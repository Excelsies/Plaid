import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, leaf, split } from '../helpers.mjs';

// bsp.splitBoxes replaced six hand-written copies of the split geometry.
// The reference below is those copies as they were, verbatim; both run on
// the same seeded random trees and must agree exactly.

class Reference {
    constructor(core, ref) {
        this.core = core;
        this.ref = ref;
    }

    bspInsert(node, win, x, y, w, h, gap, ratio = null) {
        if (!node) return this.ref.bspMakeLeaf(win);
        if (node.type === 'empty') return this.ref.bspMakeLeaf(win);
        if (node.type === 'leaf') {
            const dir = w >= h ? 'h' : 'v';
            if (ratio === null) ratio = this.core._settings.get_double('dwindle-ratio');
            return this.ref.bspMakeSplit(dir, ratio, node, this.ref.bspMakeLeaf(win));
        }
        const isH = node.direction === 'h';
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (isH)
            node.second = this.bspInsert(node.second, win, x + split + gap, y, secondSize, h, gap, ratio);
        else
            node.second = this.bspInsert(node.second, win, x, y + split + gap, w, secondSize, gap, ratio);
        return node;
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
        const isH = node.direction === 'h';
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
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (split < 0 || secondSize < 0) return;
        if (isH) {
            this.bspLayout(node.first, x, y, split, h, gap, skipWindow);
            this.bspLayout(node.second, x + split + gap, y, secondSize, h, gap, skipWindow);
        } else {
            this.bspLayout(node.first, x, y, w, split, gap, skipWindow);
            this.bspLayout(node.second, x, y + split + gap, w, secondSize, gap, skipWindow);
        }
    }
    bspFindLeafAtPoint(node, x, y, w, h, px, py, gap) {
        if (!node) return null;
        if (node.type === 'empty') return node;
        if (node.type === 'leaf') return node;
        const isH = node.direction === 'h';
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (isH) {
            if (px < x + split + gap)
                return this.bspFindLeafAtPoint(node.first, x, y, split, h, px, py, gap);
            else
                return this.bspFindLeafAtPoint(node.second, x + split + gap, y, secondSize, h, px, py, gap);
        } else {
            if (py < y + split + gap)
                return this.bspFindLeafAtPoint(node.first, x, y, w, split, px, py, gap);
            else
                return this.bspFindLeafAtPoint(node.second, x, y + split + gap, w, secondSize, px, py, gap);
        }
    }
    bspTagGeometry(node, x, y, w, h, gap) {
        if (!node) return;
        node._x = x;
        node._y = y;
        node._w = w;
        node._h = h;
        if (node.type === 'empty' || node.type === 'leaf') return;
        const isH = node.direction === 'h';
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (isH) {
            this.bspTagGeometry(node.first, x, y, split, h, gap);
            this.bspTagGeometry(node.second, x + split + gap, y, secondSize, h, gap);
        } else {
            this.bspTagGeometry(node.first, x, y, w, split, gap);
            this.bspTagGeometry(node.second, x, y + split + gap, w, secondSize, gap);
        }
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
        const isH = node.direction === 'h';
        const axis = isH ? areaW : areaH;
        const split = Math.floor((axis - gap) * node.ratio);
        const secondSize = axis - split - gap;
        if (isH) {
            this.clampTreeToMinSizes(node.first, split, areaH, gap);
            this.clampTreeToMinSizes(node.second, secondSize, areaH, gap);
        } else {
            this.clampTreeToMinSizes(node.first, areaW, split, gap);
            this.clampTreeToMinSizes(node.second, areaW, secondSize, gap);
        }
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
        const isH = node.direction === 'h';
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        const childAxis = axisSize - gap;
        let changed = false;
        if (isH) {
            changed = this.adjustForConstraints(node.first, node, true, x, y, split, h, gap, childAxis) || changed;
            changed = this.adjustForConstraints(node.second, node, false, x + split + gap, y, secondSize, h, gap, childAxis) || changed;
        } else {
            changed = this.adjustForConstraints(node.first, node, true, x, y, w, split, gap, childAxis) || changed;
            changed = this.adjustForConstraints(node.second, node, false, x, y + split + gap, w, secondSize, gap, childAxis) || changed;
        }
        return changed;
    }
}

// A fixed linear congruential sequence: the same trees on every run.
function rng(seed) {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function core(rnd) {
    const calls = [];
    return { calls, _settings: { get_double: () => 0.5, get_int: () => 4 }, debugLog() {}, _liveSent: null,
        grab: { safeMove: (w, x, y, ww, h) => calls.push([w.id, x, y, ww, h]) }, rnd };
}

function tree(rnd, depth, ids) {
    if (depth <= 0 || rnd() < 0.25) {
        if (rnd() < 0.05) return { type: 'empty' };
        const w = Math.floor(rnd() * 900) + 1, h = Math.floor(rnd() * 900) + 1;
        return { type: 'leaf', window: { id: ++ids.n, get_frame_rect: () => ({ width: w, height: h }), is_fullscreen: () => false } };
    }
    return { type: 'split', direction: rnd() < 0.5 ? 'h' : 'v', ratio: 0.02 + rnd() * 0.96,
        first: tree(rnd, depth - 1, ids), second: tree(rnd, depth - 1, ids) };
}

const clone = n => n && (n.type === 'split' ? { ...n, first: clone(n.first), second: clone(n.second) } : { ...n });
const str = n => JSON.stringify(n, (k, v) => (k === 'window' ? v?.id : v));
const mins = (n, rnd) => {
    if (!n || n.type === 'empty') return;
    n._minW = Math.floor(rnd() * 600);
    n._minH = Math.floor(rnd() * 600);
    if (n.type === 'split') { mins(n.first, rnd); mins(n.second, rnd); }
};

test('splitBoxes: the six geometry passes agree with their hand-written originals on 300 seeded trees', () => {
    const rnd = rng(12345);
    const runs = {
        tag: (b, t, c, a) => { b.bspTagGeometry(t, a.x, a.y, a.w, a.h, a.gap); return str(t); },
        layout: (b, t, c, a) => { b.bspLayout(t, a.x, a.y, a.w, a.h, a.gap, null); return JSON.stringify(c.calls) + str(t); },
        clamp: (b, t, c, a) => { mins(t, rng(a.seed)); b.clampTreeToMinSizes(t, a.w, a.h, a.gap); return str(t); },
        point: (b, t, c, a) => {
            const r = rng(a.seed);
            return Array.from({ length: 12 }, () => {
                const l = b.bspFindLeafAtPoint(t, a.x, a.y, a.w, a.h, a.x + r() * a.w, a.y + r() * a.h, a.gap);
                return l?.window?.id ?? l?.type;
            }).join(',');
        },
        adjust: (b, t, c, a) => b.adjustForConstraints(t, null, false, a.x, a.y, a.w, a.h, a.gap, a.w) + str(t),
        insert: (b, t, c, a) => str(b.bspInsert(t, { id: 9999 }, a.x, a.y, a.w, a.h, a.gap, null)),
    };
    let cases = 0;
    for (let i = 0; i < 300; i++) {
        const t = tree(rnd, 5, { n: 0 });
        const a = { x: Math.floor(rnd() * 100), y: Math.floor(rnd() * 100), w: Math.floor(rnd() * 3000) - 200,
            h: Math.floor(rnd() * 2000) - 200, gap: Math.floor(rnd() * 12), seed: Math.floor(rnd() * 1e6) };
        for (const [name, run] of Object.entries(runs)) {
            const cn = core(), co = core();
            const self = makeSelf();
            Object.assign(self, { _settings: cn._settings, debugLog: () => {}, _liveSent: null });
            self.grab.safeMove = cn.grab.safeMove;
            const got = run(self.bsp, clone(t), cn, a);
            const want = run(new Reference(co, self.bsp), clone(t), co, a);
            assert.equal(got, want, `${name} #${i} ${JSON.stringify(a)}`);
            cases++;
        }
    }
    assert.equal(cases, 1800);
});

// bspLayout gives nothing to a split whose span is under one gap (a
// negative child along the split), and only along the split's axis.
test('bspLayout: a split narrower than its gap lays out neither child; the other axis does not stop it', () => {
    const self = makeSelf({ 'inside-gap': 10 });
    const moved = [];
    self.grab.safeMove = (w, ...r) => moved.push([w, ...r]);
    const a = { id: 1 }, b = { id: 2 };
    self.bsp.bspLayout(split('h', 0.5, leaf(a), leaf(b)), 0, 0, 6, 100, 10, null);
    assert.deepEqual(moved, []);
    self.bsp.bspLayout(split('h', 0.5, leaf(a), leaf(b)), 0, 0, 100, -5, 10, null);
    assert.deepEqual(moved.map(m => m[0]), [a, b]);
});
