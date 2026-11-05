import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

// Spiral's Hyprland operations: directional focus and swap on slots.

const WS = {};
const WA = { x: 0, y: 0, width: 1000, height: 500 };

function win(id, frame, opts = {}) {
  const w = fakeWin({ id, instance: id, frame, ...opts });
  w.get_id = () => id;
  w.get_workspace = () => WS;
  w.get_maximize_flags = () => 0;
  return w;
}

function groupSelf(layout, wins, settings = {}) {
  const self = makeSelf({ 'dwindle-ratio': 0.5, enabled: true, ...settings });
  const floats = new Set();
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = w => floats.has(w);
  self.windows.isFullscreenTile = () => false;
  self.windows.getWindowsForWorkspace = () => wins;
  self.windows.cursorWarpDeferred = () => {};
  self.monitors.windowMon = () => 0;
  self.monitors.groupPlaces = () => true;
  self.monitors.monitorWorkArea = () => WA;
  self.monitors.getWindowsForGroup = () => wins;
  self.geometry.wsIndex = () => 1;
  self.grab.safeMove = () => {};
  self.signals.addIdle = () => {};
  self.currentTime = () => 0;
  const retiles = [];
  self.layouts.retileWorkspace = ws => retiles.push(ws);
  let activated = null;
  for (const w of wins) w.activate = () => { activated = w; };
  return { self, floats, retiles, activated: () => activated };
}

// h0.5(A,Bm) on a 1000 px area: Bm (an 800 px minimum) is drawn centred on
// its slot and clamped into the area, so its frame covers A's right edge.
function oversized(layout) {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 200, y: 0, width: 800, height: 500 });
  const ctx = groupSelf(layout, [a, b]);
  ctx.self.bsp.bspSetTree(WS, 0, split('h', 0.5, leaf(a), leaf(b)));
  return { ...ctx, a, b };
}

test('moveFocus: Spiral finds the neighbour of an oversized tile both ways (slots); dwindle compares frames', () => {
  for (const [layout, reach] of [['spiral', true], ['dwindle', false]]) {
    const { self, a, b, activated } = oversized(layout);
    global.display.focus_window = a;
    self.actions.moveFocus('right');
    assert.equal(activated(), reach ? b : null, `${layout}: right from a`);
    global.display.focus_window = b;
    self.actions.moveFocus('left');
    assert.equal(activated(), reach ? a : null, `${layout}: left from b`);
  }
});

test('swapWindow: Spiral swaps past an oversized tile; dwindle leaves the tree', () => {
  for (const [layout, swapped] of [['spiral', true], ['dwindle', false]]) {
    const { self, a, b } = oversized(layout);
    global.display.focus_window = a;
    self.actions.swapWindow('right');
    const t = self.bsp.bspGetTree(WS, 0);
    assert.deepEqual([t.first.window, t.second.window], swapped ? [b, a] : [a, b], layout);
  }
});

// A float keeps its frame, even while a stale leaf of it is in the tree:
// from its leaf (top right) down reaches b, from its frame nothing does.
test('moveFocus: a float compares its frame, not a leaf it still holds', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 500, y: 252, width: 500, height: 248 });
  const f = win('f', { x: 100, y: 100, width: 100, height: 100 });
  const { self, floats, activated } = groupSelf('spiral', [a, b, f]);
  floats.add(f);
  self.bsp.bspSetTree(WS, 0, split('h', 0.5, leaf(a), split('v', 0.5, leaf(f), leaf(b))));
  global.display.focus_window = f;
  self.actions.moveFocus('down');
  assert.equal(activated(), null);
  self.actions.moveFocus('right');
  assert.equal(activated(), null);
  f.get_frame_rect = () => ({ x: 520, y: 100, width: 100, height: 100 });
  self.actions.moveFocus('left');
  assert.equal(activated(), a);
});

test('spiralSlots: each tile\'s leaf, a lone tile the tiling area, nothing for dwindle', () => {
  const a = win('a', { x: 0, y: 0, width: 500, height: 500 });
  const b = win('b', { x: 200, y: 0, width: 800, height: 500 });
  const { self } = groupSelf('spiral', [a, b]);
  self.bsp.bspSetTree(WS, 0, split('h', 0.5, leaf(a), leaf(b)));
  assert.deepEqual([...self.bsp.spiralSlots(WS, 0)], [[a, { x: 0, y: 0, w: 500, h: 500 }], [b, { x: 500, y: 0, w: 500, h: 500 }]]);
  self.monitors.getWindowsForGroup = () => [b];
  assert.deepEqual([...self.bsp.spiralSlots(WS, 0)], [[b, { x: 0, y: 0, w: 1000, h: 500 }]]);
  self.windows.getWorkspaceLayout = () => 'dwindle';
  assert.equal(self.bsp.spiralSlots(WS, 0).size, 0);
});

// Split orientation (Hyprland preserve_split=false): each unpinned split of a
// Spiral tree takes its direction from its box at every layout.

function retiled(layout, tree, wins, settings = {}, setup = () => {}) {
  const ctx = groupSelf(layout, wins, settings);
  const moves = new Map();
  ctx.self.grab.safeMove = (w, x, y, ww, h) => moves.set(w, [x, y, ww, h]);
  ctx.self.bsp.bspSetTree(WS, 0, tree);
  ctx.self._bspLaidOutAs.set(ctx.self.monitors.groupObj(WS, 0), layout);
  setup(ctx.self);
  ctx.self.layouts.retileDwindle(WS, wins, 0);
  return { ...ctx, moves, tree: ctx.self.bsp.bspGetTree(WS, 0) };
}

// A|(B/C) with A closed: the promoted B/C split was stacked for its old box.
test('retileDwindle: a Spiral split promoted by a close re-orients to its box; dwindle keeps it', () => {
  for (const [layout, dir] of [['spiral', 'h'], ['dwindle', 'v']]) {
    const b = win('b', null), c = win('c', null);
    const { tree, moves } = retiled(layout, split('v', 0.5, leaf(b), leaf(c)), [b, c]);
    assert.equal(tree.direction, dir, layout);
    if (layout === 'spiral') assert.deepEqual([moves.get(b), moves.get(c)], [[0, 0, 500, 500], [500, 0, 500, 500]]);
  }
});

test('orientTree: a box taller than wide stacks, a wider or square one splits side by side, each from its own box', () => {
  const { self } = groupSelf('spiral', []);
  const t = split('v', 0.5, leaf(1), split('v', 0.5, leaf(2), split('h', 0.5, leaf(3), leaf(4))));
  self.bsp.orientTree(t, { x: 0, y: 0, w: 1000, h: 500 }, 0);
  // 1000x500 -> h; the right 500x500 -> h; its right 250x500 -> v.
  assert.deepEqual([t.direction, t.second.direction, t.second.second.direction], ['h', 'h', 'v']);
  const tall = split('h', 0.5, leaf(1), leaf(2));
  self.bsp.orientTree(tall, { x: 0, y: 0, w: 500, h: 501 }, 0);
  assert.equal(tall.direction, 'v');
});

test('retileDwindle: a pinned Spiral split keeps its direction, the others still re-orient', () => {
  const b = win('b', null), c = win('c', null), d = win('d', null);
  const pinned = split('v', 0.5, leaf(b), split('v', 0.5, leaf(c), leaf(d)));
  pinned.pinned = true;
  const { tree } = retiled('spiral', pinned, [b, c, d]);
  // Root pinned v: 1000x500 stays stacked; its second 1000x250 re-orients to h.
  assert.deepEqual([tree.direction, tree.pinned, tree.second.direction], ['v', true, 'h']);
});

test('retileDwindle: no Spiral re-orientation during a grab', () => {
  const b = win('b', null), c = win('c', null);
  const { tree } = retiled('spiral', split('v', 0.5, leaf(b), leaf(c)), [b, c], {}, self => { self._grabOp = 4097; });
  assert.equal(tree.direction, 'v');
});

test('retileDwindle: spiral-preserve-split keeps every Spiral direction', () => {
  const b = win('b', null), c = win('c', null);
  const { tree } = retiled('spiral', split('v', 0.5, leaf(b), leaf(c)), [b, c], { 'spiral-preserve-split': true });
  assert.equal(tree.direction, 'v');
});

test('bspSlotRects: a Spiral drag ghost is oriented as its layout will be; dwindle and a preserved split are not', () => {
  for (const [layout, settings, wide] of [['spiral', {}, true], ['dwindle', {}, false], ['spiral', { 'spiral-preserve-split': true }, false]]) {
    const b = win('b', null), c = win('c', null);
    const { self } = groupSelf(layout, [b, c], settings);
    // A move grab is when a ghost is laid out.
    self._grabOp = 1;
    const r = self.bsp.bspSlotRects(split('v', 0.5, leaf(b), leaf(c)), WA, WS, 0);
    assert.deepEqual(r.get(c), wide ? { x: 500, y: 0, w: 500, h: 500 } : { x: 0, y: 250, w: 1000, h: 250 }, `${layout} ${JSON.stringify(settings)}`);
  }
});

// A triangle drop picks its side: a side against the box rule is pinned, so
// the next layout keeps it (on a wide box a top drop stays stacked); a side
// the rule gives anyway is not. Untagged, the drop pins.
test('dropTree: a Spiral drop against the box rule pins its split; the next layout keeps the side', () => {
  const a = win('a', null), b = win('b', null);
  const { self } = groupSelf('spiral', [a, b]);
  const tagged = () => { const l = leaf(a); self.bsp.bspTagGeometry(l, 0, 0, 1000, 500, 0); return l; };
  assert.equal(self.spiral.dropTree(tagged(), a, b, 'left').pinned, undefined);
  assert.equal(self.spiral.dropTree(tagged(), a, b, 'right').pinned, undefined);
  assert.equal(self.spiral.dropTree(leaf(a), a, b, 'left').pinned, true, 'untagged');
  const t = self.spiral.dropTree(tagged(), a, b, 'top');
  assert.deepEqual([t.direction, t.pinned, t.first.window], ['v', true, b]);
  self.bsp.bspSetTree(WS, 0, t);
  self._bspLaidOutAs.set(self.monitors.groupObj(WS, 0), 'spiral');
  self.layouts.retileDwindle(WS, [a, b], 0);
  assert.equal(self.bsp.bspGetTree(WS, 0).direction, 'v');
});

test('retileDwindle: a layout switch clears the pins (dwindle never holds one)', () => {
  const b = win('b', null), c = win('c', null);
  const t = split('v', 0.5, leaf(b), leaf(c));
  t.pinned = true;
  const { tree } = retiled('dwindle', t, [b, c], {}, self => self._bspLaidOutAs.set(self.monitors.groupObj(WS, 0), 'spiral'));
  assert.equal(tree.pinned, undefined);
});

// Pins persist in a new key; the shape keys keep the encoding older builds read.

test('shape: a pinned split encodes as H/V and parses back pinned', () => {
  const { self } = groupSelf('spiral', []);
  const t = split('h', 0.5, leaf(1), split('v', 0.25, leaf(2), leaf(3)));
  t.second.pinned = true;
  const s = self.bsp.dwindleShapeToString(t);
  assert.equal(s, 'h0.5000(l,V0.2500(l,l))');
  const back = self.bsp.dwindleShapeFromString(s);
  assert.deepEqual([back.pinned, back.second.direction, back.second.pinned], [undefined, 'v', true]);
});

test('reconcileTreeRatios: a pinned saved split brings back its direction and pin where the structure matches', () => {
  const { self } = groupSelf('spiral', []);
  const saved = self.bsp.dwindleShapeFromString('h0.6000(l,V0.3000(l,l))');
  const live = split('h', 0.5, leaf(1), split('h', 0.5, leaf(2), leaf(3)));
  assert.equal(self.bsp.reconcileTreeRatios(saved, live, true), true);
  assert.deepEqual([live.ratio, live.second.direction, live.second.pinned, live.second.ratio], [0.6, 'v', true, 0.3]);
  // Another structure under it: no pin.
  const other = split('h', 0.5, leaf(1), split('h', 0.5, leaf(2), split('h', 0.5, leaf(3), leaf(4))));
  self.bsp.reconcileTreeRatios(saved, other, true);
  assert.deepEqual([other.second.direction, other.second.pinned], ['h', undefined]);
  // A group that keeps its directions (dwindle, a preserved split): no pin, the mismatch stops.
  const kept = split('h', 0.5, leaf(1), split('h', 0.5, leaf(2), leaf(3)));
  self.bsp.reconcileTreeRatios(saved, kept);
  assert.deepEqual([kept.ratio, kept.second.direction, kept.second.pinned, kept.second.ratio], [0.6, 'h', undefined, 0.5]);
});

// The grammar older builds parse: l, e, h/v + ratio (anything else rejects).
function olderParse(str) {
  let i = 0;
  const node = () => {
    const c = str[i];
    if (c === 'l' || c === 'e') { i++; return { type: c }; }
    if (c !== 'h' && c !== 'v') return null;
    i++;
    const s = i;
    while (i < str.length && /[0-9.]/.test(str[i])) i++;
    const r = parseFloat(str.substring(s, i));
    if (!(r > 0 && r < 1) || str[i++] !== '(') return null;
    const a = node();
    if (!a || str[i++] !== ',') return null;
    const b = node();
    if (!b || str[i++] !== ')') return null;
    return { type: 'split', direction: c, ratio: r, first: a, second: b };
  };
  const n = node();
  return n && i === str.length ? n : null;
}

function persistSelf(values = {}) {
  const self = makeSelf();
  const v = { 'inside-gap': 0, layout: 'spiral', ...values };
  self._settings = {
    v,
    get_int: k => v[k] ?? 0, get_double: k => v[k] ?? 0.5, get_boolean: k => v[k] ?? false,
    get_string: k => v[k] ?? '', get_strv: k => v[k] ?? [],
    set_strv: (k, x) => { v[k] = [...x]; }, set_string: (k, x) => { v[k] = x; },
  };
  return self;
}

test('persistence: pins go to spiral-split-pins; the shape keys keep the encoding an older build reads', () => {
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
  const t = split('h', 0.5, leaf(fakeWin()), split('v', 0.25, leaf(fakeWin()), leaf(fakeWin())));
  t.second.pinned = true;
  self._bspTrees.set(ws, t);
  // An unplugged monitor's pinned Spiral shape, kept in the raw map.
  // Another layout's entry is carried verbatim, case included.
  self._persistedDwindleRaw = new Map([['3@HDMI-9:spiral', 'V0.4000(l,l)'], ['2:foo', 'Q7(X)']]);
  self.persistence.savePersistedLayouts();
  global.workspace_manager = prev;
  const v = self._settings.v;
  assert.deepEqual(v['workspace-dwindle-trees'], ['1:spiral:h0.5000(l,v0.2500(l,l))', '2:foo:Q7(X)']);
  assert.deepEqual(v['monitor-workspace-dwindle-trees'], ['HDMI-9:3:spiral:v0.4000(l,l)']);
  assert.deepEqual(v['spiral-split-pins'], ['1:spiral:h(l,V(l,l))', 'HDMI-9:3:spiral:V(l,l)']);
  for (const e of [...v['workspace-dwindle-trees'].filter(e => !e.includes(':foo:')), ...v['monitor-workspace-dwindle-trees']]) {
    const shape = e.split(':').pop();
    assert.ok(olderParse(shape), `an older build rejects ${e}`);
  }
  // Raw keeps the pins after the write (the next save writes them again).
  assert.equal(self._persistedDwindleRaw.get('1:spiral'), 'h0.5000(l,V0.2500(l,l))');
  assert.equal(self._persistedDwindleRaw.get('3@HDMI-9:spiral'), 'V0.4000(l,l)');
});

test('persistence: pins load onto a saved shape of their structure; an older build\'s rewrite keeps or drops them', () => {
  const load = values => {
    const self = persistSelf(values);
    self.monitors.keyedPrimaryConn = () => 'DP-1';
    self.persistence.loadPersistedLayoutRules();
    return self;
  };
  const pins = ['1:spiral:h(l,V(l,l))', 'HDMI-9:3:spiral:V(l,l)', '2:h(l,V(l,l))', 'junk', '4:spiral:Q(l)'];
  // Same structure, new ratios (an older build resized it): pins kept, its ratios.
  let s = load({ 'workspace-dwindle-trees': ['1:spiral:h0.7000(l,v0.2000(l,l))', '2:h0.5000(l,v0.5000(l,l))'],
    'monitor-workspace-dwindle-trees': ['HDMI-9:3:spiral:v0.4000(l,l)'], 'spiral-split-pins': pins });
  let n = s._persistedDwindleByIndex.get('1:spiral');
  assert.deepEqual([n.ratio, n.pinned, n.second.ratio, n.second.direction, n.second.pinned], [0.7, undefined, 0.2, 'v', true]);
  assert.equal(s._persistedDwindleByIndex.get('3@HDMI-9:spiral').pinned, true);
  // Dwindle's shape never takes a pin.
  assert.equal(s._persistedDwindleByIndex.get(2).second.pinned, undefined);
  // Another structure (an older build closed or opened a window): dropped.
  s = load({ 'workspace-dwindle-trees': ['1:spiral:h0.5000(l,h0.5000(l,l))'], 'spiral-split-pins': pins });
  n = s._persistedDwindleByIndex.get('1:spiral');
  assert.deepEqual([n.second.direction, n.second.pinned], ['h', undefined]);
  assert.equal(s._persistedDwindleRaw.get('1:spiral'), 'h0.5000(l,h0.5000(l,l))');
  // No pins key (an older build's settings): shapes as before.
  s = load({ 'workspace-dwindle-trees': ['1:spiral:h0.5000(l,v0.5000(l,l))'] });
  assert.equal(s._persistedDwindleByIndex.get('1:spiral').second.pinned, undefined);
});

// The pre-map slot of a new Spiral window is tagged on the oriented tree, and
// a window opened during a grab does not re-orient the group.
test('bspInsertForWorkspace: a Spiral insert orients the tree it tags, never during a grab', () => {
  for (const [grab, dir] of [[null, 'h'], [1, 'v']]) {
    const b = win('b', null), c = win('c', null), n = win('n', null);
    const { self } = groupSelf('spiral', [b, c, n]);
    self.bsp.spiralInsertNew = (ws, tree, w) => split('h', 0.5, tree, leaf(w));
    self.bsp.bspSetTree(WS, 0, split('v', 0.5, leaf(b), leaf(c)));
    self._grabOp = grab;
    self.bsp.bspInsertForWorkspace(WS, n, 0);
    assert.equal(self.bsp.bspGetTree(WS, 0).first.direction, dir, `grab ${grab}`);
  }
});

// A restored ratio changes the boxes: the pass runs on them. On 1000x600,
// b/c's 500x600 box stacks; the saved 0.2 root makes it 800x600.
test('retileDwindle: Spiral orients on the ratios a saved shape restores', () => {
  const a = win('a', null), b = win('b', null), c = win('c', null);
  const { tree } = retiled('spiral', split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c))), [a, b, c], {}, self => {
    self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 600 });
    self._persistedDwindleByIndex = new Map([[self.persistence.shapeKey(self.monitors.groupKey(WS, 0), 'spiral'),
      self.bsp.dwindleShapeFromString('h0.2000(l,v0.5000(l,l))')]]);
  });
  assert.deepEqual([tree.ratio, tree.second.direction], [0.2, 'h']);
});

// Spiral's directions follow the boxes, so a saved shape's ratios come back
// past a direction it was saved with on another box (b/c: 700x600 saved h,
// 500x600 live v). Dwindle and a preserved split still stop there.
test('retileDwindle: Spiral restores saved ratios past a direction mismatch; dwindle and preserve-split stop there', () => {
  for (const [layout, settings, want] of [['spiral', {}, [0.3, 'h', 0.7]], ['dwindle', {}, [0.3, 'v', 0.5]],
    ['spiral', { 'spiral-preserve-split': true }, [0.3, 'v', 0.5]]]) {
    const a = win('a', null), b = win('b', null), c = win('c', null);
    const { tree } = retiled(layout, split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c))), [a, b, c], settings, self => {
      self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 600 });
      self._persistedDwindleByIndex = new Map([[self.persistence.shapeKey(self.monitors.groupKey(WS, 0), layout),
        self.bsp.dwindleShapeFromString('h0.3000(l,h0.7000(l,l))')]]);
    });
    assert.deepEqual([tree.ratio, tree.second.direction, tree.second.ratio], want, `${layout} ${JSON.stringify(settings)}`);
  }
});

