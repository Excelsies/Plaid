import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// New windows: placed while the overview is open, no map effect at the spawn
// rect, pre-placed before the first commit, the backstop places before it
// reveals, a window that turns out floating is shown at once.

// An emitter with connectObject/disconnectObject; emit(sig) runs its handlers.
function emitter(extra = {}) {
  return {
    handlers: [],
    connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) this.handlers.push([obj, a[i], a[i + 1]]); },
    disconnectObject(obj) { this.handlers = this.handlers.filter(h => h[0] !== obj); },
    emit(sig) { for (const [, s, fn] of [...this.handlers]) if (s === sig) fn(); },
    ...extra,
  };
}

const WS = {};
function newWin(id, { mapped = false, frame = { x: 400, y: 300, width: 800, height: 600 } } = {}) {
  const actor = emitter({ visible: true, opacity: 255, mapped, set_opacity(v) { this.opacity = v; } });
  const w = fakeWin({ id, instance: `w${id}` });
  Object.assign(w, emitter(), {
    _frame: { ...frame }, _configs: [], _actor: actor,
    get_id: () => id,
    get_workspace: () => WS,
    get_window_type: () => 0,
    get_frame_rect: () => ({ ...w._frame }),
    get_compositor_private: () => actor,
    move_resize_frame: (_u, x, y, width, height) => { w._configs.push([x, y, width, height]); },
  });
  return w;
}

function withOverview(visible, fn) {
  Main.overview.visible = visible;
  try {
    return fn();
  } finally {
    Main.overview.visible = false;
  }
}

test('onWindowCreated: a window opened in the overview is placed from shown, once', () => {
  const self = makeSelf({ enabled: true });
  const placed = [];
  self.dropdown.handleDropdownWindowCreated = () => false;
  self.bgApp.handleBackgroundAppWindowCreated = () => false;
  self.windows.shouldManage = () => true;
  self.windows.addWindow = () => {};
  self.windows.markPendingWindowInvisible = (w) => placed.push(['hide', w]);
  self.layouts.retileWorkspace = (ws) => placed.push(['retile', ws]);
  const w = newWin(1);
  self.signals.onWindowCreated(w);
  w.emit('shown');
  assert.deepEqual(placed, [], 'outside the overview: waits for its first frame');
  withOverview(true, () => w.emit('shown'));
  assert.deepEqual(placed, [['hide', w], ['retile', WS]]);
  w._actor.emit('first-frame');
  assert.equal(placed.length, 2, 'placed once');
  assert.equal(w._actor.handlers.length + w.handlers.length, 0, 'both hooks gone');
});

test('onWindowCreated: outside the overview the first frame places it', () => {
  const self = makeSelf({ enabled: true });
  const placed = [];
  self.dropdown.handleDropdownWindowCreated = () => false;
  self.bgApp.handleBackgroundAppWindowCreated = () => false;
  self.windows.shouldManage = () => true;
  self.windows.addWindow = () => {};
  self.windows.markPendingWindowInvisible = () => placed.push('hide');
  self.layouts.retileWorkspace = () => placed.push('retile');
  const w = newWin(1);
  self.signals.onWindowCreated(w);
  w._actor.emit('first-frame');
  assert.deepEqual(placed, ['hide', 'retile']);
});

function hideSelf(extra = {}) {
  const self = makeSelf({ enabled: true });
  self.placement.getAnimationTime = () => 0.2;
  self.windows.isFloating = () => false;
  self.signals.scheduleBorders = () => {};
  self.geometry.wsIndex = () => 1;
  Object.assign(self, extra);
  return self;
}

function withTimers(fn) {
  const orig = { add: GLib.timeout_add, remove: GLib.source_remove };
  const timers = [];
  GLib.timeout_add = (_p, ms, cb) => { timers.push([ms, cb]); return timers.length; };
  GLib.source_remove = () => true;
  const skipped = [];
  const oldSkip = Main.wm.skipNextEffect;
  Main.wm.skipNextEffect = (a) => skipped.push(a);
  try {
    return fn(timers, skipped);
  } finally {
    GLib.timeout_add = orig.add;
    GLib.source_remove = orig.remove;
    Main.wm.skipNextEffect = oldSkip;
  }
}

test('markPendingWindowInvisible: the map effect is skipped once, only before the map', () => {
  withTimers((timers, skipped) => {
    const self = hideSelf();
    const w = newWin(1);
    self._newWindowSet.add(w);
    self.windows.markPendingWindowInvisible(w, w._actor);
    self.windows.markPendingWindowInvisible(w, w._actor);
    assert.deepEqual(skipped, [w._actor]);
    assert.equal(w._actor.visible, false);
    const m = newWin(2, { mapped: true });
    self._newWindowSet.add(m);
    self.windows.markPendingWindowInvisible(m, m._actor);
    assert.equal(skipped.length, 1, 'a mapped actor keeps its next effect');
  });
});

test('markPendingWindowInvisible: a new window that turns out floating is shown at once, out of the choreography', () => {
  withTimers(() => {
    const self = hideSelf();
    self.windows.isFloating = () => true;
    const w = newWin(1);
    w._actor.visible = false;
    w._actor.opacity = 0;
    self._newWindowSet.add(w);
    self._pendingWarp.add(w);
    w._plaidInvisibleTimer = 5;
    self.windows.markPendingWindowInvisible(w, w._actor);
    assert.equal(self._newWindowSet.has(w), false);
    assert.equal(self._pendingWarp.has(w), false);
    assert.deepEqual([w._actor.visible, w._actor.opacity, w._plaidInvisibleTimer], [true, 255, 0]);
  });
});

test('backstop: re-armed while the overview is up; then placed at its slot before it is shown', () => {
  withTimers((timers) => {
    const self = hideSelf();
    const retiled = [];
    self.layouts.retileWorkspace = (ws) => retiled.push(ws);
    self.borders.updateBorders = () => {};
    self.windows.currentSlotRect = () => ({ x: 10, y: 20, w: 300, h: 400 });
    const w = newWin(1);
    self._newWindowSet.add(w);
    self._windowWorkspaces.set(w, WS);
    self.windows.markPendingWindowInvisible(w, w._actor);
    assert.equal(timers.length, 1);
    withOverview(true, () => timers[0][1]());
    assert.equal(w._actor.visible, false, 'not revealed in the overview');
    assert.equal(timers.length, 2, 're-armed');
    timers[1][1]();
    assert.deepEqual(w._configs, [[10, 20, 300, 400]]);
    assert.deepEqual(retiled, [WS]);
    assert.equal(self._newWindowSet.has(w), false);
    assert.deepEqual([w._actor.visible, w._actor.opacity], [true, 255]);
  });
});

function preSelf(tiled) {
  const self = makeSelf({ enabled: true, 'inside-gap': 0 });
  self.windows.isFloating = () => false;
  self.monitors.windowMon = () => 0;
  self.monitors.getWindowsForGroup = () => tiled;
  self.windows.currentSlotRect = () => ({ x: 500, y: 0, w: 500, h: 500 });
  self.geometry.wsIndex = () => 1;
  for (const w of tiled) self._windowWorkspaces.set(w, WS);
  return self;
}

test('prePlaceNewWindow: a new tile is configured to its slot once; never a lone one, an unresolved or a floating one', () => {
  const a = newWin(1), b = newWin(2);
  const self = preSelf([a, b]);
  self._newWindowSet.add(b);
  self.windows.prePlaceNewWindow(b);
  self.windows.prePlaceNewWindow(b);
  assert.deepEqual(b._configs, [[500, 0, 500, 500]]);
  const lone = newWin(3);
  const s2 = preSelf([lone]);
  s2._newWindowSet.add(lone);
  s2.windows.prePlaceNewWindow(lone);
  assert.deepEqual(lone._configs, [], 'a lone window: mutter would auto-maximize it');
  const anon = newWin(4);
  anon.get_wm_class_instance = () => null;
  anon.get_gtk_application_id = () => '';
  const s3 = preSelf([a, anon]);
  s3._newWindowSet.add(anon);
  s3.windows.prePlaceNewWindow(anon);
  assert.deepEqual(anon._configs, [], 'identity unresolved');
  const fl = newWin(5);
  const s4 = preSelf([a, fl]);
  s4.windows.isFloating = (w) => w === fl;
  s4._newWindowSet.add(fl);
  s4.windows.prePlaceNewWindow(fl);
  assert.deepEqual(fl._configs, []);
});

test('onWindowIdentityChanged: a late identity pre-places a new tile', () => {
  const a = newWin(1), b = newWin(2);
  const self = preSelf([a, b]);
  self.bgApp.isExtensionsAppWindow = () => false;
  self._newWindowSet.add(b);
  self.windows.onWindowIdentityChanged(b);
  assert.deepEqual(b._configs, [[500, 0, 500, 500]]);
});

test('animRetile: a retile queued during a run hides again the spawn-hidden windows of that workspace', () => {
  const self = makeSelf({ enabled: true });
  const w = newWin(1);
  self._newWindowSet.add(w);
  self._pendingWarp.add(w);
  self._animating = true;
  self._animStartedAt = Date.now();
  self._animProgressAt = Date.now();
  self.placement.animStalled = () => false;
  self.placement.animRetile(WS, [{ mon: 0, tiled: [w], layout: 'dwindle', places: true }]);
  assert.equal(self._queuedAnimWorkspaces.has(WS), true);
  assert.deepEqual([w._actor.visible, w._actor.opacity], [false, 0]);
});

test('animRetile: with no target a window without a committed frame stays new', () => {
  const self = makeSelf({ enabled: true });
  self.layouts.retileDwindle = () => {};
  self.signals.scheduleBorders = () => {};
  const w = newWin(1, { frame: { x: 0, y: 0, width: 0, height: 0 } });
  const c = newWin(2);
  self._newWindowSet.add(w).add(c);
  self.placement.animRetile(WS, [{ mon: 0, tiled: [w, c], layout: 'dwindle', places: true }]);
  assert.equal(self._newWindowSet.has(w), true);
  assert.equal(self._newWindowSet.has(c), false);
});

test('restoreFloatNaturalRect: forced for a pre-placed window still being placed', () => {
  const self = makeSelf({});
  const w = newWin(1, { frame: { x: 500, y: 0, width: 500, height: 500 } });
  w.is_fullscreen = () => false;
  w.is_maximized = () => false;
  w.get_monitor = () => 0;
  const ws = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 1000, height: 500 }) };
  w.get_workspace = () => ws;
  self._savedRects.set(w, { x: 100, y: 100, w: 300, h: 200 });
  const moved = [];
  self.windows.moveWindow = (...a) => moved.push(a.slice(1));
  self.windows.restoreFloatNaturalRect(w);
  assert.deepEqual(moved, [], 'a tile-sized frame is the user\'s, unforced');
  self.windows.restoreFloatNaturalRect(w, true);
  assert.deepEqual(moved, [[100, 100, 300, 200]]);
});

test('bspInsertForWorkspace: a dwindle insert leaves the tags and the min clamp to its retile', () => {
  const self = makeSelf({ 'inside-gap': 0, 'dwindle-ratio': 0.5 });
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.windows.getWorkspaceLayout = () => 'dwindle';
  const a = fakeWin({ id: 'a', minSize: [800, 0] }), b = fakeWin({ id: 'b' });
  self.bsp.bspSetTree(WS, 0, leaf(a));
  const old = globalThis.global;
  globalThis.global = { ...old, get_pointer: () => [-1, -1, 0] };
  try {
    self.bsp.bspInsertForWorkspace(WS, b, 0);
  } finally {
    globalThis.global = old;
  }
  const t = self.bsp.bspGetTree(WS, 0);
  assert.equal(t.ratio, 0.5);
  assert.equal(self.bsp.bspFindLeaf(t, b)._w, undefined);
});

// The real chain: insert -> prePlaceNewWindow -> currentSlotRect -> windowSlotRect.
function chain(layout) {
  const self = makeSelf({ 'inside-gap': 0, 'dwindle-ratio': 0.5, enabled: true });
  const a = newWin(1), b = newWin(2);
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.monitors.windowMon = () => 0;
  self.monitors.groupPlaces = () => true;
  self.monitors.getWindowsForGroup = () => [a, b];
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = () => false;
  self.geometry.wsIndex = () => 1;
  self._windowWorkspaces.set(a, WS).set(b, WS);
  self.bsp.bspSetTree(WS, 0, leaf(a));
  self._newWindowSet.add(b);
  const old = globalThis.global;
  globalThis.global = { ...old, get_pointer: () => [-1, -1, 0] };
  try {
    self.bsp.bspInsertForWorkspace(WS, b, 0);
    self.windows.prePlaceNewWindow(b);
  } finally {
    globalThis.global = old;
  }
  return b;
}

test('prePlaceNewWindow (real chain): a new Spiral tile is configured to its slot before its first commit', () => {
  assert.equal(chain('spiral')._configs.length, 1);
});

test('prePlaceNewWindow (real chain): a new dwindle tile has no slot before its retile, so none is sent (accepted limit)', () => {
  assert.deepEqual(chain('dwindle')._configs, []);
});

test('animRetile queued: a new window not spawn-hidden, or on another workspace, is not hidden again', () => {
  const self = makeSelf({ enabled: true });
  const shown = newWin(1), other = newWin(2);
  other.get_workspace = () => ({});
  self._newWindowSet.add(shown).add(other);
  self._pendingWarp.add(other);
  self._animating = true;
  self._animStartedAt = Date.now();
  self._animProgressAt = Date.now();
  self.placement.animStalled = () => false;
  self.placement.animRetile(WS, [{ mon: 0, tiled: [shown], layout: 'dwindle', places: true }]);
  assert.deepEqual([shown._actor.visible, shown._actor.opacity], [true, 255], 'not in the pending warp');
  assert.deepEqual([other._actor.visible, other._actor.opacity], [true, 255], 'another workspace');
});

test('onWindowIdentityChanged: a floated pre-placed window no longer being placed keeps its rect on a title change', () => {
  const self = makeSelf({ enabled: true });
  const w = newWin(1);
  w._plaidPrePlaced = true;
  w.is_maximized = () => false;
  self.bgApp.isExtensionsAppWindow = () => false;
  self.windows.isFloating = () => true;
  self.windows.isFullscreenTile = () => true;
  self.geometry.wsIndex = () => 1;
  const forced = [];
  self.windows.restoreFloatNaturalRect = (_w, force) => forced.push(force);
  self.windows.onWindowIdentityChanged(w);
  self._newWindowSet.add(w);
  self.windows.onWindowIdentityChanged(w);
  assert.deepEqual(forced, [false, true]);
});

test('backstop: nothing once shutdown has begun; a pending window that floats is shown where it is', () => {
  withTimers((timers) => {
    const self = hideSelf();
    self.windows.currentSlotRect = () => ({ x: 10, y: 20, w: 300, h: 400 });
    self.layouts.retileWorkspace = () => {};
    self.borders.updateBorders = () => {};
    const w = newWin(1);
    self._newWindowSet.add(w);
    self._windowWorkspaces.set(w, WS);
    self.windows.markPendingWindowInvisible(w, w._actor);
    self._shuttingDown = true;
    timers[0][1]();
    assert.equal(w._actor.visible, false, 'shutting down: left alone');
    self._shuttingDown = false;
    w._plaidInvisibleTimer = 0;
    self.windows.armRevealBackstop(w);
    self.windows.isFloating = () => true;
    timers.at(-1)[1]();
    assert.deepEqual(w._configs, [], 'a float is not moved to a slot');
    assert.equal(w._actor.visible, true);
  });
});

test('prePlaceNewWindow: nothing once shutdown has begun', () => {
  const a = newWin(1), b = newWin(2);
  const self = preSelf([a, b]);
  self._newWindowSet.add(b);
  self._shuttingDown = true;
  self.windows.prePlaceNewWindow(b);
  assert.deepEqual(b._configs, []);
});

test('onWindowCreated: a window closed before its first frame leaves no hook behind (tiled or floating)', () => {
  for (const floating of [false, true]) {
    const self = makeSelf({ enabled: true });
    self.dropdown.handleDropdownWindowCreated = () => false;
    self.bgApp.handleBackgroundAppWindowCreated = () => false;
    self.windows.shouldManage = () => !floating;
    self.windows.isFloating = () => floating;
    self.windows.addWindow = () => {};
    const w = newWin(1);
    const before = self.signals._tokens.length;
    self.signals.onWindowCreated(w);
    assert.ok(self.signals._tokens.length > before, `${floating}: hooked`);
    w.emit('unmanaged');
    assert.equal(self.signals._tokens.length, before, `${floating}: tokens gone`);
    assert.equal(w.handlers.length + w._actor.handlers.length, 0, `${floating}: handlers gone`);
  }
});

test('onWindowCreated: a floating window\'s first frame drops its hooks', () => {
  const self = makeSelf({ enabled: true });
  self.dropdown.handleDropdownWindowCreated = () => false;
  self.bgApp.handleBackgroundAppWindowCreated = () => false;
  self.windows.shouldManage = () => false;
  self.windows.isFloating = () => true;
  self.windows.restoreFloatNaturalRect = () => {};
  self.windows.connectFloatHooks = () => {};
  self.borders.updateBorders = () => {};
  const w = newWin(1);
  const before = self.signals._tokens.length;
  self.signals.onWindowCreated(w);
  w._actor.emit('first-frame');
  assert.equal(self.signals._tokens.length, before);
  assert.equal(w.handlers.length + w._actor.handlers.length, 0);
});
