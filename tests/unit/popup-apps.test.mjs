import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSelf, fakeWin } from '../helpers.mjs';

// popup-window-apps: an app whose menus and toolbars are plain windows (Zoom)
// tiles only its windows that declare a real minimum size.

const verdict = (opts, settings = { 'popup-window-apps': ['zoom'] }) => {
  const self = makeSelf(settings);
  const win = fakeWin(opts);
  return { managed: self.windows.shouldManage(win), floats: self.windows.floatsWhenWindowed(win) };
};
const TILED = { managed: true, floats: false };
const FLOATS = { managed: false, floats: true };

test('popup apps: Zoom main, meeting and chat windows (measured min sizes) tile', () => {
  for (const minSize of [[932, 400], [1000, 750], [870, 800]])
    assert.deepEqual(verdict({ instance: 'zoom', minSize }), TILED, `min ${minSize}`);
});

test('popup apps: a window of the app with no min size, 2x2, or under 200 on a side floats', () => {
  assert.deepEqual(verdict({ instance: 'zoom' }), FLOATS);
  assert.deepEqual(verdict({ instance: 'zoom', minSize: [2, 2] }), FLOATS);
  assert.deepEqual(verdict({ instance: 'zoom', minSize: [932, 199] }), FLOATS);
  assert.deepEqual(verdict({ instance: 'zoom', minSize: [199, 932] }), FLOATS);
  assert.deepEqual(verdict({ instance: 'zoom', minSize: [200, 200] }), TILED);
  assert.deepEqual(verdict({ instance: 'zoom', minHint: [false, 932, 400] }), FLOATS);
});

test('popup apps: matched by class or app id as the float list is', () => {
  assert.deepEqual(verdict({ wmClass: 'Zoom' }), FLOATS);
  assert.deepEqual(verdict({ appId: 'zoom' }), FLOATS);
});

test('popup apps: other apps are untouched, and an empty list changes nothing', () => {
  assert.deepEqual(verdict({ instance: 'gedit' }), TILED);
  assert.deepEqual(verdict({ instance: 'zoom' }, { 'popup-window-apps': [] }), TILED);
});

test('popup apps: the float list still floats a listed app outright', () => {
  assert.deepEqual(verdict({ instance: 'zoom', minSize: [932, 400] },
    { 'popup-window-apps': ['zoom'], 'float-windows': ['zoom'] }), FLOATS);
});

test('popup apps: zoom is not on the default float list, and is the default popup app', () => {
  const xml = readFileSync(new URL('../../extensions/schemas/org.gnome.shell.extensions.plaid.gschema.xml', import.meta.url), 'utf8');
  const def = key => xml.match(new RegExp(`<key name="${key}" type="as">\\s*<default><!\\[CDATA\\[(.*?)\\]\\]></default>`))[1];
  assert.doesNotMatch(def('float-windows'), /'zoom'/);
  assert.match(def('float-windows'), /'zoomwebviewhost'/);
  assert.equal(def('popup-window-apps'), "['zoom']");
});

test('popup apps: shouldManage and floatsWhenWindowed both ask isPopupAppWidget, nothing else re-derives it', () => {
  const src = readFileSync(new URL('../../extensions/modules/windows.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(code.match(/this\.isPopupAppWidget\(win\)/g)?.length, 2);
  assert.equal(code.match(/_popupWindowApps/g)?.length, 2); // the helper's own two reads
});
