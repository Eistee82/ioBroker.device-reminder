import { finalViolations } from "../config.js";
import { finalOn } from "../detector/index.js";
import { TRAILER_MAX_DEFAULT_SEC } from "../detector/trailer.js";
import { FINAL_KEYS } from "../detector/types.js";
import type { DetectionSettings, FinalSettings } from "../detector/types.js";
import type { PhaseModel } from "../phases/model.js";
import { applyPhaseTune, phaseTuneBase, tunePhases } from "../phases/learn.js";
import { phaseHolds } from "../phases/tracker.js";
import type { BaseKey, Change, JobStep, JobUnit, OptimizeInfo, StoredRun, StoreFile } from "../runStore.js";
import {
	BASE_KEYS,
	boundaryRuns,
	decisionOf,
	DETECTION_KEYS,
	detectionOf,
	inUse,
	markFinalResumed,
	markFinalSuspended,
	pushChange,
	refreshInfo,
	REPLAY_PICK_MAX,
	storeSamples,
	typeHash,
	WINDOW_MS,
} from "../runStore.js";
import type { HistorySuggestion } from "./analyze.js";
import { analyzeTicks } from "./analyze.js";
import type { FinalCandidate } from "./finalLearn.js";
import { learnFinal } from "./finalLearn.js";
import { margin, minEndSec } from "./optimize.js";
import type { QualityContext, Verdict } from "./quality.js";
import { admitted, primaryOf, sameRun } from "./quality.js";
import { endOkFull, simulate } from "./replay.js";
import type { SimResult } from "./replay.js";
import type { Window } from "./runs.js";
import { DENSE_MIN_MS, MAX_PAUSE_MS } from "./runs.js";
import type { TickCell, TickSeries } from "./ticks.js";
import { decodeCells, fromCells, scaled } from "./ticks.js";

/**
 * Tightening needs this many admitted runs in the 30-day window (Spec D.3 point 4, decision 4; a repair needs none).
 */
export const TIGHTEN_MIN_RUNS = 8;
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
/** Yield at least this often (active computing time) … */
const YIELD_MS = 20;
/** … and at least every this many ticks. */
const YIELD_TICKS = 256;
/**
 * Expensive steps of a job in turn (Spec D.3 budget): switch the final phase on or tune it, tighten the base values,
 * fine-tune the phases. A step interrupted by the budget goes on in the next job where it stopped.
 */
export const JOB_STEPS: readonly JobStep[] = ["final", "tighten", "phases"];
/** A cross-check (release of the final phase, phase fine tuning) runs at most once in this time … */
export const CROSS_CHECK_SPACING_MS = 24 * 60 * 60_000;
/** Most keys of runs that got a hint and are remembered (`StoreFile.hinted`). */
const HINTED_MAX = 50;
/** Findings of a data error (Spec B.3): the hint says the recording is disturbed, without asking to use the run. */
const DATA_ERRORS = new Set(["gap", "stuck", "sparse", "incomplete", "unit", "counter"]);

/**
 * The optimisation switches the final phase on by itself only with this many admitted runs in the 30-day window
 * (Spec D.5, decision 4; also the fewest runs `learnFinal` must cover when it tunes the final phase).
 */
export const FINAL_ENABLE_MIN_RUNS = 10;
/** … and this many runs per programme group (Spec D.5, decision 4). */
export const FINAL_ENABLE_MIN_PER_GROUP = 2;
/** Largest change of the lower limit of the final band (P) per step. */
const FINAL_P_STEP = 0.1;
/** Largest drop of the time in the final band (Y) per step … */
const FINAL_Y_DROP = 0.1;
/** … which needs this many covered runs (otherwise Y does not drop). */
const FINAL_Y_DROP_RUNS = 5;
/** Largest drop of the earliest start of the final block (X) per step. */
const FINAL_X_DROP = 0.25;
/** Factors of the final phase repair: time in the final band (Y) higher, earliest start (X) later, P narrower. */
const FINAL_REPAIR_Y = [1, 1.25, 1.5, 2, 3, 4];
const FINAL_REPAIR_X = [1, 1.25, 1.5, 2];
const FINAL_REPAIR_P = [1, 1.1, 1.25, 1.5];

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
	/**
	 * Time budget of the job in ms: active computing time (the sum of the stretches between two yields, Spec D.3);
	 * the cheap part of a job (gate, repair, suspending) always runs, the expensive steps stop when it is used up.
	 */
	budgetMs: number;
	/** Clock for the budget (ms; only the time between two yields counts). */
	clock: () => number;
	/** Phase model of the device (fine tuning, Spec D.6), if phases are on. */
	phases?: PhaseModel;
	/**
	 * Verdicts of the run check by key (`recompute`). Without them every stored run counts as admitted (only the
	 * decisions of the user count).
	 */
	verdicts?: ReadonlyMap<string, Verdict>;
	/** The final phase is suspended: runs are replayed with `finalMinVal = 0` (the values in use at runtime). */
	finalSuspended?: boolean;
	/**
	 * Context of the run check of the stored runs: needed to learn the final phase (switching it on, tuning it);
	 * without it the final phase is only repaired.
	 */
	quality?: QualityContext;
}

/** What the optimisation did with the final phase (Spec D.5), in order. */
export interface FinalEvent {
	/**
	 * `suspended`: an admitted run was reported too early in the replay; `repaired`: new values of the final phase
	 * after a suspension; `resumed`: used again (`reason` `repair` or `endOk`); `on`: switched on; `tuned`: adjusted;
	 * `stays`: still suspended (`reason` `noRepair`: no values detect every admitted run, `notStored`: the split run
	 * is not stored yet).
	 */
	kind: "suspended" | "repaired" | "resumed" | "on" | "tuned" | "stays";
	/** Reason. */
	reason?: string;
	/** Key of the run that caused it. */
	key?: string;
	/** Change that was recorded. */
	change?: Change;
}

/** A run in quarantine that the values in use do not detect correctly (Spec B.3 hint). */
export interface Hint {
	/** Key of the run. */
	key: string;
	/** `use`: a reason that can be a real programme (choose "use" in the dialog); `broken`: a data error. */
	kind: "use" | "broken";
	/** Start of the run in ms. */
	ts: number;
}

/** Result of the gate for one set of values. */
export interface GateResult {
	/** Every run and every false start is handled correctly. */
	ok: boolean;
	/**
	 * Per replayed run (the admitted runs of the replay pick with cells, in their order): id, key, detected
	 * correctly, delay from the programme end in s (NaN if not).
	 */
	perRun: { id: string; key: string; ok: boolean; delaySec: number }[];
	/** No false start starts a run. */
	spikesOk: boolean;
	/** Starts in the false start windows. */
	falseStarts: number;
	/** Keys of the false starts that start a run. */
	spikeKeys: string[];
	/**
	 * Runs judged `finalSplit`, replayed with their early part as one run (only with a final phase): ok when the
	 * final phase reports no end before the values without it and starts no run more.
	 */
	joined: { key: string; ok: boolean }[];
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
	/** Keys of the admitted runs the values in use did not detect correctly (`needsRepair`). */
	failing: string[];
	/** Keys of the runs that stopped a candidate or caused the repair: they become boundary runs (`veto`). */
	vetoes: string[];
	/** Keys of the runs whose older veto the new values pass: the veto ends. */
	vetoClear: string[];
	/** New hints about runs in quarantine (each run once). */
	hints: Hint[];
	/** What happened with the final phase (in this order). */
	final: FinalEvent[];
	/** What the phase fine tuning did: `tuned` (new limits in use), `newPattern` (a new phase found, once). */
	phases: ("tuned" | "newPattern")[];
	/** The expensive steps were stopped by the time budget (`info.budget` counts these jobs in a row). */
	interrupted: boolean;
	/** Active computing time of the job in ms. */
	activeMs: number;
}

class BudgetExceeded extends Error {}

/**
 * Hard bounds of optimised values.
 *
 * @param pollSec - Poll interval in s
 */
export function boundsOf(pollSec: number): Partial<Record<BaseKey, number>> {
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
	for (const [k, max] of Object.entries(b) as [BaseKey, number][]) {
		if (typeof d[k] === "number" && d[k] > max) {
			return false;
		}
	}
	if (BASE_KEYS.some(k => typeof d[k] === "number" && (!Number.isFinite(d[k]) || d[k] < 0))) {
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

/** How a stored run takes part in the optimisation. */
type Role = "gate" | "quarantine" | "none";

/**
 * Verdict of a stored run with the current decision of the user, or undefined without verdicts.
 *
 * @param store - Store
 * @param r - Run
 * @param verdicts - Verdicts by key
 */
function verdictOf(store: StoreFile, r: StoredRun, verdicts?: ReadonlyMap<string, Verdict>): Verdict | undefined {
	const v = verdicts?.get(r.key);
	if (!v) {
		return undefined;
	}
	const user = decisionOf(store, r.key)?.user;
	const out: Verdict = { ...v };
	if (user) {
		out.user = user;
	} else {
		delete out.user;
	}
	return out;
}

/**
 * Role of a stored run (Spec B.3, D.3): `gate` for a run admitted for the end (a false start: for the start),
 * `quarantine` for a run in quarantine (only "no regression"), `none` for excluded and unusable runs. Without a
 * verdict a run is admitted unless the user excluded it.
 *
 * @param store - Store
 * @param r - Run
 * @param verdicts - Verdicts by key
 */
function roleOf(store: StoreFile, r: StoredRun, verdicts?: ReadonlyMap<string, Verdict>): Role {
	if (decisionOf(store, r.key)?.user === "exclude") {
		return "none";
	}
	const v = verdictOf(store, r, verdicts);
	if (!v) {
		return "gate";
	}
	if (admitted(v, r.label === "spike" ? "start" : "end")) {
		return "gate";
	}
	return v.stage === "quarantine" ? "quarantine" : "none";
}

/**
 * Target set (Spec D.2): the admitted runs of the last 30 days (gain, ideal values, minimum counts).
 *
 * @param store - Store
 * @param now - Current time
 * @param verdicts - Verdicts by key (without: only the decisions of the user count)
 */
export function targetSet(store: StoreFile, now: number, verdicts?: ReadonlyMap<string, Verdict>): StoredRun[] {
	return store.runs.filter(r => roleOf(store, r, verdicts) === "gate" && now - r.ts <= WINDOW_MS);
}

/**
 * Check set (Spec D.2): the target set and every admitted boundary run of any age (gate and floors; no target of a
 * tightening).
 *
 * @param store - Store
 * @param now - Current time
 * @param verdicts - Verdicts by key (without: only the decisions of the user count)
 */
export function checkSet(store: StoreFile, now: number, verdicts?: ReadonlyMap<string, Verdict>): StoredRun[] {
	const boundary = boundaryRuns(store, verdicts);
	return store.runs.filter(
		r => roleOf(store, r, verdicts) === "gate" && (now - r.ts <= WINDOW_MS || boundary.has(r.key)),
	);
}

/**
 * Balanced pick of the check set for the replay (Spec B.4 point 3): every boundary run, then per programme group
 * the newest runs in turn, at most REPLAY_PICK_MAX runs with cells; the admitted false starts (at most MAX_SPIKES)
 * come on top. Used by the gate, `needsRepair` and the tightening; statistics and the run check use every run.
 *
 * @param store - Store
 * @param now - Current time
 * @param verdicts - Verdicts by key (without: only the decisions of the user count)
 * @returns runs and false starts in the order of the store
 */
export function replayPick(store: StoreFile, now: number, verdicts?: ReadonlyMap<string, Verdict>): StoredRun[] {
	const boundary = boundaryRuns(store, verdicts);
	const set = checkSet(store, now, verdicts).filter(r => typeof r.data === "string");
	const picked = new Set(set.filter(r => boundary.has(r.key)));
	const groups = new Map<number, StoredRun[]>();
	for (const r of [...set].sort((a, b) => b.ts - a.ts)) {
		if (!picked.has(r)) {
			groups.set(r.family, [...(groups.get(r.family) ?? []), r]);
		}
	}
	let added = true;
	while (added && picked.size < REPLAY_PICK_MAX) {
		added = false;
		for (const list of groups.values()) {
			const r = list.shift();
			if (r && picked.size < REPLAY_PICK_MAX) {
				picked.add(r);
				added = true;
			}
		}
	}
	const spikes = store.spikes.filter(
		r =>
			typeof r.data === "string" &&
			roleOf(store, r, verdicts) === "gate" &&
			(now - r.ts <= WINDOW_MS || boundary.has(r.key)),
	);
	return [...set.filter(r => picked.has(r)), ...spikes];
}

/**
 * Whether a candidate is never worse than the current values on the runs in quarantine (Spec D.3: "kein
 * Rückschritt"): every run the current values detect correctly is detected correctly by the candidate too.
 *
 * @param c - Result per key of the candidate
 * @param p0 - Result per key of the current values
 */
export function noRegression(c: ReadonlyMap<string, boolean>, p0: ReadonlyMap<string, boolean>): boolean {
	return [...p0].every(([key, ok]) => !ok || c.get(key) === true);
}

/** Decoded series of the stored runs of one job. */
class Data {
	private readonly cells = new WeakMap<StoredRun, TickCell[]>();
	private readonly series = new WeakMap<StoredRun, Map<Perturbation, TickSeries>>();
	/** Active computing time until the last yield (ms). */
	private activeBefore = 0;
	/** Clock after the last yield. */
	private resumedAt: number;
	private ticks = 0;
	/** Expensive part of the job: the budget applies. */
	public budgeted = false;
	/** Units of expensive steps finished in this job (the first one always finishes, so every job makes progress). */
	private finished = 0;
	/** Results of the finished units of the expensive step in progress (`StoreFile.job.memo`). */
	public memo: JobUnit[] = [];
	private pos = 0;
	/** A unit result of the step in progress comes from an earlier job (checked again before it is taken over). */
	public reused = false;
	/** Admitted runs of the replay pick with cells (gate). */
	public readonly runs: StoredRun[];
	/** Admitted false starts with cells. */
	public readonly spikes: StoredRun[];
	/** Runs and false starts in quarantine with cells (only "no regression"). */
	public readonly quarantined: StoredRun[];
	/** Target set (admitted runs of the last 30 days, also without cells). */
	public readonly target: StoredRun[];
	/** Keys of the runs grown together from two runs (only the end of the whole run is checked). */
	public readonly merged: Set<string>;
	/** The final phase is suspended: replayed with `finalMinVal = 0` (set during a job that suspends it). */
	public suspended: boolean;
	/** Stored runs judged `finalSplit` with their early part (`FinalState.joined`, both parts with cells). */
	public readonly joined: { key: string; a: StoredRun; b: StoredRun }[];
	private readonly joinedSeries = new Map<string, { s: TickSeries; win: Window }>();

	public constructor(
		public readonly store: StoreFile,
		public readonly ctx: OptimizeContext,
	) {
		this.resumedAt = ctx.clock();
		const pick = replayPick(store, ctx.now, ctx.verdicts).filter(r => inUse(store, r));
		this.runs = pick.filter(r => r.label !== "spike");
		this.spikes = pick.filter(r => r.label === "spike");
		this.quarantined = [...store.runs, ...store.spikes].filter(
			r => inUse(store, r) && roleOf(store, r, ctx.verdicts) === "quarantine",
		);
		this.target = targetSet(store, ctx.now, ctx.verdicts);
		this.merged = new Set(
			store.runs
				.filter(r => ctx.verdicts?.get(r.key)?.reasons.some(x => x.code === "merged") === true)
				.map(r => r.key),
		);
		this.suspended = ctx.finalSuspended === true;
		this.joined = this.joinedRuns();
	}

	/**
	 * Values as the detector is built at runtime: with a suspended final phase `finalMinVal = 0`.
	 *
	 * @param p - Values
	 * @param raw - The values as they are (a final phase that would be used again)
	 */
	public replayValues(p: DetectionSettings, raw = false): DetectionSettings {
		return this.suspended && !raw ? { ...p, finalMinVal: 0 } : p;
	}

	/**
	 * Runs judged `finalSplit` that are stored with cells, each with the stored run that ends where it begins (its
	 * early part); runs excluded or unusable are left out.
	 */
	private joinedRuns(): { key: string; a: StoredRun; b: StoredRun }[] {
		const { store, ctx } = this;
		const out: { key: string; a: StoredRun; b: StoredRun }[] = [];
		const usable = (r: StoredRun): boolean =>
			typeof r.data === "string" && inUse(store, r) && roleOf(store, r, ctx.verdicts) !== "none";
		for (const key of store.final?.joined ?? []) {
			const b = store.runs.find(r => r.key === key || sameRun(r.key, key));
			if (!b || !usable(b) || out.some(x => x.b === b)) {
				continue;
			}
			const a = store.runs
				.filter(
					r =>
						r !== b &&
						r.step === b.step &&
						r.ts < b.ts &&
						usable(r) &&
						r.ts + this.cellsOf(r).length * r.step >= b.ts - r.step,
				)
				.sort((x, y) => y.ts - x.ts)[0];
			if (a) {
				out.push({ key: b.key, a, b });
			}
		}
		return out;
	}

	/**
	 * Series of a run judged `finalSplit` and its early part as one run (unit of the state) with its window.
	 *
	 * @param pair - Both parts
	 * @param pair.key - Key of the split run
	 * @param pair.a - Early part
	 * @param pair.b - Split run
	 */
	public joinedOf(pair: { key: string; a: StoredRun; b: StoredRun }): { s: TickSeries; win: Window } {
		let out = this.joinedSeries.get(pair.key);
		if (out) {
			return out;
		}
		const a = this.cellsOf(pair.a);
		const b = this.cellsOf(pair.b);
		const gap = Math.round((pair.b.ts - (pair.a.ts + a.length * pair.a.step)) / pair.a.step);
		const fill = gap > 0 ? new Array<TickCell>(gap).fill(a[a.length - 1]) : [];
		const cells = [...a, ...fill, ...(gap < 0 ? b.slice(-gap) : b)];
		const off = a.length + gap;
		const s = fromCells(cells, pair.a.ts, pair.a.step);
		const end = Math.min(cells.length - 1, off + pair.b.seg.runEndIdx);
		out = {
			s,
			win: { fromIdx: 0, toIdx: cells.length - 1, runStartIdx: pair.a.seg.startIdx, runEndIdx: end, run: 0 },
		};
		this.joinedSeries.set(pair.key, out);
		return out;
	}

	/**
	 * Verdict of a stored run with the current decision of the user.
	 *
	 * @param r - Run
	 */
	public verdictOf(r: StoredRun): Verdict | undefined {
		return verdictOf(this.store, r, this.ctx.verdicts);
	}

	/**
	 * Whether the next stored run starts where this one ends (two runs shortly one after the other, stored as parts of
	 * one capture): values that join both report the end of this one only with the next one, which is no error
	 * (decision 9).
	 *
	 * @param r - Run
	 */
	public continued(r: StoredRun): boolean {
		const end = r.ts + this.cellsOf(r).length * r.step;
		return this.store.runs.some(n => n !== r && n.ts > r.ts && n.ts <= end + r.step);
	}

	public cellsOf(r: StoredRun): TickCell[] {
		let c = this.cells.get(r);
		if (!c) {
			c = typeof r.data === "string" ? decodeCells(r.data, r.q) : [];
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

	/** Active computing time of the job so far (ms): the time spent in yields does not count. */
	public get activeMs(): number {
		return this.activeBefore + Math.max(0, this.ctx.clock() - this.resumedAt);
	}

	/**
	 * Whether the budget is used up in the expensive part (never before the first unit of the job is finished).
	 *
	 * @param run - Active time since the last yield (ms)
	 */
	private overBudget(run: number): boolean {
		return this.budgeted && this.finished > 0 && this.activeBefore + run > this.ctx.budgetMs;
	}

	public async tick(): Promise<void> {
		const run = Math.max(0, this.ctx.clock() - this.resumedAt);
		if (this.overBudget(run)) {
			throw new BudgetExceeded("budget");
		}
		this.ticks++;
		if (run >= YIELD_MS || this.ticks % YIELD_TICKS === 0) {
			this.activeBefore += run;
			await this.ctx.yieldFn();
			this.resumedAt = this.ctx.clock();
		}
	}

	/**
	 * Start an expensive step with the results of its units from an earlier job.
	 *
	 * @param memo - Results of the finished units (empty: from the beginning)
	 */
	public beginStep(memo: JobUnit[]): void {
		this.memo = memo;
		this.pos = 0;
		this.reused = false;
	}

	/**
	 * One unit of an expensive step: its result is kept in the progress of the job, so that a step stopped by the
	 * budget goes on in the next job where it stopped. A unit finished before (same key at the same place) is not
	 * computed again; a different key drops the results from there on. Results are kept as JSON.
	 *
	 * @param key - Key of the unit (what it computes)
	 * @param fn - Computation
	 */
	public async unit<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const m = this.memo[this.pos];
		if (m && m.k === key) {
			this.pos++;
			this.reused = true;
			return m.v as T;
		}
		this.memo = this.memo.slice(0, this.pos);
		if (this.overBudget(Math.max(0, this.ctx.clock() - this.resumedAt))) {
			throw new BudgetExceeded("budget");
		}
		const v = JSON.parse(JSON.stringify((await fn()) ?? null)) as T;
		this.memo = [...this.memo, { k: key, v }];
		this.pos++;
		this.finished++;
		return v;
	}

	/**
	 * All stored runs and false starts as one series in W (separated by a quiet stretch), for the analysis.
	 *
	 * @param keep - Which runs to take
	 */
	public combined(keep: (r: StoredRun) => boolean): TickSeries {
		const items = [...this.runs.filter(keep), ...this.spikes].sort((a, b) => a.ts - b.ts);
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
 * Window of a stored run (cell indices), shifted for the perturbation `shift1`.
 *
 * @param s - Series
 * @param r - Run
 * @param shift - Ticks to shift
 */
function windowOf(s: TickSeries, r: StoredRun, shift: number): Window {
	return {
		fromIdx: 0,
		toIdx: s.length - 1,
		runStartIdx: r.seg.startIdx + shift,
		runEndIdx: r.label === "spike" ? null : r.seg.runEndIdx + shift,
		run: r.label === "spike" ? null : 0,
	};
}

/**
 * Whether a stored run is detected correctly (Spec B.4 `endOk` with the programme end under the tail of the store;
 * a merged run only by the end of the whole run, decision 9).
 *
 * @param data - Decoded data
 * @param r - Run
 * @param s - Series
 * @param win - Window
 * @param res - Replay
 * @param shift - Ticks of the perturbation `shift1`
 */
function runGood(data: Data, r: StoredRun, s: TickSeries, win: Window, res: SimResult, shift: number): boolean {
	const progEnd =
		data.store.tail?.separated === true && typeof r.seg.progEndIdx === "number" ? r.seg.progEndIdx + shift : null;
	if (r.postTruncated) {
		return truncatedOk(s, win, res);
	}
	if (data.merged.has(r.key) ? mergedOk(s, win, res, progEnd) : endOkFull(s, win, res, progEnd)) {
		return true;
	}
	// followed by the next run right away: its end may come with the end of the next run (both as one, decision 9),
	// but never too early
	const runEnd = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
	return (
		data.continued(r) &&
		res.started === 1 &&
		res.aborted === 0 &&
		res.finished.every(f => f >= runEnd) &&
		res.startedAt.every(t => res.finished.every(f => t <= f))
	);
}

/**
 * Replay the values over the admitted runs of the replay pick and the admitted false starts (gate).
 *
 * @param data - Decoded data
 * @param p - Values (unit of the state)
 * @param perturb - Perturbation of the input
 * @param only - Only these runs (default: all)
 * @param raw - Replay the values as they are, also while the final phase is suspended
 */
async function gateOn(
	data: Data,
	p: DetectionSettings,
	perturb: Perturbation,
	only?: (r: StoredRun) => boolean,
	raw = false,
): Promise<GateResult> {
	const { ctx } = data;
	const opts = { abort: ctx.abort, abortFixed: ctx.abortFixed, pollSec: ctx.pollSec };
	const shift = perturb === "shift1" ? 1 : 0;
	const values = data.replayValues(p, raw);
	const perRun: GateResult["perRun"] = [];
	let ok = true;
	for (const r of data.runs) {
		if (only && !only(r)) {
			continue;
		}
		const s = data.seriesOf(r, perturb);
		const win = windowOf(s, r, shift);
		const res = simulate(s, win, values, opts);
		const good = runGood(data, r, s, win, res, shift);
		// a merged run: from the end of the whole run
		const fin = data.merged.has(r.key) ? res.finished.at(-1) : res.finished[0];
		const delaySec =
			good && fin !== undefined ? (fin - (s.t0 + (win.runEndIdx as number) * s.stepMs)) / 1000 : Number.NaN;
		perRun.push({ id: r.id, key: r.key, ok: good, delaySec });
		ok &&= good;
		await data.tick();
	}
	let falseStarts = 0;
	const spikeKeys: string[] = [];
	for (const r of only ? [] : data.spikes) {
		const s = data.seriesOf(r, perturb);
		const started = simulate(s, windowOf(s, r, 0), values, opts).started;
		falseStarts += started;
		if (started > 0) {
			spikeKeys.push(r.key);
		}
		await data.tick();
	}
	// the rest of a split programme with its early part as one run (Spec D.5): only the final phase can split it
	const joined: GateResult["joined"] = [];
	if (perturb === "none" && !only && finalOn(values)) {
		for (const pair of data.joined) {
			const { s, win } = data.joinedOf(pair);
			const good = joinedOk(
				simulate(s, win, values, opts),
				simulate(s, win, { ...values, finalMinVal: 0 }, opts),
				s.stepMs,
			);
			joined.push({ key: pair.key, ok: good });
			ok &&= good;
			await data.tick();
		}
	}
	return { ok: ok && falseStarts === 0, perRun, spikesOk: falseStarts === 0, falseStarts, spikeKeys, joined };
}

/**
 * A split programme replayed as one run (Spec D.5): the final phase reports no end before the values without it
 * (at most one poll) and starts no run more; its last end may come earlier, that is its gain.
 *
 * @param r - Replay with the final phase
 * @param off - Replay of the same values without it
 * @param stepMs - Poll interval in ms
 */
function joinedOk(r: SimResult, off: SimResult, stepMs: number): boolean {
	const first = off.finished[0];
	return (
		r.started <= off.started &&
		r.aborted <= off.aborted &&
		(first === undefined || (r.finished[0] ?? Number.POSITIVE_INFINITY) >= first - stepMs)
	);
}

/**
 * Replay the values over the runs and false starts in quarantine: detected correctly per key.
 *
 * @param data - Decoded data
 * @param p - Values (unit of the state)
 * @param raw - Replay the values as they are, also while the final phase is suspended
 */
async function quarantineOn(data: Data, p: DetectionSettings, raw = false): Promise<Map<string, boolean>> {
	const { ctx } = data;
	const opts = { abort: ctx.abort, abortFixed: ctx.abortFixed, pollSec: ctx.pollSec };
	const values = data.replayValues(p, raw);
	const out = new Map<string, boolean>();
	for (const r of data.quarantined) {
		const s = data.seriesOf(r, "none");
		const win = windowOf(s, r, 0);
		const res = simulate(s, win, values, opts);
		out.set(r.key, r.label === "spike" ? res.started === 0 : runGood(data, r, s, win, res, 0));
		await data.tick();
	}
	return out;
}

/**
 * Keys of the runs and false starts a gate result does not detect correctly.
 *
 * @param g - Gate result
 */
function failingOf(g: GateResult): string[] {
	return [
		...g.perRun.filter(r => !r.ok).map(r => r.key),
		...g.spikeKeys,
		...g.joined.filter(r => !r.ok).map(r => r.key),
	];
}

/**
 * Two real runs grown together (decision 9): only the end of the whole run counts. At least one start, no abort,
 * the last end not too early (`endOk` against the end of the whole run) and no start after it; an end and a start at
 * the rest inside are no split and no early end.
 *
 * @param s - Series
 * @param win - Window
 * @param r - Result
 * @param progEnd - Programme end (tick), or null
 */
function mergedOk(s: TickSeries, win: Window, r: SimResult, progEnd: number | null): boolean {
	const last = r.finished.at(-1);
	if (r.started === 0 || r.aborted !== 0 || last === undefined) {
		return false;
	}
	const runEnd = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
	const endGood =
		last >= runEnd || (progEnd !== null && last > s.t0 + progEnd * s.stepMs && runEnd - last <= DENSE_MIN_MS);
	return endGood && r.startedAt.every(t => t <= last);
}

/**
 * Keys of the admitted runs (`uses.end`) and false starts that the values in use do not detect correctly (Spec D.3
 * point 3, decision 8): start missed, end too early (`endOk` with the programme end and the tail of the store), run
 * split (two starts in a run that did not grow together), end not detected, a start after the end. Runs in
 * quarantine and unusable runs are never in the list; two real runs grown together are no error as long as the end
 * of the whole run is detected (decision 9).
 *
 * @param store - Store
 * @param ctx - Context (verdicts, suspended final phase)
 */
export async function needsRepair(store: StoreFile, ctx: OptimizeContext): Promise<string[]> {
	const data = new Data(store, ctx);
	return failingOf(await gateOn(data, effectiveOf(ctx.type, store.override), "none"));
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
 * Settings from a learning suggestion; the final phase stays as in the current values (the
 * analysis does not learn it).
 *
 * @param sg - Suggestion
 * @param p0 - Current values
 */
function fromSuggestion(sg: HistorySuggestion, p0: DetectionSettings): DetectionSettings {
	return detectionOf({
		...finalOf(p0),
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
 * The final phase fields of values (missing = 0).
 *
 * @param p - Values
 */
function finalOf(p: DetectionSettings): Partial<DetectionSettings> {
	return Object.fromEntries(FINAL_KEYS.map(k => [k, p[k] ?? 0]));
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
	if (!data.runs.some(keep)) {
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
	for (const k of BASE_KEYS) {
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
 * the first; the final phase of the current values.
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
		...finalOf(b),
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
		out.push(saferOf(fromSuggestion(sg, p0), p0));
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
	const trailer = trailerFromStore(data.runs, poll);
	const variants: DetectionSettings[] = [base, startRaised];
	if (trailer && !(base.trailerBurstSec ?? 0)) {
		variants.push({ ...base, ...trailer }, { ...startRaised, ...trailer });
	}
	if (trailer) {
		// the filter armed only after a terminal block or some time after the start: a programme with
		// soaking keeps its drum movements and needs no long end wait
		for (const v of filterVariants(data.runs, store, poll).slice(1)) {
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
	for (const k of BASE_KEYS) {
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
 * Hints about runs in quarantine that the values in use do not detect correctly (Spec B.3), each run once: a reason
 * that can be a real programme (`foreign`, `test`) asks to use the run, a data error says the recording is disturbed.
 *
 * @param data - Decoded data
 * @param q0 - Result per key of the values in use on the runs in quarantine
 */
function hintsOf(data: Data, q0: ReadonlyMap<string, boolean>): Hint[] {
	const known = data.store.hinted ?? [];
	const out: Hint[] = [];
	for (const r of data.quarantined) {
		if (q0.get(r.key) !== false || known.some(k => k === r.key || sameRun(k, r.key))) {
			continue;
		}
		const code = primaryOf(data.verdictOf(r)?.reasons ?? []);
		out.push({
			key: r.key,
			kind: code !== null && DATA_ERRORS.has(code) ? "broken" : "use",
			ts: r.ts + r.seg.startIdx * r.step,
		});
	}
	return out;
}

/**
 * Keep the open hints of runs that are still stored in quarantine and add the new ones.
 *
 * @param data - Decoded data
 * @param hints - New hints
 */
function updateReview(data: Data, hints: readonly Hint[]): void {
	const { store } = data;
	const open = new Set(data.quarantined.map(r => r.key));
	const review = [
		...(store.info.review ?? []).filter(k => open.has(k)),
		...hints.filter(h => h.kind === "use").map(h => h.key),
	];
	if (review.length > 0) {
		store.info.review = [...new Set(review)];
	} else {
		delete store.info.review;
	}
	if (hints.length > 0) {
		store.hinted = [...(store.hinted ?? []), ...hints.map(h => h.key)].slice(-HINTED_MAX);
	}
}

/**
 * Check the values in use against the admitted runs (Spec D.3) and improve them. Repair first (decision 8): as soon
 * as an admitted run is not detected correctly, the safest close candidate that detects every admitted run of the
 * check set is taken at once, whatever the minimum count, the spacing, the lock, the drift and the step limits say;
 * runs in quarantine trigger nothing and only must not get worse. A tightening (end reported earlier) needs
 * TIGHTEN_MIN_RUNS admitted runs in the window, step limits, a cross-check, perturbed input and the envelope floors,
 * and never runs during a drift. Nothing changes if no candidate passes the gate.
 *
 * The final phase (Spec D.5) has its own path: the candidates of the analysis keep it as it is. An admitted run
 * reported too early by it suspends it at once; a suspended final phase is used again or repaired right after the
 * run (`recoverFinal`). Without a repair or a drift it is switched on or tuned (`finalStep`) before a tightening of
 * the base values is tried. The store is updated in place (only top-level fields, `info` and `changes`; vetoes,
 * hints and the events of the final phase come back in the outcome).
 *
 * @param store - Store
 * @param ctx - Context
 */
export async function optimize(store: StoreFile, ctx: OptimizeContext): Promise<OptimizeOutcome> {
	const info = store.info;
	info.lastCheckTs = ctx.now;
	refreshInfo(store);
	const data = new Data(store, ctx);
	let hints: Hint[] = [];
	const events: FinalEvent[] = [];
	const phaseEvents: OptimizeOutcome["phases"] = [];
	const vetoes: string[] = [];
	const build: Done = (kind, change = null, extra = {}) => ({
		kind,
		override: store.override,
		change,
		info,
		failing: [],
		vetoes: [],
		vetoClear: [],
		hints,
		final: events,
		phases: phaseEvents,
		interrupted: false,
		activeMs: 0,
		...extra,
	});
	const finish = (o: OptimizeOutcome): OptimizeOutcome => {
		info.nextPossibleTs = nextPossible(store);
		const eff = effectiveOf(ctx.type, store.override);
		if ((eff.trailerBurstSec ?? 0) > 0) {
			info.trailer = "used";
		} else if (info.trailer === "used") {
			info.trailer = "none";
		}
		updateReview(data, hints);
		if ((info.review?.length ?? 0) > 0 && (info.status === "ok" || info.status === "collecting")) {
			info.status = "review";
		}
		const activeMs = Math.round(data.activeMs);
		info.jobMs = activeMs;
		return {
			...o,
			override: store.override,
			hints,
			final: events,
			phases: phaseEvents,
			vetoes: [...new Set([...vetoes, ...o.vetoes])],
			activeMs,
		};
	};
	if (data.runs.length === 0 && data.spikes.length === 0 && data.quarantined.length === 0) {
		if (info.status === "drift") {
			return finish(build("drift"));
		}
		info.status = "collecting";
		return finish(build("none"));
	}
	const p0 = effectiveOf(ctx.type, store.override);
	// the cheap part of every job (Spec D.3 budget): gate, repair, suspending; never stopped by the budget
	let r0 = await gateOn(data, p0, "none");
	let q0 = await quarantineOn(data, p0);
	let failing = failingOf(r0);
	if (failing.length > 0 && finalOn(p0) && !data.suspended) {
		// an admitted run reported too early by the final phase (Spec D.3 point 3): suspend it at once, the base
		// values are then checked as the runtime uses them (without the final phase)
		const off = await gateOn(data, { ...p0, finalMinVal: 0 }, "none");
		const okOff = new Set(off.perRun.filter(r => r.ok).map(r => r.key));
		const byFinal = failing.filter(
			k =>
				okOff.has(k) ||
				r0.joined.some(j => j.key === k) ||
				(r0.spikeKeys.includes(k) && !off.spikeKeys.includes(k)),
		);
		if (byFinal.length > 0) {
			const key = newestOf(data, byFinal);
			markFinalSuspended(store, "earlyEnd", key, ctx.now, true);
			data.suspended = true;
			events.push({ kind: "suspended", reason: "earlyEnd", key });
			vetoes.push(...byFinal);
			r0 = off;
			q0 = await quarantineOn(data, p0);
			failing = failingOf(off);
		}
	}
	hints = hintsOf(data, q0);
	let out: OptimizeOutcome | null = null;
	if (failing.length > 0) {
		// repair first, also during a drift and a lock
		out = await repair(data, p0, r0, q0, failing, build);
	} else {
		store.failStreak = 0;
	}
	if (data.suspended) {
		// repair of the final phase right after the run, without minimum count, lock or step limits
		await recoverFinal(data, q0, events, vetoes);
	}
	if (!out) {
		if (info.status === "drift") {
			// a drift stops the tightening, switching the final phase on and tuning it, and the phase fine tuning
			info.budget = 0;
			out = build("drift");
		} else {
			out = await expensiveSteps(data, { p0, r0, q0 }, events, phaseEvents, build);
		}
	}
	return finish(out);
}

/** Values in use and their gate result while the expensive steps of a job run (a step that changes them updates it). */
interface StepState {
	/** Values in use. */
	p0: DetectionSettings;
	/** Gate result of the values in use. */
	r0: GateResult;
	/** Result per key of the values in use on the runs in quarantine. */
	q0: ReadonlyMap<string, boolean>;
}

/**
 * Hash of a text (FNV-1a, 8 hex digits).
 *
 * @param text - Text
 */
function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * What an expensive step works with besides the stored runs: the values in use as the runtime builds them (a step
 * stopped by the budget starts again with other values).
 *
 * @param data - Decoded data
 * @param p - Values in use
 */
function basisOf(data: Data, p: DetectionSettings): string {
	const { store, ctx } = data;
	return `${typeHash(p)}|${data.suspended ? 1 : 0}|${ctx.pollSec}|${store.unitFactor}|${store.step}`;
}

/**
 * Signature of the input of an expensive step: values in use and the runs it uses (target set, replay pick, false
 * starts, runs in quarantine, split programmes).
 *
 * @param data - Decoded data
 * @param p - Values in use
 * @param extra - More input of the step
 */
function sigOf(data: Data, p: DetectionSettings, extra = ""): string {
	const keys = (runs: readonly StoredRun[]): string[] => runs.map(r => r.key);
	return hashText(
		JSON.stringify([
			basisOf(data, p),
			keys(data.target),
			keys(data.runs),
			keys(data.spikes),
			keys(data.quarantined),
			data.joined.map(j => j.key),
			extra,
		]),
	);
}

/**
 * Whether a step searched the same input before; a cross-check (`daily`) also when it ran less than a day ago
 * (Spec D.3 budget: at most once a day and only with new admitted runs).
 *
 * @param data - Decoded data
 * @param step - Step
 * @param sig - Signature of the input (`sigOf`)
 * @param daily - At most once a day
 */
function checkedBefore(data: Data, step: JobStep, sig: string, daily: boolean): boolean {
	const c = data.store.checks?.[step];
	return c !== undefined && (c.sig === sig || (daily && data.ctx.now - c.ts < CROSS_CHECK_SPACING_MS));
}

/**
 * Remember that a step searched its input (`checkedBefore`).
 *
 * @param data - Decoded data
 * @param step - Step
 * @param sig - Signature of the input
 */
function markChecked(data: Data, step: JobStep, sig: string): void {
	data.store.checks = { ...data.store.checks, [step]: { ts: data.ctx.now, sig } };
}

/**
 * Status of the optimisation without a finding: locked, collecting runs or ok.
 *
 * @param data - Decoded data
 */
function plainStatus(data: Data): OptimizeInfo["status"] {
	const { store, ctx } = data;
	if (store.lockRuns > 0 || ctx.now < store.lockUntilTs) {
		return "locked";
	}
	return data.target.filter(trustedOf(data)).length >= TIGHTEN_MIN_RUNS ? "ok" : "collecting";
}

/**
 * The expensive steps of a job in turn (Spec D.3 budget, `JOB_STEPS`): switch the final phase on or tune it, tighten
 * the base values, fine-tune the phases. A job goes on with the step the last job stopped at, with the units it
 * finished; the budget (active computing time) stops a step without a change from it and keeps the progress
 * (`store.job`, `info.budget` counts these jobs in a row, status `budget`). A round that reaches its end clears the
 * progress and sets `info.budget` to 0. A step that changes the values in use updates `st` for the steps after it.
 *
 * @param data - Decoded data
 * @param st - Values in use and their gate results
 * @param events - What happened with the final phase
 * @param phaseEvents - What the phase fine tuning did
 * @param build - Result
 */
async function expensiveSteps(
	data: Data,
	st: StepState,
	events: FinalEvent[],
	phaseEvents: OptimizeOutcome["phases"],
	build: Done,
): Promise<OptimizeOutcome> {
	const { store, ctx } = data;
	const job = store.job;
	const at = job ? JOB_STEPS.indexOf(job.step) : -1;
	const startedTs = job && at >= 0 ? job.startedTs : ctx.now;
	let change: Change | null = null;
	let tightened: OptimizeOutcome | null = null;
	const vetoes: string[] = [];
	const vetoClear: string[] = [];
	const result = (kind: OptimizeOutcome["kind"]): OptimizeOutcome =>
		tightened ?? build(kind, change, { vetoes, vetoClear });
	data.budgeted = true;
	try {
		for (let i = Math.max(0, at); i < JOB_STEPS.length; i++) {
			const step = JOB_STEPS[i];
			const basis = basisOf(data, st.p0);
			data.beginStep(i === at && job?.basis === basis ? (job.memo ?? []) : []);
			try {
				if (step === "final") {
					change = (await finalStep(data, st, events)) ?? change;
				} else if (step === "tighten") {
					const t = await tighten(data, st.p0, st.r0, st.q0, build);
					vetoes.push(...t.vetoes);
					vetoClear.push(...t.vetoClear);
					if (t.kind === "tighten") {
						tightened = { ...t, vetoes, vetoClear };
					}
				} else {
					phaseEvents.push(...(await phaseStep(data)));
				}
			} catch (err) {
				if (!(err instanceof BudgetExceeded)) {
					throw err;
				}
				store.job = { step, cursor: data.memo.length, startedTs, basis, memo: data.memo };
				store.info.status = "budget";
				store.info.budget = (store.info.budget ?? 0) + 1;
				return { ...result(change ? "none" : "budget"), interrupted: true };
			}
		}
	} finally {
		data.budgeted = false;
	}
	delete store.job;
	store.info.budget = 0;
	if (store.info.status === "budget") {
		store.info.status = plainStatus(data);
	}
	return result("none");
}

/**
 * Phase fine tuning (Spec D.6) in the optimisation: only with phases on and the run check; the cross-check runs at
 * most once a day and only with new admitted runs. The limits of the existing phases are taken over after two equal
 * proposals in a row when the agreement of the cross-check does not drop (`tunePhases`); they are kept in the store
 * (`phaseTune`, only for the phase model they were computed for) and never change the detection. A new pattern gives
 * one hint.
 *
 * @param data - Decoded data
 */
async function phaseStep(data: Data): Promise<OptimizeOutcome["phases"]> {
	const { store, ctx } = data;
	const model = ctx.phases;
	if (!model?.enabled || !ctx.quality) {
		return [];
	}
	const quality = ctx.quality;
	const base = phaseTuneBase(model);
	const tune = store.phaseTune?.base === base ? store.phaseTune : undefined;
	const tuned = applyPhaseTune(model, tune?.applied);
	const current: PhaseModel =
		tune?.applied && typeof tune.agreement === "number"
			? { ...tuned, quality: { ...tuned.quality, agreement: tune.agreement } }
			: tuned;
	const sig = sigOf(data, ctx.type, `${base}|${tune?.applied?.hash ?? ""}`);
	if (checkedBefore(data, "phases", sig, true)) {
		return [];
	}
	const res = await data.unit("phases:tune", async () => {
		const keys = new Set(data.target.map(r => r.key));
		const units = storeSamples(store, quality)
			.filter(x => keys.has(x.run.key) && inUse(store, x.run))
			.map(x => ({ sample: x.sample, verdict: x.verdict }));
		await data.tick();
		const r = tunePhases(current, units, tune?.last ?? null, {
			pollSec: ctx.pollSec,
			holds: phaseHolds(current, store.bands ?? null) ?? [],
		});
		return {
			proposal: r.proposal,
			apply: r.model !== null,
			agreement: r.model?.quality.agreement ?? null,
			newPattern: r.newPattern,
		};
	});
	const out: OptimizeOutcome["phases"] = [];
	const next: NonNullable<StoreFile["phaseTune"]> = { base, last: res.proposal };
	if (res.apply) {
		next.applied = res.proposal;
		if (res.agreement !== null) {
			next.agreement = res.agreement;
		}
		out.push("tuned");
	} else if (tune?.applied) {
		next.applied = tune.applied;
		if (tune.agreement !== undefined) {
			next.agreement = tune.agreement;
		}
	}
	if (res.newPattern) {
		next.newPattern = true;
		if (tune?.newPattern !== true) {
			out.push("newPattern");
		}
	}
	store.phaseTune = next;
	markChecked(data, "phases", sig);
	return out;
}

/**
 * Key of the newest of some stored runs.
 *
 * @param data - Decoded data
 * @param keys - Keys
 */
function newestOf(data: Data, keys: readonly string[]): string {
	const byKey = new Map([...data.store.runs, ...data.store.spikes].map(r => [r.key, r]));
	return [...keys].sort((a, b) => (byKey.get(b)?.ts ?? 0) - (byKey.get(a)?.ts ?? 0))[0];
}

/**
 * Whether a tightening may run: outside the lock, enough admitted runs, new runs and spacing.
 *
 * @param store - Store
 * @param admittedRuns - Admitted runs in the 30-day window
 * @param now - Time
 */
function tightenAllowed(store: StoreFile, admittedRuns: number, now: number): boolean {
	return (
		store.lockRuns <= 0 &&
		now >= store.lockUntilTs &&
		admittedRuns >= TIGHTEN_MIN_RUNS &&
		store.newSinceChange >= TIGHTEN_NEW_RUNS &&
		!(store.lastChangeTs > 0 && now - store.lastChangeTs < TIGHTEN_SPACING_MS)
	);
}

/**
 * Which runs a tightening may aim at: admitted runs of the window, not cut short, not grown together.
 *
 * @param data - Decoded data
 */
function trustedOf(data: Data): (r: StoredRun) => boolean {
	const target = new Set(data.target);
	return (r: StoredRun): boolean => r.label === "run" && !r.postTruncated && !data.merged.has(r.key) && target.has(r);
}

/**
 * Samples of the check set for `learnFinal`: the runs of the check set with cells, without the runs judged
 * `finalSplit` and their early parts (their early end is no end).
 *
 * @param data - Decoded data
 * @param quality - Context of the run check
 */
function finalSamples(data: Data, quality: QualityContext): Parameters<typeof learnFinal>[0] {
	const { store, ctx } = data;
	const keys = new Set(checkSet(store, ctx.now, ctx.verdicts).map(r => r.key));
	const parts = new Set(data.joined.flatMap(j => [j.a, j.b]));
	return storeSamples(store, quality)
		.filter(x => keys.has(x.run.key) && !parts.has(x.run) && inUse(store, x.run))
		.map(x => ({ sample: x.sample, verdict: x.verdict, series: x.series }));
}

/**
 * The final phase learned from the check set (Spec B.6) with the minimum counts of the optimisation, or null when
 * it is not released.
 *
 * @param data - Decoded data
 * @param p - Values in use (their final phase is ignored)
 */
async function learnedFinal(data: Data, p: DetectionSettings): Promise<FinalCandidate | null> {
	const { store, ctx } = data;
	if (!ctx.quality || !store.bands || store.bands.bands.length === 0) {
		return null;
	}
	const learned = await learnFinal(finalSamples(data, ctx.quality), {
		base: p,
		pollSec: ctx.pollSec,
		unitFactor: store.unitFactor,
		abort: ctx.abort,
		abortFixed: ctx.abortFixed,
		bands: store.bands,
		minRuns: FINAL_ENABLE_MIN_RUNS,
		minPerGroup: FINAL_ENABLE_MIN_PER_GROUP,
		scope: ctx.quality.scope,
		yieldFn: () => data.tick(),
	});
	return learned.ok ? learned : null;
}

/**
 * Switch the final phase on or tune it (Spec D.5): on only with FINAL_ENABLE_MIN_RUNS admitted runs in the window
 * (and FINAL_ENABLE_MIN_PER_GROUP per group, checked by `learnFinal`) outside the lock; tuned only when a tightening
 * may run, within the step limits of `stepLimitFinal`. `learnFinal` must release the final phase on the check set
 * (cross-check, robustness, gain) and the gate over every admitted run must pass; no run may end later, no run in
 * quarantine get worse. The release check runs at most once a day and only with new admitted runs (Spec D.3 budget);
 * learning it is one unit of the step.
 *
 * @param data - Decoded data
 * @param st - Values in use and their gate results (updated by a change)
 * @param events - What happened with the final phase
 * @returns the change, or null
 */
async function finalStep(data: Data, st: StepState, events: FinalEvent[]): Promise<Change | null> {
	const { store, ctx } = data;
	const p0 = st.p0;
	const admittedRuns = data.target.filter(trustedOf(data)).length;
	const on = finalOn(p0);
	const allowed = on
		? tightenAllowed(store, admittedRuns, ctx.now) && admittedRuns >= FINAL_ENABLE_MIN_RUNS
		: store.lockRuns <= 0 && ctx.now >= store.lockUntilTs && admittedRuns >= FINAL_ENABLE_MIN_RUNS;
	if (!allowed || !ctx.quality || !store.bands || store.bands.bands.length === 0) {
		return null;
	}
	const sig = sigOf(data, p0);
	if (checkedBefore(data, "final", sig, true)) {
		return null;
	}
	const learned = await data.unit("final:learn", async () => {
		const l = await learnedFinal(data, p0);
		return l ? { values: l.values, covered: l.covered } : null;
	});
	const change = learned ? await finalApply(data, st, learned, events) : null;
	markChecked(data, "final", sig);
	return change;
}

/**
 * Take over the final phase learned by `finalStep` when it passes the gate over every admitted run, ends no run later
 * and makes no run in quarantine worse.
 *
 * @param data - Decoded data
 * @param st - Values in use and their gate results (updated by a change)
 * @param learned - Learned values and covered runs
 * @param learned.values - Values of the final phase
 * @param learned.covered - Runs it covers
 * @param events - What happened with the final phase
 */
async function finalApply(
	data: Data,
	st: StepState,
	learned: { values: FinalSettings; covered: number },
	events: FinalEvent[],
): Promise<Change | null> {
	const { store, ctx } = data;
	const { p0, r0, q0 } = st;
	const on = finalOn(p0);
	const values = on ? stepLimitFinal(learned.values, p0, learned.covered) : learned.values;
	if (!values) {
		return null;
	}
	const c = detectionOf({ ...p0, ...values });
	if (
		FINAL_KEYS.every(k => (c[k] ?? 0) === (p0[k] ?? 0)) ||
		!finalOn(c) ||
		finalViolations(c, c.standby, ctx.pollSec).length > 0
	) {
		return null;
	}
	const g = await gateOn(data, c, "none");
	if (!g.ok || g.falseStarts > r0.falseStarts) {
		return null;
	}
	if (g.perRun.some((r, i) => r.delaySec > (r0.perRun[i]?.delaySec ?? Number.POSITIVE_INFINITY) + ctx.pollSec)) {
		return null;
	}
	const q = await quarantineOn(data, c);
	if (!noRegression(q, q0)) {
		return null;
	}
	const before = store.override;
	store.override = diffOf(c, ctx.type);
	st.p0 = c;
	st.r0 = g;
	st.q0 = q;
	const change: Change = {
		ts: ctx.now,
		kind: on ? "finalTune" : "finalOn",
		from: before,
		to: store.override,
		reason: describeChange(p0, c),
		runs: store.runs.length + store.spikes.length,
		gainSec: Math.round(mean(r0.perRun.map(r => r.delaySec)) - mean(g.perRun.map(r => r.delaySec))),
	};
	pushChange(store, change);
	store.final = { ...(store.final ?? { splits: [], suspendedAt: 0 }), state: "on" };
	store.lastChangeTs = ctx.now;
	store.newSinceChange = 0;
	store.info.status = "ok";
	events.push({ kind: on ? "tuned" : "on", change });
	return change;
}

/**
 * After a suspension (Spec D.5): if the values in use detect every admitted run (each split programme replayed with
 * its early part as one run), the early end was right and the final phase is used again (`endOk`); otherwise the
 * closest values with a later final block, a longer time in the final band and a narrower final band (or the final
 * phase learned again, which needs the minimum counts) that detect every admitted run repair it and it is used
 * again (`repair`); without such values it stays suspended. No minimum count, lock, drift or step limits.
 *
 * @param data - Decoded data
 * @param q0 - Result per key of the values in use (without the final phase) on the runs in quarantine
 * @param events - What happened with the final phase
 * @param vetoes - Keys of the runs that become boundary runs
 */
async function recoverFinal(
	data: Data,
	q0: ReadonlyMap<string, boolean>,
	events: FinalEvent[],
	vetoes: string[],
): Promise<void> {
	const { store, ctx } = data;
	const final = store.final;
	const p1 = effectiveOf(ctx.type, store.override);
	if (!final || final.state !== "suspended" || !finalOn(p1)) {
		return;
	}
	const stays = (reason: string): void => {
		if (final.stays !== reason) {
			store.final = { ...final, stays: reason };
			events.push({ kind: "stays", reason });
		}
	};
	// a split programme can be judged only when it is stored
	const joined = final.joined ?? [];
	const missing = final.splits.filter(
		k => joined.some(j => j === k || sameRun(j, k)) && !data.joined.some(p => p.key === k || sameRun(p.key, k)),
	);
	if (missing.length > 0) {
		stays("notStored");
		return;
	}
	const g1 = await gateOn(data, p1, "none", undefined, true);
	if (g1.ok && noRegression(await quarantineOn(data, p1, true), q0)) {
		markFinalResumed(store, "endOk", ctx.now, true);
		data.suspended = false;
		events.push({ kind: "resumed", reason: "endOk" });
		return;
	}
	const failing = failingOf(g1);
	let best: DetectionSettings | null = null;
	for (const c of await finalRepairCandidates(data, p1)) {
		const g = await gateOn(data, c, "none", undefined, true);
		if (g.ok && noRegression(await quarantineOn(data, c, true), q0)) {
			best = c;
			break;
		}
	}
	if (!best) {
		stays("noRepair");
		return;
	}
	const trigger = failing.length > 0 ? newestOf(data, failing) : final.splits.at(-1);
	const before = store.override;
	store.override = diffOf(best, ctx.type);
	const change: Change = {
		ts: ctx.now,
		kind: "finalRepair",
		from: before,
		to: store.override,
		reason: describeChange(p1, best),
		runs: store.runs.length + store.spikes.length,
		gainSec: 0,
		...(trigger ? { trigger } : {}),
	};
	pushChange(store, change);
	store.lockRuns = LOCK_RUNS;
	store.lockUntilTs = ctx.now + LOCK_MS;
	store.lastChangeTs = ctx.now;
	store.newSinceChange = 0;
	store.failStreak = 0;
	store.info.status = "locked";
	markFinalResumed(store, "repair", ctx.now, true, trigger);
	data.suspended = false;
	vetoes.push(...failing);
	events.push({ kind: "repaired", change, ...(trigger ? { key: trigger } : {}) });
	events.push({ kind: "resumed", reason: "repair" });
}

/**
 * Candidates of a repair of the final phase, closest first: the final block later (X), longer in the final band (Y)
 * and a narrower final band (P higher), within the hard bounds; and the final phase learned again (only with the
 * minimum counts), made safer by the values in use.
 *
 * @param data - Decoded data
 * @param p1 - Values in use
 */
async function finalRepairCandidates(data: Data, p1: DetectionSettings): Promise<DetectionSettings[]> {
	const poll = data.ctx.pollSec;
	const out: { c: DetectionSettings; d: number }[] = [];
	const add = (c: DetectionSettings): void => {
		if (finalOn(c) && finalViolations(c, c.standby, poll).length === 0) {
			out.push({ c, d: finalDistance(c, p1) });
		}
	};
	const Y = p1.finalMinSec ?? 0;
	const X = p1.finalAfterSec ?? 0;
	const P = p1.finalMinVal ?? 0;
	const Pmax = p1.finalMaxVal ?? 0;
	for (const fy of FINAL_REPAIR_Y) {
		for (const fx of FINAL_REPAIR_X) {
			for (const fp of FINAL_REPAIR_P) {
				const p = Math.round(P * fp * 1e5) / 1e5;
				if ((fy === 1 && fx === 1 && fp === 1) || (Pmax > 0 && p >= Pmax)) {
					continue;
				}
				add({
					...p1,
					finalMinSec: Math.ceil((Y * fy) / poll) * poll,
					finalAfterSec: Math.ceil((X * fx) / poll) * poll,
					finalMinVal: p,
				});
			}
		}
	}
	const learned = await learnedFinal(data, p1);
	if (learned) {
		const v = learned.values;
		add({
			...p1,
			...v,
			finalMinSec: Math.max(v.finalMinSec, Y),
			finalAfterSec: Math.max(v.finalAfterSec, X),
			finalMinVal: Math.max(v.finalMinVal, P),
		});
	}
	return out.sort((a, b) => a.d - b.d).map(x => x.c);
}

/**
 * Distance of the final phase of two value sets (sum of relative changes).
 *
 * @param p - Values
 * @param p0 - Values in use
 */
function finalDistance(p: DetectionSettings, p0: DetectionSettings): number {
	let d = 0;
	for (const k of FINAL_KEYS) {
		const x = p[k] ?? 0;
		const y = p0[k] ?? 0;
		d += Math.abs(x - y) / Math.max(Math.abs(y), 1);
	}
	return d;
}

/**
 * Step limits of the final phase when the optimisation tunes it (Spec D.5): P changes by at most 10 %; Y rises
 * freely and drops by at most 10 %, only with at least 5 covered runs; X drops by at most 25 %; every other field
 * comes from the data. A candidate without a final phase while the values in use have one is not allowed (null: the
 * final phase is switched off only by suspending it).
 *
 * @param c - Final phase of the candidate
 * @param p0 - Final phase of the values in use
 * @param covered - Runs whose end the candidate reports early and not too early
 */
export function stepLimitFinal(c: FinalSettings, p0: FinalSettings, covered: number): Required<FinalSettings> | null {
	const a = finalFields(c);
	const b = finalFields(p0);
	if (b.finalMinVal <= 0) {
		return a;
	}
	if (a.finalMinVal <= 0) {
		return null;
	}
	const round = (x: number): number => Math.round(x * 1e5) / 1e5;
	const out = { ...a };
	out.finalMinVal = round(
		Math.min(b.finalMinVal * (1 + FINAL_P_STEP), Math.max(b.finalMinVal * (1 - FINAL_P_STEP), a.finalMinVal)),
	);
	if (a.finalMinSec < b.finalMinSec) {
		out.finalMinSec =
			covered >= FINAL_Y_DROP_RUNS
				? round(Math.max(a.finalMinSec, b.finalMinSec * (1 - FINAL_Y_DROP)))
				: b.finalMinSec;
	}
	out.finalAfterSec = round(Math.max(a.finalAfterSec, b.finalAfterSec * (1 - FINAL_X_DROP)));
	return out;
}

/**
 * Every field of the final phase (missing = 0).
 *
 * @param s - Values
 */
function finalFields(s: FinalSettings): Required<FinalSettings> {
	return Object.fromEntries(FINAL_KEYS.map(k => [k, s[k] ?? 0])) as Required<FinalSettings>;
}

/**
 * Whether a candidate of the analysis or a repair switches an active final phase off (not allowed, Spec D.5).
 *
 * @param c - Candidate
 * @param p0 - Values in use
 */
function silentFinalOff(c: DetectionSettings, p0: DetectionSettings): boolean {
	return finalOn(p0) && !finalOn(c);
}

type Done = (
	kind: OptimizeOutcome["kind"],
	change?: Change | null,
	extra?: Partial<OptimizeOutcome>,
) => OptimizeOutcome;

/**
 * Keys of the runs with a veto from an earlier job: values that are taken over pass every admitted run, so the veto
 * of these runs ends.
 *
 * @param data - Decoded data
 */
function oldVetoes(data: Data): string[] {
	return data.runs.filter(r => r.veto !== undefined && r.veto < data.ctx.now).map(r => r.key);
}

/**
 * The repair candidate closest to the current values that passes the gate and is no worse on the runs in quarantine.
 *
 * @param data - Decoded data
 * @param p0 - Current values
 * @param candidates - Candidates
 * @param seen - Candidates already checked (shared between calls)
 * @param q0 - Result per key of the current values on the runs in quarantine
 */
async function bestRepair(
	data: Data,
	p0: DetectionSettings,
	candidates: readonly DetectionSettings[],
	seen: Set<string>,
	q0: ReadonlyMap<string, boolean>,
): Promise<{ p: DetectionSettings; d: number; g: GateResult } | null> {
	let best: { p: DetectionSettings; d: number; g: GateResult } | null = null;
	for (const c of candidates) {
		const key = JSON.stringify(detectionOf(c));
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		if (silentFinalOff(c, p0)) {
			continue;
		}
		// closest to the current values; a late end (after the anti-crease phase) counts as a change too
		const d = distance(c, p0);
		if (best && d >= best.d) {
			continue;
		}
		const g = await gateOn(data, c, "none");
		const score = d + mean(g.perRun.map(r => r.delaySec)) / REPAIR_DELAY_WEIGHT_SEC;
		if (g.ok && (!best || score < best.d) && noRegression(await quarantineOn(data, c), q0)) {
			best = { p: c, d: score, g };
		}
	}
	return best;
}

/**
 * Repair (Spec D.3 point 3, decision 8): the safe candidate closest to the values in use that detects every admitted
 * run of the check set, without minimum count, spacing, lock, drift or step limits (only the hard bounds and the
 * envelope floors); the runs that triggered it become boundary runs. Without a candidate the values stay
 * (`cannotCover`, after DRIFT_RUNS in a row `drift`).
 *
 * @param data - Decoded data
 * @param p0 - Values in use
 * @param r0 - Gate result of the values in use
 * @param q0 - Result per key of the values in use on the runs in quarantine
 * @param failing - Keys of the runs and false starts not detected correctly
 * @param done - Result
 */
async function repair(
	data: Data,
	p0: DetectionSettings,
	r0: GateResult,
	q0: ReadonlyMap<string, boolean>,
	failing: string[],
	done: Done,
): Promise<OptimizeOutcome> {
	const { store, ctx } = data;
	const raw = await repairCandidates(data, p0);
	// first with the envelope floors (start not shorter than the longest burst seen, end not shorter
	// than the longest pause seen), only if none of those passes without them
	const floored = raw
		.map(c => clampBounds(applyFloors(c, store, ctx.pollSec), ctx.pollSec))
		.filter(c => withinBounds(c, ctx.pollSec));
	const seen = new Set<string>();
	let best = await bestRepair(data, p0, floored, seen, q0);
	best ??= await bestRepair(data, p0, raw, seen, q0);
	if (!best) {
		store.failStreak++;
		store.info.status = store.failStreak >= DRIFT_RUNS ? "drift" : "cannotCover";
		return done(store.failStreak >= DRIFT_RUNS ? "drift" : "cannotCover", null, { failing });
	}
	// the newest run that triggered the repair
	const byKey = new Map([...data.runs, ...data.spikes].map(r => [r.key, r]));
	const trigger = [...failing].sort((a, b) => (byKey.get(b)?.ts ?? 0) - (byKey.get(a)?.ts ?? 0))[0];
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
		trigger,
	};
	pushChange(store, change);
	store.lockRuns = LOCK_RUNS;
	store.lockUntilTs = ctx.now + LOCK_MS;
	store.lastChangeTs = ctx.now;
	store.newSinceChange = 0;
	store.failStreak = 0;
	store.info.status = "locked";
	return done("repair", change, { failing, vetoes: failing, vetoClear: oldVetoes(data) });
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

/** What the tightening keeps of an analysis (JSON, a unit of the step). */
interface StoredAnalysis {
	/** Candidate values of the analysis (the final phase as in the values in use). */
	analysis: DetectionSettings;
	/** Anti-crease phase of the analysis. */
	trailer: string;
	/** Runs detected in the leave-one-out check of the analysis, or null. */
	looDetected: number | null;
	/** Runs of the analysis. */
	runs: number;
}

/** Result of the gate of a tightening candidate (a unit of the step). */
interface CandidateCheck {
	/** Passes the gate, ends no run later, makes no run in quarantine worse. */
	pass: boolean;
	/** The one run that stopped it (veto), or null. */
	veto: string | null;
	/** Starts in the false start windows. */
	falseStarts: number;
	/** Mean end delay in s. */
	delay: number;
}

/**
 * Analysis of stored runs as the tightening keeps it.
 *
 * @param data - Decoded data
 * @param p0 - Values in use
 * @param keep - Which runs to take
 */
async function storedAnalysis(
	data: Data,
	p0: DetectionSettings,
	keep: (r: StoredRun) => boolean,
): Promise<StoredAnalysis | null> {
	const sg = await analyzeStored(data, p0, keep);
	return sg
		? {
				analysis: fromSuggestion(sg, p0),
				trailer: sg.trailer ?? "none",
				looDetected: sg.looDetected ?? null,
				runs: sg.runs,
			}
		: null;
}

/**
 * Gate of a tightening candidate: every admitted run, no more false starts, no run later, no run in quarantine worse.
 *
 * @param data - Decoded data
 * @param c - Candidate
 * @param r0 - Gate result of the values in use
 * @param q0 - Result per key of the values in use on the runs in quarantine
 */
async function candidateCheck(
	data: Data,
	c: DetectionSettings,
	r0: GateResult,
	q0: ReadonlyMap<string, boolean>,
): Promise<CandidateCheck> {
	const poll = data.ctx.pollSec;
	const g = await gateOn(data, c, "none");
	const delay = mean(g.perRun.map(r => r.delaySec));
	if (!g.ok || g.falseStarts > r0.falseStarts) {
		// a candidate that passes every other run of the check set: the one run that stops it is a boundary run
		const bad = failingOf(g);
		return { pass: false, veto: bad.length === 1 ? bad[0] : null, falseStarts: g.falseStarts, delay };
	}
	const later = g.perRun.some((r, i) => r.delaySec > (r0.perRun[i]?.delaySec ?? Number.POSITIVE_INFINITY) + poll);
	const pass = !later && noRegression(await quarantineOn(data, c), q0);
	return { pass, veto: null, falseStarts: g.falseStarts, delay };
}

/**
 * Tightening (Spec D.3 point 4): only with TIGHTEN_MIN_RUNS admitted runs in the 30-day window, TIGHTEN_NEW_RUNS new
 * ones and TIGHTEN_SPACING_MS since the last change, outside the lock; targets are the admitted runs of the window
 * (no run grown together), the gate covers the check set and the runs in quarantine must not get worse. A run that
 * alone stops a candidate gets a veto. The analysis, the gate of each candidate, the analyses without a programme
 * group and the robustness check are units of the step (Spec D.3 budget); the same input is not searched again, and
 * a candidate checked in an earlier job is checked again before it is taken over.
 *
 * @param data - Decoded data
 * @param p0 - Values in use
 * @param r0 - Gate result of the values in use
 * @param q0 - Result per key of the values in use on the runs in quarantine
 * @param done - Result
 */
async function tighten(
	data: Data,
	p0: DetectionSettings,
	r0: GateResult,
	q0: ReadonlyMap<string, boolean>,
	done: Done,
): Promise<OptimizeOutcome> {
	const { store, ctx } = data;
	const target = new Set(data.target);
	const isTrusted = (r: StoredRun): boolean =>
		r.label === "run" && !r.postTruncated && !data.merged.has(r.key) && target.has(r);
	const admittedRuns = data.target.filter(isTrusted).length;
	const trusted = data.runs.filter(isTrusted);
	const locked = store.lockRuns > 0 || ctx.now < store.lockUntilTs;
	if (locked) {
		store.info.status = "locked";
		return done("none");
	}
	store.info.status = admittedRuns >= TIGHTEN_MIN_RUNS ? "ok" : "collecting";
	if (
		admittedRuns < TIGHTEN_MIN_RUNS ||
		store.newSinceChange < TIGHTEN_NEW_RUNS ||
		(store.lastChangeTs > 0 && ctx.now - store.lastChangeTs < TIGHTEN_SPACING_MS)
	) {
		return done("none");
	}
	const sig = sigOf(data, p0, store.override === null ? "" : JSON.stringify(store.override));
	if (checkedBefore(data, "tighten", sig, false)) {
		return done("none");
	}
	const result = await tightenSearch(data, p0, r0, q0, done, { admittedRuns, trusted, isTrusted });
	markChecked(data, "tighten", sig);
	return result;
}

/**
 * Search of the tightening (`tighten`, after its conditions).
 *
 * @param data - Decoded data
 * @param p0 - Values in use
 * @param r0 - Gate result of the values in use
 * @param q0 - Result per key of the values in use on the runs in quarantine
 * @param done - Result
 * @param runs - Admitted runs
 * @param runs.admittedRuns - Admitted runs in the 30-day window
 * @param runs.trusted - Admitted runs of the replay pick
 * @param runs.isTrusted - Which runs the tightening may aim at
 */
async function tightenSearch(
	data: Data,
	p0: DetectionSettings,
	r0: GateResult,
	q0: ReadonlyMap<string, boolean>,
	done: Done,
	runs: { admittedRuns: number; trusted: StoredRun[]; isTrusted: (r: StoredRun) => boolean },
): Promise<OptimizeOutcome> {
	const { store, ctx } = data;
	const poll = ctx.pollSec;
	const { admittedRuns, trusted, isTrusted } = runs;
	const sg = await data.unit("tighten:analysis", () => storedAnalysis(data, p0, isTrusted));
	if (!sg) {
		return done("none");
	}
	store.info.trailer = sg.trailer === "notSeparable" ? "notSeparable" : store.info.trailer;
	const withTrailer = trusted.filter(r => r.feat.trailer).length;
	const shape = (c: DetectionSettings): DetectionSettings =>
		clampBounds(applyFloors(stepLimit(c, p0, admittedRuns, withTrailer, poll), store, poll), poll);
	const build = (
		recipe: Recipe,
		analysis: DetectionSettings,
		variants: Partial<DetectionSettings>[],
	): DetectionSettings => {
		const base = recipe.base === "current" ? detectionOf(p0) : analysis;
		return shape(recipe.filter >= 0 && variants[recipe.filter] ? { ...base, ...variants[recipe.filter] } : base);
	};
	const variants = filterOptions(trusted, store, p0, withTrailer, poll);
	const recipes: Recipe[] = [{ base: "analysis", filter: -1 }];
	variants.forEach((_, i) => {
		recipes.push({ base: "analysis", filter: i }, { base: "current", filter: i });
	});

	// candidates that pass the gate and are never worse on any run, fastest first
	const passing: { recipe: Recipe; c: DetectionSettings; key: string; check: CandidateCheck }[] = [];
	const seen = new Set<string>();
	const vetoes = new Set<string>();
	for (const recipe of recipes) {
		const c = build(recipe, detectionOf(sg.analysis), variants);
		const json = JSON.stringify(c);
		if (seen.has(json) || !withinBounds(c, poll) || unguardedFilterOn(c, p0) || silentFinalOff(c, p0)) {
			continue;
		}
		seen.add(json);
		const key = hashText(json);
		const check = await data.unit(`tighten:gate:${key}`, () => candidateCheck(data, c, r0, q0));
		if (check.veto !== null) {
			vetoes.add(check.veto);
		}
		if (check.pass) {
			passing.push({ recipe, c, key, check });
		}
	}
	const extra = (): Partial<OptimizeOutcome> => ({ vetoes: [...vetoes] });
	passing.sort((a, b) => a.check.delay - b.check.delay);
	const families = [...new Set(trusted.map(r => r.family))];
	const d0 = mean(r0.perRun.map(r => r.delaySec));
	// analysis without one programme group, once per group in a job (cross-check)
	const without = new Map<number, DetectionSettings | null>();
	const analysisWithout = async (fam: number): Promise<DetectionSettings | null> => {
		if (!without.has(fam)) {
			const a = await data.unit(`tighten:without:${fam}`, () =>
				storedAnalysis(data, p0, r => isTrusted(r) && r.family !== fam),
			);
			without.set(fam, a ? detectionOf(a.analysis) : null);
		}
		return without.get(fam) ?? null;
	};
	for (const cand of passing) {
		const gain = d0 - cand.check.delay;
		const fewerFalse = cand.check.falseStarts < r0.falseStarts;
		if (!fewerFalse && gain < Math.max(60, 0.1 * d0)) {
			break;
		}
		if (!(await crossCheck(data, p0, cand.recipe, families, sg, isTrusted, build, analysisWithout))) {
			continue;
		}
		const robust = await data.unit(`tighten:robust:${cand.key}`, async () => {
			for (const p of ["scale09", "scale11", "shift1", "stale5"] as const) {
				if (!(await gateOn(data, cand.c, p)).ok) {
					return false;
				}
			}
			return true;
		});
		if (!robust) {
			continue;
		}
		// a result of an earlier job: checked again against the runs stored now
		if (data.reused && !(await candidateCheck(data, cand.c, r0, q0)).pass) {
			continue;
		}
		const next = diffOf(cand.c, ctx.type);
		if (JSON.stringify(next) === JSON.stringify(store.override)) {
			return done("none", null, extra());
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
		return done("tighten", change, { ...extra(), vetoClear: oldVetoes(data) });
	}
	return done("none", null, extra());
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
 * @param analysisWithout - Analysis without one programme group
 */
async function crossCheck(
	data: Data,
	p0: DetectionSettings,
	recipe: Recipe,
	families: readonly number[],
	sg: StoredAnalysis,
	isTrusted: (r: StoredRun) => boolean,
	build: (recipe: Recipe, analysis: DetectionSettings, variants: Partial<DetectionSettings>[]) => DetectionSettings,
	analysisWithout: (fam: number) => Promise<DetectionSettings | null>,
): Promise<boolean> {
	const { store, ctx } = data;
	if (families.length < 3) {
		return recipe.base === "current" || sg.looDetected === null || sg.looDetected >= sg.runs;
	}
	for (const fam of families) {
		const keep = (r: StoredRun): boolean => isTrusted(r) && r.family !== fam;
		const rest = data.runs.filter(keep);
		const aF = recipe.base === "analysis" ? await analysisWithout(fam) : null;
		if (recipe.base === "analysis" && !aF) {
			continue;
		}
		const variants =
			recipe.filter >= 0
				? filterOptions(rest, store, p0, rest.filter(r => r.feat.trailer).length, ctx.pollSec)
				: [];
		const cF = build(recipe, aF ?? detectionOf(p0), variants);
		const gF = await gateOn(data, cF, "none", r => isTrusted(r) && r.family === fam);
		if (!gF.ok) {
			return false;
		}
	}
	return true;
}

/**
 * Apply the vetoes of an optimisation result to the stored runs (Spec D.2): the runs that stopped a candidate or
 * caused a repair get the time as veto (boundary runs), the older vetoes of runs the new values pass end.
 *
 * @param store - Store
 * @param outcome - Result of `optimize`
 * @param now - Time of the job
 */
export function applyVetoes(
	store: StoreFile,
	outcome: Pick<OptimizeOutcome, "vetoes" | "vetoClear">,
	now: number,
): void {
	const set = new Set(outcome.vetoes);
	const clear = new Set(outcome.vetoClear);
	for (const r of [...store.runs, ...store.spikes]) {
		if (clear.has(r.key)) {
			delete r.veto;
		}
		if (set.has(r.key)) {
			r.veto = now;
		}
	}
}
