import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { makeSelf, fakeWin } from '../helpers.mjs';

// The transform driver (transforms.js) against fake windows and actors.

let clock = 0; // monotonic µs
GLib.get_monotonic_time = () => clock;

function actorOf() {
  return {
    scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, opacity: 255, pivot: null,
    set_scale(x, y) { this.scale_x = x; this.scale_y = y; },
    set_translation(x, y) { this.translation_x = x; this.translation_y = y; },
    set_opacity(v) { this.opacity = v; },
    set_pivot_point(x, y) { this.pivot = [x, y]; },
    remove_all_transitions() {},
    ease() {},
    show() {},
  };
}

// A window whose configure lands at once unless `lag` (a Wayland client that
// commits later: the frame keeps its old size).
function win(frame, { lag = false } = {}) {
  const w = fakeWin();
  const actor = actorOf();
  const log = [];
  Object.assign(w, {
    _frame: { ...frame }, _actor: actor, _log: log, _ws: 'WS', _fs: false,
    get_frame_rect: () => ({ ...w._frame }),
    get_buffer_rect: () => ({ ...w._frame }),
    get_compositor_private: () => w._actor,
    get_workspace: () => w._ws,
    is_fullscreen: () => w._fs,
    connectObject(...a) { w._sig = a; },
    disconnectObject() { w._sig = null; },
    move_resize_frame: (_u, x, y, width, height) => {
      log.push(['configure', x, y, width, height]);
      w._frame = lag ? { ...w._frame, x, y } : { x, y, width, height };
    },
  });
  return w;
}

function driverSelf() {
  const self = makeSelf({});
  self.placement.getAnimationTime = () => 0.1; // f = 1
  self.transforms.ensureTimeline = () => {};
  self.monitors.recordTick = (w) => w._log?.push(['record']);
  // The timeline's first frame comes at once: each ease starts there.
  const run = self.transforms.run.bind(self.transforms);
  self.transforms.run = (...a) => { run(...a); self.transforms.step(); };
  return self;
}

const state = (w, t) => ({ win: w, startX: w._frame.x, startY: w._frame.y, startW: w._frame.width,
  startH: w._frame.height, targetX: t[0], targetY: t[1], targetW: t[2], targetH: t[3] });
const ms = (n) => n * 1000;

test('run: one configure per window, recorded first, then drawn from its old rect', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  assert.deepEqual(a._log, [['record'], ['configure', 200, 0, 100, 100]]);
  // At t = 0 the actor is translated back over the old rect.
  assert.equal(a._actor.translation_x, -200);
  assert.equal(a._actor.scale_x, 1);
  assert.ok(self._transformStates.has(a));
  assert.ok(a._sig, 'size/position hooks while it runs');
});

test('step: at the end of the ease a landed window finishes at identity, landed once', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  let landed = 0;
  self.transforms.run([state(a, [200, 0, 100, 100])], () => landed++);
  clock = ms(190);
  self.transforms.step();
  assert.equal(landed, 0);
  assert.ok(a._actor.translation_x < 0 && a._actor.translation_x > -200);
  clock = ms(380);
  self.transforms.step();
  assert.equal(landed, 1);
  assert.equal(self._transformStates.size, 0);
  assert.deepEqual([a._actor.translation_x, a._actor.scale_x], [0, 1]);
  assert.equal(a._sig, null);
  self.transforms.step();
  assert.equal(landed, 1);
});

test('step: a resize the client has not committed stays stretched over the slot, at most the hold', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 }, { lag: true });
  let landed = 0;
  self.transforms.run([state(a, [0, 0, 400, 100])], () => landed++);
  clock = ms(400);
  self.transforms.step();
  assert.equal(landed, 1, 'landed at the end of the ease');
  assert.ok(self._transformStates.has(a), 'still held');
  assert.equal(a._actor.scale_x, 4, 'stretched over the slot');
  clock = ms(380 + 1500 + 1);
  self.transforms.step();
  assert.equal(self._transformStates.size, 0);
  assert.equal(a._actor.scale_x, 1);
  assert.equal(landed, 1);
});

test('step: the commit for the slot ends the hold', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 }, { lag: true });
  self.transforms.run([state(a, [0, 0, 400, 100])], () => {});
  clock = ms(400);
  self.transforms.step();
  a._frame = { x: 0, y: 0, width: 400, height: 100 };
  self.transforms.step();
  assert.equal(self._transformStates.size, 0);
});

test('stop(keep) carries the drawn rect: a new target starts there, the same target keeps its path', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  const b = win({ x: 0, y: 200, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100]), state(b, [400, 200, 100, 100])], () => {});
  clock = ms(100);
  const carry = self.transforms.stop(true, 'WS');
  assert.equal(carry.size, 2);
  const drawnA = carry.get(a).visual;
  const t0B = carry.get(b).t0;
  const sa = state(a, [600, 0, 100, 100]);
  const sb = state(b, [400, 200, 100, 100]);
  a._log.length = 0;
  self.transforms.run([sa, sb], () => {}, carry);
  assert.deepEqual([sa.startX, sa.startY, sa.startW, sa.startH], drawnA);
  assert.equal(sa.t0, ms(100));
  assert.deepEqual(a._log, [['record'], ['configure', 600, 0, 100, 100]]);
  assert.equal(sb.t0, t0B, 'same slot: same trajectory');
  assert.equal(b._log.filter(e => e[0] === 'configure').length, 1, 'not configured again');
});

test('run: a carried window the new run does not move goes back to identity', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  clock = ms(100);
  const carry = self.transforms.stop(true, 'WS');
  assert.notEqual(a._actor.translation_x, 0, 'kept drawn');
  self.transforms.run([], () => {}, carry);
  assert.equal(a._actor.translation_x, 0);
});

test('stop: another workspace\'s run and an `only` filter are left alone', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  const b = win({ x: 0, y: 0, width: 100, height: 100 });
  b._ws = 'OTHER';
  self.transforms.run([state(a, [200, 0, 100, 100]), state(b, [200, 0, 100, 100])], () => {});
  self.transforms.stop(false, 'WS');
  assert.deepEqual([...self._transformStates.keys()], [b]);
  self.transforms.stop(false, null, w => w !== b);
  assert.deepEqual([...self._transformStates.keys()], [b]);
  self.transforms.stop();
  assert.equal(self._transformStates.size, 0);
  assert.equal(b._actor.translation_x, 0);
});

test('release: the window lands where it is, landed once', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  let landed = 0;
  self.transforms.run([state(a, [200, 0, 100, 100])], () => landed++);
  self.transforms.release(a);
  assert.equal(landed, 1);
  assert.equal(a._actor.translation_x, 0);
  assert.equal(self._transformStates.size, 0);
});

test('run: pop-in starts at 0.87 about the slot centre and fades in', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  const s = { ...state(a, [0, 0, 100, 100]), popin: true };
  self.transforms.run([s], () => {});
  assert.deepEqual([s.startX, s.startY, s.startW, s.startH], [6.5, 6.5, 87, 87]);
  assert.equal(a._actor.opacity, 0);
  clock = ms(85);
  self.transforms.step();
  assert.ok(a._actor.opacity > 100 && a._actor.opacity < 160);
  clock = ms(380);
  self.transforms.step();
  assert.equal(a._actor.opacity, 255);
});

test('run: a window already at its target with nothing to ease lands at once', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 200, y: 0, width: 100, height: 100 });
  let landed = 0;
  self.transforms.run([state(a, [200, 0, 100, 100])], () => landed++);
  assert.equal(landed, 1);
  assert.equal(self._transformStates.size, 0);
  assert.deepEqual(a._log, [], 'no configure');
});

test('step: a window moved elsewhere (mutter centring it) is configured again', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  a._frame = { x: 900, y: 500, width: 100, height: 100 };
  a._log.length = 0;
  clock = ms(20);
  self.transforms.step();
  assert.deepEqual(a._log, [['record'], ['configure', 200, 0, 100, 100]]);
});

test('step: a window gone fullscreen or unmanaged mid-run finishes', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  const b = win({ x: 0, y: 0, width: 100, height: 100 });
  let landed = 0;
  self.transforms.run([state(a, [200, 0, 100, 100]), state(b, [200, 0, 100, 100])], () => landed++);
  a._fs = true;
  b._actor = null;
  self.transforms.step();
  assert.equal(landed, 2);
  assert.equal(a._actor.translation_x, 0);
  assert.equal(self._transformStates.size, 0);
});

test('run: an ease starts on the first frame drawn, not when the run starts', () => {
  clock = 0;
  const self = makeSelf({});
  self.placement.getAnimationTime = () => 0.1;
  self.transforms.ensureTimeline = () => {};
  self.monitors.recordTick = () => {};
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [380, 0, 100, 100])], () => {});
  // The first frame 40 ms later draws the start, not 40 ms of ease.
  clock = ms(40);
  self.transforms.step();
  assert.equal(a._actor.translation_x, -380);
  clock = ms(40 + 380);
  self.transforms.step();
  assert.equal(self._transformStates.size, 0);
});

// A window with a CSD shadow: the buffer extends past the frame.
function shadowed(frame, pad = [10, 12]) {
  const w = win(frame);
  w.get_buffer_rect = () => ({ x: w._frame.x - pad[0], y: w._frame.y - pad[1],
    width: w._frame.width + 2 * pad[0], height: w._frame.height + 2 * pad[1] });
  return w;
}
// Where the actor draws the frame: the buffer origin plus the frame's
// offset in it, scaled about the buffer origin (pivot 0,0), then translated.
function drawnFrame(w) {
  const f = w._frame, b = w.get_buffer_rect(), a = w._actor;
  return [b.x + (f.x - b.x) * a.scale_x + a.translation_x, b.y + (f.y - b.y) * a.scale_y + a.translation_y,
    f.width * a.scale_x, f.height * a.scale_y];
}

test('apply: with a CSD shadow the frame is drawn at the eased rect', () => {
  clock = 0;
  const self = driverSelf();
  const a = shadowed({ x: 100, y: 50, width: 400, height: 300 }, [10, 12]);
  a.move_resize_frame = () => {}; // a lagging client keeps its frame
  self.transforms.run([state(a, [600, 80, 800, 600])], () => {});
  clock = ms(190);
  self.transforms.step();
  const v = self.transforms.visual(self._transformStates.get(a), clock);
  drawnFrame(a).forEach((x, i) => assert.ok(Math.abs(x - v[i]) < 1e-6, `${i}: ${x} vs ${v[i]}`));
});

test('timeline: one per batch of states, stopped when the last state ends', () => {
  clock = 0;
  const self = makeSelf({});
  self.placement.getAnimationTime = () => 0.1;
  self.monitors.recordTick = () => {};
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  const stage = {};
  globalThis.global.stage = stage;
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  delete globalThis.global.stage;
  const tl = self._transformTimeline;
  assert.ok(tl && tl.playing && tl.repeat_count === -1 && tl.actor === stage);
  clock = ms(10);
  tl.frame();
  assert.equal(self._transformTimeline, tl, 'still running');
  clock = ms(400);
  tl.frame();
  assert.equal(self._transformStates.size, 0);
  assert.equal(self._transformTimeline, null);
  assert.equal(tl.playing, false);
  assert.equal(tl.handlers.length, 0);
  assert.equal(self.transforms._tokens.length, 0, 'every hook disconnected');
});

test('timeline: a frame of a timeline that is no longer the current one does nothing', () => {
  clock = 0;
  const self = makeSelf({});
  self.placement.getAnimationTime = () => 0.1;
  self.monitors.recordTick = () => {};
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  const tl = self._transformTimeline;
  tl.frame(); // the ease starts
  self._transformTimeline = { stop() {} };
  clock = ms(400);
  tl.frame();
  assert.ok(self._transformStates.has(a), 'not stepped');
});

test('timeline: stop() ends it with the last state', () => {
  clock = 0;
  const self = makeSelf({});
  self.placement.getAnimationTime = () => 0.1;
  self.monitors.recordTick = () => {};
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  const tl = self._transformTimeline;
  self.transforms.stop();
  assert.equal(self._transformTimeline, null);
  assert.equal(tl.playing, false);
});

test('run: a window already running and not handed over loses its old hooks', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  self.transforms.run([state(a, [400, 0, 100, 100])], () => {});
  assert.equal(self.transforms._tokens.length, 1);
  self.transforms.stop();
  assert.equal(self.transforms._tokens.length, 0);
});

test('run: a pop-in retargeted before it landed stays a pop-in', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([{ ...state(a, [0, 0, 100, 100]), popin: true }], () => {});
  const carry = self.transforms.stop(true);
  const s = state(a, [50, 0, 100, 100]);
  self.transforms.run([s], () => {}, carry);
  assert.equal(s.popin, true);
  // Landed before the retarget: a plain move.
  const d = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([{ ...state(d, [0, 0, 100, 100]), popin: true }], () => {});
  const c2 = self.transforms.stop(true);
  c2.get(d).done = true;
  const s2 = state(d, [50, 0, 100, 100]);
  self.transforms.run([s2], () => {}, c2);
  assert.equal(s2.popin, undefined);
});

test('step: a commit of the window\'s own size at the slot\'s position ends the hold', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 }, { lag: true });
  self.transforms.run([state(a, [300, 0, 400, 100])], () => {});
  clock = ms(400);
  self.transforms.step();
  assert.ok(self._transformStates.has(a), 'held: still at the sent rect');
  // The client answered with a size of its own, at the slot.
  a._frame = { x: 300, y: 0, width: 520, height: 100 };
  self.transforms.step();
  assert.equal(self._transformStates.size, 0);
  // An answer elsewhere is not one.
  const b = win({ x: 0, y: 0, width: 100, height: 100 }, { lag: true });
  self.transforms.run([state(b, [300, 0, 400, 100])], () => {});
  clock = ms(800);
  self.transforms.step();
  b._frame = { x: 0, y: 0, width: 520, height: 100 };
  b.move_resize_frame = () => {};
  self.transforms.step();
  assert.ok(self._transformStates.has(b));
});

test('reset: an actor that is not the window\'s any more is left alone', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  const old = a._actor;
  a._actor = actorOf(); // the window's actor replaced (closed on another workspace)
  old.set_scale = () => assert.fail('touched a stale actor');
  old.set_translation = () => assert.fail('touched a stale actor');
  self.transforms.release(a);
});

test('release paths: animFloat and a regroup end a run', () => {
  clock = 0;
  const self = driverSelf();
  const released = [];
  self.transforms.release = (w) => released.push(w);
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.placement.getAnimationTime = () => 0;
  self.windows.moveWindow = () => {};
  self.placement.animFloat(a, 0, 0, 10, 10);
  self.placement.getAnimationTime = () => 0.1;
  a.get_compositor_private = () => actorOf();
  self.placement.animFloat(a, 0, 0, 10, 10);
  self.geometry.wsIndex = () => 1;
  self._windowMonitors.set(a, 'DP-1');
  self.monitors.setWindowGroup(a, 'DP-2', 'test');
  assert.deepEqual(released, [a, a]);
});

test('step: a frame of a running animation is progress for the watchdog', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  self._animating = true;
  self._animProgressAt = 0;
  self.transforms.step();
  assert.ok(self._animProgressAt > 0);
});

test('cancelAnimation: transform runs end at identity', () => {
  clock = 0;
  const self = driverSelf();
  const a = win({ x: 0, y: 0, width: 100, height: 100 });
  self.transforms.run([state(a, [200, 0, 100, 100])], () => {});
  self.placement.cancelAnimation();
  assert.equal(self._transformStates.size, 0);
  assert.equal(a._actor.translation_x, 0);
});
