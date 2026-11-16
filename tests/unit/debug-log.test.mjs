import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeSelf, fakeWin } from '../helpers.mjs';

// Debug lines reach the journal (console.log). A GObject boxed value such as
// Mtk.Rectangle keeps its fields on the prototype, so JSON.stringify prints
// "{}" for it: log its fields instead.

class BoxedRect {
  #r;
  constructor(x, y, width, height) { this.#r = { x, y, width, height }; }
  get x() { return this.#r.x; }
  get y() { return this.#r.y; }
  get width() { return this.#r.width; }
  get height() { return this.#r.height; }
}

test('debug log: GRAB_BEGIN prints the frame of a boxed rect, not {}', () => {
  assert.equal(JSON.stringify(new BoxedRect(1, 2, 3, 4)), '{}'); // the fake is faithful
  const self = makeSelf({ debug: true, 'mouse-resize': true });
  const lines = [];
  self.debugLog = (...a) => lines.push(a.join(' '));
  self.windows.isFloating = () => true;
  const WS = {};
  const w = Object.assign(fakeWin({ instance: 'term' }), {
    get_frame_rect: () => new BoxedRect(10, 20, 300, 400),
    get_buffer_rect: () => new BoxedRect(10, 20, 300, 400),
    get_workspace: () => WS,
    get_window_type: () => 0,
  });
  const MOVING = 1;
  const old = globalThis.global;
  globalThis.global = { ...old, get_pointer: () => [15, 25, 0],
    workspace_manager: { get_active_workspace: () => WS } };
  try { self.grab.handleGrabBegin(w, MOVING); } catch (_e) { /* only the log line is under test */ } finally {
    globalThis.global = old;
  }
  const begin = lines.find(l => l.startsWith('GRAB_BEGIN'));
  assert.ok(begin, `no GRAB_BEGIN line in ${JSON.stringify(lines)}`);
  assert.match(begin, /rect=\(10,20,300,400\)/);
});

// Every debugLog that JSON.stringify-s a value is listed here with why it is a
// plain JS value; a new one must be added (and checked) deliberately.
const STRINGIFY_OK = new Map([
  ['bsp.js', ['min=${JSON.stringify(raw)}']], // get_min_size(): a JS array
]);

test('debug log: no debugLog JSON.stringify-s a value that is not known to be plain', () => {
  const dir = new URL('../../extensions/modules/', import.meta.url);
  const found = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const re = /debugLog\(`[^`]*`/g;
    for (const m of src.matchAll(re)) {
      for (const s of m[0].matchAll(/\$\{JSON\.stringify\([^}]*\)\}/g)) {
        const ok = (STRINGIFY_OK.get(f) || []).some(a => s[0].includes(a.slice(a.indexOf('${'))));
        if (!ok) found.push(`${f}: ${s[0]}`);
      }
    }
  }
  assert.deepEqual(found, []);
});
