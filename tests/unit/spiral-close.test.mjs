import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { readFileSync } from 'node:fs';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Focus after a close in a Spiral group (Hyprland focus_on_close=0): the
// leaf nearest the closed tile's centre, once mutter has picked a focus and
// the group was laid out without it.

const WS = {};
const WA = { x: 0, y: 0, width: 1000, height: 800 };

function win(id) {
  const w = fakeWin({ id, instance: id, frame: { x: 0, y: 0, width: 100, height: 100 } });
  w.get_id = () => id;
  w.get_workspace = () => WS;
  return w;
}

function group(layout, tree, wins, settings = {}) {
  const self = makeSelf({ enabled: true, ...settings });
  const floats = new Set();
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = w => floats.has(w);
  self.windows.isFullscreenTile = () => false;
  self.monitors.windowMon = () => 0;
  self.monitors.windowConn = () => 'M0';
  self.monitors.connMon = () => 0;
  self.monitors.groupPlaces = () => true;
  self.monitors.monitorWorkArea = () => WA;
  let members = wins;
  self.monitors.getWindowsForGroup = () => members;
  self.geometry.wsIndex = () => 1;
  self.currentTime = () => 0;
  self.layouts.retileWorkspace = () => {};
  const idles = [];
  self.signals.addIdle = fn => { idles.push(fn); return idles.length; };
  const warped = [];
  self.windows.cursorWarpDeferred = w => warped.push(w);
  const activated = [];
  for (const w of wins) {
    w.activate = () => { activated.push(w); global.display.focus_window = w; };
    self._windowWorkspaces.set(w, WS);
  }
  self.bsp.bspSetTree(WS, 0, tree);
  global.workspace_manager = { get_active_workspace: () => WS };
  // The window leaves (its leaf and group membership go, mutter picks
  // `picked`) and the workspace's retile lays the group out with the
  // orientation pass, as retileDwindle does.
  // Focus moves as mutter moves it: notify::focus-window tells Plaid.
  const focus = w => { global.display.focus_window = w; self.actions.noteFocus(w); };
  const leave = (w, picked) => {
    members = members.filter(x => x !== w);
    self.bsp.bspSetTree(WS, 0, self.bsp.bspRemove(self.bsp.bspGetTree(WS, 0), w));
    focus(picked);
    self.actions.noteClosed(w);
  };
  const retile = () => {
    self.bsp.orientSpiral(self.bsp.bspGetTree(WS, 0), { x: 0, y: 0, w: WA.width, h: WA.height }, 0, WS, 0, true);
    self.actions.focusAfterClose(WS);
  };
  const close = (w, picked) => { leave(w, picked); retile(); };
  const runIdles = () => { while (idles.length) idles.shift()(); };
  const drop = w => {
    members = members.filter(x => x !== w);
    self.bsp.bspSetTree(WS, 0, self.bsp.bspRemove(self.bsp.bspGetTree(WS, 0), w));
  };
  return { self, floats, idles, runIdles, activated, warped, leave, retile, close, focus, drop };
}

// A|(B/C), C focused and closed; mutter picks A (its MRU), Hyprland B.
function abc(layout = 'spiral', settings = {}) {
  const a = win('a'), b = win('b'), c = win('c');
  const ctx = group(layout, split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c))), [a, b, c], settings);
  global.display.focus_window = c;
  return { ...ctx, a, b, c };
}

test('focus after close: the leaf that takes the closed tile\'s place, not mutter\'s pick', () => {
  const { self, a, b, c, close, runIdles, activated, warped } = abc();
  self.actions.noteClosing(c);
  close(c, a);
  runIdles();
  assert.deepEqual(activated, [b]);
  assert.deepEqual(warped, [], 'follow-focus off: the cursor stays');
});

test('focus after close: follow-focus warps the cursor to it', () => {
  const { self, a, b, c, close, runIdles, warped } = abc('spiral', { 'follow-focus': true });
  self.actions.noteClosing(c);
  close(c, a);
  runIdles();
  assert.deepEqual(warped, [b]);
});

// h0.5(X, v0.3(B, C)): X's centre (250, 400) is in C's slot while the
// promoted split is still stacked, in B's once the retile orients it.
test('focus after close: the nearest leaf is read after the retile laid the group out', () => {
  const x = win('x'), b = win('b'), c = win('c');
  const { self, leave, retile, idles, runIdles, activated } = group('spiral',
    split('h', 0.5, leaf(x), split('v', 0.3, leaf(b), leaf(c))), [x, b, c]);
  global.display.focus_window = x;
  self.actions.noteClosing(x);
  leave(x, c);
  assert.equal(idles.length, 0, 'nothing before the retile');
  retile();
  runIdles();
  assert.deepEqual(activated, [b]);
});

test('focus after close: removeWindow records mutter\'s pick, scheduleRetile focuses after its layout', () => {
  const { self, a, b, c, idles, runIdles, activated, focus } = abc();
  self.actions.noteClosing(c);
  focus(a);
  self.monitors.getWindowsForGroup = () => [a, b];
  self.windows.removeWindow(c);
  assert.equal(self._closeFocus.get(c)?.closed, true);
  assert.equal(self._closeFocus.get(c).picked, a);
  const orig = GLib.timeout_add;
  const order = [];
  let cb = null;
  GLib.timeout_add = (_p, _ms, fn) => { cb = fn; return 9; };
  try {
    self.layouts.doRetileWorkspace = () => order.push(idles.length);
    self.signals.scheduleRetile(WS);
  } finally {
    GLib.timeout_add = orig;
  }
  cb();
  assert.deepEqual(order, [0], 'the layout runs before the focus is queued');
  runIdles();
  assert.deepEqual(activated, [b]);
  assert.equal(self._closeFocus.size, 0);
});

test('focus after close: the unmanaging signal records the focused tile', () => {
  const { self, c } = abc();
  self.windows.connectWindowSignals(c);
  assert.equal(typeof c._signals.unmanaging, 'function');
  c._signals.unmanaging();
  const r = self._closeFocus.get(c);
  assert.deepEqual([r?.x, r?.y], [750, 600]);
});

test('focus after close: nothing for a float, an unfocused tile, a dwindle group or an untiled monitor', () => {
  const cases = {
    float: ctx => ctx.floats.add(ctx.c),
    'not focused': ctx => { global.display.focus_window = ctx.b; },
    dwindle: null,
    'a monitor that does not tile': ctx => { ctx.self.monitors.groupPlaces = () => false; },
  };
  for (const [kind, setup] of Object.entries(cases)) {
    const ctx = abc(kind === 'dwindle' ? 'dwindle' : 'spiral');
    setup?.(ctx);
    ctx.self.actions.noteClosing(ctx.c);
    ctx.close(ctx.c, ctx.a);
    ctx.runIdles();
    assert.deepEqual(ctx.activated, [], kind);
  }
});

test('focus after close: focus that moved after mutter\'s pick stays (background app restore, a new window, the user)', () => {
  const { self, a, c, close, idles, runIdles, activated, focus } = abc();
  self.actions.noteClosing(c);
  close(c, a);
  assert.equal(idles.length, 1);
  focus(win('o'));
  runIdles();
  assert.deepEqual(activated, []);
});

test('focus after close: mutter\'s pick of the background app or of a new window stays', () => {
  for (const kind of ['bgapp', 'new']) {
    const { self, c, close, idles, runIdles, activated } = abc();
    const p = win('p');
    if (kind === 'bgapp') self._backgroundAppWin = p;
    else self._newWindowSet.add(p);
    self.actions.noteClosing(c);
    close(c, p);
    assert.equal(idles.length, 0, kind);
    assert.equal(self._closeFocus.size, 0, kind);
    runIdles();
    assert.deepEqual(activated, [], kind);
  }
});

test('focus after close: nothing during a grab, with tiling off, or once the workspace is no longer shown', () => {
  for (const kind of ['grab', 'off', 'ws']) {
    const { self, a, c, close, runIdles, activated } = abc('spiral', kind === 'off' ? { enabled: false } : {});
    self.actions.noteClosing(c);
    close(c, a);
    if (kind === 'grab') self._grabOp = 1;
    if (kind === 'ws') global.workspace_manager = { get_active_workspace: () => ({}) };
    runIdles();
    assert.deepEqual(activated, [], kind);
  }
});

test('focus after close: nothing at shell shutdown or once the group\'s monitor is gone', () => {
  {
    const { self, a, c, close, runIdles, activated } = abc();
    self._shuttingDown = true;
    self.actions.noteClosing(c);
    assert.equal(self._closeFocus.size, 0);
    close(c, a);
    runIdles();
    assert.deepEqual(activated, [], 'shutdown');
  }
  {
    const { self, a, c, close, runIdles, activated } = abc();
    self.actions.noteClosing(c);
    close(c, a);
    self.monitors.connMon = () => -1;
    self.monitors.groupPlaces = (_ws, mon) => mon >= 0;
    runIdles();
    assert.deepEqual(activated, [], 'monitor gone');
  }
});

test('focus after close: the record is the closing window\'s, and its own workspace\'s retile uses it once', () => {
  const { self, a, b, c, leave, drop, retile, idles, activated, runIdles } = abc();
  self.actions.noteClosing(c);
  drop(b);
  self.actions.noteClosed(b);
  assert.equal(self._closeFocus.get(c)?.closed, false, 'another window leaving');
  self.actions.focusAfterClose(WS);
  assert.equal(idles.length, 0, 'a retile before it left');
  const o = win('o');
  leave(c, o);
  self.actions.focusAfterClose({});
  assert.equal(idles.length, 0, 'another workspace\'s retile');
  self.actions.noteClosed(c);
  retile();
  retile();
  assert.equal(idles.length, 1, 'one focus per close');
  runIdles();
  assert.deepEqual(activated, [a], 'a, alone in the group now');
});

// removeWindow runs again at the actor's destroy, after focus may have
// moved (the background app's restore): mutter's pick stands.
test('focus after close: a second removeWindow keeps mutter\'s pick', () => {
  const { self, a, c, leave, retile, runIdles, activated, focus } = abc();
  self.actions.noteClosing(c);
  leave(c, a);
  focus(win('o'));
  self.actions.noteClosed(c);
  retile();
  runIdles();
  assert.deepEqual(activated, []);
});

// No close effect (animations off, the overview, a workspace switch): the
// actor is destroyed at once, so removeWindow runs while the closing window
// still has focus, and mutter picks afterwards.
test('focus after close: an actor destroyed before mutter picks a focus', () => {
  const { self, a, b, c, drop, focus, retile, runIdles, activated } = abc();
  self.actions.noteClosing(c);
  drop(c);
  self.actions.noteClosed(c);
  focus(a);
  retile();
  runIdles();
  assert.deepEqual(activated, [b]);
});

test('focus after close: with no focus move seen, mutter\'s pick is read at the retile', () => {
  {
    const { self, c, drop, retile, idles } = abc();
    self.actions.noteClosing(c);
    drop(c);
    self.actions.noteClosed(c);
    retile();
    assert.deepEqual([self._closeFocus.size, idles.length], [0, 0], 'still the closing window\'s focus: dropped');
  }
  const { self, a, b, c, drop, retile, runIdles, activated } = abc();
  self.actions.noteClosing(c);
  drop(c);
  self.actions.noteClosed(c);
  global.display.focus_window = a;
  retile();
  runIdles();
  assert.deepEqual(activated, [b]);
});

test('focus after close: a record older than a second is dropped', () => {
  const { self, a, c, close, runIdles, activated } = abc();
  self.actions.noteClosing(c);
  self._closeFocus.get(c).at -= 1001;
  close(c, a);
  runIdles();
  assert.deepEqual(activated, []);
});

test('focus after close: one record per window; a closing window does not drop another\'s', () => {
  const { self, a, b, c, leave, retile, idles, focus } = abc();
  self.actions.noteClosing(c);
  focus(b);
  self.actions.noteClosing(a);
  assert.deepEqual([...self._closeFocus.keys()], [c], 'an unfocused window keeps no record');
  self.actions.noteClosing(b);
  assert.deepEqual([...self._closeFocus.keys()], [c, b]);
  leave(c, a);
  retile();
  assert.equal(idles.length, 1);
});

test('focus after close: the cursor follows the heir also when mutter picked it', () => {
  const { self, b, c, close, runIdles, activated, warped } = abc('spiral', { 'follow-focus': true });
  self.actions.noteClosing(c);
  close(c, b);
  runIdles();
  assert.deepEqual([activated, warped], [[], [b]]);
});

test('focus after close: nothing while the overview or a modal is up', () => {
  for (const kind of ['overview', 'modal']) {
    const { self, a, c, close, runIdles, activated } = abc();
    self.actions.noteClosing(c);
    close(c, a);
    if (kind === 'overview') Main.overview.visible = true;
    else Main.setModalCount(1);
    try {
      runIdles();
    } finally {
      Main.overview.visible = false;
      Main.setModalCount(0);
    }
    assert.deepEqual(activated, [], kind);
  }
});

test('focus after close: with no focus move seen, a pick of the background app at the retile stays', () => {
  const { self, c, drop, retile, idles } = abc();
  const p = win('p');
  self._backgroundAppWin = p;
  self.actions.noteClosing(c);
  drop(c);
  self.actions.noteClosed(c);
  global.display.focus_window = p;
  retile();
  assert.deepEqual([self._closeFocus.size, idles.length], [0, 0]);
});

// mutter's pick reaches the record through the focus-window handler.
test('focus after close: notify::focus-window reports every focus move', () => {
  const src = readFileSync(new URL('../../extensions/modules/signals.js', import.meta.url), 'utf8');
  const m = /connectObject\(global\.display, 'notify::focus-window', \(\) => \{\n([^]*?)\n {8}\}\);/.exec(src);
  assert.ok(m, 'the handler');
  assert.match(m[1].split('\n').slice(0, 3).join('\n'), /const win = global\.display\.focus_window;\n\s+this\.core\.actions\.noteFocus\(win\);/);
});

// B, nearest the closed C, is still opening: the next nearest tile (A,
// mutter's pick already) keeps focus; B is not activated mid-placement.
test('focus after close: a window still opening is no candidate', () => {
  const { self, a, b, c, close, runIdles, activated } = abc();
  self.actions.noteClosing(c);
  close(c, a);
  self._newWindowSet.add(b);
  runIdles();
  assert.deepEqual(activated, []);
  self._newWindowSet.delete(b);
});
