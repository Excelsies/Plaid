import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

const slot = (x, w) => ({ targetX: x, targetY: 0, targetW: w, targetH: 600 });

function landingSelf(settings = {}) {
  const timers = [];
  const self = makeSelf(settings, {
    _windowMasks: new Map(),
    _scheduleBorders() {},
  });
  self.signals.addTimeout = (ms, fn) => timers.push(fn);
  return { self, timers };
}

function landingWin(opts = {}) {
  const w = fakeWin({ frame: { x: 0, y: 0, width: 900, height: 600 }, ...opts });
  const actor = { visible: false, set_opacity() {} };
  w.get_compositor_private = () => actor;
  w.get_id = () => w._testId;
  w.get_workspace = () => null;
  return w;
}

test('landing: three missed retries accept the slot, never float the window', () => {
  const { self, timers } = landingSelf();
  const win = landingWin();
  for (let i = 0; i < 4; i++) self.placement.retryLanding(win, slot(0, 800));
  assert.equal(timers.length, 3);
  assert.equal(self.placement.landingAccepted(win, 0, 0, 800, 600), true);
  assert.equal(self.windows.isFloating(win), false);
  assert.equal(self._toggleFloatWindows.has(win), false);
  assert.equal(win.get_compositor_private().visible, true);
});

test('landing: a new slot gets a fresh budget', () => {
  const { self, timers } = landingSelf();
  const win = landingWin();
  for (let i = 0; i < 3; i++) self.placement.retryLanding(win, slot(0, 800));
  self.placement.retryLanding(win, slot(0, 1200));
  assert.equal(timers.length, 4);
  assert.equal(self._landingAccepted.has(win), false);
  assert.equal(self._landingRetries.get(win).n, 1);
});

test('landing: an accepted slot is not re-verified; another slot is', () => {
  const { self } = landingSelf();
  const win = landingWin();
  for (let i = 0; i < 4; i++) self.placement.retryLanding(win, slot(0, 800));
  let retried = 0;
  self.placement.retryLanding = () => retried++;
  assert.equal(self.placement.verifyAnimationLanding({ win, ...slot(0, 800) }, 'tiled'), false);
  assert.equal(retried, 0);
  self.placement.verifyAnimationLanding({ win, ...slot(0, 1200) }, 'tiled');
  assert.equal(retried, 1);
  assert.equal(self._landingAccepted.has(win), false);
});

test('landing: a miss while the window settles is not counted', () => {
  const { self, timers } = landingSelf();
  const win = landingWin();
  for (let i = 0; i < 5; i++) self.placement.retryLanding(win, slot(0, 800), true);
  assert.equal(timers.length, 0);
  assert.equal(self._landingRetries.has(win), false);
  assert.equal(self._landingAccepted.has(win), false);
});

test('landing: a window whose slot keeps moving is accepted after its total misses', () => {
  const { self, timers } = landingSelf();
  const win = landingWin();
  for (let i = 0; i < 10; i++) self.placement.retryLanding(win, slot(0, 800 + i * 10));
  assert.equal(timers.length, 9);
  assert.equal(self.placement.landingAccepted(win, 0, 0, 890, 600), true);
  // Still over the total: the next slot is accepted at its first miss.
  self.placement.retryLanding(win, slot(0, 1000));
  assert.equal(timers.length, 9);
  assert.equal(self.placement.landingAccepted(win, 0, 0, 1000, 600), true);
});

test('landing: the workspace landing check leaves an accepted window alone', () => {
  const { self } = landingSelf({ enabled: true });
  const win = landingWin();
  win.is_fullscreen = () => false;
  for (let i = 0; i < 4; i++) self.placement.retryLanding(win, slot(0, 800));
  const ws = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 2560, height: 1440 }) };
  const old = globalThis.global;
  globalThis.global = { display: { get_primary_monitor: () => 0 } };
  let retiles = 0;
  self.signals.scheduleRetile = () => retiles++;
  self.windows.getWorkspaceLayout = () => 'dwindle';
  self.windows.getWindowsForWorkspace = () => [win];
  // The min-clamped slot differs from the accepted target.
  self.grab.windowSlotRect = () => ({ x: 0, y: 0, w: 700, h: 600 });
  const other = landingWin();
  other.is_fullscreen = () => false;
  try {
    self.placement.checkWorkspaceLandings(ws);
    assert.equal(retiles, 0);
    // The same off-slot frame on a window with no accepted slot is retiled.
    self.windows.getWindowsForWorkspace = () => [win, other];
    self.placement.checkWorkspaceLandings(ws);
  } finally {
    globalThis.global = old;
  }
  assert.equal(retiles, 1);
  assert.equal(self.placement.landingAccepted(win, 0, 0, 800, 600), true);
});

test('landing: leaving the scratchpad gives the window a fresh landing budget', () => {
  const { self } = landingSelf();
  const win = landingWin();
  for (let i = 0; i < 4; i++) self.placement.retryLanding(win, slot(0, 800));
  self._scratchpadWindows.set(win, {});
  self.actions.getActiveWindow = () => win;
  self.borders.updateBorders = () => {};
  self.workspaces.showPopup = () => {};
  self.scratchpad.scratchpadRemove();
  assert.equal(self._landingAccepted.has(win), false);
  assert.equal(self._landingRetries.has(win), false);
});

test('toggle float: a tiled window always floats, with or without an accepted slot', () => {
  const { self } = landingSelf();
  const win = landingWin();
  const ws = {};
  win.get_workspace = () => ws;
  for (let i = 0; i < 4; i++) self.placement.retryLanding(win, slot(0, 800));
  self.actions.getActiveWindow = () => win;
  self.windows.getWorkspaceLayout = () => 'master-stack';
  self.layouts.retileWorkspace = () => {};
  self.actions.toggleFloat();
  assert.equal(self._toggleFloatWindows.has(win), true);
  assert.equal(self.windows.isFloating(win), true);
});

test('landing: landing on an accepted slot clears the window\'s miss total', () => {
  const { self } = landingSelf();
  const win = landingWin();
  for (let i = 0; i < 10; i++) self.placement.retryLanding(win, slot(0, 800 + i * 10));
  const ws = { list_windows: () => [] };
  win.get_workspace = () => ws;
  // The frame now matches the accepted slot (0, 0, 890, 600).
  win.get_frame_rect = () => ({ x: 0, y: 0, width: 890, height: 600 });
  assert.equal(self.placement.verifyAnimationLanding({ win, ...slot(0, 890) }, 'tiled'), true);
  assert.equal(self._landingRetries.has(win), false);
  assert.equal(self._landingAccepted.has(win), false);
});

test('landing: closing the window clears its landing state', () => {
  const { self } = landingSelf();
  const win = landingWin();
  for (let i = 0; i < 3; i++) self.placement.retryLanding(win, slot(0, 800));
  const other = landingWin();
  for (let i = 0; i < 4; i++) self.placement.retryLanding(other, slot(0, 800));
  self.windows.disconnectWindowSignals = () => {};
  self.borders.removeBorder = () => {};
  self.windows.removeWindow(win);
  self.windows.removeWindow(other);
  assert.equal(self._landingRetries.has(win), false);
  assert.equal(self._landingAccepted.has(other), false);
});
