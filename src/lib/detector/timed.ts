import type { DetectionSettings, Detector, DetectorEvent, DeviceStatus, TickResult } from "./types.js";

/** Options of the time-based detection. */
export interface TimedOptions {
	/** Abort detection: running and below standby for at least endDurationSec / 2 → "aborted". */
	abort: boolean;
}

/**
 * Time-based (event-driven) start/end detection (Spec 9.3, #435).
 *
 * Works with plugs that only report on change: `feed()` is called for every new power value,
 * `tick()` on every poll with the last known value and only advances the time conditions.
 *
 * - Start: power >= startVal without interruption for >= startDurationSec.
 * - End: power < endVal without interruption for >= endDurationSec (a value >= endVal resets the timer).
 * - Abort (option): running and power < standby without interruption for >= endDurationSec / 2.
 * - Status after the end or while not running: < standby → "off", < endVal → "standby".
 */
export class TimedDetector implements Detector {
	private readonly startValue: number;
	private readonly endValue: number;
	private readonly standbyValue: number;
	private readonly startMs: number;
	private readonly endMs: number;
	private readonly abort: boolean;
	private isStarted = false;
	private aboveStartSince: number | null = null;
	private belowEndSince: number | null = null;
	private belowStandbySince: number | null = null;

	/**
	 * @param settings - Thresholds and durations of the device type
	 * @param options - Detection options
	 */
	public constructor(settings: DetectionSettings, options: TimedOptions) {
		this.startValue = settings.startVal;
		this.endValue = settings.endVal;
		this.standbyValue = settings.standby || 1;
		this.startMs = Math.max(settings.startDurationSec, 0) * 1000;
		this.endMs = Math.max(settings.endDurationSec, 0) * 1000;
		this.abort = options.abort;
	}

	/** Whether a run is in progress. */
	public get started(): boolean {
		return this.isStarted;
	}

	/** Reset to the initial state. */
	public reset(): void {
		this.isStarted = false;
		this.aboveStartSince = null;
		this.belowEndSince = null;
		this.belowStandbySince = null;
	}

	/**
	 * Evaluate a newly arrived power value.
	 *
	 * @param power - New power value in W
	 * @param now - Timestamp of the value in ms
	 */
	public feed(power: number, now: number): TickResult {
		return this.step(power, now);
	}

	/**
	 * Evaluate one poll step with the last known power value. A repeated value does not reset any
	 * timer, so only the time conditions advance.
	 *
	 * @param power - Last known power in W
	 * @param now - Timestamp in ms
	 */
	public tick(power: number, now: number): TickResult {
		return this.step(power, now);
	}

	/**
	 * @param power - Power value in W
	 * @param now - Timestamp in ms
	 */
	private step(power: number, now: number): TickResult {
		this.track(power, now);
		const events: DetectorEvent[] = [];
		let status: DeviceStatus | null = null;

		if (!this.isStarted) {
			if (this.elapsed(this.aboveStartSince, now, this.startMs)) {
				this.isStarted = true;
				events.push("started");
				status = "running";
			} else {
				status = this.idleStatus(power);
			}
		} else if (this.abort && this.elapsed(this.belowStandbySince, now, this.endMs / 2)) {
			this.isStarted = false;
			events.push("aborted");
			status = "off";
		} else if (this.elapsed(this.belowEndSince, now, this.endMs)) {
			this.isStarted = false;
			events.push("finished");
			status = power < this.standbyValue ? "off" : "standby";
		} else {
			events.push("running");
			status = "running";
		}

		return { events, status, average: power, started: this.isStarted };
	}

	/**
	 * @param power - Power value in W
	 * @param now - Timestamp in ms
	 */
	private track(power: number, now: number): void {
		this.aboveStartSince = power >= this.startValue ? (this.aboveStartSince ?? now) : null;
		this.belowEndSince = power < this.endValue ? (this.belowEndSince ?? now) : null;
		this.belowStandbySince = power < this.standbyValue ? (this.belowStandbySince ?? now) : null;
	}

	/**
	 * @param since - Start of the condition or null
	 * @param now - Timestamp in ms
	 * @param durationMs - Required duration in ms
	 */
	private elapsed(since: number | null, now: number, durationMs: number): boolean {
		return since !== null && now - since >= durationMs;
	}

	/**
	 * Status while not running.
	 *
	 * @param power - Power value in W
	 */
	private idleStatus(power: number): DeviceStatus | null {
		if (power < this.standbyValue) {
			return "off";
		}
		if (power < this.endValue) {
			return "standby";
		}
		return null;
	}
}
