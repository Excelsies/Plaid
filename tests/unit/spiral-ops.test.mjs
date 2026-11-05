import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Spiral's Hyprland operations: directional focus and swap on slots.

const WS = {};
const WA = { x: 0, y: 0, width: 1000, height: 500 };

function win(id, frame, opts = {}) {
  const w = fakeWin({ id, instance: id, frame, ...opts });
  w.get_id = () => id;
  w.get_workspace = () => WS;
  w.get_maximize_flags = () => 0;
  return w;
}

function groupSelf(layout, wins, settings = {}) {
  const self = makeSelf({ 'dwindle-ratio': 0.5, enabled: true, ...settings });
  const floats = new Set();
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = w => floats.has(w);
  self.windows.isFullscreenTile = () => false;
  self.windows.getWindowsForWorkspace = () => wins;
  self.windows.cursorWarpDeferred = () => {};
  self.monitors.windowMon = () => 0;
  self.monitors.groupPlaces = () => true;
  self.monitors.monitorWorkArea = () => WA;
  self.monitors.getWindowsForGroup = () => wins;
  self.geometry.wsIndex = () => 1;
  self.grab.safeMove = () => {};
  self.signals.addIdle = () => {};
  self.currentTime = () => 0;
  const retiles = [];
  self.layouts.retileWorkspace = ws => retiles.push(ws);
  let activated = null;
  for (const w of wins) w.activate = () => { activated = w; };
  return { self, floats, retiles, activated: () => activated };
}

// h0.5(A,Bm) on a 1000 px area: Bm (an 800 px minimum) is drawn centred on
// its slot and clamped into the area, so its frame covers A's right edge.
function oversized(layout) {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 200, y: 0, width: 800, height: 500 });
  const ctx = groupSelf(layout, [a, b]);
  ctx.self.bsp.bspSetTree(WS, 0, split('h', 0.5, leaf(a), leaf(b)));
  return { ...ctx, a, b };
}

test('moveFocus: Spiral finds the neighbour of an oversized tile both ways (slots); dwindle compares frames', () => {
  for (const [layout, reach] of [['spiral', true], ['dwindle', false]]) {
    const { self, a, b, activated } = oversized(layout);
    global.display.focus_window = a;
    self.actions.moveFocus('right');
    assert.equal(activated(), reach ? b : null, `${layout}: right from a`);
    global.display.focus_window = b;
    self.actions.moveFocus('left');
    assert.equal(activated(), reach ? a : null, `${layout}: left from b`);
  }
});

test('swapWindow: Spiral swaps past an oversized tile; dwindle leaves the tree', () => {
  for (const [layout, swapped] of [['spiral', true], ['dwindle', false]]) {
    const { self, a, b } = oversized(layout);
    global.display.focus_window = a;
    self.actions.swapWindow('right');
    const t = self.bsp.bspGetTree(WS, 0);
    assert.deepEqual([t.first.window, t.second.window], swapped ? [b, a] : [a, b], layout);
  }
});

// A float keeps its frame, even while a stale leaf of it is in the tree:
// from its leaf (top right) down reaches b, from its frame nothing does.
test('moveFocus: a float compares its frame, not a leaf it still holds', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 252, width: 500, height: 248 });
  const f = win('f', { x: 100, y: 100, width: 100, height: 100 });
  const { self, floats, activated } = groupSelf('spiral', [a, b, f]);
  floats.add(f);
  self.bsp.bspSetTree(WS, 0, split('h', 0.5, leaf(a), split('v', 0.5, leaf(f), leaf(b))));
  global.display.focus_window = f;
  self.actions.moveFocus('down');
  assert.equal(activated(), null);
  self.actions.moveFocus('right');
  assert.equal(activated(), null);
  f.get_frame_rect = () => ({ x: 520, y: 100, width: 100, height: 100 });
  self.actions.moveFocus('left');
  assert.equal(activated(), a);
});

test('spiralSlots: each tile\'s leaf, a lone tile the tiling area, nothing for dwindle', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 200, y: 0, width: 800, height: 500 });
  const { self } = groupSelf('spiral', [a, b]);
  self.bsp.bspSetTree(WS, 0, split('h', 0.5, leaf(a), leaf(b)));
  assert.deepEqual([...self.bsp.spiralSlots(WS, 0)], [[a, { x: 0, y: 0, w: 500, h: 500 }], [b, { x: 500, y: 0, w: 500, h: 500 }]]);
  self.monitors.getWindowsForGroup = () => [b];
  assert.deepEqual([...self.bsp.spiralSlots(WS, 0)], [[b, { x: 0, y: 0, w: 1000, h: 500 }]]);
  self.windows.getWorkspaceLayout = () => 'dwindle';
  assert.equal(self.bsp.spiralSlots(WS, 0).size, 0);
});
