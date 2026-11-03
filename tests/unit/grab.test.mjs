import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

const MOVE = 1;
const RESIZE_E = 1 | (2 << 12);

// Distinct workspaces (deepEqual tells them apart by id).
const workspaces = (n) => Array.from({ length: n }, (_, id) => ({ id }));

function withWorkspaces(workspaces, active, fn) {
  const old = globalThis.global;
  globalThis.global = {
    workspace_manager: {
      get_n_workspaces: () => workspaces.length,
      get_workspace_by_index: (i) => workspaces[i] ?? null,
      get_active_workspace: () => active,
    },
    get_pointer: () => [0, 0],
  };
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

function grabSelf(overrides = {}) {
  const retiled = [];
  const self = makeSelf({ enabled: true }, {
    _isFloating: () => false,
    _kickMaskNow() {},
    _getWindowsForWorkspace: () => [],
    _retileWorkspace: (ws) => retiled.push(ws),
    ...overrides,
  });
  return { self, retiled };
}

const grabbed = (ws) => ({
  get_workspace: () => ws,
  get_wm_class_instance: () => 'gjs',
  raise() {},
});

test('_doRetileWorkspace: a retile requested during a grab is deferred, not dropped', () => {
  let scanned = false;
  const [ws] = workspaces(1);
  const self = makeSelf({ enabled: true }, {
    _grabOp: MOVE,
    _wsIndex: () => 1,
    _getWindowsForWorkspace() { scanned = true; return []; },
  });
  self._doRetileWorkspace(ws);
  assert.equal(scanned, false);
  assert.equal(self._retileAfterGrab.size, 1);
  assert.equal(self._retileAfterGrab.has(ws), true);
});

test('_handleGrabEnd: deferred retiles run, active workspace first, drop workspace once', () => {
  const [w0, w1, w2, w3] = workspaces(4);
  const { self, retiled } = grabSelf();
  self._grabOp = RESIZE_E;
  self._retileAfterGrab.add(w3);
  self._retileAfterGrab.add(w1);
  self._retileAfterGrab.add(w2);
  withWorkspaces([w0, w1, w2, w3], w2, () => self._handleGrabEnd(grabbed(w3), RESIZE_E));
  // w3 is the drop workspace: retiled by the grab end itself, not again.
  assert.deepEqual(retiled, [w3, w2, w1]);
  assert.equal(self._retileAfterGrab.size, 0);
  assert.equal(self._grabOp, null);
});

test('_handleGrabEnd: a workspace removed during the grab is skipped', () => {
  const [w0, w1, gone] = workspaces(3);
  const { self, retiled } = grabSelf();
  self._grabOp = MOVE;
  self._retileAfterGrab.add(gone);
  self._retileAfterGrab.add(w1);
  withWorkspaces([w0, w1], w0, () => self._handleGrabEnd(null, MOVE));
  assert.deepEqual(retiled, [w1]);
});

test('_handleGrabEnd: no deferred retile runs once shutdown has begun', () => {
  const [w0, w1] = workspaces(2);
  const { self, retiled } = grabSelf({ _shuttingDown: true });
  self._grabOp = MOVE;
  self._retileAfterGrab.add(w1);
  withWorkspaces([w0, w1], w1, () => self._handleGrabEnd(null, MOVE));
  assert.deepEqual(retiled, []);
  assert.equal(self._retileAfterGrab.size, 0);
});

test('_onShellShutdown: drops retiles deferred by a grab', () => {
  const self = makeSelf({}, { _shuttingDown: false, _cancelAnimation() {} });
  self._retileAfterGrab.add({});
  self._onShellShutdown();
  assert.equal(self._retileAfterGrab.size, 0);
});
