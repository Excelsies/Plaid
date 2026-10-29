import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

// Five workspaces; index 0 is the background-app parking workspace.
const wss = [0, 1, 2, 3, 4].map((i) => ({ index: () => i }));
// Minimal global.workspace_manager stand-in.
function stubGlobal() {
  globalThis.global = {
    workspace_manager: {
      get_n_workspaces: () => wss.length,
      get_workspace_by_index: (i) => wss[i] ?? null,
    },
  };
}

test('_dragScrollTarget: the adjacent workspace in the scroll direction', () => {
  stubGlobal();
  const self = makeSelf({}, { _backgroundAppParkingWs: wss[0] });
  assert.equal(self._dragScrollTarget(wss[2], 1), wss[3]);
  assert.equal(self._dragScrollTarget(wss[2], -1), wss[1]);
});

test('_dragScrollTarget: skips the parking workspace and never wraps', () => {
  stubGlobal();
  const self = makeSelf({}, { _backgroundAppParkingWs: wss[0] });
  assert.equal(self._dragScrollTarget(wss[1], -1), null);
  assert.equal(self._dragScrollTarget(wss[4], 1), null);
});

test('_dragScrollTarget: workspace 0 is a normal target without a parking workspace', () => {
  stubGlobal();
  const self = makeSelf({}, { _backgroundAppParkingWs: null });
  assert.equal(self._dragScrollTarget(wss[1], -1), wss[0]);
});
