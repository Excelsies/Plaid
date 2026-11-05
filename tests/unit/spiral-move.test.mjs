import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// movewindow (Super+Shift+arrows): Hyprland's in a Spiral group, GNOME's
// move-to-monitor for any other window.

const WS = {};
// Two 1000x800 monitors side by side; monitor 1 (MON1) is right of monitor 0.
const AREAS = [{ x: 0, y: 0, width: 1000, height: 800 }, { x: 1000, y: 0, width: 1000, height: 800 }];

function win(id, mon = 0) {
  const w = fakeWin({ id, instance: id, frame: { x: 0, y: 0, width: 100, height: 100 } });
  w.get_id = () => id;
  w.get_workspace = () => WS;
  w.get_monitor = () => mon;
  w.moved = [];
  w.move_to_monitor = m => w.moved.push(`plain ${m}`);
  return w;
}

// groups: [tree or null per monitor]; layouts: per monitor.
function setup({ trees, layouts = ['spiral', 'spiral'], wins, settings = {}, neighbors = { 'right:0': 1, 'left:1': 0 } }) {
  const self = makeSelf({ enabled: true, ...settings });
  const floats = new Set();
  const groupOf = new Map(wins.map(w => [w, w.get_monitor()]));
  self.windows.getWorkspaceLayout = (_ws, mon) => layouts[mon];
  self.windows.isFloating = w => floats.has(w);
  self.windows.isFullscreenTile = () => false;
  self.monitors.windowMon = w => groupOf.get(w) ?? 0;
  self.monitors.groupPlaces = (_ws, mon) => mon >= 0 && layouts[mon] !== 'floating';
  self.monitors.monitorWorkArea = (_ws, mon) => AREAS[mon];
  self.monitors.monConn = mon => `M${mon}`;
  self.monitors.getWindowsForGroup = (_ws, mon) => wins.filter(w => groupOf.get(w) === mon);
  self.monitors.neighbor = (mon, dir) => neighbors[`${dir}:${mon}`] ?? -1;
  const regrouped = [];
  self.monitors.moveWindowToGroup = (w, conn, cause, at) => regrouped.push([w, conn, cause, at]);
  // GNOME's move (its rect maths is tested on its own below).
  self.monitors.moveToMonitor = (w, m) => w.moved.push(m);
  self.geometry.wsIndex = () => 1;
  const retiles = [];
  self.layouts.retileWorkspace = ws => retiles.push(ws);
  const refreshed = [];
  self.layouts.refreshSavedShape = (_ws, t, mon) => refreshed.push(mon);
  const warped = [];
  self.windows.cursorWarpDeferred = w => warped.push(w);
  trees.forEach((t, mon) => t && self.bsp.bspSetTree(WS, mon, t));
  return { self, floats, regrouped, retiles, refreshed, warped, tree: mon => self.bsp.bspGetTree(WS, mon) };
}

const shape = (self, t) => self.bsp.dwindleShapeToString(t);
const names = t => t.type === 'leaf' ? t.window._testId
  : `${t.direction}${t.pinned ? '!' : ''}(${names(t.first)},${names(t.second)})`;

function abc() {
  const a = win('a'), b = win('b'), c = win('c');
  const ctx = setup({ trees: [split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)))], wins: [a, b, c] });
  return { ...ctx, a, b, c };
}

test('movewindow: toward a lone partner across the parent split, past it (Hyprland\'s override)', () => {
  {
    const a = win('a'), b = win('b');
    const { self, tree, retiles, refreshed } = setup({ trees: [split('h', 0.5, leaf(a), leaf(b))], wins: [a, b] });
    assert.equal(self.spiral.moveWindow(a, WS, 0, 'right'), true);
    assert.equal(names(tree(0)), 'h(b,a)');
    assert.deepEqual([retiles.length, refreshed], [1, [0]]);
  }
  {
    const { self, c, tree } = abc();
    self.spiral.moveWindow(c, WS, 0, 'up');
    assert.equal(names(tree(0)), 'h(a,v(c,b))');
  }
});

// A|(B/C): B left. Its parent is stacked, so no override: B splits A, the
// leaf past its left edge, on the half the point is in (A is tall: top).
test('movewindow: otherwise it splits the leaf past its edge, on the side the point picks', () => {
  const { self, b, tree } = abc();
  self.spiral.moveWindow(b, WS, 0, 'left');
  assert.equal(names(tree(0)), 'h(v(b,a),c)');
});

// C left in A|(B/C): B is a lone partner, but across a stacked split, so no
// override: C splits A below (A is tall, C's centre in its lower half).
test('movewindow: a lone partner along the other axis is no override', () => {
  const { self, c, tree } = abc();
  self.spiral.moveWindow(c, WS, 0, 'left');
  assert.equal(names(tree(0)), 'h(v(a,c),b)');
});

// h(A, h!(B, C)): B left. B is the first child: the lone partner it moves
// toward is outside its split, so no override; B splits A below.
test('movewindow: no override toward the window\'s own side of the split', () => {
  const a = win('a'), b = win('b'), c = win('c');
  const { self, tree } = setup({ trees: [split('h', 0.5, leaf(a), { ...split('h', 0.5, leaf(b), leaf(c)), pinned: true })], wins: [a, b, c] });
  self.spiral.moveWindow(b, WS, 0, 'left');
  assert.equal(names(tree(0)), 'h(v(a,b),c)');
});

test('movewindow: a window without a slot (a float) is left alone', () => {
  const { self, b, floats, tree, retiles } = abc();
  floats.add(b);
  assert.equal(self.spiral.moveWindow(b, WS, 0, 'left'), false);
  assert.deepEqual([names(tree(0)), retiles.length], ['h(a,v(b,c))', 0]);
});

// A right in A|(B/C): its partner is a split, no override. Without A the
// B/C split fills the area and turns side by side (B 0-500, C 500-1000):
// the point (501, 400) is in C, which A splits below (C is tall, the point
// on its middle line).
test('movewindow: the leaf is found on the layout the window leaves behind, oriented', () => {
  const { self, a, tree } = abc();
  self.spiral.moveWindow(a, WS, 0, 'right');
  assert.equal(names(tree(0)), 'h(b,v(c,a))');
  // h0.5(X, v0.3(B, C)): stacked, (501, 400) would be in C's wide slot (right).
  const x = win('x'), b = win('b'), c = win('c');
  const s2 = setup({ trees: [split('h', 0.5, leaf(x), split('v', 0.3, leaf(b), leaf(c)))], wins: [x, b, c] });
  s2.self.spiral.moveWindow(x, WS, 0, 'right');
  assert.equal(names(s2.tree(0)), 'h(b,v(c,x))');
});

test('movewindow: the point is just inside the neighbour, past the inside gap', () => {
  // gap 10: B's slot starts at 505; the point left of it (494) is in A (0-495).
  const a = win('a'), b = win('b'), c = win('c');
  const { self, tree } = setup({ trees: [split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)))],
    wins: [a, b, c], settings: { 'inside-gap': 10 } });
  self.spiral.moveWindow(b, WS, 0, 'left');
  assert.equal(names(tree(0)), 'h(v(b,a),c)');
});

// v!(A, h(B, C)), gap 10: A is 0-395 high, B 405-800. B up: the point
// (247.5, 394) is in A; without the gap (404) it would be nearer C.
test('movewindow: up and down, the point is past the inside gap too', () => {
  const a = win('a'), b = win('b'), c = win('c');
  const up = setup({ trees: [{ ...split('v', 0.5, leaf(a), split('h', 0.5, leaf(b), leaf(c))), pinned: true }],
    wins: [a, b, c], settings: { 'inside-gap': 10 } });
  up.self.spiral.moveWindow(b, WS, 0, 'up');
  assert.match(names(up.tree(0)), /^v!?\(h!?\(b,a\),c\)$/);
  const down = setup({ trees: [{ ...split('v', 0.5, split('h', 0.5, leaf(b), leaf(c)), leaf(a)), pinned: true }],
    wins: [a, b, c], settings: { 'inside-gap': 10 } });
  down.self.spiral.moveWindow(b, WS, 0, 'down');
  assert.match(names(down.tree(0)), /^v!?\(c,h!?\(b,a\)\)$/);
});

test('movewindow: past the tiling area into the Spiral group of the monitor there, at that point', () => {
  const { self, b, regrouped, tree, retiles } = abc();
  assert.equal(self.spiral.moveWindow(b, WS, 0, 'right'), true);
  // B's slot is (500, 0, 500, 400): the point is (1001, 200).
  assert.deepEqual(regrouped, [[b, 'M1', 'move', [1001, 200]]]);
  assert.equal(names(tree(0)), 'h(a,v(b,c))', 'the regroup edits the trees');
  assert.equal(retiles.length, 0);
});

test('movewindow: past the edge into another layout by its own rule; into a group that places nothing, GNOME\'s move', () => {
  for (const layouts of [['spiral', 'dwindle'], ['spiral', 'floating'], ['spiral', 'spiral']]) {
    const a = win('a'), b = win('b');
    const { self, regrouped } = setup({ trees: [split('h', 0.5, leaf(a), leaf(b))], layouts, wins: [a, b] });
    // Spiral there, on a monitor that does not tile (workspaces on the primary only).
    if (layouts[1] === 'spiral') self.monitors.groupPlaces = (_ws, mon) => mon === 0;
    self.spiral.moveWindow(b, WS, 0, 'right');
    const want = layouts[1] === 'dwindle' ? [[[b, 'M1', 'move', null]], []] : [[], [1]];
    assert.deepEqual([regrouped, b.moved], want, layouts[1]);
  }
});

// A lone tile's tree is not kept: its slot is the tiling area.
test('movewindow: a lone tile with no tree moves to the monitor there', () => {
  const a = win('a');
  const { self, regrouped } = setup({ trees: [], wins: [a] });
  assert.equal(self.spiral.moveWindow(a, WS, 0, 'right'), true);
  assert.deepEqual(regrouped, [[a, 'M1', 'move', [1001, 400]]]);
});

test('movewindow: past the edge with no monitor there, nothing', () => {
  const { self, a, regrouped, tree, retiles } = abc();
  assert.equal(self.spiral.moveWindow(a, WS, 0, 'left'), false);
  assert.deepEqual([regrouped, a.moved, retiles], [[], [], []]);
  assert.equal(names(tree(0)), 'h(a,v(b,c))');
});

test('bspInsertForWorkspace at a point: the nearest leaf, the point\'s side', () => {
  const c = win('c', 1), d = win('d', 1), b = win('b', 1);
  const { self, tree } = setup({ trees: [null, split('h', 0.5, leaf(c), leaf(d))], wins: [c, d, b] });
  // (1000, 200): C (1000-1500 x 0-800, tall) on its top half.
  self.bsp.bspInsertForWorkspace(WS, b, 1, false, [1000, 200]);
  assert.equal(names(tree(1)), 'h(v(b,c),d)');
});

// A monitor whose last window left keeps an empty tree.
test('bspInsertForWorkspace at a point: an emptied Spiral group takes the window as its lone tile', () => {
  const b = win('b', 1);
  const { self, tree } = setup({ trees: [null, { type: 'empty' }], wins: [b] });
  self.bsp.bspInsertForWorkspace(WS, b, 1, false, [1001, 200]);
  assert.equal(names(tree(1)), 'b');
});

test('geometry.nearestTo: the closest rect, the first of a tie, null for none', () => {
  const self = makeSelf();
  const r = (x, y) => ({ x, y, w: 10, h: 10 });
  assert.equal(self.geometry.nearestTo([['a', r(0, 0)], ['b', r(20, 0)]], 16, 5), 'b');
  assert.equal(self.geometry.nearestTo([['a', r(0, 0)], ['b', r(20, 0)]], 15, 5), 'a');
  assert.equal(self.geometry.nearestTo([], 0, 0), null);
});

test('moveWindow: a Spiral tile uses movewindow; follow-focus warps the cursor when it moved', () => {
  for (const ff of [false, true]) {
    const { self, b, tree, warped } = abc();
    self._settings.get_boolean = k => (k === 'follow-focus' ? ff : k === 'enabled');
    global.display.focus_window = b;
    self.actions.moveWindow('left');
    assert.equal(names(tree(0)), 'h(v(b,a),c)', `follow-focus ${ff}`);
    assert.deepEqual(warped, ff ? [b] : [], `follow-focus ${ff}`);
  }
  const { self, a, warped } = abc();
  self._settings.get_boolean = k => k === 'follow-focus' || k === 'enabled';
  global.display.focus_window = a;
  self.actions.moveWindow('left');
  assert.deepEqual(warped, [], 'nothing moved, no warp');
});

// Every window that is not a tile of a Spiral group gets GNOME's move; its
// group follows as after GNOME's (onWindowEnteredMonitor), nothing here.
test('moveWindow: any other window moves to the monitor in that direction, as GNOME\'s move', () => {
  const cases = {
    float: ctx => ctx.floats.add(ctx.b),
    dwindle: null,
    'untiled monitor': ctx => { ctx.self.monitors.groupPlaces = (_ws, mon) => mon === 1; },
    'tiling off': ctx => { ctx.self._settings.get_boolean = () => false; },
  };
  for (const [kind, prep] of Object.entries(cases)) {
    const a = win('a'), b = win('b');
    const ctx = setup({ trees: [split('h', 0.5, leaf(a), leaf(b))], layouts: [kind === 'dwindle' ? 'dwindle' : 'spiral', 'spiral'], wins: [a, b] });
    ctx.self._windowMonitors.set(b, 'M0');
    prep?.({ ...ctx, b });
    global.display.focus_window = b;
    ctx.self.actions.moveWindow('right');
    assert.deepEqual([b.moved, ctx.regrouped, names(ctx.tree(0)), ctx.retiles.length], [[1], [], 'h(a,b)', 0], kind);
    ctx.self.actions.moveWindow('left');
    assert.deepEqual(b.moved, [1], `${kind}: no monitor on the left`);
  }
});

// A window on every workspace may carry another workspace in its record.
test('movewindow: past the edge, a window on every workspace gets GNOME\'s move', () => {
  const { self, b, regrouped } = abc();
  b.is_on_all_workspaces = () => true;
  self.spiral.moveWindow(b, WS, 0, 'right');
  assert.deepEqual([regrouped, b.moved], [[], [1]]);
});

// mutter's move_rect_between_rects, measured against GNOME's key in a
// sandbox (top bar 32 on monitor 0): a fitting frame keeps its relative
// place, one that does not fit its centre's; size kept; a user op.
test('monitors.moveToMonitor: GNOME\'s rect, as a user operation', () => {
  const self = makeSelf();
  const areas = [{ x: 0, y: 32, width: 2560, height: 1408 }, { x: 2560, y: 0, width: 2560, height: 1440 }];
  const make = (rect, mon, extra = {}) => {
    const w = { calls: [], get_frame_rect: () => ({ ...rect }), get_monitor: () => mon,
      get_work_area_for_monitor: m => areas[m], is_fullscreen: () => false, get_maximize_flags: () => 0,
      move_resize_frame(...a) { this.calls.push(['frame', ...a]); }, move_to_monitor(m) { this.calls.push(['monitor', m]); }, ...extra };
    return w;
  };
  const f = make({ x: 300, y: 200, width: 800, height: 600 }, 0);
  self.monitors.moveToMonitor(f, 1);
  assert.deepEqual(f.calls, [['frame', true, 2860, 174, 800, 600]]);
  // A monitor-sized tile on monitor 1, taller than monitor 0's work area.
  const t = make({ x: 2564, y: 4, width: 2552, height: 1432 }, 1);
  self.monitors.moveToMonitor(t, 0);
  assert.deepEqual(t.calls, [['frame', true, 4, 20, 2552, 1432]]);
  const t2 = make({ x: 2560, y: 0, width: 2552, height: 1432 }, 1);
  self.monitors.moveToMonitor(t2, 0);
  assert.deepEqual(t2.calls, [['frame', true, 0, 16, 2552, 1432]]);
  // Float sums, as mutter's: the centre branch clamped (a centre past the
  // right edge) and not, on a 1920x1080 monitor 1 at x 2560 (mutter: 4180,
  // 25 and 1879, 112; summed as doubles 4179 and 1878), the centre's y
  // (-484, not -483) and the contained branch's x (3561, not 3560). The
  // values are mutter's float32 arithmetic, worked out outside Plaid.
  areas.splice(0, 2, { x: 0, y: 0, width: 2560, height: 1440 }, { x: 2560, y: 0, width: 1920, height: 1080 });
  for (const [rect, want] of [[{ x: 2400, y: 100, width: 600, height: 400 }, [4180, 25]],
    [{ x: -639, y: 300, width: 1614, height: 900 }, [1879, 112]], [{ x: 300, y: 200, width: 800, height: 600 }, [2750, 114]],
    [{ x: 1417, y: 200, width: 380, height: 300 }, [3561, 136]], [{ x: 300, y: -461, width: 800, height: 1106 }, [2685, -484]]]) {
    const w = make(rect, 0);
    self.monitors.moveToMonitor(w, 1);
    assert.deepEqual(w.calls, [['frame', true, ...want, rect.width, rect.height]], JSON.stringify(rect));
  }
  // The contained branch's y, on a monitor 1 that starts at y 30 (513, not 512).
  areas.splice(1, 1, { x: 2560, y: 30, width: 1920, height: 1080 });
  const ky = make({ x: 300, y: 672, width: 800, height: 160 }, 0);
  self.monitors.moveToMonitor(ky, 1);
  assert.deepEqual(ky.calls, [['frame', true, 2750, 513, 800, 160]]);
  for (const extra of [{ is_fullscreen: () => true }, { get_maximize_flags: () => 3 }]) {
    const w = make({ x: 0, y: 0, width: 2560, height: 1440 }, 0, extra);
    self.monitors.moveToMonitor(w, 1);
    assert.deepEqual(w.calls, [['monitor', 1]]);
  }
});

// GNOME's move-to-monitor goes by the window's own monitor.
test('moveWindow: a non-Spiral window goes by the monitor it is on, not its group\'s', () => {
  const a = win('a'), b = win('b', 1);
  const ctx = setup({ trees: [split('h', 0.5, leaf(a), leaf(b))], layouts: ['dwindle', 'dwindle'], wins: [a, b],
    neighbors: { 'right:0': 1, 'left:1': 0 } });
  ctx.self.monitors.windowMon = () => 0;
  global.display.focus_window = b;
  ctx.self.actions.moveWindow('left');
  assert.deepEqual(b.moved, [0]);
});

test('moveWindow: nothing without a focused window or during a grab', () => {
  const { self, b, tree } = abc();
  global.display.focus_window = null;
  self.actions.moveWindow('left');
  global.display.focus_window = b;
  self._grabOp = 1;
  self.actions.moveWindow('left');
  assert.equal(names(tree(0)), 'h(a,v(b,c))');
  assert.deepEqual(b.moved, []);
});

test('monitors.neighbor: GNOME\'s monitor in that direction; none for a missing monitor', () => {
  const self = makeSelf();
  const asked = [];
  const prev = global.display;
  global.display = { ...prev, get_monitor_neighbor_index: (m, d) => { asked.push([m, d]); return 7; } };
  try {
    assert.deepEqual(['left', 'right', 'up', 'down'].map(d => self.monitors.neighbor(2, d)), [7, 7, 7, 7]);
    assert.deepEqual(asked, [[2, 2], [2, 3], [2, 0], [2, 1]]);
    assert.equal(self.monitors.neighbor(-1, 'left'), -1);
    assert.equal(self.monitors.neighbor(0, 'sideways'), -1);
  } finally {
    global.display = prev;
  }
});

test('keybindings: move-window-* are registered to moveWindow, on Super+Shift+arrows', () => {
  const self = makeSelf();
  const keys = new Map();
  const prev = Main.wm.addKeybinding;
  Main.wm.addKeybinding = (key, _s, _f, _m, fn) => { keys.set(key, fn); return true; };
  self.keybindings.checkKeybindingConflicts = () => {};
  self.keybindings.connectObject = () => 0;
  const called = [];
  self.actions.moveWindow = d => called.push(d);
  try {
    self.keybindings.registerKeybindings();
  } finally {
    Main.wm.addKeybinding = prev;
  }
  for (const d of ['left', 'right', 'up', 'down']) keys.get(`move-window-${d}`)();
  assert.deepEqual(called, ['left', 'right', 'up', 'down']);
  const schema = readFileSync(new URL('../../extensions/schemas/org.gnome.shell.extensions.plaid.gschema.xml', import.meta.url), 'utf8');
  for (const [d, k] of [['left', 'Left'], ['right', 'Right'], ['up', 'Up'], ['down', 'Down']]) {
    const m = new RegExp(`<key name="move-window-${d}" type="as">\\s*<default><!\\[CDATA\\[(.*?)\\]\\]></default>`).exec(schema);
    assert.equal(m?.[1], `['<Super><Shift>${k}']`, d);
  }
});

// The real group move: the window leaves monitor 0's tree and splits the
// leaf of monitor 1's Spiral tree nearest the point, on its side.
test('moveWindowToGroup at a point: the Spiral target group splits there', () => {
  const a = win('a'), b = win('b'), c = win('c', 1), d = win('d', 1);
  const wins = [a, b, c, d];
  const { self, tree } = setup({ trees: [split('h', 0.5, leaf(a), leaf(b)), split('h', 0.5, leaf(c), leaf(d))], wins });
  const conn = new Map(wins.map(w => [w, `M${w.get_monitor()}`]));
  self.monitors.connMon = cn => Number(cn.slice(1));
  self.monitors.windowConn = w => conn.get(w);
  self.monitors.setWindowGroup = (w, cn) => conn.set(w, cn);
  self.monitors.removeFromGroupTree = (w, ws, cn) => self.bsp.bspSetTree(ws, self.monitors.connMon(cn), self.bsp.bspRemove(self.bsp.bspGetTree(ws, self.monitors.connMon(cn)), w));
  self.monitors.getWindowsForGroup = (_ws, mon) => wins.filter(w => conn.get(w) === `M${mon}`);
  for (const w of wins) { self._windowMonitors.set(w, conn.get(w)); self._windowWorkspaces.set(w, WS); }
  self.windows.getWorkspaceOrder = () => [...wins];
  delete self.monitors.moveWindowToGroup;
  assert.equal(self.monitors.moveWindowToGroup(b, 'M1', 'move', [1001, 600]), true);
  assert.equal(names(tree(0)), 'a');
  assert.equal(names(tree(1)), 'h(v(c,b),d)');
});

// The override side is pinned only where the box rule would turn it: down
// past a lone partner that fills the wide area keeps the two stacked. The
// move is structural: the next layout re-orients the group.
test('movewindow: a side against the box rule is pinned; the group re-orients at its next layout', () => {
  const a = win('a'), b = win('b');
  const t = { ...split('v', 0.5, leaf(a), leaf(b)), pinned: true, _orientSig: 'x' };
  const { self, tree } = setup({ trees: [t], wins: [a, b] });
  self.spiral.moveWindow(a, WS, 0, 'down');
  assert.equal(names(tree(0)), 'v!(b,a)');
  // The root survives the move (h(C, B/A)): its signature is dropped.
  const c = win('c'), d = win('d'), e = win('e');
  const t3 = { ...split('h', 0.5, leaf(c), split('v', 0.5, leaf(d), leaf(e))), _orientSig: 'x' };
  const s3 = setup({ trees: [t3], wins: [c, d, e] });
  s3.self.spiral.moveWindow(d, WS, 0, 'down');
  assert.deepEqual([names(s3.tree(0)), s3.tree(0)._orientSig], ['h(c,v(e,d))', undefined]);
});
