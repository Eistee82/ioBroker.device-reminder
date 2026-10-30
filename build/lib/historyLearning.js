import { analyzeTicks } from "./learn/analyze.js";
import { fromPoints } from "./learn/ticks.js";
export { DELAY_TOLERANCE_SEC, HISTORY_DAYS, MIN_RUNS, pickMode } from "./learn/analyze.js";
export async function analyzeHistory(input, pollIntervalSec, opts = {}) {
    const poll = Math.max(pollIntervalSec, 1);
    let series;
    if (Array.isArray(input)) {
        const factor = opts.unitFactor && opts.unitFactor > 0 ? opts.unitFactor : 1;
        const points = input.map(p => ({ ts: p.ts, val: p.val * factor }));
        series = fromPoints(points, poll * 1000);
    }
    else {
        series = input;
    }
    return analyzeTicks(series, poll, opts);
}
//# sourceMappingURL=historyLearning.js.map