// Programmes of a washing machine and a dryer with anti-crease phases (one value = one 10 s tick, W).

/**
 * Small deterministic pseudo random generator (LCG).
 *
 * @param {number} seed start value
 * @returns {() => number} generator returning values in [0, 1)
 */
export function lcg(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * Repeat a value n times.
 *
 * @param {number} v power
 * @param {number} n ticks
 * @returns {number[]} values
 */
export function times(v, n) {
	return new Array(Math.max(0, Math.round(n))).fill(v);
}

/**
 * Random values between two powers.
 *
 * @param {() => number} rnd generator
 * @param {number} lo lower power
 * @param {number} hi upper power
 * @param {number} n ticks
 * @returns {number[]} values
 */
function between(rnd, lo, hi, n) {
	return Array.from({ length: Math.max(0, Math.round(n)) }, () => Math.round((lo + rnd() * (hi - lo)) * 10) / 10);
}

/**
 * Washing with tumbling: the drum turns 10-20 s and stops 5-15 s (motor 80-400 W, stopped 5 W).
 *
 * @param {() => number} rnd generator
 * @param {number} n ticks
 * @returns {number[]} values
 */
function tumble(rnd, n) {
	const out = [];
	while (out.length < n) {
		out.push(...between(rnd, 80, 400, 1 + Math.floor(rnd() * 2)));
		if (rnd() < 0.6) {
			out.push(5);
		}
	}
	return out.slice(0, n);
}

/**
 * Soaking: the drum turns for 10-20 s every `everyTicks` ticks, else 3 W.
 *
 * @param {() => number} rnd generator
 * @param {number} n ticks
 * @param {number} everyTicks period
 * @returns {number[]} values
 */
function soak(rnd, n, everyTicks) {
	const out = [];
	while (out.length < n) {
		out.push(...times(3, everyTicks - 2), ...between(rnd, 120, 200, 2));
	}
	return out.slice(0, n);
}

/** Washing machine programmes (core part, without idle before and after). */
export const WASHER = {
	cotton60: rnd => [
		...between(rnd, 1900, 2100, 90),
		...tumble(rnd, 180),
		...times(3, 6),
		...tumble(rnd, 30),
		...times(3, 9),
		...tumble(rnd, 30),
		...times(3, 9),
		...tumble(rnd, 30),
		...between(rnd, 300, 800, 50),
	],
	quick30: rnd => [
		...between(rnd, 1900, 2100, 30),
		...tumble(rnd, 60),
		...times(3, 6),
		...tumble(rnd, 24),
		...between(rnd, 300, 800, 30),
	],
	eco4060: rnd => [
		...between(rnd, 1900, 2100, 60),
		...tumble(rnd, 60),
		...soak(rnd, 150, 12),
		...tumble(rnd, 90),
		...times(3, 9),
		...tumble(rnd, 30),
		...between(rnd, 300, 800, 40),
	],
	wool: rnd => [
		...between(rnd, 1900, 2100, 20),
		...tumble(rnd, 18),
		...times(3, 18),
		...tumble(rnd, 18),
		...times(3, 18),
		...tumble(rnd, 18),
		...times(3, 12),
		...between(rnd, 300, 600, 24),
	],
	spinOnly: rnd => [...tumble(rnd, 12), ...between(rnd, 300, 800, 48)],
};

/** Dryer programmes (core part). */
export const DRYER = {
	cupboard: rnd => [...between(rnd, 2000, 2500, 360), ...between(rnd, 150, 300, 60)],
	iron: rnd => [...between(rnd, 2000, 2500, 240), ...between(rnd, 150, 300, 48)],
	refresh: rnd => [...between(rnd, 300, 600, 120)],
	heatPump: rnd => [...between(rnd, 600, 900, 600), ...between(rnd, 150, 300, 60)],
};

/**
 * Anti-crease shapes: burst power, burst ticks, distance in ticks (burst start to burst start), total ticks.
 * T6 stops after 10 minutes (door opened).
 */
export const ANTI_CREASE = {
	T1: { power: 600, burst: 2, every: 30, total: 360 },
	T2: { power: 300, burst: 1, every: 6, total: 180 },
	T3: { power: 100, burst: 3, every: 12, total: 540 },
	T4: { power: 450, burst: 2, every: 18, total: 720 },
	T5: { power: 200, burst: 2, every: 24, total: 270 },
	T6: { power: 300, burst: 2, every: 12, total: 60 },
};

/**
 * Anti-crease phase after a programme.
 *
 * @param {() => number} rnd generator
 * @param {keyof typeof ANTI_CREASE} shape shape
 * @param {number} idle electronics level between the bursts
 * @returns {number[]} values
 */
export function antiCrease(rnd, shape, idle) {
	const { power, burst, every, total } = ANTI_CREASE[shape];
	const out = [];
	while (out.length + every <= total) {
		out.push(...times(idle, every - burst), ...between(rnd, power * 0.9, power * 1.1, burst));
	}
	return out;
}

/**
 * One run: idle, programme, optional anti-crease phase, idle.
 *
 * @param {object} o options
 * @param {"washer" | "dryer"} o.device device
 * @param {string} o.programme programme name
 * @param {keyof typeof ANTI_CREASE | null} [o.shape] anti-crease shape
 * @param {number} [o.seed] seed
 * @param {number} [o.idle] idle level after the programme
 * @param {number} [o.after] idle ticks after the run
 * @param {number} [o.pause] level of the pauses inside the programme (default 3 W, drum stops 5 W)
 * @returns {{ values: number[], start: number, coreEnd: number }} values and the index of the start and of the last programme tick
 */
export function runOf(o) {
	const rnd = lcg(o.seed ?? 1);
	const idle = o.idle ?? 0.8;
	const raw = (o.device === "dryer" ? DRYER : WASHER)[o.programme](rnd);
	const core = o.pause === undefined ? raw : raw.map(v => (v === 3 || v === 5 ? o.pause : v));
	const before = times(0.3, 6);
	const trailer = o.shape ? antiCrease(rnd, o.shape, idle) : [];
	const values = [...before, ...core, ...trailer, ...times(o.shape ? 0.3 : idle, o.after ?? 360)];
	return { values, start: before.length, coreEnd: before.length + core.length - 1 };
}
