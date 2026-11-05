import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const ext = join(root, 'extensions');

const extensionJs = readFileSync(join(ext, 'extension.js'), 'utf8');
const prefsJs = readFileSync(join(ext, 'prefs.js'), 'utf8');
const schemaXml = readFileSync(join(ext, 'schemas', 'org.gnome.shell.extensions.plaid.gschema.xml'), 'utf8');
const metadata = JSON.parse(readFileSync(join(ext, 'metadata.json'), 'utf8'));

// Every shipped source file — the API-usage scans below must cover the
// extracted modules too, or moving code into modules silently drops coverage.
const modulesDir = join(ext, 'modules');
const moduleFiles = existsSync(modulesDir)
  ? readdirSync(modulesDir).filter((f) => f.endsWith('.js')).map((f) => join(modulesDir, f))
  : [];
const sourceFiles = [join(ext, 'extension.js'), join(ext, 'prefs.js'), ...moduleFiles];
const allJs = sourceFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

// Comments legitimately mention removed APIs (documenting why they are gone),
// so the API-usage scans below must ignore comments.
const codeOnly = allJs
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const schemaKeys = new Set([...schemaXml.matchAll(/<key\s+name="([^"]+)"/g)].map((m) => m[1]));

const keybindingsJs = readFileSync(join(ext, 'modules', 'keybindings.js'), 'utf8');

function extractKeybindKeys() {
  const block = keybindingsJs.match(/const PLAID_KEYBIND_KEYS = \[([\s\S]*?)\];/);
  assert.ok(block, 'PLAID_KEYBIND_KEYS block not found');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('schema declares every PLAID_KEYBIND_KEYS entry', () => {
  for (const key of extractKeybindKeys())
    assert.ok(schemaKeys.has(key), `keybinding "${key}" missing from the schema`);
});

// Read or written through the extension's settings: this._settings (the
// entry point), this.core._settings (the subsystems), settings (prefs).
const SETTINGS_KEY_RE = /(?:\bthis\.(?:core\.)?_settings|\bsettings)\.(?:get|set)_(?:int|double|boolean|string|strv)\('([^']+)'/g;

test('every literal settings key read or written through the settings exists in the schema', () => {
  // Calibration: lines copied verbatim from the modules.
  const cal = [
    "        const gap = this.core._settings.get_int('inside-gap');",
    "            this.core._settings.set_strv('workspace-layouts', layouts);",
    "        const layout = settings.get_string('layout');",
  ].join('\n');
  assert.deepEqual([...cal.matchAll(SETTINGS_KEY_RE)].map((m) => m[1]), ['inside-gap', 'workspace-layouts', 'layout']);
  const used = [...allJs.matchAll(SETTINGS_KEY_RE)].map((m) => m[1]);
  assert.ok(new Set(used).size >= 50, `only ${new Set(used).size} keys found: the scan lost its population`);
  const missing = [...new Set(used)].filter((k) => !schemaKeys.has(k));
  assert.deepEqual(missing, [], `settings keys used but not declared: ${missing.join(', ')}`);
});

test('metadata uuid/shell-version are consistent', () => {
  assert.equal(metadata.uuid, 'plaid@plyply99');
  assert.ok(Number.isInteger(metadata.version), 'version must be an integer');
  assert.ok(metadata['shell-version'].includes('50'), 'shell-version must include 50');
  assert.ok(metadata['shell-version'].includes('51'), 'shell-version must include 51');
});

test('no non-introspectable GLib.dir_* calls (removed from the API surface)', () => {
  for (const bad of ['GLib.dir_open', 'GLib.dir_read_name', 'GLib.dir_close'])
    assert.ok(!codeOnly.includes(bad), `${bad} is not introspectable in GJS`);
});

test('Clutter.get_default_backend is only used behind a feature-detect guard', () => {
  if (codeOnly.includes('Clutter.get_default_backend('))
    assert.ok(codeOnly.includes("typeof Clutter.get_default_backend === 'function'"),
      'Clutter.get_default_backend used without the typeof guard');
});

test('no removed St.BoxLayout vertical property usage', () => {
  assert.ok(!codeOnly.includes('.vertical'), 'St.BoxLayout.vertical was removed in GNOME 51');
});

test('prefs.js is present and non-empty', () => {
  assert.ok(prefsJs.length > 1000);
});

test('every relative ./modules/*.js import resolves on disk', () => {
  const importRe = /from\s+['"](\.[^'"]+\.js)['"]/g;
  for (const file of [join(ext, 'extension.js'), join(ext, 'prefs.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(importRe)) {
      const p = join(dirname(file), m[1]);
      assert.ok(existsSync(p), `import "${m[1]}" in ${file} does not resolve to ${p}`);
    }
  }
});

test('build.sh packs the modules directory', () => {
  const build = readFileSync(join(root, 'build.sh'), 'utf8');
  assert.ok(/paths = \[[^\]]*'modules'/.test(build),
    "build.sh's pack-append list must include 'modules' or the zip will miss them");
});

test('sync.sh syncs the modules directory', () => {
  const sync = readFileSync(join(root, 'sync.sh'), 'utf8');
  assert.ok(sync.includes('$SOURCE/modules'), 'sync.sh must copy extensions/modules');
});

test('entry point stays small and free of lifecycle wrappers', () => {
  const lines = extensionJs.split('\n');
  assert.ok(lines.length <= 100, `extension.js is ${lines.length} lines; keep the default entry point small`);

  const code = extensionJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  assert.ok(!code.includes('_disable'), 'the entry point must not keep a _disable() alias');
  assert.ok(!/\btry\s*\{/.test(code), 'the entry point must not wrap enable()/disable() in try/catch');
  assert.ok(!/\bcatch\s*\(/.test(code), 'the entry point must not catch errors');
  assert.ok(!code.includes('Object.assign'), 'the entry point must not merge prototypes');
  assert.ok(!code.includes('attachMethods'), 'no custom attach-methods wrapper');

  const enable = code.indexOf('enable()');
  const disable = code.indexOf('disable()');
  assert.ok(enable >= 0 && disable > enable, 'enable() and disable() must both be present');

  const between = code.slice(enable, disable);
  assert.ok(between.includes('new PlaidCore(this)'), 'enable() must create the core');
  assert.ok(code.slice(disable).includes('this._plaid.destroy()'), 'disable() must destroy the core');

  // No module-scope call expressions: initialization happens in enable().
  assert.ok(!/^[A-Za-z_$][\w$]*\s*\(/m.test(code), 'no calls at module scope');
});

test('every GLib source is tracked or owned by a cleaned-up field', () => {
  const files = [join(ext, 'extension.js'), ...moduleFiles];
  const missed = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const [index, line] of src.split('\n').entries()) {
      if (!/GLib\.(timeout_add|idle_add|timeout_add_seconds)\s*\(/.test(line)) continue;
      if (file.endsWith(join('modules', 'signals.js'))) continue; // the tracker helpers

      const wrapped = /this\._add(?:Timeout|Idle)\s*\(/.test(line);
      const assigned = /(?:^|\s)(?:const\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*=\s*GLib\.(?:timeout_add|idle_add|timeout_add_seconds)\s*\(/.test(line);
      if (!wrapped && !assigned)
        missed.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }

  assert.deepEqual(missed, [], `untracked GLib sources:\n${missed.join('\n')}`);
});

test('shell modules export classes, not private function bundles', () => {
  for (const file of moduleFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/^export function _/m.test(src), `${file} exports a private-looking function name`);
    assert.ok(!/^export const \w+Methods\s*=/m.test(src), `${file} still exports a method bundle`);
  }
});

test('shell code logs through console.* only', () => {
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(!/(^|[^.\w$])log\s*\(/.test(src), `${file} still calls log()`);
  }
});

test('shell code uses connectObject/disconnectObject for signals', () => {
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\.connect\s*\(/.test(src), `${file} still uses raw .connect()`);
    assert.ok(!/\.disconnect\s*\(/.test(src), `${file} still uses raw .disconnect()`);
  }
});

test('shell modules have no empty catch blocks', () => {
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(src), `${file} has an empty catch block`);
  }
});

test('cycle-layout default avoids GNOME switch-group-backward', () => {
  const block = schemaXml.match(/<key name="cycle-layout"[\s\S]*?<\/key>/)?.[0] || '';
  assert.match(block, /<Super><Shift>e/, 'cycle-layout default must be the conflict-free Super+Shift+E');
  assert.ok(schemaKeys.has('keybind-migration-3-done'), 'migration marker for cycle-layout is missing');
});

test('keybinding conflict scanner is limited to known shortcut schemas', () => {
  const src = readFileSync(join(ext, 'modules', 'keybind-conflicts.js'), 'utf8');
  assert.ok(!src.includes('list_schemas'), 'the scanner must not walk every installed schema');
  for (const schema of [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
  ])
    assert.ok(src.includes(schema), `scanner is missing ${schema}`);
});

test('no legacy self._ references in composed subsystems', () => {
  for (const file of moduleFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/\bself\._[A-Za-z]/.test(src), `${file} still uses a legacy self._ field`);
  }
});

test('no writes to read-only Meta.Window properties', () => {
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/\b(?:win|w|metaWindow)\.(?:skip_taskbar|minimized|maximized|fullscreen)\s*=/.test(src),
      `${file} writes a read-only Meta.Window property`);
  }
});

test('GI namespaces are imported where they are used', () => {
  const namespaces = ['Main', 'GLib', 'St', 'Clutter', 'Meta', 'Gio', 'Shell', 'Cogl', 'GObject', 'graphene', 'cairo'];
  // keybind-conflicts.js receives Gio as an injected parameter so it can run
  // in the GTK-only prefs process. layouts.js mentions St.Settings only in a
  // comment; workspaces.js mentions org.gnome.Shell in a D-Bus name string.
  // placement.js and signals.js mention Meta only in comments.
  const allowed = new Set([
    'keybind-conflicts.js:Gio',
    'layouts.js:St',
    'placement.js:Meta',
    'signals.js:Meta',
    'workspaces.js:Shell',
  ]);
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8');
    for (const ns of namespaces) {
      if (!new RegExp(`\\b${ns}\\.`).test(src)) continue;
      if (allowed.has(`${basename(file)}:${ns}`)) continue;
      const imported = new RegExp(`import\\s+(?:\\*\\s+as\\s+)?${ns}\\b`).test(src);
      assert.ok(imported, `${file} uses ${ns} without importing it`);
    }
  }
});

test('shell code does not read another extension', () => {
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/just-perfection/.test(src), `${file} references Just Perfection`);
    assert.ok(!/extensionManager\.lookup/.test(src), `${file} looks up another extension`);
  }
});

test('no redundant existence checks for guaranteed Meta.Window methods', () => {
  const methods = ['get_pid', 'get_title', 'get_gtk_application_id',
    'get_compositor_private', 'get_workspace'];
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8');
    for (const method of methods) {
      assert.ok(!new RegExp(`\\.${method}\\s*\\?`).test(src),
        `${file} guards guaranteed Meta.Window.${method}()`);
    }
  }
});

test('subsystem cleanup is the last statement and normally indented', () => {
  for (const file of moduleFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/^ {12}super\.destroy\(\);$/m.test(src),
      `${file} has a misindented super.destroy()`);
    assert.ok(!/\n\}\n\}\s*$/.test(src), `${file} has stray class-closing braces`);
  }
});

test('shell code avoids synchronous file APIs', () => {
  const forbidden = [
    ['GLib.file_get_contents()', /GLib\.file_get_contents\s*\(/],
    ['sync load_contents()', /\.load_contents\s*\(/],
    ['sync enumerate_children()', /\.enumerate_children\s*\(/],
    ['sync next_file()', /\.next_file\s*\(/],
  ];
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const [name, re] of forbidden)
      assert.ok(!re.test(src), `${file} uses ${name}`);
  }
});

test('GObject.registerClass is not inside a class method', () => {
  for (const file of moduleFiles) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/^ {8,}.*GObject\.registerClass/m.test(src),
      `${file} registers a GObject class inside a class method`);
  }
});

test('try/catch budget and no wrappers around standard calls', () => {
  const budgets = new Map([
    ['blur.js', 6],
    ['mask.js', 3],
    ['background-app.js', 8],
    ['updater.js', 3],
  ]);
  const denied = 'disconnectObject|destroy|get_compositor_private|get_frame_rect|' +
    'get_buffer_rect|get_workspace|minimize|maximize|unminimize|delete|' +
    'change_workspace|move_resize_frame|make_above|stick|raise|activate';
  const wrapped = new RegExp(`\\btry\\s*\\{\\s*(?:[A-Za-z_$][\\w$]*\\.)*(?:${denied})\\s*\\(`);
  let total = 0;
  for (const file of [join(ext, 'extension.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8');
    const count = (src.match(/\btry\s*\{/g) || []).length;
    total += count;
    const allowed = budgets.get(basename(file)) ?? 3;
    assert.ok(count <= allowed, `${file} has ${count} try blocks (max ${allowed})`);
    assert.ok(!wrapped.test(src), `${file} wraps a standard call in try/catch`);
  }
  assert.ok(total <= 38, `shell code has ${total} try blocks (max 38)`);
});
// Calls of `name(` in module code, keyed `file:enclosing method`, comments
// stripped and the definitions skipped.
function callSites(name) {
  const sites = {};
  for (const file of moduleFiles) {
    const lines = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
    let method = '?';
    for (const raw of lines) {
      const line = raw.replace(/\/\/.*$/, '');
      const head = /^ {4}(\w+)\s*\([^)]*\)\s*\{\s*$/.exec(line);
      if (head) {
        method = head[1];
        if (method === name) continue;
      }
      for (const m of line.matchAll(new RegExp(`\\b${name}\\(([^()]*)\\)`, 'g'))) {
        const key = `${file.split('/').pop()}:${method}`;
        (sites[key] ??= []).push(m[1]);
      }
    }
  }
  return sites;
}

// Lines matching `re` in module code, counted per `file:enclosing method`.
function callSitesOf(re) {
  const sites = {};
  for (const file of moduleFiles) {
    const lines = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
    let method = '?';
    for (const raw of lines) {
      const line = raw.replace(/\/\/.*$/, '');
      const head = /^ {4}(\w+)\s*\([^)]*\)\s*\{\s*$/.exec(line);
      if (head) method = head[1];
      if (re.test(line)) {
        const key = `${file.split('/').pop()}:${method}`;
        sites[key] = (sites[key] ?? 0) + 1;
      }
    }
  }
  return sites;
}

// Spiral ignores minimums (bsp.minimumsIgnored): a BSP partition reads one
// only through bsp.layoutMinSize, and every tree or slot clamp names its
// group. A new getWindowMinSize call is refused until it is placed here.
test('BSP min sites read minimums through bsp.layoutMinSize, naming their group', () => {
  const counts = Object.fromEntries(Object.entries(callSites('getWindowMinSize')).map(([k, v]) => [k, v.length]));
  assert.deepEqual(counts, {
    'bsp.js:layoutMinSize': 1,
    'geometry.js:minClampSlot': 1,
    'grab.js:resizeTick': 5,
    'layouts.js:clampMasterStackRatios': 3,
    'layouts.js:retileMasterStack': 2,
    'layouts.js:retileCenteredMasterStack': 2,
  });
  for (const name of ['treeMinSizes', 'bspSlotRects']) {
    for (const [site, args] of Object.entries(callSites(name))) {
      // bspSlotRects may add its orient flag after the group.
      for (const a of args)
        assert.ok([4, name === 'bspSlotRects' ? 5 : 4].includes(a.split(',').length), `${site}: ${name}(${a}) does not name its group (ws, mon)`);
    }
  }
});

// A lone tile's rect is decided in one place (bsp.loneTileRect) for every BSP
// site; master-stack and the maximize conversions keep the whole area.
test('lone BSP tiles take their rect from bsp.loneTileRect only', () => {
  const counts = Object.fromEntries(Object.entries(callSites('singleWindowRect')).map(([k, v]) => [k, v.length]));
  assert.deepEqual(counts, {
    'bsp.js:loneTileRect': 1,
    'layouts.js:retileMasterStack': 1,
    'layouts.js:retileCenteredMasterStack': 1,
    'windows.js:convertMaximizedToGaps': 1,
    'windows.js:handleFloatMaximize': 1,
  });
});

// "Is this Spiral" is answered by the layout traits (helpers.js isSpiralLayout,
// bsp.isSpiral for a group): no layout name is compared anywhere else, and a
// new 'spiral' literal is refused until it is placed here.
test('Spiral is decided by the layout traits only', () => {
  const quoted = /['"]spiral['"]/;
  const compare = new RegExp(`(?:[!=]==?|\\bcase)\\s*${quoted.source}|${quoted.source}\\s*[!=]==?`);
  // Calibration on lines copied verbatim from the tree before the traits.
  for (const line of [
    "        if (ws && this.core.windows.getWorkspaceLayout(ws, mon) === 'spiral') return 0.5;",
    "            const spiral = g.places && g.layout === 'spiral';",
    "        return layout === 'dwindle' || layout === 'spiral';",
    "        return layout === 'spiral' ? `${groupKey}:spiral` : groupKey;",
  ])
    assert.ok(compare.test(line), `calibration: ${line.trim()}`);
  assert.ok(compare.test("case 'spiral':") && compare.test('"spiral" !== layout'), 'calibration: case / reversed');
  assert.ok(!compare.test("    return tail === '' || tail === ':spiral';"), 'calibration: the shape tag is not a layout name');
  const sites = {};
  const bad = [];
  for (const file of sourceFiles) {
    const name = file.split('/').pop();
    const lines = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
    lines.forEach((raw, i) => {
      const line = raw.replace(/\/\/.*$/, '');
      if (compare.test(line)) bad.push(`${name}:${i + 1} ${line.trim()}`);
      const n = (line.match(new RegExp(quoted.source, 'g')) || []).length;
      if (n) sites[name] = (sites[name] ?? 0) + n;
    });
  }
  assert.deepEqual(bad, []);
  // Names, captions, the traits table and the cycle order.
  assert.deepEqual(sites, { 'actions.js': 1, 'helpers.js': 2, 'prefs.js': 2 });
});

// A BSP split's child boxes are computed in one place (bsp.splitBoxes).
test('BSP split geometry is computed by bsp.splitBoxes only', () => {
  const geo = /\*\s*[\w.]*\bratio\)/;
  for (const line of ['        const split = Math.floor((axisSize - gap) * node.ratio);',
    '        const split = Math.floor((axis - gap) * node.ratio);'])
    assert.ok(geo.test(line), `calibration: ${line.trim()}`);
  const sites = Object.entries(callSitesOf(geo)).map(([k, v]) => `${k} ${v}`);
  assert.deepEqual(sites, ['bsp.js:splitBoxes 1']);
});

// Shutdown removes the sourceFields with GLib.source_remove, which throws on
// anything but a source id (a connectObject token stopped shutdown mid-way).
// Every assignment of a listed field is 0/null or a GLib source id.
test('every onShellShutdown sourceFields entry is only ever assigned a GLib source id', () => {
  const signals = readFileSync(join(modulesDir, 'signals.js'), 'utf8');
  const block = signals.match(/const sourceFields = \[([\s\S]*?)\];/);
  assert.ok(block, 'sourceFields list not found');
  const fields = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(fields.length >= 15, `only ${fields.length} fields: the scan lost its population`);
  // The per-window sources shutdown removes the same way.
  const perWindow = [...new Set([...signals.matchAll(/GLib\.source_remove\(win\.(_plaid\w+)\)/g)].map((m) => m[1]))];
  assert.deepEqual(perWindow.sort(), ['_plaidInvisibleTimer', '_plaidSettlePollId']);
  const SOURCE = /^(?:0|null|GLib\.(?:timeout_add|idle_add|timeout_add_seconds)\()/;
  const bad = (src, file, names) => {
    const out = [];
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      for (const f of names) {
        // =, ??= and ||= (not == / ===)
        const m = line.match(new RegExp(`\\.${f}\\s*(?:\\?\\?=|\\|\\|=|=(?!=))\\s*(.*)$`));
        if (!m) continue;
        const rhs = m[1].trim();
        if (SOURCE.test(rhs)) continue;
        // `x = id;` where id was just made by GLib.*_add in the same function.
        const id = rhs.match(/^([A-Za-z_$][\w$]*);$/);
        if (id && lines.slice(Math.max(0, i - 25), i).some((l) => new RegExp(`const ${id[1]} = GLib\\.(?:timeout_add|idle_add)\\(`).test(l))) continue;
        out.push(`${file}:${i + 1} ${f} = ${rhs.slice(0, 40)}`);
      }
    });
    return out;
  };
  // Calibration on lines copied verbatim from the tree (each must still be there): a source id
  // passes; a connectObject token and a ??= Map are refused when their field is listed.
  const src = Object.fromEntries(moduleFiles.map((f) => [f.split('/').pop(), readFileSync(f, 'utf8')]));
  const cal = [
    ['placement.js', '            this.core._animTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {', '_animTickId', 0],
    ['placement.js', '        win._plaidSettlePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {', '_plaidSettlePollId', 0],
    ['grab.js', "        this.core._liveResizeId = this.connectObject(global.stage, 'before-update', () => {", '_liveResizeId', 1],
    ['bsp.js', '                    const sent = this.core._liveSent ??= new Map();', '_liveSent', 1],
  ];
  for (const [file, line, name, n] of cal) {
    assert.ok(src[file].split('\n').includes(line), `calibration line gone from ${file}: ${line.trim()}`);
    assert.equal(bad(line, file, [name]).length, n, `${file}: ${line.trim()}`);
  }
  const found = Object.entries(src).flatMap(([f, s]) => bad(s, f, [...fields, ...perWindow]));
  assert.deepEqual(found, []);
});
