import { TRAILER_MAX_DEFAULT_SEC } from "../detector/trailer.js";
import type { DetectionSettings } from "../detector/types.js";
import type { Change, DetectionKey, OptimizeInfo, StoredRun, StoreFile } from "../runStore.js";
import { DETECTION_KEYS, detectionOf, pushChange, refreshInfo } from "../runStore.js";
import type { HistorySuggestion } from "./analyze.js";
import { analyzeTicks } from "./analyze.js";
import { margin, minEndSec } from "./optimize.js";
import { runOkFull, simulate } from "./replay.js";
import type { SimResult } from "./replay.js";
import type { Window } from "./runs.js";
import { MAX_PAUSE_MS } from "./runs.js";
import type { TickCell, TickSeries } from "./ticks.js";
import { decodeCells, fromCells, scaled } from "./ticks.js";

/** Tightening needs this many trusted runs. */
export const TIGHTEN_MIN_RUNS = 4;
/** Tightening needs this many new trusted runs since the last change. */
export const TIGHTEN_NEW_RUNS = 2;
/** Minimum time between two tightenings. */
export const TIGHTEN_SPACING_MS = 24 * 60 * 60_000;
/** Lock after a repair, undo or reset: runs and time. */
export const LOCK_RUNS = 5;
/** Lock after a repair, undo or reset: time. */
export const LOCK_MS = 14 * 24 * 60 * 60_000;
/** Largest drop of a numeric field per tightening. */
export const MAX_DROP = 0.25;
/** Largest change of a threshold per tightening. */
export const MAX_THRESHOLD_CHANGE = 0.3;
/** Trusted runs in a row that fail before the optimisation pauses. */
export const DRIFT_RUNS = 3;
/** A change of the mode needs this many trusted runs. */
const MODE_CHANGE_RUNS = 6;
/** Turning the anti-crease filter on by tightening needs this many trusted runs with a trailer. */
const FILTER_RUNS = 2;
/** Separator between two stored runs when they are analysed together. */
const SEPARATOR_MS = MAX_PAUSE_MS + 10 * 60_000;
/** Yield at least this often. */
const YIELD_MS = 20;

/** Changes of the input data used to check a candidate for robustness. */
export type Perturbation = "none" | "scale09" | "scale11" | "shift1" | "stale5";

/** Context of one optimisation job. */
export interface OptimizeContext {
	/** Device type (unit of the state). */
	type: DetectionSettings;
	/** Poll interval in s. */
	pollSec: number;
	/** Abort detection of the device. */
	abort: boolean;
	/** Corrected abort detection of the device. */
	abortFixed: boolean;
	/** Lets other work run. */
	yieldFn: () => Promise<void>;
	/** Current time in ms. */
	now: number;
	/** Time budget of the job in ms. */
	budgetMs: number;
	/** Clock for the budget. */
	clock: () => number;
}

/** Result of the gate for one set of values. */
export interface GateResult {
	/** Every run and every false start is handled correctly. */
	ok: boolean;
	/** Per stored run: detected correctly, delay from the programme end in s (NaN if not). */
	perRun: { ok: boolean; delaySec: number }[];
	/** No false start starts a run. */
	spikesOk: boolean;
	/** Starts in the false start windows. */
	falseStarts: number;
}

/** Result of an optimisation job. */
export interface OptimizeOutcome {
	/** What happened. */
	kind: "none" | "repair" | "tighten" | "cannotCover" | "drift" | "budget";
	/** New override (only for repair and tighten). */
	override: Partial<DetectionSettings> | null;
	/** Change that was recorded, or null. */
	change: Change | null;
	/** Status after the job. */
	info: OptimizeInfo;
}

class BudgetExceeded extends Error {}

/**
 * Hard bounds of optimised values.
 *
 * @param pollSec - Poll interval in s
 */
export function boundsOf(pollSec: number): Partial<Record<DetectionKey, number>> {
	return {
		endDurationSec: 3600,
		endCount: Math.floor(3600 / pollSec),
		pauseHoldSec: 10800,
		startCount: 60,
		startDurationSec: 600,
		trailerMaxSec: 14400,
		trailerBurstSec: 180,
	};
}

/**
 * Effective values: type with the override.
 *
 * @param type - Device type
 * @param override - Override or null
 */
export function effectiveOf(type: DetectionSettings, override: Partial<DetectionSettings> | null): DetectionSettings {
	return detectionOf({ ...detectionOf(type), ...(override ?? {}) });
}

/**
 * Override of the values: the fields that differ from the type.
 *
 * @param p - Values
 * @param type - Device type
 */
export function diffOf(p: DetectionSettings, type: DetectionSettings): Partial<DetectionSettings> | null {
	const a = detectionOf(p);
	const b = detectionOf(type);
	const out: Record<string, unknown> = {};
	for (const k of DETECTION_KEYS) {
		if (a[k] !== b[k]) {
			out[k] = a[k];
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * Whether the values are within the hard bounds and keep standby < endVal < startVal.
 *
 * @param p - Values
 * @param pollSec - Poll interval in s
 */
export function withinBounds(p: DetectionSettings, pollSec: number): boolean {
	const d = detectionOf(p);
	const b = boundsOf(pollSec);
	for (const [k, max] of Object.entries(b) as [DetectionKey, number][]) {
		if (typeof d[k] === "number" && d[k] > max) {
			return false;
		}
	}
	if (DETECTION_KEYS.some(k => typeof d[k] === "number" && (!Number.isFinite(d[k]) || d[k] < 0))) {
		return false;
	}
	return d.standby < d.endVal && d.endVal < d.startVal && d.startCount >= 1 && d.endCount >= 1;
}

/**
 * Values clamped to the hard bounds.
 *
 * @param p - Values
 * @param pollSec - Poll interval in s
 */
export function clampBounds(p: DetectionSettings, pollSec: number): DetectionSettings {
	const d = detectionOf(p) as unknown as Record<string, number | string>;
	for (const [k, max] of Object.entries(boundsOf(pollSec))) {
		if (typeof d[k] === "number") {
			d[k] = Math.min(max, d[k]);
		}
	}
	return d as unknown as DetectionSettings;
}

/** Decoded series of the stored runs of one job. */
class Data {
	private readonly cells = new WeakMap<StoredRun, TickCell[]>();
	private readonly series = new WeakMap<StoredRun, Map<Perturbation, TickSeries>>();
	private lastYield: number;
	private readonly start: number;

	public constructor(
		public readonly store: StoreFile,
		public readonly ctx: OptimizeContext,
	) {
		this.start = ctx.clock();
		this.lastYield = this.start;
	}

	public cellsOf(r: StoredRun): TickCell[] {
		let c = this.cells.get(r);
		if (!c) {
			c = decodeCells(r.data, r.q);
			this.cells.set(r, c);
		}
		return c;
	}

	/**
	 * Series of a run in the unit of the state, perturbed.
	 *
	 * @param r - Stored run
	 * @param p - Perturbation
	 */
	public seriesOf(r: StoredRun, p: Perturbation): TickSeries {
		let byP = this.series.get(r);
		if (!byP) {
			byP = new Map();
			this.series.set(r, byP);
		}
		let s = byP.get(p);
		if (s) {
			return s;
		}
		let cells = this.cellsOf(r);
		if (p === "shift1") {
			cells = [cells[0], ...cells];
		} else if (p === "stale5") {
			cells = cells.map((c, i) => (i > 0 && i % 20 === 0 ? cells[i - 1] : c));
		}
		s = fromCells(cells, r.ts, r.step);
		if (p === "scale09" || p === "scale11") {
			s = scaled(s, p === "scale09" ? 0.9 : 1.1);
		}
		byP.set(p, s);
		return s;
	}

	public async tick(): Promise<void> {
		const now = this.ctx.clock();
		if (now - this.start > this.ctx.budgetMs) {
			throw new BudgetExceeded("budget");
		}
		if (now - this.lastYield >= YIELD_MS) {
			this.lastYield = now;
			await this.ctx.yieldFn();
		}
	}

	/**
	 * All stored runs and false starts as one series in W (separated by a quiet stretch), for the analysis.
	 *
	 * @param keep - Which runs to take
	 */
	public combined(keep: (r: StoredRun) => boolean): TickSeries {
		const items = [...this.store.runs.filter(keep), ...this.store.spikes].sort((a, b) => a.ts - b.ts);
		const all: TickCell[] = [];
		const sep = Math.ceil(SEPARATOR_MS / this.store.step);
		for (const r of items) {
			const cells = this.cellsOf(r);
			all.push(...cells);
			const vals = cells.filter(c => c.valid).map(c => c.last);
			vals.sort((a, b) => a - b);
			const idle = vals.length > 0 ? vals[Math.floor(vals.length * 0.2)] : 0;
			for (let k = 0; k < sep; k++) {
				all.push({ min: idle, max: idle, last: idle, valid: true });
			}
		}
		return fromCells(all, 0, this.store.step, this.store.unitFactor);
	}
}

/**
 * Replay the values over every stored run and false start.
 *
 * @param data - Decoded data
 * @param p - Values (unit of the state)
 * @param perturb - Perturbation of the input
 * @param only - Only these runs (default: all)
 */
async function gateOn(
	data: Data,
	p: DetectionSettings,
	perturb: Perturbation,
	only?: (r: StoredRun) => boolean,
): Promise<GateResult> {
	const { store, ctx } = data;
	const opts = { abort: ctx.abort, abortFixed: ctx.abortFixed, pollSec: ctx.pollSec };
	const shift = perturb === "shift1" ? 1 : 0;
	const perRun: GateResult["perRun"] = [];
	let ok = true;
	for (const r of store.runs) {
		if (only && !only(r)) {
			continue;
		}
		const s = data.seriesOf(r, perturb);
		const win: Window = {
			fromIdx: 0,
			toIdx: s.length - 1,
			runStartIdx: r.seg.startIdx + shift,
			runEndIdx: r.seg.runEndIdx + shift,
			run: 0,
		};
		const res = simulate(s, win, p, opts);
		const good = r.postTruncated ? truncatedOk(s, win, res) : runOkFull(s, win, res);
		const delaySec =
			good && res.finished.length > 0
				? (res.finished[0] - (s.t0 + (win.runEndIdx as number) * s.stepMs)) / 1000
				: Number.NaN;
		perRun.push({ ok: good, delaySec });
		ok &&= good;
		await data.tick();
	}
	let falseStarts = 0;
	for (const r of only ? [] : store.spikes) {
		const s = data.seriesOf(r, perturb);
		const win: Window = {
			fromIdx: 0,
			toIdx: s.length - 1,
			runStartIdx: r.seg.startIdx,
			runEndIdx: null,
			run: null,
		};
		falseStarts += simulate(s, win, p, opts).started;
		await data.tick();
	}
	return { ok: ok && falseStarts === 0, perRun, spikesOk: falseStarts === 0, falseStarts };
}

/**
 * A run whose time after the end is cut short: one start, no abort, no end before the run end.
 *
 * @param s - Series
 * @param win - Window
 * @param r - Result
 */
function truncatedOk(s: TickSeries, win: Window, r: SimResult): boolean {
	const end = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
	return r.started === 1 && r.aborted === 0 && r.finished.length <= 1 && r.finished.every(t => t >= end);
}

/**
 * Replay values over the stored runs and false starts of a store (gate of every change).
 *
 * @param store - Store
 * @param p - Values (unit of the state)
 * @param ctx - Context
 * @param perturb - Perturbation of the input
 */
export async function gate(
	store: StoreFile,
	p: DetectionSettings,
	ctx: OptimizeContext,
	perturb: Perturbation = "none",
): Promise<GateResult> {
	return gateOn(new Data(store, ctx), p, perturb);
}

/**
 * Settings from a learning suggestion.
 *
 * @param sg - Suggestion
 */
function fromSuggestion(sg: HistorySuggestion): DetectionSettings {
	return detectionOf({
		...sg.thresholds,
		mode: sg.mode,
		startDurationSec: sg.startDurationSec,
		endDurationSec: sg.endDurationSec,
		pauseHoldSec: sg.pauseHoldSec,
		pauseUntilSec: sg.pauseUntilSec,
		pauseBelowVal: sg.pauseBelowVal,
		trailerBurstSec: sg.trailerBurstSec ?? 0,
		trailerGapSec: sg.trailerGapSec ?? 0,
		trailerAfterSec: sg.trailerAfterSec ?? 0,
		trailerBlockVal: sg.trailerBlockVal ?? 0,
		trailerMaxSec: sg.trailerMaxSec ?? 0,
	});
}

/**
 * Analyse stored runs with the learning core.
 *
 * @param data - Decoded data
 * @param p0 - Current values
 * @param keep - Which runs to take
 */
async function analyzeStored(
	data: Data,
	p0: DetectionSettings,
	keep: (r: StoredRun) => boolean,
): Promise<HistorySuggestion | null> {
	const { store, ctx } = data;
	if (!store.runs.some(keep)) {
		return null;
	}
	const res = await analyzeTicks(data.combined(keep), ctx.pollSec, {
		abort: ctx.abort,
		abortFixed: ctx.abortFixed,
		unitFactor: store.unitFactor,
		currentType: p0,
		minRuns: 1,
		yieldFn: () => data.tick(),
	});
	return "error" in res ? null : res;
}

/**
 * Distance of values from the current values (sum of relative changes).
 *
 * @param p - Values
 * @param p0 - Current values
 */
function distance(p: DetectionSettings, p0: DetectionSettings): number {
	const a = detectionOf(p) as unknown as Record<string, number | string>;
	const b = detectionOf(p0) as unknown as Record<string, number | string>;
	const filterA = (a.trailerBurstSec as number) > 0;
	const filterB = (b.trailerBurstSec as number) > 0;
	let d = filterA !== filterB ? 1 : 0;
	for (const k of DETECTION_KEYS) {
		if (k.startsWith("trailer") && (!filterA || !filterB)) {
			continue;
		}
		const x = a[k];
		const y = b[k];
		if (typeof x === "number" && typeof y === "number") {
			d += Math.abs(x - y) / Math.max(Math.abs(y), 1);
		} else if (x !== y) {
			d += 1;
		}
	}
	return d;
}

/** End delay in s that weighs as much as one relative change of a value when choosing a repair. */
const REPAIR_DELAY_WEIGHT_SEC = 600;

/**
 * Anti-crease filter settings from the stored runs with a trailer.
 *
 * @param runs - Stored runs
 * @param pollSec - Poll interval in s
 */
export function trailerFromStore(runs: readonly StoredRun[], pollSec: number): Partial<DetectionSettings> | null {
	const t = runs.filter(r => r.feat.trailer);
	if (t.length === 0) {
		return null;
	}
	const burstMax = Math.max(...t.map(r => r.feat.burstMaxSec));
	const gapMin = Math.min(...t.map(r => r.feat.trailerGapMinSec || 60));
	const longest = Math.max(...t.map(r => r.feat.trailerSec));
	return {
		trailerBurstSec: Math.min(
			180,
			Math.max(Math.ceil(Math.max(15, 1.5 * pollSec + 10)), Math.ceil(burstMax * 1.5)),
		),
		trailerGapSec: Math.max(1, Math.min(Math.floor(0.8 * gapMin), Math.max(3 * pollSec, 30))),
		trailerAfterSec: 0,
		trailerBlockVal: 0,
		trailerMaxSec: Math.min(14400, Math.max(TRAILER_MAX_DEFAULT_SEC, Math.ceil(longest * 1.25 + 900))),
	};
}

/**
 * Per field the safer of two value sets: longer waits, higher start threshold, the end threshold of
 * the first.
 *
 * @param c - Candidate
 * @param p0 - Current values
 */
function saferOf(c: DetectionSettings, p0: DetectionSettings): DetectionSettings {
	const a = detectionOf(c);
	const b = detectionOf(p0);
	return {
		...a,
		startVal: Math.max(a.startVal, b.startVal),
		startCount: Math.max(a.startCount, b.startCount),
		endCount: Math.max(a.endCount, b.endCount),
		startDurationSec: Math.max(a.startDurationSec, b.startDurationSec),
		endDurationSec: Math.max(a.endDurationSec, b.endDurationSec),
		pauseHoldSec: Math.max(a.pauseHoldSec ?? 0, b.pauseHoldSec ?? 0),
		trailerGapSec: Math.max(a.trailerGapSec ?? 0, b.trailerGapSec ?? 0),
	};
}

/**
 * Candidates of a repair: the analysis of all stored runs and targeted loosenings of the current values.
 *
 * @param data - Decoded data
 * @param p0 - Current values
 */
async function repairCandidates(data: Data, p0: DetectionSettings): Promise<DetectionSettings[]> {
	const { store, ctx } = data;
	const poll = ctx.pollSec;
	const out: DetectionSettings[] = [];
	const sg = await analyzeStored(data, p0, () => true);
	if (sg) {
		// only merged with the current values: the plain analysis may wait much shorter than now and
		// a repair has seen too few runs for that (a tightening has its own step limits and checks)
		out.push(saferOf(fromSuggestion(sg), p0));
	}
	const base = detectionOf(p0);
	const env = store.envelope;
	const burst = env.maxBurstSec + margin(env.maxBurstSec, poll);
	const startK = Math.ceil(burst / poll);
	const startRaised: DetectionSettings = {
		...base,
		startCount: Math.max(base.startCount, startK),
		startDurationSec: Math.max(base.startDurationSec, Math.ceil(burst)),
	};
	const trailer = trailerFromStore(store.runs, poll);
	const variants: DetectionSettings[] = [base, startRaised];
	if (trailer && !(base.trailerBurstSec ?? 0)) {
		variants.push({ ...base, ...trailer }, { ...startRaised, ...trailer });
	}
	if (trailer) {
		// the filter armed only after a terminal block or some time after the start: a programme with
		// soaking keeps its drum movements and needs no long end wait
		for (const v of filterVariants(store.runs, store, poll).slice(1)) {
			variants.push({ ...base, ...v }, { ...startRaised, ...v });
		}
	}
	if ((base.trailerBurstSec ?? 0) > 0) {
		if (trailer) {
			// the filter as it is, widened to the longest bursts and anti-crease phases seen
			variants.push({
				...base,
				trailerBurstSec: Math.max(base.trailerBurstSec ?? 0, trailer.trailerBurstSec ?? 0),
				trailerGapSec: Math.min(base.trailerGapSec || 30, trailer.trailerGapSec || 30),
				trailerMaxSec: Math.max(base.trailerMaxSec ?? 0, trailer.trailerMaxSec ?? 0),
			});
		}
		variants.push({ ...base, trailerAfterSec: 0, trailerBlockVal: 0, trailerBurstSec: 0 });
	}
	const minRunUnit = env.minRunW / store.unitFactor;
	if (minRunUnit > 0) {
		const sv = Math.max(base.endVal * 1.2, 0.25 * minRunUnit);
		if (sv < base.startVal) {
			variants.push({ ...base, startVal: Math.round(sv * 100) / 100 });
		}
	}
	for (const v of variants) {
		for (const f of [1, 1.5, 2, 3, 4, 6]) {
			out.push({
				...v,
				endCount: Math.ceil(v.endCount * f),
				endDurationSec: Math.ceil(v.endDurationSec * f),
			});
		}
	}
	return out
		.map(c => clampBounds(c, poll))
		.filter(c => withinBounds(c, poll))
		.filter(c => (c.trailerBurstSec ?? 0) === 0 || (c.trailerBurstSec ?? 0) >= 15);
}

/**
 * Step limit of a tightening: numeric fields drop by at most 25 % (thresholds change by at most
 * 30 %), counts and durations are rounded up to whole polls; mode changes and turning the filter on
 * need enough runs.
 *
 * @param c - Candidate
 * @param p0 - Current values
 * @param trusted - Trusted runs
 * @param withTrailer - Trusted runs with a trailer
 * @param pollSec - Poll interval in s
 */
export function stepLimit(
	c: DetectionSettings,
	p0: DetectionSettings,
	trusted: number,
	withTrailer: number,
	pollSec: number,
): DetectionSettings {
	const a = detectionOf(c) as unknown as Record<string, number | string>;
	const b = detectionOf(p0) as unknown as Record<string, number | string>;
	const out: Record<string, number | string> = { ...a };
	const thresholds = new Set(["startVal", "endVal", "standby"]);
	const durations = new Set(["startDurationSec", "endDurationSec", "pauseHoldSec", "trailerMaxSec"]);
	for (const k of DETECTION_KEYS) {
		const x = a[k];
		const y = b[k];
		if (typeof x !== "number" || typeof y !== "number") {
			continue;
		}
		if (thresholds.has(k)) {
			out[k] = Math.min(y * (1 + MAX_THRESHOLD_CHANGE), Math.max(y * (1 - MAX_THRESHOLD_CHANGE), x));
			out[k] = Math.round(out[k] * 1e5) / 1e5;
			continue;
		}
		if (y > 0 && x < y * (1 - MAX_DROP)) {
			out[k] = y * (1 - MAX_DROP);
		}
		if (k === "startCount" || k === "endCount") {
			out[k] = Math.ceil(out[k] as number);
		} else if (durations.has(k)) {
			out[k] = Math.ceil((out[k] as number) / pollSec) * pollSec;
		}
	}
	if (a.mode !== b.mode && trusted < MODE_CHANGE_RUNS) {
		out.mode = b.mode;
	}
	const filterOn = (b.trailerBurstSec as number) <= 0 && (a.trailerBurstSec as number) > 0;
	if (filterOn && withTrailer < FILTER_RUNS) {
		for (const k of ["trailerBurstSec", "trailerGapSec", "trailerAfterSec", "trailerBlockVal", "trailerMaxSec"]) {
			out[k] = b[k];
		}
	}
	return out as unknown as DetectionSettings;
}

/**
 * Envelope floors: the end waits at least for the longest pause ever seen (unless the pause
 * protection holds it), the start for the longest burst (unless the anti-crease filter is on).
 *
 * @param c - Candidate
 * @param store - Store
 * @param pollSec - Poll interval in s
 */
export function applyFloors(c: DetectionSettings, store: StoreFile, pollSec: number): DetectionSettings {
	const d = detectionOf(c);
	const env = store.envelope;
	const pauseFloor = Math.max(minEndSec(pollSec), env.maxPauseSec * 1.25 + 2 * pollSec);
	const guardHolds =
		(d.pauseHoldSec ?? 0) >= env.maxPauseSec * 1.25 && ((d.pauseUntilSec ?? 0) > 0 || (d.pauseBelowVal ?? 0) > 0);
	if (!guardHolds && env.maxPauseSec > 0) {
		if (d.mode === "timed") {
			d.endDurationSec = Math.max(d.endDurationSec, Math.ceil(pauseFloor));
		} else {
			d.endCount = Math.max(d.endCount, Math.ceil(pauseFloor / pollSec));
			if (d.mode === "combined") {
				d.endDurationSec = Math.max(d.endDurationSec, Math.ceil(pauseFloor));
			}
		}
	}
	if ((d.trailerBurstSec ?? 0) <= 0 && env.maxBurstSec > 0) {
		const startFloor = env.maxBurstSec + margin(env.maxBurstSec, pollSec);
		if (d.mode !== "timed") {
			d.startCount = Math.max(d.startCount, Math.ceil(startFloor / pollSec));
		}
		if (d.mode !== "count") {
			d.startDurationSec = Math.max(d.startDurationSec, Math.ceil(startFloor));
		}
	}
	return d;
}

function mean(values: readonly number[]): number {
	const v = values.filter(x => Number.isFinite(x));
	return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

/**
 * Short text of the changed fields.
 *
 * @param from - Values before
 * @param to - Values after
 */
export function describeChange(from: DetectionSettings, to: DetectionSettings): string {
	const a = detectionOf(from) as unknown as Record<string, number | string>;
	const b = detectionOf(to) as unknown as Record<string, number | string>;
	const parts: string[] = [];
	for (const k of DETECTION_KEYS) {
		if (a[k] !== b[k]) {
			if (k === "trailerBurstSec" && (a[k] === 0 || b[k] === 0)) {
				parts.push(b[k] === 0 ? "anti-crease filter off" : "anti-crease filter on");
			} else if (
				!k.startsWith("trailer") ||
				((a.trailerBurstSec as number) > 0 && (b.trailerBurstSec as number) > 0)
			) {
				parts.push(`${k} ${a[k]} → ${b[k]}`);
			}
		}
	}
	return parts.join(", ");
}

/**
 * Earliest time of the next tightening.
 *
 * @param store - Store
 */
function nextPossible(store: StoreFile): number {
	return Math.max(store.lockUntilTs, store.lastChangeTs > 0 ? store.lastChangeTs + TIGHTEN_SPACING_MS : 0);
}

/**
 * Check the current values against every stored run and false start and improve them: a repair
 * (looser values) as soon as a run is not detected correctly, a tightening (end reported earlier)
 * only after enough runs, with step limits, a cross-check, perturbed input and envelope floors.
 * Nothing changes if no candidate passes the gate. The store is updated in place.
 *
 * @param store - Store
 * @param ctx - Context
 */
export async function optimize(store: StoreFile, ctx: OptimizeContext): Promise<OptimizeOutcome> {
	const info = store.info;
	info.lastCheckTs = ctx.now;
	refreshInfo(store);
	const done = (kind: OptimizeOutcome["kind"], change: Change | null = null): OptimizeOutcome => {
		info.nextPossibleTs = nextPossible(store);
		const eff = effectiveOf(ctx.type, store.override);
		if ((eff.trailerBurstSec ?? 0) > 0) {
			info.trailer = "used";
		} else if (info.trailer === "used") {
			info.trailer = "none";
		}
		return { kind, override: store.override, change, info };
	};
	if (info.status === "drift") {
		return done("drift");
	}
	if (store.runs.length === 0 && store.spikes.length === 0) {
		info.status = "collecting";
		return done("none");
	}
	const data = new Data(store, ctx);
	const p0 = effectiveOf(ctx.type, store.override);
	try {
		const r0 = await gateOn(data, p0, "none");
		if (!r0.ok) {
			return await repair(data, p0, r0, done);
		}
		store.failStreak = 0;
		const outcome = await tighten(data, p0, r0, done);
		return outcome;
	} catch (err) {
		if (err instanceof BudgetExceeded) {
			info.status = "budget";
			return done("budget");
		}
		throw err;
	}
}

type Done = (kind: OptimizeOutcome["kind"], change?: Change | null) => OptimizeOutcome;

/**
 * The repair candidate closest to the current values that passes the gate.
 *
 * @param data - Decoded data
 * @param p0 - Current values
 * @param candidates - Candidates
 * @param seen - Candidates already checked (shared between calls)
 */
async function bestRepair(
	data: Data,
	p0: DetectionSettings,
	candidates: readonly DetectionSettings[],
	seen: Set<string>,
): Promise<{ p: DetectionSettings; d: number; g: GateResult } | null> {
	let best: { p: DetectionSettings; d: number; g: GateResult } | null = null;
	for (const c of candidates) {
		const key = JSON.stringify(detectionOf(c));
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		// closest to the current values; a late end (after the anti-crease phase) counts as a change too
		const d = distance(c, p0);
		if (best && d >= best.d) {
			continue;
		}
		const g = await gateOn(data, c, "none");
		const score = d + mean(g.perRun.map(r => r.delaySec)) / REPAIR_DELAY_WEIGHT_SEC;
		if (g.ok && (!best || score < best.d)) {
			best = { p: c, d: score, g };
		}
	}
	return best;
}

async function repair(data: Data, p0: DetectionSettings, r0: GateResult, done: Done): Promise<OptimizeOutcome> {
	const { store, ctx } = data;
	const raw = await repairCandidates(data, p0);
	// first with the envelope floors (start not shorter than the longest burst seen, end not shorter
	// than the longest pause seen), only if none of those passes without them
	const floored = raw
		.map(c => clampBounds(applyFloors(c, store, ctx.pollSec), ctx.pollSec))
		.filter(c => withinBounds(c, ctx.pollSec));
	const seen = new Set<string>();
	let best = await bestRepair(data, p0, floored, seen);
	best ??= await bestRepair(data, p0, raw, seen);
	if (!best) {
		store.failStreak++;
		store.info.status = store.failStreak >= DRIFT_RUNS ? "drift" : "cannotCover";
		return done(store.failStreak >= DRIFT_RUNS ? "drift" : "cannotCover");
	}
	const before = store.override;
	store.override = diffOf(best.p, ctx.type);
	const change: Change = {
		ts: ctx.now,
		kind: "repair",
		from: before,
		to: store.override,
		reason: describeChange(p0, best.p),
		runs: store.runs.length + store.spikes.length,
		gainSec: Math.round(mean(r0.perRun.map(r => r.delaySec)) - mean(best.g.perRun.map(r => r.delaySec))),
	};
	pushChange(store, change);
	store.lockRuns = LOCK_RUNS;
	store.lockUntilTs = ctx.now + LOCK_MS;
	store.lastChangeTs = ctx.now;
	store.newSinceChange = 0;
	store.failStreak = 0;
	store.info.status = "locked";
	return done("repair", change);
}

/**
 * Anti-crease filter variants derived from runs: plain, only after a terminal block of at least 80 %
 * of the lowest seen, only some time after the start, and both.
 *
 * @param runs - Runs (trusted)
 * @param store - Store (unit factor)
 * @param pollSec - Poll interval in s
 */
function filterVariants(runs: readonly StoredRun[], store: StoreFile, pollSec: number): Partial<DetectionSettings>[] {
	const t = trailerFromStore(runs, pollSec);
	if (!t) {
		return [];
	}
	const withTrailer = runs.filter(r => r.feat.trailer);
	const block =
		Math.round(((0.8 * Math.min(...withTrailer.map(r => r.feat.blockMean))) / store.unitFactor) * 1e5) / 1e5;
	const after = Math.floor(0.9 * Math.min(...runs.map(r => r.feat.coreSec)));
	const out: Partial<DetectionSettings>[] = [t];
	if (block > 0) {
		out.push({ ...t, trailerBlockVal: block });
	}
	if (after > 0) {
		out.push({ ...t, trailerAfterSec: Math.min(21600, after) });
	}
	if (block > 0 && after > 0) {
		out.push({ ...t, trailerBlockVal: block, trailerAfterSec: Math.min(21600, after) });
	}
	return out;
}

/**
 * Anti-crease filter options of a tightening: the filter of the current values when it is on,
 * otherwise the variants derived from the runs that arm only after a terminal block (only with
 * enough runs with a trailer).
 *
 * @param runs - Trusted runs
 * @param store - Store
 * @param p0 - Current values
 * @param withTrailer - Trusted runs with a trailer
 * @param pollSec - Poll interval in s
 */
function filterOptions(
	runs: readonly StoredRun[],
	store: StoreFile,
	p0: DetectionSettings,
	withTrailer: number,
	pollSec: number,
): Partial<DetectionSettings>[] {
	const d = detectionOf(p0);
	if ((d.trailerBurstSec ?? 0) > 0) {
		return [
			{
				trailerBurstSec: d.trailerBurstSec,
				trailerGapSec: d.trailerGapSec,
				trailerAfterSec: d.trailerAfterSec,
				trailerBlockVal: d.trailerBlockVal,
				trailerMaxSec: d.trailerMaxSec,
			},
		];
	}
	if (withTrailer < FILTER_RUNS) {
		return [];
	}
	// a tightening turns the filter on only behind a terminal block like the ones seen: a programme
	// not seen yet with a soaking phase (drum movements after washing) would otherwise lose its soak
	// to the filter and end early; the plain filter is left to learning and repair
	return filterVariants(runs, store, pollSec).filter(v => (v.trailerBlockVal ?? 0) > 0);
}

/**
 * Whether a candidate switches the anti-crease filter on without the terminal block guard (a
 * tightening must not: see `filterOptions`).
 *
 * @param c - Candidate
 * @param p0 - Current values
 */
function unguardedFilterOn(c: DetectionSettings, p0: DetectionSettings): boolean {
	return (p0.trailerBurstSec ?? 0) <= 0 && (c.trailerBurstSec ?? 0) > 0 && (c.trailerBlockVal ?? 0) <= 0;
}

/** How a tightening candidate is built (repeated without one programme group for the cross-check). */
interface Recipe {
	/** Start from the current values or from the analysis. */
	base: "current" | "analysis";
	/** Index of the anti-crease filter variant, or -1 (as derived). */
	filter: number;
}

async function tighten(data: Data, p0: DetectionSettings, r0: GateResult, done: Done): Promise<OptimizeOutcome> {
	const { store, ctx } = data;
	const poll = ctx.pollSec;
	const isTrusted = (r: StoredRun): boolean => r.label === "run" && !r.postTruncated;
	const trusted = store.runs.filter(isTrusted);
	const locked = store.lockRuns > 0 || ctx.now < store.lockUntilTs;
	if (locked) {
		store.info.status = "locked";
		return done("none");
	}
	store.info.status = trusted.length >= TIGHTEN_MIN_RUNS ? "ok" : "collecting";
	if (
		trusted.length < TIGHTEN_MIN_RUNS ||
		store.newSinceChange < TIGHTEN_NEW_RUNS ||
		(store.lastChangeTs > 0 && ctx.now - store.lastChangeTs < TIGHTEN_SPACING_MS)
	) {
		return done("none");
	}
	const sg = await analyzeStored(data, p0, isTrusted);
	if (!sg) {
		return done("none");
	}
	store.info.trailer = sg.trailer === "notSeparable" ? "notSeparable" : store.info.trailer;
	const withTrailer = trusted.filter(r => r.feat.trailer).length;
	const shape = (c: DetectionSettings): DetectionSettings =>
		clampBounds(applyFloors(stepLimit(c, p0, trusted.length, withTrailer, poll), store, poll), poll);
	const build = (
		recipe: Recipe,
		analysis: DetectionSettings,
		variants: Partial<DetectionSettings>[],
	): DetectionSettings => {
		const base = recipe.base === "current" ? detectionOf(p0) : analysis;
		return shape(recipe.filter >= 0 && variants[recipe.filter] ? { ...base, ...variants[recipe.filter] } : base);
	};
	const analysis = fromSuggestion(sg);
	const variants = filterOptions(trusted, store, p0, withTrailer, poll);
	const recipes: Recipe[] = [{ base: "analysis", filter: -1 }];
	variants.forEach((_, i) => {
		recipes.push({ base: "analysis", filter: i }, { base: "current", filter: i });
	});

	// candidates that pass the gate and are never worse on any run, fastest first
	const passing: { recipe: Recipe; c: DetectionSettings; g: GateResult; delay: number }[] = [];
	const seen = new Set<string>();
	for (const recipe of recipes) {
		const c = build(recipe, analysis, variants);
		const key = JSON.stringify(c);
		if (seen.has(key) || !withinBounds(c, poll) || unguardedFilterOn(c, p0)) {
			continue;
		}
		seen.add(key);
		const g = await gateOn(data, c, "none");
		if (!g.ok || g.falseStarts > r0.falseStarts) {
			continue;
		}
		if (g.perRun.some((r, i) => r.delaySec > r0.perRun[i].delaySec + poll)) {
			continue;
		}
		passing.push({ recipe, c, g, delay: mean(g.perRun.map(r => r.delaySec)) });
	}
	passing.sort((a, b) => a.delay - b.delay);
	const families = [...new Set(trusted.map(r => r.family))];
	const d0 = mean(r0.perRun.map(r => r.delaySec));
	for (const cand of passing) {
		const gain = d0 - cand.delay;
		const fewerFalse = cand.g.falseStarts < r0.falseStarts;
		if (!fewerFalse && gain < Math.max(60, 0.1 * d0)) {
			break;
		}
		if (!(await crossCheck(data, p0, cand.recipe, families, sg, isTrusted, build))) {
			continue;
		}
		let robust = true;
		for (const p of ["scale09", "scale11", "shift1", "stale5"] as const) {
			if (!(await gateOn(data, cand.c, p)).ok) {
				robust = false;
				break;
			}
		}
		if (!robust) {
			continue;
		}
		const next = diffOf(cand.c, ctx.type);
		if (JSON.stringify(next) === JSON.stringify(store.override)) {
			return done("none");
		}
		const before = store.override;
		store.override = next;
		const change: Change = {
			ts: ctx.now,
			kind: "tighten",
			from: before,
			to: next,
			reason: describeChange(p0, cand.c),
			runs: store.runs.length + store.spikes.length,
			gainSec: Math.round(gain),
		};
		pushChange(store, change);
		store.lastChangeTs = ctx.now;
		store.newSinceChange = 0;
		store.info.status = "ok";
		return done("tighten", change);
	}
	return done("none");
}

/**
 * Cross-check of a candidate: with at least three programme groups the same recipe derived without
 * a group must detect that group; otherwise the leave-one-out result of the analysis must be complete.
 *
 * @param data - Decoded data
 * @param p0 - Current values
 * @param recipe - How the candidate was built
 * @param families - Programme groups of the trusted runs
 * @param sg - Analysis of all trusted runs
 * @param isTrusted - Which runs are trusted
 * @param build - Builds a candidate from a recipe
 */
async function crossCheck(
	data: Data,
	p0: DetectionSettings,
	recipe: Recipe,
	families: readonly number[],
	sg: HistorySuggestion,
	isTrusted: (r: StoredRun) => boolean,
	build: (recipe: Recipe, analysis: DetectionSettings, variants: Partial<DetectionSettings>[]) => DetectionSettings,
): Promise<boolean> {
	const { store, ctx } = data;
	if (families.length < 3) {
		return recipe.base === "current" || sg.looDetected === undefined || sg.looDetected >= sg.runs;
	}
	for (const fam of families) {
		const keep = (r: StoredRun): boolean => isTrusted(r) && r.family !== fam;
		const rest = store.runs.filter(keep);
		const sgF = recipe.base === "analysis" ? await analyzeStored(data, p0, keep) : null;
		if (recipe.base === "analysis" && !sgF) {
			continue;
		}
		const variants =
			recipe.filter >= 0
				? filterOptions(rest, store, p0, rest.filter(r => r.feat.trailer).length, ctx.pollSec)
				: [];
		const cF = build(recipe, sgF ? fromSuggestion(sgF) : detectionOf(p0), variants);
		const gF = await gateOn(data, cF, "none", r => isTrusted(r) && r.family === fam);
		if (!gF.ok) {
			return false;
		}
	}
	return true;
}
