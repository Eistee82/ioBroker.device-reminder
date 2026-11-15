import type { DetectionSettings } from "./detector/types.js";
import type { Layout } from "./learn/runs.js";
import { simulate } from "./learn/replay.js";
import type { TickSeries } from "./learn/ticks.js";
import { scaled } from "./learn/ticks.js";
import type { Capture } from "./runRecorder.js";
import type { StoredRun } from "./runStore.js";
import { labelCapture } from "./runStore.js";

/** What `storedRunsOfHistory` needs to know about the device. */
export interface HistoryRunsOptions {
	/** Values in use (unit of the state): their events label the runs. */
	eff: DetectionSettings;
	/** Abort detection. */
	abort: boolean;
	/** Corrected abort detection. */
	abortFixed: boolean;
	/** Poll interval in s. */
	pollSec: number;
	/** W per unit of the state. */
	unitFactor: number;
	/** Runs for which this returns true are left out (start in ms). */
	skip?: (startMs: number) => boolean;
	/** Called between two runs so that other work can run. */
	yieldFn?: () => Promise<void>;
}

/**
 * Stored runs and false starts of a history (Spec D.2): every run of the layout is replayed with the values in use to
 * get the events the runtime would have seen, then labelled like a recorded run. The keys are set by `addRun`.
 *
 * @param series - Series in W
 * @param layout - Layout of the series (all runs)
 * @param o - Device and options
 * @returns stored runs in the order of the layout windows (`label` tells run from false start)
 */
export async function storedRunsOfHistory(
	series: TickSeries,
	layout: Layout,
	o: HistoryRunsOptions,
): Promise<StoredRun[]> {
	const factor = o.unitFactor;
	const sim = factor === 1 ? series : scaled(series, 1 / factor);
	const out: StoredRun[] = [];
	for (const w of [...layout.windows].sort((a, b) => a.fromIdx - b.fromIdx)) {
		const startMs = series.t0 + w.runStartIdx * series.stepMs;
		if (o.skip?.(startMs)) {
			continue;
		}
		const cells = [];
		// ticks with a stored value: the report times of a history run
		const rep: number[] = [];
		for (let i = w.fromIdx; i <= w.toIdx; i++) {
			cells.push({ min: sim.min[i], max: sim.max[i], last: sim.last[i], valid: sim.valid[i] === 1 });
			if (series.has[i] === 1) {
				rep.push((i - w.fromIdx) * series.stepMs);
			}
		}
		const r = simulate(sim, w, o.eff, { abort: o.abort, abortFixed: o.abortFixed, pollSec: o.pollSec });
		const ev: Capture["ev"] = [
			...r.startedAt.map((t): [number, "s"] => [t, "s"]),
			...r.finished.map((t): [number, "f"] => [t, "f"]),
		];
		ev.sort((a, b) => a[0] - b[0]);
		const cap: Capture = {
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
