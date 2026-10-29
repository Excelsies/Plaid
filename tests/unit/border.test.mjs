import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

test('_gradientThetaStep: one colour level per pi / (widest channel difference)', () => {
  const self = makeSelf();
  const black = { r: 0, g: 0, b: 0 };
  assert.equal(self._gradientThetaStep(black, { r: 1, g: 0, b: 0 }), Math.PI / 255);
  assert.equal(self._gradientThetaStep(black, { r: 0, g: 10 / 255, b: 2 / 255 }), Math.PI / 10);
});

test('_gradientThetaStep: equal (or sub-level) colours never need a re-render', () => {
  const self = makeSelf();
  const c = { r: 0.5, g: 0.5, b: 0.5 };
  assert.equal(self._gradientThetaStep(c, c), Infinity);
  assert.equal(self._gradientThetaStep(c, { r: 0.5 + 0.5 / 255, g: 0.5, b: 0.5 }), Infinity);
});

test('_gradientStale: undrawn is stale, then only after a full step, across the 2*pi wrap', () => {
  const self = makeSelf();
  assert.equal(self._gradientStale(undefined, 1, 0.1), true);
  assert.equal(self._gradientStale(1, 1.05, 0.1), false);
  assert.equal(self._gradientStale(1, 1.1, 0.1), true);
  assert.equal(self._gradientStale(Math.PI * 2 - 0.02, 0.03, 0.1), false);
  assert.equal(self._gradientStale(Math.PI * 2 - 0.05, 0.06, 0.1), true);
  assert.equal(self._gradientStale(undefined, 1, Infinity), false);
});

test('_settingsMemo reads each key once per pass', () => {
  let reads = 0;
  const self = makeSelf();
  self._settings = { get_int: () => ++reads, get_boolean: () => true, get_string: () => '', get_strv: () => [] };
  const memo = self._settingsMemo();
  assert.equal(memo.get_int('border-radius'), 1);
  assert.equal(memo.get_int('border-radius'), 1);
  assert.equal(memo.get_int('active-border-width'), 2);
  assert.equal(reads, 2);
});
