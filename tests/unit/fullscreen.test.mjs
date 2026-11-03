import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

function withWorkspace(fn) {
  const ws = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 2000, height: 1000 }) };
  const old = globalThis.global;
  globalThis.global = {
    display: { get_primary_monitor: () => 0 },
    workspace_manager: {
      get_n_workspaces: () => 2,
      get_workspace_by_index: (i) => (i === 1 ? ws : null),
      get_active_workspace: () => ws,
    },
    get_pointer: () => [0, 0],
  };
  try {
    return fn(ws);
  } finally {
    globalThis.global = old;
  }
}

let nextId = 1;
// A tiled window. The layout never configures it (no workspace) unless it is
// fullscreen, which every move path skips anyway.
function tile(opts = {}, ws = null) {
  const w = fakeWin(opts);
  const id = nextId++;
  w.get_id = () => id;
  w.get_workspace = () => (opts.fullscreen ? ws : null);
  w.get_compositor_private = () => null;
  return w;
}

test('isFloating: a fullscreen tile is excluded from tiling, but does not float', () => {
  const self = makeSelf();
  const w = tile({ fullscreen: true });
  assert.equal(self._isFloating(w), true);
  assert.equal(self.windows.floatsWhenWindowed(w), false);
});

test('retileDwindle: a fullscreen tile keeps its leaf (regression: pruned by any retile)', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const a = tile({ fullscreen: true }, ws);
    const [b, c] = [tile(), tile()];
    self._windowWorkspaces.set(a, ws);
    self._bspTrees.set(ws, split('h', 0.5, leaf(a), leaf(b)));
    self._retileDwindle(ws, [b, c]); // C opens while A is fullscreen
    assert.deepEqual(self._bspCollectWindows(self._bspTrees.get(ws)).map(w => w.get_id()).sort(),
      [a, b, c].map(w => w.get_id()).sort());
  });
});

test('retileDwindle: a fullscreen float or a minimized fullscreen window loses its leaf', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const floated = tile({ fullscreen: true }, ws);
    const hidden = tile({ fullscreen: true, minimized: true }, ws);
    const [b, c] = [tile(), tile()];
    self._windowWorkspaces.set(floated, ws);
    self._windowWorkspaces.set(hidden, ws);
    self._toggleFloatWindows.add(floated);
    self._bspTrees.set(ws, split('h', 0.5, leaf(floated), split('v', 0.5, leaf(hidden), leaf(b))));
    self._retileDwindle(ws, [b, c]);
    assert.deepEqual(self._bspCollectWindows(self._bspTrees.get(ws)), [b, c]);
  });
});

test('onWindowIdentityChanged: a retitled fullscreen tile keeps its leaf', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const a = tile({ fullscreen: true }, ws);
    const b = tile();
    self._windowWorkspaces.set(a, ws);
    const tree = split('h', 0.5, leaf(a), leaf(b));
    self._bspTrees.set(ws, tree);
    self.windows.onWindowIdentityChanged(a);
    assert.equal(self._bspTrees.get(ws), tree);
    assert.deepEqual(self._bspCollectWindows(tree), [a, b]);
  });
});

function signalWin(state) {
  const handlers = {};
  const w = tile();
  w.is_fullscreen = () => state.fullscreen;
  w.get_workspace = () => state.ws;
  w.connectObject = (name, cb) => { handlers[name] = cb; };
  w.disconnectObject = () => {};
  return { w, handlers };
}

test('notify::fullscreen: leaving fullscreen retiles, entering does not', () => {
  const ws = {};
  const retiled = [];
  const self = makeSelf({}, { _retileWorkspace: (x) => retiled.push(x) });
  const state = { fullscreen: true, ws };
  const { w, handlers } = signalWin(state);
  self.windows.connectWindowSignals(w);
  handlers['notify::fullscreen']();
  assert.deepEqual(retiled, []);
  state.fullscreen = false;
  handlers['notify::fullscreen']();
  assert.deepEqual(retiled, [ws]);
});

test('notify::minimized: a fullscreen tile retiles, a float does not', () => {
  const ws = {};
  const retiled = [];
  const self = makeSelf({}, { _retileWorkspace: (x) => retiled.push(x) });
  const tileSig = signalWin({ fullscreen: true, ws });
  self.windows.connectWindowSignals(tileSig.w);
  tileSig.handlers['notify::minimized']();
  const floatSig = signalWin({ fullscreen: true, ws });
  self._toggleFloatWindows.add(floatSig.w);
  self.windows.connectWindowSignals(floatSig.w);
  floatSig.handlers['notify::minimized']();
  assert.deepEqual(retiled, [ws]);
});

test('isFullscreenTile: only on its workspace and on the tiled monitor', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const a = tile({ fullscreen: true }, ws);
    const other = tile({ fullscreen: true, monitor: 1 }, ws);
    self._windowWorkspaces.set(a, ws);
    self._windowWorkspaces.set(other, ws);
    assert.equal(self.windows.isFullscreenTile(a, ws), true);
    assert.equal(self.windows.isFullscreenTile(a, {}), false);
    assert.equal(self.windows.isFullscreenTile(other, ws), false);
  });
});

test('retileDwindle: a fullscreen tile on another monitor loses its leaf', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const a = tile({ fullscreen: true, monitor: 1 }, ws);
    const [b, c] = [tile(), tile()];
    self._windowWorkspaces.set(a, ws);
    self._bspTrees.set(ws, split('h', 0.5, leaf(a), leaf(b)));
    self._retileDwindle(ws, [b, c]);
    assert.deepEqual(self._bspCollectWindows(self._bspTrees.get(ws)), [b, c]);
  });
});

test('adjustForConstraints: a kept fullscreen leaf does not bend its parent (regression)', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const fs = tile({ fullscreen: true, frame: { x: 0, y: 0, width: 2000, height: 1000 } }, ws);
    const b = tile({ frame: { x: 1000, y: 0, width: 1000, height: 500 } });
    const c = tile({ frame: { x: 1000, y: 500, width: 1000, height: 500 } });
    const tree = split('h', 0.5, leaf(fs), split('v', 0.5, leaf(b), leaf(c)));
    self.bsp.bspLayout(tree, 0, 0, 2000, 1000, 0);
    assert.equal(self.bsp.adjustForConstraints(tree, null, true, 0, 0, 2000, 1000, 0, 0), false);
    assert.equal(tree.ratio, 0.5);
  });
});
