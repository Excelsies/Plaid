import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';
import { LAYOUT_NAMES, isBspLayout } from '../../extensions/modules/helpers.js';

// Spiral: layout identity and insertion.

function stubGlobal({ pointer = [0, 0], focus = null } = {}) {
  globalThis.global = {
    ...globalThis.global,
    get_pointer: () => [...pointer, 0],
    display: {
      ...globalThis.global.display,
      focus_window: focus,
      get_primary_monitor: () => 0,
      get_monitor_geometry: () => ({ x: 0, y: 0, width: 1000, height: 500 }),
    },
    workspace_manager: { get_n_workspaces: () => 2, get_workspace_by_index: (i) => (i === 1 ? WS : {}) },
  };
}

const WS = {};
const AREA = { x: 0, y: 0, w: 1000, h: 500 };
const W = (id) => ({ ...fakeWin({ id, instance: id }), get_workspace: () => WS, get_id: () => id });

function spiralSelf(layout = 'spiral', settings = {}) {
  const self = makeSelf({ 'dwindle-ratio': 0.6, ...settings });
  self.windows.getWorkspaceLayout = () => layout;
  self.windows.isFloating = () => false;
  return self;
}

test('isBspLayout and LAYOUT_NAMES: dwindle and spiral are the BSP layouts', () => {
  assert.deepEqual(Object.keys(LAYOUT_NAMES), ['dwindle', 'spiral', 'master-stack', 'centered-master-stack', 'floating']);
  assert.deepEqual(Object.keys(LAYOUT_NAMES).filter(isBspLayout), ['dwindle', 'spiral']);
});

test('bspSplitRatio: Spiral halves, dwindle uses dwindle-ratio', () => {
  assert.equal(spiralSelf('spiral').bsp.bspSplitRatio(WS, 0), 0.5);
  assert.equal(spiralSelf('dwindle').bsp.bspSplitRatio(WS, 0), 0.6);
});

test('spiralInsertNew: splits the focused window, new window on the pointer\'s half', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self.bsp.bspTagGeometry(tree, AREA.x, AREA.y, AREA.w, AREA.h, 0);
  // b is 500x500: a side-by-side split; the pointer is in its left half.
  stubGlobal({ pointer: [600, 250], focus: b });
  const after = self.bsp.spiralInsertNew(WS, tree, c, AREA, 0);
  assert.equal(after.second.direction, 'h');
  assert.equal(after.second.ratio, 0.5);
  assert.deepEqual([after.second.first.window, after.second.second.window], [c, b]);
});

test('spiralInsertNew: the focused window wins over the leaf under the pointer', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self.bsp.bspTagGeometry(tree, AREA.x, AREA.y, AREA.w, AREA.h, 0);
  stubGlobal({ pointer: [900, 250], focus: a });
  const after = self.bsp.spiralInsertNew(WS, tree, c, AREA, 0);
  assert.deepEqual(self.bsp.bspCollectWindows(after.first), [a, c]);
  assert.equal(after.second.window, b);
});

test('spiralInsertNew: the pointer on the slot centre keeps the classic spiral (new window second)', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b');
  const tree = leaf(a);
  self.bsp.bspTagGeometry(tree, AREA.x, AREA.y, AREA.w, AREA.h, 0);
  stubGlobal({ pointer: [500, 250], focus: a });
  const after = self.bsp.spiralInsertNew(WS, tree, b, AREA, 0);
  assert.deepEqual([after.first.window, after.second.window], [a, b]);
});

test('spiralInsertNew: without focus, the leaf under the pointer, else the closest', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b'), c = W('c');
  let tree = split('h', 0.5, leaf(a), leaf(b));
  self.bsp.bspTagGeometry(tree, AREA.x, AREA.y, AREA.w, AREA.h, 0);
  stubGlobal({ pointer: [-50, 900] }); // off the tiling area, nearest a
  let after = self.bsp.spiralInsertNew(WS, tree, c, AREA, 0);
  assert.equal(after.first.type, 'split');
  assert.deepEqual(self.bsp.bspCollectWindows(after.first), [c, a]); // pointer left of a's centre
  tree = split('h', 0.5, leaf(a), leaf(b));
  self.bsp.bspTagGeometry(tree, AREA.x, AREA.y, AREA.w, AREA.h, 0);
  stubGlobal({ pointer: [900, 400] });
  after = self.bsp.spiralInsertNew(WS, tree, c, AREA, 0);
  assert.deepEqual(self.bsp.bspCollectWindows(after.second), [b, c]);
});

test('bspInsertAtLeaf: direction and order from the side, the given ratio', () => {
  const self = spiralSelf();
  const a = W('a'), b = W('b'), z = W('z');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const after = self.bsp.bspInsertAtLeaf(tree, tree.first, z, 'v', true, 0.5);
  assert.equal(after.first.direction, 'v');
  assert.deepEqual([after.first.first.window, after.first.second.window], [z, a]);
});

test('syncTree: Spiral inserts a missing window by the Spiral rule, dwindle appends it', () => {
  const a = W('a'), b = W('b'), c = W('c');
  stubGlobal({ pointer: [100, 100], focus: a });
  const self = spiralSelf();
  self.windows.isFullscreenTile = () => false;
  let tree = self.bsp.syncTree(WS, split('h', 0.5, leaf(a), leaf(b)), [a, b, c], AREA, 0, 0);
  assert.deepEqual(self.bsp.bspCollectWindows(tree.first), [c, a], 'next to the focus, the pointer\'s half');
  const dw = spiralSelf('dwindle');
  dw.windows.isFullscreenTile = () => false;
  tree = dw.bsp.syncTree(WS, split('h', 0.5, leaf(a), leaf(b)), [a, b, c], AREA, 0, 0);
  assert.deepEqual(dw.bsp.bspCollectWindows(tree.second), [b, c]);
  assert.equal(tree.second.ratio, 0.6);
  // A window that left goes; a fullscreen tile keeps its leaf.
  dw.windows.isFullscreenTile = (w) => w === b;
  tree = dw.bsp.syncTree(WS, split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c))), [a], AREA, 0, 0);
  assert.deepEqual(dw.bsp.bspCollectWindows(tree), [a, b]);
  // No tree: built from the window list with the layout's ratio.
  tree = self.bsp.syncTree(WS, null, [a, b], AREA, 0, 0);
  assert.equal(tree.ratio, 0.5);
});

test('retileDwindle: a dwindle/Spiral switch resets every split to the new ratio', () => {
  const a = W('a'), b = W('b'), c = W('c');
  stubGlobal();
  const self = spiralSelf('dwindle');
  self.windows.isFullscreenTile = () => false;
  self.geometry.wsIndex = () => 1;
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.grab.safeMove = () => {};
  self.windows.moveWindow = () => {};
  const tree = split('h', 0.7, leaf(a), split('v', 0.3, leaf(b), leaf(c)));
  self.bsp.bspSetTree(WS, 0, tree);
  self.layouts.retileDwindle(WS, [a, b, c], 0);
  assert.equal(tree.ratio, 0.7, 'same layout: kept');
  assert.equal(self._bspLaidOutAs.get(WS), 'dwindle');
  self.windows.getWorkspaceLayout = () => 'spiral';
  self.layouts.retileDwindle(WS, [a, b, c], 0);
  const t = self.bsp.bspGetTree(WS, 0);
  assert.deepEqual([t.ratio, t.second.ratio], [0.5, 0.5]);
  assert.equal(self._bspLaidOutAs.get(WS), 'spiral');
});

test('retileDwindle: the switch is seen after a close made a subtree the root', () => {
  const a = W('a'), b = W('b'), c = W('c');
  stubGlobal();
  const self = spiralSelf('dwindle');
  self.windows.isFullscreenTile = () => false;
  self.geometry.wsIndex = () => 1;
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.grab.safeMove = () => {};
  self.bsp.bspSetTree(WS, 0, split('h', 0.7, leaf(a), split('v', 0.3, leaf(b), leaf(c))));
  self.layouts.retileDwindle(WS, [a, b, c], 0);
  // a closes: v(b, c) is the root now, a node the layout never marked.
  self.windows.getWorkspaceLayout = () => 'spiral';
  self.layouts.retileDwindle(WS, [b, c], 0);
  assert.equal(self.bsp.bspGetTree(WS, 0).ratio, 0.5);
});

test('bspInsertForWorkspace: a Spiral group inserts by the Spiral rule and tags the new leaf', () => {
  const a = W('a'), b = W('b');
  stubGlobal({ pointer: [100, 100], focus: a });
  const self = spiralSelf();
  self.monitors.monitorWorkArea = () => ({ x: 0, y: 0, width: 1000, height: 500 });
  self.bsp.bspSetTree(WS, 0, leaf(a));
  self.bsp.bspInsertForWorkspace(WS, b, 0);
  const t = self.bsp.bspGetTree(WS, 0);
  assert.deepEqual([t.first.window, t.second.window], [b, a]);
  assert.equal(t.ratio, 0.5);
  assert.deepEqual([t.first._x, t.first._w], [0, 500]);
});

// Every layout list in the shell and prefs names the layouts LAYOUT_NAMES
// names, in its order; a layout test asks isBspLayout, not a name.
test('static: layout lists match LAYOUT_NAMES; no bare dwindle layout test', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = join(here, '..', '..', 'extensions');
  const names = Object.keys(LAYOUT_NAMES);
  const lists = [];
  for (const f of ['prefs.js', ...readdirSync(join(ext, 'modules')).map(n => `modules/${n}`)]) {
    const src = readFileSync(join(ext, f), 'utf8');
    for (const m of src.matchAll(/\[('dwindle'[^\]]*)\]/g))
      lists.push([f, [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])]);
  }
  assert.ok(lists.length >= 2, `found ${lists.length} lists`);
  for (const [f, l] of lists) assert.deepEqual(l, names, f);
  const prefs = readFileSync(join(ext, 'prefs.js'), 'utf8');
  for (const n of names) assert.ok(prefs.includes(`'${n}': _(`), `prefs caption for ${n}`);
  // Calibration: the layout tests of 77ab043, copied verbatim, and the other
  // spellings of one.
  const cal = [
    "        if (layout === 'dwindle') {",
    "        if (this.core.monitors.groupPlaces(ws, mon) && this.core.windows.getWorkspaceLayout(ws, mon) === 'dwindle') {",
    "            if (!tree || tree.type !== 'split' || this.core.windows.layoutForKey(key) !== 'dwindle') continue;",
    'if (layout == "dwindle")', 'if (`dwindle` !== layout)', "case 'dwindle':", "if (['x'].includes('dwindle'))",
  ];
  assert.deepEqual(cal.map(l => bareDwindle(l).length), [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(bareDwindle("const layouts = ['dwindle', 'spiral'];"), [], 'a list is not a test');
  const bare = [];
  let scanned = 0;
  for (const f of ['prefs.js', ...readdirSync(join(ext, 'modules')).map(n => `modules/${n}`)]) {
    if (f === 'modules/helpers.js') continue;
    scanned++;
    for (const [line, m] of bareDwindle(readFileSync(join(ext, f), 'utf8'))) {
      // Dwindle only by name: its own ratio row, and its own preview.
      if (f === 'prefs.js' && /dwindleRatioRow\.set_visible\(layout === 'dwindle'\)|\} else if \(layout === 'dwindle'\) \{/.test(line))
        continue;
      bare.push(`${f}: ${m}`);
    }
  }
  assert.ok(scanned > 25, `scanned ${scanned} files`);
  assert.deepEqual(bare, []);
});

// [line, match] of every comparison of a layout with 'dwindle', in any
// quoting, as a switch case or an includes() argument; comments ignored.
function bareDwindle(src) {
  const re = /[!=]==?\s*(['"`])dwindle\1|(['"`])dwindle\2\s*[!=]==?|\bcase\s+(['"`])dwindle\3\s*:|\.includes\(\s*(['"`])dwindle\4\s*\)/g;
  const out = [];
  for (const line of src.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    for (const m of code.matchAll(re)) out.push([code, m[0]]);
  }
  return out;
}
