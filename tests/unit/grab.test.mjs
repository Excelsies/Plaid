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

// A move grab with the pointer far from the press: only the window's travel
// decides whether it was a drop.
function moveEndSelf(frame) {
  const repositioned = [];
  const { self } = grabSelf({
    _repositionWindow: (win, ws) => repositioned.push([win, ws]),
  });
  self._grabOp = MOVE;
  self._grabStartX = 100;
  self._grabStartY = 100;
  self._grabStartFrame = { x: 0, y: 0 };
  self._grabGrace = 10;
  const ws = {};
  const win = { ...grabbed(ws), get_frame_rect: () => ({ ...frame }) };
  withWorkspaces([ws], ws, () => {
    globalThis.global.get_pointer = () => [900, 700];
    self._handleGrabEnd(win, MOVE);
  });
  return { self, repositioned };
}

test('_handleGrabEnd: a drag that did not move the window is not a drop (Escape)', () => {
  const { self, repositioned } = moveEndSelf({ x: 0, y: 0, width: 800, height: 600 });
  assert.deepEqual(repositioned, []);
  assert.equal(self._grabStartFrame, null);
});

test('_handleGrabEnd: a window moved past the grace is dropped', () => {
  const { repositioned } = moveEndSelf({ x: 400, y: 300, width: 800, height: 600 });
  assert.equal(repositioned.length, 1);
});

test('updateMoveDragPreview: hidden until the window, not the pointer, travelled', () => {
  let hidden = 0;
  let targeted = 0;
  const ws = {};
  const self = makeSelf({}, {
    _hideDropPreview: () => hidden++,
    _getWorkspaceLayout: () => 'dwindle',
    _getWindowsForWorkspace: () => [{}, {}],
    _isFloating: () => false,
    _computeDwindleDropTarget: () => { targeted++; return null; },
  });
  self._grabStartFrame = { x: 0, y: 0 };
  self._grabGrace = 10;
  let frame = { x: 0, y: 0, width: 800, height: 600 };
  const win = { get_workspace: () => ws, get_frame_rect: () => ({ ...frame }) };
  withWorkspaces([ws], ws, () => {
    globalThis.global.get_pointer = () => [900, 700];
    self.dragPreview.updateMoveDragPreview(win);
    assert.equal(targeted, 0);
    frame = { x: 300, y: 0, width: 800, height: 600 };
    self.dragPreview.updateMoveDragPreview(win);
  });
  assert.equal(targeted, 1);
  assert.equal(hidden, 2);
});
