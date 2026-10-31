/** Detection thresholds of a device type (3.1.2 semantics). */
export interface TypeThresholds {
	/** Power in W at or above which the device counts as started. */
	startVal: number;
	/** Power in W below which the device counts as finished. */
	endVal: number;
	/** Power in W below which the device counts as switched off. */
	standby: number;
	/** Number of consecutive samples required for the start. */
	startCount: number;
	/** Number of samples used for end detection. */
	endCount: number;
}

/** Status of a device. */
export type DeviceStatus = "running" | "standby" | "off";

/** Event emitted by a detector. */
export type DetectorEvent = "started" | "running" | "finished" | "aborted";

/** Result of one detector step. */
export interface TickResult {
	/** Events raised in this step. */
	events: DetectorEvent[];
	/** Last status set in this step, otherwise null. */
	status: DeviceStatus | null;
	/** Last average consumption written in this step, otherwise null. */
	average: number | null;
	/** Whether a run is in progress after this step. */
	started: boolean;
	/**
	 * Time of the call that raised each event (same length as `events`). Only set by detectors that
	 * pass on calls later (anti-crease filter); otherwise every event belongs to the current call.
	 */
	times?: number[];
}

/** How start and end are detected. */
export type DetectionMode = "count" | "timed" | "combined";

/** Thresholds plus the time-based settings. */
export interface DetectionSettings extends TypeThresholds {
	/** Detection mode. */
	mode: DetectionMode;
	/** Minimum duration in seconds above the start threshold. */
	startDurationSec: number;
	/** Minimum duration in seconds below the end threshold. */
	endDurationSec: number;
	/** Pause protection: hold time in seconds (0 or missing = off). */
	pauseHoldSec?: number;
	/** Pause protection: a phase below endVal beginning within this many seconds of the start is a pause (0 = unused). */
	pauseUntilSec?: number;
	/** Pause protection: a phase below endVal staying below this power is a pause (0 = unused). */
	pauseBelowVal?: number;
	/** Anti-crease filter (master switch): longest phase >= endVal that still counts as a drum burst in s (0 = off). */
	trailerBurstSec?: number;
	/** Anti-crease filter: minimum time below endVal before a burst can be held in s (0 = automatic). */
	trailerGapSec?: number;
	/** Anti-crease filter: bursts are held only this many seconds after the start (0 = unused). */
	trailerAfterSec?: number;
	/** Anti-crease filter: bursts are held only after a sustained block with a mean of at least this power (0 = unused). */
	trailerBlockVal?: number;
	/** Anti-crease filter: how long the anti-crease phase may last after the end in s. */
	trailerMaxSec?: number;
}

/** Additional evidence for one poll step. */
export interface TickHints {
	/** Whether the configured switch is known to be off (false/unknown without a switch). */
	switchOff?: boolean;
}

/** A start/end detector fed with power values. */
export interface Detector {
	/** Evaluate one poll step. */
	tick(power: number, now: number, hints?: TickHints): TickResult;
	/** Evaluate a newly arrived power value (time-based modes). */
	feed?(power: number, now: number): TickResult;
	/** Whether a run is in progress. */
	readonly started: boolean;
	/** Reset to the initial state. */
	reset(): void;
}
