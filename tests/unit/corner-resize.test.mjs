import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split, frameClock } from '../helpers.mjs';
import { cornerSigns } from '../../extensions/modules/grab.js';

// An edge grab pressed near either end of that edge resizes both axes, as the
// corner would (tiled windows; Plaid moves the dividers itself).

const F = { x: 100, y: 100, width: 400, height: 200 };

test('cornerSigns: an E or W edge near its top or bottom adds the vertical axis', () => {
  assert.deepEqual(cornerSigns(1, 0, [500, 110], F, 0.2), [1, -1, 'h']);   // top 5%
  assert.deepEqual(cornerSigns(1, 0, [500, 290], F, 0.2), [1, 1, 'h']);    // bottom 95%
  assert.deepEqual(cornerSigns(-1, 0, [100, 290], F, 0.2), [-1, 1, 'h']);
  assert.deepEqual(cornerSigns(1, 0, [500, 200], F, 0.2), [1, 0, null]);   // middle
  assert.deepEqual(cornerSigns(1, 0, [500, 139], F, 0.2), [1, -1, 'h']);   // just inside 20%
  assert.deepEqual(cornerSigns(1, 0, [500, 141], F, 0.2), [1, 0, null]);   // just outside
  assert.deepEqual(cornerSigns(1, 0, [500, 140], F, 0.2), [1, 0, null]);   // exactly 20%: the edge
  assert.deepEqual(cornerSigns(1, 0, [500, 260], F, 0.2), [1, 0, null]);   // exactly 80%: the edge
});

test('cornerSigns: an N or S edge near its left or right adds the horizontal axis', () => {
  assert.deepEqual(cornerSigns(0, -1, [120, 100], F, 0.2), [-1, -1, 'w']);
  assert.deepEqual(cornerSigns(0, 1, [480, 300], F, 0.2), [1, 1, 'w']);
  assert.deepEqual(cornerSigns(0, 1, [300, 300], F, 0.2), [0, 1, null]);
});

test('cornerSigns: a press in the resize border outside the frame counts as its end', () => {
  // CSD shadow / invisible border: a few px past the frame's corner.
  assert.deepEqual(cornerSigns(1, 0, [505, 95], F, 0.2), [1, -1, 'h']);
  assert.deepEqual(cornerSigns(0, 1, [96, 304], F, 0.2), [-1, 1, 'w']);
});

test('cornerSigns: corner ops, zone 0, no press and an empty frame stay as they are', () => {
  assert.deepEqual(cornerSigns(1, 1, [500, 110], F, 0.2), [1, 1, null]);
  assert.deepEqual(cornerSigns(1, 0, [500, 110], F, 0), [1, 0, null]);
  assert.deepEqual(cornerSigns(1, 0, null, F, 0.2), [1, 0, null]);
  assert.deepEqual(cornerSigns(1, 0, [500, 110], { ...F, height: 0 }, 0.2), [1, 0, null]);
  assert.deepEqual(cornerSigns(0, 0, [500, 110], F, 0.2), [0, 0, null]);
});

// --- grab wiring (the spiral-resize test world) ---

function actorOf() {
  return {
    scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
    set_scale(x, y) { this.scale_x = x; this.scale_y = y; },
    set_translation(x, y) { this.translation_x = x; this.translation_y = y; },
    set_pivot_point() {}, remove_all_transitions() {},
  };
}
const WS = {};
function win(id, frame) {
  const w = fakeWin({ id, instance: id });
  const actor = actorOf();
  Object.assign(w, {
    _frame: { ...frame }, _configs: [], _actor: actor,
    get_id: () => id, get_workspace: () => WS, get_window_type: () => 0,
    get_frame_rect: () => ({ ...w._frame }), get_buffer_rect: () => ({ ...w._frame }),
    get_compositor_private: () => actor,
    connectObject() {}, disconnectObject() {}, raise() {}, lower() {},
    move_resize_frame: (_u, x, y, width, height) => { w._configs.push([x, y, width, height]); },
  });
  return w;
}
function world(layout, settings = {}, bMin = null) {
  // a | b over c: b's W edge and its bottom (b/c) divider.
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 0, width: 500, height: 250 });
  if (bMin) b.get_min_size = () => [true, ...bMin];
  const c = win('c', { x: 500, y: 250, width: 500, height: 250 });
  const tree = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)));
  const self = makeSelf({ 'inside-gap': 0, enabled: true, 'mouse-resize': true,
    'corner-resize': true, 'corner-resize-zone': 20, ...settings });
  self.monitors.windowMon = () => 0;
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.monitors.groupPlaces = () => true;
  self.monitors.getWindowsForGroup = () => [a, b, c];
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = () => false;
  self.bsp.bspGetTree = () => tree;
  self.borders.updateBordersDuringGrab = () => {};
  self.grab.moveTiledExcept = () => {};
  return { self, a, b, c, tree };
}
function withPointer(fn) {
  const old = globalThis.global;
  const p = { ptr: [500, 230] };
  globalThis.global = { ...old, get_pointer: () => [...p.ptr, 0],
    workspace_manager: { get_active_workspace: () => WS, get_n_workspaces: () => 1, get_workspace_by_index: () => WS } };
  const clock = frameClock();
  try { return fn(p, clock.frame); } finally { clock.restore(); globalThis.global = old; }
}
const W_EDGE = 1 | (1 << 12);

test('grab: a W-edge press near the bottom moves both dividers (Spiral), the window stretched on the added axis', () => {
  const { self, b, tree } = world('spiral');
  withPointer((p, frame) => {
    self.grab.pressAnchor = () => [500, 230]; // 92% down b's left edge
    self.grab.handleGrabBegin(b, W_EDGE);
    assert.deepEqual([self._grabWidthSign, self._grabHeightSign, self._grabCornerAxis], [-1, 1, 'h']);
    assert.equal(self._grabResizeNodeW, tree);
    assert.equal(self._grabResizeNodeH, tree.second);
    p.ptr = [400, 280]; // 100 left, 50 down from the press
    frame();
    assert.equal(tree.ratio, 0.4);
    assert.equal(tree.second.ratio, 0.6);
    // mutter kept b's height (250); its slot is now 300 tall: drawn stretched.
    assert.equal(b._actor.scale_y, 300 / 250);
    // The release: the hand-off sizes b at its stretched slot.
    let handed = null;
    self.transforms.handOffLiveStretch = (w) => { handed = self._liveStretched?.get(w); };
    self.layouts.retileWorkspace = () => {};
    self.grab.handleGrabEnd(b, W_EDGE);
    assert.deepEqual(handed, { x: 400, y: 0, w: 600, h: 300 });
    assert.equal(self._grabCornerAxis, null);
  });
});

test('grab: a W-edge press mid-edge moves only the vertical divider', () => {
  const { self, b, tree } = world('spiral');
  withPointer((p, frame) => {
    self.grab.pressAnchor = () => [500, 125];
    self.grab.handleGrabBegin(b, W_EDGE);
    assert.deepEqual([self._grabWidthSign, self._grabHeightSign, self._grabCornerAxis], [-1, 0, null]);
    p.ptr = [400, 180];
    frame();
    assert.equal(tree.ratio, 0.4);
    assert.equal(tree.second.ratio, 0.5);
  });
});

test('grab: switched off, zone 0, a keyboard resize or an unknown press keep the edge', () => {
  for (const [settings, op, press] of [
    [{ 'corner-resize': false }, W_EDGE, [500, 230]],
    [{ 'corner-resize-zone': 0 }, W_EDGE, [500, 230]],
    [{}, W_EDGE | 0x100, [500, 230]],
    [{}, W_EDGE, null],
  ]) {
    const { self, b } = world('spiral', settings);
    withPointer(() => {
      self.grab.pressAnchor = () => press;
      self.grab.handleGrabBegin(b, op);
      assert.equal(self._grabCornerAxis, null, JSON.stringify(settings) + op);
      assert.equal(self._grabHeightSign, 0);
    });
  }
});

test('grab: dwindle draws the grabbed window over its slot on the added axis, and never lowers it for it', () => {
  const { self, b, tree } = world('dwindle');
  withPointer((p, frame) => {
    self.grab.pressAnchor = () => [500, 230];
    self.grab.handleGrabBegin(b, W_EDGE);
    assert.equal(self._grabCornerAxis, 'h');
    let lowered = false;
    b.lower = () => { lowered = true; };
    p.ptr = [500, 150]; // 80 up from the press: b's slot shrinks to 170, mutter keeps 250
    frame();
    assert.equal(Math.round(tree.second.ratio * 100), 34);
    // The layout floors the slot (169 px here): the leaf's tagged height.
    assert.equal(b._actor.scale_y, tree.second.first._h / 250);
    assert.ok(Math.abs(tree.second.first._h - 170) <= 1);
    assert.equal(lowered, false);
  });
});

test('grab: dwindle, the added axis clamped at a minimum: the window is not lowered (mutter never grew it)', () => {
  const { self, b, tree } = world('dwindle', {}, [0, 200]);
  withPointer((p, frame) => {
    self.grab.pressAnchor = () => [500, 230];
    self.grab.handleGrabBegin(b, W_EDGE);
    let lowered = false;
    b.lower = () => { lowered = true; };
    p.ptr = [500, 100]; // asks for 120 px: b's minimum holds the slot at 200
    frame();
    assert.equal(self._grabClampedH, true);
    assert.ok(Math.abs(tree.second.first._h - 200) <= 1);
    assert.equal(lowered, false);
  });
});

test('grab: master-stack never configures the grabbed window on the added axis', () => {
  const { self, b } = world('master-stack');
  withPointer((p, frame) => {
    self.grab.pressAnchor = () => [500, 230];
    self.grab.handleGrabBegin(b, W_EDGE);
    assert.equal(self._grabCornerAxis, 'h');
    self.grab.windowSlotRect = () => ({ x: 500, y: 0, w: 500, h: 150 });
    p.ptr = [500, 150];
    frame();
    assert.deepEqual(b._configs, [], 'no boundary move on the added axis');
    assert.equal(b._actor.scale_y, 150 / 250);
  });
});
