/**
 * Phase model of a device (Spec A.4): power bands as the generic names ("spin") and phases as the
 * classes inside a band ("final spin"). The model only names what the device does; it never changes a
 * message of the detection. Missing in the device = phases off.
 */

/** Ids of the fixed system phases (names from the i18n keys in `SYSTEM_PHASE_KEYS`, 11 languages). */
export const SYSTEM_PHASES = {
	/** Anti-crease phase: as long as the TrailerFilter holds the end. */
	antiCrease: "antiCrease",
	/** After the run: as long as the lock phase of the final phase runs (without anti-crease). */
	afterRun: "afterRun",
	/** Outside all bands (below the lowest band, or in a gap between two bands). */
	rest: "rest",
	/** A value was held longer than the suspect limit of its band (missing values, display only). */
	unknown: "unknown",
} as const;

/** Id of the system phase "unknown". */
export const UNKNOWN_PHASE = SYSTEM_PHASES.unknown;

/** i18n keys of the system phase names and of the neutral name template of learned phases. */
export const SYSTEM_PHASE_KEYS = {
	antiCrease: "phase_antiCrease",
	afterRun: "phase_afterRun",
	rest: "phase_rest",
	unknown: "phase_unknown",
	/** Template of the name of a learned phase: placeholder `{n}`, its number in the order of the run (Spec B.5). */
	neutral: "phase_neutral",
} as const;

/** English names of the system phases (used when the caller passes no translated names). */
export const DEFAULT_PHASE_NAMES: Readonly<Record<string, string>> = {
	antiCrease: "Anti-crease",
	afterRun: "After the run",
	rest: "Rest",
	unknown: "Unknown",
};

/** Predecessor ids with a fixed meaning in `PhaseDef.after`: rest before the phase, start of the run. */
const CONTEXT_IDS = ["idle", "start"] as const;

/** Smoothing of a band (Spec A.5). */
export type BandSmoothing = "block" | "level" | "debounce" | "peak";

/** A power band: `[min, max)` in the unit of the state. */
export interface BandDef {
	/** Stable id. */
	id: string;
	/** Generic name, e.g. "Spin". */
	name: string;
	/** Lower limit. */
	min: number;
	/** Upper limit (exclusive); `Infinity` for the highest band (stored as `null` in JSON). */
	max: number;
	/** How the band is read from the raw values. */
	smoothing: BandSmoothing;
	/** block: dip tolerance; level: hold time; debounce: debounce time; peak: display hold time (s). */
	dipSec: number;
	/** level: window of the median and the maximum (s). */
	windowSec: number;
}

/** Event phase (P3): a short entry into a band that is confirmed by the band the value goes to. */
export interface PhaseTrigger {
	/** Band ids the value has to go to within `confirmSec` after entering the band of the phase. */
	confirm: string[];
	/** Time from the entry within which the value has to reach one of the `confirm` bands (s). */
	confirmSec: number;
	/** Length of the event phase from the entry (s); afterwards the normal band phase applies. */
	tailSec: number;
}

/** A class inside a band. */
export interface PhaseDef {
	/** Stable id (`p3`). */
	id: string;
	/** Name. */
	name: string;
	/** `BandDef.id`. */
	band: string;
	/** Shortest duration of the class in s (0 = open). */
	minSec: number;
	/** Longest duration of the class in s (0 = open). */
	maxSec: number;
	/** Allowed predecessors: phase ids, `"idle"` (rest before) or `"start"` (first phase of the run). */
	after?: string[];
	/** Only with scope run: the phase begins at least this long after the start of the run (s). */
	notBeforeSec?: number;
	/** Event phase (P3). */
	trigger?: PhaseTrigger;
	/** `live`: named as soon as the duration proves it; `end`: only known when the segment ends. */
	decided: "live" | "end";
	/** "Finished afterwards" (operation only; the effect comes from `detection.final*`). */
	final?: boolean;
	/**
	 * After-run (Spec B.5 step 8): shown while the trailer filter holds the end, never read from the bands (`band` only
	 * keeps the model valid); at most one per model.
	 */
	trailer?: boolean;
	/** Shown in the states. */
	show: boolean;
	/** Messages at the start and/or end of the phase. */
	notify?: { start?: boolean; end?: boolean; text?: string };
	/** Learning statistics. */
	stats: PhaseStats;
}

/** Learning statistics of a phase. */
export interface PhaseStats {
	/** Runs or days with the phase. */
	runs: number;
	/** Agreement of the cross-check (0..1). */
	agreement: number;
	/** End of the latest evidence (ms). */
	lastSeen: number;
	/** Typical power in W (after-run: the highest values of its bursts). */
	watts?: number;
	/** Shortest time in the phase per run or day (s). */
	shortSec?: number;
	/** Longest time in the phase per run or day (s). */
	longSec?: number;
}

/** Phase model of a device (`DeviceConfig.phases`). */
export interface PhaseModel {
	/** Format. */
	v: 1;
	/** Opt-in, default false. */
	enabled: boolean;
	/** `continuous`: without relation to runs (e.g. a boiler). */
	scope: "run" | "continuous";
	/** Bands, ascending, without overlap, unit of the state. */
	bands: BandDef[];
	/** Phases. */
	phases: PhaseDef[];
	/** When the model was learned (ms). */
	learnedAt: number;
	/** Result of the cross-check. */
	quality: { agreement: number; runsUsed: number };
}

const SMOOTHINGS: readonly BandSmoothing[] = ["block", "level", "debounce", "peak"];
const RESERVED = new Set<string>([...Object.values(SYSTEM_PHASES), ...CONTEXT_IDS]);

/** Entries of the state `phases` (the newest segments). */
export const PHASES_MAX = 200;
/** Scope continuous: the state `phases` holds the last 24 h. */
export const PHASES_CONTINUOUS_MS = 86_400_000;
/** Scope continuous: a phase message of the same phase is sent at most this often (ms). */
export const PHASE_NOTIFY_MIN_MS = 600_000;

/**
 * Names of the system phases in one language.
 *
 * @param translate - Translation of an i18n key (e.g. `I18n.translate` in the system language)
 */
export function systemPhaseNames(translate: (key: string) => string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const id of Object.values(SYSTEM_PHASES)) {
		const text = translate(SYSTEM_PHASE_KEYS[id]);
		out[id] = text && text !== SYSTEM_PHASE_KEYS[id] ? text : DEFAULT_PHASE_NAMES[id];
	}
	return out;
}

function isRecord(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** Thrown inside `normalizePhases` for a model that cannot be used. */
class InvalidModel extends Error {}

function fail(reason: string): never {
	throw new InvalidModel(reason);
}

function nonNegative(val: unknown, fallback: number, what: string): number {
	if (val === undefined || val === null) {
		return fallback;
	}
	const n = typeof val === "number" ? val : Number.NaN;
	if (!Number.isFinite(n) || n < 0) {
		fail(`${what} is not a number ≥ 0`);
	}
	return n;
}

function text(val: unknown, what: string): string {
	if (typeof val !== "string" || val.trim() === "") {
		fail(`${what} is missing`);
	}
	return val;
}

function bandOfRaw(raw: unknown, k: number, last: boolean): BandDef {
	if (!isRecord(raw)) {
		fail(`band #${k + 1} is not an object`);
	}
	const id = text(raw.id, `id of band #${k + 1}`);
	const min = nonNegative(raw.min, Number.NaN, `min of band "${id}"`);
	if (!Number.isFinite(min)) {
		fail(`min of band "${id}" is missing`);
	}
	// JSON stores Infinity as null: only the highest band may be open at the top
	const max = (raw.max === null || raw.max === undefined) && last ? Infinity : raw.max;
	if (typeof max !== "number" || Number.isNaN(max) || max <= min) {
		fail(`max of band "${id}" is not above its min`);
	}
	const smoothing = SMOOTHINGS.find(s => s === raw.smoothing);
	if (!smoothing) {
		fail(`smoothing of band "${id}" is unknown`);
	}
	return {
		id,
		name: typeof raw.name === "string" ? raw.name : id,
		min,
		max,
		smoothing,
		dipSec: nonNegative(raw.dipSec, 0, `dipSec of band "${id}"`),
		windowSec: nonNegative(raw.windowSec, 0, `windowSec of band "${id}"`),
	};
}

function idList(val: unknown, what: string): string[] {
	if (!Array.isArray(val) || val.some(x => typeof x !== "string" || x === "")) {
		fail(`${what} is not a list of ids`);
	}
	return [...(val as string[])];
}

function phaseOfRaw(raw: unknown, k: number, bandIds: ReadonlySet<string>): PhaseDef {
	if (!isRecord(raw)) {
		fail(`phase #${k + 1} is not an object`);
	}
	const id = text(raw.id, `id of phase #${k + 1}`);
	const band = text(raw.band, `band of phase "${id}"`);
	if (!bandIds.has(band)) {
		fail(`phase "${id}" refers to the unknown band "${band}"`);
	}
	const minSec = nonNegative(raw.minSec, 0, `minSec of phase "${id}"`);
	const maxSec = nonNegative(raw.maxSec, 0, `maxSec of phase "${id}"`);
	if (maxSec > 0 && maxSec < minSec) {
		fail(`maxSec of phase "${id}" is below its minSec`);
	}
	const decided = raw.decided === undefined ? "live" : raw.decided;
	if (decided !== "live" && decided !== "end") {
		fail(`decided of phase "${id}" is unknown`);
	}
	const stats = isRecord(raw.stats) ? raw.stats : {};
	const out: PhaseDef = {
		id,
		name: typeof raw.name === "string" ? raw.name : id,
		band,
		minSec,
		maxSec,
		decided,
		show: typeof raw.show === "boolean" ? raw.show : true,
		stats: {
			runs: nonNegative(stats.runs, 0, `stats.runs of phase "${id}"`),
			agreement: nonNegative(stats.agreement, 0, `stats.agreement of phase "${id}"`),
			lastSeen: nonNegative(stats.lastSeen, 0, `stats.lastSeen of phase "${id}"`),
		},
	};
	for (const key of ["watts", "shortSec", "longSec"] as const) {
		if (stats[key] !== undefined) {
			out.stats[key] = nonNegative(stats[key], 0, `stats.${key} of phase "${id}"`);
		}
	}
	if (raw.after !== undefined) {
		out.after = idList(raw.after, `after of phase "${id}"`);
	}
	if (raw.notBeforeSec !== undefined) {
		out.notBeforeSec = nonNegative(raw.notBeforeSec, 0, `notBeforeSec of phase "${id}"`);
	}
	if (raw.trigger !== undefined) {
		if (!isRecord(raw.trigger)) {
			fail(`trigger of phase "${id}" is not an object`);
		}
		const confirm = idList(raw.trigger.confirm, `trigger.confirm of phase "${id}"`);
		const unknownBand = confirm.find(b => !bandIds.has(b) || b === band);
		if (confirm.length === 0 || unknownBand !== undefined) {
			fail(`trigger.confirm of phase "${id}" refers to no other known band`);
		}
		out.trigger = {
			confirm,
			confirmSec: nonNegative(raw.trigger.confirmSec, 0, `trigger.confirmSec of phase "${id}"`),
			tailSec: nonNegative(raw.trigger.tailSec, 0, `trigger.tailSec of phase "${id}"`),
		};
	}
	if (raw.final === true) {
		out.final = true;
	}
	if (raw.trailer === true) {
		out.trailer = true;
	}
	if (isRecord(raw.notify)) {
		const notify: PhaseDef["notify"] = {};
		if (raw.notify.start === true) {
			notify.start = true;
		}
		if (raw.notify.end === true) {
			notify.end = true;
		}
		if (typeof raw.notify.text === "string" && raw.notify.text !== "") {
			notify.text = raw.notify.text;
		}
		if (Object.keys(notify).length > 0) {
			out.notify = notify;
		}
	}
	return out;
}

/**
 * Check and complete a stored phase model (Spec A.4). Bands must be ascending without overlap, ids must
 * be unique (bands and phases share one namespace, system ids are reserved), and `band`, `after` and
 * `trigger.confirm` must refer to existing ids. `notBeforeSec` is not allowed with scope continuous: it
 * is removed with one warning. A model that cannot be used gives `undefined` and one warning.
 *
 * @param raw - Stored model (`native.phases`)
 * @param warnings - Receives the warnings
 * @param label - Device name for the warnings
 */
export function normalizePhases(raw: unknown, warnings: string[], label: string): PhaseModel | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	try {
		if (!isRecord(raw)) {
			fail("not an object");
		}
		if (raw.v !== undefined && raw.v !== 1) {
			fail(`unknown format ${JSON.stringify(raw.v)}`);
		}
		const scope = raw.scope === undefined ? "run" : raw.scope;
		if (scope !== "run" && scope !== "continuous") {
			fail("scope is unknown");
		}
		if (!Array.isArray(raw.bands) || raw.bands.length === 0) {
			fail("no bands");
		}
		const rawBands = raw.bands as unknown[];
		const bands = rawBands.map((b, k) => bandOfRaw(b, k, k === rawBands.length - 1));
		const ids = new Set<string>();
		for (const [k, b] of bands.entries()) {
			if (RESERVED.has(b.id) || ids.has(b.id)) {
				fail(`band id "${b.id}" is used twice or reserved`);
			}
			ids.add(b.id);
			if (k > 0 && b.min < bands[k - 1].max) {
				fail(`band "${b.id}" overlaps band "${bands[k - 1].id}" or is not ascending`);
			}
		}
		const bandIds = new Set(ids);
		const rawPhases = raw.phases === undefined ? [] : raw.phases;
		if (!Array.isArray(rawPhases)) {
			fail("phases is not a list");
		}
		const phases = rawPhases.map((p, k) => phaseOfRaw(p, k, bandIds));
		for (const p of phases) {
			if (RESERVED.has(p.id) || ids.has(p.id)) {
				fail(`phase id "${p.id}" is used twice or reserved`);
			}
			ids.add(p.id);
		}
		if (phases.filter(p => p.trailer).length > 1) {
			fail("more than one after-run phase");
		}
		const phaseIds = new Set(phases.map(p => p.id));
		for (const p of phases) {
			const bad = p.after?.find(a => !phaseIds.has(a) && !(CONTEXT_IDS as readonly string[]).includes(a));
			if (bad !== undefined) {
				fail(`after of phase "${p.id}" refers to the unknown phase "${bad}"`);
			}
		}
		if (scope === "continuous" && phases.some(p => p.notBeforeSec !== undefined)) {
			for (const p of phases) {
				delete p.notBeforeSec;
			}
			warnings.push(
				`Device "${label}": notBeforeSec removed from the phases (not allowed with scope continuous)`,
			);
		}
		const quality = isRecord(raw.quality) ? raw.quality : {};
		return {
			v: 1,
			enabled: raw.enabled === true,
			scope,
			bands,
			phases,
			learnedAt: nonNegative(raw.learnedAt, 0, "learnedAt"),
			quality: {
				agreement: nonNegative(quality.agreement, 0, "quality.agreement"),
				runsUsed: nonNegative(quality.runsUsed, 0, "quality.runsUsed"),
			},
		};
	} catch (err) {
		if (!(err instanceof InvalidModel)) {
			throw err;
		}
		warnings.push(`Device "${label}": phases ignored (${err.message})`);
		return undefined;
	}
}
