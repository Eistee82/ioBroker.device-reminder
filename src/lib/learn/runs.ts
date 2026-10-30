import type { TickSeries } from "./ticks.js";
import { applyGapRule } from "./ticks.js";

/** A run may pause (power at idle level) for at most this long. */
export const MAX_PAUSE_MS = 30 * 60_000;
/** Minimum time above the run level for a run; shorter activity is a spike (display, pump). */
export const MIN_ACTIVE_MS = 5 * 60_000;
/** Idle time simulated before a run. */
export const PAD_BEFORE_MS = 30 * 60_000;
/** Time after a run in which the end has to be reported. */
export const PAD_AFTER_MS = 3 * 60 * 60_000;
/** Newest runs / spikes that are used. */
export const MAX_WINDOWS = 20;
/** Longest burst of an anti-crease trailer. */
export const TRAILER_BURST_MS = 2 * 60_000;
/** Distance between two bursts of an anti-crease trailer. */
export const TRAILER_GAP_MS: readonly [number, number] = [60_000, 15 * 60_000];
/** Minimum length of the block before an anti-crease trailer. */
export const SUSTAINED_MS = 2 * 60_000;
/** A slightly raised level after the run lasting at least this long belongs to the run (drying). */
export const PLATEAU_RUN_MS = 20 * 60_000;
/** The raised level ends after this long at idle level. */
export const PLATEAU_QUIET_MS = 5 * 60_000;
/** Shortest gap at which two grown-together runs are split. */
export const SPLIT_GAP_MIN_MS = 3 * 60_000;
/** Time after the end used for the level after a run. */
export const POST_END_MS = 10 * 60_000;
/** Minimum distance between two levels in W. */
export const LEVEL_SEP_W = 0.3;
/** Idle time after the end used for the idle level. */
const IDLE_SPAN_MS = 2 * 60 * 60_000;
/** Pauses inside a run shorter than this describe the level of pauses. */
const SHORT_PAUSE_MS = 10 * 60_000;

/** A stretch of ticks (indices, inclusive). */
export interface Span {
	/** First tick. */
	from: number;
	/** Last tick. */
	to: number;
}

/** One run found in the history. */
export interface RunInfo {
	/** First active tick. */
	from: number;
	/** Last active tick (including an anti-crease trailer). */
	to: number;
	/** Number of active ticks. */
	active: number;
	/** Last tick of the run without the anti-crease trailer. */
	coreEnd: number;
	/** Last tick of the run including a drying plateau. */
	runEnd: number;
	/** Bursts of the anti-crease trailer. */
	bursts: Span[];
	/** Pauses (ticks at or below the run level) between `from` and `coreEnd`. */
	gaps: Span[];
	/** Median power of the drying plateau, or null. */
	plateauLevel: number | null;
	/** Level after the end (p90 of the first 10 minutes). */
	postEnd: number;
}

/** Simulated tick range with the expected result. */
export interface Window {
	/** First simulated tick. */
	fromIdx: number;
	/** Last simulated tick. */
	toIdx: number;
	/** First active tick. */
	runStartIdx: number;
	/** Last tick of the run; null for a spike (no start expected). */
	runEndIdx: number | null;
	/** Index into `Layout.runs` for a run window. */
	run: number | null;
}

/** Runs, spikes, levels and windows of a series. */
export interface Layout {
	/** Run level in W (ticks above it are active). */
	runLimit: number;
	/** Idle level after a run in W. */
	idle: number;
	/** Highest level after the end of a run. */
	lpost: number;
	/** Runs (newest MAX_WINDOWS). */
	runs: RunInfo[];
	/** Short activity that is no run (newest MAX_WINDOWS). */
	spikes: Span[];
	/** Windows of the runs and spikes to simulate. */
	windows: Window[];
	/** Segments dropped because they touch a gap. */
	gapsDropped: number;
}

/** Options of the layout. */
export interface LayoutOptions {
	/** Recording of one run: idle from the tail, one run, the end of the series is not a gap. */
	recording?: boolean;
}

interface Segment extends Span {
	active: number;
	touched: boolean;
}

/**
 * Value at the given fraction of the sorted values (nearest rank).
 *
 * @param values - Values
 * @param q - Fraction 0..1
 */
export function quantile(values: ArrayLike<number>, q: number): number {
	const n = values.length;
	if (n === 0) {
		return 0;
	}
	const sorted = Float64Array.from(values).sort();
	const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
	return sorted[idx];
}

/**
 * Median.
 *
 * @param values - Values
 */
export function median(values: ArrayLike<number>): number {
	const n = values.length;
	if (n === 0) {
		return 0;
	}
	const sorted = Float64Array.from(values).sort();
	const mid = Math.floor(n / 2);
	return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Valid values of a tick range.
 *
 * @param s - Series
 * @param from - First tick
 * @param to - Last tick (inclusive)
 */
function valuesOf(s: TickSeries, from: number, to: number): number[] {
	const out: number[] = [];
	for (let i = Math.max(0, from); i <= Math.min(s.length - 1, to); i++) {
		if (s.valid[i] === 1) {
			out.push(s.last[i]);
		}
	}
	return out;
}

/**
 * Stretches above the run level; pauses up to `maxGap` ticks belong to the stretch, gaps break it.
 *
 * @param s - Series
 * @param limit - Run level in W
 * @param maxGap - Longest pause in ticks
 * @param endIsGap - Minimum active ticks of a stretch near the end of the series that counts as incomplete
 *   (a run that may still be going on); 0 = the end of the series is no gap
 */
function segments(s: TickSeries, limit: number, maxGap: number, endIsGap: number): Segment[] {
	const out: Segment[] = [];
	let current: Segment | null = null;
	let lastInvalid = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < s.length; i++) {
		if (s.valid[i] === 0) {
			if (current && i - current.to - 1 <= maxGap) {
				current.touched = true;
			}
			current = null;
			lastInvalid = i;
			continue;
		}
		if (s.last[i] <= limit) {
			continue;
		}
		if (current && i - current.to - 1 <= maxGap) {
			current.to = i;
			current.active++;
		} else {
			current = { from: i, to: i, active: 1, touched: i - lastInvalid - 1 <= maxGap };
			out.push(current);
		}
	}
	if (endIsGap > 0 && current && current.active >= endIsGap && s.length - 1 - current.to <= maxGap) {
		current.touched = true;
	}
	return out;
}

/**
 * Blocks of consecutive ticks above the limit inside a span.
 *
 * @param s - Series
 * @param span - Range
 * @param limit - Level in W
 */
function blocksOf(s: TickSeries, span: Span, limit: number): Span[] {
	const out: Span[] = [];
	let cur: Span | null = null;
	for (let i = span.from; i <= span.to; i++) {
		if (s.last[i] > limit) {
			if (cur && cur.to === i - 1) {
				cur.to = i;
			} else {
				cur = { from: i, to: i };
				out.push(cur);
			}
		}
	}
	return out;
}

/**
 * Gaps (stretches at or below the limit) between active blocks.
 *
 * @param blocks - Active blocks in order
 * @param upTo - Last tick to consider
 */
function gapsBetween(blocks: Span[], upTo: number): Span[] {
	const out: Span[] = [];
	for (let k = 1; k < blocks.length; k++) {
		if (blocks[k].from > upTo) {
			break;
		}
		if (blocks[k].from > blocks[k - 1].to + 1) {
			out.push({ from: blocks[k - 1].to + 1, to: blocks[k].from - 1 });
		}
	}
	return out;
}

/**
 * Anti-crease trailer: the longest suffix of at least two short bursts with regular distances after
 * a sustained block. Returns the index of the sustained block, or -1.
 *
 * @param blocks - Active blocks of the segment
 * @param stepMs - Poll interval in ms
 */
function trailerStart(blocks: Span[], stepMs: number): number {
	const dur = (b: Span): number => (b.to - b.from + 1) * stepMs;
	const gapOk = (a: Span, b: Span): boolean => {
		const gap = (b.from - a.to - 1) * stepMs;
		return gap >= TRAILER_GAP_MS[0] && gap <= TRAILER_GAP_MS[1];
	};
	let k = blocks.length - 1;
	let n = 0;
	while (k >= 0 && dur(blocks[k]) <= TRAILER_BURST_MS && (n === 0 || gapOk(blocks[k], blocks[k + 1]))) {
		k--;
		n++;
	}
	if (n >= 2 && k >= 0 && dur(blocks[k]) >= SUSTAINED_MS && gapOk(blocks[k], blocks[k + 1])) {
		return k;
	}
	return -1;
}

interface Bounds {
	/** First tick of the next segment (or series length). */
	next: number;
}

/**
 * Core end, trailer and pauses of a run.
 *
 * @param s - Series
 * @param seg - Segment of the run
 * @param runLimit - Run level
 */
function coreOf(s: TickSeries, seg: Span & { active: number }, runLimit: number): RunInfo {
	const blocks = blocksOf(s, seg, runLimit);
	const k = trailerStart(blocks, s.stepMs);
	const coreEnd = k >= 0 ? blocks[k].to : seg.to;
	return {
		from: seg.from,
		to: seg.to,
		active: seg.active,
		coreEnd,
		runEnd: coreEnd,
		bursts: k >= 0 ? blocks.slice(k + 1) : [],
		gaps: gapsBetween(blocks, coreEnd),
		plateauLevel: null,
		postEnd: 0,
	};
}

/**
 * Idle level: median over the runs of the p20 after the core end.
 *
 * @param s - Series
 * @param runs - Runs
 * @param bounds - Next segment per run
 * @param fallback - Level if there is no data after any run
 */
function idleOf(s: TickSeries, runs: RunInfo[], bounds: Bounds[], fallback: number): number {
	const span = Math.ceil(IDLE_SPAN_MS / s.stepMs);
	const levels: number[] = [];
	runs.forEach((r, i) => {
		const vals = valuesOf(s, r.coreEnd + 1, Math.min(r.coreEnd + span, bounds[i].next - 1));
		if (vals.length > 0) {
			levels.push(quantile(vals, 0.2));
		}
	});
	return levels.length > 0 ? median(levels) : fallback;
}

/**
 * Drying plateau and level after the end of a run.
 *
 * @param s - Series
 * @param r - Run (updated)
 * @param next - First tick of the next segment
 * @param idle - Idle level
 * @param runLimit - Run level
 */
function finishRun(s: TickSeries, r: RunInfo, next: number, idle: number, runLimit: number): void {
	const level = Math.max(idle + LEVEL_SEP_W, idle * 1.3);
	const quietTicks = Math.ceil(PLATEAU_QUIET_MS / s.stepMs);
	let plateauTicks = 0;
	let plateauLast = r.coreEnd;
	let quiet = 0;
	const values: number[] = [];
	for (let j = r.coreEnd + 1; j < Math.min(next, s.length) && s.valid[j] === 1; j++) {
		const v = s.last[j];
		if (v > level && v <= runLimit) {
			plateauTicks++;
			plateauLast = j;
			values.push(v);
			quiet = 0;
		} else if (++quiet >= quietTicks) {
			break;
		}
	}
	if (plateauTicks * s.stepMs >= PLATEAU_RUN_MS) {
		r.runEnd = plateauLast;
		r.plateauLevel = median(values);
	} else {
		r.runEnd = r.coreEnd;
		r.plateauLevel = null;
	}
	const post = valuesOf(s, r.runEnd + 1, Math.min(r.runEnd + Math.ceil(POST_END_MS / s.stepMs), next - 1));
	r.postEnd = post.length > 0 ? quantile(post, 0.9) : idle;
}

/**
 * Median power of a gap.
 *
 * @param s - Series
 * @param g - Gap
 */
function gapLevel(s: TickSeries, g: Span): number {
	return median(valuesOf(s, g.from, g.to));
}

/**
 * Split runs that grew together: a long gap at the level after an end, clearly different from the
 * level of the pauses inside runs.
 *
 * @param s - Series
 * @param runs - Runs
 * @param bounds - Next segment per run
 * @param runLimit - Run level
 * @returns split spans (from/to/active) or null if nothing was split
 */
function splitGrown(
	s: TickSeries,
	runs: RunInfo[],
	bounds: Bounds[],
	runLimit: number,
): (Span & { active: number })[] | null {
	const step = s.stepMs;
	const bp: number[] = [];
	const be: number[] = [];
	runs.forEach((r, i) => {
		for (const g of r.gaps) {
			if ((g.to - g.from + 1) * step < SHORT_PAUSE_MS) {
				bp.push(gapLevel(s, g));
			}
		}
		if ((bounds[i].next - r.to - 1) * step > MAX_PAUSE_MS) {
			be.push(r.postEnd);
		}
	});
	if (bp.length === 0 || be.length === 0) {
		return null;
	}
	const minBe = Math.min(...be);
	const maxBe = Math.max(...be);
	if (!(Math.max(...bp) * 1.5 + LEVEL_SEP_W < minBe * 0.8)) {
		return null;
	}
	const lo = 0.8 * minBe;
	const hi = 1.25 * maxBe + 0.1;
	const minActive = Math.ceil(MIN_ACTIVE_MS / step);
	const activeIn = (a: number, b: number): number => {
		let n = 0;
		for (let i = a; i <= b; i++) {
			if (s.last[i] > runLimit) {
				n++;
			}
		}
		return n;
	};
	let changed = false;
	const out: (Span & { active: number })[] = [];
	for (const r of runs) {
		let from = r.from;
		const allGaps = gapsBetween(blocksOf(s, r, runLimit), r.to);
		for (const g of allGaps) {
			if (g.from <= from || (g.to - g.from + 1) * step < SPLIT_GAP_MIN_MS) {
				continue;
			}
			const lv = gapLevel(s, g);
			if (lv < lo || lv > hi) {
				continue;
			}
			const before = activeIn(from, g.from - 1);
			const after = activeIn(g.to + 1, r.to);
			if (before >= minActive && after >= minActive) {
				out.push({ from, to: g.from - 1, active: before });
				from = g.to + 1;
				changed = true;
			}
		}
		out.push({ from, to: r.to, active: activeIn(from, r.to) });
	}
	return changed ? out : null;
}

/**
 * Details of all runs: core end, idle level, plateau, level after the end.
 *
 * @param s - Series
 * @param spans - Run segments
 * @param bounds - Next segment per run
 * @param runLimit - Run level
 * @param fallbackIdle - Idle level without data after the runs
 */
function detailRuns(
	s: TickSeries,
	spans: (Span & { active: number })[],
	bounds: Bounds[],
	runLimit: number,
	fallbackIdle: number,
): { runs: RunInfo[]; idle: number } {
	const runs = spans.map(seg => coreOf(s, seg, runLimit));
	const idle = idleOf(s, runs, bounds, fallbackIdle);
	runs.forEach((r, i) => finishRun(s, r, bounds[i].next, idle, runLimit));
	return { runs, idle };
}

/**
 * Next segment after each run.
 *
 * @param spans - Run spans
 * @param all - All segment starts, sorted
 * @param length - Series length
 */
function boundsOf(spans: Span[], all: Span[], length: number): Bounds[] {
	return spans.map(r => ({ next: all.find(x => x.from > r.to)?.from ?? length }));
}

/**
 * Find runs, spikes, levels and the windows to simulate.
 *
 * @param s - Series in W (finalized)
 * @param opts - Options
 */
export function buildLayout(s: TickSeries, opts: LayoutOptions = {}): Layout {
	const step = s.stepMs;
	const validValues = valuesOf(s, 0, s.length - 1);
	let tailIdle: number | null = null;
	if (opts.recording) {
		const tail = validValues.slice(-Math.max(3, Math.ceil(validValues.length * 0.1)));
		tailIdle = median(tail);
	}
	const runLimit = (tailIdle ?? median(validValues)) * 3 + 2;
	if (!opts.recording) {
		applyGapRule(s, runLimit);
	}
	const maxGap = opts.recording ? s.length : Math.floor(MAX_PAUSE_MS / step);
	const minActive = opts.recording ? 6 : Math.ceil(MIN_ACTIVE_MS / step);
	const all = segments(s, runLimit, maxGap, opts.recording ? 0 : minActive);
	const usable = all.filter(x => !x.touched);
	const gapsDropped = all.length - usable.length;
	let runSpans: (Span & { active: number })[] = usable.filter(x => x.active >= minActive);
	const spikes: Span[] = usable.filter(x => x.active < minActive).slice(-MAX_WINDOWS);

	const fallbackIdle = tailIdle ?? median(validValues);
	let bounds = boundsOf(runSpans, all, s.length);
	let { runs, idle } = detailRuns(s, runSpans, bounds, runLimit, fallbackIdle);
	if (!opts.recording) {
		const split = splitGrown(s, runs, bounds, runLimit);
		if (split) {
			runSpans = split;
			const starts = [
				...all.filter(x => !runSpans.some(r => r.from <= x.from && x.to <= r.to)),
				...runSpans,
			].sort((a, b) => a.from - b.from);
			bounds = boundsOf(runSpans, starts, s.length);
			({ runs, idle } = detailRuns(s, runSpans, bounds, runLimit, fallbackIdle));
		}
	}
	if (opts.recording && tailIdle !== null) {
		const last = runs.at(-1);
		if (!last || (s.length - 1 - last.runEnd) * step < 2 * 60_000) {
			idle = tailIdle;
			for (const r of runs) {
				r.postEnd = tailIdle;
			}
		}
	}

	// windows: neighbours are all segments (also dropped ones) and the run parts
	const neighbours: Span[] = [
		...all.filter(x => !runSpans.some(r => r.from <= x.from && x.to <= r.to)),
		...runSpans.map(r => ({ from: r.from, to: r.to })),
	].sort((a, b) => a.from - b.from);
	const windows: Window[] = [];
	const padBefore = Math.ceil(PAD_BEFORE_MS / step);
	const padAfter = Math.ceil(PAD_AFTER_MS / step);
	const make = (span: Span, end: number, run: number | null): Window | null => {
		const prev = [...neighbours].reverse().find(x => x.to < span.from);
		const next = neighbours.find(x => x.from > span.to);
		let fromIdx = Math.max(span.from - padBefore, prev ? prev.to + 1 : 0);
		let toIdx = Math.min(end + padAfter, next ? next.from - 1 : s.length - 1);
		for (let i = span.from; i >= fromIdx; i--) {
			if (s.valid[i] === 0) {
				fromIdx = i + 1;
				break;
			}
		}
		for (let i = span.from; i <= toIdx; i++) {
			if (s.valid[i] === 0) {
				toIdx = i - 1;
				break;
			}
		}
		if (toIdx < span.to) {
			return null;
		}
		return { fromIdx, toIdx, runStartIdx: span.from, runEndIdx: run === null ? null : end, run };
	};
	const kept: RunInfo[] = [];
	for (const r of runs.slice(-MAX_WINDOWS)) {
		const win = make(r, r.runEnd, kept.length);
		if (win) {
			kept.push(r);
			windows.push(win);
		}
	}
	for (const sp of spikes) {
		const win = make(sp, sp.to, null);
		if (win) {
			windows.push(win);
		}
	}
	const lpost = kept.length > 0 ? Math.max(...kept.map(r => r.postEnd)) : idle;
	return { runLimit, idle, lpost, runs: kept, spikes, windows, gapsDropped };
}
