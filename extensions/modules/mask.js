// Rounded corners: an alpha mask on each window's own texture (mutter's
// MetaShapedTexture mask), drawn with the window's texture, no offscreen copy
// of the window. The border and the scratch ring are the border widgets
// (borders.js).
//
// mutter paints a fully opaque surface's opaque region without the mask, so the
// window actor's first child (the surface container on Wayland, the surface on
// X11) is painted at 254, or at window-blur-opacity for a blurred window: the
// blended path applies the mask everywhere. Plaid's fades and hides stay on the
// window actor, above it. The mask is the main surface's: a subsurface reaching
// a corner (an offloaded video) stays square. An X11 window mutter frames keeps
// mutter's own mask (its frame and shape) and square corners, and so does a
// multi-plane (YUV) texture: mutter's masked pipeline asserts on one. A mask
// cannot be removed (only swapped), and mutter clears it only when the
// texture's logical size changes: a masked window whose buffer turns YUV at the
// same logical size, or one disabled Plaid left with its 1x1 mask, would hit
// that assert.
//
// Methods live on this subsystem class.

import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import { PlaidSubsystem } from './subsystem.js';

// The surface opacity that keeps mutter on its masked path, one level below
// opaque (no visible blend).
const MASKED_OPACITY = 254;

// The mask's alpha for a w x h texture: 255 inside the rounded rect
// [x0, x1) x [y0, y1) (texture pixels, radius r), 0 outside, the corner arcs
// antialiased over one pixel. Rows are filled natively; only the corner
// squares are computed per pixel. `buffer`, when big enough, is reused (a live
// resize rebuilds a mask per size, megabytes each); the result is a view on it.
export function buildMaskAlpha(w, h, x0, y0, x1, y1, r, buffer = null) {
    const data = buffer && buffer.length >= w * h ? buffer.subarray(0, w * h) : new Uint8Array(w * h);
    data.fill(0);
    const X0 = Math.max(0, Math.round(x0)), X1 = Math.min(w, Math.round(x1));
    const Y0 = Math.max(0, Math.round(y0)), Y1 = Math.min(h, Math.round(y1));
    if (X1 <= X0 || Y1 <= Y0) return data;
    const rad = Math.max(0, Math.min(r, (X1 - X0) / 2, (Y1 - Y0) / 2));
    const k = Math.ceil(rad);
    for (let y = Y0; y < Y1; y++) {
        const row = y * w;
        const top = y < Y0 + k, bottom = y >= Y1 - k;
        if (!top && !bottom) {
            data.fill(255, row + X0, row + X1);
            continue;
        }
        data.fill(255, row + X0 + k, row + X1 - k);
        const cy = top ? Y0 + rad : Y1 - rad;
        const py = y + 0.5;
        for (let i = 0; i < k; i++) {
            for (const [x, cx] of [[X0 + i, X0 + rad], [X1 - 1 - i, X1 - rad]]) {
                const px = x + 0.5;
                const dx = (x < X0 + rad ? cx - px : px - cx);
                const dy = top ? cy - py : py - cy;
                let a = 255;
                if (dx > 0 && dy > 0) {
                    const d = Math.hypot(dx, dy) - rad;
                    a = d <= -0.5 ? 255 : d >= 0.5 ? 0 : Math.round((0.5 - d) * 255);
                }
                data[row + x] = a;
            }
        }
    }
    return data;
}

export class Masks extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    // The window actor's first child that is not Plaid's own (a border or
    // ring): the surface container (Wayland) or surface (X11). Its paint
    // opacity decides mutter's masked path.
    surfaceActor(actor) {
        for (let child = actor?.get_first_child(); child; child = child.get_next_sibling()) {
            if (!child._plaidOwned) return child;
        }
        return null;
    }

    // The frame's rect inside the window's texture, in texture pixels: the
    // frame relative to the buffer, scaled by texture pixels per buffer
    // pixel, clamped to the texture.
    maskRect(win, w, h) {
        const buffer = win.get_buffer_rect();
        const frame = win.get_frame_rect();
        if (!(buffer.width > 0) || !(buffer.height > 0)) return null;
        const sx = w / buffer.width, sy = h / buffer.height;
        const x0 = Math.max(0, (frame.x - buffer.x) * sx);
        const y0 = Math.max(0, (frame.y - buffer.y) * sy);
        const x1 = Math.min(w, (frame.x - buffer.x + frame.width) * sx);
        const y1 = Math.min(h, (frame.y - buffer.y + frame.height) * sy);
        return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1, scale: Math.min(sx, sy) } : null;
    }

    // The surface opacity a masked window paints at.
    maskedOpacity(win, settings) {
        if (!this.core.blur.blurs(win, settings)) return MASKED_OPACITY;
        const pct = settings.get_int('window-blur-opacity');
        return Math.max(0, Math.min(MASKED_OPACITY, Math.round(pct / 100 * 255)));
    }

    // Whether Plaid may put a mask on this texture: mutter owns the mask of an
    // X11 window it frames, its masked pipeline takes a single-plane texture
    // only (it asserts otherwise: a YUV buffer would abort the shell), and a
    // fullscreen window has none.
    maskable(win, tex) {
        if (win.is_fullscreen?.()) return false;
        if (win.get_client_type?.() === Meta.WindowClientType.X11 && win.decorated) return false;
        // Fails closed: a texture that cannot say its plane count is not masked.
        return typeof tex.get_n_planes === 'function' && tex.get_n_planes() === 1;
    }

    // The surface's opacity, Plaid's while it sets one: the value it had is
    // kept for the restore, taken when Plaid first changes it.
    setOpacity(rec, opacity) {
        if (!rec.opacitySet) {
            rec.opacity = rec.surface.opacity;
            rec.opacitySet = true;
        }
        if (rec.surface.opacity !== opacity) rec.surface.opacity = opacity;
    }

    // Plaid's opacity off: the surface's own value back. One Plaid never set is
    // left alone (mutter sets an X11 window's opacity there).
    restoreOpacity(rec) {
        if (!rec.opacitySet) return;
        rec.opacitySet = false;
        if (rec.surface.get_parent()) rec.surface.opacity = rec.opacity;
    }

    // Rounds the window's corners at `radius` (logical pixels): builds the mask
    // when the texture, its size or the frame in it changed, and keeps the
    // surface on mutter's masked path. A window Plaid may not mask keeps square
    // corners and only a blurred window's opacity.
    ensureWindowMask(win, actor, radius, settings = this.core._settings) {
        if (!this.core._windowMasks || !actor || !settings) return;
        const stex = actor.get_texture?.();
        if (!stex?.set_mask_texture) return;
        const tex = stex.get_texture();
        const surface = this.surfaceActor(actor);
        if (!tex || !surface) return;
        let rec = this.core._windowMasks.get(win);
        if (rec && rec.stex !== stex) {
            this.teardown(rec);
            this.core._windowMasks.delete(win);
            rec = null;
        }
        if (!rec) {
            // masked: Plaid's mask is on the texture (mutter clears it on a
            // size change, and owns it on a framed X11 window).
            rec = { stex, surface, key: '', radius, opacity: 255, opacitySet: false, masked: false };
            rec.sizeToken = this.connectObject(stex, 'size-changed', () => {
                rec.masked = false;
                rec.key = '';
                this.kickMaskNow(win);
            });
            this.core._windowMasks.set(win, rec);
        }
        rec.radius = radius;
        // A replaced surface actor starts with its own opacity.
        if (rec.surface !== surface) {
            rec.surface = surface;
            rec.opacitySet = false;
        }
        if (!this.maskable(win, tex)) {
            // The texture's mask is left as it is: a mask can only be swapped
            // for another one. Usually mutter cleared it (the size changed) or
            // owns it (a framed X11 window); a window that went fullscreen at
            // its old size keeps Plaid's until its next size change.
            rec.key = '';
            if (this.core.blur.blurs(win, settings)) this.setOpacity(rec, this.maskedOpacity(win, settings));
            else this.restoreOpacity(rec);
            return;
        }
        const w = tex.get_width(), h = tex.get_height();
        const rect = this.maskRect(win, w, h);
        if (!rect) return;
        const r = radius * rect.scale;
        const key = `${w}x${h}|${rect.x0},${rect.y0},${rect.x1},${rect.y1}|${r}`;
        if (rec.key !== key) {
            // One scratch buffer, grown to the largest texture: the texture
            // copies it.
            if (!this._scratch || this._scratch.length < w * h) this._scratch = new Uint8Array(w * h);
            const alpha = buildMaskAlpha(w, h, rect.x0, rect.y0, rect.x1, rect.y1, r, this._scratch);
            rec.mask = Cogl.Texture2D.new_from_data(this.coglContext(), w, h, Cogl.PixelFormat.A_8, w, alpha);
            stex.set_mask_texture(rec.mask);
            rec.masked = true;
            rec.key = key;
            surface.queue_redraw();
        }
        this.setOpacity(rec, this.maskedOpacity(win, settings));
    }

    // The window's mask again, at once (a texture resize, a grab's end).
    kickMaskNow(win) {
        const rec = this.core._windowMasks?.get(win);
        const actor = win.get_compositor_private();
        if (!rec || !actor) return;
        this.ensureWindowMask(win, actor, rec.radius);
    }

    coglContext() {
        return global.stage.get_context().get_backend().get_cogl_context();
    }

    // A mask that keeps everything: the mask argument is not nullable, and a
    // 1x1 opaque texture samples as opaque over the whole window.
    clearMask() {
        this._clearMask ??= Cogl.Texture2D.new_from_data(this.coglContext(), 1, 1, Cogl.PixelFormat.A_8, 1, Uint8Array.of(255));
        return this._clearMask;
    }

    // Square corners and the surface's own opacity again. The 1x1 mask goes on
    // only over Plaid's own mask: one mutter cleared (a size change) is left
    // empty, the safe state for any buffer.
    teardown(rec) {
        if (rec.sizeToken) this.disconnectToken(rec.sizeToken);
        rec.sizeToken = null;
        if (rec.masked) rec.stex.set_mask_texture(this.clearMask());
        rec.masked = false;
        this.restoreOpacity(rec);
        rec.mask = null;
    }

    removeMask(win) {
        const rec = this.core._windowMasks?.get(win);
        if (!rec) return;
        this.teardown(rec);
        this.core._windowMasks.delete(win);
    }

    removeAllMasks() {
        if (!this.core._windowMasks) return;
        for (const win of [...this.core._windowMasks.keys()])
            this.removeMask(win);
    }

    destroy() {
        this.removeAllMasks();
        this._clearMask = null;
        this._scratch = null;
        super.destroy();
    }
}
