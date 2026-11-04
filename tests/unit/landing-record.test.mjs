import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

// The per-window landing record and its transitions: miss, accept, slot
// change, frame, land, close, scratchpad release.

function recSelf() {
  const timers = [];
  const self = makeSelf({}, { _windowMasks: new Map() });
  self.signals.addTimeout = (ms, fn) => timers.push(fn);
  self.signals.scheduleBorders = () => {};
  return { self, timers };
}

function win(frame = { x: 0, y: 0, width: 900, height: 600 }) {
  const w = fakeWin({ frame });
  const actor = { visible: false, set_opacity() {} };
  w.get_compositor_private = () => actor;
  w.get_id = () => w._testId;
  w.get_workspace = () => null;
  return w;
}

const slot = (w) => ({ targetX: 0, targetY: 0, targetW: w, targetH: 600 });

test('landing record: a miss counts per slot and in total', () => {
  const { self } = recSelf();
  const w = win();
  self.placement.retryLanding(w, slot(800));
  self.placement.retryLanding(w, slot(800));
  assert.deepEqual(self._landings.get(w), { key: '0,0,800,600', n: 2, total: 2, accepted: null, frame: null });
  self.placement.retryLanding(w, slot(700));
  const rec = self._landings.get(w);
  assert.equal(rec.key, '0,0,700,600');
  assert.equal(rec.n, 1);
  assert.equal(rec.total, 3);
});

test('landing record: accept keeps the total, zeroes the slot count and drops the frame', () => {
  const { self } = recSelf();
  const w = win();
  self.placement.landingFrame(w, { x: 0, y: 0, width: 900, height: 600 });
  for (let i = 0; i < 4; i++) self.placement.retryLanding(w, slot(800));
  assert.deepEqual(self._landings.get(w), { key: '0,0,800,600', n: 0, total: 4, accepted: '0,0,800,600', frame: null });
  assert.equal(self.placement.hasAcceptedLanding(w), true);
});

test('landing record: a slot change ends the acceptance, the counts stay', () => {
  const { self } = recSelf();
  const w = win();
  for (let i = 0; i < 4; i++) self.placement.retryLanding(w, slot(800));
  self.placement.retryLanding = () => {};
  self.placement.verifyAnimationLanding({ win: w, ...slot(1200) }, 'tiled');
  const rec = self._landings.get(w);
  assert.equal(rec.accepted, null);
  assert.equal(rec.total, 4);
  assert.equal(self.placement.hasAcceptedLanding(w), false);
});

test('landing record: a slot change on a window with no record creates none', () => {
  const { self } = recSelf();
  const w = win();
  self.placement.landingSlotChanged(w);
  assert.equal(self._landings.has(w), false);
});

test('landing record: the frame transition returns the previous mismatched frame', () => {
  const { self } = recSelf();
  const w = win();
  assert.equal(self.placement.landingFrame(w, { x: 1, y: 2, width: 3, height: 4 }), null);
  assert.deepEqual(self.placement.landingFrame(w, { x: 5, y: 6, width: 7, height: 8 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(self._landings.get(w).frame, { x: 5, y: 6, w: 7, h: 8 });
});

test('landing record: a verified miss stores its frame, two equal frames bend once', () => {
  const { self } = recSelf();
  const w = win({ x: 0, y: 0, width: 900, height: 600 });
  w.get_maximize_flags = () => 0;
  let bent = 0;
  self.placement.adjustPinnedTree = () => bent++;
  self.placement.recordObservedMin = () => {};
  self.placement.retryLanding = () => {};
  self.placement.verifyAnimationLanding({ win: w, ...slot(800) }, 'tiled');
  assert.deepEqual(self._landings.get(w).frame, { x: 0, y: 0, w: 900, h: 600 });
  assert.equal(bent, 0);
  self.placement.verifyAnimationLanding({ win: w, ...slot(800) }, 'tiled');
  assert.equal(bent, 1);
});

test('landing record: landing drops the record', () => {
  const { self } = recSelf();
  const w = win({ x: 0, y: 0, width: 800, height: 600 });
  for (let i = 0; i < 2; i++) self.placement.retryLanding(w, slot(700));
  assert.equal(self.placement.verifyAnimationLanding({ win: w, ...slot(800) }, 'tiled'), true);
  assert.equal(self._landings.has(w), false);
});

test('landing record: closing the window drops the record', () => {
  const { self } = recSelf();
  const w = win();
  self.placement.landingFrame(w, { x: 0, y: 0, width: 1, height: 1 });
  self.windows.disconnectWindowSignals = () => {};
  self.borders.removeBorder = () => {};
  self.windows.removeWindow(w);
  assert.equal(self._landings.has(w), false);
});

test('landing record: leaving the scratchpad drops the record', () => {
  const { self } = recSelf();
  const w = win();
  for (let i = 0; i < 4; i++) self.placement.retryLanding(w, slot(800));
  assert.equal(self._landings.has(w), true);
  self._scratchpadWindows.set(w, {});
  self.actions.getActiveWindow = () => w;
  self.borders.updateBorders = () => {};
  self.workspaces.showPopup = () => {};
  self.scratchpad.scratchpadRemove();
  assert.equal(self._landings.has(w), false);
});

test('landing record: a pending retry stops once the slot is accepted', () => {
  const { self, timers } = recSelf();
  const w = win();
  let retiles = 0;
  w.get_workspace = () => ({});
  self.layouts.retileWorkspace = () => retiles++;
  self.placement.retryLanding(w, slot(800));
  timers[0]();
  assert.equal(retiles, 1);
  self.placement.retryLanding(w, slot(800));
  self.placement.landingAccept(w, '0,0,800,600');
  timers[1]();
  assert.equal(retiles, 1);
});

test('landing record: after teardown no transition writes', () => {
  const { self } = recSelf();
  const w = win();
  self._landings = null;
  assert.equal(self.placement.landingMiss(w, 'k'), null);
  self.placement.landingAccept(w, 'k');
  self.placement.landingSlotChanged(w);
  assert.equal(self.placement.landingFrame(w, { x: 0, y: 0, width: 1, height: 1 }), null);
  assert.equal(self.placement.hasAcceptedLanding(w), false);
  self.placement.releaseLanding(w);
  self.placement.retryLanding(w, slot(800));
});
