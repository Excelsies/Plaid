import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Hyprland's rules for Spiral groups; dwindle keeps its own.

const WS = {};
const WA = { x: 0, y: 0, width: 1000, height: 500 };

function win(id, opts = {}) {
  const w = fakeWin({ id, instance: id, ...opts });
  w.get_id = () => id;
  w.get_workspace = () => WS;
  return w;
}

function groupSelf(layout, settings = {}) {
  const self = makeSelf({ 'dwindle-ratio': 0.5, enabled: true, ...settings });
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = () => false;
  self.windows.isFullscreenTile = () => false;
  self.monitors.windowMon = () => 0;
  self.monitors.groupPlaces = () => true;
  self.monitors.monitorWorkArea = () => WA;
  self.geometry.wsIndex = () => 1;
  self.grab.safeMove = () => {};
  return self;
}

// Y1: minimums.

test('layoutMinSize: a Spiral group gives no minimum (client, rule, learned); dwindle the real one', () => {
  const a = win('a', { minSize: [600, 300] });
  const r = win('r');
  const l = win('l');
  for (const [layout, want] of [['spiral', false], ['dwindle', true]]) {
    const self = groupSelf(layout);
    self._minSizeOverrides = new Map([['r', { w: 700, h: 0 }]]);
    self._observedMinSizes.set(l, { w: 0, h: 400 });
    const got = [a, r, l].map(w => self.bsp.layoutMinSize(w, WS, 0));
    assert.deepEqual(got, want
      ? [{ w: 600, h: 300 }, { w: 700, h: 0 }, { w: 0, h: 400 }]
      : [{ w: 0, h: 0 }, { w: 0, h: 0 }, { w: 0, h: 0 }], layout);
  }
});

test('retileDwindle: a Spiral split keeps its ratio past a minimum; dwindle clamps it', () => {
  for (const [layout, ratio] of [['spiral', 0.5], ['dwindle', 0.2]]) {
    const a = win('a'), b = win('b', { minSize: [800, 0] });
    const self = groupSelf(layout);
    const moves = new Map();
    self.grab.safeMove = (w, x, y, ww, h) => moves.set(w, [x, y, ww, h]);
    self.bsp.bspSetTree(WS, 0, split('h', 0.5, leaf(a), leaf(b)));
    self._bspLaidOutAs.set(self.monitors.groupObj(WS, 0), layout);
    self.layouts.retileDwindle(WS, [a, b], 0);
    assert.equal(self.bsp.bspGetTree(WS, 0).ratio.toFixed(4), ratio.toFixed(4), layout);
    const [x, , w] = moves.get(b);
    assert.ok(layout === 'spiral' ? x === 500 && w === 500 : w >= 800, `${layout}: b at ${moves.get(b)}`);
  }
});

test('retileDwindle: a nested Spiral split keeps its ratio past a minimum on either side', () => {
  for (const [layout, ratio] of [['spiral', 0.5], ['dwindle', 0.8]]) {
    const a = win('a'), b = win('b', { minSize: [800, 0] }), c = win('c');
    const self = groupSelf(layout);
    self.bsp.bspSetTree(WS, 0, split('h', 0.5, split('v', 0.5, leaf(b), leaf(c)), leaf(a)));
    self._bspLaidOutAs.set(self.monitors.groupObj(WS, 0), layout);
    self.layouts.retileDwindle(WS, [b, c, a], 0);
    assert.equal(self.bsp.bspGetTree(WS, 0).ratio.toFixed(4), ratio.toFixed(4), layout);
  }
});

test('windowSlotRect: a Spiral slot is its leaf, never widened to the minimum', () => {
  for (const [layout, w] of [['spiral', 300], ['dwindle', 800]]) {
    const a = win('a'), b = win('b', { minSize: [800, 0] });
    const self = groupSelf(layout);
    self.monitors.getWindowsForGroup = () => [a, b];
    const tree = split('h', 0.7, leaf(a), leaf(b));
    self.bsp.bspTagGeometry(tree, 0, 0, 1000, 500, 0);
    self.bsp.bspGetTree = () => tree;
    assert.equal(self.grab.windowSlotRect(b, WS, layout, WA, 0).w, w, layout);
  }
});

test('bspSlotRects: a Spiral drag ghost\'s slots ignore minimums', () => {
  for (const layout of ['spiral', 'dwindle']) {
    const a = win('a'), b = win('b', { minSize: [800, 0] });
    const self = groupSelf(layout);
    const w = self.bsp.bspSlotRects(split('h', 0.5, leaf(a), leaf(b)), WA, WS, 0).get(b).w;
    assert.ok(layout === 'spiral' ? w === 500 : w >= 800, `${layout}: ${w}`);
  }
});

test('landing: a Spiral window stuck over its slot learns no minimum and bends no split', () => {
  for (const [layout, n] of [['spiral', 0], ['dwindle', 1]]) {
    const self = groupSelf(layout);
    const w = win('a', { frame: { x: 0, y: 0, width: 900, height: 500 } });
    w.get_compositor_private = () => ({});
    w.get_maximize_flags = () => 0;
    let learned = 0;
    let bent = 0;
    self.placement.recordObservedMin = () => learned++;
    self.placement.adjustPinnedTree = () => bent++;
    self.placement.retryLanding = () => {};
    const s = { win: w, targetX: 0, targetY: 0, targetW: 500, targetH: 500 };
    self.placement.verifyAnimationLanding(s, 'tiled');
    self.placement.verifyAnimationLanding(s, 'tiled');
    assert.deepEqual([learned, bent], [n, n], layout);
  }
});

test('resizeDwindle: a Spiral keyboard resize reaches 0.05 / 0.95, dwindle stops at 0.15 / 0.85', () => {
  for (const [layout, lo, hi] of [['spiral', 0.05, 0.95], ['dwindle', 0.15, 0.85]]) {
    const a = win('a'), b = win('b');
    const self = groupSelf(layout);
    self.layouts.refreshSavedShape = () => {};
    const tree = split('h', 0.5, leaf(a), leaf(b));
    tree._w = 1000;
    self.bsp.bspSetTree(WS, 0, tree);
    self.actions.resizeDwindle(a, WS, 'width', -900, 0);
    assert.equal(tree.ratio, lo, `${layout} shrink`);
    self.actions.resizeDwindle(a, WS, 'width', 1900, 0);
    assert.equal(tree.ratio, hi, `${layout} grow`);
  }
});
