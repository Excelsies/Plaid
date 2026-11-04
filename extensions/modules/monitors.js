// Per-monitor tiling groups. A group is (workspace, monitor): each one tiles
// its own windows with its own layout. Monitors are named by connector
// ("DP-2"), which survives hotplug and a primary change; display indices do
// not. The group of the monitor that was primary when the state was keyed
// (_keyedPrimary) keeps the single-monitor keys (the workspace index in the
// per-index maps, the workspace object in the trees), so it reads and
// persists exactly as before. Other groups key by "index@connector" and by a
// per-group key object.
//
// A window changes group only through moveWindowToGroup (monitor change, drop,
// grab end, hotplug, resume) or swapAcrossGroups; both write the record
// through setWindowGroup. Naming an index stand-in ("#0" -> "DP-1") renames
// the record in place (syncKeyedPrimary).

import { PlaidSubsystem } from './subsystem.js';
import { sessionState } from './session-state.js';

// A frame the configure ticks sent counts as theirs this long (a late commit).
const TICK_SETTLE_MS = 2000;

// Runs are told apart by number: the window keeps no reference to its run's
// state (a landing diagnostic serializes the tree, windows included).
let lastRun = 0;

export class Monitors extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    // A key of a per-index map: a number (the keyed primary's group) or
    // "index@connector", optionally followed by a tail.
    static parseGroupKey(key) {
        if (typeof key === 'number') return { idx: key, conn: null, tail: '' };
        const m = /^(\d+)(?:@([^:]+))?(.*)$/.exec(String(key));
        if (!m) return null;
        return { idx: parseInt(m[1], 10), conn: m[2] ?? null, tail: m[3] };
    }

    // conn null: the keyed primary's group.
    static formatGroupKey(idx, conn, tail = '') {
        if (conn === null || conn === undefined) return tail ? `${idx}${tail}` : idx;
        return `${idx}@${conn}${tail}`;
    }

    // "CONNECTOR:rest" entries of the monitor-* settings keys.
    static splitMonitorEntry(entry) {
        const sep = entry.indexOf(':');
        if (sep <= 0) return null;
        const conn = entry.substring(0, sep);
        if (!Monitors.savedConn(conn)) return null;
        return { conn, rest: entry.substring(sep + 1) };
    }

    // A connector worth saving: a real name. An index stand-in ("#N", "#-1")
    // would name another monitor, or none, in the next session.
    static savedConn(conn) {
        return !!conn && !/[@\s#]/.test(conn);
    }

    connectSignals() {
        // mutter moves windows off a removed monitor (window-entered-monitor)
        // before it reports monitors-changed: drop the connector map first.
        const mm = global.backend.get_monitor_manager();
        this.connectObject(mm, 'monitors-changed-internal', () => this.invalidate());
        this.connectObject(global.display, 'window-entered-monitor',
            (_d, mon, win) => this.onWindowEnteredMonitor(win, mon));
        // Which monitors tile (tiledMonitors).
        if (this.core._mutterSettings) {
            this.connectObject(this.core._mutterSettings, 'changed::workspaces-only-on-primary', () => {
                this.invalidate();
                this.core.layouts.retileAll();
            });
        }
    }

    nMonitors() {
        return global.display.get_n_monitors();
    }

    // Display index -> connector, rebuilt after any monitor change. A monitor
    // without one keys its windows by index ("#N"); the first full lookup
    // after that (on the next monitor change) regroups them under the
    // connector.
    connectors() {
        if (this.core._monitorConnCache) return this.core._monitorConnCache;
        const conns = [];
        for (const lm of global.backend.get_monitor_manager().get_logical_monitors()) {
            const conn = lm.get_monitors()[0]?.get_connector();
            if (conn) conns[lm.get_number()] = conn;
        }
        const n = this.nMonitors();
        let full = conns.length >= n;
        for (let i = 0; i < n && full; i++) full = !!conns[i];
        this.core._monitorConnCache = conns;
        if (!full) {
            this.core._monitorConnPartial = true;
        } else if (this.core._monitorConnPartial) {
            this.core._monitorConnPartial = false;
            this.scheduleRegroup();
        }
        return conns;
    }

    // Without a connector the index stands in: a layout still works, only its
    // persistence follows the index instead of the monitor.
    monConn(mon) {
        return this.connectors()[mon] ?? `#${mon}`;
    }

    // The connector of mon's group; null names the primary's.
    groupConn(mon) {
        return mon === undefined || mon === null ? this.keyedPrimaryConn() : this.monConn(mon);
    }

    // -1: that monitor is not connected.
    connMon(conn) {
        if (!conn) return -1;
        const conns = this.connectors();
        const i = conns.indexOf(conn);
        if (i >= 0) return i;
        const m = /^#(\d+)$/.exec(conn);
        if (!m) return -1;
        const n = parseInt(m[1], 10);
        return n < this.nMonitors() && !conns[n] ? n : -1;
    }

    primaryMon() {
        return global.display.get_primary_monitor();
    }

    keyedPrimaryConn() {
        if (this.core._keyedPrimary === undefined || this.core._keyedPrimary === null)
            this.core._keyedPrimary = this.monConn(this.primaryMon());
        return this.core._keyedPrimary;
    }

    // The group's key in the per-index maps (layouts, ratios, saved rules).
    // No monitor: the keyed primary's group.
    groupKey(ws, mon) {
        const idx = typeof ws === 'number' ? ws : this.core.geometry.wsIndex(ws);
        if (mon === undefined || mon === null) return idx;
        return this.groupKeyFor(idx, this.monConn(mon));
    }

    groupKeyFor(idx, conn) {
        if (conn === null || conn === undefined || conn === this.keyedPrimaryConn()) return idx;
        return `${idx}@${conn}`;
    }

    // The group's key in the workspace-object maps (trees, leaf signatures).
    groupObj(ws, mon) {
        if (mon === undefined || mon === null) return ws;
        return this.groupObjFor(ws, this.monConn(mon));
    }

    groupObjFor(ws, conn) {
        if (!ws || conn === null || conn === undefined || conn === this.keyedPrimaryConn()) return ws;
        if (!this.core._groupObjs) this.core._groupObjs = new Map();
        let byConn = this.core._groupObjs.get(ws);
        if (!byConn) {
            byConn = new Map();
            this.core._groupObjs.set(ws, byConn);
        }
        let g = byConn.get(conn);
        if (!g) {
            g = { plaidGroup: true, ws, conn };
            byConn.set(conn, g);
        }
        return g;
    }

    // A removed workspace takes its groups' trees and signatures with it.
    forgetWorkspaceGroups(ws) {
        const objs = [ws, ...(this.core._groupObjs?.get(ws)?.values() ?? [])];
        for (const map of [this.core._bspTrees, this.core._dwindleLeafSigs]) {
            for (const k of objs) map?.delete(k);
        }
        this.core._groupObjs?.delete(ws);
    }

    windowConn(win) {
        return this.core._windowMonitors?.get(win) ?? this.keyedPrimaryConn();
    }

    // The display index of the window's group; -1 while that monitor is gone.
    windowMon(win) {
        const conn = this.core._windowMonitors?.get(win);
        if (conn === undefined) return this.primaryMon();
        return this.connMon(conn);
    }

    // Monitors or their settings changed: the cached views are stale.
    invalidate() {
        this.core._monitorConnCache = null;
        this.core._tiledMonitorsCache = null;
    }

    // Primary first. With workspaces only on the primary the other monitors
    // keep their windows on every workspace: they stay untiled.
    tiledMonitors() {
        if (this.core._tiledMonitorsCache) return this.core._tiledMonitorsCache;
        const primary = this.primaryMon();
        const n = this.nMonitors();
        const onlyPrimary = !!this.core._mutterSettings?.get_boolean('workspaces-only-on-primary');
        const out = [primary];
        for (let i = 0; i < n && !onlyPrimary; i++) {
            if (i !== primary) out.push(i);
        }
        this.core._tiledMonitorsCache = out;
        return out;
    }

    monitorTiled(mon) {
        return mon >= 0 && this.tiledMonitors().includes(mon);
    }

    // The one answer to "does this group place its windows": its monitor
    // tiles and its layout is not floating. The retile, and every site that
    // lays windows out, computes a slot or edits a split from user input, asks
    // here; runs already under way finish at the targets they started with.
    groupPlaces(ws, mon) {
        return this.monitorTiled(mon) && this.core.windows.getWorkspaceLayout(ws, mon) !== 'floating';
    }

    monitorAt(px, py) {
        const n = this.nMonitors();
        for (let i = 0; i < n; i++) {
            const g = global.display.get_monitor_geometry(i);
            if (g && px >= g.x && px < g.x + g.width && py >= g.y && py < g.y + g.height)
                return i;
        }
        return -1;
    }

    monitorWorkArea(ws, mon) {
        if (mon === undefined || mon === null) mon = this.primaryMon();
        if (!ws || mon < 0) return null;
        return ws.get_work_area_for_monitor(mon);
    }

    // Every monitor's windows are getWindowsForWorkspace; a layout takes its
    // group's.
    getWindowsForGroup(ws, mon) {
        const conn = this.groupConn(mon);
        return this.core.windows.getWindowsForWorkspace(ws).filter(w => this.windowConn(w) === conn);
    }

    // The primary changed: its group takes over the single-monitor keys, the
    // former primary's group moves to its connector's keys.
    syncKeyedPrimary() {
        if (this.restorePending()) return false;
        const cur = this.monConn(this.primaryMon());
        const old = this.core._keyedPrimary;
        if (old === undefined || old === null) {
            this.core._keyedPrimary = cur;
            return false;
        }
        if (old === cur) return false;
        // The same monitor, named now: its group keeps the keys, and what was
        // loaded or kept for the name ("i@cur") joins them where the session
        // has nothing of its own.
        const stand = /^#(\d+)$/.exec(old);
        if (stand && this.connectors()[parseInt(stand[1], 10)] === cur) {
            for (const map of this.groupIndexMaps()) {
                for (const [k, v] of [...(map ?? [])]) {
                    const p = Monitors.parseGroupKey(k);
                    if (p?.conn !== cur) continue;
                    map.delete(k);
                    const to = Monitors.formatGroupKey(p.idx, null, p.tail);
                    if (!map.has(to)) map.set(to, v);
                }
            }
            for (const [ws, byConn] of [...(this.core._groupObjs ?? [])]) {
                const g = byConn.get(cur);
                if (!g) continue;
                byConn.delete(cur);
                for (const map of [this.core._bspTrees, this.core._dwindleLeafSigs]) {
                    if (!map?.has(g)) continue;
                    if (!map.get(ws)) map.set(ws, map.get(g));
                    map.delete(g);
                }
            }
            this.core._keyedPrimary = cur;
            for (const [win, conn] of this.core._windowMonitors ?? []) {
                if (conn === old) this.core._windowMonitors.set(win, cur);
            }
            this.core.debugLog(`monitors: primary group ${old} is ${cur}`);
            return true;
        }
        const rekey = (k) => {
            const p = Monitors.parseGroupKey(k);
            if (!p) return k;
            const conn = p.conn ?? old;
            return Monitors.formatGroupKey(p.idx, conn === cur ? null : conn, p.tail);
        };
        for (const map of this.groupIndexMaps()) {
            if (!map) continue;
            const entries = [...map];
            map.clear();
            for (const [k, v] of entries) map.set(rekey(k), v);
        }
        const objEntries = [];
        for (const map of [this.core._bspTrees, this.core._dwindleLeafSigs]) {
            if (!map) continue;
            objEntries.push([map, [...map]]);
            map.clear();
        }
        this.core._keyedPrimary = cur;
        for (const [map, entries] of objEntries) {
            for (const [k, v] of entries) {
                const ws = k?.plaidGroup ? k.ws : k;
                const conn = k?.plaidGroup ? k.conn : old;
                map.set(this.groupObjFor(ws, conn), v);
            }
        }
        this.core.debugLog(`monitors: primary group ${old} -> ${cur}`);
        return true;
    }

    // Every per-index map whose keys name a group.
    groupIndexMaps() {
        const c = this.core;
        return [c._workspaceLayouts, c._masterRatios, c._stackRatios,
            c._persistedLayoutByIndex, c._persistedMasterByIndex, c._persistedStackByIndex,
            c._persistedDwindleByIndex, c._persistedDwindleRaw, c._pinnedAdjustCounts];
    }

    // mutter moved the window to another monitor (move-to-monitor, its
    // placement, a drag ended elsewhere): it joins that monitor's group.
    onWindowEnteredMonitor(win, mon) {
        if (!this.core._settings || this.core._shuttingDown || !this.core._windowMonitors?.has(win)) return;
        // Mid-hotplug the indices may already be the new configuration's.
        this.invalidate();
        // A drag keeps its group until the grab ends (regroupAfterGrab).
        if (win === this.core._grabbedWindow) return;
        // Our own animation crossing a monitor on its way to its slot there.
        if (this.ownMoveInFlight(win)) return;
        if (mon < 0) return;
        // Its monitor was removed: the monitors-changed regroup takes it, once
        // the removed monitor's shapes are saved.
        if (this.connMon(this.windowConn(win)) < 0) {
            this.scheduleRegroup();
            return;
        }
        this.moveWindowToGroup(win, this.monConn(mon), 'monitor');
    }

    // Before each configure tick (placement.tickConfigure): crossing a monitor,
    // the move emits window-entered-monitor before it returns. Only positions
    // this run's ticks sent: a frame a lagging client still shows may be the
    // run's start, where a user move can land too.
    recordTick(win, x, y, run) {
        if (!run._plaidRun) run._plaidRun = ++lastRun;
        const sent = win._plaidTickSent;
        const inFlight = !!sent && sent.run === run._plaidRun && Date.now() - sent.at < TICK_SETTLE_MS;
        const sentAt = inFlight ? sent.sentAt : [];
        sentAt.push(`${x},${y}`);
        if (sentAt.length > 16) sentAt.splice(0, sentAt.length - 16);
        win._plaidTickSent = { at: Date.now(), run: run._plaidRun, sentAt,
            end: [run.targetX, run.targetY, run.targetW, run.targetH] };
    }

    // The frame is at a position the configure ticks sent (mutter may clamp
    // its size to the monitor it is over) and their run ends on the window's
    // group monitor: an animation (or its late commit) passing over other
    // monitors, not a move. Anything else moved it.
    ownMoveInFlight(win) {
        const sent = win._plaidTickSent;
        if (!sent || Date.now() - sent.at >= TICK_SETTLE_MS) return false;
        const f = win.get_frame_rect();
        if (!sent.sentAt.includes(`${f.x},${f.y}`)) return false;
        const [x, y, w, h] = sent.end;
        return this.monitorAt(x + w / 2, y + h / 2) === this.windowMon(win);
    }

    // What a resume compares (core.resumeRetilesAll): each monitor's connector
    // and work area (a new primary moves the top bar, so its work area).
    signature() {
        const ws = global.workspace_manager.get_active_workspace();
        const parts = [];
        for (let i = 0; i < this.nMonitors(); i++) {
            const a = ws?.get_work_area_for_monitor(i);
            parts.push(`${this.monConn(i)}:${a ? `${a.x},${a.y},${a.width},${a.height}` : '-'}`);
        }
        return parts.join(' ');
    }

    // A stash waits for restoreTilingState: its maps are keyed for the stashed
    // primary. Re-keying the new core's maps first would swap them between
    // monitors; the restore re-keys and regroups. (A regroup before it finds
    // no windows: they are added after the restore.)
    restorePending() {
        return sessionState.stashedTiling !== null;
    }

    // One idle for every monitor change of a hotplug.
    scheduleRegroup() {
        if (this.core._regroupId || !this.core._settings || this.core._shuttingDown) return;
        this.core._regroupId = this.core.signals.addIdle(() => {
            this.core._regroupId = 0;
            if (!this.core._settings || this.core._shuttingDown) return false;
            this.invalidate();
            this.syncKeyedPrimary();
            this.regroupWindows('hotplug');
            return false;
        });
    }

    // Every window whose monitor is not its group's joins its monitor's
    // group. A removed monitor's groups keep their layout and saved shape for
    // its return.
    regroupWindows(cause) {
        if (!this.core._settings || this.core._shuttingDown || !this.core._windowMonitors) return;
        const saved = new Set();
        for (const [win, conn] of [...this.core._windowMonitors]) {
            // A drag regroups at its end; our own animation is passing over.
            if (win === this.core._grabbedWindow || this.ownMoveInFlight(win)) continue;
            const mon = win.get_monitor();
            if (mon < 0) continue;
            const to = this.monConn(mon);
            if (to === conn) continue;
            if (!saved.has(conn) && this.connMon(conn) < 0) {
                saved.add(conn);
                this.saveGroupShapes(conn);
            }
            this.moveWindowToGroup(win, to, cause);
        }
    }

    // The monitor's arrangements as saved shapes, before its windows leave.
    saveGroupShapes(conn) {
        const wm = global.workspace_manager;
        let saved = 0;
        for (let i = 1; i < wm.get_n_workspaces(); i++) {
            const ws = wm.get_workspace_by_index(i);
            const key = this.groupKeyFor(i, conn);
            const tree = ws && this.core._bspTrees.get(this.groupObjFor(ws, conn));
            if (!tree || tree.type !== 'split' || this.core.windows.layoutForKey(key) !== 'dwindle') continue;
            const shape = this.core.bsp.dwindleShapeToString(tree);
            this.core._persistedDwindleRaw?.set(key, shape);
            this.core._persistedDwindleByIndex?.set(key, this.core.bsp.dwindleShapeFromString(shape));
            saved++;
        }
        this.core.debugLog(`group: monitor ${conn} removed, ${saved} arrangements kept`);
        if (saved > 0) this.core.persistence.scheduleSaveLayouts();
    }

    // The one way a window changes group (monitor change, drop, grab end,
    // hotplug): it leaves the old group's tree, goes last in the order, joins
    // the new tree (at the pointer only for a drag, which ended there; a drop
    // then places it) and the workspace retiles. A window is in exactly one
    // group.
    moveWindowToGroup(win, conn, cause) {
        if (!this.core._windowMonitors?.has(win)) return false;
        const from = this.windowConn(win);
        if (from === conn) return false;
        const ws = this.core._windowWorkspaces.get(win) ?? win.get_workspace();
        this.setWindowGroup(win, conn, cause);
        if (!ws) return true;
        this.removeFromGroupTree(win, ws, from);
        const order = this.core.windows.getWorkspaceOrder(ws);
        const i = order.indexOf(win);
        if (i !== -1) {
            order.splice(i, 1);
            order.push(win);
        }
        const mon = this.connMon(conn);
        if (this.groupPlaces(ws, mon) && !this.core.windows.isFloating(win) &&
            this.core.windows.getWorkspaceLayout(ws, mon) === 'dwindle')
            this.core.bsp.bspInsertForWorkspace(ws, win, mon, cause === 'drop' || cause === 'grab-end');
        this.core.layouts.retileWorkspace(ws);
        return true;
    }

    // The group record itself (moveWindowToGroup, swapAcrossGroups): a run in
    // flight would pull the window back to its old slot.
    setWindowGroup(win, conn, cause) {
        const from = this.windowConn(win);
        this.core._windowMonitors.set(win, conn);
        const ws = this.core._windowWorkspaces.get(win) ?? win.get_workspace();
        this.core.debugLog(`group: ${win.get_wm_class_instance() || '?'} ws=${this.core.geometry.wsIndex(ws)} ${from} -> ${conn} (${cause})`);
        for (const s of this.core._animStates ?? []) {
            if (s.win === win) s.regrouped = true;
        }
        win._plaidTickSent = null;
        this.core.transforms.release(win);
    }

    // a and b trade places across two monitors: each takes the other's leaf,
    // order position and group.
    swapAcrossGroups(ws, a, b) {
        const ca = this.windowConn(a);
        const cb = this.windowConn(b);
        for (const conn of [ca, cb]) {
            const tree = this.core._bspTrees.get(this.groupObjFor(ws, conn));
            if (tree) this.core.bsp.bspSwapWindows(tree, a, b);
        }
        const order = this.core.windows.getWorkspaceOrder(ws);
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        if (ia !== -1 && ib !== -1) {
            order[ia] = b;
            order[ib] = a;
        }
        this.setWindowGroup(a, cb, 'swap');
        this.setWindowGroup(b, ca, 'swap');
    }

    // Leave the group's tree now: while a grab defers the retile, the stale
    // leaf would keep its slot for good.
    removeFromGroupTree(win, ws, conn) {
        const key = this.groupObjFor(ws, conn);
        const tree = this.core._bspTrees.get(key);
        if (tree) this.core._bspTrees.set(key, this.core.bsp.bspRemove(tree, win));
    }

    // Any grab, tracked or not (mouse-resize off, floats): mutter moves the
    // window, its group follows at the end (regroupAfterGrab).
    grabBegan(win) {
        this.core._grabbedWindow = win;
        this.core._grabDropped = false;
    }

    // A drop (windows.repositionWindow) chose the pointer's monitor; the grab
    // end keeps it.
    grabDropped(win) {
        if (win && win === this.core._grabbedWindow) this.core._grabDropped = true;
    }

    // The grab is over: a window it left on another monitor joins that
    // monitor's group (a float, a click or cancel, mouse-resize off); one
    // whose monitor went away mid-drag joins the monitor it is on. A drop
    // already chose the pointer's monitor: kept.
    regroupAfterGrab(win) {
        if (!win || win !== this.core._grabbedWindow) return;
        this.core._grabbedWindow = null;
        const dropped = this.core._grabDropped;
        this.core._grabDropped = false;
        if (!this.core._settings || this.core._shuttingDown || !this.core._windowMonitors?.has(win)) return;
        if (dropped && this.windowMon(win) >= 0) return;
        const mon = win.get_monitor();
        if (mon >= 0)
            this.moveWindowToGroup(win, this.monConn(mon), 'grab-end');
        else if (this.windowMon(win) < 0)
            this.scheduleRegroup();
    }

    // The focused window's tiled monitor, else the pointer's, else the
    // primary.
    activeMonitor(ws) {
        const focus = global.display.focus_window;
        if (focus && focus.get_workspace() === ws && this.core._windowMonitors?.has(focus)) {
            const mon = this.windowMon(focus);
            if (this.monitorTiled(mon)) return mon;
        }
        const cur = global.display.get_current_monitor();
        return this.monitorTiled(cur) ? cur : this.primaryMon();
    }

    destroy() {
        this.core._regroupId = 0;
        this.core._grabbedWindow = null;
        this.core._grabDropped = false;
        this.core._monitorConnCache = null;
        this.core._monitorConnPartial = false;
        this.core._tiledMonitorsCache = null;
        super.destroy();
    }
}
