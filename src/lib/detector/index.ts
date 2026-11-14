import { FinalPhaseFilter, finalFloors } from "./finalPhase.js";
import { LegacyDetector } from "./legacy.js";
import { TimedDetector } from "./timed.js";
import { TrailerFilter } from "./trailer.js";
import { FINAL_KEYS } from "./types.js";
import type { DetectionSettings, Detector, FinalSettings } from "./types.js";

export type {
	DetectionMode,
	DetectionSettings,
	Detector,
	DetectorEvent,
	DeviceStatus,
	FinalExit,
	FinalKey,
	FinalSettings,
	FinalStats,
	TickHints,
	TickResult,
	TypeThresholds,
} from "./types.js";
export { FINAL_KEYS } from "./types.js";
export { FINAL_ACT_WINDOW_MS, FinalPhaseFilter, finalFloors } from "./finalPhase.js";
export type { FinalPhaseOptions } from "./finalPhase.js";
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
	/** Poll interval in s (used by the anti-crease filter and the final phase; default 10). */
	pollSec?: number;
	/** Final phase: start in the lock phase that began at this time (restart during the lock phase). */
	resumeLockAt?: number;
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
 * Whether the final phase is on: master switch `finalMinVal > 0 && finalMinSec > 0` (Spec A.2).
 *
 * @param s - Detection settings
 */
export function finalOn(s: DetectionSettings): boolean {
	return (s.finalMinVal ?? 0) > 0 && (s.finalMinSec ?? 0) > 0;
}

/**
 * Create the detector for a device type (Spec 9.3).
 *
 * - `count`: 3.1.2 detection (optionally with the corrected abort detection).
 * - `timed`: time-based, event-driven detection.
 * - `combined`: 3.1.2 detection plus minimum durations above startVal / below endVal.
 * - with the final phase on (`finalOn`) the detector of the mode is wrapped in the final phase filter,
 *   and with `trailerBurstSec > 0` everything in the anti-crease filter (outside); otherwise unchanged.
 *
 * @param s - Thresholds, mode and durations of the device type
 * @param o - Device options
 */
export function createDetector(s: DetectionSettings, o: DetectorOptions): Detector {
	const pollSec = Math.max(1, o.pollSec ?? 10);
	let inner = createInner(s, o);
	if (finalOn(s)) {
		inner = new FinalPhaseFilter(inner, finalSettingsOf(s), {
			pollSec,
			standby: s.standby,
			resumeLockAt: o.resumeLockAt,
		});
	}
	if ((s.trailerBurstSec ?? 0) <= 0) {
		return inner;
	}
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
 * Values of the final phase the filter works with: 0 replaced by the default, the floors per poll applied
 * (`finalFloors`). Times in s, levels in the unit of the state.
 *
 * @param s - Detection settings
 * @param pollSec - Poll interval in s
 */
export function finalValuesOf(s: DetectionSettings, pollSec: number): Required<FinalSettings> {
	return finalFloors(finalSettingsOf(s), Math.max(1, pollSec), s.standby);
}

/**
 * Every field of the final phase (missing or invalid = 0).
 *
 * @param s - Detection settings
 */
function finalSettingsOf(s: DetectionSettings): Required<FinalSettings> {
	const out = {} as Required<FinalSettings>;
	for (const k of FINAL_KEYS) {
		const v = s[k];
		out[k] = typeof v === "number" && Number.isFinite(v) ? v : 0;
	}
	return out;
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
