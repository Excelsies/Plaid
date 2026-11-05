import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

// Y3: a maximum below the open box floats a new window.

test('maxBelowOpenBox: strict < on either axis in frame units, 0 unbounded, read once, Spiral only', () => {
  const self = groupSelf('spiral');
  const check = (opts, box, spiral = true) => {
    const w = win('m', opts);
    w._plaidOpenBox = box;
    const r = self.bsp.maxBelowOpenBox(w, spiral);
    assert.equal(w._plaidOpenBox, null, 'the box is read once');
    return r;
  };
  const box = { w: 1000, h: 500 };
  assert.equal(check({ maxSize: [1000, 500] }, box), null, 'equal: tiles');
  assert.deepEqual(check({ maxSize: [999, 0] }, box), { max: { w: 999, h: 0 }, box });
  assert.deepEqual(check({ maxSize: [0, 499] }, box), { max: { w: 0, h: 499 }, box });
  assert.equal(check({ maxSize: [0, 0] }, box), null, '0x0: unbounded');
  assert.equal(check({ maxHint: [false, 10, 10] }, box), null, 'unset hint');
  assert.equal(check({ maxSize: [990, 490], frameDelta: [10, 10] }, box), null, 'frame units: 1000x500 tiles');
  assert.ok(check({ maxSize: [989, 490], frameDelta: [10, 10] }, box), 'frame units: 999 floats');
  assert.equal(check({ maxSize: [10, 10] }, null), null, 'no box: not a Spiral open');
  assert.equal(check({ maxSize: [10, 10] }, box, false), null, 'not a Spiral group');
});

// The monitor (Hyprland's box for a first window) is larger than the gapped tiling area.
const MONITOR = { x: 0, y: 0, width: 1040, height: 540 };

test('open box: a new Spiral window records the leaf it splits, before the split; the first one its monitor', () => {
  const self = groupSelf('spiral');
  globalThis.global = { ...globalThis.global, get_pointer: () => [100, 100, 0],
    display: { ...globalThis.global.display, focus_window: null, get_monitor_geometry: () => MONITOR } };
  const a = win('a'), b = win('b'), old = win('o');
  self._newWindowSet.add(a);
  self._newWindowSet.add(b);
  self.bsp.bspInsertForWorkspace(WS, a, 0);
  assert.deepEqual(a._plaidOpenBox, { w: 1040, h: 540 });
  self.bsp.bspInsertForWorkspace(WS, b, 0);
  assert.deepEqual(b._plaidOpenBox, { w: 1000, h: 500 });
  self.bsp.bspInsertForWorkspace(WS, old, 0);
  assert.equal(old._plaidOpenBox, undefined, 'not a new window');
  const dw = groupSelf('dwindle');
  const c = win('c');
  dw._newWindowSet.add(c);
  dw.bsp.bspInsertForWorkspace(WS, c, 0);
  assert.equal(c._plaidOpenBox, undefined, 'dwindle records none');
});

test('open box: syncTree records the pre-split leaf for a new window entering a Spiral tree', () => {
  const self = groupSelf('spiral');
  globalThis.global = { ...globalThis.global, get_pointer: () => [900, 100, 0],
    display: { ...globalThis.global.display, focus_window: null } };
  const a = win('a'), b = win('b'), c = win('c');
  self._newWindowSet.add(c);
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self.bsp.syncTree(WS, tree, [a, b, c], { x: 0, y: 0, w: 1000, h: 500 }, 0, 0);
  assert.deepEqual(c._plaidOpenBox, { w: 500, h: 500 });
});

test('open box: a new window entering an empty or missing Spiral tree records its monitor; dwindle none', () => {
  const prev = globalThis.global.display;
  globalThis.global.display = { ...prev, get_monitor_geometry: () => MONITOR };
  try {
    for (const tree of [{ type: 'empty' }, null]) {
      for (const [layout, box] of [['spiral', { w: 1040, h: 540 }], ['dwindle', undefined]]) {
        const self = groupSelf(layout);
        const a = win('a'), b = win('b');
        self._newWindowSet.add(a);
        self.bsp.syncTree(WS, tree, [a, b], { x: 0, y: 0, w: 1000, h: 500 }, 0, 0);
        assert.deepEqual(a._plaidOpenBox, box, `${layout} ${tree ? 'empty' : 'no'} tree`);
      }
    }
  } finally {
    globalThis.global.display = prev;
  }
});

test('open box: a first window on a non-primary monitor records that monitor, not the primary', () => {
  const prev = globalThis.global;
  globalThis.global = { ...prev, get_pointer: () => [3000, 100, 0],
    display: { ...prev.display, focus_window: null, get_primary_monitor: () => 0,
      get_monitor_geometry: (i) => (i === 1 ? { x: 2560, y: 0, width: 1920, height: 1080 } : { x: 0, y: 0, width: 2560, height: 1440 }) } };
  try {
    const self = groupSelf('spiral');
    const a = win('a');
    self._newWindowSet.add(a);
    self.bsp.bspInsertForWorkspace(WS, a, 1);
    assert.deepEqual(a._plaidOpenBox, { w: 1920, h: 1080 });
    const b = win('b');
    self._newWindowSet.add(b);
    self.bsp.recordFirstOpenBox(b, null);
    assert.deepEqual(b._plaidOpenBox, { w: 2560, h: 1440 }, 'no monitor named: the primary');
  } finally {
    globalThis.global = prev;
  }
});

test('disable drops every managed window\'s open box', () => {
  const self = groupSelf('spiral');
  const w = win('w');
  w.disconnectObject = () => {};
  w._plaidOpenBox = { w: 1, h: 1 };
  self._windowWorkspaces.set(w, WS);
  self.windows.destroy();
  assert.equal(w._plaidOpenBox, null);
});

function runSelf(layout) {
  const self = groupSelf(layout, { 'inside-gap': 0 });
  self.placement.getAnimationTime = () => 0.1;
  self.placement.verifyAnimationLanding = () => true;
  self.placement.armSettlePoll = () => {};
  self.placement.deferNewWindowPlacement = () => {};
  const laid = [];
  self.layouts.retileDwindle = (_ws, tiled) => {
    laid.push(...tiled);
    for (const w of tiled) self._animTargets.set(w, { x: 0, y: 0, w: 500, h: 500 });
  };
  self.signals.scheduleRetile = () => {};
  self.signals.scheduleBorders = () => {};
  self.signals.addTimeout = () => 0;
  self.persistence.scheduleSaveLayouts = () => {};
  self.transforms.run = () => {};
  self.transforms.stop = () => null;
  self.monitors.windowConn = () => 'c';
  return { self, laid };
}

function animWin(id, opts) {
  const w = win(id, opts);
  const actor = { opacity: 0, visible: false, set_opacity(v) { this.opacity = v; }, remove_all_transitions() {} };
  w.get_compositor_private = () => actor;
  w._actor = actor;
  return w;
}

test('animRetile: a new Spiral window whose maximum is below its box floats, shown, out of the layout', () => {
  for (const layout of ['spiral', 'dwindle']) {
    const { self, laid } = runSelf(layout);
    const a = animWin('a'), n = animWin('n', { maxSize: [400, 0] });
    self._newWindowSet.add(n);
    n._plaidOpenBox = { w: 1000, h: 500 };
    let removed = null;
    self.monitors.removeFromGroupTree = (w) => { removed = w; };
    self.placement.animRetile(WS, [{ mon: 0, tiled: [a, n], layout, places: true }]);
    const floated = layout === 'spiral';
    assert.equal(self._toggleFloatWindows.has(n), floated, layout);
    assert.equal(laid.includes(n), !floated, layout);
    assert.equal(removed, floated ? n : null, layout);
    assert.equal(n._plaidOpenBox, null, `${layout}: read once`);
    if (floated)
      assert.deepEqual([n._actor.visible, n._actor.opacity, self._newWindowSet.has(n)], [true, 255, false]);
  }
});

test('animRetile: the box is not re-checked after the first placement', () => {
  const { self } = runSelf('spiral');
  const n = animWin('n', { maxSize: [400, 0] });
  self._newWindowSet.add(n);
  n._plaidOpenBox = { w: 300, h: 500 };
  self.placement.animRetile(WS, [{ mon: 0, tiled: [n], layout: 'spiral', places: true }]);
  assert.equal(self._toggleFloatWindows.has(n), false);
  assert.equal(n._plaidOpenBox, null);
  self._animating = false;
  self._newWindowSet.add(n);
  n.get_max_size = () => [true, 100, 100];
  self.placement.animRetile(WS, [{ mon: 0, tiled: [n], layout: 'spiral', places: true }]);
  assert.equal(self._toggleFloatWindows.has(n), false, 'a max set after open stays tiled');
});

test('animRetile: a window placed already (not new) is never checked, whatever box it kept', () => {
  const { self, laid } = runSelf('spiral');
  const n = animWin('n', { maxSize: [400, 0] });
  n._plaidOpenBox = { w: 1000, h: 500 };
  self.placement.animRetile(WS, [{ mon: 0, tiled: [n], layout: 'spiral', places: true }]);
  assert.equal(self._toggleFloatWindows.has(n), false);
  assert.ok(laid.includes(n));
});

test('removeWindow drops the open box', () => {
  const self = groupSelf('spiral');
  const w = win('w');
  w._plaidOpenBox = { w: 1, h: 1 };
  self.monitors.windowConn = () => null;
  self.layouts.retileWorkspace = () => {};
  self.windows.removeWindow(w);
  assert.equal(w._plaidOpenBox, null);
});

// Y4 (and D6 for dwindle and master-stack): a mutter half tile on a tile is
// released to its slot.

function sideSelf(layout, { flags = 2, maximized = false } = {}) {
  const self = groupSelf(layout);
  const w = win('s', { maximized });
  const calls = [];
  w.get_maximize_flags = () => flags;
  w.unmaximize = () => calls.push('unmaximize');
  self._windowWorkspaces.set(w, WS);
  self.layouts.retileWorkspace = (ws) => calls.push(ws === WS ? 'retile' : 'retile?');
  return { self, w, calls };
}

test('releaseSideTile: a side tile is unmaximized and retiled in every tiling layout; a floating group keeps it', () => {
  for (const [layout, flags, want] of [
    ['spiral', 2, ['unmaximize', 'retile']], ['spiral', 1, ['unmaximize', 'retile']],
    ['dwindle', 2, ['unmaximize', 'retile']], ['dwindle', 1, ['unmaximize', 'retile']],
    ['master-stack', 2, ['unmaximize', 'retile']], ['centered-master-stack', 2, ['unmaximize', 'retile']],
    ['floating', 2, []]]) {
    const { self, w, calls } = sideSelf(layout, { flags });
    // As monitors.groupPlaces: a floating group places nothing.
    self.monitors.groupPlaces = () => layout !== 'floating';
    assert.equal(self.windows.releaseSideTile(w), want.length > 0, `${layout} flags ${flags}`);
    assert.deepEqual(calls, want, `${layout} flags ${flags}`);
  }
});

test('releaseSideTile: no release when maximized both ways, unflagged, grabbed, floating, fullscreen, unmanaged, not placing or disabled', () => {
  const cases = {
    maximized: ({ w }) => { w.get_maximize_flags = () => 3; w.is_maximized = () => true; },
    unflagged: ({ w }) => { w.get_maximize_flags = () => 0; },
    grab: ({ self }) => { self._grabOp = 1; },
    floating: ({ self }) => { self.windows.isFloating = () => true; },
    fullscreen: ({ w }) => { w.is_fullscreen = () => true; },
    unmanaged: ({ self, w }) => { self._windowWorkspaces.delete(w); },
    'not placing': ({ self }) => { self.monitors.groupPlaces = () => false; },
    'no monitor': ({ self }) => { self.monitors.windowMon = () => -1; },
    disabled: ({ self }) => { self._settings = { ...self._settings, get_boolean: () => false }; },
    'shutting down': ({ self }) => { self._shuttingDown = true; },
  };
  for (const [name, set] of Object.entries(cases)) {
    const ctx = sideSelf('spiral');
    set(ctx);
    assert.equal(ctx.self.windows.releaseSideTile(ctx.w), false, name);
    assert.deepEqual(ctx.calls, [], name);
  }
});

test('window signals: a size or position change releases a Spiral side tile', () => {
  for (const signal of ['size-changed', 'position-changed']) {
    const { self, w, calls } = sideSelf('spiral');
    const handlers = new Map();
    w.connectObject = (name, fn) => handlers.set(name, fn);
    w.get_compositor_private = () => null;
    self.borders.updateBorders = () => {};
    self.windows.trackFloatGeometry = () => {};
    self.grab.maybeReassertSlot = () => {};
    self.windows.connectWindowSignals(w);
    handlers.get(signal)();
    assert.deepEqual(calls, ['unmaximize', 'retile'], signal);
  }
});

// The enable pass gives a tile mutter tiled while Plaid was off its slot
// back, as it converts a maximized one.
test('static: enable releases a side tile beside convertMaximizedToGaps', () => {
  const core = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'modules', 'core.js'), 'utf8');
  assert.match(core, /this\.windows\.addWindow\(win, resumeLike\);\s*if \(!resumeLockCycle\) \{\s*this\.windows\.convertMaximizedToGaps\(win\);\s*this\.windows\.releaseSideTile\(win\);/);
});
