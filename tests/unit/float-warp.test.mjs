import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { makeSelf, fakeWin } from '../helpers.mjs';

// A new floating window opens where its app put it: the cursor stays put.
// Zoom's popup menus are plain new windows of the 'zoom' class.

const schema = readFileSync(new URL('../../extensions/schemas/org.gnome.shell.extensions.plaid.gschema.xml',
  import.meta.url), 'utf8');

function emitter(extra = {}) {
  return {
    handlers: [],
    connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) this.handlers.push([obj, a[i], a[i + 1]]); },
    disconnectObject(obj) { this.handlers = this.handlers.filter(h => h[0] !== obj); },
    emit(sig) { for (const [, s, fn] of [...this.handlers]) if (s === sig) fn(); },
    ...extra,
  };
}

function floatWin(instance = 'zoom') {
  const actor = emitter({ visible: true, opacity: 255, mapped: false, set_opacity(v) { this.opacity = v; } });
  const w = fakeWin({ id: 7, instance });
  Object.assign(w, emitter(), {
    get_id: () => 7,
    get_workspace: () => ({}),
    get_window_type: () => 0,
    get_frame_rect: () => ({ x: 100, y: 100, width: 400, height: 300 }),
    get_compositor_private: () => actor,
  });
  w._actor = actor;
  return w;
}

function floatSelf() {
  const self = makeSelf({ enabled: true, 'follow-focus': true });
  const warps = [];
  self.windows.cursorWarpDeferred = (w) => warps.push(w);
  self.windows.moveCursorToWindow = (w) => warps.push(w);
  self.windows.restoreFloatNaturalRect = () => {};
  self.windows.connectFloatHooks = () => {};
  self.borders.updateBorders = () => {};
  return { self, warps };
}

test('onWindowCreated: a new floating window does not pull the cursor', () => {
  const { self, warps } = floatSelf();
  self.dropdown.handleDropdownWindowCreated = () => false;
  self.bgApp.handleBackgroundAppWindowCreated = () => false;
  self.windows.shouldManage = () => false;
  self.windows.isFloating = () => true;
  let hooked = 0;
  self.windows.connectFloatHooks = () => hooked++;
  const w = floatWin();
  self.signals.onWindowCreated(w);
  w._actor.emit('first-frame');
  assert.equal(hooked, 1, 'the float path ran');
  assert.deepEqual(warps, []);
});

test('markPendingWindowInvisible: a floating window is not warped to, and a tile still is', () => {
  const { self, warps } = floatSelf();
  self.placement.getAnimationTime = () => 0.2;
  self.signals.scheduleBorders = () => {};
  self.geometry.wsIndex = () => 1;
  const f = floatWin();
  self.windows.isFloating = () => true;
  self.windows.markPendingWindowInvisible(f, f._actor);
  assert.deepEqual(warps, []);
  assert.equal(self._pendingWarp?.has(f) ?? false, false);

  const t = floatWin('gedit');
  self.windows.isFloating = () => false;
  self.windows.armRevealBackstop = () => {};
  self._newWindowSet.add(t);
  const oldSkip = Main.wm.skipNextEffect;
  Main.wm.skipNextEffect = () => {};
  try {
    self.windows.markPendingWindowInvisible(t, t._actor);
  } finally {
    Main.wm.skipNextEffect = oldSkip;
  }
  assert.equal(self._pendingWarp.has(t), true, 'a tiled new window still gets its warp after landing');
});

test('float-windows: the Zoom helper floats by default; Zoom itself is a popup-window app', () => {
  const block = schema.match(/<key name="float-windows"[\s\S]*?<\/key>/)[0];
  const list = JSON.parse(block.match(/<default><!\[CDATA\[(.*?)\]\]><\/default>/)[1].replace(/'/g, '"'));
  assert.ok(list.includes('zoomwebviewhost'));
  assert.ok(!list.includes('zoom'), 'zoom tiles its real windows (popup-window-apps)');
  const self = makeSelf({ enabled: true, 'float-windows': list });
  self._floatingClasses = new Set(list);
  assert.equal(self.floatClassMatches(floatWin('zoom')), false);
  assert.equal(self.floatClassMatches(floatWin('zoomwebviewhost')), true);
  assert.equal(self.floatClassMatches(floatWin('gedit')), false);
});
