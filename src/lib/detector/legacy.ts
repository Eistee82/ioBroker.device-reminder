import type { Detector, DetectorEvent, DeviceStatus, TickResult, TypeThresholds } from "./types.js";

export type { DetectorEvent, DeviceStatus, TickResult, TypeThresholds } from "./types.js";

/** Options of the count-based (3.1.2) detection. */
export interface LegacyOptions {
	/** Abort detection (device switched off by hand while running). */
	abort: boolean;
	/**
	 * Corrected abort detection: standbyCount = max(ceil(endCount / 2), 2), so that the standby buffer
	 * can reach valCancel (in 3.1.2 it mostly cannot).
	 */
	abortFixed?: boolean;
	/** Combined mode: "started" additionally needs power >= startVal for at least this many ms (0 = off). */
	minStartMs?: number;
	/** Combined mode: "finished" additionally needs power < endVal for at least this many ms (0 = off). */
	minEndMs?: number;
}

type BufferName = "start" | "end" | "standby";

/** Mutable collector for the outputs of one tick. */
interface TickOutput {
	events: DetectorEvent[];
	status: DeviceStatus | null;
	average: number | null;
}

/**
 * Average of the values, rounded to 2 decimals exactly like 3.1.2 (`calculation`).
 *
 * @param values - Non-empty list of power values
 */
export function legacyAverage(values: readonly number[]): number {
	let sum = 0;
	for (const value of values) {
		sum = sum + value;
	}
	return Math.round((sum / values.length) * 100) / 100;
}

/**
 * Count-based start/end detection, behaviour-identical to device-reminder 3.1.2
 * (main.js `evaluatingInputValue`, `evaluateStatus`, `calcStart`).
 *
 * Output mapping: status "start" → "running", "standby" → "standby", "end" → "off".
 * Events: "aborted" = abort detection, "started" = start, "running" = operating branch,
 * "finished" = end detection.
 */
export class LegacyDetector implements Detector {
	/** Start threshold in W. */
	public readonly startValue: number;
	/** End threshold in W. */
	public readonly endValue: number;
	/** Standby threshold in W (0 or empty → 1, as in 3.1.2). */
	public readonly standbyValue: number;
	/** Number of samples in the start buffer. */
	public readonly startCount: number;
	/** Number of samples in the end buffer. */
	public readonly endCount: number;
	/** Number of samples in the standby buffer (3.1.2: depends on endVal). */
	public readonly standbyCount: number;
	/** Minimum standby buffer length for the abort detection (endCount / 2). */
	public readonly valCancel: number;

	private readonly abort: boolean;
	private readonly minStartMs: number;
	private readonly minEndMs: number;
	private isStarted = false;
	/** Timestamp since which the power is continuously >= startVal, otherwise null. */
	private aboveStartSince: number | null = null;
	/** Timestamp since which the power is continuously < endVal, otherwise null. */
	private belowEndSince: number | null = null;
	private buffers: Record<BufferName, number[]> = { start: [], end: [], standby: [] };
	private averages: Record<BufferName, number> = { start: 0, end: 0, standby: 0 };

	/**
	 * @param thresholds - Thresholds of the device type
	 * @param options - Detection options
	 */
	public constructor(thresholds: TypeThresholds, options: LegacyOptions) {
		this.startValue = thresholds.startVal;
		this.endValue = thresholds.endVal;
		this.standbyValue = thresholds.standby || 1;
		this.startCount = thresholds.startCount;
		this.endCount = thresholds.endCount;
		this.standbyCount = options.abortFixed
			? Math.max(Math.ceil(thresholds.endCount / 2), 2)
			: thresholds.endVal <= 10
				? thresholds.endVal || 10
				: 10;
		this.valCancel = thresholds.endCount / 2;
		this.abort = options.abort;
		this.minStartMs = options.minStartMs ?? 0;
		this.minEndMs = options.minEndMs ?? 0;
	}

	/** Whether a run is in progress. */
	public get started(): boolean {
		return this.isStarted;
	}

	/** Current lengths of the internal buffers (diagnostics and tests). */
	public get bufferLengths(): Record<BufferName, number> {
		return {
			start: this.buffers.start.length,
			end: this.buffers.end.length,
			standby: this.buffers.standby.length,
		};
	}

	/** Reset to the initial state. */
	public reset(): void {
		this.isStarted = false;
		this.buffers = { start: [], end: [], standby: [] };
		this.averages = { start: 0, end: 0, standby: 0 };
		this.aboveStartSince = null;
		this.belowEndSince = null;
	}

	/**
	 * Evaluate one poll step with the last known power value.
	 *
	 * @param power - Last known power in W
	 * @param now - Timestamp in ms (used by the minimum durations of the combined mode)
	 */
	public tick(power: number, now: number): TickResult {
		const out: TickOutput = { events: [], status: null, average: null };
		this.trackDurations(power, now);
		this.fillBuffers(power, out);
		this.evaluate(out, now);
		return { events: out.events, status: out.status, average: out.average, started: this.isStarted };
	}

	/**
	 * Remember since when the power is continuously above the start or below the end threshold.
	 *
	 * @param power - Power value in W
	 * @param now - Timestamp in ms
	 */
	private trackDurations(power: number, now: number): void {
		if (power >= this.startValue) {
			this.aboveStartSince ??= now;
		} else {
			this.aboveStartSince = null;
		}
		if (power < this.endValue) {
			this.belowEndSince ??= now;
		} else {
			this.belowEndSince = null;
		}
	}

	/**
	 * Whether the minimum start duration (combined mode) is met; always true without it.
	 *
	 * @param now - Timestamp in ms
	 */
	private startDurationMet(now: number): boolean {
		return this.minStartMs <= 0 || (this.aboveStartSince !== null && now - this.aboveStartSince >= this.minStartMs);
	}

	/**
	 * Whether the minimum end duration (combined mode) is met; always true without it.
	 *
	 * @param now - Timestamp in ms
	 */
	private endDurationMet(now: number): boolean {
		return this.minEndMs <= 0 || (this.belowEndSince !== null && now - this.belowEndSince >= this.minEndMs);
	}

	private countOf(name: BufferName): number {
		switch (name) {
			case "start":
				return this.startCount;
			case "end":
				return this.endCount;
			default:
				return this.standbyCount;
		}
	}

	/**
	 * 3.1.2 `calcStart`: push, average over up to count + 1 values, then trim.
	 *
	 * @param name - Buffer to fill
	 * @param power - Power value in W
	 * @param out - Outputs of the current tick
	 */
	private push(name: BufferName, power: number, out: TickOutput): void {
		const buffer = this.buffers[name];
		buffer.push(power);
		this.averages[name] = legacyAverage(buffer);
		out.average = this.averages[name];
		if (buffer.length > this.countOf(name)) {
			buffer.shift();
		}
	}

	/**
	 * 3.1.2 `evaluatingInputValue`.
	 *
	 * @param power - Power value in W
	 * @param out - Outputs of the current tick
	 */
	private fillBuffers(power: number, out: TickOutput): void {
		if (this.isStarted) {
			this.push("standby", power, out);
			this.push("end", power, out);
			this.buffers.start = [];
		} else if (power < this.startValue) {
			this.buffers.start = [];
			this.push("standby", power, out);
		} else {
			this.push("start", power, out);
			this.buffers.standby = [];
		}
	}

	/**
	 * 3.1.2 `evaluateStatus` (without messages, autoOff and runtime, which belong to the device runtime).
	 *
	 * @param out - Outputs of the current tick
	 * @param now - Timestamp in ms
	 */
	private evaluate(out: TickOutput, now: number): void {
		const avg = this.averages;

		// abort detection
		if (
			this.abort &&
			this.isStarted &&
			avg.standby < this.standbyValue &&
			this.buffers.standby.length >= this.valCancel
		) {
			out.events.push("aborted");
			out.status = "off";
			out.average = avg.standby;
			this.isStarted = false;
			this.buffers = { start: [], end: [], standby: [] };
		}

		// start
		if (
			avg.start > this.startValue &&
			this.buffers.start.length >= this.startCount &&
			!this.isStarted &&
			this.startDurationMet(now)
		) {
			this.isStarted = true;
			out.events.push("started");
			out.status = "running";
		}

		if (this.isStarted && avg.end > this.endValue) {
			// operating branch
			out.events.push("running");
			out.status = "running";
		} else if (
			this.isStarted &&
			avg.end < this.endValue &&
			this.buffers.end.length >= this.endCount * (2 / 3) &&
			this.endDurationMet(now)
		) {
			// end detection
			out.events.push("finished");
			this.isStarted = false;
			if (avg.end < this.standbyValue) {
				avg.standby = avg.end;
				this.buffers.standby = [];
				out.status = "off";
			} else {
				out.status = "standby";
			}
			this.buffers.start = [];
			this.buffers.end = [];
		}

		// not running
		if (!this.isStarted) {
			if (avg.standby >= this.standbyValue && avg.standby < this.endValue) {
				out.status = "standby";
			} else if (avg.standby <= this.standbyValue) {
				out.status = "off";
			}
		}
	}
}
