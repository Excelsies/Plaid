import { test } from 'node:test';
import assert from 'node:assert/strict';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { makeSelf, leaf, split, oneMonitor } from '../helpers.mjs';
import { sessionState } from '../../extensions/modules/session-state.js';

const MOVE = 1;
const RESIZE_E = 1 | (2 << 12);
const SUPER = Clutter.ModifierType.MOD4_MASK;
const { UP, DOWN, SMOOTH } = Clutter.ScrollDirection;

// Five workspaces; index 0 is the background-app parking workspace.
const wss = [0, 1, 2, 3, 4].map((i) => ({
  id: i,
  index: () => i,
  get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 2560, height: 1440 }),
}));

let now = 0;
GLib.get_monotonic_time = () => now;

// `animate`: the move starts a slide inside the call, as the shell does with
// animations on; without it the switch is instant.
function setup({ settings = {}, parking = wss[0], floating = false, workspaces = wss, animate = false } = {}) {
  now = 10_000_000;
  const filters = { added: 0, removed: [] };
  Clutter.Event.add_filter = (_stage, fn) => {
    filters.fn = fn;
    return ++filters.added;
  };
  Clutter.Event.remove_filter = (id) => {
    filters.removed.push(id);
    filters.fn = null;
  };
  globalThis.global = {
    stage: {},
    display: oneMonitor({ compositor_modifiers: SUPER }),
    workspace_manager: {
      get_n_workspaces: () => workspaces.length,
      get_workspace_by_index: (i) => workspaces[i] ?? null,
      get_active_workspace: () => workspaces[1],
    },
    get_pointer: () => [0, 0],
    get_current_time: () => 0,
  };
  const moves = [];
  Main.overview.visible = false;
  Main.wm.actionMoveWindow = (win, dest) => {
    moves.push([win.get_workspace().index(), dest.index()]);
    win._ws = dest;
    const anim = Main.wm._workspaceAnimation;
    if (animate && anim && anim._switchData === null) anim._switchData = { monitors: [] };
  };
  Main.wm._workspaceAnimation = { _switchData: null, _grab: null };
  Main.popped.length = 0;
  sessionState.parkingWorkspace = parking;
  sessionState.parkingFront = false;
  const values = { enabled: true, 'mouse-resize': true, 'drag-scroll-workspace': true, ...settings };
  const repositioned = [];
  const self = makeSelf(values, {
    _backgroundAppParkingWs: parking,
    _isFloating: () => floating,
    _getAnimationTime: () => 0.1,
    _hideDropPreview() {},
    _kickMaskNow() {},
    _getWindowsForWorkspace: () => [],
    _retileWorkspace() {},
    _repositionWindow: (win, ws) => repositioned.push([win, ws]),
    _wsIndex: (ws) => ws.index(),
  });
  self._grabOp = MOVE;
  return { self, values, filters, moves, repositioned };
}

function dragWin(ws) {
  const w = {
    _ws: ws,
    get_workspace: () => w._ws,
    get_window_type: () => 0,
    is_on_all_workspaces: () => false,
    is_skip_taskbar: () => false,
    get_wm_class_instance: () => 'gjs',
    get_frame_rect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    raise() {},
  };
  return w;
}

const scroll = (direction, state = SUPER) => ({
  type: () => Clutter.EventType.SCROLL,
  get_state: () => state,
  get_scroll_direction: () => direction,
});
const release = { type: () => Clutter.EventType.BUTTON_RELEASE };

function withWarnings(fn) {
  const warned = [];
  const orig = console.warn;
  console.warn = (msg) => warned.push(msg);
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warned;
}

test('drag-scroll: the filter lives from a move grab begin to its end', () => {
  const { self, filters } = setup();
  const win = dragWin(wss[1]);
  self._beginDragScroll(win, MOVE);
  assert.equal(filters.added, 1);
  self._handleGrabEnd(win, MOVE);
  assert.deepEqual(filters.removed, [1]);
  assert.equal(self.dragScroll.carrying(wss[1]), false);
});

test('drag-scroll: no filter for a resize grab, with the setting off, or with mouse-resize off', () => {
  const resize = setup();
  resize.self._beginDragScroll(dragWin(wss[1]), RESIZE_E);
  assert.equal(resize.filters.added, 0);

  const off = setup({ settings: { 'drag-scroll-workspace': false } });
  off.self._beginDragScroll(dragWin(wss[1]), MOVE);
  assert.equal(off.filters.added, 0);

  // The grab-op-begin gate in connectGrabSignals.
  const gated = setup({ settings: { 'mouse-resize': false } });
  const handlers = {};
  globalThis.global.display.connectObject = (name, cb) => { handlers[name] = cb; };
  gated.self._handleGrabBegin = () => {};
  gated.self._connectGrabSignals();
  handlers['grab-op-begin'](null, dragWin(wss[1]), MOVE);
  assert.equal(gated.filters.added, 0);
  gated.values['mouse-resize'] = true;
  handlers['grab-op-begin'](null, dragWin(wss[1]), MOVE);
  assert.equal(gated.filters.added, 1);
});

test('drag-scroll: shell shutdown removes the filter', () => {
  const { self, filters } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  self._onShellShutdown();
  assert.deepEqual(filters.removed, [1]);
});

test('drag-scroll: disable removes the filter before the grab is torn down', () => {
  const { self, filters } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  const order = [];
  for (const name of Object.keys(self)) {
    const sub = self[name];
    if (name === 'dragScroll' || !sub || typeof sub.destroy !== 'function' || name === 'ext') continue;
    sub.destroy = () => order.push(name);
  }
  const realEnd = self.dragScroll.end.bind(self.dragScroll);
  self.dragScroll.end = () => {
    order.push('dragScroll');
    realEnd();
  };
  self.destroy();
  assert.deepEqual(filters.removed, [1]);
  assert.ok(order.indexOf('dragScroll') >= 0 && order.indexOf('dragScroll') < order.indexOf('grab'),
    `teardown order: ${order.join(',')}`);
});

test('drag-scroll: Super + scroll carries one workspace per step, throttled', () => {
  const { self, filters, moves } = setup();
  const win = dragWin(wss[1]);
  self._beginDragScroll(win, MOVE);
  assert.equal(filters.fn(scroll(DOWN)), Clutter.EVENT_STOP);
  now += 100_000;
  filters.fn(scroll(DOWN));
  assert.deepEqual(moves, [[1, 2]]);
  now += 300_000;
  filters.fn(scroll(DOWN));
  assert.deepEqual(moves, [[1, 2], [2, 3]]);
});

test('drag-scroll: no step while the slide runs, past the throttle', () => {
  const { self, filters, moves } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  filters.fn(scroll(DOWN));
  Main.wm._workspaceAnimation._switchData = { monitors: [] };
  now += 1_000_000;
  filters.fn(scroll(DOWN));
  assert.deepEqual(moves, [[1, 2]]);
  Main.wm._workspaceAnimation._switchData = null;
  filters.fn(scroll(DOWN));
  assert.deepEqual(moves, [[1, 2], [2, 3]]);
});

test('drag-scroll: wraps at both ends and skips the parking workspace', () => {
  const down = setup();
  down.self._beginDragScroll(dragWin(wss[4]), MOVE);
  down.filters.fn(scroll(DOWN));
  assert.deepEqual(down.moves, [[4, 1]]);

  const up = setup();
  up.self._beginDragScroll(dragWin(wss[1]), MOVE);
  up.filters.fn(scroll(UP));
  assert.deepEqual(up.moves, [[1, 4]]);
});

test('realNeighbor: wraps without a parking workspace, and holds with a single real one', () => {
  const { self } = setup({ parking: null });
  assert.equal(self.bgApp.realNeighbor(wss[0], -1), wss[4]);
  assert.equal(self.bgApp.realNeighbor(wss[1], -1), wss[0]);
  assert.equal(self.bgApp.realNeighbor(wss[2], 1), wss[3]);

  const one = setup({ workspaces: wss.slice(0, 2) });
  assert.equal(one.self.bgApp.realNeighbor(wss[1], 1), wss[1]);
  assert.equal(one.self.bgApp.realNeighbor(wss[0], 1), null);
  one.self._beginDragScroll(dragWin(wss[1]), MOVE);
  one.filters.fn(scroll(DOWN));
  assert.deepEqual(one.moves, []);
});

test('drag-scroll: plain scroll, smooth scroll and the setting turned off mid-grab do not carry', () => {
  const { self, values, filters, moves } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  assert.equal(filters.fn(scroll(DOWN, 0)), Clutter.EVENT_PROPAGATE);
  assert.equal(filters.fn(scroll(SMOOTH)), Clutter.EVENT_STOP);
  values['drag-scroll-workspace'] = false;
  assert.equal(filters.fn(scroll(DOWN)), Clutter.EVENT_PROPAGATE);
  assert.deepEqual(moves, []);
});

test('drag-scroll: mouse-resize or tiling turned off mid-grab stops the carry', () => {
  for (const key of ['mouse-resize', 'enabled']) {
    const { self, values, filters, moves } = setup();
    self._beginDragScroll(dragWin(wss[1]), MOVE);
    values[key] = false;
    assert.equal(filters.fn(scroll(DOWN)), Clutter.EVENT_PROPAGATE, key);
    assert.deepEqual(moves, [], key);
  }
});

test('drag-scroll: a carried window is dropped at release without travel', () => {
  const { self, filters, repositioned } = setup();
  self._grabStartFrame = { x: 0, y: 0 };
  self._grabGrace = 10;
  const win = dragWin(wss[1]);
  self._beginDragScroll(win, MOVE);
  filters.fn(scroll(DOWN));
  self._handleGrabEnd(win, MOVE);
  assert.deepEqual(repositioned, [[win, wss[2]]]);
  assert.equal(self._grabCarried, null);

  // The next grab, not carried, is a click again.
  self._grabOp = MOVE;
  self._grabStartFrame = { x: 0, y: 0 };
  self._handleGrabEnd(win, MOVE);
  assert.equal(repositioned.length, 1);
});

test('drag-scroll: the drop preview stays hidden during the slide', () => {
  const { self, filters } = setup();
  let targeted = 0;
  self._computeDwindleDropTarget = () => { targeted++; return null; };
  self._getWorkspaceLayout = () => 'dwindle';
  self._getWindowsForWorkspace = () => [{}, {}];
  const win = dragWin(wss[1]);
  self._beginDragScroll(win, MOVE);
  filters.fn(scroll(DOWN));
  Main.wm._workspaceAnimation._switchData = { monitors: [] };
  self.dragPreview.updateMoveDragPreview(win);
  assert.equal(targeted, 0);
  Main.wm._workspaceAnimation._switchData = null;
  self.dragPreview.updateMoveDragPreview(win);
  assert.equal(targeted, 1);
});

test('workspace-changed: the window leaves the old tree at once', () => {
  const { self } = setup();
  const handlers = {};
  const [a, b] = [dragWin(wss[1]), dragWin(wss[1])];
  a.connectObject = (name, cb) => { handlers[name] = cb; };
  a.disconnectObject = () => {};
  a.get_compositor_private = () => null;
  self._bspTrees.set(wss[1], split('h', 0.5, leaf(a), leaf(b)));
  self._windowWorkspaces.set(a, wss[1]);
  self.windows.connectWindowSignals(a);
  a._ws = wss[2];
  handlers['workspace-changed']();
  assert.deepEqual(self._bspCollectWindows(self._bspTrees.get(wss[1])), [b]);
});

test('drag-scroll: a release during the slide pops its grab only when it is a Clutter.Grab', () => {
  const { self, filters } = setup({ animate: true });
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  filters.fn(scroll(DOWN));
  const anim = Main.wm._workspaceAnimation;
  anim._grab = {};
  const warned = withWarnings(() => {
    filters.fn(release);
    filters.fn(release);
  });
  assert.deepEqual(Main.popped, []);
  assert.equal(warned.length, 1);

  const grab = new Clutter.Grab();
  anim._grab = grab;
  assert.equal(filters.fn(release), Clutter.EVENT_PROPAGATE);
  assert.deepEqual(Main.popped, [grab]);
  assert.equal(anim._grab, null);
});

test('drag-scroll: unexpected slide state falls back to the nominal slide, no pop', () => {
  const { self, filters, moves } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  Main.wm._workspaceAnimation = { _switchData: { monitors: 'x' }, _grab: new Clutter.Grab() };
  const warned = withWarnings(() => {
    filters.fn(scroll(DOWN));
    filters.fn(release);
    // 250ms x slow_down_factor 1: still sliding at 200ms, done at 300ms.
    now += 200_000;
    assert.equal(self.dragScroll.sliding(), true);
    now += 100_000;
    assert.equal(self.dragScroll.sliding(), false);
    now += 100_000;
    filters.fn(scroll(DOWN));
  });
  assert.deepEqual(Main.popped, []);
  assert.deepEqual(moves, [[1, 2], [2, 3]]);
  assert.equal(warned.length, 1);
});

test('drag-scroll: without the shell\'s slide state the nominal slide holds the next step', () => {
  const { self, filters, moves } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  delete Main.wm._workspaceAnimation;
  const warned = withWarnings(() => {
    filters.fn(scroll(DOWN));
    now += 200_000;
    filters.fn(release);
    assert.equal(self.dragScroll.sliding(), true);
    now += 150_000;
    assert.equal(self.dragScroll.sliding(), false);
  });
  assert.deepEqual(moves, [[1, 2]]);
  assert.deepEqual(Main.popped, []);
  assert.equal(warned.length, 1);
});

test('drag-scroll: the switch focus restore skips the workspace the dragged window is on', () => {
  const { self, values } = setup();
  values['workspace-popup'] = false;
  const handlers = {};
  self.signals.connectObject = (_emitter, name, cb) => { handlers[name] = cb; };
  const OrigSettings = Gio.Settings;
  Gio.Settings = class {};
  const core = self;
  core.grab.connectGrabSignals = () => {};
  core.monitors.connectSignals = () => {};
  try {
    self.signals.connectSignals();
  } finally {
    Gio.Settings = OrigSettings;
  }
  core.windows.reassertFloatingTransients = () => false;
  core.borders.updateBorders = () => {};
  core.placement.checkWorkspaceLandings = () => {};
  core.bgApp.hideParkingCard = () => {};
  GLib.timeout_add = () => 1;
  const other = dragWin(wss[1]);
  core.windows.getWindowsForWorkspace = () => [other];
  let restores = 0;
  self.signals.addIdle = () => { restores++; };

  const win = dragWin(wss[1]);
  self._beginDragScroll(win, MOVE);
  handlers['active-workspace-changed']();
  assert.equal(restores, 0);

  self._handleGrabEnd(win, MOVE);
  handlers['active-workspace-changed']();
  assert.equal(restores, 1);
});

test('drag-scroll: a slide this grab did not start holds the step', () => {
  const { self, filters, moves } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  Main.wm._workspaceAnimation._switchData = { monitors: [] };
  filters.fn(scroll(DOWN));
  assert.deepEqual(moves, []);
});

test('drag-scroll: a release ends only the slide the carry started', () => {
  const { self, filters } = setup({ animate: true });
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  filters.fn(scroll(DOWN));
  const anim = Main.wm._workspaceAnimation;
  // The carry's slide finishes; a keyboard switch starts another.
  anim._switchData = { monitors: [] };
  anim._grab = new Clutter.Grab();
  filters.fn(release);
  assert.deepEqual(Main.popped, []);
  assert.ok(anim._grab);
});

test('drag-scroll: a second begin replaces the live filter', () => {
  const { self, filters } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  self._beginDragScroll(dragWin(wss[2]), MOVE);
  assert.equal(filters.added, 2);
  assert.deepEqual(filters.removed, [1]);
});

test('drag-scroll: begin skips dialogs, sticky and skip-taskbar windows, and untracked tiled grabs', () => {
  const cases = [
    (w) => { w.get_window_type = () => 3; },
    (w) => { w.is_on_all_workspaces = () => true; },
    (w) => { w.is_skip_taskbar = () => true; },
  ];
  for (const tweak of cases) {
    const { self, filters } = setup();
    const win = dragWin(wss[1]);
    tweak(win);
    self._beginDragScroll(win, MOVE);
    assert.equal(filters.added, 0);
  }
  const untracked = setup();
  untracked.self._grabOp = null;
  untracked.self._beginDragScroll(dragWin(wss[1]), MOVE);
  assert.equal(untracked.filters.added, 0);
  const floating = setup({ floating: true });
  floating.self._grabOp = null;
  floating.self._beginDragScroll(dragWin(wss[1]), MOVE);
  assert.equal(floating.filters.added, 1);
});

test('drag-scroll: no carry while the overview is open', () => {
  const { self, filters, moves } = setup();
  self._beginDragScroll(dragWin(wss[1]), MOVE);
  Main.overview.visible = true;
  filters.fn(scroll(DOWN));
  Main.overview.visible = false;
  assert.deepEqual(moves, []);
});

test('drag-scroll: a new grab starts uncarried', () => {
  const { self } = setup({ floating: true });
  const win = dragWin(wss[1]);
  win.get_buffer_rect = () => ({ x: 0, y: 0, width: 800, height: 600 });
  globalThis.global.display.get_n_monitors = () => 0;
  globalThis.global.display.get_primary_monitor = () => 0;
  globalThis.global.display.get_monitor_geometry = () => ({ x: 0, y: 0, width: 2560, height: 1440 });
  self.grab.startGrabLoop = () => {};
  self._grabCarried = win;
  self.grab.handleGrabBegin(win, MOVE);
  assert.equal(self._grabCarried, null);
});

test('grab begin: a transform run on the grabbed window ends (mutter moves it now)', () => {
  const { self } = setup({ floating: true });
  const win = dragWin(wss[1]);
  win.get_buffer_rect = () => ({ x: 0, y: 0, width: 800, height: 600 });
  globalThis.global.display.get_n_monitors = () => 0;
  globalThis.global.display.get_primary_monitor = () => 0;
  globalThis.global.display.get_monitor_geometry = () => ({ x: 0, y: 0, width: 2560, height: 1440 });
  self.grab.startGrabLoop = () => {};
  const released = [];
  self.transforms.release = (w) => released.push(w);
  self.grab.handleGrabBegin(win, MOVE);
  assert.deepEqual(released, [win]);
});

test('drag-scroll: the drop preview does not read the slide state without a watched grab', () => {
  const { self } = setup();
  Main.wm._workspaceAnimation = { _switchData: { monitors: 'x' }, _grab: null };
  const warned = withWarnings(() => self.dragPreview.updateMoveDragPreview({ get_workspace: () => null }));
  assert.deepEqual(warned, []);
});
