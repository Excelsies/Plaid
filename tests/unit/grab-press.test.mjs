import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import { makeSelf } from '../helpers.mjs';

// The press anchor (grab.trackPressPointer / pressAnchor).

let clock = 0; // ms
GLib.get_monotonic_time = () => clock * 1000;

function tracker() {
  return {
    handlers: [],
    connectObject(...a) { const obj = a.pop(); this.handlers.push([obj, a[0], a[1]]); },
    disconnectObject(obj) { this.handlers = this.handlers.filter(h => h[0] !== obj); },
    emit(sig) { for (const [, s, fn] of [...this.handlers]) if (s === sig) fn(); },
  };
}

function pressSelf(pointer, layout = 'spiral') {
  const self = makeSelf({});
  self.monitors.tiledMonitors = () => [0, 1];
  self.monitors.groupPlaces = () => true;
  self.windows.getWorkspaceLayout = (_ws, mon) => (mon === 1 ? layout : 'dwindle');
  const old = globalThis.global;
  globalThis.global = { ...old, get_pointer: () => [...pointer.at, 0],
    workspace_manager: { get_active_workspace: () => ({}) } };
  return { self, restore: () => { globalThis.global = old; } };
}

test('trackPressPointer: with a tiled group (Spiral, dwindle or master-stack), the pointer is recorded after a cursor change, for 3 s', () => {
  clock = 1000;
  const ptr = { at: [10, 10] };
  const { self, restore } = pressSelf(ptr, 'master-stack');
  try {
    const t = tracker();
    self.grab.trackPressPointer(t);
    self.grab.trackPressPointer(t);
    assert.equal(t.handlers.length, 1, 'one position hook');
    clock = 1500;
    ptr.at = [20, 20];
    t.emit('position-invalidated');
    assert.deepEqual(self.grab._pressTrail.map(e => e.slice(1)), [[10, 10], [10, 10], [20, 20]]);
    clock = 4500;
    t.emit('position-invalidated');
    assert.equal(t.handlers.length, 0, 'stopped after 3 s');
    assert.equal(self.grab._pressTrail, null);
  } finally {
    restore();
  }
});

test('pressAnchor: the pointer recorded last before the press; none for an old or missing press', () => {
  clock = 1000;
  const ptr = { at: [10, 10] };
  const { self, restore } = pressSelf(ptr);
  try {
    const t = tracker();
    self.grab.trackPressPointer(t);
    clock = 1100; ptr.at = [50, 60]; t.emit('position-invalidated');
    clock = 1200; ptr.at = [70, 80]; t.emit('position-invalidated');
    const win = (ut) => ({ get_user_time: () => ut });
    clock = 1300;
    assert.deepEqual(self.grab.pressAnchor(win(1150)), [50, 60]);
    assert.deepEqual(self.grab.pressAnchor(win(1250)), [70, 80]);
    assert.equal(self.grab.pressAnchor(win(900)), null, 'before the trail');
    assert.equal(self.grab.pressAnchor(win(0)), null, 'no user time');
    clock = 2300;
    assert.equal(self.grab.pressAnchor(win(1250)), null, 'a press over 1 s ago');
    self.grab.destroy();
    assert.equal(self.grab._pressTrail, null);
    assert.equal(t.handlers.length, 0);
  } finally {
    restore();
  }
});

test('trail: the last 8 positions', () => {
  clock = 0;
  const ptr = { at: [0, 0] };
  const { self, restore } = pressSelf(ptr);
  try {
    const t = tracker();
    self.grab.trackPressPointer(t);
    for (let i = 1; i <= 10; i++) { clock = i; ptr.at = [i, i]; t.emit('position-invalidated'); }
    assert.equal(self.grab._pressTrail.length, 8);
    assert.deepEqual(self.grab._pressTrail[0].slice(1), [3, 3]);
  } finally {
    restore();
  }
});

test('trackPressPointer: nothing is recorded or hooked without a tiled group on the active workspace', () => {
  clock = 0;
  const { self, restore } = pressSelf({ at: [1, 1] }, 'floating');
  self.monitors.groupPlaces = () => false;
  try {
    const t = tracker();
    self.grab.trackPressPointer(t);
    assert.equal(t.handlers.length, 0);
    assert.equal(self.grab._pressTrail, null);
  } finally {
    restore();
  }
});
