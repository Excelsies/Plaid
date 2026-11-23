import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { makeSelf } from '../helpers.mjs';

// The launch runs the parsed command line directly, with the BGAPP marker
// in the child's environment; no /bin/sh.
function launchSelf() {
  const self = makeSelf();
  const bg = self.bgApp;
  bg.isDynamicWorkspaces = () => true;
  bg.scheduleBackgroundAppReservation = () => {};
  bg.scheduleBackgroundAppReleaseWatch = () => {};
  bg.recordBackgroundAppHistory = () => {};
  self._backgroundAppParkingWs = {};
  const popups = [];
  self.workspaces.showPopup = (title, text) => popups.push(`${title}: ${text}`);
  return { self, bg, popups };
}

function withLauncher(parse, fn) {
  const spawned = [];
  const oldParse = GLib.shell_parse_argv;
  const oldLauncher = Gio.SubprocessLauncher;
  const oldFlags = Gio.SubprocessFlags;
  GLib.shell_parse_argv = parse;
  Gio.SubprocessFlags = { NONE: 0 };
  Gio.SubprocessLauncher = class {
    constructor(p) { this.flags = p.flags; this.env = {}; }
    setenv(k, v) { this.env[k] = v; }
    spawnv(argv) {
      const proc = { argv, env: this.env, wait_async() {} };
      spawned.push(proc);
      return proc;
    }
  };
  try {
    fn(spawned);
  } finally {
    GLib.shell_parse_argv = oldParse;
    Gio.SubprocessLauncher = oldLauncher;
    Gio.SubprocessFlags = oldFlags;
  }
}

test('background app: the command line runs as a parsed argv with the BGAPP marker', () => {
  const { self, bg, popups } = launchSelf();
  withLauncher((cmd) => [true, cmd === 'app --title "a b"' ? ['app', '--title', 'a b'] : null], (spawned) => {
    bg.spawnBackgroundAppProcess('app --title "a b"');
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].argv, ['app', '--title', 'a b']);
    assert.deepEqual(spawned[0].env, { PLAID_BGAPP: '1' });
    assert.equal(self._backgroundAppProc, spawned[0]);
    assert.deepEqual(popups, []);
  });
});

test('background app: a command line that does not parse says it could not start', () => {
  const { self, bg, popups } = launchSelf();
  withLauncher(() => { throw new Error('unbalanced quote'); }, (spawned) => {
    bg.spawnBackgroundAppProcess('app "unclosed');
    assert.equal(spawned.length, 0);
    assert.equal(self._backgroundAppProc, null);
    assert.equal(self._backgroundAppPending, false);
    assert.equal(popups.length, 1);
    assert.match(popups[0], /Could not start: app "unclosed/);
  });
});
