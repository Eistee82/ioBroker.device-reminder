// Final phase values of the washer and helpers to run the detector chain with them (Spec A.3, B.6).
import { baseBandsOf } from "../../build/lib/learn/bands.js";
import { checkRuns, runSamples } from "../../build/lib/learn/quality.js";
import { fromPoints } from "../../build/lib/learn/ticks.js";
import { BASE_TS, detectorRun, layoutOf } from "./fixtures.js";
import { runOf } from "./programmes.js";

const MIN = 60_000;

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

/**
 * Input of `learnFinal` from stored values: samples of every run, base bands and the run check
 * (`runSamples` + `baseBandsOf` + `checkRuns`).
 *
 * @param {{ ts: number, val: number }[]} points stored values in the unit of the state
 * @param {object} [o] options
 * @param {number} [o.stepMs] poll interval (10 000)
 * @param {number} [o.unitFactor] W per unit of the state (1)
 * @param {{ from: number, to: number }[]} [o.outages] outages
 * @param {"live" | "history"} [o.src] origin ("history")
 * @returns {{ runs: { sample: object, verdict: object, series: object }[], bands: object, layout: object, series: object }} input
 */
export function learnInput(points, o = {}) {
	const { stepMs = 10_000, unitFactor = 1, outages = [], src = "history" } = o;
	const { samples, layout, series } = runSamples("wm", points, { stepMs, src, unitFactor });
	const bands = baseBandsOf(samples, layout.runLimit / unitFactor);
	const verdicts = checkRuns(samples, {
		bands,
		unitFactor,
		unit: unitFactor === 1000 ? "kW" : "W",
		settings: null,
		pollMs: stepMs,
		outages,
		scope: "run",
	});
	return { runs: samples.map((sample, k) => ({ sample, verdict: verdicts[k], series })), bands, layout, series };
}

/**
 * Input of `learnPhases` from stored values (scope run): every sample with its verdict of the run check
 * (`runSamples` + `baseBandsOf` + `checkRuns`, like `learnInput`).
 *
 * @param {{ ts: number, val: number }[]} points stored values in the unit of the state
 * @param {object} [o] options of `learnInput`
 * @returns {{ units: { sample: object, verdict: object }[], runLimit: number }} samples and run level in W
 */
export function phaseInput(points, o = {}) {
	const { runs, layout } = learnInput(points, o);
	return { units: runs.map(({ sample, verdict }) => ({ sample, verdict })), runLimit: layout.runLimit };
}

/**
 * Soaking programme (Spec 8.2): before the final spin of run k a copy of that spin block, then 45 min of
 * `level` W; everything from the final spin on comes later by that time.
 *
 * @param {{ ts: number, val: number }[]} points stored values in W
 * @param {number} k index into the layout runs
 * @param {number} [level] power while soaking in W
 * @returns {{ ts: number, val: number }[]} stored values
 */
export function soaking(points, k, level = 3) {
	const { s, L } = layoutOf(points);
	const r = L.runs[k];
	const from = s.t0 + r.endBlockFrom * s.stepMs;
	const to = s.t0 + (r.endBlockTo + 1) * s.stepMs;
	const held = points.findLast(p => p.ts <= from);
	const block = points.filter(p => p.ts > from && p.ts < to);
	const shiftMs = to - from + 45 * MIN;
	return [
		...points.filter(p => p.ts < from),
		{ ts: from, val: held.val },
		...block,
		{ ts: to, val: level },
		{ ts: from + shiftMs, val: held.val },
		...points.filter(p => p.ts > from).map(p => ({ ts: p.ts + shiftMs, val: p.val })),
	];
}

/** A marked start more than this after the early end is the next programme, not the rest of a split one. */
const SPLIT_WITHIN_MS = 3 * 60 * MIN;

/**
 * One part of a split programme as a sample of the run check.
 *
 * @param {{ ts: number, val: number }[]} points stored values (sorted)
 * @param {number} from begin of the stored values of the part
 * @param {number} start start of the part
 * @param {number} end end of the part
 * @param {string} [afterFinal] exit that ended the lock phase before the part
 * @returns {object} sample
 */
function partOf(points, from, start, end, afterFinal) {
	const held = points.findLast(p => p.ts <= from);
	const pts = [...(held ? [{ ts: from, val: held.val }] : []), ...points.filter(p => p.ts > from && p.ts <= end)];
	return {
		points: pts,
		from,
		to: end,
		key: `wm@${start}`,
		kind: "run",
		src: "live",
		info: null,
		family: -1,
		...(afterFinal ? { afterFinal } : {}),
		starts: [start],
		facts: {
			start,
			coreEnd: end,
			progEnd: end,
			runEnd: end,
			end,
			coreSec: (end - start) / 1000,
			feat: null,
			offSec: null,
			preLevel: null,
			postLevel: null,
			restLevel: null,
			endBlocks: [],
			invalidShare: 0,
			timeJumps: 0,
		},
	};
}

/**
 * Programmes split by an early end: the detector chain with the washer values and the final phase runs
 * over the values; for every start with the mark b–g (exit a is no split, the mark sits on the first
 * start after the lock phase only) that comes within 3 h of the early end before it, the early part
 * (run start to early end) and the rest (early end to its end, so the time between the parts is in it)
 * are returned as samples.
 *
 * @param {{ ts: number, val: number }[]} points stored values in W
 * @param {object} finalValues final phase values
 * @param {number} [stepMs] poll interval
 * @returns {{ prev: object, next: object }[]} pairs
 */
export function splitPairs(points, finalValues, stepMs = 10_000) {
	const sorted = [...points].sort((a, b) => a.ts - b.ts);
	const s = fromPoints(sorted, stepMs);
	const values = Array.from({ length: s.length }, (_, i) => (Number.isFinite(s.last[i]) ? s.last[i] : 0));
	const { ev } = detectorRun(values, { ...WM_312, ...finalValues }, { pollSec: stepMs / 1000 });
	const T = at => s.t0 + at;
	const out = [];
	ev.forEach((x, k) => {
		if (x.e !== "started" || x.exit === null || x.exit === "a") {
			return;
		}
		const early = ev.slice(0, k).findLast(y => y.e === "finished");
		const begin = early && ev.slice(0, k).findLast(y => y.e === "started" && y.at <= early.at);
		const done = ev.slice(k + 1).find(y => y.e === "finished");
		if (!early || !begin || !done || x.at - early.at > SPLIT_WITHIN_MS) {
			return;
		}
		out.push({
			prev: partOf(sorted, T(begin.at) - stepMs, T(begin.at), T(early.at)),
			next: partOf(sorted, T(early.at), T(x.at), T(done.at), x.exit),
		});
	});
	return out;
}

/**
 * `splitPairs` for values per tick (tick i at `BASE_TS + i · stepMs`).
 *
 * @param {number[]} values power per tick
 * @param {object} finalValues final phase values
 * @param {number} [stepMs] poll interval
 * @returns {{ prev: object, next: object }[]} pairs
 */
export function splitPairsOfTicks(values, finalValues, stepMs = 10_000) {
	return splitPairs(
		values.map((val, i) => ({ ts: BASE_TS + i * stepMs, val })),
		finalValues,
		stepMs,
	);
}
