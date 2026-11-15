import type { AnalyzeOptions, HistoryLearningError, HistorySuggestion } from "./learn/analyze.js";
import { analyzeTicks } from "./learn/analyze.js";
import { baseBandsOf } from "./learn/bands.js";
import type { QualityCode, QualityContext, RunSample, Verdict } from "./learn/quality.js";
import { cleanPoints } from "./learn/clean.js";
import { admitted, checkRuns, primaryOf, runSamples } from "./learn/quality.js";
import type { HistoryPoint, TickSeries } from "./learn/ticks.js";
import { fromPoints } from "./learn/ticks.js";

export type { AnalyzeOptions, HistoryLearningError, HistorySuggestion } from "./learn/analyze.js";
export { DELAY_TOLERANCE_SEC, HISTORY_DAYS, MIN_RUNS, pickMode } from "./learn/analyze.js";
export type { ModeEvaluation } from "./learn/replay.js";
export type { HistoryPoint, TickSeries } from "./learn/ticks.js";

/**
 * Runs are held back from the suggestion only with at least this many runs (as many as a tightening of the automatic
 * optimisation needs): the run check compares runs with each other, and with a few runs a real programme of its own
 * (another heating, a short programme) looks like a foreign load or a manual test; leaving it out would let the
 * suggestion end it too early.
 */
const RUN_CHECK_MIN_RUNS = 8;
/** Base bands need at least this many clean runs. */
const BANDS_MIN_RUNS = 3;

/**
 * Whether a sample counts for the suggestion: a run admitted for the end that did not grow together from two runs
 * (a merged run counts only for the end of the whole run, not for pauses, durations and limits), a short activity
 * admitted for the start values.
 *
 * @param x - Sample
 * @param v - Verdict
 */
function counts(x: RunSample, v: Verdict): boolean {
	if (x.kind === "spike") {
		return admitted(v, "start");
	}
	return x.kind === "run" && admitted(v, "end") && !v.reasons.some(r => r.code === "merged");
}

/**
 * Verdicts of the run check over the stored values of a history (Spec B.2): first without bands, then with the
 * base bands of the runs admitted for phases (at least three).
 *
 * @param samples - Samples (`runSamples`)
 * @param runLimit - Run level in the unit of the state
 * @param ctx - Context without bands
 */
function verdictsOf(samples: RunSample[], runLimit: number, ctx: Omit<QualityContext, "bands">): Verdict[] {
	const first = checkRuns(samples, { ...ctx, bands: null });
	const clean = samples.filter((x, k) => x.kind === "run" && admitted(first[k], "phases"));
	if (clean.length < BANDS_MIN_RUNS) {
		return first;
	}
	return checkRuns(samples, { ...ctx, bands: baseBandsOf(clean, runLimit) });
}

/** A stretch of stored values held back by the run check (ms). */
export interface HeldBack {
	/** Begin. */
	from: number;
	/** End (exclusive). */
	to: number;
	/** Deciding finding (`primaryOf`), or null. */
	code: QualityCode | null;
}

/**
 * Stretches of stored values that the run check holds back from the suggestion (Spec B.2, B.3): runs in
 * quarantine, unusable runs and runs grown together, short activities held back for the start values (manual
 * tests). With fewer than RUN_CHECK_MIN_RUNS runs nothing is held back.
 *
 * @param points - Stored values in the unit of the state (any order, invalid values allowed)
 * @param pollSec - Poll interval in s
 * @param unitFactor - W per unit of the state
 * @param templatePeakW - Typical peak of the chosen template in W (unit check), if known
 * @returns stretches sorted by time, and the cleaned values
 */
export function heldBackOf(
	points: readonly HistoryPoint[],
	pollSec: number,
	unitFactor: number,
	templatePeakW?: number,
): { spans: HeldBack[]; points: HistoryPoint[] } {
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
			// a stored value belongs to the tick after it: the stretch begins one poll before the first active tick
			from: x.facts.start - stepMs,
			to: Math.max(x.facts.end, x.facts.runEnd) + stepMs,
			code: primaryOf(v.reasons),
		}))
		.sort((a, b) => a.from - b.from);
	return { spans, points: clean.points };
}

/**
 * Stored values with stretches taken out: each stretch keeps the value held before it, as if the device had not
 * run there.
 *
 * @param points - Stored values sorted by time
 * @param spans - Stretches sorted by time
 */
export function withoutSpans(
	points: readonly HistoryPoint[],
	spans: readonly { from: number; to: number }[],
): HistoryPoint[] {
	if (spans.length === 0) {
		return [...points];
	}
	const out: HistoryPoint[] = [];
	let k = 0;
	let held = points.length > 0 ? points[0].val : 0;
	let entered = -1;
	for (const p of points) {
		while (k < spans.length && spans[k].to <= p.ts) {
			k++;
		}
		const d = spans[k];
		if (d && p.ts >= d.from) {
			// inside a stretch: the value before it goes on up to the next value after it
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

/**
 * Derive one device type from the runs stored in the history of the power state. The type has to
 * detect every run, whatever programme was used: end threshold, end waiting time and an optional
 * pause protection are chosen so that every run is detected exactly once and the end is reported as
 * early as possible; every candidate is checked by running the real detectors over all runs. Stored
 * values pass the run check first (Spec B.2): runs held back by it (quarantine, unusable, grown together)
 * and manual tests change no value.
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
		const raw = input as readonly HistoryPoint[];
		let kept: readonly HistoryPoint[] = raw;
		if (opts.heldBack) {
			kept = withoutSpans(cleanPoints(raw).points, opts.heldBack);
		} else if (!opts.recording) {
			const held = heldBackOf(raw, poll, factor, opts.templatePeakW);
			kept = withoutSpans(held.points, held.spans);
		}
		series = fromPoints(
			kept.map(p => ({ ts: p.ts, val: p.val * factor })),
			poll * 1000,
		);
	} else {
		series = input as TickSeries;
	}
	return analyzeTicks(series, poll, opts);
}
