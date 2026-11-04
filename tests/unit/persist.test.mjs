import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

test('loadPersistedLayoutRules: stack weights load in the format the save writes', () => {
  const self = makeSelf({ 'workspace-stack-ratios': ['1:0:1.0,1:0.8', '3:2:1.5', 'bad', ':0:1', '0:0:1'] });
  self.persistence.loadPersistedLayoutRules();
  assert.deepEqual([...self._persistedStackByIndex.keys()].sort(), [1, 3]);
  assert.deepEqual([...self._persistedStackByIndex.get(1)], [[0, 1.0], [1, 0.8]]);
  assert.deepEqual([...self._persistedStackByIndex.get(3)], [[2, 1.5]]);
});
