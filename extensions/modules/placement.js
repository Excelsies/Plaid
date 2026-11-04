// Window placement, animation, landing verification, and the new-window
// spawn choreography. Methods live on this subsystem class.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { isBspLayout } from './helpers.js';

// Counted misses: per slot before it is accepted, and per window across
// slots (a layout that keeps moving the slot), reset when it lands.
const LANDING_RETRIES = 3;
const LANDING_MISSES = 9;

// A slot as a landing key: the frame it asks for, in whole pixels.
function landingKey(x, y, w, h) {
    return `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}

// --- Master-Stack Helpers ---

export class Placement {
    constructor(core) {
        this.core = core;
    }

    getAnimationTime() {
        // Do NOT gate on St.Settings.enable_animations — it can read false
        // even when the gsettings default is true (observed on llvmpipe
        // VMs), silently disabling every placement animation and the spawn
        // hide choreography. slow_down_factor is the accessibility lever.
        const stSettings = St.Settings.get();
        return 0.1 * Math.max(0.1, stSettings.slow_down_factor);
    }

    // A duration in ms at the user's animation speed (slow_down_factor).
    scaledAnimMs(ms) {
        return ms * this.getAnimationTime() * 10;
    }

    // Watchdog budget of a transform run: no progress for this long means a
    // completion was lost. Scaled with the animation time, so a slowed-down
    // run is not cut short.
    animStallBudget() {
        return 500 + 3 * this.getAnimationTime() * 1000;
    }

    // A tick run is over by its duration, so 800 ms from its start means a
    // missed completion; a transform run stalls when nothing advanced it for
    // the budget.
    animStalled(now = Date.now()) {
        if (this.core._animTransformRun)
            return now - this.core._animProgressAt > this.animStallBudget();
        return !!this.core._animStartedAt && now - this.core._animStartedAt > 800;
    }

    cancelAnimation() {
        if (this.core._animTickId) {
            GLib.source_remove(this.core._animTickId);
            this.core._animTickId = 0;
        }
        // Retire the run: its late callbacks must not clear _animating under
        // the next one.
        this.core._animGen = (this.core._animGen || 0) + 1;
        this.core.transforms.stop();
        if (this.core._newWindowSet) {
            for (const win of this.core._newWindowSet) {
                // A window can be disposed mid-animation; cleanup must continue.
                {
                    const a = win.get_compositor_private();
                    if (a) {
                        a.visible = true;
                        a.set_opacity(255);
                        a.remove_all_transitions();
                    }
                }
            }
        }
        // New X11 windows can be held hidden while the settle poll fixes their
        // restored geometry. Disabling mid-hold must not leave them invisible.
        if (this.core._windowWorkspaces) {
            for (const win of this.core._windowWorkspaces.keys()) {
                if (!win._plaidHoldReveal) continue;
                win._plaidHoldReveal = false;
                {
                    const a = win.get_compositor_private();
                    if (a) {
                        a.visible = true;
                        a.set_opacity(255);
                        a.remove_all_transitions();
                    }
                    const effect = this.core._windowMasks && this.core._windowMasks.get(win);
                    if (effect && effect.setOpacityUniform)
                        effect.setOpacityUniform(1);
                }
            }
        }
        this.core._animating = false;
        this.core._animTargets = null;
        this.core._animStates = null;
        if (this.core._queuedAnimWorkspaces && this.core._queuedAnimWorkspaces.size > 0) {
            const pending = [...this.core._queuedAnimWorkspaces];
            this.core._queuedAnimWorkspaces.clear();
            this.core.debugLog(`anim: cancelled, draining ${pending.length} queued retiles`);
            for (const ws of pending) this.core.signals.scheduleRetile(ws);
        }
    }

    revealHeldNewWindow(win, fadeDuration = 80) {
        // X11 clients can re-apply their remembered frame right after mapping
        // (Emacs restores a 2320x1467 frame). The new window is held invisible
        // until the settle poll has corrected that, so the oversized frame is
        // never shown; this reveals it at the real slot.
        if (!this.core._settings || !win || !win._plaidHoldReveal) return;
        win._plaidHoldReveal = false;
        {
            if (win._plaidInvisibleTimer) {
                GLib.source_remove(win._plaidInvisibleTimer);
                win._plaidInvisibleTimer = 0;
            }
            if (this.core._pendingWarp) this.core._pendingWarp.delete(win);
            const actor = win.get_compositor_private();
            if (actor) {
                actor.visible = true;
                actor.remove_all_transitions();
                actor.set_opacity(0);
                actor.ease({
                    opacity: 255,
                    duration: fadeDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => {
                        { if (actor.opacity < 255) actor.set_opacity(255); }
                    },
                });
            }
            const effect = this.core._windowMasks && this.core._windowMasks.get(win);
            if (effect && effect.setOpacityUniform)
                effect.setOpacityUniform(1);
        }
        this.core.signals.scheduleBorders();
        this.core.debugLog(`place: held reveal at slot for ${win.get_wm_class_instance() || '?'}`);
    }

    // animGen: the run placing it; a newer run places it instead.
    deferNewWindowPlacement(s, duration, done, animGen = this.core._animGen) {
        const fadeDuration = Math.min(duration, 80);
        const fadeIn = (holdForSettle = false) => {
            if (!this.core._settings) return;
            {
                const f = s.win.get_frame_rect();
                this.core.debugLog(`place: fading frame=(${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.width)},${Math.round(f.height)}) ` +
                    `target=(${Math.round(s.targetX)},${Math.round(s.targetY)},${Math.round(s.targetW)},${Math.round(s.targetH)})`);
            }
            const isX11 = this.core.bsp.isX11Client(s.win);
            const hold = holdForSettle && isX11;
            {
                const actor = s.win.get_compositor_private();
                if (actor && !hold) {
                    actor.visible = true;
                    // actor opacity is still 0 from the spawn hide — the
                    // ease below animates 0→255.
                }
            }
            // The window has landed — cancel the 2.5s backstop reveal so it
            // can't force-reveal a window that later moves to an inactive
            // workspace.
            if (s.win._plaidInvisibleTimer) {
                GLib.source_remove(s.win._plaidInvisibleTimer);
                s.win._plaidInvisibleTimer = 0;
            }
            // Revealing = leaving the pending-warp state NOW: the offscreen
            // mask multiplies the whole output (content AND border) by its
            // opacity uniform, so a window still in _pendingWarp paints
            // invisible even though the actor is visible. The frozen-frame
            // / give-up paths reach fadeIn WITHOUT the verified-landing
            // success branch (the only other place _pendingWarp is cleared),
            // so clear it here — the same block the backstop reveal uses.
            if (this.core._pendingWarp) this.core._pendingWarp.delete(s.win);
            {
                const effect = this.core._windowMasks && this.core._windowMasks.get(s.win);
                if (effect && effect.setOpacityUniform)
                    effect.setOpacityUniform(1);
            }
            // Settle window: some clients (Firefox's session restore) re-apply
            // their remembered geometry AFTER the placement. The size-changed
            // hook catches it when the event reaches us, but the event path
            // proved unreliable for this case (the journal showed only the
            // backstop ever correcting), so a fine-grained poll is the
            // dependable monitor: every 400ms for the 6s window, re-check
            // the slot with the tight tolerance + direct re-place. The
            // restore lands ~1-2s in → corrected within ~400ms of it (a
            // quick flicker, no multi-second wait). Cost: ~15 trivial ticks
            // per newly opened window, settle-window-only. The poll is NOT
            // stopped on the first in-slot tick — a restore landing between
            // ticks would be missed.
            const heldSlotOk = () => {
                const ws = s.win.get_workspace();
                if (!ws) return false;
                const mon = this.core.monitors.windowMon(s.win);
                if (mon < 0) return false;
                if (!this.core.monitors.groupPlaces(ws, mon)) return true;
                const layout = this.core.windows.getWorkspaceLayout(ws, mon);
                const gap = this.core._settings.get_int('inside-gap');
                const workArea = this.core.monitors.monitorWorkArea(ws, mon);
                if (!workArea || !workArea.width) return false;
                const slot = this.core.grab.windowSlotRect(s.win, ws, layout, workArea, gap);
                if (!slot) return false;
                const f = s.win.get_frame_rect();
                return Math.abs(f.x - slot.x) <= 4 && Math.abs(f.y - slot.y) <= 4 &&
                    Math.abs(f.width - slot.w) <= 4 && Math.abs(f.height - slot.h) <= 4;
            };
            const revealHeld = () => {
                if (!this.core._settings || !s.win || !s.win._plaidHoldReveal) return;
                this.revealHeldNewWindow(s.win, fadeDuration);
            };
            s.win._plaidSettleUntil = Date.now() + 6000;
            if (s.win._plaidSettlePollId) {
                GLib.source_remove(s.win._plaidSettlePollId);
                s.win._plaidSettlePollId = 0;
            }
            s.win._plaidSettlePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                const w = s.win;
                if (!this.core._settings || !w || !w.get_compositor_private() ||
                    !this.core._windowWorkspaces || !this.core._windowWorkspaces.has(w)) {
                    if (w) w._plaidSettlePollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                if (!w._plaidSettleUntil || Date.now() > w._plaidSettleUntil) {
                    w._plaidSettlePollId = 0;
                    this.settleEnded(w, heldSlotOk());
                    return GLib.SOURCE_REMOVE;
                }
                { this.core.grab.maybeReassertSlot(w, 4, 'direct'); }
                if (w._plaidHoldReveal && heldSlotOk()) revealHeld();
                return GLib.SOURCE_CONTINUE;
            });
            this.core.signals.scheduleBorders();
            let faded = false;
            const finishFade = () => {
                if (!this.core._settings) return;
                if (!faded) {
                    faded = true;
                    // The ease can be cancelled by another move/retile. Make
                    // the fallback restore the final state instead of only
                    // signalling completion, or the window stays see-through.
                    if (!(this.core._pendingWarp && this.core._pendingWarp.has(s.win))) {
                        const a = s.win.get_compositor_private();
                        if (a) {
                            a.visible = true;
                            a.set_opacity(255);
                        }
                        const effect = this.core._windowMasks && this.core._windowMasks.get(s.win);
                        if (effect && effect.setOpacityUniform)
                            effect.setOpacityUniform(1);
                    }
                    done();
                }
            };
            if (hold) {
                s.win._plaidHoldReveal = true;
                this.core.debugLog(`place: holding reveal until settle (${s.win.get_wm_class_instance() || '?'})`);
                // Hard backstop: if the client keeps fighting the slot (or the
                // poll cannot read a settled frame), never leave it invisible.
                this.core.signals.addTimeout(1200, () => {
                    if (!this.core._settings) return GLib.SOURCE_REMOVE;
                    this.revealHeldNewWindow(s.win, fadeDuration);
                    return GLib.SOURCE_REMOVE;
                });
                // The window stays hidden, but the animation pipeline must not
                // stay blocked while the settle poll corrects the client.
                done();
                return;
            }
            {
                const actor = s.win.get_compositor_private();
                if (actor) {
                    actor.ease({ opacity: 255, duration: fadeDuration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: finishFade });
                    this.core.signals.addTimeout(fadeDuration + 100, finishFade);
                    return;
                }
            }
            finishFade();
        };
        let tries = 0;
        let lastFrameKey = null;
        let sameFrameCount = 0;
        const attempt = () => {
            if (!this.core._settings || animGen !== this.core._animGen) return;
            this.core._animProgressAt = Date.now();
            {
                if (!s.win || !s.win.get_compositor_private()) {
                    done();
                    return;
                }
                s.win.move_resize_frame(true, s.targetX, s.targetY, s.targetW, s.targetH);
            }
            let frameKey = null;
            {
                const f = s.win.get_frame_rect();
                frameKey = `${f.x},${f.y},${f.width},${f.height}`;
                this.core.debugLog(`place: moved frame=(${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.width)},${Math.round(f.height)}) ` +
                    `target=(${Math.round(s.targetX)},${Math.round(s.targetY)},${Math.round(s.targetW)},${Math.round(s.targetH)})`);
            }
            if (this.verifyAnimationLanding(s, 'new', true)) {
                this.core.debugLog(`place: attempt ${tries} verified — fading at target`);
                fadeIn(true);
            } else if (this.landingAccepted(s.win, s.targetX, s.targetY, s.targetW, s.targetH)) {
                this.core.debugLog('place: slot accepted — fading');
                fadeIn();
            } else {
                // Bounded: the pure landing verify never accepts a slot, so
                // an endless retry here would wedge the whole
                // animation pipeline (_animating stays true, later retiles
                // queue forever, new windows sit hidden until the reveal
                // timer pops them at the center). Give up after ~1.5s and
                // finish at the target regardless.
                tries++;
                this.core.debugLog(`place: attempt ${tries} mismatch`);
                // Provably-ignored move: the frame is byte-identical across
                // consecutive attempts while the verify keeps failing —
                // mutter/Qt are not honoring geometry ops at all (the
                // map-time settling race; the goverlay trace
                // burned all 16 retries on a frozen frame, keeping the
                // window invisible ~1.7s for nothing). Stop retrying and
                // take the give-up path NOW: reveal at the spawn geometry,
                // then the settle poll + the 2s re-retile land it the
                // moment mutter wakes up. Windows whose frame MOVES between
                // attempts keep the full budget and stay hidden — normal
                // placement polish is unchanged.
                if (frameKey !== null && frameKey === lastFrameKey) {
                    sameFrameCount++;
                } else {
                    sameFrameCount = 0;
                }
                lastFrameKey = frameKey;
                const frozen = sameFrameCount >= 2;
                if (tries > 15 || frozen) {
                    this.core.debugLog(frozen
                        ? `anim: new-window placement frozen after ${tries} identical frames — finishing at spawn`
                        : 'anim: new-window placement gave up after retries — finishing at target');
                    {
                        if (s.win && s.win.get_compositor_private())
                            s.win.move_resize_frame(true, s.targetX, s.targetY, s.targetW, s.targetH);
                    }
                    fadeIn();
                    // Self-healing settle re-request: a fresh window's
                    // move_resize_frame can be ignored/clamped by mutter
                    // while it is still settling (map-time race, or the
                    // shadow buffer wider than the screen), so all attempts
                    // fail. By ~2s the window has settled and a normal
                    // retile lands (the "second app fixes it" effect,
                    // automated). One shot; the reveal above already
                    // happened, so the window never sits hidden.
                    const settleWin = s.win;
                    this.core.signals.addTimeout(2000, () => {
                        if (!this.core._settings) return GLib.SOURCE_REMOVE;
                        if (!settleWin || !settleWin.get_compositor_private()) return GLib.SOURCE_REMOVE;
                        if (!this.core._windowWorkspaces || !this.core._windowWorkspaces.has(settleWin))
                            return GLib.SOURCE_REMOVE;
                        const ws = settleWin.get_workspace();
                        if (ws) this.core.layouts.retileWorkspace(ws);
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                this.core.signals.addTimeout(100, attempt);
            }
        };
        this.core.signals.addTimeout(80, attempt);
    }

    checkWorkspaceLandings(ws) {
        if (!this.core._settings || this.core._shuttingDown || !this.core._settings.get_boolean('enabled')) return;
        if (this.core._grabOp) return;
        const gap = this.core._settings.get_int('inside-gap');
        let off = 0;
        let count = 0;
        for (const mon of this.core.monitors.tiledMonitors()) {
            if (!this.core.monitors.groupPlaces(ws, mon)) continue;
            const layout = this.core.windows.getWorkspaceLayout(ws, mon);
            const tiled = this.core.monitors.getWindowsForGroup(ws, mon).filter(w => !this.core.windows.isFloating(w));
            if (tiled.length === 0) continue;
            const workArea = this.core.monitors.monitorWorkArea(ws, mon);
            if (!workArea || workArea.width === 0) continue;
            count += tiled.length;
            for (const win of tiled) {
                if (win.minimized || win.is_fullscreen()) continue;
                if (this.hasAcceptedLanding(win)) continue;
                const slot = this.core.grab.windowSlotRect(win, ws, layout, workArea, gap);
                if (!slot) continue;
                const f = win.get_frame_rect();
                if (Math.abs(f.x - slot.x) > 16 || Math.abs(f.y - slot.y) > 16 ||
                    Math.abs(f.width - slot.w) > 16 || Math.abs(f.height - slot.h) > 16)
                    off++;
            }
        }
        if (off > 0) {
            this.core.debugLog(`landing check: ws re-tiled (${off}/${count} windows off-slot)`);
            this.core.signals.scheduleRetile(ws);
        }
    }

    adjustPinnedTree(win, ws) {
        // Convergence guard: when min-size constraints can't fit the
        // partition, re-splitting just flips the layout back and forth
        // (steam 1364x810 + friends 306x540 + several windows). Bound the
        // adjustments per group so the layout settles on a stable
        // partition instead of oscillating forever.
        const mon = win ? this.core.monitors.windowMon(win) : -1;
        if (mon < 0) return;
        const idx = this.core.monitors.groupKey(ws, mon);
        const now = Date.now();
        let rec = this.core._pinnedAdjustCounts.get(idx);
        if (!rec || now - rec.since > 2000) {
            rec = { count: 0, since: now };
            this.core._pinnedAdjustCounts.set(idx, rec);
        }
        rec.count++;
        if (rec.count > 4) {
            this.core.debugLog(`pinned adjust: ws=${idx} gave up after ${rec.count} adjustments`);
            return;
        }
        try {
            if (!win || !ws) return;
            if (!this.core.monitors.groupPlaces(ws, mon)) return;
            const layout = this.core.windows.getWorkspaceLayout(ws, mon);
            const gap = this.core._settings.get_int('inside-gap');
            const workArea = this.core.monitors.monitorWorkArea(ws, mon);
            if (!workArea || workArea.width === 0) return;
            const area = this.core.geometry.outsideArea(workArea);
            if (!area) return;
            const areaW = area.w;
            const areaH = area.h;
            const f = win.get_frame_rect();
            const min = this.core.bsp.getWindowMinSize(win);
            const minSrc = min.w > 0 || min.h > 0 ? `min=${min.w}x${min.h}` : 'min=none';
            let changed = false;
            if (isBspLayout(layout)) {
                const tree = this.core.bsp.bspGetTree(ws, mon);
                if (!tree) return;
                changed = this.core.bsp.adjustForConstraints(tree, null, true, area.x, area.y, areaW, areaH, gap, 0);
            } else if (layout === 'master-stack' || layout === 'centered-master-stack') {
                const tiled = this.core.monitors.getWindowsForGroup(ws, mon).filter(w => !this.core.windows.isFloating(w));
                if (tiled.length < 2) return;
                if (win === tiled[0]) {
                    const basis = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;
                    if (basis > 0) {
                        const ratio = this.core.layouts.getMasterRatio(ws, mon);
                        const nr = Math.min(0.95, Math.max(ratio, f.width / basis));
                        if (nr !== ratio) {
                            this.core._masterRatios.set(this.core.monitors.groupKey(ws, mon), nr);
                            changed = true;
                        }
                    }
                } else {
                    const idx = tiled.indexOf(win) - 1;
                    const stackRatios = this.core.layouts.getStackRatios(ws, mon);
                    const numStack = tiled.length - 1;
                    const totalStackH = areaH - gap * (numStack - 1);
                    if (totalStackH > 0 && idx >= 0) {
                        let total = 0;
                        const weights = [];
                        for (let i = 0; i < numStack; i++) {
                            const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
                            weights.push(w);
                            total += w;
                        }
                        const curH = total > 0 ? Math.floor(totalStackH * weights[idx] / total) : 0;
                        if (curH > 0 && f.height > curH + 1) {
                            stackRatios.set(idx, weights[idx] * (f.height / curH));
                            changed = true;
                        }
                    }
                }
            } else {
                return;
            }
            // Report and persist ONLY on a real ratio change: the old
            // unconditional log claimed "bent" even when every clamp was a
            // no-op (it misled the triage).
            if (!changed) return;
            this.core.debugLog(`constraint: pinned frame ${Math.round(f.width)}x${Math.round(f.height)} bent the split ratio (${minSrc})`);
            this.core.persistence.scheduleSaveLayouts();
        } catch (e) {
            // The whole bend used to be swallowed silently — any exception
            // (e.g. a finalized window's get_frame_rect) killed the min-size
            // bend with zero trace while the window sat off-slot.
            this.core.debugLog(`pinned adjust failed: ${e.message}`);
        }
    }

    verifyAnimationLanding(s, kind, pure = false) {
        if (this.core._grabOp) return false;
        const win = s.win;
        if (!win || !win.get_compositor_private()) {
            if (!pure)
                this.core.debugLog(`anim: landing skipped (window gone) ${kind} id=${win ? win.get_id() : '?'}`);
            return false;
        }
        const accepted = this.landingAccepted(win, s.targetX, s.targetY, s.targetW, s.targetH);
        // An accepted slot ends when the layout gives the window another.
        if (!accepted) this.landingSlotChanged(win);
        const f = win.get_frame_rect();
        // The deferred new-window placement must land PRECISELY (pure
        // mode): the 16px tolerance silently accepted off-landings like
        // mutter's shadow-clamped frame (8px x-offset) and never
        // re-requested, leaving the window at wrong screen gaps. The
        // animated tick path keeps 16px — sliding frames.
        const tol = kind === 'new' && pure ? 4 : 16;
        if (Math.abs(f.x - s.targetX) > tol || Math.abs(f.y - s.targetY) > tol ||
            Math.abs(f.width - s.targetW) > tol || Math.abs(f.height - s.targetH) > tol) {
            // An accepted slot is not retried; landing on it still counts.
            if (accepted) return false;
            if (!pure) {
                this.core.debugLog(`anim: landing mismatch (${kind}) ${win.get_wm_class_instance() || '?'} id=${win.get_id()} minimized=${win.minimized} ` +
                    `frame=(${f.x},${f.y},${f.width},${f.height}) target=(${s.targetX},${s.targetY},${s.targetW},${s.targetH})`);
                {
                    const mws = win.get_workspace();
                    if (mws) {
                        const tree = this.core.bsp.bspGetTree(mws, this.core.monitors.windowMon(win));
                        const min = this.core.bsp.getWindowMinSize(win);
                        if (tree)
                            this.core.debugLog(`diag: tree=${JSON.stringify(tree)} min=${min.w}x${min.h}`);
                    }
                }
                const prev = this.landingFrame(win, f);
                const refusesShrink = f.width > s.targetW + 16 || f.height > s.targetH + 16;
                // A settling client can re-apply its remembered geometry
                // after placement (XWayland Emacs: 1936x1185). That is not a
                // minimum-size refusal — learning it as one bent the dwindle
                // ratio to the client's own frame and persisted the result.
                // Wait out the settle window; stable clients still bend
                // through the normal retry path afterwards.
                const settling = !!(win._plaidSettleUntil && win._plaidSettleUntil > Date.now());
                if (!settling && !this.mutterSized(win) && prev && refusesShrink &&
                    Math.abs(f.x - prev.x) <= 1 && Math.abs(f.y - prev.y) <= 1 &&
                    Math.abs(f.width - prev.w) <= 1 && Math.abs(f.height - prev.h) <= 1) {
                    this.recordObservedMin(win, f, { w: s.targetW, h: s.targetH });
                    this.adjustPinnedTree(win, win.get_workspace());
                }
                this.retryLanding(win, s, settling);
            }
            return false;
        } else {
            this.releaseLanding(win);
            if (this.core._pendingWarp && this.core._pendingWarp.has(win)) {
                this.core._pendingWarp.delete(win);
                this.core.windows.moveCursorToWindow(win);
                // The window has landed — cancel the 2.5s backstop reveal
                // (it must not force-reveal a window that later moves to
                // an inactive workspace) and re-attach flair that the
                // pending-warp state skipped.
                //
                // The settle poll is deliberately NOT cancelled here:
                // this function also runs on the 'tiled' verify path of
                // every animated retile, where killing an armed settle
                // poll would silently skip the client-resize correction
                // for windows whose slot was accepted. The poll self-expires at 6s.
                if (win._plaidInvisibleTimer) {
                    GLib.source_remove(win._plaidInvisibleTimer);
                    win._plaidInvisibleTimer = 0;
                }
                this.core.signals.scheduleBorders();
                this.core.borders.updateBorders();
            }
            return true;
        }
    }

    // A maximized or side-tiled frame is mutter's size, not the client's:
    // learning or bending to it would keep the window from fitting a slot again.
    mutterSized(win) {
        return !!(win.get_maximize_flags && win.get_maximize_flags() !== 0);
    }

    recordObservedMin(win, frame, target) {
        // The window is stable at a size larger than its slot: it refused to
        // shrink. Remember that floor so the next partition allocates a slot it
        // will actually take (apps such as ghostty report no min width, so
        // get_min_size() can't tell us).
        if (!this.core._observedMinSizes || !win) return;
        if (this.mutterSized(win)) return;
        const cur = this.core._observedMinSizes.get(win) || { w: 0, h: 0 };
        let w = cur.w;
        let h = cur.h;
        if (frame.width > target.w + 16) w = Math.max(w, Math.round(frame.width));
        if (frame.height > target.h + 16) h = Math.max(h, Math.round(frame.height));
        // Cap at half the work area: a single window can never need more than
        // that as a minimum, and it stops one bogus sample (a resize mutter
        // ignored) from starving the window for the rest of the session.
        // Its group's monitor (the primary while that monitor is gone).
        {
            const ws = win.get_workspace();
            const mon = this.core.monitors.windowMon(win);
            const wa = ws && this.core.monitors.monitorWorkArea(ws, mon >= 0 ? mon : this.core.monitors.primaryMon());
            if (wa) {
                w = Math.min(w, Math.ceil(wa.width / 2));
                h = Math.min(h, Math.ceil(wa.height / 2));
            }
        }
        if (w === cur.w && h === cur.h) return;
        this.core._observedMinSizes.set(win, { w, h });
        this.core.debugLog(`min-learned: ${w}x${h} for ${win.get_wm_class_instance() || '?'}`);
    }

    // One landing record per window: the current slot's key and misses, the
    // window's miss total across slots, the accepted slot, and the last
    // mismatched frame. Transitions: miss, accept, slot change, frame; land
    // and close drop it (releaseLanding).
    landingRecord(win) {
        const records = this.core._landings;
        if (!records || !win) return null;
        let rec = records.get(win);
        if (!rec) {
            rec = { key: null, n: 0, total: 0, accepted: null, frame: null };
            records.set(win, rec);
        }
        return rec;
    }

    // A counted miss on the slot `key`: another slot starts a fresh count.
    landingMiss(win, key) {
        const rec = this.landingRecord(win);
        if (!rec) return null;
        rec.n = (rec.key === key ? rec.n : 0) + 1;
        rec.total++;
        rec.key = key;
        return rec;
    }

    // The window stays at this slot; its total still counts.
    landingAccept(win, key) {
        const rec = this.landingRecord(win);
        if (!rec) return;
        rec.key = key;
        rec.n = 0;
        rec.accepted = key;
        rec.frame = null;
    }

    landingSlotChanged(win) {
        const rec = this.core._landings?.get(win);
        if (rec) rec.accepted = null;
    }

    // Records the mismatched frame and returns the previous one.
    landingFrame(win, f) {
        const rec = this.landingRecord(win);
        if (!rec) return null;
        const prev = rec.frame;
        rec.frame = { x: f.x, y: f.y, w: f.width, h: f.height };
        return prev;
    }

    hasAcceptedLanding(win) {
        const rec = this.core._landings?.get(win);
        return !!rec && rec.accepted !== null;
    }

    // Landed, closed, or out of the scratchpad: the record goes.
    releaseLanding(win) {
        if (!win) return;
        if (this.core._landings) this.core._landings.delete(win);
    }

    // The window was left at this slot after its retries; another slot
    // gets a fresh budget while the window's total allows it.
    landingAccepted(win, x, y, w, h) {
        const rec = this.core._landings?.get(win);
        return !!rec && rec.accepted !== null && rec.accepted === landingKey(x, y, w, h);
    }

    // The settle window closed: its hints count from here on, and so does a
    // miss. A window off its slot retiles its workspace once.
    settleEnded(win, inSlot) {
        if (inSlot || !this.core._settings) return;
        const ws = win.get_workspace();
        if (ws) this.core.layouts.retileWorkspace(ws);
    }

    retryLanding(win, s, settling = false) {
        if (!this.core._landings || !this.core._settings || !win) return;
        if (!win.get_compositor_private()) {
            this.core.debugLog(`anim: landing retry skipped (window gone) id=${win.get_id()}`);
            return;
        }
        // While it settles the poll re-asserts the slot and its end retiles;
        // a miss there is not counted.
        if (settling) return;
        const key = landingKey(s.targetX, s.targetY, s.targetW, s.targetH);
        const { n, total } = this.landingMiss(win, key);
        if (n > LANDING_RETRIES || total > LANDING_MISSES) {
            // Never floated: the window keeps its leaf, and its slot is not
            // re-requested until the layout gives it another.
            this.landingAccept(win, key);
            // Clear the pending-warp state so a masked window is never left
            // invisible: an accepted slot makes every later
            // verifyAnimationLanding return false, so the success branch
            // that clears _pendingWarp does not run for it, and the mask
            // uniform stays at 0 (the whole output multiplied by it — no
            // content, no border) until a title/wm-class notify or close.
            // Mirror the backstop-reveal block.
            if (this.core._pendingWarp) this.core._pendingWarp.delete(win);
            {
                const a = win.get_compositor_private();
                if (a) {
                    a.visible = true;
                    a.set_opacity(255);
                }
            }
            {
                const effect = this.core._windowMasks && this.core._windowMasks.get(win);
                if (effect && effect.setOpacityUniform)
                    effect.setOpacityUniform(1);
            }
            this.core.signals.scheduleBorders();
            const f = win.get_frame_rect();
            this.core.debugLog(`anim: landing accepted after retries for ${win.get_wm_class_instance() || '?'} id=${win.get_id()} ` +
                `frame=${Math.round(f.width)}x${Math.round(f.height)} slot=${Math.round(s.targetW)}x${Math.round(s.targetH)}`);
            return;
        }
        this.core.signals.addTimeout(200, () => {
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            if (this.hasAcceptedLanding(win)) return GLib.SOURCE_REMOVE;
            // Window-liveness: _removeWindow prunes the landing state on
            // close, so that guard no longer covers a window closed within
            // this 200ms window — touching a finalized Meta.Window here
            // throws inside the source callback.
            if (!win.get_compositor_private()) return GLib.SOURCE_REMOVE;
            const ws = win.get_workspace();
            if (ws) {
                this.core.debugLog(`anim: landing retry ${n} for ${win.get_wm_class_instance() || '?'} id=${win.get_id()} minimized=${win.minimized}`);
                this.core.layouts.retileWorkspace(ws);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // groups: [{mon, tiled, layout, places}] (layouts.doRetileWorkspace),
    // every group in one run; places is monitors.groupPlaces' answer.
    animRetile(workspace, groups) {
        const tiledWindows = groups.flatMap(g => g.tiled);
        if (!this.core._settings || this.core._shuttingDown) {
            this.core._animating = false;
            return;
        }
        if (this.core._animating) {
            // Stall watchdog: the in-flight animation's completion signal
            // can be missed (interrupted transitions, destroyed windows).
            // If it has not completed within a generous budget, force-finish
            // so queued retiles keep running instead of wedging forever.
            if (this.animStalled()) {
                // Teardown the in-flight animation BEFORE starting a new
                // one: the watchdog previously just cleared _animating and
                // drained the queue, leaving the 16ms tick alive — the new
                // animation then overwrote _animTickId without removing the
                // old source, so BOTH ticks ran concurrently on the same
                // _animStates (double dec(), spurious landing verifies,
                // one leaked GLib source per occurrence; live at
                // slow-down-factor 8 where 800ms animations sit exactly on
                // the watchdog budget).
                if (this.core._animTickId) {
                    GLib.source_remove(this.core._animTickId);
                    this.core._animTickId = 0;
                }
                // The run below retires the stalled one; its workspace is
                // retiled again for the new windows it has not placed.
                this.core._animStates = null;
                this.core._animTargets = null;
                this.core._animWindows = null;
                this.core._animating = false;
                if (this.core._animWorkspace && this.core._animWorkspace !== workspace)
                    this.core._queuedAnimWorkspaces.add(this.core._animWorkspace);
                const pending = [...this.core._queuedAnimWorkspaces];
                this.core._queuedAnimWorkspaces.clear();
                this.core.debugLog(`anim: watchdog drained stalled queue (${pending.length})`);
                for (const ws of pending) this.core.signals.scheduleRetile(ws);
            } else {
                this.core._queuedAnimWorkspaces.add(workspace);
                this.core.debugLog(`anim: retile queued while animating (queue=${this.core._queuedAnimWorkspaces.size})`);
                return;
            }
        }
        const animGen = ++this.core._animGen;
        this.core._animWorkspace = workspace;
        this.core._animStartedAt = Date.now();
        this.core._animProgressAt = this.core._animStartedAt;
        this.core._animTransformRun = false;

        this.core._animTargets = new Map();

        for (const { mon, tiled, layout, places } of groups) {
            if (!places) {
                // GNOME owns placement there (a floating layout, or a monitor
                // that does not tile); the fade-in choreography just anchors
                // at the window's current (GNOME-placed) position.
                for (const win of tiled) {
                    if (!this.core._newWindowSet.has(win)) continue;
                    const f = win.get_frame_rect();
                    if (f.width > 0 && f.height > 0)
                        this.core._animTargets.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
                }
            } else if (isBspLayout(layout))
                this.core.layouts.retileDwindle(workspace, tiled, mon);
            else if (layout === 'centered-master-stack')
                this.core.layouts.retileCenteredMasterStack(workspace, tiled, null, mon);
            else
                this.core.layouts.retileMasterStack(workspace, tiled, null, mon);
        }

        if (this.core._animTargets.size === 0) {
            this.core.debugLog('anim: no targets (bail)');
            this.core._animTargets = null;
            this.core._animWindows = null;
            for (const win of tiledWindows) this.core._newWindowSet.delete(win);
            this.core.signals.scheduleBorders();
            return;
        }

        this.core._animating = true;
        const animTime = this.getAnimationTime();
        const duration = animTime * 1000;

        const states = [];
        for (const [win, target] of this.core._animTargets) {
            if (!win || win.is_fullscreen() || !win.get_workspace()) continue;
            const frame = win.get_frame_rect();
            const actor = win.get_compositor_private();
            const isNew = this.core._newWindowSet.has(win);
            this.core.debugLog(`anim: start ws=${this.core.geometry.wsIndex(workspace)} win=${win.get_wm_class_instance() || '?'} new=${isNew} ` +
                `target=(${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.w)},${Math.round(target.h)})`);
            states.push({ win, actor, isNew, startX: frame.x, startY: frame.y, startW: frame.width, startH: frame.height, targetX: target.x, targetY: target.y, targetW: target.w, targetH: target.h });
        }
        this.core._animTargets = null;
        this.core._animWindows = new Set(states.map(s => s.win));

        let remaining = states.length;
        if (remaining === 0) { this.core._animating = false; this.core._animWindows = null; return; }

        const dec = () => {
            // A retired run must not finish its replacement.
            if (!this.core._newWindowSet || animGen !== this.core._animGen) return;
            this.core._animProgressAt = Date.now();
            remaining--;
            if (remaining <= 0) {
                this.core._animating = false;
                this.core._animWindows = null;
                this.core.debugLog(`anim: done ws=${this.core.geometry.wsIndex(workspace)} queued=${this.core._queuedAnimWorkspaces.size}`);
                for (const w of tiledWindows) this.core._newWindowSet.delete(w);
                this.core._animStates = null;
                this.core.persistence.scheduleSaveLayouts();
                this.core.signals.scheduleBorders();
                if (this.core._queuedAnimWorkspaces.size > 0) {
                    const pending = [...this.core._queuedAnimWorkspaces];
                    this.core._queuedAnimWorkspaces.clear();
                    for (const ws of pending) this.core.signals.scheduleRetile(ws);
                }
            }
        };

        const newStates = states.filter(s => s.isNew);
        const existingStates = states.filter(s => !s.isNew);

        // New windows: init opacity and animate later
        for (const s of newStates) {
            if (s.actor) {
                s.actor.remove_all_transitions();
                s.actor.set_opacity(0);
                // No show() here — a new window hidden via actor.visible=false
                // must stay invisible until the placement reveals it at its
                // slot.
            }
        }

        if (existingStates.length > 0) {
            this.core._animStates = existingStates;
            this.core._animStartTime = Date.now();
            this.core._animTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                if (!this.core._settings) { this.core._animTickId = 0; return GLib.SOURCE_REMOVE; }
                if (!this.core._animStates) { this.core._animTickId = 0; this.core._animating = false; return GLib.SOURCE_REMOVE; }
                const elapsed = Date.now() - this.core._animStartTime;
                const t = Math.min(elapsed / duration, 1);
                const e = 1 - Math.pow(1 - t, 3);
                for (const s of this.core._animStates) {
                    // Regrouped mid-run: mutter put it on another monitor.
                    if (s.regrouped || !s.win.get_compositor_private()) continue;
                    const x = s.startX + (s.targetX - s.startX) * e;
                    const y = s.startY + (s.targetY - s.startY) * e;
                    const w = s.startW + (s.targetW - s.startW) * e;
                    const h = s.startH + (s.targetH - s.startH) * e;
                    this.tickConfigure(s.win, Math.round(x), Math.round(y), Math.round(w), Math.round(h), s);
                }
                if (t >= 1) {
                    this.core._animTickId = 0;
                    this.core._animStates = null;
                    for (const s of existingStates) {
                        if (s.regrouped || !s.win.get_compositor_private()) { dec(); continue; }
                        this.tickConfigure(s.win, s.targetX, s.targetY, s.targetW, s.targetH, s);
                        this.verifyAnimationLanding(s, 'tiled');
                        dec();
                    }
                    // Now fade in new windows (placement + fade handled deferred)
                    for (const s of newStates) {
                        if (s.actor) {
                            this.deferNewWindowPlacement(s, duration, dec, animGen);
                        } else {
                            dec();
                        }
                    }
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            // Only new windows — fade them in after the deferred placement
            for (const s of newStates) {
                if (s.actor) {
                    this.deferNewWindowPlacement(s, duration, dec, animGen);
                } else {
                    dec();
                }
            }
        }
    }

    // run: the state it animates (its target is where the run ends). Recorded
    // first: crossing a monitor, the move emits window-entered-monitor before
    // it returns (monitors.ownMoveInFlight).
    tickConfigure(win, x, y, w, h, run) {
        this.core.monitors.recordTick(win, x, y, run);
        win.move_resize_frame(true, x, y, w, h);
    }

    animFloat(win, x, y, w, h) {
        const animTime = this.getAnimationTime();
        if (animTime <= 0) {
            this.core.windows.moveWindow(win, x, y, w, h);
            return;
        }
        const actor = win.get_compositor_private();
        if (!actor) {
            this.core.windows.moveWindow(win, x, y, w, h);
            return;
        }
        this.core.transforms.release(win);
        const frame = win.get_frame_rect();
        { win.move_resize_frame(true, x, y, w, h); }
        actor.remove_all_transitions();
        actor.set_translation(0, 0, 0);
        actor.set_scale(1, 1);
        const scaleX = frame.width > 0 ? frame.width / w : 1;
        const scaleY = frame.height > 0 ? frame.height / h : 1;
        actor.set_pivot_point(0, 0);
        actor.set_translation(frame.x - x, frame.y - y, 0);
        actor.set_scale(scaleX, scaleY);
        actor.show();
        const props = { duration: animTime * 1000, mode: Clutter.AnimationMode.EASE_OUT_CUBIC };
        props.translation_x = 0;
        props.translation_y = 0;
        if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
            props.scale_x = 1;
            props.scale_y = 1;
        }
        // Mark Plaid's own resize animation so the blur suppression does not
        // mistake this deliberate scale for an external fly-in (which would
        // flash the blur off while growing a window).
        win._plaidFloatAnim = true;
        props.onStopped = () => { win._plaidFloatAnim = false; };
        actor.ease(props);
    }

    destroy() {
        this.cancelAnimation();
        this.core._animating = false;
        if (this.core._windowWorkspaces) {
            for (const win of this.core._windowWorkspaces.keys()) {
                if (win._plaidSettlePollId) {
                    GLib.source_remove(win._plaidSettlePollId);
                    win._plaidSettlePollId = 0;
                }
            }
        }
    }
}
