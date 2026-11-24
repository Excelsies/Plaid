import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, menuWin, withMenus } from '../helpers.mjs';

// Focus on hover focuses the window the pointer enters, never the window it
// moves over while another one holds focus (a menu that took focus from it).

function hoverWorld() {
  const self = makeSelf({ 'pointer-focus': true });
  const pf = self.pointerFocus;
  const focused = [];
  const win = (title) => Object.assign(fakeWin({ title }), {
    focus() { focused.push(title); global.display.focus_window = this; },
  });
  let under = null;
  pf.resolveWindowByScan = () => under;
  pf.canPointerFocusWindow = () => true;
  const prevFocus = global.display.focus_window;
  const prevTime = global.get_current_time;
  global.display.focus_window = null;
  global.get_current_time = () => 0;
  return {
    self, pf, focused, win,
    // One tick at a new pointer position over `w` (null: nothing under it).
    move(w, i) { under = w; pf.applyPointerFocus(10 + i, 10); },
    restore() { global.display.focus_window = prevFocus; global.get_current_time = prevTime; },
  };
}

test('hover: entering a window focuses it once', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    t.move(a, 1);
    t.move(a, 2);
    assert.deepEqual(t.focused, ['A']);
  } finally { t.restore(); }
});

test('hover: moving over the window a menu took focus from keeps the menu focused', () => {
  const t = hoverWorld();
  try {
    const meet = t.win('Meeting');
    const menu = t.win('Toolbar Menu');
    t.move(meet, 1);
    // The app opens its menu as a new window and gives it focus.
    global.display.focus_window = menu;
    for (let i = 2; i < 8; i++) t.move(meet, i);
    assert.deepEqual(t.focused, ['Meeting']);
    assert.equal(global.display.focus_window, menu);
    // Entering the menu itself: already focused, nothing to do.
    t.move(menu, 9);
    assert.deepEqual(t.focused, ['Meeting']);
  } finally { t.restore(); }
});

test('hover: crossing to another window and back focuses each on entry', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    const b = t.win('B');
    t.move(a, 1);
    t.move(b, 2);
    t.move(a, 3);
    assert.deepEqual(t.focused, ['A', 'B', 'A']);
  } finally { t.restore(); }
});

test('hover: leaving to nothing and coming back is an entry', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    t.move(a, 1);
    global.display.focus_window = null; // focus went elsewhere meanwhile
    t.move(null, 2);
    t.move(a, 3);
    assert.deepEqual(t.focused, ['A', 'A']);
  } finally { t.restore(); }
});

test('hover: turning it off forgets the hovered window, so the first move after re-enabling focuses', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    t.move(a, 1);
    global.display.focus_window = null;
    t.pf.teardownPointerFocus();
    t.move(a, 2);
    assert.deepEqual(t.focused, ['A', 'A']);
  } finally { t.restore(); }
});

test('hover: a window whose process verdict was pending is focused once the verdict lands', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    let pending = true;
    t.pf.canPointerFocusWindow = () => !pending;
    t.move(a, 1);
    assert.deepEqual(t.focused, []);
    // The async cmdline read lands (not Chromium): the callback forgets the
    // hovered window (next test), then the forced re-tick at the same position.
    pending = false;
    t.self._pointerFocusHover = null;
    t.move(a, 1);
    assert.deepEqual(t.focused, ['A']);
  } finally { t.restore(); }
});

test('hover: the async verdict callback forgets the hovered window', () => {
  const t = hoverWorld();
  try {
    const a = Object.assign(t.win('A'), { get_pid: () => 4242 });
    const pf = t.pf;
    let landed = null;
    t.self.procInfo.procCmdlineCached = () => undefined;
    t.self.procInfo.getProcCmdline = (_pid, cb) => { landed = cb; };
    t.self._chromiumProcessCache = new Map();
    t.self._pointerFocusHover = a;
    assert.equal(pf.isChromiumProcessWindow(a), true); // pending: skipped
    landed('/usr/bin/zoom');
    assert.equal(t.self._pointerFocusHover, null);
    assert.equal(t.self._pointerFocusLastX, -1);
  } finally { t.restore(); }
});

test('menu open: clientMenuOpen holds for the focused window\'s shown menus only', () => {
  const { windows } = makeSelf({});
  const focus = fakeWin({ title: 'F', pid: 7 });
  const other = fakeWin({ title: 'O', pid: 8 });
  const ws = 'ws-active';
  const prevFocus = global.display.focus_window;
  const prevWm = global.workspace_manager;
  global.display.focus_window = focus;
  global.workspace_manager = { get_active_workspace: () => ws };
  // Every menu sits on an explicit workspace: the active one unless named.
  const menu = (parent, opts = {}) => menuWin(parent, { workspace: ws, ...opts });
  const open = (w) => withMenus([fakeWin({ type: 0, actor: {}, workspace: ws }), w], () => windows.clientMenuOpen());
  try {
    assert.equal(withMenus([], () => windows.clientMenuOpen()), false);
    assert.equal(open(menu(focus)), true, 'DROPDOWN_MENU');
    assert.equal(open(menu(focus, { type: 10 })), true, 'POPUP_MENU');
    assert.equal(open(menu(focus, { type: 13 })), true, 'COMBO');
    assert.equal(open(menu(focus, { type: 11 })), false, 'TOOLTIP takes no grab');
    assert.equal(open(menu(focus, { type: 6 })), false, 'MENU is a torn-off toplevel');
    assert.equal(open(menu(focus, { type: 0 })), false, 'NORMAL');
    assert.equal(open(menu(focus, { actor: null })), false, 'no actor: not shown');
    assert.equal(open(menu(focus, { minimized: true })), false, 'minimized');
    assert.equal(open(menu(menu(focus))), true, 'a nested menu');
    assert.equal(open(menu(other)), false, 'another window\'s menu');
    assert.equal(open(menu(focus, { workspace: 'ws-other' })), false, 'on another workspace');
    assert.equal(open(menu(null, { pid: 7, overrideRedirect: true })), true, 'X11 override-redirect menu of the focused process');
    assert.equal(open(menu(null, { pid: 7 })), false, 'a managed parentless menu-type window is not one');
    assert.equal(open(menu(null, { pid: 8, overrideRedirect: true })), false, 'override-redirect, another process');
    global.display.focus_window = fakeWin({ title: 'P0', pid: 0 });
    assert.equal(open(menu(null, { pid: 0, overrideRedirect: true })), false, 'no pid on either side');
    const selfMenu = menu(other, { pid: 9 });
    global.display.focus_window = selfMenu;
    assert.equal(open(selfMenu), true, 'the focused window is itself a menu');
    global.display.focus_window = null;
    assert.equal(open(menu(focus)), false, 'nothing focused');
    global.display.focus_window = focus;
    global.workspace_manager = { get_active_workspace: () => null };
    assert.equal(open(menu(focus)), false, 'no active workspace (shutdown)');
  } finally { global.display.focus_window = prevFocus; global.workspace_manager = prevWm; }
});

test('menu open: hover does not focus the window entered, nor record it', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    const b = t.win('B');
    t.move(a, 1);
    withMenus([menuWin(a)], () => { t.move(b, 2); t.move(b, 3); });
    assert.deepEqual(t.focused, ['A']);
    assert.equal(t.self._pointerFocusHover, a);
  } finally { t.restore(); }
});

test('menu open: once it closes, the window the pointer is in takes focus without a move', () => {
  const t = hoverWorld();
  const prevPointer = global.get_pointer;
  try {
    const a = t.win('A');
    const b = t.win('B');
    t.move(a, 1);
    global.get_pointer = () => [500, 10, 0];
    withMenus([menuWin(a)], () => t.pf.pointerFocusTick());
    // Same position after the menu closed: the next tick still looks.
    t.pf.resolveWindowByScan = () => b;
    t.pf.pointerFocusTick();
    assert.deepEqual(t.focused, ['A', 'B']);
    t.pf.pointerFocusTick();
    assert.deepEqual(t.focused, ['A', 'B'], 'unmoved, nothing left to do');
  } finally { global.get_pointer = prevPointer; t.restore(); }
});

test('menu open: closing over the window that already has focus changes nothing', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    t.move(a, 1);
    withMenus([menuWin(a)], () => t.move(a, 2));
    t.move(a, 3);
    assert.deepEqual(t.focused, ['A']);
  } finally { t.restore(); }
});
