import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

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
  const origT = GLib.timeout_add;
  let loop = null;
  GLib.timeout_add = (_p, _ms, cb) => { loop = cb; return 7; };
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
    GLib.timeout_add = origT;
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
  const origT = GLib.timeout_add;
  GLib.timeout_add = () => 7;
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
    GLib.timeout_add = origT;
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
  const origT = GLib.timeout_add;
  GLib.timeout_add = () => 7;
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
    GLib.timeout_add = origT;
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
  const origT = GLib.timeout_add;
  let loop = null;
  GLib.timeout_add = (_p, _ms, cb) => { loop = cb; return 7; };
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
    GLib.timeout_add = origT;
    globalThis.global = old;
  }
});
