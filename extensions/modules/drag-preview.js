// Drag previews: the full-screen overlay, the blue drop rectangle, and the
// dwindle/master-stack target calculations used while dragging a window.
// Owns _dwindleDropCache (the drag's dwindle slots and landings; cleared
// with the drag ghosts, spiral.clearGhosts).
//
// Methods live on this subsystem class.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { isBspLayout } from './helpers.js';

const PREVIEW_STYLE = 'background-color: rgba(53, 132, 228, 0.15); border: 2px solid #3584e4;';
const DROP_PREVIEW_FADE_MS = 120;
const DROP_PREVIEW_GLIDE_MS = 80;


export class DragPreview {
    constructor(core) {
        this.core = core;
    }

    updateDropOverlaySize() {
        const monitors = global.display.get_n_monitors();
        let maxX = 0, maxY = 0;
        for (let i = 0; i < monitors; i++) {
            const geom = global.display.get_monitor_geometry(i);
            maxX = Math.max(maxX, geom.x + geom.width);
            maxY = Math.max(maxY, geom.y + geom.height);
        }
        if (this.core._dropOverlay) {
            this.core._dropOverlay.set_position(0, 0);
            this.core._dropOverlay.set_size(maxX, maxY);
        }
    }

    updateMoveDragPreview(metaWindow) {
        if (!metaWindow || !this.core._settings) return;
        // Sliding to a drag-scroll target: a zone would draw over the slide.
        if (this.core.dragScroll.active() && this.core.dragScroll.sliding()) {
            this.hideDropPreview();
            return;
        }
        const ws = metaWindow.get_workspace();
        if (!ws) return;
        // Click-vs-drag gate: keep the overlay hidden until the window
        // actually travelled — a titlebar click must not show a drag preview.
        // A Spiral drag that has started shows its home layout instead.
        const dragging = this.core.grab.movedPastGrace(metaWindow);
        if (!dragging && !this.core._dragGhost) {
            this.hideDropPreview();
            return;
        }
        const [px, py] = global.get_pointer();
        // Over another tiled monitor the drop goes to its group.
        const monitors = this.core.monitors;
        const src = monitors.windowMon(metaWindow);
        const ptrMon = monitors.monitorAt(px, py);
        if (ptrMon !== src && monitors.monitorTiled(ptrMon)) {
            // A Spiral source re-flows without the window.
            if (dragging && monitors.groupPlaces(ws, src) &&
                this.core.windows.getWorkspaceLayout(ws, src) === 'spiral')
                this.core.spiral.leaveSource(metaWindow, ws, src);
            const rect = dragging ? this.crossDropPlan(metaWindow, ws, ptrMon, px, py)?.rect : null;
            if (rect)
                this.showDropPreview(rect.x, rect.y, rect.w, rect.h);
            else
                this.hideDropPreview();
            return;
        }
        if (!monitors.groupPlaces(ws, src)) {
            this.hideDropPreview();
            return;
        }

        const tiledWindows = monitors.getWindowsForGroup(ws, src).filter(w => !this.core.windows.isFloating(w));
        if (tiledWindows.length <= 1) {
            this.hideDropPreview();
            return;
        }

        const layout = this.core.windows.getWorkspaceLayout(ws, src);
        if (layout === 'spiral') {
            this.core.spiral.updateDragPreview(metaWindow, ws, px, py, dragging);
            return;
        }
        if (!dragging) {
            this.hideDropPreview();
            return;
        }
        if (isBspLayout(layout)) {
            const rect = this.dwindleDropPreview(metaWindow, ws, px, py, src);
            if (rect)
                this.showDropPreview(rect.x, rect.y, rect.w, rect.h);
            else
                this.hideDropPreview();
        } else {
            const targetIdx = this.core.layouts.computeMasterStackDropTarget(ws, px, py, src);
            if (targetIdx >= 0) {
                this.showMasterStackPreview(ws, targetIdx, src);
            } else {
                this.hideDropPreview();
            }
        }
    }

    // A drop of `win` (not in that group yet) on monitor `mon`, as the same
    // drop within a monitor would show and make it: { rect, tree?, before? }.
    // An empty monitor takes it whole; a floating one leaves it where it is
    // (no rect); null: the pointer is not over a slot there.
    crossDropPlan(win, ws, mon, px, py) {
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        if (!this.core.geometry.isValidWorkArea(workArea)) return null;
        const g = global.display.get_monitor_geometry(mon);
        if (!g || px < g.x || px >= g.x + g.width || py < g.y || py >= g.y + g.height) return null;
        if (!this.core.monitors.groupPlaces(ws, mon)) return {};
        const layout = this.core.windows.getWorkspaceLayout(ws, mon);
        const tiled = this.core.monitors.getWindowsForGroup(ws, mon)
            .filter(w => !this.core.windows.isFloating(w) && w !== win);
        if (tiled.length === 0) return { rect: this.core.bsp.loneTileRect(win, workArea, ws, mon) };
        if (layout === 'spiral') {
            // The target monitor's own ghost: zones and the drop's tree.
            let g = this.core._dropGhost;
            if (!g || g.ws !== ws || g.mon !== mon || g.win !== win) {
                this.core.spiral.syncDragTree(ws, win, mon);
                g = this.core._dropGhost = this.core.spiral.buildDragGhost(win, ws, mon);
            }
            const zone = g ? this.core.spiral.dropZone(g, px, py) : null;
            return zone ? { rect: zone.rect, tree: () => this.core.spiral.dropTree(this.core.bsp.bspClone(g.tree), zone.target, win, zone.side) } : null;
        }
        if (isBspLayout(layout)) {
            if (this.core._dwindleDropCache?.mon !== mon)
                this.core.spiral.syncDragTree(ws, win, mon);
            const rect = this.dwindleDropPreview(win, ws, px, py, mon);
            const tree = this.core.bsp.bspGetTree(ws, mon);
            const target = rect && tree
                ? this.core.geometry.dropTargetAt(this.core._dwindleDropCache.live, workArea, px, py, mon) : null;
            return target ? { rect, tree: () => this.dwindleDropTree(this.core.bsp.bspClone(tree), win, target, workArea, ws, mon) } : null;
        }
        const idx = this.core.layouts.computeMasterStackDropTarget(ws, px, py, mon);
        if (idx < 0) return null;
        return { rect: this.masterStackPreviewRect(ws, idx, mon), before: tiled[idx] ?? null };
    }

    showMasterStackPreview(ws, targetIdx, mon) {
        const r = this.masterStackPreviewRect(ws, targetIdx, mon);
        if (r) this.showDropPreview(r.x, r.y, r.w, r.h);
    }

    masterStackPreviewRect(ws, targetIdx, mon) {
        const gap = this.core._settings.get_int('inside-gap');
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        if (!workArea) return null;

        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return null;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;
        const masterRatio = this.core.layouts.getMasterRatio(ws, mon);
        const layout = this.core.windows.getWorkspaceLayout(ws, mon);

        let rx, ry;
        let rw, rh;

        if (targetIdx === 0) {
            if (layout === 'centered-master-stack') {
                const masterW = Math.floor((areaW - gap * 2) * masterRatio);
                rx = areaX + Math.floor((areaW - masterW) / 2);
                rw = masterW;
            } else {
                rw = Math.floor((areaW - gap) * masterRatio);
                rx = areaX;
            }
            ry = areaY;
            rh = areaH;
        } else {
            if (layout === 'centered-master-stack') {
                const leftCount = Math.ceil((this.core.monitors.getWindowsForGroup(ws, mon)
                    .filter(w => !this.core.windows.isFloating(w)).length - 1) / 2);
                const masterW = Math.floor((areaW - gap * 2) * masterRatio);
                const masterX = areaX + Math.floor((areaW - masterW) / 2);
                if (targetIdx <= leftCount) {
                    rx = areaX;
                    rw = masterX - areaX - gap;
                } else {
                    rx = masterX + masterW + gap;
                    rw = areaX + areaW - rx;
                }
            } else {
                const masterW = Math.floor((areaW - gap) * masterRatio);
                rx = areaX + masterW + gap;
                rw = areaW - masterW - gap;
            }
            ry = areaY;
            rh = areaH;
        }

        return { x: rx, y: ry, w: rw, h: rh };
    }

    // The target splits along the longer side of its slot once `win` is gone
    // (not before: a target that then spans the screen would give a strip),
    // `win` second. null: no change. Group (ws, mon) gives the minimums.
    dwindleDropTree(tree, win, target, workArea, ws, mon) {
        const bsp = this.core.bsp;
        // Preserve the split ratio at the drop target so the re-insert
        // mirrors the previous proportions instead of resetting to the
        // default dwindle-ratio.
        const targetRatio = this.core.windows.dwindleDropRatio(tree, target);
        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return null;
        // With a window from elsewhere this only collapses empty children.
        const newTree = bsp.bspRemove(tree, win);
        const leaf = bsp.bspFindLeaf(newTree, target);
        if (!leaf) return null;
        const gap = this.core._settings.get_int('inside-gap');
        bsp.treeMinSizes(newTree, gap, ws, mon);
        bsp.clampTreeToMinSizes(newTree, area.w, area.h, gap);
        bsp.bspTagGeometry(newTree, area.x, area.y, area.w, area.h, gap);
        return bsp.bspReplaceLeaf(newTree, leaf, win, targetRatio);
    }

    // The window's slot after a drop on group (ws, mon) (its own slot over its
    // own leaf): the target is the slot under the clamped pointer, else the
    // closest (geometry.dropTargetAt), so a gap or the top bar still drops.
    dwindleDropPreview(win, ws, px, py, mon) {
        const bsp = this.core.bsp;
        const tree = bsp.bspGetTree(ws, mon);
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        if (!tree || !this.core.geometry.isValidWorkArea(workArea)) return null;
        // Per drag and monitor, until the tree changes (layouts.doRetileWorkspace
        // and the drag resets clear it).
        if (!this.core._dwindleDropCache || this.core._dwindleDropCache.mon !== mon) {
            this.core._dwindleDropCache = { mon, live: bsp.bspSlotRects(bsp.bspClone(tree), workArea, ws, mon),
                landing: new Map() };
        }
        const c = this.core._dwindleDropCache;
        const target = this.core.geometry.dropTargetAt(c.live, workArea, px, py, mon);
        if (!target) return null;
        if (target === win) return c.live.get(win) ?? null;
        if (!c.landing.has(target)) {
            const drop = this.dwindleDropTree(bsp.bspClone(tree), win, target, workArea, ws, mon);
            c.landing.set(target, drop ? bsp.bspSlotRects(drop, workArea, ws, mon).get(win) ?? null : null);
        }
        return c.landing.get(target);
    }

    // Fades in on its first appearance, then glides between targets. The
    // target is remembered (_dropPreviewTarget) so the same one is not
    // re-eased every tick.
    showDropPreview(x, y, w, h) {
        if (w <= 0 || h <= 0) {
            this.hideDropPreview();
            return;
        }
        if (!this.core._dropPreview) {
            this.core._dropPreview = new St.Widget({
                style: PREVIEW_STYLE,
                reactive: false,
                visible: false,
            });
            this.core._dropOverlay.add_child(this.core._dropPreview);
        }
        const p = this.core._dropPreview;
        const t = this.core._dropPreviewTarget;
        if (p.visible && t && t.x === x && t.y === y && t.w === w && t.h === h)
            return;
        this.core._dropPreviewTarget = { x, y, w, h };
        if (!p.visible) {
            // Styled here so a border-radius change applies to the next drag.
            const radius = Math.max(0, this.core._settings.get_int('border-radius'));
            p.style = `${PREVIEW_STYLE} border-radius: ${radius}px;`;
            p.remove_all_transitions();
            p.set_position(x, y);
            p.set_size(w, h);
            p.opacity = 0;
            p.visible = true;
            p.ease({ opacity: 255, duration: DROP_PREVIEW_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            return;
        }
        p.ease({
            x, y, width: w, height: h, opacity: 255,
            duration: DROP_PREVIEW_GLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    hideDropPreview() {
        // Hide, don't destroy — the 16ms grab loop alternates between
        // target/no-target regions; recreating the widget each tick churns
        // allocations and re-layout under a live grab.
        if (this.core._dropPreview) {
            this.core._dropPreview.remove_all_transitions();
            this.core._dropPreview.visible = false;
        }
        this.core._dropPreviewTarget = null;
    }

    destroyDropPreview() {
        if (this.core._dropPreview) {
            this.core._dropPreview.destroy();
            this.core._dropPreview = null;
        }
    }

    destroyDropOverlay() {
        if (this.core._dropOverlay) {
            this.core._dropOverlay.destroy();
            this.core._dropOverlay = null;
        }
    }

    init() {
        if (this.core._dropOverlay) return;
        this.core._dropOverlay = new St.Widget({
            reactive: false,
            visible: true,
        });
        Main.layoutManager.uiGroup.add_child(this.core._dropOverlay);
    }

    destroy() {
        this.destroyDropPreview();
        this.destroyDropOverlay();
    }
}
