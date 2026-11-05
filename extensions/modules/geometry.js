// Plaid — work-area / slot geometry helpers.
//
// Instance methods live on this subsystem class.


export class Geometry {
    constructor(core) {
        this.core = core;
    }

    isValidWorkArea(workArea) {
        // mutter can return a garbage rect from get_work_area_for_monitor
        // while monitors are mid-reconfiguration (the login race:
        // 9x 'get_logical_monitor_from_number' assertions → a (5,4,1,1)-class
        // rect passed the old width===0 guard and drove a false 1x1-slot
        // retile that floated Firefox at login). A healthy work area is
        // never under ~100px on either axis — reject anything smaller so
        // placements/slots/restores can never act on a degenerate rect.
        return !!(workArea &&
            Number.isFinite(workArea.x + workArea.y + workArea.width + workArea.height) &&
            workArea.width >= 100 && workArea.height >= 100);
    }

    outsideArea(workArea) {
        // The tiling area: the work area inset by the per-edge OUTSIDE gaps
        // (spacing between windows and the screen edges) — the same rect
        // whether one window or many (the multi-window layouts tile inside
        // it; the single-window placement IS it).
        if (!this.core._settings) return null;
        if (!this.isValidWorkArea(workArea)) return null;
        const top = this.core._settings.get_int('outside-gap-top');
        const bottom = this.core._settings.get_int('outside-gap-bottom');
        const left = this.core._settings.get_int('outside-gap-left');
        const right = this.core._settings.get_int('outside-gap-right');
        return {
            x: workArea.x + left,
            y: workArea.y + top,
            w: Math.max(1, workArea.width - left - right),
            h: Math.max(1, workArea.height - top - bottom),
        };
    }

    singleWindowRect(workArea) {
        return this.outsideArea(workArea);
    }

    minClampSlot(r, win, areaW, areaH) {
        if (!r) return r;
        const min = this.core.bsp.getWindowMinSize(win);
        if (min.w > 0 && r.w < min.w) r.w = Math.min(min.w, areaW);
        if (min.h > 0 && r.h < min.h) r.h = Math.min(min.h, areaH);
        return r;
    }

    // Squared distance from (px, py) to the rect (0 inside it).
    pointRectDistSq(x, y, w, h, px, py) {
        const dx = Math.max(x - px, 0, px - (x + w));
        const dy = Math.max(y - py, 0, py - (y + h));
        return dx * dx + dy * dy;
    }

    // The side of `r` a drop at (px, py) lands on: the diagonals cut it into
    // four triangles and the one under the point wins.
    dropZoneSide(r, px, py) {
        const dx = px - (r.x + r.w / 2);
        const dy = py - (r.y + r.h / 2);
        if (Math.abs(dy) * r.w < Math.abs(dx) * r.h)
            return dx > 0 ? 'right' : 'left';
        return dy > 0 ? 'bottom' : 'top';
    }

    // Clamped into the work area: mutter stops a dragged titlebar below the
    // top bar while the pointer goes on. null off monitor `monIdx` (default
    // the primary): no drop there.
    dropPoint(workArea, px, py, monIdx) {
        const mon = global.display.get_monitor_geometry(monIdx ?? global.display.get_primary_monitor());
        if (!mon || px < mon.x || px >= mon.x + mon.width || py < mon.y || py >= mon.y + mon.height)
            return null;
        return [Math.max(workArea.x, Math.min(workArea.x + workArea.width - 1, px)),
            Math.max(workArea.y, Math.min(workArea.y + workArea.height - 1, py))];
    }

    // The window whose slot (rects: win -> {x, y, w, h}) is under the
    // clamped pointer, else the closest, so a drop in a gap still has a
    // target.
    dropTargetAt(rects, workArea, px, py, mon) {
        const pt = this.dropPoint(workArea, px, py, mon);
        if (!pt) return null;
        [px, py] = pt;
        return this.nearestTo(rects, px, py);
    }

    // The key whose rect ([key, {x, y, w, h}] pairs) is closest to (px, py),
    // the first on a tie; null when there is none.
    nearestTo(rects, px, py) {
        let best = null;
        let bestD = Infinity;
        for (const [key, r] of rects) {
            const d = this.pointRectDistSq(r.x, r.y, r.w, r.h, px, py);
            if (d < bestD) {
                best = key;
                bestD = d;
            }
        }
        return best;
    }

    bgAppRealToDisplay(realIdx) {
        const parkingIdx = this.core._backgroundAppParkingWs ?
            this.wsIndex(this.core._backgroundAppParkingWs) : -1;
        // No parking workspace => no reserved slot => identity mapping. A
        // bare `realIdx > -1` is always true and would shift every label
        // down by one.
        return parkingIdx >= 0 && realIdx > parkingIdx ? realIdx - 1 : realIdx;
    }

    wsIndex(ws) {
        if (!ws) return -1;
        // Scan for identity instead of calling ws.index(): during shell teardown
        // the workspace object can already be disposed, and Mutter asserts on
        // meta_workspace_index() for it.
        const wm = global.workspace_manager;
        for (let i = 0; i < wm.get_n_workspaces(); i++) {
            if (wm.get_workspace_by_index(i) === ws) return i;
        }
        return -1;
    }

}
