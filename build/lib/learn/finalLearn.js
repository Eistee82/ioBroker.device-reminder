import { createDetector } from "../detector/index.js";
import { FINAL_KEYS } from "../detector/types.js";
import { finalViolations } from "../config.js";
import { bandSegmentsOf, suspectLimitOf } from "./bands.js";
import { admitted } from "./quality.js";
import { DENSE_MIN_MS, median, PAD_AFTER_MS, PAD_BEFORE_MS, quantile, SUSTAINED_MS } from "./runs.js";
const POWER_KEYS = [
    "startVal",
    "endVal",
    "standby",
    "pauseBelowVal",
    "trailerBlockVal",
    "finalMinVal",
    "finalMaxVal",
    "finalHotVal",
    "finalRestVal",
    "finalActVal",
];
const SEPARATION = 2;
const P_STEP = Math.log(1.02);
const OTHER_FLOOR_SEC = 30;
const MIN_DIP_SEC = 60;
const MIN_QUIET_SEC = 120;
const MIN_REST_SEC = 60;
const MIN_CHECK_SEC = 1800;
const MIN_LOCK_SEC = 1800;
const MAX_LOCK_SEC = 14_400;
const TIME_MARGIN = 1.5;
const AFTER_SHARE = 0.5;
const AFTER_Q = 0.1;
const ACT_FACTOR = 1.5;
const ACT_SHARE_MIN = 0.6;
const ACT_SHARE_ADD = 0.15;
const ACT_SHARE_MAX = 0.8;
const ACT_SHARE_OFF = 0.65;
const ACT_WINDOW_MS = 5 * 60_000;
const GAIN_MIN_SEC = 60;
const GAIN_SHARE = 0.1;
const GROUP_FOLDS_MIN = 3;
const ROBUST_SCALES = [0.9, 1.1];
const ROBUST_POLLS = [3, 6];
const ROBUST_MISSING = 0.3;
const MAX_POLL_SEC = 600;
const MARGIN_FACTORS = [0.9, 1.1];
const SPLIT_MIN_RUNS = 3;
const START_MS = 10 * 60_000;
const START_SHARE = 0.8;
const SPLIT_REST_MIN_MS = MIN_REST_SEC * 1000;
function zeroFinal() {
    const out = {};
    for (const k of FINAL_KEYS) {
        out[k] = 0;
    }
    return out;
}
function inW(s, factor) {
    const out = { ...s };
    for (const k of POWER_KEYS) {
        const v = out[k];
        if (typeof v === "number") {
            out[k] = v * factor;
        }
    }
    return out;
}
function round4(v) {
    return v > 0 ? Number(v.toPrecision(4)) : 0;
}
function idxOf(s, t) {
    return Math.round((t - s.t0) / s.stepMs);
}
function itemsOf(runs) {
    const bySeries = new Map();
    for (const r of runs) {
        const list = bySeries.get(r.series) ?? [];
        list.push(r.sample);
        bySeries.set(r.series, list);
    }
    for (const list of bySeries.values()) {
        list.sort((a, b) => a.facts.start - b.facts.start);
    }
    const out = [];
    for (const { sample, verdict, series: s } of runs) {
        const info = sample.info;
        if (sample.kind !== "run" || info === null) {
            continue;
        }
        const list = bySeries.get(s);
        const k = list.indexOf(sample);
        const prev = k > 0 ? list[k - 1] : null;
        const next = k + 1 < list.length ? list[k + 1] : null;
        let fromIdx = Math.max(0, info.from - Math.ceil(PAD_BEFORE_MS / s.stepMs), prev ? idxOf(s, prev.facts.end) + 1 : 0);
        let toIdx = Math.min(s.length - 1, info.runEnd + Math.ceil(PAD_AFTER_MS / s.stepMs), next ? idxOf(s, next.facts.start) - 1 : s.length - 1);
        for (let i = info.from; i >= fromIdx; i--) {
            if (s.valid[i] === 0) {
                fromIdx = i + 1;
                break;
            }
        }
        for (let i = info.from; i <= toIdx; i++) {
            if (s.valid[i] === 0) {
                toIdx = i - 1;
                break;
            }
        }
        if (toIdx < info.to) {
            continue;
        }
        out.push({
            sample,
            verdict,
            series: s,
            info,
            fromIdx,
            toIdx,
            runEndT: s.t0 + info.runEnd * s.stepMs,
            progEndT: s.t0 + info.progEnd * s.stepMs,
            clean: verdict.user === "include" || verdict.stage === "ok",
            merged: verdict.reasons.some(r => r.code === "merged"),
        });
    }
    return out;
}
function blocksOfRun(it, P, Pmax, dipMs, bands, factor) {
    const s = it.series;
    const from = it.info.from;
    if (!it.limits) {
        it.limits = new Float64Array(Math.max(0, it.info.coreEnd - from + 1));
        for (let i = from; i <= it.info.coreEnd; i++) {
            it.limits[i - from] = (suspectLimitOf(bands, s.last[i] / factor) ?? Number.POSITIVE_INFINITY) * 1000;
        }
    }
    const out = [];
    let cur = null;
    let below = 0;
    let hold = 0;
    const close = () => {
        if (cur) {
            out.push(cur);
        }
        cur = null;
        below = 0;
    };
    for (let i = from; i <= it.info.coreEnd; i++) {
        if (s.valid[i] === 0) {
            close();
            hold = 0;
            continue;
        }
        hold = s.has[i] === 1 ? 0 : hold + s.stepMs;
        const v = s.last[i];
        if (v >= Pmax) {
            close();
        }
        else if (v >= P) {
            cur ??= { from: i, to: i, ms: 0, suspect: false };
            cur.to = i;
            cur.ms += s.stepMs;
            below = 0;
            if (hold > it.limits[i - from]) {
                cur.suspect = true;
            }
        }
        else if (cur) {
            below += s.stepMs;
            if (below > dipMs) {
                close();
            }
        }
    }
    close();
    return out;
}
function scanAt(items, afterMs, P, Pmax, dipMs, floorMs, bands, factor) {
    const all = items.map(it => blocksOfRun(it, P, Pmax, dipMs, bands, factor));
    let otherMs = floorMs;
    for (const blocks of all) {
        for (const b of blocks.slice(0, -1)) {
            if (!b.suspect) {
                otherMs = Math.max(otherMs, b.ms);
            }
        }
    }
    const finals = all.map(blocks => {
        const last = blocks.at(-1);
        return last && !last.suspect ? last : null;
    });
    let covered = 0;
    let finalMs = Number.POSITIVE_INFINITY;
    for (const [k, f] of finals.entries()) {
        if (f && f.ms >= SEPARATION * otherMs && (f.from - items[k].info.from) * items[k].series.stepMs >= afterMs) {
            covered++;
            finalMs = Math.min(finalMs, f.ms);
        }
    }
    return { P, covered, finals, otherMs, finalMs };
}
function finalBandOf(items, bands, factor) {
    let top = -1;
    let low = Number.POSITIVE_INFINITY;
    for (const it of items) {
        const seg = bandSegmentsOf(it.sample, bands, it.sample.facts.coreEnd)
            .filter(x => x.ms >= SUSTAINED_MS)
            .at(-1);
        if (seg) {
            top = Math.max(top, seg.band);
            low = Math.min(low, seg.band);
        }
    }
    if (top < 0) {
        return null;
    }
    return {
        lo: bands.bands[low].min * factor,
        Pmax: top >= bands.bands.length - 1 ? 0 : bands.bands[top].max * factor,
    };
}
function longestBelowTicks(s, from, to, level) {
    let best = 0;
    let run = 0;
    for (let i = Math.max(0, from); i <= Math.min(s.length - 1, to); i++) {
        run = s.valid[i] === 1 && s.last[i] < level ? run + s.stepMs : 0;
        best = Math.max(best, run);
    }
    return best;
}
function ruleOf(items, ctx, minCovered) {
    const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
    const poll = Math.max(1, ctx.pollSec);
    const G = Math.max(MIN_DIP_SEC, 2 * poll);
    const dataSec = items[0].series.stepMs / 1000;
    const scanDipMs = Math.max(MIN_DIP_SEC, 2 * dataSec) * 1000;
    const restVal = ctx.bands.runLimit * factor > 0 ? ctx.bands.runLimit * factor : ctx.base.standby * factor;
    const band = finalBandOf(items, ctx.bands, factor);
    if (band === null) {
        return null;
    }
    const Pmax = band.Pmax > 0 ? band.Pmax : Number.POSITIVE_INFINITY;
    let hi = Pmax;
    if (!Number.isFinite(hi)) {
        hi = 0;
        for (const it of items) {
            for (let i = it.info.from; i <= it.info.coreEnd; i++) {
                hi = Math.max(hi, it.series.last[i] || 0);
            }
        }
    }
    const floorMs = Math.max(OTHER_FLOOR_SEC, 2 * dataSec) * 1000;
    const scans = [];
    for (let lnP = Math.log(Math.max(restVal, band.lo)) + P_STEP; lnP < Math.log(hi); lnP += P_STEP) {
        scans.push(scanAt(items, 0, Math.exp(lnP), Pmax, scanDipMs, floorMs, ctx.bands, factor));
    }
    const best = Math.max(0, ...scans.map(x => x.covered));
    if (best < minCovered) {
        return null;
    }
    let range = null;
    let start = -1;
    scans.forEach((x, k) => {
        if (x.covered === best) {
            if (start < 0) {
                start = k;
            }
            if (!range || k - start > range[1] - range[0]) {
                range = [start, k];
            }
        }
        else {
            start = -1;
        }
    });
    const [a, b] = range;
    const pick = scans[(a + b) >> 1];
    const P = round4(pick.P);
    const first = scanAt(items, 0, P, Pmax, scanDipMs, floorMs, ctx.bands, factor);
    const begins = [];
    first.finals.forEach((f, k) => {
        if (f) {
            begins.push((f.from - items[k].info.from) * items[k].series.stepMs);
        }
    });
    const X = Math.round((AFTER_SHARE * quantile(begins, AFTER_Q)) / 1000);
    const at = scanAt(items, X * 1000, P, Pmax, scanDipMs, floorMs, ctx.bands, factor);
    const Y = Math.round(Math.sqrt(at.finalMs * at.otherMs) / 1000);
    let dipMs = 0;
    let progRest = 0;
    let tailRest = 0;
    let tailInBand = false;
    let hotOk = Number.isFinite(Pmax);
    const trailerVals = [];
    let gapMs = 0;
    items.forEach((it, k) => {
        const s = it.series;
        progRest = Math.max(progRest, longestBelowTicks(s, it.info.from, it.info.coreEnd, restVal));
        if (it.info.trailerFrom !== null && it.info.trailerTo !== null) {
            tailRest = Math.max(tailRest, longestBelowTicks(s, it.info.trailerFrom, it.info.trailerTo, restVal));
            const inBurst = (i) => it.info.bursts.some(x => i >= x.from && i <= x.to);
            for (let i = it.info.trailerFrom; i <= it.info.trailerTo; i++) {
                if (s.valid[i] === 1 && !inBurst(i)) {
                    trailerVals.push(s.last[i]);
                }
            }
        }
        const fin = at.finals[k];
        if (fin) {
            dipMs = Math.max(dipMs, longestBelowTicks(s, fin.from, fin.to, P));
            let rest = 0;
            const restTicks = Math.ceil(Math.max(MIN_REST_SEC, 3 * poll) / (s.stepMs / 1000));
            for (let i = fin.to + 1; i <= it.toIdx && rest < restTicks; i++) {
                if (s.valid[i] === 0) {
                    break;
                }
                const v = s.last[i];
                rest = v < restVal ? rest + 1 : 0;
                if (v >= Pmax) {
                    hotOk = false;
                }
                else if (v >= P && i > it.info.coreEnd) {
                    tailInBand = true;
                }
            }
        }
        const after = it.info.from + Math.ceil((X * 1000) / s.stepMs);
        const blocks = blocksOfRun(it, P, Pmax, scanDipMs, ctx.bands, factor).filter(x => x.from >= after);
        for (let j = 1; j < blocks.length; j++) {
            gapMs = Math.max(gapMs, (blocks[j].from - blocks[j - 1].to) * s.stepMs);
        }
    });
    const Z = Math.max(MIN_QUIET_SEC, (2 * dipMs) / 1000, 2 * poll);
    const restSec = Math.max(MIN_REST_SEC, 3 * poll, (2 * progRest) / 1000, (TIME_MARGIN * tailRest) / 1000);
    const tailLevel = trailerVals.length > 0 ? median(trailerVals) : 0;
    let actVal = round4(ACT_FACTOR * (tailLevel > 0 ? tailLevel : restVal));
    if (actVal < restVal || actVal >= P) {
        actVal = 0;
    }
    return {
        P,
        Pmax: Number.isFinite(Pmax) ? round4(Pmax) : 0,
        hot: hotOk && Number.isFinite(Pmax) ? round4(Pmax) : 0,
        X,
        Y,
        Z: Math.round(Z),
        G,
        restVal,
        restSec: Math.round(restSec),
        actVal,
        checkSec: Math.round(Math.max(MIN_CHECK_SEC, (TIME_MARGIN * gapMs) / 1000)),
        tailInBand,
    };
}
function valuesOf(r, lockSec, actShare) {
    return {
        finalMinVal: r.P,
        finalMaxVal: r.Pmax,
        finalHotVal: r.hot,
        finalAfterSec: r.X,
        finalMinSec: r.Y,
        finalQuietSec: r.Z,
        finalDipSec: r.G,
        finalRestVal: r.restVal,
        finalRestSec: r.restSec,
        finalActVal: actShare > 0 ? r.actVal : 0,
        finalActShare: actShare > 0 ? actShare : 0,
        finalCheckSec: Math.min(r.checkSec, lockSec),
        finalLockSec: lockSec,
    };
}
function replay(s, fromIdx, toIdx, settings, ctx, actVal = 0) {
    const det = createDetector(settings, { abort: ctx.abort, abortFixed: ctx.abortFixed, pollSec: s.stepMs / 1000 });
    const feed = settings.mode === "timed" ? det.feed?.bind(det) : undefined;
    const out = { starts: [], finished: [], aborted: 0, early: 0, actShare: 0 };
    const collect = (r, t) => {
        r.events.forEach((ev, k) => {
            const at = r.times?.[k] ?? t;
            if (ev === "started") {
                out.starts.push(at);
            }
            else if (ev === "finished") {
                out.finished.push(at);
            }
            else if (ev === "aborted") {
                out.aborted++;
            }
        });
    };
    const win = [];
    let winMs = 0;
    let aboveMs = 0;
    let prevVal = null;
    const step = s.stepMs;
    for (let i = fromIdx; i <= toIdx; i++) {
        const t = s.t0 + i * step;
        const last = s.last[i];
        if (feed && s.has[i] === 1) {
            if (s.max[i] > last) {
                collect(feed(s.max[i], t - step / 2), t - step / 2);
            }
            if (s.min[i] < last) {
                collect(feed(s.min[i], t - step / 4), t - step / 4);
            }
            collect(feed(last, t), t);
        }
        const wasSettling = det.settling === true;
        collect(det.tick(last, t, { switchOff: false }), t);
        if (actVal > 0 && wasSettling && det.settling === true && prevVal !== null) {
            const above = prevVal > actVal;
            win.push({ ms: step, above });
            winMs += step;
            aboveMs += above ? step : 0;
            while (winMs > ACT_WINDOW_MS) {
                const first = win.shift();
                winMs -= first.ms;
                aboveMs -= first.above ? first.ms : 0;
            }
            if (winMs >= ACT_WINDOW_MS) {
                out.actShare = Math.max(out.actShare, aboveMs / winMs);
            }
        }
        else if (det.settling !== true) {
            win.length = 0;
            winMs = 0;
            aboveMs = 0;
        }
        prevVal = last;
    }
    out.early = det.stats?.early ?? 0;
    return out;
}
function endInTime(it, f) {
    return f >= it.runEndT || (f > it.progEndT && it.runEndT - f <= DENSE_MIN_MS);
}
function judge(it, r) {
    const f = it.merged ? r.finished.at(-1) : r.finished[0];
    const wrong = f === undefined || r.starts.length === 0 || !endInTime(it, f);
    const phantom = !it.merged &&
        (r.starts.length > 1 || r.finished.length > 1 || r.aborted > 0 || r.starts.some(t => f !== undefined && t > f));
    return { wrong, phantom, delaySec: wrong ? Number.NaN : (f - it.runEndT) / 1000 };
}
function scaledSeries(s, k) {
    return { ...s, last: s.last.map(v => v * k), max: s.max.map(v => v * k), min: s.min.map(v => v * k) };
}
function coarseSeries(s, k, phase) {
    const n = Math.max(0, Math.floor((s.length - 1 - phase) / k) + 1);
    const last = new Float64Array(n);
    const max = new Float64Array(n);
    const min = new Float64Array(n);
    const has = new Uint8Array(n);
    const valid = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
        const i = phase + j * k;
        last[j] = s.last[i];
        let hi = s.last[i];
        let lo = s.last[i];
        let any = 0;
        let ok = 1;
        for (let x = Math.max(0, i - k + 1); x <= i; x++) {
            if (s.has[x] === 1) {
                any = 1;
                hi = Math.max(hi, s.max[x]);
                lo = Math.min(lo, s.min[x]);
            }
            if (s.valid[x] === 0) {
                ok = 0;
            }
        }
        max[j] = hi;
        min[j] = lo;
        has[j] = any;
        valid[j] = ok;
    }
    return {
        ...s,
        t0: s.t0 + phase * s.stepMs,
        stepMs: s.stepMs * k,
        length: n,
        last,
        max,
        min,
        has,
        valid,
        firstIdx: 0,
    };
}
function missingSeries(s, share, seed) {
    let a = seed >>> 0;
    const rnd = () => {
        a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
        return a / 0x100000000;
    };
    const last = s.last.slice();
    const max = s.max.slice();
    const min = s.min.slice();
    const has = s.has.slice();
    let held = s.last[0];
    for (let i = 0; i < s.length; i++) {
        if (s.has[i] === 1 && i > 0 && rnd() < share) {
            has[i] = 0;
            max[i] = held;
            min[i] = held;
        }
        else if (s.has[i] === 1) {
            held = s.last[i];
        }
        last[i] = held;
    }
    return { ...s, last, max, min, has };
}
function laterSeries(s) {
    return { ...s, t0: s.t0 + s.stepMs };
}
export async function learnFinal(runs, ctx) {
    const result = {
        values: zeroFinal(),
        ok: false,
        reasons: [],
        covered: 0,
        gainSec: 0,
        earlyEnds: 0,
        fallbacks: 0,
        perGroup: {},
    };
    if (ctx.scope === "continuous") {
        result.reasons.push("continuous");
        return result;
    }
    const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
    const items = itemsOf(runs);
    const finals = items.filter(it => admitted(it.verdict, "final"));
    const ends = items.filter(it => admitted(it.verdict, "end"));
    for (const it of finals) {
        result.perGroup[it.sample.family] = (result.perGroup[it.sample.family] ?? 0) + 1;
    }
    if (finals.length < ctx.minRuns) {
        result.reasons.push("tooFewRuns");
        return result;
    }
    if (Object.values(result.perGroup).some(n => n < ctx.minPerGroup)) {
        result.reasons.push("fewPerGroup");
        return result;
    }
    const rule = ruleOf(finals, ctx, ctx.minRuns);
    if (rule === null) {
        result.reasons.push("noSeparation");
        return result;
    }
    if (rule.tailInBand) {
        result.reasons.push("tailInBand");
    }
    const toUnit = (v) => ({
        ...v,
        finalMinVal: v.finalMinVal / factor,
        finalMaxVal: v.finalMaxVal / factor,
        finalHotVal: v.finalHotVal / factor,
        finalRestVal: v.finalRestVal / factor,
        finalActVal: v.finalActVal / factor,
    });
    result.values = toUnit(valuesOf(rule, MAX_LOCK_SEC, 0));
    if (finalViolations(result.values, ctx.base.standby, ctx.pollSec).length > 0) {
        result.reasons.push("outOfRange");
        return result;
    }
    if (result.reasons.length > 0) {
        return result;
    }
    const baseW = { ...inW(ctx.base, factor), ...zeroFinal() };
    const withFinal = (v) => ({ ...baseW, ...v });
    const baseSims = ends.map(it => replay(it.series, it.fromIdx, it.toIdx, baseW, ctx));
    const base = ends.map((it, k) => judge(it, baseSims[k]));
    const baseEnd = baseSims.map(r => r.finished[0]);
    await ctx.yieldFn();
    let longest = 0;
    ends.forEach((it, k) => {
        const r = replay(it.series, it.fromIdx, it.toIdx, withFinal(valuesOf(rule, MAX_LOCK_SEC, 0)), ctx);
        if (r.early > 0 && r.finished.length > 0 && baseEnd[k] !== undefined) {
            longest = Math.max(longest, baseEnd[k] - r.finished[0]);
        }
    });
    const lockSec = Math.round(Math.min(MAX_LOCK_SEC, Math.max(MIN_LOCK_SEC, (TIME_MARGIN * longest) / 1000)));
    await ctx.yieldFn();
    let share = 0;
    if (rule.actVal > 0) {
        for (const it of ends) {
            const r = replay(it.series, it.fromIdx, it.toIdx, withFinal(valuesOf(rule, lockSec, 0)), ctx, rule.actVal);
            share = Math.max(share, r.actShare);
        }
    }
    const actShare = rule.actVal > 0 && share <= ACT_SHARE_OFF
        ? Math.round(Math.min(ACT_SHARE_MAX, Math.max(ACT_SHARE_MIN, share + ACT_SHARE_ADD)) * 100) / 100
        : 0;
    const W = valuesOf(rule, lockSec, actShare);
    result.values = toUnit(W);
    if (finalViolations(result.values, ctx.base.standby, ctx.pollSec).length > 0) {
        result.reasons.push("outOfRange");
        return result;
    }
    await ctx.yieldFn();
    const add = (r) => {
        if (!result.reasons.includes(r)) {
            result.reasons.push(r);
        }
    };
    const settings = withFinal(W);
    let sumBase = 0;
    let sumCand = 0;
    let n = 0;
    const earlyOf = (sets) => ends.map((it, k) => {
        const j = judge(it, replay(it.series, it.fromIdx, it.toIdx, sets, ctx));
        return j.wrong && !base[k].wrong ? 1 : 0;
    });
    ends.forEach((it, k) => {
        const r = replay(it.series, it.fromIdx, it.toIdx, settings, ctx);
        const j = judge(it, r);
        const b = base[k];
        const worse = (j.wrong && !b.wrong) || (j.phantom && !b.phantom);
        if (j.wrong && !b.wrong) {
            result.earlyEnds++;
        }
        if (worse) {
            if (!it.clean) {
                add("worseOnFlagged");
            }
            else {
                add(j.wrong && !b.wrong ? "earlyEnd" : "phantomStart");
            }
        }
        if (r.early > 0 && !j.wrong && admitted(it.verdict, "final")) {
            result.covered++;
        }
        if (!j.wrong && !b.wrong) {
            sumBase += b.delaySec;
            sumCand += j.delaySec;
            n++;
        }
    });
    await ctx.yieldFn();
    if (result.covered < ctx.minRuns) {
        add("tooFewRuns");
    }
    const meanBase = n > 0 ? sumBase / n : 0;
    result.gainSec = n > 0 ? Math.round(meanBase - sumCand / n) : 0;
    if (result.gainSec < Math.max(GAIN_MIN_SEC, GAIN_SHARE * meanBase)) {
        add("noGain");
    }
    const groups = [...new Set(finals.map(it => it.sample.family))];
    const folds = groups.length >= GROUP_FOLDS_MIN
        ? groups.map(g => finals.filter(it => it.sample.family === g))
        : finals.map(it => [it]);
    for (const fold of folds) {
        const train = finals.filter(it => !fold.includes(it));
        const r = train.length > 0 ? ruleOf(train, ctx, 1) : null;
        for (const it of fold) {
            const k = ends.indexOf(it);
            if (r === null) {
                result.fallbacks++;
                continue;
            }
            const sim = replay(it.series, it.fromIdx, it.toIdx, withFinal({ ...valuesOf(r, lockSec, actShare), finalCheckSec: W.finalCheckSec }), ctx);
            const j = judge(it, sim);
            if (j.wrong && !(k >= 0 && base[k].wrong)) {
                add("crossCheck");
            }
            else if (sim.early === 0) {
                result.fallbacks++;
            }
        }
        await ctx.yieldFn();
    }
    const variants = [
        ...ROBUST_SCALES.map(k => (s) => scaledSeries(s, k)),
        ...ROBUST_POLLS.filter(k => (k * (ends[0]?.series.stepMs ?? 0)) / 1000 <= MAX_POLL_SEC).map(k => (s) => coarseSeries(s, k, 0)),
        (s) => missingSeries(s, ROBUST_MISSING, 5),
        laterSeries,
    ];
    for (const make of variants) {
        const cache = new Map();
        for (const it of ends) {
            let v = cache.get(it.series);
            if (!v) {
                v = make(it.series);
                cache.set(it.series, v);
            }
            const from = Math.max(0, idxOf(v, it.series.t0 + it.fromIdx * it.series.stepMs));
            const to = Math.min(v.length - 1, idxOf(v, it.series.t0 + it.toIdx * it.series.stepMs));
            const bj = judge(it, replay(v, from, to, baseW, ctx));
            const j = judge(it, replay(v, from, to, settings, ctx));
            if (j.wrong && !bj.wrong) {
                add("robustness");
            }
        }
        await ctx.yieldFn();
    }
    const early0 = result.earlyEnds;
    for (const m of MARGIN_FACTORS) {
        const e = earlyOf(withFinal({ ...W, finalMinVal: W.finalMinVal * m })).reduce((x, y) => x + y, 0);
        if (e !== early0) {
            add("margin");
        }
    }
    await ctx.yieldFn();
    result.ok = result.reasons.length === 0;
    return result;
}
function longestBelow(points, from, to, level) {
    let best = 0;
    let run = 0;
    for (let k = 0; k < points.length; k++) {
        const a = Math.max(points[k].ts, from);
        const b = Math.min(k + 1 < points.length ? points[k + 1].ts : to, to);
        if (b <= a) {
            continue;
        }
        run = points[k].val < level ? run + (b - a) : 0;
        best = Math.max(best, run);
    }
    return best;
}
function joined(a, b) {
    const all = [...a.points, ...b.points].sort((x, y) => x.ts - y.ts);
    return all.filter((p, k) => k === 0 || p.ts !== all[k - 1].ts);
}
function startBands(u, start, bands) {
    const to = Math.min(u.to, start + START_MS);
    const core = { points: u.points, from: start, to: Math.max(start, to) };
    return new Set(bandSegmentsOf(core, bands).map(x => x.band));
}
export function checkFinalSplit(prev, next, clean, bands, finalRestVal) {
    const runs = clean.filter(c => c.kind === "run");
    const between = longestBelow(joined(prev, next), prev.facts.end, next.facts.start, finalRestVal);
    if (runs.length < SPLIT_MIN_RUNS || bands === null || bands.bands.length === 0) {
        return (between <=
            Math.max(SPLIT_REST_MIN_MS, longestBelow(prev.points, prev.facts.start, prev.facts.end, finalRestVal)));
    }
    const count = new Map();
    for (const r of runs) {
        for (const b of startBands(r, r.facts.start, bands)) {
            count.set(b, (count.get(b) ?? 0) + 1);
        }
    }
    const typical = [...count].filter(([, c]) => c >= START_SHARE * runs.length).map(([b]) => b);
    const own = startBands(next, next.facts.start, bands);
    if (typical.some(b => !own.has(b))) {
        return true;
    }
    let longest = SPLIT_REST_MIN_MS;
    for (const r of runs) {
        longest = Math.max(longest, longestBelow(r.points, r.facts.start, r.facts.coreEnd, finalRestVal));
    }
    return between <= longest;
}
//# sourceMappingURL=finalLearn.js.map