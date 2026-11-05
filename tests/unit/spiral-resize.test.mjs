import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import { makeSelf, fakeWin, leaf, split, frameClock } from '../helpers.mjs';

// Spiral live resize (grab.spiralLiveResize and its grab-loop branch).

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
function win(id, frame, { lag = true } = {}) {
  const w = fakeWin({ id, instance: id });
  const actor = actorOf();
  Object.assign(w, {
    _frame: { ...frame }, _configs: [], _actor: actor, _sigs: [],
    get_id: () => id,
    get_workspace: () => WS,
    get_frame_rect: () => ({ ...w._frame }),
    get_buffer_rect: () => ({ ...w._frame }),
    get_compositor_private: () => actor,
    connectObject(...a) { w._sigs.push(a[0]); },
    disconnectObject() {},
    move_resize_frame: (_u, x, y, width, height) => {
      w._configs.push([x, y, width, height]);
      if (!lag) w._frame = { x, y, width, height };
    },
  });
  return w;
}

function resizeSelf(tree) {
  const self = makeSelf({ 'inside-gap': 0, enabled: true, 'mouse-resize': true });
  self.monitors.windowMon = () => 0;
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.monitors.groupPlaces = () => true;
  self.windows.getWorkspaceLayout = () => 'spiral';
  self.windows.isFloating = () => false;
  self.bsp.bspGetTree = () => tree;
  self.borders.updateBordersDuringGrab = () => {};
  return self;
}

test('spiralLiveResize: neighbours get a configure only when their slot changes, stretched until they commit', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  self.bsp.bspTagGeometry(tree, 0, 0, 1000, 500, 0);
  self.grab.spiralLiveResize(a);
  self.grab.spiralLiveResize(a);
  assert.deepEqual(a._configs, [], 'mutter sizes the grabbed window');
  assert.deepEqual(b._configs, [[600, 0, 400, 500]], 'once');
  // b has not committed: drawn over its slot.
  assert.equal(b._actor.scale_x, 0.8);
  assert.deepEqual(self._liveStretched.get(b), { x: 600, y: 0, w: 400, h: 500 });
  // The grabbed window, its frame behind the slot: stretched to the slot.
  assert.equal(a._actor.scale_x, 1.2);
});

test('spiralLiveResize: on an axis no divider follows the grabbed window is drawn at its frame', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 450 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  self.bsp.bspTagGeometry(tree, 0, 0, 1000, 500, 0);
  self._grabHeightSign = 1;
  self._grabResizeNodeH = null;
  self.grab.spiralLiveResize(a);
  assert.equal(a._actor.scale_y, 1, 'full-height axis: its own frame');
  assert.equal(self._liveStretched.has(a), false);
});

test('grab begin and loop: a Spiral resize picks the grabbed edge\'s divider, hooks nothing, and stretches', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  const old = globalThis.global;
  let ptr = [500, 250];
  globalThis.global = { ...old, get_pointer: () => [...ptr, 0],
    workspace_manager: { get_active_workspace: () => WS, get_n_workspaces: () => 1, get_workspace_by_index: () => WS } };
  const clock = frameClock();
  const loop = clock.frame;
  try {
    a.get_window_type = () => 0;
    b.get_window_type = () => 0;
    let moved = 0;
    self.grab.moveTiledExcept = () => { moved++; };
    // b's left edge (W = 1).
    self.grab.handleGrabBegin(b, 1 | (1 << 12));
    assert.equal(self._grabResizeNodeW, tree);
    assert.deepEqual(b._sigs, [], 'no boundary hooks');
    ptr = [400, 250];
    loop();
    assert.equal(tree.ratio, 0.4);
    assert.equal(moved, 0, 'not the dwindle relayout');
    assert.deepEqual(a._configs, [[0, 0, 400, 500]]);
    assert.ok(self._liveStretched.has(a));
  } finally {
    clock.restore();
    globalThis.global = old;
  }
});

test('grab begin: a tiled pointer resize is measured from the press (Spiral, dwindle, master-stack); a keyboard one from the pointer', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  const old = globalThis.global;
  globalThis.global = { ...old, get_pointer: () => [508, 250, 0],
    workspace_manager: { get_active_workspace: () => WS, get_n_workspaces: () => 1, get_workspace_by_index: () => WS } };
  const clock = frameClock();
  try {
    b.get_window_type = () => 0;
    self.grab.pressAnchor = () => [500, 250];
    const W_EDGE = 1 | (1 << 12);
    self.grab.handleGrabBegin(b, W_EDGE);
    assert.equal(self._grabStartX, 500, 'from the press');
    self._grabOp = null;
    self.grab.handleGrabBegin(b, W_EDGE | 0x100);
    assert.equal(self._grabStartX, 508, 'keyboard: the pointer');
    self._grabOp = null;
    for (const layout of ['dwindle', 'master-stack']) {
      self._grabOp = null;
      self.windows.getWorkspaceLayout = () => layout;
      self.grab.handleGrabBegin(b, W_EDGE);
      assert.equal(self._grabStartX, 500, `${layout}: from the press`);
    }
    // A floating window: mutter's own resize, the pointer.
    self._grabOp = null;
    self.windows.isFloating = () => true;
    self.grab.handleGrabBegin(b, W_EDGE);
    assert.equal(self._grabStartX, 508, 'floating: the pointer');
  } finally {
    clock.restore();
    globalThis.global = old;
  }
});

test('grab end: a release before the last tick still applies the last motion (a flick)', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  const old = globalThis.global;
  let ptr = [500, 250];
  globalThis.global = { ...old, get_pointer: () => [...ptr, 0],
    workspace_manager: { get_active_workspace: () => WS, get_n_workspaces: () => 1, get_workspace_by_index: () => WS } };
  const clock = frameClock();
  try {
    b.get_window_type = () => 0;
    b.raise = () => {};
    self.borders.startBorderAnimation = () => {};
    self.masks.kickMaskNow = () => {};
    self.layouts.retileWorkspace = () => {};
    self.windows.repositionWindow = () => {};
    self.grab.pressAnchor = () => null;
    self.placement.getAnimationTime = () => 0.1;
    self.transforms.ensureTimeline = () => {};
    self.grab.handleGrabBegin(b, 1 | (1 << 12));
    ptr = [400, 250]; // released before the loop ticked
    self.grab.handleGrabEnd(b, 1 | (1 << 12));
    assert.equal(tree.ratio, 0.4);
  } finally {
    clock.restore();
    globalThis.global = old;
  }
});

test('grab begin and loop: a dwindle resize picks the grabbed edge\'s divider and holds the inner one', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 250, height: 500 });
  const c = win('c', { x: 750, y: 0, width: 250, height: 500 });
  const tree = split('h', 0.5, leaf(a), split('h', 0.5, leaf(b), leaf(c)));
  const self = resizeSelf(tree);
  self.windows.getWorkspaceLayout = () => 'dwindle';
  const old = globalThis.global;
  let ptr = [500, 250];
  globalThis.global = { ...old, get_pointer: () => [...ptr, 0],
    workspace_manager: { get_active_workspace: () => WS, get_n_workspaces: () => 1, get_workspace_by_index: () => WS } };
  const clock = frameClock();
  const loop = clock.frame;
  try {
    b.get_window_type = () => 0;
    self.grab.pressAnchor = () => null;
    self.grab.moveTiledExcept = () => {};
    self.grab.enforceGrabBoundary = () => {};
    // b's left edge (W = 1): the root divider, not the b|c split nearest b.
    self.grab.handleGrabBegin(b, 1 | (1 << 12));
    assert.equal(self._grabResizeNodeW, tree);
    assert.equal(self._grabInnerW.node, tree.second);
    ptr = [400, 250];
    loop();
    assert.equal(tree.ratio, 0.4);
    const inner = tree.second;
    assert.equal(inner._x + Math.floor(inner._w * inner.ratio), 750, 'b\'s right edge stays');
  } finally {
    clock.restore();
    globalThis.global = old;
  }
});

// One configure in flight per neighbour: the next slot goes after the client
// answers the last one (or the wait runs out), and it is the latest slot.
function liveTick(self, tree, a, ratio) {
  tree.ratio = ratio;
  self.bsp.bspTagGeometry(tree, 0, 0, 1000, 500, 0);
  self.grab.spiralLiveResize(a);
}

test('spiralLiveResize: one configure in flight per neighbour, the latest slot after its commit', () => {
  GLib.get_monotonic_time = () => 0;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  liveTick(self, tree, a, 0.6);
  liveTick(self, tree, a, 0.62);
  liveTick(self, tree, a, 0.64);
  assert.deepEqual(b._configs, [[600, 0, 400, 500]], 'nothing more while the first is in flight');
  // Drawn over the latest slot meanwhile.
  assert.deepEqual(self._liveStretched.get(b), { x: 640, y: 0, w: 360, h: 500 });
  assert.equal(b._actor.scale_x, 0.72);
  b._frame = { x: 600, y: 0, width: 400, height: 500 };
  liveTick(self, tree, a, 0.66);
  assert.deepEqual(b._configs, [[600, 0, 400, 500], [660, 0, 340, 500]], 'the latest slot, once answered');
});

test('spiralLiveResize: an answer at another size, or no answer in time, also ends the wait', () => {
  let now = 0;
  GLib.get_monotonic_time = () => now;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  liveTick(self, tree, a, 0.6);
  // A client of its own size (size increments) commits 405 wide.
  b._frame = { x: 600, y: 0, width: 405, height: 500 };
  liveTick(self, tree, a, 0.62);
  assert.equal(b._configs.length, 2);
  // No answer: held until the wait runs out.
  liveTick(self, tree, a, 0.64);
  now = 499 * 1000;
  liveTick(self, tree, a, 0.65);
  assert.equal(b._configs.length, 2);
  now = 500 * 1000;
  liveTick(self, tree, a, 0.66);
  assert.deepEqual(b._configs.at(-1), [660, 0, 340, 500]);
  GLib.get_monotonic_time = () => 0;
});

test('spiralLiveResize: a configure mutter applies at once (a move) leaves nothing in flight', () => {
  GLib.get_monotonic_time = () => 0;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 }, { lag: false });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  liveTick(self, tree, a, 0.6);
  liveTick(self, tree, a, 0.62);
  assert.deepEqual(b._configs, [[600, 0, 400, 500], [620, 0, 380, 500]]);
});

test('grab end: a neighbour still owed its last slot gets it at the hand-off, and is held until that commit', () => {
  GLib.get_monotonic_time = () => 0;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  self.placement.getAnimationTime = () => 0.1;
  self.transforms.ensureTimeline = () => {};
  self.monitors.recordTick = () => {};
  self.monitors.windowConn = () => 'M';
  liveTick(self, tree, a, 0.6);
  liveTick(self, tree, a, 0.64);
  self.transforms.handOffLiveStretch(a);
  assert.deepEqual(b._configs, [[600, 0, 400, 500], [640, 0, 360, 500]]);
  assert.ok(self._transformStates.has(b));
  // The first configure's commit: still held over the final slot.
  b._frame = { x: 600, y: 0, width: 400, height: 500 };
  self.transforms.step();
  assert.ok(self._transformStates.has(b));
  b._frame = { x: 640, y: 0, width: 360, height: 500 };
  self.transforms.step();
  assert.equal(self._transformStates.has(b), false);
});

test('grab end: a neighbour already sent its last slot gets no second configure at the hand-off', () => {
  GLib.get_monotonic_time = () => 0;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  self.placement.getAnimationTime = () => 0.1;
  self.transforms.ensureTimeline = () => {};
  self.monitors.windowConn = () => 'M';
  liveTick(self, tree, a, 0.6);
  self.transforms.handOffLiveStretch(a);
  assert.deepEqual(b._configs, [[600, 0, 400, 500]]);
});

test('spiralLiveResize: an X11 neighbour is never waited on (mutter sets its frame at once)', () => {
  GLib.get_monotonic_time = () => 0;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  b.get_client_type = () => 1;
  // Size increments: mutter sets 9 px steps, never the slot.
  b.move_resize_frame = (_u, x, y, width, height) => {
    b._configs.push([x, y, width, height]);
    b._frame = { x, y, width: width - width % 9, height };
  };
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  liveTick(self, tree, a, 0.6);
  liveTick(self, tree, a, 0.62);
  assert.deepEqual(b._configs, [[600, 0, 400, 500], [620, 0, 380, 500]]);
});

test('spiralLiveResize: past the wait the latest slot is re-sent once, and the next waits for both answers or another wait', () => {
  let now = 0;
  GLib.get_monotonic_time = () => now * 1000;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  liveTick(self, tree, a, 0.6);
  now = 500;
  liveTick(self, tree, a, 0.62);
  assert.equal(b._configs.length, 2, 'no answer in time: re-sent');
  now = 600;
  liveTick(self, tree, a, 0.64);
  assert.equal(b._configs.length, 2, 'within the wait of the re-send: nothing');
  // The first configure's commit answers only the first.
  b._frame = { x: 600, y: 0, width: 400, height: 500 };
  liveTick(self, tree, a, 0.64);
  assert.equal(b._configs.length, 2);
  b._frame = { x: 620, y: 0, width: 380, height: 500 };
  liveTick(self, tree, a, 0.64);
  assert.deepEqual(b._configs.at(-1), [640, 0, 360, 500], 'both answered: the latest');
  GLib.get_monotonic_time = () => 0;
});

test('grab end: a neighbour drawn flush at its final slot with another rect in flight is sent the slot', () => {
  GLib.get_monotonic_time = () => 0;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  self.placement.getAnimationTime = () => 0.1;
  self.transforms.ensureTimeline = () => {};
  self.monitors.recordTick = () => {};
  self.monitors.windowConn = () => 'M';
  liveTick(self, tree, a, 0.6);
  liveTick(self, tree, a, 0.5);
  assert.equal(self._liveStretched.has(b), false, 'flush: not stretched');
  self.transforms.handOffLiveStretch(a);
  assert.deepEqual(b._configs, [[600, 0, 400, 500], [500, 0, 500, 500]]);
});

test('grab end: a window that left the workspace mid-grab is not sent its old slot', () => {
  GLib.get_monotonic_time = () => 0;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  self.placement.getAnimationTime = () => 0.1;
  self.transforms.ensureTimeline = () => {};
  self.monitors.recordTick = () => {};
  self.monitors.windowConn = () => 'M';
  liveTick(self, tree, a, 0.6);
  liveTick(self, tree, a, 0.64);
  b.get_workspace = () => ({});
  self.transforms.handOffLiveStretch(a);
  assert.deepEqual(b._configs, [[600, 0, 400, 500]]);
});

test('spiralLiveResize: an answered neighbour whose slot did not change is not sent it again', () => {
  GLib.get_monotonic_time = () => 0;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 }, { lag: false });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  liveTick(self, tree, a, 0.6);
  liveTick(self, tree, a, 0.6);
  assert.deepEqual(b._configs, [[600, 0, 400, 500]]);
});

test('spiralLiveResize: one answer at the last rect sent answers every configure, so a client back on time gets one per frame', () => {
  let now = 0;
  GLib.get_monotonic_time = () => now * 1000;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  liveTick(self, tree, a, 0.6);
  now = 500; // stalled: re-sent
  liveTick(self, tree, a, 0.62);
  assert.equal(b._configs.length, 2);
  // One commit for both (xdg acks the latest only).
  b._frame = { x: 620, y: 0, width: 380, height: 500 };
  now = 516;
  liveTick(self, tree, a, 0.64);
  assert.deepEqual(b._configs.at(-1), [640, 0, 360, 500], 'sent at once');
  // Answering within a frame from here: a configure per frame.
  for (const [i, r] of [[1, 0.66], [2, 0.68], [3, 0.7]]) {
    const [x, , w] = b._configs.at(-1);
    b._frame = { x, y: 0, width: w, height: 500 };
    now = 516 + 16 * i;
    liveTick(self, tree, a, r);
    assert.equal(b._configs.length, 3 + i, `frame ${i}`);
  }
  GLib.get_monotonic_time = () => 0;
});

test('spiralLiveResize: a silent client is re-sent every wait, its count held at two', () => {
  let now = 0;
  GLib.get_monotonic_time = () => now * 1000;
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 500 });
  const tree = split('h', 0.6, leaf(a), leaf(b));
  const self = resizeSelf(tree);
  for (const [t, r] of [[0, 0.6], [500, 0.62], [1000, 0.64], [1500, 0.66]]) {
    now = t;
    liveTick(self, tree, a, r);
  }
  assert.equal(b._configs.length, 4, 'one per wait');
  // Two answers at sizes of its own clear the count.
  now = 1510;
  b._frame = { x: 600, y: 0, width: 405, height: 500 };
  liveTick(self, tree, a, 0.66);
  b._frame = { x: 620, y: 0, width: 385, height: 500 };
  liveTick(self, tree, a, 0.68);
  assert.equal(b._configs.length, 5, 'sent after the second answer');
  GLib.get_monotonic_time = () => 0;
});
