import { test } from 'node:test';
import assert from 'node:assert/strict';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import { makeSelf } from '../helpers.mjs';
import { buildMaskAlpha } from '../../extensions/modules/mask.js';

// Rounded corners: an alpha mask on the window's own texture, the surface
// actor one level below opaque, the border widget hugging the corner.

Cogl.PixelFormat ??= { A_8: 17 };
Cogl.Texture2D ??= { new_from_data: (_ctx, w, h, fmt, stride, data) => ({ w, h, fmt, stride, data }) };

function fakeWorld({ texW = 420, texH = 330, buffer = { x: 90, y: 40, width: 420, height: 330 },
    frame = { x: 100, y: 50, width: 400, height: 300 } } = {}) {
  const handlers = [];
  const tex = { get_width: () => texW, get_height: () => texH, get_n_planes: () => 1 };
  const stex = {
    masks: [],
    set_mask_texture(m) { this.masks.push(m); },
    get_texture: () => tex,
    connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) handlers.push([obj, a[i], a[i + 1]]); },
    disconnectObject(obj) { for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i][0] === obj) handlers.splice(i, 1); },
    fire(sig) { for (const [, s, fn] of [...handlers]) if (s === sig) fn(); },
    handlers,
  };
  const surface = { opacity: 255, redraws: 0, parent: true, get_parent() { return this.parent; },
    get_next_sibling: () => null, queue_redraw() { this.redraws++; } };
  const actor = { get_texture: () => world.stex, get_first_child: () => surface };
  const win = { get_buffer_rect: () => ({ ...world.buffer }), get_frame_rect: () => ({ ...world.frame }),
    get_compositor_private: () => actor, get_wm_class_instance: () => 'gjs', get_wm_class: () => 'gjs',
    get_gtk_application_id: () => null };
  const world = { stex, tex, surface, actor, win, buffer, frame };
  return world;
}

function maskSelf(extra = {}) {
  const self = makeSelf({ enabled: true, 'window-blur': false, 'window-blur-opacity': 100, ...extra });
  const old = globalThis.global.stage;
  globalThis.global.stage = { get_context: () => ({ get_backend: () => ({ get_cogl_context: () => ({}) }) }) };
  return { self, restore: () => { globalThis.global.stage = old; } };
}

test('buildMaskAlpha: opaque inside the rounded rect, clear outside, antialiased corners, four alike', () => {
  const w = 40, h = 30;
  const a = buildMaskAlpha(w, h, 5, 4, 35, 26, 6);
  const at = (x, y) => a[y * w + x];
  assert.equal(at(0, 0), 0);
  assert.equal(at(4, 10), 0, 'left of the rect');
  assert.equal(at(5, 10), 255, 'left edge column');
  assert.equal(at(34, 10), 255, 'right edge column');
  assert.equal(at(35, 10), 0);
  assert.equal(at(20, 3), 0);
  assert.equal(at(20, 4), 255);
  assert.equal(at(20, 25), 255);
  assert.equal(at(20, 26), 0);
  assert.equal(at(5, 4), 0, 'the very corner is outside the arc');
  assert.equal(at(8, 7), 255, 'inside the arc');
  const partial = [...a].filter(v => v > 0 && v < 255).length;
  assert.ok(partial > 0, 'some antialiased pixels');
  // Mirror symmetry of the corners.
  for (let y = 4; y < 10; y++)
    for (let x = 5; x < 11; x++) {
      const v = at(x, y);
      assert.equal(at(w - 1 - x, y), v, `x mirror ${x},${y}`);
      assert.equal(at(x, h - 1 - y), v, `y mirror ${x},${y}`);
    }
});

test('buildMaskAlpha: radius clamped to half the rect; empty rect is all clear; radius 0 is square', () => {
  const a = buildMaskAlpha(10, 10, 0, 0, 10, 10, 50);
  assert.equal(a[5 * 10 + 5], 255);
  assert.equal(a[0], 0);
  assert.ok([...buildMaskAlpha(8, 8, 4, 4, 4, 8, 2)].every(v => v === 0));
  const sq = buildMaskAlpha(6, 6, 1, 1, 5, 5, 0);
  assert.equal(sq[1 * 6 + 1], 255);
  assert.equal(sq[0], 0);
});

test('maskRect: the frame inside the buffer, in texture pixels (scaled buffer), clamped', () => {
  const { self } = maskSelf();
  const w = fakeWorld();
  assert.deepEqual(self.masks.maskRect(w.win, 420, 330), { x0: 10, y0: 10, x1: 410, y1: 310, scale: 1 });
  assert.deepEqual(self.masks.maskRect(w.win, 840, 660), { x0: 20, y0: 20, x1: 820, y1: 620, scale: 2 });
  w.frame.width = 900;
  assert.equal(self.masks.maskRect(w.win, 420, 330).x1, 420);
  w.buffer.width = 0;
  assert.equal(self.masks.maskRect(w.win, 420, 330), null);
});

test('ensureWindowMask: masks the texture, puts the surface one level below opaque, rebuilds only on a change', () => {
  const { self, restore } = maskSelf();
  try {
    const w = fakeWorld();
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.stex.masks.length, 1);
    const m = w.stex.masks[0];
    assert.deepEqual([m.w, m.h, m.fmt, m.stride], [420, 330, Cogl.PixelFormat.A_8, 420]);
    assert.equal(w.surface.opacity, 254);
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.stex.masks.length, 1, 'same geometry: no rebuild');
    w.frame.height = 280;
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.stex.masks.length, 2, 'the frame changed');
    self.masks.ensureWindowMask(w.win, w.actor, 20);
    assert.equal(w.stex.masks.length, 3, 'the radius changed');
    // The texture resized: rebuilt at once.
    w.tex.get_width = () => 500;
    w.stex.fire('size-changed');
    assert.equal(w.stex.masks.length, 4);
    assert.equal(w.stex.masks[3].w, 500);
  } finally {
    restore();
  }
});

test('ensureWindowMask: a replaced texture is masked anew; removal clears the mask and restores the surface', () => {
  const { self, restore } = maskSelf();
  try {
    const w = fakeWorld();
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    const first = w.stex;
    const n0 = self.masks._tokens.length;
    w.stex = { ...first, masks: [], set_mask_texture(m) { this.masks.push(m); } };
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(first.masks.at(-1).w, 1, 'the old texture unmasked (a 1x1 opaque mask)');
    assert.equal(w.stex.masks.length, 1);
    assert.equal(self.masks._tokens.length, n0, 'the old size hook released, the new one held');
    self.masks.removeMask(w.win);
    assert.deepEqual([w.stex.masks.at(-1).w, w.stex.masks.at(-1).h, [...w.stex.masks.at(-1).data]], [1, 1, [255]]);
    assert.equal(w.surface.opacity, 255);
    assert.equal(self._windowMasks.has(w.win), false);
    assert.equal(self.masks._tokens.length, n0 - 1);
  } finally {
    restore();
  }
});

test('ensureWindowMask: a blurred window paints at window-blur-opacity; nothing without a mask API or texture', () => {
  const { self, restore } = maskSelf({ 'window-blur': true, 'window-blur-opacity': 60 });
  try {
    const w = fakeWorld();
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.surface.opacity, 153);
    const w2 = fakeWorld();
    delete w2.stex.set_mask_texture;
    self.masks.ensureWindowMask(w2.win, w2.actor, 15);
    assert.equal(self._windowMasks.has(w2.win), false);
    const w3 = fakeWorld();
    w3.stex.get_texture = () => null;
    self.masks.ensureWindowMask(w3.win, w3.actor, 15);
    assert.equal(self._windowMasks.has(w3.win), false, 'no buffer yet: a later pass');
  } finally {
    restore();
  }
});

test('border radius: with rounded corners the stroke hugs the masked corner; without, unchanged', () => {
  class A { constructor(p = {}) { Object.assign(this, { x: 0, y: 0, width: 0, height: 0, visible: true }, p); this.children = []; this.parent = null; }
    add_child(c) { this.children.push(c); c.parent = this; } get_parent() { return this.parent; }
    get_last_child() { return this.children.at(-1) ?? null; } get_previous_sibling() { return null; }
    set_position(x, y) { this.x = x; this.y = y; } set_size(w, h) { this.width = w; this.height = h; }
    set_style(s) { this.style = s; } destroy() {} connectObject() {} disconnectObject() {} queue_repaint() {} }
  const old = { W: St.Widget, D: St.DrawingArea };
  St.Widget = A; St.DrawingArea = A;
  try {
    for (const [rounded, gradient, want] of [[true, true, 15 + 2], [false, true, 15], [true, false, 'border-radius: 19px'], [false, false, 'border-radius: 15px']]) {
      const self = makeSelf({ enabled: true, 'borders-enabled': true, 'gradient-borders': gradient, 'rounded-corners': rounded,
        'border-radius': 15, 'active-border-width': 4, 'inactive-border-width': 4, 'gradient-direction': 'vertical',
        'active-border-color': ['#ff0000'], 'active-border-color-2': ['#0000ff'] });
      const actor = new A();
      const frame = { x: 0, y: 0, width: 400, height: 300 };
      const win = { get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...frame }), get_compositor_private: () => actor };
      self.borders.ensureWindowBorder(win, actor, frame, true);
      const b = self._windowBorders.get(win);
      if (gradient) assert.equal(b._plaidBorder.radius, want, `rounded=${rounded}`);
      else assert.match(b.style, new RegExp(want), `rounded=${rounded}`);
    }
    // The scratch ring sits on the border's outer edge either way.
    const self = makeSelf({ enabled: true, 'borders-enabled': true, 'gradient-borders': false, 'rounded-corners': true,
      'border-radius': 15, 'active-border-width': 4, 'inactive-border-width': 4, 'active-border-color': ['#ff0000'] });
    const actor = new A();
    const frame = { x: 0, y: 0, width: 400, height: 300 };
    const win = { get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...frame }), get_compositor_private: () => actor };
    self._scratchpadWindows = new Set([win]);
    self._scratchpadRings = new Map();
    self.borders.ensureWindowBorder(win, actor, frame, true);
    assert.match(self._scratchpadRings.get(win).style, /border-radius: 23px/);
  } finally {
    St.Widget = old.W; St.DrawingArea = old.D;
  }
});

test('buildMaskAlpha: a reused buffer gives the same mask, cleared of the last one', () => {
  const fresh = buildMaskAlpha(30, 20, 2, 2, 28, 18, 5);
  const buf = new Uint8Array(30 * 20 + 50).fill(255);
  const reused = buildMaskAlpha(30, 20, 2, 2, 28, 18, 5, buf);
  assert.deepEqual([...reused], [...fresh]);
  assert.equal(reused.buffer, buf.buffer, 'a view on the buffer');
  assert.equal(buildMaskAlpha(40, 40, 0, 0, 40, 40, 0, buf).length, 1600, 'too small: a new array');
});

test('ensureWindowMask: an X11 window mutter frames keeps its own mask; a size change always rebuilds', () => {
  const { self, restore } = maskSelf();
  try {
    const w = fakeWorld();
    w.win.get_client_type = () => 1;
    w.win.decorated = true;
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.stex.masks.length, 0, 'framed X11: left to mutter');
    w.win.decorated = false;
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.stex.masks.length, 1, 'undecorated X11 (client-side frame): masked');
    // mutter cleared the mask on a size change the key cannot see.
    w.stex.fire('size-changed');
    assert.equal(w.stex.masks.length, 2, 'built again');
  } finally {
    restore();
  }
});

test('removeMask: the surface goes back to the opacity it had (an X11 window opacity)', () => {
  const { self, restore } = maskSelf();
  try {
    const w = fakeWorld();
    w.surface.opacity = 200;
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.surface.opacity, 254);
    self.masks.removeMask(w.win);
    assert.equal(w.surface.opacity, 200);
  } finally {
    restore();
  }
});

test('maskable: never a fullscreen window, a framed X11 window or a multi-plane (YUV) texture', () => {
  const { self, restore } = maskSelf({ 'window-blur': true, 'window-blur-opacity': 60 });
  try {
    for (const [name, set] of [
      ['fullscreen', w => { w.win.is_fullscreen = () => true; }],
      ['framed X11', w => { w.win.get_client_type = () => 1; w.win.decorated = true; }],
      ['two planes', w => { w.tex.get_n_planes = () => 2; }],
    ]) {
      const w = fakeWorld();
      set(w);
      self.masks.ensureWindowMask(w.win, w.actor, 15);
      assert.equal(w.stex.masks.length, 0, `${name}: no mask`);
      assert.equal(w.surface.opacity, 153, `${name}: the blur opacity still applies`);
      self.masks.removeMask(w.win);
      assert.equal(w.stex.masks.length, 0, `${name}: removal sets no mask either`);
      assert.equal(w.surface.opacity, 255);
    }
  } finally {
    restore();
  }
});

test('a mask mutter cleared (a size change) is left clear when the window may no longer be masked', () => {
  const { self, restore } = maskSelf();
  try {
    const w = fakeWorld();
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.stex.masks.length, 1);
    // Fullscreen: the size changes (mutter clears the mask), then the pass removes it.
    w.win.is_fullscreen = () => true;
    w.tex.get_width = () => 2560;
    w.stex.fire('size-changed');
    self.masks.removeMask(w.win);
    assert.equal(w.stex.masks.length, 1, 'no 1x1 mask over the cleared one');
    // Rounded corners turned off while masked: the 1x1 mask replaces Plaid's.
    const w2 = fakeWorld();
    self.masks.ensureWindowMask(w2.win, w2.actor, 15);
    self.masks.removeMask(w2.win);
    assert.equal(w2.stex.masks.at(-1).w, 1);
  } finally {
    restore();
  }
});

test('opacity: Plaid restores only what it changed; an unmasked, unblurred window is left to mutter', () => {
  const { self, restore } = maskSelf();
  try {
    const w = fakeWorld();
    w.win.get_client_type = () => 1;
    w.win.decorated = true;
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    w.surface.opacity = 180; // mutter applies the window's _NET_WM_WINDOW_OPACITY
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.surface.opacity, 180, 'left alone');
    self.masks.removeMask(w.win);
    assert.equal(w.surface.opacity, 180);
    // A masked window: the value it had when Plaid first changed it comes back.
    const w2 = fakeWorld();
    w2.surface.opacity = 230;
    self.masks.ensureWindowMask(w2.win, w2.actor, 15);
    assert.equal(w2.surface.opacity, 254);
    self.masks.removeMask(w2.win);
    assert.equal(w2.surface.opacity, 230);
  } finally {
    restore();
  }
});

test('maskable: a texture without a plane count is not masked (fails closed)', () => {
  const { self, restore } = maskSelf();
  try {
    const w = fakeWorld();
    delete w.tex.get_n_planes;
    self.masks.ensureWindowMask(w.win, w.actor, 15);
    assert.equal(w.stex.masks.length, 0);
  } finally {
    restore();
  }
});
