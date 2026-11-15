import { analyzeTicks } from "./learn/analyze.js";
import { checkRuns, runSamples } from "./learn/quality.js";
import { PAD_AFTER_MS } from "./learn/runs.js";
import { fromPoints } from "./learn/ticks.js";
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;
const MAX_SAMPLES = 10_000;
export class LearningRecorder {
    samples = [];
    startedAt = 0;
    running = false;
    get active() {
        return this.running;
    }
    get sampleCount() {
        return this.samples.length;
    }
    start(now) {
        this.samples = [];
        this.startedAt = now;
        this.running = true;
    }
    add(p, now) {
        if (!this.running) {
            return;
        }
        const t = now - this.startedAt;
        if (t > MAX_DURATION_MS) {
            this.running = false;
            return;
        }
        this.samples.push({ t, p });
        if (this.samples.length >= MAX_SAMPLES) {
            this.running = false;
        }
    }
    stop(_now) {
        this.running = false;
        return this.samples.slice();
    }
}
export async function suggestType(samples, pollIntervalSec, opts = {}) {
    if (samples.length < 20) {
        return { error: "tooFewSamples" };
    }
    const poll = Math.max(pollIntervalSec, 1);
    const factor = opts.unitFactor && opts.unitFactor > 0 ? opts.unitFactor : 1;
    const series = fromPoints(samples.map(s => ({ ts: s.t, val: s.p * factor })), poll * 1000, PAD_AFTER_MS);
    const result = await analyzeTicks(series, poll, { ...opts, minRuns: 1, recording: true });
    if ("error" in result || !result.evaluation.some(e => e.detected > 0)) {
        return { error: "noRun" };
    }
    return result;
}
export function recordingChecks(samples, pollIntervalSec, unitFactor = 1) {
    const stepMs = Math.max(pollIntervalSec, 1) * 1000;
    const { samples: found } = runSamples("recording", samples.map(s => ({ ts: s.t, val: s.p })), { stepMs, src: "live", unitFactor });
    const verdicts = checkRuns(found, {
        bands: null,
        unitFactor,
        unit: unitFactor === 1000 ? "kW" : "W",
        settings: null,
        pollMs: stepMs,
        outages: [],
        scope: "run",
    });
    const out = new Set();
    for (const v of verdicts) {
        for (const r of v.reasons) {
            if (r.code === "invalid" || (r.code === "gap" && r.detail.startsWith("proven"))) {
                out.add(r.code);
            }
        }
    }
    return [...out];
}
//# sourceMappingURL=learning.js.map