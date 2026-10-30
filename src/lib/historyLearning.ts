import type { AnalyzeOptions, HistoryLearningError, HistorySuggestion } from "./learn/analyze.js";
import { analyzeTicks } from "./learn/analyze.js";
import type { HistoryPoint, TickSeries } from "./learn/ticks.js";
import { fromPoints } from "./learn/ticks.js";

export type { AnalyzeOptions, HistoryLearningError, HistorySuggestion } from "./learn/analyze.js";
export { DELAY_TOLERANCE_SEC, HISTORY_DAYS, MIN_RUNS, pickMode } from "./learn/analyze.js";
export type { ModeEvaluation } from "./learn/replay.js";
export type { HistoryPoint, TickSeries } from "./learn/ticks.js";

/**
 * Derive one device type from the runs stored in the history of the power state. The type has to
 * detect every run, whatever programme was used: end threshold, end waiting time and an optional
 * pause protection are chosen so that every run is detected exactly once and the end is reported as
 * early as possible; every candidate is checked by running the real detectors over all runs.
 *
 * @param input - Stored values (unit of the state, any order) or a series in W from `loadHistorySeries`
 * @param pollIntervalSec - Poll interval in seconds
 * @param opts - Options (device options, unit, deadband, current type, progress)
 */
export async function analyzeHistory(
	input: readonly HistoryPoint[] | TickSeries,
	pollIntervalSec: number,
	opts: AnalyzeOptions = {},
): Promise<HistorySuggestion | HistoryLearningError> {
	const poll = Math.max(pollIntervalSec, 1);
	let series: TickSeries;
	if (Array.isArray(input)) {
		const factor = opts.unitFactor && opts.unitFactor > 0 ? opts.unitFactor : 1;
		const points = (input as readonly HistoryPoint[]).map(p => ({ ts: p.ts, val: p.val * factor }));
		series = fromPoints(points, poll * 1000);
	} else {
		series = input as TickSeries;
	}
	return analyzeTicks(series, poll, opts);
}
