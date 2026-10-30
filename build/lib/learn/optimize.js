import { LEVEL_SEP_W, median, quantile } from "./runs.js";
export const GUARD_MIN_GAIN_SEC = 180;
export function margin(d, pollSec) {
    return Math.max(2 * pollSec, 60, 0.25 * d);
}
export function minEndSec(pollSec) {
    return Math.max(3 * pollSec, 120);
}
function round2(v) {
    return Math.round(v * 100) / 100;
}
export function endCandidates(s, layout, minDeltaW) {
    const { idle, lpost, runs, runLimit } = layout;
    const lmin = Math.max(idle * 1.15 + 0.2, lpost * 1.15 + 0.2, lpost + minDeltaW);
    const active = [];
    const levels = [];
    for (const r of runs) {
        for (let i = r.from; i <= r.coreEnd; i++) {
            if (s.last[i] > runLimit) {
                active.push(s.last[i]);
            }
        }
        for (const g of r.gaps) {
            const vals = [];
            for (let i = g.from; i <= g.to; i++) {
                vals.push(s.last[i]);
            }
            levels.push(median(vals));
        }
        if (r.plateauLevel !== null) {
            levels.push(r.plateauLevel);
        }
    }
    const lmax = Math.max(lmin, 0.5 * quantile(active, 0.1));
    const clamp = (v) => round2(Math.min(lmax, Math.max(lmin, v)));
    const out = [clamp(Math.max(idle * 1.5, idle + 1, lmin))];
    const extra = [...new Set(levels.map(round2))].filter(b => b / lmin >= 1.3).sort((a, b) => a - b);
    for (const b of extra) {
        const c = clamp(Math.sqrt(lmin * b));
        if (!out.includes(c) && out.length < 6) {
            out.push(c);
        }
    }
    return out;
}
export function runTable(s, r, e, run) {
    const stepSec = s.stepMs / 1000;
    const pauses = [];
    let start = -1;
    let lv = Number.NEGATIVE_INFINITY;
    for (let i = r.from; i <= r.runEnd; i++) {
        if (s.last[i] < e) {
            if (start < 0) {
                start = i;
                lv = s.max[i];
            }
            else {
                lv = Math.max(lv, s.max[i]);
            }
        }
        else if (start >= 0) {
            pauses.push({ d: (i - start) * stepSec, o: (start - r.from) * stepSec, lv });
            start = -1;
        }
    }
    const endStretch = start >= 0 ? start : r.runEnd + 1;
    return {
        pauses,
        oEnd: (endStretch - r.from) * stepSec,
        trail: (r.runEnd + 1 - endStretch) * stepSec,
        endStretch,
        run,
    };
}
function endLevel(s, t, e, ds) {
    const to = Math.min(s.length - 1, t.endStretch + Math.ceil((ds * 1000) / s.stepMs));
    let b = Number.NEGATIVE_INFINITY;
    for (let i = t.endStretch; i <= to; i++) {
        if (s.last[i] < e) {
            b = Math.max(b, s.last[i]);
        }
    }
    return b;
}
export function planFor(ctx, e, tables) {
    const poll = ctx.pollSec;
    const n = Math.max(1, tables.length);
    const all = tables.flatMap(t => t.pauses);
    const dmax = all.reduce((m, p) => Math.max(m, p.d), 0);
    const trail = tables.reduce((m, t) => Math.max(m, t.trail), 0);
    const dsFor = (dk) => Math.ceil(Math.max(minEndSec(poll), dk + margin(dk, poll), trail > 0 ? trail + margin(trail, poll) : 0));
    const noGuardDs = dsFor(dmax);
    const noGuardCost = n * noGuardDs;
    let best = null;
    const levels = [0, ...[...new Set(all.map(p => p.d))].sort((a, b) => a - b)];
    for (const dk of levels) {
        const held = all.filter(p => p.d > dk);
        if (held.length === 0) {
            continue;
        }
        const Ds = dsFor(dk);
        const hold = Math.ceil(1.25 * Math.max(...held.map(p => p.d)) + 2 * poll);
        const options = [];
        const a = Math.max(...held.map(p => p.lv));
        const b = Math.min(...tables.map(t => endLevel(ctx.series, t, e, Ds)));
        if (Number.isFinite(b) && b - a >= Math.max(LEVEL_SEP_W, 0.5 * b, 2 * ctx.minDeltaW)) {
            options.push({
                cost: n * Ds,
                guard: { pauseHoldSec: hold, pauseUntilSec: 0, pauseBelowVal: round2((a + b) / 2) },
            });
        }
        const oH = Math.max(...held.map(p => p.o));
        const T = Math.ceil(oH + Math.max(2 * poll, 180, 0.25 * oH));
        options.push({
            cost: tables.reduce((sum, t) => sum + (t.oEnd < T ? Math.max(hold, Ds) : Ds), 0),
            guard: { pauseHoldSec: hold, pauseUntilSec: T, pauseBelowVal: 0 },
        });
        const option = options.reduce((x, y) => (y.cost < x.cost ? y : x));
        if (!best || option.cost < best.cost) {
            best = { cost: option.cost, Ds, guard: option.guard };
        }
    }
    if (best && (noGuardCost - best.cost) / n >= GUARD_MIN_GAIN_SEC) {
        return { e, Ds: best.Ds, guard: best.guard, estCost: best.cost, dmax, noGuardDs };
    }
    return { e, Ds: noGuardDs, guard: null, estCost: noGuardCost, dmax, noGuardDs };
}
//# sourceMappingURL=optimize.js.map