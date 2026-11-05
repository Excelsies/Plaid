// Transform driver: each window is configured once, then drawn every frame at
// lerp(start, target, easeOutQuint(t)) through its actor's scale and
// translation, re-derived from the current frame and buffer, so whatever the
// client has drawn is stretched over the eased rect (waiting for the commit
// would flash the destination and make slow clients jump). landed(s) runs
// once per state; a resized window stays stretched until its commit (at most
// TRANSFORM_HOLD_MS after the ease, scaled with the animation speed).
//
// The driver owns the actor's scale, translation, pivot and the pop-in
// opacity while a state exists; every state ends at identity (finish, stop,
// release, destroy).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { PlaidSubsystem } from './subsystem.js';

const TRANSFORM_ANIM_MS = 380;
const POPIN_SCALE = 0.87;
const POPIN_FADE_MS = 170;
const TRANSFORM_HOLD_MS = 1500;

export class Transforms extends PlaidSubsystem {
    constructor(core) {
        super(core);
        this._timelineToken = null;
    }

    // states: {win, startX..H, targetX..H, popin?}. carry: states a stopped
    // run left drawn where they are (stop(true)); a window in it starts from
    // its drawn rect, the rest go back to identity.
    run(states, landed, carry = new Map()) {
        const map = this.core._transformStates;
        if (!map) return;
        const now = GLib.get_monotonic_time();
        const duration = this.core.placement.scaledAnimMs(TRANSFORM_ANIM_MS);
        for (const s of states) {
            // A state of this window not handed over: its hooks go with it.
            const cur = map.get(s.win);
            if (cur && cur !== carry.get(s.win)) {
                this.disconnectState(cur);
                map.delete(s.win);
            }
            const actor = s.win.get_compositor_private();
            const prev = carry.get(s.win);
            carry.delete(s.win);
            // A new window's own first-frame retile retargets its pop-in run:
            // keep the flag or its 'new' landing is lost.
            if (prev?.popin && !prev.done) s.popin = true;
            if (!actor) {
                landed(s);
                continue;
            }
            s.actor = actor;
            s.onLanded = landed;
            s.done = false;
            if (prev && prev.targetX === s.targetX && prev.targetY === s.targetY &&
                prev.targetW === s.targetW && prev.targetH === s.targetH) {
                // Same slot: keep its trajectory; restarting from the drawn
                // rect brakes it.
                for (const k of ['startX', 'startY', 'startW', 'startH', 't0', 'dur', 'sent'])
                    s[k] = prev[k];
                this.resendIfMoved(s);
            } else {
                if (prev) {
                    [s.startX, s.startY, s.startW, s.startH] = prev.visual;
                } else if (s.popin) {
                    s.startW = s.targetW * POPIN_SCALE;
                    s.startH = s.targetH * POPIN_SCALE;
                    s.startX = s.targetX + (s.targetW - s.startW) / 2;
                    s.startY = s.targetY + (s.targetH - s.startH) / 2;
                }
                // The ease starts on the first frame the driver draws, not
                // here: a run started between frames would skip its start.
                s.t0 = null;
                s.dur = duration;
                if (prev || s.popin || !this.frameAt(s)) this.configure(s);
                // Right after the configure: the target for a move or an X11
                // client, the old rect for a Wayland resize until its commit.
                const f = s.win.get_frame_rect();
                s.sent = { x: f.x, y: f.y, w: f.width, h: f.height };
            }
            s.op0 = null;
            if (prev && prev.op0 !== null) {
                s.op0 = prev.op0;
                s.fadeT0 = prev.fadeT0;
                s.fadeMs = prev.fadeMs;
            } else if (s.popin) {
                s.op0 = 0;
                s.fadeT0 = null;
                s.fadeMs = this.core.placement.scaledAnimMs(POPIN_FADE_MS);
            }
            if (s.op0 === null &&
                Math.max(Math.abs(s.startX - s.targetX), Math.abs(s.startY - s.targetY),
                    Math.abs(s.startW - s.targetW), Math.abs(s.startH - s.targetH)) < 1 &&
                this.frameAt(s)) {
                if (prev) this.reset(prev);
                landed(s);
                continue;
            }
            const reapply = () => {
                if (map.get(s.win) === s && s.win.get_compositor_private())
                    this.apply(s, GLib.get_monotonic_time());
            };
            s.sigToken = this.connectObject(s.win, 'size-changed', reapply, 'position-changed', reapply);
            actor.remove_all_transitions();
            actor.set_pivot_point(0, 0);
            map.set(s.win, s);
            this.apply(s, now);
        }
        // Back to identity: interrupted windows this run does not move.
        for (const p of carry.values()) this.reset(p);
        if (map.size > 0) this.ensureTimeline();
    }

    // The frame is the state's target, exactly.
    frameAt(s) {
        const f = s.win.get_frame_rect();
        return f.x === s.targetX && f.y === s.targetY && f.width === s.targetW && f.height === s.targetH;
    }

    // The run's one configure. Recorded first: crossing a monitor, the move
    // emits window-entered-monitor before it returns (monitors.ownMoveInFlight).
    configure(s) {
        this.core.monitors.recordTick(s.win, s.targetX, s.targetY, s);
        s.win.move_resize_frame(true, s.targetX, s.targetY, s.targetW, s.targetH);
    }

    // Ticks before layout and paint: every frame gets a fresh transform.
    ensureTimeline() {
        if (this.core._transformTimeline) return;
        const tl = new Clutter.Timeline({ actor: global.stage, duration: 1000, repeat_count: -1 });
        this._timelineToken = this.connectObject(tl, 'new-frame', () => {
            if (this.core._transformTimeline !== tl) return;
            this.step();
            if (this.core._transformStates?.size === 0) this.stopTimeline();
        });
        this.core._transformTimeline = tl;
        tl.start();
    }

    stopTimeline() {
        const tl = this.core._transformTimeline;
        if (!tl) return;
        this.core._transformTimeline = null;
        if (this._timelineToken) this.disconnectToken(this._timelineToken);
        this._timelineToken = null;
        tl.stop();
    }

    // t0 null: not drawn yet, at its start.
    visual(s, now) {
        // dur 0: arrived (a hand-off held at its slot).
        const t = s.dur > 0 ? Math.min(1, Math.max(0, (now - (s.t0 ?? now)) / 1000 / s.dur)) : 1;
        const e = 1 - Math.pow(1 - t, 5);
        return [s.startX + (s.targetX - s.startX) * e, s.startY + (s.targetY - s.startY) * e,
            s.startW + (s.targetW - s.startW) * e, s.startH + (s.targetH - s.startH) * e];
    }

    // Pivot (0,0) is the buffer origin. Read the window, not the actor: in the
    // update phase the allocation can still be the pre-commit one.
    apply(s, now) {
        const f = s.win.get_frame_rect();
        if (f.width <= 0 || f.height <= 0) return;
        const b = s.win.get_buffer_rect();
        const [x, y, w, h] = this.visual(s, now);
        const sx = w / f.width, sy = h / f.height;
        s.actor.set_scale(sx, sy);
        s.actor.set_translation(x - b.x - (f.x - b.x) * sx, y - b.y - (f.y - b.y) * sy, 0);
        if (s.op0 !== null) {
            const k = Math.min(1, (now - (s.fadeT0 ?? now)) / 1000 / s.fadeMs);
            s.actor.set_opacity(Math.round(s.op0 + (255 - s.op0) * k));
        }
    }

    step() {
        const map = this.core._transformStates;
        if (!map) return;
        const now = GLib.get_monotonic_time();
        // Progress for the watchdog: a slowed-down ease outlasts its budget.
        if (this.core._animating) this.core._animProgressAt = Date.now();
        for (const s of [...map.values()]) {
            if (map.get(s.win) !== s) continue;
            // Gone, or fullscreen: nothing may transform it.
            if (!s.win.get_compositor_private() || s.win.is_fullscreen()) {
                this.finish(s);
                continue;
            }
            s.t0 ??= now;
            if (s.op0 !== null) s.fadeT0 ??= now;
            this.resendIfMoved(s);
            if (now - s.t0 >= s.dur * 1000) {
                // Answered (at the slot or a size of its own) or out of time;
                // without `sent` only the slot counts. An answer must be at
                // the slot's position: a commit for an abandoned Wayland
                // configure carries that position.
                const f = s.win.get_frame_rect();
                const near = r => Math.abs(f.x - r.x) <= 2 && Math.abs(f.y - r.y) <= 2 &&
                    Math.abs(f.width - r.w) <= 2 && Math.abs(f.height - r.h) <= 2;
                const atSlot = Math.abs(f.x - s.targetX) <= 2 && Math.abs(f.y - s.targetY) <= 2;
                if (near({ x: s.targetX, y: s.targetY, w: s.targetW, h: s.targetH }) ||
                    (s.sent && !near(s.sent) && atSlot) ||
                    now - s.t0 >= (s.dur + this.core.placement.scaledAnimMs(TRANSFORM_HOLD_MS)) * 1000) {
                    this.finish(s);
                    continue;
                }
                if (!s.done) {
                    s.done = true;
                    s.onLanded(s);
                    if (map.get(s.win) !== s) continue;
                }
            }
            this.apply(s, now);
        }
    }

    // Moved by something else (mutter centres a window configured before
    // map): send the configure again.
    resendIfMoved(s) {
        if (!s.sent) return;
        const f = s.win.get_frame_rect();
        if (f.width <= 0 || f.height <= 0) return;
        const at = (x, y) => Math.abs(f.x - x) <= 2 && Math.abs(f.y - y) <= 2;
        if (at(s.sent.x, s.sent.y) || at(s.targetX, s.targetY)) return;
        this.configure(s);
        const g = s.win.get_frame_rect();
        s.sent = { x: g.x, y: g.y, w: g.width, h: g.height };
    }

    reset(s) {
        // Closed on an inactive workspace: no close effect keeps the actor
        // alive, and touching it logs a Gjs-CRITICAL.
        if (s.win.get_compositor_private() !== s.actor) return;
        s.actor.set_scale(1, 1);
        s.actor.set_translation(0, 0, 0);
        if (s.op0 !== null) s.actor.set_opacity(255);
    }

    disconnectState(s) {
        if (s.sigToken) this.disconnectToken(s.sigToken);
        s.sigToken = null;
    }

    finish(s) {
        this.disconnectState(s);
        this.core._transformStates?.delete(s.win);
        this.reset(s);
        if (!s.done) {
            s.done = true;
            s.onLanded(s);
        }
    }

    // For code that moves or transforms the window itself (a grab, a float,
    // a regroup, unmanage): it lands where it is.
    release(win) {
        const s = this.core._transformStates?.get(win);
        if (s) this.finish(s);
    }

    running(workspace) {
        return [...(this.core._transformStates?.keys() ?? [])].some(w => w.get_workspace() === workspace);
    }

    // workspace: only its runs; only(win): only those windows'. keep: leave
    // windows drawn where they are and return their states for the replacing
    // run (snapping to identity jumps every moving window).
    stop(keep = false, workspace = null, only = null) {
        const carry = new Map();
        const map = this.core._transformStates;
        if (!map) return carry;
        const now = GLib.get_monotonic_time();
        for (const s of [...map.values()]) {
            if (workspace && s.win.get_workspace() !== workspace) continue;
            if (only && !only(s.win)) continue;
            this.disconnectState(s);
            map.delete(s.win);
            if (keep && s.win.get_compositor_private()) {
                s.visual = this.visual(s, now);
                carry.set(s.win, s);
            } else {
                this.reset(s);
            }
        }
        if (map.size === 0) this.stopTimeline();
        return carry;
    }

    // Live resize: the actor drawn over `draw` (default its slot) while its
    // client catches up; same mapping as apply(). The stretch owns the
    // transform (a resize during an animation).
    stretchActorToSlot(win, slot, draw = slot) {
        this.release(win);
        const actor = win.get_compositor_private();
        if (!actor || !this.core._liveStretched) return;
        const f = win.get_frame_rect();
        if (f.width <= 0 || f.height <= 0) return;
        const flush = Math.abs(f.x - draw.x) <= 1 && Math.abs(f.y - draw.y) <= 1 &&
            Math.abs(f.width - draw.w) <= 1 && Math.abs(f.height - draw.h) <= 1;
        // Drawn at its own frame: the release retile eases it into its slot.
        if (flush) {
            if (this.core._liveStretched.delete(win)) {
                actor.set_scale(1, 1);
                actor.set_translation(0, 0, 0);
            }
            return;
        }
        const b = win.get_buffer_rect();
        const sx = draw.w / f.width, sy = draw.h / f.height;
        const tx = draw.x - b.x - (f.x - b.x) * sx, ty = draw.y - b.y - (f.y - b.y) * sy;
        // Only a changing transform: each set_* queues a redraw.
        if (Math.abs(actor.scale_x - sx) > 1e-4 || Math.abs(actor.scale_y - sy) > 1e-4 ||
            Math.abs(actor.translation_x - tx) > 0.01 || Math.abs(actor.translation_y - ty) > 0.01) {
            actor.remove_all_transitions();
            actor.set_pivot_point(0, 0);
            actor.set_scale(sx, sy);
            actor.set_translation(tx, ty, 0);
        }
        // The slot, not the drawn rect: what the grab-end hand-off holds.
        this.core._liveStretched.set(win, slot);
    }

    // Grab end: windows still stretched stay over their slot as an arrived
    // ease for the release retile; reset, a lagging window would show its
    // stale size.
    handOffLiveStretch(grabbed) {
        const live = this.core._liveStretched;
        const sent = this.core._liveSent;
        this.core._liveStretched = null;
        this.core._liveSent = null;
        if (!grabbed) return;
        // Until now the grabbed window's size was mutter's.
        const g = live?.get(grabbed);
        if (g && grabbed.get_compositor_private())
            grabbed.move_resize_frame(true, g.x, g.y, g.w, g.h);
        // A neighbour last sent another rect than its slot is still owed it,
        // also one drawn flush at the slot with that rect still in flight
        // (the grabbed window was never sent one).
        for (const [win, e] of sent ?? []) {
            const r = e.slot;
            if (!r || win.get_workspace() !== grabbed.get_workspace() || !win.get_compositor_private()) continue;
            if (e.x !== r.x || e.y !== r.y || e.w !== r.w || e.h !== r.h)
                win.move_resize_frame(true, r.x, r.y, r.w, r.h);
        }
        if (!live || live.size === 0) return;
        const now = GLib.get_monotonic_time();
        const conn = this.core.monitors.windowConn(grabbed);
        const carry = this.takeOver(grabbed.get_workspace(), w => this.core.monitors.windowConn(w) === conn);
        const states = [];
        for (const [win, r] of live) {
            const actor = win.get_compositor_private();
            if (!actor) continue;
            const at = { startX: r.x, startY: r.y, startW: r.w, startH: r.h,
                targetX: r.x, targetY: r.y, targetW: r.w, targetH: r.h };
            // sent: null: every commit but the slot's answers a queued grab
            // configure.
            carry.set(win, { ...at, win, actor, t0: now, dur: 0, sent: null, op0: null,
                visual: [r.x, r.y, r.w, r.h] });
            states.push({ ...at, win });
        }
        this.run(states, () => {}, carry);
    }

    // stop(true) for code that draws the windows itself from here: the run
    // they belonged to counts them as landed, so it ends with its other
    // windows (another group's tick run keeps going).
    takeOver(workspace, only) {
        const carry = this.stop(true, workspace, only);
        for (const s of carry.values()) {
            if (s.done) continue;
            s.done = true;
            s.onLanded(s);
        }
        return carry;
    }

    // Disable or shutdown mid-resize: every stretched actor at identity.
    clearLiveStretch() {
        for (const win of this.core._liveStretched?.keys() ?? []) {
            const actor = win.get_compositor_private();
            if (!actor) continue;
            actor.set_scale(1, 1);
            actor.set_translation(0, 0, 0);
        }
        this.core._liveStretched = null;
        this.core._liveSent = null;
    }

    destroy() {
        this.clearLiveStretch();
        this.stop();
        this.stopTimeline();
        super.destroy();
    }
}
