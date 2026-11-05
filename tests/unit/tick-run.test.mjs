import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import { makeSelf, fakeWin } from '../helpers.mjs';

// Tick runs (dwindle, master-stack): only moved rects are sent, a window at
// its slot gets nothing, a re-run starts where a slow client is heading, and
// a commit mid-animation re-checks its slot once the run is over.

function win(ws, id, frame, { lag = false } = {}) {
  const w = fakeWin({ id, instance: `w${id}` });
  Object.assign(w, {
    _frame: { ...frame }, _configs: [],
    get_id: () => id,
    get_workspace: () => ws,
    get_frame_rect: () => ({ ...w._frame }),
    get_compositor_private: () => ({ remove_all_transitions() {}, set_opacity() {} }),
    move_resize_frame: (_u, x, y, width, height) => {
      w._configs.push([x, y, width, height]);
      if (!lag) w._frame = { x, y, width, height };
    },
  });
  return w;
}

function runSelf(targets) {
  const ticks = [];
  const retiles = [];
  const self = makeSelf({ 'inside-gap': 0, enabled: true });
  self.placement.getAnimationTime = () => 0.1;
  self.placement.verifyAnimationLanding = () => true;
  self.layouts.retileDwindle = (_ws, tiled) => {
    for (const w of tiled) self._animTargets.set(w, targets.get(w));
  };
  self.signals.scheduleRetile = (ws) => retiles.push(ws);
  self.signals.scheduleBorders = () => {};
  self.persistence.scheduleSaveLayouts = () => {};
  self.geometry.wsIndex = () => 1;
  return { self, ticks, retiles };
}

// GLib sources captured, Date.now driven by `at.now`.
function withClock(ticks, at, fn) {
  const orig = { add: GLib.timeout_add, remove: GLib.source_remove, now: Date.now };
  GLib.timeout_add = (_p, _ms, cb) => { ticks.push(cb); return ticks.length; };
  GLib.source_remove = () => true;
  Date.now = () => at.now;
  try {
    return fn();
  } finally {
    GLib.timeout_add = orig.add;
    GLib.source_remove = orig.remove;
    Date.now = orig.now;
  }
}

const group = (tiled) => [{ mon: 0, tiled, layout: 'dwindle', places: true }];

test('tick run: a window at its slot gets no configure, during the run or at its end', () => {
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 300, height: 500 });
  const b = win(ws, 2, { x: 500, y: 0, width: 500, height: 500 });
  const targets = new Map([[a, { x: 0, y: 0, w: 300, h: 500 }], [b, { x: 300, y: 0, w: 700, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  const at = { now: 1000 };
  withClock(ticks, at, () => {
    self.placement.animRetile(ws, group([a, b]));
    for (const t of [1016, 1032, 1050, 1100]) { at.now = t; ticks.at(-1)(); }
  });
  assert.deepEqual(a._configs, [], 'a never moved');
  assert.ok(b._configs.length > 1);
  assert.deepEqual(b._configs.at(-1), [300, 0, 700, 500]);
  assert.equal(self._animating, false);
});

test('tick run: a rect that did not move since the last tick is not re-sent', () => {
  const ws = {};
  const b = win(ws, 2, { x: 500, y: 0, width: 500, height: 500 });
  const { self, ticks } = runSelf(new Map([[b, { x: 300, y: 0, w: 700, h: 500 }]]));
  const at = { now: 1000 };
  withClock(ticks, at, () => {
    self.placement.animRetile(ws, group([b]));
    at.now = 1030; ticks.at(-1)();
    const n = b._configs.length;
    ticks.at(-1)();
    assert.equal(b._configs.length, n, 'same time, same rect: nothing sent');
  });
});

test('tick run: a re-run starts where a slow client is heading, not from its stale frame', () => {
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 }, { lag: true });
  const targets = new Map([[a, { x: 0, y: 0, w: 300, h: 500 }]]);
  const { self, ticks } = runSelf(targets);
  const at = { now: 1000 };
  withClock(ticks, at, () => {
    self.placement.animRetile(ws, group([a]));
    at.now = 1200; ticks.at(-1)(); // the run ends: a sent 300 wide, still drawn at 500
    assert.deepEqual(a._configs.at(-1), [0, 0, 300, 500]);
    assert.equal(self.monitors.tickSentPending(a, a.get_frame_rect()), true);
    targets.set(a, { x: 0, y: 0, w: 200, h: 500 });
    self.placement.animRetile(ws, group([a]));
    assert.deepEqual([self._animStates[0].startW], [300], 'from the rect in flight');
    at.now = 1216; ticks.at(-1)();
    assert.ok(a._configs.at(-1)[2] <= 300, `never back towards the stale 500: ${a._configs.at(-1)}`);
  });
});

test('tickSentPending: not once the frame is one the ticks never saw or sent, or after 2 s', () => {
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 }, { lag: true });
  const self = makeSelf({});
  const at = { now: 1000 };
  withClock([], at, () => {
    self.placement.tickConfigure(a, 0, 0, 300, 500, { targetX: 0, targetY: 0, targetW: 300, targetH: 500 });
    assert.equal(self.monitors.tickSentPending(a, { x: 0, y: 0, width: 500, height: 500 }), true);
    assert.equal(self.monitors.tickSentPending(a, { x: 7, y: 0, width: 500, height: 500 }), false, 'moved by something else');
    at.now = 3001;
    assert.equal(self.monitors.tickSentPending(a, { x: 0, y: 0, width: 500, height: 500 }), false, 'stale');
  });
});

test('maybeReassertSlot mid-animation defers the window; the drain re-checks it once, not on a workspace being retiled', () => {
  const ws = {}, other = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 100, height: 100 });
  const c = win(other, 3, { x: 0, y: 0, width: 100, height: 100 });
  const self = makeSelf({ enabled: true });
  const retiles = [];
  self.signals.scheduleRetile = (w) => retiles.push(w);
  self.windows.isFloating = () => false;
  self._windowWorkspaces.set(a, ws).set(c, other);
  self._animating = true;
  self.grab.maybeReassertSlot(a);
  self.grab.maybeReassertSlot(c);
  assert.deepEqual([...self._deferredReassertWins], [a, c]);
  assert.equal(self._queuedAnimWorkspaces.size, 0, 'no retile queued per commit');
  self._animating = false;
  const checked = [];
  const orig = self.grab.maybeReassertSlot.bind(self.grab);
  self.grab.maybeReassertSlot = (w) => { checked.push(w); };
  self._queuedAnimWorkspaces.add(ws);
  const old = globalThis.global;
  globalThis.global = { ...old, workspace_manager: { get_active_workspace: () => ws } };
  try {
    self.placement.drainAnimQueue();
  } finally {
    globalThis.global = old;
    self.grab.maybeReassertSlot = orig;
  }
  assert.deepEqual(retiles, [ws]);
  assert.deepEqual(checked, [c], 'a is on the retiled workspace');
  assert.equal(self._deferredReassertWins.size, 0);
});

test('drainAnimQueue: the active workspace is retiled first', () => {
  const self = makeSelf({});
  const retiles = [];
  self.signals.scheduleRetile = (w) => retiles.push(w);
  const w1 = { id: 1 }, w2 = { id: 2 }, w3 = { id: 3 };
  for (const w of [w1, w2, w3]) self._queuedAnimWorkspaces.add(w);
  const old = globalThis.global;
  globalThis.global = { ...old, workspace_manager: { get_active_workspace: () => w2 } };
  try {
    self.placement.drainAnimQueue();
  } finally {
    globalThis.global = old;
  }
  assert.deepEqual(retiles, [w2, w1, w3]);
});

test('recordTick: at most the last 32 seen or sent frames are kept', () => {
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 }, { lag: true });
  const self = makeSelf({});
  const run = { targetX: 0, targetY: 0, targetW: 300, targetH: 500 };
  for (let i = 0; i < 40; i++) self.placement.tickConfigure(a, 0, 0, 300 + i, 500, run);
  assert.equal(a._plaidTickSent.seen.length, 32);
});

test('a Spiral run starts from the frame, not from a pending tick rect (the driver draws it)', () => {
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 }, { lag: true });
  const { self, ticks } = runSelf(new Map([[a, { x: 0, y: 0, w: 300, h: 500 }]]));
  self.windows.getWorkspaceLayout = () => 'spiral';
  self.bsp.tileRect = (_w, r) => r;
  let started = null;
  self.transforms.run = (states) => { started = states; };
  self.transforms.stop = () => new Map();
  const at = { now: 1000 };
  withClock(ticks, at, () => {
    a._plaidTickSent = { at: 1000, run: 1, sentAt: [], end: [0, 0, 300, 500], x: 0, y: 0, w: 300, h: 500, seen: ['0,0,500,500'] };
    assert.equal(self.monitors.tickSentPending(a, a.get_frame_rect()), true);
    self.placement.animRetile(ws, [{ mon: 0, tiled: [a], layout: 'spiral', places: true }]);
  });
  assert.ok(started, 'a Spiral transform run');
  assert.equal(started[0].startW, 500);
});

test('removeWindow drops a deferred slot re-check', () => {
  const ws = {};
  const a = win(ws, 1, { x: 0, y: 0, width: 500, height: 500 });
  const self = makeSelf({ enabled: true });
  self.monitors.windowConn = () => null;
  self.layouts.retileWorkspace = () => {};
  self.geometry.wsIndex = () => 1;
  self._deferredReassertWins.add(a);
  self.windows.removeWindow(a);
  assert.equal(self._deferredReassertWins.has(a), false);
});

test('tick run: a new window the run did not place stays new; a new one it starts arms the reveal backstop', () => {
  const ws = {};
  const a = win(ws, 1, { x: 500, y: 0, width: 500, height: 500 });
  const n = win(ws, 2, { x: 0, y: 0, width: 0, height: 0 });
  const c = win(ws, 3, { x: 0, y: 0, width: 100, height: 100 });
  const { self, ticks } = runSelf(new Map([[a, { x: 300, y: 0, w: 700, h: 500 }], [c, { x: 0, y: 0, w: 300, h: 500 }]]));
  self.layouts.retileDwindle = (_ws, tiled) => {
    for (const w of tiled) if (w !== n) self._animTargets.set(w, w === a ? { x: 300, y: 0, w: 700, h: 500 } : { x: 0, y: 0, w: 300, h: 500 });
  };
  const armed = [];
  self.windows.armRevealBackstop = (w) => armed.push(w);
  self.placement.deferNewWindowPlacement = (_s, _d, done) => done();
  self._newWindowSet.add(n).add(c);
  const at = { now: 1000 };
  withClock(ticks, at, () => {
    self.placement.animRetile(ws, group([a, n, c]));
    at.now = 1200; ticks.at(-1)();
  });
  assert.equal(self._animating, false);
  assert.deepEqual(armed, [c]);
  assert.equal(self._newWindowSet.has(n), true, 'not placed by this run: still new');
  assert.equal(self._newWindowSet.has(c), false);
});

test('deferNewWindowPlacement: a busy client is frozen only after a second without a frame change', () => {
  const ws = {};
  const w = win(ws, 1, { x: 400, y: 300, width: 800, height: 600 }, { lag: true });
  let eased = 0;
  w.get_compositor_private = () => ({ remove_all_transitions() {}, set_opacity() {}, ease() { eased++; } });
  const { self, ticks } = runSelf(new Map());
  self.placement.verifyAnimationLanding = () => false;
  self.placement.landingAccepted = () => false;
  // The attempt loop's 80 / 100 ms retries.
  const attempts = [];
  self.signals.addTimeout = (ms, fn) => { if (ms === 80 || ms === 100) attempts.push(fn); return 1; };
  const at = { now: 0 };
  withClock(ticks, at, () => {
    self.placement.deferNewWindowPlacement({ win: w, actor: w.get_compositor_private(), targetX: 0, targetY: 0, targetW: 10, targetH: 10 },
      100, () => {}, self._animGen);
    for (const t of [0, 100, 200, 300]) { at.now = t; attempts.at(-1)(); }
    assert.equal(eased, 0, 'identical frames for 300 ms: still placing');
    at.now = 1200; attempts.at(-1)();
    assert.equal(eased, 1, 'frozen: revealed where it is');
  });
});
