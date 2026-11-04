import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Drop point, closest slot and slot rects (geometry.js, bsp.js).
const WORK_AREA = { x: 0, y: 0, width: 1000, height: 500 };
const W = (id) => fakeWin({ id });

function withMonitor(fn) {
  const old = globalThis.global;
  globalThis.global = {
    ...old,
    display: {
      ...old.display,
      get_primary_monitor: () => 0,
      get_monitor_geometry: (i) => (i === 1 ? { x: 1000, y: 0, width: 800, height: 500 } : { x: 0, y: 0, width: 1000, height: 500 }),
    },
  };
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

test('bspSlotRects: a lone leaf gets the single-window rect, splits their leaf slots', () => {
  const self = makeSelf({ 'inside-gap': 10 });
  const a = W('a'), b = W('b');
  assert.deepEqual(self.bsp.bspSlotRects(leaf(a), WORK_AREA).get(a), { x: 0, y: 0, w: 1000, h: 500 });
  const rects = self.bsp.bspSlotRects(split('h', 0.5, leaf(a), leaf(b)), WORK_AREA);
  assert.deepEqual(rects.get(a), { x: 0, y: 0, w: 495, h: 500 });
  assert.deepEqual(rects.get(b), { x: 505, y: 0, w: 495, h: 500 });
  assert.equal(self.bsp.bspSlotRects(null, WORK_AREA).size, 0);
});

test('bspSlotRects: slots are min-size clamped as the retile clamps them', () => {
  const self = makeSelf({ 'inside-gap': 0 });
  const a = fakeWin({ id: 'a', minSize: [700, 0] }), b = W('b');
  const rects = self.bsp.bspSlotRects(split('h', 0.5, leaf(a), leaf(b)), WORK_AREA);
  assert.deepEqual(rects.get(a), { x: 0, y: 0, w: 700, h: 500 });
  assert.deepEqual(rects.get(b), { x: 700, y: 0, w: 300, h: 500 });  // Minimums that do not fit: each slot still reports its minimum.
  const c = fakeWin({ id: 'c', minSize: [700, 0] });
  const over = self.bsp.bspSlotRects(split('h', 0.5, leaf(a), leaf(c)), WORK_AREA);
  assert.deepEqual(over.get(c), { x: 500, y: 0, w: 700, h: 500 });
});

test('dropTargetAt: the slot under the pointer, else the closest; null off the monitor', () => withMonitor(() => {
  const self = makeSelf();
  const a = W('a'), b = W('b');
  const rects = new Map([[a, { x: 0, y: 0, w: 490, h: 500 }], [b, { x: 510, y: 0, w: 490, h: 500 }]]);
  assert.equal(self.geometry.dropTargetAt(rects, WORK_AREA, 100, 100), a);
  assert.equal(self.geometry.dropTargetAt(rects, WORK_AREA, 505, 100), b); // in the gap, nearer b
  assert.equal(self.geometry.dropTargetAt(rects, WORK_AREA, 1500, 100), null);
}));

test('dropPoint: clamped into the work area (over the top bar), null off the monitor', () => withMonitor(() => {
  const self = makeSelf();
  const wa = { x: 0, y: 32, width: 1000, height: 468 };
  assert.deepEqual(self.geometry.dropPoint(wa, 400, 5), [400, 32]);
  assert.deepEqual(self.geometry.dropPoint(wa, 999, 499), [999, 499]);
  assert.equal(self.geometry.dropPoint(wa, 1200, 100), null);
  assert.deepEqual(self.geometry.dropPoint({ x: 1000, y: 0, width: 800, height: 500 }, 1200, 100, 1), [1200, 100]);
}));

test('pointRectDistSq is 0 inside the rect and the squared edge distance outside', () => {
  const self = makeSelf();
  assert.equal(self.geometry.pointRectDistSq(0, 0, 100, 100, 50, 50), 0);
  assert.equal(self.geometry.pointRectDistSq(0, 0, 100, 100, 130, 50), 900);
  assert.equal(self.geometry.pointRectDistSq(0, 0, 100, 100, -30, -40), 2500);
});
