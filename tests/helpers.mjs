// Shared test fixtures: fake GSettings, fake Meta windows, BSP tree builders,
// and a `makeSelf` that builds a real PlaidCore with its subsystem classes.
// The returned Proxy keeps the old method names used by the unit tests.

import { PlaidCore } from '../extensions/modules/core.js';
import { LEGACY_METHODS } from './legacy-methods.mjs';

export { normalizeAccel, maskSdfRect } from '../extensions/modules/helpers.js';

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
    get_strv: (k) => (k in values ? values[k] : []),
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

// Real PlaidCore + subsystem instances; the Proxy keeps the old `_method`
// call sites used by the existing unit tests.
export function makeSelf(settings = {}, overrides = {}) {
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
// one tick; restore() puts the old stage and backend back.
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
  const emit = (e, sig) => { for (const [o, , s, fn] of [...handlers]) if (o === e && s === sig) fn(e); };
  return {
    stage, tracker, handlers,
    frame: () => emit(stage, 'before-update'),
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
