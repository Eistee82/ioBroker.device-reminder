import { createDetector } from "../detector/index.js";
import type { DetectionMode, DetectionSettings, TickResult } from "../detector/types.js";
import type { Window } from "./runs.js";
import type { TickSeries } from "./ticks.js";

/** How well one detection mode recognises the runs. */
export interface ModeEvaluation {
	/** Detection mode. */
	mode: DetectionMode;
	/** Runs that were detected exactly once (one start, one end after the run, no abort). */
	detected: number;
	/** Number of runs. */
	runs: number;
	/** Starts outside of a run (short spikes). */
	falseStarts: number;
	/** Mean time from the real end of a run to the reported end, in seconds. */
	endDelaySec: number;
	/** Longest time from the real end of a run to the reported end, in seconds. */
	endDelayMaxSec: number;
	/** Delay per run window in s (NaN if the run was not detected correctly). */
	delays?: number[];
}

/** Device options for the replay. */
export interface ReplayOptions {
	/** Abort detection. */
	abort: boolean;
	/** Corrected abort detection. */
	abortFixed: boolean;
	/** Poll interval in s (anti-crease filter; default: step of the series). */
	pollSec?: number;
}

/** Events of one simulated window. */
export interface SimResult {
	/** Number of "started" events. */
	started: number;
	/** Number of "aborted" events. */
	aborted: number;
	/** Timestamps of the "finished" events. */
	finished: number[];
	/** Timestamps of the "started" events. */
	startedAt: number[];
}

/**
 * Run the real detector over one window as the runtime would see the history: in the time-based
 * mode every stored value is fed (extremes of a tick before its last value), every poll tick
 * evaluates the last known value.
 *
 * @param s - Series in W
 * @param win - Window
 * @param settings - Detection settings in W
 * @param opts - Device options
 * @param stopAtFinish - Stop after the first "finished"
 */
export function simulate(
	s: TickSeries,
	win: Window,
	settings: DetectionSettings,
	opts: ReplayOptions,
	stopAtFinish = false,
): SimResult {
	const detector = createDetector(settings, {
		abort: opts.abort,
		abortFixed: opts.abortFixed,
		pollSec: opts.pollSec ?? s.stepMs / 1000,
	});
	const feed = settings.mode === "timed" ? detector.feed?.bind(detector) : undefined;
	const res: SimResult = { started: 0, aborted: 0, finished: [], startedAt: [] };
	const collect = (r: TickResult, t: number): void => {
		r.events.forEach((ev, k) => {
			const at = r.times?.[k] ?? t;
			if (ev === "started") {
				res.started++;
				res.startedAt.push(at);
			} else if (ev === "aborted") {
				res.aborted++;
			} else if (ev === "finished") {
				res.finished.push(at);
			}
		});
	};
	const step = s.stepMs;
	for (let i = win.fromIdx; i <= win.toIdx; i++) {
		const t = s.t0 + i * step;
		const last = s.last[i];
		if (feed && s.has[i] === 1) {
			if (s.max[i] > last) {
				collect(feed(s.max[i], t - step / 2), t - step / 2);
			}
			if (s.min[i] < last) {
				collect(feed(s.min[i], t - step / 4), t - step / 4);
			}
			collect(feed(last, t), t);
		}
		collect(detector.tick(last, t, { switchOff: false }), t);
		if (stopAtFinish && res.finished.length > 0) {
			break;
		}
	}
	return res;
}

/**
 * Whether a run window was detected correctly.
 *
 * @param s - Series
 * @param win - Run window
 * @param r - Simulation result
 */
export function runOk(s: TickSeries, win: Window, r: SimResult): boolean {
	const end = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
	return r.started === 1 && r.aborted === 0 && r.finished.length > 0 && r.finished[0] >= end;
}

/**
 * Whether a run window was detected exactly right over the whole window: one start, no abort, one
 * end not before the end of the run and no start after it. A spike window passes without a start.
 *
 * @param s - Series
 * @param win - Window
 * @param r - Simulation result of the whole window (without stopAtFinish)
 */
export function runOkFull(s: TickSeries, win: Window, r: SimResult): boolean {
	if (win.runEndIdx === null) {
		return r.started === 0;
	}
	return runOk(s, win, r) && r.finished.length === 1 && r.startedAt.every(t => t <= r.finished[0]);
}

/**
 * Whether the settings detect every run window (start once, no abort, end not before the end).
 *
 * @param s - Series
 * @param windows - Run windows
 * @param settings - Detection settings
 * @param opts - Device options
 * @param yieldFn - Called after the round
 */
export async function allOk(
	s: TickSeries,
	windows: readonly Window[],
	settings: DetectionSettings,
	opts: ReplayOptions,
	yieldFn?: () => Promise<void>,
): Promise<boolean> {
	let ok = true;
	for (const win of windows) {
		if (!runOk(s, win, simulate(s, win, settings, opts, true))) {
			ok = false;
			break;
		}
	}
	await yieldFn?.();
	return ok;
}

/**
 * Evaluate settings over all windows.
 *
 * @param s - Series
 * @param windows - Runs and spikes
 * @param settings - Detection settings
 * @param opts - Device options
 * @param yieldFn - Called after the round
 */
export async function evaluate(
	s: TickSeries,
	windows: readonly Window[],
	settings: DetectionSettings,
	opts: ReplayOptions,
	yieldFn?: () => Promise<void>,
): Promise<ModeEvaluation> {
	let detected = 0;
	let falseStarts = 0;
	let delaySum = 0;
	let delayMax = 0;
	let runs = 0;
	const delays: number[] = [];
	for (const win of windows) {
		const res = simulate(s, win, settings, opts);
		if (win.runEndIdx === null) {
			falseStarts += res.started;
			continue;
		}
		runs++;
		if (runOkFull(s, win, res)) {
			detected++;
			const delay = (res.finished[0] - (s.t0 + win.runEndIdx * s.stepMs)) / 1000;
			delaySum += delay;
			delayMax = Math.max(delayMax, delay);
			delays.push(delay);
		} else {
			delays.push(Number.NaN);
		}
	}
	await yieldFn?.();
	return {
		mode: settings.mode,
		detected,
		runs,
		falseStarts,
		endDelaySec: detected > 0 ? Math.round(delaySum / detected) : 0,
		endDelayMaxSec: Math.round(delayMax),
		delays,
	};
}

/**
 * Negative if `a` recognises the runs better than `b`: more runs detected, fewer false starts,
 * then the shorter end delay.
 *
 * @param a - First evaluation
 * @param b - Second evaluation
 */
export function compare(a: ModeEvaluation, b: ModeEvaluation): number {
	return (
		b.detected - a.detected ||
		a.falseStarts - b.falseStarts ||
		a.endDelaySec - b.endDelaySec ||
		a.endDelayMaxSec - b.endDelayMaxSec
	);
}
