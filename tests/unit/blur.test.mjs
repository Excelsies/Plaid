import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import { makeSelf, fakeWin } from '../helpers.mjs';
import { blurViewScale, blurMonitorDims, blurBlitRect, blurPassRect, blurPaintView } from '../../extensions/modules/blur.js';

// Blur scale: the painted view's scale (a fractional monitor), not the
// integer UI scale.

const here = dirname(fileURLToPath(import.meta.url));
const blurSrc = readFileSync(join(here, '..', '..', 'extensions', 'modules', 'blur.js'), 'utf8');

const views = (...scales) => () => scales.map(s => ({ get_scale: () => s }));
// The resource scale is mutter's whole-number one (2 on a 1.25 monitor).
const actorAt = (x, y, scale) => ({ get_transformed_position: () => [x, y], peek_stage_views: views(scale),
  get_resource_scale: () => Math.ceil(scale) });
// Monitor 0: 2560x1440 at 1.5; monitor 1 right of it: 1920x1080 at 1.
const display = {
  get_n_monitors: () => 2,
  get_primary_monitor: () => 0,
  get_monitor_geometry: (i) => (i === 0 ? { x: 0, y: 0, width: 2560, height: 1440 }
    : { x: 2560, y: 0, width: 1920, height: 1080 }),
  get_monitor_scale: (i) => (i === 0 ? 1.5 : 1),
};
// The user's layouts: a 1.5 monitor right of a 3840 or 4096 wide one.
const offset = (x0) => ({
  get_n_monitors: () => 2,
  get_primary_monitor: () => 1,
  get_monitor_geometry: (i) => (i === 0 ? { x: 0, y: 0, width: x0, height: 2160 }
    : { x: x0, y: 0, width: 2560, height: 1440 }),
  get_monitor_scale: (i) => (i === 0 ? 1 : 1.5),
});
function withDisplay(d, fn) {
  const old = globalThis.global.display;
  globalThis.global.display = d;
  try {
    return fn();
  } finally {
    globalThis.global.display = old;
  }
}

test('blurViewScale: the scale of the views the actor is on (the largest); 1 with none or no usable one', () => {
  assert.equal(blurViewScale(actorAt(0, 0, 1.5)), 1.5);
  assert.equal(blurViewScale({ peek_stage_views: views(1, 1.25) }), 1.25);
  for (const s of [0, -1, NaN, Infinity, undefined])
    assert.equal(blurViewScale({ peek_stage_views: views(s) }), 1, String(s));
  assert.equal(blurViewScale({ peek_stage_views: views() }), 1);
  assert.equal(blurViewScale({}), 1);
});

// A stage view: its logical rect, scale and framebuffer.
const viewAt = (x, y, w, h, scale, fb = {}) => ({ get_scale: () => scale, get_framebuffer: () => fb,
  get_layout: (r) => Object.assign(r, { x, y, width: w, height: h }) });
const LEFT = viewAt(0, 0, 2560, 1440, 1.5, 'left-fb'), RIGHT = viewAt(2560, 0, 1920, 1080, 1, 'right-fb');
const actorOn = (x, y, ...vs) => ({ get_transformed_position: () => [x, y], peek_stage_views: () => vs,
  get_resource_scale: () => 2 });
const rectOf = (v) => { const r = {}; v.get_layout(r); return { x: r.x, y: r.y, w: r.width, h: r.height, scale: v.get_scale() }; };

test('blurMonitorDims: the largest view the actor is on in framebuffer pixels (else the primary), at least 640x480', () => {
  withDisplay(display, () => {
    assert.deepEqual(blurMonitorDims(actorOn(100, 40, LEFT)), { monW: 3840, monH: 2160 });
    assert.deepEqual(blurMonitorDims(actorOn(2660, 40, RIGHT)), { monW: 1920, monH: 1080 }, 'not the largest monitor');
    // Across both: one size for both views' paints, so no rebuild per paint.
    assert.deepEqual(blurMonitorDims(actorOn(2400, 40, LEFT, RIGHT)), { monW: 3840, monH: 2160 });
    assert.deepEqual(blurMonitorDims(actorOn(-500, 40)), { monW: 2560, monH: 1440 }, 'on no view: the primary');
    assert.deepEqual(blurMonitorDims(actorOn(10, 10, viewAt(0, 0, 300, 200, 1))), { monW: 640, monH: 480 }, 'floor');
  });
  withDisplay(offset(3840), () =>
    assert.deepEqual(blurMonitorDims(actorOn(-500, 40)), { monW: 2560, monH: 1440 }, 'the primary, not monitor 0'));
});

test('blurPaintView: the view whose framebuffer the paint draws into; null for any other target', () => {
  const old = globalThis.global.stage;
  globalThis.global.stage = { peek_stage_views: () => [LEFT, RIGHT] };
  try {
    assert.deepEqual(blurPaintView({ get_framebuffer: () => 'right-fb' }), { x: 2560, y: 0, w: 1920, h: 1080, scale: 1 });
    assert.deepEqual(blurPaintView({ get_framebuffer: () => 'left-fb' }).scale, 1.5);
    assert.equal(blurPaintView({ get_framebuffer: () => 'offscreen' }), null);
  } finally {
    globalThis.global.stage = old;
  }
});

test('blurBlitRect: the painted view\'s scale and origin; without one, the actor\'s monitor and largest scale', () => {
  withDisplay(display, () => {
    assert.deepEqual(blurBlitRect(actorOn(100, 40, LEFT), 400, 300, rectOf(LEFT)),
      { px: 150, py: 60, physW: 600, physH: 450 });
    // Across both views: each view's paint reads at its own scale and origin.
    const across = actorOn(2400, 40, LEFT, RIGHT);
    assert.deepEqual(blurBlitRect(across, 400, 300, rectOf(LEFT)), { px: 3600, py: 60, physW: 600, physH: 450 });
    assert.deepEqual(blurBlitRect(across, 400, 300, rectOf(RIGHT)), { px: -160, py: 40, physW: 400, physH: 300 });
    // No view (an offscreen paint): the monitor holding the origin.
    assert.deepEqual(blurBlitRect(actorAt(100, 40, 1.5), 400, 300), { px: 150, py: 60, physW: 600, physH: 450 });
    assert.deepEqual(blurBlitRect(actorAt(2660, 40, 1), 400, 300), { px: 100, py: 40, physW: 400, physH: 300 });
  });
});

test('blurBlitRect: a 1.5 view at x=3840 or x=4096, the origin taken off before scaling', () => {
  for (const x0 of [3840, 4096]) {
    const v = viewAt(x0, 0, 2560, 1440, 1.5);
    withDisplay(offset(x0), () => {
      assert.deepEqual(blurBlitRect(actorOn(x0 + 100, 40, v), 400, 300, rectOf(v)),
        { px: 150, py: 60, physW: 600, physH: 450 }, String(x0));
      assert.deepEqual(blurBlitRect(actorAt(x0 + 100, 40, 1.5), 400, 300),
        { px: 150, py: 60, physW: 600, physH: 450 }, `${x0}, no view`);
    });
  }
});

test('blurPassRect: at 1.5 each pass covers exactly the content share it reads back', () => {
  withDisplay(display, () => {
    const actor = actorOn(100, 40, LEFT);
    const { physW, physH } = blurBlitRect(actor, 400, 300, rectOf(LEFT));
    const { monW, monH } = blurMonitorDims(actor);
    const p = blurPassRect(physW, physH, monW, monH, 2);
    assert.deepEqual([p.bw, p.bh], [300, 225]);
    assert.equal(p.bw / (monW / 2), p.fx);
    assert.equal(p.bh / (monH / 2), p.fy);
  });
});

// The effect class itself, on recording Clutter nodes: what the paint hands
// to the GL chain.
class Node {
  constructor(fb) { this.fb = fb; this.rects = []; this.children = []; this.blits = []; }
  add_texture_rectangle(box, ...tc) { this.rects.push([[box.x1, box.y1, box.x2, box.y2], tc]); }
  add_child(c) { this.children.push(c); }
  add_blit_rectangle(...a) { this.blits.push(a); }
}
function paintedChain(actor, fb) {
  GObject.registerClass = (_meta, cls) => cls;
  Clutter.Effect ??= class { get_actor() { return this._actor; } queue_repaint() {} };
  Clutter.LayerNode = Node;
  Clutter.BlitNode = Node;
  Clutter.ActorBox = class { constructor(o) { Object.assign(this, o); } };
  const self = makeSelf({});
  const eff = self.blur.createGjsBlurEffect();
  assert.ok(eff, 'effect built');
  const pipe = { set_uniform_float() {} };
  const { monW, monH } = blurMonitorDims(actor);
  Object.assign(eff, { _actor: actor, _ready: true, _radius: 20, _bgFb: 'bg', _brightFb: 'bright', _hFb: 'h', _vFb: 'v',
    _bgTex: { get_width: () => monW, get_height: () => monH }, _monitorKey: `${monW}x${monH}:2`,
    _brightPipeline: pipe, _hPipeline: pipe, _vPipeline: pipe, _basePipeline: pipe, _kernelKey: '' });
  const node = new Node('stage');
  const oldStage = globalThis.global.stage;
  globalThis.global.stage = { peek_stage_views: () => [LEFT, RIGHT] };
  try {
    eff.vfunc_paint_node(node, { get_framebuffer: () => fb });
  } finally {
    globalThis.global.stage = oldStage;
  }
  assert.equal(eff._paintFailCount, 0, 'painted');
  const bright = node.children[0], v = bright.children[0], h = v.children[0], bg = h.children[0];
  return { bright, v, h, bg, blit: bg.children[0], monW, monH };
}

test('paint at 1.5: the blit, every pass and the composite get framebuffer and logical rects', () => {
  withDisplay(display, () => {
    const actor = { ...actorOn(100, 40, LEFT), width: 400, height: 300, get_parent: () => ({}) };
    const { bright, v, h, bg, blit, monW, monH } = paintedChain(actor, 'left-fb');
    assert.equal(blit.fb, 'left-fb');
    assert.deepEqual(blit.blits, [[150, 60, 0, 0, 600, 450]], 'the stage read at the scale');
    const tc = [0, 0, 600 / monW, 450 / monH];
    for (const [name, layer] of [['v', v], ['h', h], ['bg', bg]])
      assert.deepEqual(layer.rects, [[[0, 0, 300, 225], tc]], `${name} pass in framebuffer pixels`);
    assert.deepEqual(bright.rects, [[[0, 0, 400, 300], tc]], 'composite in the actor\'s logical rect');
  });
});

test('paint across two views: the scale-1 view\'s paint reads at scale 1 from its own origin', () => {
  withDisplay(display, () => {
    const actor = { ...actorOn(2400, 40, LEFT, RIGHT), width: 400, height: 300, get_parent: () => ({}) };
    const { v, blit, monW, monH } = paintedChain(actor, 'right-fb');
    assert.deepEqual(blit.blits, [[-160, 40, 0, 0, 400, 300]]);
    assert.deepEqual(v.rects, [[[0, 0, 200, 150], [0, 0, 400 / monW, 300 / monH]]]);
  });
});

test('ensureWindowBlur: the radius is the setting, capped at 100, times the view scale, and follows a view change', () => {
  Shell.BlurEffect ??= class {};
  const values = { 'window-blur': true, 'window-blur-radius': 20, 'window-blur-brightness': 0.6 };
  const self = makeSelf(values);
  self._windowBlurs = new Map();
  const win = fakeWin({ instance: 'gjs' });
  let scale = 1.5;
  const handlers = {};
  const actor = { add_effect_with_name() {}, peek_stage_views: () => [{ get_scale: () => scale }],
    connectObject(sig, fn) { handlers[sig] = fn; }, disconnectObject() {} };
  const blur = { _sibling: null, get_actor: () => actor, radius: 0, brightness: 0, corner_radius: 0 };
  self._windowBlurs.set(win, blur);
  self.blur.ensureWindowBlur(win, actor);
  assert.equal(blur.radius, 30);
  // Moved to a scale-1 monitor: no borders pass needed.
  scale = 1;
  handlers['stage-views-changed']();
  assert.equal(blur.radius, 20);
  scale = 1.5;
  for (const [set, want] of [[90, 135], [150, 150]]) {
    values['window-blur-radius'] = set;
    self.blur.ensureWindowBlur(win, actor);
    assert.equal(blur.radius, want, `setting ${set}`);
  }
  // Removed: the hook goes with it.
  self.blur.removeBlur(win);
  assert.equal(blur._viewsToken, null);
  scale = 1;
  handlers['stage-views-changed']();
  assert.equal(blur.radius, 150, 'a removed blur is left alone');
});

test('blur.js never reads the integer UI scale', () => {
  assert.ok(!blurSrc.includes('scale_factor'), 'use blurViewScale / blurMonitorDims');
});

const schemaXml = readFileSync(join(here, '..', '..', 'extensions', 'schemas',
  'org.gnome.shell.extensions.plaid.gschema.xml'), 'utf8');
const signalsSrc = readFileSync(join(here, '..', '..', 'extensions', 'modules', 'signals.js'), 'utf8');

test('blur-exclude: an empty list by default, so every window keeps its blur', () => {
  assert.match(schemaXml, /<key name="blur-exclude" type="as">\s*<default>\[\]<\/default>/);
  const self = makeSelf({ 'window-blur': true });
  assert.equal(self.blur.blurs(fakeWin({ instance: 'firefox' })), true);
});

test('blurs: off with window-blur off, or for a class on blur-exclude (any of its class names, any case)', () => {
  const off = makeSelf({ 'window-blur': false });
  assert.equal(off.blur.blurs(fakeWin({ instance: 'kitty' })), false);
  const self = makeSelf({ 'window-blur': true, 'blur-exclude': ['firefox', 'Org.Gnome.Ptyxis'] });
  assert.equal(self.blur.blurs(fakeWin({ instance: 'Navigator', wmClass: 'Firefox' })), false);
  assert.equal(self.blur.blurs(fakeWin({ appId: 'org.gnome.Ptyxis' })), false);
  assert.equal(self.blur.blurs(fakeWin({ instance: 'kitty' })), true);
});

test('ensureWindowBlur: an excluded window loses its blur and gets none', () => {
  Shell.BlurEffect ??= class {};
  const self = makeSelf({ 'window-blur': true, 'blur-exclude': ['firefox'] });
  self._windowBlurs = new Map();
  const win = fakeWin({ instance: 'firefox' });
  const actor = { add_effect_with_name() { throw new Error('no blur may be attached'); }, peek_stage_views: views(1) };
  self._windowBlurs.set(win, { _sibling: null, get_actor: () => actor });
  self.blur.ensureWindowBlur(win, actor);
  assert.equal(self._windowBlurs.has(win), false);
  self.blur.ensureWindowBlur(win, actor);
  assert.equal(self._windowBlurs.has(win), false);
});

test('blur-exclude: a change re-applies the Flair', () => {
  assert.match(signalsSrc, /'changed::blur-exclude', \(\) => this\.core\.borders\.updateBorders\(\)\)/);
});

test('blurs and ensureWindowBlur: a borders pass\'s settings memo decides, not a fresh read', () => {
  Shell.BlurEffect ??= class {};
  const self = makeSelf({ 'window-blur': true, 'blur-exclude': [] });
  self._windowBlurs = new Map();
  const memo = { get_boolean: () => true, get_strv: () => ['gjs'] };
  const win = fakeWin({ instance: 'gjs' });
  assert.equal(self.blur.blurs(win), true);
  assert.equal(self.blur.blurs(win, memo), false);
  const actor = { add_effect_with_name() {}, peek_stage_views: views(1) };
  self._windowBlurs.set(win, { _sibling: null, get_actor: () => actor });
  self.blur.ensureWindowBlur(win, actor, memo);
  assert.equal(self._windowBlurs.has(win), false);
});

test('the view-change hook is disconnected when the blur goes: removed, or dropped by the dead-host self-heal', () => {
  Shell.BlurEffect ??= class {};
  const old = globalThis.global.window_group;
  globalThis.global.window_group = {};
  try {
    for (const how of ['remove', 'self-heal']) {
      const self = makeSelf({ 'window-blur': true, 'window-blur-radius': 20 });
      self._windowBlurs = new Map();
      const win = fakeWin({ instance: 'gjs' });
      const gone = [];
      const actor = { add_effect_with_name() {}, peek_stage_views: views(1), get_parent: () => null,
        connectObject() {}, disconnectObject(tok) { gone.push(tok); } };
      let host = actor;
      const blur = { _sibling: null, get_actor: () => host, radius: 0, brightness: 0, corner_radius: 0 };
      self._windowBlurs.set(win, blur);
      self.blur.ensureWindowBlur(win, actor);
      const tok = blur._viewsToken;
      assert.ok(tok, 'hooked');
      if (how === 'remove') {
        self.blur.removeBlur(win);
      } else {
        host = null;
        self.blur.ensureWindowBlur(win, actor);
        assert.equal(self._windowBlurs.has(win), false, 'dropped');
      }
      assert.ok(gone.includes(tok), `${how}: the hook is disconnected`);
      assert.equal(blur._viewsToken, null);
    }
  } finally {
    globalThis.global.window_group = old;
  }
});
