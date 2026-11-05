import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Directional focus across monitors: each window is compared by the rect of
// its own group, a Spiral tile by its slot, a dwindle tile by its frame.
// Monitor 0 (Spiral, 1000x500): v(A, Bm) with Bm drawn over the whole area;
// monitor 1 (dwindle, to the right): C1 above C2.

const WS = {};
const AREAS = [{ x: 0, y: 0, width: 1000, height: 500 }, { x: 1000, y: 0, width: 1000, height: 500 }];

function win(id, mon, frame) {
  const w = fakeWin({ id, instance: id, frame });
  w.get_id = () => id;
  w.get_workspace = () => WS;
  w._mon = mon;
  return w;
}

function xmon() {
  const a = win('a', 0, { x: 0, y: 0, width: 1000, height: 250 });
  const bm = win('bm', 0, { x: 0, y: 0, width: 1000, height: 500 });
  const c1 = win('c1', 1, { x: 1000, y: 0, width: 1000, height: 240 });
  const c2 = win('c2', 1, { x: 1000, y: 260, width: 1000, height: 240 });
  const wins = [a, bm, c1, c2];
  const self = makeSelf({ 'dwindle-ratio': 0.5, enabled: true });
  self.windows.getWorkspaceLayout = (_ws, mon) => (mon === 1 ? 'dwindle' : 'spiral');
  self.windows.isFloating = () => false;
  self.windows.getWindowsForWorkspace = () => wins;
  self.monitors.windowMon = w => w._mon;
  self.monitors.groupPlaces = () => true;
  self.monitors.monitorWorkArea = (_ws, mon) => AREAS[mon];
  self.monitors.getWindowsForGroup = (_ws, mon) => wins.filter(w => w._mon === mon);
  self.signals.addIdle = () => {};
  self.currentTime = () => 0;
  self.bsp.bspSetTree(WS, 0, split('v', 0.5, leaf(a), leaf(bm)));
  let activated = null;
  for (const w of wins) w.activate = () => { activated = w; };
  return { self, a, bm, c1, c2, activated: () => activated };
}

test('moveFocus across monitors: an oversized Spiral tile and its neighbours compare slots, the other monitor frames', () => {
  const r = xmon();
  // From Bm (slot: the lower half) right: C2, not the C1 its frame ties with.
  global.display.focus_window = r.bm;
  r.self.actions.moveFocus('right');
  assert.equal(r.activated(), r.c2);
  // From C1 left: A (Bm's slot is below C1), not the taller Bm frame.
  global.display.focus_window = r.c1;
  r.self.actions.moveFocus('left');
  assert.equal(r.activated(), r.a);
});
