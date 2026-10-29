import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Drag-drop helpers: real geometry, no min sizes, no gaps unless set.
const WORK_AREA = { x: 0, y: 0, width: 1000, height: 500 };
const W = (id) => fakeWin({ id });

// Minimal `global` stand-in for _dropPoint.
function stubGlobal() {
  globalThis.global = {
    display: {
      get_primary_monitor: () => 0,
      get_monitor_geometry: () => ({ x: 0, y: 0, width: 1000, height: 500 }),
    },
  };
}

test('_bspSlotRects: a lone leaf gets the single-window rect, splits their leaf slots', () => {
  const self = makeSelf({ 'inside-gap': 10 });
  const a = W('a'), b = W('b');
  assert.deepEqual(self._bspSlotRects(leaf(a), WORK_AREA).get(a), { x: 0, y: 0, w: 1000, h: 500 });
  const rects = self._bspSlotRects(split('h', 0.5, leaf(a), leaf(b)), WORK_AREA);
  assert.deepEqual(rects.get(a), { x: 0, y: 0, w: 495, h: 500 });
  assert.deepEqual(rects.get(b), { x: 505, y: 0, w: 495, h: 500 });
});

test('_dwindleDropTree: the target splits along its longer side once the window has left', () => {
  // h(A, v(B, C)): dropping A on B leaves v(B, C) spanning the screen, so
  // B (1000x250) splits side by side, A second, at B's split ratio.
  const self = makeSelf();
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), split('v', 0.4, leaf(b), leaf(c)));
  const after = self._dwindleDropTree(self._bspClone(tree), a, b, WORK_AREA);
  assert.equal(after.direction, 'v');
  assert.equal(after.first.direction, 'h');
  assert.equal(after.first.ratio, 0.4);
  assert.deepEqual([after.first.first.window, after.first.second.window, after.second.window], [b, a, c]);
  // The live tree is untouched.
  assert.deepEqual(self._bspCollectWindows(tree), [a, b, c]);
});

test('_dwindleDropTree: a window not in the tree is inserted', () => {
  const self = makeSelf();
  const a = W('a'), b = W('b'), z = W('z');
  const after = self._dwindleDropTree(split('h', 0.5, leaf(a), leaf(b)), z, b, WORK_AREA);
  assert.deepEqual(self._bspCollectWindows(after), [a, b, z]);
});

test('_dropTargetAt: the slot under the pointer, else the closest; null off the monitor', () => {
  stubGlobal();
  const self = makeSelf();
  const a = W('a'), b = W('b');
  const rects = new Map([[a, { x: 0, y: 0, w: 490, h: 500 }], [b, { x: 510, y: 0, w: 490, h: 500 }]]);
  assert.equal(self._dropTargetAt(rects, WORK_AREA, 100, 100), a);
  assert.equal(self._dropTargetAt(rects, WORK_AREA, 505, 100), b); // in the gap, nearer b
  assert.equal(self._dropTargetAt(rects, WORK_AREA, 1500, 100), null);
});
