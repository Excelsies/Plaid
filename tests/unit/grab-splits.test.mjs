import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// The grabbed edge's split (grab.pickSplits / updateGrabSplits), on a
// 1000x500 tiling area without gaps.

const WA = { x: 0, y: 0, width: 1000, height: 500 };
const AREA = { x: 0, y: 0, w: 1000, h: 500 };
const W = (n) => fakeWin({ instance: n });

// sign: [width, height] of the grab (W edge -1, E +1; N -1, S +1).
function pick(tree, win, [ws, hs], layout = 'spiral') {
  const self = makeSelf({ 'inside-gap': 0 });
  self.windows.getWorkspaceLayout = () => layout;
  self.monitors.windowMon = () => 0;
  self.monitors.monitorWorkArea = () => WA;
  self.bsp.bspGetTree = () => tree;
  self._grabWidthSign = ws;
  self._grabHeightSign = hs;
  self.grab.pickSplits(win, {});
  return self;
}

test('pickSplits: an inner edge moves the divider under it, following the pointer', () => {
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)));
  const self = pick(tree, b, [-1, 1]);
  assert.equal(self._grabResizeNodeW, tree, 'b\'s left edge is the root divider');
  assert.equal(self._grabFollowW, 1);
  assert.equal(self._grabResizeNodeH, tree.second, 'b\'s bottom edge is the v divider');
  assert.equal(self._grabFollowH, 1);
  self.grab.updateGrabSplits(tree, -100, 50, 0, AREA);
  assert.equal(tree.ratio, 0.4);
  assert.equal(tree.second.ratio, 0.6);
});

test('pickSplits: a monitor-edge grab moves the opposite divider, mirrored', () => {
  const a = W('a'), b = W('b');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = pick(tree, a, [-1, 0]);
  assert.equal(self._grabResizeNodeW, tree);
  assert.equal(self._grabFollowW, -1);
  assert.equal(self._grabResizeNodeH, null, 'no height grab');
  // Dragged right, mutter shrinks a from the left: the divider moves left.
  self.grab.updateGrabSplits(tree, 100, 0, 0, AREA);
  assert.equal(tree.ratio, 0.4);
});

test('pickSplits: a full-span axis has no divider', () => {
  const a = W('a'), b = W('b');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = pick(tree, a, [0, 1]);
  assert.equal(self._grabResizeNodeH, null);
  assert.equal(self._grabResizeNodeW, null);
});

test('pickSplits: a split met first on the axis holds the anchored edge', () => {
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), split('h', 0.5, leaf(b), leaf(c)));
  const self = pick(tree, b, [-1, 0]);
  assert.equal(self._grabResizeNodeW, tree);
  assert.equal(self._grabInnerW.node, tree.second);
  assert.equal(self._grabInnerW.anchor, 750);
  self.grab.updateGrabSplits(tree, -100, 0, 0, AREA);
  assert.equal(tree.ratio, 0.4);
  // b's right edge stays at 750.
  const inner = tree.second;
  assert.equal(inner._x + Math.floor(inner._w * inner.ratio), 750);
});

test('updateGrabSplits: a Spiral divider passes a minimum and stops at 0.05 / 0.95', () => {
  const a = fakeWin({ instance: 'a', minSize: [300, 0] }), b = W('b');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = pick(tree, b, [-1, 0]);
  self.grab.updateGrabSplits(tree, -400, 0, 0, AREA, {}, 0);
  assert.equal(tree.ratio.toFixed(4), '0.1000');
  self.grab.updateGrabSplits(tree, -480, 0, 0, AREA, {}, 0);
  assert.equal(tree.ratio, 0.05);
  self.grab.updateGrabSplits(tree, 480, 0, 0, AREA, {}, 0);
  assert.equal(tree.ratio, 0.95);
});

test('updateGrabSplits: a dwindle divider stops at both subtrees\' minimums, not at 0.05 / 0.95', () => {
  const a = fakeWin({ instance: 'a', minSize: [300, 0] }), b = fakeWin({ instance: 'b', minSize: [200, 0] });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const self = pick(tree, b, [-1, 0], 'dwindle');
  self.grab.updateGrabSplits(tree, -400, 0, 0, AREA, {}, 0);
  assert.equal(tree.ratio, 0.3);
  self.grab.updateGrabSplits(tree, 480, 0, 0, AREA, {}, 0);
  assert.equal(tree.ratio, 0.8);
  // No minimum: the whole axis, past 0.05 / 0.95.
  const c = W('c'), d = W('d');
  const free = split('h', 0.5, leaf(c), leaf(d));
  const s2 = pick(free, d, [-1, 0], 'dwindle');
  s2.grab.updateGrabSplits(free, -480, 0, 0, AREA, {}, 0);
  assert.equal(free.ratio.toFixed(2), '0.02');
});

test('updateGrabSplits: a dwindle inner split holds the anchored edge within its minimums', () => {
  const a = W('a'), b = W('b'), c = fakeWin({ instance: 'c', minSize: [200, 0] });
  const tree = split('h', 0.5, leaf(a), split('h', 0.5, leaf(b), leaf(c)));
  const self = pick(tree, b, [-1, 0], 'dwindle');
  self.grab.updateGrabSplits(tree, -100, 0, 0, AREA, {}, 0);
  assert.equal(tree.ratio, 0.4);
  const inner = tree.second;
  assert.equal(inner._x + Math.floor(inner._w * inner.ratio), 750, 'b\'s right edge stays at 750');
});

test('setGrabRatio: Spiral keeps a raw ratio within [0.05, 0.95], whatever the children\'s minimums', () => {
  const self = makeSelf({});
  const node = { direction: 'h', _w: 1000, ratio: 0.5, first: { _minW: 300 }, second: { _minW: 200 } };
  assert.equal(self.grab.setGrabRatio(node, 0.1, 0, true), false);
  assert.equal(node.ratio, 0.1);
  assert.equal(self.grab.setGrabRatio(node, 0.01, 0, true), true);
  assert.equal(node.ratio, 0.05);
  self.grab.setGrabRatio(node, 0.99, 0, true);
  assert.equal(node.ratio, 0.95);
});

test('setGrabRatio: dwindle keeps the children\'s minimums; minimums that do not fit share the axis', () => {
  const self = makeSelf({});
  const node = { direction: 'h', _w: 1000, ratio: 0.5, first: { _minW: 300 }, second: { _minW: 200 } };
  assert.equal(self.grab.setGrabRatio(node, 0.1, 0, false), true);
  assert.equal(node.ratio, 0.3);
  self.grab.setGrabRatio(node, 0.95, 0, false);
  assert.equal(node.ratio, 0.8);
  assert.equal(self.grab.setGrabRatio(node, 0.5, 0, false), false);
  const over = { direction: 'v', _h: 500, ratio: 0.5, first: { _minH: 400 }, second: { _minH: 400 } };
  self.grab.setGrabRatio(over, 0.9, 0, false);
  assert.equal(over.ratio, 0.5);
});

test('grab end: the picked splits\' inner anchors and follow signs go', () => {
  const self = makeSelf({});
  self.borders.startBorderAnimation = () => {};
  self._grabInnerW = { node: {} };
  self._grabInnerH = { node: {} };
  self._grabFollowW = -1;
  self._grabFollowH = -1;
  self.grab.handleGrabEnd(W('a'), 1);
  assert.deepEqual([self._grabInnerW, self._grabInnerH, self._grabFollowW, self._grabFollowH], [null, null, 1, 1]);
});

test('updateGrabSplits: a dwindle subtree narrowed by the divider is re-clamped to its minimums', () => {
  const a = W('a'), b = W('b'), c = fakeWin({ instance: 'c', minSize: [300, 0] });
  const tree = split('h', 0.5, leaf(a), split('h', 0.5, leaf(b), leaf(c)));
  const self = pick(tree, a, [1, 0], 'dwindle');
  self.grab.updateGrabSplits(tree, 200, 0, 0, AREA, {}, 0);
  assert.equal(tree.ratio, 0.7);
  assert.ok(tree.second.second._w >= 300, `c drawn ${tree.second.second._w} wide, under its minimum`);
});

test('updateGrabSplits: a dwindle inner split that cannot hold the anchored edge keeps its minimums', () => {
  const a = W('a'), b = fakeWin({ instance: 'b', minSize: [100, 0] }), c = fakeWin({ instance: 'c', minSize: [200, 0] });
  const tree = split('h', 0.5, leaf(a), split('h', 0.5, leaf(b), leaf(c)));
  const self = pick(tree, b, [-1, 0], 'dwindle');
  self.grab.updateGrabSplits(tree, 200, 0, 0, AREA, {}, 0);
  assert.equal(tree.ratio, 0.7);
  assert.ok(tree.second.first._w >= 100, `b drawn ${tree.second.first._w} wide, under its minimum`);
});
