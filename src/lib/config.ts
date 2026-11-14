import { FINAL_KEYS } from "./detector/types.js";
import type { DetectionMode, DetectionSettings, FinalKey, FinalSettings } from "./detector/types.js";
import type { DeviceTypeConfig } from "./legacyTypes.js";
import { defaultInstance, fixedTextState, kindFromInstance } from "./messenger/adapters.js";
import { detectionOf } from "./runStore.js";
import { parseNumber } from "./utils.js";

/** Messenger kind. */
export type MessengerKind =
	| "alexa"
	| "sayit"
	| "whatsapp"
	| "telegram"
	| "pushover"
	| "signal"
	| "email"
	| "matrix"
	| "discord"
	| "ntfy"
	| "pushsafer"
	| "gotify";

/** Bounds of the anti-crease fields: [min when on, max]. */
export const TRAILER_BOUNDS = {
	trailerBurstSec: [15, 180],
	trailerGapSec: [0, 600],
	trailerAfterSec: [0, 21600],
	trailerBlockVal: [0, 10000],
	trailerMaxSec: [900, 14400],
} as const;

/** Names of the anti-crease fields. */
export const TRAILER_KEYS = Object.keys(TRAILER_BOUNDS) as (keyof typeof TRAILER_BOUNDS)[];

/**
 * Normalized anti-crease fields of a raw type: empty when the filter is off (3.1.2 behaviour),
 * otherwise all five clamped to their bounds.
 *
 * @param raw - Raw type (native row or settings)
 */
export function normalizeTrailer(raw: Record<string, unknown>): Partial<Record<(typeof TRAILER_KEYS)[number], number>> {
	const val = (key: (typeof TRAILER_KEYS)[number]): number => {
		const v = parseNumber(raw[key]);
		return v !== null && Number.isFinite(v) ? Math.max(0, v) : 0;
	};
	const burst = val("trailerBurstSec");
	if (burst <= 0) {
		return {};
	}
	const clamp = (key: (typeof TRAILER_KEYS)[number], v: number, zeroOk: boolean): number => {
		const [lo, hi] = TRAILER_BOUNDS[key];
		if (zeroOk && v === 0) {
			return 0;
		}
		return Math.min(hi, Math.max(lo, v));
	};
	const max = val("trailerMaxSec");
	return {
		trailerBurstSec: clamp("trailerBurstSec", burst, false),
		trailerGapSec: clamp("trailerGapSec", val("trailerGapSec"), true),
		trailerAfterSec: clamp("trailerAfterSec", val("trailerAfterSec"), true),
		trailerBlockVal: clamp("trailerBlockVal", val("trailerBlockVal"), true),
		trailerMaxSec: clamp("trailerMaxSec", max > 0 ? max : 7200, false),
	};
}

/**
 * Bounds of the time fields (s) and of the activity share of the final phase: [min, max] for values
 * other than 0 (Spec A.2). Powers have no absolute bounds, they are in the unit of the state and only
 * follow the relative rules of `normalizeFinal`.
 */
export const FINAL_BOUNDS = {
	finalAfterSec: [0, 604_800],
	finalMinSec: [10, 86_400],
	finalQuietSec: [30, 7200],
	finalDipSec: [10, 3600],
	finalRestSec: [10, 14_400],
	finalActShare: [0.5, 0.9],
	finalCheckSec: [300, 14_400],
	finalLockSec: [600, 14_400],
} as const satisfies Partial<Record<FinalKey, readonly [number, number]>>;

/** Entries of `FINAL_BOUNDS`. */
const FINAL_RANGES = Object.entries(FINAL_BOUNDS) as [keyof typeof FINAL_BOUNDS, readonly [number, number]][];

/** Values used when a final phase field is 0, as far as they do not depend on the poll interval. */
const FINAL_ZERO = { finalQuietSec: 120, finalDipSec: 60, finalCheckSec: 1800, finalLockSec: 14_400 } as const;

/** All final phase fields as numbers (missing = 0). */
type FinalValues = Record<FinalKey, number>;

/**
 * Value of a final phase field, or its replacement when it is 0.
 *
 * @param f - Values
 * @param key - Field with a replacement for 0
 */
function finalEff(f: FinalValues, key: keyof typeof FINAL_ZERO): number {
	return f[key] > 0 ? f[key] : FINAL_ZERO[key];
}

/**
 * Rest level in effect: `finalRestVal`, otherwise `standby`.
 *
 * @param f - Values
 * @param standby - Standby threshold of the device
 */
function finalRestOf(f: FinalValues, standby: number): number {
	return f.finalRestVal > 0 ? f.finalRestVal : standby;
}

/**
 * Normalized final phase of raw settings (Spec A.2): empty while the master switch
 * (`finalMinVal` and `finalMinSec`) is off or the band is empty, otherwise all 13 fields, clamped
 * and corrected towards the safe side. Every correction is reported as a warning
 * `Device "<label>": <field> <old> → <new> (<reason>)`.
 *
 * @param raw - Raw settings (`standby` gives the rest level when `finalRestVal` is 0)
 * @param warnings - Receives the warnings
 * @param label - Device name for the warnings
 */
export function normalizeFinal(raw: Record<string, unknown>, warnings: string[], label: string): FinalSettings {
	const notes: string[] = [];
	const note = (key: FinalKey, from: number, to: number, why: string): void => {
		notes.push(`Device "${label}": ${key} ${from} → ${to} (${why})`);
	};
	const f = {} as FinalValues;
	for (const key of FINAL_KEYS) {
		const v = parseNumber(raw[key]);
		if (v === null) {
			f[key] = 0;
		} else if (v < 0) {
			f[key] = 0;
			note(key, v, 0, "negative");
		} else {
			f[key] = v;
		}
	}
	if (f.finalMinVal <= 0 || f.finalMinSec <= 0) {
		return {};
	}
	const standby = Math.max(0, parseNumber(raw.standby) ?? 0);
	const rest = finalRestOf(f, standby);
	const off = (why: string): FinalSettings => {
		warnings.push(`Device "${label}": finalMinVal ${f.finalMinVal} → 0 (${why}; final phase off)`);
		return {};
	};
	if (f.finalMinVal <= rest) {
		return off(`not above the rest level ${rest}`);
	}
	if (f.finalMaxVal > 0 && f.finalMaxVal <= f.finalMinVal) {
		return off(`finalMaxVal ${f.finalMaxVal} not above it, empty band`);
	}
	for (const [key, [lo, hi]] of FINAL_RANGES) {
		const v = f[key];
		if (v !== 0 && (v < lo || v > hi)) {
			f[key] = Math.min(hi, Math.max(lo, v));
			note(key, v, f[key], `range ${lo}–${hi}`);
		}
	}
	if (f.finalHotVal !== 0 && (f.finalMaxVal <= 0 || f.finalHotVal < f.finalMaxVal)) {
		note(
			"finalHotVal",
			f.finalHotVal,
			0,
			f.finalMaxVal > 0 ? `below finalMaxVal ${f.finalMaxVal}` : "finalMaxVal open",
		);
		f.finalHotVal = 0;
	}
	if (f.finalActVal !== 0 && (f.finalActVal < rest || f.finalActVal >= f.finalMinVal)) {
		note("finalActVal", f.finalActVal, 0, `outside ${rest}–${f.finalMinVal}, finalActShare 0 too`);
		f.finalActVal = 0;
		f.finalActShare = 0;
	} else if ((f.finalActVal === 0) !== (f.finalActShare === 0)) {
		const key = f.finalActVal === 0 ? "finalActShare" : "finalActVal";
		note(key, f[key], 0, `needs ${key === "finalActVal" ? "finalActShare" : "finalActVal"} as well`);
		f.finalActVal = 0;
		f.finalActShare = 0;
	}
	const dip = finalEff(f, "finalDipSec");
	if (finalEff(f, "finalQuietSec") < dip) {
		note("finalQuietSec", f.finalQuietSec, dip, `below finalDipSec ${dip}`);
		f.finalQuietSec = dip;
	}
	const lock = finalEff(f, "finalLockSec");
	if (finalEff(f, "finalCheckSec") > lock) {
		note("finalCheckSec", f.finalCheckSec, lock, `above finalLockSec ${lock}`);
		f.finalCheckSec = lock;
	}
	warnings.push(...notes);
	return f;
}

/**
 * Final phase fields that break a bound, a rule or a floor of the poll interval (Spec A.2); changes
 * nothing. Learned values are checked with this and dropped instead of clamped.
 *
 * Floors per poll (only for values other than 0): `finalMinSec`, `finalDipSec` ≥ 2 · poll,
 * `finalQuietSec` ≥ max(2 · poll, G), `finalRestSec` ≥ 3 · poll, `finalLockSec` ≥ 2 · poll.
 *
 * @param s - Final phase values
 * @param standby - Standby threshold of the device (rest level when `finalRestVal` is 0)
 * @param pollSec - Poll interval in s
 */
export function finalViolations(s: FinalSettings, standby: number, pollSec: number): FinalKey[] {
	const bad = new Set<FinalKey>();
	const f = {} as FinalValues;
	for (const key of FINAL_KEYS) {
		const v = s[key] ?? 0;
		if (!Number.isFinite(v) || v < 0) {
			bad.add(key);
		}
		f[key] = Number.isFinite(v) ? v : 0;
	}
	if (f.finalMinVal > 0 && f.finalMinSec > 0) {
		const rest = finalRestOf(f, standby);
		if (f.finalMinVal <= rest) {
			bad.add(f.finalRestVal > 0 ? "finalRestVal" : "finalMinVal");
		}
		if (f.finalMaxVal > 0 && f.finalMaxVal <= f.finalMinVal) {
			bad.add("finalMaxVal");
		}
		for (const [key, [lo, hi]] of FINAL_RANGES) {
			if (f[key] !== 0 && (f[key] < lo || f[key] > hi)) {
				bad.add(key);
			}
		}
		if (f.finalHotVal !== 0 && (f.finalMaxVal <= 0 || f.finalHotVal < f.finalMaxVal)) {
			bad.add("finalHotVal");
		}
		if (f.finalActVal !== 0 && (f.finalActVal < rest || f.finalActVal >= f.finalMinVal)) {
			bad.add("finalActVal");
		}
		if ((f.finalActVal === 0) !== (f.finalActShare === 0)) {
			bad.add("finalActVal");
			bad.add("finalActShare");
		}
		if (finalEff(f, "finalQuietSec") < finalEff(f, "finalDipSec")) {
			bad.add("finalQuietSec");
		}
		if (finalEff(f, "finalCheckSec") > finalEff(f, "finalLockSec")) {
			bad.add("finalCheckSec");
		}
		const poll = Math.max(1, pollSec);
		const dipRun = f.finalDipSec > 0 ? f.finalDipSec : Math.max(60, 2 * poll);
		const floors: [FinalKey, number][] = [
			["finalMinSec", 2 * poll],
			["finalDipSec", 2 * poll],
			["finalQuietSec", Math.max(2 * poll, dipRun)],
			["finalRestSec", 3 * poll],
			["finalLockSec", 2 * poll],
		];
		for (const [key, min] of floors) {
			if (f[key] !== 0 && f[key] < min) {
				bad.add(key);
			}
		}
	}
	return FINAL_KEYS.filter(k => bad.has(k));
}

/** Recipient config configuration. */
export interface RecipientConfig {
	/** Id. */
	id: string;
	/** Name. */
	name: string;
	/** Enabled. */
	enabled: boolean;
	/** Kind. */
	kind: MessengerKind;
	/** Instance. */
	instance?: string;
	/** Active from. */
	activeFrom?: string;
	/** Active until. */
	activeUntil?: string;
	/** State ID. */
	stateId?: string;
	/** Volume. */
	volume?: number;
	/** Volume state ID. */
	volumeStateId?: string;
	/** Telegram target. */
	telegramTarget?: "user" | "chatId" | "none";
	/** Target. */
	target?: string;
	/** Title. */
	title?: string;
	/** Device. */
	device?: string;
	/** Priority. */
	priority?: number;
	/** Sound. */
	sound?: string;
	/** Ttl. */
	ttl?: number;
	/** Topic. */
	topic?: string;
	/** Email from. */
	emailFrom?: string;
	/** Email to. */
	emailTo?: string;
	/** User ID. */
	userId?: string;
	/** User tag. */
	userTag?: string;
	/** User name. */
	userName?: string;
	/** Server ID. */
	serverId?: string;
	/** Channel ID. */
	channelId?: string;
}

/** Status texts configuration. */
export interface StatusTexts {
	/** Running. */
	running: string;
	/** Standby. */
	standby: string;
	/** Off. */
	off: string;
}

/** Instance config configuration. */
export interface InstanceConfig {
	/** Config version (5: the detection values live in the devices, `native.types` is only an archive). */
	configVersion: 5;
	/** Recipients. */
	recipients: RecipientConfig[];
	/** Status texts. */
	statusTexts: StatusTexts;
	/** Poll interval (seconds). */
	pollIntervalSec: number;
	/** History html. */
	historyHtml: boolean;
}

/** Action event. */
export type ActionEvent = "start" | "end" | "reminder" | "acknowledged";

/** Device action configuration. */
export interface DeviceAction {
	/** Event. */
	event: ActionEvent;
	/** State ID. */
	stateId: string;
	/** Value. */
	value: string;
}

/** Reminder config configuration. */
export interface ReminderConfig {
	/** Enabled. */
	enabled: boolean;
	/** Interval min. */
	intervalMin: number;
	/** Max count. */
	maxCount: number;
	/** Text. */
	text: string;
	/** Ack state ID. */
	ackStateId: string;
}

/** Device config configuration. */
export interface DeviceConfig {
	/** Enabled. */
	enabled: boolean;
	/** Name. */
	name: string;
	/** Detection values (unit of the power state, all fields filled in). */
	detection: DetectionSettings;
	/** Id of the built-in template the values come from; missing once the values differ from it. */
	template?: string;
	/** The values were learned (recording or history) or saved from the optimisation. */
	learned?: boolean;
	/** The values could not be taken over exactly: the device stays off until it is checked and saved. */
	needsReview?: boolean;
	/** Why the device needs a review (English). */
	reviewHint?: string;
	/** Source ID. */
	sourceId?: string;
	/** Power ID. */
	powerId: string;
	/** Switch ID. */
	switchId?: string;
	/** Start text. */
	startText: string;
	/** End text. */
	endText: string;
	/** Abort. */
	abort: boolean;
	/** Abort fixed. */
	abortFixed: boolean;
	/** Auto off. */
	autoOff: boolean;
	/** Auto off minutes. */
	autoOffMinutes: number;
	/** Recipients. */
	recipients: string[];
	/** Reminder. */
	reminder: ReminderConfig;
	/** Actions. */
	actions: DeviceAction[];
	/** Automatic optimisation of the detection (set only when on; off = the detection values of the device). */
	autoOptimize?: boolean;
	/** Report changes of the automatic optimisation as a message (set only when on). */
	optimizeNotify?: boolean;
}

const MESSENGER_KINDS: readonly MessengerKind[] = [
	"alexa",
	"sayit",
	"whatsapp",
	"telegram",
	"pushover",
	"signal",
	"email",
	"matrix",
	"discord",
	"ntfy",
	"pushsafer",
	"gotify",
];
const ACTION_EVENTS: readonly ActionEvent[] = ["start", "end", "reminder", "acknowledged"];
const DETECTION_MODES: readonly DetectionMode[] = ["count", "timed", "combined"];
const TELEGRAM_TARGETS = ["user", "chatId", "none"] as const;

/** D e f a u l t_ r e m i n d e r. */
export const DEFAULT_REMINDER: ReminderConfig = {
	enabled: false,
	intervalMin: 30,
	maxCount: 10,
	text: "",
	ackStateId: "",
};

const DEFAULT_STATUS_TEXTS: StatusTexts = { running: "in action", standby: "standby", off: "switched off" };
const DEFAULT_POLL_INTERVAL_SEC = 10;

function isRecord(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

function str(val: unknown, fallback = ""): string {
	if (typeof val === "string") {
		return val;
	}
	if (typeof val === "number" && Number.isFinite(val)) {
		return String(val);
	}
	return fallback;
}

function optStr(val: unknown): string | undefined {
	const s = str(val).trim();
	return s === "" ? undefined : s;
}

function bool(val: unknown, fallback: boolean): boolean {
	if (typeof val === "boolean") {
		return val;
	}
	if (val === "true") {
		return true;
	}
	if (val === "false") {
		return false;
	}
	return fallback;
}

function num(val: unknown, fallback: number): number {
	return parseNumber(val) ?? fallback;
}

function optNum(val: unknown): number | undefined {
	return parseNumber(val) ?? undefined;
}

function normalizeRecipient(raw: unknown, index: number, id: string, warnings: string[]): RecipientConfig | null {
	if (!isRecord(raw)) {
		warnings.push(`Recipient #${index + 1} ignored: not an object`);
		return null;
	}
	const kind = MESSENGER_KINDS.find(k => k === raw.kind);
	if (!kind) {
		warnings.push(`Recipient #${index + 1} ignored: missing or unknown kind`);
		return null;
	}
	const rec: RecipientConfig = {
		id,
		name: str(raw.name).trim() || kind,
		enabled: bool(raw.enabled, true),
		kind,
	};
	const strings = [
		"instance",
		"activeFrom",
		"activeUntil",
		"stateId",
		"volumeStateId",
		"target",
		"title",
		"device",
		"sound",
		"topic",
		"emailFrom",
		"emailTo",
		"userId",
		"userTag",
		"userName",
		"serverId",
		"channelId",
	] as const;
	for (const key of strings) {
		const v = optStr(raw[key]);
		if (v !== undefined) {
			rec[key] = v;
		}
	}
	for (const key of ["volume", "priority", "ttl"] as const) {
		const v = optNum(raw[key]);
		if (v !== undefined) {
			rec[key] = v;
		}
	}
	const tt = TELEGRAM_TARGETS.find(t => t === raw.telegramTarget);
	if (tt) {
		rec.telegramTarget = tt;
	}
	return rec;
}

/**
 * Fill in what the admin UI derives from the chosen instance: the messenger kind follows the instance,
 * the instance is taken from the speech state (or the default instance) for old rows, and SayIt/WhatsApp
 * get their fixed text state. Returns the same object if nothing changed.
 *
 * @param raw - Raw recipient row of the native
 */
export function completeRecipientRow(raw: Record<string, unknown>): Record<string, unknown> {
	const rawInstance = str(raw.instance).trim();
	const kind = kindFromInstance(rawInstance) ?? MESSENGER_KINDS.find(k => k === raw.kind);
	if (!kind) {
		return raw;
	}
	let instance = rawInstance;
	if (!instance) {
		const fromState = str(raw.stateId).split(".").slice(0, 2).join(".");
		instance = kindFromInstance(fromState) === kind ? fromState : defaultInstance(kind);
	}
	const next: Record<string, unknown> = { ...raw, kind, instance };
	const fixed = fixedTextState(kind, instance);
	if (fixed) {
		next.stateId = fixed;
	}
	const changed = (["kind", "instance", "stateId"] as const).some(k => next[k] !== raw[k]);
	return changed ? next : raw;
}

/**
 * Recipient from one row of the settings (used to test a row that is not saved yet).
 *
 * @param raw - Raw recipient row
 */
export function recipientFromRow(raw: unknown): { recipient: RecipientConfig | null; warnings: string[] } {
	const warnings: string[] = [];
	if (!isRecord(raw)) {
		return { recipient: null, warnings: ["Recipient #1 ignored: not an object"] };
	}
	const row = completeRecipientRow(raw);
	const recipient = normalizeRecipient(row, 0, str(row.id).trim() || "test", warnings);
	return { recipient, warnings };
}

/** Raw rows of the native with generated ids filled in. */
export interface IdPatch {
	/** Recipients. */
	recipients?: unknown[];
}

function generateRecipientId(raw: Record<string, unknown>, index: number, taken: Set<string>): string {
	const kind = MESSENGER_KINDS.find(k => k === raw.kind) ?? "recipient";
	const stamp = Date.now().toString(36);
	let n = index;
	let id = `${kind}-${stamp}${n}`;
	while (taken.has(id)) {
		n++;
		id = `${kind}-${stamp}${n}`;
	}
	taken.add(id);
	return id;
}

/**
 * Normalize the instance configuration (adapter native) and fill defaults.
 *
 * @param native - Raw adapter native object
 */
export function normalizeInstanceConfig(native: Record<string, unknown>): {
	config: InstanceConfig;
	warnings: string[];
	/** Whether ids were generated for recipients that had none (or a duplicate one). */
	generatedIds: boolean;
	/** Raw `recipients` rows with the generated ids filled in; to be stored in the native. */
	idPatch: IdPatch;
} {
	const warnings: string[] = [];
	const src = isRecord(native) ? native : {};
	const idPatch: IdPatch = {};

	const recipients: RecipientConfig[] = [];
	if (Array.isArray(src.recipients)) {
		const seen = new Set<string>();
		const taken = new Set<string>(
			src.recipients.map(raw => (isRecord(raw) ? str(raw.id).trim() : "")).filter(id => id !== ""),
		);
		const rawRows: unknown[] = [...src.recipients];
		src.recipients.forEach((original, i) => {
			const raw = isRecord(original) ? completeRecipientRow(original) : original;
			if (raw !== original) {
				rawRows[i] = raw;
				idPatch.recipients = rawRows;
			}
			let id = isRecord(raw) ? str(raw.id).trim() : "";
			if (isRecord(raw) && (id === "" || seen.has(id))) {
				// New (or cloned) recipient: generate a unique id that does not depend on the position
				id = generateRecipientId(raw, i, taken);
				rawRows[i] = { ...raw, id };
				idPatch.recipients = rawRows;
			}
			const r = normalizeRecipient(raw, i, id, warnings);
			if (!r) {
				return;
			}
			seen.add(r.id);
			recipients.push(r);
		});
	}

	const rawTexts = isRecord(src.statusTexts) ? src.statusTexts : {};
	const statusTexts: StatusTexts = {
		running: str(rawTexts.running) || DEFAULT_STATUS_TEXTS.running,
		standby: str(rawTexts.standby) || DEFAULT_STATUS_TEXTS.standby,
		off: str(rawTexts.off) || DEFAULT_STATUS_TEXTS.off,
	};

	const poll = num(src.pollIntervalSec, DEFAULT_POLL_INTERVAL_SEC);
	const pollIntervalSec = Math.min(600, Math.max(1, poll));

	return {
		config: {
			configVersion: 5,
			recipients,
			statusTexts,
			pollIntervalSec,
			historyHtml: bool(src.historyHtml, false),
		},
		warnings,
		generatedIds: idPatch.recipients !== undefined,
		idPatch,
	};
}

/** Values of the template "Custom", used for missing detection values. */
const CUSTOM_VALUES = {
	startVal: 30,
	endVal: 5,
	standby: 1,
	startCount: 1,
	endCount: 20,
	startDurationSec: 60,
	endDurationSec: 300,
} as const;

/** Hint and warning when a device has no detection values. */
const MISSING_DETECTION = 'detection values missing, using "Custom"';

/**
 * Normalized detection values of a device: thresholds, mode and durations (missing or invalid ones take the value
 * of the template "Custom" with a warning), pause protection, anti-crease filter and final phase (Spec A.2), all
 * fields filled in. Null if `raw` is no object.
 *
 * @param raw - Raw detection values (`native.detection`)
 * @param warnings - Receives the warnings `Device "<label>": <field> <old> → <new> (<reason>)`
 * @param label - Device name for the warnings
 */
export function normalizeDetection(raw: unknown, warnings: string[], label: string): DetectionSettings | null {
	if (!isRecord(raw)) {
		return null;
	}
	const required = (key: keyof typeof CUSTOM_VALUES): number => {
		const v = parseNumber(raw[key]);
		if (v === null || !Number.isFinite(v)) {
			const old = raw[key] === undefined ? "missing" : JSON.stringify(raw[key]);
			warnings.push(`Device "${label}": ${key} ${old} → ${CUSTOM_VALUES[key]} (not a number)`);
			return CUSTOM_VALUES[key];
		}
		return Math.max(0, v);
	};
	const optional = (key: string): number => {
		const v = parseNumber(raw[key]);
		return v !== null && Number.isFinite(v) ? Math.max(0, v) : 0;
	};
	let mode = DETECTION_MODES.find(m => m === raw.mode);
	if (!mode) {
		const old = raw.mode === undefined ? "missing" : JSON.stringify(raw.mode);
		warnings.push(`Device "${label}": mode ${old} → count (unknown mode)`);
		mode = "count";
	}
	const standby = required("standby");
	const base: DetectionSettings = {
		startVal: required("startVal"),
		endVal: required("endVal"),
		standby,
		startCount: required("startCount"),
		endCount: required("endCount"),
		mode,
		startDurationSec: required("startDurationSec"),
		endDurationSec: required("endDurationSec"),
		pauseHoldSec: optional("pauseHoldSec"),
		pauseUntilSec: optional("pauseUntilSec"),
		pauseBelowVal: optional("pauseBelowVal"),
		...normalizeTrailer(raw),
		...normalizeFinal({ ...raw, standby }, warnings, label),
	};
	return detectionOf(base);
}

/**
 * Normalize one device configuration; returns null if it is unusable (no power state).
 *
 * Without valid `detection` the values of an old device type are read (`typeId` in `legacyTypes`, nothing is
 * written; the result has no `typeId`). This only happens if the migration of a V4 test installation could not
 * write the device (`applyV4Migration`, retried at the next start).
 *
 * Without both the device gets the values of "Custom" and stays off with a review hint: such a device was
 * ignored before and must not start sending messages.
 *
 * @param native - Raw device native object
 * @param legacyTypes - Device types of an earlier version (`resolveLegacyTypes` of the instance native)
 */
export function normalizeDeviceConfig(
	native: Record<string, unknown>,
	legacyTypes?: readonly DeviceTypeConfig[],
): {
	config: DeviceConfig | null;
	warnings: string[];
} {
	const warnings: string[] = [];
	const src = isRecord(native) ? native : {};
	const name = str(src.name).trim();
	const powerId = str(src.powerId).trim();
	if (powerId === "") {
		warnings.push(`Device "${name}" ignored: no power state configured`);
		return { config: null, warnings };
	}

	const rawReminder = isRecord(src.reminder) ? src.reminder : {};
	const reminder: ReminderConfig = {
		enabled: bool(rawReminder.enabled, DEFAULT_REMINDER.enabled),
		intervalMin: Math.max(1, num(rawReminder.intervalMin, DEFAULT_REMINDER.intervalMin)),
		maxCount: Math.max(0, Math.floor(num(rawReminder.maxCount, DEFAULT_REMINDER.maxCount))),
		text: str(rawReminder.text),
		ackStateId: str(rawReminder.ackStateId).trim(),
	};

	const actions: DeviceAction[] = [];
	if (Array.isArray(src.actions)) {
		src.actions.forEach((raw, i) => {
			if (!isRecord(raw)) {
				warnings.push(`Action #${i + 1} of "${name}" ignored: not an object`);
				return;
			}
			const event = ACTION_EVENTS.find(e => e === raw.event);
			const stateId = str(raw.stateId).trim();
			if (!event || stateId === "") {
				warnings.push(`Action #${i + 1} of "${name}" ignored: missing event or state`);
				return;
			}
			actions.push({ event, stateId, value: str(raw.value) });
		});
	}

	const recipients = Array.isArray(src.recipients)
		? src.recipients.filter((r): r is string => typeof r === "string" && r !== "")
		: [];

	let detection = normalizeDetection(src.detection, warnings, name);
	let template = optStr(src.template);
	let enabled = bool(src.enabled, true);
	let needsReview = bool(src.needsReview, false);
	let reviewHint = optStr(src.reviewHint);
	const typeId = optStr(src.typeId);
	if (!detection && typeId !== undefined) {
		const type = legacyTypes?.find(t => t.id === typeId);
		if (type) {
			detection = detectionOf(type);
			if (type.builtin) {
				template = type.id;
			}
		}
	}
	if (!detection) {
		detection = detectionOf({ ...CUSTOM_VALUES, mode: "count" });
		template = undefined;
		enabled = false;
		needsReview = true;
		reviewHint = MISSING_DETECTION;
		warnings.push(`Device "${name}": ${MISSING_DETECTION}, device disabled until it is checked`);
	}

	const config: DeviceConfig = {
		enabled,
		name,
		detection,
		powerId,
		startText: str(src.startText),
		endText: str(src.endText),
		abort: bool(src.abort, false),
		abortFixed: bool(src.abortFixed, false),
		autoOff: bool(src.autoOff, false),
		autoOffMinutes: Math.max(0, num(src.autoOffMinutes, 0)),
		recipients,
		reminder,
		actions,
	};
	if (bool(src.autoOptimize, false)) {
		config.autoOptimize = true;
	}
	if (bool(src.optimizeNotify, false)) {
		config.optimizeNotify = true;
	}
	const sourceId = optStr(src.sourceId);
	if (sourceId !== undefined) {
		config.sourceId = sourceId;
	}
	const switchId = optStr(src.switchId);
	if (switchId !== undefined) {
		config.switchId = switchId;
	}
	if (template !== undefined) {
		config.template = template;
	}
	if (bool(src.learned, false)) {
		config.learned = true;
	}
	if (needsReview) {
		config.needsReview = true;
		if (reviewHint !== undefined) {
			config.reviewHint = reviewHint;
		}
	}
	return { config, warnings };
}
