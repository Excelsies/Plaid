// Window actions: focus, swap, resize, tiling/maximize toggles, centering,
// layout cycling, and the float picker.
//
// Methods live on this subsystem class.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { LAYOUT_NAMES, isBspLayout } from './helpers.js';
import { PlaidSubsystem } from './subsystem.js';

// Focus after a close: a record older than this (a retile held up) is dropped.
const CLOSE_FOCUS_MS = 1000;


export class Actions extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    getActiveWindow() {
        return global.display.focus_window;
    }

    // A tiled Spiral window is compared by its slot (an oversized tile's
    // frame covers its neighbours' edges), anything else by its frame.
    directionalTarget(focused, direction, windows, ws) {
        const slots = new Map();
        for (const mon of new Set([focused, ...windows].map(w => this.core.monitors.windowMon(w)))) {
            for (const [w, r] of this.core.bsp.spiralSlots(ws, mon)) slots.set(w, r);
        }
        const rectOf = w => {
            const s = slots.get(w);
            return s ? { x: s.x, y: s.y, width: s.w, height: s.h } : w.get_frame_rect();
        };
        return this.core.bsp.findDirectionalTarget(focused, direction, windows, rectOf);
    }

    moveFocus(direction) {
        const focused = this.getActiveWindow();
        if (!focused) return;
        const ws = focused.get_workspace();
        if (!ws) return;

        // Every monitor's: at a screen edge focus crosses over.
        const windows = this.core.windows.getWindowsForWorkspace(ws)
            .filter(w => !this.core.windows.isFloating(w));
        if (windows.length <= 1) return;

        const bestWindow = this.directionalTarget(focused, direction, windows, ws);
        if (!bestWindow) return;

        this.core._keyboardFocusChange = true;
        bestWindow.activate(this.core.currentTime());
        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    // Hyprland's focus_on_close=0, in steps. The focused tile of a Spiral
    // group is closing (mutter has not moved focus yet): its slot's centre,
    // one record per window.
    noteClosing(win) {
        const records = this.core._closeFocus;
        if (!records || !this.core._settings || this.core._shuttingDown) return;
        if (global.display.focus_window !== win) return;
        // Slots are a Spiral group's tiles only: no float, no other layout.
        const ws = this.core._windowWorkspaces.get(win);
        if (!ws) return;
        const s = this.core.bsp.spiralSlots(ws, this.core.monitors.windowMon(win)).get(win);
        if (s) {
            records.set(win, { win, ws, conn: this.core.monitors.windowConn(win), at: Date.now(),
                x: s.x + s.w / 2, y: s.y + s.h / 2, closed: false, picked: undefined });
        }
    }

    // Focus moved (notify::focus-window): the first move after a close is
    // mutter's pick. The background app's and a new window's stay.
    noteFocus(win) {
        for (const c of this.core._closeFocus?.values() ?? []) {
            if (c.picked === undefined) this.pick(c, win);
        }
    }

    pick(c, win) {
        if (win && (win === this.core._backgroundAppWin || this.core._newWindowSet?.has(win)))
            this.core._closeFocus.delete(c.win);
        else
            c.picked = win;
    }

    // It left (removeWindow). An actor destroyed at once (no close effect)
    // runs this before mutter picks a focus.
    noteClosed(win) {
        const c = this.core._closeFocus?.get(win);
        if (c) c.closed = true;
    }

    // Its workspace was laid out without it (scheduleRetile): once the idles
    // queued before this one ran (the background app's focus restore), the
    // leaf nearest that centre in the same group, unless focus moved since
    // mutter's pick. The cursor follows with follow-focus, also when mutter
    // picked that leaf itself.
    focusAfterClose(ws) {
        const records = this.core._closeFocus;
        for (const c of [...records?.values() ?? []]) {
            if (c.ws !== ws || !c.closed) continue;
            records.delete(c.win);
            if (c.picked === undefined) {
                // No focus move seen: mutter's pick is the focus now.
                const now = global.display.focus_window;
                if (now === c.win) continue;
                this.pick(c, now);
                if (c.picked === undefined) continue;
            }
            this.core.signals.addIdle(() => this.focusLeafAfterClose(c));
        }
    }

    focusLeafAfterClose(c) {
        if (!this.core._settings || this.core._shuttingDown || this.core._grabOp ||
            !this.core._settings.get_boolean('enabled') || Main.overview.visible || Main.modalCount > 0) return false;
        if (Date.now() - c.at > CLOSE_FOCUS_MS) return false;
        if (global.display.focus_window !== c.picked || c.ws !== global.workspace_manager.get_active_workspace()) return false;
        // A window still opening is no candidate, as it is none for mutter's pick.
        const slots = [...this.core.bsp.spiralSlots(c.ws, this.core.monitors.connMon(c.conn))]
            .filter(([w]) => !this.core._newWindowSet?.has(w));
        const next = this.core.geometry.nearestTo(slots, c.x, c.y);
        if (!next) return false;
        if (next !== c.picked) {
            this.core.debugLog(`spiral: focus after close -> ${next.get_wm_class_instance() || '?'} id=${next.get_id()}`);
            next.activate(this.core.currentTime());
        }
        if (this.core._settings.get_boolean('follow-focus'))
            this.core.windows.cursorWarpDeferred(next);
        return false;
    }

    // Super+Shift+arrows. A tile of a Spiral group: Hyprland's movewindow
    // (spiral.moveWindow). Any other window, and every window with tiling
    // off, moves to the monitor in that direction as GNOME's move-to-monitor
    // does (monitors.moveToMonitor); its group follows as after GNOME's move.
    moveWindow(direction) {
        const win = this.getActiveWindow();
        if (!win || this.core._grabOp) return;
        const monitors = this.core.monitors;
        const ws = win.get_workspace();
        const mon = monitors.windowMon(win);
        if (ws && this.core._settings.get_boolean('enabled') && this.core.bsp.spiralSlots(ws, mon).has(win)) {
            if (this.core.spiral.moveWindow(win, ws, mon, direction) &&
                this.core._settings.get_boolean('follow-focus'))
                this.core.windows.cursorWarpDeferred(win);
            return;
        }
        const to = monitors.neighbor(win.get_monitor(), direction);
        if (to >= 0) monitors.moveToMonitor(win, to);
    }

    swapWindow(direction) {
        const focused = this.getActiveWindow();
        if (!focused) return;
        if (this.core.windows.isFloating(focused)) {
            this.moveFloating(focused, direction);
            return;
        }
        const ws = focused.get_workspace();
        if (!ws) return;
        const monitors = this.core.monitors;
        const mon = monitors.windowMon(focused);
        if (mon < 0) return;
        // A group that places nothing (floating, or a monitor that does not
        // tile): the window moves as a float.
        if (!monitors.groupPlaces(ws, mon)) {
            this.moveFloating(focused, direction);
            return;
        }

        // Every tiled monitor's tiles: at a screen edge the swap crosses over
        // (not into a floating layout, which would not place the window).
        const windows = this.core.windows.getWindowsForWorkspace(ws).filter(w =>
            !this.core.windows.isFloating(w) && monitors.groupPlaces(ws, monitors.windowMon(w)));
        if (windows.length <= 1) return;

        const bestWindow = this.directionalTarget(focused, direction, windows, ws);
        if (!bestWindow) return;

        const layout = this.core.windows.getWorkspaceLayout(ws, mon);
        if (monitors.windowConn(bestWindow) !== monitors.windowConn(focused)) {
            monitors.swapAcrossGroups(ws, focused, bestWindow);
        } else if (isBspLayout(layout)) {
            const tree = this.core.bsp.bspGetTree(ws, mon);
            if (tree) {
                this.core.bsp.bspSwapWindows(tree, focused, bestWindow);
            }
        } else {
            this.core.layouts.swapMasterStackWindows(focused, bestWindow);
        }
        this.core.layouts.retileWorkspace(ws);
        this.core._keyboardFocusChange = true;
        focused.activate(this.core.currentTime());
        this.core.windows.cursorWarpDeferred(focused);
        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    // Hyprland's togglesplit: the focused Spiral tile's parent split turns
    // side by side <-> stacked, pinned against the box rule so the
    // orientation pass keeps it; back on the rule's direction it is free.
    toggleSplit() {
        this.editParentSplit('toggle', (s, box) => {
            s.direction = s.direction === 'h' ? 'v' : 'h';
            if (s.direction === this.core.bsp.boxDirection(box)) delete s.pinned;
            else s.pinned = true;
        });
    }

    // Hyprland's swapsplit: the parent's two children trade places; the
    // ratio stays with the first slot.
    swapSplit() {
        this.editParentSplit('swap', s => {
            [s.first, s.second] = [s.second, s.first];
        });
    }

    editParentSplit(what, edit) {
        const focused = this.getActiveWindow();
        if (!focused || this.core._grabOp || this.core.windows.isFloating(focused) || focused.is_fullscreen()) return;
        const ws = focused.get_workspace();
        if (!ws) return;
        const monitors = this.core.monitors;
        const mon = monitors.windowMon(focused);
        if (mon < 0 || !monitors.groupPlaces(ws, mon) || !this.core.bsp.isSpiral(ws, mon)) return;
        // A lone tile's tree is not synced: no parent of it is live.
        if (monitors.getWindowsForGroup(ws, mon).filter(w => !this.core.windows.isFloating(w)).length < 2) return;
        const tree = this.core.bsp.bspGetTree(ws, mon);
        const path = [];
        if (!tree || !this.core.bsp.bspFindPath(tree, focused, path) || path.length === 0) return;
        const area = this.core.geometry.outsideArea(monitors.monitorWorkArea(ws, mon));
        if (!area) return;
        const parent = path[path.length - 1];
        const gap = this.core._settings.get_int('inside-gap');
        this.core.bsp.bspTagGeometry(tree, area.x, area.y, area.w, area.h, gap);
        const box = { x: parent._x, y: parent._y, w: parent._w, h: parent._h };
        edit(parent, box);
        // Its children have new boxes (a turned split, a moved ratio): the
        // rule orients them there. The gate (bsp.orientLive) sees no change.
        this.core.bsp.orientChildren(parent, box, gap, ws, mon);
        this.core.debugLog(`spiral: ${what} split of ${focused.get_wm_class_instance() || '?'} id=${focused.get_id()} ` +
            `-> ${this.core.bsp.dwindleShapeToString(parent)}`);
        this.core.layouts.refreshSavedShape(ws, tree, mon);
        this.core.layouts.retileWorkspace(ws);
        if (this.core._settings.get_boolean('follow-focus'))
            this.core.windows.cursorWarpDeferred(focused);
    }

    resizeWindow(action, axis) {
        const focused = this.getActiveWindow();
        if (!focused) return;

        const amount = this.core._settings.get_int('resize-amount');
        const delta = action === 'grow' ? amount : -amount;

        if (this.core.windows.isFloating(focused)) {
            this.resizeFloating(focused, axis, delta);
            return;
        }

        const ws = focused.get_workspace();
        if (!ws) return;
        // The focused window's monitor only.
        const mon = this.core.monitors.windowMon(focused);
        if (mon < 0) return;
        if (!this.core.monitors.groupPlaces(ws, mon)) {
            this.resizeFloating(focused, axis, delta);
            return;
        }

        const tiledWindows = this.core.monitors.getWindowsForGroup(ws, mon)
            .filter(w => !this.core.windows.isFloating(w));
        const idx = tiledWindows.indexOf(focused);
        if (idx === -1 || tiledWindows.length <= 1) return;

        const layout = this.core.windows.getWorkspaceLayout(ws, mon);
        if (isBspLayout(layout))
            this.resizeDwindle(focused, ws, axis, delta, mon);
        else
            this.core.layouts.resizeMasterStack(focused, ws, axis, delta, mon);

        this.core.layouts.retileWorkspace(ws);
        if (this.core._settings.get_boolean('follow-focus'))
            this.core.windows.cursorWarpDeferred(focused);
    }

    resizeFloating(win, axis, delta) {
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return;
        let x = frame.x;
        let y = frame.y;
        let w = frame.width;
        let h = frame.height;
        if (axis === 'width') {
            w = Math.max(100, w + delta);
        } else {
            h = Math.max(100, h + delta);
        }
        this.core.placement.animFloat(win, x, y, w, h);
        this.core.windows.moveCursorToWindow(win);
    }

    moveFloating(win, direction) {
        const amount = this.core._settings.get_int('resize-amount');
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return;

        let x = frame.x;
        let y = frame.y;
        switch (direction) {
            case 'left': x -= amount; break;
            case 'right': x += amount; break;
            case 'up': y -= amount; break;
            case 'down': y += amount; break;
        }
        this.core.placement.animFloat(win, x, y, frame.width, frame.height);
        this.core.windows.moveCursorToWindow(win);
    }

    resizeDwindle(focused, workspace, axis, delta, mon) {
        const tree = this.core.bsp.bspGetTree(workspace, mon);
        if (!tree) return;

        const targetIsHorizontal = axis === 'width';
        const path = [];
        this.core.bsp.bspFindPath(tree, focused, path);

        for (let i = path.length - 1; i >= 0; i--) {
            const split = path[i];
            if ((split.direction === 'h') === targetIsHorizontal) {
                const workArea = this.core.monitors.monitorWorkArea(workspace, mon);
                if (!workArea) return;
                // Scale the delta by the split's OWN span (tagged by
                // _bspTagGeometry during layout) so a deep-nested split
                // moves by the same RELATIVE amount as a top-level one —
                // the old full-work-area divisor made the resize feel
                // shallower at depth and shift with the gap settings.
                const axisSize = targetIsHorizontal
                    ? (split._w > 0 ? split._w : workArea.width)
                    : (split._h > 0 ? split._h : workArea.height);
                if (!(axisSize > 0)) return;
                // grow/shrink is relative to the FOCUSED window. The ratio is
                // the FIRST child's fraction, so a window living in the second
                // child must move the ratio the opposite way (the mouse-resize
                // path flips its sign the same way). Without this, keyboard
                // resize was inverted for every non-leftmost leaf — and the
                // BSP builds a right-leaning tree, so that was almost all of
                // them.
                const inFirst = this.core.bsp.bspFindPath(split.first, focused, []);
                const signedDelta = inFirst ? delta : -delta;
                // Spiral: Hyprland's 0.1..1.9 of 2 for every resize.
                const [lo, hi] = this.core.bsp.minimumsIgnored(workspace, mon) ? [0.05, 0.95] : [0.15, 0.85];
                split.ratio = Math.max(lo, Math.min(hi, split.ratio + signedDelta / axisSize));
                this.core.layouts.refreshSavedShape(workspace, tree, mon);
                return;
            }
        }
    }

    toggleFloat() {
        const focused = this.getActiveWindow();
        if (!focused) return;

        const wasFloating = this.core._toggleFloatWindows.has(focused);
        if (wasFloating) {
            this.core._toggleFloatWindows.delete(focused);
        } else {
            this.core._toggleFloatWindows.add(focused);
        }
        const ws = focused.get_workspace();
        if (!ws) return;

        const mon = this.core.monitors.windowMon(focused);
        if (this.core.monitors.groupPlaces(ws, mon) && isBspLayout(this.core.windows.getWorkspaceLayout(ws, mon))) {
            if (wasFloating)
                this.core.bsp.bspInsertForWorkspace(ws, focused, mon);
            else
                this.core.monitors.removeFromGroupTree(focused, ws, this.core.monitors.windowConn(focused));
        }

        this.core._keyboardFocusChange = true;
        this.core.layouts.retileWorkspace(ws);
        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    toggleTiling() {
        this.core._settings.set_boolean('enabled', !this.core._settings.get_boolean('enabled'));
    }

    toggleMaximize() {
        const win = this.getActiveWindow();
        if (!win) return;
        if (win.is_maximized()) {
            win.unmaximize();
            return;
        }
        const saved = this.core._maximizeToggleRects && this.core._maximizeToggleRects.get(win);
        if (saved) {
            this.core._maximizeToggleRects.delete(win);
            win.unmaximize();
            if (saved.w > 0)
                win.move_resize_frame(true, saved.x, saved.y, saved.w, saved.h);
            return;
        }
        const f = win.get_frame_rect();
        if (this.core._maximizeToggleRects)
            this.core._maximizeToggleRects.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
        win.maximize();
    }

    onTilingEnabledChanged() {
        if (!this.core._settings) return;
        const enabled = this.core._settings.get_boolean('enabled');

        if (enabled) {
            for (const win of this.core._windowWorkspaces.keys())
                this.core.windows.capturePosition(win);
            this.core._keyboardFocusChange = true;
            this.core.layouts.retileAll();
            this.core.signals.addIdle(() => {
                this.core._keyboardFocusChange = false;
                return false;
            });
            this.core.bgApp.checkDynamicWorkspaces();
            if (this.core._settings.get_boolean('workspace-popup'))
                this.core.workspaces.showPopup('Tiling Enabled');
        } else {
            this.core.windows.restoreSavedPositions();
            if (this.core._settings.get_boolean('workspace-popup'))
                this.core.workspaces.showPopup('Tiling Disabled');
        }
    }

    centerWindow() {
        const win = this.getActiveWindow();
        if (!win) return;
        if (!this.core.windows.isFloating(win)) return;

        const ws = win.get_workspace();
        if (!ws) return;

        const frame = win.get_frame_rect();
        // On its own monitor.
        const monitor = win.get_monitor();
        const workArea = this.core.monitors.monitorWorkArea(ws, monitor >= 0 ? monitor : this.core.monitors.primaryMon());
        if (!workArea) return;

        const x = workArea.x + Math.floor((workArea.width - frame.width) / 2);
        const y = workArea.y + Math.floor((workArea.height - frame.height) / 2);

        const actor = win.get_compositor_private();
        if (actor) actor.remove_all_transitions();

        win.move_resize_frame(true, x, y, frame.width, frame.height);

        this.core._keyboardFocusChange = true;
        win.activate(this.core.currentTime());

        this.core.windows.moveCursorToWindow(win);

        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    // The focused monitor's layout only.
    cycleLayout() {
        const layouts = ['dwindle', 'spiral', 'master-stack', 'centered-master-stack', 'floating'];
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        const mon = this.core.monitors.activeMonitor(ws);
        const current = this.core.windows.getWorkspaceLayout(ws, mon);
        const idx = layouts.indexOf(current);
        const next = layouts[(idx + 1) % layouts.length];
        if (next !== current) {
            this.core._workspaceLayouts.set(this.core.monitors.groupKey(ws, mon), next);
            this.core.layouts.retileWorkspace(ws);
            this.core.workspaces.showPopup(`Layout: ${LAYOUT_NAMES[next] || next}`, null, 3000, null, mon);
            this.core.persistence.scheduleSaveLayouts();
        }
    }

    startPickMode() {
        if (this.core._pickFocusId) {
            global.display.disconnectObject(this.core._pickFocusId);
            this.core._pickFocusId = null;
        }
        this.core._pickFocusId = this.connectObject(global.display, 'notify::focus-window', () => {
            const win = global.display.focus_window;
            if (!win) return;
            if (this.core._pickFocusId) {
                global.display.disconnectObject(this.core._pickFocusId);
                this.core._pickFocusId = null;
            }
            const cls = this.core.winClassCandidates(win)[0] || '';
            const title = win.get_title() || '';
            this.core._settings.set_string('pick-mode-class', cls);
            this.core._settings.set_string('pick-mode-title', title);
            this.core._settings.set_boolean('pick-mode', false);
        });
    }

    handlePickFloat() {
        const win = global.display.focus_window;
        if (!win) {
            Main.notify(_('No window is focused'));
            return;
        }

        const cls = this.core.winClassCandidates(win)[0] || '';
        const title = win.get_title() || '';

        if (!cls && !title) {
            Main.notify(_('Could not identify the focused window'));
            return;
        }

        this.showFloatPickDialog(cls, title);
    }

    showFloatPickDialog(cls, title) {
        this.destroyFloatPickDialog();
        const dialog = new ModalDialog();
        this.core._pickDialog = dialog;

        const content = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 12px;' });

        const header = new St.Label({
            text: _('Add Floating Window'),
            style: 'font-weight: bold; font-size: 14px;',
        });
        content.add_child(header);

        const subtitle = new St.Label({
            text: _('How should this window be identified?'),
        });
        content.add_child(subtitle);

        dialog.contentLayout.add_child(content);

        const buttons = [];

        if (cls) {
            buttons.push({
                label: _('By class: %s').replace('%s', cls),
                action: () => {
                    this.addFloatEntry('float-windows', cls.toLowerCase());
                    dialog.close();
                },
                key: Clutter.KEY_c,
            });
        }

        if (title) {
            buttons.push({
                label: _('By title: %s').replace('%s', title),
                action: () => {
                    this.addFloatEntry('float-titles', title);
                    dialog.close();
                },
                key: Clutter.KEY_t,
            });
        }

        buttons.push({
            label: _('Cancel'),
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
        });

        dialog.setButtons(buttons);
        dialog.open();
    }

    addFloatEntry(key, value) {
        const current = new Set(this.core._settings.get_strv(key));
        current.add(value);
        this.core._settings.set_strv(key, [...current]);

        if (key === 'float-windows') {
            this.core._floatingClasses = new Set(this.core._settings.get_strv('float-windows'));
        } else {
            this.core._floatingTitles = new Set(this.core._settings.get_strv('float-titles'));
        }

        if (value.length > 40)
            value = value.substring(0, 37) + '...';
        Main.notify(_('Added "%s" to float list').replace('%s', value));
    }

    destroyFloatPickDialog() {
        if (this.core._pickDialog) {
            this.core._pickDialog.close();
            this.core._pickDialog = null;
        }
    }

    destroy() {
        this.destroyFloatPickDialog();
        if (this.core._pickFocusId) {
            global.display.disconnectObject(this.core._pickFocusId);
            this.core._pickFocusId = null;
        }
        super.destroy();
    }
}
