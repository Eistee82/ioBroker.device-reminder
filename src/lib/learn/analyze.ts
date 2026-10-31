import { TRAILER_MAX_DEFAULT_SEC } from "../detector/trailer.js";
import type { DetectionMode, DetectionSettings } from "../detector/types.js";
import type { LearningSuggestion } from "../learning.js";
import type { GuardSettings, Plan, PlanContext, RunTable, TrailerParams } from "./optimize.js";
import { endCandidates, planFor, runTable, suppressBursts } from "./optimize.js";
import type { ModeEvaluation, ReplayOptions, SimResult } from "./replay.js";
import { allOk, compare, evaluate, runOkFull, simulate } from "./replay.js";
import type { Layout, RunInfo, Span, Window } from "./runs.js";
import { buildLayout, median } from "./runs.js";
import type { TickSeries } from "./ticks.js";
import { scaled } from "./ticks.js";

/** Errors of the analysis. */
export type HistoryLearningError =
	{ error: "noHistory" } | { error: "tooFewRuns"; runs: number } | { error: "energyCounter" };

/** Suggestion derived from the runs; mode, runs and evaluation are always set. */
export type HistorySuggestion = LearningSuggestion & Required<Pick<LearningSuggestion, "mode" | "runs" | "evaluation">>;

/** Options of the analysis. */
export interface AnalyzeOptions {
	/** Abort detection of the device. */
	abort?: boolean;
	/** Corrected abort detection of the device. */
	abortFixed?: boolean;
	/** Factor from the unit of the state to W (kW: 1000). */
	unitFactor?: number;
	/** Deadband of the history adapter (`changesMinDelta`) in the unit of the state. */
	minDelta?: number;
	/**
	 * Current device type (unit of the state), evaluated over the same runs. A raised phase after a
	 * run (drying) belongs to the run if this type keeps running there (level >= its endVal).
	 */
	currentType?: DetectionSettings;
	/** Minimum number of runs (default 2). */
	minRuns?: number;
	/** Recording of one run instead of a history. */
	recording?: boolean;
	/** Called regularly so that other work can run. */
	yieldFn?: () => Promise<void>;
	/** Progress 0..1. */
	onProgress?: (fraction: number) => void;
}

/** Days of history that are analysed. */
export const HISTORY_DAYS = 30;
/** Minimum number of runs in the history. */
export const MIN_RUNS = 2;
/** End delays closer than this count as equal (then the 3.1.2 count mode wins). */
export const DELAY_TOLERANCE_SEC = 60;
const MODE_ORDER: readonly DetectionMode[] = ["count", "combined", "timed"];
const NO_GUARD: GuardSettings = { pauseHoldSec: 0, pauseUntilSec: 0, pauseBelowVal: 0 };

/**
 * Best mode: most runs detected, fewest false starts; among equally reliable modes the fastest end,
 * where end delays within DELAY_TOLERANCE_SEC count as equal and the order count, combined, timed
 * decides (count is the 3.1.2 behaviour).
 *
 * @param evaluations - Best evaluation per mode
 */
export function pickMode(evaluations: readonly ModeEvaluation[]): DetectionMode {
	const mostDetected = Math.max(...evaluations.map(e => e.detected));
	const top = evaluations.filter(e => e.detected === mostDetected);
	const fewestFalse = Math.min(...top.map(e => e.falseStarts));
	const reliable = top.filter(e => e.falseStarts === fewestFalse);
	const fastest = Math.min(...reliable.map(e => e.endDelaySec));
	const order = (m: DetectionMode): number => MODE_ORDER.indexOf(m);
	return [...reliable]
		.filter(e => e.endDelaySec <= fastest + DELAY_TOLERANCE_SEC)
		.sort((a, b) => order(a.mode) - order(b.mode))[0].mode;
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

/**
 * Longest stretch of consecutive ticks at or above a level inside the spans.
 *
 * @param s - Series
 * @param spans - Ranges
 * @param level - Level in W
 */
function longestAbove(s: TickSeries, spans: readonly Span[], level: number): number {
	let longest = 0;
	for (const sp of spans) {
		let cur = 0;
		for (let i = sp.from; i <= sp.to; i++) {
			cur = s.last[i] >= level ? cur + 1 : 0;
			longest = Math.max(longest, cur);
		}
	}
	return longest;
}

interface Candidate {
	settings: DetectionSettings;
	evaluation: ModeEvaluation;
	plan: Plan;
}

/**
 * Shared state of one analysis. Every replay runs in the unit of the state with the thresholds as
 * they are saved, so that the 2-decimal rounding of the count mode and its standby buffer length
 * (derived from endVal) behave exactly like at runtime (for example with a state in kW).
 */
class Analysis {
	private readonly runWindows;
	private readonly sim: TickSeries;
	private done = 0;
	private total = 1;

	public constructor(
		s: TickSeries,
		private readonly layout: Layout,
		private readonly replay: ReplayOptions,
		private readonly opts: AnalyzeOptions,
		private readonly factor: number,
	) {
		this.runWindows = layout.windows.filter(w => w.run !== null);
		this.sim = factor === 1 ? s : scaled(s, 1 / factor);
	}

	/**
	 * Value in the unit of the state as it is saved.
	 *
	 * @param v - Value in W
	 */
	public out(v: number): number {
		return this.factor === 1 ? round2(v) : Math.round((v / this.factor) * 1e5) / 1e5;
	}

	/**
	 * Settings in the unit of the state as they are saved.
	 *
	 * @param settings - Settings in W
	 */
	public inUnit(settings: DetectionSettings): DetectionSettings {
		return {
			...settings,
			startVal: this.out(settings.startVal),
			endVal: this.out(settings.endVal),
			standby: this.out(settings.standby),
			pauseBelowVal: this.out(settings.pauseBelowVal ?? 0),
			...(settings.trailerBlockVal ? { trailerBlockVal: this.out(settings.trailerBlockVal) } : {}),
		};
	}

	/**
	 * Simulate one window with settings in W.
	 *
	 * @param win - Window
	 * @param settings - Settings in W
	 */
	public simulate(win: Window, settings: DetectionSettings): SimResult {
		return simulate(this.sim, win, this.inUnit(settings), this.replay);
	}

	/**
	 * Evaluate settings that are already in the unit of the state (current type).
	 *
	 * @param settings - Settings in the unit of the state
	 */
	public evaluateUnit(settings: DetectionSettings): Promise<ModeEvaluation> {
		return evaluate(this.sim, this.layout.windows, settings, this.replay, this.opts.yieldFn);
	}

	public plan(total: number): void {
		this.total = Math.max(1, total);
	}

	public finish(): void {
		this.done = this.total;
		this.opts.onProgress?.(1);
	}

	public progress(): void {
		this.done++;
		this.opts.onProgress?.(Math.min(1, this.done / this.total));
	}

	public ok(settings: DetectionSettings): Promise<boolean> {
		return allOk(this.sim, this.runWindows, this.inUnit(settings), this.replay, this.opts.yieldFn);
	}

	public evaluate(settings: DetectionSettings): Promise<ModeEvaluation> {
		return this.evaluateUnit(this.inUnit(settings));
	}

	/**
	 * Smallest safe endCount by binary search with the real detector, plus a margin.
	 *
	 * @param make - Settings for an endCount
	 * @param hi - Upper bound
	 * @returns endCount or null if even the upper bound fails
	 */
	public async searchCount(make: (endCount: number) => DetectionSettings, hi: number): Promise<number | null> {
		if (!(await this.ok(make(hi)))) {
			return null;
		}
		let lo = 2;
		let top = hi;
		while (lo < top) {
			const mid = Math.floor((lo + top) / 2);
			if (await this.ok(make(mid))) {
				top = mid;
			} else {
				lo = mid + 1;
			}
		}
		let e = Math.min(hi, lo + Math.max(2, Math.ceil(0.25 * lo)));
		while (e < hi && !(await this.ok(make(e)))) {
			e = Math.min(hi, e + Math.max(1, Math.ceil(0.1 * e)));
		}
		return e;
	}
}

/**
 * Derive one device type from the runs of a series: every run has to be detected, whatever programme
 * was used. The end threshold, the end waiting time and an optional pause protection are chosen so
 * that the end is reported as early as possible; every candidate is checked with the real detector.
 *
 * @param series - Power values in W on the poll grid
 * @param pollIntervalSec - Poll interval in seconds
 * @param opts - Options
 */
export async function analyzeTicks(
	series: TickSeries,
	pollIntervalSec: number,
	opts: AnalyzeOptions = {},
): Promise<HistorySuggestion | HistoryLearningError> {
	if (series.points < 20 || series.length === 0) {
		return { error: "noHistory" };
	}
	const poll = Math.max(pollIntervalSec, 1);
	const factor = opts.unitFactor && opts.unitFactor > 0 ? opts.unitFactor : 1;
	const minDeltaW = Math.max(0, opts.minDelta ?? 0) * factor;
	const keepAbove = opts.currentType ? opts.currentType.endVal * factor : undefined;
	const layout = buildLayout(series, { recording: opts.recording, keepAbove });
	const { runs, idle, runLimit } = layout;
	const minRuns = Math.max(1, opts.minRuns ?? MIN_RUNS);
	if (runs.length < minRuns) {
		return { error: "tooFewRuns", runs: runs.length };
	}
	const replay: ReplayOptions = {
		abort: opts.abort === true,
		abortFixed: opts.abortFixed === true,
		pollSec: poll,
	};
	const an = new Analysis(series, layout, replay, opts, factor);

	// start
	const runPower = runs.map(r => {
		const vals: number[] = [];
		for (let i = r.from; i <= r.coreEnd; i++) {
			if (series.last[i] > runLimit) {
				vals.push(series.last[i]);
			}
		}
		return median(vals);
	});
	const startVal = round2(Math.max(idle + 5, 0.25 * Math.min(...runPower)));
	const standby = round2(idle * 1.2 + 0.1);
	const maxBurst = longestAbove(series, [...runs.flatMap(r => r.bursts), ...layout.spikes], startVal);
	const k0 = Math.max(2, maxBurst + 1);
	const base: SearchBase = { series, layout, poll, minDeltaW, startVal, standby, k0 };

	// anti-crease filter: derived from the trailers, used only if it reports the end earlier
	const withTrailer = runs.filter(r => r.bursts.length >= 2);
	const trailerParams = withTrailer.length >= 2 ? deriveTrailer(withTrailer, series.stepMs, poll) : null;
	const variants: TrailerParams[] = [];
	if (trailerParams) {
		const minCore = Math.min(...runs.map(r => (r.coreEnd - r.from) * (series.stepMs / 1000)));
		const minBlock = Math.min(...runs.map(r => r.blockMean));
		const after = Math.floor(0.9 * minCore);
		const block = round2(0.8 * minBlock);
		variants.push(trailerParams);
		variants.push({ ...trailerParams, trailerAfterSec: after });
		if (block > startVal) {
			variants.push({ ...trailerParams, trailerBlockVal: block });
			variants.push({ ...trailerParams, trailerAfterSec: after, trailerBlockVal: block });
		}
	}
	const perSearch =
		Math.min(2, endCandidates(series, layout, minDeltaW).length) *
		(2 + 2 * new Set([k0 * poll, Math.max(60, k0 * poll)]).size);
	an.plan((1 + variants.length) * perSearch + 2);

	const plain = await searchModes(an, base, null);
	let chosenSearch = plain;
	let trailer: "none" | "used" | "notSeparable" = "none";
	if (variants.length > 0) {
		// every variant is searched; the best one that detects every run competes with the plain search
		let bestFiltered: { search: SearchResult; evaluation: ModeEvaluation } | null = null;
		for (const v of variants) {
			const filtered = await searchModes(an, base, v);
			const fBest = bestOf(filtered);
			if (fBest.evaluation.detected < fBest.evaluation.runs) {
				continue;
			}
			if (!bestFiltered || compare(fBest.evaluation, bestFiltered.evaluation) < 0) {
				bestFiltered = { search: filtered, evaluation: fBest.evaluation };
			}
		}
		if (!bestFiltered) {
			trailer = "notSeparable";
		} else if (betterWithFilter(bestFiltered.evaluation, bestOf(plain).evaluation)) {
			chosenSearch = bestFiltered.search;
			trailer = "used";
		}
	}

	const evaluation = MODE_ORDER.map(m => chosenSearch.best.get(m)?.evaluation).filter(e => e !== undefined);
	const mode = pickMode(evaluation);
	const chosen = chosenSearch.best.get(mode) as Candidate;
	const settings = chosen.settings;

	// cross-check: would each run have been detected if it had been missing from the history?
	let looDetected: number | undefined;
	if (runs.length >= 2) {
		looDetected = 0;
		const tables = chosenSearch.tablesByE.get(chosen.plan.e) ?? [];
		for (const win of layout.windows) {
			if (win.run === null) {
				continue;
			}
			const plan = planFor(
				chosenSearch.ctx,
				chosen.plan.e,
				tables.filter(t => t.run !== win.run),
			);
			const endTicks = Math.ceil(plan.Ds / poll);
			const endCount = endTicks + Math.max(2, Math.ceil(0.25 * endTicks));
			const loo: DetectionSettings = {
				...settings,
				...(plan.guard ?? NO_GUARD),
				...(mode === "count" ? { endCount, endDurationSec: endCount * poll } : { endDurationSec: plan.Ds }),
			};
			const res = an.simulate(win, loo);
			if (runOkFull(series, win, res)) {
				looDetected++;
			}
			await opts.yieldFn?.();
		}
	}
	an.progress();

	let current: ModeEvaluation | undefined;
	if (opts.currentType) {
		current = await an.evaluateUnit(opts.currentType);
	}
	an.finish();

	const out = (v: number): number => an.out(v);
	const stepSec = series.stepMs / 1000;
	const chosenEval = chosen.evaluation;
	const trailerOut =
		trailer === "used" && settings.trailerBurstSec
			? {
					trailerBurstSec: settings.trailerBurstSec,
					trailerGapSec: settings.trailerGapSec ?? 0,
					trailerAfterSec: settings.trailerAfterSec ?? 0,
					trailerBlockVal: out(settings.trailerBlockVal ?? 0),
					trailerMaxSec: settings.trailerMaxSec ?? 0,
				}
			: {};
	return {
		thresholds: {
			startVal: out(settings.startVal),
			endVal: out(settings.endVal),
			standby: out(settings.standby),
			startCount: settings.startCount,
			endCount: settings.endCount,
		},
		startDurationSec: settings.startDurationSec,
		endDurationSec: settings.endDurationSec,
		durationSec: Math.max(...runs.map(r => Math.round((r.runEnd - r.from) * stepSec))),
		samples: series.points,
		pauseHoldSec: settings.pauseHoldSec ?? 0,
		pauseUntilSec: settings.pauseUntilSec ?? 0,
		pauseBelowVal: out(settings.pauseBelowVal ?? 0),
		...trailerOut,
		mode,
		runs: runs.length,
		evaluation,
		...(looDetected !== undefined ? { looDetected } : {}),
		longestPauseSec: Math.round(chosen.plan.dmax),
		...(current ? { current } : {}),
		gapsDropped: layout.gapsDropped,
		trailer,
		trailerRuns: [withTrailer.length, runs.length],
		delays: chosenEval.delays ?? [],
		falseStarts: chosenEval.falseStarts,
	};
}

/** Inputs of the candidate search that do not depend on the anti-crease filter. */
interface SearchBase {
	series: TickSeries;
	layout: Layout;
	poll: number;
	minDeltaW: number;
	startVal: number;
	standby: number;
	k0: number;
}

/** Best candidate per mode of one search. */
interface SearchResult {
	best: Map<DetectionMode, Candidate>;
	tablesByE: Map<number, RunTable[]>;
	ctx: PlanContext;
}

/**
 * Best candidate of a search (by pickMode).
 *
 * @param r - Search result
 */
function bestOf(r: SearchResult): Candidate {
	const evaluation = MODE_ORDER.map(m => r.best.get(m)?.evaluation).filter(e => e !== undefined);
	return r.best.get(pickMode(evaluation)) as Candidate;
}

/**
 * Whether the filter variant is clearly better: more runs, fewer false starts, or an end reported at
 * least DELAY_TOLERANCE_SEC earlier (a tie keeps the detection without filter).
 *
 * @param f - Evaluation with the filter
 * @param p - Evaluation without the filter
 */
export function betterWithFilter(f: ModeEvaluation, p: ModeEvaluation): boolean {
	if (f.detected !== p.detected) {
		return f.detected > p.detected;
	}
	if (f.falseStarts !== p.falseStarts) {
		return f.falseStarts < p.falseStarts;
	}
	return f.endDelaySec < p.endDelaySec - DELAY_TOLERANCE_SEC;
}

/**
 * Settings of the anti-crease filter derived from the trailers of the runs.
 *
 * @param runs - Runs with a trailer
 * @param stepMs - Poll interval in ms
 * @param poll - Poll interval in s
 */
export function deriveTrailer(runs: readonly RunInfo[], stepMs: number, poll: number): TrailerParams {
	const burstMax = Math.max(...runs.map(r => r.burstMaxMs)) / 1000;
	const gapMin = Math.min(...runs.map(r => r.gapMinMs)) / 1000;
	const longest = Math.max(...runs.map(r => ((r.trailerTo ?? r.coreEnd) - r.coreEnd) * (stepMs / 1000)));
	const burst = Math.min(180, Math.max(Math.ceil(Math.max(15, 1.5 * poll + 10)), Math.ceil(burstMax * 1.5)));
	const gap = Math.max(1, Math.min(Math.floor(0.8 * gapMin), Math.max(3 * poll, 30, Math.floor(0.5 * gapMin))));
	return {
		trailerBurstSec: burst,
		trailerGapSec: gap,
		trailerAfterSec: 0,
		trailerBlockVal: 0,
		// generous: the phase also ends after a quiet time, and real activity is always passed on
		trailerMaxSec: Math.min(14400, Math.max(TRAILER_MAX_DEFAULT_SEC, Math.ceil(longest * 1.25 + 900))),
	};
}

/**
 * Search the best candidate of every mode: end threshold candidates planned in closed form (on the
 * burst-free copy when the filter is used), the best two simulated with the real detector.
 *
 * @param an - Analysis
 * @param b - Inputs
 * @param trailer - Filter settings or null
 */
async function searchModes(an: Analysis, b: SearchBase, trailer: TrailerParams | null): Promise<SearchResult> {
	const { series, layout, poll, minDeltaW, startVal, standby, k0 } = b;
	const extra: Partial<DetectionSettings> = trailer ?? {};
	const startCounts = [k0, k0 + 1];
	const startDurations = [...new Set([k0 * poll, Math.max(60, k0 * poll)])];
	const ctx0: PlanContext = { series, runs: layout.runs, pollSec: poll, minDeltaW };
	const tablesByE = new Map<number, RunTable[]>();
	let ctx = ctx0;
	const plans = endCandidates(series, layout, minDeltaW).map(e => {
		const planSeries = trailer ? suppressBursts(series, layout, trailer, e, poll) : series;
		ctx = { ...ctx0, series: planSeries };
		const tables = layout.runs.map((r, i) => runTable(planSeries, r, e, i));
		tablesByE.set(e, tables);
		return planFor(ctx, e, tables);
	});
	const chosenPlans = [...plans].sort((x, y) => x.estCost - y.estCost).slice(0, 2);

	const best = new Map<DetectionMode, Candidate>();
	const consider = async (settings: DetectionSettings, plan: Plan): Promise<void> => {
		const evaluation = await an.evaluate(settings);
		const known = best.get(settings.mode);
		if (!known || compare(evaluation, known.evaluation) < 0) {
			best.set(settings.mode, { settings, evaluation, plan });
		}
		an.progress();
	};
	for (const plan of chosenPlans) {
		const thresholds = { startVal, endVal: plan.e, standby, ...extra };
		let countE = 0;
		for (const startCount of startCounts) {
			const make =
				(guard: GuardSettings) =>
				(endCount: number): DetectionSettings => ({
					...thresholds,
					...guard,
					mode: "count",
					startCount,
					endCount,
					startDurationSec: startCount * poll,
					endDurationSec: endCount * poll,
				});
			let settings: DetectionSettings | null = null;
			if (plan.guard) {
				const e = await an.searchCount(make(plan.guard), Math.ceil((plan.Ds / poll) * 1.5) + 3);
				settings = e === null ? null : make(plan.guard)(e);
			}
			if (!settings) {
				const hi = Math.max(
					2,
					Math.ceil((Math.ceil(plan.dmax / poll) + 3) * 1.5),
					Math.ceil((plan.noGuardDs / poll) * 1.5) + 3,
				);
				settings = make(NO_GUARD)((await an.searchCount(make(NO_GUARD), hi)) ?? hi);
			}
			if (startCount === k0) {
				countE = settings.endCount;
			}
			await consider(settings, plan);
		}
		for (const mode of ["timed", "combined"] as const) {
			for (const startDurationSec of startDurations) {
				const make = (guard: GuardSettings, endDurationSec: number): DetectionSettings => ({
					...thresholds,
					...guard,
					mode,
					startCount: k0,
					endCount: mode === "combined" ? 3 : countE,
					startDurationSec,
					endDurationSec,
				});
				let settings: DetectionSettings | null = null;
				let ds = plan.Ds;
				for (let attempt = 0; attempt <= 3 && !settings; attempt++) {
					const candidate = make(plan.guard ?? NO_GUARD, ds);
					if (await an.ok(candidate)) {
						settings = candidate;
					}
					ds = Math.ceil(ds * 1.25);
				}
				await consider(settings ?? make(NO_GUARD, plan.noGuardDs), plan);
			}
		}
	}
	return { best, tablesByE, ctx };
}
