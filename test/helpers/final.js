// Final phase values of the washer and helpers to run the detector chain with them (Spec A.3).
import { detectorRun } from "./fixtures.js";
import { runOf } from "./programmes.js";

/** Washer values of 3.1.2 (built-in template, count mode). */
export const WM_312 = {
	startVal: 30,
	endVal: 15,
	standby: 1,
	startCount: 2,
	endCount: 50,
	mode: "count",
	startDurationSec: 60,
	endDurationSec: 300,
};

/** Final phase of the washer as checked on the real data (Spec A.3 "Geprüft", y_actexit.mjs). */
export const WM_FINAL = {
	finalMinVal: 150,
	finalMaxVal: 1311,
	finalHotVal: 1311,
	finalAfterSec: 3600,
	finalMinSec: 168,
	finalQuietSec: 120,
	finalDipSec: 60,
	finalRestVal: 5.5,
	finalRestSec: 60,
	finalActVal: 9,
	finalActShare: 0.7,
	finalCheckSec: 2400,
	finalLockSec: 2700,
};

/** A final phase that fires on the 400-tick random curves of the golden fixture. */
export const SHORT_FINAL = {
	...WM_FINAL,
	finalAfterSec: 0,
	finalMinSec: 30,
	finalQuietSec: 30,
	finalCheckSec: 300,
	finalLockSec: 600,
};

/**
 * A final phase that fires on the random curves and whose lock phase is not ended by the rest proof:
 * reaches the exits a and c–g there (rest proof longer than the lock phase, activity above 0.6 W).
 */
export const LOCK_FINAL = {
	...SHORT_FINAL,
	finalMinSec: 90,
	finalRestVal: 0.5,
	finalRestSec: 14_400,
	finalActVal: 0.6,
	finalActShare: 0.5,
	finalCheckSec: 400,
};

/**
 * Run the detector chain with the washer values and its final phase.
 *
 * @param {number[]} values power per tick (10 s)
 * @param {object} [extra] settings over the washer values
 * @param {object} [o] options of `detectorRun`
 * @returns {ReturnType<typeof detectorRun>} events, ticks, detector
 */
export function finalRun(values, extra = {}, o = {}) {
	return detectorRun(values, { ...WM_312, ...WM_FINAL, ...extra }, o);
}

/**
 * Start events of a run.
 *
 * @param {{ ev: { e: string }[] }} r result of `detectorRun`
 * @returns {{ e: string, i: number, at: number, exit: string | null }[]} starts
 */
export function starts(r) {
	return r.ev.filter(x => x.e === "started");
}

/**
 * End events (finished) of a run.
 *
 * @param {{ ev: { e: string }[] }} r result of `detectorRun`
 * @returns {{ e: string, i: number, at: number, exit: string | null }[]} ends
 */
export function ends(r) {
	return r.ev.filter(x => x.e === "finished");
}

/**
 * Synthetic cotton programme (seed 1) with 3 W in ticks 380–389, so that the final spin from tick 390
 * forms a block of its own after X = 60 min (review/synth2.mjs: early end at the core end + 13).
 *
 * @returns {{ values: number[], coreEnd: number }} values per tick and the last tick of the programme
 */
export function syntheticRun() {
	const r = runOf({ device: "washer", programme: "cotton60", seed: 1 });
	return { values: r.values.map((v, i) => (i >= 380 && i <= 389 ? 3 : v)), coreEnd: r.coreEnd };
}
