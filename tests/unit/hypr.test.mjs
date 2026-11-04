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
    const a = win('a'), b = win('b');
    const self = groupSelf(layout);
    self._minSizeOverrides = new Map([['b', { w: 800, h: 0 }]]);
    self.monitors.getWindowsForGroup = () => [a, b];
    const tree = split('h', 0.7, leaf(a), leaf(b));
    self.bsp.bspTagGeometry(tree, 0, 0, 1000, 500, 0);
    self.bsp.bspGetTree = () => tree;
    assert.equal(self.grab.windowSlotRect(b, WS, layout, WA, 0).w, w, layout);
  }
});

test('bspSlotRects: a Spiral drag ghost\'s slots ignore minimums', () => {
  for (const layout of ['spiral', 'dwindle']) {
    const a = win('a'), b = win('b');
    const self = groupSelf(layout);
    self._minSizeOverrides = new Map([['b', { w: 800, h: 0 }]]);
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

// Y2: an oversized tile overlaps its neighbours, inside its work area.

test('tileRect: a Spiral tile is grown to its client minimum; nothing else is', () => {
  const r = { x: 500, y: 0, w: 500, h: 250 };
  const spiral = groupSelf('spiral');
  const wl = win('w', { minSize: [790, 300], frameDelta: [10, 0] });
  assert.deepEqual(spiral.bsp.tileRect(wl, r, WS, 0), { x: 200, y: 0, w: 800, h: 300 }, 'centred, kept in the work area');
  assert.equal(spiral.bsp.tileRect(win('f', { minSize: [400, 200] }), r, WS, 0), r, 'fits: the slot');
  assert.equal(spiral.bsp.tileRect(win('n'), r, WS, 0), r, 'no hint');
  assert.deepEqual(spiral.bsp.tileRect(win('x', { minSize: [780, 280], frameDelta: [20, 20], clientType: 1 }), r, WS, 0),
    { x: 200, y: 0, w: 800, h: 300 }, 'X11, its titlebar included');
  spiral._minSizeOverrides = new Map([['o', { w: 900, h: 0 }]]);
  const learned = win('l');
  spiral._observedMinSizes.set(learned, { w: 900, h: 0 });
  assert.equal(spiral.bsp.tileRect(win('o'), r, WS, 0), r, 'a min-window-sizes rule');
  assert.equal(spiral.bsp.tileRect(learned, r, WS, 0), r, 'a learned minimum');
  assert.equal(groupSelf('dwindle').bsp.tileRect(wl, r, WS, 0), r, 'dwindle');
});

test('windowSlotRect and bspSlotRects: an oversized Spiral tile is its slot grown in the work area, the split keeps its ratio', () => {
  const a = win('a'), b = win('b', { minSize: [800, 0] });
  const self = groupSelf('spiral');
  self.monitors.getWindowsForGroup = () => [a, b];
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self.bsp.bspTagGeometry(tree, 0, 0, 1000, 500, 0);
  self.bsp.bspGetTree = () => tree;
  assert.deepEqual(self.grab.windowSlotRect(b, WS, 'spiral', WA, 0), { x: 200, y: 0, w: 800, h: 500 });
  const rects = self.bsp.bspSlotRects(split('h', 0.5, leaf(a), leaf(b)), WA, WS, 0);
  assert.deepEqual(rects.get(b), { x: 200, y: 0, w: 800, h: 500 });
  assert.deepEqual(rects.get(a), { x: 0, y: 0, w: 500, h: 500 });
  const lone = self.bsp.bspSlotRects(leaf(win('c', { minSize: [1200, 0] })), WA, WS, 0);
  assert.deepEqual([...lone.values()], [{ x: 0, y: 0, w: 1200, h: 500 }], 'a lone tile too');
});

test('tileRect: centred on its slot inside the work area, clamped at either edge; no work area, the slot', () => {
  const self = groupSelf('spiral');
  self.monitors.monitorWorkArea = () => ({ x: 100, y: 50, width: 3000, height: 1000 });
  const w = win('w', { minSize: [800, 600] });
  assert.deepEqual(self.bsp.tileRect(w, { x: 1000, y: 300, w: 500, h: 400 }, WS, 0), { x: 850, y: 200, w: 800, h: 600 });
  assert.deepEqual(self.bsp.tileRect(w, { x: 120, y: 60, w: 500, h: 400 }, WS, 0), { x: 100, y: 50, w: 800, h: 600 });
  assert.deepEqual(self.bsp.tileRect(w, { x: 2600, y: 650, w: 500, h: 400 }, WS, 0), { x: 2300, y: 450, w: 800, h: 600 });
  const big = win('b', { minSize: [3500, 0] });
  assert.equal(self.bsp.tileRect(big, { x: 1000, y: 300, w: 500, h: 400 }, WS, 0).x, 100, 'wider than the area: its left edge');
  self.monitors.monitorWorkArea = () => null;
  const r = { x: 1000, y: 300, w: 500, h: 400 };
  assert.equal(self.bsp.tileRect(w, r, WS, 0), r);
});

test('lone tile: the slot, the drag ghost, an empty monitor\'s drop and the retile agree; the settle poll sees it in its slot', () => {
  const lone = { x: 0, y: 0, w: 1200, h: 500 };
  const self = groupSelf('spiral');
  const w = win('w', { minSize: [1200, 0], frame: { x: 0, y: 0, width: 1200, height: 500 } });
  self.monitors.getWindowsForGroup = () => [w];
  self.monitors.monitorWorkArea = () => WA;
  assert.deepEqual(self.grab.windowSlotRect(w, WS, 'spiral', WA, 0), lone, 'windowSlotRect');
  assert.deepEqual(self.bsp.bspSlotRects(leaf(w), WA, WS, 0).get(w), lone, 'bspSlotRects');
  self.monitors.getWindowsForGroup = () => [];
  const prev = globalThis.global.display;
  globalThis.global.display = { ...prev, get_monitor_geometry: () => ({ x: 0, y: 0, width: 1000, height: 500 }) };
  try {
    assert.deepEqual(self.dragPreview.crossDropPlan(w, WS, 0, 500, 250).rect, lone, 'crossDropPlan');
  } finally {
    globalThis.global.display = prev;
  }
  self.monitors.getWindowsForGroup = () => [w];
  const moved = [];
  self.windows.moveWindow = (_w, ...r) => moved.push(r);
  self.layouts.retileDwindle(WS, [w], 0);
  assert.deepEqual(moved, [[0, 0, 1200, 500]], 'retile');
  assert.equal(self.placement.settledInSlot(w), true, 'settled');
  assert.equal(groupSelf('dwindle').bsp.loneTileRect(w, WA, WS, 0).w, 1000, 'dwindle: the area');
});

test('tileRect: clamped into the tiling area, inside the outer gaps', () => {
  const self = groupSelf('spiral', { 'outside-gap-left': 10, 'outside-gap-right': 20, 'outside-gap-top': 30, 'outside-gap-bottom': 40 });
  const w = win('w', { minSize: [600, 450] });
  // tiling area 10,30 970x430: right and bottom edges at 980 / 460
  assert.deepEqual(self.bsp.tileRect(w, { x: 700, y: 30, w: 280, h: 300 }, WS, 0), { x: 380, y: 30, w: 600, h: 450 });
  assert.deepEqual(self.bsp.tileRect(w, { x: 10, y: 200, w: 280, h: 260 }, WS, 0), { x: 10, y: 30, w: 600, h: 450 });
});

test('tileRect: an oversized tile at a monitor edge stays on its monitor, so its group keeps it', () => {
  const self = groupSelf('spiral');
  const prev = globalThis.global.display;
  globalThis.global.display = { ...prev, get_n_monitors: () => 2,
    get_monitor_geometry: (i) => ({ x: i * 2560, y: 0, width: 2560, height: 1440 }) };
  try {
    self.monitors.nMonitors = () => 2;
    self.monitors.monitorWorkArea = () => ({ x: 0, y: 32, width: 2560, height: 1408 });
    const bm = win('bm', { minSize: [1000, 0] });
    const r = self.bsp.tileRect(bm, { x: 2082, y: 36, w: 474, h: 1400 }, WS, 0);
    assert.ok(r.x >= 0 && r.x + r.w <= 2560, `inside monitor 0: ${JSON.stringify(r)}`);
    assert.equal(self.monitors.monitorAt(r.x + r.w / 2, r.y + r.h / 2), 0);
    assert.equal(self.monitors.monitorAt(r.x + r.w - 1, r.y), 0, 'no part on monitor 1');
  } finally {
    globalThis.global.display = prev;
  }
});

test('animRetile: an oversized Spiral tile is configured and drawn at its grown rect, dwindle at its slot', () => {
  for (const [layout, want] of [['spiral', [200, 0, 800, 500]], ['dwindle', [500, 0, 500, 500]]]) {
    const self = groupSelf(layout);
    self.placement.getAnimationTime = () => 0.1;
    self.placement.verifyAnimationLanding = () => true;
    self.layouts.retileDwindle = (_ws, tiled) => self._animTargets.set(tiled[0], { x: 500, y: 0, w: 500, h: 500 });
    self.signals.scheduleRetile = () => {};
    self.signals.scheduleBorders = () => {};
    self.persistence.scheduleSaveLayouts = () => {};
    self.transforms.ensureTimeline = () => {};
    self.monitors.recordTick = () => {};
    const b = win('b', { minSize: [800, 0], frame: { x: 0, y: 0, width: 800, height: 500 } });
    const sent = [];
    b.get_compositor_private = () => ({ set_scale() {}, set_translation() {}, set_pivot_point() {}, remove_all_transitions() {}, set_opacity() {} });
    b.connectObject = () => {};
    b.move_resize_frame = (_u, ...r) => sent.push(r);
    let target = null;
    self.transforms.run = (states) => { target = states[0]; self.transforms.configure(states[0]); };
    self.placement.animRetile(WS, [{ mon: 0, tiled: [b], layout, places: true }]);
    if (layout === 'spiral') {
      assert.deepEqual([target.targetX, target.targetY, target.targetW, target.targetH], want);
      assert.deepEqual(sent[0], want);
    } else {
      assert.equal(target, null, 'dwindle ticks, not driven');
      const s = self._animStates[0];
      assert.deepEqual([s.targetX, s.targetY, s.targetW, s.targetH], want);
    }
  }
});

test('spiralLiveResize: an oversized neighbour is sent its slot grown in the work area, and drawn there', () => {
  const a = win('a', { frame: { x: 0, y: 0, width: 600, height: 500 } });
  const b = win('b', { minSize: [700, 0], frame: { x: 500, y: 0, width: 700, height: 500 } });
  const self = groupSelf('spiral');
  const tree = split('h', 0.6, leaf(a), leaf(b));
  self.bsp.bspTagGeometry(tree, 0, 0, 1000, 500, 0);
  self.bsp.bspGetTree = () => tree;
  const sent = [];
  const drawn = [];
  b.move_resize_frame = (_u, ...r) => sent.push(r);
  self.transforms.stretchActorToSlot = (w, slot) => drawn.push([w, slot]);
  self.grab.spiralLiveResize(a);
  assert.deepEqual(sent, [[300, 0, 700, 500]]);
  assert.deepEqual(drawn.find(([w]) => w === b)[1], { x: 300, y: 0, w: 700, h: 500 });
});
