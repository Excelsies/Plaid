import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, oneMonitor } from '../helpers.mjs';

// Distinct workspaces (deepEqual tells them apart by id).
const workspaces = (n) => Array.from({ length: n }, (_, id) => ({ id }));

// Workspaces renumber on insert/removal: the index is a position in `order`.
function wsSelf(order) {
  let saves = 0;
  const retiled = [];
  const self = makeSelf({}, {
    _wsIndex: (ws) => order.indexOf(ws),
    _scheduleSaveLayouts: () => saves++,
    _scheduleBackgroundAppParkingFix() {},
    _retileWorkspace: (ws) => retiled.push(ws),
  });
  return { self, saves: () => saves, retiled };
}

function withOrder(order, fn) {
  const old = globalThis.global;
  globalThis.global = {
    display: oneMonitor(),
    workspace_manager: {
      get_n_workspaces: () => order.length,
      get_workspace_by_index: (i) => order[i] ?? null,
    },
  };
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

test('shiftWorkspaceIndexKeys: a removed workspace takes its per-index state with it', () => {
  const order = workspaces(4);
  const w3 = order[3];
  const { self, saves } = wsSelf(order);
  self._workspaceLayouts = new Map([[1, 'dwindle'], [2, 'floating'], [3, 'master-stack']]);
  self._masterRatios = new Map([[3, 0.6]]);
  self._stackRatios = new Map([[2, new Map([[0, 2]])]]);
  const win = { get_workspace: () => w3 };
  self._windowWorkspaces.set(win, w3);
  order.splice(2, 1); // workspace 2 removed: w3 is index 2 now
  withOrder(order, () => self.persistence.shiftWorkspaceIndexKeys(2, -1));
  assert.deepEqual([...self._workspaceLayouts].sort(), [[1, 'dwindle'], [2, 'master-stack']]);
  assert.deepEqual([...self._masterRatios], [[2, 0.6]]);
  assert.equal(self._stackRatios.size, 0);
  assert.equal(self._windowWSIndices.get(win), 2);
  assert.equal(saves(), 1);
});

test('shiftWorkspaceIndexKeys: an insert moves the later indices up', () => {
  const order = workspaces(4);
  const { self } = wsSelf(order);
  self._workspaceLayouts = new Map([[1, 'dwindle'], [2, 'master-stack']]);
  withOrder(order, () => self.persistence.shiftWorkspaceIndexKeys(2, +1));
  assert.deepEqual([...self._workspaceLayouts].sort(), [[1, 'dwindle'], [3, 'master-stack']]);
});

test('shiftWorkspaceIndexKeys: nothing to shift saves nothing', () => {
  const order = workspaces(1);
  const { self, saves } = wsSelf(order);
  self._workspaceLayouts = new Map([[1, 'dwindle']]);
  withOrder(order, () => self.persistence.shiftWorkspaceIndexKeys(5, -1));
  assert.equal(saves(), 0);
});

test('shiftWorkspaceIndexKeys: rules for slots beyond the count move too', () => {
  const order = workspaces(3);
  const { self } = wsSelf(order);
  self._persistedLayoutByIndex = new Map([[1, 'dwindle'], [2, 'floating'], [3, 'master-stack'], [5, 'floating']]);
  self._persistedMasterByIndex = new Map([[3, 0.6]]);
  // workspace 2 of 4 removed; slot 5 was never created this session
  withOrder(order, () => self.persistence.shiftWorkspaceIndexKeys(2, -1));
  assert.deepEqual([...self._persistedLayoutByIndex].sort(),
    [[1, 'dwindle'], [2, 'master-stack'], [4, 'floating']]);
  assert.deepEqual([...self._persistedMasterByIndex], [[2, 0.6]]);
});

test('shiftWorkspaceIndexKeys: saved shapes move with their workspace', () => {
  const order = workspaces(3);
  const { self } = wsSelf(order);
  self._persistedDwindleByIndex = new Map([[3, 'a'], [5, 'c']]);
  self._persistedDwindleRaw = new Map([[3, 'h0.6(l,l)']]);
  withOrder(order, () => self.persistence.shiftWorkspaceIndexKeys(2, -1));
  assert.deepEqual([...self._persistedDwindleByIndex].sort(), [[2, 'a'], [4, 'c']]);
  assert.deepEqual([...self._persistedDwindleRaw], [[2, 'h0.6(l,l)']]);
});

test('shiftWorkspaceIndexKeys: a BGAPP parking at slot 0 keeps the slot', () => {
  const order = workspaces(4);
  const { self } = wsSelf(order);
  self._backgroundAppParkingWs = order[0];
  self._workspaceLayouts = new Map([[0, 'floating'], [1, 'dwindle'], [2, 'master-stack']]);
  withOrder(order, () => self.persistence.shiftWorkspaceIndexKeys(0, +1)); // move left from ws 1
  assert.deepEqual([...self._workspaceLayouts].sort(), [[0, 'floating'], [2, 'dwindle'], [3, 'master-stack']]);
  order.splice(1, 1);
  withOrder(order, () => self.persistence.shiftWorkspaceIndexKeys(1, -1));
  assert.deepEqual([...self._workspaceLayouts].sort(), [[0, 'floating'], [1, 'dwindle'], [2, 'master-stack']]);
});

test('shiftWorkspaceIndexKeys: with a trailing parking, slot 0 is an ordinary workspace', () => {
  const order = workspaces(4);
  const { self } = wsSelf(order);
  self._backgroundAppParkingWs = order[2];
  self._workspaceLayouts = new Map([[0, 'dwindle'], [1, 'master-stack'], [2, 'floating']]);
  order.splice(0, 1);
  withOrder(order, () => self.persistence.shiftWorkspaceIndexKeys(0, -1));
  assert.deepEqual([...self._workspaceLayouts].sort(), [[0, 'master-stack'], [1, 'floating']]);
});

test('workspace-removed: the next workspace keeps its layout and its windows (regression)', () => {
  // ws 1 had one window (dwindle), ws 2 two (centered master-stack); the
  // window on ws 1 closed and dynamic workspaces removed ws 1.
  const order = workspaces(4);
  const [, w1, w2, w3] = order;
  const { self, retiled } = wsSelf(order);
  const a = fakeWin();
  const b = fakeWin();
  a.get_workspace = () => w2;
  b.get_workspace = () => w2;
  self._workspaceLayouts = new Map([[1, 'dwindle'], [2, 'centered-master-stack']]);
  self._workspaceOrders = new Map([[w1, []], [w2, [a, b]], [w3, []]]);
  self._windowWorkspaces = new Map([[a, w2], [b, w2]]);
  self._windowWSIndices = new Map([[a, 2], [b, 2]]);
  self._retileAfterGrab.add(w1);
  order.splice(1, 1);
  withOrder(order, () => self.signals.onWorkspaceRemoved(1));
  assert.equal(self._getWorkspaceLayout(w2), 'centered-master-stack');
  assert.equal(self._getWorkspaceLayout(w3), '');
  assert.deepEqual(self._getWindowsForWorkspace(w2), [a, b]);
  assert.equal(self._workspaceOrders.has(w1), false);
  assert.equal(self._retileAfterGrab.has(w1), false);
  assert.deepEqual(retiled, [w2, w3]);
});

// The shell's insertWorkspace(pos): append (mutter emits workspace-added),
// move the windows at pos and after up one workspace, then activate the
// workspace the active windows went to.
function fakeShellWm(self, order, wins, seen) {
  return {
    insertWorkspace(pos) {
      order.push({ id: order.length });
      self.signals.onWorkspaceAdded(order.length - 1);
      for (const w of wins) {
        const i = order.indexOf(w._ws);
        if (i >= pos) w._ws = order[i + 1];
      }
      seen.push(self._getWorkspaceLayout(order[pos + 1]));
    },
  };
}

test('insertWorkspace: the per-index state moves before the new workspace activates', () => {
  const order = workspaces(3);
  const w2 = order[2];
  const { self, saves } = wsSelf(order);
  const a = fakeWin();
  a._ws = w2;
  self._workspaceLayouts = new Map([[1, 'dwindle'], [2, 'master-stack']]);
  const seen = [];
  const wm = fakeShellWm(self, order, [a], seen);
  const original = wm.insertWorkspace;
  withOrder(order, () => {
    self.signals.hookInsertWorkspace(wm);
    wm.insertWorkspace(1); // an overview drop between thumbnails 0 and 1
  });
  // The windows of ws 1 now live on ws 2, those of ws 2 on ws 3.
  assert.deepEqual([...self._workspaceLayouts].sort(), [[2, 'dwindle'], [3, 'master-stack']]);
  assert.deepEqual(seen, ['dwindle']);
  assert.equal(a._ws, order[3]);
  assert.equal(saves(), 1);

  self.signals.destroy();
  assert.equal(wm.insertWorkspace, original);
});

test('insertWorkspace: no workspace appended (static workspaces), nothing shifts', () => {
  const order = workspaces(3);
  const { self } = wsSelf(order);
  self._workspaceLayouts = new Map([[1, 'dwindle']]);
  const wm = { insertWorkspace() {} };
  withOrder(order, () => {
    self.signals.hookInsertWorkspace(wm);
    wm.insertWorkspace(0);
    // A later plain append moves nothing either.
    order.push({ id: 3 });
    self.signals.onWorkspaceAdded(3);
  });
  assert.deepEqual([...self._workspaceLayouts], [[1, 'dwindle']]);
});

test('insertWorkspace: only its own append (at the old count) shifts', () => {
  const order = workspaces(3);
  const { self } = wsSelf(order);
  self._workspaceLayouts = new Map([[1, 'dwindle']]);
  // Not the append at index 3 (the count before): a stray workspace-added.
  const wm = { insertWorkspace() { self.signals.onWorkspaceAdded(1); } };
  withOrder(order, () => {
    self.signals.hookInsertWorkspace(wm);
    wm.insertWorkspace(1);
  });
  assert.deepEqual([...self._workspaceLayouts], [[1, 'dwindle']]);
});

test('workspace-removed during teardown schedules no layout save (regression: leaked timer)', () => {
  const order = workspaces(4);
  const self = makeSelf({}, {
    _wsIndex: (ws) => order.indexOf(ws),
    _retileWorkspace() {},
  });
  self._workspaceLayouts = new Map([[1, 'dwindle'], [3, 'master-stack']]);
  self._workspaceOrders = new Map([[order[2], []]]);
  // The final save writes the settings (GSettings has the setters).
  self._settings.set_strv = () => {};
  self._settings.set_string = () => {};
  withOrder(order, () => {
    self.persistence.destroy(); // the final save of core.destroy
    order.splice(2, 1); // the BGAPP releases its trailing parking
    self.signals.onWorkspaceRemoved(2);
  });
  assert.equal(self._workspaceLayoutsSaveId, 0);
  assert.deepEqual([...self._workspaceLayouts].sort(), [[1, 'dwindle'], [2, 'master-stack']]);
});
