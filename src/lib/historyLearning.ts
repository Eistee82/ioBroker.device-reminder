import { createDetector } from "./detector/index.js";
import type { DetectionMode, DetectionSettings } from "./detector/types.js";
import type { LearningSuggestion } from "./learning.js";

/** One stored value of the power state. */
export interface HistoryPoint {
	/** Timestamp in ms. */
	ts: number;
	/** Power in W. */
	val: number;
}

/** How well one detection mode recognises the runs found in the history. */
export interface ModeEvaluation {
	/** Detection mode. */
	mode: DetectionMode;
	/** Runs that were detected exactly once (one start, one end after the run). */
	detected: number;
	/** Number of runs found in the history. */
	runs: number;
	/** Starts outside of a run (short spikes). */
	falseStarts: number;
	/** Mean time from the real end of a run to the reported end, in seconds. */
	endDelaySec: number;
}

/** Errors of the history analysis. */
export type HistoryLearningError = { error: "noHistory" } | { error: "tooFewRuns"; runs: number };

/** Suggestion derived from the history; mode, runs and evaluation are always set. */
export type HistorySuggestion = LearningSuggestion & Required<Pick<LearningSuggestion, "mode" | "runs" | "evaluation">>;

/** Days of history that are analysed. */
export const HISTORY_DAYS = 30;
/** A run may pause (power at idle level) for at most this long. */
const MAX_PAUSE_MS = 30 * 60_000;
/** Minimum time above the run level for a run; shorter activity is a spike (display, pump). */
const MIN_ACTIVE_MS = 5 * 60_000;
/** Idle time simulated before a run. */
const PAD_BEFORE_MS = 30 * 60_000;
/** Time after a run in which the end has to be reported. */
const PAD_AFTER_MS = 3 * 60 * 60_000;
/** Newest runs / spikes that are simulated. */
const MAX_WINDOWS = 20;
/** Minimum number of runs. */
const MIN_RUNS = 2;
/** End delays closer than this count as equal (then the 3.1.2 count mode wins). */
const DELAY_TOLERANCE_SEC = 60;
const END_FACTORS = [1, 1.5, 2, 3];
const MODE_ORDER: readonly DetectionMode[] = ["count", "combined", "timed"];

/** A stretch of activity on the poll grid (tick indices, inclusive). */
interface Segment {
	from: number;
	to: number;
	active: number;
}

/** Simulated time range with the expected result. */
interface Window {
	from: number;
	to: number;
	/** Timestamp of the last active tick of a run; null for a spike (no start expected). */
	runEnd: number | null;
}

interface CandidateResult {
	settings: DetectionSettings;
	evaluation: ModeEvaluation;
}

function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

/**
 * Power value on the poll grid: the last stored value at or before each tick, as the runtime sees it.
 *
 * @param points - Sorted history
 * @param from - First tick in ms
 * @param stepMs - Poll interval in ms
 * @param count - Number of ticks
 */
function resample(points: HistoryPoint[], from: number, stepMs: number, count: number): number[] {
	const out = new Array<number>(count);
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

/**
 * Stretches above the run level; pauses shorter than MAX_PAUSE_MS are part of the stretch.
 *
 * @param ticks - Power per tick
 * @param limit - Run level in W
 * @param maxGap - Longest pause in ticks
 */
function segments(ticks: number[], limit: number, maxGap: number): Segment[] {
	const out: Segment[] = [];
	let current: Segment | null = null;
	for (let i = 0; i < ticks.length; i++) {
		if (ticks[i] <= limit) {
			continue;
		}
		if (current && i - current.to - 1 <= maxGap) {
			current.to = i;
			current.active++;
		} else {
			current = { from: i, to: i, active: 1 };
			out.push(current);
		}
	}
	return out;
}

/**
 * Longest stretch of ticks below the end threshold inside one run.
 *
 * @param ticks - Power per tick
 * @param seg - Run
 * @param endVal - End threshold in W
 */
function longestDip(ticks: number[], seg: Segment, endVal: number): number {
	let longest = 0;
	let current = 0;
	for (let i = seg.from; i <= seg.to; i++) {
		current = ticks[i] < endVal ? current + 1 : 0;
		longest = Math.max(longest, current);
	}
	return longest;
}

/**
 * Run the detector of the given settings over one window with the history as it would arrive live:
 * every stored value is fed (time-based mode), every poll tick evaluates the last known value.
 *
 * @param points - Sorted history
 * @param win - Window to simulate
 * @param stepMs - Poll interval in ms
 * @param settings - Detection settings
 */
function simulate(
	points: HistoryPoint[],
	win: Window,
	stepMs: number,
	settings: DetectionSettings,
): { started: number; finished: number[] } {
	const detector = createDetector(settings, { abort: false, abortFixed: false });
	const feed = settings.mode === "timed" ? detector.feed?.bind(detector) : undefined;
	let idx = points.findIndex(p => p.ts > win.from);
	if (idx < 0) {
		idx = points.length;
	}
	let value = idx > 0 ? points[idx - 1].val : points[0].val;
	let started = 0;
	const finished: number[] = [];
	const collect = (events: string[], t: number): void => {
		for (const ev of events) {
			if (ev === "started") {
				started++;
			} else if (ev === "finished") {
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

/**
 * Evaluate one candidate over all windows.
 *
 * @param points - Sorted history
 * @param windows - Runs and spikes
 * @param stepMs - Poll interval in ms
 * @param settings - Detection settings
 */
function evaluate(
	points: HistoryPoint[],
	windows: Window[],
	stepMs: number,
	settings: DetectionSettings,
): ModeEvaluation {
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

/**
 * Negative if `a` recognises the runs better than `b`: more runs detected, fewer false starts,
 * then the shorter end delay.
 *
 * @param a - First evaluation
 * @param b - Second evaluation
 */
function compare(a: ModeEvaluation, b: ModeEvaluation): number {
	return b.detected - a.detected || a.falseStarts - b.falseStarts || a.endDelaySec - b.endDelaySec;
}

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

/**
 * Derive one device type from the runs stored in the history of the power state. The type has to
 * detect every run, whatever programme was used: the thresholds cover the run with the longest
 * pause, and every candidate is checked by running the real detectors over all runs.
 *
 * @param raw - History of the power state (any order)
 * @param pollIntervalSec - Poll interval in seconds
 */
export function analyzeHistory(
	raw: readonly HistoryPoint[],
	pollIntervalSec: number,
): HistorySuggestion | HistoryLearningError {
	const points = raw.filter(p => Number.isFinite(p.ts) && Number.isFinite(p.val)).sort((a, b) => a.ts - b.ts);
	if (points.length < 20) {
		return { error: "noHistory" };
	}
	const poll = Math.max(pollIntervalSec, 1);
	const stepMs = poll * 1000;
	const first = points[0].ts;
	const count = Math.floor((points[points.length - 1].ts - first) / stepMs) + 1;
	const ticks = resample(points, first, stepMs, count);
	const at = (i: number): number => first + i * stepMs;

	const runLimit = median(ticks) * 3 + 2;
	const all = segments(ticks, runLimit, Math.floor(MAX_PAUSE_MS / stepMs));
	const isRun = (s: Segment): boolean => s.active * stepMs >= MIN_ACTIVE_MS;
	const runs = all.filter(isRun).slice(-MAX_WINDOWS);
	if (runs.length < MIN_RUNS) {
		return { error: "tooFewRuns", runs: runs.length };
	}

	// standby level: what the device draws right after a run
	const tail: number[] = [];
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

	const windows: Window[] = [];
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
	const candidates: DetectionSettings[] = [];
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

	const best = new Map<DetectionMode, CandidateResult>();
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
