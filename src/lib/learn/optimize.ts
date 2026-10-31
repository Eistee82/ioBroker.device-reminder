import { TrailerFilter } from "../detector/trailer.js";
import type { Detector, TickResult } from "../detector/types.js";
import type { Layout, RunInfo } from "./runs.js";
import { LEVEL_SEP_W, median, quantile } from "./runs.js";
import type { TickSeries } from "./ticks.js";

/** Settings of the anti-crease filter (s, W; 0 = unused). */
export interface TrailerParams {
	/** Longest drum burst in s. */
	trailerBurstSec: number;
	/** Minimum quiet time before a burst in s. */
	trailerGapSec: number;
	/** Bursts are held only this many seconds after the start. */
	trailerAfterSec: number;
	/** Bursts are held only after a block of at least this mean power (W). */
	trailerBlockVal: number;
	/** Length of the anti-crease phase after the end in s. */
	trailerMaxSec: number;
}

/** Minimum mean gain per run (s) for the pause protection to be suggested. */
export const GUARD_MIN_GAIN_SEC = 180;

/** Pause protection settings (0 = unused). */
export interface GuardSettings {
	/** Hold time in s. */
	pauseHoldSec: number;
	/** A phase beginning within this many seconds of the start is a pause. */
	pauseUntilSec: number;
	/** A phase staying below this power (W) is a pause. */
	pauseBelowVal: number;
}

/** One pause inside a run below the end threshold. */
export interface Pause {
	/** Length in s. */
	d: number;
	/** Begin, seconds after the start of the run. */
	o: number;
	/** Highest value of the pause (W). */
	lv: number;
}

/** Pauses and end of one run for one end threshold. */
export interface RunTable {
	/** Pauses inside the run (not containing the end). */
	pauses: Pause[];
	/** Begin of the phase below endVal that contains the end, seconds after the start. */
	oEnd: number;
	/** Part of that phase before the end of the run (s); 0 if the run ends above endVal. */
	trail: number;
	/** First tick of the phase below endVal that contains the end. */
	endStretch: number;
	/** Index of the run. */
	run: number;
}

/** Shortest safe end waiting time and pause protection for one end threshold. */
export interface Plan {
	/** End threshold in W. */
	e: number;
	/** End waiting time in s. */
	Ds: number;
	/** Pause protection or null. */
	guard: GuardSettings | null;
	/** Estimated total end delay in s. */
	estCost: number;
	/** Longest pause in a run (s). */
	dmax: number;
	/** End waiting time without pause protection. */
	noGuardDs: number;
}

/** Context for the closed-form planning. */
export interface PlanContext {
	/** Series in W. */
	series: TickSeries;
	/** Runs of the series. */
	runs: RunInfo[];
	/** Poll interval in s. */
	pollSec: number;
	/** Deadband of the history adapter in W. */
	minDeltaW: number;
}

/**
 * Safety margin for a duration.
 *
 * @param d - Duration in s
 * @param pollSec - Poll interval in s
 */
export function margin(d: number, pollSec: number): number {
	return Math.max(2 * pollSec, 60, 0.25 * d);
}

/**
 * Shortest end waiting time.
 *
 * @param pollSec - Poll interval in s
 */
export function minEndSec(pollSec: number): number {
	return Math.max(3 * pollSec, 120);
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

/**
 * Candidates for the end threshold.
 *
 * @param s - Series
 * @param layout - Runs and levels
 * @param minDeltaW - Deadband of the history adapter in W
 */
export function endCandidates(s: TickSeries, layout: Layout, minDeltaW: number): number[] {
	const { idle, lpost, runs, runLimit } = layout;
	const lmin = Math.max(idle * 1.15 + 0.2, lpost * 1.15 + 0.2, lpost + minDeltaW);
	const active: number[] = [];
	const levels: number[] = [];
	for (const r of runs) {
		for (let i = r.from; i <= r.coreEnd; i++) {
			if (s.last[i] > runLimit) {
				active.push(s.last[i]);
			}
		}
		for (const g of r.gaps) {
			const vals: number[] = [];
			for (let i = g.from; i <= g.to; i++) {
				vals.push(s.last[i]);
			}
			levels.push(median(vals));
		}
		if (r.plateauLevel !== null) {
			levels.push(r.plateauLevel);
		}
	}
	const lmax = Math.max(lmin, 0.5 * quantile(active, 0.1));
	const clamp = (v: number): number => round2(Math.min(lmax, Math.max(lmin, v)));
	const out = [clamp(Math.max(idle * 1.5, idle + 1, lmin))];
	const extra = [...new Set(levels.map(round2))].filter(b => b / lmin >= 1.3).sort((a, b) => a - b);
	for (const b of extra) {
		const c = clamp(Math.sqrt(lmin * b));
		if (!out.includes(c) && out.length < 6) {
			out.push(c);
		}
	}
	// an end threshold near the drum bursts or the run power would let the bursts keep the run going
	const bound = endBound(s, layout);
	const kept = out.filter(e => e < bound);
	return kept.length > 0 ? kept : out.slice(0, 1);
}

/**
 * Upper bound of the end threshold: half the p10 of the burst maxima and half the median run power.
 *
 * @param s - Series
 * @param layout - Runs and levels
 */
export function endBound(s: TickSeries, layout: Layout): number {
	let bound = Number.POSITIVE_INFINITY;
	for (const r of layout.runs) {
		if (r.bursts.length > 0) {
			bound = Math.min(bound, 0.5 * r.burstP10W);
		}
		const vals: number[] = [];
		for (let i = r.from; i <= r.coreEnd; i++) {
			if (s.last[i] > layout.runLimit) {
				vals.push(s.last[i]);
			}
		}
		if (vals.length > 0) {
			bound = Math.min(bound, 0.5 * median(vals));
		}
	}
	return bound;
}

/**
 * Copy of a series as the inner detector would see it behind the anti-crease filter, assuming a run
 * in progress from the start of each run window (planning only; the real filter decides at replay).
 *
 * @param s - Series in W
 * @param layout - Runs and windows
 * @param p - Filter settings
 * @param endVal - End threshold in W
 * @param pollSec - Poll interval in s
 */
export function suppressBursts(
	s: TickSeries,
	layout: Layout,
	p: TrailerParams,
	endVal: number,
	pollSec: number,
): TickSeries {
	const last = Float64Array.from(s.last);
	const min = Float64Array.from(s.min);
	const max = Float64Array.from(s.max);
	for (const w of layout.windows) {
		if (w.run === null) {
			continue;
		}
		const r = layout.runs[w.run];
		let started = false;
		const probe: Detector = {
			get started(): boolean {
				return started;
			},
			tick(power: number, now: number): TickResult {
				const i = Math.round((now - s.t0) / s.stepMs);
				const events: TickResult["events"] = [];
				if (!started && i >= r.from) {
					started = true;
					events.push("started");
				}
				if (power !== s.last[i]) {
					last[i] = power;
					min[i] = power;
					max[i] = power;
				}
				return { events, status: null, average: null, started };
			},
			reset(): void {
				started = false;
			},
		};
		const filter = new TrailerFilter(probe, { ...p, endVal, standby: 0, pollSec });
		for (let i = w.fromIdx; i <= w.toIdx; i++) {
			filter.tick(s.last[i], s.t0 + i * s.stepMs);
		}
	}
	return { ...s, last, min, max };
}

/**
 * Pauses below `e` inside a run and the begin of the phase that contains the end.
 *
 * @param s - Series
 * @param r - Run
 * @param e - End threshold in W
 * @param run - Index of the run
 */
export function runTable(s: TickSeries, r: RunInfo, e: number, run: number): RunTable {
	const stepSec = s.stepMs / 1000;
	const pauses: Pause[] = [];
	let start = -1;
	let lv = Number.NEGATIVE_INFINITY;
	for (let i = r.from; i <= r.runEnd; i++) {
		if (s.last[i] < e) {
			if (start < 0) {
				start = i;
				lv = s.max[i];
			} else {
				lv = Math.max(lv, s.max[i]);
			}
		} else if (start >= 0) {
			pauses.push({ d: (i - start) * stepSec, o: (start - r.from) * stepSec, lv });
			start = -1;
		}
	}
	const endStretch = start >= 0 ? start : r.runEnd + 1;
	return {
		pauses,
		oEnd: (endStretch - r.from) * stepSec,
		trail: (r.runEnd + 1 - endStretch) * stepSec,
		endStretch,
		run,
	};
}

/**
 * Highest value below `e` in the first `ds` seconds of the phase that contains the end.
 *
 * @param s - Series
 * @param t - Table of the run
 * @param e - End threshold
 * @param ds - End waiting time in s
 */
function endLevel(s: TickSeries, t: RunTable, e: number, ds: number): number {
	const to = Math.min(s.length - 1, t.endStretch + Math.ceil((ds * 1000) / s.stepMs));
	let b = Number.NEGATIVE_INFINITY;
	for (let i = t.endStretch; i <= to; i++) {
		if (s.last[i] < e) {
			b = Math.max(b, s.last[i]);
		}
	}
	return b;
}

/**
 * Shortest safe end waiting time and the best pause protection (closed form) for a set of runs.
 *
 * @param ctx - Series and settings
 * @param e - End threshold in W
 * @param tables - Tables of the runs to cover
 */
export function planFor(ctx: PlanContext, e: number, tables: RunTable[]): Plan {
	const poll = ctx.pollSec;
	const n = Math.max(1, tables.length);
	const all = tables.flatMap(t => t.pauses);
	const dmax = all.reduce((m, p) => Math.max(m, p.d), 0);
	const trail = tables.reduce((m, t) => Math.max(m, t.trail), 0);
	const dsFor = (dk: number): number =>
		Math.ceil(Math.max(minEndSec(poll), dk + margin(dk, poll), trail > 0 ? trail + margin(trail, poll) : 0));
	const noGuardDs = dsFor(dmax);
	const noGuardCost = n * noGuardDs;
	let best: { cost: number; Ds: number; guard: GuardSettings } | null = null;
	const levels = [0, ...[...new Set(all.map(p => p.d))].sort((a, b) => a - b)];
	for (const dk of levels) {
		const held = all.filter(p => p.d > dk);
		if (held.length === 0) {
			continue;
		}
		const Ds = dsFor(dk);
		const hold = Math.ceil(1.25 * Math.max(...held.map(p => p.d)) + 2 * poll);
		const options: { cost: number; guard: GuardSettings }[] = [];
		const a = Math.max(...held.map(p => p.lv));
		const b = Math.min(...tables.map(t => endLevel(ctx.series, t, e, Ds)));
		// halfway between the pauses and the end, but above 0 (pauses at slightly negative values)
		const below = round2(Math.max((a + b) / 2, b / 2));
		if (Number.isFinite(b) && below > 0 && b - a >= Math.max(LEVEL_SEP_W, 0.5 * b, 2 * ctx.minDeltaW)) {
			options.push({
				cost: n * Ds,
				guard: { pauseHoldSec: hold, pauseUntilSec: 0, pauseBelowVal: below },
			});
		}
		const oH = Math.max(...held.map(p => p.o));
		const T = Math.ceil(oH + Math.max(2 * poll, 180, 0.25 * oH));
		options.push({
			cost: tables.reduce((sum, t) => sum + (t.oEnd < T ? Math.max(hold, Ds) : Ds), 0),
			guard: { pauseHoldSec: hold, pauseUntilSec: T, pauseBelowVal: 0 },
		});
		const option = options.reduce((x, y) => (y.cost < x.cost ? y : x));
		if (!best || option.cost < best.cost) {
			best = { cost: option.cost, Ds, guard: option.guard };
		}
	}
	if (best && (noGuardCost - best.cost) / n >= GUARD_MIN_GAIN_SEC) {
		return { e, Ds: best.Ds, guard: best.guard, estCost: best.cost, dmax, noGuardDs };
	}
	return { e, Ds: noGuardDs, guard: null, estCost: noGuardCost, dmax, noGuardDs };
}
