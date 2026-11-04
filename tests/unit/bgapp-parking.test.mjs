import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, oneMonitor } from '../helpers.mjs';
import { sessionState } from '../../extensions/modules/session-state.js';

function fakeWorkspace(windows = []) {
  return {
    _wins: windows.slice(),
    activated: false,
    list_windows() { return this._wins.slice(); },
    activate() { this.activated = true; },
  };
}

function withGlobalWorkspaceManager(wm, fn) {
  const old = globalThis.global;
  globalThis.global = { display: oneMonitor(), workspace_manager: wm };
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

test('_evacuateParkingWorkspace: moves user windows off the parking and activates a real workspace', () => {
  const parking = fakeWorkspace();
  const real = fakeWorkspace();
  const user = fakeWin();
  let userWs = parking;
  user.get_workspace = () => userWs;
  user.change_workspace = (ws) => {
    userWs = ws;
    parking._wins = parking._wins.filter(w => w !== user);
    real._wins.push(user);
  };
  parking._wins.push(user);

  const wm = {
    get_n_workspaces: () => 2,
    get_workspace_by_index: (i) => (i === 0 ? parking : real),
    get_active_workspace: () => parking,
    append_new_workspace: () => real,
  };
  const self = makeSelf({}, {
    _backgroundAppParkingWs: parking,
    _backgroundAppWin: null,
    _matchesBackgroundApp: () => false,
    _currentTime: () => 0,
    _wsIndex: (ws) => (ws === parking ? 0 : 1),
    _scheduleWorkspacePillUpdate() {},
    _debugLog() {},
  });

  withGlobalWorkspaceManager(wm, () => self._evacuateParkingWorkspace());

  assert.equal(userWs, real);
  assert.equal(real.activated, true);
  assert.equal(parking._wins.length, 0);
});

test('_evacuateParkingWorkspace: no user windows + real active is a no-op', () => {
  const parking = fakeWorkspace();
  const real = fakeWorkspace();
  let activated = false;
  real.activate = () => { activated = true; };
  const wm = {
    get_n_workspaces: () => 2,
    get_workspace_by_index: (i) => (i === 0 ? parking : real),
    get_active_workspace: () => real,
    append_new_workspace: () => real,
  };
  const self = makeSelf({}, {
    _backgroundAppParkingWs: parking,
    _backgroundAppWin: null,
    _matchesBackgroundApp: () => false,
    _currentTime: () => 0,
    _wsIndex: () => 1,
    _scheduleWorkspacePillUpdate() {},
    _debugLog() {},
  });

  withGlobalWorkspaceManager(wm, () => self._evacuateParkingWorkspace());

  assert.equal(activated, false);
});

test('_evacuateParkingWorkspace: a reentrant workspace change does not recurse', () => {
  const parking = fakeWorkspace();
  const real = fakeWorkspace();
  const user = fakeWin();
  let userWs = parking;
  let moves = 0;
  user.get_workspace = () => userWs;
  user.change_workspace = (ws) => {
    moves++;
    userWs = ws;
    parking._wins = parking._wins.filter(w => w !== user);
    real._wins.push(user);
    // A workspace change emits active-workspace-changed synchronously; the
    // handler can re-enter evacuation before this call returns.
    self.bgApp.evacuateParkingWorkspace();
  };
  parking._wins.push(user);

  const wm = {
    get_n_workspaces: () => 2,
    get_workspace_by_index: (i) => (i === 0 ? parking : real),
    get_active_workspace: () => parking,
    append_new_workspace: () => real,
  };
  const self = makeSelf({}, {
    _backgroundAppParkingWs: parking,
    _backgroundAppWin: null,
    _matchesBackgroundApp: () => false,
    _currentTime: () => 0,
    _wsIndex: (ws) => (ws === parking ? 0 : 1),
    _scheduleWorkspacePillUpdate() {},
    _debugLog() {},
  });

  withGlobalWorkspaceManager(wm, () => self._evacuateParkingWorkspace());

  assert.equal(moves, 1, 'the window must be moved exactly once');
  assert.equal(real.activated, true);
  assert.equal(parking._wins.length, 0);
});

test('parking hiding: the switcher, overview and keyboard neighbour skip the parking workspace', async () => {
  const Meta = (await import('gi://Meta')).default;
  const St = (await import('gi://St')).default;
  const Shell = (await import('gi://Shell')).default;
  const Main = await import('resource:///org/gnome/shell/ui/main.js');
  const { MonitorWorkspaceSwitcherPopup } = await import('resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js');
  const { WorkspacesView } = await import('resource:///org/gnome/shell/ui/workspacesView.js');
  const { ThumbnailsBox } = await import('resource:///org/gnome/shell/ui/workspaceThumbnail.js');

  const bgWin = fakeWin({ pid: 4242 });
  // A second window of the background app, known only to the core's matcher.
  const bgHelper = fakeWin({ pid: 4243 });
  const parking = fakeWorkspace([bgWin, bgHelper]);
  const ws1 = fakeWorkspace();
  const ws2 = fakeWorkspace();
  const order = [parking, ws1, ws2];
  let active = ws1;
  const wm = {
    n_workspaces: 3,
    get_n_workspaces: () => 3,
    get_workspace_by_index: (i) => order[i] ?? null,
    get_active_workspace: () => active,
  };

  Meta.MotionDirection = { UP: -1, DOWN: -2, LEFT: -3, RIGHT: -4 };
  Meta.Workspace = class { get_neighbor(direction) { return `orig:${direction}`; } };
  Shell.ActionMode = { NORMAL: 1, OVERVIEW: 2 };
  St.Bin = class {
    constructor() { this.active = false; }
    add_style_pseudo_class() { this.active = true; }
  };
  Main.wm.setCustomKeybindingHandler = () => {};
  Main.overview._overview = { controls: null };
  WorkspacesView.prototype._updateVisibility = function () {
    for (const card of this._workspaces) card.visible = true;
  };
  MonitorWorkspaceSwitcherPopup.prototype.redisplay = () => {};
  ThumbnailsBox.prototype.addThumbnails = function () {
    for (const t of this._thumbnails) t.visible = true;
  };

  const self = makeSelf();
  self._backgroundAppParkingWs = parking;
  self._backgroundAppParkingFront = true;
  self._backgroundAppWin = bgWin;
  sessionState.parkingWorkspace = parking;
  sessionState.parkingFront = true;
  sessionState.bgAppWindow = bgWin;
  sessionState.parkingHiding = null;
  sessionState.bgAppPids.clear();
  self.bgApp.isBgAppProcessWindow = () => false;
  self.bgApp.matchesBackgroundApp = (w) => w === bgHelper;

  withGlobalWorkspaceManager(wm, () => {
    // The core leaves the helper on the parking (evacuation, hideParkingCard).
    assert.equal(self.bgApp.workspaceHasUserWindows(parking), false);
    self.bgApp.applyBackgroundAppHiding();
    try {
      const next = Meta.Workspace.prototype.get_neighbor;
      assert.equal(next.call(ws2, Meta.MotionDirection.RIGHT), ws1);
      assert.equal(next.call(ws1, Meta.MotionDirection.LEFT), ws2);
      assert.equal(next.call(ws1, Meta.MotionDirection.UP), `orig:${Meta.MotionDirection.UP}`);
      assert.equal(next.call(parking, Meta.MotionDirection.RIGHT), `orig:${Meta.MotionDirection.RIGHT}`);

      const view = new WorkspacesView();
      view._workspaces = order.map(metaWorkspace => ({ metaWorkspace, visible: false }));
      view._updateVisibility();
      assert.deepEqual(view._workspaces.map(c => c.visible), [false, true, true]);

      const popup = new MonitorWorkspaceSwitcherPopup();
      const shown = [];
      popup._list = { destroy_all_children() {}, add_child: (c) => shown.push(c) };
      popup.redisplay(1);
      assert.deepEqual(shown.map(c => c.active), [true, false]);

      const box = new ThumbnailsBox();
      box._thumbnails = order.map(metaWorkspace => ({ metaWorkspace, visible: false }));
      box.addThumbnails(0, 3);
      assert.deepEqual(box._thumbnails.map(t => t.visible), [false, true, true]);

      // On the parking workspace itself nothing is hidden.
      active = parking;
      view._updateVisibility();
      assert.deepEqual(view._workspaces.map(c => c.visible), [true, true, true]);
      shown.length = 0;
      popup.redisplay(0);
      assert.deepEqual(shown.map(c => c.active), [true, false, false]);
      box.addThumbnails(0, 3);
      assert.deepEqual(box._thumbnails.map(t => t.visible), [true, true, true]);
    } finally {
      self.bgApp.restoreBackgroundAppHiding();
      sessionState.parkingWorkspace = null;
      sessionState.parkingFront = false;
      sessionState.bgAppWindow = null;
      sessionState.bgAppPids.clear();
    }
  });
});

test('clearBackgroundApp: a restart or release drops the app\'s pids, a lock cycle keeps them', () => {
  const lock = sessionState.lockCycle;
  try {
    for (const [lockCycle, release, kept] of [[false, false, false], [false, true, false], [true, true, true]]) {
      const self = makeSelf();
      sessionState.lockCycle = lockCycle;
      sessionState.bgAppPids.add(4242);
      withGlobalWorkspaceManager({ get_n_workspaces: () => 1, get_workspace_by_index: () => null },
        () => self.bgApp.clearBackgroundApp(release));
      assert.equal(sessionState.bgAppPids.has(4242), kept, `lockCycle=${lockCycle} release=${release}`);
      sessionState.bgAppPids.clear();
    }
  } finally {
    sessionState.lockCycle = lock;
  }
});

// Release with a trailing parking that holds a helper window of the app (noted
// while the core ran) and, optionally, a user window. The proc layer has no
// marker for either pid; every sweep start is counted.
async function releaseParking({ user = false } = {}) {
  const Main = await import('resource:///org/gnome/shell/ui/main.js');
  Main.wm.keepWorkspaceAlive = () => {};
  const helper = fakeWin({ pid: 4243 });
  const wins = user ? [helper, fakeWin({ pid: 5000 })] : [helper];
  const parking = fakeWorkspace(wins);
  const removed = [];
  const self = makeSelf({ 'background-app-enabled': true, 'background-app': 'app' });
  self._backgroundAppParkingWs = parking;
  self._backgroundAppParkingFront = false;
  self.bgApp.restoreBackgroundAppHiding = () => {};
  self.currentTime = () => 0;
  self.procInfo.procEnvironCached = () => '';
  let sweeps = 0;
  self.bgApp.startMarkerPidSweep = () => { sweeps++; };
  const lock = sessionState.lockCycle;
  sessionState.lockCycle = false;
  sessionState.bgAppPids.add(4243);
  try {
    withGlobalWorkspaceManager({
      get_n_workspaces: () => 2,
      get_workspace_by_index: (i) => (i === 1 ? parking : null),
      remove_workspace: (ws) => removed.push(ws),
    }, () => self.bgApp.clearBackgroundApp(true));
  } finally {
    sessionState.lockCycle = lock;
  }
  const pidsLeft = sessionState.bgAppPids.size;
  sessionState.bgAppPids.clear();
  return { removed: removed.length, sweeps, pidsLeft };
}

test('clearBackgroundApp: a trailing parking holding only the app\'s windows is removed on release', async () => {
  const r = await releaseParking();
  assert.equal(r.removed, 1);
  assert.equal(r.pidsLeft, 0, 'the pids go after the check');
  assert.equal((await releaseParking({ user: true })).removed, 0, 'a user window keeps it');
});

test('clearBackgroundApp: the release starts no marker sweep', async () => {
  assert.equal((await releaseParking({ user: true })).sweeps, 0);
});
