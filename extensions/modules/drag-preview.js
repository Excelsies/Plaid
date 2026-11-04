// Drag previews: the full-screen overlay, the blue drop rectangle, and the
// dwindle/master-stack target calculations used while dragging a window.
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
            const glide = monitors.groupPlaces(ws, ptrMon) &&
                this.core.windows.getWorkspaceLayout(ws, ptrMon) === 'spiral';
            if (rect)
                this.showDropPreview(rect.x, rect.y, rect.w, rect.h, glide);
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
            const leaf = this.computeDwindleDropTarget(ws, px, py, src);
            if (leaf && leaf.type === 'leaf') {
                this.showDropPreview(leaf._x, leaf._y, leaf._w, leaf._h);
            } else {
                this.hideDropPreview();
            }
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
        if (tiled.length === 0) return { rect: this.core.geometry.singleWindowRect(workArea) };
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
            const leaf = this.computeDwindleDropTarget(ws, px, py, mon);
            if (!leaf || leaf.type !== 'leaf') return null;
            const target = leaf.window;
            const rect = { x: leaf._x, y: leaf._y, w: leaf._w, h: leaf._h };
            return { rect, tree: () => {
                const tree = this.core.bsp.bspClone(this.core.bsp.bspGetTree(ws, mon));
                const at = this.core.bsp.bspFindLeaf(tree, target);
                if (!at) return null;
                return this.core.bsp.bspReplaceLeaf(tree, at, win, this.core.windows.dwindleDropRatio(tree, target));
            } };
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

    computeDwindleDropTarget(ws, px, py, mon) {
        const tree = this.core.bsp.bspGetTree(ws, mon);
        if (!tree) return null;

        const gap = this.core._settings.get_int('inside-gap');
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        if (!workArea) return null;

        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return null;
        const ax = area.x;
        const ay = area.y;
        const aw = area.w;
        const ah = area.h;

        // Drop zones live inside the outside-gapped area — a pointer in the
        // outside-gap strip selects nothing.
        if (px < ax || px > ax + aw || py < ay || py > ay + ah)
            return null;

        this.core.bsp.bspTagGeometry(tree, ax, ay, aw, ah, gap);
        return this.core.bsp.bspFindLeafAtPoint(tree, ax, ay, aw, ah, px, py, gap);
    }

    // glide: fade in on its first appearance, then glide between targets
    // (Spiral's zones); otherwise it jumps.
    showDropPreview(x, y, w, h, glide = false) {
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
        if (glide) {
            this.glideDropPreview(x, y, w, h);
            return;
        }
        const p = this.core._dropPreview;
        // After a glide: no ease left running, no partial fade, and no
        // remembered target (a later glide to it would be skipped).
        if (this.core._dropPreviewTarget || p.opacity !== 255) {
            p.remove_all_transitions();
            p.opacity = 255;
            this.core._dropPreviewTarget = null;
        }
        if (p.style !== PREVIEW_STYLE)
            p.style = PREVIEW_STYLE;
        this.core._dropPreview.visible = true;
        this.core._dropPreview.set_position(x, y);
        this.core._dropPreview.set_size(w, h);
    }

    // The preview's target is remembered (_dropPreviewTarget) so the same
    // one is not re-eased every tick.
    glideDropPreview(x, y, w, h) {
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
