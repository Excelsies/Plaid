// Super + scroll while dragging: carry the dragged window to the next or
// previous workspace. A move grab holds a Clutter grab, so the shell's own
// Super+scroll switcher never sees the scroll; an event filter, installed
// for the move grab only, still does.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { PlaidSubsystem } from './subsystem.js';

// One step per throttle (a wheel spin is a burst of notches); SLIDE_MS is
// the shell's slide, used when its progress cannot be read.
const THROTTLE_MS = 300;
const SLIDE_MS = 250;

export class DragScroll extends PlaidSubsystem {
    constructor(core) {
        super(core);
        this._filterId = 0;
        this._win = null;
        this._lastStep = 0;
        this._holdUntil = 0;
        this._slide = null;
        this._shellWarned = false;
    }

    begin(win, grabOp) {
        this.end();
        if (!win || !this.core._settings || this.core._shuttingDown) return;
        if (!this.core.grab.isMoveGrab(grabOp) || !this.enabled()) return;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
        if (win.is_on_all_workspaces() || win.is_skip_taskbar()) return;
        // A tiled window only while Plaid tracks the grab (_grabOp): that
        // keeps the move's retiles from configuring it.
        if (this.core._grabOp === null && !this.core.windows.isFloating(win)) return;
        this._filterId = Clutter.Event.add_filter(global.stage, event => this.onEvent(event));
        this._win = win;
    }

    // The one remover: grab end, destroy and shell shutdown all end here.
    end() {
        if (this._filterId) {
            Clutter.Event.remove_filter(this._filterId);
            this._filterId = 0;
        }
        this._win = null;
        this._lastStep = 0;
        this._holdUntil = 0;
        this._slide = null;
    }

    // Read live: turning any of these off mid-drag stops the next step.
    enabled() {
        const s = this.core._settings;
        return s.get_boolean('enabled') && s.get_boolean('mouse-resize') &&
            s.get_boolean('drag-scroll-workspace');
    }

    // A move grab is being watched for Super + scroll.
    active() {
        return !!this._win;
    }

    // The window being dragged is on `ws`: a focus restore there would
    // raise another window over it.
    carrying(ws) {
        return !!this._win && this._win.get_workspace() === ws;
    }

    onEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this.releaseDuringSlide();
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.SCROLL) return Clutter.EVENT_PROPAGATE;
        const win = this._win;
        if (!win || !this.core._settings || this.core._shuttingDown) return Clutter.EVENT_PROPAGATE;
        if (!this.enabled()) return Clutter.EVENT_PROPAGATE;
        // The shell's window-drag modifier (mouse-button-modifier).
        const mods = global.display.compositor_modifiers || Clutter.ModifierType.MOD4_MASK;
        if ((event.get_state() & mods) !== mods) return Clutter.EVENT_PROPAGATE;
        // Discrete steps only: mutter emulates each stream from the other, so
        // the discrete one counts every gesture once. Smooth events are
        // swallowed.
        let step;
        switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
                step = 1;
                break;
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
                step = -1;
                break;
            default:
                return Clutter.EVENT_STOP;
        }
        // One step per slide too: a slowed-down slide outlasts the throttle.
        const now = GLib.get_monotonic_time();
        if (now - this._lastStep < THROTTLE_MS * 1000 || this.sliding())
            return Clutter.EVENT_STOP;
        this._lastStep = now;
        this.carry(win, step);
        return Clutter.EVENT_STOP;
    }

    // The next real workspace in `step`'s direction: the parking workspace
    // is skipped and the ends wrap.
    carry(win, step) {
        if (Main.overview.visible) return;
        const src = win.get_workspace();
        if (!src) return;
        const dest = this.core.bgApp.realNeighbor(src, step);
        if (!dest || dest === src) {
            this.core.debugLog(`drag-scroll: no workspace next to ${this.core.geometry.wsIndex(src)}`);
            return;
        }
        // Carried in, it was dragged wherever it is released (movedPastGrace).
        this.core._grabCarried = win;
        this.core.dragPreview.hideDropPreview();
        const slideMs = SLIDE_MS * this.core.placement.getAnimationTime() * 10;
        this._holdUntil = GLib.get_monotonic_time() + slideMs * 1000;
        this.core.debugLog(`drag-scroll: ${win.get_wm_class_instance() || '?'} ` +
            `ws ${this.core.geometry.wsIndex(src)} -> ${this.core.geometry.wsIndex(dest)}`);
        // The shell's own move-window-to-workspace; mutter keeps the move
        // grab across the switch.
        Main.wm.actionMoveWindow(win, dest);
        // The shell starts the slide inside the switch: remember which one
        // is ours, so a release only ends that one.
        const slide = this.shellSlide();
        this._slide = slide?.sliding ? slide.anim._switchData : null;
        win.raise();
    }

    // Main.wm._workspaceAnimation is private. Read only in the shape it has
    // (_switchData null between slides, its monitor groups during one);
    // anything else is null, logged once.
    shellSlide() {
        const anim = Main.wm?._workspaceAnimation;
        const data = anim?._switchData;
        if (data === null) return { anim, sliding: false };
        if (Array.isArray(data?.monitors)) return { anim, sliding: true };
        this.warnShellShape();
        return null;
    }

    warnShellShape() {
        if (this._shellWarned) return;
        this._shellWarned = true;
        console.warn('[plaid] drag-scroll: unexpected workspace slide state, ' +
            'using the nominal slide length and leaving a release during the slide to the shell');
    }

    // A workspace slide is running, whoever started it: the shell's state
    // when it reads as expected, else a carry's nominal slide length.
    sliding() {
        const slide = this.shellSlide();
        if (slide) return slide.sliding;
        return GLib.get_monotonic_time() < this._holdUntil;
    }

    // The slide's modal grab would keep a release from the window drag,
    // leaving the window glued to the pointer: pop it here (filters run
    // before grab delivery), only when it has exactly the expected shape.
    releaseDuringSlide() {
        if (!this._slide) return;
        const slide = this.shellSlide();
        if (!slide?.sliding || slide.anim._switchData !== this._slide) {
            this._slide = null;
            return;
        }
        const grab = slide.anim._grab;
        if (!grab) return;
        if (!(grab instanceof Clutter.Grab)) {
            this.warnShellShape();
            return;
        }
        // The shell nulls _grab when it pops it, so a set one is still pushed.
        Main.popModal(grab);
        slide.anim._grab = null;
        this.core.debugLog('drag-scroll: released during the slide');
    }

    destroy() {
        this.end();
        super.destroy();
    }
}
