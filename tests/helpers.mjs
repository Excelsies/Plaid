// Shared test fixtures: fake GSettings, fake Meta windows, BSP tree builders,
// and a `makeSelf` that builds a real PlaidCore with its subsystem classes.
// The returned Proxy keeps the old method names used by the unit tests.

import { PlaidCore } from '../extensions/modules/core.js';
import { LEGACY_METHODS } from './legacy-methods.mjs';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

export { normalizeAccel } from '../extensions/modules/helpers.js';

// One monitor, index 0, no connector lookup: what the single-monitor tests
// assume. Tests that replace `global` take `display: oneMonitor()`.
export function oneMonitor(extra = {}) {
  return {
    get_primary_monitor: () => 0,
    get_n_monitors: () => 1,
    get_current_monitor: () => 0,
    get_monitor_geometry: () => ({ x: 0, y: 0, width: 2560, height: 1440 }),
    get_monitor_index_for_rect: () => 0,
    focus_window: null,
    ...extra,
  };
}

// Node's own `global` is globalThis: give it the display tests leave unstubbed.
if (!globalThis.global.display) globalThis.global.display = oneMonitor();

// The shell always has a monitor manager. A test that replaces `global`
// without one gets an empty manager: every monitor keyed by its index.
const emptyBackend = () => ({ get_monitor_manager: () => ({ get_logical_monitors: () => [] }) });
let shellGlobal = globalThis.global;
if (!shellGlobal.backend) shellGlobal.backend = emptyBackend();
Object.defineProperty(globalThis, 'global', {
  configurable: true,
  get: () => shellGlobal,
  set: (g) => {
    shellGlobal = g;
    if (g && typeof g === 'object' && !('backend' in g)) g.backend = emptyBackend();
  },
});

export function fakeSettings(values = {}) {
  return {
    get_int: (k) => (k in values ? values[k] : 0),
    get_double: (k) => (k in values ? values[k] : 0.5),
    get_boolean: (k) => (k in values ? values[k] : false),
    get_string: (k) => (k in values ? values[k] : ''),
    get_strv: (k) => (k in values ? [...values[k]] : []),
    set_strv: (k, v) => { values[k] = [...v]; },
    get_default_value: (k) => (k in values ? { deep_unpack: () => values[k] } : null),
    get_user_value: (k) => (k in values ? { deep_unpack: () => values[k] } : null),
    settings_schema: { list_keys: () => Object.keys(values) },
  };
}

// The landing tests read the per-window record through the two maps it
// replaced: a counted miss (slot key, count, total) and an accepted slot.
function landingViews(core) {
  const rec = (win) => core._landings?.get(win);
  Object.defineProperty(core, '_landingRetries', {
    configurable: true,
    get: () => ({
      has: (win) => (rec(win)?.key ?? null) !== null,
      get: (win) => {
        const r = rec(win);
        return r && r.key !== null ? { key: r.key, n: r.n, total: r.total } : undefined;
      },
    }),
  });
  Object.defineProperty(core, '_landingAccepted', {
    configurable: true,
    get: () => ({
      has: (win) => (rec(win)?.accepted ?? null) !== null,
      get: (win) => rec(win)?.accepted ?? undefined,
    }),
  });
}

function resetCoreState(core, settings) {
  core._settings = fakeSettings(settings);
  core._floatingClasses = new Set(settings['float-windows'] ?? []);
  core._popupWindowApps = new Set(settings['popup-window-apps'] ?? []);
  core._floatingTitles = new Set(settings['float-titles'] ?? []);
  core._floatingTitlePatterns = [];
  core._floatProcessCache = new Map();
  core._minSizeOverrides = new Map();
  core._windowBorders = new Map();
  core._scratchpadRings = new Map();
  core._windowMasks = new Map();
  core._maskQuarantined = new Set();
  core._windowBlurs = new Map();
  core._sourceIds = new Set();
  core._workspaceOrders = new Map();
  core._windowWorkspaces = new Map();
  core._windowWSIndices = new Map();
  core._windowMonitors = new Map();
  core._groupObjs = new Map();
  core._monitorConnCache = null;
  core._monitorConnPartial = false;
  core._tiledMonitorsCache = null;
  core._keyedPrimary = null;
  core._regroupId = 0;
  core._grabbedWindow = null;
  core._grabDropped = false;
  core._slotReassertTimes = new Map();
  core._workspaceLayouts = new Map();
  core._lastRetileTimes = new Map();
  core._masterRatios = new Map();
  core._stackRatios = new Map();
  core._bspTrees = new Map();
  core._dwindleLeafSigs = new Map();
  core._bspLaidOutAs = new Map();
  core._lastFocusedPerWorkspace = new Map();
  core._savedRects = new Map();
  core._workspaceLayoutsSaveId = 0;
  core._saveDirtySince = 0;
  core._layoutSaveClosed = false;
  core._stackSettleId = 0;
  core._pickFocusId = null;
  core._conflictScanId = 0;
  core._keybindChangeIds = [];
  core._backgroundAppCloneWatchId = 0;
  core._backgroundAppSpawnRetries = 0;
  core._signals = [];
  core._pendingRetileIds = new Map();
  core._pendingBorderId = 0;
  core._queuedAnimWorkspaces = new Set();
  core._deferredReassertWins = new Set();
  core._animStartedAt = 0;
  core._animProgressAt = 0;
  core._animGen = 0;
  core._animWorkspace = null;
  core._animTransformRun = false;
  core._animTickLeft = 0;
  core._transformStates = new Map();
  core._transformTimeline = null;
  core._liveSent = null;
  core._liveStretched = null;
  core._dragGhost = null;
  core._dropGhost = null;
  core._dwindleDropCache = null;
  core._dragShrunk = null;
  core._landings = new Map();
  landingViews(core);
  core._observedMinSizes = new Map();
  core._pendingWarp = new Set();
  core._retileAfterGrab = new Set();
  core._pinnedAdjustCounts = new Map();
  core._stackDiagnostics = new Set();
  core._toggleFloatWindows = new Set();
  core._keyboardFocusChange = false;
  core._grabOp = null;
  core._grabWindow = null;
  core._grabStartX = 0;
  core._grabStartY = 0;
  core._grabStartFrame = null;
  core._grabCarried = null;
  core._grabWidthSign = 0;
  core._grabHeightSign = 0;
  core._grabCornerAxis = null;
  core._grabResizeNodeW = null;
  core._grabResizeNodeH = null;
  core._grabInnerW = null;
  core._grabClampedW = false;
  core._grabClampedH = false;
  core._grabLowered = false;
  core._grabInnerH = null;
  core._grabFollowW = 1;
  core._grabFollowH = 1;
  core._grabInitialRatioW = 0;
  core._grabInitialRatioH = 0;
  core._grabInitialMasterRatio = 0;
  core._grabInitialStackRatios = null;
  core._liveResizeId = 0;
  core._grabSizeChangedId = 0;
  core._grabPositionChangedId = 0;
  core._layoutPopup = null;
  core._layoutPopupHideId = 0;
  core._warningPopup = null;
  core._warningPopupId = 0;
  core._pendingWarning = null;
  core._pendingWarningOverviewId = 0;
  core._origWorkspaceSwitcherDisplay = null;
  core._dropdownWin = null;
  core._dropdownUnmanagedId = 0;
  core._dropdownPending = false;
  core._dropdownPendingId = 0;
  core._dropdownWaiters = new Map();
  core._dropdownGeometryIds = null;
  core._markerPidCache = null;
  core._dropdownSettingsChangedId = 0;
  core._dropdownHeightChangedId = 0;
  core._backgroundAppWin = null;
  core._backgroundAppWaiter = null;
  core._backgroundAppReleaseId = 0;
  core._maximizeToggleRects = new Map();
  core._backgroundAppPending = false;
  core._backgroundAppSpawnRetries = 0;
  core._markerSweepPending = false;
  core._bgAppRecheckPending = false;
  core._bgAppRecheckId = 0;
  core._markerSweepGen = 0;
  core._backgroundAppPendingId = 0;
  core._backgroundAppUnmanagedId = 0;
  core._backgroundAppSettingsChangedId = 0;
  core._backgroundAppEnabledChangedId = 0;
  core._backgroundAppRestartId = 0;
  core._pointerFocusId = 0;
  core._pointerFocusLastX = -1;
  core._pointerFocusLastY = -1;
  core._pointerFocusHover = null;
  core._pointerFocusCandSig = '';
  core._chromiumProcessCache = new Map();
  core._backgroundAppProc = null;
  core._backgroundAppFirstFrameId = 0;
  core._backgroundAppClone = null;
  core._backgroundAppGroupAddedId = 0;
  core._backgroundAppCloneWatchId = 0;
  core._backgroundAppParkIds = null;
  core._backgroundAppParkWatchTimeoutId = 0;
  core._backgroundAppParkCoalesceId = 0;
  core._backgroundAppParkCount = 0;
  core._backgroundAppParkingWs = null;
  core._backgroundAppHiding = null;
  core._backgroundAppParkingFixId = 0;
  core._backgroundAppParkingLastRelocate = 0;
  core._dynamicWsWarned = false;
  core._lastRealFocusedWindow = null;
  core._floatMaxRects = new Map();
  core._gappedMaxSet = new Set();
  core._borderAnimId = 0;
  core._scratchpadWindows = new Map();
  core._scratchpadVisible = false;
  core._dropPreview = null;
  core._dropPreviewTarget = null;
  core._dropOverlay = null;
  core._shuttingDown = false;
  core._animating = false;
  core._animTargets = null;
  core._animStates = null;
  core._animWindows = null;
  core._animStartTime = 0;
  core._animTickId = 0;
  core._newWindowSet = new Set();
  core._closeFocus = new Map();
  core._floatHooks = new Map();
  core._mutterSettings = null;
  core._signals = [];
  core._windowSignals = new Map();
  core._shellSettings = null;
  core._shellSettingsChangedId = 0;
  core._jpSettings = null;
  core._jpSettingsChangedId = 0;
  core._pointerFocusEnabledId = 0;
}

function applyOverride(core, key, value) {
  core[key] = value;
  const target = LEGACY_METHODS[key];
  if (!target) return;
  const [prop, name] = target;
  if (prop === 'core') {
    core[name] = value;
    return;
  }
  if (core[prop])
    core[prop][name] = value;
}

// The GI the gradient ring needs (border-ring.js), recording what it is
// given. Clutter.Actor is the ring's base, with the parent/child protocol the
// border tests' fake actors use; `emit` runs its handlers. A pipeline records
// its uniforms by name; a pipeline node keeps the uniforms it was made with
// (mutter copies the pipeline) and its rectangles. Installed at run time
// (makeSelf): a registerClass at import time still throws, as does any other
// class's. `cogl.news` counts Pipeline.new.
export class FakeClutterActor {
  constructor(p = {}) {
    Object.assign(this, { x: 0, y: 0, width: 0, height: 0, visible: true, mapped: true }, p);
    this.children = [];
    this.parent = null;
    this.calls = { pos: 0, size: 0 };
    this.clips = [];
    this.handlers = [];
    this.destroyed = false;
    this.views = [];
    this.paintOpacity = 255;
  }
  add_child(c) { this.children.push(c); c.parent = this; }
  get_parent() { return this.parent; }
  get_first_child() { return this.children[0] ?? null; }
  get_last_child() { return this.children.at(-1) ?? null; }
  get_previous_sibling() { const k = this.parent?.children ?? []; return k[k.indexOf(this) - 1] ?? null; }
  get_next_sibling() { const k = this.parent?.children ?? []; const i = k.indexOf(this); return i < 0 ? null : k[i + 1] ?? null; }
  set_child_above_sibling(c) { this.children = this.children.filter(k => k !== c); this.children.push(c); this.raises = (this.raises ?? 0) + 1; }
  set_position(x, y) { this.calls.pos++; this.x = x; this.y = y; }
  set_size(w, h) { this.calls.size++; this.width = w; this.height = h; }
  destroy() { this.destroyed = true; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) this.handlers.push([obj, a[i], a[i + 1]]); }
  disconnectObject(obj) { this.handlers = this.handlers.filter(h => h[0] !== obj); }
  emit(sig) { for (const [, s, fn] of [...this.handlers]) if (s === sig) fn(this); }
  queue_redraw_with_clip(clip) { this.clips.push(clip); }
  get_paint_opacity() { return this.paintOpacity; }
  peek_stage_views() { return this.views; }
}

// Blending as Cogl derives it (cogl-pipeline.c
// _cogl_pipeline_update_real_blend_enable): a pipeline keeps the blend flag
// it was copied with until a setter marks it dirty (set_color, set_blend, a
// layer texture that changes; not add_snippet, not a null texture on a new
// layer, not a uniform); a dirty one looks at what it and its dirty
// ancestors changed, and a fragment snippet there means blending.
export class FakePipeline {
  constructor(from = null) {
    this.uniforms = new Map(from?.uniforms ?? []);
    this.snippets = [...(from?.snippets ?? [])];
    this.names = from?.names ?? [];
    this.nullLayer = from?.nullLayer;
    this.copiedFrom = from;
    this.sets = 0;
    this.changed = new Set();
    this.blendDirty = from?.blendDirty ?? false;
    this.realBlend = from?.realBlend ?? false;
  }
  copy() { return new FakePipeline(this); }
  set_layer_null_texture(layer) { this.nullLayer = layer; this.changed.add('layers'); }
  add_snippet(s) { this.snippets.push(s); this.changed.add('snippets'); }
  set_blend(s) {
    if (s !== 'RGBA = ADD (SRC_COLOR, DST_COLOR*(1-SRC_COLOR[A]))') throw new Error(`blend string ${s}`);
    this.blend = s;
    this.blendDirty = true;
    return true;
  }
  blends() {
    if (!this.blendDirty) return this.realBlend;
    for (let p = this; p?.blendDirty; p = p.copiedFrom)
      if (p.changed.has('snippets')) return true;
    return this.realBlend;
  }
  get_uniform_location(name) {
    if (!this.names.includes(name)) this.names.push(name);
    return this.names.indexOf(name);
  }
  set_uniform_float(loc, n, count, v) {
    if (v.length !== n * count) throw new Error(`uniform ${this.names[loc]}: ${v.length} values for ${n} x ${count}`);
    this.sets++;
    this.uniforms.set(this.names[loc].replace(/^ring_/, ''), [...v]);
  }
}

export const cogl = { news: 0, fail: null, failNode: null };

export function installRingGi() {
  if (installRingGi.done) return;
  installRingGi.done = true;
  Clutter.Actor ??= FakeClutterActor;
  Clutter.ActorBox ??= class ActorBox { constructor(p = {}) { Object.assign(this, p); } };
  Clutter.PipelineNode ??= class PipelineNode {
    constructor(pipeline) {
      if (cogl.failNode) throw new Error(cogl.failNode);
      this.uniforms = new Map(pipeline.uniforms);
      this.blends = pipeline.copy().blends();
      this.rects = [];
    }
    add_texture_rectangle(box, ...tex) { this.rects.push([box, ...tex]); }
  };
  Cogl.Pipeline ??= { new: () => {
    cogl.news++;
    if (cogl.fail) throw new Error(cogl.fail);
    return new FakePipeline();
  } };
  Cogl.Snippet ??= { new: (hook, decl, code) => ({ hook, decl, code }) };
  const register = GObject.registerClass;
  GObject.registerClass = (meta, cls) => (meta?.GTypeName === 'PlaidBorderRing' ? cls : register(meta, cls));
}

// The Cogl context masks.coglContext() reads, on a `global.stage` that has
// none; restore() puts the old stage back.
export function coglStage() {
  const old = globalThis.global.stage;
  globalThis.global.stage = { get_context: () => ({ get_backend: () => ({ get_cogl_context: () => ({}) }) }) };
  return { restore: () => { globalThis.global.stage = old; } };
}

// Real PlaidCore + subsystem instances; the Proxy keeps the old `_method`
// call sites used by the existing unit tests.
export function makeSelf(settings = {}, overrides = {}) {
  installRingGi();
  const core = new PlaidCore({
    getSettings: () => fakeSettings(settings),
    metadata: {},
  });
  resetCoreState(core, settings);
  for (const [key, value] of Object.entries(overrides))
    applyOverride(core, key, value);

  return new Proxy(core, {
    get(target, prop, receiver) {
      if (prop in target)
        return Reflect.get(target, prop, receiver);
      const targetInfo = LEGACY_METHODS[prop];
      if (targetInfo) {
        const [owner, name] = targetInfo;
        const obj = owner === 'core' ? target : target[owner];
        if (obj && typeof obj[name] === 'function')
          return obj[name].bind(obj);
      }
      return undefined;
    },
    set(target, prop, value) {
      applyOverride(target, prop, value);
      return true;
    },
  });
}

// The grab loop's frame clock on the current `global`: the stage's
// before-update and the cursor tracker's position-invalidated. frame() runs
// one tick (once per view on several monitors); restore() puts the old stage and backend back.
export function frameClock() {
  const g = globalThis.global;
  const old = { stage: g.stage, backend: g.backend };
  const handlers = [];
  const emitter = () => ({
    connectObject(...a) {
      const obj = a.pop();
      for (let i = 0; i + 1 < a.length; i += 2) handlers.push([this, obj, a[i], a[i + 1]]);
    },
    disconnectObject(obj) {
      for (let i = handlers.length - 1; i >= 0; i--)
        if (handlers[i][0] === this && handlers[i][1] === obj) handlers.splice(i, 1);
    },
  });
  const stage = Object.assign(emitter(), { updates: 0, schedule_update() { this.updates++; } });
  const tracker = emitter();
  g.stage = stage;
  g.backend = { ...(g.backend ?? {}), get_cursor_tracker: () => tracker };
  const emit = (e, sig, ...args) => { for (const [o, , s, fn] of [...handlers]) if (o === e && s === sig) fn(e, ...args); };
  return {
    stage, tracker, handlers,
    // A view (with get_layout) as before-update passes it; none by default.
    frame: (view) => emit(stage, 'before-update', view),
    move: () => emit(tracker, 'position-invalidated'),
    restore: () => { g.stage = old.stage; g.backend = old.backend; },
  };
}

let _winId = 0;

export function fakeWin(opts = {}) {
  const frame = opts.frame ?? { x: 0, y: 0, width: 100, height: 100 };
  const buffer = opts.buffer ?? frame;
  return {
    _testId: opts.id ?? ++_winId,
    get_frame_rect: () => ({ ...frame }),
    get_buffer_rect: () => ({ ...buffer }),
    get_wm_class_instance: () => opts.instance ?? null,
    get_wm_class: () => opts.wmClass ?? null,
    get_gtk_application_id: () => opts.appId ?? null,
    get_title: () => opts.title ?? '',
    get_pid: () => opts.pid ?? 0,
    get_monitor: () => opts.monitor ?? 0,
    get_transient_for: () => opts.transientFor ?? null,
    // GNOME 50 shape: [ok, w, h]. `minHint`/`maxHint` pass a raw shape through.
    get_min_size: () => opts.minHint ?? (opts.minSize ? [true, ...opts.minSize] : [false, 0, 0]),
    get_max_size: () => opts.maxHint ?? (opts.maxSize ? [true, ...opts.maxSize] : [false, 0, 0]),
    client_rect_to_frame_rect: (r) => {
      const [dw, dh] = opts.frameDelta ?? [0, 0];
      return { ...r, width: r.width + dw, height: r.height + dh };
    },
    get_window_type: () => opts.type ?? 0,
    get_pid: () => opts.pid ?? 0,
    get_compositor_private: () => opts.actor ?? null,
    _signals: {},
    connectObject(name, callback) {
      this._signals[name] = callback;
      return {};
    },
    disconnectObject() {},
    // Meta.WindowClientType: 0 Wayland, 1 X11.
    get_client_type: () => opts.clientType ?? 0,
    is_skip_taskbar: () => opts.skipTaskbar ?? false,
    is_fullscreen: () => opts.fullscreen ?? false,
    is_maximized: () => opts.maximized ?? false,
    is_hidden: () => opts.hidden ?? false,
    get_user_time: () => opts.userTime ?? 0,
    minimized: opts.minimized ?? false,
    minimize() { this.minimized = true; },
    unminimize() { this.minimized = false; },
    activate() {},
    delete() {},
    make_above() {},
    unmake_above() {},
    stick() {},
    unstick() {},
    is_on_all_workspaces: () => opts.sticky ?? false,
  };
}

export const leaf = (win) => ({ type: 'leaf', window: win });
export const empty = () => ({ type: 'empty' });
export const split = (direction, ratio, first, second) =>
  ({ type: 'split', direction, ratio, first, second });
