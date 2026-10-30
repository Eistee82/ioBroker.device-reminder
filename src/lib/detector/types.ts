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
