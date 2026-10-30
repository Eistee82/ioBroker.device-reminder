// Stored history of a power state built from the test curves (one curve value = 10 s).
import { washingMachine } from "./curves.js";

const STEP = 10_000;
const HOUR = 3_600_000;

/**
 * Washing machine run with a long soaking pause (20 min at 0 W) in the middle.
 */
export const longPause = [...washingMachine.slice(0, 80), ...new Array(120).fill(0), ...washingMachine.slice(80)];

/**
 * Short programme: only the first part of the washing machine run.
 */
export const shortRun = [...washingMachine.slice(0, 90), ...new Array(80).fill(0.5)];

/**
 * History as a history adapter stores it (only changes): every curve is followed by hours of idle,
 * with a short display spike (30 W for 20 s) in each idle period.
 *
 * @param {number[][]} runs curves of the runs
 * @param {number} [start] timestamp of the first value
 * @returns {{ ts: number, val: number }[]} stored values
 */
export function historyOf(runs, start = 1_700_000_000_000) {
	const values = [];
	for (const run of runs) {
		values.push(...run, ...new Array(360).fill(0.5), 30, 30, ...new Array(1800).fill(0.5));
	}
	const points = [];
	values.forEach((val, i) => {
		if (points.length === 0 || points[points.length - 1].val !== val) {
			points.push({ ts: start + i * STEP, val });
		}
	});
	// the history adapter also stores the unchanged value now and then
	const end = start + values.length * STEP;
	for (let ts = start + HOUR; ts < end; ts += HOUR) {
		const last = points.filter(p => p.ts <= ts).at(-1);
		if (last && last.ts !== ts) {
			points.push({ ts, val: last.val });
		}
	}
	return points.sort((a, b) => a.ts - b.ts);
}
