/** One stored value of the power state. */
export interface HistoryPoint {
	/** Timestamp in ms. */
	ts: number;
	/** Power (unit of the state; W inside the learning core). */
	val: number;
}

/**
 * Power values on the poll grid. Tick `i` stands for the time `t0 + i * stepMs` and holds what the
 * runtime knows at that time: the last value at or before it, plus the extremes of the values that
 * arrived since the previous tick.
 */
export interface TickSeries {
	/** Time of tick 0 in ms. */
	t0: number;
	/** Poll interval in ms. */
	stepMs: number;
	/** Number of ticks. */
	length: number;
	/** Last value at or before the tick (W). */
	last: Float64Array;
	/** Smallest value in (t - step, t], otherwise the last value. */
	min: Float64Array;
	/** Largest value in (t - step, t], otherwise the last value. */
	max: Float64Array;
	/** 1 = at least one stored value in (t - step, t]. */
	has: Uint8Array;
	/** 0 = gap or unknown (before the first value, failed query, logger gap). */
	valid: Uint8Array;
	/** Timestamp of the value in `last` while building; null after `finalize`. */
	lastTs: Float64Array | null;
	/** Number of processed stored values. */
	points: number;
	/** First tick with a stored value (set by `finalize`; `length` if there is none). */
	firstIdx: number;
}

/** A gap without stored values longer than this, while the device was running, is unknown. */
export const GAP_MS = 2 * 60 * 60_000;

/**
 * Empty series.
 *
 * @param t0 - Time of tick 0 in ms
 * @param stepMs - Poll interval in ms
 * @param length - Number of ticks
 */
export function createSeries(t0: number, stepMs: number, length: number): TickSeries {
	const n = Math.max(0, Math.floor(length));
	const series: TickSeries = {
		t0,
		stepMs,
		length: n,
		last: new Float64Array(n).fill(Number.NaN),
		min: new Float64Array(n).fill(Number.NaN),
		max: new Float64Array(n).fill(Number.NaN),
		has: new Uint8Array(n),
		valid: new Uint8Array(n).fill(1),
		lastTs: new Float64Array(n).fill(Number.NEGATIVE_INFINITY),
		points: 0,
		firstIdx: 0,
	};
	return series;
}

/**
 * Add stored values (any order; duplicates at chunk borders are harmless).
 *
 * @param series - Series under construction
 * @param points - Stored values in W
 */
export function foldPoints(series: TickSeries, points: readonly HistoryPoint[]): void {
	const lastTs = series.lastTs;
	if (!lastTs) {
		return;
	}
	for (const p of points) {
		if (!Number.isFinite(p.ts) || !Number.isFinite(p.val)) {
			continue;
		}
		const i = Math.ceil((p.ts - series.t0) / series.stepMs);
		if (i < 0 || i >= series.length) {
			continue;
		}
		series.points++;
		if (series.has[i] === 0) {
			series.has[i] = 1;
			series.min[i] = p.val;
			series.max[i] = p.val;
		} else {
			series.min[i] = Math.min(series.min[i], p.val);
			series.max[i] = Math.max(series.max[i], p.val);
		}
		if (p.ts >= lastTs[i]) {
			lastTs[i] = p.ts;
			series.last[i] = p.val;
		}
	}
}

/**
 * Mark a time range as unknown (failed query).
 *
 * @param series - Series
 * @param from - Start in ms (inclusive)
 * @param to - End in ms (exclusive)
 */
export function markInvalid(series: TickSeries, from: number, to: number): void {
	const a = Math.max(0, Math.ceil((from - series.t0) / series.stepMs));
	const b = Math.min(series.length - 1, Math.ceil((to - series.t0) / series.stepMs) - 1);
	for (let i = a; i <= b; i++) {
		series.valid[i] = 0;
	}
}

/**
 * Fill ticks without stored value with the last known value; ticks before the first value are unknown.
 *
 * @param series - Series under construction
 */
export function finalize(series: TickSeries): void {
	let known = false;
	let value = 0;
	series.firstIdx = series.length;
	for (let i = 0; i < series.length; i++) {
		if (series.has[i] === 1) {
			if (!known) {
				series.firstIdx = i;
			}
			known = true;
			value = series.last[i];
			continue;
		}
		if (!known) {
			series.valid[i] = 0;
			series.last[i] = 0;
			series.min[i] = 0;
			series.max[i] = 0;
			continue;
		}
		series.last[i] = value;
		series.min[i] = value;
		series.max[i] = value;
	}
	series.lastTs = null;
}

/**
 * Stretches without stored value longer than GAP_MS while the last value was above the run level
 * are unknown: the logger (or the plug) was gone while the device was running.
 *
 * @param series - Finalized series
 * @param runLimit - Run level in W
 * @returns number of ticks marked unknown
 */
export function applyGapRule(series: TickSeries, runLimit: number): number {
	const gapTicks = Math.floor(GAP_MS / series.stepMs);
	let marked = 0;
	let i = 0;
	while (i < series.length) {
		if (series.has[i] === 1 || series.valid[i] === 0) {
			i++;
			continue;
		}
		let j = i;
		while (j + 1 < series.length && series.has[j + 1] === 0 && series.valid[j + 1] === 1) {
			j++;
		}
		if (j - i + 1 > gapTicks && i > 0 && series.last[i - 1] > runLimit) {
			for (let k = i; k <= j; k++) {
				series.valid[k] = 0;
			}
			marked += j - i + 1;
		}
		i = j + 1;
	}
	return marked;
}

/**
 * Copy of a series with every value multiplied by a factor (for example W to kW).
 *
 * @param series - Finalized series
 * @param factor - Factor
 */
export function scaled(series: TickSeries, factor: number): TickSeries {
	const mul = (a: Float64Array): Float64Array => a.map(v => v * factor);
	return { ...series, last: mul(series.last), min: mul(series.min), max: mul(series.max) };
}

/**
 * Series from a list of values (tests, recordings): tick 0 is the first value.
 *
 * @param points - Stored values in W (any order)
 * @param stepMs - Poll interval in ms
 * @param extendMs - Time after the last value in which the last value stays (recording stopped early)
 */
export function fromPoints(points: readonly HistoryPoint[], stepMs: number, extendMs = 0): TickSeries {
	const finite = points.filter(p => Number.isFinite(p.ts) && Number.isFinite(p.val));
	if (finite.length === 0) {
		return createSeries(0, stepMs, 0);
	}
	let first = finite[0].ts;
	let lastTs = finite[0].ts;
	for (const p of finite) {
		first = Math.min(first, p.ts);
		lastTs = Math.max(lastTs, p.ts);
	}
	const extra = Math.max(0, Math.ceil(extendMs / stepMs));
	const series = createSeries(first, stepMs, Math.floor((lastTs - first) / stepMs) + 2 + extra);
	foldPoints(series, finite);
	finalize(series);
	return series;
}
