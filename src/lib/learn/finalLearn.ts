import { createDetector } from "../detector/index.js";
import { FINAL_KEYS } from "../detector/types.js";
import type { DetectionSettings, FinalSettings } from "../detector/types.js";
import { finalViolations } from "../config.js";
import type { BaseBands, Unit } from "./bands.js";
import { bandSegmentsOf, suspectLimitOf } from "./bands.js";
import type { RunSample, Verdict } from "./quality.js";
import { admitted } from "./quality.js";
import type { RunInfo } from "./runs.js";
import { DENSE_MIN_MS, median, PAD_AFTER_MS, PAD_BEFORE_MS, quantile, SUSTAINED_MS } from "./runs.js";
import type { TickSeries } from "./ticks.js";

/** Why no final phase is offered (Spec B.6). */
export type FinalRejectReason =
	| "tooFewRuns"
	| "noSeparation"
	| "tailInBand"
	| "earlyEnd"
	| "phantomStart"
	| "crossCheck"
	| "robustness"
	| "margin"
	| "noGain"
	| "worseOnFlagged"
	| "fewPerGroup"
	| "outOfRange"
	| "continuous";

/** Learned final phase with the result of the release checks. */
export interface FinalCandidate {
	/** Values in the unit of the state (all 0 when nothing could be learned). */
	values: Required<FinalSettings>;
	/** Released: every check passed. */
	ok: boolean;
	/** Failed checks (empty when released). */
	reasons: FinalRejectReason[];
	/** Runs with `uses.final` whose end the final phase reports early (and not too early). */
	covered: number;
	/** Mean end delay without the final phase minus with it, in s. */
	gainSec: number;
	/** Runs with `uses.end` that the final phase reports too early (and the values without it do not). */
	earlyEnds: number;
	/** Cross-check: left-out runs in which the values learned without them never report early. */
	fallbacks: number;
	/** Runs with `uses.final` per programme group. */
	perGroup: Record<number, number>;
}

/** What `learnFinal` knows about the device. */
export interface FinalLearnContext {
	/** Detection values of the device in the unit of the state (its own final phase is ignored). */
	base: DetectionSettings;
	/** Poll interval in s. */
	pollSec: number;
	/** W per unit of the state. */
	unitFactor: number;
	/** Abort detection. */
	abort: boolean;
	/** Corrected abort detection. */
	abortFixed: boolean;
	/** Base bands and hold time profile (unit of the state). */
	bands: BaseBands;
	/** Fewest runs with `uses.final` (5 in the dialog, 10 in the optimisation). */
	minRuns: number;
	/** Fewest runs per programme group (1 in the dialog, 2 in the optimisation). */
	minPerGroup: number;
	/** `continuous`: no runs, so no final phase. */
	scope?: "run" | "continuous";
	/** Called between the expensive steps. */
	yieldFn: () => Promise<void>;
}

/** One run with its series, its window to replay and the rule values read from it. */
interface Item {
	sample: RunSample;
	verdict: Verdict;
	series: TickSeries;
	info: RunInfo;
	/** First and last tick to replay. */
	fromIdx: number;
	toIdx: number;
	/** Run end and programme end in ms. */
	runEndT: number;
	progEndT: number;
	/** Stage ok (also `rare`): the run counts as clean. */
	clean: boolean;
	/** Grown together (`merged`): only the end of the whole run counts. */
	merged: boolean;
	/** Suspect limit in ms of the value of each tick from the start to the core end (Infinity = none), filled once. */
	limits?: Float64Array;
}

/** A block in the final band (ticks, inclusive). */
interface Block {
	from: number;
	to: number;
	/** Time in the band in ms. */
	ms: number;
	/** Holds a value longer than the suspect limit of its band (P28): does not count. */
	suspect: boolean;
}

/** Values read from the runs (W, s), before the replay. */
interface Rule {
	P: number;
	Pmax: number;
	hot: number;
	X: number;
	Y: number;
	Z: number;
	G: number;
	restVal: number;
	restSec: number;
	actVal: number;
	checkSec: number;
	/** A value in the final band after the final block before rest. */
	tailInBand: boolean;
}

/** Events of one replayed window. */
interface Sim {
	starts: number[];
	finished: number[];
	aborted: number;
	/** Early ends of the final phase. */
	early: number;
	/** Highest share above the activity level in a 5-min window of a lock phase. */
	actShare: number;
}

/** Judgement of one replayed run. */
interface Judge {
	/** The end that counts was reported too early, or not at all. */
	wrong: boolean;
	/** More than one start or end (merged runs: never). */
	phantom: boolean;
	/** Delay of the end that counts in s (NaN when wrong). */
	delaySec: number;
}

/** Fields holding a power (scaled from the unit of the state to W for the replay). */
const POWER_KEYS = [
	"startVal",
	"endVal",
	"standby",
	"pauseBelowVal",
	"trailerBlockVal",
	"finalMinVal",
	"finalMaxVal",
	"finalHotVal",
	"finalRestVal",
	"finalActVal",
] as const;
/** Separation of the final block: its time in the band at least this multiple of the longest other block. */
const SEPARATION = 2;
/** Steps of the P scan on the log scale (2 %). */
const P_STEP = Math.log(1.02);
/** Shortest "longest other block" in s (a run without other blocks still needs a Y above it). */
const OTHER_FLOOR_SEC = 30;
/** Lowest values of the times of the final phase in s (Spec B.6). */
const MIN_DIP_SEC = 60;
const MIN_QUIET_SEC = 120;
const MIN_REST_SEC = 60;
const MIN_CHECK_SEC = 1800;
const MIN_LOCK_SEC = 1800;
/** Longest lock phase in s (4 h). */
const MAX_LOCK_SEC = 14_400;
/** Lock and check window: this multiple of the longest measured time. */
const TIME_MARGIN = 1.5;
/** X: this share of the p10 of the start of the end block. */
const AFTER_SHARE = 0.5;
/** Quantile of the start of the end block for X. */
const AFTER_Q = 0.1;
/** Activity level: this multiple of the rest level of the trailer (or of the rest level). */
const ACT_FACTOR = 1.5;
/** Share of the activity exit: at least this … */
const ACT_SHARE_MIN = 0.6;
/** … the highest measured share plus this … */
const ACT_SHARE_ADD = 0.15;
/** … at most this. */
const ACT_SHARE_MAX = 0.8;
/** Measured share above this: the activity exit is off. */
const ACT_SHARE_OFF = 0.65;
/** Activity window of the lock phase (as `FINAL_ACT_WINDOW_MS`). */
const ACT_WINDOW_MS = 5 * 60_000;
/** Gain: at least this many s … */
const GAIN_MIN_SEC = 60;
/** … and this share of the end delay without the final phase. */
const GAIN_SHARE = 0.1;
/** Cross-check per group from this many groups on. */
const GROUP_FOLDS_MIN = 3;
/** Robustness: power factors, poll factors, share of missing values. */
const ROBUST_SCALES = [0.9, 1.1];
const ROBUST_POLLS = [3, 6];
const ROBUST_MISSING = 0.3;
/** Longest poll interval in s. */
const MAX_POLL_SEC = 600;
/** Margin: P times these factors. */
const MARGIN_FACTORS = [0.9, 1.1];
/** finalSplit: comparison data from this many clean runs on. */
const SPLIT_MIN_RUNS = 3;
/** finalSplit: the typical start sequence is read from the first 10 min … */
const START_MS = 10 * 60_000;
/** … and holds the bands at least this share of the clean runs begins with. */
const START_SHARE = 0.8;
/**
 * finalSplit: a rest between the parts counts only when it lasts at least this long (the default rest proof, exit b
 * of the lock phase); a dip below the rest level of a few seconds is no unloading (in doubt split).
 */
const SPLIT_REST_MIN_MS = MIN_REST_SEC * 1000;

/** Every field of the final phase 0. */
function zeroFinal(): Required<FinalSettings> {
	const out = {} as Required<FinalSettings>;
	for (const k of FINAL_KEYS) {
		out[k] = 0;
	}
	return out;
}

/**
 * Detection values in W (powers times the unit factor).
 *
 * @param s - Values in the unit of the state
 * @param factor - W per unit of the state
 */
function inW(s: DetectionSettings, factor: number): DetectionSettings {
	const out: DetectionSettings = { ...s };
	for (const k of POWER_KEYS) {
		const v = out[k];
		if (typeof v === "number") {
			out[k] = v * factor;
		}
	}
	return out;
}

/**
 * A power rounded to 4 significant digits.
 *
 * @param v - Power
 */
function round4(v: number): number {
	return v > 0 ? Number(v.toPrecision(4)) : 0;
}

/**
 * Index of a time in a series (nearest tick).
 *
 * @param s - Series
 * @param t - Time in ms
 */
function idxOf(s: TickSeries, t: number): number {
	return Math.round((t - s.t0) / s.stepMs);
}

/**
 * The runs of the input with the window each one is replayed in: from 30 min before the start (not before the
 * end of the sample before it) to 3 h after the end of the run (not after the start of the next sample), cut at
 * unknown ticks; runs whose window does not hold the whole run are left out.
 *
 * @param runs - Input
 */
function itemsOf(runs: readonly { sample: RunSample; verdict: Verdict; series: TickSeries }[]): Item[] {
	const bySeries = new Map<TickSeries, RunSample[]>();
	for (const r of runs) {
		const list = bySeries.get(r.series) ?? [];
		list.push(r.sample);
		bySeries.set(r.series, list);
	}
	for (const list of bySeries.values()) {
		list.sort((a, b) => a.facts.start - b.facts.start);
	}
	const out: Item[] = [];
	for (const { sample, verdict, series: s } of runs) {
		const info = sample.info;
		if (sample.kind !== "run" || info === null) {
			continue;
		}
		const list = bySeries.get(s) as RunSample[];
		const k = list.indexOf(sample);
		const prev = k > 0 ? list[k - 1] : null;
		const next = k + 1 < list.length ? list[k + 1] : null;
		let fromIdx = Math.max(
			0,
			info.from - Math.ceil(PAD_BEFORE_MS / s.stepMs),
			prev ? idxOf(s, prev.facts.end) + 1 : 0,
		);
		let toIdx = Math.min(
			s.length - 1,
			info.runEnd + Math.ceil(PAD_AFTER_MS / s.stepMs),
			next ? idxOf(s, next.facts.start) - 1 : s.length - 1,
		);
		for (let i = info.from; i >= fromIdx; i--) {
			if (s.valid[i] === 0) {
				fromIdx = i + 1;
				break;
			}
		}
		for (let i = info.from; i <= toIdx; i++) {
			if (s.valid[i] === 0) {
				toIdx = i - 1;
				break;
			}
		}
		if (toIdx < info.to) {
			continue;
		}
		out.push({
			sample,
			verdict,
			series: s,
			info,
			fromIdx,
			toIdx,
			runEndT: s.t0 + info.runEnd * s.stepMs,
			progEndT: s.t0 + info.progEnd * s.stepMs,
			clean: verdict.user === "include" || verdict.stage === "ok",
			merged: verdict.reasons.some(r => r.code === "merged"),
		});
	}
	return out;
}

/**
 * Blocks in the final band [P, Pmax) of a run up to its core end, as the final phase counts them: the held value
 * in the band adds to the block, below P for longer than G ends it, at or above Pmax or unknown ends it.
 *
 * @param it - Run
 * @param P - Lower edge in W
 * @param Pmax - Upper edge in W (Infinity = open)
 * @param dipMs - G in ms
 * @param bands - Base bands (suspect limits, unit of the state)
 * @param factor - W per unit of the state
 */
function blocksOfRun(it: Item, P: number, Pmax: number, dipMs: number, bands: BaseBands, factor: number): Block[] {
	const s = it.series;
	const from = it.info.from;
	if (!it.limits) {
		it.limits = new Float64Array(Math.max(0, it.info.coreEnd - from + 1));
		for (let i = from; i <= it.info.coreEnd; i++) {
			it.limits[i - from] = (suspectLimitOf(bands, s.last[i] / factor) ?? Number.POSITIVE_INFINITY) * 1000;
		}
	}
	const out: Block[] = [];
	let cur: Block | null = null;
	let below = 0;
	let hold = 0;
	const close = (): void => {
		if (cur) {
			out.push(cur);
		}
		cur = null;
		below = 0;
	};
	for (let i = from; i <= it.info.coreEnd; i++) {
		if (s.valid[i] === 0) {
			close();
			hold = 0;
			continue;
		}
		hold = s.has[i] === 1 ? 0 : hold + s.stepMs;
		const v = s.last[i];
		if (v >= Pmax) {
			close();
		} else if (v >= P) {
			cur ??= { from: i, to: i, ms: 0, suspect: false };
			cur.to = i;
			cur.ms += s.stepMs;
			below = 0;
			if (hold > it.limits[i - from]) {
				cur.suspect = true;
			}
		} else if (cur) {
			below += s.stepMs;
			if (below > dipMs) {
				close();
			}
		}
	}
	close();
	return out;
}

/** Result of the P scan for one P. */
interface Scan {
	P: number;
	covered: number;
	/** Final block per run (null without one). */
	finals: (Block | null)[];
	/** Longest other block in ms (at least the floor). */
	otherMs: number;
	/** Shortest final block of the covered runs in ms. */
	finalMs: number;
}

/**
 * Separation of the final blocks at one P: a run is covered when its last block counts, begins at least X after
 * the start (otherwise it could never qualify) and is at least twice as long in the band as the longest other
 * block of all runs.
 *
 * @param items - Runs
 * @param afterMs - X in ms
 * @param P - Lower edge in W
 * @param Pmax - Upper edge in W
 * @param dipMs - G in ms
 * @param floorMs - Shortest "longest other block"
 * @param bands - Base bands
 * @param factor - W per unit of the state
 */
function scanAt(
	items: readonly Item[],
	afterMs: number,
	P: number,
	Pmax: number,
	dipMs: number,
	floorMs: number,
	bands: BaseBands,
	factor: number,
): Scan {
	const all = items.map(it => blocksOfRun(it, P, Pmax, dipMs, bands, factor));
	let otherMs = floorMs;
	for (const blocks of all) {
		for (const b of blocks.slice(0, -1)) {
			if (!b.suspect) {
				otherMs = Math.max(otherMs, b.ms);
			}
		}
	}
	const finals = all.map(blocks => {
		const last = blocks.at(-1);
		return last && !last.suspect ? last : null;
	});
	let covered = 0;
	let finalMs = Number.POSITIVE_INFINITY;
	for (const [k, f] of finals.entries()) {
		if (f && f.ms >= SEPARATION * otherMs && (f.from - items[k].info.from) * items[k].series.stepMs >= afterMs) {
			covered++;
			finalMs = Math.min(finalMs, f.ms);
		}
	}
	return { P, covered, finals, otherMs, finalMs };
}

/**
 * Range of the final band (Spec B.6): the final block of a run is its last own segment in a base band up to the core
 * end that lasts at least 2 min (a pump-out or a display level after the last phase is no phase). The lower edge is that of the lowest such band (P is searched above it), the upper edge Pmax the boundary
 * of the highest such band to the next higher base band, 0 (open) when a final block lies in the highest band. In W;
 * null without any final block.
 *
 * @param items - Runs
 * @param bands - Base bands (unit of the state)
 * @param factor - W per unit of the state
 */
function finalBandOf(items: readonly Item[], bands: BaseBands, factor: number): { lo: number; Pmax: number } | null {
	let top = -1;
	let low = Number.POSITIVE_INFINITY;
	for (const it of items) {
		const seg = bandSegmentsOf(it.sample, bands, it.sample.facts.coreEnd)
			.filter(x => x.ms >= SUSTAINED_MS)
			.at(-1);
		if (seg) {
			top = Math.max(top, seg.band);
			low = Math.min(low, seg.band);
		}
	}
	if (top < 0) {
		return null;
	}
	return {
		lo: bands.bands[low].min * factor,
		Pmax: top >= bands.bands.length - 1 ? 0 : bands.bands[top].max * factor,
	};
}

/**
 * Longest stretch of ticks with a value below a level in a tick range, in ms.
 *
 * @param s - Series
 * @param from - First tick
 * @param to - Last tick
 * @param level - Level in W
 */
function longestBelowTicks(s: TickSeries, from: number, to: number, level: number): number {
	let best = 0;
	let run = 0;
	for (let i = Math.max(0, from); i <= Math.min(s.length - 1, to); i++) {
		run = s.valid[i] === 1 && s.last[i] < level ? run + s.stepMs : 0;
		best = Math.max(best, run);
	}
	return best;
}

/**
 * The rule values of Spec B.6 from the runs (W, s), or null without a separating P.
 *
 * @param items - Runs with `uses.final`
 * @param ctx - Context
 * @param minCovered - Fewest separated runs
 */
function ruleOf(items: readonly Item[], ctx: FinalLearnContext, minCovered: number): Rule | null {
	const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
	const poll = Math.max(1, ctx.pollSec);
	const G = Math.max(MIN_DIP_SEC, 2 * poll);
	// the blocks are read at the poll of the data (normally the poll of the device): a longer device poll only
	// raises the floors, which `finalViolations` then rejects instead of the learning bending the blocks
	const dataSec = items[0].series.stepMs / 1000;
	const scanDipMs = Math.max(MIN_DIP_SEC, 2 * dataSec) * 1000;
	const restVal = ctx.bands.runLimit * factor > 0 ? ctx.bands.runLimit * factor : ctx.base.standby * factor;
	const band = finalBandOf(items, ctx.bands, factor);
	if (band === null) {
		return null;
	}
	const Pmax = band.Pmax > 0 ? band.Pmax : Number.POSITIVE_INFINITY;
	let hi = Pmax;
	if (!Number.isFinite(hi)) {
		hi = 0;
		for (const it of items) {
			for (let i = it.info.from; i <= it.info.coreEnd; i++) {
				hi = Math.max(hi, it.series.last[i] || 0);
			}
		}
	}
	const floorMs = Math.max(OTHER_FLOOR_SEC, 2 * dataSec) * 1000;
	const scans: Scan[] = [];
	for (let lnP = Math.log(Math.max(restVal, band.lo)) + P_STEP; lnP < Math.log(hi); lnP += P_STEP) {
		scans.push(scanAt(items, 0, Math.exp(lnP), Pmax, scanDipMs, floorMs, ctx.bands, factor));
	}
	const best = Math.max(0, ...scans.map(x => x.covered));
	if (best < minCovered) {
		return null;
	}
	// middle of the widest range of P with the highest coverage
	let range: [number, number] | null = null;
	let start = -1;
	scans.forEach((x, k) => {
		if (x.covered === best) {
			if (start < 0) {
				start = k;
			}
			if (!range || k - start > range[1] - range[0]) {
				range = [start, k];
			}
		} else {
			start = -1;
		}
	});
	const [a, b] = range as unknown as [number, number];
	const pick = scans[(a + b) >> 1];
	const P = round4(pick.P);
	// X: half the p10 of the start of the final block; the final blocks have to begin after it
	const first = scanAt(items, 0, P, Pmax, scanDipMs, floorMs, ctx.bands, factor);
	const begins: number[] = [];
	first.finals.forEach((f, k) => {
		if (f) {
			begins.push((f.from - items[k].info.from) * items[k].series.stepMs);
		}
	});
	const X = Math.round((AFTER_SHARE * quantile(begins, AFTER_Q)) / 1000);
	const at = scanAt(items, X * 1000, P, Pmax, scanDipMs, floorMs, ctx.bands, factor);
	const Y = Math.round(Math.sqrt(at.finalMs * at.otherMs) / 1000);
	// Z: twice the longest dip below P in the final block
	let dipMs = 0;
	let progRest = 0;
	let tailRest = 0;
	let tailInBand = false;
	let hotOk = Number.isFinite(Pmax);
	const trailerVals: number[] = [];
	let gapMs = 0;
	items.forEach((it, k) => {
		const s = it.series;
		progRest = Math.max(progRest, longestBelowTicks(s, it.info.from, it.info.coreEnd, restVal));
		if (it.info.trailerFrom !== null && it.info.trailerTo !== null) {
			tailRest = Math.max(tailRest, longestBelowTicks(s, it.info.trailerFrom, it.info.trailerTo, restVal));
			const inBurst = (i: number): boolean => it.info.bursts.some(x => i >= x.from && i <= x.to);
			for (let i = it.info.trailerFrom; i <= it.info.trailerTo; i++) {
				if (s.valid[i] === 1 && !inBurst(i)) {
					trailerVals.push(s.last[i]);
				}
			}
		}
		// after the final block until rest: never in the band (tail separates), never at or above Pmax (exit c)
		const fin = at.finals[k];
		if (fin) {
			dipMs = Math.max(dipMs, longestBelowTicks(s, fin.from, fin.to, P));
			let rest = 0;
			const restTicks = Math.ceil(Math.max(MIN_REST_SEC, 3 * poll) / (s.stepMs / 1000));
			for (let i = fin.to + 1; i <= it.toIdx && rest < restTicks; i++) {
				if (s.valid[i] === 0) {
					break;
				}
				const v = s.last[i];
				rest = v < restVal ? rest + 1 : 0;
				if (v >= Pmax) {
					hotOk = false;
				} else if (v >= P && i > it.info.coreEnd) {
					tailInBand = true;
				}
			}
		}
		// check window: longest distance of two blocks in the band after X
		const after = it.info.from + Math.ceil((X * 1000) / s.stepMs);
		const blocks = blocksOfRun(it, P, Pmax, scanDipMs, ctx.bands, factor).filter(x => x.from >= after);
		for (let j = 1; j < blocks.length; j++) {
			gapMs = Math.max(gapMs, (blocks[j].from - blocks[j - 1].to) * s.stepMs);
		}
	});
	const Z = Math.max(MIN_QUIET_SEC, (2 * dipMs) / 1000, 2 * poll);
	const restSec = Math.max(MIN_REST_SEC, 3 * poll, (2 * progRest) / 1000, (TIME_MARGIN * tailRest) / 1000);
	const tailLevel = trailerVals.length > 0 ? median(trailerVals) : 0;
	let actVal = round4(ACT_FACTOR * (tailLevel > 0 ? tailLevel : restVal));
	if (actVal < restVal || actVal >= P) {
		actVal = 0;
	}
	return {
		P,
		Pmax: Number.isFinite(Pmax) ? round4(Pmax) : 0,
		hot: hotOk && Number.isFinite(Pmax) ? round4(Pmax) : 0,
		X,
		Y,
		Z: Math.round(Z),
		G,
		restVal,
		restSec: Math.round(restSec),
		actVal,
		checkSec: Math.round(Math.max(MIN_CHECK_SEC, (TIME_MARGIN * gapMs) / 1000)),
		tailInBand,
	};
}

/**
 * Final phase values in W from the rule values and the times of the replay.
 *
 * @param r - Rule values
 * @param lockSec - Lock phase
 * @param actShare - Share of the activity exit (0 = off)
 */
function valuesOf(r: Rule, lockSec: number, actShare: number): Required<FinalSettings> {
	return {
		finalMinVal: r.P,
		finalMaxVal: r.Pmax,
		finalHotVal: r.hot,
		finalAfterSec: r.X,
		finalMinSec: r.Y,
		finalQuietSec: r.Z,
		finalDipSec: r.G,
		finalRestVal: r.restVal,
		finalRestSec: r.restSec,
		finalActVal: actShare > 0 ? r.actVal : 0,
		finalActShare: actShare > 0 ? actShare : 0,
		finalCheckSec: Math.min(r.checkSec, lockSec),
		finalLockSec: lockSec,
	};
}

/**
 * Replay one window with the full detector chain (Spec B.6: including the anti-crease filter), with the events,
 * the early ends and the highest activity share in a lock phase.
 *
 * @param s - Series in W
 * @param fromIdx - First tick
 * @param toIdx - Last tick
 * @param settings - Detection values in W
 * @param ctx - Context (abort options)
 * @param actVal - Activity level in W whose share is measured in the lock phases (0 = none)
 */
function replay(
	s: TickSeries,
	fromIdx: number,
	toIdx: number,
	settings: DetectionSettings,
	ctx: FinalLearnContext,
	actVal = 0,
): Sim {
	const det = createDetector(settings, { abort: ctx.abort, abortFixed: ctx.abortFixed, pollSec: s.stepMs / 1000 });
	const feed = settings.mode === "timed" ? det.feed?.bind(det) : undefined;
	const out: Sim = { starts: [], finished: [], aborted: 0, early: 0, actShare: 0 };
	const collect = (r: { events: string[]; times?: number[] }, t: number): void => {
		r.events.forEach((ev, k) => {
			const at = r.times?.[k] ?? t;
			if (ev === "started") {
				out.starts.push(at);
			} else if (ev === "finished") {
				out.finished.push(at);
			} else if (ev === "aborted") {
				out.aborted++;
			}
		});
	};
	const win: { ms: number; above: boolean }[] = [];
	let winMs = 0;
	let aboveMs = 0;
	let prevVal: number | null = null;
	const step = s.stepMs;
	for (let i = fromIdx; i <= toIdx; i++) {
		const t = s.t0 + i * step;
		const last = s.last[i];
		if (feed && s.has[i] === 1) {
			if (s.max[i] > last) {
				collect(feed(s.max[i], t - step / 2), t - step / 2);
			}
			if (s.min[i] < last) {
				collect(feed(s.min[i], t - step / 4), t - step / 4);
			}
			collect(feed(last, t), t);
		}
		const wasSettling = det.settling === true;
		collect(det.tick(last, t, { switchOff: false }), t);
		if (actVal > 0 && wasSettling && det.settling === true && prevVal !== null) {
			const above = prevVal > actVal;
			win.push({ ms: step, above });
			winMs += step;
			aboveMs += above ? step : 0;
			while (winMs > ACT_WINDOW_MS) {
				const first = win.shift() as { ms: number; above: boolean };
				winMs -= first.ms;
				aboveMs -= first.above ? first.ms : 0;
			}
			if (winMs >= ACT_WINDOW_MS) {
				out.actShare = Math.max(out.actShare, aboveMs / winMs);
			}
		} else if (det.settling !== true) {
			win.length = 0;
			winMs = 0;
			aboveMs = 0;
		}
		prevVal = last;
	}
	out.early = det.stats?.early ?? 0;
	return out;
}

/**
 * Whether an end is not too early (Spec B.4 `endOk` in times).
 *
 * @param it - Run
 * @param f - Time of the end
 */
function endInTime(it: Item, f: number): boolean {
	return f >= it.runEndT || (f > it.progEndT && it.runEndT - f <= DENSE_MIN_MS);
}

/**
 * Judgement of a replayed run: the first end (merged runs: the last one, Entscheidung 9) not too early, one start
 * and one end.
 *
 * @param it - Run
 * @param r - Replay
 */
function judge(it: Item, r: Sim): Judge {
	const f = it.merged ? r.finished.at(-1) : r.finished[0];
	const wrong = f === undefined || r.starts.length === 0 || !endInTime(it, f);
	const phantom =
		!it.merged &&
		(r.starts.length > 1 || r.finished.length > 1 || r.aborted > 0 || r.starts.some(t => f !== undefined && t > f));
	return { wrong, phantom, delaySec: wrong ? Number.NaN : (f - it.runEndT) / 1000 };
}

/**
 * Series with every value scaled.
 *
 * @param s - Series
 * @param k - Factor
 */
function scaledSeries(s: TickSeries, k: number): TickSeries {
	return { ...s, last: s.last.map(v => v * k), max: s.max.map(v => v * k), min: s.min.map(v => v * k) };
}

/**
 * Series polled every k-th tick (last value at the poll, extremes over the k ticks).
 *
 * @param s - Series
 * @param k - Poll factor
 * @param phase - First original tick of the new grid
 */
function coarseSeries(s: TickSeries, k: number, phase: number): TickSeries {
	const n = Math.max(0, Math.floor((s.length - 1 - phase) / k) + 1);
	const last = new Float64Array(n);
	const max = new Float64Array(n);
	const min = new Float64Array(n);
	const has = new Uint8Array(n);
	const valid = new Uint8Array(n);
	for (let j = 0; j < n; j++) {
		const i = phase + j * k;
		last[j] = s.last[i];
		let hi = s.last[i];
		let lo = s.last[i];
		let any = 0;
		let ok = 1;
		for (let x = Math.max(0, i - k + 1); x <= i; x++) {
			if (s.has[x] === 1) {
				any = 1;
				hi = Math.max(hi, s.max[x]);
				lo = Math.min(lo, s.min[x]);
			}
			if (s.valid[x] === 0) {
				ok = 0;
			}
		}
		max[j] = hi;
		min[j] = lo;
		has[j] = any;
		valid[j] = ok;
	}
	return {
		...s,
		t0: s.t0 + phase * s.stepMs,
		stepMs: s.stepMs * k,
		length: n,
		last,
		max,
		min,
		has,
		valid,
		firstIdx: 0,
	};
}

/**
 * Series with a share of the stored values missing (the held value goes on), seeded.
 *
 * @param s - Series
 * @param share - Share of the values to drop
 * @param seed - Seed
 */
function missingSeries(s: TickSeries, share: number, seed: number): TickSeries {
	let a = seed >>> 0;
	const rnd = (): number => {
		a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
		return a / 0x100000000;
	};
	const last = s.last.slice();
	const max = s.max.slice();
	const min = s.min.slice();
	const has = s.has.slice();
	let held = s.last[0];
	for (let i = 0; i < s.length; i++) {
		if (s.has[i] === 1 && i > 0 && rnd() < share) {
			has[i] = 0;
			max[i] = held;
			min[i] = held;
		} else if (s.has[i] === 1) {
			held = s.last[i];
		}
		last[i] = held;
	}
	return { ...s, last, max, min, has };
}

/**
 * Series one poll later (every value one tick later).
 *
 * @param s - Series
 */
function laterSeries(s: TickSeries): TickSeries {
	return { ...s, t0: s.t0 + s.stepMs };
}

/**
 * Learn the final phase from the runs and check whether it may be released (Spec B.6). The values follow the rules
 * of the table over the runs with `uses.final`; the release replays all runs with `uses.end` with the full chain
 * and needs: enough separated runs, a tail that stays out of the final band, no end too early and no extra start
 * (merged runs: only the end of the whole run), a cross-check without the left-out run or group, robustness,
 * margin of P, a gain, no run with findings worse than without the final phase. Values are never clamped: values
 * out of range (also the floors at the poll of the device) give `outOfRange`.
 *
 * @param runs - Samples with verdict and series (W); non-runs are only neighbours of the windows
 * @param ctx - Context
 */
export async function learnFinal(
	runs: readonly { sample: RunSample; verdict: Verdict; series: TickSeries }[],
	ctx: FinalLearnContext,
): Promise<FinalCandidate> {
	const result: FinalCandidate = {
		values: zeroFinal(),
		ok: false,
		reasons: [],
		covered: 0,
		gainSec: 0,
		earlyEnds: 0,
		fallbacks: 0,
		perGroup: {},
	};
	if (ctx.scope === "continuous") {
		result.reasons.push("continuous");
		return result;
	}
	const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
	const items = itemsOf(runs);
	const finals = items.filter(it => admitted(it.verdict, "final"));
	const ends = items.filter(it => admitted(it.verdict, "end"));
	for (const it of finals) {
		result.perGroup[it.sample.family] = (result.perGroup[it.sample.family] ?? 0) + 1;
	}
	if (finals.length < ctx.minRuns) {
		result.reasons.push("tooFewRuns");
		return result;
	}
	if (Object.values(result.perGroup).some(n => n < ctx.minPerGroup)) {
		result.reasons.push("fewPerGroup");
		return result;
	}
	const rule = ruleOf(finals, ctx, ctx.minRuns);
	if (rule === null) {
		result.reasons.push("noSeparation");
		return result;
	}
	if (rule.tailInBand) {
		result.reasons.push("tailInBand");
	}
	const toUnit = (v: Required<FinalSettings>): Required<FinalSettings> => ({
		...v,
		finalMinVal: v.finalMinVal / factor,
		finalMaxVal: v.finalMaxVal / factor,
		finalHotVal: v.finalHotVal / factor,
		finalRestVal: v.finalRestVal / factor,
		finalActVal: v.finalActVal / factor,
	});
	// provisional values: lock at its maximum, activity exit off
	result.values = toUnit(valuesOf(rule, MAX_LOCK_SEC, 0));
	if (finalViolations(result.values, ctx.base.standby, ctx.pollSec).length > 0) {
		result.reasons.push("outOfRange");
		return result;
	}
	if (result.reasons.length > 0) {
		return result;
	}
	const baseW = { ...inW(ctx.base, factor), ...zeroFinal() };
	const withFinal = (v: Required<FinalSettings>): DetectionSettings => ({ ...baseW, ...v });
	// without the final phase: end of the inner detector and delays
	const baseSims = ends.map(it => replay(it.series, it.fromIdx, it.toIdx, baseW, ctx));
	const base = ends.map((it, k) => judge(it, baseSims[k]));
	const baseEnd = baseSims.map(r => r.finished[0]);
	await ctx.yieldFn();
	// lock phase: 1.5 × the longest time from the early end to the end of the inner detector
	let longest = 0;
	ends.forEach((it, k) => {
		const r = replay(it.series, it.fromIdx, it.toIdx, withFinal(valuesOf(rule, MAX_LOCK_SEC, 0)), ctx);
		if (r.early > 0 && r.finished.length > 0 && baseEnd[k] !== undefined) {
			longest = Math.max(longest, baseEnd[k] - r.finished[0]);
		}
	});
	const lockSec = Math.round(Math.min(MAX_LOCK_SEC, Math.max(MIN_LOCK_SEC, (TIME_MARGIN * longest) / 1000)));
	await ctx.yieldFn();
	// activity exit: highest share above the activity level in a lock phase
	let share = 0;
	if (rule.actVal > 0) {
		for (const it of ends) {
			const r = replay(it.series, it.fromIdx, it.toIdx, withFinal(valuesOf(rule, lockSec, 0)), ctx, rule.actVal);
			share = Math.max(share, r.actShare);
		}
	}
	const actShare =
		rule.actVal > 0 && share <= ACT_SHARE_OFF
			? Math.round(Math.min(ACT_SHARE_MAX, Math.max(ACT_SHARE_MIN, share + ACT_SHARE_ADD)) * 100) / 100
			: 0;
	const W = valuesOf(rule, lockSec, actShare);
	result.values = toUnit(W);
	if (finalViolations(result.values, ctx.base.standby, ctx.pollSec).length > 0) {
		result.reasons.push("outOfRange");
		return result;
	}
	await ctx.yieldFn();
	// replay of every run admitted for the end
	const add = (r: FinalRejectReason): void => {
		if (!result.reasons.includes(r)) {
			result.reasons.push(r);
		}
	};
	const settings = withFinal(W);
	let sumBase = 0;
	let sumCand = 0;
	let n = 0;
	const earlyOf = (sets: DetectionSettings): number[] =>
		ends.map((it, k) => {
			const j = judge(it, replay(it.series, it.fromIdx, it.toIdx, sets, ctx));
			return j.wrong && !base[k].wrong ? 1 : 0;
		});
	ends.forEach((it, k) => {
		const r = replay(it.series, it.fromIdx, it.toIdx, settings, ctx);
		const j = judge(it, r);
		const b = base[k];
		const worse = (j.wrong && !b.wrong) || (j.phantom && !b.phantom);
		if (j.wrong && !b.wrong) {
			result.earlyEnds++;
		}
		if (worse) {
			if (!it.clean) {
				add("worseOnFlagged");
			} else {
				add(j.wrong && !b.wrong ? "earlyEnd" : "phantomStart");
			}
		}
		if (r.early > 0 && !j.wrong && admitted(it.verdict, "final")) {
			result.covered++;
		}
		if (!j.wrong && !b.wrong) {
			sumBase += b.delaySec;
			sumCand += j.delaySec;
			n++;
		}
	});
	await ctx.yieldFn();
	if (result.covered < ctx.minRuns) {
		add("tooFewRuns");
	}
	const meanBase = n > 0 ? sumBase / n : 0;
	result.gainSec = n > 0 ? Math.round(meanBase - sumCand / n) : 0;
	if (result.gainSec < Math.max(GAIN_MIN_SEC, GAIN_SHARE * meanBase)) {
		add("noGain");
	}
	// cross-check: learned without each run (from 3 groups on: without each group), the left-out run is never
	// reported too early; falling back to the normal end is allowed
	const groups = [...new Set(finals.map(it => it.sample.family))];
	const folds: Item[][] =
		groups.length >= GROUP_FOLDS_MIN
			? groups.map(g => finals.filter(it => it.sample.family === g))
			: finals.map(it => [it]);
	for (const fold of folds) {
		const train = finals.filter(it => !fold.includes(it));
		const r = train.length > 0 ? ruleOf(train, ctx, 1) : null;
		for (const it of fold) {
			const k = ends.indexOf(it);
			if (r === null) {
				result.fallbacks++;
				continue;
			}
			const sim = replay(
				it.series,
				it.fromIdx,
				it.toIdx,
				withFinal({ ...valuesOf(r, lockSec, actShare), finalCheckSec: W.finalCheckSec }),
				ctx,
			);
			const j = judge(it, sim);
			if (j.wrong && !(k >= 0 && base[k].wrong)) {
				add("crossCheck");
			} else if (sim.early === 0) {
				result.fallbacks++;
			}
		}
		await ctx.yieldFn();
	}
	// robustness: power ±10 %, poll × 3 and × 6, 30 % missing values, one poll later
	const variants: ((s: TickSeries) => TickSeries)[] = [
		...ROBUST_SCALES.map(k => (s: TickSeries) => scaledSeries(s, k)),
		...ROBUST_POLLS.filter(k => (k * (ends[0]?.series.stepMs ?? 0)) / 1000 <= MAX_POLL_SEC).map(
			k => (s: TickSeries) => coarseSeries(s, k, 0),
		),
		(s: TickSeries) => missingSeries(s, ROBUST_MISSING, 5),
		laterSeries,
	];
	for (const make of variants) {
		const cache = new Map<TickSeries, TickSeries>();
		for (const it of ends) {
			let v = cache.get(it.series);
			if (!v) {
				v = make(it.series);
				cache.set(it.series, v);
			}
			const from = Math.max(0, idxOf(v, it.series.t0 + it.fromIdx * it.series.stepMs));
			const to = Math.min(v.length - 1, idxOf(v, it.series.t0 + it.toIdx * it.series.stepMs));
			const bj = judge(it, replay(v, from, to, baseW, ctx));
			const j = judge(it, replay(v, from, to, settings, ctx));
			if (j.wrong && !bj.wrong) {
				add("robustness");
			}
		}
		await ctx.yieldFn();
	}
	// margin: P ± 10 % does not change the number of early ends
	const early0 = result.earlyEnds;
	for (const m of MARGIN_FACTORS) {
		const e = earlyOf(withFinal({ ...W, finalMinVal: W.finalMinVal * m })).reduce((x, y) => x + y, 0);
		if (e !== early0) {
			add("margin");
		}
	}
	await ctx.yieldFn();
	result.ok = result.reasons.length === 0;
	return result;
}

/**
 * Longest stretch with a held value below a level in a time range, in ms.
 *
 * @param points - Stored values sorted by time
 * @param from - Begin in ms
 * @param to - End in ms
 * @param level - Level (unit of the values)
 */
function longestBelow(points: readonly { ts: number; val: number }[], from: number, to: number, level: number): number {
	let best = 0;
	let run = 0;
	for (let k = 0; k < points.length; k++) {
		const a = Math.max(points[k].ts, from);
		const b = Math.min(k + 1 < points.length ? points[k + 1].ts : to, to);
		if (b <= a) {
			continue;
		}
		run = points[k].val < level ? run + (b - a) : 0;
		best = Math.max(best, run);
	}
	return best;
}

/**
 * Stored values of two samples together, sorted, without equal times twice.
 *
 * @param a - First sample
 * @param b - Second sample
 */
function joined(a: Unit, b: Unit): { ts: number; val: number }[] {
	const all = [...a.points, ...b.points].sort((x, y) => x.ts - y.ts);
	return all.filter((p, k) => k === 0 || p.ts !== all[k - 1].ts);
}

/**
 * Base bands of the first 10 min of a run.
 *
 * @param u - Sample
 * @param start - Start in ms
 * @param bands - Base bands
 */
function startBands(u: Unit, start: number, bands: BaseBands): Set<number> {
	const to = Math.min(u.to, start + START_MS);
	const core: Unit = { points: u.points, from: start, to: Math.max(start, to) };
	return new Set(bandSegmentsOf(core, bands).map(x => x.band));
}

/**
 * Whether the run after an early end is the rest of the split programme (Spec B.2 `finalSplit`, judged afterwards):
 * it does not begin with the typical start sequence (in its first 10 min one of the base bands is missing that at
 * least 80 % of the clean runs have in theirs), or between the early end and its start there was no rest below
 * `finalRestVal` longer than the longest rest in the programme of the clean runs (and at least as long as the default
 * rest proof of 60 s). In doubt `finalSplit`, but only with comparison data (at least 3 clean runs and base bands);
 * without them only the rest counts, compared with the longest rest in the early part itself.
 *
 * `next` has to hold the stored values from the early end on (the time between the parts), `prev` those of the
 * early part; values in the unit of the state.
 *
 * @param prev - Early part (run start to early end)
 * @param next - Run after the early end (start with the mark `afterFinal` b–g)
 * @param clean - Clean runs for comparison
 * @param bands - Base bands, or null
 * @param finalRestVal - Rest level of the final phase (unit of the state)
 */
export function checkFinalSplit(
	prev: RunSample,
	next: RunSample,
	clean: readonly RunSample[],
	bands: BaseBands | null,
	finalRestVal: number,
): boolean {
	const runs = clean.filter(c => c.kind === "run");
	const between = longestBelow(joined(prev, next), prev.facts.end, next.facts.start, finalRestVal);
	if (runs.length < SPLIT_MIN_RUNS || bands === null || bands.bands.length === 0) {
		return (
			between < SPLIT_REST_MIN_MS ||
			between <= longestBelow(prev.points, prev.facts.start, prev.facts.end, finalRestVal)
		);
	}
	const count = new Map<number, number>();
	for (const r of runs) {
		for (const b of startBands(r, r.facts.start, bands)) {
			count.set(b, (count.get(b) ?? 0) + 1);
		}
	}
	const typical = [...count].filter(([, c]) => c >= START_SHARE * runs.length).map(([b]) => b);
	const own = startBands(next, next.facts.start, bands);
	if (typical.some(b => !own.has(b))) {
		return true;
	}
	let longest = 0;
	for (const r of runs) {
		longest = Math.max(longest, longestBelow(r.points, r.facts.start, r.facts.coreEnd, finalRestVal));
	}
	return between < SPLIT_REST_MIN_MS || between <= longest;
}
