import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';
import { Monitors } from '../../extensions/modules/monitors.js';
import { sessionState } from '../../extensions/modules/session-state.js';

// Monitors side by side: 0 = "DP-1" (primary) at x 0, 1 = "DP-2" at x 1000 (and
// 2 = "DP-3" at x 1800 when three are stubbed).
const GEOM = [{ x: 0, y: 0, width: 1000, height: 500 }, { x: 1000, y: 0, width: 800, height: 500 },
  { x: 1800, y: 0, width: 800, height: 500 }];
const CONN = ['DP-1', 'DP-2', 'DP-3'];

function fakeWs() {
  return { get_work_area_for_monitor: (m) => ({ ...GEOM[m] }) };
}

// Workspaces 0 (the parking slot), 1 and 2; returns them.
function stubGlobal({ conns = ['DP-1', 'DP-2'], primary = 0, focus = null, pointer = [0, 0], nws = 3 } = {}) {
  const geom = conns.map((_c, i) => GEOM[i]);
  const wss = Array.from({ length: nws }, () => fakeWs());
  globalThis.global = {
    get_pointer: () => [...pointer, 0],
    get_current_time: () => 0,
    display: {
      focus_window: focus,
      get_primary_monitor: () => primary,
      get_n_monitors: () => conns.length,
      get_current_monitor: () => 0,
      get_monitor_geometry: (i) => geom[i],
      get_monitor_index_for_rect: (r) => {
        const cx = r.x + r.width / 2;
        return geom.findIndex(g => cx >= g.x && cx < g.x + g.width);
      },
    },
    backend: {
      get_monitor_manager: () => ({
        get_logical_monitors: () => conns.map((c, i) => ({
          get_number: () => i,
          get_monitors: () => [{ get_connector: () => c }],
        })),
      }),
    },
    workspace_manager: {
      get_n_workspaces: () => wss.length,
      get_workspace_by_index: (i) => wss[i] ?? null,
      get_active_workspace: () => wss[1],
    },
  };
  return wss;
}

let _id = 0;
// A window with a mutable frame, monitor and workspace.
function W(title, ws, mon, frame = null) {
  const w = fakeWin({ instance: title, title });
  const id = ++_id;
  Object.assign(w, {
    _title: title, _mon: mon, _frame: frame ?? { ...GEOM[mon] }, _ws: ws,
    get_id: () => id,
    get_frame_rect: () => ({ ...w._frame }),
    get_buffer_rect: () => ({ ...w._frame }),
    get_monitor: () => w._mon,
    get_workspace: () => w._ws,
    get_compositor_private: () => null,
    get_stable_sequence: () => id,
    unmaximize: () => {},
    raise: () => {},
    move_resize_frame: (_u, x, y, width, height) => { w._frame = { x, y, width, height }; },
  });
  return w;
}

const byTitle = (a, b) => (a._title < b._title ? -1 : 1);

// A self with the group state of a live session: windows registered on `ws`
// with their monitor's connector.
function groupSelf(ws, wins, extra = {}) {
  const retiles = [];
  const idx = global.workspace_manager.get_workspace_by_index(1) === ws ? 1 : 2;
  const self = makeSelf({ 'inside-gap': 0, 'dwindle-ratio': 0.5, layout: 'dwindle', enabled: true }, {
    _retileWorkspace: (w) => retiles.push(w),
    _scheduleRetile: (w) => retiles.push(w),
    _scheduleSaveLayouts: () => {},
    _scheduleBorders: () => {},
    ...extra,
  });
  for (const w of wins) {
    self._windowWorkspaces.set(w, ws);
    self._windowWSIndices.set(w, idx);
    self._windowMonitors.set(w, CONN[w._mon]);
  }
  self._workspaceOrders.set(ws, [...wins]);
  for (const k of ['_persistedLayoutByIndex', '_persistedMasterByIndex', '_persistedStackByIndex',
    '_persistedDwindleByIndex', '_persistedDwindleRaw'])
    self[k] = new Map();
  self.borders.startBorderAnimation = () => {};
  self.borders.removeBorder = () => {};
  return { self, retiles };
}

const treeWins = (self, ws, mon) => self.bsp.bspCollectWindows(self.bsp.bspGetTree(ws, mon));

test('group keys: the primary keeps the index, others add their connector; codec round-trips', () => {
  const [, ws] = stubGlobal({ nws: 3 });
  const self = makeSelf();
  const ws2 = global.workspace_manager.get_workspace_by_index(2);
  assert.equal(self.monitors.groupKey(ws2, 0), 2);
  assert.equal(self.monitors.groupKey(ws2, 1), '2@DP-2');
  assert.equal(self.monitors.groupKey(ws2, null), 2);
  assert.equal(self.monitors.groupObj(ws, 0), ws);
  const g = self.monitors.groupObj(ws, 1);
  assert.equal(g, self.monitors.groupObj(ws, 1), 'one key object per group');
  assert.deepEqual([g.ws, g.conn], [ws, 'DP-2']);
  for (const k of [3, '3@DP-2', '3@DP-2:x']) {
    const p = Monitors.parseGroupKey(k);
    assert.equal(Monitors.formatGroupKey(p.idx, p.conn, p.tail), k);
  }
  assert.deepEqual(Monitors.splitMonitorEntry('DP-2:1:dwindle'), { conn: 'DP-2', rest: '1:dwindle' });
  assert.equal(Monitors.splitMonitorEntry(':1:dwindle'), null);
  assert.equal(Monitors.splitMonitorEntry('a@b:1:dwindle'), null);
});

// A lock cycle: the stash outlives the core, the next core restores it and
// re-adds every window as a resume.
function lockCycle(self, wins) {
  sessionState.stashedTiling = null;
  self.stashTilingState();
  const next = groupSelf(wins[0]._ws, []).self;
  next._windowWorkspaces = new Map();
  try {
    next.restoreTilingState();
    for (const w of wins) next.windows.addWindow(w, true);
  } finally {
    sessionState.stashedTiling = null;
  }
  return next;
}

function liveWin(title, ws, mon) {
  const w = W(title, ws, mon);
  w.get_compositor_private = () => ({});
  w._plaidSignalsConnected = true;
  return w;
}

test('lock cycle: each window keeps its monitor group, and each group its tree', () => {
  const [, ws] = stubGlobal();
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 1), c = liveWin('c', ws, 1);
  const { self } = groupSelf(ws, [a, b, c]);
  self.bsp.bspSetTree(ws, 0, leaf(a));
  self.bsp.bspSetTree(ws, 1, split('v', 0.4, leaf(b), leaf(c)));
  const record = self._windowMonitors;
  const next = lockCycle(self, [a, b, c]);
  assert.equal(next._windowMonitors, record, 'the stashed record, not one rebuilt from get_monitor()');
  assert.deepEqual([a, b, c].map(w => next.monitors.windowMon(w)), [0, 1, 1]);
  assert.deepEqual(next.monitors.getWindowsForGroup(ws, 1), [b, c]);
  assert.deepEqual(treeWins(next, ws, 0), [a]);
  assert.deepEqual(treeWins(next, ws, 1), [b, c]);
  assert.equal(next.bsp.bspGetTree(ws, 1).ratio, 0.4);
});

test('lock cycle: a window closed and a workspace removed meanwhile are dropped from the groups', () => {
  const [, ws, ws2] = stubGlobal();
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 1), gone = liveWin('gone', ws, 1);
  const d = liveWin('d', ws2, 1);
  const { self } = groupSelf(ws, [a, b, gone]);
  self._windowWorkspaces.set(d, ws2);
  self._windowMonitors.set(d, 'DP-2');
  self.bsp.bspSetTree(ws, 1, split('v', 0.5, leaf(b), leaf(gone)));
  self.bsp.bspSetTree(ws2, 1, leaf(d));
  const deadGroup = self.monitors.groupObj(ws2, 1);
  gone.get_compositor_private = () => null;
  global.workspace_manager.get_n_workspaces = () => 2;
  d._ws = ws;
  const next = lockCycle(self, [a, b]);
  assert.equal(next._windowMonitors.has(gone), false);
  assert.deepEqual(treeWins(next, ws, 1), [b]);
  assert.equal(next._groupObjs.has(ws2), false);
  assert.equal(next._bspTrees.has(deadGroup), false);
});

test('lock cycle: a stash without monitor groups takes the monitor each window is on', () => {
  const [, ws] = stubGlobal();
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 1);
  const { self } = groupSelf(ws, [a, b]);
  sessionState.stashedTiling = null;
  self.stashTilingState();
  delete sessionState.stashedTiling.windowMonitors;
  delete sessionState.stashedTiling.groupObjs;
  const next = groupSelf(ws, []).self;
  try {
    next.restoreTilingState();
    next.windows.addWindow(a, true);
    next.windows.addWindow(b, true);
  } finally {
    sessionState.stashedTiling = null;
  }
  assert.deepEqual([a, b].map(w => next.monitors.windowMon(w)), [0, 1]);
});

test('lock cycle: maps keyed for another primary move to the current one', () => {
  const [, ws] = stubGlobal();
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 1);
  const { self } = groupSelf(ws, [a, b]);
  self.bsp.bspSetTree(ws, 0, leaf(a));
  self.bsp.bspSetTree(ws, 1, leaf(b));
  self._workspaceLayouts.set(1, 'spiral');
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  assert.equal(self.monitors.keyedPrimaryConn(), 'DP-1');
  global.display.get_primary_monitor = () => 1;
  const next = lockCycle(self, [a, b]);
  assert.equal(next.monitors.keyedPrimaryConn(), 'DP-2');
  assert.equal(next.windows.getWorkspaceLayout(ws, 0), 'spiral');
  assert.equal(next.windows.getWorkspaceLayout(ws, 1), 'master-stack');
  assert.deepEqual(treeWins(next, ws, 0), [a]);
  assert.deepEqual(treeWins(next, ws, 1), [b]);
});

function unplugSecond(primaryAfter = 0) {
  global.display.get_n_monitors = () => 1;
  global.display.get_primary_monitor = () => primaryAfter;
  global.backend.get_monitor_manager = () => ({
    get_logical_monitors: () => [{ get_number: () => 0, get_monitors: () => [{ get_connector: () => 'eDP-1' }] }],
  });
}

test('lock cycle: an undock while disabled brings the removed monitor\'s windows into a live group', () => {
  const [, ws] = stubGlobal({ conns: ['eDP-1', 'DP-2'], primary: 1 });
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 1), c = liveWin('c', ws, 1);
  const { self } = groupSelf(ws, []);
  for (const w of [a, b, c]) {
    self._windowWorkspaces.set(w, ws);
    self._windowWSIndices.set(w, 1);
  }
  self._windowMonitors.set(a, 'eDP-1');
  self._windowMonitors.set(b, 'DP-2');
  self._windowMonitors.set(c, 'DP-2');
  self._workspaceOrders.set(ws, [a, b, c]);
  assert.equal(self.monitors.keyedPrimaryConn(), 'DP-2');
  self.bsp.bspSetTree(ws, 0, leaf(a));
  self.bsp.bspSetTree(ws, 1, split('v', 0.5, leaf(b), leaf(c)));
  // While locked: DP-2 is unplugged, mutter moves its windows onto eDP-1.
  unplugSecond(0);
  b._mon = 0;
  c._mon = 0;
  const next = lockCycle(self, [a, b, c]);
  assert.deepEqual([a, b, c].map(w => next.monitors.windowMon(w)), [0, 0, 0]);
  assert.deepEqual(new Set(treeWins(next, ws, 0)), new Set([a, b, c]));
  assert.ok([...next._persistedDwindleRaw.keys()].some(k => String(k).includes('DP-2')),
    'the removed monitor\'s arrangement is kept for its return');
});

test('lock cycle: a window moved to another monitor while disabled joins that monitor\'s group', () => {
  const [, ws] = stubGlobal();
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 0), c = liveWin('c', ws, 1);
  const { self } = groupSelf(ws, [a, b, c]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, leaf(c));
  a._mon = 1;
  a._frame = { ...GEOM[1] };
  const next = lockCycle(self, [a, b, c]);
  assert.equal(next.monitors.windowMon(a), 1);
  assert.deepEqual(treeWins(next, ws, 0), [b]);
  assert.deepEqual(new Set(treeWins(next, ws, 1)), new Set([a, c]));
});

test('lock cycle: a monitor change before the restore leaves the stash to it', () => {
  const [, ws] = stubGlobal();
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 1);
  const { self } = groupSelf(ws, [a, b]);
  self.bsp.bspSetTree(ws, 0, leaf(a));
  self.bsp.bspSetTree(ws, 1, leaf(b));
  self._workspaceLayouts.set(1, 'spiral');
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  assert.equal(self.monitors.keyedPrimaryConn(), 'DP-1');
  sessionState.stashedTiling = null;
  self.stashTilingState();
  global.display.get_primary_monitor = () => 1;
  const next = groupSelf(ws, []).self;
  next._windowWorkspaces = new Map();
  next._keyedPrimary = next.resumeKeyedPrimary(true);
  try {
    // The monitors-changed handler, before the restore idle: it stands down.
    assert.equal(next.monitors.restorePending(), true);
    assert.equal(next.monitors.syncKeyedPrimary(), false);
    next.monitors.regroupWindows('hotplug');
    assert.equal(next._keyedPrimary, 'DP-1');
    next.restoreTilingState();
    assert.equal(next.monitors.restorePending(), false);
    for (const w of [a, b]) next.windows.addWindow(w, true);
  } finally {
    sessionState.stashedTiling = null;
  }
  assert.equal(next.windows.getWorkspaceLayout(ws, 0), 'spiral');
  assert.equal(next.windows.getWorkspaceLayout(ws, 1), 'master-stack');
  assert.deepEqual(treeWins(next, ws, 0), [a]);
  assert.deepEqual(treeWins(next, ws, 1), [b]);
});

test('lock cycle: the restore re-keys the stash for its own primary, whatever was read first', () => {
  const [, ws] = stubGlobal();
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 1);
  const { self } = groupSelf(ws, [a, b]);
  self._workspaceLayouts.set(1, 'spiral');
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  assert.equal(self.monitors.keyedPrimaryConn(), 'DP-1');
  sessionState.stashedTiling = null;
  self.stashTilingState();
  global.display.get_primary_monitor = () => 1;
  const next = groupSelf(ws, []).self;
  next._windowWorkspaces = new Map();
  try {
    assert.equal(next.monitors.keyedPrimaryConn(), 'DP-2', 'read before the restore');
    next.restoreTilingState();
    for (const w of [a, b]) next.windows.addWindow(w, true);
  } finally {
    sessionState.stashedTiling = null;
  }
  assert.equal(next.windows.getWorkspaceLayout(ws, 0), 'spiral');
  assert.equal(next.windows.getWorkspaceLayout(ws, 1), 'master-stack');
});

function plugSecond() {
  global.display.get_n_monitors = () => 2;
  global.display.get_primary_monitor = () => 1;
  global.display.get_monitor_geometry = (i) => GEOM[i];
  global.backend.get_monitor_manager = () => ({
    get_logical_monitors: () => ['eDP-1', 'DP-2'].map((c, i) => ({
      get_number: () => i, get_monitors: () => [{ get_connector: () => c }] })),
  });
}

test('lock resume: retiles everything after a dock, an undock or a moved work area, not otherwise', () => {
  const cycle = (before, during) => {
    const [, ws] = before();
    const a = liveWin('a', ws, 0);
    const { self } = groupSelf(ws, [a]);
    sessionState.stashedTiling = null;
    self.stashTilingState();
    during(ws);
    const next = groupSelf(ws, []).self;
    try {
      next.restoreTilingState();
    } finally {
      sessionState.stashedTiling = null;
    }
    const lock = next.resumeRetilesAll(true);
    assert.equal(next.resumeRetilesAll(true), false, 'read once');
    return [lock, next.resumeRetilesAll(false)];
  };
  const one = () => stubGlobal({ conns: ['eDP-1'] });
  const two = () => stubGlobal({ conns: ['eDP-1', 'DP-2'], primary: 1 });
  assert.deepEqual(cycle(one, () => {}), [false, true], 'nothing changed: a lock resume keeps the layout');
  assert.deepEqual(cycle(one, () => plugSecond()), [true, true], 'docked while locked');
  assert.deepEqual(cycle(two, () => unplugSecond(0)), [true, true], 'undocked while locked');
  assert.deepEqual(cycle(two, (ws) => {
    ws.get_work_area_for_monitor = (m) => ({ ...GEOM[m], y: 32, height: GEOM[m].height - 32 });
  }), [true, true], 'the top bar moved');
});

test('resumeKeyedPrimary: the stashed primary on a resume, so the saved rules load against it', () => {
  const [, ws] = stubGlobal();
  const a = liveWin('a', ws, 0), b = liveWin('b', ws, 1);
  const { self } = groupSelf(ws, [a, b]);
  self._workspaceLayouts.set(1, 'spiral');
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  assert.equal(self.monitors.keyedPrimaryConn(), 'DP-1');
  sessionState.stashedTiling = null;
  assert.equal(self.resumeKeyedPrimary(true), null, 'nothing stashed');
  self.stashTilingState();
  const lock = sessionState.lockCycle;
  try {
    sessionState.lockCycle = false;
    assert.equal(self.resumeKeyedPrimary(false), null, 'not a resume');
    sessionState.lockCycle = true;
    assert.equal(self.resumeKeyedPrimary(false), 'DP-1', 'a lock cycle');
    sessionState.lockCycle = false;
    assert.equal(self.resumeKeyedPrimary(true), 'DP-1', 'a manual toggle');
    global.display.get_primary_monitor = () => 1;
    const next = groupSelf(ws, []).self;
    next._windowWorkspaces = new Map();
    next._keyedPrimary = next.resumeKeyedPrimary(true);
    // loadPersistedLayoutRules: a saved monitor-* rule for workspace 2 on DP-2.
    const ws2 = global.workspace_manager.get_workspace_by_index(2);
    next._persistedLayoutByIndex.set(next.monitors.groupKeyFor(2, 'DP-2'), 'master-stack');
    next.restoreTilingState();
    for (const w of [a, b]) next.windows.addWindow(w, true);
    assert.equal(next.windows.getWorkspaceLayout(ws, 0), 'spiral');
    assert.equal(next.windows.getWorkspaceLayout(ws, 1), 'master-stack');
    assert.equal(next.windows.getWorkspaceLayout(ws2, 1), 'master-stack', 'the saved rule stays on DP-2');
    assert.equal(next.windows.getWorkspaceLayout(ws2, 0), 'dwindle', 'and does not move to DP-1');
  } finally {
    sessionState.lockCycle = lock;
    sessionState.stashedTiling = null;
  }
});

test('connectors: a monitor without one is keyed by its index', () => {
  stubGlobal({ conns: ['DP-1', ''] });
  const self = makeSelf();
  assert.equal(self.monitors.monConn(1), '#1');
  assert.equal(self.monitors.connMon('#1'), 1);
  assert.equal(self.monitors.connMon('HDMI-1'), -1);
  stubGlobal();
  assert.equal(makeSelf().monitors.connMon('#1'), -1, 'an index key no longer matches once the monitor has a connector');
  // No monitor has a connector: every monitor by index, still tiled.
  stubGlobal({ conns: ['', ''] });
  const unnamed = makeSelf();
  assert.equal(unnamed.monitors.monConn(0), '#0');
  assert.deepEqual(unnamed.monitors.tiledMonitors(), [0, 1]);
  // No logical monitors listed at all: the same.
  stubGlobal({ conns: ['DP-1', 'DP-2'] });
  global.backend = { get_monitor_manager: () => ({ get_logical_monitors: () => [] }) };
  const unlisted = makeSelf();
  assert.deepEqual([unlisted.monitors.monConn(0), unlisted.monitors.monConn(1)], ['#0', '#1']);
  assert.deepEqual(unlisted.monitors.tiledMonitors(), [0, 1]);
});

test('getWindowsForGroup: each monitor gets only its own windows', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 1), c = W('c', ws, 0);
  const { self } = groupSelf(ws, [a, b, c]);
  assert.deepEqual(self.monitors.getWindowsForGroup(ws, 0), [a, c]);
  assert.deepEqual(self.monitors.getWindowsForGroup(ws, 1), [b]);
  assert.deepEqual(self.monitors.getWindowsForGroup(ws, null), [a, c], 'no monitor: the primary group');
  assert.deepEqual(self.windows.getWindowsForWorkspace(ws), [a, b, c]);
});

test('per-group trees and slots: a window is laid out on its own monitor', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0), c = W('c', ws, 1), d = W('d', ws, 1);
  const { self } = groupSelf(ws, [a, b, c, d]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, split('v', 0.5, leaf(c), leaf(d)));
  for (const mon of [0, 1]) {
    const area = self.geometry.outsideArea(GEOM[mon]);
    self.bsp.bspTagGeometry(self.bsp.bspGetTree(ws, mon), area.x, area.y, area.w, area.h, 0);
  }
  assert.deepEqual(self.grab.windowSlotRect(a, ws, 'dwindle', GEOM[0], 0), { x: 0, y: 0, w: 500, h: 500 });
  assert.deepEqual(self.grab.windowSlotRect(d, ws, 'dwindle', GEOM[1], 0), { x: 1000, y: 250, w: 800, h: 250 });
  assert.equal(self._bspTrees.get(ws).first.window, a, 'the primary group keeps the workspace key');
  // Master-stack slots count the group only: c is the master of monitor 1.
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  assert.deepEqual(self.grab.windowSlotRect(c, ws, 'master-stack', GEOM[1], 0), { x: 1000, y: 0, w: 400, h: 500 });
  self._masterRatios.set('1@DP-2', 0.75);
  assert.deepEqual(self.grab.windowSlotRect(c, ws, 'master-stack', GEOM[1], 0), { x: 1000, y: 0, w: 600, h: 500 });
});

test('windowSlotRect: no slot on a monitor that is not tiled (workspaces only on the primary)', () => {
  const [, ws] = stubGlobal();
  const c = W('c', ws, 1);
  const { self } = groupSelf(ws, [c], { _mutterSettings: { get_boolean: () => true } });
  assert.deepEqual(self.monitors.tiledMonitors(), [0]);
  assert.equal(self.grab.windowSlotRect(c, ws, 'dwindle', GEOM[1], 0), null);
});

test('moveWindowToGroup: leaves the old tree, joins the new one, goes last, the workspace retiles', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0), c = W('c', ws, 1);
  const { self, retiles } = groupSelf(ws, [a, b, c]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, leaf(c));
  a._mon = 1;
  assert.equal(self.monitors.moveWindowToGroup(a, 'DP-2', 'monitor'), true);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  assert.deepEqual(treeWins(self, ws, 0), [b]);
  assert.deepEqual(treeWins(self, ws, 1).sort(byTitle), [a, c]);
  assert.deepEqual(self._workspaceOrders.get(ws), [b, c, a]);
  assert.deepEqual(retiles, [ws]);
  assert.equal(self.monitors.moveWindowToGroup(a, 'DP-2', 'monitor'), false, 'same group: nothing to do');
  assert.deepEqual(retiles, [ws]);
  // Into a monitor that does not tile: no tree there.
  self.monitors.invalidate();
  self._mutterSettings = { get_boolean: () => true };
  b._mon = 1;
  self.monitors.moveWindowToGroup(b, 'DP-2', 'monitor');
  assert.deepEqual(treeWins(self, ws, 1).sort(byTitle), [a, c]);
});

test('onWindowEnteredMonitor: regroups, except mid-drag, in transit, or off a removed monitor', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  let regroups = 0;
  const { self } = groupSelf(ws, [a, b], { _scheduleRegroup: () => regroups++ });
  a._mon = 1;
  // Any grab (mouse-resize off: Plaid does not track it, _grabOp stays null).
  self._grabbedWindow = a;
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-1', 'the grab end decides');
  self._grabbedWindow = null;
  self.monitors.onWindowEnteredMonitor(a, -1);
  assert.equal(self.monitors.windowConn(a), 'DP-1', 'in transit');
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  // b's monitor goes away: mutter moves it before monitors-changed.
  self._windowMonitors.set(b, 'HDMI-9');
  self.monitors.onWindowEnteredMonitor(b, 0);
  assert.equal(self.monitors.windowConn(b), 'HDMI-9');
  assert.equal(regroups, 1);
  // Not ours (never managed), or shutting down: nothing.
  const x = W('x', ws, 0);
  self.monitors.onWindowEnteredMonitor(x, 1);
  assert.equal(self._windowMonitors.has(x), false);
  self._shuttingDown = true;
  self.monitors.onWindowEnteredMonitor(a, 0);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
});

test('hotplug: a removed monitor\'s windows join their new monitor, its arrangement and layout stay', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0), c = W('c', ws, 0);
  const { self, retiles } = groupSelf(ws, [a, b, c]);
  let saves = 0;
  self.persistence.scheduleSaveLayouts = () => saves++;
  // b and c were on HDMI-9 (now unplugged); mutter put them on DP-1.
  self._windowMonitors.set(b, 'HDMI-9');
  self._windowMonitors.set(c, 'HDMI-9');
  self._bspTrees.set(self.monitors.groupObjFor(ws, 'HDMI-9'), split('h', 0.7, leaf(b), leaf(c)));
  self.bsp.bspSetTree(ws, 0, leaf(a));
  self._workspaceLayouts.set('1@HDMI-9', 'dwindle');
  self._workspaceLayouts.set('2@HDMI-9', 'master-stack');
  const ws2 = global.workspace_manager.get_workspace_by_index(2);
  self._bspTrees.set(self.monitors.groupObjFor(ws2, 'HDMI-9'), split('v', 0.4, leaf({}), leaf({})));
  self.monitors.regroupWindows('hotplug');
  assert.equal(self.monitors.windowConn(b), 'DP-1');
  assert.equal(self.monitors.windowConn(c), 'DP-1');
  assert.equal(treeWins(self, ws, 0).length, 3);
  assert.equal(self._persistedDwindleRaw.get('1@HDMI-9'), 'h0.7000(l,l)');
  assert.equal(self._persistedDwindleByIndex.get('1@HDMI-9').ratio, 0.7);
  assert.equal(self._workspaceLayouts.get('2@HDMI-9'), 'master-stack', 'kept for its return');
  assert.equal(self._persistedDwindleRaw.has('2@HDMI-9'), false, 'a master-stack group has no dwindle shape');
  assert.equal(saves, 1);
  assert.ok(retiles.length > 0);
});

test('drop on another monitor: onto a window it splits that leaf, onto an empty monitor it fills it', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0, { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', ws, 0, { x: 500, y: 0, width: 500, height: 500 });
  const c = W('c', ws, 1, { x: 1000, y: 0, width: 400, height: 500 });
  const d = W('d', ws, 1, { x: 1400, y: 0, width: 400, height: 500 });
  const { self, retiles } = groupSelf(ws, [a, b, c, d]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, split('h', 0.6, leaf(c), leaf(d)));
  // The preview is the target's slot, as within a monitor.
  const plan = self.dragPreview.crossDropPlan(b, ws, 1, 1200, 250);
  assert.deepEqual(plan.rect, { x: 1000, y: 0, w: 480, h: 500 });
  assert.equal(treeWins(self, ws, 1).length, 2, 'the plan changes nothing');
  self.windows.dropOnGroup(b, ws, 1, 1200, 250);
  assert.equal(self.monitors.windowConn(b), 'DP-2');
  const t1 = self.bsp.bspGetTree(ws, 1);
  // c (480x500) splits stacked, b below it, at the target's own ratio.
  assert.deepEqual(self.bsp.bspCollectWindows(t1.first), [c, b]);
  assert.equal(t1.first.direction, 'v');
  assert.equal(t1.first.ratio, 0.6);
  assert.equal(t1.second.window, d);
  assert.deepEqual(treeWins(self, ws, 0), [a]);
  assert.deepEqual(retiles, [ws]);
  // Monitor 1 emptied, then a dropped onto it.
  for (const w of [b, c, d]) {
    self.monitors.removeFromGroupTree(w, ws, 'DP-2');
    self._windowMonitors.set(w, 'DP-1');
  }
  assert.equal(self.dragPreview.crossDropPlan(a, ws, 1, 500, 100), null, 'the pointer is not on monitor 1');
  assert.deepEqual(self.dragPreview.crossDropPlan(a, ws, 1, 1100, 100), { rect: { x: 1000, y: 0, w: 800, h: 500 } });
  self.windows.dropOnGroup(a, ws, 1, 1100, 100);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  assert.equal(self.bsp.bspGetTree(ws, 1).window, a);
});

test('swapAcrossGroups: the two windows trade leaves, order slots and monitors', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0), c = W('c', ws, 1), d = W('d', ws, 1);
  const { self } = groupSelf(ws, [a, b, c, d]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, split('h', 0.5, leaf(c), leaf(d)));
  const st = { win: b };
  self._animStates = [st];
  b._plaidTickSent = { at: Date.now(), sentAt: [], end: [0, 0, 1, 1] };
  self.monitors.swapAcrossGroups(ws, b, c);
  assert.deepEqual(treeWins(self, ws, 0), [a, c]);
  assert.deepEqual(treeWins(self, ws, 1), [b, d]);
  assert.deepEqual([self.monitors.windowConn(b), self.monitors.windowConn(c)], ['DP-2', 'DP-1']);
  assert.deepEqual(self._workspaceOrders.get(ws), [a, c, b, d]);
  assert.equal(st.regrouped, true, 'the swap goes through the same group record');
  assert.equal(b._plaidTickSent, null);
});

function edgeSelf(extra = {}) {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0, { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', ws, 0, { x: 500, y: 0, width: 500, height: 500 });
  const c = W('c', ws, 1, { x: 1000, y: 0, width: 800, height: 500 });
  global.display.focus_window = b;
  let activated = null;
  for (const w of [a, b, c]) w.activate = () => { activated = w; };
  GLib.idle_add = () => 0;
  const r = groupSelf(ws, [a, b, c], { _cursorWarpDeferred: () => {}, ...extra });
  r.self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  r.self.bsp.bspSetTree(ws, 1, leaf(c));
  return { ...r, ws, a, b, c, activated: () => activated };
}

test('focus and swap cross the monitor edge', () => {
  const { self, retiles, ws, a, b, c, activated } = edgeSelf();
  self.actions.moveFocus('right');
  assert.equal(activated(), c);
  self.actions.swapWindow('right');
  assert.deepEqual(treeWins(self, ws, 0), [a, c]);
  assert.equal(self.bsp.bspGetTree(ws, 1).window, b);
  assert.deepEqual([self.monitors.windowConn(b), self.monitors.windowConn(c)], ['DP-2', 'DP-1']);
  assert.deepEqual(retiles, [ws]);
});

test('swap: not into a monitor with the floating layout, nor one that does not tile', () => {
  const floating = edgeSelf();
  floating.self._workspaceLayouts.set('1@DP-2', 'floating');
  floating.self.actions.swapWindow('right');
  assert.deepEqual([floating.self.monitors.windowConn(floating.b), floating.self.monitors.windowConn(floating.c)], ['DP-1', 'DP-2']);
  assert.deepEqual(floating.retiles, []);
  const untiled = edgeSelf({ _mutterSettings: { get_boolean: () => true } });
  untiled.self.actions.swapWindow('right');
  assert.deepEqual([untiled.self.monitors.windowConn(untiled.b), untiled.self.monitors.windowConn(untiled.c)], ['DP-1', 'DP-2']);
  assert.deepEqual(untiled.retiles, []);
});

test('swap and resize of a window on a monitor that does not tile: as on a floating layout', () => {
  const { self, retiles, b, c } = edgeSelf({ _mutterSettings: { get_boolean: () => true } });
  global.display.focus_window = c;
  const moved = [];
  self.actions.moveFloating = (w, d) => moved.push([w, d]);
  self.actions.resizeFloating = (w, axis) => moved.push([w, axis]);
  self.actions.swapWindow('left');
  self.actions.resizeWindow('grow', 'width');
  assert.deepEqual(moved, [[c, 'left'], [c, 'width']]);
  assert.deepEqual([self.monitors.windowConn(b), self.monitors.windowConn(c)], ['DP-1', 'DP-2']);
  assert.deepEqual(retiles, []);
  // Tiled again there: no tree takes it.
  self.bsp.bspSetTree(self._windowWorkspaces.get(c), 1, null);
  self._toggleFloatWindows.add(c);
  self.actions.toggleFloat();
  assert.equal(self.bsp.bspGetTree(self._windowWorkspaces.get(c), 1), null);
});

test('cycleLayout: only the focused monitor\'s layout changes, its popup on that monitor', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), c = W('c', ws, 1);
  global.display.focus_window = c;
  const shown = [];
  const { self, retiles } = groupSelf(ws, [a, c], { _showPopup: (...args) => shown.push(args) });
  self.actions.cycleLayout();
  assert.equal(self.windows.getWorkspaceLayout(ws, 1), 'spiral');
  assert.equal(self.windows.getWorkspaceLayout(ws, 0), 'dwindle');
  assert.deepEqual([...self._workspaceLayouts], [['1@DP-2', 'spiral']]);
  assert.equal(shown[0][4], 1);
  global.display.focus_window = a;
  self.actions.cycleLayout();
  assert.deepEqual([...self._workspaceLayouts].sort(), [[1, 'spiral'], ['1@DP-2', 'spiral']]);
  assert.equal(shown[1][4], 0);
  assert.equal(retiles.length, 2);
  // No focus: the pointer's monitor.
  global.display.focus_window = null;
  global.display.get_current_monitor = () => 1;
  self.actions.cycleLayout();
  assert.equal(self.windows.getWorkspaceLayout(ws, 1), 'master-stack');
});

test('maybeReassertSlot: a window already on another monitor is not pulled back', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self, retiles } = groupSelf(ws, [a, b]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspTagGeometry(self.bsp.bspGetTree(ws, 0), 0, 0, 1000, 500, 0);
  // mutter moved it (frame on DP-2) before window-entered-monitor.
  a._frame = { x: 1000, y: 0, width: 800, height: 500 };
  self.grab.maybeReassertSlot(a);
  assert.deepEqual(retiles, []);
  // Off its slot on its own monitor: re-asserted.
  a._frame = { x: 10, y: 0, width: 300, height: 500 };
  self._slotReassertTimes.clear();
  self.grab.maybeReassertSlot(a);
  assert.deepEqual(retiles, [ws]);
});

test('grab end: a window left on another monitor joins it (float, untracked grab); other grabs leave it', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0), f = W('f', ws, 0);
  let regroups = 0;
  const { self, retiles } = groupSelf(ws, [a, b, f], { _scheduleRegroup: () => regroups++ });
  self._toggleFloatWindows.add(f);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  // mouse-resize off: Plaid does not track the grab (_grabOp stays null).
  for (const w of [f, b]) {
    self.grab.onGrabOpBegin(w, 1);
    assert.equal(self._grabOp, null);
    w._mon = 1;
    self.monitors.onWindowEnteredMonitor(w, 1);
    assert.equal(self.monitors.windowConn(w), 'DP-1', 'not mid-grab');
    self.grab.onGrabOpEnd(w, 1);
    assert.equal(self.monitors.windowConn(w), 'DP-2');
    assert.equal(self._grabbedWindow, null);
  }
  assert.deepEqual(treeWins(self, ws, 0), [a]);
  assert.deepEqual(treeWins(self, ws, 1), [b], 'the tiled one joins the layout there');
  assert.equal(retiles.length, 2);
  // A grab of another window ends: nothing to do for a.
  self.grab.onGrabOpBegin(b, 1);
  self.monitors.regroupAfterGrab(a);
  assert.equal(self._grabbedWindow, b);
  // Its monitor went away mid-drag and it is nowhere yet: the regroup takes it.
  self._windowMonitors.set(a, 'HDMI-9');
  a._mon = -1;
  self.grab.onGrabOpBegin(a, 1);
  self.grab.onGrabOpEnd(a, 1);
  assert.equal(regroups, 1);
});

test('regroupWindows: a window being dragged waits for its grab end', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 1), b = W('b', ws, 1);
  const { self } = groupSelf(ws, [a, b]);
  self._windowMonitors.set(a, 'DP-1');
  self._windowMonitors.set(b, 'DP-1');
  self._grabbedWindow = a;
  self.monitors.regroupWindows('hotplug');
  assert.deepEqual([self.monitors.windowConn(a), self.monitors.windowConn(b)], ['DP-1', 'DP-2']);
});

test('own animation vs a real move: only positions the configure ticks sent are ignored', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  // A run moving a to a slot on DP-1 passes over DP-2 (late commit).
  const run = { targetX: 10, targetY: 0, targetW: 300, targetH: 500 };
  self.placement.tickConfigure(a, 1100, 0, 300, 500, run);
  self.placement.tickConfigure(a, 10, 0, 300, 500, run);
  a._frame = { x: 1100, y: 0, width: 300, height: 500 };
  a._mon = 1;
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-1');
  // mutter moves it (a position the ticks never sent) mid-run: it regroups
  // and the run leaves it alone.
  const st = { win: a };
  self._animStates = [st];
  a._frame = { x: 1200, y: 0, width: 300, height: 500 };
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  assert.equal(st.regrouped, true);
  assert.equal(a._plaidTickSent, null);
});

test('tick record: a window still serializes (the landing diagnostic prints its tree)', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  const st = { win: a, targetX: 0, targetY: 0, targetW: 500, targetH: 500 };
  self.placement.tickConfigure(a, 0, 0, 500, 500, st);
  assert.doesNotThrow(() => JSON.stringify(self.bsp.bspGetTree(ws, 0)));
});

test('own animation vs a real move: a move back to where the run started is the user\'s', () => {
  stubGlobal({ conns: ['DP-1', 'DP-2', 'DP-3'] });
  const ws = global.workspace_manager.get_workspace_by_index(1);
  const a = W('a', ws, 1), b = W('b', ws, 2);
  const { self } = groupSelf(ws, [a, b]);
  self.monitors.swapAcrossGroups(ws, a, b);
  assert.equal(self.monitors.windowConn(a), 'DP-3');
  const run = { targetX: 1800, targetY: 0, targetW: 800, targetH: 500 };
  for (const x of [1200, 1600, 1800]) self.placement.tickConfigure(a, x, 0, 800, 500, run);
  // Super+Shift+Left within the settle time: mutter keeps the work-area
  // offset, so the frame lands on the run's start.
  a._frame = { x: 1000, y: 0, width: 800, height: 500 };
  a._mon = 1;
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  // A fresh run: the positions of the run before it are not its own.
  self._windowMonitors.set(a, 'DP-3');
  for (const x of [1200, 1600, 1800]) self.placement.tickConfigure(a, x, 0, 800, 500, run);
  a._frame = { x: 1800, y: 0, width: 800, height: 500 };
  self.placement.tickConfigure(a, 1850, 0, 800, 500, { targetX: run.targetX, targetY: run.targetY, targetW: run.targetW, targetH: run.targetH });
  a._frame = { x: 1200, y: 0, width: 800, height: 500 };
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
});

test('three monitors: our own run crossing the middle monitor does not regroup', () => {
  stubGlobal({ conns: ['DP-1', 'DP-2', 'DP-3'] });
  const ws = global.workspace_manager.get_workspace_by_index(1);
  const a = W('a', ws, 2), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  const run = { targetX: 1900, targetY: 0, targetW: 600, targetH: 500 };
  // A swap sent it from DP-1 to a slot on DP-3; this tick lies over DP-2.
  a._frame = { x: 900, y: 0, width: 300, height: 500 };
  self.placement.tickConfigure(a, 1100, 0, 300, 500, run);
  a._mon = 1;
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-3', 'passing over DP-2');
  // mutter emits window-entered-monitor inside the configure itself, on the
  // run's first tick too (nothing recorded before it).
  a._plaidTickSent = null;
  a._frame = { x: 900, y: 0, width: 300, height: 500 };
  a.move_resize_frame = (_u, x, y, width, height) => {
    a._frame = { x, y, width, height };
    a._mon = 1;
    self.monitors.onWindowEnteredMonitor(a, 1);
  };
  const run2 = { targetX: run.targetX, targetY: run.targetY, targetW: run.targetW, targetH: run.targetH };
  self.placement.tickConfigure(a, 1100, 0, 300, 500, run2);
  assert.equal(self.monitors.windowConn(a), 'DP-3', 'first tick over DP-2');
  // mutter clamps the frame's height to the monitor it is over: still ours.
  a.move_resize_frame = (_u, x, y, width, height) => {
    a._frame = { x, y, width, height: Math.min(height, 400) };
    self.monitors.onWindowEnteredMonitor(a, 1);
  };
  self.placement.tickConfigure(a, 1150, 0, 300, 500, run2);
  assert.equal(self.monitors.windowConn(a), 'DP-3', 'size clamped by mutter');
  // A lagging client still at the run's start on the next tick: that frame
  // is not one the ticks sent, so a user move landing there is the user's.
  a.move_resize_frame = (_u, x, y, width, height) => { a._frame = { x, y, width, height }; };
  const run3 = { targetX: 1900, targetY: 0, targetW: 600, targetH: 500 };
  a._frame = { x: 900, y: 0, width: 300, height: 500 };
  self.placement.tickConfigure(a, 1100, 0, 300, 500, run3);
  a._frame = { x: 900, y: 0, width: 300, height: 500 };
  self.placement.tickConfigure(a, 1300, 0, 300, 500, run3);
  assert.deepEqual(a._plaidTickSent.sentAt, ['1100,0', '1300,0']);
  a._frame = { x: 900, y: 0, width: 300, height: 500 };
  self.monitors.onWindowEnteredMonitor(a, 0);
  assert.equal(self.monitors.windowConn(a), 'DP-1', 'the start frame is not ours');
  self._windowMonitors.set(a, 'DP-3');
  a.move_resize_frame = (_u, x, y, width, height) => { a._frame = { x, y, width, height }; };
  // A position the ticks never sent: mutter moved it.
  a._frame = { x: 1200, y: 40, width: 300, height: 400 };
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  // The ticks' frame, but their run does not end on its group's monitor:
  // something regrouped it since, so the frame is mutter's answer.
  self._windowMonitors.set(a, 'DP-3');
  self.placement.tickConfigure(a, 1100, 0, 300, 500, run2);
  self._windowMonitors.set(a, 'DP-1');
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  // A frame the ticks sent long ago: not a run in flight any more.
  self._windowMonitors.set(a, 'DP-3');
  self.placement.tickConfigure(a, 1100, 0, 300, 500, run2);
  a._plaidTickSent.at = 0;
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
});

test('a tick run leaves a window that changed monitor mid-run where mutter put it', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0, { x: 0, y: 0, width: 300, height: 500 });
  const b = W('b', ws, 0, { x: 300, y: 0, width: 700, height: 500 });
  for (const w of [a, b]) w.get_compositor_private = () => ({});
  let tick = null;
  const orig = GLib.timeout_add;
  GLib.timeout_add = (_p, _ms, fn) => { tick = fn; return 1; };
  try {
    const { self } = groupSelf(ws, [a, b], { _getAnimationTime: () => 0.1, _verifyAnimationLanding: () => {} });
    self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
    self.placement.animRetile(ws, [{ mon: 0, tiled: [a, b], layout: 'dwindle', places: true }]);
    assert.ok(tick, 'a tick run started');
    // Super+Shift+Right mid-run: mutter moves a, the group follows.
    a._frame = { x: 1100, y: 0, width: 300, height: 500 };
    a._mon = 1;
    self.monitors.onWindowEnteredMonitor(a, 1);
    assert.equal(self.monitors.windowConn(a), 'DP-2');
    self._animStartTime = 0; // the run is over: last tick
    tick();
    assert.deepEqual(a._frame, { x: 1100, y: 0, width: 300, height: 500 }, 'not pulled back');
    assert.deepEqual(b._frame, { x: 500, y: 0, width: 500, height: 500 });
  } finally {
    GLib.timeout_add = orig;
  }
});

test('animRetile: every group is laid out on its own monitor in one run', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), c = W('c', ws, 1), d = W('d', ws, 1);
  for (const w of [a, c, d]) w.get_compositor_private = () => ({});
  let tick = null;
  const orig = GLib.timeout_add;
  GLib.timeout_add = (_p, _ms, fn) => { tick = fn; return 1; };
  try {
    const { self } = groupSelf(ws, [a, c, d], { _getAnimationTime: () => 0.1, _verifyAnimationLanding: () => {} });
    self._workspaceLayouts.set('1@DP-2', 'master-stack');
    self.layouts.doRetileWorkspace(ws);
    self._animStartTime = 0;
    tick();
    assert.deepEqual(a._frame, { x: 0, y: 0, width: 1000, height: 500 });
    assert.deepEqual(c._frame, { x: 1000, y: 0, width: 400, height: 500 });
    assert.deepEqual(d._frame, { x: 1400, y: 0, width: 400, height: 500 });
    // Our own ticks: each window's record ends on its own monitor.
    assert.deepEqual(d._plaidTickSent.end, [1400, 0, 400, 500]);
  } finally {
    GLib.timeout_add = orig;
  }
});

test('retileDwindle and retile: each group keeps its own tree; a monitor whose work area is not ready waits', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0), c = W('c', ws, 1), d = W('d', ws, 1);
  const { self } = groupSelf(ws, [a, b, c, d]);
  self._animTargets = new Map();
  self.layouts.retileDwindle(ws, [a, b], 0);
  self.layouts.retileDwindle(ws, [c, d], 1);
  assert.deepEqual(treeWins(self, ws, 0), [a, b]);
  assert.deepEqual(treeWins(self, ws, 1), [c, d]);
  assert.deepEqual(self._animTargets.get(d), { x: 1400, y: 0, w: 400, h: 500 });
  // Monitor 1's work area mid-hotplug: only monitor 0 is laid out.
  self._animTargets = null;
  ws.get_work_area_for_monitor = (m) => (m === 1 ? { x: 1000, y: 0, width: 1, height: 1 } : { ...GEOM[m] });
  const runs = [];
  self.placement.animRetile = (_w, groups) => runs.push(groups.map(g => g.mon));
  self._getAnimationTime = () => 0.1;
  self.placement.getAnimationTime = () => 0.1;
  self.layouts.doRetileWorkspace(ws);
  assert.deepEqual(runs, [[0]]);
});

test('bspInsertForWorkspace: a new window on another monitor splits the leaf under the pointer there', () => {
  const [, ws] = stubGlobal({ pointer: [1200, 250] });
  const c = W('c', ws, 1), d = W('d', ws, 1), x = W('x', ws, 1);
  const { self } = groupSelf(ws, [c, d, x]);
  self.bsp.bspSetTree(ws, 1, split('h', 0.5, leaf(c), leaf(d)));
  self.bsp.bspInsertForWorkspace(ws, x, 1);
  const t = self.bsp.bspGetTree(ws, 1);
  assert.deepEqual(self.bsp.bspCollectWindows(t.first), [c, x]);
  assert.equal(t.second.window, d);
});

test('addWindow: a window joins the group of the monitor it opens on (the primary while it has none)', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 1), b = W('b', ws, -1);
  const { self } = groupSelf(ws, []);
  for (const w of [a, b]) w.connectObject = () => 1;
  self.windows.addWindow(a, true);
  self.windows.addWindow(b, true);
  assert.deepEqual([self.monitors.windowConn(a), self.monitors.windowConn(b)], ['DP-2', 'DP-1']);
  assert.deepEqual(treeWins(self, ws, 1), [a]);
  assert.deepEqual(treeWins(self, ws, 0), [b]);
});

test('drop over a floating or an untiled monitor: it goes there, nothing lays it out', () => {
  const [, ws] = stubGlobal({ pointer: [1600, 250] });
  const a = W('a', ws, 0), b = W('b', ws, 0), d = W('d', ws, 1);
  const { self } = groupSelf(ws, [a, b, d]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, leaf(d));
  self._workspaceLayouts.set('1@DP-2', 'floating');
  assert.deepEqual(self.dragPreview.crossDropPlan(a, ws, 1, 1600, 250), {});
  self.windows.repositionWindow(a, ws);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  assert.deepEqual(treeWins(self, ws, 1), [d]);
  // Workspaces only on the primary: monitor 1 does not tile at all.
  self._workspaceLayouts.delete('1@DP-2');
  self._mutterSettings = { get_boolean: () => true };
  self.monitors.invalidate();
  self.windows.repositionWindow(b, ws);
  assert.equal(self.monitors.windowConn(b), 'DP-2');
  assert.deepEqual(treeWins(self, ws, 1), [d]);
});

test('save: a primary change since the last save moves the single-monitor keys to the new primary', () => {
  const [, ws] = stubGlobal({ primary: 1 });
  const a = W('a', ws, 0), c = W('c', ws, 1);
  const { self } = groupSelf(ws, [a, c]);
  self._keyedPrimary = 'DP-1';
  self._settings = recSettings();
  self._workspaceLayouts = new Map([[1, 'floating'], ['1@DP-2', 'master-stack']]);
  self.persistence.savePersistedLayouts();
  const v = self._settings.v;
  assert.equal(v['monitor-primary-connector'], 'DP-2');
  assert.deepEqual(v['workspace-layouts'], ['1:master-stack', '2:dwindle']);
  assert.ok(v['monitor-workspace-layouts'].includes('DP-1:1:floating'));
});

test('connectors: a lookup missing a monitor holds until the next change; the full one regroups', () => {
  stubGlobal({ conns: ['DP-1', ''] });
  let regroups = 0, lookups = 0;
  const count = () => {
    const mm = global.backend.get_monitor_manager;
    global.backend.get_monitor_manager = () => { lookups++; return mm(); };
  };
  count();
  const self = makeSelf({}, { _scheduleRegroup: () => regroups++ });
  assert.equal(self.monitors.monConn(1), '#1');
  assert.equal(self.monitors.monConn(1), '#1');
  assert.equal(lookups, 1, 'not re-queried on every call');
  stubGlobal();
  count();
  assert.equal(self.monitors.monConn(1), '#1', 'until the monitors change');
  self.monitors.invalidate();
  assert.equal(self.monitors.monConn(1), 'DP-2');
  assert.equal(regroups, 1);
  self.monitors.invalidate();
  assert.equal(self.monitors.monConn(1), 'DP-2');
  assert.equal(regroups, 1);
  // Its "#1" windows are then off a missing monitor: the regroup moves them.
  assert.equal(self.monitors.connMon('#1'), -1);
});

test('syncKeyedPrimary: a primary keyed by index while unnamed keeps its keys once named', () => {
  const [, ws] = stubGlobal({ conns: ['', 'DP-2'] });
  const a = W('a', ws, 0);
  const { self } = groupSelf(ws, [a], { _scheduleRegroup: () => {} });
  assert.equal(self.monitors.keyedPrimaryConn(), '#0');
  self._windowMonitors.set(a, '#0');
  self._workspaceLayouts.set(1, 'master-stack');
  const tree = leaf(a);
  self._bspTrees.set(ws, tree);
  globalThis.global.backend = stubGlobalBackend(['DP-1', 'DP-2']);
  self.monitors.invalidate();
  assert.equal(self.monitors.syncKeyedPrimary(), true);
  assert.equal(self.monitors.keyedPrimaryConn(), 'DP-1');
  assert.deepEqual([...self._workspaceLayouts], [[1, 'master-stack']]);
  assert.equal(self.monitors.windowConn(a), 'DP-1');
  assert.equal(self.bsp.bspGetTree(ws, 0), tree);
});

function stubGlobalBackend(conns) {
  return {
    get_monitor_manager: () => ({
      get_logical_monitors: () => conns.map((c, i) => ({
        get_number: () => i,
        get_monitors: () => [{ get_connector: () => c }],
      })),
    }),
  };
}

// A drag (stubs for the drag state).
function dragSelf(ws, wins, extra = {}) {
  const shown = [];
  const r = groupSelf(ws, wins, {
    _showDropPreview: (x, y, w, h) => shown.push({ x, y, w, h }),
    _hideDropPreview: () => shown.push(null),
    ...extra,
  });
  r.self.grab.movedPastGrace = () => true;
  return { ...r, shown };
}

test('drag the only window of a monitor onto an empty monitor: preview and drop fill it', () => {
  const [, ws] = stubGlobal({ pointer: [1400, 250] });
  const a = W('a', ws, 0);
  const { self, shown } = dragSelf(ws, [a]);
  self.bsp.bspSetTree(ws, 0, leaf(a));
  self.dragPreview.updateMoveDragPreview(a);
  assert.deepEqual(shown.at(-1), { x: 1000, y: 0, w: 800, h: 500 });
  self.windows.repositionWindow(a, ws);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  assert.equal(self.bsp.bspGetTree(ws, 1).window, a);
});

test('drag preview over another monitor uses that monitor\'s tree', () => {
  const [, ws] = stubGlobal({ pointer: [200, 250] });
  const a = W('a', ws, 0, { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', ws, 0, { x: 500, y: 0, width: 500, height: 500 });
  const c = W('c', ws, 1, { x: 1000, y: 0, width: 400, height: 500 });
  const d = W('d', ws, 1, { x: 1400, y: 0, width: 400, height: 500 });
  const { self, shown } = dragSelf(ws, [a, b, c, d]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, split('h', 0.5, leaf(c), leaf(d)));
  self.dragPreview.updateMoveDragPreview(b);
  assert.deepEqual(shown.at(-1), { x: 0, y: 0, w: 500, h: 500 }, 'b over a');
  global.get_pointer = () => [1600, 250, 0];
  self.dragPreview.updateMoveDragPreview(b);
  assert.deepEqual(shown.at(-1), { x: 1400, y: 0, w: 400, h: 500 }, 'b over d on monitor 1');
  // Over a monitor that does not tile: no preview (the drop moves it there untiled).
  self._mutterSettings = { get_boolean: () => true };
  self.monitors.invalidate();
  self.dragPreview.updateMoveDragPreview(b);
  assert.equal(shown.at(-1), null);
});

test('master-stack drop on another monitor lands before the window under the pointer', () => {
  for (const layout of ['master-stack', 'centered-master-stack']) {
    const [, ws] = stubGlobal();
    const a = W('a', ws, 0), c = W('c', ws, 1), d = W('d', ws, 1), e = W('e', ws, 1);
    const { self, shown } = dragSelf(ws, [a, c, d, e]);
    self._workspaceLayouts.set('1@DP-2', layout);
    // master c; flat stack d, e on the right / centered: d left, e right.
    const px = layout === 'master-stack' ? 1700 : 1050;
    global.get_pointer = () => [px, 100, 0];
    self.dragPreview.updateMoveDragPreview(a);
    assert.equal(shown.at(-1).x, layout === 'master-stack' ? 1400 : 1000, layout);
    self.windows.repositionWindow(a, ws);
    assert.equal(self.monitors.windowConn(a), 'DP-2', layout);
    assert.deepEqual(self.monitors.getWindowsForGroup(ws, 1), [c, a, d, e], layout);
  }
});

test('same-monitor master-stack drop counts only that monitor\'s windows', () => {
  const [, ws] = stubGlobal({ pointer: [750, 100] });
  const c = W('c', ws, 1), a = W('a', ws, 0), b = W('b', ws, 0), d = W('d', ws, 0);
  const { self } = dragSelf(ws, [c, a, b, d]);
  self._workspaceLayouts.set(1, 'master-stack');
  // d dropped on b's stack slot (index 1 of a, b, d).
  self.windows.repositionWindow(d, ws);
  assert.deepEqual(self.monitors.getWindowsForGroup(ws, 0), [a, d, b]);
  assert.deepEqual(self.monitors.getWindowsForGroup(ws, 1), [c]);
});

test('resize acts on the focused window\'s monitor only', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0), c = W('c', ws, 1);
  global.display.focus_window = a;
  const lone = groupSelf(ws, [a, c], { _cursorWarpDeferred: () => {} });
  lone.self._settings = { ...lone.self._settings, get_int: (k) => (k === 'resize-amount' ? 450 : 0), get_string: () => 'master-stack' };
  lone.self.actions.resizeWindow('grow', 'width');
  assert.equal(lone.self._masterRatios.size, 0, 'a lone window on its monitor: nothing to resize');
  assert.deepEqual(lone.retiles, [], 'nor to retile');
  const { self } = groupSelf(ws, [a, c, b]);
  self._workspaceLayouts.set(1, 'master-stack');
  self.layouts.resizeMasterStack(a, ws, 'width', 450, 0);
  // One stack window on monitor 0: the master may grow to 1000 - 100.
  assert.equal(self._masterRatios.get(1), 0.9);
  assert.equal(self._masterRatios.has('1@DP-2'), false);
});

test('workspace popup: the focused monitor\'s layout, on that monitor', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), c = W('c', ws, 1);
  global.display.focus_window = c;
  const shown = [];
  const { self } = groupSelf(ws, [a, c], { _showPopup: (...args) => shown.push(args) });
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  self.workspaces.showWorkspacePopup(ws);
  assert.equal(shown[0][1], 'Layout: Master-stack');
  assert.equal(shown[0][4], 1);
});

test('grab end keeps the drop\'s monitor (the pointer\'s), whatever the frame overlaps most', () => {
  const [, ws] = stubGlobal({ pointer: [1050, 250] });
  const a = W('a', ws, 0, { x: 0, y: 0, width: 500, height: 500 });
  const b = W('b', ws, 0, { x: 500, y: 0, width: 500, height: 500 });
  const c = W('c', ws, 1);
  const { self } = dragSelf(ws, [a, b, c]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, leaf(c));
  // Dragged by the right end of its titlebar: frame 600..1100, mostly on DP-1.
  self.grab.onGrabOpBegin(a, 1);
  a._frame = { x: 600, y: 0, width: 500, height: 500 };
  self.windows.repositionWindow(a, ws);
  assert.equal(self.monitors.windowConn(a), 'DP-2', 'drop');
  self.monitors.regroupAfterGrab(a);
  assert.equal(self.monitors.windowConn(a), 'DP-2', 'the grab end does not undo the drop');
  assert.deepEqual(self.monitors.getWindowsForGroup(ws, 0), [b]);
  // The reverse: dropped on DP-1 (pointer) with the frame mostly over DP-2.
  global.get_pointer = () => [950, 250, 0];
  self.grab.onGrabOpBegin(b, 1);
  b._frame = { x: 900, y: 0, width: 500, height: 500 };
  b._mon = 1;
  self.windows.repositionWindow(b, ws);
  self.monitors.regroupAfterGrab(b);
  assert.equal(self.monitors.windowConn(b), 'DP-1');
  // No slot under the pointer there: it still joins that monitor.
  self.dragPreview.crossDropPlan = () => null;
  self.windows.dropOnGroup(b, ws, 1, 1400, 250);
  assert.equal(self.monitors.windowConn(b), 'DP-2');
  // Over a monitor that does not tile (workspaces only on the primary): it
  // goes there, untiled.
  self._mutterSettings = { get_boolean: () => true };
  self.monitors.invalidate();
  self.grab.onGrabOpBegin(c, 1);
  global.get_pointer = () => [1400, 250, 0];
  self._windowMonitors.set(c, 'DP-1');
  self.windows.repositionWindow(c, ws);
  self.monitors.regroupAfterGrab(c);
  assert.equal(self.monitors.windowConn(c), 'DP-2');
});

test('drag-scroll carry: the window lands in the group of the monitor it is dropped on', () => {
  const [, ws1, ws2] = stubGlobal({ pointer: [1400, 250] });
  const a = W('a', ws1, 1), b = W('b', ws1, 1), c = W('c', ws2, 0);
  const { self } = dragSelf(ws1, [a, b]);
  self._windowWorkspaces.set(c, ws2);
  self._windowWSIndices.set(c, 2);
  self._windowMonitors.set(c, 'DP-1');
  self._workspaceOrders.set(ws2, [c]);
  self.bsp.bspSetTree(ws1, 1, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws2, 0, leaf(c));
  // workspace-changed (the carry): a leaves ws1's DP-2 tree at once.
  const handlers = {};
  a.connectObject = (name, cb) => { handlers[name] = cb; return 1; };
  self.signals.connectObject = (emitter, name, cb) => { if (emitter === a) handlers[name] = cb; return 1; };
  self.windows.connectObject = (emitter, name, cb) => { if (emitter === a) handlers[name] = cb; return 1; };
  a._plaidSignalsConnected = false;
  self.windows.connectWindowSignals(a);
  self.grab.onGrabOpBegin(a, 1);
  a._ws = ws2;
  handlers['workspace-changed']();
  assert.deepEqual(treeWins(self, ws1, 1), [b]);
  assert.equal(self.monitors.windowConn(a), 'DP-2', 'the monitor stays');
  // Dropped with the pointer on DP-2: ws2's DP-2 group (empty) takes it.
  self.windows.repositionWindow(a, ws2);
  self.monitors.regroupAfterGrab(a);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  assert.deepEqual(self.monitors.getWindowsForGroup(ws2, 1), [a]);
  // Carried back and dropped over DP-1 there: it joins c's group.
  self.grab.onGrabOpBegin(a, 1);
  global.get_pointer = () => [200, 250, 0];
  self.windows.repositionWindow(a, ws2);
  self.monitors.regroupAfterGrab(a);
  assert.equal(self.monitors.windowConn(a), 'DP-1');
  assert.deepEqual(treeWins(self, ws2, 0).sort(byTitle), [a, c]);
});

test('removeWindow: a window closed mid-grab leaves no grab record, and leaves its group', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 1), b = W('b', ws, 1);
  const { self } = groupSelf(ws, [a, b]);
  self.bsp.bspSetTree(ws, 1, split('h', 0.5, leaf(a), leaf(b)));
  self.grab.onGrabOpBegin(a, 1);
  self.windows.removeWindow(a);
  assert.equal(self._grabbedWindow, null);
  assert.equal(self._windowMonitors.has(a), false);
  assert.equal(self.bsp.bspGetTree(ws, 1).window, b);
});

// Persistence: a settings stub that records writes and serves them back.
function recSettings(values = {}) {
  const v = { 'inside-gap': 0, layout: 'dwindle', ...values };
  return {
    v,
    get_int: (k) => v[k] ?? 0,
    get_double: (k) => v[k] ?? 0.5,
    get_boolean: (k) => v[k] ?? false,
    get_string: (k) => v[k] ?? '',
    get_strv: (k) => v[k] ?? [],
    set_strv: (k, x) => { v[k] = [...x]; },
    set_string: (k, x) => { v[k] = x; },
  };
}

test('persistence: the primary stays in the old keys, other monitors round-trip through the new ones', () => {
  const [, ws1] = stubGlobal();
  const a = W('a', ws1, 0), b = W('b', ws1, 0), c = W('c', ws1, 1), d = W('d', ws1, 1);
  const { self } = groupSelf(ws1, [a, b, c, d]);
  self._settings = recSettings();
  self._workspaceLayouts.set(2, 'master-stack');
  self._workspaceLayouts.set('1@DP-2', 'dwindle');
  self._workspaceLayouts.set('4@HDMI-9', 'floating'); // unplugged monitor: kept
  self._masterRatios.set('2@DP-2', 0.6);
  self._stackRatios.set('2@DP-2', new Map([[0, 1.0], [1, 0.8]]));
  self._persistedDwindleRaw.set('3@HDMI-9', 'h0.2500(l,l)');
  self.bsp.bspSetTree(ws1, 0, split('h', 0.6, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws1, 1, split('v', 0.3, leaf(c), leaf(d)));
  self.persistence.savePersistedLayouts();
  const v = self._settings.v;
  assert.deepEqual(v['workspace-layouts'], ['1:dwindle', '2:master-stack']);
  assert.deepEqual(v['workspace-dwindle-trees'], ['1:h0.6000(l,l)']);
  assert.equal(v['monitor-primary-connector'], 'DP-1');
  assert.deepEqual(v['monitor-workspace-layouts'], ['DP-2:1:dwindle', 'DP-2:2:dwindle', 'HDMI-9:4:floating']);
  assert.deepEqual(v['monitor-workspace-master-ratios'], ['DP-2:2:0.6']);
  assert.deepEqual(v['monitor-workspace-stack-ratios'], ['DP-2:2:0:1,1:0.8']);
  assert.deepEqual(v['monitor-workspace-dwindle-trees'], ['DP-2:1:v0.3000(l,l)', 'HDMI-9:3:h0.2500(l,l)']);
  // Nothing an older build could misread in the old keys.
  for (const k of ['workspace-layouts', 'workspace-master-ratios', 'workspace-stack-ratios', 'workspace-dwindle-trees'])
    assert.ok((v[k] ?? []).every(e => /^\d+:/.test(e) && !e.includes('@') && !/^\d+:\d+:[a-z]/.test(e)), k);
  assert.deepEqual([...self._persistedDwindleRaw].sort(), [[1, 'h0.6000(l,l)'], ['1@DP-2', 'v0.3000(l,l)'], ['3@HDMI-9', 'h0.2500(l,l)']].sort());

  const fresh = makeSelf({}, { _keyedPrimary: 'DP-1' });
  fresh._settings = recSettings(v);
  fresh.persistence.loadPersistedLayoutRules();
  assert.deepEqual([...fresh._persistedLayoutByIndex].sort(),
    [[1, 'dwindle'], [2, 'master-stack'], ['1@DP-2', 'dwindle'], ['2@DP-2', 'dwindle'], ['4@HDMI-9', 'floating']].sort());
  assert.equal(fresh._persistedMasterByIndex.get('2@DP-2'), 0.6);
  assert.deepEqual([...fresh._persistedStackByIndex.get('2@DP-2')], [[0, 1], [1, 0.8]]);
  assert.deepEqual([...fresh._persistedDwindleByIndex.keys()].sort(), [1, '1@DP-2', '3@HDMI-9'].sort());
  assert.equal(fresh._persistedDwindleByIndex.get('1@DP-2').ratio, 0.3);
});

test('persistence: older settings load for the primary, and follow the connector they were saved for', () => {
  stubGlobal();
  const older = { 'workspace-layouts': ['1:master-stack'], 'workspace-dwindle-trees': ['1:h0.7000(l,l)'] };
  const self = makeSelf({}, { _keyedPrimary: 'DP-1' });
  self._settings = recSettings(older);
  self.persistence.loadPersistedLayoutRules();
  assert.deepEqual([...self._persistedLayoutByIndex], [[1, 'master-stack']]);
  assert.deepEqual([...self._persistedDwindleByIndex.keys()], [1]);
  // Saved while DP-2 was primary: the old keys belong to DP-2, DP-1's own
  // entries come from the new key.
  const swapped = makeSelf({}, { _keyedPrimary: 'DP-1' });
  swapped._settings = recSettings({ ...older, 'monitor-primary-connector': 'DP-2',
    'monitor-workspace-layouts': ['DP-1:1:floating'] });
  swapped.persistence.loadPersistedLayoutRules();
  assert.deepEqual([...swapped._persistedLayoutByIndex].sort(), [[1, 'floating'], ['1@DP-2', 'master-stack']]);
  assert.deepEqual([...swapped._persistedDwindleByIndex.keys()], ['1@DP-2']);
  // Both name the same group: the single-monitor key wins (an older build
  // may have changed it since).
  const both = makeSelf({}, { _keyedPrimary: 'DP-1' });
  both._settings = recSettings({ ...older, 'monitor-workspace-layouts': ['DP-1:1:floating'] });
  both.persistence.loadPersistedLayoutRules();
  assert.deepEqual([...both._persistedLayoutByIndex], [[1, 'master-stack']]);
});

test('shiftWorkspaceIndexKeys: other monitors\' entries move with their workspace too', () => {
  const wss = stubGlobal({ nws: 5 });
  const self = makeSelf();
  self._workspaceLayouts = new Map([['3@DP-2', 'master-stack'], [3, 'floating'], ['2@DP-2', 'floating']]);
  self._stackRatios = new Map([['3@DP-2', new Map()]]);
  self._persistedLayoutByIndex = new Map([['5@DP-2', 'master-stack'], ['1@DP-2', 'dwindle']]);
  self._persistedDwindleByIndex = new Map([['3@DP-2', 's'], [3, 'd']]);
  self._persistedDwindleRaw = new Map([['3@DP-2', 'h0.5000(l,l)']]);
  self._pinnedAdjustCounts = new Map([['4@DP-2', { count: 1 }]]);
  self.persistence.scheduleSaveLayouts = () => {};
  wss.splice(2, 1);
  self.persistence.shiftWorkspaceIndexKeys(2, -1);
  assert.deepEqual([...self._workspaceLayouts].sort(), [[2, 'floating'], ['2@DP-2', 'master-stack']]);
  assert.deepEqual([...self._stackRatios.keys()], ['2@DP-2']);
  assert.deepEqual([...self._persistedLayoutByIndex].sort(), [['1@DP-2', 'dwindle'], ['4@DP-2', 'master-stack']]);
  assert.deepEqual([...self._persistedDwindleByIndex.keys()].sort(), [2, '2@DP-2'].sort());
  assert.deepEqual([...self._persistedDwindleRaw.keys()], ['2@DP-2']);
  assert.deepEqual([...self._pinnedAdjustCounts.keys()], ['3@DP-2']);
  self.persistence.shiftWorkspaceIndexKeys(1, +1);
  assert.deepEqual([...self._persistedLayoutByIndex].sort(), [['2@DP-2', 'dwindle'], ['5@DP-2', 'master-stack']]);
});

test('syncKeyedPrimary: a new primary takes over the single-monitor keys', () => {
  const [, ws] = stubGlobal({ primary: 1 });
  const a = W('a', ws, 0), c = W('c', ws, 1);
  const { self } = groupSelf(ws, [a, c]);
  self._keyedPrimary = 'DP-1';
  self._workspaceLayouts = new Map([[1, 'floating'], ['1@DP-2', 'master-stack']]);
  self._persistedDwindleRaw = new Map([[1, 'x'], ['1@DP-2', 'y']]);
  const ta = leaf(a), tc = leaf(c);
  self._bspTrees.set(ws, ta);
  self._bspTrees.set(self.monitors.groupObjFor(ws, 'DP-2'), tc);
  assert.equal(self.monitors.syncKeyedPrimary(), true);
  assert.deepEqual([...self._workspaceLayouts].sort(), [[1, 'master-stack'], ['1@DP-1', 'floating']]);
  assert.deepEqual([...self._persistedDwindleRaw].sort(), [[1, 'y'], ['1@DP-1', 'x']]);
  assert.equal(self.bsp.bspGetTree(ws, 1), tc, 'DP-2 (now primary) owns the workspace key');
  assert.equal(self._bspTrees.get(ws), tc);
  assert.equal(self.bsp.bspGetTree(ws, 0), ta);
  assert.equal(self.monitors.syncKeyedPrimary(), false);
});

test('forgetWorkspaceGroups: a removed workspace takes every monitor\'s tree with it', () => {
  const [, ws] = stubGlobal();
  const self = makeSelf();
  self.bsp.bspSetTree(ws, 0, leaf({}));
  self.bsp.bspSetTree(ws, 1, leaf({}));
  self._dwindleLeafSigs.set(self.monitors.groupObj(ws, 1), 'sig');
  self.monitors.forgetWorkspaceGroups(ws);
  assert.equal(self._bspTrees.size, 0);
  assert.equal(self._dwindleLeafSigs.size, 0);
  assert.equal(self._groupObjs.has(ws), false);
});

test('regroupWindows: a window in transit (no monitor yet) stays; moveWindowToGroup ignores windows it does not manage', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0);
  const { self, retiles } = groupSelf(ws, [a]);
  self._windowMonitors.set(a, 'DP-2');
  a._mon = -1;
  self.monitors.regroupWindows('hotplug');
  assert.equal(self.monitors.windowConn(a), 'DP-2');
  const x = W('x', ws, 0);
  assert.equal(self.monitors.moveWindowToGroup(x, 'DP-2', 'drop'), false);
  assert.equal(self._windowMonitors.has(x), false);
  assert.deepEqual(retiles, []);
});

test('onWorkspaceRemoved: every monitor\'s tree of the removed workspace goes', () => {
  const wss = stubGlobal({ nws: 3 });
  const ws2 = wss[2];
  const self = makeSelf({}, { _retileWorkspace() {}, _scheduleBackgroundAppParkingFix() {}, _scheduleSaveLayouts() {} });
  self._workspaceOrders.set(ws2, []);
  self.bsp.bspSetTree(ws2, 0, leaf({}));
  self.bsp.bspSetTree(ws2, 1, leaf({}));
  self._dwindleLeafSigs.set(self.monitors.groupObj(ws2, 1), 'sig');
  wss.splice(2, 1);
  self.signals.onWorkspaceRemoved(2);
  assert.equal(self._bspTrees.size, 0);
  assert.equal(self._dwindleLeafSigs.size, 0);
});

test('syncKeyedPrimary: the laid-out marker moves with each group (no split reset on a primary change)', () => {
  const [, ws] = stubGlobal({ primary: 1 });
  const a = W('a', ws, 0), c = W('c', ws, 1), d = W('d', ws, 1);
  const { self } = groupSelf(ws, [a, c, d]);
  self._keyedPrimary = 'DP-1';
  self._workspaceLayouts = new Map([[1, 'spiral'], ['1@DP-2', 'dwindle']]);
  const g2 = self.monitors.groupObjFor(ws, 'DP-2');
  self._bspTrees.set(g2, split('h', 0.7, leaf(c), leaf(d)));
  self._bspLaidOutAs.set(ws, 'spiral');
  self._bspLaidOutAs.set(g2, 'dwindle');
  assert.equal(self.monitors.syncKeyedPrimary(), true);
  // DP-2 is primary now: the workspace key is its group's.
  assert.equal(self._bspLaidOutAs.get(ws), 'dwindle');
  assert.equal(self._bspLaidOutAs.get(self.monitors.groupObjFor(ws, 'DP-1')), 'spiral');
  self._animTargets = new Map();
  self.layouts.retileDwindle(ws, [c, d], 1);
  assert.equal(self.bsp.bspGetTree(ws, 1).ratio, 0.7, 'dwindle\'s split kept');
});

test('the laid-out marker: kept when the stand-in is named, forgotten with the workspace', () => {
  const [, ws] = stubGlobal({ conns: ['', 'DP-2'] });
  const a = W('a', ws, 0);
  const { self } = groupSelf(ws, [a], { _scheduleRegroup: () => {} });
  self._windowMonitors.set(a, '#0');
  self._bspLaidOutAs.set(self.monitors.groupObjFor(ws, 'DP-1'), 'spiral');
  globalThis.global.backend = stubGlobalBackend(['DP-1', 'DP-2']);
  self.monitors.invalidate();
  self.monitors.syncKeyedPrimary();
  assert.equal(self._bspLaidOutAs.get(ws), 'spiral');
  self._bspLaidOutAs.set(self.monitors.groupObjFor(ws, 'DP-2'), 'dwindle');
  self.monitors.forgetWorkspaceGroups(ws);
  assert.equal(self._bspLaidOutAs.size, 0);
});

test('syncKeyedPrimary: naming the stand-in brings back what was saved for the name', () => {
  const [, ws] = stubGlobal({ conns: ['', 'DP-2'] });
  const a = W('a', ws, 0);
  const { self } = groupSelf(ws, [a], { _scheduleRegroup: () => {} });
  assert.equal(self.monitors.keyedPrimaryConn(), '#0');
  self._windowMonitors.set(a, '#0');
  self._persistedLayoutByIndex = new Map([['1@DP-1', 'master-stack'], ['2@DP-1', 'floating']]);
  self._workspaceLayouts = new Map([[2, 'dwindle'], ['2@DP-1', 'floating']]);
  const saved = leaf(a);
  self._bspTrees.set(self.monitors.groupObjFor(ws, 'DP-1'), saved);
  globalThis.global.backend = stubGlobalBackend(['DP-1', 'DP-2']);
  self.monitors.invalidate();
  self._bspTrees.set(ws, null);
  self.monitors.syncKeyedPrimary();
  assert.deepEqual([...self._persistedLayoutByIndex].sort(), [[1, 'master-stack'], [2, 'floating']]);
  assert.deepEqual([...self._workspaceLayouts], [[2, 'dwindle']], 'the session\'s own wins');
  assert.equal(self.bsp.bspGetTree(ws, 0), saved);
});

test('save: a window whose monitor is gone leaves nothing under "#-1"', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0);
  const { self } = groupSelf(ws, [a]);
  self._settings = recSettings();
  self.layouts.getMasterRatio(ws, -1);
  self._workspaceLayouts.set('1@#-1', 'floating');
  self.persistence.savePersistedLayouts();
  assert.ok(!JSON.stringify(self._settings.v).includes('#-1'));
  assert.equal(Monitors.splitMonitorEntry('#-1:1:floating'), null);
});

test('regroupWindows: our own animation passing over a monitor is not regrouped', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  self.placement.tickConfigure(a, 1100, 0, 300, 500, { targetX: 10, targetY: 0, targetW: 300, targetH: 500 });
  a._mon = 1;
  self.monitors.regroupWindows('hotplug');
  assert.equal(self.monitors.windowConn(a), 'DP-1');
});

// workspaces-only-on-primary with a master-stack rule on the secondary: c and d
// sit there where mutter put them.
function untiledSelf(extra = {}) {
  const [, ws] = stubGlobal({ pointer: [1450, 300] });
  const a = W('a', ws, 0), c = W('c', ws, 1, { x: 1200, y: 100, width: 300, height: 200 });
  const d = W('d', ws, 1, { x: 1300, y: 250, width: 300, height: 200 });
  const r = dragSelf(ws, [a, c, d], { _mutterSettings: { get_boolean: () => true }, ...extra });
  r.self._workspaceLayouts.set('1@DP-2', 'master-stack');
  const frames = () => [c, d].map(w => w.get_frame_rect());
  return { ...r, ws, a, c, d, frames, before: frames() };
}

test('a monitor that does not tile: a drag within it, the drop, the preview and a resize leave its windows alone', () => {
  const u = untiledSelf();
  assert.equal(u.self.monitors.groupPlaces(u.ws, 1), false);
  u.self.dragPreview.updateMoveDragPreview(u.d);
  assert.equal(u.shown.at(-1), null, 'no drop zone drawn there');
  u.self.windows.repositionWindow(u.d, u.ws);
  assert.deepEqual(u.frames(), u.before, 'the drop lays nothing out');
  assert.deepEqual(u.self._workspaceOrders.get(u.ws), [u.a, u.c, u.d]);
  u.self.grab.moveTiledExcept(u.c);
  assert.deepEqual(u.frames(), u.before, 'a resize tick lays nothing out');
  // The live-resize loop writes no ratio for that group.
  let tick = null;
  const orig = GLib.timeout_add;
  GLib.timeout_add = (_p, _ms, fn) => { tick = fn; return 1; };
  try {
    u.self._grabOp = 1 | (2 << 12);
    u.self._grabWidthSign = 1;
    u.self._grabStartX = 1300;
    u.self.borders.updateBordersDuringGrab = () => {};
    u.self.grab.startGrabLoop(u.c, 'resize');
    tick();
  } finally {
    GLib.timeout_add = orig;
  }
  assert.equal(u.self._masterRatios.size, 0);
  assert.deepEqual(u.frames(), u.before);
});

test('mouse-resizing the master on the second monitor changes that monitor\'s ratio only', () => {
  const [, ws] = stubGlobal({ pointer: [1480, 250] });
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const c = W('c', ws, 1, { x: 1000, y: 0, width: 400, height: 500 }), d = W('d', ws, 1, { x: 1400, y: 0, width: 400, height: 500 });
  const { self } = groupSelf(ws, [a, b, c, d]);
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  self._workspaceLayouts.set(1, 'master-stack');
  self.borders.updateBordersDuringGrab = () => {};
  let tick = null;
  const orig = GLib.timeout_add;
  GLib.timeout_add = (_p, _ms, fn) => { tick = fn; return 1; };
  try {
    self._grabOp = 1 | (2 << 12);
    self._grabWidthSign = 1;
    self._grabStartX = 1400;
    self._grabInitialMasterRatio = 0.5;
    self.grab.startGrabLoop(c, 'resize');
    tick();
  } finally {
    GLib.timeout_add = orig;
  }
  assert.equal(self._masterRatios.get('1@DP-2'), 0.6);
  assert.equal(self._masterRatios.has(1), false);
});

test('pinned adjust, slot re-assert and a late float on the second monitor use its own group', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const c = W('c', ws, 1, { x: 1000, y: 0, width: 600, height: 500 }), d = W('d', ws, 1, { x: 1600, y: 0, width: 200, height: 500 });
  const { self, retiles } = groupSelf(ws, [a, b, c, d]);
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  // c refuses to be narrower than 600: the master ratio of DP-2 bends.
  self.placement.adjustPinnedTree(c, ws);
  assert.ok(self._masterRatios.get('1@DP-2') > 0.7);
  assert.equal(self._masterRatios.has(1), false);
  assert.deepEqual([...self._pinnedAdjustCounts.keys()], ['1@DP-2']);
  // Its master-stack slot (the primary is dwindle, with no tree for c).
  self._masterRatios.set('1@DP-2', 0.5);
  self.grab.maybeReassertSlot(c);
  assert.deepEqual(retiles, [ws]);
  // d turns floating late (identity): it leaves DP-2's tree, not the primary's.
  self._workspaceLayouts.delete('1@DP-2');
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, split('h', 0.5, leaf(c), leaf(d)));
  self._toggleFloatWindows.add(d);
  self.windows.onWindowIdentityChanged(d);
  assert.deepEqual(treeWins(self, ws, 1), [c]);
  assert.deepEqual(treeWins(self, ws, 0), [a, b]);
});

test('drop with the pointer between monitors: no monitor, the window keeps its group', () => {
  const [, ws] = stubGlobal({ pointer: [5000, 250] });
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = dragSelf(ws, [a, b]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.windows.repositionWindow(a, ws);
  assert.equal(self.monitors.windowConn(a), 'DP-1');
  assert.ok(![...self._windowMonitors.values()].includes('#-1'));
});

test('addWindow on a monitor that does not tile: no tree takes it', () => {
  const [, ws] = stubGlobal();
  const c = W('c', ws, 1);
  const { self } = groupSelf(ws, [], { _mutterSettings: { get_boolean: () => true } });
  c.connectObject = () => 1;
  self.windows.addWindow(c, true);
  assert.equal(self.monitors.windowConn(c), 'DP-2');
  assert.equal(self.bsp.bspGetTree(ws, 1), null);
});

test('checkWorkspaceLandings: a window off its slot on the second monitor re-tiles', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), c = W('c', ws, 1, { x: 1100, y: 50, width: 300, height: 300 }), d = W('d', ws, 1);
  const { self, retiles } = groupSelf(ws, [a, c, d]);
  self._workspaceLayouts.set('1@DP-2', 'master-stack');
  self.placement.checkWorkspaceLandings(ws);
  assert.deepEqual(retiles, [ws]);
});

test('monitors-changed: a new primary takes the single-monitor keys and an unplugged monitor\'s windows join theirs', () => {
  const [, ws] = stubGlobal({ primary: 1 });
  const a = W('a', ws, 0), c = W('c', ws, 1), h = W('h', ws, 1);
  const { self } = groupSelf(ws, [a, c, h]);
  self._keyedPrimary = 'DP-1';
  self._windowMonitors.set(h, 'HDMI-9');
  self._workspaceLayouts = new Map([[1, 'floating']]);
  const handlers = {};
  self.signals.connectObject = (_e, name, cb) => { handlers[name] = cb; };
  self.monitors.connectSignals = () => {};
  self.grab.connectGrabSignals = () => {};
  self.signals.hookInsertWorkspace = () => {};
  self.dragPreview.updateDropOverlaySize = () => {};
  self.bgApp.refillBackgroundApp = () => {};
  let retiled = 0;
  self.layouts.retileAll = () => retiled++;
  const OrigSettings = Gio.Settings;
  Gio.Settings = class {};
  try {
    self.signals.connectSignals();
  } finally {
    Gio.Settings = OrigSettings;
  }
  handlers['monitors-changed']();
  assert.deepEqual([...self._workspaceLayouts], [['1@DP-1', 'floating']]);
  let parsed = 0;
  self.persistence.parsePersistedDwindleShapes = () => { parsed++; return new Map(); };
  handlers['changed::monitor-workspace-dwindle-trees']();
  assert.equal(parsed, 1);
  assert.equal(self.monitors.windowConn(h), 'DP-2');
  assert.equal(retiled, 1);
});

test('window-entered-monitor is connected with mutter\'s argument order (display, monitor, window)', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  const handlers = {};
  global.display.connectObject = (name, cb) => { handlers[name] = cb; };
  global.backend.get_monitor_manager = () => ({ connectObject() {}, get_logical_monitors: () =>
    ['DP-1', 'DP-2'].map((cn, i) => ({ get_number: () => i, get_monitors: () => [{ get_connector: () => cn }] })) });
  self.monitors.connectSignals();
  a._mon = 1;
  handlers['window-entered-monitor'](global.display, 1, a);
  assert.equal(self.monitors.windowConn(a), 'DP-2');
});

test('scheduleRegroup: one idle for a burst; it regroups, and not after shutdown', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  const idles = [];
  const orig = GLib.idle_add;
  GLib.idle_add = (_p, fn) => { idles.push(fn); return idles.length; };
  try {
    a._mon = 1;
    self.monitors.scheduleRegroup();
    self.monitors.scheduleRegroup();
    assert.equal(idles.length, 1);
    idles[0]();
    assert.equal(self.monitors.windowConn(a), 'DP-2');
    assert.equal(self._regroupId, 0);
    b._mon = 1;
    self.monitors.scheduleRegroup();
    self._shuttingDown = true;
    idles[1]();
    assert.equal(self.monitors.windowConn(b), 'DP-1');
  } finally {
    GLib.idle_add = orig;
  }
});

test('hotplug: three windows off a removed monitor keep its whole arrangement, and append where they land', () => {
  const [, ws] = stubGlobal({ pointer: [200, 250] });
  const a = W('a', ws, 0), e = W('e', ws, 0), b = W('b', ws, 0), c = W('c', ws, 0), d = W('d', ws, 0);
  const { self } = groupSelf(ws, [a, e, b, c, d]);
  for (const w of [b, c, d]) self._windowMonitors.set(w, 'HDMI-9');
  self._bspTrees.set(self.monitors.groupObjFor(ws, 'HDMI-9'), split('h', 0.7, leaf(b), split('v', 0.4, leaf(c), leaf(d))));
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(e)));
  self.monitors.regroupWindows('hotplug');
  assert.equal(self._persistedDwindleRaw.get('1@HDMI-9'), 'h0.7000(l,v0.4000(l,l))');
  // Appended dwindle style: a, under the pointer, is not split.
  const t = self.bsp.bspGetTree(ws, 0);
  assert.equal(t.first.type, 'leaf');
  assert.equal(t.first.window, a);
  assert.equal(self.bsp.bspCollectWindows(t).length, 5);
});

test('grab end: a drop moves the window once (the drop first, then the grab-end rule)', () => {
  const [, ws] = stubGlobal({ pointer: [950, 250] });
  const a = W('a', ws, 0), b = W('b', ws, 0, { x: 900, y: 0, width: 500, height: 500 }), c = W('c', ws, 1);
  const { self } = dragSelf(ws, [a, b, c]);
  self.masks.kickMaskNow = () => {};
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  b._mon = 1; // frame mostly on DP-2, the pointer on DP-1
  const moves = [];
  const orig = self.monitors.moveWindowToGroup.bind(self.monitors);
  self.monitors.moveWindowToGroup = (w, conn, cause) => { moves.push(cause); return orig(w, conn, cause); };
  self.grab.onGrabOpBegin(b, 1);
  self._grabOp = 1;
  self.grab.onGrabOpEnd(b, 1);
  assert.equal(self.monitors.windowConn(b), 'DP-1');
  assert.deepEqual(moves, []);
});

test('save: a primary without a connector yet names no monitor, and no "#" key is kept', () => {
  const [, ws] = stubGlobal({ conns: ['', ''] });
  const a = W('a', ws, 0), c = W('c', ws, 1);
  const { self } = groupSelf(ws, [a, c]);
  self._windowMonitors.set(a, '#0');
  self._windowMonitors.set(c, '#1');
  self._settings = recSettings({ 'monitor-primary-connector': 'DP-1' });
  self._workspaceLayouts.set('1@#1', 'master-stack');
  self.persistence.savePersistedLayouts();
  const v = self._settings.v;
  assert.equal(v['monitor-primary-connector'], 'DP-1', 'the last real name stays');
  assert.ok(!JSON.stringify(v).includes('#'));
  assert.equal(Monitors.splitMonitorEntry('#1:1:dwindle'), null);
});

test('removeWindow and disable forget the tick record; the hotplug regroup stands down at shutdown', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 1);
  const { self } = groupSelf(ws, [a, b]);
  const run = { targetX: 0, targetY: 0, targetW: 10, targetH: 10 };
  self.placement.tickConfigure(a, 0, 0, 10, 10, run);
  self.placement.tickConfigure(b, 1000, 0, 10, 10, run);
  const released = [];
  const release = self.transforms.release.bind(self.transforms);
  self.transforms.release = (w) => { released.push(w); release(w); };
  self.windows.removeWindow(a);
  assert.equal(a._plaidTickSent, null);
  assert.deepEqual(released, [a], 'a transform run on it ends');
  self.windows.destroy();
  assert.equal(b._plaidTickSent, null);
  self._windowMonitors.set(b, 'DP-1');
  self._shuttingDown = true;
  self.monitors.regroupWindows('hotplug');
  assert.equal(self.monitors.windowConn(b), 'DP-1');
});

test('entered-monitor reads the monitors fresh: indices may already be the new configuration\'s', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  assert.equal(self.monitors.monConn(1), 'DP-2');
  globalThis.global.backend = stubGlobalBackend(['DP-1', 'HDMI-1']);
  a._mon = 1;
  self.monitors.onWindowEnteredMonitor(a, 1);
  assert.equal(self.monitors.windowConn(a), 'HDMI-1');
});

test('connectSignals: the monitor setting and mutter\'s own change drop the cached views', () => {
  stubGlobal();
  const self = makeSelf();
  const handlers = {};
  const mm = { connectObject: (name, cb) => { handlers[name] = cb; } };
  global.backend.get_monitor_manager = () => mm;
  global.display.connectObject = () => {};
  self._mutterSettings = { get_boolean: () => false, connectObject: (name, cb) => { handlers[name] = cb; } };
  self.layouts.retileAll = () => {};
  self.monitors.connectSignals();
  for (const name of ['monitors-changed-internal', 'changed::workspaces-only-on-primary']) {
    self._monitorConnCache = ['X'];
    self._tiledMonitorsCache = [9];
    handlers[name]();
    assert.equal(self._monitorConnCache, null, name);
    assert.equal(self._tiledMonitorsCache, null, name);
  }
});

test('saveGroupShapes: a removed monitor\'s single window is no arrangement to keep', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  self._windowMonitors.set(b, 'HDMI-9');
  self._bspTrees.set(self.monitors.groupObjFor(ws, 'HDMI-9'), leaf(b));
  self.monitors.regroupWindows('hotplug');
  assert.equal(self._persistedDwindleRaw.has('1@HDMI-9'), false);
});

test('activeMonitor: a focused window on another workspace does not decide', () => {
  const [, ws, ws2] = stubGlobal();
  const a = W('a', ws, 0), c = W('c', ws2, 1);
  const { self } = groupSelf(ws, [a]);
  self._windowMonitors.set(c, 'DP-2');
  global.display.focus_window = c;
  assert.equal(self.monitors.activeMonitor(ws), 0);
});

test('maybeReassertSlot: a frame over no monitor at all is still pulled back', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self, retiles } = groupSelf(ws, [a, b]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspTagGeometry(self.bsp.bspGetTree(ws, 0), 0, 0, 1000, 500, 0);
  a._frame = { x: 5000, y: 0, width: 300, height: 500 };
  self.grab.maybeReassertSlot(a);
  assert.deepEqual(retiles, [ws]);
});

test('keys while the window\'s group monitor is gone: swap and resize do nothing', () => {
  const { self, b } = edgeSelf();
  self._windowMonitors.set(b, 'HDMI-9');
  const moved = [];
  self.actions.moveFloating = () => moved.push('move');
  self.actions.resizeFloating = () => moved.push('resize');
  self.actions.swapWindow('left');
  self.actions.resizeWindow('grow', 'width');
  assert.deepEqual(moved, []);
});

test('grab begin and end during shutdown record and regroup nothing', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  self.grab.onGrabOpBegin(a, 1);
  self._shuttingDown = true;
  a._mon = 1;
  self.monitors.regroupAfterGrab(a);
  assert.equal(self.monitors.windowConn(a), 'DP-1');
  self._grabbedWindow = null;
  self.grab.onGrabOpBegin(b, 1);
  assert.equal(self._grabbedWindow, null);
});

test('removeWindow: a window whose monitor is gone leaves that group\'s tree whatever the default layout', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 0);
  const { self } = groupSelf(ws, [a, b]);
  self._settings = recSettings({ layout: 'master-stack' });
  self._windowMonitors.set(a, 'HDMI-9');
  self._windowMonitors.set(b, 'HDMI-9');
  const key = self.monitors.groupObjFor(ws, 'HDMI-9');
  self._bspTrees.set(key, split('h', 0.5, leaf(a), leaf(b)));
  self.windows.removeWindow(a);
  assert.equal(self._bspTrees.get(key).window, b);
});

test('moveWindowToGroup and swapAcrossGroups: a window with no workspace, or not in the order, corrupt nothing', () => {
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0), b = W('b', ws, 1), x = W('x', null, 0);
  const { self } = groupSelf(ws, [a, b]);
  self._windowMonitors.set(x, 'DP-1');
  assert.equal(self.monitors.moveWindowToGroup(x, 'DP-2', 'monitor'), true);
  assert.equal(self._workspaceOrders.has(null), false);
  self._workspaceOrders.set(ws, [a]);
  self.monitors.swapAcrossGroups(ws, a, b);
  assert.deepEqual(self._workspaceOrders.get(ws), [a]);
});

test('grab end with no drop (mouse-resize off): the window joins the other monitor at the pointer', () => {
  const [, ws] = stubGlobal({ pointer: [1200, 250] });
  const a = W('a', ws, 0), b = W('b', ws, 0), c = W('c', ws, 1), d = W('d', ws, 1);
  const { self } = groupSelf(ws, [a, b, c, d]);
  self.bsp.bspSetTree(ws, 0, split('h', 0.5, leaf(a), leaf(b)));
  self.bsp.bspSetTree(ws, 1, split('h', 0.5, leaf(c), leaf(d)));
  self.grab.onGrabOpBegin(b, 1);
  b._mon = 1;
  self.grab.onGrabOpEnd(b, 1);
  const t = self.bsp.bspGetTree(ws, 1);
  assert.deepEqual(self.bsp.bspCollectWindows(t.first), [c, b], 'c, under the pointer, splits');
  assert.equal(t.second.window, d);
});

// One retile tick of every group of ws (the run is over at once).
function retileOnce(self, ws) {
  let tick = null;
  const orig = GLib.timeout_add;
  GLib.timeout_add = (_p, _ms, fn) => { tick = fn; return 1; };
  try {
    self._getAnimationTime = () => 0.1;
    self._verifyAnimationLanding = () => {};
    self.layouts.doRetileWorkspace(ws);
    self._animStartTime = 0;
    if (tick) tick();
  } finally {
    GLib.timeout_add = orig;
  }
}

test('retile: a monitor that does not tile, and a floating group, are not laid out', () => {
  const u = untiledSelf();
  for (const w of [u.a, u.c, u.d]) w.get_compositor_private = () => ({});
  retileOnce(u.self, u.ws);
  assert.deepEqual(u.frames(), u.before, 'workspaces only on the primary: DP-2 is left alone');
  assert.deepEqual(u.a.get_frame_rect(), { x: 0, y: 0, width: 1000, height: 500 }, 'the primary is laid out');
  const [, ws] = stubGlobal();
  const a = W('a', ws, 0, { x: 10, y: 10, width: 200, height: 200 }), b = W('b', ws, 0, { x: 300, y: 50, width: 200, height: 200 });
  for (const w of [a, b]) w.get_compositor_private = () => ({});
  const { self } = groupSelf(ws, [a, b]);
  self._workspaceLayouts.set(1, 'floating');
  retileOnce(self, ws);
  assert.deepEqual([a, b].map(w => w.get_frame_rect()), [{ x: 10, y: 10, width: 200, height: 200 }, { x: 300, y: 50, width: 200, height: 200 }]);
});

test('retile: a new window on a monitor that does not tile fades in where mutter put it', () => {
  const u = untiledSelf();
  for (const w of [u.a, u.c, u.d]) w.get_compositor_private = () => ({ remove_all_transitions() {}, set_opacity() {} });
  u.self._newWindowSet.add(u.d);
  const runs = [];
  u.self.placement.deferNewWindowPlacement = (st) => runs.push([st.win, st.targetX, st.targetY]);
  retileOnce(u.self, u.ws);
  assert.deepEqual(runs, [[u.d, 1300, 250]]);
});

test('mouse resize over a stale dwindle tree on a monitor that does not tile moves no split', () => {
  const u = untiledSelf();
  u.self._workspaceLayouts.delete('1@DP-2');
  const stale = split('h', 0.5, leaf(u.c), leaf(u.d));
  u.self.bsp.bspSetTree(u.ws, 1, stale);
  u.c.get_buffer_rect = () => u.c.get_frame_rect();
  u.c.connectObject = () => 1;
  global.workspace_manager.get_active_workspace = () => u.ws;
  u.self.borders.updateBordersDuringGrab = () => {};
  let tick = null;
  const orig = GLib.timeout_add;
  GLib.timeout_add = (_p, _ms, fn) => { tick = fn; return 1; };
  try {
    global.get_pointer = () => [1450, 300, 0];
    u.self.grab.handleGrabBegin(u.c, 1 | (2 << 12));
    assert.equal(u.self._grabResizeNodeW, null, 'no split picked');
    global.get_pointer = () => [1550, 300, 0];
    tick();
  } finally {
    GLib.timeout_add = orig;
  }
  assert.equal(stale.ratio, 0.5);
  assert.equal(stale._w, undefined, 'the stale tree is not even tagged');
});

test('a held new window in a group that places nothing is revealed at the first settle tick', () => {
  const u = untiledSelf();
  const shown = [];
  const actor = { visible: false, remove_all_transitions() {}, set_opacity(o) { shown.push(o); }, ease() {} };
  u.d.get_compositor_private = () => actor;
  u.d.get_client_type = () => 1; // X11: the reveal is held until the settle poll
  const timers = [];
  const origT = GLib.timeout_add;
  GLib.timeout_add = (_p, ms, fn) => { timers.push([ms, fn]); return timers.length; };
  u.self.signals.addTimeout = (ms, fn) => { timers.push([ms, fn]); return timers.length; };
  try {
    const f = u.d.get_frame_rect();
    const st = { win: u.d, actor, isNew: true, targetX: f.x, targetY: f.y, targetW: f.width, targetH: f.height };
    u.self.placement.deferNewWindowPlacement(st, 100, () => {});
    timers.find(([ms]) => ms === 80)[1]();
    assert.equal(u.d._plaidHoldReveal, true, 'held for the settle');
    timers.find(([ms]) => ms === 400)[1]();
    assert.equal(u.d._plaidHoldReveal, false, 'revealed: nothing there would correct it');
  } finally {
    GLib.timeout_add = origT;
  }
});

// Every caller inside the extension names the group: a call that leaves the
// monitor out silently means "the primary" (kept only for outside callers).
const MIN_ARGS = { bspGetTree: 2, bspSetTree: 3, bspInsertForWorkspace: 3, getWorkspaceLayout: 2,
  getMasterRatio: 2, getStackRatios: 2, clampMasterStackRatios: 6, retileMasterStack: 4,
  retileCenteredMasterStack: 4, retileDwindle: 3, resizeMasterStack: 5, resizeDwindle: 5,
  computeMasterStackDropTarget: 4, computeDwindleDropTarget: 4, showMasterStackPreview: 3,
  masterStackPreviewRect: 3, refreshSavedShape: 3, getWindowsForGroup: 2, monitorWorkArea: 2,
  groupKey: 2, groupObj: 2, isFullscreenTile: 3, crossDropPlan: 5, dropOnGroup: 5, groupPlaces: 2 };

// The primary's group named on purpose: the single-monitor keys hold it.
const NULL_MON_OK = new Set(['persistence.js']);

// Comments and string literals blanked, offsets kept.
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, m => `'${' '.repeat(m.length - 2)}'`);
}

// [file:line name (n of need args)] for each short call or a literal null/undefined
// monitor, and the call count per name.
function shortCalls(src, file) {
  const bad = [];
  const seen = {};
  const code = codeOf(src);
  const re = /\.([A-Za-z]+)\(/g;
  let m;
  while ((m = re.exec(code))) {
    const need = MIN_ARGS[m[1]];
    if (!need) continue;
    seen[m[1]] = (seen[m[1]] ?? 0) + 1;
    let depth = 0, commas = 0, any = false, i = re.lastIndex, start = i;
    const args = [];
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === '`') { i = code.indexOf('`', i + 1); any = true; continue; }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) { commas++; args.push(code.slice(start, i)); start = i + 1; }
      if (!/\s/.test(ch)) any = true;
    }
    args.push(code.slice(start, i));
    const n = any ? commas + 1 : 0;
    const line = code.slice(0, m.index).split('\n').length;
    if (n < need) bad.push(`${file}:${line} ${m[1]} (${n} of ${need} args)`);
    else if (/^\s*(null|undefined)\s*$/.test(args[need - 1]) && !NULL_MON_OK.has(file))
      bad.push(`${file}:${line} ${m[1]} (null monitor)`);
  }
  return { bad, seen };
}

// A group map keyed by a workspace or its index outside the key helpers names
// the primary's group whatever the window's monitor.
function bareGroupKeys(src, file) {
  if (file === 'monitors.js' || file === 'persistence.js') return [];
  const code = codeOf(src);
  const re = /\._(masterRatios|stackRatios|workspaceLayouts|pinnedAdjustCounts|persisted\w+|bspTrees|dwindleLeafSigs)\.(get|set|has|delete)\(\s*(this\.core\.geometry\.wsIndex\(|ws\b|workspace\b|wsNow\b|oldWs\b|newWs\b|mws\b|i\b)/g;
  const bad = [];
  let m;
  while ((m = re.exec(code)))
    bad.push(`${file}:${code.slice(0, m.index).split('\n').length} _${m[1]}.${m[2]}(${m[3]}`);
  return bad;
}

// Methods that lay windows out, compute a slot or edit a split must ask
// monitors.groupPlaces, or say here why their caller does.
const PLACES = /\.(animRetile|swapMasterStackWindows|retileMasterStack|retileCenteredMasterStack|retileDwindle|bspLayout|bspInsertForWorkspace|windowSlotRect|computeDwindleDropTarget|computeMasterStackDropTarget|showMasterStackPreview|masterStackPreviewRect|crossDropPlan|resizeMasterStack|resizeDwindle|moveTiledExcept|adjustForConstraints)\(|_masterRatios\.set\(|stackRatios\.set\(/;
const PLACES_CALLER_ASKS = {
  'bsp.js bspLayout': 'tree recursion; its callers ask',
  'bsp.js adjustForConstraints': 'tree recursion; adjustPinnedTree asks',
  'drag-preview.js showMasterStackPreview': 'updateMoveDragPreview asks',
  'grab.js enforceGrabBoundary': 'its slot is windowSlotRect, which asks',
  'layouts.js getMasterRatio': 'getter (a default entry)',
  'layouts.js getStackRatios': 'getter (a default entry)',
  'layouts.js clampMasterStackRatios': 'part of a layout pass',
  'layouts.js retileCenteredMasterStack': 'layout pass; animRetile, moveTiledExcept and repositionWindow run it for a placing group',
  'layouts.js resizeMasterStack': 'actions.resizeWindow asks',
  'layouts.js retileDwindle': 'layout pass; animRetile runs it only for a group doRetileWorkspace found placing',
  'placement.js animRetile': 'each group carries doRetileWorkspace\'s groupPlaces answer (places); a group that does not place only anchors new windows',
  'windows.js dropOnGroup': 'repositionWindow calls it for a tiled monitor; crossDropPlan asks',
};
function unaskedPlacers(src, file) {
  const out = [];
  let name = null, body = [];
  for (const l of src.split('\n')) {
    const m = /^    (?:static )?(\w+)\(.*\) \{$/.exec(l);
    if (m) { name = m[1]; body = []; continue; }
    if (name && l === '    }') {
      const code = codeOf(body.join('\n'));
      if (PLACES.test(code) && !/groupPlaces\(/.test(code)) out.push(`${file} ${name}`);
      name = null;
      continue;
    }
    if (name) body.push(l);
  }
  return out;
}

test('static: group-aware calls pass their monitor', () => {
  // Calibration: a known short call is found, a full one is not.
  const cal = shortCalls('a.core.bsp.bspGetTree(ws);\nb.getWorkspaceLayout(ws, f(x, y));\n', 'cal');
  assert.deepEqual(cal.bad, ['cal:1 bspGetTree (1 of 2 args)']);
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', 'extensions', 'modules');
  const bad = [];
  const seen = {};
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const r = shortCalls(readFileSync(join(dir, f), 'utf8'), f);
    bad.push(...r.bad);
    for (const [k, v] of Object.entries(r.seen)) seen[k] = (seen[k] ?? 0) + v;
  }
  assert.deepEqual(bad, []);
  // Every name is still called somewhere: a rename would empty the check.
  assert.deepEqual(Object.keys(MIN_ARGS).filter(k => !seen[k]), []);
  assert.deepEqual(shortCalls('x.getWorkspaceLayout(ws, null);\n', 'cal').bad, ['cal:1 getWorkspaceLayout (null monitor)']);
});

test('static: the keys read through persistedEntries exist in the schema', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = join(here, '..', '..', 'extensions');
  const schema = readFileSync(join(ext, 'schemas', 'org.gnome.shell.extensions.plaid.gschema.xml'), 'utf8');
  const keys = new Set([...schema.matchAll(/<key\s+name="([^"]+)"/g)].map(m => m[1]));
  const src = readFileSync(join(ext, 'modules', 'persistence.js'), 'utf8');
  const read = [...src.matchAll(/persistedEntries\('([^']+)', '([^']+)'\)/g)].flatMap(m => [m[1], m[2]]);
  assert.equal(read.length, 8);
  assert.deepEqual(read.filter(k => !keys.has(k)), []);
});

test('static: group maps are keyed through the helpers, not by a workspace', () => {
  assert.deepEqual(bareGroupKeys('a.core._masterRatios.set(this.core.geometry.wsIndex(ws), 1);\nb.core._bspTrees.get(ws);\nc.core._bspTrees.get(key);\n' +
    'const mr = this.core._masterRatios.get(i);\nconst tree = this.core._bspTrees.get(mws);\n', 'cal.js'),
    ['cal.js:1 _masterRatios.set(this.core.geometry.wsIndex(', 'cal.js:2 _bspTrees.get(ws', 'cal.js:4 _masterRatios.get(i', 'cal.js:5 _bspTrees.get(mws']);
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', 'extensions', 'modules');
  const bad = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js')))
    bad.push(...bareGroupKeys(readFileSync(join(dir, f), 'utf8'), f));
  assert.deepEqual(bad, []);
});

test('static: every method that places windows asks groupPlaces (or its caller does)', () => {
  assert.deepEqual(unaskedPlacers('class X {\n    foo(ws) {\n        this.core.layouts.retileDwindle(ws, [], 1);\n    }\n}\n', 'cal.js'), ['cal.js foo']);
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', 'extensions', 'modules');
  const found = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js')))
    found.push(...unaskedPlacers(readFileSync(join(dir, f), 'utf8'), f));
  assert.deepEqual(found.filter(k => !PLACES_CALLER_ASKS[k]), [], 'a new placing method must ask groupPlaces');
  assert.deepEqual(Object.keys(PLACES_CALLER_ASKS).filter(k => !found.includes(k)), [], 'stale allow entry');
});
