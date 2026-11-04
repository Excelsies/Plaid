import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import { makeSelf, fakeWin, leaf, split, frameClock } from '../helpers.mjs';

// Dwindle live resize on the frame clock: changed slots only, the grabbed
// window never configured, the overshoot past a minimum lowered, a
// monitor-edge axis anchored.

function actorOf() {
  return {
    scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
    set_scale(x, y) { this.scale_x = x; this.scale_y = y; },
    set_translation(x, y) { this.translation_x = x; this.translation_y = y; },
    set_pivot_point() {},
    remove_all_transitions() {},
  };
}

const WS = {};
function win(id, frame, minSize) {
  const w = fakeWin({ id, instance: id, minSize });
  const actor = actorOf();
  Object.assign(w, {
    _frame: { ...frame }, _configs: [], _actor: actor, _sigs: [], _lowered: 0,
    get_id: () => id,
    get_workspace: () => WS,
    get_window_type: () => 0,
    get_frame_rect: () => ({ ...w._frame }),
    get_buffer_rect: () => ({ ...w._frame }),
    get_compositor_private: () => actor,
    connectObject(...a) { w._sigs.push(a[0]); },
    disconnectObject() {},
    lower() { w._lowered++; },
    raise() {},
    move_resize_frame: (_u, x, y, width, height) => { w._configs.push([x, y, width, height]); },
  });
  return w;
}

function resizeSelf(tree, layout = 'dwindle') {
  const self = makeSelf({ 'inside-gap': 0, enabled: true, 'mouse-resize': true });
  self.monitors.windowMon = () => 0;
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.monitors.groupPlaces = () => true;
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = () => false;
  self.bsp.bspGetTree = () => tree;
  self.borders.updateBordersDuringGrab = () => {};
  self.grab.pressAnchor = () => null;
  return self;
}

// Runs fn(ptr, clock) with a pointer, workspaces and the frame clock.
function withGrab(start, fn) {
  const old = globalThis.global;
  const ptr = { at: start };
  globalThis.global = { ...old, get_pointer: () => [...ptr.at, 0],
    workspace_manager: { get_active_workspace: () => WS, get_n_workspaces: () => 1, get_workspace_by_index: () => WS } };
  const clock = frameClock();
  const origT = GLib.timeout_add;
  let timers = 0;
  GLib.timeout_add = () => { timers++; return 9; };
  try {
    return fn(ptr, clock, () => timers);
  } finally {
    GLib.timeout_add = origT;
    clock.restore();
    globalThis.global = old;
  }
}

const W_EDGE = 1 | (1 << 12);
const E_EDGE = 1 | (2 << 12);

test('grab loop: on the frame clock, the pointer schedules a frame, no timer; grab end stops it', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const self = resizeSelf(split('h', 0.5, leaf(a), leaf(b)));
  self.masks.kickMaskNow = () => {};
  self.layouts.retileWorkspace = () => {};
  withGrab([500, 250], (ptr, clock, timers) => {
    self.grab.handleGrabBegin(b, W_EDGE);
    assert.equal(timers(), 0, 'no 16 ms timer');
    assert.ok(clock.stage.updates >= 1, 'a first frame scheduled');
    const n = clock.stage.updates;
    clock.move();
    assert.equal(clock.stage.updates, n + 1, 'the pointer moving schedules a frame');
    assert.equal(clock.handlers.length, 2);
    self.grab.handleGrabEnd(b, W_EDGE);
    assert.equal(clock.handlers.length, 0, 'disconnected');
    assert.equal(self._liveResizeId, 0);
  });
});

test('dwindle tick: neighbours get a configure only when their slot changes; the grabbed window none, no hooks', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  withGrab([500, 250], (ptr, clock) => {
    self.grab.handleGrabBegin(b, W_EDGE);
    assert.deepEqual(b._sigs, [], 'no boundary hooks: mutter owns the grabbed window');
    ptr.at = [400, 250];
    clock.frame();
    clock.frame();
    assert.equal(tree.ratio, 0.4);
    assert.deepEqual(a._configs, [[0, 0, 400, 500]], 'one configure for one slot');
    assert.deepEqual(b._configs, [], 'the grabbed window is never configured');
    ptr.at = [350, 250];
    clock.frame();
    assert.deepEqual(a._configs.at(-1), [0, 0, 350, 500]);
  });
});

test('dwindle tick: past a neighbour\'s minimum the grabbed window goes under it once; grab end resets', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 }, [400, 0]);
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  self.masks.kickMaskNow = () => {};
  self.layouts.retileWorkspace = () => {};
  withGrab([500, 250], (ptr, clock) => {
    self.grab.handleGrabBegin(a, E_EDGE);
    ptr.at = [800, 250];
    a._frame = { x: 0, y: 0, width: 800, height: 500 }; // mutter grows it past the clamp
    clock.frame();
    assert.equal(tree.ratio, 0.6, 'stopped at b\'s minimum');
    assert.equal(self._grabClampedW, true);
    assert.equal(a._lowered, 1);
    clock.frame();
    assert.equal(a._lowered, 1, 'once');
    self.grab.handleGrabEnd(a, E_EDGE);
    assert.deepEqual([self._grabLowered, self._grabClampedW], [false, false]);
  });
});

test('dwindle tick: within the minimums nothing is lowered', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 }, [100, 0]);
  const self = resizeSelf(split('h', 0.5, leaf(a), leaf(b)));
  withGrab([500, 250], (ptr, clock) => {
    self.grab.handleGrabBegin(a, E_EDGE);
    ptr.at = [700, 250];
    a._frame = { x: 0, y: 0, width: 700, height: 500 };
    clock.frame();
    assert.equal(a._lowered, 0);
  });
});

test('dwindle tick: on a monitor-edge axis the grabbed window is translated back onto its slot', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  withGrab([0, 250], (ptr, clock) => {
    // a's left edge is the monitor edge: the divider moves, mirrored.
    self.grab.handleGrabBegin(a, W_EDGE);
    assert.equal(self._grabFollowW, -1);
    ptr.at = [100, 250];
    a._frame = { x: 100, y: 0, width: 400, height: 500 }; // mutter moved the dragged edge
    clock.frame();
    assert.equal(tree.ratio, 0.4);
    assert.equal(a._actor.translation_x, -100, 'drawn at the monitor edge');
    assert.equal(a._actor.scale_x, 1, 'never scaled');
    assert.ok(self._liveStretched.has(a));
  });
});

test('dwindle grab end: a release before the last frame still applies the last motion (a flick)', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  self.masks.kickMaskNow = () => {};
  self.layouts.retileWorkspace = () => {};
  self.windows.repositionWindow = () => {};
  self.placement.getAnimationTime = () => 0.1;
  self.transforms.ensureTimeline = () => {};
  withGrab([500, 250], (ptr) => {
    self.grab.handleGrabBegin(b, W_EDGE);
    ptr.at = [400, 250];
    self.grab.handleGrabEnd(b, W_EDGE);
    assert.equal(tree.ratio, 0.4);
  });
});

test('bspLayout: a retile (no grabbed window) always sends; a live resize re-sends a slot whose height alone changed', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 0, y: 250, width: 500, height: 250 });
  const self = resizeSelf(split('v', 0.5, leaf(a), leaf(b)));
  self._liveSent = new Map([[a, { x: 0, y: 0, w: 1000, h: 250 }]]);
  self.bsp.bspLayout(split('v', 0.5, leaf(a), leaf(b)), 0, 0, 1000, 500, 0);
  assert.deepEqual(a._configs, [[0, 0, 1000, 250]], 'sent although _liveSent matches');
  self._liveSent = new Map([[a, { x: 0, y: 0, w: 1000, h: 250 }]]);
  self.bsp.bspLayout(split('v', 0.6, leaf(a), leaf(b)), 0, 0, 1000, 500, 0, b);
  assert.deepEqual(a._configs.at(-1), [0, 0, 1000, 300], 'height changed: re-sent');
});

test('dwindle tick: clamped, but the frame not past its slot: not lowered', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 }, [400, 0]);
  const self = resizeSelf(split('h', 0.5, leaf(a), leaf(b)));
  withGrab([500, 250], (ptr, clock) => {
    self.grab.handleGrabBegin(a, E_EDGE);
    ptr.at = [800, 250];
    a._frame = { x: 0, y: 0, width: 601, height: 500 }; // at its 600 slot, within 1 px
    clock.frame();
    assert.equal(self._grabClampedW, true);
    assert.equal(a._lowered, 0);
  });
});

test('grab loop: no tick once shutdown has begun, or while the window has no actor', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const self = resizeSelf(split('h', 0.5, leaf(a), leaf(b)));
  withGrab([500, 250], (ptr, clock) => {
    let ticks = 0;
    self.grab.handleGrabBegin(b, W_EDGE);
    self.grab.resizeTick = () => { ticks++; };
    clock.frame();
    assert.equal(ticks, 1);
    self._shuttingDown = true;
    clock.frame();
    assert.equal(ticks, 1, 'shutting down');
    self._shuttingDown = false;
    b.get_compositor_private = () => null;
    clock.frame();
    assert.equal(ticks, 1, 'no actor');
  });
});

test('grab begin clears the tick record: a user grab is not a tick in flight', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const self = resizeSelf(split('h', 0.5, leaf(a), leaf(b)));
  b._plaidTickSent = { at: Date.now(), seen: [] };
  withGrab([500, 250], () => self.grab.handleGrabBegin(b, W_EDGE));
  assert.equal(b._plaidTickSent, null);
});

test('a window lowered past a minimum is raised when it floated mid-grab, and on disable', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 }, [400, 0]);
  const self = resizeSelf(split('h', 0.5, leaf(a), leaf(b)));
  self.masks.kickMaskNow = () => {};
  self.layouts.retileWorkspace = () => {};
  let raised = 0;
  a.raise = () => { raised++; };
  withGrab([500, 250], (ptr, clock) => {
    self.grab.handleGrabBegin(a, E_EDGE);
    ptr.at = [800, 250];
    a._frame = { x: 0, y: 0, width: 800, height: 500 };
    clock.frame();
    assert.equal(a._lowered, 1);
    self.windows.isFloating = () => true; // toggled floating mid-grab
    self.grab.handleGrabEnd(a, E_EDGE);
    assert.equal(raised, 1);
    self.windows.isFloating = () => false;
    ptr.at = [500, 250];
    self.grab.handleGrabBegin(a, E_EDGE);
    ptr.at = [800, 250];
    clock.frame();
    assert.equal(a._lowered, 2);
    self.grab.destroy();
    assert.equal(raised, 2, 'disable mid-grab');
    assert.equal(self._grabLowered, false);
  });
});
