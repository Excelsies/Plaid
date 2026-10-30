import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Minimal `global` stand-in: pointer, focus and primary monitor.
function stubGlobal({ pointer = [0, 0], focus = null } = {}) {
  globalThis.global = {
    get_pointer: () => [...pointer, 0],
    display: {
      focus_window: focus,
      get_primary_monitor: () => 0,
      get_monitor_geometry: () => ({ x: 0, y: 0, width: 1000, height: 500 }),
    },
  };
}

const WS = {};
const AREA = { x: 0, y: 0, w: 1000, h: 500 };
const WORK_AREA = { x: 0, y: 0, width: 1000, height: 500 };

const W = (id) => ({ ...fakeWin({ id }), get_workspace: () => WS, get_id: () => id });

function spiralSelf() {
  return makeSelf({}, {
    _getWorkspaceLayout: () => 'spiral',
    _isFloating: () => false,
  });
}

test('_spiralInsertNew: splits the focused window, new window on the pointer\'s half', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self._bspTagGeometry(tree, AREA.x, AREA.y, AREA.w, AREA.h, 0);
  // b is 500x500: a side-by-side split; the pointer is in its left half.
  stubGlobal({ pointer: [600, 250], focus: b });
  const after = self._spiralInsertNew(WS, tree, c, AREA);
  assert.equal(after.second.direction, 'h');
  assert.equal(after.second.ratio, 0.5);
  assert.deepEqual([after.second.first.window, after.second.second.window], [c, b]);
});

test('_spiralInsertNew: the pointer on the slot centre keeps the classic spiral (new window second)', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b');
  const tree = leaf(a);
  self._bspTagGeometry(tree, AREA.x, AREA.y, AREA.w, AREA.h, 0);
  stubGlobal({ pointer: [500, 250], focus: a });
  const after = self._spiralInsertNew(WS, tree, b, AREA);
  assert.deepEqual([after.first.window, after.second.window], [a, b]);
});

test('_spiralInsertNew: without focus, the leaf closest to the pointer is split', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self._bspTagGeometry(tree, AREA.x, AREA.y, AREA.w, AREA.h, 0);
  stubGlobal({ pointer: [-50, 900] }); // off the tiling area, nearest a
  const after = self._spiralInsertNew(WS, tree, c, AREA);
  assert.equal(after.first.type, 'split');
  assert.deepEqual(self._bspCollectWindows(after.first), [c, a]); // pointer left of a's centre
});

test('_spiralDropTree: the side picks direction and order, always 50/50', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b'), z = W('z');
  const cases = { left: ['h', [z, b]], right: ['h', [b, z]], top: ['v', [z, b]], bottom: ['v', [b, z]] };
  for (const [side, [dir, order]] of Object.entries(cases)) {
    const tree = self._spiralDropTree(split('h', 0.5, leaf(a), leaf(b)), b, z, side);
    assert.equal(tree.second.direction, dir, side);
    assert.equal(tree.second.ratio, 0.5, side);
    assert.deepEqual([tree.second.first.window, tree.second.second.window], order, side);
  }
});

test('_spiralDropZone: picks target and triangle, and the landing rect of that drop', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b'), z = W('z');
  stubGlobal();
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const g = { win: z, workArea: WORK_AREA, tree, rects: self._bspSlotRects(self._bspClone(tree), WORK_AREA),
    zones: new Map() };
  const top = self._spiralDropZone(g, 750, 20);
  assert.equal(top.target, b);
  assert.equal(top.side, 'top');
  assert.deepEqual(top.rect, { x: 500, y: 0, w: 500, h: 250 });
  const left = self._spiralDropZone(g, 520, 250);
  assert.equal(left.side, 'left');
  assert.deepEqual(left.rect, { x: 500, y: 0, w: 250, h: 500 });
});

test('_spiralAtHome: the whole slot until the pointer leaves it, then only its core', () => {
  const self = spiralSelf();
  const g = { home: { x: 0, y: 0, w: 500, h: 500 }, workArea: WORK_AREA, atHome: null };
  assert.equal(self._spiralAtHome(g, 20, 20), true);
  g.leftHome = true;
  assert.equal(self._spiralAtHome(g, 20, 20), false);
  assert.equal(self._spiralAtHome(g, 250, 250), true);
  // A pointer pushed past the screen edge next to the slot is still home.
  g.leftHome = false;
  assert.equal(self._spiralAtHome(g, -40, 250), true);
});
