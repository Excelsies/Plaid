import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A lock cycle destroys the core and builds a new one. Every container, record
// or window reference the core holds is either carried over by the lock stash
// (core.js stashTilingState / restoreTilingState) or listed below as rebuilt,
// with the reason a fresh one is right. A new field in neither is refused.
// Known limit: a field reached only through an alias (`const m = this.core._x;
// m.set(...)`) and assigned from a local is not seen unless some line uses
// `this.core._x` as a container or creates it in place.

const here = dirname(fileURLToPath(import.meta.url));
const modulesDir = join(here, '..', '..', 'extensions', 'modules');
const raw = Object.fromEntries(readdirSync(modulesDir).filter((f) => f.endsWith('.js'))
  .map((f) => [f, readFileSync(join(modulesDir, f), 'utf8')]));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, ''));
// An assignment whose value is on the next line is read as one line.
const joinContinued = (lines) => lines.reduce((out, l) => {
  const prev = out[out.length - 1];
  if (prev !== undefined && /(?:[^=!<>]=|\?\?=|\|\|=)\s*$/.test(prev)) out[out.length - 1] = `${prev.trimEnd()} ${l.trim()}`;
  else out.push(l);
  return out;
}, []);
const src = Object.fromEntries(Object.entries(raw).map(([f, s]) => [f, joinContinued(code(s))]));

function body(lines, name) {
  const start = lines.indexOf(`    ${name}() {`);
  assert.ok(start >= 0, `${name}() not found`);
  return lines.slice(start + 1, lines.indexOf('    }', start));
}

const CREATE = /^(?:new (?:Map|Set|WeakMap|WeakSet|Array)\b|Object\.create\(null\)|\[|\{)/;
const DERIVED = /^this\.\w+(?:\.\w+)*\(/;
const WIN = /(?:Win|Window)$/;
const USE = /\.(?:get|set|has|add|delete|clear|keys|values|entries|forEach|size)\b/;

// enable(): `this._x = <container | derived value>`, and window references.
const enableFields = (lines) => lines.flatMap((l) => {
  const m = /^\s*this\.(_\w+)\s*=\s*(.*)$/.exec(l);
  return m && (CREATE.test(m[2]) || DERIVED.test(m[2]) || WIN.test(m[1])) ? [m[1]] : [];
});
// The subsystems: a container or record made on the core, a window reference,
// or a core field used as a container.
const moduleFields = (lines) => lines.flatMap((l) => [
  ...[...l.matchAll(/\bthis\.core\.(_\w+)\s*(?:\?\?=|\|\|=|=(?!=))\s*(.*)$/g)]
    .filter((m) => CREATE.test(m[2]) || WIN.test(m[1])).map((m) => m[1]),
  ...[...l.matchAll(/\bthis\.core\.(_\w+)\??(\.\w+)/g)].filter((m) => USE.test(m[2])).map((m) => m[1]),
]);
// core.js outside enable(): a field used as a container.
const coreUses = (lines) => lines.flatMap((l) =>
  [...l.matchAll(/\bthis\.(_\w+)\??(\.\w+)/g)].filter((m) => USE.test(m[2])).map((m) => m[1]));
// A subsystem's own container (the subsystems are rebuilt with the core).
const ownFields = (lines) => lines.flatMap((l) => {
  const m = /^\s*this\.(_\w+)\s*(?:\?\?=|=(?!=))\s*(.*)$/.exec(l);
  return m && CREATE.test(m[2]) ? [m[1]] : [];
});
const stashEntries = (lines) => lines.flatMap((l) => {
  const m = /^\s+(\w+): this\.(_\w+),$/.exec(l);
  return m ? [[m[1], m[2]]] : [];
});

const REBUILT = {
  _settings: 'opened again by enable()',
  _floatingClasses: 'parsed from float-windows at enable',
  _popupWindowApps: 'parsed from popup-window-apps at enable',
  _floatingTitles: 'parsed from float-titles at enable',
  _floatingTitlePatterns: 'compiled from float-titles at enable',
  _minSizeOverrides: 'parsed from min-window-sizes at enable',
  _persistedLayoutByIndex: 'loaded from the settings (flushed at disable) by loadPersistedLayoutRules',
  _persistedMasterByIndex: 'loaded from the settings (flushed at disable) by loadPersistedLayoutRules',
  _persistedStackByIndex: 'loaded from the settings (flushed at disable) by loadPersistedLayoutRules',
  _persistedDwindleByIndex: 'loaded from the settings (flushed at disable) by loadPersistedLayoutRules',
  _persistedDwindleRaw: 'loaded from the settings (flushed at disable) by loadPersistedLayoutRules',
  _floatProcessCache: '/proc lookup cache, refilled on demand',
  _chromiumProcessCache: '/proc lookup cache, refilled on demand',
  _windowBorders: 'Flair actor, destroyed at disable; the resume pass runs updateBorders()',
  _scratchpadRings: 'Flair actor, destroyed at disable; the resume pass runs updateBorders()',
  _windowMasks: 'window masks, cleared at disable; the resume pass runs updateBorders()',
  _windowBlurs: 'Flair effect, destroyed at disable; the resume pass runs updateBorders()',
  _sourceIds: 'GLib sources, removed at disable',
  _pendingRetileIds: 'GLib sources, removed at disable',
  _keybindChangeIds: 'signal ids, reconnected by registerKeybindings',
  _failedKeybindCombos: 'rebuilt by registerKeybindings',
  _keybindConflictTimes: 'a 2.5 s rate limit on conflict notices',
  _keybindConflictById: 'rebuilt by the conflict scan',
  _keybindConflictByName: 'rebuilt by the conflict scan',
  _slotReassertTimes: 'rate-limit timestamps',
  _lastRetileTimes: 'rate-limit timestamps',
  _pinnedAdjustCounts: 'convergence guard over a 2 s window',
  _stackDiagnostics: 'once-per-window debug log',
  _grabbedWindow: 'per grab; grab.destroy ends it',
  _grabWindow: 'per grab; grab.destroy ends it',
  _grabStartFrame: 'per grab; grab.destroy ends it',
  _grabInitialStackRatios: 'per grab; grab.destroy ends it',
  _retileAfterGrab: 'per grab; grab.destroy ends it',
  _liveSent: 'per grab (live resize); grab.destroy ends it',
  _liveStretched: 'per grab (live resize); grab.destroy ends it',
  _dwindleDropCache: 'per drag (drop preview)',
  _dropPreviewTarget: 'per drag (drop preview)',
  _queuedAnimWorkspaces: 'animation in flight, ended at disable',
  _deferredReassertWins: 'animation in flight, ended at disable',
  _transformStates: 'animation in flight, ended at disable',
  _animTargets: 'animation in flight, ended at disable',
  _animWindows: 'animation in flight, ended at disable',
  _landings: 'landing retries; the next slot starts a fresh budget',
  _pendingWarp: 'pointer warp waiting for a placement',
  _closeFocus: 'focus-after-close record, waiting for one retile; disable drops it',
  _newWindowSet: 'new-window choreography; a resume adds windows as resumed, never new',
  _windowSignals: 'reconnected for every restored window by the resume pass (addWindow, reconnectRestored)',
  _floatHooks: 'reconnected by connectFloatHooks in the resume pass',
  _workspacePillFocusedWin: 'the pill is rebuilt by initWorkspacePill',
  _pendingWarning: 'the dynamic-workspaces warning queued behind the overview; the resume pass checks again and raises it anew',
  _dropdownWin: 're-adopted by initDropdownTerminal (sessionState.ddtPid)',
  _dropdownWaiters: 'per spawn of the dropdown terminal',
  _dropdownGeometryIds: 'signal ids on the dropdown window, reconnected at adoption',
  _backgroundAppWin: 're-claimed by initBackgroundApp and the resume pass (sessionState.bgAppWindow)',
  _backgroundAppWaiter: 'per spawn of the background app',
  _backgroundAppHiding: 'taken over from sessionState.parkingHiding',
  _markerPidCache: '/proc marker scan cache, refilled on demand',
  // A subsystem's own containers.
  'proc-info.js:_procCmdlineCache': '/proc cache, refilled on demand',
  'proc-info.js:_procCmdlineWaiters': 'reads in flight, cleared at disable',
  'proc-info.js:_procEnvironCache': '/proc cache, refilled on demand',
  'proc-info.js:_procEnvironWaiters': 'reads in flight, cleared at disable',
  'grab.js:_pressTrail': 'pointer trail of the current press',
  'blur.js:_retired': 'GL resources waiting to be freed',
  'subsystem.js:_tokens': 'connectObject tokens, disconnected at disable',
};

test('every core container is carried by the lock stash or rebuilt with a reason', (t) => {
  // Calibration on lines copied verbatim from the modules (each must still be there).
  const cal = [
    ['core.js', '        this._bspTrees = new Map();', enableFields, ['_bspTrees']],
    ['core.js', '        this._minSizeOverrides = this.bsp.parseMinSizeOverrides(this._settings.get_strv(\'min-window-sizes\'));', enableFields, ['_minSizeOverrides']],
    ['core.js', '        this._grabStartX = 0;', enableFields, []],
    ['core.js', '                bspTrees: this._bspTrees,', stashEntries, [['bspTrees', '_bspTrees']]],
    ['core.js', '                monitorSig: this.monitors.signature(),', stashEntries, []],
    ['keybindings.js', '        this.core._failedKeybindCombos = new Map();', moduleFields, ['_failedKeybindCombos']],
    ['persistence.js', '        this.core._persistedDwindleRaw = raw;', moduleFields, []],
    ['windows.js', '        this.core._savedRects.delete(win);', moduleFields, ['_savedRects']],
    ['placement.js', '            this.core._animTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {', moduleFields, []],
    ['proc-info.js', '        this._procCmdlineCache = new Map();', ownFields, ['_procCmdlineCache']],
  ];
  // A value on the next line is joined (verbatim pair; St widgets are not containers).
  const pair = ['        this.core._workspacePillNumbers =',
    "            new St.BoxLayout({ style_class: 'plaid-workspace-pill-numbers' });"];
  assert.ok(raw['workspace-pill.js'].includes(pair.join('\n')), 'calibration pair gone from workspace-pill.js');
  assert.deepEqual(joinContinued(pair),
    ["        this.core._workspacePillNumbers = new St.BoxLayout({ style_class: 'plaid-workspace-pill-numbers' });"]);
  assert.ok(src['workspace-pill.js'].includes("        this.core._workspacePillNumbers = new St.BoxLayout({ style_class: 'plaid-workspace-pill-numbers' });"));
  assert.deepEqual(joinContinued(['        if (a ==', '            b) {']), ['        if (a ==', '            b) {'], 'a comparison is not an assignment');
  // No module makes Object.create(null) today: its pattern only.
  assert.deepEqual(moduleFields(['        this.core._byName = Object.create(null);']), ['_byName']);
  for (const [file, line, scan, want] of cal) {
    assert.ok(raw[file].split('\n').includes(line), `calibration line gone from ${file}: ${line.trim()}`);
    assert.deepEqual(scan([line]), want, `calibration ${file}: ${line.trim()}`);
  }

  const core = src['core.js'];
  const stash = stashEntries(body(core, 'stashTilingState'));
  const restore = body(core, 'restoreTilingState').join('\n');
  const stashed = new Set(stash.map(([, f]) => f));
  const fromEnable = new Set(enableFields(body(core, 'enable')));
  const fromModules = new Set(Object.entries(src).filter(([f]) => f !== 'core.js').flatMap(([, l]) => moduleFields(l)));
  const fromCore = new Set(coreUses(core));
  const own = [...new Set(Object.entries(src).filter(([f]) => f !== 'core.js')
    .flatMap(([f, l]) => ownFields(l).map((n) => `${f}:${n}`)))];
  t.diagnostic(`stash (${stash.length}): ${stash.map(([, f]) => f).join(' ')}`);
  t.diagnostic(`enable (${fromEnable.size}): ${[...fromEnable].join(' ')}`);
  t.diagnostic(`modules (${fromModules.size}): ${[...fromModules].join(' ')}`);
  t.diagnostic(`core uses (${fromCore.size}): ${[...fromCore].join(' ')}`);
  t.diagnostic(`subsystem-owned (${own.length}): ${own.join(' ')}`);
  assert.ok(stash.length >= 15, `only ${stash.length} stash entries: the scan lost its population`);
  assert.ok(fromEnable.size >= 50, `only ${fromEnable.size} enable() fields: the scan lost its population`);
  assert.ok(fromModules.size >= 40, `only ${fromModules.size} module fields: the scan lost its population`);
  assert.ok(fromCore.size >= 5, `only ${fromCore.size} core.js uses: the scan lost its population`);
  assert.ok(own.length >= 7, `only ${own.length} subsystem-owned containers: the scan lost its population`);

  // Every stash entry is a field enable() sets, and the restore reads and assigns it.
  const enableText = body(core, 'enable').join('\n');
  for (const [key, field] of stash) {
    assert.match(enableText, new RegExp(`\\bthis\\.${field} = `), `stashed ${field} is not set by enable()`);
    assert.match(restore, new RegExp(`\\bs\\.${key}\\b`), `restoreTilingState never reads s.${key}`);
    assert.match(restore, new RegExp(`\\bthis\\.${field} = `), `restoreTilingState never assigns ${field}`);
  }

  const population = new Set([...stashed, ...fromEnable, ...fromModules, ...fromCore, ...own]);
  const neither = [...population].filter((f) => !stashed.has(f) && !(f in REBUILT));
  const both = [...population].filter((f) => stashed.has(f) && f in REBUILT);
  const stale = Object.keys(REBUILT).filter((f) => !population.has(f));
  const unexplained = Object.entries(REBUILT).filter(([, r]) => !r.trim()).map(([f]) => f);
  t.diagnostic(`population ${population.size}: stashed ${stashed.size}, rebuilt ${Object.keys(REBUILT).length}`);
  assert.deepEqual(neither, [], 'in neither the lock stash nor the rebuilt list');
  assert.deepEqual(both, [], 'in both lists');
  assert.deepEqual(stale, [], 'rebuilt entries the code no longer has');
  assert.deepEqual(unexplained, []);
});
