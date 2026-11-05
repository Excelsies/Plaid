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

// movewindow: the point a pixel inside the neighbour past each edge of a
// slot, as Hyprland's focal point (gap: the inside gap; a rect's far edge
// counts as on it), and the side a window moved toward a lone partner lands
// on (Hyprland's direction override).
const FOCAL = {
    left: (s, gap) => [s.x - gap - 1, s.y + s.h / 2],
    right: (s, gap) => [s.x + s.w + gap + 1, s.y + s.h / 2],
    up: (s, gap) => [s.x + s.w / 2, s.y - gap - 1],
    down: (s, gap) => [s.x + s.w / 2, s.y + s.h + gap + 1],
};
const PAST_PARTNER = { left: 'left', right: 'right', up: 'top', down: 'bottom' };

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
        // The live slots as laid out (a resize since the last structural
        // change left them unoriented); the ghost lost a window, so it is
        // oriented as the layout without it will be.
        const live = bsp.bspSlotRects(bsp.bspClone(tree), workArea, ws, mon, false);
        const home = live.get(win) ?? null;
        const ghost = home ? bsp.bspRemove(bsp.bspClone(tree), win) : bsp.bspClone(tree);
        if (!ghost || ghost.type === 'empty') return null;
        return { ws, mon, win, workArea, tree: ghost, rects: bsp.bspSlotRects(ghost, workArea, ws, mon, !!home),
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
        let floated = false;
        for (const [w, r] of atHome ? g.live : g.rects) {
            if (w === g.win || !w.get_compositor_private() || w.is_fullscreen()) continue;
            const f = w.get_frame_rect();
            // No commit yet: its first-frame retile re-flows the drag again.
            if (f.width <= 0 || f.height <= 0) continue;
            const s = { win: w, startX: f.x, startY: f.y, startW: f.width, startH: f.height,
                targetX: r.x, targetY: r.y, targetW: r.w, targetH: r.h };
            // Opened mid-drag, its first placement: floated as at any open
            // (bsp.maxBelowOpenBox), else popped in at its slot without the
            // cursor warp.
            const below = this.core._newWindowSet?.has(w) &&
                this.core.bsp.maxBelowOpenBox(w, this.core.bsp.isSpiral(g.ws, g.mon));
            if (below) {
                this.core.placement.floatAtOpen(w, below);
                floated = true;
                continue;
            }
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
        // The ghost is rebuilt without it (layouts.doRetileWorkspace).
        if (floated) this.core.layouts.retileWorkspace(g.ws);
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
            g.zones.set(key, this.core.bsp.bspSlotRects(drop, g.workArea, g.ws, g.mon).get(g.win) ?? null);
        }
        const rect = g.zones.get(key);
        return rect ? { target, side, rect } : null;
    }

    // Hyprland's movewindow of a tile of Spiral group (ws, mon): it leaves its
    // leaf and splits the leaf nearest the point just past its slot's edge
    // (FOCAL) on the side that point picks; toward a lone partner across
    // its parent split, past that partner. Past the tiling area it joins the
    // group of the monitor in that direction, if any, at that point when it
    // is Spiral; a monitor that does not tile gets GNOME's move.
    moveWindow(win, ws, mon, dir) {
        const bsp = this.core.bsp;
        const monitors = this.core.monitors;
        const slot = bsp.spiralSlots(ws, mon).get(win);
        const area = this.core.geometry.outsideArea(monitors.monitorWorkArea(ws, mon));
        if (!slot || !area) return false;
        const gap = this.core._settings.get_int('inside-gap');
        const [px, py] = FOCAL[dir](slot, gap);
        const name = `${win.get_wm_class_instance() || '?'} id=${win.get_id()}`;
        if (px < area.x || px >= area.x + area.w || py < area.y || py >= area.y + area.h) {
            const to = monitors.neighbor(mon, dir);
            if (to < 0) return false;
            this.core.debugLog(`spiral: move ${name} ${dir} to monitor ${to}`);
            // Another layout takes it by its own rule. A monitor that places
            // nothing, or a window on every workspace (its record may name
            // another one), gets GNOME's move; its group follows.
            if (monitors.groupPlaces(ws, to) && !win.is_on_all_workspaces())
                monitors.moveWindowToGroup(win, monitors.monConn(to), 'move', bsp.isSpiral(ws, to) ? [px, py] : null);
            else
                monitors.moveToMonitor(win, to);
            return true;
        }
        const tree = bsp.bspGetTree(ws, mon);
        const path = [];
        if (!bsp.bspFindPath(tree, win, path) || path.length === 0) return false;
        const parent = path[path.length - 1];
        const back = dir === 'left' || dir === 'up';
        const partner = back ? parent.first : parent.second;
        const across = parent.direction === (dir === 'left' || dir === 'right' ? 'h' : 'v');
        const side = across && partner.type === 'leaf' && partner.window !== win ? PAST_PARTNER[dir] : null;
        const rest = bsp.bspRemove(bsp.bspClone(tree), win);
        // The layout the window leaves behind, as the next retile orients it
        // (a move is structural: bsp.orientLive runs on the result).
        bsp.orientSpiral(rest, area, gap, ws, mon);
        bsp.bspTagGeometry(rest, area.x, area.y, area.w, area.h, gap);
        const next = this.insertNear(rest, win, px, py, side);
        bsp.bspSetTree(ws, mon, next);
        bsp.markStructural(ws, mon);
        this.core.debugLog(`spiral: move ${name} ${dir} -> ${bsp.dwindleShapeToString(next)}`);
        this.core.layouts.refreshSavedShape(ws, next, mon);
        this.core.layouts.retileWorkspace(ws);
        return true;
    }

    // movewindow's reinsertion into a tagged tree: `win` splits the leaf
    // nearest (px, py), on `side` or the one the point picks (bsp.pointSide).
    insertNear(tree, win, px, py, side = null) {
        const bsp = this.core.bsp;
        const target = bsp.nearestLeaf(tree, px, py);
        if (!target) return bsp.bspMakeLeaf(win);
        return this.dropTree(tree, target.window, win, side ?? bsp.pointSide(target, px, py));
    }

    // A drop's side is pinned where the box rule would turn it (the target's
    // box in the tagged tree; untagged: pinned), so the orientation pass
    // keeps it; a side the rule gives anyway follows its box later.
    dropTree(tree, target, win, side) {
        const bsp = this.core.bsp;
        const dir = (side === 'left' || side === 'right') ? 'h' : 'v';
        const leaf = bsp.bspFindLeaf(tree, target);
        const pinned = !(leaf?._w > 0 && leaf._h > 0) || dir !== bsp.boxDirection({ w: leaf._w, h: leaf._h });
        return bsp.bspInsertAtLeaf(tree, leaf, win, dir, side === 'left' || side === 'top', 0.5, pinned);
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
            this.core.dragPreview.showDropPreview(rect.x, rect.y, rect.w, rect.h);
        else
            this.core.dragPreview.hideDropPreview();
    }

    // The drag is over another monitor: the Spiral source group re-flows
    // without the window (dragPreview's cross branch).
    leaveSource(win, ws, src) {
        let g = this.core._dragGhost;
        if (!g || g.ws !== ws || g.mon !== src || g.win !== win) {
            this.syncDragTree(ws, win, src);
            g = this.core._dragGhost = this.buildDragGhost(win, ws, src);
        }
        if (!g) return;
        this.shrinkDraggedWindow(win);
        g.leftHome = true;
        this.showDragLayout(g, false);
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
    // Also the dwindle drop cache (dragPreview): every drag reset clears it.
    clearGhosts() {
        this.core._dragGhost = null;
        this.core._dropGhost = null;
        this.core._dwindleDropCache = null;
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
