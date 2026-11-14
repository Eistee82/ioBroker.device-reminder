import type { FinalExit } from "../detector/types.js";
import type { HistorySettings } from "../historySource.js";
import type { BaseBands, Unit } from "./bands.js";
import { bandOf, bandSegmentsOf, suspectLimitOf, unitsOf } from "./bands.js";
import type { RawPoint } from "./clean.js";
import { cleanPoints } from "./clean.js";
import type { StoredFeatures } from "./families.js";
import { assignFamilies, FAMILY_DISTANCE, featuresOf } from "./families.js";
import type { Layout, RunInfo, Span } from "./runs.js";
import {
	blocksOf,
	buildLayout,
	END_BLOCK_BRIDGE_MS,
	END_BLOCK_SHARE,
	LEVEL_SEP_W,
	median,
	mergeBlocks,
	quantile,
	SUSTAINED_MS,
} from "./runs.js";
import type { TickSeries } from "./ticks.js";
import { fromPoints, markInvalid } from "./ticks.js";

/** Findings of the run check (Spec B.2). */
export type QualityCode =
	| "incomplete"
	| "gap"
	| "stuck"
	| "sparse"
	| "unit"
	| "counter"
	| "foreign"
	| "spike"
	| "test"
	| "aborted"
	| "trailerCut"
	| "merged"
	| "finalSplit"
	| "historyCfg"
	| "invalid"
	| "timeJump"
	| "rare"
	| "formerlyDropped";

/** One finding with its explanation. For `gap` the detail starts with `proven` or `suspect`. */
export interface Reason {
	/** Finding. */
	code: QualityCode;
	/** Explanation (numbers in s and in the unit of the state). */
	detail: string;
}

/** What the run check says about one run (Spec B.2). */
export interface Verdict {
	/** Start minute (UTC) and device; live and history runs match within ±5 min (`sameRun`). */
	key: string;
	/** Stage from the findings (`stageOf`); computed again at every evaluation. */
	stage: "ok" | "limited" | "quarantine" | "unusable";
	/** Findings. */
	reasons: Reason[];
	/** What the run may be used for (`usesOf`). */
	uses: { start: boolean; end: boolean; phases: boolean; final: boolean; trailer: boolean; rest: boolean };
	/** Safety limits the run sets on its own, with the value without it (set by the optimisation). */
	boundary?: { quantity: string; value: number; without: number }[];
	/** Time the run last stopped a candidate of the optimisation (D.2). */
	veto?: number;
	/** Decision of the user; it always wins except over `unusable`. */
	user?: "include" | "exclude";
}

/** Stage of a verdict. */
export type Stage = Verdict["stage"];

/** What a run may be used for. */
export type Uses = Verdict["uses"];

/** Measured values of a sample (ms; levels in the unit of the state). */
export interface SampleFacts {
	/** First active tick (day section: begin). */
	start: number;
	/** Core end (spike, day section: end). */
	coreEnd: number;
	/** Programme end (`RunInfo.progEnd`). */
	progEnd: number;
	/** End of the run including a drying plateau. */
	runEnd: number;
	/** Last active tick including the trailer. */
	end: number;
	/** Duration of the programme in s (start to core end). */
	coreSec: number;
	/** Group features (runs only). */
	feat: StoredFeatures | null;
	/** Core end to the moment the device switches off after trailer and rest level, in s; null if unknown. */
	offSec: number | null;
	/** Level in the 30 min before the start (median), null without values. */
	preLevel: number | null;
	/** Level in the 30 min after the end (median), null without values. */
	postLevel: number | null;
	/** Level after the end of the run (`RunInfo.postEnd`), null for spikes and day sections. */
	restLevel: number | null;
	/** Sustained blocks above the end block level up to the core end (the last one is the end block). */
	endBlocks: { from: number; to: number; level: number }[];
	/** Share of the raw values in the sample that were missing, not a number or negative. */
	invalidShare: number;
	/** Jumps back in time of more than a minute inside the sample. */
	timeJumps: number;
}

/** A run, a short activity or a day section, with its stored values (Spec B.2). */
export interface RunSample extends Unit {
	/** Key (`verdictKey`). */
	key: string;
	/** Layout run, short activity below MIN_ACTIVE_MS, or a segment dropped as incomplete. */
	kind: "run" | "spike" | "incomplete";
	/** Origin. */
	src: "live" | "history";
	/** Layout of the run (layout runs only). */
	info: RunInfo | null;
	/** Programme group (-1 without `info`). */
	family: number;
	/** Report times in ms (live report log), also for unchanged values. */
	reports?: number[];
	/** Live: the run was aborted. */
	aborted?: boolean;
	/** Live: the adapter restarted during the run. */
	restarted?: boolean;
	/** Live: the start came from the lock phase of the final phase with this exit. */
	afterFinal?: FinalExit;
	/** Live: reported starts in the run (ms). */
	starts?: number[];
	/** Measured values. */
	facts: SampleFacts;
}

/** What the run check knows about the device and the data. */
export interface QualityContext {
	/** Base bands and hold time profile (unit of the state), or null. */
	bands: BaseBands | null;
	/** W per unit of the state. */
	unitFactor: number;
	/** Unit text of the state. */
	unit: string;
	/** Settings of the history adapter, or null. */
	settings: HistorySettings | null;
	/** Poll interval in ms. */
	pollMs: number;
	/** Times the adapter or the logger was down. */
	outages: { from: number; to: number }[];
	/** `run`: one sample per run; `continuous`: day sections. */
	scope: "run" | "continuous";
	/** Typical peak of the chosen template in W (unit check). */
	templatePeakW?: number;
	/** Range and keys of an old V4 store (before V5). */
	oldStore?: { from: number; to: number; keys: string[] };
}

/** Two keys within this many minutes are the same run. */
const SAME_RUN_MIN = 5;
/** Window before and after a run for the rest level (foreign load). */
const AROUND_MS = 30 * 60_000;
/** Time after the end in which the device has to switch off (otherwise unknown). */
const OFF_SCAN_MS = 6 * 60 * 60_000;
/** Proven gap with relog: silence longer than this multiple of the relog interval plus a poll. */
const RELOG_GAP_FACTOR = 2;
/** Proven gap in the report log: silence longer than this multiple of p99.9 of the report intervals … */
const REPORT_GAP_FACTOR = 3;
/** … and at least this long. */
const REPORT_GAP_MIN_MS = 2 * 60_000;
/** Stuck: at least this many reports with the same value … */
const STUCK_MIN_REPORTS = 20;
/** … in a band whose values otherwise vary by more than this (coefficient of variation). */
const STUCK_MIN_CV = 0.05;
/** Sparse: p90 of the intervals above this multiple of the median p90 of the other runs. */
const SPARSE_FACTOR = 4;
/** Unit: run peak below 1/50 or above 50 times the median run peak. */
const UNIT_FACTOR = 50;
/** Unit: typical peak below 1/100 of the template peak. */
const UNIT_TEMPLATE_FACTOR = 100;
/** Foreign load: rest level above the usual one by at least this many W … */
const FOREIGN_MIN_W = 20;
/** … or this many times its spread. */
const FOREIGN_SPREAD = 3;
/** Foreign load: share of the run above the known range of the highest band. */
const FOREIGN_TOP_SHARE = 0.05;
/** Known range of the highest band: this multiple of p99.9 of the other runs. */
const FOREIGN_TOP_FACTOR = 1.5;
/** Spike: single value above this multiple of p99.9 of the runs. */
const SPIKE_FACTOR = 3;
/** Quantile of the values of the runs for spikes and the highest band. */
const TOP_Q = 0.999;
/** Test: a run shorter than this. */
const TEST_RUN_MS = 10 * 60_000;
/** Test: a short activity longer than this multiple of the second longest. */
const TEST_SPIKE_RATIO = 2;
/** Test: a band of the typical sequence is touched by at least this share of the clean runs. */
const COMMON_SHARE = 0.5;
/** Cut trailer: shorter than this share of the median trailer of the other runs … */
const TRAILER_SHARE = 0.5;
/** … or the device switches off earlier than the median minus max(5 min, 4 × MADn). */
const TRAILER_EARLY_MIN_SEC = 5 * 60;
/** See TRAILER_EARLY_MIN_SEC. */
const TRAILER_EARLY_MAD = 4;
/** Cut trailer: only for devices with a trailer in at least this many clean runs. */
const TRAILER_MIN_RUNS = 2;
/** Grown together: longer than this multiple of the longest run of its group. */
const MERGED_FACTOR = 1.8;
/** A block is like the end block when its level is within this factor of it (without bands). */
const END_LEVEL_RATIO = 2;
/** Invalid values: more than this share. */
const INVALID_SHARE = 0.01;
/**
 * Programme groups of the run check: runs closer than this (RMS of the z-normalised features). Twice
 * the family distance: over a few runs the z-normalisation is dominated by the rare programmes, and with
 * FAMILY_DISTANCE 6 of 11 normal washer runs would be groups of their own.
 */
const GROUP_DISTANCE = 2 * FAMILY_DISTANCE;
/** Rare: |z| of log duration or log energy in its group above this. */
const RARE_Z = 3.5;
/** Comparisons over all other runs (cut trailer, aborted, rare) need at least this many. */
const RARE_GROUP_MIN = 3;
/** Rare by z: the group has at least this many other runs (a spread of fewer runs means nothing). */
const RARE_Z_MIN = 5;
/** Smallest spread of the log values in a group (15 %). */
const RARE_SPREAD_MIN = 0.15;
/** Rare: duration, energy or longest block below half the smallest or above twice the largest of all other runs. */
const RARE_FAR = 2;
/** Rare: a run of its own group is not rare when another run has duration, energy and longest block within 20 %. */
const RARE_TWIN = Math.log(1.2);
/** History rounding coarser than this share of the rest level. */
const ROUND_SHARE = 0.1;
/** Aborted (history): the device switched off within this time after the core end. */
const ABORT_OFF_SEC = 60;
/** Aborted (history): duration below this quantile of its group. */
const ABORT_Q = 0.1;
/** Aborted (history): no end block of at least this share of the median end block. */
const ABORT_END_BLOCK_SHARE = 0.5;

/** Stage of each finding (`gap`/`stuck` depend on the detail). */
const STAGE_OF: Record<QualityCode, Stage> = {
	incomplete: "unusable",
	gap: "quarantine",
	unit: "unusable",
	counter: "unusable",
	stuck: "quarantine",
	sparse: "quarantine",
	foreign: "quarantine",
	test: "quarantine",
	merged: "limited",
	trailerCut: "limited",
	aborted: "limited",
	spike: "limited",
	historyCfg: "limited",
	invalid: "limited",
	timeJump: "limited",
	finalSplit: "ok",
	rare: "ok",
	formerlyDropped: "ok",
};

/** Order of the findings for the hint (Spec B.3, P7): data errors before form findings. */
const RANK: QualityCode[] = [
	"incomplete",
	"gap",
	"unit",
	"counter",
	"stuck",
	"sparse",
	"foreign",
	"test",
	"merged",
	"trailerCut",
	"aborted",
	"spike",
	"historyCfg",
	"invalid",
	"timeJump",
	"finalSplit",
	"rare",
	"formerlyDropped",
];

const STAGE_ORDER: Stage[] = ["ok", "limited", "quarantine", "unusable"];

/**
 * Key of a run: device and start minute (UTC).
 *
 * @param deviceId - Device id
 * @param startMs - Start of the run in ms
 */
export function verdictKey(deviceId: string, startMs: number): string {
	return `${deviceId}@${Math.floor(startMs / 60_000)}`;
}

/**
 * Device and minute of a key, or null.
 *
 * @param key - Key
 */
function parseKey(key: string): { device: string; minute: number } | null {
	const at = key.lastIndexOf("@");
	const minute = at >= 0 ? Number(key.slice(at + 1)) : Number.NaN;
	return Number.isFinite(minute) ? { device: key.slice(0, at), minute } : null;
}

/**
 * Whether two keys stand for the same run: same device, start within 5 min (live ↔ history).
 *
 * @param a - Key
 * @param b - Key
 */
export function sameRun(a: string, b: string): boolean {
	const x = parseKey(a);
	const y = parseKey(b);
	return x !== null && y !== null && x.device === y.device && Math.abs(x.minute - y.minute) <= SAME_RUN_MIN;
}

/**
 * Stage of one finding.
 *
 * @param r - Finding
 */
function stageOfReason(r: Reason): Stage {
	if (r.code === "gap" && r.detail.startsWith("proven")) {
		return "unusable";
	}
	// scope continuous: only the segment drops out, the day stays usable
	if ((r.code === "gap" || r.code === "stuck") && r.detail.includes("segment")) {
		return "ok";
	}
	return STAGE_OF[r.code];
}

/**
 * Stage of a set of findings: `unusable` > quarantine (data errors, then form) > `limited` > `ok`.
 * `rare`, `finalSplit` and `formerlyDropped` keep the stage `ok`.
 *
 * @param reasons - Findings
 */
export function stageOf(reasons: readonly Reason[]): Stage {
	let k = 0;
	for (const r of reasons) {
		k = Math.max(k, STAGE_ORDER.indexOf(stageOfReason(r)));
	}
	return STAGE_ORDER[k];
}

/**
 * The finding that decides the hint: highest stage, then the order of Spec B.3 (data errors before
 * form findings). Null without findings.
 *
 * @param reasons - Findings
 */
export function primaryOf(reasons: readonly Reason[]): QualityCode | null {
	let best: Reason | null = null;
	for (const r of reasons) {
		if (best === null) {
			best = r;
			continue;
		}
		const a = STAGE_ORDER.indexOf(stageOfReason(r));
		const b = STAGE_ORDER.indexOf(stageOfReason(best));
		if (a > b || (a === b && RANK.indexOf(r.code) < RANK.indexOf(best.code))) {
			best = r;
		}
	}
	return best?.code ?? null;
}

/**
 * What a run with these findings may be used for (Spec B.2, column "Folge").
 *
 * @param reasons - Findings
 */
export function usesOf(reasons: readonly Reason[]): Uses {
	const u: Uses = { start: true, end: true, phases: true, final: true, trailer: true, rest: true };
	const none = (): void => {
		u.start = u.end = u.phases = u.final = u.trailer = u.rest = false;
	};
	for (const r of reasons) {
		const stage = stageOfReason(r);
		if (stage === "unusable" || stage === "quarantine") {
			none();
			continue;
		}
		switch (r.code) {
			case "merged":
				// the end of the whole run only; pauses, durations, limits, phases, final phase, trailer not
				u.phases = u.final = u.trailer = u.rest = false;
				break;
			case "trailerCut":
				u.trailer = u.rest = false;
				break;
			case "aborted":
				u.end = u.phases = u.final = u.trailer = u.rest = false;
				break;
			case "historyCfg":
				if (r.detail.startsWith("debounce")) {
					u.phases = u.trailer = false;
				} else if (r.detail.startsWith("ignoreZero")) {
					u.rest = false;
				}
				break;
			default:
				break;
		}
	}
	return u;
}

/**
 * Whether a run may be used for a purpose: the decision of the user wins (except over `unusable`),
 * otherwise stage and uses.
 *
 * @param v - Verdict
 * @param purpose - Purpose
 */
export function admitted(v: Verdict, purpose: keyof Uses): boolean {
	if (v.user === "exclude") {
		return false;
	}
	if (v.user === "include") {
		return v.stage !== "unusable";
	}
	return (v.stage === "ok" || v.stage === "limited") && v.uses[purpose];
}

/**
 * Index of the first point at or after `ts`.
 *
 * @param points - Points sorted by time
 * @param ts - Time
 */
function lowerBound(points: readonly { ts: number }[], ts: number): number {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].ts < ts) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/**
 * Index of the first number at or after `x` in a sorted array.
 *
 * @param a - Sorted numbers
 * @param x - Value
 */
function lowerNum(a: readonly number[], x: number): number {
	let lo = 0;
	let hi = a.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (a[mid] < x) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/**
 * Stored values in [from, to] with the held value at `from` as first point.
 *
 * @param points - Points sorted by time
 * @param from - Begin in ms
 * @param to - End in ms
 */
function sliceUnit(points: readonly { ts: number; val: number }[], from: number, to: number): Unit {
	const a = lowerBound(points, from);
	const b = lowerBound(points, to + 1);
	const out: { ts: number; val: number }[] = [];
	if (a > 0 && (a === points.length || points[a].ts > from)) {
		out.push({ ts: from, val: points[a - 1].val });
	}
	for (let i = a; i < b; i++) {
		out.push({ ts: points[i].ts, val: points[i].val });
	}
	return { points: out, from, to };
}

/**
 * Median of the valid values of a tick range, or null.
 *
 * @param s - Series
 * @param from - First tick
 * @param to - Last tick
 */
function medianOfTicks(s: TickSeries, from: number, to: number): number | null {
	const v: number[] = [];
	for (let i = Math.max(0, from); i <= Math.min(s.length - 1, to); i++) {
		if (s.valid[i] === 1) {
			v.push(s.last[i]);
		}
	}
	return v.length > 0 ? median(v) : null;
}

/**
 * Normalised median absolute deviation.
 *
 * @param v - Values
 */
function madn(v: readonly number[]): number {
	if (v.length === 0) {
		return 0;
	}
	const m = median(v);
	return 1.4826 * median(v.map(x => Math.abs(x - m)));
}

/**
 * Time-weighted quantile of held values.
 *
 * @param pairs - Value and duration
 * @param q - Fraction 0..1
 */
function weightedQuantile(pairs: [number, number][], q: number): number {
	if (pairs.length === 0) {
		return Number.NaN;
	}
	pairs.sort((a, b) => a[0] - b[0]);
	const total = pairs.reduce((s, p) => s + p[1], 0);
	let acc = 0;
	for (const [v, d] of pairs) {
		acc += d;
		if (acc >= q * total) {
			return v;
		}
	}
	return pairs.at(-1)![0];
}

/**
 * Held values of a sample in [from, to] with their durations.
 *
 * @param u - Sample
 * @param from - Begin in ms
 * @param to - End in ms
 */
function heldPairs(u: Unit, from: number, to: number): [number, number][] {
	const out: [number, number][] = [];
	const p = u.points;
	for (let i = 0; i < p.length; i++) {
		const a = Math.max(p[i].ts, from);
		const b = Math.min(i + 1 < p.length ? p[i + 1].ts : u.to, to);
		if (b > a) {
			out.push([p[i].val, b - a]);
		}
	}
	return out;
}

/**
 * Held value at a time, or null before the first value.
 *
 * @param u - Sample
 * @param t - Time in ms
 */
function heldAt(u: Unit, t: number): number | null {
	const i = lowerBound(u.points, t + 1) - 1;
	return i >= 0 ? u.points[i].val : null;
}

/** Raw values of the input sorted by time, for the share of invalid values per sample. */
interface RawIndex {
	/** Times of all raw values. */
	all: number[];
	/** Times of the invalid raw values. */
	bad: number[];
	/** Times of the jumps back. */
	jumps: number[];
}

/**
 * Index of the raw values.
 *
 * @param raw - Raw values in the order they arrived
 * @param jumps - Times of the jumps back
 */
function rawIndexOf(raw: readonly RawPoint[], jumps: readonly number[]): RawIndex {
	const all: number[] = [];
	const bad: number[] = [];
	for (const p of raw) {
		if (!Number.isFinite(p.ts)) {
			continue;
		}
		all.push(p.ts);
		if (p.val === null || typeof p.val !== "number" || !Number.isFinite(p.val) || p.val < 0) {
			bad.push(p.ts);
		}
	}
	all.sort((a, b) => a - b);
	bad.sort((a, b) => a - b);
	return { all, bad, jumps: [...jumps].sort((a, b) => a - b) };
}

/**
 * Count of sorted numbers in [from, to].
 *
 * @param a - Sorted numbers
 * @param from - Begin
 * @param to - End
 */
function countIn(a: readonly number[], from: number, to: number): number {
	return lowerNum(a, to + 1) - lowerNum(a, from);
}

/** Options of `samplesOf`. */
export interface SampleOptions {
	/** Origin. */
	src: "live" | "history";
	/** W per unit of the state. */
	unitFactor: number;
	/** Raw values as read (share of invalid values); missing = none. */
	raw?: readonly RawPoint[];
	/** Times of the jumps back in time. */
	timeJumps?: readonly number[];
}

/**
 * Facts of a layout run.
 *
 * @param s - Series in W
 * @param L - Layout
 * @param r - Run
 * @param all - All segments of the layout, sorted
 * @param factor - W per unit of the state
 */
function runFacts(
	s: TickSeries,
	L: Layout,
	r: RunInfo,
	all: readonly Span[],
	factor: number,
): Omit<SampleFacts, "invalidShare" | "timeJumps"> {
	const T = (i: number): number => s.t0 + i * s.stepMs;
	const feat = featuresOf(s, r, L.runLimit);
	const last = Math.max(r.to, r.runEnd);
	// switched off: below the rest level (display) or, without one, at the run level
	const offLevel = L.rest !== null ? L.idle + Math.max(LEVEL_SEP_W, 0.5 * (L.rest - L.idle)) : L.runLimit;
	let offSec: number | null = null;
	const scan = Math.ceil(OFF_SCAN_MS / s.stepMs);
	for (let i = last + 1; i < Math.min(s.length, last + scan); i++) {
		if (s.valid[i] === 0 || s.last[i] > L.runLimit) {
			break;
		}
		if (s.last[i] <= offLevel) {
			offSec = ((i - r.coreEnd) * s.stepMs) / 1000;
			break;
		}
	}
	const around = Math.ceil(AROUND_MS / s.stepMs);
	const prev = [...all].reverse().find(x => x.to < r.from);
	const next = all.find(x => x.from > last);
	const pre = medianOfTicks(s, Math.max(r.from - around, prev ? prev.to + 1 : 0), r.from - 1);
	const post = medianOfTicks(s, last + 1, Math.min(last + around, next ? next.from - 1 : s.length - 1));
	const level = L.tailSeparated ? END_BLOCK_SHARE * L.burstMaxW : L.runLimit;
	const endBlocks = mergeBlocks(
		blocksOf(s, { from: r.from, to: r.coreEnd }, level),
		Math.floor(END_BLOCK_BRIDGE_MS / s.stepMs) + 1,
	)
		.filter(b => (b.to - b.from + 1) * s.stepMs >= SUSTAINED_MS)
		.map(b => {
			const v: number[] = [];
			for (let i = b.from; i <= b.to; i++) {
				if (s.last[i] > level) {
					v.push(s.last[i]);
				}
			}
			return { from: T(b.from), to: T(b.to), level: median(v) / factor };
		});
	return {
		start: T(r.from),
		coreEnd: T(r.coreEnd),
		progEnd: T(r.progEnd),
		runEnd: T(r.runEnd),
		end: T(r.to),
		coreSec: feat.coreSec,
		feat,
		offSec,
		preLevel: pre === null ? null : pre / factor,
		postLevel: post === null ? null : post / factor,
		restLevel: r.postEnd / factor,
		endBlocks,
	};
}

/**
 * Samples of a layout: every run (`kind: "run"`), every short activity (`spike`) and every dropped
 * segment (`incomplete`), sorted by time, with programme groups for the runs. Shared by the history
 * (`runSamples`) and the run store.
 *
 * @param deviceId - Device id (keys)
 * @param points - Cleaned stored values in the unit of the state, sorted by time
 * @param s - Series in W
 * @param L - Layout of the series (all runs)
 * @param o - Options
 */
export function samplesOf(
	deviceId: string,
	points: readonly { ts: number; val: number }[],
	s: TickSeries,
	L: Layout,
	o: SampleOptions,
): RunSample[] {
	const factor = o.unitFactor > 0 ? o.unitFactor : 1;
	const T = (i: number): number => s.t0 + i * s.stepMs;
	const raw = rawIndexOf(o.raw ?? [], o.timeJumps ?? []);
	const quality = (from: number, to: number): { invalidShare: number; timeJumps: number } => {
		const n = countIn(raw.all, from, to);
		return { invalidShare: n > 0 ? countIn(raw.bad, from, to) / n : 0, timeJumps: countIn(raw.jumps, from, to) };
	};
	const all: Span[] = [...L.runs, ...L.spikes, ...L.incomplete]
		.map(x => ({ from: x.from, to: x.to }))
		.sort((a, b) => a.from - b.from);
	const units = unitsOf(points, L, s, factor);
	const feats: StoredFeatures[] = [];
	const out: RunSample[] = L.runs.map((r, k) => {
		const facts = runFacts(s, L, r, all, factor);
		feats.push(facts.feat as StoredFeatures);
		return {
			...units[k],
			key: verdictKey(deviceId, facts.start),
			kind: "run",
			src: o.src,
			info: r,
			family: -1,
			facts: { ...facts, ...quality(units[k].from, units[k].to) },
		};
	});
	const families = assignFamilies(
		feats,
		feats.map(() => -1),
		0,
	).families;
	out.forEach((x, k) => (x.family = families[k]));
	const other = (sp: Span, kind: "spike" | "incomplete"): RunSample => {
		const from = T(Math.max(0, sp.from - 1));
		const to = T(Math.min(s.length - 1, sp.to + 1));
		const start = T(sp.from);
		const end = T(sp.to);
		return {
			...sliceUnit(points, from, to),
			key: verdictKey(deviceId, start),
			kind,
			src: o.src,
			info: null,
			family: -1,
			facts: {
				start,
				coreEnd: end,
				progEnd: end,
				runEnd: end,
				end,
				coreSec: ((sp.to - sp.from + 1) * s.stepMs) / 1000,
				feat: null,
				offSec: null,
				preLevel: null,
				postLevel: null,
				restLevel: null,
				endBlocks: [],
				...quality(from, to),
			},
		};
	};
	out.push(...L.spikes.map(sp => other(sp, "spike")), ...L.incomplete.map(sp => other(sp, "incomplete")));
	return out.sort((a, b) => a.facts.start - b.facts.start);
}

/**
 * Cleaned values, series in W (unknown time after a jump back marked) and the layout of all runs.
 *
 * @param points - Raw values in the unit of the state
 * @param stepMs - Poll interval in ms
 * @param unitFactor - W per unit of the state
 */
function prepare(
	points: readonly RawPoint[],
	stepMs: number,
	unitFactor: number,
): { clean: ReturnType<typeof cleanPoints>; series: TickSeries; layout: Layout; factor: number } {
	const clean = cleanPoints(points);
	const factor = unitFactor > 0 ? unitFactor : 1;
	const series = fromPoints(
		clean.points.map(p => ({ ts: p.ts, val: p.val * factor })),
		stepMs,
	);
	for (const u of clean.unknown) {
		markInvalid(series, u.from, u.to + 1);
	}
	const layout = buildLayout(series, { maxRuns: Number.POSITIVE_INFINITY });
	return { clean, series, layout, factor };
}

/**
 * Samples of a recording (scope run): cleaned, laid out with all runs, programme groups assigned.
 * Returns every layout run, every short activity and every dropped segment.
 *
 * @param deviceId - Device id (keys)
 * @param points - Stored values in the unit of the state (any order, invalid values allowed)
 * @param o - Options
 * @param o.stepMs - Poll interval in ms
 * @param o.src - Origin
 * @param o.unitFactor - W per unit of the state
 */
export function runSamples(
	deviceId: string,
	points: readonly RawPoint[],
	o: { stepMs: number; src: "live" | "history"; unitFactor: number },
): { samples: RunSample[]; layout: Layout; series: TickSeries; clean: ReturnType<typeof cleanPoints> } {
	const { clean, series, layout, factor } = prepare(points, o.stepMs, o.unitFactor);
	const samples = samplesOf(deviceId, clean.points, series, layout, {
		src: o.src,
		unitFactor: factor,
		raw: points,
		timeJumps: clean.timeJumps.map(j => j.at),
	});
	return { samples, layout, series, clean };
}

/**
 * Day sections of a recording (scope continuous): 24 h each from the first value. A section that is
 * shorter only because the data ends there is complete (there is no run end that could be missing);
 * a section with unknown time is `incomplete`.
 *
 * @param deviceId - Device id (keys)
 * @param points - Stored values in the unit of the state (any order, invalid values allowed)
 * @param o - Options
 * @param o.stepMs - Poll interval in ms
 * @param o.src - Origin
 * @param o.unitFactor - W per unit of the state
 */
export function daySamples(
	deviceId: string,
	points: readonly RawPoint[],
	o: { stepMs: number; src: "live" | "history"; unitFactor: number },
): RunSample[] {
	const { clean, series: s } = prepare(points, o.stepMs, o.unitFactor);
	const pts = clean.points;
	if (pts.length === 0) {
		return [];
	}
	const raw = rawIndexOf(
		points,
		clean.timeJumps.map(j => j.at),
	);
	const out: RunSample[] = [];
	const first = pts[0].ts;
	const lastTs = pts.at(-1)!.ts;
	for (let from = first; from < lastTs; from += 86_400_000) {
		const to = Math.min(from + 86_400_000, lastTs);
		const a = Math.max(s.firstIdx, Math.ceil((from - s.t0) / s.stepMs));
		const b = Math.min(s.length - 1, Math.floor((to - s.t0) / s.stepMs));
		let unknown = false;
		for (let i = a; i <= b && !unknown; i++) {
			unknown = s.valid[i] === 0;
		}
		const n = countIn(raw.all, from, to);
		out.push({
			...sliceUnit(pts, from, to),
			key: verdictKey(deviceId, from),
			kind: unknown ? "incomplete" : "run",
			src: o.src,
			info: null,
			family: -1,
			facts: {
				start: from,
				coreEnd: to,
				progEnd: to,
				runEnd: to,
				end: to,
				coreSec: (to - from) / 1000,
				feat: null,
				offSec: null,
				preLevel: null,
				postLevel: null,
				restLevel: null,
				endBlocks: [],
				invalidShare: n > 0 ? countIn(raw.bad, from, to) / n : 0,
				timeJumps: countIn(raw.jumps, from, to),
			},
		});
	}
	return out;
}

/** Working state of one sample during `checkRuns`. */
interface Work {
	/** Sample. */
	s: RunSample;
	/** Findings so far. */
	reasons: Reason[];
}

/**
 * Whether a set of findings puts a run into quarantine or makes it unusable.
 *
 * @param reasons - Findings
 */
function excluded(reasons: readonly Reason[]): boolean {
	const st = stageOf(reasons);
	return st === "quarantine" || st === "unusable";
}

/**
 * Format a number for a detail text.
 *
 * @param x - Number
 */
function fmt(x: number): string {
	return String(Math.round(x * 100) / 100);
}

/**
 * Intervals between stored values inside [from, to] in ms.
 *
 * @param u - Sample
 * @param from - Begin
 * @param to - End
 */
function intervalsIn(u: Unit, from: number, to: number): number[] {
	const out: number[] = [];
	const p = u.points;
	for (let i = lowerBound(p, from) + 1; i < p.length && p[i].ts <= to; i++) {
		out.push(p[i].ts - p[i - 1].ts);
	}
	return out;
}

/**
 * Longest time without a stored value that overlaps [from, to] (also across its borders, up to the end
 * of the sample), in ms.
 *
 * @param u - Sample
 * @param from - Begin
 * @param to - End
 */
function longestSilence(u: Unit, from: number, to: number): number {
	const p = u.points;
	let longest = 0;
	if (p.length === 0) {
		return u.to - u.from;
	}
	for (let i = Math.max(1, lowerBound(p, from)); i <= p.length; i++) {
		const a = p[i - 1].ts;
		const b = i < p.length ? p[i].ts : u.to;
		if (a > to) {
			break;
		}
		if (b >= from) {
			longest = Math.max(longest, b - a);
		}
	}
	return longest;
}

/**
 * Global findings: counter instead of power, wrong unit for the template.
 *
 * @param w - Samples
 * @param ctx - Context
 */
function checkGlobal(w: Work[], ctx: QualityContext): void {
	if (/wh$/i.test(ctx.unit.trim())) {
		w.forEach(x => x.reasons.push({ code: "counter", detail: `unit ${ctx.unit.trim()}` }));
		return;
	}
	const peaks = w
		.filter(x => x.s.kind === "run" && x.s.info !== null)
		.map(x => peakOf(x.s))
		.filter(p => p > 0);
	if (peaks.length === 0) {
		return;
	}
	const typical = median(peaks);
	const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
	if (
		ctx.templatePeakW !== undefined &&
		ctx.templatePeakW > 0 &&
		typical * factor < ctx.templatePeakW / UNIT_TEMPLATE_FACTOR
	) {
		w.forEach(x =>
			x.reasons.push({
				code: "unit",
				detail: `typical peak ${fmt(typical)} ${ctx.unit}, template ${fmt(ctx.templatePeakW!)} W`,
			}),
		);
		return;
	}
	for (const x of w) {
		if (x.s.kind !== "run" || x.s.info === null) {
			continue;
		}
		const p = peakOf(x.s);
		if (p < typical / UNIT_FACTOR || p > typical * UNIT_FACTOR) {
			x.reasons.push({ code: "unit", detail: `peak ${fmt(p)}, median of the runs ${fmt(typical)}` });
		}
	}
}

/**
 * Highest value of a sample from the start to the end of the run.
 *
 * @param s - Sample
 */
function peakOf(s: RunSample): number {
	let m = 0;
	for (const [v] of heldPairs(s, s.facts.start, Math.max(s.facts.runEnd, s.facts.end) + 1)) {
		m = Math.max(m, v);
	}
	return m;
}

/**
 * Report times of a sample: the live report log, or the stored values when the history stores
 * unchanged values again (relog). Null when unchanged values are not visible.
 *
 * @param s - Sample
 * @param ctx - Context
 */
function reportsOf(s: RunSample, ctx: QualityContext): number[] | null {
	if (s.reports && s.reports.length >= 2) {
		return s.reports;
	}
	if (s.src === "history" && ctx.settings !== null && ctx.settings.relogSec > 0) {
		return s.points.map(p => p.ts);
	}
	return null;
}

/**
 * Data findings of one sample: incomplete, proven and suspect gaps, stuck values, history settings,
 * invalid values, jumps back in time.
 *
 * @param x - Sample
 * @param ctx - Context
 * @param reportP999 - p99.9 of the report intervals of all live samples in ms (0 = none)
 * @param cv - Coefficient of variation per band index
 */
function checkData(x: Work, ctx: QualityContext, reportP999: number, cv: number[]): void {
	const s = x.s;
	const f = s.facts;
	const continuous = ctx.scope === "continuous";
	if (s.kind === "incomplete") {
		x.reasons.push({
			code: "incomplete",
			detail: continuous ? "unknown time in the section" : "touches a gap or the end of the data",
		});
	}
	if (s.restarted) {
		x.reasons.push({ code: "incomplete", detail: "adapter restarted during the run" });
	}
	const runTo = Math.max(f.runEnd, f.end);
	// (1) relog: the logger stores the value again after relogSec, a longer silence is a gap
	if (s.src === "history" && ctx.settings !== null && ctx.settings.relogSec > 0) {
		const limit = RELOG_GAP_FACTOR * ctx.settings.relogSec * 1000 + ctx.pollMs;
		const longest = longestSilence(s, f.start, runTo);
		if (longest > limit) {
			x.reasons.push({
				code: "gap",
				detail: `proven: no value for ${fmt(longest / 1000)} s with relog ${ctx.settings.relogSec} s`,
			});
		}
	}
	// (2) live report log: no report, not even with the same value
	if (s.reports && s.reports.length >= 2 && reportP999 > 0) {
		const limit = Math.max(REPORT_GAP_MIN_MS, REPORT_GAP_FACTOR * reportP999);
		let longest = 0;
		for (let i = 1; i < s.reports.length; i++) {
			if (s.reports[i] >= f.start && s.reports[i - 1] <= runTo) {
				longest = Math.max(longest, s.reports[i] - s.reports[i - 1]);
			}
		}
		if (longest > limit) {
			x.reasons.push({ code: "gap", detail: `proven: no report for ${fmt(longest / 1000)} s` });
		}
	}
	// (3) the adapter or the logger was down
	const outage = ctx.outages.find(o => o.from <= runTo && o.to >= f.start);
	if (outage) {
		x.reasons.push({ code: "gap", detail: `proven: outage of ${fmt((outage.to - outage.from) / 1000)} s` });
	}
	// suspect: a value held longer than the suspect limit of its band (only with a hold time profile);
	// scope run: the first one in the core is enough; scope continuous: every segment (the day stays
	// usable, the segments drop out of the duration statistics and the phase learning)
	if (ctx.bands !== null && !s.fromTicks) {
		// scope run: up to the programme end (a long quiet value between the bursts of a trailer that the layout of
		// a single recording did not separate is no gap)
		const to = continuous ? f.end : Math.min(f.coreEnd, f.progEnd);
		const p = s.points;
		for (let i = 0; i < p.length; i++) {
			const next = i + 1 < p.length ? p[i + 1].ts : s.to;
			const a = Math.max(p[i].ts, f.start);
			const b = Math.min(next, to);
			if (b <= a) {
				continue;
			}
			const limit = suspectLimitOf(ctx.bands, p[i].val);
			if (limit !== null && (next - p[i].ts) / 1000 > limit) {
				x.reasons.push({
					code: "gap",
					detail: `suspect${continuous ? ` segment at ${p[i].ts}` : ""}: ${fmt(p[i].val)} held for ${fmt((next - p[i].ts) / 1000)} s (limit ${fmt(limit)} s)`,
				});
				if (!continuous) {
					break;
				}
			}
		}
	}
	// stuck: at least 20 reports with the same value, longer than the suspect limit, in a varying band
	const reports = ctx.bands !== null ? reportsOf(s, ctx) : null;
	if (reports !== null && ctx.bands !== null) {
		let k = 0;
		while (k < reports.length) {
			const v = heldAt(s, reports[k]);
			let j = k;
			while (j + 1 < reports.length && heldAt(s, reports[j + 1]) === v) {
				j++;
			}
			const band = v === null ? null : bandOf(ctx.bands, v);
			const limit = v === null ? null : suspectLimitOf(ctx.bands, v);
			const idx = band ? ctx.bands.bands.indexOf(band) : -1;
			if (
				v !== null &&
				band !== null &&
				limit !== null &&
				j - k + 1 >= STUCK_MIN_REPORTS &&
				(reports[j] - reports[k]) / 1000 > limit &&
				(cv[idx] ?? 0) > STUCK_MIN_CV &&
				reports[j] >= f.start &&
				reports[k] <= (continuous ? f.end : f.coreEnd)
			) {
				x.reasons.push({
					code: "stuck",
					detail: `${continuous ? `segment at ${reports[k]}: ` : ""}${j - k + 1} reports of ${fmt(v)} over ${fmt((reports[j] - reports[k]) / 1000)} s`,
				});
				if (!continuous) {
					break;
				}
			}
			k = j + 1;
		}
	}
	if (s.src === "history" && ctx.settings !== null) {
		const st = ctx.settings;
		if (st.ignoreZero) {
			x.reasons.push({ code: "historyCfg", detail: "ignoreZero: zero values are not stored" });
		}
		const debounce = Math.max(st.debounceMs, st.blockTimeMs);
		if (debounce > ctx.pollMs) {
			x.reasons.push({ code: "historyCfg", detail: `debounce ${debounce} ms > poll ${ctx.pollMs} ms` });
		}
		if (
			st.round !== null &&
			f.restLevel !== null &&
			f.restLevel > 0 &&
			10 ** -st.round > ROUND_SHARE * f.restLevel
		) {
			x.reasons.push({ code: "historyCfg", detail: `round ${st.round} digits, rest level ${fmt(f.restLevel)}` });
		}
	}
	if (f.invalidShare > INVALID_SHARE) {
		x.reasons.push({ code: "invalid", detail: `${fmt(100 * f.invalidShare)} % invalid values` });
	}
	if (f.timeJumps > 0) {
		x.reasons.push({ code: "timeJump", detail: `${f.timeJumps} jumps back in time` });
	}
}

/**
 * Sparse runs: p90 of the intervals between the stored values above 4 × the median p90 of the other
 * runs.
 *
 * @param runs - Runs
 */
function checkSparse(runs: Work[]): void {
	const p90 = runs.map(x => {
		const d = intervalsIn(x.s, x.s.facts.start, x.s.facts.coreEnd);
		return x.s.fromTicks || d.length === 0 ? null : quantile(d, 0.9);
	});
	runs.forEach((x, k) => {
		const own = p90[k];
		const others = p90.filter((v, j): v is number => j !== k && v !== null);
		if (own === null || others.length < 2) {
			return;
		}
		const ref = median(others);
		if (own > SPARSE_FACTOR * ref) {
			x.reasons.push({
				code: "sparse",
				detail: `p90 of the intervals ${fmt(own / 1000)} s, others ${fmt(ref / 1000)} s`,
			});
		}
	});
}

/**
 * Spikes: a single value above 3 × p99.9 of the runs.
 *
 * @param w - Samples
 */
function checkSpikes(w: Work[]): void {
	const pairs: [number, number][] = [];
	for (const x of w) {
		if (x.s.kind === "run") {
			pairs.push(...heldPairs(x.s, x.s.facts.start, Math.max(x.s.facts.runEnd, x.s.facts.end) + 1));
		}
	}
	const top = weightedQuantile(pairs, TOP_Q);
	if (!(top > 0)) {
		return;
	}
	const limit = SPIKE_FACTOR * top;
	for (const x of w) {
		const p = x.s.points;
		const i = p.findIndex(
			(q, k) => q.val > limit && !(k > 0 && p[k - 1].val > limit) && !(k + 1 < p.length && p[k + 1].val > limit),
		);
		if (i >= 0) {
			x.reasons.push({ code: "spike", detail: `${fmt(p[i].val)} > ${fmt(limit)}` });
		}
	}
}

/**
 * Bands of the typical sequence: touched by at least half of the clean runs; null when the clean
 * runs themselves touch only one band (feature 3 of `test` does not apply).
 *
 * @param clean - Clean runs
 * @param bands - Base bands
 */
function commonBandsOf(clean: Work[], bands: BaseBands): Set<number> | null {
	const touched = clean.map(x => new Set(bandSegmentsOf(x.s, bands, x.s.facts.coreEnd).map(b => b.band)));
	if (touched.length === 0 || median(touched.map(t => t.size)) <= 1) {
		return null;
	}
	const common = new Set<number>();
	bands.bands.forEach((_, k) => {
		if (touched.filter(t => t.has(k)).length >= COMMON_SHARE * touched.length) {
			common.add(k);
		}
	});
	return common;
}

/**
 * Form findings (quarantine): foreign load and manual tests.
 *
 * @param w - Samples
 * @param clean - Runs without data findings
 * @param ctx - Context
 */
function checkForm(w: Work[], clean: Work[], ctx: QualityContext): void {
	const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
	const minW = FOREIGN_MIN_W / factor;
	const levelRef = (pick: (f: SampleFacts) => number | null, self: Work): number | null => {
		const v = clean
			.filter(x => x !== self)
			.map(x => pick(x.s.facts))
			.filter((l): l is number => l !== null);
		return v.length >= 3 ? median(v) + Math.max(minW, FOREIGN_SPREAD * madn(v)) : null;
	};
	const tops = new Map<Work, number>();
	for (const x of clean) {
		tops.set(x, weightedQuantile(heldPairs(x.s, x.s.facts.start, x.s.facts.runEnd + 1), TOP_Q));
	}
	const spikes = w.filter(x => x.s.kind === "spike");
	const common = ctx.bands !== null && ctx.bands.bands.length > 0 ? commonBandsOf(clean, ctx.bands) : null;
	for (const x of w) {
		const f = x.s.facts;
		if (x.s.kind === "spike") {
			// a short activity that alone would decide the start values
			const second = Math.max(0, ...spikes.filter(y => y !== x).map(y => y.s.facts.coreSec));
			if (f.coreSec > TEST_SPIKE_RATIO * second) {
				x.reasons.push({
					code: "test",
					detail: `short activity of ${fmt(f.coreSec)} s, next longest ${fmt(second)} s`,
				});
			}
			continue;
		}
		if (x.s.kind !== "run" || x.s.info === null) {
			continue;
		}
		// foreign (1): the level before or after the run is raised
		const pre = levelRef(g => g.preLevel, x);
		const post = levelRef(g => g.postLevel, x);
		if (pre !== null && f.preLevel !== null && f.preLevel > pre) {
			x.reasons.push({ code: "foreign", detail: `level before the run ${fmt(f.preLevel)} > ${fmt(pre)}` });
		} else if (post !== null && f.postLevel !== null && f.postLevel > post) {
			x.reasons.push({ code: "foreign", detail: `level after the run ${fmt(f.postLevel)} > ${fmt(post)}` });
		} else {
			// foreign (2): values far above the highest band of the other runs for more than 5 % of the run
			const others = clean
				.filter(y => y !== x)
				.map(y => tops.get(y) ?? Number.NaN)
				.filter(t => t > 0);
			if (others.length >= 3) {
				const limit = FOREIGN_TOP_FACTOR * median(others);
				const pairs = heldPairs(x.s, f.start, f.runEnd + 1);
				const total = pairs.reduce((a, p) => a + p[1], 0);
				const above = pairs.filter(p => p[0] > limit).reduce((a, p) => a + p[1], 0);
				if (total > 0 && above > FOREIGN_TOP_SHARE * total) {
					x.reasons.push({
						code: "foreign",
						detail: `${fmt((100 * above) / total)} % of the run above ${fmt(limit)}`,
					});
				}
			}
		}
		// test (2): shorter than 10 min
		if (f.coreSec * 1000 < TEST_RUN_MS) {
			x.reasons.push({ code: "test", detail: `run of ${fmt(f.coreSec)} s` });
		} else if (common !== null && ctx.bands !== null) {
			// test (3): no typical band sequence
			const own = new Set(bandSegmentsOf(x.s, ctx.bands, f.coreEnd).map(b => b.band));
			if (own.size <= 1 || ![...own].some(b => common.has(b))) {
				x.reasons.push({
					code: "test",
					detail: `touches ${own.size} band(s), none or one of the typical sequence`,
				});
			}
		}
	}
}

/**
 * Programme groups of the clean runs (Spec B.3: only runs without quarantine form groups; ids stay
 * those of the samples where possible).
 *
 * @param clean - Clean runs
 */
function groupsOf(clean: Work[]): Map<Work, number> {
	const feats = clean.map(x => x.s.facts.feat as StoredFeatures);
	const next = Math.max(-1, ...clean.map(x => x.s.family)) + 1;
	const { families } = assignFamilies(
		feats,
		clean.map(x => x.s.family),
		next,
		GROUP_DISTANCE,
	);
	return new Map(clean.map((x, k) => [x, families[k]]));
}

/**
 * Number of sustained blocks of a run at the level of its end block (Spec B.2 `merged`: two end
 * blocks). With bands the block lies in the band of the end block, without within a factor of 2.
 *
 * @param f - Facts
 * @param bands - Base bands or null
 */
function endLikeBlocks(f: SampleFacts, bands: BaseBands | null): number {
	const end = f.endBlocks.at(-1);
	if (!end) {
		return 0;
	}
	const endBand = bands ? bandOf(bands, end.level) : null;
	return f.endBlocks.filter(b =>
		endBand !== null && bands !== null
			? bandOf(bands, b.level) === endBand
			: b.level >= end.level / END_LEVEL_RATIO && b.level <= end.level * END_LEVEL_RATIO,
	).length;
}

/**
 * Limited findings (cut trailer, aborted, grown together) and rare programmes.
 *
 * @param runs - Runs (with `info`)
 * @param clean - Runs without quarantine
 * @param ctx - Context
 */
function checkShape(runs: Work[], clean: Work[], ctx: QualityContext): void {
	const groups = groupsOf(clean);
	const groupOf = (x: Work): Work[] => {
		const g = groups.get(x);
		return g === undefined ? [] : clean.filter(y => y !== x && groups.get(y) === g);
	};
	for (const x of runs) {
		const f = x.s.facts;
		const feat = f.feat as StoredFeatures;
		const others = clean.filter(y => y !== x);
		// cut trailer: only for devices with a trailer in at least 2 clean runs
		const trailers = others.map(y => (y.s.facts.feat as StoredFeatures).trailerSec);
		if (trailers.filter(t => t > 0).length >= TRAILER_MIN_RUNS) {
			const med = median(trailers);
			const offs = others.map(y => y.s.facts.offSec).filter((o): o is number => o !== null);
			const offMed = offs.length >= TRAILER_MIN_RUNS ? median(offs) : null;
			const offLimit =
				offMed === null ? null : offMed - Math.max(TRAILER_EARLY_MIN_SEC, TRAILER_EARLY_MAD * madn(offs));
			if (feat.trailerSec < TRAILER_SHARE * med) {
				x.reasons.push({
					code: "trailerCut",
					detail: `trailer ${fmt(feat.trailerSec)} s, median ${fmt(med)} s`,
				});
			} else if (offLimit !== null && f.offSec !== null && f.offSec < offLimit) {
				x.reasons.push({
					code: "trailerCut",
					detail: `switched off ${fmt(f.offSec)} s after the end, others ${fmt(offMed!)} s`,
				});
			}
		}
		if (!groups.has(x)) {
			continue;
		}
		const group = groupOf(x);
		const ref = group.length > 0 ? group : others;
		// aborted (history): abrupt end without end block and trailer, shorter than p10 of its group
		if (x.s.src === "history" && ref.length >= RARE_GROUP_MIN && f.offSec !== null) {
			const blocks = ref.map(y => y.s.facts.endBlocks.at(-1)).filter(b => b !== undefined);
			const endMs = blocks.length > 0 ? median(blocks.map(b => b.to - b.from)) : 0;
			const own = f.endBlocks.at(-1);
			const noEndBlock = !own || own.to - own.from < ABORT_END_BLOCK_SHARE * endMs;
			const trailerElsewhere =
				ref.filter(y => (y.s.facts.feat as StoredFeatures).trailerSec > 0).length >= TRAILER_MIN_RUNS;
			const abrupt = f.offSec - feat.trailerSec <= ABORT_OFF_SEC + ctx.pollMs / 1000 && feat.trailerSec === 0;
			if (
				abrupt &&
				noEndBlock &&
				trailerElsewhere &&
				f.coreSec <
					quantile(
						ref.map(y => y.s.facts.coreSec),
						ABORT_Q,
					)
			) {
				x.reasons.push({ code: "aborted", detail: `ends abruptly after ${fmt(f.coreSec)} s` });
			}
		}
		// grown together: much longer than its group (all runs for a group of its own) and two end blocks
		const longest = Math.max(0, ...ref.map(y => y.s.facts.coreSec));
		const merged = ref.length > 0 && f.coreSec > MERGED_FACTOR * longest && endLikeBlocks(f, ctx.bands) >= 2;
		if (merged) {
			x.reasons.push({
				code: "merged",
				detail: `${fmt(f.coreSec)} s, longest of its group ${fmt(longest)} s, two end blocks`,
			});
			continue;
		}
		const dur = (y: Work): number => y.s.facts.coreSec;
		const energy = (y: Work): number => (y.s.facts.feat as StoredFeatures).energyWh;
		const block = (y: Work): number => Math.max(0, ...y.s.facts.endBlocks.map(b => b.to - b.from));
		const lg = (v: number): number => Math.log(Math.max(1e-3, v));
		// rare: the only run of its group (and no other run of about the same duration, energy and longest
		// block: the
		// z-normalised groups also split runs that differ only in small features), far off within its
		// group, or far off from all runs
		const twin = others.some(y =>
			[dur, energy, block].every(pick => Math.abs(lg(pick(y)) - lg(pick(x))) <= RARE_TWIN),
		);
		if (group.length === 0 && !twin) {
			x.reasons.push({ code: "rare", detail: "only run of its programme group" });
			continue;
		}
		const logs = (ys: Work[], pick: (g: Work) => number): number[] =>
			ys.map(y => Math.log(Math.max(1e-3, pick(y))));
		const zOf = (pick: (g: Work) => number): number => {
			const v = logs(group, pick);
			return (Math.log(Math.max(1e-3, pick(x))) - median(v)) / Math.max(RARE_SPREAD_MIN, madn(v));
		};
		// far off from every other run: below half the smallest or above twice the largest value
		const far = (pick: (g: Work) => number): boolean => {
			const v = others.map(pick);
			const own = pick(x);
			return own < Math.min(...v) / RARE_FAR || own > Math.max(...v) * RARE_FAR;
		};
		if (group.length >= RARE_Z_MIN && Math.max(Math.abs(zOf(dur)), Math.abs(zOf(energy))) > RARE_Z) {
			x.reasons.push({ code: "rare", detail: "duration or energy far off within its group" });
		} else if (others.length >= RARE_GROUP_MIN && (far(dur) || far(energy) || far(block))) {
			x.reasons.push({ code: "rare", detail: "duration, energy or longest block far off from all runs" });
		}
	}
}

/**
 * Check every run (Spec B.2): findings, stage and uses, in the order of `runs`. The stages are computed
 * again at every evaluation (the comparison statistics change); `user` is set by the caller.
 *
 * @param runs - Samples (`runSamples`, `daySamples`, run store)
 * @param ctx - Context
 */
export function checkRuns(runs: readonly RunSample[], ctx: QualityContext): Verdict[] {
	const w: Work[] = runs.map(s => ({ s, reasons: [] }));
	checkGlobal(w, ctx);
	// report intervals of all live samples
	const intervals: number[] = [];
	for (const x of w) {
		const r = x.s.reports;
		if (r && r.length >= 2) {
			for (let i = 1; i < r.length; i++) {
				intervals.push(r[i] - r[i - 1]);
			}
		}
	}
	const reportP999 = intervals.length > 0 ? quantile(intervals, TOP_Q) : 0;
	// variation of the stored values per band (stuck needs a band that otherwise varies)
	const cv: number[] = [];
	if (ctx.bands !== null) {
		const per = ctx.bands.bands.map(() => ({ n: 0, sum: 0, sq: 0 }));
		for (const x of w) {
			for (const p of x.s.points) {
				const b = bandOf(ctx.bands, p.val);
				if (b) {
					const acc = per[ctx.bands.bands.indexOf(b)];
					acc.n++;
					acc.sum += p.val;
					acc.sq += p.val * p.val;
				}
			}
		}
		per.forEach((a, k) => {
			const mean = a.n > 0 ? a.sum / a.n : 0;
			cv[k] = mean > 0 ? Math.sqrt(Math.max(0, a.sq / a.n - mean * mean)) / mean : 0;
		});
	}
	for (const x of w) {
		checkData(x, ctx, reportP999, cv);
	}
	checkSpikes(w);
	if (ctx.scope === "run") {
		const runs = w.filter(x => x.s.kind === "run" && x.s.info !== null && x.s.facts.feat !== null);
		checkSparse(runs);
		checkForm(
			w,
			runs.filter(x => !excluded(x.reasons)),
			ctx,
		);
		if (runs.some(x => x.s.aborted)) {
			runs.filter(x => x.s.aborted).forEach(x => x.reasons.push({ code: "aborted", detail: "aborted (live)" }));
		}
		checkShape(
			runs,
			runs.filter(x => !excluded(x.reasons)),
			ctx,
		);
		const old = ctx.oldStore;
		if (old) {
			for (const x of runs) {
				const f = x.s.facts;
				if (
					x.s.src === "history" &&
					f.start >= old.from &&
					f.start <= old.to &&
					!old.keys.some(k => sameRun(k, x.s.key))
				) {
					x.reasons.push({ code: "formerlyDropped", detail: "not in the old store of this time" });
				}
			}
		}
	}
	return w.map(x => ({ key: x.s.key, stage: stageOf(x.reasons), reasons: x.reasons, uses: usesOf(x.reasons) }));
}
