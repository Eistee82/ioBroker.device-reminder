import { FINAL_KEYS } from "./detector/types.js";
import type { DetectionSettings, FinalExit } from "./detector/types.js";
import type { FileIO } from "./host.js";
import type { BaseBands } from "./learn/bands.js";
import { bandFeaturesOf, baseBandsOf } from "./learn/bands.js";
import type { StoredFeatures } from "./learn/families.js";
import { assignFamilies, featuresOf } from "./learn/families.js";
import type { QualityContext, RunSample, Uses, Verdict } from "./learn/quality.js";
import { admitted, checkRuns, sameRun, samplesOf, verdictKey } from "./learn/quality.js";
import type { Layout, RunInfo, TailPart } from "./learn/runs.js";
import {
	applyTail,
	buildLayout,
	LAYOUT_REV,
	LEVEL_SEP_W,
	MAX_PAUSE_MS,
	median,
	quantile,
	SPLIT_GAP_MIN_MS,
	tailRule,
} from "./learn/runs.js";
import type { TickCell, TickSeries } from "./learn/ticks.js";
import { decodeCells, encodeCells, fromCells, quantOf } from "./learn/ticks.js";
import type { PhaseTuneProposal } from "./phases/learn.js";
import type { Capture, CaptureEntry } from "./runRecorder.js";
import { errorMessage } from "./utils.js";

/** Version of the store format. */
export const STORE_VERSION = 1;
/** Time window of the learning data: older runs go unless they are boundary runs or keep a group alive. */
export const WINDOW_MS = 30 * 86_400_000;
/** Most stored runs (metadata; their cells only while there is room). */
export const MAX_RUN_META = 400;
/** Every programme group keeps at least this many runs. */
export const MIN_PER_FAMILY = 2;
/** Most runs replayed by the optimisation (the newest of every group plus all boundary runs). */
export const REPLAY_PICK_MAX = 60;
/** Most stored false starts. */
export const MAX_SPIKES = 10;
/** Largest store file in bytes (characters). */
export const MAX_STORE_BYTES = 1_000_000;
/** Largest persisted capture of a run in progress in bytes (characters, encoded). */
export const MAX_PENDING_BYTES = 200_000;
/** Most kept changes. */
export const MAX_CHANGES = 10;
/** A runtime start within this distance of the segmented start counts as the start of the run. */
const START_MATCH_MS = 5 * 60_000;
/** Time after the programme that a trusted run must contain. */
const POST_ROLL_MS = MAX_PAUSE_MS;
/** Base bands are learned from at least this many clean runs. */
const BANDS_MIN_RUNS = 3;

/** Classification of a stored capture. */
export type RunLabel = "run" | "split" | "spike";

/** One stored capture. */
export interface StoredRun {
	/** Id (time of the first cell and number of events in base 36; for display and selection). */
	id: string;
	/** Key of the run (`verdictKey`: device and start minute; set by `addRun` and `upgradeStore`). */
	key: string;
	/** Revision of the layout the segmentation comes from (`LAYOUT_REV`; missing: before V5). */
	rev?: number;
	/** Time of cell 0 in ms. */
	ts: number;
	/** Poll interval in ms. */
	step: number;
	/** Quantisation factor of `data`. */
	q: number;
	/** Factor from the unit of the state to W. */
	unitFactor: number;
	/** Encoded cells (unit of the state); missing: only the metadata are kept (no room). */
	data?: string;
	/** Runtime events with their time. */
	ev: CaptureEntry[];
	/** Classification. */
	label: RunLabel;
	/** Origin. */
	src: "live" | "history";
	/** Whether the time after the end was cut short (restart). */
	postTruncated: boolean;
	/** The start came from the lock phase of the final phase with this exit. */
	afterFinal?: FinalExit;
	/** Time the run last stopped a candidate of the optimisation (boundary run, Spec D.2). */
	veto?: number;
	/**
	 * Report times as differences (`toDiffs`, ms after `ts`): live the reports of the power state, history the
	 * ticks with a stored value. Missing: unknown.
	 */
	rep?: number[];
	/**
	 * Poll interval in ms before the run was converted to a finer grid: short bursts are missing, so the run is not
	 * used for phases and the trailer (a property of the run, not a decision of the user).
	 */
	gridFrom?: number;
	/** Segmentation (cell indices). */
	seg: {
		startIdx: number;
		coreEndIdx: number;
		runEndIdx: number;
		trailerFrom: number | null;
		trailerTo: number | null;
		/** Programme end (`RunInfo.progEnd` under the tail of the store; `runEndIdx` without a separated tail). */
		progEndIdx: number;
		/** Run level of the capture in W (missing: before V5). */
		runLimit?: number;
	};
	/** Features (W, s). */
	feat: StoredFeatures;
	/** Programme group. */
	family: number;
}

/**
 * Extremes of the admitted runs, never narrower than the envelope of a store before V5 (`legacyEnvelope`). Kept
 * in W and s; computed again whenever the runs or the decisions change.
 */
export interface Envelope {
	/** Longest pause inside a programme in s. */
	maxPauseSec: number;
	/** Longest burst (anti-crease or false start) in s. */
	maxBurstSec: number;
	/** Longest gap between two anti-crease bursts in s. */
	maxTrailSec: number;
	/** Longest anti-crease phase in s. */
	maxTrailerSec: number;
	/** Lowest median run power in W (0 = none). */
	minRunW: number;
	/** Shortest programme in s (0 = none). */
	minCoreSec: number;
	/** Number of runs that went in. */
	n: number;
}

/** One change of the optimised values. */
export interface Change {
	/** Time in ms. */
	ts: number;
	/**
	 * Kind (`adopted`: the values in use became the base values; `typeChanged`: entries of earlier versions, shown
	 * like `baseChanged`; `revert`: a repair taken back; `finalOn`/`finalSuspend`/`finalResume`/`finalRepair`/
	 * `finalTune`: the final phase switched on, suspended, used again, repaired or adjusted).
	 */
	kind:
		| "repair"
		| "tighten"
		| "undo"
		| "reset"
		| "adopted"
		| "baseChanged"
		| "typeChanged"
		| "revert"
		| "finalOn"
		| "finalSuspend"
		| "finalResume"
		| "finalRepair"
		| "finalTune";
	/** Override before. */
	from: Partial<DetectionSettings> | null;
	/** Override after. */
	to: Partial<DetectionSettings> | null;
	/** Reason (English). */
	reason: string;
	/** Number of runs checked. */
	runs: number;
	/** Mean gain of the end delay in s. */
	gainSec: number;
	/** Key of the run that caused the change (kept while the run is stored). */
	trigger?: string;
}

/** Status of the automatic optimisation. */
export type OptimizeStatus = "off" | "collecting" | "ok" | "locked" | "cannotCover" | "drift" | "budget" | "review";

/** Status shown in `learning.optimizeInfo`. */
export interface OptimizeInfo {
	/** Status. */
	status: OptimizeStatus;
	/** Stored runs. */
	runs: number;
	/** Stored false starts. */
	spikes: number;
	/** Programme groups. */
	families: number;
	/** Anti-crease handling. */
	trailer: "none" | "used" | "notSeparable";
	/** Time of the last check. */
	lastCheckTs: number;
	/** Earliest time of the next tightening. */
	nextPossibleTs: number;
	/** End delay of the last run in s (from the programme end). */
	lastEndDelaySec: number;
	/** Captures that could not be classified. */
	unclear: number;
	/** Final phase: off, on, or suspended (derived from the values in use at every write; only `suspended` is kept). */
	finalState?: "off" | "on" | "suspended";
	/** Keys of the runs with an open hint (wrongly detected run in quarantine, Spec B.3). */
	review?: string[];
	/** Stored runs and false starts excluded by the user. */
	excluded?: number;
	/** Optimisation jobs in a row stopped by the time budget. */
	budget?: number;
	/** Active computing time of the last job in ms. */
	jobMs?: number;
}

/** Decision of the user about one run (kept over its key, also by "clear learning data"). */
export interface Decision {
	/** Use the run although the run check holds it back, or never use it. */
	user?: "include" | "exclude";
	/** Reason (shown with the key when the run itself is gone). */
	reason?: string;
}

/** Tail of the stored runs (Spec B.4, over all admitted runs; W). */
export interface StoreTail {
	/** Values above it belong to the programme in W. */
	ceil: number;
	/** Whether the trailer is separated from the programme. */
	separated: boolean;
	/** Highest burst maximum of the trailers in W (0 without). */
	burstMaxW: number;
	/** Median run level of the captures in W. */
	runLimit: number;
}

/** State of the final phase in the store. */
export interface FinalState {
	/** Off, on, or suspended after a split programme. */
	state: "off" | "on" | "suspended";
	/** Keys of the runs judged `finalSplit`. */
	splits: string[];
	/** Time of the suspension (0 = none). */
	suspendedAt: number;
	/** Reason of the suspension (`finalSplit`, `earlyEnd`). */
	reason?: string;
	/** Keys of the runs after an early end already judged afterwards (not judged again when the capture closes). */
	checked?: string[];
	/**
	 * Keys of the runs judged `finalSplit` (rest of a split programme), kept while they are stored, also after the
	 * final phase is used again: the optimisation replays each with its early part as one run (Spec D.5).
	 */
	joined?: string[];
	/** Why the suspended final phase is not used again yet (`noRepair`, `notStored`). */
	stays?: string;
}

/** Most keys of split runs that are remembered (`FinalState.joined`). */
const JOINED_MAX = 20;

/**
 * Suspend the final phase in the store (Spec A.3, D.3 point 3): state, split run, change entry. A run judged
 * `finalSplit` is also kept as split run to replay it with its early part (`joined`).
 *
 * @param store - Store
 * @param reason - `finalSplit` or `earlyEnd`
 * @param key - Key of the run that caused it
 * @param now - Time
 * @param on - Whether the values in use have a final phase (state when the store has none yet)
 * @returns whether the final phase was suspended before
 */
export function markFinalSuspended(store: StoreFile, reason: string, key: string, now: number, on: boolean): boolean {
	const final = store.final ?? { state: on ? "on" : "off", splits: [], suspendedAt: 0 };
	const was = final.state === "suspended";
	const joined = reason === "finalSplit" && !(final.joined ?? []).includes(key);
	store.final = {
		...final,
		state: "suspended",
		splits: final.splits.includes(key) ? final.splits : [...final.splits, key],
		suspendedAt: was ? final.suspendedAt : now,
		reason,
		...(joined ? { joined: [...(final.joined ?? []), key].slice(-JOINED_MAX) } : {}),
	};
	if (!was) {
		delete store.final.stays;
	}
	pushChange(store, {
		ts: now,
		kind: "finalSuspend",
		from: store.override,
		to: store.override,
		reason: `final phase suspended (${reason})`,
		runs: store.runs.length + store.spikes.length,
		gainSec: 0,
		trigger: key,
	});
	return was;
}

/**
 * Use the suspended final phase again in the store (Spec A.3 point 6, D.5): every split run is cleared (the runs
 * judged `finalSplit` stay in `joined`), state from the values in use, change entry.
 *
 * @param store - Store with a suspended final phase
 * @param why - Reason (`user`, `repair`, `endOk`, …)
 * @param now - Time
 * @param on - Whether the values in use have a final phase
 * @param key - Key of the run (optional)
 */
export function markFinalResumed(store: StoreFile, why: string, now: number, on: boolean, key?: string): void {
	const final = store.final ?? { state: "off", splits: [], suspendedAt: 0 };
	const next: FinalState = { ...final, state: on ? "on" : "off", splits: [], suspendedAt: 0 };
	delete next.reason;
	delete next.stays;
	store.final = next;
	pushChange(store, {
		ts: now,
		kind: "finalResume",
		from: store.override,
		to: store.override,
		reason: `final phase used again (${why})`,
		runs: store.runs.length + store.spikes.length,
		gainSec: 0,
		...(key ? { trigger: key } : {}),
	});
}

/** Expensive step of an optimisation job (Spec D.3 budget). */
export type JobStep = "tighten" | "final" | "phases";

/** Result of a finished unit of an expensive step (key and JSON value). */
export interface JobUnit {
	/** Key of the unit. */
	k: string;
	/** Result. */
	v: unknown;
}

/** Progress of an expensive step stopped by the time budget. */
export interface JobProgress {
	/** Step that goes on (the steps before it in `JOB_STEPS` are done in this round). */
	step: JobStep;
	/** Finished units of the step. */
	cursor: number;
	/** Time the round of the steps began. */
	startedTs: number;
	/** Hash of the values the step works with: other values start it again. */
	basis?: string;
	/** Results of the finished units. */
	memo?: JobUnit[];
}

/** Fine tuning of the phases in the store (Spec D.6). */
export interface PhaseTuneState {
	/** `phaseTuneBase` of the phase model of the device it belongs to (another model drops it). */
	base: string;
	/** Proposal of the last check (hysteresis: taken over when the next one is equal). */
	last?: PhaseTuneProposal;
	/** Limits in use (absolute values), if the tuning was taken over. */
	applied?: PhaseTuneProposal;
	/** Agreement of the cross-check of the limits in use. */
	agreement?: number;
	/** A new phase was found (the hint is given once). */
	newPattern?: boolean;
}

/** Learning data of one device. */
export interface StoreFile {
	/** Format version. */
	v: 1;
	/** Write counter. */
	seq: number;
	/** Device id. */
	deviceId: string;
	/** Template id of the device when the store was created (informational, not compared). */
	typeId: string;
	/** Hash of the detection values of the device (`typeHash`). */
	typeHash: string;
	/** Poll interval in ms. */
	step: number;
	/** Factor from the unit of the state to W. */
	unitFactor: number;
	/** Stored runs (oldest first). */
	runs: StoredRun[];
	/** Stored false starts (oldest first). */
	spikes: StoredRun[];
	/** Capture of a run in progress (persisted at the end of a run). */
	pending: Capture | null;
	/** Extremes of all runs. */
	envelope: Envelope;
	/** Optimised values (differences to the detection values of the device), or null. */
	override: Partial<DetectionSettings> | null;
	/** Last changes (oldest first). */
	changes: Change[];
	/** No tightening before this time. */
	lockUntilTs: number;
	/** No tightening before this many more trusted runs. */
	lockRuns: number;
	/** Time of the last change. */
	lastChangeTs: number;
	/** Trusted runs since the last change. */
	newSinceChange: number;
	/** Trusted runs in a row that the current values do not detect and no repair covers. */
	failStreak: number;
	/** Next free family id. */
	nextFamily: number;
	/** Status. */
	info: OptimizeInfo;
	/** Decisions of the user per run key (only those; the stages of the run check are computed again). */
	verdicts: Record<string, Decision>;
	/** Base bands and hold time profile (unit of the state). */
	bands?: BaseBands;
	/** Tail of the admitted runs. */
	tail?: StoreTail;
	/** Final phase. */
	final?: FinalState;
	/**
	 * Last completed search of an expensive step (time and signature of its input): the same input is not searched
	 * again, a cross-check (final phase, phases) at most once a day and only with new admitted runs (Spec D.3).
	 */
	checks?: Partial<Record<JobStep, { ts: number; sig: string }>>;
	/** Fine tuning of the phases (Spec D.6). */
	phaseTune?: PhaseTuneState;
	/** Envelope of a store before V5, frozen at the first load: the envelope is never narrower. */
	legacyEnvelope?: Envelope;
	/** Progress of an expensive step of the optimisation stopped by the time budget (Spec D.3). */
	job?: JobProgress;
	/** Revision of the layout of the stored runs. */
	layoutRev?: number;
	/** Time of the last poll (for an outage of more than an hour). */
	lastSeenTs?: number;
	/** Time the history was read when the optimisation started (also without runs). */
	historyReadTs?: number;
	/** Keys of the runs in quarantine that got their hint already (Spec B.3: each run once). */
	hinted?: string[];
}

/** Base detection fields (thresholds, mode, pause protection, anti-crease filter). */
export const BASE_KEYS = [
	"startVal",
	"endVal",
	"standby",
	"startCount",
	"endCount",
	"mode",
	"startDurationSec",
	"endDurationSec",
	"pauseHoldSec",
	"pauseUntilSec",
	"pauseBelowVal",
	"trailerBurstSec",
	"trailerGapSec",
	"trailerAfterSec",
	"trailerBlockVal",
	"trailerMaxSec",
] as const;

/** All detection fields: the base fields and the fields of the final phase. */
export const DETECTION_KEYS = [...BASE_KEYS, ...FINAL_KEYS] as const;

/** One base detection field. */
export type BaseKey = (typeof BASE_KEYS)[number];

/** One detection field. */
export type DetectionKey = (typeof DETECTION_KEYS)[number];

/**
 * Detection fields of a type with every optional field filled in (0).
 *
 * @param t - Type or settings
 */
export function detectionOf(t: DetectionSettings): DetectionSettings {
	const out: DetectionSettings = {
		startVal: t.startVal,
		endVal: t.endVal,
		standby: t.standby,
		startCount: t.startCount,
		endCount: t.endCount,
		mode: t.mode,
		startDurationSec: t.startDurationSec,
		endDurationSec: t.endDurationSec,
		pauseHoldSec: t.pauseHoldSec ?? 0,
		pauseUntilSec: t.pauseUntilSec ?? 0,
		pauseBelowVal: t.pauseBelowVal ?? 0,
		trailerBurstSec: t.trailerBurstSec ?? 0,
		trailerGapSec: t.trailerGapSec ?? 0,
		trailerAfterSec: t.trailerAfterSec ?? 0,
		trailerBlockVal: t.trailerBlockVal ?? 0,
		trailerMaxSec: t.trailerMaxSec ?? 0,
	};
	for (const k of FINAL_KEYS) {
		out[k] = t[k] ?? 0;
	}
	return out;
}

/**
 * FNV-1a hash of the detection values: the base fields as before, each final phase field only when
 * it is not 0 (appended as `|name=value`), so the hashes of existing values stay the same.
 *
 * @param t - Type or settings
 */
export function typeHash(t: DetectionSettings): string {
	const d = detectionOf(t);
	let text = JSON.stringify(BASE_KEYS.map(k => d[k]));
	for (const k of FINAL_KEYS) {
		const v = d[k] ?? 0;
		if (v !== 0) {
			text += `|${k}=${v}`;
		}
	}
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** Empty envelope. */
export function emptyEnvelope(): Envelope {
	return { maxPauseSec: 0, maxBurstSec: 0, maxTrailSec: 0, maxTrailerSec: 0, minRunW: 0, minCoreSec: 0, n: 0 };
}

/**
 * New empty store.
 *
 * @param deviceId - Device id
 * @param typeId - Template id of the device (informational)
 * @param hash - Hash of the detection values of the device
 * @param step - Poll interval in ms
 * @param unitFactor - Factor from the unit of the state to W
 */
export function emptyStore(
	deviceId: string,
	typeId: string,
	hash: string,
	step: number,
	unitFactor: number,
): StoreFile {
	return {
		v: STORE_VERSION,
		seq: 0,
		deviceId,
		typeId,
		typeHash: hash,
		step,
		unitFactor,
		runs: [],
		spikes: [],
		pending: null,
		envelope: emptyEnvelope(),
		override: null,
		changes: [],
		lockUntilTs: 0,
		lockRuns: 0,
		lastChangeTs: 0,
		newSinceChange: 0,
		failStreak: 0,
		nextFamily: 0,
		info: {
			status: "collecting",
			runs: 0,
			spikes: 0,
			families: 0,
			trailer: "none",
			lastCheckTs: 0,
			nextPossibleTs: 0,
			lastEndDelaySec: 0,
			unclear: 0,
		},
		verdicts: {},
		legacyEnvelope: emptyEnvelope(),
		layoutRev: LAYOUT_REV,
	};
}

/**
 * File name of a slot.
 *
 * @param deviceId - Device id
 * @param slot - Slot
 */
function slotName(deviceId: string, slot: "a" | "b"): string {
	return `${deviceId}.${slot}.json`;
}

function isStore(val: unknown, deviceId: string): val is StoreFile {
	if (typeof val !== "object" || val === null) {
		return false;
	}
	const s = val as Partial<StoreFile>;
	return (
		s.v === STORE_VERSION &&
		s.deviceId === deviceId &&
		typeof s.seq === "number" &&
		Array.isArray(s.runs) &&
		Array.isArray(s.spikes) &&
		Array.isArray(s.changes) &&
		typeof s.envelope === "object"
	);
}

/**
 * Load the newest valid slot of a device (null: no learning data). Throws if a file cannot be read.
 *
 * @param io - Files
 * @param deviceId - Device id
 * @param log - Logger
 */
export async function loadStore(
	io: FileIO,
	deviceId: string,
	log: Pick<ioBroker.Logger, "warn" | "debug">,
): Promise<StoreFile | null> {
	let best: StoreFile | null = null;
	for (const slot of ["a", "b"] as const) {
		// a missing file reads as null; any other read error is thrown, so that a store that exists
		// but cannot be read right now is not taken for an empty one (and then overwritten)
		const text = await io.read(slotName(deviceId, slot));
		if (text === null) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(text);
			if (!isStore(parsed, deviceId)) {
				log.warn(`Learning data ${slotName(deviceId, slot)} ignored: unknown format`);
				continue;
			}
			if (!best || parsed.seq > best.seq) {
				best = parsed;
			}
		} catch (err) {
			log.warn(`Learning data ${slotName(deviceId, slot)} ignored: ${errorMessage(err)}`);
		}
	}
	if (best) {
		best.nextFamily ??= Math.max(0, ...best.runs.map(r => r.family + 1));
		try {
			best.pending = decodePending(best.pending);
		} catch (err) {
			log.warn(`Learning data of ${deviceId}: capture of the last run ignored: ${errorMessage(err)}`);
			best.pending = null;
		}
	}
	return best;
}

/** Capture of a run in progress as stored in the file (cells encoded like a stored run). */
interface StoredCapture extends Omit<Capture, "cells" | "rep"> {
	/** Quantisation factor. */
	q: number;
	/** Encoded cells. */
	data: string;
	/** Report times as differences (the first one to `t0`). */
	rep?: number[];
}

/**
 * Times as differences to the time before (the first one as is).
 *
 * @param times - Times (ascending)
 */
export function toDiffs(times: readonly number[]): number[] {
	return times.map((t, i) => (i === 0 ? t : t - times[i - 1]));
}

/**
 * Times from differences written by `toDiffs`, or undefined if the value is not a list of numbers.
 *
 * @param diffs - Value read from the file
 */
export function fromDiffs(diffs: unknown): number[] | undefined {
	if (!Array.isArray(diffs) || !diffs.every(d => typeof d === "number" && Number.isFinite(d))) {
		return undefined;
	}
	const times: number[] = [];
	for (const d of diffs as number[]) {
		times.push(times.length === 0 ? d : (times.at(-1) as number) + d);
	}
	return times;
}

/**
 * Encode a capture for the file.
 *
 * @param c - Capture
 */
export function encodePending(c: Capture): StoredCapture {
	const q = quantOf(c.unitFactor);
	const out: StoredCapture = {
		t0: c.t0,
		stepMs: c.stepMs,
		unitFactor: c.unitFactor,
		ev: c.ev,
		postTruncated: c.postTruncated,
		q,
		data: encodeCells(c.cells, q),
	};
	if (c.rep) {
		out.rep = toDiffs(c.rep);
	}
	return out;
}

/**
 * `decodePending` for tests.
 *
 * @param raw - Value of `pending` in the file
 */
export function decodePendingForTest(raw: unknown): Capture | null {
	return decodePending(raw);
}

/**
 * Decode a capture read from the file.
 *
 * @param raw - Value of `pending` in the file
 */
function decodePending(raw: unknown): Capture | null {
	if (raw === null || raw === undefined) {
		return null;
	}
	const c = raw as Partial<StoredCapture>;
	if (
		typeof c.data !== "string" ||
		typeof c.q !== "number" ||
		typeof c.t0 !== "number" ||
		typeof c.stepMs !== "number" ||
		typeof c.unitFactor !== "number" ||
		!Array.isArray(c.ev)
	) {
		throw new Error("unknown format");
	}
	const out: Capture = {
		t0: c.t0,
		stepMs: c.stepMs,
		unitFactor: c.unitFactor,
		ev: c.ev,
		postTruncated: c.postTruncated === true,
		cells: decodeCells(c.data, c.q),
	};
	const rep = fromDiffs(c.rep);
	if (rep) {
		out.rep = rep;
	}
	return out;
}

/**
 * The store as written to the file (the capture of a run in progress encoded).
 *
 * @param store - Store
 */
export function serializeStore(store: StoreFile): string {
	return JSON.stringify(store.pending ? { ...store, pending: encodePending(store.pending) } : store);
}

/**
 * Save the store into the older slot (the other slot keeps the previous version).
 *
 * @param io - Files
 * @param store - Store (seq is increased)
 */
export async function saveStore(io: FileIO, store: StoreFile): Promise<void> {
	store.seq++;
	await io.write(slotName(store.deviceId, store.seq % 2 === 0 ? "a" : "b"), serializeStore(store));
}

/**
 * Delete both slots of a device.
 *
 * @param io - Files
 * @param deviceId - Device id
 */
export async function removeStore(io: FileIO, deviceId: string): Promise<void> {
	await io.remove(slotName(deviceId, "a"));
	await io.remove(slotName(deviceId, "b"));
}

/** Result of comparing the base values of the device with the store. */
export type BaseReconcile = "none" | "adopted" | "baseChanged";

/**
 * Compare the base values of the device with the store (at load and whenever the device configuration changes).
 * If the new base values equal the values in use with the old override (result of "adopt as base values"), the
 * override becomes null without loss (`adopted`); any other change of the base values drops the override
 * (`baseChanged`).
 *
 * @param store - Store
 * @param baseHash - Hash of the new base values of the device
 * @param effectiveHash - Hash of the values in use with the old override (old base values with `store.override`),
 * or null if unknown
 * @param now - Current time
 */
export function reconcileBase(
	store: StoreFile,
	baseHash: string,
	effectiveHash: string | null,
	now: number,
): BaseReconcile {
	if (store.typeHash === baseHash) {
		return "none";
	}
	store.typeHash = baseHash;
	if (store.override && effectiveHash === baseHash) {
		pushChange(store, {
			ts: now,
			kind: "adopted",
			from: store.override,
			to: null,
			reason: "values in use adopted as base values",
			runs: store.runs.length,
			gainSec: 0,
		});
		store.override = null;
		return "adopted";
	}
	if (store.override) {
		pushChange(store, {
			ts: now,
			kind: "baseChanged",
			from: store.override,
			to: null,
			reason: "detection values changed",
			runs: store.runs.length,
			gainSec: 0,
		});
	}
	store.override = null;
	store.failStreak = 0;
	if (store.info.status === "drift") {
		store.info.status = "collecting";
	}
	return "baseChanged";
}

/**
 * Adapt a loaded store to the current detection values, poll interval and unit. Only the hash of the detection
 * values is compared (the template id may differ, e.g. after the migration); other detection values drop the
 * override. Another poll interval or unit converts the stored runs (`convertRuns`). The registry compares the base values with `reconcileBase` before (that also catches up an adoption
 * whose store was not saved any more) and reports the result itself.
 *
 * @param store - Store
 * @param hash - Hash of the current detection values of the device
 * @param step - Current poll interval in ms
 * @param unitFactor - Current unit factor
 * @param now - Current time
 * @returns messages for the log (English)
 */
export function reconcileStore(
	store: StoreFile,
	hash: string,
	step: number,
	unitFactor: number,
	now: number,
): string[] {
	const msgs: string[] = [];
	const hadOverride = store.override !== null;
	if (reconcileBase(store, hash, null, now) === "baseChanged" && hadOverride) {
		msgs.push("detection values changed, optimised values discarded");
	}
	msgs.push(...convertRuns(store, step, unitFactor));
	refreshInfo(store);
	return msgs;
}

/**
 * Append a change. At most MAX_CHANGES are kept: entries whose triggering run is still stored and the last change of
 * the base values (`adopted`/`baseChanged`, the limit of undo) stay; the oldest other entry goes first.
 *
 * @param store - Store
 * @param c - Change
 */
export function pushChange(store: StoreFile, c: Change): void {
	store.changes.push(c);
	while (store.changes.length > MAX_CHANGES) {
		const keys = [...store.runs, ...store.spikes].map(r => r.key);
		let lastBase = -1;
		store.changes.forEach((x, i) => {
			if (x.kind === "adopted" || x.kind === "baseChanged" || x.kind === "typeChanged") {
				lastBase = i;
			}
		});
		const kept = (x: Change, i: number): boolean =>
			i === lastBase ||
			(x.trigger !== undefined && keys.some(k => k === x.trigger || sameRun(k, x.trigger ?? "")));
		const victim = store.changes.findIndex((x, i) => !kept(x, i));
		store.changes.splice(victim >= 0 ? victim : 0, 1);
	}
}

/**
 * Counters of the status.
 *
 * @param store - Store
 */
export function refreshInfo(store: StoreFile): void {
	store.info.runs = store.runs.length;
	store.info.spikes = store.spikes.length;
	store.info.families = new Set(store.runs.map(r => r.family)).size;
	store.info.excluded = [...store.runs, ...store.spikes].filter(
		r => decisionOf(store, r.key)?.user === "exclude",
	).length;
}

/** Result of labelling a capture. */
export interface LabelResult {
	/** Classification ("unclear" is not stored). */
	label: RunLabel | "unclear";
	/** Stored run, or null for "unclear". */
	run: StoredRun | null;
	/** Delay from the programme end to the reported end in s, or null. */
	endDelaySec: number | null;
	/** Whether the run may be used for tightening. */
	trusted: boolean;
}

/** Options of `labelCapture`. */
export interface LabelOptions {
	/**
	 * The capture is a part of a split capture followed by another part (`splitCapture`): it ends at a rest or at an
	 * early end, so the time after the programme needs no post-roll of MAX_PAUSE_MS.
	 */
	followed?: boolean;
}

/**
 * Classify a closed capture (or one part of it, `splitCapture`) and turn it into a stored run. `split` means: the
 * run of the capture has two or more reported starts or ends (or none); whether it is a merged run (no detection
 * error, Spec B.2 `merged`) decides the run check after it was stored. The mark `afterFinal` of the first start
 * goes to the stored run.
 *
 * @param c - Capture
 * @param keepAboveW - End threshold of the effective type in W (drying phases above it belong to the run)
 * @param src - Origin
 * @param o - Options
 */
export function labelCapture(
	c: Capture,
	keepAboveW: number,
	src: "live" | "history" = "live",
	o: LabelOptions = {},
): LabelResult {
	const sW = fromCells(c.cells, c.t0, c.stepMs, c.unitFactor);
	const unclear: LabelResult = { label: "unclear", run: null, endDelaySec: null, trusted: false };
	if (sW.points < 20) {
		return unclear;
	}
	const layout = buildLayout(sW, { recording: true, keepAbove: keepAboveW });
	const starts = c.ev.filter(e => e[1] === "s");
	const ends = c.ev.filter(e => e[1] !== "s");
	const mark = starts[0]?.[2];
	const q = quantOf(c.unitFactor);
	const base = {
		id: `${c.t0.toString(36)}${c.ev.length.toString(36)}`,
		ts: c.t0,
		step: c.stepMs,
		q,
		unitFactor: c.unitFactor,
		data: encodeCells(c.cells, q),
		ev: c.ev,
		src,
		postTruncated: c.postTruncated,
		family: -1,
		// set by addRun (the key needs the device id)
		key: "",
		rev: LAYOUT_REV,
		...(c.rep ? { rep: toDiffs(c.rep) } : {}),
		...(mark ? { afterFinal: mark } : {}),
	};
	if (layout.runs.length === 0) {
		if (starts.length === 0) {
			return unclear;
		}
		const sp = layout.spikes.at(-1);
		const from = sp?.from ?? Math.max(0, Math.round((starts[0][0] - c.t0) / c.stepMs));
		const to = sp?.to ?? from;
		const run: StoredRun = {
			...base,
			label: "spike",
			seg: {
				startIdx: from,
				coreEndIdx: to,
				runEndIdx: to,
				trailerFrom: null,
				trailerTo: null,
				progEndIdx: to,
				runLimit: layout.runLimit,
			},
			feat: {
				coreSec: 0,
				energyWh: 0,
				hiShare: 0,
				maxPauseSec: 0,
				nPause: 0,
				trailer: false,
				blockMean: 0,
				burstMaxSec: ((sp ? sp.to - sp.from : 0) + 1) * (c.stepMs / 1000),
				trailerSec: 0,
				minRunW: 0,
				trailerGapMaxSec: 0,
				trailerGapMinSec: 0,
				burstMaxW: 0,
				endBlockMinW: 0,
			},
		};
		return { label: "spike", run, endDelaySec: null, trusted: false };
	}
	if (layout.runs.length > 1) {
		return unclear;
	}
	const r = layout.runs[0];
	const startT = c.t0 + r.from * c.stepMs;
	const coreEndT = c.t0 + r.runEnd * c.stepMs;
	const run: StoredRun = {
		...base,
		label: "run",
		seg: {
			startIdx: r.from,
			coreEndIdx: r.coreEnd,
			runEndIdx: r.runEnd,
			trailerFrom: r.trailerFrom,
			trailerTo: r.trailerTo,
			progEndIdx: r.progEnd,
			runLimit: layout.runLimit,
		},
		feat: featuresOf(sW, r, layout.runLimit),
	};
	const firstEnd = ends.find(e => e[0] >= startT);
	const endDelaySec = firstEnd ? Math.round((firstEnd[0] - coreEndT) / 1000) : null;
	if (starts.length >= 2 || ends.length >= 2 || ends.length === 0) {
		return { label: "split", run: { ...run, label: "split" }, endDelaySec, trusted: false };
	}
	const startOk = Math.abs(starts[0][0] - startT) <= START_MATCH_MS;
	let valid = true;
	for (let i = r.from; i <= r.runEnd; i++) {
		if (sW.valid[i] === 0) {
			valid = false;
			break;
		}
	}
	const postOk = (c.cells.length - 1 - r.runEnd) * c.stepMs >= POST_ROLL_MS || c.postTruncated || o.followed === true;
	if (!startOk || !valid || !postOk) {
		return unclear;
	}
	return { label: "run", run, endDelaySec, trusted: !c.postTruncated };
}

/** One part of a capture (`splitCapture`). */
export interface CapturePart {
	/** Cells, events and report times of the part. */
	capture: Capture;
	/** Events of the part (the same as `capture.ev`). */
	ev: CaptureEntry[];
	/** Another part follows (the part ends at a rest or at an early end). */
	followed: boolean;
}

/**
 * Ticks of a capture in W (NaN: invalid).
 *
 * @param c - Capture
 */
function wattsOf(c: Capture): number[] {
	return c.cells.map(x => (x.valid && Number.isFinite(x.last) ? x.last * c.unitFactor : Number.NaN));
}

/**
 * Level after the end of a capture in W: the end of a capture is its quiet time after the last run (like the idle
 * level of the recording layout: the lower of the median of the last 10 % and the last value).
 *
 * @param w - Ticks in W
 */
function idleOfCapture(w: readonly number[]): number {
	const valid = w.filter(x => Number.isFinite(x));
	if (valid.length === 0) {
		return 0;
	}
	const tail = valid.slice(-Math.max(3, Math.ceil(valid.length * 0.1)));
	return Math.max(0, Math.min(median(tail), tail.at(-1) ?? 0));
}

/**
 * Levels of the pauses inside the reported runs of a capture in W: stretches at or below the run level that are
 * shorter than a rest (SPLIT_GAP_MIN_MS), each by its median.
 *
 * @param c - Capture
 * @param w - Ticks in W
 * @param runLimit - Run level in W
 * @param idxOf - Cell index of a time
 * @param need - Ticks of a rest
 */
function pauseLevels(
	c: Capture,
	w: readonly number[],
	runLimit: number,
	idxOf: (t: number) => number,
	need: number,
): number[] {
	const out: number[] = [];
	let runFrom: number | null = null;
	for (const e of c.ev) {
		if (e[1] === "s") {
			runFrom ??= idxOf(e[0]);
			continue;
		}
		if (runFrom === null) {
			continue;
		}
		const to = idxOf(e[0]);
		let k = runFrom;
		while (k <= to) {
			if (Number.isFinite(w[k]) && w[k] <= runLimit) {
				const from = k;
				while (k <= to && Number.isFinite(w[k]) && w[k] <= runLimit) {
					k++;
				}
				if (k - from < need) {
					out.push(median(w.slice(from, k)));
				}
			} else {
				k++;
			}
		}
		runFrom = null;
	}
	return out;
}

/**
 * Split a capture into its runs (Spec B.2 "Live-Aufnahme und gespeicherte Läufe"): a capture stays open after an
 * end, and a start meanwhile extends it, so two real runs shortly one after the other end up in one capture. It is
 * split between a reported end and the next start where the device rests at its level after an end for at least
 * SPLIT_GAP_MIN_MS (as `splitGrown` of the history only if the pauses inside the runs are clearly below or above
 * that level; otherwise a long pause inside a programme would split it and the split run would be hidden), and in
 * addition at every start with the mark `afterFinal` (there at the rest, otherwise right after the early end, so
 * that the part after it holds the time between the parts). Each part after a cut begins with the start of the cut and
 * keeps the events up to the next one; report times go to the part of their time.
 * Without a split point the capture is the only part.
 *
 * @param c - Closed capture
 */
export function splitCapture(c: Capture): CapturePart[] {
	const n = c.cells.length;
	const step = c.stepMs;
	const whole: CapturePart[] = [{ capture: c, ev: c.ev, followed: false }];
	if (n === 0 || c.ev.filter(e => e[1] === "s").length < 2) {
		return whole;
	}
	const w = wattsOf(c);
	const idle = idleOfCapture(w);
	const runLimit = idle * 3 + 2;
	const idxOf = (t: number): number => Math.max(0, Math.min(n - 1, Math.round((t - c.t0) / step)));
	const need = Math.ceil(SPLIT_GAP_MIN_MS / step);
	const pauses = pauseLevels(c, w, runLimit, idxOf, need);
	// pauses clearly below the level after an end (or none seen), or clearly above it
	const below = pauses.length === 0 || quantile(pauses, 0.9) * 1.5 + LEVEL_SEP_W < idle * 0.8;
	const above = pauses.length > 0 && quantile(pauses, 0.1) > idle * 1.5 + LEVEL_SEP_W;
	const lo = pauses.length > 0 && below ? 0.8 * idle : Number.NEGATIVE_INFINITY;
	const hi = 1.25 * idle + 0.1;
	const atRest = (k: number): boolean => (below || above) && Number.isFinite(w[k]) && w[k] >= lo && w[k] <= hi;

	const cuts: number[] = [];
	// index into c.ev of the start that begins the part after each cut
	const firstEv: number[] = [];
	let lastEnd: CaptureEntry | null = null;
	for (const [j, e] of c.ev.entries()) {
		if (e[1] !== "s") {
			lastEnd = e;
			continue;
		}
		if (!lastEnd) {
			continue;
		}
		const iE = idxOf(lastEnd[0]);
		const iS = idxOf(e[0]);
		lastEnd = null;
		// the longest rest between the end and the start
		let best: { from: number; len: number } | null = null;
		let k = iE + 1;
		while (k < iS) {
			if (atRest(k)) {
				const from = k;
				while (k < iS && atRest(k)) {
					k++;
				}
				if (!best || k - from > best.len) {
					best = { from, len: k - from };
				}
			} else {
				k++;
			}
		}
		let cut: number | null = null;
		if (best && best.len >= need) {
			cut = best.from + Math.floor(best.len / 2);
		} else if (e[2] !== undefined) {
			cut = iE + 1;
		}
		if (cut !== null && cut > (cuts.at(-1) ?? 0) && cut < n) {
			cuts.push(cut);
			firstEv.push(j);
		}
	}
	if (cuts.length === 0) {
		return whole;
	}
	const bounds = [0, ...cuts, n];
	const evBounds = [0, ...firstEv, c.ev.length];
	const parts: CapturePart[] = [];
	for (let p = 0; p + 1 < bounds.length; p++) {
		const from = bounds[p];
		const to = bounds[p + 1];
		const first = p === 0;
		const last = p + 2 === bounds.length;
		const t0 = c.t0 + from * step;
		// by order, not by time: a start dated back to the early end has the time of that end
		const ev = c.ev.slice(evBounds[p], evBounds[p + 1]);
		const capture: Capture = {
			t0,
			stepMs: step,
			unitFactor: c.unitFactor,
			cells: c.cells.slice(from, to),
			ev,
			postTruncated: last ? c.postTruncated : false,
		};
		if (c.rep) {
			// a report belongs to the cell of the next poll
			const lowRep = (from - 1) * step;
			const highRep = (to - 1) * step;
			capture.rep = c.rep.filter(t => (first || t > lowRep) && (last || t <= highRep)).map(t => t - from * step);
		}
		parts.push({ capture, ev, followed: !last });
	}
	return parts;
}

/** Exits of the lock phase after which the run is judged afterwards (exit a: the inner detector ended itself). */
const JUDGED_EXITS: readonly FinalExit[] = ["b", "c", "d", "e", "f", "g"];

/** A run after an early end with its early part, for the judgement afterwards (`checkFinalSplit`). */
export interface FinalSplitPair {
	/** Key of the run after the early end (its start). */
	key: string;
	/** Exit of the lock phase. */
	exit: FinalExit;
	/** Early part: run start to the early end. */
	prev: RunSample;
	/** Run after the early end, with the stored values from the early end on. */
	next: RunSample;
}

/**
 * Sample of one part of a capture for `checkFinalSplit`: the changes of the held value on the poll grid (unit of the
 * state) from `fromMs` (with the value held there), the part from `startMs` to `endMs`.
 *
 * @param c - Capture
 * @param key - Key
 * @param fromMs - Begin of the stored values
 * @param startMs - Start
 * @param endMs - End
 * @param exit - Mark of the start
 */
function partSample(
	c: Capture,
	key: string,
	fromMs: number,
	startMs: number,
	endMs: number,
	exit?: FinalExit,
): RunSample {
	const points: { ts: number; val: number }[] = [];
	c.cells.forEach((x, i) => {
		const ts = c.t0 + i * c.stepMs;
		if (!x.valid || ts > endMs) {
			return;
		}
		if (ts <= fromMs) {
			// the value held at the begin
			points[0] = { ts: fromMs, val: x.last };
			return;
		}
		if (points.length === 0 || points[points.length - 1].val !== x.last) {
			points.push({ ts, val: x.last });
		}
	});
	return {
		points,
		from: fromMs,
		to: endMs,
		key,
		kind: "run",
		src: "live",
		info: null,
		family: -1,
		...(exit ? { afterFinal: exit } : {}),
		starts: [startMs],
		facts: {
			start: startMs,
			coreEnd: endMs,
			progEnd: endMs,
			runEnd: endMs,
			end: endMs,
			coreSec: (endMs - startMs) / 1000,
			feat: null,
			offSec: null,
			preLevel: null,
			postLevel: null,
			restLevel: null,
			endBlocks: [],
			invalidShare: 0,
			timeJumps: 0,
		},
	};
}

/**
 * Runs of a capture that started after an early end of the final phase (mark `afterFinal` b–g) and have ended
 * since, each with its early part (Spec A.3 "Beurteilung im Nachhinein"): the early part runs from the start before
 * the early end to the early end, the run after it holds the values from the early end to its end.
 *
 * @param c - Capture (closed, or a snapshot of the open one)
 * @param deviceId - Device id (keys)
 */
export function finalSplitPairs(c: Capture, deviceId: string): FinalSplitPair[] {
	const out: FinalSplitPair[] = [];
	c.ev.forEach((e, k) => {
		const exit = e[2];
		if (e[1] !== "s" || exit === undefined || !JUDGED_EXITS.includes(exit)) {
			return;
		}
		const before = c.ev.slice(0, k);
		const early = before.findLast(x => x[1] !== "s");
		const done = c.ev.slice(k + 1).find(x => x[1] !== "s");
		if (!early || !done) {
			return;
		}
		const begin = before.findLast(x => x[1] === "s" && x[0] <= early[0]);
		const startMs = begin ? begin[0] : c.t0;
		const key = verdictKey(deviceId, e[0]);
		out.push({
			key,
			exit,
			prev: partSample(c, verdictKey(deviceId, startMs), startMs - c.stepMs, startMs, early[0]),
			next: partSample(c, key, early[0], e[0], done[0], exit),
		});
	});
	return out;
}

/** The rest of a split programme starts at most this long after the early end (as in `splitPairs` of the tests). */
const SPLIT_WITHIN_MS = 3 * 60 * 60_000;

/**
 * A capture whose first start comes after an early end of the final phase (mark `afterFinal` b–g) without that early
 * end in the capture itself, joined with the stored run before it: a rest of more than 30 quiet minutes (e.g.
 * soaking) closed the capture of the early part, which is stored as a run of its own. Null when the capture holds its
 * early end itself or no stored run ends with an end at most 3 h before (then nothing is judged).
 *
 * @param store - Store
 * @param c - Capture (closed, or a snapshot of the open one)
 */
export function joinedCapture(store: StoreFile, c: Capture): Capture | null {
	const first = c.ev.find(e => e[1] === "s");
	if (!first || first[2] === undefined || !JUDGED_EXITS.includes(first[2])) {
		return null;
	}
	if (c.ev.some(e => e[1] !== "s" && e[0] < first[0])) {
		return null;
	}
	const prev = store.runs
		.filter(r => typeof r.data === "string" && r.step === c.stepMs && r.unitFactor === c.unitFactor && r.ts < c.t0)
		.sort((a, b) => b.ts - a.ts)[0];
	const last = prev?.ev.at(-1);
	if (!prev || !last || last[1] === "s" || first[0] - last[0] > SPLIT_WITHIN_MS) {
		return null;
	}
	const cells = decodeCells(prev.data as string, prev.q);
	// the pre-roll of a capture is the end of the one before: overlapping cells come from the newer capture
	const gap = Math.round((c.t0 - (prev.ts + cells.length * prev.step)) / c.stepMs);
	const head = gap >= 0 ? [...cells, ...new Array<TickCell>(gap).fill(cells[cells.length - 1])] : cells.slice(0, gap);
	return {
		t0: prev.ts,
		stepMs: c.stepMs,
		unitFactor: c.unitFactor,
		cells: [...head, ...c.cells],
		ev: [...prev.ev.filter(e => !c.ev.some(x => x[0] === e[0] && x[1] === e[1])), ...c.ev].sort(
			(a, b) => a[0] - b[0],
		),
		postTruncated: c.postTruncated,
	};
}

/**
 * Extremes of a set of runs.
 *
 * @param runs - Runs
 * @param spikes - False starts
 */
export function envelopeOf(runs: readonly StoredRun[], spikes: readonly StoredRun[]): Envelope {
	const env = emptyEnvelope();
	for (const r of runs) {
		addEnd(env, r);
		addTrailer(env, r);
	}
	for (const s of spikes) {
		env.maxBurstSec = Math.max(env.maxBurstSec, s.feat.burstMaxSec);
	}
	return env;
}

/**
 * Add the pause, power and duration of a run to an envelope (counts the run).
 *
 * @param env - Envelope
 * @param r - Run
 */
function addEnd(env: Envelope, r: StoredRun): void {
	env.maxPauseSec = Math.max(env.maxPauseSec, r.feat.maxPauseSec);
	env.minRunW = env.minRunW === 0 ? r.feat.minRunW : Math.min(env.minRunW, r.feat.minRunW);
	env.minCoreSec = env.minCoreSec === 0 ? r.feat.coreSec : Math.min(env.minCoreSec, r.feat.coreSec);
	env.n++;
}

/**
 * Add the trailer of a run to an envelope.
 *
 * @param env - Envelope
 * @param r - Run
 */
function addTrailer(env: Envelope, r: StoredRun): void {
	env.maxBurstSec = Math.max(env.maxBurstSec, r.feat.burstMaxSec);
	env.maxTrailSec = Math.max(env.maxTrailSec, r.feat.trailerGapMaxSec ?? 0);
	env.maxTrailerSec = Math.max(env.maxTrailerSec, r.feat.trailerSec);
}

/**
 * Merge two envelopes (the result is never narrower than either).
 *
 * @param a - Known envelope
 * @param b - New extremes
 */
export function mergeEnvelope(a: Envelope, b: Envelope): Envelope {
	const lo = (x: number, y: number): number => (x === 0 ? y : y === 0 ? x : Math.min(x, y));
	return {
		maxPauseSec: Math.max(a.maxPauseSec, b.maxPauseSec),
		maxBurstSec: Math.max(a.maxBurstSec, b.maxBurstSec),
		maxTrailSec: Math.max(a.maxTrailSec, b.maxTrailSec),
		maxTrailerSec: Math.max(a.maxTrailerSec, b.maxTrailerSec),
		minRunW: lo(a.minRunW, b.minRunW),
		minCoreSec: lo(a.minCoreSec, b.minCoreSec),
		n: Math.max(a.n, b.n),
	};
}

const ENVELOPE_KEYS = ["maxPauseSec", "maxBurstSec", "maxTrailSec", "maxTrailerSec", "minRunW", "minCoreSec"] as const;

/**
 * Decision of the user about a run: by its key, otherwise by a key of the same run (live ↔ history, ±5 min).
 *
 * @param store - Store
 * @param key - Key of the run
 */
export function decisionOf(store: StoreFile, key: string): Decision | undefined {
	const all = store.verdicts ?? {};
	const exact = all[key];
	if (exact || key === "") {
		return exact;
	}
	const near = Object.keys(all).find(k => sameRun(k, key));
	return near === undefined ? undefined : all[near];
}

/**
 * Set or remove the decision of the user about a run.
 *
 * @param store - Store
 * @param key - Key of the run
 * @param user - Decision, or null to remove it
 * @param reason - Reason (optional)
 */
export function setDecision(store: StoreFile, key: string, user: "include" | "exclude" | null, reason?: string): void {
	store.verdicts ??= {};
	if (user === null) {
		delete store.verdicts[key];
		return;
	}
	store.verdicts[key] = reason ? { user, reason } : { user };
}

/**
 * Whether a stored run can be replayed: it has cells and the user did not exclude it.
 *
 * @param store - Store
 * @param r - Run
 */
export function inUse(store: StoreFile, r: StoredRun): boolean {
	return typeof r.data === "string" && decisionOf(store, r.key)?.user !== "exclude";
}

/** What a stored run counts for in the envelope and the tail. */
interface RunUse {
	/** Excluded by the user. */
	excluded: boolean;
	/** Pause, power and duration (and the end criterion). */
	end: boolean;
	/** Trailer extremes. */
	trailer: boolean;
	/** Burst of a false start. */
	start: boolean;
}

/**
 * What every stored run counts for: the decision of the user and, if known, the automatic verdict (`admitted`).
 * Without a verdict only the decisions count. A merged run counts for none of the statistics (Spec B.2), a run
 * converted to a finer grid not for the trailer.
 *
 * @param store - Store
 * @param verdicts - Verdicts by key (`recompute`), or undefined
 */
function usesOfStore(store: StoreFile, verdicts?: ReadonlyMap<string, Verdict>): Map<StoredRun, RunUse> {
	const out = new Map<StoredRun, RunUse>();
	for (const r of [...store.runs, ...store.spikes]) {
		const d = decisionOf(store, r.key);
		const v = verdicts?.get(r.key);
		const ok = (purpose: keyof Uses): boolean => (v ? admitted({ ...v, user: d?.user }, purpose) : true);
		const excluded = d?.user === "exclude";
		const merged = v?.reasons.some(x => x.code === "merged") === true;
		const end = !excluded && !merged && ok("end");
		out.set(r, {
			excluded,
			end,
			trailer: end && r.gridFrom === undefined && ok("trailer"),
			start: !excluded && ok("start"),
		});
	}
	return out;
}

/**
 * Envelope of the runs that count (without the frozen envelope of before V5).
 *
 * @param store - Store
 * @param use - What the runs count for
 * @param skip - Run to leave out
 */
function envelopeWith(store: StoreFile, use: ReadonlyMap<StoredRun, RunUse>, skip?: StoredRun): Envelope {
	const env = emptyEnvelope();
	for (const r of store.runs) {
		const u = use.get(r);
		if (r === skip || !u?.end) {
			continue;
		}
		addEnd(env, r);
		if (u.trailer) {
			addTrailer(env, r);
		}
	}
	for (const s of store.spikes) {
		if (s !== skip && use.get(s)?.start) {
			env.maxBurstSec = Math.max(env.maxBurstSec, s.feat.burstMaxSec);
		}
	}
	return env;
}

/**
 * Whether a run counts as boundary run: it alone sets an extreme of the envelope, or it stopped a candidate of the
 * optimisation (`veto`).
 *
 * @param store - Store
 * @param use - What the runs count for
 * @param full - Envelope of all runs that count
 * @param r - Run
 */
function isBoundary(store: StoreFile, use: ReadonlyMap<StoredRun, RunUse>, full: Envelope, r: StoredRun): boolean {
	if (use.get(r)?.excluded) {
		return false;
	}
	if (r.veto !== undefined) {
		return true;
	}
	const rest = envelopeWith(store, use, r);
	return ENVELOPE_KEYS.some(k => rest[k] !== full[k]);
}

/**
 * Keys of the boundary runs (Spec D.2, P23): runs that alone set an extreme of the envelope of the admitted runs,
 * and runs that stopped a candidate of the optimisation (`veto`).
 *
 * @param store - Store
 * @param verdicts - Verdicts by key (`recompute`); without them only the decisions of the user count
 */
export function boundaryRuns(store: StoreFile, verdicts?: ReadonlyMap<string, Verdict>): Set<string> {
	const use = usesOfStore(store, verdicts);
	const full = envelopeWith(store, use);
	const out = new Set<string>();
	for (const r of [...store.runs, ...store.spikes]) {
		if (isBoundary(store, use, full, r)) {
			out.add(r.key);
		}
	}
	return out;
}

/**
 * Compute the envelope again from the admitted runs and the frozen envelope of before V5 (P10): never narrower than
 * `legacyEnvelope`; excluding a run and using it again restores it exactly.
 *
 * @param store - Store
 * @param verdicts - Verdicts by key (`recompute`); without them only the decisions of the user count
 */
export function recomputeEnvelope(store: StoreFile, verdicts?: ReadonlyMap<string, Verdict>): void {
	const own = envelopeWith(store, usesOfStore(store, verdicts));
	store.envelope = mergeEnvelope(store.legacyEnvelope ?? emptyEnvelope(), own);
}

/**
 * Series of a stored run in W (null without cells).
 *
 * @param r - Run
 */
function seriesOf(r: StoredRun): { cells: TickCell[]; s: TickSeries } | null {
	if (typeof r.data !== "string") {
		return null;
	}
	const cells = decodeCells(r.data, r.q);
	return { cells, s: fromCells(cells, r.ts, r.step, r.unitFactor) };
}

/**
 * Compute the tail of the store again (Spec B.4 over the admitted runs) and with it the programme end and the end
 * block of every stored run with cells.
 *
 * @param store - Store
 * @param verdicts - Verdicts by key (`recompute`); without them only the decisions of the user count
 */
export function recomputeTail(store: StoreFile, verdicts?: ReadonlyMap<string, Verdict>): void {
	const use = usesOfStore(store, verdicts);
	const parts: { run: StoredRun; part: TailPart }[] = [];
	for (const r of store.runs) {
		const dec = r.label === "spike" ? null : seriesOf(r);
		if (!dec) {
			continue;
		}
		const g = r.seg;
		parts.push({
			run: r,
			part: {
				s: dec.s,
				r: {
					from: g.startIdx,
					coreEnd: g.coreEndIdx,
					runEnd: g.runEndIdx,
					trailerFrom: g.trailerFrom,
					burstMaxW: r.feat.burstMaxW ?? 0,
					progEnd: g.progEndIdx,
					endBlockFrom: g.coreEndIdx,
					endBlockTo: g.coreEndIdx,
					endBlockMinW: r.feat.endBlockMinW ?? 0,
				},
				runLimit: g.runLimit ?? 0,
			},
		});
	}
	const used = parts.filter(x => use.get(x.run)?.end);
	if (used.length === 0) {
		delete store.tail;
		return;
	}
	const tail = tailRule(used.map(x => x.part));
	for (const x of parts) {
		applyTail(x.part, tail);
		x.run.seg.progEndIdx = x.part.r.progEnd;
		x.run.feat.endBlockMinW = x.part.r.endBlockMinW;
	}
	store.tail = {
		ceil: tail.tailCeil,
		separated: tail.tailSeparated,
		burstMaxW: tail.burstMaxW,
		runLimit: median(used.map(x => x.part.runLimit)),
	};
}

/** A stored run as a sample of the run check. */
export interface StoreSample {
	/** Stored run. */
	run: StoredRun;
	/** Sample. */
	sample: RunSample;
	/** Verdict with the decision of the user applied. */
	verdict: Verdict;
	/** Series in W. */
	series: TickSeries;
}

/**
 * Stored values of a run in the unit of the state: the report times of a history run with the value of their tick,
 * otherwise the changes on the poll grid.
 *
 * @param r - Run
 * @param cells - Decoded cells
 */
function pointsOfStored(r: StoredRun, cells: readonly TickCell[]): { ts: number; val: number }[] {
	const out: { ts: number; val: number }[] = [];
	const rep = r.src === "history" ? fromDiffs(r.rep) : undefined;
	if (rep && rep.length > 0) {
		for (const t of rep) {
			const c = cells[Math.max(0, Math.min(cells.length - 1, Math.ceil(t / r.step)))];
			if (c?.valid) {
				out.push({ ts: r.ts + t, val: c.last });
			}
		}
		return out;
	}
	cells.forEach((c, i) => {
		if (c.valid && (out.length === 0 || out[out.length - 1].val !== c.last)) {
			out.push({ ts: r.ts + i * r.step, val: c.last });
		}
	});
	return out;
}

/**
 * Sample of the run check from a stored run: the layout of its capture with the segmentation and the tail of the
 * store, its key, group, report log and events.
 *
 * @param store - Store
 * @param r - Run with cells
 */
function sampleOfStored(store: StoreFile, r: StoredRun): { sample: RunSample; series: TickSeries } | null {
	const dec = seriesOf(r);
	if (!dec) {
		return null;
	}
	const { cells, s } = dec;
	const points = pointsOfStored(r, cells);
	const g = r.seg;
	const L0 = buildLayout(s, { recording: true, maxRuns: Number.POSITIVE_INFINITY });
	let L: Layout;
	if (r.label === "spike") {
		L = { ...L0, runs: [], spikes: [{ from: g.startIdx, to: g.coreEndIdx }], incomplete: [] };
	} else {
		const best = [...L0.runs].sort((a, b) => Math.abs(a.from - g.startIdx) - Math.abs(b.from - g.startIdx))[0];
		if (best) {
			const info: RunInfo = {
				...best,
				from: g.startIdx,
				coreEnd: g.coreEndIdx,
				runEnd: g.runEndIdx,
				progEnd: g.progEndIdx,
				trailerFrom: g.trailerFrom,
				trailerTo: g.trailerTo,
				to: Math.max(best.to, g.trailerTo ?? g.runEndIdx),
			};
			L = {
				...L0,
				runs: [info],
				spikes: [],
				incomplete: [],
				tailSeparated: store.tail?.separated ?? false,
				burstMaxW: store.tail?.burstMaxW ?? L0.burstMaxW,
				tailCeil: store.tail?.ceil ?? L0.tailCeil,
			};
		} else {
			// the run cannot be laid out any more: it is used for nothing
			L = { ...L0, runs: [], spikes: [], incomplete: [{ from: g.startIdx, to: g.runEndIdx }] };
		}
	}
	const sample = samplesOf(store.deviceId, points, s, L, { src: r.src, unitFactor: r.unitFactor })[0];
	if (!sample) {
		return null;
	}
	sample.key = r.key;
	sample.family = r.label === "spike" ? -1 : r.family;
	if (sample.kind === "run") {
		sample.facts.feat = r.feat;
		sample.facts.coreSec = r.feat.coreSec;
	}
	const rep = r.src === "live" ? fromDiffs(r.rep) : undefined;
	if (rep) {
		sample.reports = rep.map(t => r.ts + t);
	}
	sample.starts = r.ev.filter(e => e[1] === "s").map(e => e[0]);
	if (r.ev.some(e => e[1] === "a")) {
		sample.aborted = true;
	}
	if (r.afterFinal) {
		sample.afterFinal = r.afterFinal;
	}
	return { sample, series: s };
}

/**
 * Samples and verdicts of all stored runs and false starts with cells (bridge store ↔ run check): every run is
 * checked again (`stuck`, `sparse`, `gap` change with the comparison runs); the decisions of the user and the
 * finer grid (`gridFrom`: no phases, no trailer) are applied. Runs without cells give no sample.
 *
 * @param store - Store
 * @param ctx - Context of the run check
 */
export function storeSamples(store: StoreFile, ctx: QualityContext): StoreSample[] {
	const built: { run: StoredRun; sample: RunSample; series: TickSeries }[] = [];
	for (const r of [...store.runs, ...store.spikes].sort((a, b) => startOf(a) - startOf(b))) {
		const x = sampleOfStored(store, r);
		if (x) {
			built.push({ run: r, ...x });
		}
	}
	const verdicts = checkRuns(
		built.map(b => b.sample),
		ctx,
	);
	return built.map((b, k) => ({ ...b, verdict: withDecision(store, b.run, verdicts[k]) }));
}

/**
 * A verdict with the decision of the user and the finer grid of the run applied.
 *
 * @param store - Store
 * @param r - Run
 * @param v - Automatic verdict
 */
function withDecision(store: StoreFile, r: StoredRun, v: Verdict): Verdict {
	const out: Verdict = { ...v, uses: { ...v.uses } };
	const d = decisionOf(store, r.key);
	if (d?.user) {
		out.user = d.user;
	}
	if (r.gridFrom !== undefined) {
		out.uses.phases = false;
		out.uses.trailer = false;
	}
	return out;
}

/**
 * Base bands and hold time profile from the clean runs, in two passes (Spec B.1a): verdicts without the hold time
 * profile, bands and profile from the runs admitted for phases (at least three), verdicts again. Fills the band
 * features of the runs (`topBandSec`, `finalBandBlocks`).
 *
 * @param store - Store
 * @param ctx - Context of the run check (its `bands` are replaced)
 * @returns verdicts by key
 */
export function recomputeBands(store: StoreFile, ctx: QualityContext): Map<string, Verdict> {
	const first = storeSamples(store, { ...ctx, bands: store.bands ? { ...store.bands, holds: [] } : null });
	const clean = first.filter(x => x.sample.kind === "run" && admitted(x.verdict, "phases"));
	const factor = store.unitFactor > 0 ? store.unitFactor : 1;
	if (clean.length >= BANDS_MIN_RUNS) {
		const runLimit = median(clean.map(x => (x.run.seg.runLimit ?? 0) / factor));
		const bands = baseBandsOf(
			clean.map(x => x.sample),
			runLimit,
		);
		store.bands = bands;
		for (const x of first) {
			if (x.sample.kind === "run") {
				const f = bandFeaturesOf(x.sample, bands, x.sample.facts.coreEnd);
				if (f) {
					x.run.feat.topBandSec = f.topBandSec;
					x.run.feat.finalBandBlocks = f.finalBandBlocks;
				}
			}
		}
	} else {
		delete store.bands;
	}
	const second = checkRuns(
		first.map(x => x.sample),
		{ ...ctx, bands: store.bands ?? null },
	);
	return new Map(first.map((x, k) => [x.run.key, withDecision(store, x.run, second[k])]));
}

/**
 * Run check, base bands, tail and envelope of the store computed again.
 *
 * @param store - Store
 * @param ctx - Context of the run check
 * @returns verdicts by key
 */
export function recompute(store: StoreFile, ctx: QualityContext): Map<string, Verdict> {
	const verdicts = recomputeBands(store, ctx);
	recomputeTail(store, verdicts);
	recomputeEnvelope(store, verdicts);
	return verdicts;
}

/**
 * Start time of a stored run (first active cell).
 *
 * @param r - Run
 */
export function startOf(r: StoredRun): number {
	return r.ts + r.seg.startIdx * r.step;
}

/** Options of `addRun`. */
export interface AddRunOptions {
	/** Context of the run check: run check, bands and tail are computed again (without: only the decisions count). */
	ctx?: QualityContext;
	/** Current time (default: end of the added capture). */
	now?: number;
	/** Many runs in a row (history): only the envelope; the caller calls `recompute` (or `recomputeTail`) after. */
	deferred?: boolean;
	/** Called with the verdicts of the run check (only with `ctx` and without `deferred`). */
	onVerdicts?: (verdicts: ReadonlyMap<string, Verdict>) => void;
}

/**
 * Store a labelled run or false start: key, families, run check, tail, envelope and the limits are kept.
 *
 * @param store - Store
 * @param run - Stored run
 * @param o - Options
 * @returns ids of the evicted runs
 */
export function addRun(store: StoreFile, run: StoredRun, o: AddRunOptions = {}): string[] {
	if (!run.key) {
		run.key = verdictKey(store.deviceId, startOf(run));
	}
	run.rev ??= LAYOUT_REV;
	if (run.label === "spike") {
		store.spikes.push(run);
	} else {
		store.runs.push(run);
	}
	const verdicts = o.ctx && !o.deferred ? recomputeBands(store, o.ctx) : undefined;
	if (verdicts) {
		o.onVerdicts?.(verdicts);
	}
	if (run.label !== "spike") {
		const fam = assignFamilies(
			store.runs.map(r => r.feat),
			store.runs.map(r => r.family),
			store.nextFamily ?? 0,
		);
		store.runs.forEach((r, i) => {
			r.family = fam.families[i];
		});
		store.nextFamily = fam.nextId;
	}
	if (!o.deferred) {
		recomputeTail(store, verdicts);
	}
	recomputeEnvelope(store, verdicts);
	const now = o.now ?? run.ts + Math.max(0, (run.seg.runEndIdx + 1) * run.step);
	const evicted = fitSize(store, now, verdicts);
	refreshInfo(store);
	return evicted;
}

/**
 * Drop the report times and then the capture of a run in progress if it is too large to persist, then evict runs
 * and false starts (`evict`).
 *
 * @param store - Store
 * @param now - Current time (default: start of the newest stored run)
 * @param verdicts - Verdicts by key (`recompute`), or undefined
 * @returns ids of the evicted runs
 */
export function fitSize(store: StoreFile, now?: number, verdicts?: ReadonlyMap<string, Verdict>): string[] {
	if (store.pending?.rep && JSON.stringify(encodePending(store.pending)).length > MAX_PENDING_BYTES) {
		// the report times go first: the run itself is worth more than its report statistics
		const lighter: Capture = { ...store.pending };
		delete lighter.rep;
		store.pending = lighter;
	}
	if (store.pending && JSON.stringify(encodePending(store.pending)).length > MAX_PENDING_BYTES) {
		// too large to persist: a restart before the capture closes loses this run
		store.pending = null;
	}
	const newest = Math.max(0, ...[...store.runs, ...store.spikes].map(startOf));
	return evict(store, now ?? newest, verdicts);
}

/**
 * Evict runs step by step (Spec D.2, P23); after every evicted run the boundary runs are determined again, so of two
 * equally extreme runs one always stays. Boundary runs are never evicted, and every programme group keeps
 * MIN_PER_FAMILY runs. Order: runs older than WINDOW_MS (history first); over MAX_STORE_BYTES or MAX_RUN_META the
 * cells of excluded runs, history runs, then the oldest run of the largest group. Runs excluded by the user go
 * first; their decision stays in `verdicts`.
 *
 * @param store - Store
 * @param now - Current time
 * @param verdicts - Verdicts by key (`recompute`); without them only the decisions of the user count
 * @returns ids of the evicted runs
 */
export function evict(store: StoreFile, now: number, verdicts?: ReadonlyMap<string, Verdict>): string[] {
	const evicted: string[] = [];
	const use = usesOfStore(store, verdicts);
	const remove = (r: StoredRun): void => {
		const list = store.runs.includes(r) ? store.runs : store.spikes;
		list.splice(list.indexOf(r), 1);
		evicted.push(r.id);
	};
	const counts = (): Map<number, number> => {
		const m = new Map<number, number>();
		for (const r of store.runs) {
			if (!use.get(r)?.excluded) {
				m.set(r.family, (m.get(r.family) ?? 0) + 1);
			}
		}
		return m;
	};
	// one run of the pool (in its order): excluded runs at once, otherwise the first that is no boundary run
	const step = (pool: () => StoredRun[], perFamily: boolean): boolean => {
		const full = envelopeWith(store, use);
		const count = counts();
		for (const r of pool()) {
			if (use.get(r)?.excluded) {
				remove(r);
				return true;
			}
			if (perFamily && (count.get(r.family) ?? 0) <= MIN_PER_FAMILY) {
				continue;
			}
			if (!isBoundary(store, use, full, r)) {
				remove(r);
				return true;
			}
		}
		return false;
	};
	const old = (r: StoredRun): boolean => now - r.ts > WINDOW_MS;
	const byTs = (a: StoredRun, b: StoredRun): number => a.ts - b.ts;
	const historyFirst = (a: StoredRun, b: StoredRun): number =>
		(a.src === "history" ? 0 : 1) - (b.src === "history" ? 0 : 1) || byTs(a, b);
	const over = (): boolean => store.runs.length > MAX_RUN_META || sizeOf(store) > MAX_STORE_BYTES;

	// 1. older than the window
	while (step(() => store.runs.filter(old).sort(historyFirst), true)) {
		// next
	}
	while (step(() => store.spikes.filter(old).sort(byTs), false)) {
		// next
	}
	// 2. over the limits: the cells of excluded runs (the key with the decision stays), then excluded runs
	if (sizeOf(store) > MAX_STORE_BYTES) {
		for (const r of [...store.runs, ...store.spikes].filter(x => use.get(x)?.excluded && x.data).sort(byTs)) {
			delete r.data;
			if (sizeOf(store) <= MAX_STORE_BYTES) {
				break;
			}
		}
	}
	while (store.runs.length > MAX_RUN_META) {
		const ex = store.runs.filter(x => use.get(x)?.excluded).sort(byTs)[0];
		if (!ex) {
			break;
		}
		remove(ex);
	}
	// 3. history runs, then the oldest run of the largest group
	while (over() && step(() => store.runs.filter(r => r.src === "history").sort(byTs), true)) {
		// next
	}
	while (
		over() &&
		step(() => {
			const count = counts();
			return [...store.runs].sort(
				(a, b) => (count.get(b.family) ?? 0) - (count.get(a.family) ?? 0) || byTs(a, b),
			);
		}, true)
	) {
		// next
	}
	// false starts: at most MAX_SPIKES, and while the file is too large
	while (store.spikes.length > MAX_SPIKES || (sizeOf(store) > MAX_STORE_BYTES && store.spikes.length > 0)) {
		if (!step(() => [...store.spikes].sort(byTs), false)) {
			if (store.spikes.length <= MAX_SPIKES) {
				break;
			}
			remove([...store.spikes].sort(byTs)[0]);
		}
	}
	// last resort: the oldest run that is no boundary run, also below the minimum of its group
	while (over() && step(() => [...store.runs].sort(byTs), false)) {
		// next
	}
	if (evicted.length > 0) {
		// the extremes stay (boundary runs are kept), the count follows
		recomputeEnvelope(store, verdicts);
		refreshInfo(store);
	}
	return evicted;
}

/**
 * Size of the store as JSON.
 *
 * @param store - Store
 */
export function sizeOf(store: StoreFile): number {
	return serializeStore(store).length;
}

/**
 * Bring a loaded store to the current version (Spec C.7, P10, P12): the envelope of before V5 is frozen once as
 * `legacyEnvelope`; runs with an older layout revision are segmented again from their cells (the programme groups
 * keep their ids, runs without cells stay as they are); every run gets its key, programme end, burst maximum and
 * end block minimum; the tail and the envelope are computed again (only the decisions of the user count, the
 * registry calls `recompute` with the run check after). A store of the current version stays as it is.
 *
 * @param store - Store
 * @param keepAboveW - End threshold of the values in use in W (drying phases above it belong to the run)
 * @returns messages for the log (English); empty if nothing had to change
 */
export function upgradeStore(store: StoreFile, keepAboveW?: number): string[] {
	const msgs: string[] = [];
	let changed = store.layoutRev !== LAYOUT_REV;
	if (typeof store.verdicts !== "object" || store.verdicts === null || Array.isArray(store.verdicts)) {
		store.verdicts = {};
	}
	if (!store.legacyEnvelope) {
		store.legacyEnvelope = { ...emptyEnvelope(), ...store.envelope };
		changed = true;
	}
	let again = 0;
	for (const r of [...store.runs, ...store.spikes]) {
		if (((r.rev ?? 0) < LAYOUT_REV || r.seg.runLimit === undefined) && typeof r.data === "string") {
			changed = true;
			if (resegment(r, keepAboveW)) {
				again++;
			}
		}
		const g = r.seg;
		if (!Number.isInteger(g.progEndIdx)) {
			g.progEndIdx = g.runEndIdx;
			changed = true;
		}
		if (!Number.isFinite(r.feat.burstMaxW)) {
			r.feat.burstMaxW = 0;
			changed = true;
		}
		if (!Number.isFinite(r.feat.endBlockMinW)) {
			r.feat.endBlockMinW = r.label === "spike" ? 0 : r.feat.minRunW;
			changed = true;
		}
		if (typeof r.key !== "string" || r.key === "") {
			r.key = verdictKey(store.deviceId, startOf(r));
			changed = true;
		}
	}
	if (store.bands) {
		// JSON writes the open upper limit of the highest band as null
		for (const b of store.bands.bands) {
			if (typeof b.max !== "number") {
				b.max = Number.POSITIVE_INFINITY;
			}
		}
	}
	if (!changed) {
		return msgs;
	}
	store.layoutRev = LAYOUT_REV;
	recomputeTail(store);
	recomputeEnvelope(store);
	refreshInfo(store);
	msgs.push(
		again > 0
			? `learning data brought to the current version, ${again} stored runs segmented again`
			: "learning data brought to the current version",
	);
	return msgs;
}

/**
 * Segment a stored run again from its cells with the current layout (the programme group stays).
 *
 * @param r - Run with cells
 * @param keepAboveW - End threshold in W, or undefined
 * @returns whether the segmentation was taken over
 */
function resegment(r: StoredRun, keepAboveW: number | undefined): boolean {
	const dec = seriesOf(r);
	if (!dec) {
		return false;
	}
	const L = buildLayout(dec.s, {
		recording: true,
		maxRuns: Number.POSITIVE_INFINITY,
		...(keepAboveW !== undefined ? { keepAbove: keepAboveW } : {}),
	});
	r.rev = LAYOUT_REV;
	r.seg.runLimit = L.runLimit;
	if (r.label === "spike") {
		return false;
	}
	const g = r.seg;
	const best = [...L.runs].sort((a, b) => Math.abs(a.from - g.startIdx) - Math.abs(b.from - g.startIdx))[0];
	if (!best) {
		return false;
	}
	const bands = { topBandSec: r.feat.topBandSec, finalBandBlocks: r.feat.finalBandBlocks };
	r.seg = {
		startIdx: best.from,
		coreEndIdx: best.coreEnd,
		runEndIdx: best.runEnd,
		trailerFrom: best.trailerFrom,
		trailerTo: best.trailerTo,
		progEndIdx: best.progEnd,
		runLimit: L.runLimit,
	};
	const feat: StoredFeatures = featuresOf(dec.s, best, L.runLimit);
	if (bands.topBandSec !== undefined && bands.finalBandBlocks !== undefined) {
		feat.topBandSec = bands.topBandSec;
		feat.finalBandBlocks = bands.finalBandBlocks;
	}
	r.feat = feat;
	return true;
}

/**
 * Cells on another poll grid (Spec C.7, P27): coarser takes the held value at the grid point and the extremes of the
 * time since the previous one (unknown if any value was); finer repeats the held value.
 *
 * @param cells - Cells
 * @param from - Poll interval of the cells in ms
 * @param to - New poll interval in ms
 */
function regrid(cells: readonly TickCell[], from: number, to: number): TickCell[] {
	if (cells.length === 0 || from === to) {
		return [...cells];
	}
	const n = Math.floor(((cells.length - 1) * from) / to) + 1;
	const out: TickCell[] = [];
	for (let j = 0; j < n; j++) {
		const t = j * to;
		const hi = Math.min(cells.length - 1, Math.floor(t / from));
		if (to > from) {
			const lo = j === 0 ? 0 : Math.floor((t - to) / from) + 1;
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			let valid = true;
			for (let i = Math.max(0, lo); i <= hi; i++) {
				const c = cells[i];
				valid &&= c.valid;
				if (c.valid) {
					min = Math.min(min, c.min, c.last);
					max = Math.max(max, c.max, c.last);
				}
			}
			const last = cells[hi].last;
			out.push({ min: Number.isFinite(min) ? min : last, max: Number.isFinite(max) ? max : last, last, valid });
		} else {
			const c = cells[hi];
			out.push(t === hi * from ? { ...c } : { min: c.last, max: c.last, last: c.last, valid: c.valid });
		}
	}
	return out;
}

/**
 * Cells in another unit (`factor` = old unit factor / new unit factor).
 *
 * @param cells - Cells
 * @param factor - Factor
 */
function rescale(cells: TickCell[], factor: number): TickCell[] {
	return factor === 1
		? cells
		: cells.map(c => ({ min: c.min * factor, max: c.max * factor, last: c.last * factor, valid: c.valid }));
}

/**
 * Convert one stored run to another poll interval and unit; the features, the envelope and the tail stay (W, s).
 *
 * @param r - Run
 * @param step - New poll interval in ms
 * @param unitFactor - New unit factor
 */
function convertRun(r: StoredRun, step: number, unitFactor: number): void {
	const q = quantOf(unitFactor);
	if (typeof r.data === "string") {
		const cells = rescale(regrid(decodeCells(r.data, r.q), r.step, step), r.unitFactor / unitFactor);
		r.data = encodeCells(cells, q);
		const last = cells.length - 1;
		const idx = (i: number): number => Math.max(0, Math.min(last, Math.round((i * r.step) / step)));
		const g = r.seg;
		r.seg = {
			...g,
			startIdx: idx(g.startIdx),
			coreEndIdx: idx(g.coreEndIdx),
			runEndIdx: idx(g.runEndIdx),
			trailerFrom: g.trailerFrom === null ? null : idx(g.trailerFrom),
			trailerTo: g.trailerTo === null ? null : idx(g.trailerTo),
			progEndIdx: idx(g.progEndIdx),
		};
	}
	if (step < r.step) {
		r.gridFrom = Math.max(r.gridFrom ?? r.step, r.step);
	} else if (r.gridFrom !== undefined && step >= r.gridFrom) {
		delete r.gridFrom;
	}
	r.step = step;
	r.unitFactor = unitFactor;
	r.q = q;
}

/**
 * Convert the stored runs, the false starts, the capture of a run in progress and the base bands to another poll
 * interval or unit instead of discarding them (Spec C.7, P27). Envelope, frozen envelope and tail are kept in W and
 * stay as they are; runs brought to a finer grid get `gridFrom` (no phases, no trailer).
 *
 * @param store - Store
 * @param step - New poll interval in ms
 * @param unitFactor - New unit factor
 * @returns messages for the log (English)
 */
export function convertRuns(store: StoreFile, step: number, unitFactor: number): string[] {
	if (store.step === step && store.unitFactor === unitFactor) {
		return [];
	}
	const all = [...store.runs, ...store.spikes];
	for (const r of all) {
		convertRun(r, step, unitFactor);
	}
	if (store.pending) {
		const c = store.pending;
		store.pending = {
			...c,
			cells: rescale(regrid(c.cells, c.stepMs, step), c.unitFactor / unitFactor),
			stepMs: step,
			unitFactor,
		};
	}
	if (store.bands && store.unitFactor !== unitFactor) {
		const k = store.unitFactor / unitFactor;
		store.bands = {
			...store.bands,
			runLimit: store.bands.runLimit * k,
			bands: store.bands.bands.map(b => ({ ...b, min: b.min * k, max: b.max * k })),
		};
	}
	const what = `poll interval ${store.step / 1000} s → ${step / 1000} s, unit factor ${store.unitFactor} → ${unitFactor}`;
	store.step = step;
	store.unitFactor = unitFactor;
	return all.length > 0 ? [`${what}: ${all.length} stored runs converted`] : [];
}

/**
 * Empty learning data of a device ("clear learning data", P26): runs, values, changes and the frozen envelope go;
 * the decisions of the user stay unless `keepDecisions` is false.
 *
 * @param store - Store
 * @param keepDecisions - Keep the decisions of the user
 */
export function clearLearningData(store: StoreFile, keepDecisions: boolean): StoreFile {
	const out = emptyStore(store.deviceId, store.typeId, store.typeHash, store.step, store.unitFactor);
	// the next save must win over both slots of the old data
	out.seq = store.seq;
	if (store.lastSeenTs !== undefined) {
		out.lastSeenTs = store.lastSeenTs;
	}
	if (keepDecisions) {
		for (const [key, d] of Object.entries(store.verdicts ?? {})) {
			if (d.user) {
				out.verdicts[key] = d.reason ? { user: d.user, reason: d.reason } : { user: d.user };
			}
		}
	}
	return out;
}
