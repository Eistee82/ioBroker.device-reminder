import { TRAILER_MAX_DEFAULT_SEC } from "../detector/trailer.js";
import { DETECTION_KEYS, detectionOf, pushChange, refreshInfo } from "../runStore.js";
import { analyzeTicks } from "./analyze.js";
import { margin, minEndSec } from "./optimize.js";
import { runOkFull, simulate } from "./replay.js";
import { MAX_PAUSE_MS } from "./runs.js";
import { decodeCells, fromCells, scaled } from "./ticks.js";
export const TIGHTEN_MIN_RUNS = 4;
export const TIGHTEN_NEW_RUNS = 2;
export const TIGHTEN_SPACING_MS = 24 * 60 * 60_000;
export const LOCK_RUNS = 5;
export const LOCK_MS = 14 * 24 * 60 * 60_000;
export const MAX_DROP = 0.25;
export const MAX_THRESHOLD_CHANGE = 0.3;
export const DRIFT_RUNS = 3;
const MODE_CHANGE_RUNS = 6;
const FILTER_RUNS = 2;
const SEPARATOR_MS = MAX_PAUSE_MS + 10 * 60_000;
const YIELD_MS = 20;
class BudgetExceeded extends Error {
}
export function boundsOf(pollSec) {
    return {
        endDurationSec: 3600,
        endCount: Math.floor(3600 / pollSec),
        pauseHoldSec: 10800,
        startCount: 60,
        startDurationSec: 600,
        trailerMaxSec: 14400,
        trailerBurstSec: 180,
    };
}
export function effectiveOf(type, override) {
    return detectionOf({ ...detectionOf(type), ...(override ?? {}) });
}
export function diffOf(p, type) {
    const a = detectionOf(p);
    const b = detectionOf(type);
    const out = {};
    for (const k of DETECTION_KEYS) {
        if (a[k] !== b[k]) {
            out[k] = a[k];
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}
export function withinBounds(p, pollSec) {
    const d = detectionOf(p);
    const b = boundsOf(pollSec);
    for (const [k, max] of Object.entries(b)) {
        if (typeof d[k] === "number" && d[k] > max) {
            return false;
        }
    }
    if (DETECTION_KEYS.some(k => typeof d[k] === "number" && (!Number.isFinite(d[k]) || d[k] < 0))) {
        return false;
    }
    return d.standby < d.endVal && d.endVal < d.startVal && d.startCount >= 1 && d.endCount >= 1;
}
export function clampBounds(p, pollSec) {
    const d = detectionOf(p);
    for (const [k, max] of Object.entries(boundsOf(pollSec))) {
        if (typeof d[k] === "number") {
            d[k] = Math.min(max, d[k]);
        }
    }
    return d;
}
class Data {
    store;
    ctx;
    cells = new WeakMap();
    series = new WeakMap();
    lastYield;
    start;
    constructor(store, ctx) {
        this.store = store;
        this.ctx = ctx;
        this.start = ctx.clock();
        this.lastYield = this.start;
    }
    cellsOf(r) {
        let c = this.cells.get(r);
        if (!c) {
            c = decodeCells(r.data, r.q);
            this.cells.set(r, c);
        }
        return c;
    }
    seriesOf(r, p) {
        let byP = this.series.get(r);
        if (!byP) {
            byP = new Map();
            this.series.set(r, byP);
        }
        let s = byP.get(p);
        if (s) {
            return s;
        }
        let cells = this.cellsOf(r);
        if (p === "shift1") {
            cells = [cells[0], ...cells];
        }
        else if (p === "stale5") {
            cells = cells.map((c, i) => (i > 0 && i % 20 === 0 ? cells[i - 1] : c));
        }
        s = fromCells(cells, r.ts, r.step);
        if (p === "scale09" || p === "scale11") {
            s = scaled(s, p === "scale09" ? 0.9 : 1.1);
        }
        byP.set(p, s);
        return s;
    }
    async tick() {
        const now = this.ctx.clock();
        if (now - this.start > this.ctx.budgetMs) {
            throw new BudgetExceeded("budget");
        }
        if (now - this.lastYield >= YIELD_MS) {
            this.lastYield = now;
            await this.ctx.yieldFn();
        }
    }
    combined(keep) {
        const items = [...this.store.runs.filter(keep), ...this.store.spikes].sort((a, b) => a.ts - b.ts);
        const all = [];
        const sep = Math.ceil(SEPARATOR_MS / this.store.step);
        for (const r of items) {
            const cells = this.cellsOf(r);
            all.push(...cells);
            const vals = cells.filter(c => c.valid).map(c => c.last);
            vals.sort((a, b) => a - b);
            const idle = vals.length > 0 ? vals[Math.floor(vals.length * 0.2)] : 0;
            for (let k = 0; k < sep; k++) {
                all.push({ min: idle, max: idle, last: idle, valid: true });
            }
        }
        return fromCells(all, 0, this.store.step, this.store.unitFactor);
    }
}
async function gateOn(data, p, perturb, only) {
    const { store, ctx } = data;
    const opts = { abort: ctx.abort, abortFixed: ctx.abortFixed, pollSec: ctx.pollSec };
    const shift = perturb === "shift1" ? 1 : 0;
    const perRun = [];
    let ok = true;
    for (const r of store.runs) {
        if (only && !only(r)) {
            continue;
        }
        const s = data.seriesOf(r, perturb);
        const win = {
            fromIdx: 0,
            toIdx: s.length - 1,
            runStartIdx: r.seg.startIdx + shift,
            runEndIdx: r.seg.runEndIdx + shift,
            run: 0,
        };
        const res = simulate(s, win, p, opts);
        const good = r.postTruncated ? truncatedOk(s, win, res) : runOkFull(s, win, res);
        const delaySec = good && res.finished.length > 0
            ? (res.finished[0] - (s.t0 + win.runEndIdx * s.stepMs)) / 1000
            : Number.NaN;
        perRun.push({ ok: good, delaySec });
        ok &&= good;
        await data.tick();
    }
    let falseStarts = 0;
    for (const r of only ? [] : store.spikes) {
        const s = data.seriesOf(r, perturb);
        const win = {
            fromIdx: 0,
            toIdx: s.length - 1,
            runStartIdx: r.seg.startIdx,
            runEndIdx: null,
            run: null,
        };
        falseStarts += simulate(s, win, p, opts).started;
        await data.tick();
    }
    return { ok: ok && falseStarts === 0, perRun, spikesOk: falseStarts === 0, falseStarts };
}
function truncatedOk(s, win, r) {
    const end = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
    return r.started === 1 && r.aborted === 0 && r.finished.length <= 1 && r.finished.every(t => t >= end);
}
export async function gate(store, p, ctx, perturb = "none") {
    return gateOn(new Data(store, ctx), p, perturb);
}
function fromSuggestion(sg) {
    return detectionOf({
        ...sg.thresholds,
        mode: sg.mode,
        startDurationSec: sg.startDurationSec,
        endDurationSec: sg.endDurationSec,
        pauseHoldSec: sg.pauseHoldSec,
        pauseUntilSec: sg.pauseUntilSec,
        pauseBelowVal: sg.pauseBelowVal,
        trailerBurstSec: sg.trailerBurstSec ?? 0,
        trailerGapSec: sg.trailerGapSec ?? 0,
        trailerAfterSec: sg.trailerAfterSec ?? 0,
        trailerBlockVal: sg.trailerBlockVal ?? 0,
        trailerMaxSec: sg.trailerMaxSec ?? 0,
    });
}
async function analyzeStored(data, p0, keep) {
    const { store, ctx } = data;
    if (!store.runs.some(keep)) {
        return null;
    }
    const res = await analyzeTicks(data.combined(keep), ctx.pollSec, {
        abort: ctx.abort,
        abortFixed: ctx.abortFixed,
        unitFactor: store.unitFactor,
        currentType: p0,
        minRuns: 1,
        yieldFn: () => data.tick(),
    });
    return "error" in res ? null : res;
}
function distance(p, p0) {
    const a = detectionOf(p);
    const b = detectionOf(p0);
    const filterA = a.trailerBurstSec > 0;
    const filterB = b.trailerBurstSec > 0;
    let d = filterA !== filterB ? 1 : 0;
    for (const k of DETECTION_KEYS) {
        if (k.startsWith("trailer") && (!filterA || !filterB)) {
            continue;
        }
        const x = a[k];
        const y = b[k];
        if (typeof x === "number" && typeof y === "number") {
            d += Math.abs(x - y) / Math.max(Math.abs(y), 1);
        }
        else if (x !== y) {
            d += 1;
        }
    }
    return d;
}
const REPAIR_DELAY_WEIGHT_SEC = 600;
export function trailerFromStore(runs, pollSec) {
    const t = runs.filter(r => r.feat.trailer);
    if (t.length === 0) {
        return null;
    }
    const burstMax = Math.max(...t.map(r => r.feat.burstMaxSec));
    const gapMin = Math.min(...t.map(r => r.feat.trailerGapMinSec || 60));
    const longest = Math.max(...t.map(r => r.feat.trailerSec));
    return {
        trailerBurstSec: Math.min(180, Math.max(Math.ceil(Math.max(15, 1.5 * pollSec + 10)), Math.ceil(burstMax * 1.5))),
        trailerGapSec: Math.max(1, Math.min(Math.floor(0.8 * gapMin), Math.max(3 * pollSec, 30))),
        trailerAfterSec: 0,
        trailerBlockVal: 0,
        trailerMaxSec: Math.min(14400, Math.max(TRAILER_MAX_DEFAULT_SEC, Math.ceil(longest * 1.25 + 900))),
    };
}
function saferOf(c, p0) {
    const a = detectionOf(c);
    const b = detectionOf(p0);
    return {
        ...a,
        startVal: Math.max(a.startVal, b.startVal),
        startCount: Math.max(a.startCount, b.startCount),
        endCount: Math.max(a.endCount, b.endCount),
        startDurationSec: Math.max(a.startDurationSec, b.startDurationSec),
        endDurationSec: Math.max(a.endDurationSec, b.endDurationSec),
        pauseHoldSec: Math.max(a.pauseHoldSec ?? 0, b.pauseHoldSec ?? 0),
        trailerGapSec: Math.max(a.trailerGapSec ?? 0, b.trailerGapSec ?? 0),
    };
}
async function repairCandidates(data, p0) {
    const { store, ctx } = data;
    const poll = ctx.pollSec;
    const out = [];
    const sg = await analyzeStored(data, p0, () => true);
    if (sg) {
        const c = fromSuggestion(sg);
        out.push(c, saferOf(c, p0));
    }
    const base = detectionOf(p0);
    const env = store.envelope;
    const burst = env.maxBurstSec + margin(env.maxBurstSec, poll);
    const startK = Math.ceil(burst / poll);
    const startRaised = {
        ...base,
        startCount: Math.max(base.startCount, startK),
        startDurationSec: Math.max(base.startDurationSec, Math.ceil(burst)),
    };
    const trailer = trailerFromStore(store.runs, poll);
    const variants = [base, startRaised];
    if (trailer && !(base.trailerBurstSec ?? 0)) {
        variants.push({ ...base, ...trailer }, { ...startRaised, ...trailer });
    }
    if ((base.trailerBurstSec ?? 0) > 0) {
        if (trailer) {
            variants.push({
                ...base,
                trailerBurstSec: Math.max(base.trailerBurstSec ?? 0, trailer.trailerBurstSec ?? 0),
                trailerGapSec: Math.min(base.trailerGapSec || 30, trailer.trailerGapSec || 30),
                trailerMaxSec: Math.max(base.trailerMaxSec ?? 0, trailer.trailerMaxSec ?? 0),
            });
        }
        variants.push({ ...base, trailerAfterSec: 0, trailerBlockVal: 0, trailerBurstSec: 0 });
    }
    const minRunUnit = env.minRunW / store.unitFactor;
    if (minRunUnit > 0) {
        const sv = Math.max(base.endVal * 1.2, 0.25 * minRunUnit);
        if (sv < base.startVal) {
            variants.push({ ...base, startVal: Math.round(sv * 100) / 100 });
        }
    }
    for (const v of variants) {
        for (const f of [1, 1.5, 2, 3, 4, 6]) {
            out.push({
                ...v,
                endCount: Math.ceil(v.endCount * f),
                endDurationSec: Math.ceil(v.endDurationSec * f),
            });
        }
    }
    return out
        .map(c => clampBounds(c, poll))
        .filter(c => withinBounds(c, poll))
        .filter(c => (c.trailerBurstSec ?? 0) === 0 || (c.trailerBurstSec ?? 0) >= 15);
}
export function stepLimit(c, p0, trusted, withTrailer, pollSec) {
    const a = detectionOf(c);
    const b = detectionOf(p0);
    const out = { ...a };
    const thresholds = new Set(["startVal", "endVal", "standby"]);
    const durations = new Set(["startDurationSec", "endDurationSec", "pauseHoldSec", "trailerMaxSec"]);
    for (const k of DETECTION_KEYS) {
        const x = a[k];
        const y = b[k];
        if (typeof x !== "number" || typeof y !== "number") {
            continue;
        }
        if (thresholds.has(k)) {
            out[k] = Math.min(y * (1 + MAX_THRESHOLD_CHANGE), Math.max(y * (1 - MAX_THRESHOLD_CHANGE), x));
            out[k] = Math.round(out[k] * 1e5) / 1e5;
            continue;
        }
        if (y > 0 && x < y * (1 - MAX_DROP)) {
            out[k] = y * (1 - MAX_DROP);
        }
        if (k === "startCount" || k === "endCount") {
            out[k] = Math.ceil(out[k]);
        }
        else if (durations.has(k)) {
            out[k] = Math.ceil(out[k] / pollSec) * pollSec;
        }
    }
    if (a.mode !== b.mode && trusted < MODE_CHANGE_RUNS) {
        out.mode = b.mode;
    }
    const filterOn = b.trailerBurstSec <= 0 && a.trailerBurstSec > 0;
    if (filterOn && withTrailer < FILTER_RUNS) {
        for (const k of ["trailerBurstSec", "trailerGapSec", "trailerAfterSec", "trailerBlockVal", "trailerMaxSec"]) {
            out[k] = b[k];
        }
    }
    return out;
}
export function applyFloors(c, store, pollSec) {
    const d = detectionOf(c);
    const env = store.envelope;
    const pauseFloor = Math.max(minEndSec(pollSec), env.maxPauseSec * 1.25 + 2 * pollSec);
    const guardHolds = (d.pauseHoldSec ?? 0) >= env.maxPauseSec * 1.25 && ((d.pauseUntilSec ?? 0) > 0 || (d.pauseBelowVal ?? 0) > 0);
    if (!guardHolds && env.maxPauseSec > 0) {
        if (d.mode === "timed") {
            d.endDurationSec = Math.max(d.endDurationSec, Math.ceil(pauseFloor));
        }
        else {
            d.endCount = Math.max(d.endCount, Math.ceil(pauseFloor / pollSec));
            if (d.mode === "combined") {
                d.endDurationSec = Math.max(d.endDurationSec, Math.ceil(pauseFloor));
            }
        }
    }
    if ((d.trailerBurstSec ?? 0) <= 0 && env.maxBurstSec > 0) {
        const startFloor = env.maxBurstSec + margin(env.maxBurstSec, pollSec);
        if (d.mode !== "timed") {
            d.startCount = Math.max(d.startCount, Math.ceil(startFloor / pollSec));
        }
        if (d.mode !== "count") {
            d.startDurationSec = Math.max(d.startDurationSec, Math.ceil(startFloor));
        }
    }
    return d;
}
function mean(values) {
    const v = values.filter(x => Number.isFinite(x));
    return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
export function describeChange(from, to) {
    const a = detectionOf(from);
    const b = detectionOf(to);
    const parts = [];
    for (const k of DETECTION_KEYS) {
        if (a[k] !== b[k]) {
            if (k === "trailerBurstSec" && (a[k] === 0 || b[k] === 0)) {
                parts.push(b[k] === 0 ? "anti-crease filter off" : "anti-crease filter on");
            }
            else if (!k.startsWith("trailer") ||
                (a.trailerBurstSec > 0 && b.trailerBurstSec > 0)) {
                parts.push(`${k} ${a[k]} → ${b[k]}`);
            }
        }
    }
    return parts.join(", ");
}
function nextPossible(store) {
    return Math.max(store.lockUntilTs, store.lastChangeTs > 0 ? store.lastChangeTs + TIGHTEN_SPACING_MS : 0);
}
export async function optimize(store, ctx) {
    const info = store.info;
    info.lastCheckTs = ctx.now;
    refreshInfo(store);
    const done = (kind, change = null) => {
        info.nextPossibleTs = nextPossible(store);
        const eff = effectiveOf(ctx.type, store.override);
        if ((eff.trailerBurstSec ?? 0) > 0) {
            info.trailer = "used";
        }
        else if (info.trailer === "used") {
            info.trailer = "none";
        }
        return { kind, override: store.override, change, info };
    };
    if (info.status === "drift") {
        return done("drift");
    }
    if (store.runs.length === 0 && store.spikes.length === 0) {
        info.status = "collecting";
        return done("none");
    }
    const data = new Data(store, ctx);
    const p0 = effectiveOf(ctx.type, store.override);
    try {
        const r0 = await gateOn(data, p0, "none");
        if (!r0.ok) {
            return await repair(data, p0, r0, done);
        }
        store.failStreak = 0;
        const outcome = await tighten(data, p0, r0, done);
        return outcome;
    }
    catch (err) {
        if (err instanceof BudgetExceeded) {
            info.status = "budget";
            return done("budget");
        }
        throw err;
    }
}
async function repair(data, p0, r0, done) {
    const { store, ctx } = data;
    let best = null;
    const seen = new Set();
    for (const c of await repairCandidates(data, p0)) {
        const key = JSON.stringify(detectionOf(c));
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const d = distance(c, p0);
        if (best && d >= best.d) {
            continue;
        }
        const g = await gateOn(data, c, "none");
        const score = d + mean(g.perRun.map(r => r.delaySec)) / REPAIR_DELAY_WEIGHT_SEC;
        if (g.ok && (!best || score < best.d)) {
            best = { p: c, d: score, g };
        }
    }
    if (!best) {
        store.failStreak++;
        store.info.status = store.failStreak >= DRIFT_RUNS ? "drift" : "cannotCover";
        return done(store.failStreak >= DRIFT_RUNS ? "drift" : "cannotCover");
    }
    const before = store.override;
    store.override = diffOf(best.p, ctx.type);
    const change = {
        ts: ctx.now,
        kind: "repair",
        from: before,
        to: store.override,
        reason: describeChange(p0, best.p),
        runs: store.runs.length + store.spikes.length,
        gainSec: Math.round(mean(r0.perRun.map(r => r.delaySec)) - mean(best.g.perRun.map(r => r.delaySec))),
    };
    pushChange(store, change);
    store.lockRuns = LOCK_RUNS;
    store.lockUntilTs = ctx.now + LOCK_MS;
    store.lastChangeTs = ctx.now;
    store.newSinceChange = 0;
    store.failStreak = 0;
    store.info.status = "locked";
    return done("repair", change);
}
function filterVariants(runs, store, pollSec) {
    const t = trailerFromStore(runs, pollSec);
    if (!t) {
        return [];
    }
    const withTrailer = runs.filter(r => r.feat.trailer);
    const block = Math.round(((0.8 * Math.min(...withTrailer.map(r => r.feat.blockMean))) / store.unitFactor) * 1e5) / 1e5;
    const after = Math.floor(0.9 * Math.min(...runs.map(r => r.feat.coreSec)));
    const out = [t];
    if (block > 0) {
        out.push({ ...t, trailerBlockVal: block });
    }
    if (after > 0) {
        out.push({ ...t, trailerAfterSec: Math.min(21600, after) });
    }
    if (block > 0 && after > 0) {
        out.push({ ...t, trailerBlockVal: block, trailerAfterSec: Math.min(21600, after) });
    }
    return out;
}
function filterOptions(runs, store, p0, withTrailer, pollSec) {
    const d = detectionOf(p0);
    if ((d.trailerBurstSec ?? 0) > 0) {
        return [
            {
                trailerBurstSec: d.trailerBurstSec,
                trailerGapSec: d.trailerGapSec,
                trailerAfterSec: d.trailerAfterSec,
                trailerBlockVal: d.trailerBlockVal,
                trailerMaxSec: d.trailerMaxSec,
            },
        ];
    }
    return withTrailer >= FILTER_RUNS ? filterVariants(runs, store, pollSec) : [];
}
async function tighten(data, p0, r0, done) {
    const { store, ctx } = data;
    const poll = ctx.pollSec;
    const isTrusted = (r) => r.label === "run" && !r.postTruncated;
    const trusted = store.runs.filter(isTrusted);
    const locked = store.lockRuns > 0 || ctx.now < store.lockUntilTs;
    if (locked) {
        store.info.status = "locked";
        return done("none");
    }
    store.info.status = trusted.length >= TIGHTEN_MIN_RUNS ? "ok" : "collecting";
    if (trusted.length < TIGHTEN_MIN_RUNS ||
        store.newSinceChange < TIGHTEN_NEW_RUNS ||
        (store.lastChangeTs > 0 && ctx.now - store.lastChangeTs < TIGHTEN_SPACING_MS)) {
        return done("none");
    }
    const sg = await analyzeStored(data, p0, isTrusted);
    if (!sg) {
        return done("none");
    }
    store.info.trailer = sg.trailer === "notSeparable" ? "notSeparable" : store.info.trailer;
    const withTrailer = trusted.filter(r => r.feat.trailer).length;
    const shape = (c) => clampBounds(applyFloors(stepLimit(c, p0, trusted.length, withTrailer, poll), store, poll), poll);
    const build = (recipe, analysis, variants) => {
        const base = recipe.base === "current" ? detectionOf(p0) : analysis;
        return shape(recipe.filter >= 0 && variants[recipe.filter] ? { ...base, ...variants[recipe.filter] } : base);
    };
    const analysis = fromSuggestion(sg);
    const variants = filterOptions(trusted, store, p0, withTrailer, poll);
    const recipes = [{ base: "analysis", filter: -1 }];
    variants.forEach((_, i) => {
        recipes.push({ base: "analysis", filter: i }, { base: "current", filter: i });
    });
    const passing = [];
    const seen = new Set();
    for (const recipe of recipes) {
        const c = build(recipe, analysis, variants);
        const key = JSON.stringify(c);
        if (seen.has(key) || !withinBounds(c, poll)) {
            continue;
        }
        seen.add(key);
        const g = await gateOn(data, c, "none");
        if (!g.ok || g.falseStarts > r0.falseStarts) {
            continue;
        }
        if (g.perRun.some((r, i) => r.delaySec > r0.perRun[i].delaySec + poll)) {
            continue;
        }
        passing.push({ recipe, c, g, delay: mean(g.perRun.map(r => r.delaySec)) });
    }
    passing.sort((a, b) => a.delay - b.delay);
    const families = [...new Set(trusted.map(r => r.family))];
    const d0 = mean(r0.perRun.map(r => r.delaySec));
    for (const cand of passing) {
        const gain = d0 - cand.delay;
        const fewerFalse = cand.g.falseStarts < r0.falseStarts;
        if (!fewerFalse && gain < Math.max(60, 0.1 * d0)) {
            break;
        }
        if (!(await crossCheck(data, p0, cand.recipe, families, sg, isTrusted, build))) {
            continue;
        }
        let robust = true;
        for (const p of ["scale09", "scale11", "shift1", "stale5"]) {
            if (!(await gateOn(data, cand.c, p)).ok) {
                robust = false;
                break;
            }
        }
        if (!robust) {
            continue;
        }
        const next = diffOf(cand.c, ctx.type);
        if (JSON.stringify(next) === JSON.stringify(store.override)) {
            return done("none");
        }
        const before = store.override;
        store.override = next;
        const change = {
            ts: ctx.now,
            kind: "tighten",
            from: before,
            to: next,
            reason: describeChange(p0, cand.c),
            runs: store.runs.length + store.spikes.length,
            gainSec: Math.round(gain),
        };
        pushChange(store, change);
        store.lastChangeTs = ctx.now;
        store.newSinceChange = 0;
        store.info.status = "ok";
        return done("tighten", change);
    }
    return done("none");
}
async function crossCheck(data, p0, recipe, families, sg, isTrusted, build) {
    const { store, ctx } = data;
    if (families.length < 3) {
        return recipe.base === "current" || sg.looDetected === undefined || sg.looDetected >= sg.runs;
    }
    for (const fam of families) {
        const keep = (r) => isTrusted(r) && r.family !== fam;
        const rest = store.runs.filter(keep);
        const sgF = recipe.base === "analysis" ? await analyzeStored(data, p0, keep) : null;
        if (recipe.base === "analysis" && !sgF) {
            continue;
        }
        const variants = recipe.filter >= 0
            ? filterOptions(rest, store, p0, rest.filter(r => r.feat.trailer).length, ctx.pollSec)
            : [];
        const cF = build(recipe, sgF ? fromSuggestion(sgF) : detectionOf(p0), variants);
        const gF = await gateOn(data, cF, "none", r => isTrusted(r) && r.family === fam);
        if (!gF.ok) {
            return false;
        }
    }
    return true;
}
//# sourceMappingURL=autoOptimize.js.map