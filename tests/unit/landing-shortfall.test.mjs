import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

// A frame that holds still a little short of its slot, at the slot's top-left
// (a client sizing in cell steps), is accepted after one retry instead of three.

const SLOT = { targetX: 0, targetY: 0, targetW: 800, targetH: 600 };

function world(frame) {
  const timers = [];
  const self = makeSelf({}, { _windowMasks: new Map(), _scheduleBorders() {} });
  self.signals.addTimeout = (ms, fn) => timers.push(fn);
  const win = fakeWin({ frame });
  const actor = { visible: false, set_opacity() {} };
  win.get_compositor_private = () => actor;
  win.get_id = () => 1;
  win.get_workspace = () => null;
  let f = { ...frame };
  win.get_frame_rect = () => ({ ...f });
  const verify = () => self.placement.verifyAnimationLanding({ win, ...SLOT }, 'tiled');
  return { self, win, timers, verify, setFrame: (nf) => { f = { ...nf }; } };
}
const accepted = (self, win) => self.placement.landingAccepted(win, 0, 0, 800, 600);

test('shortfall: a still frame short of its slot at its corner is accepted on the second miss', () => {
  const t = world({ x: 0, y: 0, width: 780, height: 590 });
  t.verify();
  assert.equal(accepted(t.self, t.win), false);
  assert.equal(t.timers.length, 1); // one retry sent
  t.verify();
  assert.equal(accepted(t.self, t.win), true);
  assert.equal(t.timers.length, 1); // no second retry
  assert.equal(t.win.get_compositor_private().visible, true);
});

test('shortfall: the bound is min(64 px, 10%) per axis, inclusive', () => {
  for (const [w, h, ok] of [[736, 600, true], [735, 600, false], [800, 540, true], [800, 539, false]]) {
    const t = world({ x: 0, y: 0, width: w, height: h });
    t.verify(); t.verify();
    assert.equal(accepted(t.self, t.win), ok, `${w}x${h}`);
  }
});

test('shortfall: a frame off the slot corner (a spawn rect), larger, or moving is retried', () => {
  for (const frame of [
    { x: 100, y: 50, width: 780, height: 590 }, // centred spawn rect
    { x: 5, y: 0, width: 780, height: 590 },    // 5 px off the corner
    { x: 0, y: 0, width: 820, height: 600 },    // larger than the slot
  ]) {
    const t = world(frame);
    t.verify(); t.verify();
    assert.equal(accepted(t.self, t.win), false, JSON.stringify(frame));
    assert.equal(t.timers.length, 2);
  }
  const m = world({ x: 0, y: 0, width: 780, height: 590 });
  m.verify();
  m.setFrame({ x: 0, y: 0, width: 770, height: 590 }); // still resizing
  m.verify();
  assert.equal(accepted(m.self, m.win), false);
});

test('shortfall: nothing is accepted early while the window settles', () => {
  // A miss counted on the slot, then the window settles again (a pop-in
  // re-arms the settle poll): a client restoring its own geometry is not
  // accepted at it.
  const t = world({ x: 0, y: 0, width: 780, height: 590 });
  t.verify();
  assert.equal(t.timers.length, 1);
  t.win._plaidSettleUntil = Date.now() + 6000;
  t.verify(); t.verify();
  assert.equal(accepted(t.self, t.win), false);
  assert.equal(t.timers.length, 1);
});

test('shortfall: a miss on another slot does not count as the retry', () => {
  const t = world({ x: 0, y: 0, width: 780, height: 590 });
  t.self.placement.verifyAnimationLanding({ win: t.win, ...SLOT, targetW: 1200 }, 'tiled');
  t.verify();
  assert.equal(accepted(t.self, t.win), false);
});
