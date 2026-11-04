import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import { makeSelf, fakeWin } from '../helpers.mjs';

// Animation runs: generations and the stall watchdog.

function win(ws, id) {
  const w = fakeWin({ id, instance: `w${id}` });
  let frame = { x: 0, y: 0, width: 100, height: 100 };
  Object.assign(w, {
    get_id: () => id,
    get_workspace: () => ws,
    get_frame_rect: () => ({ ...frame }),
    get_compositor_private: () => ({ remove_all_transitions() {}, set_opacity() {} }),
    move_resize_frame: (_u, x, y, width, height) => { frame = { x, y, width, height }; },
  });
  return w;
}

// A self whose dwindle pass sends every window to (200, 0, 300, 300); the
// tick sources are captured, not run.
function runSelf() {
  const ticks = [];
  const retiles = [];
  const self = makeSelf({ 'inside-gap': 0, enabled: true });
  self.placement.getAnimationTime = () => 0.1;
  self.placement.verifyAnimationLanding = () => true;
  self.layouts.retileDwindle = (_ws, tiled) => {
    for (const w of tiled) self._animTargets.set(w, { x: 200, y: 0, w: 300, h: 300 });
  };
  self.signals.scheduleRetile = (ws) => retiles.push(ws);
  self.signals.scheduleBorders = () => {};
  self.persistence.scheduleSaveLayouts = () => {};
  self.geometry.wsIndex = () => 1;
  return { self, ticks, retiles };
}

function withTicks(ticks, fn) {
  const orig = GLib.timeout_add;
  GLib.timeout_add = (_p, _ms, cb) => { ticks.push(cb); return ticks.length; };
  const origRemove = GLib.source_remove;
  GLib.source_remove = () => true;
  try {
    return fn();
  } finally {
    GLib.timeout_add = orig;
    GLib.source_remove = origRemove;
  }
}

const group = (tiled) => [{ mon: 0, tiled, layout: 'dwindle', places: true }];

test('animRetile: a run retired by the watchdog cannot finish its replacement', () => {
  const { self, ticks } = runSelf();
  const wsA = { id: 'A' }, wsB = { id: 'B' };
  const a = win(wsA, 1), b = win(wsB, 2);
  withTicks(ticks, () => {
    self.placement.animRetile(wsA, group([a]));
    assert.equal(self._animating, true);
    const runA = ticks.at(-1);
    // A's completion was lost: past 800 ms the next retile retires it.
    self._animStartedAt = Date.now() - 900;
    self.placement.animRetile(wsB, group([b]));
    assert.equal(self._animating, true, 'B runs');
    const runB = ticks.at(-1);
    assert.notEqual(runA, runB);
    // A's late last tick: its dec belongs to a retired run.
    self._animStartTime = 0;
    runA();
    assert.equal(self._animating, true, 'B is still in flight');
    runB();
    assert.equal(self._animating, false, 'B finished itself');
  });
});

test('animRetile: the watchdog retiles the stalled run\'s workspace again', () => {
  const { self, ticks, retiles } = runSelf();
  const wsA = { id: 'A' }, wsB = { id: 'B' };
  withTicks(ticks, () => {
    self.placement.animRetile(wsA, group([win(wsA, 1)]));
    self._animStartedAt = Date.now() - 900;
    self.placement.animRetile(wsB, group([win(wsB, 2)]));
  });
  assert.deepEqual(retiles, [wsA]);
});

test('animRetile: within the watchdog budget a retile is queued, not started', () => {
  const { self, ticks } = runSelf();
  const wsA = { id: 'A' }, wsB = { id: 'B' };
  withTicks(ticks, () => {
    self.placement.animRetile(wsA, group([win(wsA, 1)]));
    const gen = self._animGen;
    self.placement.animRetile(wsB, group([win(wsB, 2)]));
    assert.equal(self._animGen, gen);
    assert.deepEqual([...self._queuedAnimWorkspaces], [wsB]);
  });
});

test('cancelAnimation: retires the run in flight', () => {
  const { self, ticks } = runSelf();
  const ws = { id: 'A' };
  withTicks(ticks, () => {
    self.placement.animRetile(ws, group([win(ws, 1)]));
    const run = ticks.at(-1);
    self.placement.cancelAnimation();
    // A later run, then the cancelled one's last tick.
    self.placement.animRetile(ws, group([win(ws, 2)]));
    self._animStartTime = 0;
    run();
    assert.equal(self._animating, true);
  });
});

test('animStalled: tick runs by age (800 ms), transform runs by progress (500 + 300 f ms)', () => {
  const { self } = runSelf();
  const now = 100000;
  self._animStartedAt = now - 801;
  self._animProgressAt = now - 10;
  self._animTransformRun = false;
  assert.equal(self.placement.animStalled(now), true);
  self._animStartedAt = now - 799;
  assert.equal(self.placement.animStalled(now), false);
  // A slowed transform run (f = 8: 3.04 s ease) is not cut at 800 ms.
  self.placement.getAnimationTime = () => 0.8;
  self._animTransformRun = true;
  self._animStartedAt = now - 3000;
  self._animProgressAt = now - 2800;
  assert.ok(Math.abs(self.placement.animStallBudget() - 2900) < 1e-6);
  assert.equal(self.placement.animStalled(now), false);
  self._animProgressAt = now - 2901;
  assert.equal(self.placement.animStalled(now), true);
});

test('deferNewWindowPlacement: a retired run stops placing', () => {
  const { self, ticks } = runSelf();
  const ws = { id: 'A' };
  const w = win(ws, 1);
  let moved = 0;
  w.move_resize_frame = () => { moved++; };
  withTicks(ticks, () => {
    const gen = self._animGen;
    self.placement.deferNewWindowPlacement({ win: w, actor: {}, targetX: 0, targetY: 0, targetW: 10, targetH: 10 },
      100, () => {}, gen);
    const attempt = ticks.at(-1);
    self._animGen++;
    attempt();
    assert.equal(moved, 0);
  });
});

test('cancelAnimation: a deferred placement of the cancelled run stops (shutdown)', () => {
  const { self, ticks } = runSelf();
  const ws = { id: 'A' };
  const w = win(ws, 1);
  let moved = 0;
  w.move_resize_frame = () => { moved++; };
  withTicks(ticks, () => {
    self.placement.deferNewWindowPlacement({ win: w, actor: {}, targetX: 0, targetY: 0, targetW: 10, targetH: 10 },
      100, () => {}, self._animGen);
    const attempt = ticks.at(-1);
    self.placement.cancelAnimation();
    attempt();
    assert.equal(moved, 0);
  });
});

test('a removed workspace is no animation run\'s workspace (the watchdog would re-queue it)', () => {
  const { self } = runSelf();
  const live = { id: 'live' }, dead = { id: 'dead' };
  const old = globalThis.global;
  globalThis.global = { ...old, workspace_manager: { get_n_workspaces: () => 1, get_workspace_by_index: () => live } };
  try {
    self.bgApp.scheduleBackgroundAppParkingFix = () => {};
    self.persistence.shiftWorkspaceIndexKeys = () => {};
    self.layouts.retileWorkspace = () => {};
    self._workspaceOrders.set(dead, []);
    self._animWorkspace = dead;
    self.signals.onWorkspaceRemoved(1);
    assert.equal(self._animWorkspace, null);
  } finally {
    globalThis.global = old;
  }
});
