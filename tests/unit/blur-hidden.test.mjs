import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import { makeSelf } from '../helpers.mjs';

// A blurred window that stays hidden gives its blur's GL targets back.

function fakeBlur(mapped) {
  const actor = { mapped };
  return { actor, releases: 0, held: true, get_actor: () => actor,
    releaseTargets() { if (!this.held) return false; this.held = false; this.releases++; return true; } };
}

test('releaseHiddenTargets: only a blur hidden for the whole wait lets go, once; a shown one keeps them', () => {
  const self = makeSelf({ enabled: true, 'window-blur': true });
  const shown = fakeBlur(true), hidden = fakeBlur(false), square = { get_actor: () => ({ mapped: false }) };
  self._windowBlurs = new Map([[{}, shown], [{}, hidden], [{}, square]]);
  const s = 1000000;
  assert.equal(self.blur.releaseHiddenTargets(1 * s), 0, 'just hidden');
  assert.equal(self.blur.releaseHiddenTargets(3.5 * s), 0, 'not long enough');
  assert.equal(self.blur.releaseHiddenTargets(4 * s), 1);
  assert.equal(self.blur.releaseHiddenTargets(9 * s), 0, 'already released');
  assert.deepEqual([shown.releases, hidden.releases], [0, 1]);
  // Shown again, then hidden: the wait starts over.
  hidden.actor.mapped = true; hidden.held = true;
  self.blur.releaseHiddenTargets(10 * s);
  hidden.actor.mapped = false;
  assert.equal(self.blur.releaseHiddenTargets(11 * s), 0);
  assert.equal(self.blur.releaseHiddenTargets(14 * s), 1);
});

test('scheduleHiddenSweep: one sweep while blurs exist; it ends when the last blur goes', () => {
  const self = makeSelf({ enabled: true, 'window-blur': true });
  const timers = [];
  self.signals.addTimeout = (ms, fn) => { timers.push([ms, fn]); return timers.length; };
  self._windowBlurs = new Map([[{}, fakeBlur(true)]]);
  self.blur.scheduleHiddenSweep();
  self.blur.scheduleHiddenSweep();
  assert.equal(timers.length, 1, 'one sweep');
  assert.equal(timers[0][1](), GLib.SOURCE_CONTINUE);
  self._windowBlurs.clear();
  assert.equal(timers[0][1](), GLib.SOURCE_REMOVE);
  self.blur.scheduleHiddenSweep();
  assert.equal(timers.length, 2, 'armed again by the next blur');
});

test('releaseHiddenTargets: the overview (it hides the window group) and a paint since counted as shown', async () => {
  const Main = await import('resource:///org/gnome/shell/ui/main.js');
  const self = makeSelf({ enabled: true, 'window-blur': true });
  const b = fakeBlur(false);
  self._windowBlurs = new Map([[{}, b]]);
  const s = 1000000;
  Main.overview.visible = true;
  try {
    self.blur.releaseHiddenTargets(1 * s);
    assert.equal(self.blur.releaseHiddenTargets(10 * s), 0, 'overview open');
  } finally {
    Main.overview.visible = false;
  }
  self.blur.releaseHiddenTargets(20 * s);
  b._lastPaint = 21 * s; // shown and painted between two sweeps
  assert.equal(self.blur.releaseHiddenTargets(24 * s), 0, 'a paint since restarts the wait');
  self.blur.releaseHiddenTargets(25 * s);
  assert.equal(self.blur.releaseHiddenTargets(28 * s), 1);
});
