import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, frameClock } from '../helpers.mjs';

test('_onShellShutdown: sets the flag, clears queued retiles, cancels animation', () => {
  let cancelled = false;
  const self = makeSelf({}, {
    _shuttingDown: false,
    _pendingRetileIds: new Map([[{}, 1], [{}, 2]]),
    _cancelAnimation() { cancelled = true; },
  });

  self._onShellShutdown();

  assert.equal(self._shuttingDown, true);
  assert.equal(self._pendingRetileIds.size, 0);
  assert.equal(cancelled, true);
});

test('_scheduleRetile: no-op after shutdown (regression: retile ran after shutdown)', () => {
  const self = makeSelf({}, {
    _shuttingDown: true,
    _pendingRetileIds: new Map(),
    _lastRetileTimes: new Map(),
  });

  self._scheduleRetile({});

  assert.equal(self._pendingRetileIds.size, 0);
});

test('_animRetile: no-op after shutdown', () => {
  const self = makeSelf({}, { _shuttingDown: true, _animating: false });
  self._animRetile({}, []);
  assert.equal(self._animating, false);
});

test('_doRetileWorkspace: no-op after shutdown', () => {
  let scanned = false;
  const self = makeSelf({}, {
    _shuttingDown: true,
    _getWindowsForWorkspace() { scanned = true; return []; },
  });
  self._doRetileWorkspace({});
  assert.equal(scanned, false);
});


test('_onShellShutdown: idempotent across closing/x11-closing/shutdown', () => {
  let cancelled = 0;
  const self = makeSelf({}, {
    _shuttingDown: false,
    _pendingRetileIds: new Map([[{}, 1]]),
    _cancelAnimation() { cancelled++; },
  });

  self._onShellShutdown();
  self._onShellShutdown();
  self._onShellShutdown();

  assert.equal(cancelled, 1);
});

test('_onShellShutdown during a grab: the frame-clock loop is disconnected, the rest of shutdown runs', () => {
  let cancelled = false;
  const self = makeSelf({ enabled: true }, { _shuttingDown: false, _cancelAnimation() { cancelled = true; } });
  const clock = frameClock();
  try {
    self._grabOp = 1 | (2 << 12);
    self.grab.startGrabLoop({ get_compositor_private: () => ({}), get_frame_rect: () => ({ width: 1, height: 1 }) }, 'resize');
    assert.equal(clock.handlers.length, 2);
    self._onShellShutdown();
    assert.equal(clock.handlers.length, 0, 'stage and cursor hooks gone');
    assert.equal(self._liveResizeId, 0);
    assert.equal(cancelled, true, 'shutdown went on past the grab loop');
  } finally {
    clock.restore();
  }
});
