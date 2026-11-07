import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { makeSelf, oneMonitor, fakeSettings } from '../helpers.mjs';

// Border animation idle cost: colour-level gate, visibility gate, stop when
// nothing animates, mask re-arm, per-pass settings memo, no-Flair return.

test('_gradientThetaStep: one colour level per pi / (widest channel difference)', () => {
  const self = makeSelf();
  const black = { r: 0, g: 0, b: 0 };
  assert.equal(self._gradientThetaStep(black, { r: 1, g: 0, b: 0 }), Math.PI / 255);
  assert.equal(self._gradientThetaStep(black, { r: 0, g: 10 / 255, b: 2 / 255 }), Math.PI / 10);
});

test('_gradientThetaStep: equal (or sub-level) colours never need a re-render', () => {
  const self = makeSelf();
  const c = { r: 0.5, g: 0.5, b: 0.5 };
  assert.equal(self._gradientThetaStep(c, c), Infinity);
  assert.equal(self._gradientThetaStep(c, { r: 0.5 + 0.5 / 255, g: 0.5, b: 0.5 }), Infinity);
});

test('_gradientStale: undrawn is stale, then only after a full step, across the 2*pi wrap', () => {
  const self = makeSelf();
  assert.equal(self._gradientStale(undefined, 1, 0.1), true);
  assert.equal(self._gradientStale(1, 1.05, 0.1), false);
  assert.equal(self._gradientStale(1, 1.1, 0.1), true);
  assert.equal(self._gradientStale(Math.PI * 2 - 0.02, 0.03, 0.1), false);
  assert.equal(self._gradientStale(Math.PI * 2 - 0.05, 0.06, 0.1), true);
  assert.equal(self._gradientStale(undefined, 1, Infinity), false);
});

test('_settingsMemo reads each key once per pass', () => {
  let reads = 0;
  const self = makeSelf();
  self._settings = { get_int: () => ++reads, get_boolean: () => true, get_string: () => '', get_strv: () => [] };
  const memo = self._settingsMemo();
  assert.equal(memo.get_int('border-radius'), 1);
  assert.equal(memo.get_int('border-radius'), 1);
  assert.equal(memo.get_int('active-border-width'), 2);
  assert.equal(reads, 2);
  // A new pass reads again: the memo is never kept between passes.
  assert.equal(self._settingsMemo().get_int('border-radius'), 3);
});

// The 33 ms tick, captured from GLib.timeout_add; Date.now is the rotation clock.
const ANIM = { 'gradient-borders': true, 'border-animation-speed': 5 };
const PERIOD = 12000; // borderRotationMs(5)
function withTick(fn) {
  const orig = { add: GLib.timeout_add, remove: GLib.source_remove, now: Date.now };
  const t = { fn: null, starts: 0, removed: 0, clock: 0 };
  GLib.timeout_add = (_p, _ms, cb) => { t.fn = cb; t.starts++; return 7; };
  GLib.source_remove = () => { t.removed++; return true; };
  Date.now = () => t.clock;
  try {
    return fn(t);
  } finally {
    GLib.timeout_add = orig.add;
    GLib.source_remove = orig.remove;
    Date.now = orig.now;
    Main.overview.visible = false;
  }
}
const at = (theta) => (theta / (Math.PI * 2)) * PERIOD;
function border(step, mapped = true) {
  const b = { _plaidBorder: { thetaStep: step }, mapped, repaints: 0 };
  b._plaidStrips = [{ visible: true, queue_repaint() { b.repaints++; } }];
  return b;
}
function mask(step, mapped = true) {
  const actor = { mapped };
  return { _plaidThetaStep: step, thetas: [], get_actor: () => actor, setTheta(t) { this.thetas.push(t); } };
}

test('border tick: an unmapped border or mask is skipped, unless the overview is shown', () => {
  withTick((t) => {
    const self = makeSelf(ANIM);
    const on = border(0.01), off = border(0.01, false);
    const mOn = mask(0.01), mOff = mask(0.01, false);
    self._windowBorders.set({}, on).set({}, off);
    self._windowMasks.set({}, mOn).set({}, mOff);
    self._startBorderAnimation();
    t.clock = at(1);
    assert.equal(t.fn(), GLib.SOURCE_CONTINUE);
    assert.equal(on.repaints, 1);
    assert.equal(off.repaints, 0);
    assert.equal(mOn.thetas.length, 1);
    assert.equal(mOff.thetas.length, 0);
    Main.overview.visible = true;
    t.clock = at(2);
    t.fn();
    assert.equal(off.repaints, 1);
    assert.equal(mOff.thetas.length, 1);
  });
});

test('border tick: re-rendered only once the colour moved a full level', () => {
  withTick((t) => {
    const self = makeSelf(ANIM);
    const b = border(0.1), m = mask(0.1);
    self._windowBorders.set({}, b);
    self._windowMasks.set({}, m);
    self._startBorderAnimation();
    t.clock = at(1);
    t.fn();
    t.clock = at(1.05);
    t.fn();
    assert.equal(b.repaints, 1);
    assert.equal(m.thetas.length, 1);
    t.clock = at(1.1);
    t.fn();
    assert.equal(b.repaints, 2);
    assert.deepEqual(m.thetas.length, 2);
  });
});

test('border tick: a mask whose actor is gone is skipped, the others still rotate', () => {
  withTick((t) => {
    const self = makeSelf(ANIM);
    const gone = mask(0.01);
    gone.get_actor = () => null;
    const live = mask(0.01);
    self._windowMasks.set({}, gone).set({}, live);
    self._startBorderAnimation();
    t.clock = at(1);
    assert.equal(t.fn(), GLib.SOURCE_CONTINUE);
    assert.equal(gone.thetas.length, 0);
    assert.equal(live.thetas.length, 1);
  });
});

test('border tick: stops when nothing draws a two-colour gradient', () => {
  withTick((t) => {
    const self = makeSelf(ANIM);
    self._windowBorders.set({}, border(Infinity));
    self._windowMasks.set({}, mask(Infinity));
    self._windowBorders.set({ id: 2 }, border(0.01));
    self._startBorderAnimation();
    t.clock = at(1);
    assert.equal(t.fn(), GLib.SOURCE_CONTINUE);
    self._windowBorders.delete([...self._windowBorders.keys()][1]);
    assert.equal(t.fn(), GLib.SOURCE_REMOVE);
    assert.equal(self._borderAnimId, 0);
  });
});

test('_syncBorderAnimation: borders and masks without a two-colour gradient arm no tick', () => {
  withTick((t) => {
    const self = makeSelf(ANIM);
    self._windowBorders.set({}, border(Infinity));
    self._windowBorders.set({ plain: 1 }, { mapped: true });
    self._windowMasks.set({}, mask(Infinity));
    self._syncBorderAnimation();
    assert.equal(t.starts, 0);
    self._windowMasks.set({ id: 2 }, mask(0.02));
    self._syncBorderAnimation();
    assert.equal(t.starts, 1);
    assert.equal(self._borderAnimId, 7);
  });
});

// updateMaskBounds against a Wayland window and an attached effect.
function maskWin() {
  const frame = { x: 0, y: 0, width: 400, height: 300 };
  return {
    get_client_type: () => 0,
    get_buffer_rect: () => ({ ...frame }),
    get_frame_rect: () => ({ ...frame }),
    get_wm_class_instance: () => 'gjs',
    get_wm_class: () => 'gjs',
    get_gtk_application_id: () => null,
  };
}
function maskEffect() {
  return { updates: [], updateMask(...a) { this.updates.push(a); }, get_actor: () => ({ mapped: true }) };
}
function updateMask(settings) {
  return withTick((t) => {
    const old = globalThis.global.display;
    globalThis.global.display = oneMonitor();
    try {
      const self = makeSelf({ ...ANIM, 'borders-enabled': true, 'active-border-width': 2,
        'inactive-border-width': 2, 'inactive-border-color': ['#000000'], 'inactive-border-color-2': ['#0a0000'],
        ...settings });
      const eff = maskEffect();
      self._updateMaskBounds(maskWin(), { width: 400, height: 300 }, eff, 12);
      return { eff, t, self };
    } finally {
      globalThis.global.display = old;
    }
  });
}

test('mask thetaStep: finite only for a rotating gradient with a drawn border, which re-arms the tick', () => {
  const { eff, t, self } = updateMask({});
  assert.equal(eff._plaidThetaStep, Math.PI / 10);
  assert.equal(typeof eff._plaidTheta, 'number');
  assert.equal(t.starts, 1);
  assert.equal(self._borderAnimId, 7);
});

test('mask thetaStep: Infinity at border width 0 and outside the rotating mode', () => {
  for (const s of [{ 'borders-enabled': false }, { 'inactive-border-width': 0 },
    { 'gradient-borders': false }, { 'border-animation-speed': 0 }]) {
    const { eff, t } = updateMask(s);
    assert.equal(eff._plaidThetaStep, Infinity, JSON.stringify(s));
    assert.equal(t.starts, 0, JSON.stringify(s));
  }
});

test('_handleGrabEnd syncs the border animation instead of starting it', () => {
  const calls = [];
  const self = makeSelf({ enabled: true }, {
    _isFloating: () => false,
    _kickMaskNow() {},
    _getWindowsForWorkspace: () => [],
    _retileWorkspace() {},
    _startBorderAnimation: () => calls.push('start'),
    _syncBorderAnimation: () => calls.push('sync'),
  });
  // The passes a live resize stood in for: one at the end.
  self.signals.scheduleBorders = () => calls.push('pass');
  self._grabOp = 1;
  const ws = { id: 0 };
  const old = globalThis.global;
  globalThis.global = {
    display: oneMonitor(),
    workspace_manager: { get_n_workspaces: () => 1, get_workspace_by_index: () => ws, get_active_workspace: () => ws },
    get_pointer: () => [0, 0],
  };
  try {
    self._handleGrabEnd(null, 1);
  } finally {
    globalThis.global = old;
  }
  assert.deepEqual(calls, ['sync', 'pass']);
});

test('border-animation-speed changed: the cached rotation period is dropped before the resync', () => {
  // connectSignals needs the whole shell; the handler is read from the source.
  const src = readFileSync(new URL('../../extensions/modules/signals.js', import.meta.url), 'utf8');
  const m = src.match(/'changed::border-animation-speed', \(\) => \{([\s\S]*?)\n {8}\}\);/);
  assert.ok(m, 'handler found');
  const calls = [...m[1].matchAll(/this\.core\.borders\.(\w+)\(/g)].map(x => x[1]);
  assert.deepEqual(calls, ['forgetRotation', 'syncBorderAnimation', 'updateBorders']);
});

test('syncBlurStackingNow: no blurs, no work', () => {
  const self = makeSelf({ enabled: true });
  self._windowBlurs = new Map();
  const old = globalThis.global;
  let reads = 0;
  globalThis.global = { ...old, display: { get_n_monitors: () => { reads++; return 1; }, get_monitor_geometry: () => { reads++; return {}; } } };
  try {
    assert.equal(self.blur.syncBlurStackingNow(), false);
  } finally {
    globalThis.global = old;
  }
  assert.equal(reads, 0);
});

test('_doUpdateBorders: with no Flair on it removes every border, mask and blur and walks no window', () => {
  const removed = [];
  let walked = false;
  const self = makeSelf({ 'borders-enabled': false, 'rounded-corners': true, 'border-radius': 0, 'window-blur': false }, {
    _removeAllBorders: () => removed.push('borders'),
    _removeAllMasks: () => removed.push('masks'),
    _removeAllBlurs: () => removed.push('blurs'),
    _getWindowsForWorkspace: () => { walked = true; return []; },
    _syncBorderAnimation: () => removed.push('sync'),
  });
  const old = globalThis.global;
  globalThis.global = { display: oneMonitor(), workspace_manager: { get_active_workspace: () => { walked = true; return {}; } } };
  try {
    self._doUpdateBorders();
  } finally {
    globalThis.global = old;
  }
  assert.deepEqual(removed.sort(), ['blurs', 'borders', 'masks', 'sync']);
  assert.equal(walked, false);
});

test('_startBorderAnimation: no tick once shutdown has begun (a mask re-arm after the stop)', () => {
  withTick((t) => {
    const self = makeSelf(ANIM, { _shuttingDown: true });
    self._windowMasks.set({}, mask(0.02));
    self._startBorderAnimation();
    assert.equal(t.starts, 0);
    assert.equal(self._borderAnimId, 0);
  });
});

test('_doUpdateBorders: with no Flair on the dropdown terminal still gets its effects removed', () => {
  const applied = [];
  const ddt = {};
  const self = makeSelf({ 'borders-enabled': false, 'rounded-corners': false, 'window-blur': false }, {
    _removeAllBorders() {}, _removeAllMasks() {}, _removeAllBlurs() {}, _syncBorderAnimation() {},
    _applyDropdownEffects: (w) => applied.push(w),
  });
  self._dropdownWin = ddt;
  const old = globalThis.global;
  globalThis.global = { display: oneMonitor() };
  try {
    self._doUpdateBorders();
  } finally {
    globalThis.global = old;
  }
  assert.deepEqual(applied, [ddt]);
});

test('border tick: a plain (non-gradient) border widget in the map is skipped, not an error', () => {
  withTick((t) => {
    const self = makeSelf(ANIM);
    const plain = { mapped: true, repaints: 0, queue_repaint() { this.repaints++; } };
    self._windowBorders.set({}, plain).set({ id: 2 }, border(0.01));
    self._startBorderAnimation();
    t.clock = at(1);
    assert.equal(t.fn(), GLib.SOURCE_CONTINUE);
    assert.equal(plain.repaints, 0);
  });
});

test('updateMaskBounds without settings (disable): the mask no longer keeps a tick wanted', () => {
  const old = globalThis.global.display;
  globalThis.global.display = oneMonitor();
  try {
    const self = makeSelf(ANIM);
    const eff = maskEffect();
    eff._plaidThetaStep = 0.02;
    self._settings = null;
    self._updateMaskBounds(maskWin(), { width: 400, height: 300 }, eff, 12);
    assert.equal(eff._plaidThetaStep, Infinity);
  } finally {
    globalThis.global.display = old;
  }
});

test('mask opacity: window-blur-opacity only for a window that is blurred (not on blur-exclude)', () => {
  const base = { 'window-blur': true, 'window-blur-opacity': 80 };
  assert.equal(updateMask(base).eff.updates[0][10], 0.8);
  assert.equal(updateMask({ ...base, 'blur-exclude': ['gjs'] }).eff.updates[0][10], 1);
});

test('_doUpdateBorders: blur gets the pass\'s settings memo, for tiled and floating windows', () => {
  const self = makeSelf({ 'borders-enabled': false, 'rounded-corners': false, 'window-blur': true, 'blur-exclude': [] });
  const got = [];
  self.blur.ensureWindowBlur = (w, a, s) => got.push([w.t, s]);
  self.masks.removeMask = () => {};
  self.borders.syncBorderAnimation = () => {};
  const mk = (t) => Object.assign(fakeWinLite(t), { t });
  const tiled = mk('tiled'), fl = mk('float');
  self.windows.getWindowsForWorkspace = () => [tiled];
  self.windows.isFloating = (w) => w === fl;
  const ws = { list_windows: () => [tiled, fl] };
  const old = globalThis.global;
  globalThis.global = { ...old, display: { ...oneMonitor(), focus_window: null },
    workspace_manager: { get_active_workspace: () => ws } };
  try {
    self.borders.doUpdateBorders();
  } finally {
    globalThis.global = old;
  }
  assert.deepEqual(got.map(g => g[0]), ['tiled', 'float']);
  for (const [, s] of got) {
    assert.ok(s && s !== self._settings, 'the memo');
    assert.deepEqual(s.get_strv('blur-exclude'), []);
  }
});

function fakeWinLite() {
  const frame = { x: 0, y: 0, width: 400, height: 300 };
  return { is_fullscreen: () => false, get_compositor_private: () => ({}), get_frame_rect: () => ({ ...frame }),
    get_buffer_rect: () => ({ ...frame }),
    get_window_type: () => 0, get_wm_class_instance: () => 'gjs' };
}

test('mask opacity: decided by the pass\'s settings memo when one is handed in', () => {
  const old = globalThis.global.display;
  globalThis.global.display = oneMonitor();
  try {
    const base = { ...ANIM, 'borders-enabled': true, 'active-border-width': 2, 'inactive-border-width': 2,
      'inactive-border-color': ['#000000'], 'inactive-border-color-2': ['#0a0000'],
      'window-blur': true, 'window-blur-opacity': 80 };
    const self = makeSelf({ ...base, 'blur-exclude': [] });
    const eff = maskEffect();
    self._updateMaskBounds(maskWin(), { width: 400, height: 300 }, eff, 12, fakeSettings({ ...base, 'blur-exclude': ['gjs'] }));
    assert.equal(eff.updates[0][10], 1);
  } finally {
    globalThis.global.display = old;
  }
});
