import { LegacyDetector } from "./legacy.js";
import { TimedDetector } from "./timed.js";
import { TrailerFilter } from "./trailer.js";
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
export { PauseGuard } from "./pauseGuard.js";
export { TRAILER_BLOCK_SEC, TRAILER_MAX_DEFAULT_SEC, TrailerFilter } from "./trailer.js";
export type { TrailerSettings } from "./trailer.js";
export type { PauseGuardSettings } from "./pauseGuard.js";

/** Device options relevant for the detection. */
export interface DetectorOptions {
	/** Abort detection. */
	abort: boolean;
	/** Corrected abort detection (count and combined mode). */
	abortFixed: boolean;
	/** Poll interval in s (used by the anti-crease filter; default 10). */
	pollSec?: number;
}

/**
 * Effective minimum quiet time of the anti-crease filter.
 *
 * @param s - Detection settings
 * @param pollSec - Poll interval in s
 */
export function trailerGapOf(s: DetectionSettings, pollSec: number): number {
	return (s.trailerGapSec ?? 0) > 0 ? (s.trailerGapSec as number) : Math.max(3 * pollSec, 30);
}

/**
 * Create the detector for a device type (Spec 9.3).
 *
 * - `count`: 3.1.2 detection (optionally with the corrected abort detection).
 * - `timed`: time-based, event-driven detection.
 * - `combined`: 3.1.2 detection plus minimum durations above startVal / below endVal.
 * - with `trailerBurstSec > 0` the detector is wrapped in the anti-crease filter (otherwise unchanged).
 *
 * @param s - Thresholds, mode and durations of the device type
 * @param o - Device options
 */
export function createDetector(s: DetectionSettings, o: DetectorOptions): Detector {
	const inner = createInner(s, o);
	if ((s.trailerBurstSec ?? 0) <= 0) {
		return inner;
	}
	const pollSec = Math.max(1, o.pollSec ?? 10);
	return new TrailerFilter(inner, {
		trailerBurstSec: s.trailerBurstSec as number,
		trailerGapSec: trailerGapOf(s, pollSec),
		trailerAfterSec: s.trailerAfterSec ?? 0,
		trailerBlockVal: s.trailerBlockVal ?? 0,
		trailerMaxSec: s.trailerMaxSec ?? 0,
		endVal: s.endVal,
		standby: s.standby,
		pollSec,
	});
}

/**
 * The detector of the mode without the anti-crease filter.
 *
 * @param s - Detection settings
 * @param o - Device options
 */
function createInner(s: DetectionSettings, o: DetectorOptions): Detector {
	const pauseGuard = { pauseHoldSec: s.pauseHoldSec, pauseUntilSec: s.pauseUntilSec, pauseBelowVal: s.pauseBelowVal };
	switch (s.mode) {
		case "timed":
			return new TimedDetector(s, { abort: o.abort });
		case "combined":
			return new LegacyDetector(s, {
				abort: o.abort,
				abortFixed: o.abortFixed,
				minStartMs: Math.max(s.startDurationSec, 0) * 1000,
				minEndMs: Math.max(s.endDurationSec, 0) * 1000,
				pauseGuard,
			});
		default:
			return new LegacyDetector(s, { abort: o.abort, abortFixed: o.abortFixed, pauseGuard });
	}
}
