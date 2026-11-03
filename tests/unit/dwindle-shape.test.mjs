import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, empty, split } from '../helpers.mjs';

const shapeToString = (self, node) => self._dwindleShapeToString(node);
const shapeFromString = (self, str) => self._dwindleShapeFromString(str);

test('shape: leaf/empty encode to l/e', () => {
  const self = makeSelf();
  assert.equal(shapeToString(self, leaf(fakeWin())), 'l');
  assert.equal(shapeToString(self, empty()), 'e');
  assert.equal(shapeToString(self, null), 'e');
});

test('shape: split encodes direction + 4dp ratio + children', () => {
  const self = makeSelf();
  const tree = split('h', 0.848, leaf(null), leaf(null));
  assert.equal(shapeToString(self, tree), 'h0.8480(l,l)');
});

test('shape: round-trips structure and ratios', () => {
  const self = makeSelf();
  const tree = split('v', 0.3333, leaf(null), split('h', 0.75, leaf(null), leaf(null)));
  const str = shapeToString(self, tree);
  const back = shapeFromString(self, str);
  assert.equal(back.type, 'split');
  assert.equal(back.direction, 'v');
  assert.equal(back.ratio, 0.3333);
  assert.equal(back.second.type, 'split');
  assert.equal(back.second.direction, 'h');
  assert.equal(back.second.ratio, 0.75);
});

test('shape: ratios are clamped away from 1.0000/0.0000 (parser rejects those)', () => {
  const self = makeSelf();
  assert.equal(shapeToString(self, split('h', 0.99999, leaf(null), leaf(null))), 'h0.9999(l,l)');
  assert.equal(shapeToString(self, split('h', 0.00001, leaf(null), leaf(null))), 'h0.0001(l,l)');
  // and the clamped form parses
  assert.notEqual(shapeFromString(self, 'h0.9999(l,l)'), null);
});

test('shape: parser rejects malformed / out-of-range input', () => {
  const self = makeSelf();
  for (const bad of ['', 'z', 'h0.5(l)', 'h0.5(l,l)x', 'h1.0000(l,l)', 'h0.0000(l,l)', 'h0.5(l,l,l)']) {
    assert.equal(shapeFromString(self, bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('_parsePersistedDwindleShapes: keeps valid entries, drops bad/zero/negative indices', () => {
  const self = makeSelf({
    'workspace-dwindle-trees': ['3:h0.8480(l,l)', '0:l', '-1:l', 'bad', '5:h1.0000(l,l)', '2:v0.5(l,e)'],
  });
  const map = self._parsePersistedDwindleShapes();
  assert.deepEqual([...map.keys()].sort((a, b) => a - b), [2, 3]);
  assert.equal(map.get(3).direction, 'h');
  assert.equal(map.get(3).ratio, 0.848);
  assert.equal(self._persistedDwindleRaw.get(3), 'h0.8480(l,l)');
  assert.equal(self._persistedDwindleRaw.has(5), false);
});

test('_reconcileTreeRatios: copies matching-direction ratios into the live tree', () => {
  const self = makeSelf();
  const saved = split('h', 0.8, leaf(null), leaf(null));
  const live = split('h', 0.5, leaf(null), leaf(null));
  assert.equal(self._reconcileTreeRatios(saved, live), true);
  assert.equal(live.ratio, 0.8);
});

test('_reconcileTreeRatios: idempotent (second pass reports no change)', () => {
  const self = makeSelf();
  const saved = split('h', 0.8, leaf(null), leaf(null));
  const live = split('h', 0.8, leaf(null), leaf(null));
  assert.equal(self._reconcileTreeRatios(saved, live), false);
});

test('_reconcileTreeRatios: direction mismatch stops descent', () => {
  const self = makeSelf();
  const saved = split('h', 0.8, leaf(null), leaf(null));
  const live = split('v', 0.5, leaf(null), leaf(null));
  assert.equal(self._reconcileTreeRatios(saved, live), false);
  assert.equal(live.ratio, 0.5);
});

test('_reconcileTreeRatios: ignores ratios outside the sane 0.02..0.98 band', () => {
  const self = makeSelf();
  const saved = split('h', 0.99, leaf(null), leaf(null));
  const live = split('h', 0.5, leaf(null), leaf(null));
  assert.equal(self._reconcileTreeRatios(saved, live), false);
  assert.equal(live.ratio, 0.5);
});

test('_reconcileTreeRatios: ignores a shape saved from a DIFFERENT window count (regression)', () => {
  const self = makeSelf();
  // A 2-window 85/15 shape must not be applied to a 7-window tree (it starved
  // everything past the first split → sub-minimum slots → floated windows).
  const saved = split('h', 0.85, leaf(null), leaf(null));
  const live = split('h', 0.5, leaf(null),
    split('v', 0.5, leaf(null), split('h', 0.5, leaf(null),
      split('v', 0.5, leaf(null), split('h', 0.5, leaf(null), leaf(null))))));
  assert.equal(self._reconcileTreeRatios(saved, live), false);
  assert.equal(live.ratio, 0.5);
});

test('_reconcileTreeRatios: copies ratios when the window counts match', () => {
  const self = makeSelf();
  const saved = split('h', 0.8, leaf(null), split('v', 0.4, leaf(null), leaf(null)));
  const live = split('h', 0.5, leaf(null), split('v', 0.5, leaf(null), leaf(null)));
  assert.equal(self._reconcileTreeRatios(saved, live), true);
  assert.equal(live.ratio, 0.8);
  assert.equal(live.second.ratio, 0.4);
});

test('_reconcileTreeRatios: ignores a mirrored shape with the same leaf count (regression)', () => {
  const self = makeSelf();
  // Root counts match (1 + 2) but the big subtree is on the other side —
  // copying 0.85 would cram the live 2-leaf subtree into 15%.
  const saved = split('h', 0.85, split('v', 0.5, leaf(null), leaf(null)), leaf(null));
  const live = split('h', 0.5, leaf(null), split('v', 0.5, leaf(null), leaf(null)));
  assert.equal(self._reconcileTreeRatios(saved, live), false);
  assert.equal(live.ratio, 0.5);
});

// Dwindle retiles against a fake 2000x1000 work area on workspace index 1.
function withDwindleWorkspace(fn, width = 2000) {
  const ws = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width, height: 1000 }) };
  const workspaces = [{}, ws];
  const old = globalThis.global;
  globalThis.global = {
    display: { get_primary_monitor: () => 0 },
    workspace_manager: {
      get_n_workspaces: () => workspaces.length,
      get_workspace_by_index: (i) => workspaces[i] ?? null,
      get_active_workspace: () => ws,
    },
    get_pointer: () => [0, 0],
  };
  try {
    return fn(ws);
  } finally {
    globalThis.global = old;
  }
}

let nextId = 1;
const tile = () => {
  const w = fakeWin();
  const id = nextId++;
  w.get_id = () => id;
  w.get_workspace = () => null; // never configured by the layout
  return w;
};

const RESIZE_E = 1 | (2 << 12);
const MOVE = 1;

function grabEnd(self, ws, grabOp) {
  self._grabOp = grabOp;
  self._handleGrabEnd({
    get_workspace: () => ws,
    get_wm_class_instance: () => 'gjs',
    get_frame_rect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    raise() {},
  }, grabOp);
}

function grabSelf(settings = {}) {
  return makeSelf(settings, {
    _isFloating: () => false,
    _kickMaskNow() {},
    _getWindowsForWorkspace: () => [],
    _getWorkspaceLayout: () => 'dwindle',
    _retileWorkspace() {},
  });
}

test('_handleGrabEnd: a resize survives a window opened before the debounced save (regression)', () => {
  withDwindleWorkspace((ws) => {
    const [a, b, c, d] = [tile(), tile(), tile(), tile()];
    const self = grabSelf({ 'dwindle-ratio': 0.5 });
    const tree = split('h', 0.5, split('v', 0.5, leaf(a), leaf(b)), leaf(c));
    self._bspTrees.set(ws, tree);
    self._dwindleLeafSigs.set(ws, [a, b, c].map(w => w.get_id()).join(','));
    self._persistedDwindleByIndex = new Map([[1, self._dwindleShapeFromString('h0.5000(v0.5000(l,l),l)')]]);

    // The A|B divider, dragged from 0.5 to 0.7.
    self._grabResizeNodeH = tree.first;
    self._grabInitialRatioH = 0.5;
    tree.first.ratio = 0.7;
    grabEnd(self, ws, RESIZE_E);
    self._retileDwindle(ws, [a, b, c, d]); // D splits C: a window-set change

    assert.equal(tree.first.ratio, 0.7);
  });
});

test('resizeDwindle: a keyboard resize reaches the saved shape', () => {
  withDwindleWorkspace((ws) => {
    const [a, b] = [tile(), tile()];
    const self = makeSelf();
    const tree = split('h', 0.5, leaf(a), leaf(b));
    tree._w = 1000;
    self._bspTrees.set(ws, tree);
    self._persistedDwindleByIndex = new Map([[1, self._dwindleShapeFromString('h0.5000(l,l)')]]);
    self.actions.resizeDwindle(a, ws, 'width', 100);
    assert.equal(self._dwindleShapeToString(self._persistedDwindleByIndex.get(1)), 'h0.6000(l,l)');
  });
});

test('retileDwindle: a same-set retile keeps the bigger saved shape for a login restore (regression)', () => {
  withDwindleWorkspace((ws) => {
    const [a, b, c] = [tile(), tile(), tile()];
    const self = makeSelf({ 'dwindle-ratio': 0.5 });
    self._persistedDwindleByIndex = new Map([[1, self._dwindleShapeFromString('h0.3000(l,v0.7000(l,l))')]]);
    self._retileDwindle(ws, [a]);
    self._retileDwindle(ws, [a, b]); // b restored
    self._retileDwindle(ws, [a, b]); // a settle re-assert or landing retry
    self._retileDwindle(ws, [a, b, c]); // c restored
    assert.equal(self._dwindleShapeToString(self._bspTrees.get(ws)), 'h0.3000(l,v0.7000(l,l))');
  }, 1200); // c's slot is taller than wide: a v-split, as saved
});

test('_handleGrabEnd: a click or an unmoved resize leaves the saved shape alone', () => {
  withDwindleWorkspace((ws) => {
    const [a, b] = [tile(), tile()];
    const self = grabSelf();
    const tree = split('h', 0.72, leaf(a), leaf(b));
    self._bspTrees.set(ws, tree);
    self._persistedDwindleByIndex = new Map([[1, self._dwindleShapeFromString('h0.3000(l,v0.7000(l,l))')]]);
    self._grabStartFrame = { x: 0, y: 0 };
    grabEnd(self, ws, MOVE);
    self._grabResizeNodeW = tree;
    self._grabInitialRatioW = 0.72;
    grabEnd(self, ws, RESIZE_E);
    assert.equal(self._dwindleShapeToString(self._persistedDwindleByIndex.get(1)), 'h0.3000(l,v0.7000(l,l))');
  });
});

test('_handleGrabEnd: a real drop reaches the saved shape', () => {
  withDwindleWorkspace((ws) => {
    const [a, b] = [tile(), tile()];
    const self = grabSelf();
    self._repositionWindow = () => {
      self._bspTrees.set(ws, split('v', 0.4, leaf(b), leaf(a)));
    };
    self._bspTrees.set(ws, split('h', 0.72, leaf(a), leaf(b)));
    self._persistedDwindleByIndex = new Map([[1, self._dwindleShapeFromString('h0.3000(l,v0.7000(l,l))')]]);
    self._grabStartFrame = { x: 400, y: 300 }; // the window travelled 500px
    grabEnd(self, ws, MOVE);
    assert.equal(self._dwindleShapeToString(self._persistedDwindleByIndex.get(1)), 'v0.4000(l,l)');
  });
});

test('refreshSavedShape: takes the whole live shape, never the parking slot', () => {
  withDwindleWorkspace((ws) => {
    const self = makeSelf();
    self._persistedDwindleByIndex = new Map([[1, self._dwindleShapeFromString('h0.5000(l,v0.5000(l,l))')]]);
    self.layouts.refreshSavedShape(ws, split('v', 0.3, leaf(null), leaf(null)));
    assert.equal(self._dwindleShapeToString(self._persistedDwindleByIndex.get(1)), 'v0.3000(l,l)');

    self.layouts.refreshSavedShape(globalThis.global.workspace_manager.get_workspace_by_index(0),
      split('h', 0.4, leaf(null), leaf(null)));
    assert.equal(self._persistedDwindleByIndex.has(0), false);
  });
});
