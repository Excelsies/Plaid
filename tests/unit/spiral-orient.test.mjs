import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// When Spiral re-orients: only on a change of structure or area (one
// decision point, bsp.orientLive), never on a resize. And how long a pin
// lasts: a drop pins only against the box rule, a close that promotes a
// split frees it, a saved pin comes back only over its own windows.

const WS = {};
let WA = { x: 0, y: 0, width: 1000, height: 500 };

function win(id) {
  const w = fakeWin({ id, instance: id, frame: null });
  w.get_id = () => id;
  w.get_workspace = () => WS;
  w.get_maximize_flags = () => 0;
  return w;
}

function groupSelf(wins, settings = {}, layout = 'spiral') {
  const self = makeSelf({ 'dwindle-ratio': 0.5, enabled: true, ...settings });
  const state = { wins, layout };
  self.windows.getWorkspaceLayout = () => state.layout;
  self.windows.isFloating = () => false;
  self.windows.isFullscreenTile = () => false;
  self.windows.getWindowsForWorkspace = () => state.wins;
  self.monitors.windowMon = () => 0;
  self.monitors.groupPlaces = () => true;
  self.monitors.monitorWorkArea = () => WA;
  self.monitors.getWindowsForGroup = () => state.wins;
  self.geometry.wsIndex = () => 1;
  self.grab.safeMove = () => {};
  self.layouts.retileWorkspace = () => {};
  return { self, state };
}

const retile = (self, wins) => {
  if (!self._bspLaidOutAs.has(self.monitors.groupObj(WS, 0)))
    self._bspLaidOutAs.set(self.monitors.groupObj(WS, 0), self.windows.getWorkspaceLayout(WS, 0));
  self.layouts.retileDwindle(WS, wins, 0);
  return self.bsp.bspGetTree(WS, 0);
};
const str = (self, t) => self.bsp.dwindleShapeToString(t);

// P4: h(A,v(B,h(C,D))) on 2560x1440, a corner drag leaves root 0.42 and the
// inner 0.30. B/C|D's box is 1484 wide after it: by the box rule it would
// turn side by side, but a resize never flips.
test('a resize never re-orients: the release keeps every direction (P4); a keyboard resize neither', () => {
  WA = { x: 0, y: 0, width: 2560, height: 1440 };
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(win);
  const { self } = groupSelf([a, b, c, d]);
  const t = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), split('h', 0.5, leaf(c), leaf(d))));
  self.bsp.bspSetTree(WS, 0, t);
  retile(self, [a, b, c, d]);
  t.ratio = 0.42;
  t.second.ratio = 0.3;
  self._grabOp = 1;
  retile(self, [a, b, c, d]);
  self._grabOp = null;
  assert.equal(str(self, retile(self, [a, b, c, d])), 'h0.4200(l,v0.3000(l,h0.5000(l,l)))');
  // A keyboard resize: the same ratio-only retile.
  t.ratio = 0.3;
  assert.equal(retile(self, [a, b, c, d]).second.direction, 'v');
  // A structural change does re-orient: C closes.
  assert.equal(str(self, retile(self, [a, b, d])), 'h0.3000(l,h0.3000(l,l))');
  WA = { x: 0, y: 0, width: 1000, height: 500 };
});

test('orientLive: a window swap or another ratio-only retile does not re-orient; area, layout switch and the setting do', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(win);
  const { self, state } = groupSelf([a, b, c]);
  // A|(B/C) on 1000x500: B/C's 500x500 box is side by side by the rule.
  const t = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)));
  self.bsp.bspSetTree(WS, 0, t);
  self.bsp.orientLive(t, { x: 0, y: 0, w: 1000, h: 500 }, 0, WS, 0);
  assert.equal(t.second.direction, 'h');
  const back = () => { t.second.direction = 'v'; };
  back();
  self.bsp.bspSwapWindows(t, b, c);
  self.bsp.orientLive(t, { x: 0, y: 0, w: 1000, h: 500 }, 0, WS, 0);
  assert.equal(t.second.direction, 'v', 'swap');
  // Another tiling area: re-oriented.
  self.bsp.orientLive(t, { x: 0, y: 30, w: 1000, h: 470 }, 0, WS, 0);
  assert.equal(t.second.direction, 'h', 'area');
  // A switch from a layout that does not orient (here: the setting on, then off).
  back();
  self._settings.get_boolean = k => k === 'spiral-preserve-split';
  self.bsp.orientLive(t, { x: 0, y: 30, w: 1000, h: 470 }, 0, WS, 0);
  assert.equal(t.second.direction, 'v', 'preserved');
  self._settings.get_boolean = () => false;
  self.bsp.orientLive(t, { x: 0, y: 30, w: 1000, h: 470 }, 0, WS, 0);
  assert.equal(t.second.direction, 'h', 'setting off');
  back();
  state.layout = 'dwindle';
  self.bsp.orientLive(t, { x: 0, y: 30, w: 1000, h: 470 }, 0, WS, 0);
  state.layout = 'spiral';
  self.bsp.orientLive(t, { x: 0, y: 30, w: 1000, h: 470 }, 0, WS, 0);
  assert.equal(t.second.direction, 'h', 'layout switch');
  // markStructural: the next pass runs.
  back();
  self.bsp.markStructural(WS, 0);
  self.bsp.orientLive(t, { x: 0, y: 30, w: 1000, h: 470 }, 0, WS, 0);
  assert.equal(t.second.direction, 'h', 'marked');
});

// A subtree that was the root once must not keep its signature: after a
// window opened beside it and closed again, it is re-oriented for the area.
test('orientLive: a former root promoted back is re-oriented', () => {
  const [b, c, n] = ['b', 'c', 'n'].map(win);
  const { self } = groupSelf([b, c]);
  const area = { x: 0, y: 0, w: 1000, h: 500 };
  const sub = split('h', 0.5, leaf(b), leaf(c));
  self.bsp.orientLive(sub, area, 0, WS, 0);
  const t = split('h', 0.5, leaf(n), sub);
  self.bsp.orientLive(t, area, 0, WS, 0);
  assert.equal(sub.direction, 'h', 'its 500x500 box');
  sub.direction = 'v';
  const back = self.bsp.bspRemove(t, n);
  assert.equal(back, sub);
  self.bsp.orientLive(back, area, 0, WS, 0);
  assert.equal(sub.direction, 'h');
});

// P1: A|B, C dropped below B on a 500x500 box (square: side by side by the
// rule, so the drop is pinned), then A closes: the promoted B/C split is
// free again and turns side by side on the whole area.
test('a close that promotes a pinned split frees it (P1)', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(win);
  const { self, state } = groupSelf([a, b, c]);
  const t = split('h', 0.5, leaf(a), leaf(b));
  self.bsp.bspTagGeometry(t, 0, 0, 1000, 500, 0);
  self.bsp.bspSetTree(WS, 0, self.spiral.dropTree(t, b, c, 'bottom'));
  assert.equal(retile(self, [a, b, c]).second.pinned, true);
  state.wins = [b, c];
  const after = retile(self, [b, c]);
  assert.deepEqual([after.direction, after.pinned], ['h', undefined]);
});

test('orientation gate: one decision point for a group\'s own tree', () => {
  const src = f => readFileSync(new URL(`../../extensions/modules/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const count = (s, re) => (s.match(re) || []).length;
  const bsp = src('bsp.js'), layouts = src('layouts.js'), spiral = src('spiral.js');
  // orientTree: its recursion, orientSpiral and orientLive.
  assert.equal(count(bsp, /this\.orientTree\(/g), 4);
  assert.equal(count(layouts + spiral, /orientTree\(/g), 0);
  // orientLive: the retile and the new window's tag; nothing else lays a live tree out oriented.
  assert.equal(count(layouts, /bsp\.orientLive\(/g), 1);
  assert.equal(count(bsp, /this\.orientLive\(/g), 1);
  assert.equal(count(spiral, /orientLive\(/g), 0);
});

test('spiral-preserve-split: a change retiles every group', () => {
  const s = readFileSync(new URL('../../extensions/modules/signals.js', import.meta.url), 'utf8');
  assert.match(s, /'changed::spiral-preserve-split', \(\) => this\.core\.layouts\.retileAll\(\)\)/);
});

// P2: a pin saved from a live tree names its windows: it does not land on
// another window's split of the same shape. One read from the settings
// names none, and lands by shape.
test('reconcileTreeRatios: a saved pin comes back over its own windows only (P2)', () => {
  const [a, b, c, t, z] = ['a', 'b', 'c', 't', 'z'].map(win);
  const { self } = groupSelf([a, t, z]);
  const live0 = split('h', 0.5, leaf(a), split('h', 0.5, leaf(b), leaf(c)));
  live0.second.pinned = true;
  const saved = self.bsp.savedShape(live0);
  assert.equal(saved.second.ids, 'b,c');
  const other = split('h', 0.5, leaf(a), split('v', 0.5, leaf(t), leaf(z)));
  self.bsp.reconcileTreeRatios(saved, other, true);
  assert.deepEqual([other.second.direction, other.second.pinned], ['v', undefined]);
  const same = split('h', 0.5, leaf(a), split('v', 0.5, leaf(c), leaf(b)));
  self.bsp.reconcileTreeRatios(saved, same, true);
  assert.deepEqual([same.second.direction, same.second.pinned], ['h', true]);
  const read = self.bsp.dwindleShapeFromString('h0.5000(l,H0.5000(l,l))');
  const any = split('h', 0.5, leaf(a), split('v', 0.5, leaf(t), leaf(z)));
  self.bsp.reconcileTreeRatios(read, any, true);
  assert.deepEqual([any.second.direction, any.second.pinned], ['h', true]);
});

// M6: the live tree's own pin wins over a saved one.
test('reconcileTreeRatios: a live pin keeps its direction over a saved pin', () => {
  const { self } = groupSelf([]);
  const saved = self.bsp.dwindleShapeFromString('h0.5000(l,H0.5000(l,l))');
  const live = split('h', 0.5, leaf(win('a')), split('v', 0.5, leaf(win('b')), leaf(win('c'))));
  live.second.pinned = true;
  self.bsp.reconcileTreeRatios(saved, live, true);
  assert.deepEqual([live.second.direction, live.second.pinned], ['v', true]);
});

function persistSelf(values = {}) {
  const self = makeSelf();
  const v = { 'inside-gap': 0, layout: 'spiral', ...values };
  self._settings = {
    v, get_int: k => v[k] ?? 0, get_double: k => v[k] ?? 0.5, get_boolean: k => v[k] ?? false,
    get_string: k => v[k] ?? '', get_strv: k => v[k] ?? [], set_string: (k, x) => { v[k] = x; },
    set_strv: (k, x) => { v[k] = [...x]; if (k === 'workspace-dwindle-trees') self.persistence.loadPersistedLayoutRules(); },
  };
  return self;
}

// M7: the primary's entries belong to the monitor the keys were saved for
// (monitor-primary-connector), also when another monitor is the primary now.
test('persistence: primary pins load for the monitor the keys were saved for', () => {
  const self = persistSelf({ 'monitor-primary-connector': 'DP-1',
    'workspace-dwindle-trees': ['1:spiral:h0.5000(l,v0.5000(l,l))'], 'spiral-split-pins': ['1:spiral:h(l,V(l,l))'] });
  self.monitors.keyedPrimaryConn = () => 'DP-2';
  self.persistence.loadPersistedLayoutRules();
  assert.equal(self._persistedDwindleByIndex.get('1@DP-1:spiral').second.pinned, true);
});

// P3: a re-parse on the shapes write (a changed:: handler) reads the pins
// the same save wrote.
test('persistence: the save writes the pins before the shapes (P3)', () => {
  const self = persistSelf();
  const ws = {};
  const prev = global.workspace_manager;
  global.workspace_manager = { get_n_workspaces: () => 2, get_workspace_by_index: i => (i === 1 ? ws : {}) };
  self.monitors.syncKeyedPrimary = () => {};
  self.monitors.keyedPrimaryConn = () => 'DP-1';
  self.monitors.tiledMonitors = () => [0];
  self.monitors.monConn = () => 'DP-1';
  self.geometry.wsIndex = w => (w === ws ? 1 : 0);
  self._workspaceLayouts.set(1, 'spiral');
  const t = split('h', 0.5, leaf(fakeWin()), split('h', 0.25, leaf(fakeWin()), leaf(fakeWin())));
  t.second.pinned = true;
  self._bspTrees.set(ws, t);
  self.persistence.savePersistedLayouts();
  global.workspace_manager = prev;
  assert.equal(self._persistedDwindleByIndex.get('1:spiral').second.pinned, true);
});

// The signature sees the shape and the windows: a reshaped tree (a drop that
// keeps the window set) and a window replaced in place both re-orient.
test('orientLive: a new shape with the same windows, or another window in the same shape, re-orients', () => {
  const [a, b, c, n] = ['a', 'b', 'c', 'n'].map(win);
  const { self } = groupSelf([a, b, c]);
  const area = { x: 0, y: 0, w: 1000, h: 500 };
  const t = split('h', 0.5, leaf(a), split('h', 0.5, leaf(b), leaf(c)));
  self.bsp.orientLive(t, area, 0, WS, 0);
  assert.equal(t.second.direction, 'h', '500x500');
  // Reshaped in place: h(h(a,b),c), the inner split left stacked.
  const inner = t.second;
  t.second = leaf(c);
  t.first = { ...inner, direction: 'v', first: leaf(a), second: leaf(b) };
  self.bsp.orientLive(t, area, 0, WS, 0);
  assert.equal(t.first.direction, 'h', 'new shape');
  // b replaced by n, same shape.
  t.first.direction = 'v';
  t.first.second = leaf(n);
  self.bsp.orientLive(t, area, 0, WS, 0);
  assert.equal(t.first.direction, 'h', 'another window');
});

// A new window's insert already ran the pass on its tree; the retile that
// follows restores a saved shape (new ratios, same structure): it runs again.
test('retileDwindle: a restored shape re-orients after the insert already took the pass', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(win);
  const { self } = groupSelf([a, b, c]);
  WA = { x: 0, y: 0, width: 1000, height: 600 };
  const t = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)));
  self.bsp.bspSetTree(WS, 0, t);
  self.bsp.orientLive(t, { x: 0, y: 0, w: 1000, h: 600 }, 0, WS, 0);
  assert.equal(t.second.direction, 'v', '500x600');
  self._persistedDwindleByIndex = new Map([[self.persistence.shapeKey(self.monitors.groupKey(WS, 0), 'spiral'),
    self.bsp.dwindleShapeFromString('h0.2000(l,v0.5000(l,l))')]]);
  const after = retile(self, [a, b, c]);
  WA = { x: 0, y: 0, width: 1000, height: 500 };
  assert.deepEqual([after.ratio, after.second.direction], [0.2, 'h']);
});

// A drag starts from the layout as it is: after a resize that did not flip
// (P4), the live slots and home are the unoriented ones; the ghost (A gone)
// is oriented. On another monitor's group nothing is removed: no pass.
test('buildDragGhost: home and the live slots keep the layout a resize left; the ghost without the window is oriented', () => {
  WA = { x: 0, y: 0, width: 2560, height: 1440 };
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(win);
  const { self } = groupSelf([a, b, c, d]);
  const t = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), split('h', 0.5, leaf(c), leaf(d))));
  self.bsp.bspSetTree(WS, 0, t);
  retile(self, [a, b, c, d]);
  t.ratio = 0.42;
  t.second.ratio = 0.3;
  retile(self, [a, b, c, d]);
  const slots = self.bsp.spiralSlots(WS, 0);
  const g = self.spiral.buildDragGhost(b, WS, 0);
  assert.equal(str(self, self.bsp.bspGetTree(WS, 0)), 'h0.4200(l,v0.3000(l,h0.5000(l,l)))', 'live tree untouched');
  for (const w of [a, b, c, d]) assert.deepEqual(g.live.get(w), slots.get(w), w.get_id());
  assert.deepEqual(g.home, slots.get(b));
  // Without B: A|(C|D) side by side as the rule gives (C|D's box 1478x1440).
  assert.equal(g.tree.second.direction, 'h');
  // Not in this group (another monitor's drag): the live tree as is.
  const other = self.spiral.buildDragGhost(win('x'), WS, 0);
  assert.equal(str(self, other.tree), 'h0.4200(l,v0.3000(l,h0.5000(l,l)))');
  WA = { x: 0, y: 0, width: 1000, height: 500 };
});

test('bspClone: a copy carries no orientation signature', () => {
  const { self } = groupSelf([]);
  const t = { ...split('h', 0.5, leaf(win('a')), leaf(win('b'))), _orientSig: 'x' };
  assert.equal(self.bsp.bspClone(t)._orientSig, undefined);
  assert.equal(t._orientSig, 'x');
});
