import { endCandidates, planFor, runTable } from "./optimize.js";
import { allOk, compare, evaluate, runOk, simulate } from "./replay.js";
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
    const replay = { abort: opts.abort === true, abortFixed: opts.abortFixed === true };
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
    const startCounts = [k0, k0 + 1];
    const startDurations = [...new Set([k0 * poll, Math.max(60, k0 * poll)])];
    const ctx = { series, runs, pollSec: poll, minDeltaW };
    const tablesByE = new Map();
    const plans = endCandidates(series, layout, minDeltaW).map(e => {
        const tables = runs.map((r, i) => runTable(series, r, e, i));
        tablesByE.set(e, tables);
        return planFor(ctx, e, tables);
    });
    const chosenPlans = [...plans].sort((a, b) => a.estCost - b.estCost).slice(0, 2);
    an.plan(chosenPlans.length * (startCounts.length + 2 * startDurations.length) + 2);
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
        const thresholds = { startVal, endVal: plan.e, standby };
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
    const evaluation = MODE_ORDER.map(m => best.get(m)?.evaluation).filter(e => e !== undefined);
    const mode = pickMode(evaluation);
    const chosen = best.get(mode);
    const settings = chosen.settings;
    let looDetected;
    if (runs.length >= 2) {
        looDetected = 0;
        const tables = tablesByE.get(chosen.plan.e) ?? [];
        for (const win of layout.windows) {
            if (win.run === null) {
                continue;
            }
            const plan = planFor(ctx, chosen.plan.e, tables.filter(t => t.run !== win.run));
            const endTicks = Math.ceil(plan.Ds / poll);
            const endCount = endTicks + Math.max(2, Math.ceil(0.25 * endTicks));
            const loo = {
                ...settings,
                ...(plan.guard ?? NO_GUARD),
                ...(mode === "count" ? { endCount, endDurationSec: endCount * poll } : { endDurationSec: plan.Ds }),
            };
            const res = an.simulate(win, loo);
            if (runOk(series, win, res) && res.finished.length === 1) {
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
    an.progress();
    const out = (v) => an.out(v);
    const stepSec = series.stepMs / 1000;
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
        mode,
        runs: runs.length,
        evaluation,
        ...(looDetected !== undefined ? { looDetected } : {}),
        longestPauseSec: Math.round(chosen.plan.dmax),
        ...(current ? { current } : {}),
        gapsDropped: layout.gapsDropped,
    };
}
//# sourceMappingURL=analyze.js.map