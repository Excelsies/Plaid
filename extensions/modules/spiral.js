// Spiral drag: while a window is dragged, the others are laid out on a copy
// of the tree without it (the ghost, _dragGhost) and reflow there; the
// dragged window shrinks about the grab point. Drop zones are the triangles
// of each ghost slot (Hyprland's smart_split), and a drop inserts into the
// ghost tree the zone was picked on, so it lands where its preview was. Over
// its own slot (home) the live layout shows and a drop changes nothing.
//
// Owns _dragGhost, _dropGhost (the ghost of another monitor a drop goes to)
// and _dragShrunk; the transform driver draws the reflow.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PlaidSubsystem } from './subsystem.js';

const DRAG_SCALE = 0.85;
const DRAG_SHRINK_MS = 150;
// Once the pointer has left home, home is only its slot's core.
const HOME_CORE = 0.4;
const HOME_HYSTERESIS_PX = 12;

export class Spiral extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    // The drag's layout of group `mon` (default the window's own): the live
    // slots, the ghost tree without `win` and its slots, `win`'s home slot.
    // On another monitor's group `win` is not in the tree: the ghost is the
    // live tree and there is no home. null: no tree, or no valid work area.
    buildDragGhost(win, ws, mon = this.core.monitors.windowMon(win)) {
        const bsp = this.core.bsp;
        const tree = bsp.bspGetTree(ws, mon);
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        if (!tree || !this.core.geometry.isValidWorkArea(workArea)) return null;
        const live = bsp.bspSlotRects(bsp.bspClone(tree), workArea);
        const home = live.get(win) ?? null;
        const ghost = home ? bsp.bspRemove(bsp.bspClone(tree), win) : bsp.bspClone(tree);
        if (!ghost || ghost.type === 'empty') return null;
        return { ws, mon, win, workArea, tree: ghost, rects: bsp.bspSlotRects(ghost, workArea),
            live, home, atHome: null, leftHome: false, zones: new Map() };
    }

    // Re-flow the group to the ghost's slots (away from home) or the live
    // ones (at home), from where each window is drawn.
    showDragLayout(g, atHome) {
        if (g.atHome === atHome) return;
        g.atHome = atHome;
        // Take the group's windows from an in-flight retile where they are
        // drawn: the reflow continues from there, and the run ends with its
        // other groups (another monitor keeps animating).
        const conn = this.core.monitors.monConn(g.mon);
        const carry = this.core.transforms.takeOver(g.ws, w => this.core.monitors.windowConn(w) === conn);
        const states = [];
        for (const [w, r] of atHome ? g.live : g.rects) {
            if (w === g.win || !w.get_compositor_private() || w.is_fullscreen()) continue;
            const f = w.get_frame_rect();
            // No commit yet: its first-frame retile re-flows the drag again.
            if (f.width <= 0 || f.height <= 0) continue;
            const s = { win: w, startX: f.x, startY: f.y, startW: f.width, startH: f.height,
                targetX: r.x, targetY: r.y, targetW: r.w, targetH: r.h };
            // Opened mid-drag: pop in at its slot, without the cursor warp.
            if (this.core._newWindowSet?.has(w)) {
                s.popin = true;
                this.core._newWindowSet.delete(w);
                this.core.placement.revealPlacedWindow(w);
            }
            states.push(s);
        }
        this.core.debugLog(`spiral: drag ${atHome ? 'home' : 'reflow'} ws=${this.core.geometry.wsIndex(g.ws)} ` +
            `${g.win.get_wm_class_instance() || '?'} id=${g.win.get_id()} (${states.length} windows)`);
        this.core.transforms.run(states, () => {}, carry);
    }

    // The workspace under the drag changed (a window opened, closed or
    // moved): sync the live tree, then rebuild the ghost and re-flow if
    // anything on screen changes.
    refreshDragGhost() {
        const old = this.core._dragGhost;
        if (!old) return;
        const ws = old.ws;
        this.syncDragTree(ws, old.win, old.mon);
        const g = this.buildDragGhost(old.win, ws, old.mon);
        const same = (a, b) => {
            if (!a || !b) return a === b;
            if (a.size !== undefined) {
                if (a.size !== b.size) return false;
                for (const [w, r] of a) {
                    if (!same(r, b.get(w))) return false;
                }
                return true;
            }
            return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
        };
        if (g && same(g.home, old.home) && same(g.rects, old.rects) && same(g.live, old.live))
            return;
        this.core.debugLog(`spiral: drag ghost refreshed ws=${this.core.geometry.wsIndex(ws)} ${g ? '' : '(none)'}`);
        if (g) g.leftHome = old.leftHome;
        this.core._dragGhost = g;
        if (g && this.core._grabOp)
            this.core.dragPreview.updateMoveDragPreview(old.win);
    }

    // The group's tree as a retile would make it. A dragged window the tree
    // does not hold yet is left out: the drop places it. mon: the group (the
    // window's own, or the one a drop on another monitor goes to).
    syncDragTree(ws, win, mon = this.core.monitors.windowMon(win)) {
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        const area = this.core.geometry.isValidWorkArea(workArea) ? this.core.geometry.outsideArea(workArea) : null;
        if (!area) return;
        const bsp = this.core.bsp;
        const tree = bsp.bspGetTree(ws, mon);
        const held = !!(tree && bsp.bspFindLeaf(tree, win));
        const tiled = this.core.monitors.getWindowsForGroup(ws, mon)
            .filter(w => !this.core.windows.isFloating(w) && (held || w !== win));
        bsp.bspSetTree(ws, mon, bsp.syncTree(ws, tree, tiled, area,
            this.core._settings.get_int('inside-gap'), mon));
    }

    // Over the dragged window's slot (its core once left), the outside-gap
    // strip included; the hysteresis keeps a wobble from re-flowing every
    // neighbour.
    atHome(g, px, py) {
        let h = g.home;
        if (!h) return false;
        const a = this.core.geometry.outsideArea(g.workArea);
        const x = a ? Math.min(Math.max(px, a.x), a.x + a.w - 1) : px;
        const y = a ? Math.min(Math.max(py, a.y), a.y + a.h - 1) : py;
        if (g.leftHome) {
            const mx = h.w * (1 - HOME_CORE) / 2, my = h.h * (1 - HOME_CORE) / 2;
            h = { x: h.x + mx, y: h.y + my, w: h.w - 2 * mx, h: h.h - 2 * my };
        }
        const m = g.atHome === null ? 0 : g.atHome ? HOME_HYSTERESIS_PX : -HOME_HYSTERESIS_PX;
        return x >= h.x - m && x < h.x + h.w + m && y >= h.y - m && y < h.y + h.h + m;
    }

    // Like Hyprland's smart_split: the target's triangle under the pointer
    // picks the side; in a gap the closest slot is the target. The landing
    // rect of each (target, side) is computed once per ghost.
    dropZone(g, px, py) {
        // Same clamped point as the target, so the preview matches the drop.
        const pt = this.core.geometry.dropPoint(g.workArea, px, py, g.mon);
        if (!pt) return null;
        [px, py] = pt;
        const target = this.core.geometry.dropTargetAt(g.rects, g.workArea, px, py, g.mon);
        if (!target) return null;
        const side = this.core.geometry.dropZoneSide(g.rects.get(target), px, py);
        const key = `${target.get_id()}:${side}`;
        if (!g.zones.has(key)) {
            const drop = this.dropTree(this.core.bsp.bspClone(g.tree), target, g.win, side);
            g.zones.set(key, this.core.bsp.bspSlotRects(drop, g.workArea).get(g.win) ?? null);
        }
        const rect = g.zones.get(key);
        return rect ? { target, side, rect } : null;
    }

    dropTree(tree, target, win, side) {
        const dir = (side === 'left' || side === 'right') ? 'h' : 'v';
        return this.core.bsp.bspInsertAtLeaf(tree, this.core.bsp.bspFindLeaf(tree, target), win, dir,
            side === 'left' || side === 'top', 0.5);
    }

    // The move-drag preview of a Spiral group (dragPreview): the ghost is
    // built once the window has travelled, the others reflow, and the
    // preview glides between zones. Back inside the click guard is home too:
    // that release drops nothing.
    updateDragPreview(win, ws, px, py, dragging) {
        let g = this.core._dragGhost;
        if (!g && !dragging) {
            this.core.dragPreview.hideDropPreview();
            return;
        }
        if (!g || g.ws !== ws || g.mon !== this.core.monitors.windowMon(win) || g.win !== win) {
            this.syncDragTree(ws, win);
            g = this.core._dragGhost = this.buildDragGhost(win, ws);
        }
        if (!g) {
            this.core.dragPreview.hideDropPreview();
            return;
        }
        this.shrinkDraggedWindow(win);
        const atHome = !dragging || this.atHome(g, px, py);
        if (!atHome) g.leftHome = true;
        this.showDragLayout(g, atHome);
        const zone = !dragging || atHome ? null : this.dropZone(g, px, py);
        const zoneKey = zone ? `${zone.target.get_id()}:${zone.side}` : null;
        if (zone && zoneKey !== g.zoneKey)
            this.core.debugLog(`spiral: zone ${zone.target.get_wm_class_instance() || '?'} id=${zone.target.get_id()} ${zone.side}`);
        g.zoneKey = zoneKey;
        const rect = !dragging ? null : atHome ? g.home : zone?.rect;
        if (rect)
            this.core.dragPreview.showDropPreview(rect.x, rect.y, rect.w, rect.h, true);
        else
            this.core.dragPreview.hideDropPreview();
    }

    // The drop of a Spiral drag within its group: inserted on the drag's
    // layout (the ghost) where the zone was picked; home or no zone leaves
    // the live tree alone. Returns whether the tree changed.
    drop(win, ws, mon, px, py) {
        const cur = this.core._dragGhost;
        const g = cur?.ws === ws && cur.mon === mon && cur.win === win ? cur : this.buildDragGhost(win, ws, mon);
        if (!g || this.atHome(g, px, py)) return false;
        const zone = this.dropZone(g, px, py);
        if (!zone) return false;
        this.core.debugLog(`spiral: drop ${win.get_wm_class_instance() || '?'} id=${win.get_id()} ` +
            `on ${zone.target.get_wm_class_instance() || '?'} ${zone.side} ws=${this.core.geometry.wsIndex(ws)}`);
        this.core.bsp.bspSetTree(ws, mon, this.dropTree(g.tree, zone.target, win, zone.side));
        return true;
    }

    // Visual only, about the grab point: the titlebar stays under the
    // pointer.
    shrinkDraggedWindow(win) {
        if (this.core._dragShrunk) return;
        const actor = win.get_compositor_private();
        const b = win.get_buffer_rect();
        if (!actor || b.width <= 0 || b.height <= 0) return;
        const [px, py] = global.get_pointer();
        const d = { win, actor,
            pivotX: Math.min(1, Math.max(0, (px - b.x) / b.width)),
            pivotY: Math.min(1, Math.max(0, (py - b.y) / b.height)) };
        this.core._dragShrunk = d;
        actor.remove_all_transitions();
        actor.set_pivot_point(d.pivotX, d.pivotY);
        actor.ease({
            scale_x: DRAG_SCALE, scale_y: DRAG_SCALE,
            duration: this.core.placement.scaledAnimMs(DRAG_SHRINK_MS),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // Grab end: hand the shrunk window to the driver where it is drawn; the
    // release retile eases it to its slot.
    unshrinkDraggedWindow() {
        const d = this.core._dragShrunk;
        this.core._dragShrunk = null;
        if (!d || d.win.get_compositor_private() !== d.actor) return;
        const { win, actor } = d;
        const f = win.get_frame_rect();
        const b = win.get_buffer_rect();
        const sx = actor.scale_x;
        const sy = actor.scale_y;
        actor.remove_all_transitions();
        if (f.width <= 0 || f.height <= 0) {
            actor.set_scale(1, 1);
            return;
        }
        // The frame as drawn: scaled about the pivot, a point of the buffer.
        const ox = b.x + d.pivotX * b.width;
        const oy = b.y + d.pivotY * b.height;
        const r = { x: ox + (f.x - ox) * sx, y: oy + (f.y - oy) * sy, w: f.width * sx, h: f.height * sy };
        const conn = this.core.monitors.windowConn(win);
        const carry = this.core.transforms.takeOver(win.get_workspace(), w => this.core.monitors.windowConn(w) === conn);
        const states = [...carry.values()].map(p => ({ win: p.win, startX: p.startX, startY: p.startY,
            startW: p.startW, startH: p.startH, targetX: p.targetX, targetY: p.targetY,
            targetW: p.targetW, targetH: p.targetH }));
        const at = { startX: r.x, startY: r.y, startW: r.w, startH: r.h,
            targetX: r.x, targetY: r.y, targetW: r.w, targetH: r.h };
        carry.set(win, { ...at, win, actor, t0: GLib.get_monotonic_time(), dur: 0, sent: null, op0: null,
            visual: [r.x, r.y, r.w, r.h] });
        states.push({ ...at, win });
        this.core.transforms.run(states, () => {}, carry);
    }

    // A Clutter.Clone ignores its source's transform: give the drag-scroll
    // slide's clone of the shrunk window the drag's scale.
    shrinkSlideClone(win) {
        const actor = this.core._dragShrunk?.win === win ? this.core._dragShrunk.actor : null;
        if (!actor) return;
        const groups = Main.wm?._workspaceAnimation?._switchData?.monitors;
        if (!Array.isArray(groups)) return;
        const [px, py] = actor.get_pivot_point();
        const visit = parent => {
            for (const child of parent.get_children()) {
                if (child instanceof Clutter.Clone && child.source === actor) {
                    child.set_pivot_point(px, py);
                    child.set_scale(actor.scale_x, actor.scale_y);
                } else {
                    visit(child);
                }
            }
        };
        for (const group of groups) visit(group);
    }

    // The ghosts belong to the workspace and window set they were built for.
    clearGhosts() {
        this.core._dragGhost = null;
        this.core._dropGhost = null;
    }

    // Disable or shutdown mid-drag: no ghost, the shrunk window at identity.
    reset() {
        this.clearGhosts();
        const d = this.core._dragShrunk;
        this.core._dragShrunk = null;
        if (d && d.win.get_compositor_private() === d.actor) {
            d.actor.remove_all_transitions();
            d.actor.set_scale(1, 1);
        }
    }

    destroy() {
        this.reset();
        super.destroy();
    }
}
