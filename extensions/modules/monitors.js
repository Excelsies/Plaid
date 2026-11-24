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
// grab end, hotplug, resume, movewindow) or swapAcrossGroups; both write the record
// through setWindowGroup. Naming an index stand-in ("#0" -> "DP-1") renames
// the record in place (syncKeyedPrimary).

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { PlaidSubsystem } from './subsystem.js';
import { isBspLayout } from './helpers.js';
import { sessionState } from './session-state.js';

// A burst of monitor changes is handled once: SETTLE_MS after its last event,
// at most SETTLE_CAP_MS after its first; a partial connector map waits
// SETTLE_MS more, SETTLE_RETRIES times, before the stand-ins are used.
const SETTLE_MS = 300;
const SETTLE_CAP_MS = 2000;
const SETTLE_RETRIES = 10;

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
        this.connectObject(mm, 'monitors-changed-internal', () => {
            this.invalidate();
            this.armSettle();
        });
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
        if (conn !== null && conn !== undefined && conn !== this.keyedPrimaryConn() && this.fixedConn(conn))
            return `m@${conn}`;
        return this.slotKeyFor(idx, conn);
    }

    // The per-workspace key of a slot, fixed groups or not: what the
    // workspace-* and monitor-workspace-* settings store. Both arrangements
    // are kept while the setting is toggled.
    slotKeyFor(idx, conn) {
        if (conn === null || conn === undefined || conn === this.keyedPrimaryConn()) return idx;
        return `${idx}@${conn}`;
    }

    // The group's key in the workspace-object maps (trees, leaf signatures).
    groupObj(ws, mon) {
        if (mon === undefined || mon === null) return ws;
        return this.groupObjFor(ws, this.monConn(mon));
    }

    groupObjFor(ws, conn) {
        if (conn === null || conn === undefined || conn === this.keyedPrimaryConn()) return ws;
        if (this.fixedConn(conn)) return this.fixedGroupObj(conn);
        if (!ws) return ws;
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

    // A fixed group's one object, whatever the workspace.
    fixedGroupObj(conn) {
        if (!this.core._fixedGroupObjs) this.core._fixedGroupObjs = new Map();
        let g = this.core._fixedGroupObjs.get(conn);
        if (!g) {
            g = { plaidGroup: true, fixed: true, ws: null, conn };
            this.core._fixedGroupObjs.set(conn, g);
        }
        return g;
    }

    // Workspaces on the primary only: mutter shows every other monitor's
    // windows on every workspace, so each such monitor tiles them as one
    // group of its own, a fixed group, that no workspace switch changes. Its
    // keys are "m@CONNECTOR". Never true while the setting is off.
    onlyPrimary() {
        if (this.core._onlyPrimaryCache === null || this.core._onlyPrimaryCache === undefined)
            this.core._onlyPrimaryCache = !!this.core._mutterSettings?.get_boolean('workspaces-only-on-primary');
        return this.core._onlyPrimaryCache;
    }

    fixedConn(conn) {
        return !!conn && this.onlyPrimary() && conn !== this.monConn(this.primaryMon());
    }

    fixedMon(mon) {
        return mon !== undefined && mon !== null && mon >= 0 && this.fixedConn(this.monConn(mon));
    }

    // A fixed group is laid out from the active workspace's pass only: once
    // per cycle, not once per workspace.
    laidOutIn(ws, mon) {
        return !this.fixedMon(mon) || ws === global.workspace_manager?.get_active_workspace();
    }

    // A removed workspace takes its groups' trees and signatures with it.
    forgetWorkspaceGroups(ws) {
        const objs = [ws, ...(this.core._groupObjs?.get(ws)?.values() ?? [])];
        for (const map of [this.core._bspTrees, this.core._dwindleLeafSigs, this.core._bspLaidOutAs]) {
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
        this.core._onlyPrimaryCache = null;
    }

    // Every monitor, primary first. With workspaces on the primary only the
    // others tile as fixed groups (fixedConn).
    tiledMonitors() {
        if (this.core._tiledMonitorsCache) return this.core._tiledMonitorsCache;
        const primary = this.primaryMon();
        const n = this.nMonitors();
        const out = [primary];
        for (let i = 0; i < n; i++) {
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

    // The monitor next to `mon` in direction 'left'|'right'|'up'|'down', as
    // GNOME's move-to-monitor finds it; -1: none.
    neighbor(mon, dir) {
        const d = { left: Meta.DisplayDirection.LEFT, right: Meta.DisplayDirection.RIGHT,
            up: Meta.DisplayDirection.UP, down: Meta.DisplayDirection.DOWN }[dir];
        if (mon < 0 || d === undefined) return -1;
        return global.display.get_monitor_neighbor_index(mon, d);
    }

    // GNOME's move-to-monitor: mutter's move_to_monitor_internal with the
    // user-action flag, which spares a monitor-sized frame the constraints
    // that keep a plain move_to_monitor on its monitor. The frame keeps its
    // size and its relative place in the work area, or its centre's when it
    // does not fit (move_rect_between_rects: every product and sum rounded
    // to float, as mutter's C). A fullscreen or
    // maximized window is fitted to the new monitor by mutter itself.
    moveToMonitor(win, to) {
        if (win.is_fullscreen() || win.get_maximize_flags() !== 0) {
            win.move_to_monitor(to);
            return;
        }
        const r = win.get_frame_rect();
        const o = win.get_work_area_for_monitor(win.get_monitor());
        const n = win.get_work_area_for_monitor(to);
        const f = Math.fround;
        let x, y;
        if (r.x >= o.x && r.y >= o.y && r.x + r.width <= o.x + o.width && r.y + r.height <= o.y + o.height &&
            o.width > r.width && o.height > r.height && n.width >= r.width && n.height >= r.height) {
            x = Math.trunc(f(n.x + f(f((r.x - o.x) / (o.width - r.width)) * (n.width - r.width))));
            y = Math.trunc(f(n.y + f(f((r.y - o.y) / (o.height - r.height)) * (n.height - r.height))));
        } else {
            const eps = 2 ** -23;
            const rel = (v, len) => Math.min(Math.max(f(v / len), eps), 1 - eps);
            const hw = Math.trunc(r.width / 2), hh = Math.trunc(r.height / 2);
            x = Math.trunc(f(n.x - hw + f(rel(r.x - o.x + hw, o.width) * n.width)));
            y = Math.trunc(f(n.y - hh + f(rel(r.y - o.y + hh, o.height) * n.height)));
        }
        win.move_resize_frame(true, x, y, r.width, r.height);
    }

    monitorWorkArea(ws, mon) {
        if (mon === undefined || mon === null) mon = this.primaryMon();
        if (!ws || mon < 0) return null;
        return ws.get_work_area_for_monitor(mon);
    }

    // Every monitor's windows are getWindowsForWorkspace; a layout takes its
    // group's. A fixed group's are every tracked window on its monitor:
    // mutter reports such a window on the active workspace, whichever
    // workspace's order holds it.
    getWindowsForGroup(ws, mon) {
        const conn = this.groupConn(mon);
        if (this.fixedConn(conn)) {
            return [...(this.core._windowMonitors ?? [])]
                .filter(([w, c]) => c === conn && this.core.windows.tileCandidate(w))
                .map(([w]) => w);
        }
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
                for (const map of [this.core._bspTrees, this.core._dwindleLeafSigs, this.core._bspLaidOutAs]) {
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
        for (const map of [this.core._bspTrees, this.core._dwindleLeafSigs, this.core._bspLaidOutAs]) {
            if (!map) continue;
            objEntries.push([map, [...map]]);
            map.clear();
        }
        this.core._keyedPrimary = cur;
        for (const [map, entries] of objEntries) {
            for (const [k, v] of entries) {
                if (k?.fixed) {
                    map.set(k, v);
                    continue;
                }
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
        // A burst of monitor changes is settling: its pass regroups every
        // window from where mutter finally put it.
        if (this.core._monitorsSettling) return;
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
    // With the size (w, h): also the rect sent and the frames the ticks saw or
    // sent while it is in flight (tickSentPending).
    recordTick(win, x, y, run, w = null, h = null) {
        if (!run._plaidRun) run._plaidRun = ++lastRun;
        const sent = win._plaidTickSent;
        const inFlight = !!sent && sent.run === run._plaidRun && Date.now() - sent.at < TICK_SETTLE_MS;
        const sentAt = inFlight ? sent.sentAt : [];
        sentAt.push(`${x},${y}`);
        if (sentAt.length > 16) sentAt.splice(0, sentAt.length - 16);
        let seen = null;
        if (w !== null) {
            const f = win.get_frame_rect();
            seen = this.tickSentPending(win, f) ? sent.seen : [];
            seen.push(`${f.x},${f.y},${f.width},${f.height}`, `${x},${y},${w},${h}`);
            if (seen.length > 32) seen.splice(0, seen.length - 32);
        }
        win._plaidTickSent = { at: Date.now(), run: run._plaidRun, sentAt,
            end: [run.targetX, run.targetY, run.targetW, run.targetH], x, y, w, h, seen };
    }

    // The last configure tick is still in flight: recent, not landed, and the
    // frame is one the ticks saw or sent (else something else moved it).
    tickSentPending(win, f) {
        const sent = win._plaidTickSent;
        return !!sent?.seen && Date.now() - sent.at < TICK_SETTLE_MS &&
            sent.seen.includes(`${f.x},${f.y},${f.width},${f.height}`);
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

    // Monitor changes come in bursts (a hotplug, a scale or a primary change is
    // several events, and mutter moves windows in between): one settled pass
    // handles the burst. Until it runs, retiles wait (layouts) and
    // window-entered-monitor is ignored.
    armSettle() {
        if (!this.core._settings || this.core._shuttingDown) return;
        const now = GLib.get_monotonic_time() / 1000;
        if (!this.core._monitorsSettling) {
            this.core._monitorsSettling = true;
            this.core._monitorSettleFirst = now;
        }
        const wait = Math.max(0, Math.min(SETTLE_MS, this.core._monitorSettleFirst + SETTLE_CAP_MS - now));
        this.clearSettleTimer();
        this.core._monitorSettleId = this.core.signals.addTimeout(Math.round(wait), () => {
            this.core._monitorSettleId = 0;
            this.settledPass();
            return GLib.SOURCE_REMOVE;
        });
        this.core.debugLog(`monitors: settle armed (${Math.round(wait)} ms)`);
    }

    clearSettleTimer() {
        if (!this.core._monitorSettleId) return;
        GLib.source_remove(this.core._monitorSettleId);
        this.core.signals.untrackSource(this.core._monitorSettleId);
        this.core._monitorSettleId = 0;
    }

    // The burst is over: every window joins the group of the monitor mutter put
    // it on, the primary is re-keyed if it changed, and every workspace is
    // retiled once (work areas change even when no window moved).
    settledPass() {
        // First, so that nothing below can leave every retile waiting.
        this.core._monitorsSettling = false;
        this.core._monitorSettleFirst = 0;
        if (!this.core._settings || this.core._shuttingDown) return;
        this.invalidate();
        this.connectors();
        this.core.debugLog(`monitors: settled pass begin partial=${!!this.core._monitorConnPartial} ` +
            `retries=${this.core._monitorSettleRetries}`);
        if (this.core._monitorConnPartial && this.core._monitorSettleRetries < SETTLE_RETRIES) {
            this.core._monitorSettleRetries++;
            this.armSettle();
            return;
        }
        this.core._monitorSettleRetries = 0;
        this.syncKeyedPrimary();
        this.regroupWindows('hotplug');
        this.core.layouts.retileAll();
        // X11 frame and buffer offsets can be stale after a reconfiguration
        // even for a window that did not resize.
        this.core.signals.addTimeout(150, () => {
            if (this.core._settings) this.core.borders.updateBorders();
            return GLib.SOURCE_REMOVE;
        });
        this.logSettleShapes();
        this.core.debugLog('monitors: settled pass done');
    }

    // Debug only: each workspace's dwindle and Spiral shapes per monitor after a
    // settled pass, so a shuffle after a monitor event leaves a trail.
    logSettleShapes() {
        if (!this.core._settings.get_boolean('debug')) return;
        const parts = [];
        for (let i = 1; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (!ws) continue;
            const groups = [];
            for (const mon of this.tiledMonitors()) {
                const tree = this.core.bsp.bspGetTree(ws, mon);
                if (tree?.type !== 'split') continue;
                groups.push(`${this.monConn(mon)}:${this.core.bsp.dwindleShapeToString(tree)}`);
            }
            if (groups.length) parts.push(`${i}:[${groups.join(' ')}]`);
        }
        this.core.debugLog(`settle shapes: ${parts.join(' ') || 'none'}`);
    }

    // One idle for every monitor change of a hotplug.
    scheduleRegroup() {
        if (this.core._regroupId || !this.core._settings || this.core._shuttingDown) return;
        this.core._regroupId = this.core.signals.addIdle(() => {
            this.core._regroupId = 0;
            if (!this.core._settings || this.core._shuttingDown) return false;
            // The settled pass regroups.
            if (this.core._monitorsSettling) return false;
            this.invalidate();
            this.syncKeyedPrimary();
            this.regroupWindows('hotplug');
            return false;
        });
    }

    // Every window whose monitor is not its group's joins its monitor's
    // group. A removed monitor's groups keep their layout and saved shape for
    // its return. Its windows move off the remaining display's workspaces: one
    // unused workspace per (monitor, source workspace), so no existing
    // workspace reflows; when mutter brings one back to the returning monitor
    // it goes back to its source workspace (if it is still where it was sent).
    regroupWindows(cause) {
        if (!this.core._settings || this.core._shuttingDown || !this.core._windowMonitors) return;
        const evacuated = this.evacuated();
        const moves = [];
        for (const [win, conn] of [...this.core._windowMonitors]) {
            // A drag regroups at its end; our own animation is passing over.
            if (win === this.core._grabbedWindow || this.ownMoveInFlight(win)) continue;
            const mon = win.get_monitor();
            if (mon < 0) continue;
            const to = this.monConn(mon);
            if (to === conn) {
                // Back on the monitor it left without a regroup: nothing to restore.
                const e = evacuated.get(win);
                if (e && this.connMon(e.conn) >= 0) evacuated.delete(win);
                continue;
            }
            moves.push({ win, conn, to, gone: this.connMon(conn) < 0 });
        }
        const targets = this.evacuationTargets(moves.filter(m => m.gone));
        const saved = new Set();
        const lost = new Set(), sentTo = new Set(), back = new Set();
        let sent = 0, returned = 0;
        for (const { win, conn, to, gone } of moves) {
            if (!saved.has(conn) && gone) {
                saved.add(conn);
                this.saveGroupShapes(conn);
            }
            const target = targets.get(win);
            if (target) {
                // Change workspace while still in the old group: the order and
                // the old tree follow the move, then the window joins `to` there.
                evacuated.set(win, { conn, source: this.core._windowWorkspaces.get(win) ?? win.get_workspace(), target });
                this.core.debugLog(`evacuate: ${win.get_wm_class_instance() || '?'} id=${win.get_id()} ${conn} ` +
                    `ws=${this.core.geometry.wsIndex(evacuated.get(win).source)} -> ws=${this.core.geometry.wsIndex(target)}`);
                if (win.get_workspace() !== target) win.change_workspace(target);
                this.followMove(win);
                sent++;
                lost.add(conn);
                sentTo.add(target);
            } else {
                const e = evacuated.get(win);
                if (e && e.conn === to) {
                    evacuated.delete(win);
                    if (this.restoreEvacuated(win, e)) {
                        returned++;
                        back.add(to);
                        // Shown on every workspace now: back in its home order.
                        if (this.fixedConn(to)) {
                            this.moveWindowToGroup(win, to, cause);
                            this.adoptIntoWorkspace(win, e.source);
                            continue;
                        }
                    }
                }
            }
            this.moveWindowToGroup(win, to, cause);
        }
        this.cleanupEvacuation();
        this.monitorChangeNotice(lost, sent, sentTo, back, returned);
    }

    evacuated() {
        if (!this.core._evacuated) this.core._evacuated = new Map();
        return this.core._evacuated;
    }

    // A workspace no window of its own is on (windows shown on every
    // workspace, such as a fixed monitor's, do not count).
    wsEmpty(ws) {
        return !ws.list_windows().some(w => !w.is_on_all_workspaces?.());
    }

    // An unused workspace for each (monitor, source workspace) group of
    // windows whose monitor is gone, in source order: an empty one that is not
    // shown, else the shown one if empty, else a new one. Never slot 0 or the
    // Background App's parking. Map window -> target.
    evacuationTargets(detached) {
        const out = new Map();
        const wm = global.workspace_manager;
        if (!detached.length || !wm) return out;
        if (!this.core._evacTargets) this.core._evacTargets = new Map();
        if (!this.core._createdEvacTargets) this.core._createdEvacTargets = new Set();
        const geo = this.core.geometry;
        const groups = new Map();
        for (const d of detached) {
            const src = this.core._windowWorkspaces.get(d.win) ?? d.win.get_workspace();
            const key = `${d.conn}|${src ? geo.wsIndex(src) : -1}`;
            if (!groups.has(key)) groups.set(key, { idx: src ? geo.wsIndex(src) : -1, src, wins: [] });
            groups.get(key).wins.push(d.win);
        }
        // A source stays as it was, for the windows' return.
        const used = new Set([...groups.values()].map(g => g.src));
        const usable = (ws) => ws && geo.wsIndex(ws) >= 1 && ws !== this.core._backgroundAppParkingWs && !used.has(ws);
        const sorted = [...groups].sort((a, b) => a[1].idx - b[1].idx || (a[0] < b[0] ? -1 : 1));
        for (const [key, g] of sorted) {
            let target = this.core._evacTargets.get(key);
            if (!usable(target)) {
                target = null;
                const active = wm.get_active_workspace();
                let shown = null;
                for (let i = 1; i < wm.get_n_workspaces() && !target; i++) {
                    const ws = wm.get_workspace_by_index(i);
                    if (!usable(ws) || !this.wsEmpty(ws)) continue;
                    if (ws === active) shown ??= ws;
                    else target = ws;
                }
                target ??= shown;
                if (!target) {
                    target = wm.append_new_workspace(false, this.core.currentTime());
                    if (target) this.core._createdEvacTargets.add(target);
                }
                if (!target) {
                    this.core.debugLog(`evacuate: no workspace for ${key} (${g.wins.map(w => w.get_id()).join(',')}): staying put`);
                    continue;
                }
                this.core._evacTargets.set(key, target);
            }
            used.add(target);
            for (const w of g.wins) out.set(w, target);
        }
        return out;
    }

    // An evacuated window mutter brought back to its monitor goes to its
    // source workspace, unless the source is gone. (Moved by hand meanwhile,
    // it has no record: windows.js drops it.) A fixed monitor's window is
    // shown on every workspace: the caller puts it in its home order.
    restoreEvacuated(win, e) {
        const srcIdx = e.source ? this.core.geometry.wsIndex(e.source) : -1;
        if (srcIdx < 1 || global.workspace_manager.get_workspace_by_index(srcIdx) !== e.source) return false;
        this.core.debugLog(`evacuate: restore ${win.get_wm_class_instance() || '?'} id=${win.get_id()} ` +
            `ws=${this.core.geometry.wsIndex(e.target)} -> ws=${srcIdx}`);
        if (!this.fixedConn(e.conn) && win.get_workspace() !== e.source) {
            win.change_workspace(e.source);
            this.followMove(win);
        }
        return true;
    }

    // Our order follows a change_workspace even when the window's signals
    // are not connected (the resume pass of a lock cycle runs before them).
    followMove(win) {
        if (this.core._windowWorkspaces.get(win) !== win.get_workspace()) this.core.windows.followWorkspace(win);
    }

    // Workspaces made for an evacuation go once empty and not shown; a
    // returned monitor's reuse keys go.
    cleanupEvacuation() {
        const wm = global.workspace_manager;
        if (!wm || (!this.core._evacTargets?.size && !this.core._createdEvacTargets?.size)) return;
        for (const key of [...(this.core._evacTargets?.keys() ?? [])]) {
            if (this.connMon(key.slice(0, key.lastIndexOf('|'))) >= 0) this.core._evacTargets.delete(key);
        }
        const active = wm.get_active_workspace();
        for (const ws of [...(this.core._createdEvacTargets ?? [])]) {
            const idx = this.core.geometry.wsIndex(ws);
            if (idx < 1 || wm.get_workspace_by_index(idx) !== ws) {
                this.core._createdEvacTargets.delete(ws);
                continue;
            }
            if (ws === active || !this.wsEmpty(ws)) continue;
            this.core.debugLog(`evacuate: removed ws=${idx}`);
            this.core._createdEvacTargets.delete(ws);
            wm.remove_workspace(ws, this.core.currentTime());
        }
    }

    formatWorkspaces(list) {
        const n = [...new Set(list)].filter(i => i >= 1).sort((a, b) => a - b);
        if (n.length === 0) return 'an unused workspace';
        if (n.length === 1) return `Workspace ${n[0]}`;
        return n.every((v, i) => i === 0 || v === n[i - 1] + 1)
            ? `Workspaces ${n[0]}\u2013${n[n.length - 1]}`
            : `Workspaces ${n.join(', ')}`;
    }

    // One popup per pass that moved windows away or back, on the pointer's
    // monitor.
    monitorChangeNotice(lost, sent, sentTo, back, returned) {
        if (!this.core.workspaces || (sent === 0 && returned === 0)) return;
        const name = (set, what) => set.size === 1
            ? `${Monitors.savedConn([...set][0]) ? [...set][0] : 'Display'} ${what}`
            : `${set.size} displays ${what}`;
        const plural = (k) => `${k} window${k === 1 ? '' : 's'}`;
        const geo = this.core.geometry;
        const [title, subtitle] = sent > 0
            ? [name(lost, 'disconnected'),
                `${plural(sent)} moved to ${this.formatWorkspaces([...sentTo].map(ws => geo.bgAppRealToDisplay(geo.wsIndex(ws)) + 1))}`]
            : [name(back, 'connected'), `${plural(returned)} returned to their workspaces`];
        this.core.signals.addTimeout(250, () => {
            if (this.core._settings) this.core.workspaces.showPopup(title, subtitle, 3000, null, global.display.get_current_monitor());
            return GLib.SOURCE_REMOVE;
        });
    }

    // The monitor's arrangements as saved shapes, before its windows leave.
    saveGroupShapes(conn) {
        const wm = global.workspace_manager;
        let saved = 0;
        // A fixed group's key and tree are the same at every index.
        for (let i = 1; i < wm.get_n_workspaces(); i++) {
            const ws = wm.get_workspace_by_index(i);
            const group = this.groupKeyFor(i, conn);
            const layout = this.core.windows.layoutForKey(group);
            const tree = ws && this.core._bspTrees.get(this.groupObjFor(ws, conn));
            if (!tree || tree.type !== 'split' || !isBspLayout(layout)) continue;
            const key = this.core.persistence.shapeKey(group, layout);
            const shape = this.core.bsp.dwindleShapeToString(tree);
            this.core._persistedDwindleRaw?.set(key, shape);
            this.core._persistedDwindleByIndex?.set(key, this.core.bsp.savedShape(tree));
            saved++;
        }
        this.core.debugLog(`group: monitor ${conn} removed, ${saved} arrangements kept`);
        if (saved > 0) this.core.persistence.scheduleSaveLayouts();
    }

    // The one way a window changes group (monitor change, drop, grab end,
    // hotplug, movewindow): it leaves the old group's tree, goes last in the
    // order, joins the new tree (at the pointer only for a drag, which ended
    // there; a drop then places it; at `at` for movewindow) and the workspace
    // retiles. A window is in exactly one group.
    moveWindowToGroup(win, conn, cause, at = null) {
        if (!this.core._windowMonitors?.has(win)) return false;
        const from = this.windowConn(win);
        if (from === conn) return false;
        // Out of a fixed group into a workspace's: the workspace it shows on.
        if (this.fixedConn(from) && !this.fixedConn(conn)) this.adoptIntoWorkspace(win, win.get_workspace());
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
            isBspLayout(this.core.windows.getWorkspaceLayout(ws, mon)))
            this.core.bsp.bspInsertForWorkspace(ws, win, mon, cause === 'drop' || cause === 'grab-end', at);
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
        // A fixed group's window taking a workspace group's place joins ws.
        if (this.fixedConn(ca) && !this.fixedConn(cb)) this.adoptIntoWorkspace(a, ws);
        if (this.fixedConn(cb) && !this.fixedConn(ca)) this.adoptIntoWorkspace(b, ws);
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

    // A fixed group's window stays in the order of the workspace it came
    // from (its home); joining a workspace's group it moves to that
    // workspace's order.
    adoptIntoWorkspace(win, ws) {
        const home = this.core._windowWorkspaces.get(win);
        if (!ws || home === ws) return;
        if (home) {
            const order = this.core.windows.getWorkspaceOrder(home);
            const i = order.indexOf(win);
            if (i !== -1) order.splice(i, 1);
        }
        const order = this.core.windows.getWorkspaceOrder(ws);
        if (!order.includes(win)) order.push(win);
        this.core._windowWorkspaces.set(win, ws);
        this.core._windowWSIndices.set(win, this.core.geometry.wsIndex(ws));
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
        this.clearSettleTimer();
        this.core._monitorsSettling = false;
        this.core._monitorSettleFirst = 0;
        this.core._monitorSettleRetries = 0;
        this.core._regroupId = 0;
        this.core._grabbedWindow = null;
        this.core._grabDropped = false;
        this.core._monitorConnCache = null;
        this.core._monitorConnPartial = false;
        this.core._tiledMonitorsCache = null;
        super.destroy();
    }
}
