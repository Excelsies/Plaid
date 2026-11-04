import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Dwindle drop: the target is the slot under the clamped pointer or the
// closest one, the preview shows where the window lands, and every preview
// fades in and glides.

const WORK_AREA = { x: 0, y: 0, width: 1000, height: 500 };
const WS = {};
const W = (id) => Object.assign(fakeWin({ id, instance: id }), { get_id: () => id, get_workspace: () => WS });

function withGlobal(pointer, fn) {
  const old = globalThis.global;
  globalThis.global = {
    ...old,
    get_pointer: () => [...pointer, 0],
    display: { ...old.display, get_primary_monitor: () => 0, get_n_monitors: () => 1,
      get_monitor_geometry: () => ({ x: 0, y: 0, width: 1000, height: 500 }) },
  };
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

function preview() {
  return {
    visible: false, opacity: 255, style: '', eases: [], pos: null, size: null,
    ease(p) { this.eases.push(p); },
    remove_all_transitions() {},
    set_position(x, y) { this.pos = [x, y]; },
    set_size(w, h) { this.size = [w, h]; },
  };
}

// h0.6(A, v0.5(B, C)) on 1000x500, no gaps: A 600 wide, B over C.
function dropSelf(layout = 'dwindle', gap = 0, workArea = WORK_AREA) {
  const a = W('a'), b = W('b'), c = W('c');
  const self = makeSelf({ 'inside-gap': gap, 'dwindle-ratio': 0.5, enabled: true });
  self.monitors.windowMon = () => 0;
  self.monitors.monitorAt = () => 0;
  self.monitors.monitorTiled = () => true;
  self.monitors.groupPlaces = () => true;
  self.monitors.grabDropped = () => {};
  self.monitors.monitorWorkArea = () => workArea;
  self.monitors.getWindowsForGroup = () => [a, b, c];
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = () => false;
  self.persistence.scheduleSaveLayouts = () => {};
  self.bsp.bspSetTree(WS, 0, split('h', 0.6, leaf(a), split('v', 0.5, leaf(b), leaf(c))));
  self._dropPreview = preview();
  return { self, a, b, c };
}

test('dwindleDropPreview: the slot the window lands in, not the target leaf', () => withGlobal([0, 0], () => {
  const { self, a } = dropSelf();
  // Over C (600,250 400x250): A drops into C's slot once A is gone (the
  // whole bottom row), split along its longer side at C's split ratio.
  const { c } = { c: [...self.bsp.bspSlotRects(self.bsp.bspGetTree(WS, 0), WORK_AREA, WS, 0).keys()][2] };
  assert.deepEqual(self.bsp.bspSlotRects(self.bsp.bspGetTree(WS, 0), WORK_AREA, WS, 0).get(c), { x: 600, y: 250, w: 400, h: 250 });
  assert.deepEqual(self.dragPreview.dwindleDropPreview(a, WS, 800, 400, 0), { x: 500, y: 250, w: 500, h: 250 });
}));

test('dwindleDropPreview: over its own slot it is that slot', () => withGlobal([0, 0], () => {
  const { self, a } = dropSelf();
  assert.deepEqual(self.dragPreview.dwindleDropPreview(a, WS, 100, 100, 0), { x: 0, y: 0, w: 600, h: 500 });
}));

test('dwindleDropPreview: a pointer in a gap, the outside-gap strip or over the top bar still has a target', () => withGlobal([0, 0], () => {
  const wa = { x: 0, y: 32, width: 1000, height: 468 };
  const { self, a } = dropSelf('dwindle', 20, wa);
  // Over the top bar above B, and in the gap between A and B|C.
  assert.ok(self.dragPreview.dwindleDropPreview(a, WS, 800, 5, 0));
  assert.ok(self.dragPreview.dwindleDropPreview(a, WS, 600, 300, 0));
  assert.ok(self.dragPreview.dwindleDropPreview(a, WS, 999, 499, 0));
  // Off the monitor: no target.
  assert.equal(self.dragPreview.dwindleDropPreview(a, WS, 1500, 300, 0), null);
}));

test('dwindleDropPreview: computed once per drag, target and monitor; the ghost reset clears it', () => withGlobal([0, 0], () => {
  const { self, a } = dropSelf();
  let n = 0;
  const orig = self.bsp.bspSlotRects.bind(self.bsp);
  self.bsp.bspSlotRects = (...args) => { n++; return orig(...args); };
  self.dragPreview.dwindleDropPreview(a, WS, 800, 400, 0);
  const first = n;
  self.dragPreview.dwindleDropPreview(a, WS, 810, 410, 0);
  assert.equal(n, first);
  self.spiral.clearGhosts();
  assert.equal(self._dwindleDropCache, null);
  self.dragPreview.dwindleDropPreview(a, WS, 800, 400, 0);
  assert.equal(n, 2 * first);
}));

test('repositionWindow: a dwindle drop goes where the preview showed; its own slot changes nothing', () => {
  const { self, a } = dropSelf();
  const tree0 = self.bsp.bspGetTree(WS, 0);
  withGlobal([100, 100], () => self.windows.repositionWindow(a, WS));
  assert.equal(self.bsp.bspGetTree(WS, 0), tree0);
  const want = withGlobal([0, 0], () => self.dragPreview.dwindleDropPreview(a, WS, 605, 260, 0));
  self.spiral.clearGhosts();
  withGlobal([605, 260], () => self.windows.repositionWindow(a, WS));
  const after = self.bsp.bspGetTree(WS, 0);
  assert.notEqual(after, tree0);
  assert.deepEqual(self.bsp.bspSlotRects(self.bsp.bspClone(after), WORK_AREA, WS, 0).get(a), want);
});

test('repositionWindow: a drop over the top bar is not lost', () => {
  const wa = { x: 0, y: 32, width: 1000, height: 468 };
  const { self, a } = dropSelf('dwindle', 0, wa);
  const tree0 = self.bsp.bspGetTree(WS, 0);
  withGlobal([800, 5], () => self.windows.repositionWindow(a, WS));
  assert.notEqual(self.bsp.bspGetTree(WS, 0), tree0);
});

test('crossDropPlan: a dwindle group shows and makes the landing slot', () => withGlobal([0, 0], () => {
  const { self, a, b, c } = dropSelf();
  const d = W('d');
  self.monitors.getWindowsForGroup = () => [a, b, c];
  self.spiral.syncDragTree = () => {};
  const plan = self.dragPreview.crossDropPlan(d, WS, 0, 800, 400);
  assert.ok(plan.rect);
  assert.deepEqual(self.bsp.bspSlotRects(plan.tree(), WORK_AREA, WS, 0).get(d), plan.rect);
}));

test('updateMoveDragPreview: dwindle and master-stack previews fade in and glide', () => withGlobal([800, 400], () => {
  for (const layout of ['dwindle', 'master-stack']) {
    const { self, a } = dropSelf(layout);
    self.grab.movedPastGrace = () => true;
    self.dragScroll.active = () => false;
    self.layouts.computeMasterStackDropTarget = () => 1;
    self.layouts.getMasterRatio = () => 0.5;
    self.dragPreview.updateMoveDragPreview(a);
    const p = self._dropPreview;
    assert.equal(p.visible, true, layout);
    assert.equal(p.eases.at(-1).duration, 120, layout);
    assert.ok(self._dropPreviewTarget, layout);
  }
}));

test('a retile deferred by the grab drops the dwindle landings (the window set changed)', () => {
  const { self } = dropSelf();
  self._dwindleDropCache = { mon: 0, live: new Map(), landing: new Map() };
  self._grabOp = 1;
  self.geometry.wsIndex = () => 1;
  self.layouts.doRetileWorkspace(WS);
  assert.equal(self._dwindleDropCache, null);
  assert.equal(self._retileAfterGrab.has(WS), true);
});
