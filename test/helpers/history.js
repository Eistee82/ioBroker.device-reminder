// Stored history of a power state built from the test curves (one curve value = 10 s).
import { dishwasher, dryer, washingMachine } from "./curves.js";

const STEP = 10_000;
const HOUR = 3_600_000;

/**
 * Repeat a value n times.
 *
 * @param {number} value power in W
 * @param {number} n number of ticks
 * @returns {number[]} array of n values
 */
export function times(value, n) {
	return new Array(n).fill(value);
}

/**
 * Washing machine run with a long soaking pause (20 min at 0 W) in the middle.
 */
export const longPause = [...washingMachine.slice(0, 80), ...times(0, 120), ...washingMachine.slice(80)];

/**
 * Short programme: only the first part of the washing machine run.
 */
export const shortRun = [...washingMachine.slice(0, 90), ...times(0.5, 80)];

/**
 * Curve whose idle level after the run is 0 W instead of 0.5 W.
 *
 * @param {number[]} c curve
 * @returns {number[]} curve with 0 W instead of 0.5 W
 */
export function zeroTail(c) {
	return c.map(v => (v === 0.5 ? 0 : v));
}

/** Dryer with an anti-crease trailer: bursts of 20 s (600 W) every 5 min after the end. */
export const dryerAntiCrease = [
	...dryer.slice(0, 153),
	...Array.from({ length: 6 }, () => [...times(0.4, 30), 600, 600]).flat(),
	...times(0.4, 200),
];

/** Dishwasher with 60 min of drying at 1 W. */
export const dishwasherLongDrying = [...dishwasher.slice(0, 238), ...times(1, 360), ...times(0.3, 150)];

/** Heating for 25 min at a constant 2000 W, then the washing machine programme. */
export const steadyHeat = [...times(0, 3), ...times(2000, 150), ...washingMachine.slice(33)];

/**
 * History as a history adapter stores it (only changes): every curve is followed by hours of idle,
 * with a short display spike (30 W for 20 s) in each idle period.
 *
 * @param {number[][]} runs curves of the runs
 * @param {number} [start] timestamp of the first value
 * @param {object} [o] options
 * @param {number} [o.idle] idle level between the runs (W)
 * @param {boolean} [o.relog] whether the unchanged value is stored again every hour
 * @param {number} [o.deadband] only store values differing at least this much from the last stored one
 * @param {number[][]} [o.between] values after run i instead of the idle period
 * @returns {{ ts: number, val: number }[]} stored values
 */
export function historyOf(runs, start = 1_700_000_000_000, o = {}) {
	const { idle = 0.5, relog = true, deadband = 0, between = [] } = o;
	const values = [];
	runs.forEach((run, i) => {
		values.push(...run);
		if (between[i]) {
			values.push(...between[i]);
		} else {
			values.push(...times(idle, 360), 30, 30, ...times(idle, 1800));
		}
	});
	const points = [];
	values.forEach((val, i) => {
		const last = points.at(-1);
		if (!last || (deadband > 0 ? Math.abs(val - last.val) >= deadband : last.val !== val)) {
			points.push({ ts: start + i * STEP, val });
		}
	});
	if (relog) {
		// the history adapter also stores the unchanged value now and then
		const end = start + values.length * STEP;
		const extra = [];
		let idx = 0;
		for (let ts = start + HOUR; ts < end; ts += HOUR) {
			while (idx + 1 < points.length && points[idx + 1].ts <= ts) {
				idx++;
			}
			if (points[idx].ts !== ts) {
				extra.push({ ts, val: points[idx].val });
			}
		}
		points.push(...extra);
	}
	return points.sort((a, b) => a.ts - b.ts);
}

/**
 * Timestamp of the first value of every run in `historyOf(runs, start, o)`.
 *
 * @param {number[][]} runs curves of the runs
 * @param {number} [start] timestamp of the first value
 * @param {object} [o] options of historyOf
 * @param {number[][]} [o.between] values after run i instead of the idle period
 * @returns {number[]} timestamps
 */
export function runStarts(runs, start = 1_700_000_000_000, o = {}) {
	const out = [];
	let idx = 0;
	runs.forEach((run, i) => {
		out.push(start + idx * STEP);
		idx += run.length + (o.between?.[i] ? o.between[i].length : 2162);
	});
	return out;
}

/**
 * Timestamp of the last value above a level of every run in `historyOf(runs, start, o)`.
 *
 * @param {number[][]} runs curves of the runs
 * @param {number} level power in W
 * @param {number} [start] timestamp of the first value
 * @param {object} [o] options of historyOf
 * @returns {number[]} timestamps
 */
export function runEnds(runs, level, start = 1_700_000_000_000, o = {}) {
	const starts = runStarts(runs, start, o);
	return runs.map((run, i) => {
		let last = 0;
		run.forEach((v, j) => {
			if (v > level) {
				last = j;
			}
		});
		return starts[i] + last * STEP;
	});
}
