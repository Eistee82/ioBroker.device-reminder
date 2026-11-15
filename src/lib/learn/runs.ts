import type { TickSeries } from "./ticks.js";
import { applyGapRule, GAP_MS } from "./ticks.js";

/** A run may pause (power at idle level) for at most this long. */
export const MAX_PAUSE_MS = 30 * 60_000;
/** Minimum time above the run level for a run; shorter activity is a spike (display, pump). */
export const MIN_ACTIVE_MS = 5 * 60_000;
/** Idle time simulated before a run. */
export const PAD_BEFORE_MS = 30 * 60_000;
/** Time after a run in which the end has to be reported. */
export const PAD_AFTER_MS = 3 * 60 * 60_000;
/** Newest runs / spikes that are used (default of `LayoutOptions.maxRuns`). */
export const MAX_WINDOWS = 20;
/**
 * Revision of the layout rules. A stored run with an older revision (or none) is laid out again from
 * its cells when it is loaded.
 */
export const LAYOUT_REV = 3;
/** A block of one tick counts as a single report only at polls up to this long (`peelSingles`). */
export const SINGLE_REPORT_MAX_MS = 10_000;
/** At most this many single reports are cut off at each edge of a run (`peelSingles`). */
export const SINGLE_REPORT_MAX_PEEL = 2;
/** A single report at least this far from the rest of a run does not extend it (`peelSingles`). */
export const SINGLE_REPORT_GAP_MS = 30_000;
/** Longest burst of an anti-crease trailer. */
export const TRAILER_BURST_MS = 2 * 60_000;
/** Longest distance between two bursts of an anti-crease trailer. */
export const TRAILER_GAP_MAX_MS = 15 * 60_000;
/**
 * Blocks closer than this belong together (tumbling with short stops is one block).
 *
 * @param stepMs - Poll interval in ms
 */
export function TRAILER_GAP_MIN_MS(stepMs: number): number {
	return Math.max(20_000, 2 * stepMs);
}
/** Minimum length of the block before an anti-crease trailer. */
export const SUSTAINED_MS = 2 * 60_000;
/**
 * A slightly raised level after the run lasting at least this long belongs to the run (drying), if
 * the current device type keeps running at that level (see `LayoutOptions.keepAbove`).
 */
export const PLATEAU_RUN_MS = 20 * 60_000;
/** The raised level ends after this long at idle level. */
export const PLATEAU_QUIET_MS = 5 * 60_000;
/** Shortest gap at which two grown-together runs are split. */
export const SPLIT_GAP_MIN_MS = 3 * 60_000;
/** Time after the end used for the level after a run. */
export const POST_END_MS = 10 * 60_000;
/** Minimum distance between two levels in W. */
export const LEVEL_SEP_W = 0.3;
/**
 * A flat level at the end of most runs lasting at least this long is a rest level (display or door
 * lock after the end, before the device switches itself off); it is no activity.
 */
export const REST_MIN_MS = 5 * 60_000;
/** A rest level is at most this share of the median run power. */
const REST_MAX_SHARE = 0.1;
/** Minimum number of bursts of a dense trailer. */
const DENSE_MIN_BURSTS = 6;
/**
 * Minimum length of a dense trailer. An end reported after the programme end and at most this long
 * before the end of the run is not too early (`endOk`): a shorter trailer is not found as one.
 */
export const DENSE_MIN_MS = 5 * 60_000;
/** Highest share of burst time in a dense trailer (tumbling during the programme is busier). */
const DENSE_MAX_DUTY = 0.7;
/** Highest quiet level of a dense trailer as share of the median burst maximum. */
const DENSE_MAX_QUIET_SHARE = 0.25;
/** Time at the end of a run whose low values give the quiet level of a dense trailer. */
const DENSE_PROBE_MS = 10 * 60_000;
/** The end block of a run with a separated tail lies above this multiple of the highest burst maximum. */
export const END_BLOCK_SHARE = 1.25;
/** The tail ceiling is this multiple of the highest burst maximum (separated tail only). */
const TAIL_CEIL_SHARE = 1.1;
/** Dips of the end block up to this long are bridged. */
export const END_BLOCK_BRIDGE_MS = 60_000;
/** The end block of a separated tail reaches the core end within this time. */
const END_BLOCK_REACH_MS = 60_000;
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
	/** Level after the end (p90 of the first 10 minutes without the bursts). */
	postEnd: number;
	/** First tick of the anti-crease trailer, or null. */
	trailerFrom: number | null;
	/** Last tick of the anti-crease trailer, or null. */
	trailerTo: number | null;
	/** Longest burst of the trailer in ms (0 without trailer). */
	burstMaxMs: number;
	/** p90 of the burst lengths of the trailer in ms (0 without trailer). */
	burstP90Ms: number;
	/** Shortest quiet time before a burst of the trailer in ms (0 without trailer). */
	gapMinMs: number;
	/** p10 of the highest value of each burst in W (0 without trailer). */
	burstP10W: number;
	/** Mean power of the last 2 minutes of the terminal block (the last sustained block before the core end) in W. */
	blockMean: number;
	/** Quiet level between the bursts of a dense trailer in W (0 otherwise). */
	trailerQuietW: number;
	/** Highest value of the bursts of the trailer in W (0 without trailer). */
	burstMaxW: number;
	/**
	 * Programme end: last tick in [from, runEnd] above `Layout.tailCeil` (`runEnd` without a separated
	 * tail). An end reported after it and at most DENSE_MIN_MS before `runEnd` is not too early.
	 */
	progEnd: number;
	/** First tick of the end block (the last sustained block before the core end). */
	endBlockFrom: number;
	/** Last tick of the end block. */
	endBlockTo: number;
	/** Lowest held value in the end block in W. */
	endBlockMinW: number;
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
	/** Programme end of the run (`RunInfo.progEnd`); missing = the end has to come after `runEndIdx`. */
	progEndIdx?: number;
}

/** Runs, spikes, levels and windows of a series. */
export interface Layout {
	/** Run level in W (ticks above it are active). */
	runLimit: number;
	/** Idle level after a run in W. */
	idle: number;
	/** Highest level after the end of a run. */
	lpost: number;
	/** Runs (newest `LayoutOptions.maxRuns`). */
	runs: RunInfo[];
	/** Short activity that is no run (newest `LayoutOptions.maxRuns`). */
	spikes: Span[];
	/** Windows of the runs and spikes to simulate. */
	windows: Window[];
	/** Segments dropped because they touch a gap. */
	gapsDropped: number;
	/** Rest level after the end of the runs in W (display before the device switches off), or null. */
	rest: number | null;
	/**
	 * Highest value of the trailer bursts over all runs with a trailer (W); 0 without. Both the end
	 * block (above 1.25 times) and the tail ceiling (1.1 times) are derived from it.
	 */
	burstMaxW: number;
	/**
	 * Whether the trailer is separated from the programme: at least 2 runs with a trailer, and in each of
	 * them the end block above 1.25 times the burst maximum reaches the core end.
	 */
	tailSeparated: boolean;
	/** Values above it belong to the programme (1.1 times the burst maximum if separated, else `runLimit`). */
	tailCeil: number;
	/** Run-sized segments dropped because they touch a gap or the end of the data. */
	incomplete: Span[];
}

/** Options of the layout. */
export interface LayoutOptions {
	/** Recording of one run: idle from the tail, one run, the end of the series is not a gap. */
	recording?: boolean;
	/**
	 * End threshold of the current device type in W. A raised phase of at least PLATEAU_RUN_MS after the
	 * run belongs to the run only if its level is at or above it (the current type keeps the device
	 * running there, as with the drying of a dishwasher); otherwise, and without a current type, it is
	 * the display or door lock after the end.
	 */
	keepAbove?: number;
	/**
	 * Newest runs and spikes that are kept (default MAX_WINDOWS; `Infinity` for the run check and the
	 * stored runs, so that 30 days are not cut to the newest 20).
	 */
	maxRuns?: number;
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
	// The time before the first stored value is unknown, but it cannot hide the start of a run if the
	// first value is at idle level or if it came long after the begin (a running device stores values,
	// see GAP_MS): history adapters storing changes only have no value before an idle stretch.
	const lead = s.firstIdx;
	const leadIdle = lead > 0 && lead < s.length && (lead * s.stepMs >= GAP_MS || s.last[lead] <= limit);
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
			const afterLead = leadIdle && lastInvalid === lead - 1;
			current = { from: i, to: i, active: 1, touched: !afterLead && i - lastInvalid - 1 <= maxGap };
			out.push(current);
		}
	}
	if (endIsGap > 0 && current && current.active >= endIsGap && s.length - 1 - current.to <= maxGap) {
		current.touched = true;
	}
	return s.stepMs <= SINGLE_REPORT_MAX_MS ? out.flatMap(x => peelSingles(s, x, limit)) : out;
}

/**
 * A single report at the edge of a segment does not extend it (LAYOUT_REV 3): a block of one tick before the first
 * or after the last other block, at least SINGLE_REPORT_GAP_MS away, is a segment of its own (a spike) when the block
 * next to it is longer than one tick, or when it is one tick as well and the two gaps differ by more than a factor
 * of 2 (bursts of an anti-crease phase come at regular gaps and stay). At most SINGLE_REPORT_MAX_PEEL per edge.
 *
 * @param s - Series
 * @param seg - Segment
 * @param limit - Level in W
 */
function peelSingles(s: TickSeries, seg: Segment, limit: number): Segment[] {
	if (seg.active < 2) {
		return [seg];
	}
	const b = blocksOf(s, seg, limit);
	if (b.length < 2) {
		return [seg];
	}
	const minGap = Math.ceil(SINGLE_REPORT_GAP_MS / s.stepMs);
	const gapAt = (k: number): number => b[k + 1].from - b[k].to - 1;
	const single = (k: number): boolean => b[k].from === b[k].to;
	const irregular = (g: number, h: number): boolean => Math.max(g, h) > 2 * Math.max(1, Math.min(g, h));
	// `edge` is the single block, `inner` the block next to it, `g` the gap between them, `h` the gap behind `inner`
	const lone = (inner: number, g: number, h: number | null): boolean =>
		g >= minGap && (!single(inner) || (h !== null && irregular(g, h)));
	let lo = 0;
	let hi = b.length - 1;
	while (
		lo < SINGLE_REPORT_MAX_PEEL &&
		hi - lo >= 1 &&
		single(lo) &&
		lone(lo + 1, gapAt(lo), lo + 1 < hi ? gapAt(lo + 1) : null)
	) {
		lo++;
	}
	while (
		b.length - 1 - hi < SINGLE_REPORT_MAX_PEEL &&
		hi - lo >= 1 &&
		single(hi) &&
		lone(hi - 1, gapAt(hi - 1), hi - 1 > lo ? gapAt(hi - 2) : null)
	) {
		hi--;
	}
	if (lo === 0 && hi === b.length - 1) {
		return [seg];
	}
	const piece = (k: number): Segment => ({ from: b[k].from, to: b[k].to, active: 1, touched: seg.touched });
	const rest: Segment = {
		from: b[lo].from,
		to: b[hi].to,
		active: seg.active - lo - (b.length - 1 - hi),
		touched: seg.touched,
	};
	return [...b.slice(0, lo).map((_, k) => piece(k)), rest, ...b.slice(hi + 1).map((_, k) => piece(hi + 1 + k))];
}

/**
 * Blocks of consecutive ticks above the limit inside a span.
 *
 * @param s - Series
 * @param span - Range
 * @param limit - Level in W
 */
export function blocksOf(s: TickSeries, span: Span, limit: number): Span[] {
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
export function gapsBetween(blocks: Span[], upTo: number): Span[] {
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
 * Merge blocks whose distance is shorter than `minGapTicks`.
 *
 * @param blocks - Active blocks in order
 * @param minGapTicks - Shortest distance that separates two blocks
 */
export function mergeBlocks(blocks: Span[], minGapTicks: number): Span[] {
	const out: Span[] = [];
	for (const b of blocks) {
		const last = out.at(-1);
		if (last && b.from - last.to - 1 < minGapTicks) {
			last.to = b.to;
		} else {
			out.push({ from: b.from, to: b.to });
		}
	}
	return out;
}

/**
 * Anti-crease trailer: the longest suffix of at least two short bursts (gaps up to 15 min, one longer
 * gap up to MAX_PAUSE_MS for a door opened in between) after a sustained block. Blocks closer than
 * TRAILER_GAP_MIN_MS are merged first.
 *
 * @param blocks - Active blocks of the segment
 * @param stepMs - Poll interval in ms
 * @returns the sustained block and the bursts, or null
 */
function trailerOf(blocks: Span[], stepMs: number): { block: Span; bursts: Span[] } | null {
	const merged = mergeBlocks(blocks, Math.ceil(TRAILER_GAP_MIN_MS(stepMs) / stepMs));
	const dur = (b: Span): number => (b.to - b.from + 1) * stepMs;
	const gap = (a: Span, b: Span): number => (b.from - a.to - 1) * stepMs;
	let door = false;
	const gapOk = (a: Span, b: Span): boolean => {
		const g = gap(a, b);
		if (g <= TRAILER_GAP_MAX_MS) {
			return true;
		}
		if (!door && g <= MAX_PAUSE_MS) {
			door = true;
			return true;
		}
		return false;
	};
	let k = merged.length - 1;
	let n = 0;
	while (k >= 0 && dur(merged[k]) <= TRAILER_BURST_MS && (n === 0 || gapOk(merged[k], merged[k + 1]))) {
		k--;
		n++;
	}
	if (n >= 2 && k >= 0 && dur(merged[k]) >= SUSTAINED_MS && gapOk(merged[k], merged[k + 1])) {
		return { block: merged[k], bursts: merged.slice(k + 1) };
	}
	return null;
}

/**
 * Dense anti-crease trailer: after the last sustained block (final spin) the drum moves for a few
 * seconds and rests for a few seconds, alternating with every report, for at least DENSE_MIN_MS.
 * The bursts are measured against the quiet level of the end of the run (the electronics between the
 * drum moves), not against the run level.
 *
 * @param s - Series
 * @param seg - Segment of the run
 * @param runLimit - Run level
 * @returns the sustained block, the bursts and the quiet level, or null
 */
function denseTrailerOf(
	s: TickSeries,
	seg: Span,
	runLimit: number,
): { block: Span; bursts: Span[]; quiet: number; limit: number } | null {
	const step = s.stepMs;
	const tail = valuesOf(s, seg.to - Math.ceil(DENSE_PROBE_MS / step) + 1, seg.to);
	if (tail.length === 0) {
		return null;
	}
	const quiet = quantile(tail, 0.25);
	const limit = Math.max(runLimit, quiet * 1.5 + LEVEL_SEP_W);
	const blocks = blocksOf(s, seg, limit);
	const dur = (b: Span): number => (b.to - b.from + 1) * step;
	let k = blocks.length - 1;
	while (
		k >= 0 &&
		dur(blocks[k]) < SUSTAINED_MS &&
		(k === blocks.length - 1 || (blocks[k + 1].from - blocks[k].to - 1) * step <= TRAILER_GAP_MAX_MS)
	) {
		k--;
	}
	if (k < 0 || dur(blocks[k]) < SUSTAINED_MS) {
		return null;
	}
	const bursts = blocks.slice(k + 1);
	const spanMs = (seg.to - blocks[k].to) * step;
	if (bursts.length < DENSE_MIN_BURSTS || spanMs < DENSE_MIN_MS) {
		return null;
	}
	const busy = bursts.reduce((a, b) => a + dur(b), 0);
	if (busy > DENSE_MAX_DUTY * spanMs) {
		return null;
	}
	// between the drum moves only the electronics runs: far below the drum moves themselves
	const maxima = bursts.map(b => Math.max(...valuesOf(s, b.from, b.to)));
	if (quiet > DENSE_MAX_QUIET_SHARE * median(maxima)) {
		return null;
	}
	return { block: blocks[k], bursts, quiet, limit };
}

/**
 * Anti-crease trailer above a raised level: between the drum moves the electronics (fan, display) may
 * stay above the run level for a while, which joins the bursts into blocks longer than a burst (dryer:
 * drum moves of about 100 W, between them 4 W or 8–13 W). The bursts are measured above a quarter of
 * the high values at the end of the run instead (DENSE_MAX_QUIET_SHARE, as for a dense trailer).
 *
 * @param s - Series
 * @param seg - Segment of the run
 * @param runLimit - Run level
 * @returns the sustained block, the bursts, the highest quiet level between them and the level, or null
 */
function raisedTrailerOf(
	s: TickSeries,
	seg: Span,
	runLimit: number,
): { block: Span; bursts: Span[]; quiet: number; limit: number } | null {
	const tail = valuesOf(s, seg.to - Math.ceil(DENSE_PROBE_MS / s.stepMs) + 1, seg.to);
	if (tail.length === 0) {
		return null;
	}
	const limit = DENSE_MAX_QUIET_SHARE * quantile(tail, 0.9);
	if (limit <= runLimit) {
		return null;
	}
	const found = trailerOf(blocksOf(s, seg, limit), s.stepMs);
	if (!found) {
		return null;
	}
	// highest level between the bursts: the end threshold has to lie above it
	let quiet = 0;
	let prev = found.block.to;
	const maxima: number[] = [];
	for (const b of found.bursts) {
		const vals = valuesOf(s, prev + 1, b.from - 1);
		if (vals.length > 0) {
			quiet = Math.max(quiet, median(vals));
		}
		maxima.push(Math.max(...valuesOf(s, b.from, b.to)));
		prev = b.to;
	}
	// between the drum moves only the electronics runs (a heater switching between two high levels is
	// no trailer)
	if (quiet > DENSE_MAX_QUIET_SHARE * median(maxima)) {
		return null;
	}
	return { ...found, quiet, limit };
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
	const plain = trailerOf(blocks, s.stepMs);
	const dense = plain === null ? denseTrailerOf(s, seg, runLimit) : null;
	const raisedFound = dense === null ? raisedTrailerOf(s, seg, runLimit) : null;
	// a trailer at the run level whose sustained block ends later than the one above the raised level
	// took bursts joined by the electronics for the block
	const raised = raisedFound && (plain === null || raisedFound.block.to < plain.block.to) ? raisedFound : null;
	const trailer = raised ?? dense ?? plain;
	const coreEnd = trailer ? trailer.block.to : seg.to;
	const bursts = trailer ? trailer.bursts : [];
	let burstMaxMs = 0;
	let gapMinMs = 0;
	const maxima: number[] = [];
	bursts.forEach((b, i) => {
		burstMaxMs = Math.max(burstMaxMs, (b.to - b.from + 1) * s.stepMs);
		const prevEnd = i === 0 ? coreEnd : bursts[i - 1].to;
		const g = (b.from - prevEnd - 1) * s.stepMs;
		gapMinMs = i === 0 ? g : Math.min(gapMinMs, g);
		let m = Number.NEGATIVE_INFINITY;
		for (let j = b.from; j <= b.to; j++) {
			m = Math.max(m, s.max[j]);
		}
		maxima.push(m);
	});
	// a dense trailer is measured above its quiet level: the electronics between the drum moves is
	// above the run level and would join the whole run into one block; a raised trailer likewise for
	// the terminal block, the pauses of the run stay those at the run level
	const level = dense ? dense.limit : raised ? raised.limit : runLimit;
	const coreBlocks = dense ? blocksOf(s, seg, level) : blocks;
	const terminalBlocks = raised ? blocksOf(s, seg, level) : coreBlocks;
	// terminal block: the last block of at least SUSTAINED_MS before the core end (short dips bridged)
	const merged = mergeBlocks(
		terminalBlocks.filter(b => b.to <= coreEnd),
		Math.ceil(TRAILER_GAP_MIN_MS(s.stepMs) / s.stepMs),
	);
	const terminal =
		[...merged].reverse().find(b => (b.to - b.from + 1) * s.stepMs >= SUSTAINED_MS) ?? merged.at(-1) ?? null;
	// mean of the last SUSTAINED_MS of the terminal block (as the anti-crease filter sees it)
	let blockMean = 0;
	if (terminal) {
		const from = Math.max(terminal.from, terminal.to - Math.ceil(SUSTAINED_MS / s.stepMs) + 1);
		const vals: number[] = [];
		for (let j = from; j <= terminal.to; j++) {
			if (s.last[j] > level) {
				vals.push(s.last[j]);
			}
		}
		blockMean = vals.length > 0 ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
	}
	return {
		from: seg.from,
		to: seg.to,
		active: seg.active,
		coreEnd,
		runEnd: coreEnd,
		bursts,
		gaps: gapsBetween(coreBlocks, coreEnd),
		plateauLevel: null,
		postEnd: 0,
		trailerFrom: bursts.length > 0 ? bursts[0].from : null,
		trailerTo: bursts.length > 0 ? (bursts.at(-1) as Span).to : null,
		burstMaxMs,
		burstP90Ms:
			bursts.length > 0
				? quantile(
						bursts.map(b => (b.to - b.from + 1) * s.stepMs),
						0.9,
					)
				: 0,
		gapMinMs,
		burstP10W: maxima.length > 0 ? quantile(maxima, 0.1) : 0,
		blockMean,
		trailerQuietW: dense ? dense.quiet : raised ? raised.quiet : 0,
		burstMaxW: maxima.length > 0 ? Math.max(...maxima) : 0,
		progEnd: coreEnd,
		endBlockFrom: terminal ? terminal.from : seg.from,
		endBlockTo: terminal ? terminal.to : coreEnd,
		endBlockMinW: 0,
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
	return Math.max(0, levels.length > 0 ? median(levels) : fallback);
}

/**
 * Drying plateau and level after the end of a run.
 *
 * @param s - Series
 * @param r - Run (updated)
 * @param next - First tick of the next segment
 * @param idle - Idle level
 * @param runLimit - Run level
 * @param keepAbove - End threshold of the current type in W (see `LayoutOptions.keepAbove`)
 */
function finishRun(
	s: TickSeries,
	r: RunInfo,
	next: number,
	idle: number,
	runLimit: number,
	keepAbove: number | undefined,
): void {
	const level = Math.max(idle + LEVEL_SEP_W, idle * 1.3);
	const quietTicks = Math.ceil(PLATEAU_QUIET_MS / s.stepMs);
	let plateauTicks = 0;
	let plateauLast = r.coreEnd;
	let quiet = 0;
	// anti-crease bursts or other activity after the core end: the raised level in between is the
	// electronics of the trailer, no drying
	let interrupted = r.bursts.length > 0;
	const values: number[] = [];
	for (let j = r.coreEnd + 1; !interrupted && j < Math.min(next, s.length) && s.valid[j] === 1; j++) {
		const v = s.last[j];
		if (v > runLimit) {
			interrupted = true;
		} else if (v > level) {
			plateauTicks++;
			plateauLast = j;
			values.push(v);
			quiet = 0;
		} else if (++quiet >= quietTicks) {
			break;
		}
	}
	const plateau = values.length > 0 ? median(values) : 0;
	if (!interrupted && keepAbove !== undefined && plateau >= keepAbove && plateauTicks * s.stepMs >= PLATEAU_RUN_MS) {
		r.runEnd = plateauLast;
		r.plateauLevel = plateau;
	} else {
		r.runEnd = r.coreEnd;
		r.plateauLevel = null;
	}
	// the bursts of an anti-crease trailer are no level after the end
	const inBurst = (i: number): boolean => r.bursts.some(b => i >= b.from && i <= b.to);
	const quietOf = (from: number, to: number): number[] => {
		const out: number[] = [];
		for (let i = Math.max(0, from); i <= Math.min(s.length - 1, to); i++) {
			if (s.valid[i] === 1 && !inBurst(i)) {
				out.push(s.last[i]);
			}
		}
		return out;
	};
	const post = quietOf(r.runEnd + 1, Math.min(r.runEnd + Math.ceil(POST_END_MS / s.stepMs), next - 1));
	let level0 = post.length > 0 ? quantile(post, 0.9) : null;
	if (level0 === null && r.trailerFrom !== null && r.trailerTo !== null) {
		const quiet = quietOf(r.trailerFrom, r.trailerTo);
		level0 = quiet.length > 0 ? median(quiet) : null;
	}
	r.postEnd = Math.max(0, level0 ?? idle);
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
	// pauses inside runs clearly below the level after an end (pump off at 0 W, display after the end)
	// or clearly above it (electronics during drum pauses, plug at 0.3 W after the end); a single
	// outlier (for example the gap between two grown-together runs) does not decide
	const pausesBelow = quantile(bp, 0.9) * 1.5 + LEVEL_SEP_W < minBe * 0.8;
	const pausesAbove = quantile(bp, 0.1) > maxBe * 1.5 + LEVEL_SEP_W;
	if (!pausesBelow && !pausesAbove) {
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
			// pauses below: the gap is at the level after an end; pauses above: the gap stays at or
			// below the level after an end (display, then idle) and therefore below every pause
			const inBand = pausesBelow
				? gapLevel(s, g) >= lo && gapLevel(s, g) <= hi
				: quantile(valuesOf(s, g.from, g.to), 0.9) <= hi;
			if (!inBand) {
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
 * @param keepAbove - End threshold of the current type in W (see `LayoutOptions.keepAbove`)
 */
function detailRuns(
	s: TickSeries,
	spans: (Span & { active: number })[],
	bounds: Bounds[],
	runLimit: number,
	fallbackIdle: number,
	keepAbove: number | undefined,
): { runs: RunInfo[]; idle: number } {
	const runs = spans.map(seg => coreOf(s, seg, runLimit));
	const idle = idleOf(s, runs, bounds, fallbackIdle);
	runs.forEach((r, i) => finishRun(s, r, bounds[i].next, idle, runLimit, keepAbove));
	return { runs, idle };
}

/**
 * Width of the band around a flat level.
 *
 * @param level - Level in W
 */
function restBand(level: number): number {
	return Math.max(LEVEL_SEP_W, 0.1 * level);
}

/**
 * Rest level: most runs end with a flat level above the run level for at least REST_MIN_MS (display
 * or door lock after the end) before the device switches itself off. Without it that level counts as
 * activity and the end of a run is the moment the device switches off.
 *
 * @param s - Series
 * @param runs - Runs
 * @param runLimit - Run level
 * @returns the highest rest level and the shortest rest phase, or null
 */
function restLevelOf(
	s: TickSeries,
	runs: readonly RunInfo[],
	runLimit: number,
): { level: number; minMs: number } | null {
	const levels: number[] = [];
	const lengths: number[] = [];
	for (const r of runs) {
		const v = s.last[r.to];
		let i = r.to;
		while (i - 1 >= r.from && s.valid[i - 1] === 1 && Math.abs(s.last[i - 1] - v) <= restBand(v)) {
			i--;
		}
		const ms = (r.to - i + 1) * s.stepMs;
		const active = valuesOf(s, r.from, i - 1).filter(x => x > runLimit);
		if (ms >= REST_MIN_MS && active.length > 0 && v <= REST_MAX_SHARE * median(active)) {
			levels.push(v);
			lengths.push(ms);
		}
	}
	if (levels.length < Math.max(2, Math.ceil(runs.length / 2))) {
		return null;
	}
	const lo = Math.min(...levels);
	const hi = Math.max(...levels);
	return hi <= lo * 1.5 + LEVEL_SEP_W ? { level: hi, minMs: Math.min(...lengths) } : null;
}

/**
 * Split runs at a pause that starts with the rest level for at least half the shortest rest phase
 * (two runs started one after the other without switching the device off in between).
 *
 * @param s - Series
 * @param spans - Run spans
 * @param runLimit - Run level (just above the rest level)
 * @param rest - Rest level and shortest rest phase
 * @param rest.level - Rest level in W
 * @param rest.minMs - Shortest rest phase in ms
 * @param minActive - Minimum active ticks of a run
 */
function splitAtRest(
	s: TickSeries,
	spans: (Span & { active: number })[],
	runLimit: number,
	rest: { level: number; minMs: number },
	minActive: number,
): (Span & { active: number })[] {
	const need = Math.ceil(Math.max(SPLIT_GAP_MIN_MS, rest.minMs / 2) / s.stepMs);
	const band = restBand(rest.level);
	const activeIn = (a: number, b: number): number => {
		let n = 0;
		for (let i = a; i <= b; i++) {
			if (s.last[i] > runLimit) {
				n++;
			}
		}
		return n;
	};
	const out: (Span & { active: number })[] = [];
	for (const r of spans) {
		let from = r.from;
		for (const g of gapsBetween(blocksOf(s, r, runLimit), r.to)) {
			let flat = 0;
			while (g.from + flat <= g.to && Math.abs(s.last[g.from + flat] - rest.level) <= band) {
				flat++;
			}
			if (flat < need || g.from <= from) {
				continue;
			}
			const before = activeIn(from, g.from - 1);
			const after = activeIn(g.to + 1, r.to);
			if (before >= minActive && after >= minActive) {
				out.push({ from, to: g.from - 1, active: before });
				from = g.to + 1;
			}
		}
		out.push({ from, to: r.to, active: activeIn(from, r.to) });
	}
	return out;
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
 * Last block of at least SUSTAINED_MS above a level up to the core end; dips up to
 * END_BLOCK_BRIDGE_MS are bridged.
 *
 * @param s - Series
 * @param r - Run
 * @param level - Level in W
 */
function endBlockOf(s: TickSeries, r: Pick<RunInfo, "from" | "coreEnd">, level: number): Span | null {
	const merged = mergeBlocks(
		blocksOf(s, { from: r.from, to: r.coreEnd }, level),
		Math.floor(END_BLOCK_BRIDGE_MS / s.stepMs) + 1,
	);
	return [...merged].reverse().find(b => (b.to - b.from + 1) * s.stepMs >= SUSTAINED_MS) ?? null;
}

/** Fields of a run that the tail rule reads and sets. */
export type TailRun = Pick<
	RunInfo,
	| "from"
	| "coreEnd"
	| "runEnd"
	| "trailerFrom"
	| "burstMaxW"
	| "progEnd"
	| "endBlockFrom"
	| "endBlockTo"
	| "endBlockMinW"
>;

/** One run of the tail rule with its series and run level (the runs may come from different series). */
export interface TailPart {
	/** Series in W. */
	s: TickSeries;
	/** Run (`progEnd`, `endBlockFrom`, `endBlockTo` and `endBlockMinW` are set by `applyTail`). */
	r: TailRun;
	/** Run level of its series in W. */
	runLimit: number;
}

/** Result of the tail rule. */
export interface Tail {
	/** Highest burst maximum of the runs with a trailer in W (0 without). */
	burstMaxW: number;
	/** Whether the trailer is separated from the programme. */
	tailSeparated: boolean;
	/** Values above it belong to the programme in W. */
	tailCeil: number;
}

/**
 * Tail rule of Spec B.4 over runs that may come from different series (the runs of one layout, or the
 * stored runs of a device): the tail is separated from the programme if at least 2 runs have a trailer
 * and in each of them the last block above 1.25 times the highest burst maximum reaches the core end.
 * Then values above 1.1 times the burst maximum belong to the programme; otherwise the tail ceiling is
 * the run level (the median over the runs).
 *
 * @param parts - Runs with their series
 */
export function tailRule(parts: readonly TailPart[]): Tail {
	const withTrailer = parts.filter(p => p.r.trailerFrom !== null);
	const burstMaxW = withTrailer.length > 0 ? Math.max(...withTrailer.map(p => p.r.burstMaxW)) : 0;
	const hi = END_BLOCK_SHARE * burstMaxW;
	const limit = withTrailer.length > 0 ? Math.max(...withTrailer.map(p => p.runLimit)) : 0;
	const tailSeparated =
		withTrailer.length >= 2 &&
		burstMaxW > limit &&
		withTrailer.every(p => {
			const b = endBlockOf(p.s, p.r, hi);
			return b !== null && p.r.coreEnd - b.to <= Math.ceil(END_BLOCK_REACH_MS / p.s.stepMs);
		});
	const tailCeil = tailSeparated ? TAIL_CEIL_SHARE * burstMaxW : median(parts.map(p => p.runLimit));
	return { burstMaxW, tailSeparated, tailCeil };
}

/**
 * Programme end and end block of one run under a tail (sets `progEnd`, `endBlockFrom`, `endBlockTo`
 * and `endBlockMinW`).
 *
 * @param p - Run with its series
 * @param tail - Result of `tailRule`
 */
export function applyTail(p: TailPart, tail: Tail): void {
	const { s, r, runLimit } = p;
	// without a block above the end block level (a short final spin) the last block above the run level
	const above = tail.tailSeparated ? endBlockOf(s, r, END_BLOCK_SHARE * tail.burstMaxW) : null;
	const b = above ?? endBlockOf(s, r, runLimit) ?? { from: r.endBlockFrom, to: r.endBlockTo };
	r.endBlockFrom = b.from;
	r.endBlockTo = b.to;
	let min = Number.POSITIVE_INFINITY;
	for (let i = b.from; i <= b.to; i++) {
		if (s.valid[i] === 1) {
			min = Math.min(min, s.last[i]);
		}
	}
	r.endBlockMinW = Number.isFinite(min) ? min : 0;
	r.progEnd = r.runEnd;
	if (tail.tailSeparated) {
		// a run that never exceeds the ceiling keeps the criterion of today
		for (let i = r.runEnd; i >= r.from; i--) {
			if (s.valid[i] === 1 && s.last[i] > tail.tailCeil) {
				r.progEnd = i;
				break;
			}
		}
	}
}

/**
 * Programme end and tail of the runs of one series (Spec B.4, `tailRule`). Sets `progEnd`,
 * `endBlockFrom`, `endBlockTo` and `endBlockMinW` of every run.
 *
 * @param s - Series
 * @param runs - Runs (updated)
 * @param runLimit - Run level
 */
function tailOf(s: TickSeries, runs: RunInfo[], runLimit: number): Tail {
	const parts = runs.map(r => ({ s, r, runLimit }));
	const tail = parts.length > 0 ? tailRule(parts) : { burstMaxW: 0, tailSeparated: false, tailCeil: runLimit };
	for (const p of parts) {
		applyTail(p, tail);
	}
	return tail;
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
		// the last value as well: a recording stopped shortly after the end has the run in its tail
		tailIdle = Math.max(0, Math.min(median(tail), tail.at(-1) ?? 0));
	}
	let runLimit = Math.max(0, tailIdle ?? median(validValues)) * 3 + 2;
	if (!opts.recording) {
		applyGapRule(s, runLimit);
	}
	const maxGap = opts.recording ? s.length : Math.floor(MAX_PAUSE_MS / step);
	const minActive = opts.recording ? 6 : Math.ceil(MIN_ACTIVE_MS / step);
	const maxRuns = Math.max(1, opts.maxRuns ?? MAX_WINDOWS);
	const scan = (): {
		all: Segment[];
		runSpans: (Span & { active: number })[];
		spikes: Span[];
		dropped: number;
		incomplete: Span[];
	} => {
		const found = segments(s, runLimit, maxGap, opts.recording ? 0 : minActive);
		const usable = found.filter(x => !x.touched);
		return {
			all: found,
			runSpans: usable.filter(x => x.active >= minActive),
			spikes: usable.filter(x => x.active < minActive).slice(-maxRuns),
			dropped: found.length - usable.length,
			incomplete: found.filter(x => x.touched && x.active >= minActive).map(x => ({ from: x.from, to: x.to })),
		};
	};
	let { all, runSpans, spikes, dropped: gapsDropped, incomplete } = scan();

	const fallbackIdle = Math.max(0, tailIdle ?? median(validValues));
	let bounds = boundsOf(runSpans, all, s.length);
	let { runs, idle } = detailRuns(s, runSpans, bounds, runLimit, fallbackIdle, opts.keepAbove);
	let rest: number | null = null;
	const restCandidate = opts.recording ? null : restLevelOf(s, runs, runLimit);
	// the current type keeps running at that level: it is the drying of the run, no rest
	const restFound =
		restCandidate && !(opts.keepAbove !== undefined && restCandidate.level >= opts.keepAbove)
			? restCandidate
			: null;
	if (restFound) {
		// the rest level is no activity, and a run is over once the device rests there for half the
		// shortest rest phase (two runs started one after the other without switching off)
		rest = restFound.level;
		runLimit = restFound.level + restBand(restFound.level);
		({ all, runSpans, spikes, dropped: gapsDropped, incomplete } = scan());
		runSpans = splitAtRest(s, runSpans, runLimit, restFound, minActive);
		bounds = boundsOf(runSpans, all, s.length);
		({ runs, idle } = detailRuns(s, runSpans, bounds, runLimit, fallbackIdle, opts.keepAbove));
	}
	if (!opts.recording) {
		const split = splitGrown(s, runs, bounds, runLimit);
		if (split) {
			runSpans = split;
			const starts = [
				...all.filter(x => !runSpans.some(r => r.from <= x.from && x.to <= r.to)),
				...runSpans,
			].sort((a, b) => a.from - b.from);
			bounds = boundsOf(runSpans, starts, s.length);
			({ runs, idle } = detailRuns(s, runSpans, bounds, runLimit, fallbackIdle, opts.keepAbove));
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
	const runWindows: Window[] = [];
	for (const r of runs.slice(-maxRuns)) {
		const win = make(r, r.runEnd, kept.length);
		if (win) {
			kept.push(r);
			runWindows.push(win);
		} else {
			// invalid ticks inside the run: it cannot be replayed
			incomplete.push({ from: r.from, to: r.to });
		}
	}
	const tail = tailOf(s, kept, runLimit);
	runWindows.forEach((w, k) => {
		w.progEndIdx = kept[k].progEnd;
		windows.push(w);
	});
	for (const sp of spikes) {
		const win = make(sp, sp.to, null);
		if (win) {
			windows.push(win);
		}
	}
	const lpost = kept.length > 0 ? Math.max(...kept.map(r => r.postEnd)) : idle;
	incomplete.sort((a, b) => a.from - b.from);
	return { runLimit, idle, lpost, runs: kept, spikes, windows, gapsDropped, rest, ...tail, incomplete };
}
