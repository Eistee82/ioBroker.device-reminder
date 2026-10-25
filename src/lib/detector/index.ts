import { LegacyDetector } from "./legacy.js";
import { TimedDetector } from "./timed.js";
import type { DetectionSettings, Detector } from "./types.js";

export type {
	DetectionMode,
	DetectionSettings,
	Detector,
	DetectorEvent,
	DeviceStatus,
	TickHints,
	TickResult,
	TypeThresholds,
} from "./types.js";
export { LegacyDetector } from "./legacy.js";
export { TimedDetector } from "./timed.js";

/** Device options relevant for the detection. */
export interface DetectorOptions {
	/** Abort detection. */
	abort: boolean;
	/** Corrected abort detection (count and combined mode). */
	abortFixed: boolean;
}

/**
 * Create the detector for a device type (Spec 9.3).
 *
 * - `count`: 3.1.2 detection (optionally with the corrected abort detection).
 * - `timed`: time-based, event-driven detection.
 * - `combined`: 3.1.2 detection plus minimum durations above startVal / below endVal.
 *
 * @param s - Thresholds, mode and durations of the device type
 * @param o - Device options
 */
export function createDetector(s: DetectionSettings, o: DetectorOptions): Detector {
	switch (s.mode) {
		case "timed":
			return new TimedDetector(s, { abort: o.abort });
		case "combined":
			return new LegacyDetector(s, {
				abort: o.abort,
				abortFixed: o.abortFixed,
				minStartMs: Math.max(s.startDurationSec, 0) * 1000,
				minEndMs: Math.max(s.endDurationSec, 0) * 1000,
			});
		default:
			return new LegacyDetector(s, { abort: o.abort, abortFixed: o.abortFixed });
	}
}
