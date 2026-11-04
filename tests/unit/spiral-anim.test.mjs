import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import { makeSelf, fakeWin } from '../helpers.mjs';

// Spiral retiles through the transform driver (placement.animRetile).

let clock = 0;
GLib.get_monotonic_time = () => clock;

function actorOf() {
  return {
    scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, opacity: 255, visible: false,
    set_scale(x, y) { this.scale_x = x; this.scale_y = y; },
    set_translation(x, y) { this.translation_x = x; this.translation_y = y; },
    set_opacity(v) { this.opacity = v; },
    set_pivot_point() {},
    remove_all_transitions() {},
  };
}

function win(ws, id, frame) {
  const w = fakeWin({ id, instance: `w${id}` });
  const actor = actorOf();
  Object.assign(w, {
    _frame: { ...frame }, _configs: 0,
    get_id: () => id,
    get_workspace: () => ws,
    get_frame_rect: () => ({ ...w._frame }),
    get_buffer_rect: () => ({ ...w._frame }),
    get_compositor_private: () => actor,
    connectObject() {},
    disconnectObject() {},
    move_resize_frame: (_u, x, y, width, height) => { w._configs++; w._frame = { x, y, width, height }; },
  });
  w._actor = actor;
  return w;
}

// Every window's slot is targets.get(win).
function runSelf(targets) {
  const ticks = [];
  const self = makeSelf({ 'inside-gap': 0, enabled: true });
  self.placement.getAnimationTime = () => 0.1;
  self.placement.verifyAnimationLanding = () => true;
  self.placement.armSettlePoll = () => {};
  self.layouts.retileDwindle = (_ws, tiled) => {
    for (const w of tiled) self._animTargets.set(w, targets.get(w));
  };
  self.layouts.retileMasterStack = self.layouts.retileDwindle;
  self.signals.scheduleRetile = () => {};
  self.signals.scheduleBorders = () => {};
  self.persistence.scheduleSaveLayouts = () => {};
  self.geometry.wsIndex = () => 1;
  self.transforms.ensureTimeline = () => {};
  self.monitors.recordTick = () => {};
  return { self, ticks };
}

function withTicks(ticks, fn) {
  const orig = GLib.timeout_add;
  GLib.timeout_add = (_p, _ms, cb) => { ticks.push(cb); return ticks.length; };
  try {
    return fn();
  } finally {
    GLib.timeout_add = orig;
  }
}

const spiral = (tiled) => [{ mon: 0, tiled, layout: 'spiral', places: true }];

test('animRetile: a Spiral group is configured once per window and drawn by the driver, no tick', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 });
  const b = win(ws, 2, { x: 500, y: 0, width: 500, height: 500 });
  const targets = new Map([[a, { x: 0, y: 0, w: 300, h: 500 }], [b, { x: 300, y: 0, w: 700, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  withTicks(ticks, () => self.placement.animRetile(ws, spiral([a, b])));
  self.transforms.step(); // the first frame
  assert.equal(ticks.length, 0);
  assert.deepEqual([a._configs, b._configs], [1, 1]);
  assert.equal(self._transformStates.size, 2);
  assert.equal(self._animTransformRun, true);
  assert.equal(self._animating, true);
  // Landed at the end of the ease: the run is done.
  clock = 400 * 1000;
  self.transforms.step();
  assert.equal(self._animating, false);
  assert.equal(self._transformStates.size, 0);
});

test('animRetile: a retile mid-run retargets from each drawn rect; the retired run lands nothing', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 });
  const targets = new Map([[a, { x: 200, y: 0, w: 500, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  const landed = [];
  const run = self.transforms.run.bind(self.transforms);
  self.transforms.run = (states, cb, carry) => { landed.push(cb); run(states, cb, carry); };
  let verified = 0;
  self.placement.verifyAnimationLanding = () => { verified++; return true; };
  withTicks(ticks, () => self.placement.animRetile(ws, spiral([a])));
  const gen = self._animGen;
  clock = 100 * 1000;
  const drawn = self.transforms.visual(self._transformStates.get(a), clock);
  targets.set(a, { x: 600, y: 0, w: 500, h: 500 });
  withTicks(ticks, () => self.placement.animRetile(ws, spiral([a])));
  assert.equal(self._animGen, gen + 1, 'not queued behind it');
  assert.equal(self._queuedAnimWorkspaces.size, 0);
  const s = self._transformStates.get(a);
  assert.deepEqual([s.startX, s.startY, s.startW, s.startH], drawn);
  assert.equal(s.targetX, 600);
  // The first run's landed callback, late: nothing happens.
  landed[0]({ win: a, popin: false });
  assert.equal(verified, 0);
  assert.equal(self._animating, true);
});

test('animRetile: a new Spiral window pops in revealed, the cursor already at its slot', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 1000, height: 500 });
  const n = win(ws, 2, { x: 300, y: 100, width: 400, height: 300 });
  const targets = new Map([[a, { x: 0, y: 0, w: 500, h: 500 }], [n, { x: 500, y: 0, w: 500, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  self._newWindowSet.add(n);
  self._pendingWarp.add(n);
  const warps = [];
  self.windows.moveCursorToWindow = (w, r) => warps.push([w, r]);
  withTicks(ticks, () => self.placement.animRetile(ws, spiral([a, n])));
  const s = self._transformStates.get(n);
  assert.equal(s.popin, true);
  assert.equal(n._actor.visible, true);
  assert.equal(n._actor.opacity, 0, 'fading in from 0');
  assert.equal(self._pendingWarp.has(n), false);
  assert.equal(self._newWindowSet.has(n), false);
  assert.deepEqual(warps, [[n, { x: 500, y: 0, width: 500, height: 500 }]]);
});

test('animRetile: dwindle and Spiral groups of one workspace run side by side', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 });
  const c = win(ws, 3, { x: 1000, y: 0, width: 500, height: 500 });
  const targets = new Map([[a, { x: 0, y: 0, w: 300, h: 500 }], [c, { x: 1000, y: 0, w: 300, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  withTicks(ticks, () => self.placement.animRetile(ws, [
    { mon: 0, tiled: [a], layout: 'dwindle', places: true },
    { mon: 1, tiled: [c], layout: 'spiral', places: true }]));
  assert.equal(ticks.length, 1, 'a tick run for dwindle');
  assert.deepEqual([...self._transformStates.keys()], [c]);
});

test('animRetile: a non-Spiral retile drops the transforms of its workspace', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 });
  const targets = new Map([[a, { x: 200, y: 0, w: 500, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  withTicks(ticks, () => self.placement.animRetile(ws, spiral([a])));
  self._animating = false;
  withTicks(ticks, () => self.placement.animRetile(ws, [{ mon: 0, tiled: [a], layout: 'dwindle', places: true }]));
  assert.equal(self._transformStates.size, 0);
  assert.equal(a._actor.translation_x, 0);
});

test('maybeReassertSlot: a window the driver holds is left to it', () => {
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 });
  const { self } = runSelf(new Map());
  self._windowWorkspaces.set(a, ws);
  self._transformStates.set(a, {});
  let asked = false;
  self.monitors.windowMon = () => { asked = true; return 0; };
  a.is_fullscreen = () => false;
  self.grab.maybeReassertSlot(a, 4, 'direct');
  assert.equal(asked, false);
});

test('animRetile: a window of a transform run that lands is progress for the watchdog', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 });
  const b = win(ws, 2, { x: 500, y: 0, width: 500, height: 500 });
  const targets = new Map([[a, { x: 0, y: 0, w: 300, h: 500 }], [b, { x: 300, y: 0, w: 700, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  withTicks(ticks, () => self.placement.animRetile(ws, spiral([a, b])));
  self._animProgressAt = 0;
  self.transforms.release(a);
  assert.ok(self._animProgressAt > 0);
  assert.equal(self._animating, true);
});

test('animRetile: a dwindle new window still being placed keeps the run: a second retile queues', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 1000, y: 0, width: 500, height: 500 });
  const d = win(ws, 4, { x: 300, y: 100, width: 400, height: 300 });
  let hidden = 0;
  const set = d._actor.set_opacity.bind(d._actor);
  d._actor.set_opacity = (v) => { if (v === 0) hidden++; set(v); };
  const targets = new Map([[a, { x: 1200, y: 0, w: 500, h: 500 }], [d, { x: 0, y: 0, w: 1000, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  self._newWindowSet.add(d);
  const groups = [{ mon: 0, tiled: [d], layout: 'dwindle', places: true },
    { mon: 1, tiled: [a], layout: 'spiral', places: true }];
  withTicks(ticks, () => self.placement.animRetile(ws, groups));
  assert.equal(self._animTickLeft, 1, 'd is placed by the run');
  assert.equal(hidden, 1);
  withTicks(ticks, () => self.placement.animRetile(ws, groups));
  assert.equal(self._queuedAnimWorkspaces.size, 1);
  assert.equal(hidden, 1, 'd is not hidden again');
});

test('animRetile: once another group\'s windows are placed, a Spiral retile retargets again', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 1000, y: 0, width: 500, height: 500 });
  const d = win(ws, 4, { x: 0, y: 0, width: 400, height: 300 });
  const targets = new Map([[a, { x: 1200, y: 0, w: 500, h: 500 }], [d, { x: 0, y: 0, w: 1000, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  const groups = [{ mon: 0, tiled: [d], layout: 'dwindle', places: true },
    { mon: 1, tiled: [a], layout: 'spiral', places: true }];
  withTicks(ticks, () => self.placement.animRetile(ws, groups));
  assert.equal(self._animTickLeft, 1);
  self._animStartTime = 0;
  withTicks(ticks, () => ticks.at(-1)()); // d's tick run ends
  assert.equal(self._animTickLeft, 0);
  const gen = self._animGen;
  withTicks(ticks, () => self.placement.animRetile(ws, groups));
  assert.equal(self._animGen, gen + 1, 'retargeted, not queued');
});

test('watchdog: with no stalled workspace known, no other run is stopped', () => {
  clock = 0;
  const ws = {}, other = {};
  const a = win(other, 1, { x: 0, y: 0, width: 500, height: 500 });
  const b = win(ws, 2, { x: 0, y: 0, width: 500, height: 500 });
  const targets = new Map([[a, { x: 200, y: 0, w: 500, h: 500 }], [b, { x: 300, y: 0, w: 500, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  withTicks(ticks, () => self.placement.animRetile(other, spiral([a])));
  // Stalled, its workspace forgotten (removed meanwhile).
  self._animWorkspace = null;
  self._animProgressAt = 0;
  withTicks(ticks, () => self.placement.animRetile(ws, [{ mon: 0, tiled: [b], layout: 'dwindle', places: true }]));
  assert.ok(self._transformStates.has(a), 'another workspace\'s run left alone');
});

test('decTick: a window gone during the tick run and a run of new windows only both finish it', () => {
  clock = 0;
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 });
  const b = win(ws, 2, { x: 500, y: 0, width: 500, height: 500 });
  const targets = new Map([[a, { x: 0, y: 0, w: 300, h: 500 }], [b, { x: 300, y: 0, w: 700, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  const dwindle = [{ mon: 0, tiled: [a, b], layout: 'dwindle', places: true }];
  withTicks(ticks, () => self.placement.animRetile(ws, dwindle));
  assert.equal(self._animTickLeft, 2);
  b.get_compositor_private = () => null; // closed mid-run
  self._animStartTime = 0;
  withTicks(ticks, () => ticks.at(-1)());
  assert.equal(self._animTickLeft, 0);
  assert.equal(self._animating, false);
  // New windows only: no tick, each placed (or gone) counts down.
  const n = win(ws, 3, { x: 0, y: 0, width: 100, height: 100 });
  targets.set(n, { x: 0, y: 0, w: 500, h: 500 });
  self._newWindowSet.add(n);
  withTicks(ticks, () => self.placement.animRetile(ws, [{ mon: 0, tiled: [n], layout: 'dwindle', places: true }]));
  assert.equal(self._animTickLeft, 1, 'its deferred placement is pending');
  n.get_compositor_private = () => null; // closed before its placement
  withTicks(ticks, () => ticks.at(-1)());
  assert.equal(self._animTickLeft, 0);
  assert.equal(self._animating, false);
});

test('settledInSlot: no workspace, a gone monitor or no slot is not settled; a group that does not place is', () => {
  const self = makeSelf({ 'inside-gap': 0 });
  const ws = {};
  const w = fakeWin();
  w.get_workspace = () => ws;
  w.get_frame_rect = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  const slot = { x: 0, y: 0, w: 1000, h: 500 };
  self.monitors.windowMon = () => 0;
  self.monitors.groupPlaces = () => true;
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.windows.getWorkspaceLayout = () => 'dwindle';
  self.grab.windowSlotRect = () => slot;
  assert.equal(self.placement.settledInSlot(w), true, 'in its slot');
  w.get_workspace = () => null;
  assert.equal(self.placement.settledInSlot(w), false, 'no workspace');
  w.get_workspace = () => ws;
  self.monitors.windowMon = () => -1;
  assert.equal(self.placement.settledInSlot(w), false, 'its monitor is gone');
  self.monitors.windowMon = () => 0;
  self.grab.windowSlotRect = () => null;
  assert.equal(self.placement.settledInSlot(w), false, 'no slot');
  self.monitors.groupPlaces = () => false;
  assert.equal(self.placement.settledInSlot(w), true, 'a group that does not place');
});
