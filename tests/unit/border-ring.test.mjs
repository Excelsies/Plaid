import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import St from 'gi://St';
import { makeSelf, fakeWin, frameClock, coglStage, cogl, FakeClutterActor } from '../helpers.mjs';

// Rotating gradient borders as one ring actor (border-ring.js): its look and
// angle in uniforms, its band in four strips; borders moved and recoloured in
// place, the grab loop touching only borders that moved, and the swap with the
// strips (border-strips.test.mjs) when the rotation starts or stops.

class FakeActor {
  constructor(p = {}) {
    Object.assign(this, { x: 0, y: 0, width: 0, height: 0, visible: true, mapped: true }, p);
    this.children = [];
    this.parent = null;
    this.calls = { pos: 0, size: 0, style: 0 };
    this.handlers = [];
    this.destroyed = false;
  }
  add_child(c) { this.children.push(c); c.parent = this; }
  get_parent() { return this.parent; }
  get_first_child() { return this.children[0] ?? null; }
  get_last_child() { return this.children.at(-1) ?? null; }
  get_previous_sibling() { const k = this.parent?.children ?? []; return k[k.indexOf(this) - 1] ?? null; }
  get_next_sibling() { const k = this.parent?.children ?? []; const i = k.indexOf(this); return i < 0 ? null : k[i + 1] ?? null; }
  set_child_above_sibling(c, sib) { this.children = this.children.filter(k => k !== c); this.children.push(c); this.raises = (this.raises ?? 0) + 1; }
  set_position(x, y) { this.calls.pos++; this.x = x; this.y = y; }
  set_size(w, h) { this.calls.size++; this.width = w; this.height = h; }
  set_style(s) { this.calls.style++; this.style = s; }
  destroy() { this.destroyed = true; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) this.handlers.push([obj, a[i], a[i + 1]]); }
  disconnectObject() {}
}

// A static gradient's strip (border-strips.test.mjs has the drawing).
class FakeArea extends FakeActor {
  queue_repaint() { this.calls.queue = (this.calls.queue ?? 0) + 1; }
}

// St widgets are the fake actor (solid borders, the scratch ring, the strips'
// container); the ring gets a Cogl context; the rotation clock stands still
// unless a test moves it.
function withSt(fn) {
  const old = { Widget: St.Widget, DrawingArea: St.DrawingArea, now: Date.now };
  St.Widget = FakeActor;
  St.DrawingArea = FakeArea;
  Date.now = () => 1000;
  const stage = coglStage();
  try { return fn(); } finally { St.Widget = old.Widget; St.DrawingArea = old.DrawingArea; Date.now = old.now; stage.restore(); }
}

const SETTINGS = {
  'borders-enabled': true, 'gradient-borders': true, 'rounded-corners': false, 'border-radius': 15,
  'active-border-width': 2, 'inactive-border-width': 2, 'gradient-direction': 'vertical',
  'active-border-color': ['#ff0000'], 'active-border-color-2': ['#0000ff'],
  'inactive-border-color': ['#202020'], 'inactive-border-color-2': ['#404040'],
  'border-animation-speed': 5, 'enabled': true,
};

function setup(extra = {}) {
  const values = { ...SETTINGS, ...extra };
  const self = makeSelf(values);
  // Writable: a test flips a key between passes.
  Object.assign(self._settings, {
    set_boolean: (k, v) => { values[k] = v; }, set_int: (k, v) => { values[k] = v; },
    set_string: (k, v) => { values[k] = v; },
  });
  const actor = new FakeActor();
  let frame = { x: 100, y: 50, width: 800, height: 600 };
  const win = fakeWin({ actor });
  win.get_frame_rect = () => ({ ...frame });
  win.get_buffer_rect = () => ({ ...frame });
  return { self, actor, win, setFrame: f => { frame = { ...frame, ...f }; } };
}

const uniforms = b => Object.fromEntries(b._pipeline.uniforms);
const rects = b => b._rects.map(r => { const x = r.box; return [x.x1, x.y1, x.x2 - x.x1, x.y2 - x.y1]; });

// The fragment snippet in JS, line for line (border-ring.js RING_CODE): the
// coverage and colour it gives the box point (x, y) from the sent uniforms.
function shade(b, x, y) {
  const u = b._pipeline.uniforms;
  const clamp = v => Math.max(0, Math.min(1, v));
  const [w, h] = u.get('size');
  const [cx, cy, bx, by] = u.get('path');
  const r = u.get('radius')[0];
  const qx = Math.abs(x - cx) - bx + r, qy = Math.abs(y - cy) - by + r;
  const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  const d = Math.abs(sd) - u.get('half')[0];
  const cover = clamp(0.5 - d / u.get('aa')[0]);
  const t = (Math.atan2(y - h / 2, x - w / 2) - u.get('theta')[0]) / (Math.PI * 2);
  const g = t - Math.floor(t);
  const pos = 1 - Math.abs(2 * g - 1);
  const c1 = u.get('color1'), c2 = u.get('color2');
  return { cover, pos, c: c1.map((v, i) => v + (c2[i] - v) * pos) };
}

test('ensureWindowBorder: a gradient border is one ring actor, its band in four strips, its look in uniforms', () => withSt(() => {
  const { self, actor, win } = setup();
  assert.equal(self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true), true);
  const b = self._windowBorders.get(win);
  assert.ok(b instanceof FakeClutterActor && b._plaidGradient && b._plaidOwned);
  assert.deepEqual([actor.children.length, actor.children[0]], [1, b]);
  assert.deepEqual([b.x, b.y, b.width, b.height], [-2, -2, 804, 604]);
  assert.deepEqual(rects(b), [[0, 0, 804, 18], [0, 586, 804, 18], [0, 18, 18, 568], [786, 18, 18, 568]]);
  // Texture coordinates span the box: the snippet's pixels are box pixels.
  assert.deepEqual(b._rects[3].tex, [786 / 804, 18 / 604, 1, 586 / 604]);
  assert.deepEqual(uniforms(b), {
    aa: [1], size: [804, 604], path: [402, 302, 401, 301], radius: [15], half: [1],
    color1: [1, 0, 0], color2: [0, 0, 1], theta: [self.borders.borderAngle()[1]],
  });
  // The template's pipeline, copied, with the snippet on layer 0's coordinates.
  assert.ok(b._pipeline.copiedFrom === self.borders._ringTemplate.pipeline);
  assert.equal(b._pipeline.nullLayer, 0);
  assert.match(b._pipeline.snippets[0].code, /cogl_tex_coord0_in\.xy \* ring_size/);
  // Every uniform the snippet declares is sent, and no other.
  const declared = [...b._pipeline.snippets[0].decl.matchAll(/uniform \w+ ring_(\w+);/g)].map(m => m[1]).sort();
  assert.deepEqual(declared, [...Object.keys(uniforms(b)), 'opacity'].sort());
}));

test('ensureWindowBorder: moved, resized and recoloured in place: the same ring, new uniforms', () => withSt(() => {
  const { self, actor, win, setFrame } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  const pipeline = b._pipeline;
  const sets = () => pipeline.sets;
  // Unchanged: nothing touched.
  const s0 = sets();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.deepEqual([b.calls.pos, b.calls.size, sets(), b.clips.length], [1, 1, s0, 4]);
  // A move of the buffer origin: position only, no uniform, no redraw.
  setFrame({ x: 100 }); win.get_buffer_rect = () => ({ x: 90, y: 50, width: 800, height: 600 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.deepEqual([b.x, b.calls.size, sets(), b.clips.length], [8, 1, s0, 4]);
  // A resize: new strips and the size uniforms, the band redrawn.
  win.get_buffer_rect = () => win.get_frame_rect();
  setFrame({ width: 500 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.deepEqual([b.width, rects(b)[0][2], uniforms(b).size[0], uniforms(b).path[2]], [504, 504, 504, 251]);
  assert.equal(b.clips.length, 8);
  // Focus lost: recoloured by uniforms, the same ring and pipeline.
  const s1 = sets();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), false);
  assert.equal(self._windowBorders.get(win), b);
  assert.equal(b._pipeline, pipeline);
  assert.deepEqual([uniforms(b).color1, uniforms(b).color2].map(c => c.map(v => Math.round(v * 255))),
    [[0x20, 0x20, 0x20], [0x40, 0x40, 0x40]]);
  assert.equal(sets() - s1, 2, 'only the colours sent');
  assert.equal(b.clips.length, 12);
  assert.equal(b.destroyed, false);
}));

test('ensureWindowBorder: gradient to solid, a dead actor, or a resized scratch window builds anew', () => withSt(() => {
  const { self, actor, win, setFrame } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const g = self._windowBorders.get(win);
  self._settings.set_boolean('gradient-borders', false);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const solid = self._windowBorders.get(win);
  assert.notEqual(solid, g);
  assert.equal(g.destroyed, true);
  assert.match(solid.style, /border: 2px solid #ff0000/);
  // A solid border recoloured in place: a new style, the same widget.
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), false);
  assert.equal(self._windowBorders.get(win), solid);
  assert.match(solid.style, /#202020/);
  // Solid back to gradient: a ring again.
  self._settings.set_boolean('gradient-borders', true);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), false);
  const ring = self._windowBorders.get(win);
  assert.ok(ring._plaidGradient && solid.destroyed);
  // The actor replaced: rebuilt on the new one.
  const actor2 = new FakeActor();
  win.get_compositor_private = () => actor2;
  self.borders.ensureWindowBorder(win, actor2, win.get_frame_rect(), false);
  assert.notEqual(self._windowBorders.get(win), ring);
  assert.equal(self._windowBorders.get(win).get_parent(), actor2);
  // A scratch window that was resized is rebuilt with its ring (a move
  // carries border and ring with the actor).
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor2, win.get_frame_rect(), true);
  const s1 = self._windowBorders.get(win);
  self.borders.ensureWindowBorder(win, actor2, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), s1, 'unmoved scratch border kept');
  setFrame({ height: 500 });
  self.borders.ensureWindowBorder(win, actor2, win.get_frame_rect(), true);
  assert.notEqual(self._windowBorders.get(win), s1);
  assert.equal(self._scratchpadRings.size, 1);
  assert.match(self._scratchpadRings.get(win).style, /border: 2px solid #f5c211/, 'the scratch ring stays an St border');
}));

test('updateBordersDuringGrab: only a border whose window changed is touched', () => withSt(() => {
  const a = setup(), self = a.self;
  const actorB = new FakeActor();
  const winB = fakeWin({ actor: actorB, frame: { x: 1000, y: 50, width: 400, height: 600 } });
  self.borders.ensureWindowBorder(a.win, a.actor, a.win.get_frame_rect(), true);
  self.borders.ensureWindowBorder(winB, actorB, winB.get_frame_rect(), false);
  const ba = self._windowBorders.get(a.win), bb = self._windowBorders.get(winB);
  const before = [ba.clips.length, bb.clips.length, bb._pipeline.sets, bb.calls.pos, bb.calls.size];
  a.setFrame({ width: 700 });
  self.borders.updateBordersDuringGrab();
  self.borders.updateBordersDuringGrab();
  assert.deepEqual([bb.clips.length, bb._pipeline.sets, bb.calls.pos, bb.calls.size], before.slice(1), 'B untouched');
  assert.equal(ba.clips.length, before[0] + 4, 'A redrawn once');
  assert.deepEqual([ba.width, uniforms(ba).size[0]], [704, 704]);
  // The stroke it was drawn with: a focus change mid-grab is the pass's to restyle.
  self._settings.set_int('active-border-width', 8);
  a.setFrame({ width: 690 });
  self.borders.updateBordersDuringGrab();
  assert.deepEqual([ba.width, uniforms(ba).half[0]], [694, 1]);
}));

test('queueBorderRepaint: turns the ring by its angle uniform and redraws only its band; a solid border is left alone', () => withSt(() => {
  const { self, actor, win } = setup();
  const frozen = Date.now;
  let t = 1000;
  Date.now = () => t;
  try {
    self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
    const b = self._windowBorders.get(win);
    const pipeline = b._pipeline, shape = b._rects;
    assert.deepEqual(uniforms(b).theta, [self.borders.borderAngle()[1]]);
    const laidOut = b._plaidTheta;
    t += 3000;
    const [sets, clips] = [pipeline.sets, b.clips.length];
    self.borders.queueBorderRepaint(b);
    assert.notEqual(b._plaidTheta, laidOut);
    assert.equal(b._plaidTheta, self.borders.borderAngle()[1]);
    assert.deepEqual(uniforms(b).theta, [b._plaidTheta]);
    assert.equal(pipeline.sets - sets, 1, 'one uniform');
    assert.deepEqual(b.clips.slice(clips).map(c => [c.x, c.y, c.width, c.height]), rects(b), 'the band, strip by strip');
    assert.equal(b._rects, shape, 'no new shape');
    assert.equal(b._pipeline, pipeline);
    // The same angle again: nothing sent, nothing redrawn.
    self.borders.queueBorderRepaint(b);
    assert.equal(b.clips.length, clips + 4);
  } finally {
    Date.now = frozen;
  }
  const plain = new FakeActor();
  self.borders.queueBorderRepaint(plain);
  assert.equal(plain._plaidTheta, undefined);
}));

test('ringUniforms + the snippet: the band within half a stroke of the rounded path, one pixel of edge', () => withSt(() => {
  const { self, actor, win } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  // The path runs 1 px inside the 804 x 604 box, the stroke 2 px wide.
  assert.equal(shade(b, 402.5, 1).cover, 1, 'on the path');
  assert.equal(shade(b, 402.5, 0.5).cover, 1, 'inside the band');
  assert.equal(shade(b, 402.5, 0).cover, 0.5, 'its outer edge: half');
  assert.equal(shade(b, 402.5, 2).cover, 0.5, 'its inner edge (the frame): half');
  assert.equal(shade(b, 402.5, 3).cover, 0, 'over the window');
  assert.equal(shade(b, 1, 302).cover, 1, 'the left edge');
  // The corner is cut on the radius: the box corner is outside the stroke,
  // the arc's midpoint on it.
  assert.equal(shade(b, 1, 1).cover, 0);
  const m = 1 + 15 - 15 / Math.SQRT2;
  assert.ok(Math.abs(shade(b, m, m).cover - 1) < 1e-9);
  // At a scale of 2 the edge is half a logical pixel.
  b.setScale(2);
  assert.equal(shade(b, 402.5, 0).cover, 0.5);
  assert.equal(shade(b, 402.5, -0.25).cover, 0);
  assert.equal(shade(b, 402.5, 0.25).cover, 1);
}));

test('ringUniforms + the snippet: a rotating gradient is colour 1 at the angle, colour 2 opposite', () => withSt(() => {
  const { self, actor, win } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  b.setUniforms({ theta: [0] });
  assert.deepEqual(shade(b, 803, 302).c, [1, 0, 0], 'the right edge, angle 0');
  assert.deepEqual(shade(b, 1, 302).c, [0, 0, 1], 'the left edge, half a turn on');
  assert.ok(Math.abs(shade(b, 402, 0).pos - 0.5) < 1e-12, 'a quarter turn: half way');
  b.setUniforms({ theta: [Math.PI] });
  assert.deepEqual(shade(b, 1, 302).c, [1, 0, 0], 'turned half a turn');
  // The old position at the same point: g < 0.5 ? 2g : 2(1 - g) of the angle.
  for (const theta of [0.3, 2, 5.9]) {
    b.setUniforms({ theta: [theta] });
    for (const [x, y] of [[700, 1], [803, 500], [5, 600], [1, 40]]) {
      const ang = Math.atan2(y - 302, x - 402);
      const g = ((ang - theta) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
      assert.ok(Math.abs(shade(b, x, y).pos - (g < 0.5 ? g * 2 : (1 - g) * 2)) < 1e-9, `${theta} ${x},${y}`);
    }
  }
}));

test('vfunc_paint_node: one pipeline node over the band at the paint opacity; nothing when transparent or empty', () => withSt(() => {
  const { self, actor, win } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  const paint = () => { const node = { kids: [], add_child(k) { this.kids.push(k); } }; b.vfunc_paint_node(node, {}); return node.kids; };
  let kids = paint();
  assert.equal(kids.length, 1);
  assert.deepEqual(kids[0].uniforms.get('opacity'), [1]);
  // Blended over the window, premultiplied: without it the band's
  // transparent pixels replace the window under them.
  assert.equal(kids[0].blends, true);
  assert.equal(self.borders._ringTemplate.pipeline.blend, 'RGBA = ADD (SRC_COLOR, DST_COLOR*(1-SRC_COLOR[A]))');
  assert.deepEqual(kids[0].rects.map(([box, ...tex]) => [box.x1, box.y1, box.x2, box.y2, ...tex]),
    b._rects.map(r => [r.box.x1, r.box.y1, r.box.x2, r.box.y2, ...r.tex]));
  // The window actor's fade: the opacity uniform, before the node copies it.
  b.paintOpacity = 51;
  kids = paint();
  assert.deepEqual(kids[0].uniforms.get('opacity'), [0.2]);
  const sets = b._pipeline.sets;
  paint();
  assert.equal(b._pipeline.sets, sets, 'unchanged: not sent again');
  b.paintOpacity = 0;
  assert.equal(paint().length, 0);
  b.paintOpacity = 255;
  // A stroke that fills its box draws nothing.
  self.borders.placeBorder(b, 0, 0, 2, 50);
  assert.deepEqual(b._rects, []);
  assert.equal(paint().length, 0);
}));

test('a ring under two corners deep draws only its strips with area', () => withSt(() => {
  const { self, actor, win } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  self.borders.placeBorder(b, -2, -2, 20, 20);
  assert.deepEqual(rects(b), [[0, 0, 20, 10], [0, 10, 20, 10]]);
  const clips = b.clips.length;
  self.borders.queueBorderRepaint(b);
  b.setUniforms({ color1: [0, 1, 0] });
  assert.equal(b.clips.length, clips + 2, 'a redraw of the two strips');
}));

test('ring paint failure: it stops painting and the next pass draws every gradient in strips', () => withSt(() => {
  const { self, actor, win } = setup();
  const winB = fakeWin({ actor: new FakeActor(), frame: { x: 1000, y: 50, width: 400, height: 600 } });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  self.borders.ensureWindowBorder(winB, winB.get_compositor_private(), winB.get_frame_rect(), false);
  const b = self._windowBorders.get(win), bB = self._windowBorders.get(winB);
  let passes = 0;
  self.signals.scheduleBorders = () => passes++;
  const logs = [];
  self.debugLog = m => logs.push(m);
  const node = { kids: [], add_child(k) { this.kids.push(k); } };
  cogl.failNode = 'no program';
  try {
    b.vfunc_paint_node(node, {});
    b.vfunc_paint_node(node, {});
    bB.vfunc_paint_node(node, {});
  } finally {
    cogl.failNode = null;
  }
  assert.deepEqual([passes, logs.length], [1, 1], 'one pass and one line for every failing ring');
  assert.match(logs[0], /no program/);
  assert.equal(self.borders._ringTemplate, null, 'the template let go');
  b.vfunc_paint_node(node, {});
  assert.equal(node.kids.length, 0, 'a failed ring paints nothing');
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  self.borders.ensureWindowBorder(winB, winB.get_compositor_private(), winB.get_frame_rect(), false);
  const [sa, sb] = [self._windowBorders.get(win), self._windowBorders.get(winB)];
  assert.deepEqual([sa._plaidStrips?.length, sb._plaidStrips?.length], [4, 4], 'strips, not solid');
  assert.deepEqual([sa._plaidBorder.color1, sb._plaidBorder.color1].map(c => Math.round(c.r * 255)), [0xff, 0x20], 'each its focus colours');
  assert.deepEqual([b.destroyed, bB.destroyed], [true, true]);
  // Still rotating: the strips turn on the tick.
  assert.ok(self.borders.borderAnimationNeeded());
}));

test('ringTemplate: built once for every ring; without a pipeline gradients are drawn in strips, not retried', () => withSt(() => {
  const { self, actor, win } = setup();
  const winB = fakeWin({ actor: new FakeActor(), frame: { x: 1000, y: 50, width: 400, height: 600 } });
  const n0 = cogl.news;
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  self.borders.ensureWindowBorder(winB, winB.get_compositor_private(), winB.get_frame_rect(), true);
  const [a, b] = [self._windowBorders.get(win), self._windowBorders.get(winB)];
  assert.equal(cogl.news - n0, 1, 'one pipeline');
  assert.ok(a._pipeline !== b._pipeline && a._pipeline.copiedFrom === b._pipeline.copiedFrom, 'a copy each');

  const s = setup();
  const logs = [];
  s.self.debugLog = m => logs.push(m);
  cogl.fail = 'no GLSL';
  const n1 = cogl.news;
  try {
    s.self.borders.ensureWindowBorder(s.win, s.actor, s.win.get_frame_rect(), true);
    s.self.borders.ensureWindowBorder(s.win, s.actor, s.win.get_frame_rect(), false);
  } finally {
    cogl.fail = null;
  }
  const strips = s.self._windowBorders.get(s.win);
  assert.equal(strips._plaidStrips?.length, 4, 'strips, not solid');
  assert.equal(Math.round(strips._plaidBorder.color1.r * 255), 0x20, 'restyled in place to the unfocused colours');
  assert.equal(cogl.news - n1, 1, 'not retried');
  assert.equal(logs.filter(l => /no GLSL/.test(l)).length, 1);
}));

test('ring scale: the edge follows the views it is on, at creation and on stage-views-changed', () => withSt(() => {
  const { self, actor, win } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  assert.deepEqual(uniforms(b).aa, [1], 'on no view yet: scale 1');
  b.views = [{ get_scale: () => 1 }, { get_scale: () => 1.25 }];
  const clips = b.clips.length;
  b.emit('stage-views-changed');
  assert.deepEqual(uniforms(b).aa, [0.8]);
  assert.equal(b.clips.length, clips + 4);
  b.views = [{ get_scale: () => NaN }];
  b.emit('stage-views-changed');
  assert.deepEqual(uniforms(b).aa, [1], 'a bad scale: 1 (blurViewScale)');
}));

test('width 0, removal and disable: the ring, its handler and the template go', () => withSt(() => {
  const { self, actor, win } = setup();
  const n0 = self.borders._tokens.length;
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  assert.equal(self.borders._tokens.length, n0 + 1);
  self._settings.set_int('active-border-width', 0);
  assert.equal(self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true), false);
  assert.deepEqual([b.destroyed, self._windowBorders.has(win), self.borders._tokens.length, b.handlers.length], [true, false, n0, 0]);
  self._settings.set_int('active-border-width', 2);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b2 = self._windowBorders.get(win);
  assert.ok(b2._plaidGradient && b2 !== b);
  self.borders.destroy();
  assert.deepEqual([b2.destroyed, self._windowBorders.size, self.borders._tokens.length, self.borders._ringTemplate], [true, 0, 0, null]);
}));

test('ring on X11: the box stays inside the buffer, and so does the path', () => withSt(() => {
  const { self, actor, win } = setup();
  win.get_client_type = () => 1;
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  assert.deepEqual([b.x, b.y, b.width, b.height], [0, 0, 800, 600]);
  assert.deepEqual([uniforms(b).size, uniforms(b).path], [[800, 600], [400, 300, 399, 299]]);
  assert.deepEqual(rects(b)[0], [0, 0, 800, 18]);
}));

test('settings: radius, rounded corners, direction and width restyle the ring in place', () => withSt(() => {
  const { self, actor, win } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  self._settings.set_boolean('rounded-corners', true);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.deepEqual(uniforms(b).radius, [16], 'the masked corner plus half the stroke');
  self._settings.set_int('border-radius', 4);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.deepEqual(uniforms(b).radius, [5]);
  // The rotating gradient has no direction: a change keeps the ring.
  self._settings.set_string('gradient-direction', 'horizontal');
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  self._settings.set_int('active-border-width', 6);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.deepEqual([b.width, uniforms(b).half, uniforms(b).radius], [812, [3], [7]]);
  assert.equal(self._windowBorders.get(win), b);
  assert.equal(b.destroyed, false);
}));

test('surfaceActor: a border or ring of either kind is never the window\'s surface', () => withSt(() => {
  const { self, actor, win } = setup({ 'gradient-borders': false });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self.masks.surfaceActor(actor), null, 'only Plaid children: no surface yet');
  const surface = new FakeActor();
  actor.add_child(surface);
  assert.equal(self.masks.surfaceActor(actor), surface, 'a solid border is skipped');
  self._settings.set_boolean('gradient-borders', true);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  actor.children = [self._windowBorders.get(win), surface];
  assert.equal(self.masks.surfaceActor(actor), surface, 'a gradient border is skipped');
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  actor.children = [self._scratchpadRings.get(win), self._windowBorders.get(win), surface];
  assert.equal(self.masks.surfaceActor(actor), surface, 'the ring is skipped');
}));
test('ensureWindowBorder: a border kept in place goes back above a replaced client surface', () => withSt(() => {
  const { self, actor, win } = setup();
  const surface = new FakeActor();
  actor.add_child(surface);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  assert.equal(actor.get_last_child(), b);
  // Unchanged and on top: no restack.
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(actor.raises ?? 0, 0);
  // The surface replaced: the new one is appended after the border.
  actor.children = actor.children.filter(c => c !== surface);
  actor.add_child(new FakeActor());
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.equal(actor.get_last_child(), b);
  // Recoloured in place: also on top.
  actor.add_child(new FakeActor());
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), false);
  assert.equal(actor.get_last_child(), b);
}));

test('updateBordersDuringGrab: a scratch border is left for the pass, which lays it out with its ring', () => withSt(() => {
  const { self, actor, win, setFrame } = setup();
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  setFrame({ width: 600 });
  self.borders.updateBordersDuringGrab();
  assert.equal(b.width, 804, 'not moved by the grab loop');
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win).width, 604);
  assert.equal(self._scratchpadRings.get(win).width, 604 + 2 * 2);
}));

test('a rebuilt or removed gradient border drops its handler', () => withSt(() => {
  const { self, actor, win } = setup();
  const n0 = self.borders._tokens.length;
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self.borders._tokens.length, n0 + 1);
  for (let i = 0; i < 3; i++) {
    self._settings.set_boolean('gradient-borders', i % 2 === 0 ? false : true);
    self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  }
  self.borders.removeBorder(win);
  assert.equal(self.borders._tokens.length, n0);
}));

test('rotation stopped and started: the ring and the strips swap, handlers released, focus colours kept', () => withSt(() => {
  const { self, actor, win } = setup();
  const winB = fakeWin({ actor: new FakeActor(), frame: { x: 1000, y: 50, width: 400, height: 600 } });
  const n0 = self.borders._tokens.length;
  const pass = () => {
    self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
    self.borders.ensureWindowBorder(winB, winB.get_compositor_private(), winB.get_frame_rect(), false);
    return [self._windowBorders.get(win), self._windowBorders.get(winB)];
  };
  const speed = v => { self._settings.set_int('border-animation-speed', v); self.borders.forgetRotation(); };
  const [ra, rb] = pass();
  assert.ok(ra._plaidGradient && rb._plaidGradient);
  assert.equal(self.borders._tokens.length, n0 + 2, 'a views handler each');
  // Stopped: strips, the rings gone with their handlers.
  speed(0);
  const [sa, sb] = pass();
  assert.deepEqual([sa._plaidStrips?.length, sb._plaidStrips?.length], [4, 4]);
  assert.deepEqual([ra.destroyed, rb.destroyed, actor.children.includes(ra)], [true, true, false]);
  assert.deepEqual([ra.handlers.length, self.borders._tokens.length], [0, n0 + 8], 'four strip handlers each');
  assert.deepEqual([sa._plaidBorder.color1, sb._plaidBorder.color1].map(c => Math.round(c.r * 255)), [0xff, 0x20]);
  assert.equal(sa._plaidBorder.color2.b, 1, 'focused: colour 2 of the active pair');
  // Started again: rings, the strips gone with their handlers.
  speed(5);
  const [na, nb] = pass();
  assert.ok(na._plaidGradient && nb._plaidGradient && na !== ra);
  assert.deepEqual([sa.destroyed, sb.destroyed, self.borders._tokens.length], [true, true, n0 + 2]);
  assert.deepEqual([uniforms(na).color1, uniforms(nb).color1].map(c => Math.round(c[0] * 255)), [0xff, 0x20]);
  assert.deepEqual(actor.children, [na], 'one border on the window');
  // A focus change after the swap recolours the ring in place.
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), false);
  assert.equal(self._windowBorders.get(win), na);
  assert.deepEqual(uniforms(na).color1.map(v => Math.round(v * 255)), [0x20, 0x20, 0x20]);
  self.borders.removeBorder(win);
  self.borders.removeBorder(winB);
  assert.equal(self.borders._tokens.length, n0);
}));
test('ensureWindowBorder: a scratch border kept in place goes back on top with its ring above it', () => withSt(() => {
  const { self, actor, win } = setup();
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win), ring = self._scratchpadRings.get(win);
  actor.add_child(new FakeActor());
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.deepEqual(actor.children.slice(-2), [b, ring]);
}));

test('keepBorderOnTop: an unchanged border above the surface, with its ring, is never restacked', () => withSt(() => {
  const { self, actor, win } = setup();
  actor.add_child(new FakeActor());
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  for (let i = 0; i < 5; i++) self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(actor.raises ?? 0, 0);
}));

test('borderPath: the stroke\'s rect and radius, clamped; none when the stroke fills the border', () => {
  const m = makeSelf().borderMath;
  assert.deepEqual(m.borderPath({ width: 2, radius: 15 }, 804, 604), { x: 1, y: 1, pw: 802, ph: 602, r: 15 });
  assert.equal(m.borderPath({ width: 4, radius: 400 }, 100, 60).r, 28);
  assert.equal(m.borderPath({ width: 2, radius: -3 }, 50, 50).r, 0);
  assert.equal(m.borderPath({ width: 8, radius: 0 }, 8, 100), null);
});

test('noteGeometry: a move that keeps the frame where the last pass saw it in the buffer runs no pass', () => {
  const self = makeSelf({ enabled: true });
  let passes = 0;
  self.signals.scheduleBorders = () => passes++;
  self.grab.resizeLoopRunning = () => false;
  let frame = { x: 10, y: 10, width: 400, height: 300 }, buffer = { x: 0, y: 0, width: 420, height: 330 };
  const win = { get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...buffer }) };
  self.borders.noteGeometry(win);
  assert.equal(passes, 1, 'never seen by a pass');
  self.borders.notePass(win);
  frame = { ...frame, x: 510 }; buffer = { ...buffer, x: 500 };
  self.borders.noteGeometry(win);
  assert.equal(passes, 1, 'moved with its buffer');
  frame = { ...frame, x: 515 };
  self.borders.noteGeometry(win);
  assert.equal(passes, 2, 'the frame moved inside the buffer');
  self.borders.notePass(win);
  frame = { ...frame, width: 380 };
  self.borders.noteGeometry(win);
  assert.equal(passes, 3, 'resized');
  // A window waiting for its warp is not recorded: its next move runs a pass.
  const w2 = { get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...buffer }) };
  self._pendingWarp = new Set([w2]);
  self.borders.notePass(w2);
  self.borders.noteGeometry(w2);
  assert.equal(passes, 4);
});

test('noteGeometry: during a live resize the loop stands in for the pass, unless a mask or blur needs it', () => {
  const values = { enabled: true, 'rounded-corners': false, 'border-radius': 15, 'window-blur': false };
  const self = makeSelf(values);
  let passes = 0;
  self.signals.scheduleBorders = () => passes++;
  const frame = { x: 0, y: 0, width: 400, height: 300 };
  const actor = {};
  let mon = 0, fullscreen = false;
  const win = { get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...frame }), get_compositor_private: () => actor,
    get_monitor: () => mon, is_fullscreen: () => fullscreen };
  const border = { get_parent: () => actor };
  self._windowBorders.set(win, border);
  self._grabWindow = { get_monitor: () => 0 };
  self.grab.resizeLoopRunning = () => true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 0, 'resize loop, no mask or blur');
  values['rounded-corners'] = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 1, 'masks follow the pass');
  values['rounded-corners'] = false; values['window-blur'] = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 2, 'blur follows the pass');
  values['window-blur'] = false; values['border-radius'] = 0; values['rounded-corners'] = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 2, 'rounded at radius 0 draws no mask');
  // Only what the tick lays out: not another monitor's window, a fullscreen
  // one, a scratch border, or a window without a border.
  mon = 1;
  self.borders.noteGeometry(win);
  assert.equal(passes, 3, 'another monitor');
  mon = 0; fullscreen = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 4, 'fullscreen');
  fullscreen = false; border._plaidScratch = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 5, 'scratch');
  border._plaidScratch = false; self._windowBorders.delete(win);
  self.borders.noteGeometry(win);
  assert.equal(passes, 6, 'no border');
  self._windowBorders.set(win, { get_parent: () => ({}) });
  self.borders.noteGeometry(win);
  assert.equal(passes, 7, 'a border left on a replaced actor');
  self._windowBorders.set(win, border);
  values.enabled = false;
  self.borders.noteGeometry(win);
  assert.equal(passes, 8, 'tiling off: the tick places no border');
  values.enabled = true;
  self.grab.resizeLoopRunning = () => false;
  self.borders.noteGeometry(win);
  assert.equal(passes, 9, 'no resize loop');
});

test('doUpdateBorders: a window the pass strips or skips is not recorded as laid out', () => {
  const self = makeSelf({ 'borders-enabled': false, 'rounded-corners': false, 'window-blur': true, 'blur-exclude': [] });
  self.blur.ensureWindowBlur = () => {};
  self.blur.removeBlur = () => {};
  self.masks.removeMask = () => {};
  self.borders.syncBorderAnimation = () => {};
  let fs = false;
  const frame = { x: 0, y: 0, width: 400, height: 300 };
  const mk = () => ({ is_fullscreen: () => fs, get_compositor_private: () => ({}), get_frame_rect: () => ({ ...frame }),
    get_buffer_rect: () => ({ ...frame }), get_window_type: () => 0, get_wm_class_instance: () => 'gjs' });
  const tiled = mk(), fl = mk();
  self.windows.getWindowsForWorkspace = () => [tiled];
  self.windows.isFloating = (w) => w === fl;
  const ws = { list_windows: () => [tiled, fl] };
  const old = globalThis.global;
  globalThis.global = { ...old, display: { focus_window: null }, workspace_manager: { get_active_workspace: () => ws } };
  try {
    self.borders.doUpdateBorders();
    assert.ok(tiled._plaidPassGeom && fl._plaidPassGeom, 'both laid out');
    fs = true;
    self.borders.doUpdateBorders();
    assert.equal(tiled._plaidPassGeom, undefined, 'tiled fullscreen: stripped');
    assert.equal(fl._plaidPassGeom, undefined, 'float fullscreen: stripped');
  } finally {
    globalThis.global = old;
  }
  // Back from fullscreen at the same rect: the size-changed runs a pass.
  let passes = 0;
  self.signals.scheduleBorders = () => passes++;
  self.grab.resizeLoopRunning = () => false;
  fs = false;
  self.borders.noteGeometry(tiled);
  self.borders.noteGeometry(fl);
  assert.equal(passes, 2);
});

test('resizeLoopRunning: only while the loop runs in resize mode', () => {
  const self = makeSelf({ enabled: true });
  const clock = frameClock();
  try {
    const win = { get_monitor: () => 0, get_compositor_private: () => ({}), get_frame_rect: () => ({ width: 1, height: 1 }) };
    assert.equal(self.grab.resizeLoopRunning(), false);
    self.grab.startGrabLoop(win, 'move');
    assert.equal(self.grab.resizeLoopRunning(), false, 'a move drag lays out no borders');
    self.grab.startGrabLoop(win, 'resize');
    assert.equal(self.grab.resizeLoopRunning(), true);
    self.grab.stopLiveResizeLoop();
    assert.equal(self.grab.resizeLoopRunning(), false);
  } finally {
    clock.restore();
  }
});

test('borderAngle: the period is read once, again after the setting changes', () => {
  const values = { 'border-animation-speed': 5 };
  const self = makeSelf(values);
  let reads = 0;
  const get = self._settings.get_int;
  self._settings.get_int = k => { if (k === 'border-animation-speed') reads++; return get(k); };
  self.borders.borderAngle(); self.borders.borderAngle();
  assert.equal(reads, 1);
  values['border-animation-speed'] = 0;
  assert.equal(self.borders.borderAngle()[0], true, 'cached until told');
  self.borders.forgetRotation();
  assert.equal(self.borders.borderAngle()[0], false);
  assert.equal(reads, 2);
});

test('disconnectToken: releases a token whichever subsystem made it, once', () => {
  const self = makeSelf({ enabled: true });
  const calls = [];
  const emitter = { connectObject() {}, disconnectObject: t => calls.push(t) };
  const n0 = self.windows._tokens.length;
  const t = self.windows.connectObject(emitter, 'x', () => {});
  assert.equal(self.windows._tokens.length, n0 + 1);
  self.borders.disconnectToken(t); // another subsystem
  assert.equal(self.windows._tokens.length, n0);
  assert.deepEqual(calls, [t]);
  self.windows.disconnectToken(t);
  assert.equal(calls.length, 1, 'a second release does nothing');
  self.windows.disconnectToken(0);
  self.windows.disconnectToken(null);
});

function hookEmitter() {
  const handlers = [];
  return {
    handlers,
    connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) handlers.push([obj, a[i], a[i + 1]]); },
    disconnectObject(obj) { for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i][0] === obj) handlers.splice(i, 1); },
    fire(sig) { for (const [, s, fn] of [...handlers]) if (s === sig) fn(); },
  };
}

test('removeBlur: a blur\'s hooks are released also once its window actor is gone', () => {
  const self = makeSelf({ enabled: true });
  const actor = hookEmitter();
  const win = { get_compositor_private: () => null };
  const n0 = self.blur._tokens.length;
  const blur = {
    _actorDestroyId: self.blur.connectObject(actor, 'destroy', () => {}),
    _actorParentSetId: self.blur.connectObject(actor, 'parent-set', () => {}),
    _viewsToken: self.blur.connectObject(actor, 'stage-views-changed', () => {}),
    _settleNotifyIds: ['notify::x', 'notify::y'].map(sig => self.blur.connectObject(actor, sig, () => {})),
  };
  self._windowBlurs.set(win, blur);
  self.blur.removeBlur(win);
  assert.equal(self.blur._tokens.length, n0);
  assert.equal(actor.handlers.length, 0);
  assert.equal(self._windowBlurs.has(win), false);
});

test('disconnectGrabBoundaryHooks: released with no grab window, or another one', () => {
  const self = makeSelf({ enabled: true });
  const a = hookEmitter();
  const n0 = self.grab._tokens.length;
  self._grabSizeChangedId = self.grab.connectObject(a, 'size-changed', () => {});
  self._grabPositionChangedId = self.grab.connectObject(a, 'position-changed', () => {});
  self._grabWindow = null;
  self.grab.disconnectGrabBoundaryHooks();
  assert.equal(self.grab._tokens.length, n0);
  assert.equal(a.handlers.length, 0);
});

test('dropdown terminal: closing it releases its geometry and unmanaged hooks', () => {
  const self = makeSelf({ enabled: true });
  const win = Object.assign(hookEmitter(), { get_pid: () => 0 });
  const n0 = self.dropdown._tokens.length;
  self.dropdown.armDropdownWindow(win, 'term');
  assert.equal(self.dropdown._tokens.length, n0 + 3);
  win.fire('unmanaged');
  assert.equal(self.dropdown._tokens.length, n0);
  assert.equal(win.handlers.length, 0);
  assert.equal(self._dropdownWin, null);
});

test('background app: an unmanaged or first-frame hook releases its own token, not a later one', () => {
  const self = makeSelf({ enabled: true });
  const n0 = self.bgApp._tokens.length;
  const first = hookEmitter(), second = hookEmitter();
  const t1 = self.bgApp.connectObject(first, 'unmanaged', () => self.bgApp.releaseUnmanagedHook(t1));
  self._backgroundAppUnmanagedId = t1;
  const t2 = self.bgApp.connectObject(second, 'unmanaged', () => self.bgApp.releaseUnmanagedHook(t2));
  self._backgroundAppUnmanagedId = t2; // a later window's hook
  first.fire('unmanaged');
  assert.equal(self._backgroundAppUnmanagedId, t2, 'the later hook stays recorded');
  assert.equal(self.bgApp._tokens.length, n0 + 1);
  second.fire('unmanaged');
  assert.equal(self._backgroundAppUnmanagedId, 0);
  assert.equal(self.bgApp._tokens.length, n0);
});

test('background app: its unmanaged and first-frame hooks release the token they were given', () => {
  // The claim paths need the whole app setup; the wiring is read from the source.
  const src = readFileSync(new URL('../../extensions/modules/background-app.js', import.meta.url), 'utf8');
  const unmanaged = [...src.matchAll(/const (\w+) = this\.core\._backgroundAppUnmanagedId = this\.connectObject\(win, 'unmanaged', \(\) => \{\n\s+this\.releaseUnmanagedHook\((\w+)\);/g)];
  assert.equal(unmanaged.length, 2, 'both claim paths');
  for (const m of unmanaged) assert.equal(m[1], m[2]);
  assert.equal((src.match(/'unmanaged'/g) ?? []).length, 3, 'no other unmanaged hook (the waiter cleans up through cleanup)');
  const ff = src.match(/if \(this\.core\._backgroundAppFirstFrameId\) this\.disconnectToken\(this\.core\._backgroundAppFirstFrameId\);\n\s+const (\w+) = this\.core\._backgroundAppFirstFrameId = this\.connectObject\(actor, 'first-frame', \(\) => \{\n(?:\s+\/\/.*\n)?\s+this\.disconnectToken\((\w+)\);\n\s+if \(this\.core\._backgroundAppFirstFrameId === (\w+)\)\n\s+this\.core\._backgroundAppFirstFrameId = 0;/);
  assert.ok(ff, 'an earlier hook is released first; the hook releases its own token and clears only its own field');
  assert.ok(ff[1] === ff[2] && ff[2] === ff[3]);
});
