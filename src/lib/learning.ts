import type { TypeThresholds } from "./detector/types.js";

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

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

/**
 * Derive type settings from a recorded run.
 *
 * @param samples - Recorded samples
 * @param pollIntervalSec - Poll interval in seconds
 */
export function suggestType(
	samples: LearningSample[],
	pollIntervalSec: number,
): LearningSuggestion | { error: "tooFewSamples" | "noRun" } {
	if (samples.length < 20) {
		return { error: "tooFewSamples" };
	}
	const tailCount = Math.max(3, Math.ceil(samples.length * 0.1));
	const idle = median(samples.slice(-tailCount).map(s => s.p));
	const runLimit = idle * 3 + 2;
	const runIdx: number[] = [];
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
		} else {
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
