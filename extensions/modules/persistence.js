// Per-workspace layout/ratio persistence (across logins) — serializes the live
// layout and ratio maps to the settings keys, and reloads them at startup.
// Keyed by workspace INDEX (never by workspace object). The workspace-* keys
// hold the primary monitor's group in the single-monitor format, so a build
// without per-monitor tiling reads them unchanged; the monitor-workspace-*
// keys hold the other monitors, each entry prefixed "CONNECTOR:".
//
// Methods live on this subsystem class.

import GLib from 'gi://GLib';

import { Monitors } from './monitors.js';
import { LAYOUT_NAMES, isBspLayout, isSpiralLayout } from './helpers.js';


export class Persistence {
    constructor(core) {
        this.core = core;
    }

    scheduleSaveLayouts() {
        // Trailing (quiet-period) debounce: every change RESETS the timer, so
        // exactly one write lands 10s after interaction stops. A fixed-from-
        // first-event window would hammer dconf during sustained resizing.
        if (!this.core._settings || this.core._shuttingDown || this.core._layoutSaveClosed) return;
        const now = Date.now();
        if (!this.core._saveDirtySince) this.core._saveDirtySince = now;
        // Starvation cap: under back-to-back activity the quiet timer keeps
        // getting reset — force a save once we've been continuously dirty
        // for 60s, so a crash loses at most ~60s of layout changes.
        // (disable() flushes synchronously regardless.)
        if (now - this.core._saveDirtySince >= 60000) {
            if (this.core._workspaceLayoutsSaveId) {
                GLib.source_remove(this.core._workspaceLayoutsSaveId);
                this.core._workspaceLayoutsSaveId = 0;
            }
            this.core._saveDirtySince = 0;
            this.savePersistedLayouts();
            return;
        }
        if (this.core._workspaceLayoutsSaveId)
            GLib.source_remove(this.core._workspaceLayoutsSaveId);
        this.core._workspaceLayoutsSaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            this.core._workspaceLayoutsSaveId = 0;
            if (!this.core._settings || this.core._shuttingDown) return GLib.SOURCE_REMOVE;
            this.core._saveDirtySince = 0;
            this.savePersistedLayouts();
            return GLib.SOURCE_REMOVE;
        });
    }

    savePersistedLayouts() {
        try {
            const monitors = this.core.monitors;
            monitors.syncKeyedPrimary();
            const layouts = [];
            const masterRatios = [];
            const stackRatios = [];
            const dwindleRaw = new Map(this.core._persistedDwindleRaw || []);
            const n = global.workspace_manager.get_n_workspaces();
            for (let i = 1; i < n; i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                if (!ws) continue;
                // "The layout last used is the persistent one" — store the
                // effective layout of every real workspace (the parking ws at
                // index 0 is never stored).
                // No monitor: the primary's group.
                layouts.push(`${i}:${this.core.windows.getWorkspaceLayout(ws, null)}`);
                const mr = this.core._masterRatios.get(i);
                if (mr !== undefined)
                    masterRatios.push(`${i}:${mr}`);
                const sr = this.core._stackRatios.get(i);
                if (sr && sr.size > 0) {
                    const idx = [];
                    for (const [k, v] of sr)
                        idx.push(`${k}:${v}`);
                    stackRatios.push(`${i}:${idx.join(',')}`);
                }
                // Dwindle trees are in-memory only — serialize the shape+ratios
                // (no window refs) so resized arrangements survive logins.
                //
                // MERGE, don't rebuild: a full rewrite would drop every workspace
                // with no live tree at save time (at boot the first save deletes a
                // not-yet-opened workspace's shape). Mid-session churn is worse —
                // a collapsed single-leaf tree would overwrite a good shape. So
                // only a live 2+-window tree may overwrite an entry; no tree /
                // leaf / empty PRESERVES the previously-saved shape.
                // One entry per (slot, BSP layout): a shared one would stamp
                // dwindle's ratios on Spiral's tree and the reverse.
                const tree = this.core._bspTrees.get(ws);
                const layout = this.core.windows.getWorkspaceLayout(ws, null);
                if (tree && tree.type === 'split' && isBspLayout(layout))
                    dwindleRaw.set(this.shapeKey(i, layout), this.core.bsp.dwindleShapeToString(tree));
            }
            // The other monitors: "CONNECTOR:" + the same entry. A
            // disconnected monitor's rules stay for its return; live values and
            // connected monitors' layouts overwrite them.
            const primary = monitors.keyedPrimaryConn();
            const others = map => [...(map ?? [])].filter(([k]) => typeof k === 'string');
            const monLayouts = new Map([...others(this.core._persistedLayoutByIndex), ...others(this.core._workspaceLayouts)]);
            const monMaster = new Map([...others(this.core._persistedMasterByIndex), ...others(this.core._masterRatios)]);
            const monStack = new Map([...others(this.core._persistedStackByIndex), ...others(this.core._stackRatios)]);
            for (const mon of monitors.tiledMonitors()) {
                const conn = monitors.monConn(mon);
                if (conn === primary) continue;
                for (let i = 1; i < n; i++) {
                    const ws = global.workspace_manager.get_workspace_by_index(i);
                    if (!ws) continue;
                    const layout = this.core.windows.getWorkspaceLayout(ws, mon);
                    const key = monitors.groupKeyFor(i, conn);
                    monLayouts.set(key, layout);
                    const tree = this.core._bspTrees.get(monitors.groupObj(ws, mon));
                    if (tree && tree.type === 'split' && isBspLayout(layout))
                        dwindleRaw.set(this.shapeKey(key, layout), this.core.bsp.dwindleShapeToString(tree));
                }
            }
            // "CONNECTOR:INDEX:value", sorted by monitor then workspace.
            const monEntries = (map, fmt) => [...map].map(([k, v]) => {
                const p = Monitors.parseGroupKey(k);
                const val = fmt(v);
                return p && Monitors.savedConn(p.conn) && val !== null ? [p.conn, p.idx, `${p.conn}:${p.idx}${p.tail}:${val}`] : null;
            }).filter(Boolean)
                .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])
                .map(e => e[2]);
            const weights = sr => (sr && sr.size > 0 ? [...sr].map(([k, v]) => `${k}:${v}`).join(',') : null);
            // Write merged dwindle shapes: filter out non-split leftovers, keep
            // entries for workspaces beyond the current count and entries of a
            // layout this build does not know (verbatim), and re-sync the raw
            // map to exactly what we wrote. A key's monitor, not its type, says
            // which setting it goes to ("1:spiral" is the primary's).
            const dwindleTrees = [];
            const monShapes = new Map();
            for (const [key, shape] of dwindleRaw) {
                const p = Monitors.parseGroupKey(key);
                if (!p) continue;
                const node = this.core.bsp.dwindleShapeFromString(shape);
                if (this.knownShapeTail(p.tail) && (!node || node.type !== 'split')) continue;
                if (p.conn) monShapes.set(key, shape);
                else dwindleTrees.push(`${key}:${shape}`);
            }
            dwindleTrees.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
            const monDwindle = monEntries(monShapes, sh => sh);
            // The monitor the single-monitor keys describe goes first: a
            // re-parse on the writes below must read them for it. A primary
            // without a connector yet leaves the last real name.
            if (Monitors.savedConn(primary))
                this.core._settings.set_string('monitor-primary-connector', primary);
            this.core._settings.set_strv('monitor-workspace-layouts', monEntries(monLayouts, v => v));
            this.core._settings.set_strv('monitor-workspace-master-ratios', monEntries(monMaster, v => `${v}`));
            this.core._settings.set_strv('monitor-workspace-stack-ratios', monEntries(monStack, weights));
            this.core._settings.set_strv('monitor-workspace-dwindle-trees', monDwindle);
            this.core._settings.set_strv('workspace-layouts', layouts);
            this.core._settings.set_strv('workspace-master-ratios', masterRatios);
            this.core._settings.set_strv('workspace-stack-ratios', stackRatios);
            this.core._settings.set_strv('workspace-dwindle-trees', dwindleTrees);
            const raw = new Map();
            for (const entry of dwindleTrees) {
                const e = this.parseDwindleTreeEntry(entry);
                if (e) raw.set(e.key, e.shape);
            }
            for (const entry of monDwindle) {
                const m = Monitors.splitMonitorEntry(entry);
                const e = m && this.parseDwindleTreeEntry(m.rest, m.conn);
                if (e) raw.set(e.key, e.shape);
            }
            this.core._persistedDwindleRaw = raw;
            this.core.debugLog(`persisted layouts: ${layouts.length} ws, ${masterRatios.length} master, ${stackRatios.length} stack, ${dwindleTrees.length} dwindle; ` +
                `other monitors: ${monLayouts.size} layouts, ${monDwindle.length} dwindle`);
        } catch (e) {
            this.core.debugLog(`persist layouts failed: ${e.message}`);
        }
    }

    loadPersistedLayoutRules() {
        // Persisted layouts/ratios are RULES keyed by workspace slot (index):
        // "whatever workspace occupies slot N uses layout Y". Parsed once at enable
        // and read by the getters at use time — no binding to workspace objects
        // (which churn during login restores); a removal or an insert shifts the
        // slots after it (shiftWorkspaceIndexKeys). Rules for slots beyond the
        // current workspace count persist and apply when those slots spawn.
        this.core._persistedLayoutByIndex = new Map();
        this.core._persistedMasterByIndex = new Map();
        this.core._persistedStackByIndex = new Map();
        this.core._persistedDwindleByIndex = this.parsePersistedDwindleShapes();
        const monitors = this.core.monitors;
        try {
            for (const { conn, entry } of this.persistedEntries('workspace-layouts', 'monitor-workspace-layouts')) {
                const [idxStr, layout] = entry.split(':');
                const idx = parseInt(idxStr, 10);
                if (idx <= 0 || !Number.isInteger(idx)) continue;
                if (!Object.hasOwn(LAYOUT_NAMES, layout)) continue;
                this.core._persistedLayoutByIndex.set(monitors.groupKeyFor(idx, conn), layout);
            }
            for (const { conn, entry } of this.persistedEntries('workspace-master-ratios', 'monitor-workspace-master-ratios')) {
                const [idxStr, ratioStr] = entry.split(':');
                const idx = parseInt(idxStr, 10);
                const ratio = parseFloat(ratioStr);
                if (idx <= 0 || !Number.isInteger(idx) || !Number.isFinite(ratio)) continue;
                if (ratio < 0.05 || ratio > 0.95) continue;
                this.core._persistedMasterByIndex.set(monitors.groupKeyFor(idx, conn), ratio);
            }
            for (const { conn, entry } of this.persistedEntries('workspace-stack-ratios', 'monitor-workspace-stack-ratios')) {
                // "INDEX:SLOT:WEIGHT,SLOT:WEIGHT": the weights hold ':' too,
                // so only the first one ends the index.
                const sep = entry.indexOf(':');
                if (sep <= 0) continue;
                const idx = parseInt(entry.substring(0, sep), 10);
                const weightsStr = entry.substring(sep + 1);
                if (idx <= 0 || !Number.isInteger(idx)) continue;
                const map = new Map();
                for (const part of (weightsStr || '').split(',')) {
                    const [kStr, vStr] = part.split(':');
                    const k = parseInt(kStr, 10);
                    const v = parseFloat(vStr);
                    if (k >= 0 && Number.isFinite(v) && v > 0)
                        map.set(k, v);
                }
                if (map.size > 0)
                    this.core._persistedStackByIndex.set(monitors.groupKeyFor(idx, conn), map);
            }
            this.core.debugLog(`persisted rules: ${this.core._persistedLayoutByIndex.size} layouts, ` +
                `${this.core._persistedMasterByIndex.size} master, ${this.core._persistedStackByIndex.size} stack, ` +
                `${this.core._persistedDwindleByIndex.size} dwindle`);
        } catch (e) {
            this.core.debugLog(`load persisted layout rules failed: ${e.message}`);
        }
    }

    // A workspace was inserted (delta +1) or removed (delta -1) at `index`:
    // shift the per-index layouts, ratios and saved shapes (live and
    // persisted, slots beyond the workspace count too) and re-derive the
    // windows' cached indices. A BGAPP parking at slot 0 keeps that slot: no
    // rule moves into or out of it.
    shiftWorkspaceIndexKeys(index, delta) {
        const parking = this.core._backgroundAppParkingWs;
        const floor = parking && global.workspace_manager.get_workspace_by_index(0) === parking ? 1 : 0;
        const from = delta > 0 ? Math.max(index, floor) : index;
        // Group keys (monitors.js): the index moves, the monitor stays.
        const idxOf = k => Monitors.parseGroupKey(k)?.idx ?? -1;
        const rekey = (k, i) => {
            const p = Monitors.parseGroupKey(k);
            return Monitors.formatGroupKey(i, p.conn, p.tail);
        };
        let shifted = false;
        for (const map of this.core.monitors.groupIndexMaps()) {
            if (!map) continue;
            const moved = [...map].filter(([k]) => idxOf(k) >= from && idxOf(k) >= floor);
            for (const [k] of moved) map.delete(k);
            for (const [k, v] of moved) {
                const i = idxOf(k);
                if (delta < 0 && i === index) continue;
                if (i + delta >= floor) map.set(rekey(k, i + delta), v);
            }
            if (moved.length > 0) shifted = true;
        }
        this.core.windows.refreshWorkspaceIndices();
        if (!shifted) return;
        this.core.debugLog(`workspaces: index state from ${from} shifted by ${delta}`);
        this.scheduleSaveLayouts();
    }

    parsePersistedDwindleShapes() {
        // "index:shape" slot rules, same keying as workspace-layouts: the shape
        // carries only structure + ratios (no window refs) — leaves are
        // placeholders, matched to live windows by position at reconcile time. Raw
        // strings are kept alongside (in _persistedDwindleRaw) so saves MERGE
        // rather than rebuild — see _savePersistedLayouts.
        const map = new Map();
        const raw = new Map();
        try {
            for (const { conn, entry } of this.persistedEntries('workspace-dwindle-trees', 'monitor-workspace-dwindle-trees')) {
                const e = this.parseDwindleTreeEntry(entry, conn);
                if (!e) continue;
                // Another layout's shape is not applied, only kept.
                if (!e.known) {
                    raw.set(e.key, e.shape);
                    continue;
                }
                const shape = this.core.bsp.dwindleShapeFromString(e.shape);
                if (shape) {
                    map.set(e.key, shape);
                    raw.set(e.key, e.shape);
                }
            }
        } catch (e) {
            this.core.debugLog(`parse dwindle shapes failed: ${e.message}`);
        }
        this.core._persistedDwindleRaw = raw;
        return map;
    }

    // "index:shape" (dwindle, read by every build) or "index:layout:shape"
    // saved for monitor `conn` (null: the keyed primary). Shapes never
    // contain ':', so a second one marks a layout tag: 'dwindle' (an older
    // tagged build) is dwindle's key, 'spiral' gets the key's ':spiral'
    // tail, any other tag is kept under its own tail (known: false).
    parseDwindleTreeEntry(entry, conn = null) {
        const sep = entry.indexOf(':');
        if (sep <= 0) return null;
        const idx = parseInt(entry.substring(0, sep), 10);
        if (idx <= 0 || !Number.isInteger(idx)) return null;
        let shape = entry.substring(sep + 1);
        let tag = 'dwindle';
        const t = shape.indexOf(':');
        if (t >= 0) {
            tag = shape.substring(0, t);
            shape = shape.substring(t + 1);
        }
        const group = this.core.monitors.groupKeyFor(idx, conn);
        const known = isBspLayout(tag);
        return { key: known ? this.shapeKey(group, tag) : `${group}:${tag}`, shape, known };
    }

    // The saved-shape key of a group (monitors.groupKey) for a BSP layout:
    // dwindle keeps the bare group key, Spiral adds ':spiral'.
    shapeKey(groupKey, layout) {
        return isSpiralLayout(layout) ? `${groupKey}:spiral` : groupKey;
    }

    knownShapeTail(tail) {
        return tail === '' || tail === ':spiral';
    }

    // A setting's entries with the monitor they belong to (null: the keyed
    // primary): the monitor-* key's "CONNECTOR:entry" ones, then the
    // single-monitor key's, saved for monitor-primary-connector (unset: the
    // primary). The latter come last, so they win for their monitor (a build
    // without per-monitor tiling may have changed them since).
    persistedEntries(key, monKey) {
        const out = [];
        for (const raw of this.core._settings.get_strv(monKey) || []) {
            const m = Monitors.splitMonitorEntry(raw);
            if (m) out.push({ conn: m.conn, entry: m.rest });
        }
        const saved = this.core._settings.get_string('monitor-primary-connector') || null;
        for (const entry of this.core._settings.get_strv(key) || [])
            out.push({ conn: saved, entry });
        return out;
    }

    destroy() {
        // The final save below is the last one: teardown that follows (the
        // BGAPP releasing a trailing parking) must not schedule another.
        this.core._layoutSaveClosed = true;
        if (this.core._workspaceLayoutsSaveId) {
            GLib.source_remove(this.core._workspaceLayoutsSaveId);
            this.core._workspaceLayoutsSaveId = 0;
        }
        this.savePersistedLayouts();
    }
}
