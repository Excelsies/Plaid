import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

test('_onAcceleratorActivated: shows the dead combo for a matching action id', () => {
  let shown = null;
  const self = makeSelf({}, {
    _shuttingDown: false,
    _keybindConflictById: new Map([[42, {
      combo: '<Super>Up', owner: 'GNOME (maximize)', key: 'move-focus-up',
    }]]),
    _keybindConflictByName: new Map(),
    _showKeybindConflict: (combo, owner, key) => { shown = { combo, owner, key }; },
  });

  self._onAcceleratorActivated(42);

  assert.deepEqual(shown, {
    combo: '<Super>Up', owner: 'GNOME (maximize)', key: 'move-focus-up',
  });
});

test('_onAcceleratorActivated: ignores an unmatched action', () => {
  let shown = false;
  const self = makeSelf({}, {
    _shuttingDown: false,
    _keybindConflictById: new Map([[42, { combo: '<Super>Up' }]]),
    _keybindConflictByName: new Map(),
    _showKeybindConflict: () => { shown = true; },
  });

  self._onAcceleratorActivated(7);

  assert.equal(shown, false);
});

test('_showKeybindConflict: throttles repeats and falls back to the Plaid popup', () => {
  const calls = [];
  const self = makeSelf({}, {
    _showPopup: (title, subtitle) => calls.push({ title, subtitle }),
    _debugLog() {},
    _keybindConflictTimes: new Map(),
  });

  self._showKeybindConflict('<Super>Up', 'GNOME (maximize)', 'move-focus-up');
  self._showKeybindConflict('<Super>Up', 'GNOME (maximize)', 'move-focus-up');

  assert.equal(calls.length, 1);
  assert.match(calls[0].subtitle, /<Super>Up/);
  assert.match(calls[0].subtitle, /move focus up/);
  assert.match(calls[0].subtitle, /GNOME \(maximize\)/);
});

// GJS throws when prefs_get_keybinding_action returns an id the typelib's
// KeyBindingAction does not hold (the shell's own actions): the map is
// built without asking for those, and the scan goes on to the next.
test('_buildKeybindFeedbackMaps: an action outside the KeyBindingAction enum is matched by name, not asked', async () => {
  const Meta = (await import('gi://Meta')).default;
  const prev = [Meta.prefs_get_keybinding_action, Meta.KeyBindingAction];
  Meta.KeyBindingAction = { MAXIMIZE: 7, TOGGLE_TILED_LEFT: 9 };
  const asked = [];
  Meta.prefs_get_keybinding_action = name => {
    asked.push(name);
    if (name === 'toggle-tiled-left') return 0;
    if (name !== 'maximize') throw new TypeError('113 is not a valid value for enumeration KeyBindingAction');
    return 7;
  };
  const self = makeSelf();
  try {
    self.keybindings.buildKeybindFeedbackMaps([
      { schemaId: 'org.gnome.desktop.wm.keybindings', keyName: 'switch-input-source-backward', orig: '<Shift><Super>space', owners: ['toggle-float'] },
      { schemaId: 'org.gnome.desktop.wm.keybindings', keyName: 'maximize', orig: '<Super>Up', owners: ['move-focus-up'] },
      { schemaId: 'org.gnome.mutter.keybindings', keyName: 'toggle-tiled-left', orig: '<Super>Left', owners: ['move-focus-left'] },
    ]);
  } finally {
    [Meta.prefs_get_keybinding_action, Meta.KeyBindingAction] = prev;
  }
  assert.deepEqual(asked, ['maximize', 'toggle-tiled-left']);
  // A built-in mutter does not report: its enum value.
  assert.deepEqual([...self._keybindConflictById.keys()], [7, 9]);
  assert.equal(self._keybindConflictByName.get('switch-input-source-backward').combo, '<Shift><Super>space');
});
