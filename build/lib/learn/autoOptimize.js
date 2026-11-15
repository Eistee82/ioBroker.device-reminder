import { finalViolations } from "../config.js";
import { finalOn } from "../detector/index.js";
import { TRAILER_MAX_DEFAULT_SEC } from "../detector/trailer.js";
import { FINAL_KEYS } from "../detector/types.js";
import { applyPhaseTune, phaseTuneBase, tunePhases } from "../phases/learn.js";
import { phaseHolds } from "../phases/tracker.js";
import { BASE_KEYS, boundaryRuns, decisionOf, DETECTION_KEYS, detectionOf, inUse, markFinalResumed, markFinalSuspended, pushChange, refreshInfo, REPLAY_PICK_MAX, storeSamples, typeHash, WINDOW_MS, } from "../runStore.js";
import { analyzeTicks } from "./analyze.js";
import { learnFinal } from "./finalLearn.js";
import { margin, minEndSec } from "./optimize.js";
import { admitted, primaryOf, sameRun } from "./quality.js";
import { endOkFull, simulate } from "./replay.js";
import { DENSE_MIN_MS, MAX_PAUSE_MS } from "./runs.js";
import { decodeCells, fromCells, scaled } from "./ticks.js";
export const TIGHTEN_MIN_RUNS = 8;
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
const YIELD_TICKS = 256;
export const JOB_STEPS = ["final", "tighten", "phases"];
export const CROSS_CHECK_SPACING_MS = 24 * 60 * 60_000;
const HINTED_MAX = 50;
const DATA_ERRORS = new Set(["gap", "stuck", "sparse", "incomplete", "unit", "counter"]);
export const FINAL_ENABLE_MIN_RUNS = 10;
export const FINAL_ENABLE_MIN_PER_GROUP = 2;
const FINAL_P_STEP = 0.1;
const FINAL_Y_DROP = 0.1;
const FINAL_Y_DROP_RUNS = 5;
const FINAL_X_DROP = 0.25;
const FINAL_REPAIR_Y = [1, 1.25, 1.5, 2, 3, 4];
const FINAL_REPAIR_X = [1, 1.25, 1.5, 2];
const FINAL_REPAIR_P = [1, 1.1, 1.25, 1.5];
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
    if (BASE_KEYS.some(k => typeof d[k] === "number" && (!Number.isFinite(d[k]) || d[k] < 0))) {
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
function verdictOf(store, r, verdicts) {
    const v = verdicts?.get(r.key);
    if (!v) {
        return undefined;
    }
    const user = decisionOf(store, r.key)?.user;
    const out = { ...v };
    if (user) {
        out.user = user;
    }
    else {
        delete out.user;
    }
    return out;
}
function roleOf(store, r, verdicts) {
    if (decisionOf(store, r.key)?.user === "exclude") {
        return "none";
    }
    const v = verdictOf(store, r, verdicts);
    if (!v) {
        return "gate";
    }
    if (admitted(v, r.label === "spike" ? "start" : "end")) {
        return "gate";
    }
    return v.stage === "quarantine" ? "quarantine" : "none";
}
export function targetSet(store, now, verdicts) {
    return store.runs.filter(r => roleOf(store, r, verdicts) === "gate" && now - r.ts <= WINDOW_MS);
}
export function checkSet(store, now, verdicts) {
    const boundary = boundaryRuns(store, verdicts);
    return store.runs.filter(r => roleOf(store, r, verdicts) === "gate" && (now - r.ts <= WINDOW_MS || boundary.has(r.key)));
}
export function replayPick(store, now, verdicts) {
    const boundary = boundaryRuns(store, verdicts);
    const set = checkSet(store, now, verdicts).filter(r => typeof r.data === "string");
    const picked = new Set(set.filter(r => boundary.has(r.key)));
    const groups = new Map();
    for (const r of [...set].sort((a, b) => b.ts - a.ts)) {
        if (!picked.has(r)) {
            groups.set(r.family, [...(groups.get(r.family) ?? []), r]);
        }
    }
    let added = true;
    while (added && picked.size < REPLAY_PICK_MAX) {
        added = false;
        for (const list of groups.values()) {
            const r = list.shift();
            if (r && picked.size < REPLAY_PICK_MAX) {
                picked.add(r);
                added = true;
            }
        }
    }
    const spikes = store.spikes.filter(r => typeof r.data === "string" &&
        roleOf(store, r, verdicts) === "gate" &&
        (now - r.ts <= WINDOW_MS || boundary.has(r.key)));
    return [...set.filter(r => picked.has(r)), ...spikes];
}
export function noRegression(c, p0) {
    return [...p0].every(([key, ok]) => !ok || c.get(key) === true);
}
class Data {
    store;
    ctx;
    cells = new WeakMap();
    series = new WeakMap();
    activeBefore = 0;
    resumedAt;
    ticks = 0;
    budgeted = false;
    finished = 0;
    memo = [];
    pos = 0;
    reused = false;
    runs;
    spikes;
    quarantined;
    target;
    merged;
    suspended;
    joined;
    joinedSeries = new Map();
    constructor(store, ctx) {
        this.store = store;
        this.ctx = ctx;
        this.resumedAt = ctx.clock();
        const pick = replayPick(store, ctx.now, ctx.verdicts).filter(r => inUse(store, r));
        this.runs = pick.filter(r => r.label !== "spike");
        this.spikes = pick.filter(r => r.label === "spike");
        this.quarantined = [...store.runs, ...store.spikes].filter(r => inUse(store, r) && roleOf(store, r, ctx.verdicts) === "quarantine");
        this.target = targetSet(store, ctx.now, ctx.verdicts);
        this.merged = new Set(store.runs
            .filter(r => ctx.verdicts?.get(r.key)?.reasons.some(x => x.code === "merged") === true)
            .map(r => r.key));
        this.suspended = ctx.finalSuspended === true;
        this.joined = this.joinedRuns();
    }
    replayValues(p, raw = false) {
        return this.suspended && !raw ? { ...p, finalMinVal: 0 } : p;
    }
    joinedRuns() {
        const { store, ctx } = this;
        const out = [];
        const usable = (r) => typeof r.data === "string" && inUse(store, r) && roleOf(store, r, ctx.verdicts) !== "none";
        for (const key of store.final?.joined ?? []) {
            const b = store.runs.find(r => r.key === key || sameRun(r.key, key));
            if (!b || !usable(b) || out.some(x => x.b === b)) {
                continue;
            }
            const a = store.runs
                .filter(r => r !== b &&
                r.step === b.step &&
                r.ts < b.ts &&
                usable(r) &&
                r.ts + this.cellsOf(r).length * r.step >= b.ts - r.step)
                .sort((x, y) => y.ts - x.ts)[0];
            if (a) {
                out.push({ key: b.key, a, b });
            }
        }
        return out;
    }
    joinedOf(pair) {
        let out = this.joinedSeries.get(pair.key);
        if (out) {
            return out;
        }
        const a = this.cellsOf(pair.a);
        const b = this.cellsOf(pair.b);
        const gap = Math.round((pair.b.ts - (pair.a.ts + a.length * pair.a.step)) / pair.a.step);
        const fill = gap > 0 ? new Array(gap).fill(a[a.length - 1]) : [];
        const cells = [...a, ...fill, ...(gap < 0 ? b.slice(-gap) : b)];
        const off = a.length + gap;
        const s = fromCells(cells, pair.a.ts, pair.a.step);
        const end = Math.min(cells.length - 1, off + pair.b.seg.runEndIdx);
        out = {
            s,
            win: { fromIdx: 0, toIdx: cells.length - 1, runStartIdx: pair.a.seg.startIdx, runEndIdx: end, run: 0 },
        };
        this.joinedSeries.set(pair.key, out);
        return out;
    }
    verdictOf(r) {
        return verdictOf(this.store, r, this.ctx.verdicts);
    }
    continued(r) {
        const end = r.ts + this.cellsOf(r).length * r.step;
        return this.store.runs.some(n => n !== r && n.ts > r.ts && n.ts <= end + r.step);
    }
    cellsOf(r) {
        let c = this.cells.get(r);
        if (!c) {
            c = typeof r.data === "string" ? decodeCells(r.data, r.q) : [];
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
    get activeMs() {
        return this.activeBefore + Math.max(0, this.ctx.clock() - this.resumedAt);
    }
    overBudget(run) {
        return this.budgeted && this.finished > 0 && this.activeBefore + run > this.ctx.budgetMs;
    }
    async tick() {
        const run = Math.max(0, this.ctx.clock() - this.resumedAt);
        if (this.overBudget(run)) {
            throw new BudgetExceeded("budget");
        }
        this.ticks++;
        if (run >= YIELD_MS || this.ticks % YIELD_TICKS === 0) {
            this.activeBefore += run;
            await this.ctx.yieldFn();
            this.resumedAt = this.ctx.clock();
        }
    }
    beginStep(memo) {
        this.memo = memo;
        this.pos = 0;
        this.reused = false;
    }
    async unit(key, fn) {
        const m = this.memo[this.pos];
        if (m && m.k === key) {
            this.pos++;
            this.reused = true;
            return m.v;
        }
        this.memo = this.memo.slice(0, this.pos);
        if (this.overBudget(Math.max(0, this.ctx.clock() - this.resumedAt))) {
            throw new BudgetExceeded("budget");
        }
        const v = JSON.parse(JSON.stringify((await fn()) ?? null));
        this.memo = [...this.memo, { k: key, v }];
        this.pos++;
        this.finished++;
        return v;
    }
    combined(keep) {
        const items = [...this.runs.filter(keep), ...this.spikes].sort((a, b) => a.ts - b.ts);
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
function windowOf(s, r, shift) {
    return {
        fromIdx: 0,
        toIdx: s.length - 1,
        runStartIdx: r.seg.startIdx + shift,
        runEndIdx: r.label === "spike" ? null : r.seg.runEndIdx + shift,
        run: r.label === "spike" ? null : 0,
    };
}
function runGood(data, r, s, win, res, shift) {
    const progEnd = data.store.tail?.separated === true && typeof r.seg.progEndIdx === "number" ? r.seg.progEndIdx + shift : null;
    if (r.postTruncated) {
        return truncatedOk(s, win, res);
    }
    if (data.merged.has(r.key) ? mergedOk(s, win, res, progEnd) : endOkFull(s, win, res, progEnd)) {
        return true;
    }
    const runEnd = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
    return (data.continued(r) &&
        res.started === 1 &&
        res.aborted === 0 &&
        res.finished.every(f => f >= runEnd) &&
        res.startedAt.every(t => res.finished.every(f => t <= f)));
}
async function gateOn(data, p, perturb, only, raw = false) {
    const { ctx } = data;
    const opts = { abort: ctx.abort, abortFixed: ctx.abortFixed, pollSec: ctx.pollSec };
    const shift = perturb === "shift1" ? 1 : 0;
    const values = data.replayValues(p, raw);
    const perRun = [];
    let ok = true;
    for (const r of data.runs) {
        if (only && !only(r)) {
            continue;
        }
        const s = data.seriesOf(r, perturb);
        const win = windowOf(s, r, shift);
        const res = simulate(s, win, values, opts);
        const good = runGood(data, r, s, win, res, shift);
        const fin = data.merged.has(r.key) ? res.finished.at(-1) : res.finished[0];
        const delaySec = good && fin !== undefined ? (fin - (s.t0 + win.runEndIdx * s.stepMs)) / 1000 : Number.NaN;
        perRun.push({ id: r.id, key: r.key, ok: good, delaySec });
        ok &&= good;
        await data.tick();
    }
    let falseStarts = 0;
    const spikeKeys = [];
    for (const r of only ? [] : data.spikes) {
        const s = data.seriesOf(r, perturb);
        const started = simulate(s, windowOf(s, r, 0), values, opts).started;
        falseStarts += started;
        if (started > 0) {
            spikeKeys.push(r.key);
        }
        await data.tick();
    }
    const joined = [];
    if (perturb === "none" && !only && finalOn(values)) {
        for (const pair of data.joined) {
            const { s, win } = data.joinedOf(pair);
            const good = joinedOk(simulate(s, win, values, opts), simulate(s, win, { ...values, finalMinVal: 0 }, opts), s.stepMs);
            joined.push({ key: pair.key, ok: good });
            ok &&= good;
            await data.tick();
        }
    }
    return { ok: ok && falseStarts === 0, perRun, spikesOk: falseStarts === 0, falseStarts, spikeKeys, joined };
}
function joinedOk(r, off, stepMs) {
    const first = off.finished[0];
    return (r.started <= off.started &&
        r.aborted <= off.aborted &&
        (first === undefined || (r.finished[0] ?? Number.POSITIVE_INFINITY) >= first - stepMs));
}
async function quarantineOn(data, p, raw = false) {
    const { ctx } = data;
    const opts = { abort: ctx.abort, abortFixed: ctx.abortFixed, pollSec: ctx.pollSec };
    const values = data.replayValues(p, raw);
    const out = new Map();
    for (const r of data.quarantined) {
        const s = data.seriesOf(r, "none");
        const win = windowOf(s, r, 0);
        const res = simulate(s, win, values, opts);
        out.set(r.key, r.label === "spike" ? res.started === 0 : runGood(data, r, s, win, res, 0));
        await data.tick();
    }
    return out;
}
function failingOf(g) {
    return [
        ...g.perRun.filter(r => !r.ok).map(r => r.key),
        ...g.spikeKeys,
        ...g.joined.filter(r => !r.ok).map(r => r.key),
    ];
}
function mergedOk(s, win, r, progEnd) {
    const last = r.finished.at(-1);
    if (r.started === 0 || r.aborted !== 0 || last === undefined) {
        return false;
    }
    const runEnd = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
    const endGood = last >= runEnd || (progEnd !== null && last > s.t0 + progEnd * s.stepMs && runEnd - last <= DENSE_MIN_MS);
    return endGood && r.startedAt.every(t => t <= last);
}
export async function needsRepair(store, ctx) {
    const data = new Data(store, ctx);
    return failingOf(await gateOn(data, effectiveOf(ctx.type, store.override), "none"));
}
function truncatedOk(s, win, r) {
    const end = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
    return r.started === 1 && r.aborted === 0 && r.finished.length <= 1 && r.finished.every(t => t >= end);
}
export async function gate(store, p, ctx, perturb = "none") {
    return gateOn(new Data(store, ctx), p, perturb);
}
function fromSuggestion(sg, p0) {
    return detectionOf({
        ...finalOf(p0),
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
function finalOf(p) {
    return Object.fromEntries(FINAL_KEYS.map(k => [k, p[k] ?? 0]));
}
async function analyzeStored(data, p0, keep) {
    const { store, ctx } = data;
    if (!data.runs.some(keep)) {
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
    for (const k of BASE_KEYS) {
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
        ...finalOf(b),
    };
}
async function repairCandidates(data, p0) {
    const { store, ctx } = data;
    const poll = ctx.pollSec;
    const out = [];
    const sg = await analyzeStored(data, p0, () => true);
    if (sg) {
        out.push(saferOf(fromSuggestion(sg, p0), p0));
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
    const trailer = trailerFromStore(data.runs, poll);
    const variants = [base, startRaised];
    if (trailer && !(base.trailerBurstSec ?? 0)) {
        variants.push({ ...base, ...trailer }, { ...startRaised, ...trailer });
    }
    if (trailer) {
        for (const v of filterVariants(data.runs, store, poll).slice(1)) {
            variants.push({ ...base, ...v }, { ...startRaised, ...v });
        }
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
    for (const k of BASE_KEYS) {
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
function hintsOf(data, q0) {
    const known = data.store.hinted ?? [];
    const out = [];
    for (const r of data.quarantined) {
        if (q0.get(r.key) !== false || known.some(k => k === r.key || sameRun(k, r.key))) {
            continue;
        }
        const code = primaryOf(data.verdictOf(r)?.reasons ?? []);
        out.push({
            key: r.key,
            kind: code !== null && DATA_ERRORS.has(code) ? "broken" : "use",
            ts: r.ts + r.seg.startIdx * r.step,
        });
    }
    return out;
}
function updateReview(data, hints) {
    const { store } = data;
    const open = new Set(data.quarantined.map(r => r.key));
    const review = [
        ...(store.info.review ?? []).filter(k => open.has(k)),
        ...hints.filter(h => h.kind === "use").map(h => h.key),
    ];
    if (review.length > 0) {
        store.info.review = [...new Set(review)];
    }
    else {
        delete store.info.review;
    }
    if (hints.length > 0) {
        store.hinted = [...(store.hinted ?? []), ...hints.map(h => h.key)].slice(-HINTED_MAX);
    }
}
export async function optimize(store, ctx) {
    const info = store.info;
    info.lastCheckTs = ctx.now;
    refreshInfo(store);
    const data = new Data(store, ctx);
    let hints = [];
    const events = [];
    const phaseEvents = [];
    const vetoes = [];
    const build = (kind, change = null, extra = {}) => ({
        kind,
        override: store.override,
        change,
        info,
        failing: [],
        vetoes: [],
        vetoClear: [],
        hints,
        final: events,
        phases: phaseEvents,
        interrupted: false,
        activeMs: 0,
        ...extra,
    });
    const finish = (o) => {
        info.nextPossibleTs = nextPossible(store);
        const eff = effectiveOf(ctx.type, store.override);
        if ((eff.trailerBurstSec ?? 0) > 0) {
            info.trailer = "used";
        }
        else if (info.trailer === "used") {
            info.trailer = "none";
        }
        updateReview(data, hints);
        if ((info.review?.length ?? 0) > 0 && (info.status === "ok" || info.status === "collecting")) {
            info.status = "review";
        }
        const activeMs = Math.round(data.activeMs);
        info.jobMs = activeMs;
        return {
            ...o,
            override: store.override,
            hints,
            final: events,
            phases: phaseEvents,
            vetoes: [...new Set([...vetoes, ...o.vetoes])],
            activeMs,
        };
    };
    if (data.runs.length === 0 && data.spikes.length === 0 && data.quarantined.length === 0) {
        if (info.status === "drift") {
            return finish(build("drift"));
        }
        info.status = "collecting";
        return finish(build("none"));
    }
    const p0 = effectiveOf(ctx.type, store.override);
    let r0 = await gateOn(data, p0, "none");
    let q0 = await quarantineOn(data, p0);
    let failing = failingOf(r0);
    if (failing.length > 0 && finalOn(p0) && !data.suspended) {
        const off = await gateOn(data, { ...p0, finalMinVal: 0 }, "none");
        const okOff = new Set(off.perRun.filter(r => r.ok).map(r => r.key));
        const byFinal = failing.filter(k => okOff.has(k) ||
            r0.joined.some(j => j.key === k) ||
            (r0.spikeKeys.includes(k) && !off.spikeKeys.includes(k)));
        if (byFinal.length > 0) {
            const key = newestOf(data, byFinal);
            markFinalSuspended(store, "earlyEnd", key, ctx.now, true);
            data.suspended = true;
            events.push({ kind: "suspended", reason: "earlyEnd", key });
            vetoes.push(...byFinal);
            r0 = off;
            q0 = await quarantineOn(data, p0);
            failing = failingOf(off);
        }
    }
    hints = hintsOf(data, q0);
    let out = null;
    if (failing.length > 0) {
        out = await repair(data, p0, r0, q0, failing, build);
    }
    else {
        store.failStreak = 0;
    }
    if (data.suspended) {
        await recoverFinal(data, q0, events, vetoes);
    }
    if (!out) {
        if (info.status === "drift") {
            info.budget = 0;
            out = build("drift");
        }
        else {
            out = await expensiveSteps(data, { p0, r0, q0 }, events, phaseEvents, build);
        }
    }
    return finish(out);
}
function hashText(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}
function basisOf(data, p) {
    const { store, ctx } = data;
    return `${typeHash(p)}|${data.suspended ? 1 : 0}|${ctx.pollSec}|${store.unitFactor}|${store.step}`;
}
function sigOf(data, p, extra = "") {
    const keys = (runs) => runs.map(r => r.key);
    return hashText(JSON.stringify([
        basisOf(data, p),
        keys(data.target),
        keys(data.runs),
        keys(data.spikes),
        keys(data.quarantined),
        data.joined.map(j => j.key),
        extra,
    ]));
}
function checkedBefore(data, step, sig, daily) {
    const c = data.store.checks?.[step];
    return c !== undefined && (c.sig === sig || (daily && data.ctx.now - c.ts < CROSS_CHECK_SPACING_MS));
}
function markChecked(data, step, sig) {
    data.store.checks = { ...data.store.checks, [step]: { ts: data.ctx.now, sig } };
}
function plainStatus(data) {
    const { store, ctx } = data;
    if (store.lockRuns > 0 || ctx.now < store.lockUntilTs) {
        return "locked";
    }
    return data.target.filter(trustedOf(data)).length >= TIGHTEN_MIN_RUNS ? "ok" : "collecting";
}
async function expensiveSteps(data, st, events, phaseEvents, build) {
    const { store, ctx } = data;
    const job = store.job;
    const at = job ? JOB_STEPS.indexOf(job.step) : -1;
    const startedTs = job && at >= 0 ? job.startedTs : ctx.now;
    let change = null;
    let tightened = null;
    const vetoes = [];
    const vetoClear = [];
    const result = (kind) => tightened ?? build(kind, change, { vetoes, vetoClear });
    data.budgeted = true;
    try {
        for (let i = Math.max(0, at); i < JOB_STEPS.length; i++) {
            const step = JOB_STEPS[i];
            const basis = basisOf(data, st.p0);
            data.beginStep(i === at && job?.basis === basis ? (job.memo ?? []) : []);
            try {
                if (step === "final") {
                    change = (await finalStep(data, st, events)) ?? change;
                }
                else if (step === "tighten") {
                    const t = await tighten(data, st.p0, st.r0, st.q0, build);
                    vetoes.push(...t.vetoes);
                    vetoClear.push(...t.vetoClear);
                    if (t.kind === "tighten") {
                        tightened = { ...t, vetoes, vetoClear };
                    }
                }
                else {
                    phaseEvents.push(...(await phaseStep(data)));
                }
            }
            catch (err) {
                if (!(err instanceof BudgetExceeded)) {
                    throw err;
                }
                store.job = { step, cursor: data.memo.length, startedTs, basis, memo: data.memo };
                store.info.status = "budget";
                store.info.budget = (store.info.budget ?? 0) + 1;
                return { ...result(change ? "none" : "budget"), interrupted: true };
            }
        }
    }
    finally {
        data.budgeted = false;
    }
    delete store.job;
    store.info.budget = 0;
    if (store.info.status === "budget") {
        store.info.status = plainStatus(data);
    }
    return result("none");
}
async function phaseStep(data) {
    const { store, ctx } = data;
    const model = ctx.phases;
    if (!model?.enabled || !ctx.quality) {
        return [];
    }
    const quality = ctx.quality;
    const base = phaseTuneBase(model);
    const tune = store.phaseTune?.base === base ? store.phaseTune : undefined;
    const tuned = applyPhaseTune(model, tune?.applied);
    const current = tune?.applied && typeof tune.agreement === "number"
        ? { ...tuned, quality: { ...tuned.quality, agreement: tune.agreement } }
        : tuned;
    const sig = sigOf(data, ctx.type, `${base}|${tune?.applied?.hash ?? ""}`);
    if (checkedBefore(data, "phases", sig, true)) {
        return [];
    }
    const res = await data.unit("phases:tune", async () => {
        const keys = new Set(data.target.map(r => r.key));
        const units = storeSamples(store, quality)
            .filter(x => keys.has(x.run.key) && inUse(store, x.run))
            .map(x => ({ sample: x.sample, verdict: x.verdict }));
        await data.tick();
        const r = tunePhases(current, units, tune?.last ?? null, {
            pollSec: ctx.pollSec,
            holds: phaseHolds(current, store.bands ?? null) ?? [],
        });
        return {
            proposal: r.proposal,
            apply: r.model !== null,
            agreement: r.model?.quality.agreement ?? null,
            newPattern: r.newPattern,
        };
    });
    const out = [];
    const next = { base, last: res.proposal };
    if (res.apply) {
        next.applied = res.proposal;
        if (res.agreement !== null) {
            next.agreement = res.agreement;
        }
        out.push("tuned");
    }
    else if (tune?.applied) {
        next.applied = tune.applied;
        if (tune.agreement !== undefined) {
            next.agreement = tune.agreement;
        }
    }
    if (res.newPattern) {
        next.newPattern = true;
        if (tune?.newPattern !== true) {
            out.push("newPattern");
        }
    }
    store.phaseTune = next;
    markChecked(data, "phases", sig);
    return out;
}
function newestOf(data, keys) {
    const byKey = new Map([...data.store.runs, ...data.store.spikes].map(r => [r.key, r]));
    return [...keys].sort((a, b) => (byKey.get(b)?.ts ?? 0) - (byKey.get(a)?.ts ?? 0))[0];
}
function tightenAllowed(store, admittedRuns, now) {
    return (store.lockRuns <= 0 &&
        now >= store.lockUntilTs &&
        admittedRuns >= TIGHTEN_MIN_RUNS &&
        store.newSinceChange >= TIGHTEN_NEW_RUNS &&
        !(store.lastChangeTs > 0 && now - store.lastChangeTs < TIGHTEN_SPACING_MS));
}
function trustedOf(data) {
    const target = new Set(data.target);
    return (r) => r.label === "run" && !r.postTruncated && !data.merged.has(r.key) && target.has(r);
}
function finalSamples(data, quality) {
    const { store, ctx } = data;
    const keys = new Set(checkSet(store, ctx.now, ctx.verdicts).map(r => r.key));
    const parts = new Set(data.joined.flatMap(j => [j.a, j.b]));
    return storeSamples(store, quality)
        .filter(x => keys.has(x.run.key) && !parts.has(x.run) && inUse(store, x.run))
        .map(x => ({ sample: x.sample, verdict: x.verdict, series: x.series }));
}
async function learnedFinal(data, p) {
    const { store, ctx } = data;
    if (!ctx.quality || !store.bands || store.bands.bands.length === 0) {
        return null;
    }
    const learned = await learnFinal(finalSamples(data, ctx.quality), {
        base: p,
        pollSec: ctx.pollSec,
        unitFactor: store.unitFactor,
        abort: ctx.abort,
        abortFixed: ctx.abortFixed,
        bands: store.bands,
        minRuns: FINAL_ENABLE_MIN_RUNS,
        minPerGroup: FINAL_ENABLE_MIN_PER_GROUP,
        scope: ctx.quality.scope,
        yieldFn: () => data.tick(),
    });
    return learned.ok ? learned : null;
}
async function finalStep(data, st, events) {
    const { store, ctx } = data;
    const p0 = st.p0;
    const admittedRuns = data.target.filter(trustedOf(data)).length;
    const on = finalOn(p0);
    const allowed = on
        ? tightenAllowed(store, admittedRuns, ctx.now) && admittedRuns >= FINAL_ENABLE_MIN_RUNS
        : store.lockRuns <= 0 && ctx.now >= store.lockUntilTs && admittedRuns >= FINAL_ENABLE_MIN_RUNS;
    if (!allowed || !ctx.quality || !store.bands || store.bands.bands.length === 0) {
        return null;
    }
    const sig = sigOf(data, p0);
    if (checkedBefore(data, "final", sig, true)) {
        return null;
    }
    const learned = await data.unit("final:learn", async () => {
        const l = await learnedFinal(data, p0);
        return l ? { values: l.values, covered: l.covered } : null;
    });
    const change = learned ? await finalApply(data, st, learned, events) : null;
    markChecked(data, "final", sig);
    return change;
}
async function finalApply(data, st, learned, events) {
    const { store, ctx } = data;
    const { p0, r0, q0 } = st;
    const on = finalOn(p0);
    const values = on ? stepLimitFinal(learned.values, p0, learned.covered) : learned.values;
    if (!values) {
        return null;
    }
    const c = detectionOf({ ...p0, ...values });
    if (FINAL_KEYS.every(k => (c[k] ?? 0) === (p0[k] ?? 0)) ||
        !finalOn(c) ||
        finalViolations(c, c.standby, ctx.pollSec).length > 0) {
        return null;
    }
    const g = await gateOn(data, c, "none");
    if (!g.ok || g.falseStarts > r0.falseStarts) {
        return null;
    }
    if (g.perRun.some((r, i) => r.delaySec > (r0.perRun[i]?.delaySec ?? Number.POSITIVE_INFINITY) + ctx.pollSec)) {
        return null;
    }
    const q = await quarantineOn(data, c);
    if (!noRegression(q, q0)) {
        return null;
    }
    const before = store.override;
    store.override = diffOf(c, ctx.type);
    st.p0 = c;
    st.r0 = g;
    st.q0 = q;
    const change = {
        ts: ctx.now,
        kind: on ? "finalTune" : "finalOn",
        from: before,
        to: store.override,
        reason: describeChange(p0, c),
        runs: store.runs.length + store.spikes.length,
        gainSec: Math.round(mean(r0.perRun.map(r => r.delaySec)) - mean(g.perRun.map(r => r.delaySec))),
    };
    pushChange(store, change);
    store.final = { ...(store.final ?? { splits: [], suspendedAt: 0 }), state: "on" };
    store.lastChangeTs = ctx.now;
    store.newSinceChange = 0;
    store.info.status = "ok";
    events.push({ kind: on ? "tuned" : "on", change });
    return change;
}
async function recoverFinal(data, q0, events, vetoes) {
    const { store, ctx } = data;
    const final = store.final;
    const p1 = effectiveOf(ctx.type, store.override);
    if (!final || final.state !== "suspended" || !finalOn(p1)) {
        return;
    }
    const stays = (reason) => {
        if (final.stays !== reason) {
            store.final = { ...final, stays: reason };
            events.push({ kind: "stays", reason });
        }
    };
    const joined = final.joined ?? [];
    const missing = final.splits.filter(k => joined.some(j => j === k || sameRun(j, k)) && !data.joined.some(p => p.key === k || sameRun(p.key, k)));
    if (missing.length > 0) {
        stays("notStored");
        return;
    }
    const g1 = await gateOn(data, p1, "none", undefined, true);
    if (g1.ok && noRegression(await quarantineOn(data, p1, true), q0)) {
        markFinalResumed(store, "endOk", ctx.now, true);
        data.suspended = false;
        events.push({ kind: "resumed", reason: "endOk" });
        return;
    }
    const failing = failingOf(g1);
    let best = null;
    for (const c of await finalRepairCandidates(data, p1)) {
        const g = await gateOn(data, c, "none", undefined, true);
        if (g.ok && noRegression(await quarantineOn(data, c, true), q0)) {
            best = c;
            break;
        }
    }
    if (!best) {
        stays("noRepair");
        return;
    }
    const trigger = failing.length > 0 ? newestOf(data, failing) : final.splits.at(-1);
    const before = store.override;
    store.override = diffOf(best, ctx.type);
    const change = {
        ts: ctx.now,
        kind: "finalRepair",
        from: before,
        to: store.override,
        reason: describeChange(p1, best),
        runs: store.runs.length + store.spikes.length,
        gainSec: 0,
        ...(trigger ? { trigger } : {}),
    };
    pushChange(store, change);
    store.lockRuns = LOCK_RUNS;
    store.lockUntilTs = ctx.now + LOCK_MS;
    store.lastChangeTs = ctx.now;
    store.newSinceChange = 0;
    store.failStreak = 0;
    store.info.status = "locked";
    markFinalResumed(store, "repair", ctx.now, true, trigger);
    data.suspended = false;
    vetoes.push(...failing);
    events.push({ kind: "repaired", change, ...(trigger ? { key: trigger } : {}) });
    events.push({ kind: "resumed", reason: "repair" });
}
async function finalRepairCandidates(data, p1) {
    const poll = data.ctx.pollSec;
    const out = [];
    const add = (c) => {
        if (finalOn(c) && finalViolations(c, c.standby, poll).length === 0) {
            out.push({ c, d: finalDistance(c, p1) });
        }
    };
    const Y = p1.finalMinSec ?? 0;
    const X = p1.finalAfterSec ?? 0;
    const P = p1.finalMinVal ?? 0;
    const Pmax = p1.finalMaxVal ?? 0;
    for (const fy of FINAL_REPAIR_Y) {
        for (const fx of FINAL_REPAIR_X) {
            for (const fp of FINAL_REPAIR_P) {
                const p = Math.round(P * fp * 1e5) / 1e5;
                if ((fy === 1 && fx === 1 && fp === 1) || (Pmax > 0 && p >= Pmax)) {
                    continue;
                }
                add({
                    ...p1,
                    finalMinSec: Math.ceil((Y * fy) / poll) * poll,
                    finalAfterSec: Math.ceil((X * fx) / poll) * poll,
                    finalMinVal: p,
                });
            }
        }
    }
    const learned = await learnedFinal(data, p1);
    if (learned) {
        const v = learned.values;
        add({
            ...p1,
            ...v,
            finalMinSec: Math.max(v.finalMinSec, Y),
            finalAfterSec: Math.max(v.finalAfterSec, X),
            finalMinVal: Math.max(v.finalMinVal, P),
        });
    }
    return out.sort((a, b) => a.d - b.d).map(x => x.c);
}
function finalDistance(p, p0) {
    let d = 0;
    for (const k of FINAL_KEYS) {
        const x = p[k] ?? 0;
        const y = p0[k] ?? 0;
        d += Math.abs(x - y) / Math.max(Math.abs(y), 1);
    }
    return d;
}
export function stepLimitFinal(c, p0, covered) {
    const a = finalFields(c);
    const b = finalFields(p0);
    if (b.finalMinVal <= 0) {
        return a;
    }
    if (a.finalMinVal <= 0) {
        return null;
    }
    const round = (x) => Math.round(x * 1e5) / 1e5;
    const out = { ...a };
    out.finalMinVal = round(Math.min(b.finalMinVal * (1 + FINAL_P_STEP), Math.max(b.finalMinVal * (1 - FINAL_P_STEP), a.finalMinVal)));
    if (a.finalMinSec < b.finalMinSec) {
        out.finalMinSec =
            covered >= FINAL_Y_DROP_RUNS
                ? round(Math.max(a.finalMinSec, b.finalMinSec * (1 - FINAL_Y_DROP)))
                : b.finalMinSec;
    }
    out.finalAfterSec = round(Math.max(a.finalAfterSec, b.finalAfterSec * (1 - FINAL_X_DROP)));
    return out;
}
function finalFields(s) {
    return Object.fromEntries(FINAL_KEYS.map(k => [k, s[k] ?? 0]));
}
function silentFinalOff(c, p0) {
    return finalOn(p0) && !finalOn(c);
}
function oldVetoes(data) {
    return data.runs.filter(r => r.veto !== undefined && r.veto < data.ctx.now).map(r => r.key);
}
async function bestRepair(data, p0, candidates, seen, q0) {
    let best = null;
    for (const c of candidates) {
        const key = JSON.stringify(detectionOf(c));
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        if (silentFinalOff(c, p0)) {
            continue;
        }
        const d = distance(c, p0);
        if (best && d >= best.d) {
            continue;
        }
        const g = await gateOn(data, c, "none");
        const score = d + mean(g.perRun.map(r => r.delaySec)) / REPAIR_DELAY_WEIGHT_SEC;
        if (g.ok && (!best || score < best.d) && noRegression(await quarantineOn(data, c), q0)) {
            best = { p: c, d: score, g };
        }
    }
    return best;
}
async function repair(data, p0, r0, q0, failing, done) {
    const { store, ctx } = data;
    const raw = await repairCandidates(data, p0);
    const floored = raw
        .map(c => clampBounds(applyFloors(c, store, ctx.pollSec), ctx.pollSec))
        .filter(c => withinBounds(c, ctx.pollSec));
    const seen = new Set();
    let best = await bestRepair(data, p0, floored, seen, q0);
    best ??= await bestRepair(data, p0, raw, seen, q0);
    if (!best) {
        store.failStreak++;
        store.info.status = store.failStreak >= DRIFT_RUNS ? "drift" : "cannotCover";
        return done(store.failStreak >= DRIFT_RUNS ? "drift" : "cannotCover", null, { failing });
    }
    const byKey = new Map([...data.runs, ...data.spikes].map(r => [r.key, r]));
    const trigger = [...failing].sort((a, b) => (byKey.get(b)?.ts ?? 0) - (byKey.get(a)?.ts ?? 0))[0];
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
        trigger,
    };
    pushChange(store, change);
    store.lockRuns = LOCK_RUNS;
    store.lockUntilTs = ctx.now + LOCK_MS;
    store.lastChangeTs = ctx.now;
    store.newSinceChange = 0;
    store.failStreak = 0;
    store.info.status = "locked";
    return done("repair", change, { failing, vetoes: failing, vetoClear: oldVetoes(data) });
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
    if (withTrailer < FILTER_RUNS) {
        return [];
    }
    return filterVariants(runs, store, pollSec).filter(v => (v.trailerBlockVal ?? 0) > 0);
}
function unguardedFilterOn(c, p0) {
    return (p0.trailerBurstSec ?? 0) <= 0 && (c.trailerBurstSec ?? 0) > 0 && (c.trailerBlockVal ?? 0) <= 0;
}
async function storedAnalysis(data, p0, keep) {
    const sg = await analyzeStored(data, p0, keep);
    return sg
        ? {
            analysis: fromSuggestion(sg, p0),
            trailer: sg.trailer ?? "none",
            looDetected: sg.looDetected ?? null,
            runs: sg.runs,
        }
        : null;
}
async function candidateCheck(data, c, r0, q0) {
    const poll = data.ctx.pollSec;
    const g = await gateOn(data, c, "none");
    const delay = mean(g.perRun.map(r => r.delaySec));
    if (!g.ok || g.falseStarts > r0.falseStarts) {
        const bad = failingOf(g);
        return { pass: false, veto: bad.length === 1 ? bad[0] : null, falseStarts: g.falseStarts, delay };
    }
    const later = g.perRun.some((r, i) => r.delaySec > (r0.perRun[i]?.delaySec ?? Number.POSITIVE_INFINITY) + poll);
    const pass = !later && noRegression(await quarantineOn(data, c), q0);
    return { pass, veto: null, falseStarts: g.falseStarts, delay };
}
async function tighten(data, p0, r0, q0, done) {
    const { store, ctx } = data;
    const target = new Set(data.target);
    const isTrusted = (r) => r.label === "run" && !r.postTruncated && !data.merged.has(r.key) && target.has(r);
    const admittedRuns = data.target.filter(isTrusted).length;
    const trusted = data.runs.filter(isTrusted);
    const locked = store.lockRuns > 0 || ctx.now < store.lockUntilTs;
    if (locked) {
        store.info.status = "locked";
        return done("none");
    }
    store.info.status = admittedRuns >= TIGHTEN_MIN_RUNS ? "ok" : "collecting";
    if (admittedRuns < TIGHTEN_MIN_RUNS ||
        store.newSinceChange < TIGHTEN_NEW_RUNS ||
        (store.lastChangeTs > 0 && ctx.now - store.lastChangeTs < TIGHTEN_SPACING_MS)) {
        return done("none");
    }
    const sig = sigOf(data, p0, store.override === null ? "" : JSON.stringify(store.override));
    if (checkedBefore(data, "tighten", sig, false)) {
        return done("none");
    }
    const result = await tightenSearch(data, p0, r0, q0, done, { admittedRuns, trusted, isTrusted });
    markChecked(data, "tighten", sig);
    return result;
}
async function tightenSearch(data, p0, r0, q0, done, runs) {
    const { store, ctx } = data;
    const poll = ctx.pollSec;
    const { admittedRuns, trusted, isTrusted } = runs;
    const sg = await data.unit("tighten:analysis", () => storedAnalysis(data, p0, isTrusted));
    if (!sg) {
        return done("none");
    }
    store.info.trailer = sg.trailer === "notSeparable" ? "notSeparable" : store.info.trailer;
    const withTrailer = trusted.filter(r => r.feat.trailer).length;
    const shape = (c) => clampBounds(applyFloors(stepLimit(c, p0, admittedRuns, withTrailer, poll), store, poll), poll);
    const build = (recipe, analysis, variants) => {
        const base = recipe.base === "current" ? detectionOf(p0) : analysis;
        return shape(recipe.filter >= 0 && variants[recipe.filter] ? { ...base, ...variants[recipe.filter] } : base);
    };
    const variants = filterOptions(trusted, store, p0, withTrailer, poll);
    const recipes = [{ base: "analysis", filter: -1 }];
    variants.forEach((_, i) => {
        recipes.push({ base: "analysis", filter: i }, { base: "current", filter: i });
    });
    const passing = [];
    const seen = new Set();
    const vetoes = new Set();
    for (const recipe of recipes) {
        const c = build(recipe, detectionOf(sg.analysis), variants);
        const json = JSON.stringify(c);
        if (seen.has(json) || !withinBounds(c, poll) || unguardedFilterOn(c, p0) || silentFinalOff(c, p0)) {
            continue;
        }
        seen.add(json);
        const key = hashText(json);
        const check = await data.unit(`tighten:gate:${key}`, () => candidateCheck(data, c, r0, q0));
        if (check.veto !== null) {
            vetoes.add(check.veto);
        }
        if (check.pass) {
            passing.push({ recipe, c, key, check });
        }
    }
    const extra = () => ({ vetoes: [...vetoes] });
    passing.sort((a, b) => a.check.delay - b.check.delay);
    const families = [...new Set(trusted.map(r => r.family))];
    const d0 = mean(r0.perRun.map(r => r.delaySec));
    const without = new Map();
    const analysisWithout = async (fam) => {
        if (!without.has(fam)) {
            const a = await data.unit(`tighten:without:${fam}`, () => storedAnalysis(data, p0, r => isTrusted(r) && r.family !== fam));
            without.set(fam, a ? detectionOf(a.analysis) : null);
        }
        return without.get(fam) ?? null;
    };
    for (const cand of passing) {
        const gain = d0 - cand.check.delay;
        const fewerFalse = cand.check.falseStarts < r0.falseStarts;
        if (!fewerFalse && gain < Math.max(60, 0.1 * d0)) {
            break;
        }
        if (!(await crossCheck(data, p0, cand.recipe, families, sg, isTrusted, build, analysisWithout))) {
            continue;
        }
        const robust = await data.unit(`tighten:robust:${cand.key}`, async () => {
            for (const p of ["scale09", "scale11", "shift1", "stale5"]) {
                if (!(await gateOn(data, cand.c, p)).ok) {
                    return false;
                }
            }
            return true;
        });
        if (!robust) {
            continue;
        }
        if (data.reused && !(await candidateCheck(data, cand.c, r0, q0)).pass) {
            continue;
        }
        const next = diffOf(cand.c, ctx.type);
        if (JSON.stringify(next) === JSON.stringify(store.override)) {
            return done("none", null, extra());
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
        return done("tighten", change, { ...extra(), vetoClear: oldVetoes(data) });
    }
    return done("none", null, extra());
}
async function crossCheck(data, p0, recipe, families, sg, isTrusted, build, analysisWithout) {
    const { store, ctx } = data;
    if (families.length < 3) {
        return recipe.base === "current" || sg.looDetected === null || sg.looDetected >= sg.runs;
    }
    for (const fam of families) {
        const keep = (r) => isTrusted(r) && r.family !== fam;
        const rest = data.runs.filter(keep);
        const aF = recipe.base === "analysis" ? await analysisWithout(fam) : null;
        if (recipe.base === "analysis" && !aF) {
            continue;
        }
        const variants = recipe.filter >= 0
            ? filterOptions(rest, store, p0, rest.filter(r => r.feat.trailer).length, ctx.pollSec)
            : [];
        const cF = build(recipe, aF ?? detectionOf(p0), variants);
        const gF = await gateOn(data, cF, "none", r => isTrusted(r) && r.family === fam);
        if (!gF.ok) {
            return false;
        }
    }
    return true;
}
export function applyVetoes(store, outcome, now) {
    const set = new Set(outcome.vetoes);
    const clear = new Set(outcome.vetoClear);
    for (const r of [...store.runs, ...store.spikes]) {
        if (clear.has(r.key)) {
            delete r.veto;
        }
        if (set.has(r.key)) {
            r.veto = now;
        }
    }
}
//# sourceMappingURL=autoOptimize.js.map