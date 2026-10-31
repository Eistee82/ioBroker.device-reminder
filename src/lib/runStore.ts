import type { DetectionSettings } from "./detector/types.js";
import type { FileIO } from "./host.js";
import type { RunFeatures } from "./learn/families.js";
import { assignFamilies } from "./learn/families.js";
import { buildLayout, MAX_PAUSE_MS, MAX_WINDOWS, median } from "./learn/runs.js";
import type { RunInfo } from "./learn/runs.js";
import { decodeCells, encodeCells, fromCells, quantOf } from "./learn/ticks.js";
import type { TickSeries } from "./learn/ticks.js";
import type { Capture, CaptureEvent } from "./runRecorder.js";
import { errorMessage } from "./utils.js";

/** Version of the store format. */
export const STORE_VERSION = 1;
/** Most stored runs. */
export const MAX_RUNS = MAX_WINDOWS;
/** Most stored false starts. */
export const MAX_SPIKES = 10;
/** Largest store file in bytes (characters). */
export const MAX_STORE_BYTES = 400_000;
/** Largest persisted capture of a run in progress in bytes (characters, encoded). */
export const MAX_PENDING_BYTES = 200_000;
/** Most kept changes. */
export const MAX_CHANGES = 10;
/** A runtime start within this distance of the segmented start counts as the start of the run. */
const START_MATCH_MS = 5 * 60_000;
/** Time after the programme that a trusted run must contain. */
const POST_ROLL_MS = MAX_PAUSE_MS;

/** Classification of a stored capture. */
export type RunLabel = "run" | "split" | "spike";

/** One stored capture. */
export interface StoredRun {
	/** Id (time of the first cell and number of events in base 36; for display and selection). */
	id: string;
	/** Time of cell 0 in ms. */
	ts: number;
	/** Poll interval in ms. */
	step: number;
	/** Quantisation factor of `data`. */
	q: number;
	/** Factor from the unit of the state to W. */
	unitFactor: number;
	/** Encoded cells (unit of the state). */
	data: string;
	/** Runtime events with their time. */
	ev: [number, CaptureEvent][];
	/** Classification. */
	label: RunLabel;
	/** Origin. */
	src: "live" | "history";
	/** Whether the time after the end was cut short (restart). */
	postTruncated: boolean;
	/** Segmentation (cell indices). */
	seg: {
		startIdx: number;
		coreEndIdx: number;
		runEndIdx: number;
		trailerFrom: number | null;
		trailerTo: number | null;
	};
	/** Features (W, s). */
	feat: RunFeatures & {
		burstMaxSec: number;
		trailerSec: number;
		minRunW: number;
		trailerGapMaxSec: number;
		trailerGapMinSec: number;
	};
	/** Programme group. */
	family: number;
}

/** Extremes over all runs ever stored (never shrinks). */
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
	/** Kind. */
	kind: "repair" | "tighten" | "undo" | "reset" | "typeChanged";
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
}

/** Status of the automatic optimisation. */
export type OptimizeStatus = "off" | "collecting" | "ok" | "locked" | "cannotCover" | "drift" | "budget";

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
}

/** Learning data of one device. */
export interface StoreFile {
	/** Format version. */
	v: 1;
	/** Write counter. */
	seq: number;
	/** Device id. */
	deviceId: string;
	/** Device type id. */
	typeId: string;
	/** Hash of the detection fields of the type. */
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
	/** Optimised values (differences to the type), or null. */
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
}

/** Detection fields that make up a device type. */
export const DETECTION_KEYS = [
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

/** One detection field. */
export type DetectionKey = (typeof DETECTION_KEYS)[number];

/**
 * Detection fields of a type with every optional field filled in (0).
 *
 * @param t - Type or settings
 */
export function detectionOf(t: DetectionSettings): DetectionSettings {
	return {
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
}

/**
 * FNV-1a hash of the detection fields of a type.
 *
 * @param t - Type
 */
export function typeHash(t: DetectionSettings): string {
	const text = JSON.stringify(DETECTION_KEYS.map(k => detectionOf(t)[k]));
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
 * @param typeId - Type id
 * @param hash - Type hash
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
interface StoredCapture extends Omit<Capture, "cells"> {
	/** Quantisation factor. */
	q: number;
	/** Encoded cells. */
	data: string;
}

/**
 * Encode a capture for the file.
 *
 * @param c - Capture
 */
export function encodePending(c: Capture): StoredCapture {
	const q = quantOf(c.unitFactor);
	return {
		t0: c.t0,
		stepMs: c.stepMs,
		unitFactor: c.unitFactor,
		ev: c.ev,
		postTruncated: c.postTruncated,
		q,
		data: encodeCells(c.cells, q),
	};
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
	return {
		t0: c.t0,
		stepMs: c.stepMs,
		unitFactor: c.unitFactor,
		ev: c.ev,
		postTruncated: c.postTruncated === true,
		cells: decodeCells(c.data, c.q),
	};
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

/**
 * Adapt a loaded store to the current type, poll interval and unit.
 *
 * @param store - Store
 * @param typeId - Current type id
 * @param hash - Current type hash
 * @param step - Current poll interval in ms
 * @param unitFactor - Current unit factor
 * @param now - Current time
 * @returns messages for the log (English)
 */
export function reconcileStore(
	store: StoreFile,
	typeId: string,
	hash: string,
	step: number,
	unitFactor: number,
	now: number,
): string[] {
	const msgs: string[] = [];
	if (store.typeId !== typeId || store.typeHash !== hash) {
		if (store.override) {
			pushChange(store, {
				ts: now,
				kind: "typeChanged",
				from: store.override,
				to: null,
				reason: "device type changed",
				runs: store.runs.length,
				gainSec: 0,
			});
			msgs.push("device type changed, optimised values discarded");
		}
		store.override = null;
		store.typeId = typeId;
		store.typeHash = hash;
		store.failStreak = 0;
		if (store.info.status === "drift") {
			store.info.status = "collecting";
		}
	}
	if (store.step !== step || store.unitFactor !== unitFactor) {
		if (store.runs.length + store.spikes.length > 0) {
			msgs.push("poll interval or unit changed, stored runs discarded");
		}
		store.runs = [];
		store.spikes = [];
		store.pending = null;
		store.step = step;
		store.unitFactor = unitFactor;
	}
	refreshInfo(store);
	return msgs;
}

/**
 * Append a change (the last MAX_CHANGES are kept).
 *
 * @param store - Store
 * @param c - Change
 */
export function pushChange(store: StoreFile, c: Change): void {
	store.changes.push(c);
	if (store.changes.length > MAX_CHANGES) {
		store.changes.splice(0, store.changes.length - MAX_CHANGES);
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

/**
 * Features of a run of a series in W.
 *
 * @param s - Series in W
 * @param r - Run
 * @param runLimit - Run level in W
 */
function featuresOf(s: TickSeries, r: RunInfo, runLimit: number): StoredRun["feat"] {
	const stepSec = s.stepMs / 1000;
	const active: number[] = [];
	let energy = 0;
	let peak = 0;
	for (let i = r.from; i <= r.coreEnd; i++) {
		energy += s.last[i] * stepSec;
		if (s.last[i] > runLimit) {
			active.push(s.last[i]);
			peak = Math.max(peak, s.last[i]);
		}
	}
	const hi = active.filter(v => v >= 0.5 * peak).length;
	const pauses = r.gaps.map(g => (g.to - g.from + 1) * stepSec);
	let trailGap = 0;
	for (let k = 1; k < r.bursts.length; k++) {
		trailGap = Math.max(trailGap, (r.bursts[k].from - r.bursts[k - 1].to - 1) * stepSec);
	}
	return {
		coreSec: (r.coreEnd - r.from + 1) * stepSec,
		energyWh: energy / 3600,
		hiShare: active.length > 0 ? hi / active.length : 0,
		maxPauseSec: pauses.length > 0 ? Math.max(...pauses) : 0,
		nPause: pauses.length,
		trailer: r.bursts.length >= 2,
		blockMean: r.blockMean,
		burstMaxSec: r.burstMaxMs / 1000,
		trailerSec: r.trailerTo !== null ? (r.trailerTo - r.coreEnd) * stepSec : 0,
		minRunW: median(active),
		trailerGapMaxSec: trailGap,
		trailerGapMinSec: r.gapMinMs / 1000,
	};
}

/**
 * Classify a closed capture and turn it into a stored run.
 *
 * @param c - Capture
 * @param keepAboveW - End threshold of the effective type in W (drying phases above it belong to the run)
 * @param src - Origin
 */
export function labelCapture(c: Capture, keepAboveW: number, src: "live" | "history" = "live"): LabelResult {
	const sW = fromCells(c.cells, c.t0, c.stepMs, c.unitFactor);
	const unclear: LabelResult = { label: "unclear", run: null, endDelaySec: null, trusted: false };
	if (sW.points < 20) {
		return unclear;
	}
	const layout = buildLayout(sW, { recording: true, keepAbove: keepAboveW });
	const starts = c.ev.filter(e => e[1] === "s");
	const ends = c.ev.filter(e => e[1] !== "s");
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
			seg: { startIdx: from, coreEndIdx: to, runEndIdx: to, trailerFrom: null, trailerTo: null },
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
	const postOk = (c.cells.length - 1 - r.runEnd) * c.stepMs >= POST_ROLL_MS || c.postTruncated;
	if (!startOk || !valid || !postOk) {
		return unclear;
	}
	return { label: "run", run, endDelaySec, trusted: !c.postTruncated };
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
		env.maxPauseSec = Math.max(env.maxPauseSec, r.feat.maxPauseSec);
		env.maxBurstSec = Math.max(env.maxBurstSec, r.feat.burstMaxSec);
		env.maxTrailSec = Math.max(env.maxTrailSec, r.feat.trailerGapMaxSec ?? 0);
		env.maxTrailerSec = Math.max(env.maxTrailerSec, r.feat.trailerSec);
		env.minRunW = env.minRunW === 0 ? r.feat.minRunW : Math.min(env.minRunW, r.feat.minRunW);
		env.minCoreSec = env.minCoreSec === 0 ? r.feat.coreSec : Math.min(env.minCoreSec, r.feat.coreSec);
		env.n++;
	}
	for (const s of spikes) {
		env.maxBurstSec = Math.max(env.maxBurstSec, s.feat.burstMaxSec);
	}
	return env;
}

/**
 * Merge two envelopes (the result never shrinks).
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
 * Store a labelled run or false start: families, envelope and the limits are kept.
 *
 * @param store - Store
 * @param run - Stored run
 * @returns ids of the evicted runs
 */
export function addRun(store: StoreFile, run: StoredRun): string[] {
	const evicted: string[] = [];
	if (run.label === "spike") {
		store.spikes.push(run);
		while (store.spikes.length > MAX_SPIKES) {
			evicted.push((store.spikes.shift() as StoredRun).id);
		}
	} else {
		store.runs.push(run);
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
	const prevN = store.envelope.n;
	store.envelope = mergeEnvelope(store.envelope, envelopeOf(store.runs, store.spikes));
	store.envelope.n = prevN + (run.label === "spike" ? 0 : 1);
	evicted.push(...fitSize(store));
	refreshInfo(store);
	return evicted;
}

/**
 * Evict runs and false starts until the store fits its limits (also after the capture of a run in
 * progress was set). The extremes of all runs stay.
 *
 * @param store - Store
 * @returns ids of the evicted runs
 */
export function fitSize(store: StoreFile): string[] {
	const evicted: string[] = [];
	if (store.pending && JSON.stringify(encodePending(store.pending)).length > MAX_PENDING_BYTES) {
		// too large to persist: a restart before the capture closes loses this run
		store.pending = null;
	}
	while (store.runs.length > MAX_RUNS || (sizeOf(store) > MAX_STORE_BYTES && store.runs.length > 2)) {
		const victim = pickVictim(store);
		if (victim < 0) {
			break;
		}
		evicted.push(store.runs[victim].id);
		store.runs.splice(victim, 1);
	}
	while (sizeOf(store) > MAX_STORE_BYTES && store.spikes.length > 0) {
		evicted.push((store.spikes.shift() as StoredRun).id);
	}
	if (evicted.length > 0) {
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
 * Run to evict: history runs first, then the oldest run of the largest family that is not binding
 * (removing it changes none of the extremes); the last two runs of a family are kept.
 *
 * @param store - Store
 * @returns index into `store.runs`, or -1
 */
function pickVictim(store: StoreFile): number {
	const count = new Map<number, number>();
	for (const r of store.runs) {
		count.set(r.family, (count.get(r.family) ?? 0) + 1);
	}
	const full = envelopeOf(store.runs, []);
	const binding = (i: number): boolean => {
		const rest = envelopeOf(
			store.runs.filter((_, k) => k !== i),
			[],
		);
		return ENVELOPE_KEYS.some(k => rest[k] !== full[k]);
	};
	const candidates = store.runs
		.map((r, i) => ({ r, i }))
		.filter(({ r }) => (count.get(r.family) ?? 0) > 2)
		.sort(
			(a, b) =>
				(a.r.src === "history" ? 0 : 1) - (b.r.src === "history" ? 0 : 1) ||
				(count.get(b.r.family) ?? 0) - (count.get(a.r.family) ?? 0) ||
				a.r.ts - b.r.ts,
		);
	const free = candidates.find(c => !binding(c.i));
	if (free) {
		return free.i;
	}
	if (candidates.length > 0) {
		return candidates[0].i;
	}
	// every family has at most two runs: the oldest run overall
	return store.runs.length > 0 ? 0 : -1;
}
