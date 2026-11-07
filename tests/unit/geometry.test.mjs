import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

test('_isValidWorkArea rejects degenerate / non-finite rects (login race guard)', () => {
  const self = makeSelf();
  assert.equal(self._isValidWorkArea({ x: 0, y: 0, width: 1, height: 1 }), false);
  assert.equal(self._isValidWorkArea({ x: 0, y: 0, width: 99, height: 100 }), false);
  assert.equal(self._isValidWorkArea({ x: NaN, y: 0, width: 100, height: 100 }), false);
  assert.equal(self._isValidWorkArea(null), false);
  assert.equal(self._isValidWorkArea({ x: 0, y: 0, width: 100, height: 100 }), true);
});

test('_outsideArea insets the work area by the per-edge outside gaps', () => {
  const self = makeSelf({
    'outside-gap-top': 4, 'outside-gap-bottom': 4,
    'outside-gap-left': 4, 'outside-gap-right': 4,
  });
  assert.deepEqual(self._outsideArea({ x: 0, y: 0, width: 1000, height: 1000 }),
    { x: 4, y: 4, w: 992, h: 992 });
});

test('_outsideArea returns null for an invalid work area', () => {
  const self = makeSelf({ 'outside-gap-top': 4, 'outside-gap-bottom': 4, 'outside-gap-left': 4, 'outside-gap-right': 4 });
  assert.equal(self._outsideArea({ x: 0, y: 0, width: 1, height: 1 }), null);
});

test('_outsideArea never yields a non-positive size', () => {
  const self = makeSelf({
    'outside-gap-top': 9999, 'outside-gap-bottom': 9999,
    'outside-gap-left': 9999, 'outside-gap-right': 9999,
  });
  const area = self._outsideArea({ x: 0, y: 0, width: 1000, height: 1000 });
  assert.equal(area.w, 1);
  assert.equal(area.h, 1);
});

test('_singleWindowRect equals _outsideArea', () => {
  const self = makeSelf({
    'outside-gap-top': 4, 'outside-gap-bottom': 4,
    'outside-gap-left': 4, 'outside-gap-right': 4,
  });
  const wa = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(self._singleWindowRect(wa), self._outsideArea(wa));
});

test('_minClampSlot raises a slot to the window minimum, capped by the area', () => {
  const self = makeSelf({}, { _getWindowMinSize: () => ({ w: 300, h: 200 }) });
  assert.deepEqual(self._minClampSlot({ x: 0, y: 0, w: 100, h: 100 }, fakeWin(), 1000, 1000),
    { x: 0, y: 0, w: 300, h: 200 });
  assert.deepEqual(self._minClampSlot({ x: 0, y: 0, w: 100, h: 100 }, fakeWin(), 250, 150),
    { x: 0, y: 0, w: 250, h: 150 });
});

test('_minClampSlot leaves an adequate slot untouched', () => {
  const self = makeSelf({}, { _getWindowMinSize: () => ({ w: 100, h: 100 }) });
  const r = { x: 1, y: 2, w: 500, h: 400 };
  assert.deepEqual(self._minClampSlot(r, fakeWin(), 1000, 1000), r);
});

test('_findDirectionalTarget finds the left neighbour', () => {
  const self = makeSelf();
  const focused = fakeWin({ frame: { x: 100, y: 0, width: 100, height: 100 } });
  const left = fakeWin({ frame: { x: 0, y: 0, width: 100, height: 100 } });
  const right = fakeWin({ frame: { x: 200, y: 0, width: 100, height: 100 } });
  assert.equal(self._findDirectionalTarget(focused, 'left', [focused, left, right]), left);
});

test('_findDirectionalTarget reaches a narrow few-pixel overlap', () => {
  const self = makeSelf();
  const focused = fakeWin({ frame: { x: 0, y: 0, width: 100, height: 100 } });
  const right = fakeWin({ frame: { x: 100, y: 90, width: 100, height: 100 } });
  assert.equal(self._findDirectionalTarget(focused, 'right', [focused, right]), right);
});

test('_findDirectionalTarget returns null when nothing is in that direction', () => {
  const self = makeSelf();
  const focused = fakeWin({ frame: { x: 100, y: 100, width: 100, height: 100 } });
  const other = fakeWin({ frame: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(self._findDirectionalTarget(focused, 'right', [focused, other]), null);
});

test('_findDirectionalTarget ignores the focused window itself', () => {
  const self = makeSelf();
  const focused = fakeWin({ frame: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(self._findDirectionalTarget(focused, 'down', [focused]), null);
});

test('_bgAppRealToDisplay is identity with no parking workspace', () => {
  const self = makeSelf({}, { _backgroundAppParkingWs: null, _wsIndex: () => -1 });
  assert.equal(self._bgAppRealToDisplay(3), 3);
});

test('_bgAppRealToDisplay shifts indices after a parking slot (regression: bare realIdx > -1)', () => {
  const self = makeSelf({}, { _backgroundAppParkingWs: {}, _wsIndex: () => 2 });
  assert.equal(self._bgAppRealToDisplay(1), 1);
  assert.equal(self._bgAppRealToDisplay(2), 2);
  assert.equal(self._bgAppRealToDisplay(5), 4);
});

