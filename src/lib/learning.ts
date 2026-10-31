import type { DetectionMode, TypeThresholds } from "./detector/types.js";
import type { AnalyzeOptions } from "./learn/analyze.js";
import { analyzeTicks } from "./learn/analyze.js";
import type { ModeEvaluation } from "./learn/replay.js";
import { PAD_AFTER_MS } from "./learn/runs.js";
import { fromPoints } from "./learn/ticks.js";

/** One recorded power sample. */
export interface LearningSample {
	/** Milliseconds since the start of the recording. */
	t: number;
	/** Power in W. */
	p: number;
}

/** Suggested type settings derived from a recorded run. */
export interface LearningSuggestion {
	/** Suggested thresholds. */
	thresholds: TypeThresholds;
	/** Suggested start duration in seconds. */
	startDurationSec: number;
	/** Suggested end duration in seconds. */
	endDurationSec: number;
	/** Duration of the run in seconds. */
	durationSec: number;
	/** Number of samples used. */
	samples: number;
	/** Pause protection: hold time in seconds (0 = off). */
	pauseHoldSec: number;
	/** Pause protection: a phase beginning within this many seconds of the start is a pause (0 = unused). */
	pauseUntilSec: number;
	/** Pause protection: a phase staying below this power is a pause (0 = unused). */
	pauseBelowVal: number;
	/** Recommended detection mode. */
	mode?: DetectionMode;
	/** Number of runs found. */
	runs?: number;
	/** Result of every detection mode over the runs. */
	evaluation?: ModeEvaluation[];
	/** Cross-check: runs that would also be detected if they had been missing from the history. */
	looDetected?: number;
	/** Longest pause inside a run (s). */
	longestPauseSec?: number;
	/** Result of the current device type over the same runs. */
	current?: ModeEvaluation;
	/** Runs and spikes dropped because of gaps in the history. */
	gapsDropped?: number;
	/** Anti-crease filter: longest drum burst in s (set only when the filter is used). */
	trailerBurstSec?: number;
	/** Anti-crease filter: minimum quiet time before a burst in s. */
	trailerGapSec?: number;
	/** Anti-crease filter: bursts are held only this many seconds after the start. */
	trailerAfterSec?: number;
	/** Anti-crease filter: bursts are held only after a block of at least this mean power. */
	trailerBlockVal?: number;
	/** Anti-crease filter: length of the anti-crease phase after the end in s. */
	trailerMaxSec?: number;
	/** Anti-crease phase: none found, used by the filter, or not separable from phases inside a programme. */
	trailer?: "none" | "used" | "notSeparable";
	/** Runs with an anti-crease phase and all runs. */
	trailerRuns?: [number, number];
	/** End delay per run in s (from the end of the programme; NaN = not detected). */
	delays?: number[];
	/** Starts outside of a run. */
	falseStarts?: number;
}

const MAX_DURATION_MS = 12 * 60 * 60 * 1000;
const MAX_SAMPLES = 10_000;

/** Records power samples of one run (at most 12 h or 10 000 samples). */
export class LearningRecorder {
	private samples: LearningSample[] = [];
	private startedAt = 0;
	private running = false;

	/** Whether a recording is in progress. */
	public get active(): boolean {
		return this.running;
	}

	/** Number of recorded samples. */
	public get sampleCount(): number {
		return this.samples.length;
	}

	/**
	 * Start a new recording.
	 *
	 * @param now - Current timestamp in ms
	 */
	public start(now: number): void {
		this.samples = [];
		this.startedAt = now;
		this.running = true;
	}

	/**
	 * Add a sample; stops automatically at the limits.
	 *
	 * @param p - Power in W
	 * @param now - Current timestamp in ms
	 */
	public add(p: number, now: number): void {
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

	/**
	 * Stop the recording and return the samples.
	 *
	 * @param _now - Current timestamp in ms
	 */
	public stop(_now: number): LearningSample[] {
		this.running = false;
		return this.samples.slice();
	}
}

/**
 * Derive type settings from a recorded run with the same analysis as the history (one run). After
 * the recording the last value is taken to stay (as the runtime does), so that a recording stopped
 * shortly after the end still shows when the end would be reported. A run that no detection mode
 * recognises (recording stopped while the device was still running) yields `noRun`.
 *
 * @param samples - Recorded samples
 * @param pollIntervalSec - Poll interval in seconds
 * @param opts - Device options, the current device type and the unit factor of the state
 */
export async function suggestType(
	samples: LearningSample[],
	pollIntervalSec: number,
	opts: Pick<AnalyzeOptions, "abort" | "abortFixed" | "yieldFn" | "currentType" | "unitFactor"> = {},
): Promise<LearningSuggestion | { error: "tooFewSamples" | "noRun" }> {
	if (samples.length < 20) {
		return { error: "tooFewSamples" };
	}
	const poll = Math.max(pollIntervalSec, 1);
	// the samples are in the unit of the state, the analysis works in W
	const factor = opts.unitFactor && opts.unitFactor > 0 ? opts.unitFactor : 1;
	const series = fromPoints(
		samples.map(s => ({ ts: s.t, val: s.p * factor })),
		poll * 1000,
		PAD_AFTER_MS,
	);
	const result = await analyzeTicks(series, poll, { ...opts, minRuns: 1, recording: true });
	if ("error" in result || !result.evaluation.some(e => e.detected > 0)) {
		return { error: "noRun" };
	}
	return result;
}
