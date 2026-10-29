import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

// Workspaces renumber on insert/removal: index() reads a shared array.
function wsSelf(order) {
  let saves = 0;
  const self = makeSelf({}, {
    _workspaceLayouts: new Map(),
    _masterRatios: new Map(),
    _stackRatios: new Map(),
    _windowWorkspaces: new Map(),
    _windowWSIndices: new Map(),
    _wsIndex: (ws) => order.indexOf(ws),
    _scheduleSaveLayouts: () => saves++,
  });
  return { self, saves: () => saves };
}

test('_shiftWorkspaceIndexKeys: a removed workspace takes its per-index state with it', () => {
  const [w0, w1, w2, w3] = [{}, {}, {}, {}];
  const order = [w0, w1, w2, w3];
  const { self, saves } = wsSelf(order);
  self._workspaceLayouts = new Map([[1, 'dwindle'], [2, 'floating'], [3, 'master-stack']]);
  self._masterRatios = new Map([[3, 0.6]]);
  self._windowWorkspaces.set('win', w3);
  order.splice(2, 1); // workspace 2 removed: w3 is index 2 now
  self._shiftWorkspaceIndexKeys(2, -1, 4);
  assert.deepEqual([...self._workspaceLayouts].sort(), [[1, 'dwindle'], [2, 'master-stack']]);
  assert.deepEqual([...self._masterRatios], [[2, 0.6]]);
  assert.equal(self._windowWSIndices.get('win'), 2);
  assert.equal(saves(), 1);
});

test('_shiftWorkspaceIndexKeys: an inserted workspace moves the later indices up', () => {
  const [w0, w1, w2, added] = [{}, {}, {}, {}];
  const order = [w0, w1, w2];
  const { self } = wsSelf(order);
  self._workspaceLayouts = new Map([[1, 'dwindle'], [2, 'master-stack']]);
  order.splice(2, 0, added);
  self._shiftWorkspaceIndexKeys(2, +1, 3);
  assert.deepEqual([...self._workspaceLayouts].sort(), [[1, 'dwindle'], [3, 'master-stack']]);
});

test('_shiftWorkspaceIndexKeys: nothing to shift saves nothing', () => {
  const { self, saves } = wsSelf([{}]);
  self._workspaceLayouts = new Map([[1, 'dwindle']]);
  self._shiftWorkspaceIndexKeys(5, -1, 6);
  assert.equal(saves(), 0);
});

test('_shiftWorkspaceIndexKeys: persisted rules move with their workspace, future slots stay', () => {
  const { self } = wsSelf([{}, {}, {}]);
  self._persistedLayoutByIndex = new Map([[1, 'dwindle'], [2, 'floating'], [3, 'master-stack'], [5, 'floating']]);
  self._persistedMasterByIndex = new Map([[3, 0.6]]);
  // workspace 2 of 4 removed; slot 5 was never created this session
  self._shiftWorkspaceIndexKeys(2, -1, 4);
  assert.deepEqual([...self._persistedLayoutByIndex].sort(),
    [[1, 'dwindle'], [2, 'master-stack'], [5, 'floating']]);
  assert.deepEqual([...self._persistedMasterByIndex], [[2, 0.6]]);
});

test('_shiftWorkspaceIndexKeys: saved shapes move with their workspace', () => {
  const { self } = wsSelf([{}, {}, {}]);
  self._persistedDwindleByIndex = new Map([[3, 'a'], [5, 'c']]);
  self._persistedDwindleRaw = new Map([[3, 'h0.6(l,l)']]);
  self._shiftWorkspaceIndexKeys(2, -1, 4);
  assert.deepEqual([...self._persistedDwindleByIndex].sort(), [[2, 'a'], [5, 'c']]);
  assert.deepEqual([...self._persistedDwindleRaw], [[2, 'h0.6(l,l)']]);
});

test('_shiftWorkspaceIndexKeys: a workspace appended at the end moves no rule', () => {
  const { self, saves } = wsSelf([{}, {}, {}]);
  self._persistedLayoutByIndex = new Map([[1, 'dwindle'], [2, 'floating'], [3, 'master-stack']]);
  self._shiftWorkspaceIndexKeys(2, +1, 2); // mutter appends: index === old count
  assert.deepEqual([...self._persistedLayoutByIndex].sort(),
    [[1, 'dwindle'], [2, 'floating'], [3, 'master-stack']]);
  assert.equal(saves(), 0);
});
