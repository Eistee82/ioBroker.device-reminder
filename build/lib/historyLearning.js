import { analyzeTicks } from "./learn/analyze.js";
import { baseBandsOf } from "./learn/bands.js";
import { cleanPoints } from "./learn/clean.js";
import { admitted, checkRuns, primaryOf, runSamples } from "./learn/quality.js";
import { fromPoints } from "./learn/ticks.js";
export { DELAY_TOLERANCE_SEC, HISTORY_DAYS, MIN_RUNS, pickMode } from "./learn/analyze.js";
const RUN_CHECK_MIN_RUNS = 8;
const BANDS_MIN_RUNS = 3;
function counts(x, v) {
    if (x.kind === "spike") {
        return admitted(v, "start");
    }
    return x.kind === "run" && admitted(v, "end") && !v.reasons.some(r => r.code === "merged");
}
function verdictsOf(samples, runLimit, ctx) {
    const first = checkRuns(samples, { ...ctx, bands: null });
    const clean = samples.filter((x, k) => x.kind === "run" && admitted(first[k], "phases"));
    if (clean.length < BANDS_MIN_RUNS) {
        return first;
    }
    return checkRuns(samples, { ...ctx, bands: baseBandsOf(clean, runLimit) });
}
export function heldBackOf(points, pollSec, unitFactor, templatePeakW) {
    const factor = unitFactor > 0 ? unitFactor : 1;
    const stepMs = Math.max(pollSec, 1) * 1000;
    const { samples, layout, clean } = runSamples("history", points, { stepMs, src: "history", unitFactor: factor });
    if (layout.runs.length < RUN_CHECK_MIN_RUNS) {
        return { spans: [], points: clean.points };
    }
    const verdicts = verdictsOf(samples, layout.runLimit / factor, {
        unitFactor: factor,
        unit: factor === 1000 ? "kW" : "W",
        settings: null,
        pollMs: stepMs,
        outages: [],
        scope: "run",
        ...(templatePeakW !== undefined ? { templatePeakW } : {}),
    });
    const spans = samples
        .map((x, k) => ({ x, v: verdicts[k] }))
        .filter(({ x, v }) => !counts(x, v))
        .map(({ x, v }) => ({
        from: x.facts.start - stepMs,
        to: Math.max(x.facts.end, x.facts.runEnd) + stepMs,
        code: primaryOf(v.reasons),
    }))
        .sort((a, b) => a.from - b.from);
    return { spans, points: clean.points };
}
export function withoutSpans(points, spans) {
    if (spans.length === 0) {
        return [...points];
    }
    const out = [];
    let k = 0;
    let held = points.length > 0 ? points[0].val : 0;
    let entered = -1;
    for (const p of points) {
        while (k < spans.length && spans[k].to <= p.ts) {
            k++;
        }
        const d = spans[k];
        if (d && p.ts >= d.from) {
            if (entered !== k) {
                out.push({ ts: d.from, val: held });
                entered = k;
            }
            continue;
        }
        out.push(p);
        held = p.val;
    }
    return out;
}
export async function analyzeHistory(input, pollIntervalSec, opts = {}) {
    const poll = Math.max(pollIntervalSec, 1);
    let series;
    if (Array.isArray(input)) {
        const factor = opts.unitFactor && opts.unitFactor > 0 ? opts.unitFactor : 1;
        const raw = input;
        let kept = raw;
        if (opts.heldBack) {
            kept = withoutSpans(cleanPoints(raw).points, opts.heldBack);
        }
        else if (!opts.recording) {
            const held = heldBackOf(raw, poll, factor, opts.templatePeakW);
            kept = withoutSpans(held.points, held.spans);
        }
        series = fromPoints(kept.map(p => ({ ts: p.ts, val: p.val * factor })), poll * 1000);
    }
    else {
        series = input;
    }
    return analyzeTicks(series, poll, opts);
}
//# sourceMappingURL=historyLearning.js.map