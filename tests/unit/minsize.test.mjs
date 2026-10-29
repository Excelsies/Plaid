import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

const withMin = (min) => {
  const w = fakeWin();
  w._min = min;
  return w;
};

// A fake `this` whose min-size lookup reads a `_min` attached to each window.
function minSelf(settings = {}) {
  return makeSelf(settings, {
    _minSizeOverrides: new Map(),
    _getWindowMinSize: (w) => w._min ?? { w: 0, h: 0 },
  });
}

test('_treeMinSizes: h-split adds widths, takes max height', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 30 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  assert.deepEqual(self._treeMinSizes(tree), { w: 300, h: 50 });
});

test('_treeMinSizes: v-split adds heights, takes max width (regression: formulas were inverted)', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 30 });
  const tree = split('v', 0.5, leaf(a), leaf(b));
  assert.deepEqual(self._treeMinSizes(tree), { w: 200, h: 80 });
});

test('_treeMinSizes: tags each node with its computed minimum', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 30 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  assert.equal(tree._minW, 300);
  assert.equal(tree.first._minW, 100);
  assert.equal(tree.second._minW, 200);
});

// The clamp works in whole pixels: _bspLayout splits at
// floor((span - gap) * ratio), so that is what the tests check.
const splitPx = (node, span, gap = 0) => Math.floor((span - gap) * node.ratio);

test('_clampTreeToMinSizes: clamps the split so the second child keeps its minimum', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 50 });
  const tree = split('h', 0.9, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(splitPx(tree, 400), 200); // 400 - 200
  assert.equal(tree.userRatio, 0.9); // the user's ratio is kept, not overwritten
});

test('_clampTreeToMinSizes: raises a too-small split to the first child\'s minimum', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 50 });
  const tree = split('h', 0.1, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(splitPx(tree, 400), 100);
  assert.equal(tree.userRatio, 0.1);
});

test('_clampTreeToMinSizes: unsatisfiable mins share the shortfall in proportion', () => {
  const self = minSelf();
  const a = withMin({ w: 300, h: 50 });
  const b = withMin({ w: 300, h: 50 });
  const tree = split('h', 0.9, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(splitPx(tree, 400), 200); // 400 * 300 / (300 + 300)
});

test('_clampTreeToMinSizes: an unequal shortfall is shared in proportion to the mins', () => {
  const self = minSelf();
  const a = withMin({ w: 300, h: 50 });
  const b = withMin({ w: 100, h: 50 });
  const tree = split('h', 0.1, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 200, 100, 0);
  assert.equal(splitPx(tree, 200), 150); // 200 * 300 / (300 + 100)
});

test('_clampTreeToMinSizes: a ratio the mins allow is left alone', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 100, h: 50 });
  const tree = split('h', 0.4, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(tree.ratio, 0.4);
  assert.equal(tree.userRatio, undefined);
});

test('_clampTreeToMinSizes: the user ratio comes back once the clamp no longer binds', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 50 });
  const tree = split('h', 0.9, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.notEqual(tree.ratio, 0.9);
  b._min = { w: 0, h: 0 }; // the wide window shrank its minimum (or left)
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(tree.ratio, 0.9);
  assert.equal(tree.userRatio, undefined);
});

test('_clampTreeToMinSizes: a nested split is clamped against its own span (regression)', () => {
  // h0.5(A, v0.5(B, h0.9(C, D))): D's 150px minimum must hold inside the
  // 200px right column, not inside the whole 400px area.
  const self = minSelf();
  const [a, b, c, d] = [0, 0, 0, 150].map((w) => withMin({ w, h: 0 }));
  const inner = split('h', 0.9, leaf(c), leaf(d));
  const tree = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), inner));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 400, 0);
  assert.equal(splitPx(tree, 400), 200);
  assert.equal(200 - splitPx(inner, 200), 150);
});

test('_clampTreeToMinSizes: gaps are counted at every level', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 0 });
  const b = withMin({ w: 100, h: 0 });
  const c = withMin({ w: 100, h: 0 });
  const tree = split('h', 0.9, leaf(a), split('h', 0.5, leaf(b), leaf(c)));
  self._treeMinSizes(tree, 10);
  assert.equal(tree.second._minW, 210); // 100 + gap + 100
  self._clampTreeToMinSizes(tree, 400, 100, 10);
  const first = splitPx(tree, 400, 10);
  assert.ok(400 - 10 - first >= 210, `second span ${400 - 10 - first} < 210`);
});

test('_clampTreeToMinSizes: a bend holds only while its window is under the split', () => {
  const self = minSelf();
  const a = withMin({ w: 0, h: 0 });
  const b = withMin({ w: 0, h: 0 });
  const tree = split('h', 0.3, leaf(a), leaf(b));
  tree.userRatio = 0.5;
  tree.bentBy = b;
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(tree.ratio, 0.3); // still bent for b
  tree.second = leaf(withMin({ w: 0, h: 0 })); // b left
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(tree.bentBy, undefined);
  assert.equal(tree.ratio, 0.5);
});

test('_treeMinSizes: the inner gap separates two laid-out children only', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 30 });
  assert.deepEqual(self._treeMinSizes(split('h', 0.5, leaf(a), leaf(b)), 8), { w: 308, h: 50 });
  assert.deepEqual(self._treeMinSizes(split('v', 0.5, leaf(a), leaf(b)), 8), { w: 200, h: 88 });
  assert.deepEqual(self._treeMinSizes(split('h', 0.5, leaf(a), { type: 'empty' }), 8), { w: 100, h: 50 });
});

// Size hints: GNOME 50 returns [ok, w, h]; a plain [w, h] must read the same.
const hintWin = (min, max = [false, 0, 0], frameDelta = [0, 0]) => ({
  ...fakeWin(),
  get_min_size: () => min,
  get_max_size: () => max,
  client_rect_to_frame_rect: (r) => ({ ...r, width: r.width + frameDelta[0], height: r.height + frameDelta[1] }),
});

test('_unpackSizeHint: accepts both [ok, w, h] and [w, h]', () => {
  const self = makeSelf();
  assert.deepEqual(self._unpackSizeHint([true, 360, 410]), [true, 360, 410]);
  assert.deepEqual(self._unpackSizeHint([false, 0, 0]), [false, 0, 0]);
  assert.deepEqual(self._unpackSizeHint([360, 410]), [true, 360, 410]);
  assert.deepEqual(self._unpackSizeHint(null), [false, 0, 0]);
});

test('_getWindowMinSize: reads the width from an [ok, w, h] hint (regression: read ok as w)', () => {
  const self = makeSelf({}, { _minSizeOverrides: new Map() });
  assert.deepEqual(self._getWindowMinSize(hintWin([true, 360, 410])), { w: 360, h: 410 });
  assert.deepEqual(self._getWindowMinSize(hintWin([360, 410])), { w: 360, h: 410 });
  assert.deepEqual(self._getWindowMinSize(hintWin([false, 360, 410])), { w: 0, h: 0 });
});

test('_windowSizeHint: converts the client hint to a frame size', () => {
  const self = makeSelf();
  // A CSD buffer: the client size includes a 14px shadow on each side.
  assert.deepEqual(self._windowSizeHint(hintWin([true, 528, 406], undefined, [-28, -29]), 'min'),
    { w: 500, h: 377 });
  // An unset axis stays 0 rather than picking up the delta.
  assert.deepEqual(self._windowSizeHint(hintWin([true, 528, 0], undefined, [-28, -29]), 'min'),
    { w: 500, h: 0 });
  assert.equal(self._windowSizeHint(hintWin([true, 0, 0]), 'min'), null);
});

test('_isFixedSizeWindow: min === max on both axes, for either hint shape', () => {
  const self = makeSelf();
  assert.equal(self._isFixedSizeWindow(hintWin([true, 400, 300], [true, 400, 300])), true);
  assert.equal(self._isFixedSizeWindow(hintWin([400, 300], [400, 300])), true);
  assert.equal(self._isFixedSizeWindow(hintWin([true, 400, 300], [true, 400, 900])), false);
  assert.equal(self._isFixedSizeWindow(hintWin([true, 400, 300], [false, 0, 0])), false);
});

test('_bspRelocateForMinSizes: moves a window to a leaf where every minimum fits', () => {
  // v(A, v(B, v(C, D))) in 400px: B, C and D (150px tall each) stacked
  // need 450px. Splitting B's leaf side by side with D fits everything.
  const self = minSelf({ 'dwindle-ratio': 0.5 });
  const a = withMin({ w: 0, h: 0 });
  const [b, c, d] = [0, 1, 2].map(() => withMin({ w: 0, h: 150 }));
  const tree = split('v', 0.5, leaf(a), split('v', 0.5, leaf(b), split('v', 0.5, leaf(c), leaf(d))));
  self._treeMinSizes(tree);
  assert.equal(tree._minH, 450);
  const fixed = self._bspRelocateForMinSizes(tree, [d], 0, 0, 400, 400, 0, 0.5);
  assert.notEqual(fixed, tree);
  self._treeMinSizes(fixed);
  assert.ok(fixed._minW <= 400 && fixed._minH <= 400, `still infeasible: ${fixed._minW}x${fixed._minH}`);
  assert.deepEqual(new Set(self._bspCollectWindows(fixed)), new Set([a, b, c, d]));
});

test('_bspRelocateForMinSizes: a tree that fits is returned unchanged', () => {
  const self = minSelf({ 'dwindle-ratio': 0.5 });
  const a = withMin({ w: 100, h: 0 });
  const b = withMin({ w: 100, h: 0 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  assert.equal(self._bspRelocateForMinSizes(tree, [b], 0, 0, 400, 400, 0, 0.5), tree);
});

function masterSelf(masterRatio) {
  return makeSelf({}, {
    _masterRatios: new Map(),
    _wsIndex: () => 0,
    _scheduleSaveLayouts: () => {},
    _getMasterRatio: () => masterRatio,
    _getWindowMinSize: (w) => w._min ?? { w: 0, h: 0 },
  });
}

const stack = (mins) => mins.map((m) => withMin({ w: m, h: 50 }));

test('_clampMasterStackRatios: unsatisfiable with zero master-min falls back to 0.5 (regression)', () => {
  const self = masterSelf(0.5);
  const wins = stack([0, 500]);
  self._clampMasterStackRatios({}, wins, 500, 0, false);
  assert.equal(self._masterRatios.get(0), 0.5);
});

test('_clampMasterStackRatios: unsatisfiable with a real master-min uses masterMin/need', () => {
  const self = masterSelf(0.5);
  const wins = stack([200, 500]);
  self._clampMasterStackRatios({}, wins, 500, 0, false);
  assert.ok(Math.abs(self._masterRatios.get(0) - 200 / 700) < 1e-9);
});

test('_clampMasterStackRatios: clamps a ratio inside the feasible band', () => {
  const self = masterSelf(0.2);
  const wins = stack([400, 100]);
  self._clampMasterStackRatios({}, wins, 1000, 0, false);
  assert.equal(self._masterRatios.get(0), 0.4); // lo = 400/1000
});

test('_clampMasterStackRatios: leaves a feasible ratio alone', () => {
  const self = masterSelf(0.5);
  const wins = stack([100, 100]);
  self._clampMasterStackRatios({}, wins, 1000, 0, false);
  assert.equal(self._masterRatios.get(0), 0.5);
});

test('_clampMasterStackRatios: single window is a no-op', () => {
  const self = masterSelf(0.5);
  self._clampMasterStackRatios({}, stack([100]), 1000, 0, false);
  assert.equal(self._masterRatios.size, 0);
});
