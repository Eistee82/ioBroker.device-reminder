import { createDetector } from "./detector/index.js";
export const HISTORY_DAYS = 30;
const MAX_PAUSE_MS = 30 * 60_000;
const MIN_ACTIVE_MS = 5 * 60_000;
const PAD_BEFORE_MS = 30 * 60_000;
const PAD_AFTER_MS = 3 * 60 * 60_000;
const MAX_WINDOWS = 20;
const MIN_RUNS = 2;
const DELAY_TOLERANCE_SEC = 60;
const END_FACTORS = [1, 1.5, 2, 3];
const MODE_ORDER = ["count", "combined", "timed"];
function median(values) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function round2(v) {
    return Math.round(v * 100) / 100;
}
function resample(points, from, stepMs, count) {
    const out = new Array(count);
    let idx = 0;
    let value = points[0].val;
    for (let i = 0; i < count; i++) {
        const t = from + i * stepMs;
        while (idx < points.length && points[idx].ts <= t) {
            value = points[idx].val;
            idx++;
        }
        out[i] = value;
    }
    return out;
}
function segments(ticks, limit, maxGap) {
    const out = [];
    let current = null;
    for (let i = 0; i < ticks.length; i++) {
        if (ticks[i] <= limit) {
            continue;
        }
        if (current && i - current.to - 1 <= maxGap) {
            current.to = i;
            current.active++;
        }
        else {
            current = { from: i, to: i, active: 1 };
            out.push(current);
        }
    }
    return out;
}
function longestDip(ticks, seg, endVal) {
    let longest = 0;
    let current = 0;
    for (let i = seg.from; i <= seg.to; i++) {
        current = ticks[i] < endVal ? current + 1 : 0;
        longest = Math.max(longest, current);
    }
    return longest;
}
function simulate(points, win, stepMs, settings) {
    const detector = createDetector(settings, { abort: false, abortFixed: false });
    const feed = settings.mode === "timed" ? detector.feed?.bind(detector) : undefined;
    let idx = points.findIndex(p => p.ts > win.from);
    if (idx < 0) {
        idx = points.length;
    }
    let value = idx > 0 ? points[idx - 1].val : points[0].val;
    let started = 0;
    const finished = [];
    const collect = (events, t) => {
        for (const ev of events) {
            if (ev === "started") {
                started++;
            }
            else if (ev === "finished") {
                finished.push(t);
            }
        }
    };
    for (let t = win.from; t <= win.to; t += stepMs) {
        while (idx < points.length && points[idx].ts <= t) {
            value = points[idx].val;
            if (feed) {
                collect(feed(value, points[idx].ts).events, points[idx].ts);
            }
            idx++;
        }
        collect(detector.tick(value, t).events, t);
    }
    return { started, finished };
}
function evaluate(points, windows, stepMs, settings) {
    let detected = 0;
    let falseStarts = 0;
    let delaySum = 0;
    let runs = 0;
    for (const win of windows) {
        const res = simulate(points, win, stepMs, settings);
        if (win.runEnd === null) {
            falseStarts += res.started;
            continue;
        }
        runs++;
        if (res.started === 1 && res.finished.length === 1 && res.finished[0] >= win.runEnd) {
            detected++;
            delaySum += (res.finished[0] - win.runEnd) / 1000;
        }
    }
    return {
        mode: settings.mode,
        detected,
        runs,
        falseStarts,
        endDelaySec: detected > 0 ? Math.round(delaySum / detected) : 0,
    };
}
function compare(a, b) {
    return b.detected - a.detected || a.falseStarts - b.falseStarts || a.endDelaySec - b.endDelaySec;
}
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
export function analyzeHistory(raw, pollIntervalSec) {
    const points = raw.filter(p => Number.isFinite(p.ts) && Number.isFinite(p.val)).sort((a, b) => a.ts - b.ts);
    if (points.length < 20) {
        return { error: "noHistory" };
    }
    const poll = Math.max(pollIntervalSec, 1);
    const stepMs = poll * 1000;
    const first = points[0].ts;
    const count = Math.floor((points[points.length - 1].ts - first) / stepMs) + 1;
    const ticks = resample(points, first, stepMs, count);
    const at = (i) => first + i * stepMs;
    const runLimit = median(ticks) * 3 + 2;
    const all = segments(ticks, runLimit, Math.floor(MAX_PAUSE_MS / stepMs));
    const isRun = (s) => s.active * stepMs >= MIN_ACTIVE_MS;
    const runs = all.filter(isRun).slice(-MAX_WINDOWS);
    if (runs.length < MIN_RUNS) {
        return { error: "tooFewRuns", runs: runs.length };
    }
    const tail = [];
    for (const run of runs) {
        const next = all.find(s => s.from > run.to);
        const end = Math.min(run.to + Math.ceil(PAD_BEFORE_MS / stepMs), next ? next.from - 1 : count - 1);
        tail.push(...ticks.slice(run.to + 1, end + 1));
    }
    const idle = tail.length > 0 ? median(tail) : median(ticks);
    const endVal = round2(Math.max(idle * 1.5, idle + 1));
    const standby = round2(idle * 1.2 + 0.1);
    const runPower = runs.map(r => median(ticks.slice(r.from, r.to + 1).filter(p => p > runLimit)));
    const startVal = round2(Math.max(idle + 5, 0.25 * Math.min(...runPower)));
    const dip = Math.max(...runs.map(r => longestDip(ticks, r, endVal)));
    const windows = [];
    const spikes = all.filter(s => !isRun(s)).slice(-MAX_WINDOWS);
    for (const seg of [...runs, ...spikes]) {
        const idx = all.indexOf(seg);
        const prev = all[idx - 1];
        const next = all[idx + 1];
        windows.push({
            from: Math.max(at(seg.from) - PAD_BEFORE_MS, prev ? at(prev.to + 1) : first),
            to: Math.min(at(seg.to) + PAD_AFTER_MS, next ? at(next.from - 1) : at(count - 1)),
            runEnd: isRun(seg) ? at(seg.to) : null,
        });
    }
    const thresholds = { startVal, endVal, standby };
    const baseCount = Math.max(2, Math.ceil((dip + 3) * 1.5));
    const baseDurationSec = baseCount * poll;
    const startDurations = [...new Set([2 * poll, Math.max(60, 3 * poll)])];
    const candidates = [];
    for (const f of END_FACTORS) {
        const endCount = Math.ceil(baseCount * f);
        const endDurationSec = Math.ceil(baseDurationSec * f);
        for (const startCount of [2, 3]) {
            candidates.push({
                ...thresholds,
                mode: "count",
                startCount,
                endCount,
                startDurationSec: startCount * poll,
                endDurationSec: endCount * poll,
            });
        }
        for (const startDurationSec of startDurations) {
            const shared = { ...thresholds, startCount: 2, startDurationSec, endDurationSec };
            candidates.push({ ...shared, mode: "timed", endCount: baseCount });
            candidates.push({ ...shared, mode: "combined", endCount: baseCount });
        }
    }
    const best = new Map();
    for (const settings of candidates) {
        const evaluation = evaluate(points, windows, stepMs, settings);
        const known = best.get(settings.mode);
        if (!known || compare(evaluation, known.evaluation) < 0) {
            best.set(settings.mode, { settings, evaluation });
        }
    }
    const evaluation = MODE_ORDER.map(m => best.get(m)?.evaluation).filter(e => e !== undefined);
    const mode = pickMode(evaluation);
    const chosen = best.get(mode)?.settings ?? candidates[0];
    return {
        thresholds: {
            startVal: chosen.startVal,
            endVal: chosen.endVal,
            standby: chosen.standby,
            startCount: chosen.startCount,
            endCount: chosen.endCount,
        },
        startDurationSec: chosen.startDurationSec,
        endDurationSec: chosen.endDurationSec,
        durationSec: Math.max(...runs.map(r => Math.round(((r.to - r.from) * stepMs) / 1000))),
        samples: points.length,
        mode,
        runs: runs.length,
        evaluation,
    };
}
//# sourceMappingURL=historyLearning.js.map