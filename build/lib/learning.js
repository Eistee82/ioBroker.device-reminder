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
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function round2(v) {
    return Math.round(v * 100) / 100;
}
export function suggestType(samples, pollIntervalSec) {
    if (samples.length < 20) {
        return { error: "tooFewSamples" };
    }
    const tailCount = Math.max(3, Math.ceil(samples.length * 0.1));
    const idle = median(samples.slice(-tailCount).map(s => s.p));
    const runLimit = idle * 3 + 2;
    const runIdx = [];
    samples.forEach((s, i) => {
        if (s.p > runLimit) {
            runIdx.push(i);
        }
    });
    if (runIdx.length < 6) {
        return { error: "noRun" };
    }
    const startVal = round2(Math.max(idle + 5, 0.25 * median(runIdx.map(i => samples[i].p))));
    const endVal = round2(Math.max(idle * 1.5, idle + 1));
    const standby = round2(idle * 1.2 + 0.1);
    let longestDip = 0;
    let current = 0;
    for (let i = runIdx[0]; i <= runIdx[runIdx.length - 1]; i++) {
        if (samples[i].p < endVal) {
            current++;
            longestDip = Math.max(longestDip, current);
        }
        else {
            current = 0;
        }
    }
    const endCount = Math.max(2, Math.ceil((longestDip + 3) * 1.5));
    const startCount = 2;
    const lastRun = samples[runIdx[runIdx.length - 1]];
    const firstRun = samples[runIdx[0]];
    return {
        thresholds: { startVal, endVal, standby, startCount, endCount },
        startDurationSec: startCount * pollIntervalSec,
        endDurationSec: endCount * pollIntervalSec,
        durationSec: Math.round((lastRun.t - firstRun.t) / 1000),
        samples: samples.length,
    };
}
//# sourceMappingURL=learning.js.map