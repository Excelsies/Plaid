import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Spiral drag (spiral.js): ghost, zones, home, drop, reflow.

let clock = 0;
GLib.get_monotonic_time = () => clock;
const WORK_AREA = { x: 0, y: 0, width: 1000, height: 500 };
const WS = {};

function actorOf() {
  return {
    scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, eased: [], pivot: [0, 0],
    set_scale(x, y) { this.scale_x = x; this.scale_y = y; },
    set_translation(x, y) { this.translation_x = x; this.translation_y = y; },
    set_pivot_point(x, y) { this.pivot = [x, y]; },
    get_pivot_point() { return this.pivot; },
    opacity: 255,
    set_opacity(v) { this.opacity = v; },
    remove_all_transitions() {},
    ease(p) { this.eased.push(p); },
  };
}

function W(id, frame = { x: 0, y: 0, width: 100, height: 100 }) {
  const w = fakeWin({ id, instance: id });
  const actor = actorOf();
  Object.assign(w, {
    _frame: { ...frame }, _actor: actor,
    get_id: () => id,
    get_workspace: () => WS,
    get_frame_rect: () => ({ ...w._frame }),
    get_buffer_rect: () => ({ ...w._frame }),
    get_compositor_private: () => w._actor,
    connectObject() {},
    disconnectObject() {},
    move_resize_frame: (_u, x, y, width, height) => { w._frame = { x, y, width, height }; },
  });
  return w;
}

function withGlobal(pointer, fn) {
  const old = globalThis.global;
  globalThis.global = {
    ...old,
    get_pointer: () => [...pointer, 0],
    display: { ...old.display, get_primary_monitor: () => 0,
      get_monitor_geometry: () => ({ x: 0, y: 0, width: 1000, height: 500 }) },
  };
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

function dragSelf(tree, wins) {
  clock = 0;
  const self = makeSelf({ 'inside-gap': 0, enabled: true });
  self.monitors.windowMon = () => 0;
  self.monitors.monitorWorkArea = () => WORK_AREA;
  self.monitors.getWindowsForGroup = () => wins;
  self.windows.getWorkspaceLayout = () => 'spiral';
  self.windows.isFloating = () => false;
  self.windows.isFullscreenTile = () => false;
  self.geometry.wsIndex = () => 1;
  self.bsp.bspSetTree(WS, 0, tree);
  self.transforms.ensureTimeline = () => {};
  self.monitors.recordTick = () => {};
  self.placement.getAnimationTime = () => 0.1;
  return self;
}

test('dropTree: the side picks direction and order, always 50/50', () => {
  const self = makeSelf();
  const a = W('a'), b = W('b'), z = W('z');
  const cases = { left: ['h', [z, b]], right: ['h', [b, z]], top: ['v', [z, b]], bottom: ['v', [b, z]] };
  for (const [side, [dir, order]] of Object.entries(cases)) {
    const tree = self.spiral.dropTree(split('h', 0.5, leaf(a), leaf(b)), b, z, side);
    assert.equal(tree.second.direction, dir, side);
    assert.equal(tree.second.ratio, 0.5, side);
    assert.deepEqual([tree.second.first.window, tree.second.second.window], order, side);
  }
});

test('dropZoneSide picks the triangle between the rect diagonals', () => {
  const self = makeSelf();
  const r = { x: 0, y: 0, w: 400, h: 100 };
  assert.equal(self.geometry.dropZoneSide(r, 380, 50), 'right');
  assert.equal(self.geometry.dropZoneSide(r, 20, 50), 'left');
  // A wide rect still has top/bottom zones around its centre.
  assert.equal(self.geometry.dropZoneSide(r, 200, 5), 'top');
  assert.equal(self.geometry.dropZoneSide(r, 200, 95), 'bottom');
  // On a diagonal the vertical side wins.
  assert.equal(self.geometry.dropZoneSide(r, 0, 0), 'top');
});

test('dropZone: target and triangle on the ghost, and the landing rect of that drop', () => withGlobal([0, 0], () => {
  const self = makeSelf({ 'inside-gap': 0 });
  const a = W('a'), b = W('b'), z = W('z');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const g = { win: z, workArea: WORK_AREA, tree, rects: self.bsp.bspSlotRects(self.bsp.bspClone(tree), WORK_AREA),
    zones: new Map() };
  const top = self.spiral.dropZone(g, 750, 20);
  assert.equal(top.target, b);
  assert.equal(top.side, 'top');
  assert.deepEqual(top.rect, { x: 500, y: 0, w: 500, h: 250 });
  const left = self.spiral.dropZone(g, 520, 250);
  assert.equal(left.side, 'left');
  assert.deepEqual(left.rect, { x: 500, y: 0, w: 250, h: 500 });
  // Over the top bar (above the work area): still b's top zone.
  assert.equal(self.spiral.dropZone({ ...g, workArea: { x: 0, y: 30, width: 1000, height: 470 } }, 750, 5).side, 'top');
}));

test('atHome: the whole slot until the pointer leaves it, then only its core; 12 px hysteresis', () => {
  const self = makeSelf();
  const g = { home: { x: 0, y: 0, w: 500, h: 500 }, workArea: WORK_AREA, atHome: null };
  assert.equal(self.spiral.atHome(g, 20, 20), true);
  g.leftHome = true;
  assert.equal(self.spiral.atHome(g, 20, 20), false);
  assert.equal(self.spiral.atHome(g, 250, 250), true);
  // A pointer pushed past the screen edge next to the slot is still home.
  g.leftHome = false;
  assert.equal(self.spiral.atHome(g, -40, 250), true);
  // Hysteresis: home stays home 12 px past the edge, away stays away 12 px in.
  g.atHome = true;
  assert.equal(self.spiral.atHome(g, 510, 250), true);
  g.atHome = false;
  assert.equal(self.spiral.atHome(g, 490, 250), false);
});

test('buildDragGhost: the others\' slots without the window, its home, the live slots', () => {
  const a = W('a'), b = W('b'), c = W('c');
  const self = dragSelf(split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c))), [a, b, c]);
  const g = self.spiral.buildDragGhost(a, WS);
  assert.deepEqual(g.home, { x: 0, y: 0, w: 500, h: 500 });
  assert.deepEqual(g.rects.get(b), { x: 0, y: 0, w: 1000, h: 250 });
  assert.equal(g.rects.has(a), false);
  assert.deepEqual(g.live.get(c), { x: 500, y: 250, w: 500, h: 250 });
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1, height: 1 });
  assert.equal(self.spiral.buildDragGhost(a, WS), null, 'no valid work area: no ghost');
});

test('updateDragPreview: away from home the others reflow to the ghost and the zone glides in; home shows the live layout', () => {
  const a = W('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', { x: 500, y: 0, width: 500, height: 250 });
  const c = W('c', { x: 500, y: 250, width: 500, height: 250 });
  const self = dragSelf(split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c))), [a, b, c]);
  const shown = [];
  self.dragPreview.showDropPreview = (...r) => shown.push(r);
  self.dragPreview.hideDropPreview = () => shown.push(null);
  withGlobal([750, 50], () => self.spiral.updateDragPreview(a, WS, 750, 50, true));
  assert.ok(self._dragGhost, 'ghost built');
  assert.equal(self._dragShrunk?.win, a, 'shrunk');
  assert.equal(a._actor.eased[0].scale_x, 0.85);
  assert.deepEqual(self._transformStates.get(b)?.targetY, 0);
  assert.deepEqual([self._transformStates.get(b).targetW, self._transformStates.get(b).targetH], [1000, 250]);
  assert.deepEqual(shown.at(-1), [0, 0, 1000, 125, true], 'b\'s top zone');
  // Two frames of the reflow: b is drawn on its way to the ghost slot.
  self.transforms.step();
  clock = 100 * 1000;
  self.transforms.step();
  withGlobal([250, 250], () => self.spiral.updateDragPreview(a, WS, 250, 250, true));
  assert.equal(self._dragGhost.atHome, true);
  assert.deepEqual(shown.at(-1), [0, 0, 500, 500, true], 'home');
  assert.equal(self._transformStates.get(b).targetX, 500);
});

test('drop: inserted into the ghost tree at the zone; home or no ghost leaves the tree', () => {
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)));
  const self = dragSelf(tree, [a, b, c]);
  withGlobal([0, 0], () => {
    assert.equal(self.spiral.drop(a, WS, 0, 250, 250), false, 'home');
    assert.equal(self.bsp.bspGetTree(WS, 0), tree);
    // The ghost the preview showed: b spans the top, its bottom zone.
    self._dragGhost = self.spiral.buildDragGhost(a, WS);
    self._dragGhost.leftHome = true;
    assert.equal(self.spiral.drop(a, WS, 0, 600, 240), true);
  });
  const t = self.bsp.bspGetTree(WS, 0);
  assert.equal(t.direction, 'v');
  assert.deepEqual([t.first.first.window, t.first.second.window, t.second.window], [b, a, c]);
});

test('refreshDragGhost and the retile hook: a window closed mid-drag leaves the ghost before the retile is deferred', () => {
  const a = W('a'), b = W('b'), c = W('c');
  const wins = [a, b, c];
  const self = dragSelf(split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c))), wins);
  self._dragGhost = self.spiral.buildDragGhost(a, WS);
  self._grabOp = 1;
  self.dragPreview.updateMoveDragPreview = () => {};
  wins.splice(2, 1);
  self.layouts.doRetileWorkspace(WS);
  assert.ok(self._retileAfterGrab.has(WS), 'deferred');
  assert.equal(self._dragGhost.rects.has(c), false);
  assert.deepEqual(self._dragGhost.rects.get(b), { x: 0, y: 0, w: 1000, h: 500 });
});

test('grab end: ghosts cleared, the shrunk window handed to the driver where it is drawn', () => {
  const a = W('a', { x: 0, y: 0, width: 400, height: 200 });
  const self = dragSelf(leaf(a), [a]);
  self.borders.startBorderAnimation = () => {};
  self._dragGhost = {};
  self._dropGhost = {};
  self._dragShrunk = { win: a, actor: a._actor, pivotX: 0.5, pivotY: 0 };
  a._actor.scale_x = a._actor.scale_y = 0.85;
  self.grab.handleGrabEnd(a, 1);
  assert.equal(self._dragGhost, null);
  assert.equal(self._dropGhost, null);
  assert.equal(self._dragShrunk, null);
  const s = self._transformStates.get(a);
  assert.deepEqual([s.startX, s.startY, s.startW, s.startH], [30, 0, 340, 170]);
  assert.equal(a._actor.scale_x, 0.85, 'still drawn shrunk');
});

test('reset (disable, shutdown): no ghost, the shrunk window at identity', () => {
  const a = W('a');
  const self = dragSelf(leaf(a), [a]);
  self._dragGhost = {};
  self._dragShrunk = { win: a, actor: a._actor, pivotX: 0, pivotY: 0 };
  a._actor.scale_x = 0.85;
  self.spiral.destroy();
  assert.equal(self._dragGhost, null);
  assert.equal(a._actor.scale_x, 1);
});

test('carry: the ghosts belong to the workspace being left', () => {
  const a = W('a');
  const self = dragSelf(leaf(a), [a]);
  self._dragGhost = {};
  self._dropGhost = {};
  const dest = {};
  self.bgApp.realNeighbor = () => dest;
  a.raise = () => {};
  self.dragPreview.hideDropPreview = () => {};
  self.dragScroll.warnShellShape = () => {};
  const moved = [];
  Main.wm.actionMoveWindow = (w, ws) => moved.push([w, ws]);
  try {
    self.dragScroll.carry(a, 1);
  } finally {
    delete Main.wm.actionMoveWindow;
  }
  assert.deepEqual(moved, [[a, dest]]);
  assert.equal(self._dragGhost, null);
  assert.equal(self._dropGhost, null);
});

test('drop: a ghost of another group or window is not reused; no tree, no drop', () => {
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)));
  const self = dragSelf(tree, [a, b, c]);
  withGlobal([0, 0], () => {
    // A ghost built for monitor 1 (stale after a hotplug): the drop builds its own.
    self._dragGhost = { ...self.spiral.buildDragGhost(a, WS), mon: 1, home: null, tree: leaf(c),
      rects: new Map([[c, { x: 0, y: 0, w: 1000, h: 500 }]]) };
    assert.equal(self.spiral.drop(a, WS, 0, 600, 240), true);
    assert.deepEqual(self.bsp.bspCollectWindows(self.bsp.bspGetTree(WS, 0)), [b, a, c]);
    self.bsp.bspSetTree(WS, 0, null);
    self._dragGhost = null;
    assert.equal(self.spiral.drop(a, WS, 0, 600, 240), false, 'no tree');
  });
});

test('showDragLayout: another group\'s tick run and deferred new windows keep going; the group\'s own run lands', () => {
  const a = W('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', { x: 500, y: 0, width: 500, height: 500 });
  const self = dragSelf(split('h', 0.5, leaf(a), leaf(b)), [a, b]);
  const landed = [];
  self.transforms.run([{ win: b, startX: 500, startY: 0, startW: 500, startH: 500,
    targetX: 600, targetY: 0, targetW: 400, targetH: 500 }], s => landed.push(s.win));
  self._animating = true;
  self._animTickId = 42;
  const gen = self._animGen;
  let cancelled = 0;
  self.placement.cancelAnimation = () => { cancelled++; };
  const g = self.spiral.buildDragGhost(a, WS);
  self.spiral.showDragLayout(g, false);
  assert.equal(cancelled, 0);
  assert.equal(self._animTickId, 42);
  assert.equal(self._animGen, gen);
  assert.deepEqual(landed, [b], 'b leaves its run as landed');
  assert.equal(self._transformStates.get(b).targetW, 1000, 'reflowing to the ghost');
});

test('showDragLayout: a window opened mid-drag pops in at its ghost slot', () => {
  const a = W('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', { x: 500, y: 0, width: 500, height: 500 });
  const n = W('n', { x: 300, y: 100, width: 400, height: 300 });
  const self = dragSelf(split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(n))), [a, b, n]);
  self._newWindowSet.add(n);
  self._pendingWarp.add(n);
  self.spiral.showDragLayout(self.spiral.buildDragGhost(a, WS), false);
  const s = self._transformStates.get(n);
  assert.equal(s.popin, true);
  assert.equal(self._newWindowSet.has(n), false);
  assert.equal(self._pendingWarp.has(n), false, 'revealed');
  assert.equal(n._actor.opacity, 0, 'fading in');
});

test('showDragLayout: a window opened mid-drag whose maximum is below its box floats, as at any open', () => {
  const a = W('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', { x: 500, y: 0, width: 500, height: 500 });
  const n = W('n', { x: 300, y: 100, width: 300, height: 200 });
  n.get_max_size = () => [true, 300, 200];
  const self = dragSelf(split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(n))), [a, b, n]);
  self._newWindowSet.add(n);
  n._plaidOpenBox = { w: 500, h: 500 };
  let retiled = 0;
  self.layouts.retileWorkspace = () => retiled++;
  self.monitors.removeFromGroupTree = () => {};
  self.spiral.showDragLayout(self.spiral.buildDragGhost(a, WS), false);
  assert.equal(self._toggleFloatWindows.has(n), true);
  assert.equal(self._transformStates.has(n), false, 'not popped in');
  assert.equal(self._newWindowSet.has(n), false);
  assert.equal(n._plaidOpenBox, null);
  assert.equal(n._actor.opacity, 255, 'shown');
  assert.equal(retiled, 1, 'the ghost is rebuilt without it');
});

test('shrinkDraggedWindow: once per drag', () => {
  const a = W('a', { x: 0, y: 0, width: 400, height: 200 });
  const self = dragSelf(leaf(a), [a]);
  withGlobal([200, 20], () => {
    self.spiral.shrinkDraggedWindow(a);
    self.spiral.shrinkDraggedWindow(a);
  });
  assert.equal(a._actor.eased.length, 1);
  assert.deepEqual(a._actor.pivot, [0.5, 0.1]);
});

test('unshrink: with a CSD shadow the drawn frame is carried exactly', () => {
  const a = W('a', { x: 100, y: 50, width: 400, height: 200 });
  a.get_buffer_rect = () => ({ x: 90, y: 38, width: 420, height: 224 });
  const self = dragSelf(leaf(a), [a]);
  self._dragShrunk = { win: a, actor: a._actor, pivotX: 0.2, pivotY: 0.1 };
  a._actor.scale_x = a._actor.scale_y = 0.85;
  self.spiral.unshrinkDraggedWindow();
  const s = self._transformStates.get(a);
  // The pivot is a point of the buffer: (90 + 84, 38 + 22.4).
  const ox = 174, oy = 60.4;
  const want = [ox + (100 - ox) * 0.85, oy + (50 - oy) * 0.85, 340, 170];
  [s.startX, s.startY, s.startW, s.startH].forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-6, `${i}: ${v}`));
});

test('shutdown: the Spiral drag state is reset', () => {
  const a = W('a');
  const self = dragSelf(leaf(a), [a]);
  let reset = 0;
  self.spiral.reset = () => { reset++; };
  self.borders.stopBorderAnimation = () => {};
  self.signals.onShellShutdown();
  assert.equal(reset, 1);
});

test('updateDragPreview: a ghost of another monitor\'s group is rebuilt for the window\'s own', () => {
  const a = W('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', { x: 500, y: 0, width: 500, height: 500 });
  const self = dragSelf(split('h', 0.5, leaf(a), leaf(b)), [a, b]);
  self.dragPreview.showDropPreview = () => {};
  self.dragPreview.hideDropPreview = () => {};
  self._dragGhost = { ws: WS, mon: 1, win: a, atHome: null };
  withGlobal([750, 50], () => self.spiral.updateDragPreview(a, WS, 750, 50, true));
  assert.equal(self._dragGhost.mon, 0);
  assert.ok(self._dragGhost.rects.has(b));
});

test('leaveSource: a ghost of another monitor\'s group is rebuilt for the source group', () => {
  const a = W('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', { x: 500, y: 0, width: 500, height: 500 });
  const self = dragSelf(split('h', 0.5, leaf(a), leaf(b)), [a, b]);
  self._dragGhost = { ws: WS, mon: 1, win: a, atHome: null };
  withGlobal([0, 0], () => self.spiral.leaveSource(a, WS, 0));
  assert.equal(self._dragGhost.mon, 0);
  assert.equal(self._dragGhost.atHome, false);
});
