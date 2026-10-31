import { TRAILER_MAX_DEFAULT_SEC } from "../detector/trailer.js";
import { endCandidates, planFor, runTable, suppressBursts } from "./optimize.js";
import { allOk, compare, evaluate, runOkFull, simulate } from "./replay.js";
import { buildLayout, median } from "./runs.js";
import { scaled } from "./ticks.js";
export const HISTORY_DAYS = 30;
export const MIN_RUNS = 2;
export const DELAY_TOLERANCE_SEC = 60;
const MODE_ORDER = ["count", "combined", "timed"];
const NO_GUARD = { pauseHoldSec: 0, pauseUntilSec: 0, pauseBelowVal: 0 };
export function pickMode(evaluations) {
    const mostDetected = Math.max(...evaluations.map(e => e.detected));
    const top = evaluations.filter(e => e.detected === mostDetected);
    const fewestFalse = Math.min(...top.map(e => e.falseStarts));
    const reliable = top.filter(e => e.falseStarts === fewestFalse);
    const fastest = Math.min(...reliable.map(e => e.endDelaySec));
    const order = (m) => MODE_ORDER.indexOf(m);
    return [...reliable]
        .filter(e => e.endDelaySec <= fastest + DELAY_TOLERANCE_SEC)
        .sort((a, b) => order(a.mode) - order(b.mode))[0].mode;
}
function round2(v) {
    return Math.round(v * 100) / 100;
}
function longestAbove(s, spans, level) {
    let longest = 0;
    for (const sp of spans) {
        let cur = 0;
        for (let i = sp.from; i <= sp.to; i++) {
            cur = s.last[i] >= level ? cur + 1 : 0;
            longest = Math.max(longest, cur);
        }
    }
    return longest;
}
class Analysis {
    layout;
    replay;
    opts;
    factor;
    runWindows;
    sim;
    done = 0;
    total = 1;
    constructor(s, layout, replay, opts, factor) {
        this.layout = layout;
        this.replay = replay;
        this.opts = opts;
        this.factor = factor;
        this.runWindows = layout.windows.filter(w => w.run !== null);
        this.sim = factor === 1 ? s : scaled(s, 1 / factor);
    }
    out(v) {
        return this.factor === 1 ? round2(v) : Math.round((v / this.factor) * 1e5) / 1e5;
    }
    inUnit(settings) {
        return {
            ...settings,
            startVal: this.out(settings.startVal),
            endVal: this.out(settings.endVal),
            standby: this.out(settings.standby),
            pauseBelowVal: this.out(settings.pauseBelowVal ?? 0),
            ...(settings.trailerBlockVal ? { trailerBlockVal: this.out(settings.trailerBlockVal) } : {}),
        };
    }
    simulate(win, settings) {
        return simulate(this.sim, win, this.inUnit(settings), this.replay);
    }
    evaluateUnit(settings) {
        return evaluate(this.sim, this.layout.windows, settings, this.replay, this.opts.yieldFn);
    }
    plan(total) {
        this.total = Math.max(1, total);
    }
    finish() {
        this.done = this.total;
        this.opts.onProgress?.(1);
    }
    progress() {
        this.done++;
        this.opts.onProgress?.(Math.min(1, this.done / this.total));
    }
    ok(settings) {
        return allOk(this.sim, this.runWindows, this.inUnit(settings), this.replay, this.opts.yieldFn);
    }
    evaluate(settings) {
        return this.evaluateUnit(this.inUnit(settings));
    }
    async searchCount(make, hi) {
        if (!(await this.ok(make(hi)))) {
            return null;
        }
        let lo = 2;
        let top = hi;
        while (lo < top) {
            const mid = Math.floor((lo + top) / 2);
            if (await this.ok(make(mid))) {
                top = mid;
            }
            else {
                lo = mid + 1;
            }
        }
        let e = Math.min(hi, lo + Math.max(2, Math.ceil(0.25 * lo)));
        while (e < hi && !(await this.ok(make(e)))) {
            e = Math.min(hi, e + Math.max(1, Math.ceil(0.1 * e)));
        }
        return e;
    }
}
export async function analyzeTicks(series, pollIntervalSec, opts = {}) {
    if (series.points < 20 || series.length === 0) {
        return { error: "noHistory" };
    }
    const poll = Math.max(pollIntervalSec, 1);
    const factor = opts.unitFactor && opts.unitFactor > 0 ? opts.unitFactor : 1;
    const minDeltaW = Math.max(0, opts.minDelta ?? 0) * factor;
    const keepAbove = opts.currentType ? opts.currentType.endVal * factor : undefined;
    const layout = buildLayout(series, { recording: opts.recording, keepAbove });
    const { runs, idle, runLimit } = layout;
    const minRuns = Math.max(1, opts.minRuns ?? MIN_RUNS);
    if (runs.length < minRuns) {
        return { error: "tooFewRuns", runs: runs.length };
    }
    const replay = {
        abort: opts.abort === true,
        abortFixed: opts.abortFixed === true,
        pollSec: poll,
    };
    const an = new Analysis(series, layout, replay, opts, factor);
    const runPower = runs.map(r => {
        const vals = [];
        for (let i = r.from; i <= r.coreEnd; i++) {
            if (series.last[i] > runLimit) {
                vals.push(series.last[i]);
            }
        }
        return median(vals);
    });
    const startVal = round2(Math.max(idle + 5, 0.25 * Math.min(...runPower)));
    const standby = round2(idle * 1.2 + 0.1);
    const maxBurst = longestAbove(series, [...runs.flatMap(r => r.bursts), ...layout.spikes], startVal);
    const k0 = Math.max(2, maxBurst + 1);
    const base = { series, layout, poll, minDeltaW, startVal, standby, k0 };
    const withTrailer = runs.filter(r => r.bursts.length >= 2);
    const trailerParams = withTrailer.length >= 2 ? deriveTrailer(withTrailer, series.stepMs, poll) : null;
    const variants = [];
    if (trailerParams) {
        const minCore = Math.min(...runs.map(r => (r.coreEnd - r.from) * (series.stepMs / 1000)));
        const minBlock = Math.min(...runs.map(r => r.blockMean));
        const after = Math.floor(0.9 * minCore);
        const block = round2(0.8 * minBlock);
        variants.push(trailerParams);
        variants.push({ ...trailerParams, trailerAfterSec: after });
        if (block > startVal) {
            variants.push({ ...trailerParams, trailerBlockVal: block });
            variants.push({ ...trailerParams, trailerAfterSec: after, trailerBlockVal: block });
        }
    }
    const perSearch = Math.min(2, endCandidates(series, layout, minDeltaW).length) *
        (2 + 2 * new Set([k0 * poll, Math.max(60, k0 * poll)]).size);
    an.plan((1 + variants.length) * perSearch + 2);
    const plain = await searchModes(an, base, null);
    let chosenSearch = plain;
    let trailer = "none";
    if (variants.length > 0) {
        let bestFiltered = null;
        for (const v of variants) {
            const filtered = await searchModes(an, base, v);
            const fBest = bestOf(filtered);
            if (fBest.evaluation.detected < fBest.evaluation.runs) {
                continue;
            }
            if (!bestFiltered || compare(fBest.evaluation, bestFiltered.evaluation) < 0) {
                bestFiltered = { search: filtered, evaluation: fBest.evaluation };
            }
        }
        if (!bestFiltered) {
            trailer = "notSeparable";
        }
        else if (betterWithFilter(bestFiltered.evaluation, bestOf(plain).evaluation)) {
            chosenSearch = bestFiltered.search;
            trailer = "used";
        }
    }
    const evaluation = MODE_ORDER.map(m => chosenSearch.best.get(m)?.evaluation).filter(e => e !== undefined);
    const mode = pickMode(evaluation);
    const chosen = chosenSearch.best.get(mode);
    const settings = chosen.settings;
    let looDetected;
    if (runs.length >= 2) {
        looDetected = 0;
        const tables = chosenSearch.tablesByE.get(chosen.plan.e) ?? [];
        for (const win of layout.windows) {
            if (win.run === null) {
                continue;
            }
            const plan = planFor(chosenSearch.ctx, chosen.plan.e, tables.filter(t => t.run !== win.run));
            const endTicks = Math.ceil(plan.Ds / poll);
            const endCount = endTicks + Math.max(2, Math.ceil(0.25 * endTicks));
            const loo = {
                ...settings,
                ...(plan.guard ?? NO_GUARD),
                ...(mode === "count" ? { endCount, endDurationSec: endCount * poll } : { endDurationSec: plan.Ds }),
            };
            const res = an.simulate(win, loo);
            if (runOkFull(series, win, res)) {
                looDetected++;
            }
            await opts.yieldFn?.();
        }
    }
    an.progress();
    let current;
    if (opts.currentType) {
        current = await an.evaluateUnit(opts.currentType);
    }
    an.finish();
    const out = (v) => an.out(v);
    const stepSec = series.stepMs / 1000;
    const chosenEval = chosen.evaluation;
    const trailerOut = trailer === "used" && settings.trailerBurstSec
        ? {
            trailerBurstSec: settings.trailerBurstSec,
            trailerGapSec: settings.trailerGapSec ?? 0,
            trailerAfterSec: settings.trailerAfterSec ?? 0,
            trailerBlockVal: out(settings.trailerBlockVal ?? 0),
            trailerMaxSec: settings.trailerMaxSec ?? 0,
        }
        : {};
    return {
        thresholds: {
            startVal: out(settings.startVal),
            endVal: out(settings.endVal),
            standby: out(settings.standby),
            startCount: settings.startCount,
            endCount: settings.endCount,
        },
        startDurationSec: settings.startDurationSec,
        endDurationSec: settings.endDurationSec,
        durationSec: Math.max(...runs.map(r => Math.round((r.runEnd - r.from) * stepSec))),
        samples: series.points,
        pauseHoldSec: settings.pauseHoldSec ?? 0,
        pauseUntilSec: settings.pauseUntilSec ?? 0,
        pauseBelowVal: out(settings.pauseBelowVal ?? 0),
        ...trailerOut,
        mode,
        runs: runs.length,
        evaluation,
        ...(looDetected !== undefined ? { looDetected } : {}),
        longestPauseSec: Math.round(chosen.plan.dmax),
        ...(current ? { current } : {}),
        gapsDropped: layout.gapsDropped,
        trailer,
        trailerRuns: [withTrailer.length, runs.length],
        delays: chosenEval.delays ?? [],
        falseStarts: chosenEval.falseStarts,
    };
}
function bestOf(r) {
    const evaluation = MODE_ORDER.map(m => r.best.get(m)?.evaluation).filter(e => e !== undefined);
    return r.best.get(pickMode(evaluation));
}
export function betterWithFilter(f, p) {
    if (f.detected !== p.detected) {
        return f.detected > p.detected;
    }
    if (f.falseStarts !== p.falseStarts) {
        return f.falseStarts < p.falseStarts;
    }
    return f.endDelaySec < p.endDelaySec - DELAY_TOLERANCE_SEC;
}
export function deriveTrailer(runs, stepMs, poll) {
    const burstMax = Math.max(...runs.map(r => r.burstMaxMs)) / 1000;
    const gapMin = Math.min(...runs.map(r => r.gapMinMs)) / 1000;
    const longest = Math.max(...runs.map(r => ((r.trailerTo ?? r.coreEnd) - r.coreEnd) * (stepMs / 1000)));
    const burst = Math.min(180, Math.max(Math.ceil(Math.max(15, 1.5 * poll + 10)), Math.ceil(burstMax * 1.5)));
    const gap = Math.max(1, Math.min(Math.floor(0.8 * gapMin), Math.max(3 * poll, 30, Math.floor(0.5 * gapMin))));
    return {
        trailerBurstSec: burst,
        trailerGapSec: gap,
        trailerAfterSec: 0,
        trailerBlockVal: 0,
        trailerMaxSec: Math.min(14400, Math.max(TRAILER_MAX_DEFAULT_SEC, Math.ceil(longest * 1.25 + 900))),
    };
}
async function searchModes(an, b, trailer) {
    const { series, layout, poll, minDeltaW, startVal, standby, k0 } = b;
    const extra = trailer ?? {};
    const startCounts = [k0, k0 + 1];
    const startDurations = [...new Set([k0 * poll, Math.max(60, k0 * poll)])];
    const ctx0 = { series, runs: layout.runs, pollSec: poll, minDeltaW };
    const tablesByE = new Map();
    let ctx = ctx0;
    const plans = endCandidates(series, layout, minDeltaW).map(e => {
        const planSeries = trailer ? suppressBursts(series, layout, trailer, e, poll) : series;
        ctx = { ...ctx0, series: planSeries };
        const tables = layout.runs.map((r, i) => runTable(planSeries, r, e, i));
        tablesByE.set(e, tables);
        return planFor(ctx, e, tables);
    });
    const chosenPlans = [...plans].sort((x, y) => x.estCost - y.estCost).slice(0, 2);
    const best = new Map();
    const consider = async (settings, plan) => {
        const evaluation = await an.evaluate(settings);
        const known = best.get(settings.mode);
        if (!known || compare(evaluation, known.evaluation) < 0) {
            best.set(settings.mode, { settings, evaluation, plan });
        }
        an.progress();
    };
    for (const plan of chosenPlans) {
        const thresholds = { startVal, endVal: plan.e, standby, ...extra };
        let countE = 0;
        for (const startCount of startCounts) {
            const make = (guard) => (endCount) => ({
                ...thresholds,
                ...guard,
                mode: "count",
                startCount,
                endCount,
                startDurationSec: startCount * poll,
                endDurationSec: endCount * poll,
            });
            let settings = null;
            if (plan.guard) {
                const e = await an.searchCount(make(plan.guard), Math.ceil((plan.Ds / poll) * 1.5) + 3);
                settings = e === null ? null : make(plan.guard)(e);
            }
            if (!settings) {
                const hi = Math.max(2, Math.ceil((Math.ceil(plan.dmax / poll) + 3) * 1.5), Math.ceil((plan.noGuardDs / poll) * 1.5) + 3);
                settings = make(NO_GUARD)((await an.searchCount(make(NO_GUARD), hi)) ?? hi);
            }
            if (startCount === k0) {
                countE = settings.endCount;
            }
            await consider(settings, plan);
        }
        for (const mode of ["timed", "combined"]) {
            for (const startDurationSec of startDurations) {
                const make = (guard, endDurationSec) => ({
                    ...thresholds,
                    ...guard,
                    mode,
                    startCount: k0,
                    endCount: mode === "combined" ? 3 : countE,
                    startDurationSec,
                    endDurationSec,
                });
                let settings = null;
                let ds = plan.Ds;
                for (let attempt = 0; attempt <= 3 && !settings; attempt++) {
                    const candidate = make(plan.guard ?? NO_GUARD, ds);
                    if (await an.ok(candidate)) {
                        settings = candidate;
                    }
                    ds = Math.ceil(ds * 1.25);
                }
                await consider(settings ?? make(NO_GUARD, plan.noGuardDs), plan);
            }
        }
    }
    return { best, tablesByE, ctx };
}
//# sourceMappingURL=analyze.js.map