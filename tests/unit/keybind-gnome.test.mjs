import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { makeSelf, fakeWin } from '../helpers.mjs';

// GNOME's move-to-monitor keys drive Plaid's move: Plaid sets their handler
// (Main.wm.setCustomKeybindingHandler) and never their binding.

const NAMES = { 'move-to-monitor-left': 'left', 'move-to-monitor-right': 'right',
  'move-to-monitor-up': 'up', 'move-to-monitor-down': 'down' };

Shell.ActionMode = { NORMAL: 1, OVERVIEW: 2 };

// The shell's wrapper over mutter's one handler slot per name.
function fakeWm() {
  const slots = new Map();
  const calls = [];
  Main.wm.setCustomKeybindingHandler = (name, modes, handler) => {
    calls.push({ name, modes, handler });
    slots.set(name, handler);
  };
  Main.wm.removeKeybinding = () => {};
  return { slots, calls };
}

// Gio.Settings that records every schema opened and every write.
function fakeGio(values = {}) {
  const opened = [];
  const writes = [];
  Gio.Settings = class {
    constructor({ schema_id }) { this.schema = schema_id; opened.push(schema_id); }
    get_strv(k) { return values[k] ?? ['<Super><Shift>Left']; }
  };
  for (const m of ['set_strv', 'set_value', 'set_string', 'set_boolean', 'reset'])
    Gio.Settings.prototype[m] = function (...a) { writes.push([this.schema, m, ...a]); };
  return { opened, writes };
}

function setup() {
  const self = makeSelf();
  const moved = [];
  self.actions.moveWindow = (dir, win) => moved.push([dir, win]);
  const logs = [];
  self.debugLog = msg => logs.push(msg);
  return { self, moved, logs };
}

test('GNOME keys: the four move-to-monitor names get a handler, in NORMAL mode only', () => {
  const { calls } = fakeWm();
  fakeGio();
  const { self } = setup();
  self.keybindings.hookGnomeKeybindings();
  assert.deepEqual(calls.map(c => [c.name, c.modes, typeof c.handler]),
    Object.keys(NAMES).map(n => [n, Shell.ActionMode.NORMAL, 'function']));
});

test('GNOME keys: a handler moves the window mutter passes, in its own direction', () => {
  const { slots } = fakeWm();
  fakeGio();
  const { self, moved } = setup();
  const passed = fakeWin({ id: 'passed' });
  global.display.focus_window = fakeWin({ id: 'focus' });
  self.keybindings.hookGnomeKeybindings();
  for (const name of Object.keys(NAMES))
    slots.get(name)({}, passed, {}, { get_name: () => name });
  assert.deepEqual(moved, Object.values(NAMES).map(d => [d, passed]));
});

test('GNOME keys: disable hands every name back to mutter (null handler)', () => {
  const { slots, calls } = fakeWm();
  fakeGio();
  const { self } = setup();
  self.keybindings.hookGnomeKeybindings();
  calls.length = 0;
  self.keybindings.destroy();
  assert.deepEqual(calls.map(c => [c.name, c.modes, c.handler]),
    Object.keys(NAMES).map(n => [n, Shell.ActionMode.NORMAL, null]));
  assert.deepEqual([...slots.values()], [null, null, null, null]);
  calls.length = 0;
  self.keybindings.destroy();
  assert.deepEqual(calls, [], 'a second disable writes nothing');
});

test('GNOME keys: disable without a hook sets nothing', () => {
  const { calls } = fakeWm();
  fakeGio();
  const { self } = setup();
  self.keybindings.destroy();
  assert.deepEqual(calls, []);
});

// No session-modes: enable and disable run on every lock and unlock.
test('GNOME keys: repeated enable replaces the handler; one disable restores all', () => {
  const { slots, calls } = fakeWm();
  fakeGio();
  const { self, moved } = setup();
  self.keybindings.hookGnomeKeybindings();
  self.keybindings.hookGnomeKeybindings();
  assert.equal(slots.size, 4);
  assert.equal(calls.length, 8);
  const w = fakeWin({ id: 'w' });
  slots.get('move-to-monitor-left')({}, w);
  assert.deepEqual(moved, [['left', w]], 'one move per key press');
  self.keybindings.restoreGnomeKeybindings();
  assert.deepEqual([...slots.values()], [null, null, null, null]);
  // Unlock: a new core hooks again.
  const next = setup();
  next.self.keybindings.hookGnomeKeybindings();
  assert.ok([...slots.values()].every(h => typeof h === 'function'));
});

test('GNOME keys: nothing writes a GNOME setting; a cleared key is logged', () => {
  fakeWm();
  const { opened, writes } = fakeGio({ 'move-to-monitor-up': [], 'move-to-monitor-down': [''] });
  const { self, logs } = setup();
  self.keybindings.hookGnomeKeybindings();
  self.keybindings.destroy();
  assert.deepEqual(writes, []);
  assert.deepEqual([...new Set(opened)], ['org.gnome.desktop.wm.keybindings']);
  assert.deepEqual(logs.filter(l => /move-to-monitor/.test(l)), [
    "keybind: move-to-monitor-left hooked ('<Super><Shift>Left')",
    "keybind: move-to-monitor-right hooked ('<Super><Shift>Left')",
    'keybind: move-to-monitor-up hooked, but has no shortcut in GNOME',
    'keybind: move-to-monitor-down hooked, but has no shortcut in GNOME',
  ]);
});

const ext = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions');
const sources = [join(ext, 'extension.js'), join(ext, 'prefs.js'),
  ...readdirSync(join(ext, 'modules')).filter(f => f.endsWith('.js')).map(f => join(ext, 'modules', f))]
  .map(f => readFileSync(f, 'utf8')).join('\n');

test('GNOME keys: no source writes a move-to-monitor key; Plaid\'s move-window keys are gone', () => {
  const write = /\.(?:set_strv|set_value|reset)\(\s*['"`]move-to-monitor/;
  assert.ok(write.test("wm.set_strv('move-to-monitor-left', [])"), 'calibration');
  assert.ok(write.test('s.reset(`move-to-monitor-${d}`)'), 'calibration');
  assert.ok(!write.test(sources));
  const schema = readFileSync(join(ext, 'schemas', 'org.gnome.shell.extensions.plaid.gschema.xml'), 'utf8');
  assert.ok(!/move-window-(?:left|right|up|down)/.test(schema + sources));
});

test('GNOME keys: enable hooks them after Plaid\'s own keys', () => {
  const core = readFileSync(join(ext, 'modules', 'core.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.match(core, /this\.keybindings\.registerKeybindings\(\);\s*this\.keybindings\.hookGnomeKeybindings\(\);/);
});
