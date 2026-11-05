// Plaid — BSP/dwindle tree operations, min-size math, and directional search.
//
// Instance methods live on this subsystem class.
// `this` (settings, _bspTrees, _dwindleLeafSigs, …) and call sites are unchanged.
// `mon` is the group's display monitor (see monitors.js); null names the
// primary's group.

import Meta from 'gi://Meta';

import { isBspLayout, isSpiralLayout } from './helpers.js';











































function _leafCount(node) {
    if (!node || node.type === 'empty') return 0;
    if (node.type === 'leaf') return 1;
    return _leafCount(node.first) + _leafCount(node.second);
}


export class Bsp {
    constructor(core) {
        this.core = core;
    }

    // Group (ws, mon) is laid out as Spiral.
    isSpiral(ws, mon) {
        return isSpiralLayout(this.core.windows.getWorkspaceLayout(ws, mon));
    }

    bspGetTree(workspace, mon) {
        const key = this.core.monitors.groupObj(workspace, mon);
        if (!this.core._bspTrees.has(key))
            this.core._bspTrees.set(key, null);
        return this.core._bspTrees.get(key);
    }

    bspSetTree(workspace, mon, tree) {
        this.core._bspTrees.set(this.core.monitors.groupObj(workspace, mon), tree);
    }

    // Structure, ratios, windows and geometry tags; no shared nodes.
    bspClone(node) {
        if (!node) return node;
        const copy = { ...node };
        if (node.type === 'split') {
            copy.first = this.bspClone(node.first);
            copy.second = this.bspClone(node.second);
        }
        return copy;
    }

    bspMakeLeaf(win) {
        return { type: 'leaf', window: win };
    }

    bspMakeSplit(dir, ratio, first, second) {
        return { type: 'split', direction: dir, ratio, first, second };
    }

    // The boxes of a split's two children within its box: the first takes
    // `ratio` of the span less one gap, the second the rest.
    splitBoxes(node, box, gap) {
        const isH = node.direction === 'h';
        const split = Math.floor(((isH ? box.w : box.h) - gap) * node.ratio);
        if (isH) {
            return [{ x: box.x, y: box.y, w: split, h: box.h },
                { x: box.x + split + gap, y: box.y, w: box.w - split - gap, h: box.h }];
        }
        return [{ x: box.x, y: box.y, w: box.w, h: split },
            { x: box.x, y: box.y + split + gap, w: box.w, h: box.h - split - gap }];
    }

    // Split ratio for new windows: Spiral halves the target (as Hyprland),
    // dwindle keeps dwindle-ratio.
    bspSplitRatio(ws, mon) {
        if (ws && this.isSpiral(ws, mon)) return 0.5;
        return this.core._settings.get_double('dwindle-ratio');
    }

    // ratio null: dwindle-ratio.
    bspInsert(node, win, x, y, w, h, gap, ratio = null) {
        if (!node) return this.bspMakeLeaf(win);
        if (node.type === 'empty') return this.bspMakeLeaf(win);
        if (node.type === 'leaf') {
            const dir = w >= h ? 'h' : 'v';
            if (ratio === null) ratio = this.core._settings.get_double('dwindle-ratio');
            return this.bspMakeSplit(dir, ratio, node, this.bspMakeLeaf(win));
        }
        const [, b] = this.splitBoxes(node, { x, y, w, h }, gap);
        node.second = this.bspInsert(node.second, win, b.x, b.y, b.w, b.h, gap, ratio);
        return node;
    }

    bspRemove(node, win) {
        if (!node) return { type: 'empty' };
        if (node.type === 'empty') return node;
        if (node.type === 'leaf') {
            return node.window === win ? { type: 'empty' } : node;
        }
        node.first = this.bspRemove(node.first, win);
        node.second = this.bspRemove(node.second, win);
        if (node.first.type === 'empty' && node.second.type === 'empty')
            return { type: 'empty' };
        if (node.first.type === 'empty') return node.second;
        if (node.second.type === 'empty') return node.first;
        return node;
    }

    bspCollectWindows(node) {
        if (!node) return [];
        if (node.type === 'empty') return [];
        if (node.type === 'leaf') return [node.window];
        return [...this.bspCollectWindows(node.first), ...this.bspCollectWindows(node.second)];
    }

    bspLeaves(node, out = []) {
        if (!node || node.type === 'empty') return out;
        if (node.type === 'leaf') {
            out.push(node);
            return out;
        }
        this.bspLeaves(node.first, out);
        this.bspLeaves(node.second, out);
        return out;
    }

    // Every leaf's slot as a retile of group (ws, mon) lays it out (min-size
    // clamp included), so drag previews match the result. Clamps ratios in
    // place: pass a clone.
    bspSlotRects(tree, workArea, ws, mon) {
        const rects = new Map();
        if (!tree || tree.type === 'empty') return rects;
        if (tree.type === 'leaf') {
            const r = this.loneTileRect(tree.window, workArea, ws, mon);
            if (r) rects.set(tree.window, r);
            return rects;
        }
        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return rects;
        const gap = this.core._settings.get_int('inside-gap');
        this.treeMinSizes(tree, gap, ws, mon);
        this.clampTreeToMinSizes(tree, area.w, area.h, gap);
        this.bspTagGeometry(tree, area.x, area.y, area.w, area.h, gap);
        for (const l of this.bspLeaves(tree)) {
            rects.set(l.window, this.tileRect(l.window, { x: l._x, y: l._y,
                w: Math.max(l._w, l._minW || 0), h: Math.max(l._h, l._minH || 0) }, ws, mon));
        }
        return rects;
    }

    bspLayout(node, x, y, w, h, gap, skipWindow) {
        if (!node) return;
        if (node.type === 'empty') return;
        if (node.type === 'leaf') {
            node._x = x;
            node._y = y;
            node._w = w;
            node._h = h;
            if (node.window !== skipWindow) {
                // Live resize (skipWindow = the grabbed window, mutter's until the
                // grab ends): the loop runs every frame, re-send changed slots only.
                if (skipWindow) {
                    const sent = this.core._liveSent ??= new Map();
                    const last = sent.get(node.window);
                    if (last && last.x === x && last.y === y && last.w === w && last.h === h)
                        return;
                    sent.set(node.window, { x, y, w, h });
                }
                this.core.grab.safeMove(node.window, x, y, w, h);
            }
            return;
        }
        const firstEmpty = !node.first || node.first.type === 'empty';
        const secondEmpty = !node.second || node.second.type === 'empty';
        if (firstEmpty && secondEmpty) return;
        if (firstEmpty) {
            this.bspLayout(node.second, x, y, w, h, gap, skipWindow);
            return;
        }
        if (secondEmpty) {
            this.bspLayout(node.first, x, y, w, h, gap, skipWindow);
            return;
        }
        const [a, b] = this.splitBoxes(node, { x, y, w, h }, gap);
        if ((node.direction === 'h' ? Math.min(a.w, b.w) : Math.min(a.h, b.h)) < 0) return;
        this.bspLayout(node.first, a.x, a.y, a.w, a.h, gap, skipWindow);
        this.bspLayout(node.second, b.x, b.y, b.w, b.h, gap, skipWindow);
    }

    bspFindPath(node, win, path) {
        if (!node) return false;
        if (node.type === 'leaf') return node.window === win;
        path.push(node);
        if (this.bspFindPath(node.first, win, path)) return true;
        if (this.bspFindPath(node.second, win, path)) return true;
        path.pop();
        return false;
    }

    bspFindLeaf(node, win) {
        if (!node) return null;
        if (node.type === 'leaf') return node.window === win ? node : null;
        return this.bspFindLeaf(node.first, win) || this.bspFindLeaf(node.second, win);
    }

    bspSwapWindows(node, winA, winB) {
        if (!node) return;
        if (node.type === 'leaf') {
            if (node.window === winA) node.window = winB;
            else if (node.window === winB) node.window = winA;
            return;
        }
        this.bspSwapWindows(node.first, winA, winB);
        this.bspSwapWindows(node.second, winA, winB);
    }

    bspFindLeafAtPoint(node, x, y, w, h, px, py, gap) {
        if (!node) return null;
        if (node.type === 'empty') return node;
        if (node.type === 'leaf') return node;
        const [a, b] = this.splitBoxes(node, { x, y, w, h }, gap);
        const c = (node.direction === 'h' ? px < b.x : py < b.y) ? a : b;
        return this.bspFindLeafAtPoint(c === a ? node.first : node.second, c.x, c.y, c.w, c.h, px, py, gap);
    }

    bspReplaceLeaf(node, targetLeaf, newWin, preferredRatio = null) {
        if (!node) return null;
        if (node.type === 'empty') {
            if (node === targetLeaf)
                return this.bspMakeLeaf(newWin);
            return node;
        }
        if (node.type === 'leaf') {
            if (node === targetLeaf) {
                const dir = ((node._w || 0) >= (node._h || 0)) ? 'h' : 'v';
                const ratio = (preferredRatio && preferredRatio > 0 && preferredRatio < 1)
                    ? preferredRatio
                    : this.core._settings.get_double('dwindle-ratio');
                return this.bspMakeSplit(dir, ratio, node, this.bspMakeLeaf(newWin));
            }
            return node;
        }
        node.first = this.bspReplaceLeaf(node.first, targetLeaf, newWin, preferredRatio);
        node.second = this.bspReplaceLeaf(node.second, targetLeaf, newWin, preferredRatio);
        return node;
    }

    // Split targetLeaf with newWin on an explicit side (drop zones): dir 'h'
    // = side by side, 'v' = stacked; newFirst puts newWin left/top.
    bspInsertAtLeaf(node, targetLeaf, newWin, dir, newFirst, ratio) {
        if (!node || node.type === 'empty') return node;
        if (node.type === 'leaf') {
            if (node !== targetLeaf) return node;
            const leaf = this.bspMakeLeaf(newWin);
            return newFirst
                ? this.bspMakeSplit(dir, ratio, leaf, node)
                : this.bspMakeSplit(dir, ratio, node, leaf);
        }
        node.first = this.bspInsertAtLeaf(node.first, targetLeaf, newWin, dir, newFirst, ratio);
        node.second = this.bspInsertAtLeaf(node.second, targetLeaf, newWin, dir, newFirst, ratio);
        return node;
    }

    // Spiral splits the focused tiled window (else the leaf under or closest
    // to the pointer) along its longer side; the new window takes the half
    // the pointer is in. The warp to each revealed window leaves the pointer
    // on the slot's integer centre, the second half: the classic spiral when
    // unsteered. `tree` must be tagged.
    spiralInsertNew(ws, tree, win, area, mon) {
        const [px, py] = global.get_pointer();
        let target = null;
        let by = 'focus';
        const focus = global.display.focus_window;
        if (focus && focus !== win && focus.get_workspace() === ws && !this.core.windows.isFloating(focus))
            target = this.bspFindLeaf(tree, focus);
        if (!target && px >= area.x && px < area.x + area.w && py >= area.y && py < area.y + area.h) {
            target = this.bspFindLeafAtPoint(tree, area.x, area.y, area.w, area.h, px, py,
                this.core._settings.get_int('inside-gap'));
            by = 'pointer';
        }
        if (!target || target.type !== 'leaf') {
            target = null;
            by = 'nearest';
            let best = Infinity;
            for (const leaf of this.bspLeaves(tree)) {
                const d = this.core.geometry.pointRectDistSq(leaf._x, leaf._y, leaf._w, leaf._h, px, py);
                if (d < best) {
                    best = d;
                    target = leaf;
                }
            }
        }
        if (!target) {
            this.recordFirstOpenBox(win, mon);
            return this.bspMakeLeaf(win);
        }
        this.recordOpenBox(win, target._w, target._h);
        const dir = target._w >= target._h ? 'h' : 'v';
        const newFirst = dir === 'h'
            ? px < target._x + Math.floor(target._w / 2)
            : py < target._y + Math.floor(target._h / 2);
        this.core.debugLog(`spiral: insert ${win.get_wm_class_instance() || '?'} id=${win.get_id()} ` +
            `ws=${this.core.geometry.wsIndex(ws)} at ${target.window?.get_wm_class_instance() || '?'} ` +
            `(${by}) ${dir}${newFirst ? ' first' : ' second'}`);
        return this.bspInsertAtLeaf(tree, target, win, dir, newFirst, this.bspSplitRatio(ws, mon));
    }

    // Prune leaves of windows that left (a fullscreen tile keeps its leaf) and
    // insert missing ones: dwindle appends, Spiral splits next to the focus or
    // pointer (spiralInsertNew).
    syncTree(workspace, tree, tiledWindows, area, gap, mon) {
        const ratio = this.bspSplitRatio(workspace, mon);
        const spiral = this.isSpiral(workspace, mon);
        if (!tree) {
            for (const win of tiledWindows) {
                if (!tree && spiral) this.recordFirstOpenBox(win, mon);
                tree = tree ? this.bspInsert(tree, win, area.x, area.y, area.w, area.h, gap, ratio) : this.bspMakeLeaf(win);
            }
            return tree;
        }
        const tiled = new Set(tiledWindows);
        for (const tw of this.bspCollectWindows(tree)) {
            if (!tiled.has(tw) && !this.core.windows.isFullscreenTile(tw, workspace, mon))
                tree = this.bspRemove(tree, tw);
        }
        const inTree = new Set(this.bspCollectWindows(tree));
        for (const win of tiledWindows) {
            if (inTree.has(win)) continue;
            if (spiral && tree.type !== 'empty') {
                this.bspTagGeometry(tree, area.x, area.y, area.w, area.h, gap);
                tree = this.spiralInsertNew(workspace, tree, win, area, mon);
            } else {
                if (spiral) this.recordFirstOpenBox(win, mon);
                tree = this.bspInsert(tree, win, area.x, area.y, area.w, area.h, gap, ratio);
            }
            inTree.add(win);
        }
        return tree;
    }

    bspTagGeometry(node, x, y, w, h, gap) {
        if (!node) return;
        node._x = x;
        node._y = y;
        node._w = w;
        node._h = h;
        if (node.type === 'empty' || node.type === 'leaf') return;
        const [a, b] = this.splitBoxes(node, { x, y, w, h }, gap);
        this.bspTagGeometry(node.first, a.x, a.y, a.w, a.h, gap);
        this.bspTagGeometry(node.second, b.x, b.y, b.w, b.h, gap);
    }

    // atPointer false: appended as dwindle's next leaf, wherever the pointer
    // is. Spiral always inserts by its own rule (spiralInsertNew).
    bspInsertForWorkspace(ws, win, mon, atPointer = true) {
        const gap = this.core._settings.get_int('inside-gap');
        const workArea = this.core.monitors.monitorWorkArea(ws, mon);
        if (!workArea) return;
        let tree = this.bspGetTree(ws, mon);

        if (tree) {
            const existing = this.bspCollectWindows(tree);
            if (existing.includes(win)) return;
        }

        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;

        const spiral = this.isSpiral(ws, mon);
        const ratio = this.bspSplitRatio(ws, mon);
        if (tree && spiral) {
            this.bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
            tree = this.spiralInsertNew(ws, tree, win, area, mon);
        } else if (tree) {
            const [px, py] = global.get_pointer();
            this.bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
            // Leaf-pick only when the pointer is INSIDE the tiling area —
            // a pointer on another monitor (or over a panel) used to be
            // resolved against this gapped area to an ARBITRARY leaf
            // (the top-left-most), landing the new window in a slot
            // unrelated to where the user works; the append-at-end fallback
            // matches the plain new-window behavior instead.
            const inside = atPointer && px >= areaX && px < areaX + areaW &&
                py >= areaY && py < areaY + areaH;
            const target = inside
                ? this.bspFindLeafAtPoint(tree, areaX, areaY, areaW, areaH, px, py, gap)
                : null;
            if (target) {
                tree = this.bspReplaceLeaf(tree, target, win, ratio);
            } else {
                tree = this.bspInsert(tree, win, areaX, areaY, areaW, areaH, gap, ratio);
            }
        } else {
            if (spiral) this.recordFirstOpenBox(win, mon);
            tree = this.bspInsert(tree, win, areaX, areaY, areaW, areaH, gap, ratio);
        }
        this.bspSetTree(ws, mon, tree);
        // Spiral tags the new leaf now (same min clamp as the retile), so the
        // pre-map placement has its slot before the next layout pass. Dwindle
        // leaves it to its retile: tagged here, a burst of min-size windows
        // was left overlapping.
        if (spiral) {
            this.treeMinSizes(tree, gap, ws, mon);
            this.clampTreeToMinSizes(tree, areaW, areaH, gap);
            this.bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
        }
    }

    parseMinSizeOverrides(entries) {
        const map = new Map();
        for (const entry of entries || []) {
            const m = /^(.+?):(\d+)x(\d+)$/.exec(entry);
            if (m) map.set(m[1].toLowerCase(), { w: parseInt(m[2], 10), h: parseInt(m[3], 10) });
        }
        return map;
    }

    // get_min_size()/get_max_size() as [ok, w, h]. GNOME 50 returns that; a
    // plain [w, h] counts as set, any other shape as unset.
    unpackSizeHint(r) {
        if (!Array.isArray(r) || r.length < 2) return [false, 0, 0];
        const [ok, w, h] = r.length >= 3 ? [!!r[0], r[1], r[2]] : [true, r[0], r[1]];
        return [ok, Number.isFinite(w) ? w : 0, Number.isFinite(h) ? h : 0];
    }

    // The min-size hint as a FRAME size, or null. Hints are in client
    // coordinates (CSD shadow included, SSD titlebar excluded), so add mutter's
    // client-to-frame delta, measured on a probe rect.
    windowMinSizeHint(win) {
        const raw = win.get_min_size();
        if (!win._plaidHintShapeLogged) {
            win._plaidHintShapeLogged = true;
            this.core.debugLog(`size hint: ${win.get_wm_class_instance() || '?'} min=${JSON.stringify(raw)}`);
        }
        const [ok, w, h] = this.unpackSizeHint(raw);
        if (!ok || (w <= 0 && h <= 0)) return null;
        const [dw, dh] = this.clientFrameDelta(win);
        return { w: w > 0 ? Math.max(0, w + dw) : 0, h: h > 0 ? Math.max(0, h + dh) : 0 };
    }

    // The max-size hint as a FRAME size (0: unbounded on that axis), or null.
    windowMaxSizeHint(win) {
        const [ok, w, h] = this.unpackSizeHint(win.get_max_size());
        if (!ok || (w <= 0 && h <= 0)) return null;
        const [dw, dh] = this.clientFrameDelta(win);
        return { w: w > 0 ? Math.max(0, w + dw) : 0, h: h > 0 ? Math.max(0, h + dh) : 0 };
    }

    // Mutter's client-to-frame size delta, measured on a probe rect
    // (converting a G_MAXINT hint itself overflows).
    clientFrameDelta(win) {
        const probe = win.get_frame_rect();
        probe.x = 0;
        probe.y = 0;
        probe.width = 1000;
        probe.height = 1000;
        const f = win.client_rect_to_frame_rect(probe);
        return [f.width - 1000, f.height - 1000];
    }

    // A new Spiral window floats at its first placement when its maximum is
    // below the box it opens on (Hyprland): the leaf it splits, before the
    // split, or its monitor for the first window. Recorded for a new
    // window only; read once (maxBelowOpenBox).
    recordOpenBox(win, w, h) {
        if (this.core._newWindowSet?.has(win)) win._plaidOpenBox = { w, h };
    }

    // The first window's box: its group's monitor, as Hyprland's
    // (PMONITOR->m_size), not the gapped tiling area.
    recordFirstOpenBox(win, mon) {
        const m = mon === null || mon === undefined ? this.core.monitors.primaryMon() : mon;
        const g = m >= 0 ? global.display.get_monitor_geometry(m) : null;
        if (g) this.recordOpenBox(win, g.width, g.height);
    }

    // { max, box } when the new window's maximum (frame units) is below its
    // open box on an axis, else null. The box goes either way: an open is
    // checked once, and only in a Spiral group.
    maxBelowOpenBox(win, spiral) {
        const box = win._plaidOpenBox;
        win._plaidOpenBox = null;
        if (!box || !spiral) return null;
        const max = this.windowMaxSizeHint(win);
        if (!max) return null;
        return (max.w > 0 && max.w < box.w) || (max.h > 0 && max.h < box.h) ? { max, box } : null;
    }

    isX11Client(win) {
        return win.get_client_type() !== Meta.WindowClientType.WAYLAND;
    }

    getWindowMinSize(win) {
        let entry = null;
        for (const c of this.core.winClassCandidates(win)) {
            entry = this.core._minSizeOverrides.get(c);
            if (entry) break;
        }
        if (!entry) {
            const title = (win.get_title() || '').toLowerCase();
            entry = this.core._minSizeOverrides.get(title);
        }
        let w = 0;
        let h = 0;
        if (entry) {
            w = entry.w;
            h = entry.h;
        } else {
            // A freshly placed client is still restoring its own geometry, and
            // the hints it reports during that window are transient: XWayland
            // Emacs re-applies its remembered frame (1936x1185) right after
            // placement and reports a matching minimum for a few seconds. Using
            // that as a partition floor walked the dwindle split by one title
            // bar per retile (1048 -> 1008 -> 969 -> 929 -> 889) and persisted
            // the bent ratio. Ignore transient floors until the settle window
            // closes; the first retile after settle re-clamps with the stable
            // hints. An explicit min-size override still wins (checked above).
            // Only X11 clients are held: a Wayland client's minimum is the one
            // it maps with.
            if (win._plaidSettleUntil && win._plaidSettleUntil > Date.now() && this.isX11Client(win))
                return { w: 0, h: 0 };
            const min = this.windowMinSizeHint(win);
            if (min) {
                w = min.w;
                h = min.h;
            }
        }
        // Some apps (ghostty) report no minimum, so raise the floor with the size
        // this window was seen to refuse to shrink below.
        const obs = this.core._observedMinSizes.get(win);
        if (obs) {
            w = Math.max(w, obs.w);
            h = Math.max(h, obs.h);
        }
        return { w, h };
    }

    // Spiral ignores every minimum, the client's, a min-window-sizes rule and
    // a learned one: a tile is exactly its slot (Hyprland). Nothing is learned
    // from or bent for a window there either.
    minimumsIgnored(ws, mon) {
        return !!ws && this.isSpiral(ws, mon);
    }

    // The minimum a BSP partition of group (ws, mon) gives `win`.
    layoutMinSize(win, ws, mon) {
        return this.minimumsIgnored(ws, mon) ? { w: 0, h: 0 } : this.getWindowMinSize(win);
    }

    // The rect a tile of group (ws, mon) is sent and drawn at, from its slot
    // `r`. Mutter drops a configure below the client's minimum whole, position
    // included (Wayland and X11), so a Spiral slot is grown to that minimum on
    // an axis. Where it goes is Hyprland's formula for a tile larger than its
    // box: centred on the slot, then clamped into the tiling area (the work
    // area less the outer gaps). It overlaps its neighbours (no crop) and
    // never reaches another monitor; its partition stays the slot. No valid
    // tiling area: the slot.
    tileRect(win, r, ws, mon) {
        if (!r || !this.minimumsIgnored(ws, mon)) return r;
        const min = this.windowMinSizeHint(win);
        if (!min || (min.w <= r.w && min.h <= r.h)) return r;
        const area = this.core.geometry.outsideArea(this.core.monitors.monitorWorkArea(ws, mon));
        if (!area) return r;
        const w = Math.max(r.w, min.w);
        const h = Math.max(r.h, min.h);
        const clamp = (v, lo, span, size) => Math.min(Math.max(v, lo), Math.max(lo, lo + span - size));
        return {
            x: clamp(r.x - Math.floor((w - r.w) / 2), area.x, area.w, w),
            y: clamp(r.y - Math.floor((h - r.h) / 2), area.y, area.h, h),
            w, h,
        };
    }

    // A lone tile of group (ws, mon): the whole tiling area, through tileRect.
    // Every place that sends or verifies one asks here.
    loneTileRect(win, workArea, ws, mon) {
        const r = this.core.geometry.singleWindowRect(workArea);
        return r ? this.tileRect(win, { x: r.x, y: r.y, w: r.w, h: r.h }, ws, mon) : null;
    }

    // Tags every node of group (ws, mon)'s tree with its minimum.
    treeMinSizes(node, gap = 0, ws = null, mon = null) {
        if (!node || node.type === 'empty') return { w: 0, h: 0 };
        if (node.type === 'leaf') {
            const min = node.window ? this.layoutMinSize(node.window, ws, mon) : { w: 0, h: 0 };
            node._minW = min.w;
            node._minH = min.h;
            return min;
        }
        const a = this.treeMinSizes(node.first, gap, ws, mon);
        const b = this.treeMinSizes(node.second, gap, ws, mon);
        // 'h' = children side by side (widths add), 'v' = stacked (heights add).
        // Each split also consumes ONE gap along its axis, so reserve `gap` here —
        // without it every nested split under-reserves by a gap and the deep slots
        // come out too small (windows then overlap instead of shrinking).
        if (node.direction === 'h') {
            node._minW = a.w + b.w + gap;
            node._minH = Math.max(a.h, b.h);
        } else {
            node._minW = Math.max(a.w, b.w);
            node._minH = a.h + b.h + gap;
        }
        return { w: node._minW, h: node._minH };
    }

    clampTreeToMinSizes(node, areaW, areaH, gap) {
        if (!node || node.type !== 'split') return;
        const before = node.ratio;
        // Clamp THIS split against its own span, then descend with each child's
        // real slot. (Clamping bottom-up against the FULL area under-enforced
        // nested mins — deep splits were handed slots smaller than their
        // windows' minimum, which overlap instead of shrinking.)
        if (node.direction === 'h') {
            const minW1 = node.first._minW || 0;
            const minW2 = node.second._minW || 0;
            const axisSize = areaW - gap;
            if (axisSize > 0) {
                const minRatio = minW1 / axisSize;
                const maxRatio = 1 - minW2 / axisSize;
                if (maxRatio <= minRatio) {
                    const need = minW1 + minW2;
                    node.ratio = need > 0 ? minW1 / need : 0.5;
                } else {
                    node.ratio = Math.max(minRatio, Math.min(maxRatio, node.ratio));
                }
            }
        } else {
            const minH1 = node.first._minH || 0;
            const minH2 = node.second._minH || 0;
            const axisSize = areaH - gap;
            if (axisSize > 0) {
                const minRatio = minH1 / axisSize;
                const maxRatio = 1 - minH2 / axisSize;
                if (maxRatio <= minRatio) {
                    const need = minH1 + minH2;
                    node.ratio = need > 0 ? minH1 / need : 0.5;
                } else {
                    node.ratio = Math.max(minRatio, Math.min(maxRatio, node.ratio));
                }
            }
        }
        if (node.ratio !== before)
            this.core.debugLog(`clamp: ${node.direction}-split ratio ${before.toFixed(4)} -> ${node.ratio.toFixed(4)} ` +
                `mins=${node.first._minW || 0}x${node.first._minH || 0}/${node.second._minW || 0}x${node.second._minH || 0}`);
        const [a, b] = this.splitBoxes(node, { x: 0, y: 0, w: areaW, h: areaH }, gap);
        this.clampTreeToMinSizes(node.first, a.w, a.h, gap);
        this.clampTreeToMinSizes(node.second, b.w, b.h, gap);
    }

    adjustForConstraints(node, parent, isFirst, x, y, w, h, gap, parentAxis) {
        if (!node) return false;
        if (node.type === 'leaf') {
            if (!parent || !node.window) return false;
            // A kept fullscreen leaf's frame is the monitor's, not its slot's.
            if (node.window.is_fullscreen()) return false;
            const f = node.window.get_frame_rect();
            if (f.width === 0 || f.height === 0) return false;
            // parentAxis is the PARENT split's usable span (its w/h minus the
            // inner gap), passed down by the recursion. The ratio lives on
            // the parent, so the bend math must be sized against that full
            // span. The old code used the leaf's OWN allocated slot as the
            // axis — `1 - frame/ownSlot` for a second child goes negative
            // whenever the frame exceeds its (too-small) slot, clamping the
            // ratio to 0.05 (and a stale mid-animation first-child frame
            // clamps it to 0.95): the goverlay/emacs oscillation
            // that produced 95px slots and a give-up float.
            const axisSize = parentAxis;
            if (axisSize <= 0) return false;
            // "Changed" means the RATIO moved, not that the frame exceeded
            // its slot: a frame over the slot with the ratio already clamped
            // at a bound (0.05/0.95) is a no-op the caller must not log or
            // persist (the frame exceeded its slot but nothing bent).
            const before = parent.ratio;
            if (parent.direction === 'h' && f.width > node._w + 1) {
                if (isFirst) {
                    parent.ratio = Math.min(0.95, Math.max(parent.ratio, f.width / axisSize));
                } else {
                    parent.ratio = Math.max(0.05, Math.min(parent.ratio, 1 - f.width / axisSize));
                }
            } else if (parent.direction === 'v' && f.height > node._h + 1) {
                if (isFirst) {
                    parent.ratio = Math.min(0.95, Math.max(parent.ratio, f.height / axisSize));
                } else {
                    parent.ratio = Math.max(0.05, Math.min(parent.ratio, 1 - f.height / axisSize));
                }
            }
            return parent.ratio !== before;
        }
        if (node.type !== 'split') return false;
        const childAxis = (node.direction === 'h' ? w : h) - gap;
        const [a, b] = this.splitBoxes(node, { x, y, w, h }, gap);
        let changed = false;
        changed = this.adjustForConstraints(node.first, node, true, a.x, a.y, a.w, a.h, gap, childAxis) || changed;
        changed = this.adjustForConstraints(node.second, node, false, b.x, b.y, b.w, b.h, gap, childAxis) || changed;
        return changed;
    }

    dwindleShapeToString(node) {
        // Prefix encoding: l=leaf, e=empty, split = dir+ratio(child,child)
        // e.g. "h0.8480(l,l)" — one ':' per entry (the index separator).
        if (!node || node.type === 'empty') return 'e';
        if (node.type === 'leaf') return 'l';
        if (node.type !== 'split') return 'e';
        const ratio = Number.isFinite(node.ratio) ? node.ratio : 0.5;
        // Clamp before toFixed(4): a ratio ≥ 0.99995 serializes to "1.0000"
        // (and ≤ 0.00005 to "0.0000") which _dwindleShapeFromString REJECTS
        // (ratio must be strictly between 0 and 1) — the whole entry was
        // silently dropped from the written strv, losing the saved shape.
        const r = Math.min(0.9999, Math.max(0.0001, ratio));
        return `${node.direction === 'v' ? 'v' : 'h'}${r.toFixed(4)}` +
            `(${this.dwindleShapeToString(node.first)},${this.dwindleShapeToString(node.second)})`;
    }

    dwindleShapeFromString(str) {
        // Minimal recursive-descent parser for the encoding above. Leaves
        // are PLACEHOLDERS ({type:'leaf'} with no window) — only split
        // nodes' direction+ratio are ever consumed (by reconcile).
        if (typeof str !== 'string' || str.length === 0) return null;
        let i = 0;
        const parseNode = () => {
            if (i >= str.length) return null;
            const c = str[i];
            if (c === 'l') { i++; return { type: 'leaf' }; }
            if (c === 'e') { i++; return { type: 'empty' }; }
            if (c !== 'h' && c !== 'v') return null;
            const dir = c;
            i++;
            const start = i;
            while (i < str.length && /[0-9.]/.test(str[i])) i++;
            const ratio = parseFloat(str.substring(start, i));
            if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null;
            if (str[i] !== '(') return null;
            i++;
            const first = parseNode();
            if (!first || str[i] !== ',') return null;
            i++;
            const second = parseNode();
            if (!second || str[i] !== ')') return null;
            i++;
            return { type: 'split', direction: dir, ratio, first, second };
        };
        try {
            const node = parseNode();
            return node && i === str.length ? node : null;
        } catch (_e) {
            return null;
        }
    }

    reconcileTreeRatios(saved, live) {
        // Copy saved split ratios into the LIVE tree wherever the two
        // structures correspond (same direction down the path). A direction
        // mismatch means this branch's history diverged (different window
        // aspect / insert order) — stop descending there and keep the live
        // ratios. Never touches leaves. Returns true when anything changed.
        if (!saved || !live) return false;
        if (saved.type !== 'split' || live.type !== 'split') return false;
        if (saved.direction !== live.direction) return false;
        let changed = false;
        const r = Number(saved.ratio);
        // Only share a ratio between arrangements of the SAME shape — a shape
        // saved from a smaller/mirrored tree (e.g. a 2-window 85/15) applied to a
        // bigger or flipped one starves everything past the first split.
        if (_leafCount(saved.first) === _leafCount(live.first) &&
            _leafCount(saved.second) === _leafCount(live.second) &&
            Number.isFinite(r) && r > 0.02 && r < 0.98 &&
            Math.abs(live.ratio - r) > 0.0005) {
            live.ratio = r;
            changed = true;
        }
        changed = this.reconcileTreeRatios(saved.first, live.first) || changed;
        changed = this.reconcileTreeRatios(saved.second, live.second) || changed;
        return changed;
    }

    findDirectionalTarget(win, direction, windows) {
        const f = win.get_frame_rect();
        let best = null;
        // bestOverlap starts at 0 (not -1): the acceptance test requires
        // overlap > bestOverlap + 5, so the OLD -1 made the first candidate
        // need overlap > 4 — tall narrow panes sharing only a few pixels of
        // edge were unnavigable by the focus/swap keybinds even when they
        // were the only neighbor in that direction.
        let bestOverlap = 0;
        let bestDist = Infinity;
        let bestPerp = Infinity;
        let bestHeight = -1;

        for (const w of windows) {
            if (w === win) continue;
            const r = w.get_frame_rect();
            if (r.width === 0 || r.height === 0) continue;

            let overlap, dist, perp;
            switch (direction) {
                case 'left':
                    if (r.x + r.width > f.x) continue;
                    overlap = Math.min(f.y + f.height, r.y + r.height) - Math.max(f.y, r.y);
                    dist = f.x - (r.x + r.width);
                    perp = Math.abs((f.y + f.height / 2) - (r.y + r.height / 2));
                    break;
                case 'right':
                    if (r.x < f.x + f.width) continue;
                    overlap = Math.min(f.y + f.height, r.y + r.height) - Math.max(f.y, r.y);
                    dist = r.x - (f.x + f.width);
                    perp = Math.abs((f.y + f.height / 2) - (r.y + r.height / 2));
                    break;
                case 'up':
                    if (r.y + r.height > f.y) continue;
                    overlap = Math.min(f.x + f.width, r.x + r.width) - Math.max(f.x, r.x);
                    dist = f.y - (r.y + r.height);
                    perp = Math.abs((f.x + f.width / 2) - (r.x + r.width / 2));
                    break;
                case 'down':
                    if (r.y < f.y + f.height) continue;
                    overlap = Math.min(f.x + f.width, r.x + r.width) - Math.max(f.x, r.x);
                    dist = r.y - (f.y + f.height);
                    perp = Math.abs((f.x + f.width / 2) - (r.x + r.width / 2));
                    break;
                default:
                    return null;
            }
            if (overlap <= 0) continue;

            const sameHeight = Math.abs(r.height - bestHeight) <= 5;
            const overlapTie = Math.abs(overlap - bestOverlap) <= 5;
            const distTie = Math.abs(dist - bestDist) <= 5;
            if (overlap > bestOverlap + 5 ||
                (overlapTie && dist < bestDist - 5) ||
                (overlapTie && distTie &&
                 ((!sameHeight && r.height > bestHeight) ||
                  (sameHeight && perp < bestPerp)))) {
                bestOverlap = overlap;
                bestDist = dist;
                bestPerp = perp;
                bestHeight = r.height;
                best = w;
            }
        }
        return best;
    }

}
