import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

// A miss at the end of an animation is often a client still answering the
// last configure. When the retry fires and the window has landed, that is a
// landing: no workspace retile.

const SLOT = { targetX: 4, targetY: 36, targetW: 1574, targetH: 1400 };

function world(frame) {
  const timers = [];
  const retiles = [];
  const WS = {};
  const self = makeSelf({}, { _windowMasks: new Map(), _scheduleBorders() {} });
  self.signals.addTimeout = (ms, fn) => timers.push(fn);
  self.layouts.retileWorkspace = (ws) => retiles.push(ws);
  self.bsp.bspGetTree = () => null;
  self.bsp.minimumsIgnored = () => false;
  self.bsp.layoutMinSize = () => ({ w: 0, h: 0 });
  const win = fakeWin({ frame });
  const actor = { visible: false, set_opacity() {} };
  win.get_compositor_private = () => actor;
  win.get_id = () => 1;
  win.get_workspace = () => WS;
  let f = { ...frame };
  win.get_frame_rect = () => ({ ...f });
  return { self, win, timers, retiles, WS, setFrame: (nf) => { f = { ...nf }; } };
}

test('late landing: the window reached its slot before the retry: no retile, the record goes', () => {
  const t = world({ x: 35, y: 36, width: 1562, height: 1389 }); // still on its way
  t.self.placement.verifyAnimationLanding({ win: t.win, ...SLOT }, 'tiled');
  assert.equal(t.timers.length, 1);
  assert.equal(t.self._landings.has(t.win), true);
  t.setFrame({ x: 4, y: 36, width: 1574, height: 1400 });
  t.timers[0]();
  assert.deepEqual(t.retiles, []);
  assert.equal(t.self._landings.has(t.win), false);
});

test('late landing: still off its slot when the retry fires: the workspace retiles', () => {
  const t = world({ x: 35, y: 36, width: 1562, height: 1389 });
  t.self.placement.verifyAnimationLanding({ win: t.win, ...SLOT }, 'tiled');
  t.setFrame({ x: 30, y: 36, width: 1500, height: 1389 });
  t.timers[0]();
  assert.deepEqual(t.retiles, [t.WS]);
});
