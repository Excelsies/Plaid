// Grab-based mouse resize and swap: grab lifecycle, live resize loop,
// boundary enforcement, slot re-assert, and safe moves. Methods are attached
// on this subsystem class.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { PlaidSubsystem } from './subsystem.js';
import { isBspLayout } from './helpers.js';

// --- Grab-Based Mouse Resize & Swap ---

// mutter anchors a pointer resize at the button press, but grab-op-begin comes
// later, the pointer already past it. The pointer is recorded for this long
// after each cursor-shape change (pressAnchor).
const PRESS_TRACK_MS = 3000;

// --- Pick Mode ---

export class Grab extends PlaidSubsystem {
    constructor(core) {
        super(core);
        this._pressTrackToken = null;
        this._pressTrackUntil = 0;
        this._pressTrail = null;
    }

    connectGrabSignals() {
        const tracker = global.backend.get_cursor_tracker();
        this.connectObject(tracker, 'cursor-changed', () => this.trackPressPointer(tracker));
        this.connectObject(global.display, 'grab-op-begin',
            (_d, metaWindow, grabOp) => this.onGrabOpBegin(metaWindow, grabOp));
        this.connectObject(global.display, 'grab-op-end',
            (_d, metaWindow, grabOp) => this.onGrabOpEnd(metaWindow, grabOp));
        this.connectObject(global.display, 'restacked', () => {
            this.core.blur.syncBlurStacking();
            { this.core.windows.reassertFloatingTransients(); }
        });
    }

    onGrabOpBegin(metaWindow, grabOp) {
        if (metaWindow && this.core._gappedMaxSet && this.core._gappedMaxSet.has(metaWindow)) {
            this.core.debugLog('float maximize: drag exits gapped mode');
            this.core._gappedMaxSet.delete(metaWindow);
            this.core._floatMaxRects.delete(metaWindow);
        }
        if (!this.core._settings || this.core._shuttingDown) return;
        this.core.monitors.grabBegan(metaWindow);
        if (!this.core._settings.get_boolean('mouse-resize')) return;
        if (!this.core._settings.get_boolean('enabled')) return;
        this.handleGrabBegin(metaWindow, grabOp);
        this.core.dragScroll.begin(metaWindow, grabOp);
    }

    onGrabOpEnd(metaWindow, grabOp) {
        this.handleGrabEnd(metaWindow, grabOp);
        this.core.monitors.regroupAfterGrab(metaWindow);
    }

    // The press never reaches an extension: the pointer is recorded briefly
    // after a cursor-shape change (a resize edge's cursor comes before the
    // press).
    trackPressPointer(tracker) {
        // Only a Spiral resize reads the press: other layouts pay nothing.
        if (!this.pressTrackWanted()) return;
        this._pressTrackUntil = GLib.get_monotonic_time() / 1000 + PRESS_TRACK_MS;
        this.recordPressPointer();
        if (this._pressTrackToken) return;
        this._pressTrackToken = this.connectObject(tracker, 'position-invalidated', () => {
            if (GLib.get_monotonic_time() / 1000 > this._pressTrackUntil)
                this.stopPressTracking();
            else
                this.recordPressPointer();
        });
    }

    // A Spiral group on the active workspace.
    pressTrackWanted() {
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws || !this.core._settings) return false;
        return this.core.monitors.tiledMonitors().some(mon =>
            this.core.monitors.groupPlaces(ws, mon) && this.core.windows.getWorkspaceLayout(ws, mon) === 'spiral');
    }

    recordPressPointer() {
        const [x, y] = global.get_pointer();
        this._pressTrail ??= [];
        this._pressTrail.push([GLib.get_monotonic_time() / 1000, x, y]);
        if (this._pressTrail.length > 8) this._pressTrail.shift();
    }

    stopPressTracking() {
        if (this._pressTrackToken) this.disconnectToken(this._pressTrackToken);
        this._pressTrackToken = null;
        this._pressTrail = null;
    }

    // The pointer at the press that started `win`'s grab (its user time),
    // or null without a user time or a trail entry from before it, or for a
    // press over a second ago. handleGrabBegin asks only for a pointer grab.
    pressAnchor(win) {
        const t = win.get_user_time();
        const trail = this._pressTrail;
        if (!t || !trail || GLib.get_monotonic_time() / 1000 - t > 1000) return null;
        for (let i = trail.length - 1; i >= 0; i--) {
            if (trail[i][0] <= t) return [trail[i][1], trail[i][2]];
        }
        return null;
    }

    computeGrabGraceThreshold() {
        const [px, py] = global.get_pointer();
        // get_monitor_at_point() does not exist on Meta.Display in
        // GNOME 50/51 — the old call threw (swallowed) and the grace
        // was pinned at 10px on every monitor. Find the monitor by
        // geometry containment instead.
        let mon = null;
        const n = global.display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            const g = global.display.get_monitor_geometry(i);
            if (px >= g.x && px < g.x + g.width && py >= g.y && py < g.y + g.height) {
                mon = g;
                break;
            }
        }
        if (!mon)
            mon = global.display.get_monitor_geometry(global.display.get_primary_monitor());
        const minDim = Math.min(mon.width, mon.height);
        return Math.max(10, Math.min(30, Math.round(minDim / 100)));
    }

    handleGrabBegin(metaWindow, grabOp) {
        if (!metaWindow || metaWindow.get_window_type() !== Meta.WindowType.NORMAL) return;
        if (metaWindow.is_skip_taskbar()) return;
        const ws = metaWindow.get_workspace();
        if (!ws || ws !== global.workspace_manager.get_active_workspace()) return;

        const frame = metaWindow.get_frame_rect();
        const buffer = metaWindow.get_buffer_rect();
        if (!frame || frame.width === 0 || frame.height === 0 || !buffer) return;

        this.core._grabOp = grabOp;
        // mutter moves the grabbed window from here on: an eased transform
        // would hold it off the pointer.
        this.core.transforms.release(metaWindow);
        this.core.spiral.clearGhosts();

        // Capture the pointer (the resize loop's origin) and the frame (the
        // move path's click-vs-drag origin, see movedPastGrace) for every
        // tracked grab, not the constructor's zeroed coords. A Spiral pointer
        // resize is measured from the press (pressAnchor).
        const keyboard = (grabOp & 0x100) !== 0; // META_GRAB_OP_WINDOW_FLAG_KEYBOARD
        const grabMon = this.core.monitors.windowMon(metaWindow);
        const spiralResize = this.isResizeGrab(grabOp) && !keyboard && !this.core.windows.isFloating(metaWindow) &&
            this.core.monitors.groupPlaces(ws, grabMon) && this.core.windows.getWorkspaceLayout(ws, grabMon) === 'spiral';
        const [startX, startY] = (spiralResize && this.pressAnchor(metaWindow)) || global.get_pointer();
        this.core._grabStartX = startX;
        this.core._grabStartY = startY;
        this.core._grabStartFrame = { x: frame.x, y: frame.y };
        this.core._grabCarried = null;
        this.core._grabGrace = this.computeGrabGraceThreshold();

        if (this.isResizeGrab(grabOp)) {
            this.core._grabWindow = metaWindow;
            const effect = this.core._windowMasks.get(metaWindow);
            if (effect)
                effect.setBorderWidth(0);
        }

        const wmClass = metaWindow.get_wm_class_instance() || '?';
        this.core.debugLog(`GRAB_BEGIN win=${wmClass} rect=${JSON.stringify(frame)} grabOp=${grabOp} ` +
            `isResize=${this.isResizeGrab(grabOp)} isMove=${this.isMoveGrab(grabOp)} float=${this.core.windows.isFloating(metaWindow)}`);

        if (this.isResizeGrab(grabOp) && !this.core.windows.isFloating(metaWindow)) {
            const direction = (grabOp >> 12) & 0xF;
            this.core._grabWidthSign = (direction & 1) ? -1 : (direction & 2) ? 1 : 0;
            this.core._grabHeightSign = (direction & 8) ? -1 : (direction & 4) ? 1 : 0;
            const mon = this.core.monitors.windowMon(metaWindow);
            const places = this.core.monitors.groupPlaces(ws, mon);
            // Spiral moves the divider under the grabbed edge.
            const spiral = places && this.core.windows.getWorkspaceLayout(ws, mon) === 'spiral';
            const tree = places && !spiral ? this.core.bsp.bspGetTree(ws, mon) : null;
            this.core._grabResizeNodeW = null;
            this.core._grabResizeNodeH = null;
            this.core._grabInitialRatioW = 0;
            this.core._grabInitialRatioH = 0;
            if (spiral)
                this.pickSplits(metaWindow, ws);

            if (tree) {
                const path = [];
                this.core.bsp.bspFindPath(tree, metaWindow, path);
                for (let i = path.length - 1; i >= 0; i--) {
                    if (path[i].direction === 'h' && this.core._grabWidthSign !== 0 && !this.core._grabResizeNodeW) {
                        this.core._grabResizeNodeW = path[i];
                        this.core._grabInitialRatioW = path[i].ratio;
                        if (!this.core.bsp.bspFindPath(path[i].first, metaWindow, []))
                            this.core._grabWidthSign = -this.core._grabWidthSign;
                    }
                    if (path[i].direction === 'v' && this.core._grabHeightSign !== 0 && !this.core._grabResizeNodeH) {
                        this.core._grabResizeNodeH = path[i];
                        this.core._grabInitialRatioH = path[i].ratio;
                        if (!this.core.bsp.bspFindPath(path[i].first, metaWindow, []))
                            this.core._grabHeightSign = -this.core._grabHeightSign;
                    }
                }
            }

            this.core._grabInitialMasterRatio = places ? this.core.layouts.getMasterRatio(ws, mon) : 0.5;
            this.core._grabInitialStackRatios = new Map(places ? this.core.layouts.getStackRatios(ws, mon) : []);

            this.startGrabLoop(metaWindow, 'resize');
            this.disconnectGrabBoundaryHooks();
            // Spiral never configures the grabbed window mid-grab.
            if (!spiral) {
                this.core._grabSizeChangedId = this.connectObject(metaWindow, 'size-changed', () =>
                    this.enforceGrabBoundary(metaWindow));
                this.core._grabPositionChangedId = this.connectObject(metaWindow, 'position-changed', () =>
                    this.enforceGrabBoundary(metaWindow));
            }
        } else if (this.isMoveGrab(grabOp) && !this.core.windows.isFloating(metaWindow)) {
            this.startGrabLoop(metaWindow, 'move');
        } else {
            this.core._grabOp = null;
            this.core._grabWindow = null;
        }
    }

    handleGrabEnd(metaWindow, grabOp) {
        // No scroll may carry the window once the grab is over.
        this.core.dragScroll.end();
        const wasTracking = this.core._grabOp !== null;
        let dropWs = null;

        if (wasTracking && metaWindow && !this.core.windows.isFloating(metaWindow)) {
            const ws = metaWindow.get_workspace();
            if (ws) {
                // The release can come before the tick that applies the last
                // motion: one more, or a fast flick ends one motion short.
                if (this.isResizeGrab(grabOp) && this.core._liveResizeId)
                    this.spiralResizeTick(metaWindow);
                let edited = this.isResizeGrab(grabOp) && this.resizeMovedRatio();
                if (this.isMoveGrab(grabOp)) {
                    // Click-vs-drag guard: a titlebar click on a decorated
                    // window starts a move grab with no real movement, and
                    // Escape restores the frame before grab-op-end — only
                    // reposition when the window actually travelled.
                    if (this.movedPastGrace(metaWindow)) {
                        this.core.windows.repositionWindow(metaWindow, ws);
                        edited = true;
                    }
                }
                // Keep the grab's edit, or a deferred window-set retile
                // restores the pre-grab shape. After a drop on another
                // monitor, that monitor's.
                const mon = this.core.monitors.windowMon(metaWindow);
                if (edited && isBspLayout(this.core.windows.getWorkspaceLayout(ws, mon)))
                    this.core.layouts.refreshSavedShape(ws, this.core.bsp.bspGetTree(ws, mon), mon);
                this.core.layouts.retileWorkspace(ws);
                dropWs = ws;
                { metaWindow.raise(); }
            }
        }

        if (wasTracking && metaWindow)
            this.core.masks.kickMaskNow(metaWindow);

        if (wasTracking && metaWindow) {
            const wmClass = metaWindow.get_wm_class_instance() || '?';
            const ws = metaWindow.get_workspace();
            if (ws) {
                const mon = this.core.monitors.windowMon(metaWindow);
                const tree = this.core.bsp.bspGetTree(ws, mon);
                const treeWins = tree ? this.core.bsp.bspCollectWindows(tree) : [];
                const tiled = this.core.monitors.getWindowsForGroup(ws, mon).filter(w => !this.core.windows.isFloating(w));
                this.core.debugLog(`GRAB_END win=${wmClass} treeWins=[${treeWins.map(w => w.get_wm_class_instance() || '?').join(',')}] ` +
                    `tiled=[${tiled.map(w => w.get_wm_class_instance() || '?').join(',')}]`);
            }
        }

        this.core.dragPreview.hideDropPreview();
        this.stopLiveResizeLoop();
        this.disconnectGrabBoundaryHooks();
        // After the drop: ghosts, then the stretch and the shrink handed to
        // the release retile from where they are drawn.
        this.core.spiral.clearGhosts();
        this.core.transforms.handOffLiveStretch(metaWindow);
        this.core.spiral.unshrinkDraggedWindow();
        this.core._grabOp = null;
        this.core._grabWindow = null;
        this.core._grabStartFrame = null;
        this.core._grabCarried = null;
        this.core._grabInnerW = this.core._grabInnerH = null;
        this.core._grabFollowW = this.core._grabFollowH = 1;
        // Also the workspace a carried window left (drag-scroll).
        this.drainRetilesAfterGrab(dropWs);
        this.core._grabInitialStackRatios = null;
        // Sync, not start: no 30fps tick when nothing animates.
        this.core.borders.syncBorderAnimation();
    }

    // Retiles deferred by the grab, active workspace first. Not the drop's
    // workspace again: rescheduled, it would wait behind the throttle.
    drainRetilesAfterGrab(dropWs) {
        const deferred = this.core._retileAfterGrab;
        if (!deferred || deferred.size === 0) return;
        if (!this.core._settings || this.core._shuttingDown) {
            deferred.clear();
            return;
        }
        const pending = new Set(deferred);
        deferred.clear();
        const active = global.workspace_manager.get_active_workspace();
        const order = [];
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (ws === dropWs || !pending.has(ws)) continue;
            if (ws === active) order.unshift(ws);
            else order.push(ws);
        }
        if (order.length > 0)
            this.core.debugLog(`retile: drained after grab ws=[${order.map(ws => this.core.geometry.wsIndex(ws)).join(',')}]`);
        for (const ws of order)
            this.core.layouts.retileWorkspace(ws);
    }

    // The window's travel since grab begin, not the pointer's: mutter emits
    // grab-op-begin after the client's drag threshold, and Escape puts the
    // frame back while the pointer stays where it was. A window carried to
    // another workspace was dragged wherever it is released.
    movedPastGrace(win) {
        if (win && this.core._grabCarried === win) return true;
        const start = this.core._grabStartFrame;
        if (!start || !win) return false;
        const f = win.get_frame_rect();
        return Math.hypot(f.x - start.x, f.y - start.y) >= (this.core._grabGrace ?? 10);
    }

    // A dwindle resize grab that moved one of its splits.
    resizeMovedRatio() {
        const w = this.core._grabResizeNodeW;
        const h = this.core._grabResizeNodeH;
        return !!((w && w.ratio !== this.core._grabInitialRatioW) ||
            (h && h.ratio !== this.core._grabInitialRatioH));
    }

    isResizeGrab(grabOp) {
        // MetaGrabOp is bitfield-encoded (identical on mutter 18 and 51):
        // WINDOW_BASE=1, direction in bits 12-15 (W=1,E=2,S=4,N=8).
        // Resize ops have direction bits; move ops have none.
        if (grabOp === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN) return true;
        if (grabOp === Meta.GrabOp.NONE) return false;
        const direction = (grabOp >> 12) & 0xF;
        return (grabOp & 1) !== 0 && direction !== 0;
    }

    isMoveGrab(grabOp) {
        if (grabOp === Meta.GrabOp.NONE) return false;
        if (grabOp === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN) return false;
        const direction = (grabOp >> 12) & 0xF;
        return (grabOp & 1) !== 0 && direction === 0;
    }

    // Per axis the outer split is the nearest ancestor whose divider IS the
    // grabbed edge. On a monitor edge there is none: the opposite edge moves,
    // mirrored (follow -1), since mutter shrinks the frame from the dragged
    // edge. A same-direction split met first, `inner`, holds the anchored
    // edge.
    pickSplits(win, ws) {
        const c = this.core;
        c._grabResizeNodeW = c._grabResizeNodeH = null;
        c._grabInnerW = c._grabInnerH = null;
        c._grabFollowW = c._grabFollowH = 1;
        c._grabInitialRatioW = c._grabInitialRatioH = 0;
        const mon = c.monitors.windowMon(win);
        const tree = c.bsp.bspGetTree(ws, mon);
        const leaf = tree ? c.bsp.bspFindLeaf(tree, win) : null;
        if (!leaf) return;
        const workArea = c.monitors.monitorWorkArea(ws, mon);
        const area = c.geometry.isValidWorkArea(workArea) ? c.geometry.outsideArea(workArea) : null;
        if (!area) return;
        const gap = c._settings.get_int('inside-gap');
        c.bsp.bspTagGeometry(tree, area.x, area.y, area.w, area.h, gap);
        const path = [];
        c.bsp.bspFindPath(tree, win, path);
        const sticks = (a, b) => Math.abs(a - b) < 2;
        const pick = (dir, sign, lo, size, areaLo, areaSize) => {
            const atLo = sticks(lo, areaLo);
            const atHi = sticks(lo + size, areaLo + areaSize);
            if (!sign || (atLo && atHi)) return [null, null, 1];
            const wantSecond = sign < 0 || atHi;
            const wantFirst = sign > 0 || atLo;
            let inner = null;
            for (let i = path.length - 1; i >= 0; i--) {
                const node = path[i];
                if (node.direction !== dir) continue;
                const inFirst = node.first === (path[i + 1] ?? leaf);
                const other = inFirst ? node.second : node.first;
                if (!other || other.type === 'empty') continue;
                // The divider is on the far side of a monitor-edge grab.
                if (inFirst ? wantFirst : wantSecond) return [node, inner, (sign < 0) === inFirst ? -1 : 1];
                inner ??= { node, inFirst, anchor: inFirst ? lo + size : lo };
            }
            return [null, null, 1];
        };
        [c._grabResizeNodeW, c._grabInnerW, c._grabFollowW] =
            pick('h', c._grabWidthSign, leaf._x, leaf._w, area.x, area.w);
        [c._grabResizeNodeH, c._grabInnerH, c._grabFollowH] =
            pick('v', c._grabHeightSign, leaf._y, leaf._h, area.y, area.h);
        c._grabInitialRatioW = c._grabResizeNodeW?.ratio ?? 0;
        c._grabInitialRatioH = c._grabResizeNodeH?.ratio ?? 0;
    }

    // Spiral: the picked dividers follow the pointer's travel (no minimums,
    // bsp.minimumsIgnored); `inner` is re-solved so the anchored edge stays
    // where mutter keeps it. Leaves the tree tagged.
    updateGrabSplits(tree, dx, dy, gap, area) {
        const c = this.core;
        const nodeW = c._grabResizeNodeW;
        const nodeH = c._grabResizeNodeH;
        if (nodeW)
            this.setGrabRatio(nodeW, c._grabInitialRatioW + c._grabFollowW * dx / (nodeW._w - gap), gap);
        if (nodeH)
            this.setGrabRatio(nodeH, c._grabInitialRatioH + c._grabFollowH * dy / (nodeH._h - gap), gap);
        c.bsp.bspTagGeometry(tree, area.x, area.y, area.w, area.h, gap);
        for (const inner of [c._grabInnerW, c._grabInnerH]) {
            if (!inner) continue;
            const n = inner.node;
            const isH = n.direction === 'h';
            const start = isH ? n._x : n._y;
            const split = inner.inFirst ? inner.anchor - start : inner.anchor - gap - start;
            // +0.5: the layout floors (axis - gap) * ratio back to `split`.
            this.setGrabRatio(n, (split + 0.5) / ((isH ? n._w : n._h) - gap), gap);
            c.bsp.bspTagGeometry(n, n._x, n._y, n._w, n._h, gap);
        }
    }

    // A tagged Spiral split's ratio, within [0.05, 0.95] (Hyprland's 0.1..1.9
    // of 2): no minimum bounds it.
    setGrabRatio(node, raw, gap) {
        const axisSize = (node.direction === 'h' ? node._w : node._h) - gap;
        if (!(axisSize > 0) || !Number.isFinite(raw)) return;
        node.ratio = Math.max(0.05, Math.min(0.95, raw));
    }

    startGrabLoop(metaWindow, mode) {
        this.stopLiveResizeLoop();

        const ws = metaWindow.get_workspace();

        this.core._liveResizeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!this.core._settings || !metaWindow || !this.core._grabOp) {
                this.core._liveResizeId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const frame = metaWindow.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return GLib.SOURCE_CONTINUE;

            if (mode === 'resize') {
                const [curX, curY] = global.get_pointer();
                const dx = curX - this.core._grabStartX;
                const dy = curY - this.core._grabStartY;

                const gap = this.core._settings.get_int('inside-gap');
                const mon = this.core.monitors.windowMon(metaWindow);
                const workArea = this.core.monitors.monitorWorkArea(ws, mon);
                if (!workArea) return GLib.SOURCE_CONTINUE;

                // A group that places nothing has no split to move.
                const places = this.core.monitors.groupPlaces(ws, mon);
                const layout = this.core.windows.getWorkspaceLayout(ws, mon);
                if (places && layout === 'spiral') {
                    this.spiralResizeTick(metaWindow);
                    this.core.borders.updateBordersDuringGrab();
                    return GLib.SOURCE_CONTINUE;
                } else if (places && isBspLayout(layout)) {
                    const tree = this.core.bsp.bspGetTree(ws, mon);
                    if (tree) {
                        const area = this.core.geometry.outsideArea(workArea);
                        if (!area) return GLib.SOURCE_CONTINUE;
                        const areaX = area.x;
                        const areaY = area.y;
                        const areaW = area.w;
                        const areaH = area.h;

                        this.core.bsp.treeMinSizes(tree, gap, ws, mon);
                        if (this.core._grabResizeNodeW) {
                            const axis = this.core._grabResizeNodeW._w;
                            if (axis - gap > 0) {
                                const axisSize = axis - gap;
                                const minW1 = this.core._grabResizeNodeW.first._minW || 0;
                                const minW2 = this.core._grabResizeNodeW.second._minW || 0;
                                const minRatio = minW1 / axisSize;
                                const maxRatio = 1 - minW2 / axisSize;
                                const lo = maxRatio <= minRatio
                                    ? (minW1 + minW2 > 0 ? minW1 / (minW1 + minW2) : 0.15) : minRatio;
                                const hi = maxRatio <= minRatio ? lo : maxRatio;
                                const raw = this.core._grabInitialRatioW + (dx * this.core._grabWidthSign) / axisSize;
                                if (Number.isFinite(raw))
                                    this.core._grabResizeNodeW.ratio = Math.max(lo, Math.min(hi, raw));
                            }
                        }
                        if (this.core._grabResizeNodeH) {
                            const axis = this.core._grabResizeNodeH._h;
                            if (axis - gap > 0) {
                                const axisSize = axis - gap;
                                const minH1 = this.core._grabResizeNodeH.first._minH || 0;
                                const minH2 = this.core._grabResizeNodeH.second._minH || 0;
                                const minRatio = minH1 / axisSize;
                                const maxRatio = 1 - minH2 / axisSize;
                                const lo = maxRatio <= minRatio
                                    ? (minH1 + minH2 > 0 ? minH1 / (minH1 + minH2) : 0.15) : minRatio;
                                const hi = maxRatio <= minRatio ? lo : maxRatio;
                                const raw = this.core._grabInitialRatioH + (dy * this.core._grabHeightSign) / axisSize;
                                if (Number.isFinite(raw))
                                    this.core._grabResizeNodeH.ratio = Math.max(lo, Math.min(hi, raw));
                            }
                        }
                        this.core.bsp.bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
                    }
                } else if (places && (layout === 'master-stack' || layout === 'centered-master-stack')) {
                    const area = this.core.geometry.outsideArea(workArea);
                    if (!area) return GLib.SOURCE_CONTINUE;
                    const areaW = area.w;
                    const areaH = area.h;

                    if (this.core._grabWidthSign !== 0) {
                        const tiled = this.core.monitors.getWindowsForGroup(ws, mon).filter(w => !this.core.windows.isFloating(w));
                        const idx = tiled.indexOf(metaWindow);
                        this.core.debugLog(`MS_RESIZE dx=${dx} dy=${dy} wSign=${this.core._grabWidthSign} hSign=${this.core._grabHeightSign} ` +
                            `idx=${idx} numTiled=${tiled.length} initMasterRatio=${this.core._grabInitialMasterRatio.toFixed(3)}`);
                        let sign = this.core._grabWidthSign;
                        if (idx > 0) sign = -sign;
                        const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;
                        if (masterDenom > 0) {
                            let ratioDelta = (dx * sign) / masterDenom;
                            if (layout === 'centered-master-stack' && idx > 0)
                                ratioDelta *= 2;
                            const newRatio = this.core._grabInitialMasterRatio + ratioDelta;
                            const masterMin = tiled.length > 0 ? (this.core.bsp.getWindowMinSize(tiled[0]).w || 0) : 0;
                            let stackMinW = 0;
                            for (let i = 1; i < tiled.length; i++)
                                stackMinW = Math.max(stackMinW, this.core.bsp.getWindowMinSize(tiled[i]).w || 0);
                            let lo = masterMin / masterDenom;
                            let hi = 1 - stackMinW / masterDenom;
                            if (layout === 'centered-master-stack') {
                                const numStack = tiled.length - 1;
                                const leftCount = Math.ceil(numStack / 2);
                                let leftMinW = 0;
                                let rightMinW = 0;
                                for (let i = 1; i < tiled.length; i++) {
                                    const m = this.core.bsp.getWindowMinSize(tiled[i]).w || 0;
                                    if (i <= leftCount) leftMinW = Math.max(leftMinW, m);
                                    else rightMinW = Math.max(rightMinW, m);
                                }
                                hi = 1 - 2 * Math.max(leftMinW, rightMinW) / masterDenom;
                            }
                            if (hi <= lo) { lo = 0.5; hi = 0.5; }
                            if (Number.isFinite(newRatio))
                                this.core._masterRatios.set(this.core.monitors.groupKey(ws, mon), Math.max(lo, Math.min(hi, newRatio)));
                        }
                    }
                    if (this.core._grabHeightSign !== 0) {
                        const tiled = this.core.monitors.getWindowsForGroup(ws, mon).filter(w => !this.core.windows.isFloating(w));
                        const idx = tiled.indexOf(metaWindow);
                        if (idx > 0 && this.core._grabInitialStackRatios) {
                            this.core.debugLog(`MS_HEIGHT idx=${idx} dy=${dy} hSign=${this.core._grabHeightSign} ` +
                                `initStackRatios=[${[...this.core._grabInitialStackRatios.entries()].map(([k,v])=>`${k}:${v.toFixed(2)}`).join(',')}]`);
                            const numStack = tiled.length - 1;
                            const gapTotal = gap * (numStack - 1);
                            const totalStackH = areaH - gapTotal;
                            if (totalStackH > 0 && numStack > 1) {
                                const stackRatios = this.core.layouts.getStackRatios(ws, mon);
                                const draggedStackIdx = idx - 1;
                                const pixelDelta = dy * this.core._grabHeightSign;
                                const otherDelta = -pixelDelta / (numStack - 1);
                                let initTotal = 0;
                                for (let j = 0; j < numStack; j++)
                                    initTotal += this.core._grabInitialStackRatios.has(j)
                                        ? this.core._grabInitialStackRatios.get(j) : 1.0;
                                const newHeights = [];
                                for (let j = 0; j < numStack; j++) {
                                    const initW = this.core._grabInitialStackRatios.has(j)
                                        ? this.core._grabInitialStackRatios.get(j) : 1.0;
                                    const initH = totalStackH * initW / initTotal;
                                    const delta = j === draggedStackIdx ? pixelDelta : otherDelta;
                                    const minH = tiled.length > j + 1
                                        ? (this.core.bsp.getWindowMinSize(tiled[j + 1]).h || 0) : 0;
                                    newHeights.push(Math.max(minH, initH + delta));
                                }
                                const newTotalH = newHeights.reduce((a, b) => a + b, 0);
                                if (newTotalH > 0) {
                                    for (let j = 0; j < numStack; j++) {
                                        const newW = newHeights[j] / newTotalH * numStack;
                                        stackRatios.set(j, Math.max(0.1, newW));
                                    }
                                }
                            } else if (totalStackH > 0) {
                                const initialWeight = this.core._grabInitialStackRatios.has(idx - 1)
                                    ? this.core._grabInitialStackRatios.get(idx - 1) : 1.0;
                                const minH = tiled.length > idx
                                    ? (this.core.bsp.getWindowMinSize(tiled[idx]).h || 0) : 0;
                                const minWeight = totalStackH > 0 ? minH / totalStackH * numStack : 0.1;
                                const newWeight = Math.max(Math.max(0.1, minWeight),
                                    initialWeight + (dy * this.core._grabHeightSign) / totalStackH * numStack);
                                const stackRatios = this.core.layouts.getStackRatios(ws, mon);
                                stackRatios.set(idx - 1, newWeight);
                                this.core.persistence.scheduleSaveLayouts();
                            }
                        }
                    }
                }

                this.moveTiledExcept(metaWindow);
                this.enforceGrabBoundary(metaWindow);
                this.core.borders.updateBordersDuringGrab();
            } else if (mode === 'move') {
                this.core.dragPreview.updateMoveDragPreview(metaWindow);
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    // One step of a Spiral resize: the splits from the pointer's travel since
    // the press, every window stretched over its slot. false: the window's
    // group is not a placing Spiral group.
    spiralResizeTick(win) {
        const ws = win.get_workspace();
        if (!ws) return false;
        const mon = this.core.monitors.windowMon(win);
        if (!this.core.monitors.groupPlaces(ws, mon) || this.core.windows.getWorkspaceLayout(ws, mon) !== 'spiral')
            return false;
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        const tree = this.core.bsp.bspGetTree(ws, mon);
        const area = tree && workArea ? this.core.geometry.outsideArea(workArea) : null;
        if (!area) return true;
        const [x, y] = global.get_pointer();
        this.updateGrabSplits(tree, x - this.core._grabStartX, y - this.core._grabStartY,
            this.core._settings.get_int('inside-gap'), area);
        this.spiralLiveResize(win);
        return true;
    }

    // Spiral live resize: re-send changed slots only and stretch every actor
    // over its slot until its client commits, keeping edges flush with the
    // cursor. The tree is tagged (updateGrabSplits).
    spiralLiveResize(grabbed) {
        const ws = grabbed.get_workspace();
        if (!ws) return;
        const mon = this.core.monitors.windowMon(grabbed);
        const tree = this.core.bsp.bspGetTree(ws, mon);
        if (!tree || !this.core.bsp.bspFindLeaf(tree, grabbed)) return;
        if (!this.core._liveSent) this.core._liveSent = new Map();
        if (!this.core._liveStretched) this.core._liveStretched = new Map();
        for (const leaf of this.core.bsp.bspLeaves(tree)) {
            const win = leaf.window;
            if (!win || win.is_fullscreen() || !win.get_workspace()) continue;
            if (!(leaf._w > 0) || !(leaf._h > 0)) continue;
            const slot = this.core.bsp.tileRect(win, { x: leaf._x, y: leaf._y, w: leaf._w, h: leaf._h }, ws, mon);
            // mutter owns the grabbed window's geometry until the grab ends.
            if (win !== grabbed) {
                const last = this.core._liveSent.get(win);
                if (!last || last.x !== slot.x || last.y !== slot.y || last.w !== slot.w || last.h !== slot.h) {
                    this.core._liveSent.set(win, slot);
                    win.move_resize_frame(true, slot.x, slot.y, slot.w, slot.h);
                }
                this.core.transforms.stretchActorToSlot(win, slot);
                continue;
            }
            // An axis no divider follows (the window spans it, or the edge is
            // a monitor edge with nothing to mirror): draw the frame there.
            const f = win.get_frame_rect();
            const clampW = this.core._grabWidthSign !== 0 && !this.core._grabResizeNodeW;
            const clampH = this.core._grabHeightSign !== 0 && !this.core._grabResizeNodeH;
            // `slot` itself unless overridden: a copy fails the flush identity
            // test and is re-transformed every tick.
            const draw = clampW || clampH ? { ...slot } : slot;
            if (clampW) {
                draw.x = f.x;
                draw.w = f.width;
            }
            if (clampH) {
                draw.y = f.y;
                draw.h = f.height;
            }
            this.core.transforms.stretchActorToSlot(win, slot, draw);
        }
    }

    stopLiveResizeLoop() {
        if (this.core._liveResizeId) {
            GLib.source_remove(this.core._liveResizeId);
            this.core._liveResizeId = 0;
        }
    }

    moveTiledExcept(skipWindow) {
        const ws = skipWindow.get_workspace();
        if (!ws) return;
        const gap = this.core._settings.get_int('inside-gap');
        const mon = this.core.monitors.windowMon(skipWindow);
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        if (!workArea) return;

        if (!this.core.monitors.groupPlaces(ws, mon)) return;
        const layout = this.core.windows.getWorkspaceLayout(ws, mon);
        if (isBspLayout(layout)) {
            const tree = this.core.bsp.bspGetTree(ws, mon);
            if (!tree) return;
            const treeWins = this.core.bsp.bspCollectWindows(tree);
            if (!treeWins.includes(skipWindow)) return;
            const area = this.core.geometry.outsideArea(workArea);
            if (!area) return;
            this.core.bsp.bspLayout(tree, area.x, area.y, area.w, area.h, gap, skipWindow);
        } else {
            const tiled = this.core.monitors.getWindowsForGroup(ws, mon).filter(w => !this.core.windows.isFloating(w));
            if (tiled.length <= 1) return;
            if (layout === 'centered-master-stack')
                this.core.layouts.retileCenteredMasterStack(ws, tiled, skipWindow, mon);
            else
                this.core.layouts.retileMasterStack(ws, tiled, skipWindow, mon);
        }
    }

    windowSlotRect(win, ws, layout, workArea, insideGap) {
        if (!this.core.geometry.isValidWorkArea(workArea)) return null;
        if (layout === 'floating') return null;
        // A single tiled window's slot IS its placement rect — the layouts
        // place the lone window via _singleWindowRect (the work area inset
        // by the per-edge outside-gap-* settings). The slot must agree
        // EXACTLY or the re-assert/verification machinery sees a phantom mismatch
        // (or, for dwindle, no slot at all — the BSP tree is never built
        // for a single window, so the tree branch returned null and every
        // settle re-assert silently no-oped while the window sat off-slot).
        // The slot is in the window's group; workArea must be its monitor's.
        const mon = this.core.monitors.windowMon(win);
        if (!this.core.monitors.groupPlaces(ws, mon)) return null;
        const tiled = this.core.monitors.getWindowsForGroup(ws, mon).filter(w => !this.core.windows.isFloating(w));
        if (tiled.length === 1)
            return this.core.bsp.loneTileRect(win, workArea, ws, mon);
        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return null;
        const { x: areaX, y: areaY, w: areaW, h: areaH } = area;
        const gap = insideGap;
        if (areaW <= 0 || areaH <= 0) return null;

        if (isBspLayout(layout)) {
            const tree = this.core.bsp.bspGetTree(ws, mon);
            if (!tree) return null;
            const leaf = this.core.bsp.bspFindLeaf(tree, win);
            if (!leaf || leaf._w === undefined) return null;
            const r = { x: leaf._x, y: leaf._y, w: leaf._w, h: leaf._h };
            if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x + r.y + r.w + r.h)) return null;
            // Insurance: never report a slot narrower than the window's
            // minimum — the layout clamps, so verdicts must agree.
            const min = this.core.bsp.layoutMinSize(win, ws, mon);
            if (min.w > 0 && r.w < min.w) r.w = Math.min(min.w, areaW);
            if (min.h > 0 && r.h < min.h) r.h = Math.min(min.h, areaH);
            return this.core.bsp.tileRect(win, r, ws, mon);
        }

        const idx = tiled.indexOf(win);
        if (idx === -1) return null;

        const masterRatio = this.core.layouts.getMasterRatio(ws, mon);
        const numStack = tiled.length - 1;
        const stackRatios = this.core.layouts.getStackRatios(ws, mon);

        let masterX, masterW, stackX, stackW, stackIdx, colCount, colWeights;
        if (layout === 'centered-master-stack') {
            masterW = Math.floor((areaW - gap * 2) * masterRatio);
            masterX = areaX + Math.floor((areaW - masterW) / 2);
            if (idx === 0) {
                const r = { x: masterX, y: areaY, w: masterW, h: areaH };
                return this.core.geometry.minClampSlot(r, win, areaW, areaH);
            }
            const leftCount = Math.ceil(numStack / 2);
            const stackIdxIn = idx - 1;
            if (stackIdxIn < leftCount) {
                stackX = areaX;
                stackW = masterX - areaX - gap;
                stackIdx = stackIdxIn;
                colCount = leftCount;
            } else {
                stackX = masterX + masterW + gap;
                stackW = areaX + areaW - stackX;
                stackIdx = stackIdxIn - leftCount;
                colCount = numStack - leftCount;
            }
            colWeights = [];
            for (let i = 0; i < colCount; i++)
                colWeights.push(stackRatios.has(stackIdxIn - stackIdx + i) ? stackRatios.get(stackIdxIn - stackIdx + i) : 1.0);
        } else {
            masterW = Math.floor((areaW - gap) * masterRatio);
            masterX = areaX;
            if (idx === 0) {
                const r = { x: areaX, y: areaY, w: masterW, h: areaH };
                return this.core.geometry.minClampSlot(r, win, areaW, areaH);
            }
            stackX = areaX + masterW + gap;
            stackW = areaW - masterW - gap;
            stackIdx = idx - 1;
            colCount = numStack;
            colWeights = [];
            for (let i = 0; i < colCount; i++)
                colWeights.push(stackRatios.has(i) ? stackRatios.get(i) : 1.0);
        }

        if (stackW <= 0 || colCount === 0) return null;
        const totalWeight = colWeights.reduce((a, b) => a + b, 0);
        if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) return null;
        const totalColH = areaH - gap * (colCount - 1);
        let y = areaY;
        for (let i = 0; i < colCount; i++) {
            const isLast = i === colCount - 1;
            const h = isLast
                ? (areaY + areaH - y)
                : Math.floor(totalColH * colWeights[i] / totalWeight);
            if (i === stackIdx) {
                const r = { x: stackX, y, w: stackW, h };
                if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x + r.y + r.w + r.h)) return null;
                return this.core.geometry.minClampSlot(r, win, areaW, areaH);
            }
            y += h + gap;
        }
        return null;
    }

    enforceGrabBoundary(win) {
        {
            if (!this.core._settings || !this.core._grabOp || !win) return;
            const ws = win.get_workspace();
            if (!ws) return;
            const gap = this.core._settings.get_int('inside-gap');
            const mon = this.core.monitors.windowMon(win);
            const workArea = this.core.monitors.monitorWorkArea(ws, mon);
            if (!workArea || workArea.width === 0) return;
            const layout = this.core.windows.getWorkspaceLayout(ws, mon);
            const boundary = this.windowSlotRect(win, ws, layout, workArea, gap);
            if (!boundary) return;
            const f = win.get_frame_rect();
            if (f.width === 0 || f.height === 0) return;
            let nx = f.x, ny = f.y, nw = f.width, nh = f.height;
            const wOut = this.core._grabWidthSign > 0
                ? (f.x + f.width > boundary.x + boundary.w + 1)
                : this.core._grabWidthSign < 0
                    ? (f.x < boundary.x - 1 || f.x + f.width > boundary.x + boundary.w + 1)
                    : false;
            const hOut = this.core._grabHeightSign > 0
                ? (f.y + f.height > boundary.y + boundary.h + 1)
                : this.core._grabHeightSign < 0
                    ? (f.y < boundary.y - 1 || f.y + f.height > boundary.y + boundary.h + 1)
                    : false;
            if (wOut) { nx = boundary.x; nw = boundary.w; }
            if (hOut) { ny = boundary.y; nh = boundary.h; }
            if (wOut || hOut)
                this.safeMove(win, nx, ny, nw, nh);
        }
    }

    disconnectGrabBoundaryHooks() {
        const win = this.core._grabWindow;
        if (this.core._grabSizeChangedId) {
            if (win) {
                win.disconnectObject(this.core._grabSizeChangedId);
            }
            this.core._grabSizeChangedId = 0;
        }
        if (this.core._grabPositionChangedId) {
            if (win) {
                win.disconnectObject(this.core._grabPositionChangedId);
            }
            this.core._grabPositionChangedId = 0;
        }
    }

    maybeReassertSlot(win, tol = 16, mode = 'retile') {
        if (!this.core._settings || this.core._shuttingDown) return;
        if (!this.core._settings.get_boolean('enabled')) return;
        if (this.core._grabOp) return;
        if (!win || win.is_fullscreen() || win.minimized) return;
        // Never fight an in-flight Plaid animation with a direct re-place:
        // size-changed fires on every animated tick, and re-placing mid-flight
        // made the first Emacs/XWayland open bounce by 24-40px per tick. The
        // animation's landing verify settles the final frame, and the settle
        // poll retries 400ms later if the client still disagrees.
        if (this.core._animWindows && this.core._animWindows.has(win)) return;
        // Nor the transform driver, which holds it until its commit.
        if (this.core._transformStates && this.core._transformStates.has(win)) return;
        if (this.core.windows.isFloating(win)) return;
        if (!this.core._windowWorkspaces.has(win)) return;
        // Timestamp gate: size-changed fires per move/resize step and the
        // full slot computation is O(n²) per retile — skip re-checks for the
        // same window within 250ms (the retile verify covers the rest).
        // NOTE: the gate is only READ here — the timestamp is recorded
        // AFTER the animating block below, so a retile-mode call that only
        // queues (and does no work) no longer refreshes the gate and starve
        // a direct correction queued behind it. Consecutive acting calls
        // stay debounced (the client-fight protection).
        const now = Date.now();
        if (this.core._slotReassertTimes) {
            const last = this.core._slotReassertTimes.get(win);
            if (last && now - last < 250) return;
        }
        if (this.core._animating) {
            // Direct mode must NOT queue: the settle re-assert of a freshly
            // placed window can be starved by other workspaces' retile
            // animation churn (ws1's constant 1s animations) — the queued
            // ws drains into another animated retile that re-loses the
            // client-resize race. A direct re-place is safe mid-animation
            // (it only moves one window; it does not touch the retile
            // machinery).
            if (mode === 'direct') {
                // fall through to the direct check below
            } else {
                const ws = win.get_workspace();
                if (ws && this.core._queuedAnimWorkspaces) this.core._queuedAnimWorkspaces.add(ws);
                return;
            }
        }
        if (this.core._slotReassertTimes) this.core._slotReassertTimes.set(win, now);
        const ws = win.get_workspace();
        if (!ws) return;
        // Only on its group's monitor. Moved to another one, the frame is
        // there before window-entered-monitor regroups it: a slot from the
        // old group would pull it back.
        const monitor = this.core.monitors.windowMon(win);
        if (monitor < 0) return;
        const rectMon = global.display.get_monitor_index_for_rect(win.get_frame_rect());
        if (rectMon >= 0 && rectMon !== monitor) return;
        const gap = this.core._settings.get_int('inside-gap');
        const workArea = this.core.monitors.monitorWorkArea(ws, monitor);
        if (!workArea || workArea.width === 0) return;
        if (!this.core.monitors.groupPlaces(ws, monitor)) return;
        const layout = this.core.windows.getWorkspaceLayout(ws, monitor);
        const slot = this.windowSlotRect(win, ws, layout, workArea, gap);
        if (!slot) return;
        const f = win.get_frame_rect();
        if (f.width === 0 || f.height === 0) return;
        let off = Math.abs(f.width - slot.w) > tol || Math.abs(f.height - slot.h) > tol ||
            Math.abs(f.x - slot.x) > tol || Math.abs(f.y - slot.y) > tol;
        if (!off && win.get_client_type() !== Meta.WindowClientType.X11) {
            // Surface divergence: a Wayland client (Firefox's session
            // restore) can re-commit its buffer at a SMALLER size after the
            // placement while the compositor keeps the FRAME at the placed
            // geometry — the frame rect then lies about the visible window
            // (every frame-based check passes, the content renders short).
            // A healthy Wayland buffer ≥ frame (shadow margins); buffer <
            // frame = the client shrank its surface → treat as off-slot.
            // (X11 SSD frames legitimately exceed the buffer — excluded.)
            const buffer = win.get_buffer_rect();
            if (buffer.width > 0 && (buffer.width < f.width || buffer.height < f.height)) {
                // Strike bound: the frame is ALREADY in slot here (this
                // branch only runs when the frame check passed), so the
                // correction below is a fresh configure of the identical
                // rect — the Firefox-restore client obeys it (surface
                // heals → counter resets), but a client that structurally
                // never fills its frame (pascube (GTK3): committing a
                // surface 37px shorter than the frame, top
                // inset only, from first placement) makes every re-place a
                // no-op: without the bound the settle window burns ~12
                // futile moves + log lines fighting a fight it cannot win.
                const strikes = (win._plaidSurfaceStrikes || 0) + 1;
                win._plaidSurfaceStrikes = strikes;
                if (strikes > 3) {
                    if (strikes === 4)
                        this.core.debugLog(`surface divergence: accepting client geometry for ${win.get_wm_class_instance() || '?'} ` +
                            `frame=(${f.x},${f.y},${f.width},${f.height}) buffer=(${buffer.x},${buffer.y},${buffer.width},${buffer.height})`);
                    return;
                }
                this.core.debugLog(`slot re-assert (surface): ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) ` +
                    `buffer=(${buffer.x},${buffer.y},${buffer.width},${buffer.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h}) (strike ${strikes}/3)`);
                off = true;
            } else {
                // Surface (re)covered the frame — forget past strikes so a
                // later genuine shrink (Firefox restore round 2) gets a
                // fresh correction budget.
                win._plaidSurfaceStrikes = 0;
            }
        }
        if (off) {
            if (mode === 'direct') {
                // Direct re-place: forces a fresh configure the client must
                // obey (the maximize-keybind path) — silent, unanimated, no
                // verify/float machinery, so it cannot re-lose the race.
                this.core.debugLog(`slot re-assert: ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h})`);
                {
                    win.move_resize_frame(true, slot.x, slot.y, slot.w, slot.h);
                    this.core.signals.scheduleBorders();
                }
            } else {
                this.core.debugLog(`slot re-assert: ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h})`);
                this.core.signals.scheduleRetile(ws);
            }
        }
    }

    safeMove(win, x, y, w, h) {
        if (!win || win.is_fullscreen() || !win.get_workspace()) return;
        if (!(w > 0) || !(h > 0)) return;
        if (!Number.isFinite(x + y + w + h)) return;
        if (this.core._animTargets) {
            this.core._animTargets.set(win, { x, y, w, h });
            return;
        }

        const actor = win.get_compositor_private();
        if (actor) actor.remove_all_transitions();
        win.move_resize_frame(true, x, y, w, h);
    }

    destroy() {
        this.stopPressTracking();
        this.stopLiveResizeLoop();
        this.disconnectGrabBoundaryHooks();
        this.core._grabOp = null;
        this.core._grabWindow = null;
        this.core._grabStartFrame = null;
        this.core._grabCarried = null;
        super.destroy();
    }
}
