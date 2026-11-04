// Test-only ESM loader.
//
// Plaid's extension.js is a single module that imports gi:// namespaces and
// resource:// gnome-shell modules — neither resolves under plain Node. This
// loader maps both schemes to minimal stubs so the REAL extension.js (and its
// extracted ./modules/*.js) can be imported and its pure logic exercised in
// unit tests.
//
// Register it with: node --import ./tests/register.mjs --test tests/

const GI_SOURCES = {
  Clutter: 'export default { Orientation: { HORIZONTAL: 0, VERTICAL: 1 }, AnimationMode: { EASE_OUT_CUBIC: 0, EASE_OUT_QUAD: 1 }, get_default_backend: undefined, ' +
    'EVENT_PROPAGATE: false, EVENT_STOP: true, EventType: { BUTTON_RELEASE: 7, SCROLL: 8 }, ' +
    'ScrollDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SMOOTH: 4 }, ModifierType: { MOD4_MASK: 1 << 26 }, ' +
    'Grab: class Grab {}, Event: { add_filter: () => 1, remove_filter: () => {} }, ' +
    // Clutter.Timeline as GJS shows it: construct properties, start/stop,
    // and signals through connectObject/disconnectObject; frame() emits
    // new-frame (a test drives the frames).
    'Timeline: class Timeline { constructor(p = {}) { this.actor = p.actor ?? null; this.duration = p.duration ?? 0; ' +
    'this.repeat_count = p.repeat_count ?? 0; this.playing = false; this.handlers = []; } ' +
    'start() { this.playing = true; } stop() { this.playing = false; } is_playing() { return this.playing; } ' +
    'connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) this.handlers.push([obj, a[i], a[i + 1]]); } ' +
    'disconnectObject(obj) { this.handlers = this.handlers.filter(h => h[0] !== obj); } ' +
    'frame(ms = 16) { for (const [, sig, fn] of [...this.handlers]) if (sig === \'new-frame\') fn(this, ms); } } };',
  Cogl: 'export default { SnippetHook: { FRAGMENT: 1, VERTEX: 2, TEXTURE_LOOKUP: 3 } };',
  GObject: 'export default { registerClass: () => { throw new Error("GObject.registerClass invoked at import time"); } };',
  Gio: 'export default {};',
  GLib: 'export default { PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true, idle_add: () => 1, timeout_add: () => 1, source_remove: (id) => { if (typeof id !== "number") throw new TypeError("GLib.source_remove: expected a source id, got " + typeof id); return true; }, get_monotonic_time: () => 0, MainContext: { default: () => ({ find_source_by_id: () => true }) } };',
  Graphene: 'export default {};',
  Meta: 'export default { WindowType: { NORMAL: 0 }, WindowClientType: { WAYLAND: 0, X11: 1 }, GrabOp: { NONE: 0, KEYBOARD_RESIZING_UNKNOWN: 769 }, KeyBindingAction: {}, prefs_get_keybinding_action: () => 0, external_binding_name_for_action: () => null };',
  Shell: 'export default {};',
  St: 'export default {};',
  cairo: 'export default {};',
};

const RESOURCE_SOURCES = [
  [/\/extensions\/extension\.js$/, 'export class Extension {}\nexport function gettext(s) { return s; }\n' +
    'export class InjectionManager { #saved = []; ' +
    'overrideMethod(o, n, f) { const orig = o[n]; this.#saved.push([o, n, orig]); o[n] = f(orig); } ' +
    'clear() { for (const [o, n, orig] of this.#saved.reverse()) o[n] = orig; this.#saved = []; } }'],
  [/\/modalDialog\.js$/, 'export class ModalDialog {}'],
  // Mutable stand-ins: tests set wm/overview fields and read the popped grabs.
  [/\/ui\/main\.js$/, 'export const wm = {};\nexport const overview = { visible: false };\n' +
    'export const sessionMode = { currentMode: \'user\', isLocked: false, connectObject() {}, disconnectObject() {} };\n' +
    'export const popped = [];\nexport function popModal(grab) { popped.push(grab); }\n'],
  [/\/workspaceSwitcherPopup\.js$/, 'export class WorkspaceSwitcherPopup {}\nexport class MonitorWorkspaceSwitcherPopup {}'],
  [/\/workspacesView\.js$/, 'export class WorkspacesView {}'],
  [/\/workspaceThumbnail\.js$/, 'export class ThumbnailsBox {}'],
];

function resourceSource(url) {
  for (const [re, src] of RESOURCE_SOURCES) {
    if (re.test(url)) return src;
  }
  return 'export {};';
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('gi://') || specifier.startsWith('resource://'))
    return { url: specifier, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('gi://')) {
    const name = url.slice('gi://'.length).split('/')[0];
    if (!(name in GI_SOURCES))
      throw new Error(`Unknown gi:// namespace in tests: gi://${name} — check the exact namespace casing`);
    return { format: 'module', source: GI_SOURCES[name], shortCircuit: true };
  }
  if (url.startsWith('resource://')) {
    return { format: 'module', source: resourceSource(url), shortCircuit: true };
  }
  return nextLoad(url, context);
}
