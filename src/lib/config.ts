import type { DetectionMode, TypeThresholds } from "./detector/types.js";
import { allocateDeviceId } from "./ids.js";
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

/** Device type config configuration. */
export interface DeviceTypeConfig extends TypeThresholds {
	/** Id. */
	id: string;
	/** Name. */
	name: string;
	/** Builtin. */
	builtin: boolean;
	/** Mode. */
	mode: DetectionMode;
	/** Start duration (seconds). */
	startDurationSec: number;
	/** End duration (seconds). */
	endDurationSec: number;
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
	/** Config version. */
	configVersion: 4;
	/** Types. */
	types: DeviceTypeConfig[];
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
	/** Type ID. */
	typeId: string;
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

function builtinType(
	id: string,
	name: string,
	startVal: number,
	endVal: number,
	standby: number,
	startCount: number,
	endCount: number,
): DeviceTypeConfig {
	return {
		id,
		name,
		builtin: true,
		startVal,
		endVal,
		startCount,
		endCount,
		standby,
		mode: "count",
		startDurationSec: 60,
		endDurationSec: 300,
	};
}

function customType(index: number): DeviceTypeConfig {
	return {
		id: `custom${index}`,
		name: `Custom ${index}`,
		builtin: false,
		startVal: 30,
		endVal: 5,
		standby: 1,
		startCount: 1,
		endCount: 20,
		mode: "count",
		startDurationSec: 60,
		endDurationSec: 300,
	};
}

/** D e f a u l t_ t y p e s. */
export const DEFAULT_TYPES: DeviceTypeConfig[] = [
	builtinType("washing-machine", "Washing machine", 30, 15, 1, 2, 50),
	builtinType("dryer", "Dryer", 120, 15, 1, 2, 20),
	builtinType("dishwasher", "Dishwasher", 15, 0.25, 0.5, 2, 120),
	...Array.from({ length: 10 }, (_, i) => customType(i + 1)),
];

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

function normalizeType(raw: unknown, index: number, id: string, warnings: string[]): DeviceTypeConfig | null {
	if (!isRecord(raw)) {
		warnings.push(`Device type #${index + 1} ignored: not an object`);
		return null;
	}
	const builtin = DEFAULT_TYPES.find(t => t.id === id);
	const base = builtin ?? customType(0);
	const mode = DETECTION_MODES.find(m => m === raw.mode) ?? "count";
	return {
		id,
		name: str(raw.name).trim() || base.name,
		builtin: builtin?.builtin ?? false,
		startVal: Math.max(0, num(raw.startVal, base.startVal)),
		endVal: Math.max(0, num(raw.endVal, base.endVal)),
		standby: Math.max(0, num(raw.standby, base.standby)),
		startCount: Math.max(0, num(raw.startCount, base.startCount)),
		endCount: Math.max(0, num(raw.endCount, base.endCount)),
		mode,
		startDurationSec: Math.max(0, num(raw.startDurationSec, 60)),
		endDurationSec: Math.max(0, num(raw.endDurationSec, 300)),
	};
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

/** Raw rows of the native with generated ids filled in. */
export interface IdPatch {
	/** Recipients. */
	recipients?: unknown[];
	/** Device types. */
	types?: unknown[];
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
	/** Whether ids were generated for recipients or types that had none (or a duplicate one). */
	generatedIds: boolean;
	/** Raw `recipients` / `types` rows with the generated ids filled in; to be stored in the native. */
	idPatch: IdPatch;
} {
	const warnings: string[] = [];
	const src = isRecord(native) ? native : {};
	const idPatch: IdPatch = {};

	let types: DeviceTypeConfig[] = [];
	if (Array.isArray(src.types)) {
		const seen = new Set<string>();
		const taken = new Set<string>([
			...DEFAULT_TYPES.map(t => t.id),
			...src.types.map(raw => (isRecord(raw) ? str(raw.id).trim() : "")).filter(id => id !== ""),
		]);
		const rawRows: unknown[] = [...src.types];
		src.types.forEach((raw, i) => {
			let id = isRecord(raw) ? str(raw.id).trim() : "";
			if (isRecord(raw) && id === "") {
				// A type added in the admin table has no id yet: derive a stable one from its name
				id = allocateDeviceId(str(raw.name).trim() || "custom", taken);
				taken.add(id);
				rawRows[i] = { ...raw, id };
				idPatch.types = rawRows;
			}
			const t = normalizeType(raw, i, id, warnings);
			if (!t) {
				return;
			}
			if (seen.has(t.id)) {
				warnings.push(`Device type "${t.id}" ignored: duplicate id`);
				return;
			}
			seen.add(t.id);
			types.push(t);
		});
	}
	if (types.length === 0) {
		types = DEFAULT_TYPES.map(t => ({ ...t }));
	} else {
		const missing = DEFAULT_TYPES.filter(d => d.builtin && !types.some(t => t.id === d.id));
		types = [...missing.map(t => ({ ...t })), ...types];
	}

	const recipients: RecipientConfig[] = [];
	if (Array.isArray(src.recipients)) {
		const seen = new Set<string>();
		const taken = new Set<string>(
			src.recipients.map(raw => (isRecord(raw) ? str(raw.id).trim() : "")).filter(id => id !== ""),
		);
		const rawRows: unknown[] = [...src.recipients];
		src.recipients.forEach((raw, i) => {
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
			configVersion: 4,
			types,
			recipients,
			statusTexts,
			pollIntervalSec,
			historyHtml: bool(src.historyHtml, false),
		},
		warnings,
		generatedIds: idPatch.recipients !== undefined || idPatch.types !== undefined,
		idPatch,
	};
}

/**
 * Normalize one device configuration; returns null if it is unusable.
 *
 * @param native - Raw device native object
 */
export function normalizeDeviceConfig(native: Record<string, unknown>): {
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

	const config: DeviceConfig = {
		enabled: bool(src.enabled, true),
		name,
		typeId: str(src.typeId).trim(),
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
	const sourceId = optStr(src.sourceId);
	if (sourceId !== undefined) {
		config.sourceId = sourceId;
	}
	const switchId = optStr(src.switchId);
	if (switchId !== undefined) {
		config.switchId = switchId;
	}
	return { config, warnings };
}

/**
 * Find a device type by id.
 *
 * @param config - Instance configuration
 * @param typeId - Type id
 */
export function findType(config: InstanceConfig, typeId: string): DeviceTypeConfig | undefined {
	return config.types.find(t => t.id === typeId);
}
