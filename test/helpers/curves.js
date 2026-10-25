// Deterministic power curves for detector tests. One value = one 10 s poll tick (W).

/**
 * Small deterministic pseudo random generator (LCG), so curves never change between runs.
 *
 * @param {number} seed start value
 * @returns {() => number} generator returning values in [0, 1)
 */
function lcg(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * Repeat a value n times.
 *
 * @param {number} value power in W
 * @param {number} n number of ticks
 * @returns {number[]} array of n values
 */
function times(value, n) {
	return Array.from({ length: n }, () => value);
}

/**
 * Random values in [min, max], rounded to one decimal.
 *
 * @param {() => number} rnd generator
 * @param {number} min lower bound in W
 * @param {number} max upper bound in W
 * @param {number} n number of ticks
 * @returns {number[]} array of n values
 */
function between(rnd, min, max, n) {
	return Array.from({ length: n }, () => Math.round((min + rnd() * (max - min)) * 10) / 10);
}

/**
 * Washing machine: 3x 0 W, 200 ticks 10-2000 W with short 0 W dips (< 20 ticks), 80x 0.5 W.
 */
function buildWashingMachine() {
	const rnd = lcg(1);
	const run = [
		...between(rnd, 1800, 2000, 30), // heating
		...between(rnd, 10, 400, 40), // washing
		...times(0, 12), // pause (soaking)
		...between(rnd, 10, 400, 40),
		...times(0, 18), // pause before rinsing
		...between(rnd, 50, 300, 30), // rinsing
		...times(0, 5),
		...between(rnd, 300, 800, 25), // spinning
	];
	return [...times(0, 3), ...run, ...times(0.5, 80)];
}

/**
 * Dryer: 3x 0 W, 150 ticks 150-2500 W with short low dips, 40x 0.4 W.
 */
function buildDryer() {
	const rnd = lcg(2);
	const run = [
		...between(rnd, 2000, 2500, 50),
		...between(rnd, 20, 40, 4), // drum reversing
		...between(rnd, 150, 2500, 60),
		...between(rnd, 20, 40, 4),
		...between(rnd, 150, 600, 32), // cool down
	];
	return [...times(0, 3), ...run, ...times(0.4, 40)];
}

/**
 * Dishwasher: 3x 0 W, long low-power programme with two heating phases, ending at 0.3 W.
 */
function buildDishwasher() {
	const rnd = lcg(3);
	const run = [
		...between(rnd, 1900, 2100, 20), // heating
		...between(rnd, 5, 60, 120), // washing
		...between(rnd, 1900, 2100, 15), // second heating
		...between(rnd, 5, 60, 80), // rinsing
		...times(1, 40), // drying
	];
	return [...times(0, 3), ...run, ...times(0.3, 150)];
}

/**
 * Aborted run: start, a short run and then abruptly 0 W (device switched off by hand).
 */
function buildAbortedRun() {
	const rnd = lcg(4);
	return [...times(0, 3), ...between(rnd, 500, 800, 40), ...times(0, 60)];
}

/**
 * Run ending at 3 W: above the standby threshold, below endVal (#471).
 */
function buildStandbyAfterRun() {
	const rnd = lcg(5);
	return [...times(0, 3), ...between(rnd, 100, 1500, 100), ...times(3, 80)];
}

/**
 * Values flapping around a start threshold of 30 W.
 */
function buildFlapping() {
	const block = [0, 35, 20, 35, 36, 2, 33, 1, 0.5, 31, 29, 30, 30.5, 28];
	const out = [];
	for (let i = 0; i < 10; i++) {
		out.push(...block);
	}
	return out;
}

export const washingMachine = buildWashingMachine();
export const dryer = buildDryer();
export const dishwasher = buildDishwasher();
export const abortedRun = buildAbortedRun();
export const standbyAfterRun = buildStandbyAfterRun();
export const flapping = buildFlapping();

/** All curves by name. */
export const curves = { washingMachine, dryer, dishwasher, abortedRun, standbyAfterRun, flapping };

/**
 * Attach timestamps to a curve.
 *
 * @param {number[]} curve power values
 * @param {number} [stepMs] milliseconds between two values
 * @param {number} [startMs] timestamp of the first value
 * @returns {{ power: number, now: number }[]} timed samples
 */
export function withTimes(curve, stepMs = 10_000, startMs = 0) {
	return curve.map((power, i) => ({ power, now: startMs + i * stepMs }));
}
