import { simulate } from "./learn/replay.js";
import { scaled } from "./learn/ticks.js";
import { labelCapture } from "./runStore.js";
export async function storedRunsOfHistory(series, layout, o) {
    const factor = o.unitFactor;
    const sim = factor === 1 ? series : scaled(series, 1 / factor);
    const out = [];
    for (const w of [...layout.windows].sort((a, b) => a.fromIdx - b.fromIdx)) {
        const startMs = series.t0 + w.runStartIdx * series.stepMs;
        if (o.skip?.(startMs)) {
            continue;
        }
        const cells = [];
        const rep = [];
        for (let i = w.fromIdx; i <= w.toIdx; i++) {
            cells.push({ min: sim.min[i], max: sim.max[i], last: sim.last[i], valid: sim.valid[i] === 1 });
            if (series.has[i] === 1) {
                rep.push((i - w.fromIdx) * series.stepMs);
            }
        }
        const r = simulate(sim, w, o.eff, { abort: o.abort, abortFixed: o.abortFixed, pollSec: o.pollSec });
        const ev = [
            ...r.startedAt.map((t) => [t, "s"]),
            ...r.finished.map((t) => [t, "f"]),
        ];
        ev.sort((a, b) => a[0] - b[0]);
        const cap = {
            t0: series.t0 + w.fromIdx * series.stepMs,
            stepMs: series.stepMs,
            unitFactor: factor,
            cells,
            ev,
            postTruncated: false,
            rep,
        };
        const res = labelCapture(cap, o.eff.endVal * factor, "history");
        if (res.run) {
            out.push(res.run);
        }
        await o.yieldFn?.();
    }
    return out;
}
//# sourceMappingURL=historyRuns.js.map