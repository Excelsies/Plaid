// The rotating gradient border's ring: one actor drawn by one fragment
// snippet, the rounded-rect stroke as a distance field and its gradient from
// uniforms. Recolouring and rotation set uniforms and queue a redraw of the
// band; nothing is drawn on the CPU or uploaded. Static gradients are cairo
// strips, solid borders and the scratch ring St widgets (borders.js).
//
// The ring is a child of the window actor and paints in the window's paint,
// no offscreen copy. Its paint volume is its allocation (ClutterActor's
// default); on X11 the box stays inside the buffer (borders.js borderBox).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';

// Every uniform the snippet reads, as ring_<name>.
export const RING_UNIFORMS = ['size', 'path', 'radius', 'half', 'aa', 'color1', 'color2', 'theta', 'opacity'];

// Box pixels come from layer 0's texture coordinates (0..1 over the box).
// The stroke is the band within `half` of the path (a rounded rect: centre
// and half extents in ring_path, corner ring_radius), antialiased over one
// device pixel (ring_aa logical pixels). The gradient position is the angle
// around the box centre less ring_theta, as a triangle wave over one turn.
// Output is premultiplied.
const RING_DECLARATIONS = `
uniform vec2 ring_size;
uniform vec4 ring_path;
uniform float ring_radius;
uniform float ring_half;
uniform float ring_aa;
uniform vec3 ring_color1;
uniform vec3 ring_color2;
uniform float ring_theta;
uniform float ring_opacity;

float ring_box(vec2 q, vec2 b, float r) {
    vec2 d = abs(q) - b + vec2(r);
    return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0) - r;
}
`;

const RING_CODE = `
    vec2 ring_p = cogl_tex_coord0_in.xy * ring_size;
    float ring_d = abs(ring_box(ring_p - ring_path.xy, ring_path.zw, ring_radius)) - ring_half;
    float ring_cover = clamp(0.5 - ring_d / ring_aa, 0.0, 1.0);
    vec2 ring_c = ring_p - ring_size * 0.5;
    float ring_g = fract((atan(ring_c.y, ring_c.x) - ring_theta) / 6.283185307);
    float ring_pos = 1.0 - abs(2.0 * ring_g - 1.0);
    float ring_a = ring_cover * ring_opacity;
    cogl_color_out = vec4(mix(ring_color1, ring_color2, ring_pos) * ring_a, ring_a);
`;

// The pipeline every ring copies (the snippet compiles once per context) and
// its uniform locations. Throws when Cogl refuses it.
export function buildRingTemplate(coglContext) {
    const pipeline = Cogl.Pipeline.new(coglContext);
    pipeline.set_layer_null_texture(0);
    pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, RING_DECLARATIONS, RING_CODE));
    // Cogl decides blending from the state a setter marks dirty; a null
    // texture on a new layer and a snippet mark none, so a copy of its opaque
    // default pipeline draws unblended: the band's transparent pixels would
    // replace the window under them. Setting the (default, premultiplied)
    // blend marks it.
    pipeline.set_blend('RGBA = ADD (SRC_COLOR, DST_COLOR*(1-SRC_COLOR[A]))');
    const loc = {};
    for (const name of RING_UNIFORMS) loc[name] = pipeline.get_uniform_location(`ring_${name}`);
    return { cls: borderRingClass(), pipeline, loc };
}

// Registered on first use (module-level guard: registerClass runs once).
let BorderRingClass = null;

export function borderRingClass() {
    BorderRingClass ??= GObject.registerClass({
        GTypeName: 'PlaidBorderRing',
    }, class PlaidBorderRing extends Clutter.Actor {
        // `onFail` is told once when a paint throws; the ring paints nothing
        // after.
        constructor(template, onFail, params = {}) {
            super(params);
            this._pipeline = template.pipeline.copy();
            this._loc = template.loc;
            this._sent = new Map();
            this._rects = [];
            this._failed = false;
            this._onFail = onFail;
        }

        // Sends the uniforms whose values changed; true when any did.
        sendUniforms(values) {
            let changed = false;
            for (const [name, v] of Object.entries(values)) {
                const key = v.join(',');
                if (this._sent.get(name) === key) continue;
                this._sent.set(name, key);
                this._pipeline.set_uniform_float(this._loc[name], v.length, 1, v);
                changed = true;
            }
            return changed;
        }

        // New uniforms, and a redraw of the band when they changed.
        setUniforms(values) {
            if (this.sendUniforms(values)) this.redrawBand();
        }

        // The rects drawn (and redrawn) in a w x h box: the band's strips
        // (border-math.js borderStripRects), those with an area. Empty draws
        // nothing.
        setShape(rects, w, h) {
            this._rects = [];
            for (const r of rects) {
                if (!(r.w > 0) || !(r.h > 0)) continue;
                this._rects.push({
                    box: new Clutter.ActorBox({ x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h }),
                    tex: [r.x / w, r.y / h, (r.x + r.w) / w, (r.y + r.h) / h],
                    clip: new Mtk.Rectangle({ x: r.x, y: r.y, width: r.w, height: r.h }),
                });
            }
        }

        // Framebuffer pixels per logical pixel (positive, finite: blur.js
        // blurViewScale): the antialiased edge is one.
        setScale(scale) {
            this.setUniforms({ aa: [1 / scale] });
        }

        redrawBand() {
            for (const r of this._rects) this.queue_redraw_with_clip(r.clip);
        }

        // The paint opacity is the window actor's fades; the pipeline node
        // copies the pipeline, so the uniforms are sent first.
        vfunc_paint_node(node, _paintContext) {
            if (this._failed || this._rects.length === 0) return;
            try {
                const opacity = this.get_paint_opacity();
                if (opacity === 0) return;
                this.sendUniforms({ opacity: [opacity / 255] });
                const pnode = new Clutter.PipelineNode(this._pipeline);
                for (const r of this._rects) pnode.add_texture_rectangle(r.box, ...r.tex);
                node.add_child(pnode);
            } catch (e) {
                this._failed = true;
                this._onFail?.(e);
            }
        }
    });
    return BorderRingClass;
}
