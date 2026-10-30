import { applyGapRule, GAP_MS } from "./ticks.js";
export const MAX_PAUSE_MS = 30 * 60_000;
export const MIN_ACTIVE_MS = 5 * 60_000;
export const PAD_BEFORE_MS = 30 * 60_000;
export const PAD_AFTER_MS = 3 * 60 * 60_000;
export const MAX_WINDOWS = 20;
export const TRAILER_BURST_MS = 2 * 60_000;
export const TRAILER_GAP_MS = [60_000, 15 * 60_000];
export const SUSTAINED_MS = 2 * 60_000;
export const PLATEAU_RUN_MS = 20 * 60_000;
export const PLATEAU_QUIET_MS = 5 * 60_000;
export const SPLIT_GAP_MIN_MS = 3 * 60_000;
export const POST_END_MS = 10 * 60_000;
export const LEVEL_SEP_W = 0.3;
const IDLE_SPAN_MS = 2 * 60 * 60_000;
const SHORT_PAUSE_MS = 10 * 60_000;
export function quantile(values, q) {
    const n = values.length;
    if (n === 0) {
        return 0;
    }
    const sorted = Float64Array.from(values).sort();
    const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
    return sorted[idx];
}
export function median(values) {
    const n = values.length;
    if (n === 0) {
        return 0;
    }
    const sorted = Float64Array.from(values).sort();
    const mid = Math.floor(n / 2);
    return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function valuesOf(s, from, to) {
    const out = [];
    for (let i = Math.max(0, from); i <= Math.min(s.length - 1, to); i++) {
        if (s.valid[i] === 1) {
            out.push(s.last[i]);
        }
    }
    return out;
}
function segments(s, limit, maxGap, endIsGap) {
    const out = [];
    let current = null;
    let lastInvalid = Number.NEGATIVE_INFINITY;
    const lead = s.firstIdx;
    const leadIdle = lead > 0 && lead < s.length && (lead * s.stepMs >= GAP_MS || s.last[lead] <= limit);
    for (let i = 0; i < s.length; i++) {
        if (s.valid[i] === 0) {
            if (current && i - current.to - 1 <= maxGap) {
                current.touched = true;
            }
            current = null;
            lastInvalid = i;
            continue;
        }
        if (s.last[i] <= limit) {
            continue;
        }
        if (current && i - current.to - 1 <= maxGap) {
            current.to = i;
            current.active++;
        }
        else {
            const afterLead = leadIdle && lastInvalid === lead - 1;
            current = { from: i, to: i, active: 1, touched: !afterLead && i - lastInvalid - 1 <= maxGap };
            out.push(current);
        }
    }
    if (endIsGap > 0 && current && current.active >= endIsGap && s.length - 1 - current.to <= maxGap) {
        current.touched = true;
    }
    return out;
}
function blocksOf(s, span, limit) {
    const out = [];
    let cur = null;
    for (let i = span.from; i <= span.to; i++) {
        if (s.last[i] > limit) {
            if (cur && cur.to === i - 1) {
                cur.to = i;
            }
            else {
                cur = { from: i, to: i };
                out.push(cur);
            }
        }
    }
    return out;
}
function gapsBetween(blocks, upTo) {
    const out = [];
    for (let k = 1; k < blocks.length; k++) {
        if (blocks[k].from > upTo) {
            break;
        }
        if (blocks[k].from > blocks[k - 1].to + 1) {
            out.push({ from: blocks[k - 1].to + 1, to: blocks[k].from - 1 });
        }
    }
    return out;
}
function trailerStart(blocks, stepMs) {
    const dur = (b) => (b.to - b.from + 1) * stepMs;
    const gapOk = (a, b) => {
        const gap = (b.from - a.to - 1) * stepMs;
        return gap >= TRAILER_GAP_MS[0] && gap <= TRAILER_GAP_MS[1];
    };
    let k = blocks.length - 1;
    let n = 0;
    while (k >= 0 && dur(blocks[k]) <= TRAILER_BURST_MS && (n === 0 || gapOk(blocks[k], blocks[k + 1]))) {
        k--;
        n++;
    }
    if (n >= 2 && k >= 0 && dur(blocks[k]) >= SUSTAINED_MS && gapOk(blocks[k], blocks[k + 1])) {
        return k;
    }
    return -1;
}
function coreOf(s, seg, runLimit) {
    const blocks = blocksOf(s, seg, runLimit);
    const k = trailerStart(blocks, s.stepMs);
    const coreEnd = k >= 0 ? blocks[k].to : seg.to;
    return {
        from: seg.from,
        to: seg.to,
        active: seg.active,
        coreEnd,
        runEnd: coreEnd,
        bursts: k >= 0 ? blocks.slice(k + 1) : [],
        gaps: gapsBetween(blocks, coreEnd),
        plateauLevel: null,
        postEnd: 0,
    };
}
function idleOf(s, runs, bounds, fallback) {
    const span = Math.ceil(IDLE_SPAN_MS / s.stepMs);
    const levels = [];
    runs.forEach((r, i) => {
        const vals = valuesOf(s, r.coreEnd + 1, Math.min(r.coreEnd + span, bounds[i].next - 1));
        if (vals.length > 0) {
            levels.push(quantile(vals, 0.2));
        }
    });
    return Math.max(0, levels.length > 0 ? median(levels) : fallback);
}
function finishRun(s, r, next, idle, runLimit, keepAbove) {
    const level = Math.max(idle + LEVEL_SEP_W, idle * 1.3);
    const quietTicks = Math.ceil(PLATEAU_QUIET_MS / s.stepMs);
    let plateauTicks = 0;
    let plateauLast = r.coreEnd;
    let quiet = 0;
    let interrupted = r.bursts.length > 0;
    const values = [];
    for (let j = r.coreEnd + 1; !interrupted && j < Math.min(next, s.length) && s.valid[j] === 1; j++) {
        const v = s.last[j];
        if (v > runLimit) {
            interrupted = true;
        }
        else if (v > level) {
            plateauTicks++;
            plateauLast = j;
            values.push(v);
            quiet = 0;
        }
        else if (++quiet >= quietTicks) {
            break;
        }
    }
    const plateau = values.length > 0 ? median(values) : 0;
    if (!interrupted && keepAbove !== undefined && plateau >= keepAbove && plateauTicks * s.stepMs >= PLATEAU_RUN_MS) {
        r.runEnd = plateauLast;
        r.plateauLevel = plateau;
    }
    else {
        r.runEnd = r.coreEnd;
        r.plateauLevel = null;
    }
    const post = valuesOf(s, r.runEnd + 1, Math.min(r.runEnd + Math.ceil(POST_END_MS / s.stepMs), next - 1));
    r.postEnd = Math.max(0, post.length > 0 ? quantile(post, 0.9) : idle);
}
function gapLevel(s, g) {
    return median(valuesOf(s, g.from, g.to));
}
function splitGrown(s, runs, bounds, runLimit) {
    const step = s.stepMs;
    const bp = [];
    const be = [];
    runs.forEach((r, i) => {
        for (const g of r.gaps) {
            if ((g.to - g.from + 1) * step < SHORT_PAUSE_MS) {
                bp.push(gapLevel(s, g));
            }
        }
        if ((bounds[i].next - r.to - 1) * step > MAX_PAUSE_MS) {
            be.push(r.postEnd);
        }
    });
    if (bp.length === 0 || be.length === 0) {
        return null;
    }
    const minBe = Math.min(...be);
    const maxBe = Math.max(...be);
    const pausesBelow = quantile(bp, 0.9) * 1.5 + LEVEL_SEP_W < minBe * 0.8;
    const pausesAbove = quantile(bp, 0.1) > maxBe * 1.5 + LEVEL_SEP_W;
    if (!pausesBelow && !pausesAbove) {
        return null;
    }
    const lo = 0.8 * minBe;
    const hi = 1.25 * maxBe + 0.1;
    const minActive = Math.ceil(MIN_ACTIVE_MS / step);
    const activeIn = (a, b) => {
        let n = 0;
        for (let i = a; i <= b; i++) {
            if (s.last[i] > runLimit) {
                n++;
            }
        }
        return n;
    };
    let changed = false;
    const out = [];
    for (const r of runs) {
        let from = r.from;
        const allGaps = gapsBetween(blocksOf(s, r, runLimit), r.to);
        for (const g of allGaps) {
            if (g.from <= from || (g.to - g.from + 1) * step < SPLIT_GAP_MIN_MS) {
                continue;
            }
            const inBand = pausesBelow
                ? gapLevel(s, g) >= lo && gapLevel(s, g) <= hi
                : quantile(valuesOf(s, g.from, g.to), 0.9) <= hi;
            if (!inBand) {
                continue;
            }
            const before = activeIn(from, g.from - 1);
            const after = activeIn(g.to + 1, r.to);
            if (before >= minActive && after >= minActive) {
                out.push({ from, to: g.from - 1, active: before });
                from = g.to + 1;
                changed = true;
            }
        }
        out.push({ from, to: r.to, active: activeIn(from, r.to) });
    }
    return changed ? out : null;
}
function detailRuns(s, spans, bounds, runLimit, fallbackIdle, keepAbove) {
    const runs = spans.map(seg => coreOf(s, seg, runLimit));
    const idle = idleOf(s, runs, bounds, fallbackIdle);
    runs.forEach((r, i) => finishRun(s, r, bounds[i].next, idle, runLimit, keepAbove));
    return { runs, idle };
}
function boundsOf(spans, all, length) {
    return spans.map(r => ({ next: all.find(x => x.from > r.to)?.from ?? length }));
}
export function buildLayout(s, opts = {}) {
    const step = s.stepMs;
    const validValues = valuesOf(s, 0, s.length - 1);
    let tailIdle = null;
    if (opts.recording) {
        const tail = validValues.slice(-Math.max(3, Math.ceil(validValues.length * 0.1)));
        tailIdle = Math.max(0, Math.min(median(tail), tail.at(-1) ?? 0));
    }
    const runLimit = Math.max(0, tailIdle ?? median(validValues)) * 3 + 2;
    if (!opts.recording) {
        applyGapRule(s, runLimit);
    }
    const maxGap = opts.recording ? s.length : Math.floor(MAX_PAUSE_MS / step);
    const minActive = opts.recording ? 6 : Math.ceil(MIN_ACTIVE_MS / step);
    const all = segments(s, runLimit, maxGap, opts.recording ? 0 : minActive);
    const usable = all.filter(x => !x.touched);
    const gapsDropped = all.length - usable.length;
    let runSpans = usable.filter(x => x.active >= minActive);
    const spikes = usable.filter(x => x.active < minActive).slice(-MAX_WINDOWS);
    const fallbackIdle = Math.max(0, tailIdle ?? median(validValues));
    let bounds = boundsOf(runSpans, all, s.length);
    let { runs, idle } = detailRuns(s, runSpans, bounds, runLimit, fallbackIdle, opts.keepAbove);
    if (!opts.recording) {
        const split = splitGrown(s, runs, bounds, runLimit);
        if (split) {
            runSpans = split;
            const starts = [
                ...all.filter(x => !runSpans.some(r => r.from <= x.from && x.to <= r.to)),
                ...runSpans,
            ].sort((a, b) => a.from - b.from);
            bounds = boundsOf(runSpans, starts, s.length);
            ({ runs, idle } = detailRuns(s, runSpans, bounds, runLimit, fallbackIdle, opts.keepAbove));
        }
    }
    if (opts.recording && tailIdle !== null) {
        const last = runs.at(-1);
        if (!last || (s.length - 1 - last.runEnd) * step < 2 * 60_000) {
            idle = tailIdle;
            for (const r of runs) {
                r.postEnd = tailIdle;
            }
        }
    }
    const neighbours = [
        ...all.filter(x => !runSpans.some(r => r.from <= x.from && x.to <= r.to)),
        ...runSpans.map(r => ({ from: r.from, to: r.to })),
    ].sort((a, b) => a.from - b.from);
    const windows = [];
    const padBefore = Math.ceil(PAD_BEFORE_MS / step);
    const padAfter = Math.ceil(PAD_AFTER_MS / step);
    const make = (span, end, run) => {
        const prev = [...neighbours].reverse().find(x => x.to < span.from);
        const next = neighbours.find(x => x.from > span.to);
        let fromIdx = Math.max(span.from - padBefore, prev ? prev.to + 1 : 0);
        let toIdx = Math.min(end + padAfter, next ? next.from - 1 : s.length - 1);
        for (let i = span.from; i >= fromIdx; i--) {
            if (s.valid[i] === 0) {
                fromIdx = i + 1;
                break;
            }
        }
        for (let i = span.from; i <= toIdx; i++) {
            if (s.valid[i] === 0) {
                toIdx = i - 1;
                break;
            }
        }
        if (toIdx < span.to) {
            return null;
        }
        return { fromIdx, toIdx, runStartIdx: span.from, runEndIdx: run === null ? null : end, run };
    };
    const kept = [];
    for (const r of runs.slice(-MAX_WINDOWS)) {
        const win = make(r, r.runEnd, kept.length);
        if (win) {
            kept.push(r);
            windows.push(win);
        }
    }
    for (const sp of spikes) {
        const win = make(sp, sp.to, null);
        if (win) {
            windows.push(win);
        }
    }
    const lpost = kept.length > 0 ? Math.max(...kept.map(r => r.postEnd)) : idle;
    return { runLimit, idle, lpost, runs: kept, spikes, windows, gapsDropped };
}
//# sourceMappingURL=runs.js.map