import {
	DEFAULT_REMINDER,
	normalizeInstanceConfig,
	type DeviceConfig,
	type InstanceConfig,
	type MessengerKind,
	type RecipientConfig,
} from "./config.js";
import type { DetectionSettings, TypeThresholds } from "./detector/types.js";
import { allocateDeviceId, sanitizeId } from "./ids.js";
import type { DeviceTypeConfig } from "./legacyTypes.js";
import { detectionOf } from "./runStore.js";
import { CUSTOM_TEMPLATE, TEMPLATES, type Template } from "./templates.js";
import { DEVICE_STATES } from "./stateDefinitions.js";
import { errorMessage, parseNumber } from "./utils.js";

/** Result of the conversion of a 3.1.2 configuration. */
export interface MigrationResult {
	/** New instance configuration (adapter native). */
	instance: InstanceConfig;
	/** 3.1.2 types no device uses whose values or name differ from the template: `native.types` (archive). */
	archive: DeviceTypeConfig[];
	/** Devices with their new object ID, the 3.1.2 name (prefix of the old states) and the config. */
	devices: { id: string; oldName: string; config: DeviceConfig }[];
	/** Entries that could not be taken over completely. */
	warnings: string[];
}

/** Object and state access needed to move the 3.1.2 states (implemented by the adapter). */
export interface LegacyStateIo {
	/** Read an own state value (ID relative to the adapter namespace); null if it does not exist. */
	getOwnState(id: string): Promise<ioBroker.StateValue | null>;
	/** Write an own state value (ID relative to the adapter namespace, acknowledged). */
	setOwnState(id: string, v: ioBroker.StateValue): Promise<void>;
	/** Own object IDs (relative to the adapter namespace) below `prefix` (`<prefix>.…`). */
	getObjectIds(prefix: string): Promise<string[]>;
	/** Delete an own object (ID relative to the adapter namespace). */
	delObject(id: string): Promise<void>;
	/** Create or update the V4 device objects (`ensureDeviceObjects`). */
	ensureDevice(id: string, config: DeviceConfig): Promise<void>;
	/** Check whether a foreign object exists (power state of a device). */
	foreignObjectExists(id: string): Promise<boolean>;
}

/** 3.1.2 state (relative to `<oldName>`) → V4 state (relative to the device ID) whose value is taken over. */
export const LEGACY_STATE_MAP: Record<string, string> = {
	"last operations": "lastOperations",
	lastRuntime: "lastRuntime",
	"config.do not disturb": "config.doNotDisturb",
	"config.runtime max": "config.runtimeMax",
};

/** All states 3.1.2 created per device (`<oldName>.<leaf>`, see 3.1.2 `lib/states.js`). */
export const LEGACY_LEAVES: string[] = [
	"Status",
	"live consumption",
	"runtime",
	"runtime in ms",
	"lastRuntime",
	"messageDP",
	"average consumption",
	"alert runtime",
	"last operations",
	"config.do not disturb",
	"config.runtime max",
];

/** Messenger tables of 3.1.2 in the order recipients are created. */
const LEGACY_MESSENGERS = [
	"alexa",
	"sayit",
	"whatsapp",
	"telegram",
	"pushover",
	"signal",
	"email",
	"matrix",
	"discord",
] as const satisfies readonly MessengerKind[];
type LegacyMessenger = (typeof LEGACY_MESSENGERS)[number];

/** Top-level keys of a 3.1.2 native (tables of 3.1.2 `admin/lib/data.js`). */
const KNOWN_NATIVE_KEYS = new Set<string>([
	"linkedDevice",
	"devices",
	"default",
	"custom",
	"status",
	...LEGACY_MESSENGERS,
]);

/** Fields of a `linkedDevice.finalIds` entry (3.1.2 `admin/lib/index_m.js` `createArray`). */
const KNOWN_DEVICE_FIELDS = new Set<string>([
	"id",
	"enabled",
	"name",
	"type",
	"pathConsumption",
	"pathSwitch",
	"startText",
	"endText",
	"runtimeMax",
	"timer",
	"autoOff",
	"abort",
	...LEGACY_MESSENGERS,
]);

/** Adapter name per messenger for `inst` (`.0` → `<adapter>.0`). */
const INSTANCE_ADAPTER: Partial<Record<LegacyMessenger, string>> = {
	telegram: "telegram",
	pushover: "pushover",
	signal: "signal-cmb",
	matrix: "matrix-org",
	discord: "discord",
};

const PUSHOVER_PRIORITY: Record<string, number> = { normal: 0, high: 1, quiet: -1, confirmation: 2 };
const DEFAULT_VOICE_VOLUME = 50;
const CUSTOM_ID = /^custom(\d+)$/;

function isRecord(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

function str(val: unknown): string {
	if (typeof val === "string") {
		return val.trim();
	}
	if (typeof val === "number" && Number.isFinite(val)) {
		return String(val);
	}
	return "";
}

function bool(val: unknown): boolean {
	return val === true || val === "true";
}

/**
 * Rows of a 3.1.2 table (`native.<table>.ids`); missing or broken tables are empty.
 *
 * @param native - 3.1.2 native
 * @param table - Table name
 */
function rows(native: Record<string, unknown>, table: string): unknown[] {
	const t = native[table];
	return isRecord(t) && Array.isArray(t.ids) ? t.ids : [];
}

/**
 * Set an optional string field only if it is not empty.
 *
 * @param rec - Recipient to extend
 * @param key - Field name
 * @param val - Raw 3.1.2 value
 */
function putStr<K extends keyof RecipientConfig>(rec: RecipientConfig, key: K, val: unknown): void {
	const s = str(val);
	if (s !== "") {
		(rec as unknown as Record<string, unknown>)[key] = s;
	}
}

/**
 * `.0` / `0` → `<adapter>.0`; a complete instance ID is kept.
 *
 * @param kind - Messenger
 * @param inst - 3.1.2 `inst` value
 */
function instanceId(kind: LegacyMessenger, inst: unknown): string | undefined {
	const adapter = INSTANCE_ADAPTER[kind];
	const s = str(inst);
	if (!adapter || s === "") {
		return undefined;
	}
	if (/^\.?\d+$/.test(s)) {
		return `${adapter}.${s.replace(/^\./, "")}`;
	}
	return s;
}

function convertRecipient(kind: LegacyMessenger, row: Record<string, unknown>, id: string): RecipientConfig {
	const rec: RecipientConfig = { id, name: str(row.name) || id, enabled: true, kind };
	const instance = instanceId(kind, row.inst);
	if (instance !== undefined) {
		rec.instance = instance;
	}
	switch (kind) {
		case "alexa":
		case "sayit": {
			putStr(rec, "stateId", row.path);
			const volume = parseNumber(row.volume);
			// 3.1.2 admin: volume outside 0..100 or empty → 50
			rec.volume = volume === null || volume < 0 || volume > 100 ? DEFAULT_VOICE_VOLUME : volume;
			putStr(rec, "activeFrom", row.activeFrom);
			putStr(rec, "activeUntil", row.activeUntil);
			break;
		}
		case "whatsapp":
			putStr(rec, "stateId", row.path);
			break;
		case "telegram":
			// 3.1.2 sent {[key]: username}; the telegram adapter expects `user` (user name or first name) or `chatId`
			rec.telegramTarget = str(row.key) === "chatID" ? "chatId" : "user";
			putStr(rec, "target", row.username);
			break;
		case "pushover": {
			putStr(rec, "title", row.title);
			putStr(rec, "device", row.deviceID);
			rec.priority = PUSHOVER_PRIORITY[str(row.prio)] ?? 0;
			putStr(rec, "sound", row.sound);
			const ttl = parseNumber(row.ttl);
			if (ttl !== null) {
				rec.ttl = ttl;
			}
			break;
		}
		case "email":
			putStr(rec, "emailFrom", row.emailFrom);
			putStr(rec, "emailTo", row.emailTo);
			break;
		case "discord":
			putStr(rec, "userId", row.userId);
			putStr(rec, "userTag", row.userTag);
			putStr(rec, "userName", row.userName);
			putStr(rec, "serverId", row.serverId);
			putStr(rec, "channelId", row.channelId);
			break;
		default:
			break;
	}
	return rec;
}

/**
 * Recipients of all messenger tables. `paths` holds the 3.1.2 target of SayIt/WhatsApp rows: V4 derives the
 * target from the instance, a different one is reported after the normalization.
 *
 * @param native - 3.1.2 native
 * @param warnings - Receives the warnings
 */
function convertRecipients(
	native: Record<string, unknown>,
	warnings: string[],
): { recipients: RecipientConfig[]; paths: Map<string, string> } {
	const result: RecipientConfig[] = [];
	const paths = new Map<string, string>();
	const seen = new Set<string>();
	for (const kind of LEGACY_MESSENGERS) {
		rows(native, kind).forEach((row, i) => {
			const oldId = isRecord(row) ? str(row.id) : "";
			if (!isRecord(row) || oldId === "") {
				warnings.push(`Recipient ${kind} row ${i + 1} ignored: no id`);
				return;
			}
			const id = `${kind}-${oldId}`;
			if (seen.has(id)) {
				warnings.push(`Recipient ${kind} #${oldId} ignored: duplicate id`);
				return;
			}
			seen.add(id);
			result.push(convertRecipient(kind, row, id));
			if ((kind === "sayit" || kind === "whatsapp") && str(row.path) !== "") {
				paths.set(id, str(row.path));
			}
		});
	}
	return { recipients: result, paths };
}

/** How the type of a 3.1.2 device was found (`matchLegacyType`). */
export type LegacyTypeMatch = "default" | "custom" | "case" | "slot" | "none";

/** The five type values of 3.1.2. */
const LEGACY_VALUE_KEYS = ["startVal", "endVal", "standby", "startCount", "endCount"] as const;

/** One row of `default.ids`/`custom.ids` with its values read. */
interface LegacyTypeRow {
	/** Raw row. */
	raw: Record<string, unknown>;
	/** Table of the row. */
	table: "default" | "custom";
	/** Name of the row as 3.1.2 compared it (untrimmed). */
	name: string;
	/** Built-in template of a `default.ids` row (by its name); undefined for custom rows. */
	template?: Template;
	/** The five values (non-numeric ones replaced by the template value). */
	values: TypeThresholds;
	/** Id of the row in the archive (`native.types`). */
	archiveId: string;
}

/**
 * Text of a raw value as 3.1.2 compared it (`==`): strings unchanged, finite numbers as text, everything else empty.
 *
 * @param val - Raw value
 */
function rawText(val: unknown): string {
	if (typeof val === "string") {
		return val;
	}
	return typeof val === "number" && Number.isFinite(val) ? String(val) : "";
}

/**
 * Last element of a list that fulfils the predicate (3.1.2 looped over all rows, the last match won).
 *
 * @param list - Rows
 * @param pred - Predicate
 */
function lastOf<T>(list: readonly T[], pred: (item: T) => boolean): T | null {
	for (let i = list.length - 1; i >= 0; i--) {
		if (pred(list[i])) {
			return list[i];
		}
	}
	return null;
}

/**
 * Find the 3.1.2 type row of a device like 3.1.2 (`main.js` 456-503): exact, untrimmed name in `default.ids` (the
 * last match wins), otherwise exact in `custom.ids` (the last match wins). 3.1.2 never finished a device without
 * such a match; for these the values are taken, in this order, from a row whose name matches only trimmed and
 * case-insensitive (`case`, default before custom), from the custom row of the original slot `customN` (row id
 * N-1, the row was renamed after the device was set up: `slot`), or not at all (`none`: template "Custom").
 *
 * @param typeName - `type` of the 3.1.2 device (untrimmed)
 * @param defaults - Rows of `default.ids`
 * @param customs - Rows of `custom.ids`
 */
export function matchLegacyType(
	typeName: string,
	defaults: Record<string, unknown>[],
	customs: Record<string, unknown>[],
): { row: Record<string, unknown> | null; via: LegacyTypeMatch } {
	if (typeName === "") {
		return { row: null, via: "none" };
	}
	const exact = (r: Record<string, unknown>): boolean => rawText(r.name) === typeName;
	const fromDefault = lastOf(defaults, exact);
	if (fromDefault) {
		return { row: fromDefault, via: "default" };
	}
	const fromCustom = lastOf(customs, exact);
	if (fromCustom) {
		return { row: fromCustom, via: "custom" };
	}
	const key = typeName.trim().toLowerCase();
	const loose = (r: Record<string, unknown>): boolean => rawText(r.name).trim().toLowerCase() === key;
	const fromCase = key === "" ? null : (lastOf(defaults, loose) ?? lastOf(customs, loose));
	if (fromCase) {
		return { row: fromCase, via: "case" };
	}
	const slot = CUSTOM_ID.exec(typeName.trim());
	const fromSlot = slot ? lastOf(customs, r => parseNumber(r.id) === Number(slot[1]) - 1) : null;
	if (fromSlot) {
		return { row: fromSlot, via: "slot" };
	}
	return { row: null, via: "none" };
}

/**
 * The five values of a type row; empty, non-numeric or negative values are replaced with a warning.
 *
 * @param row - Raw row
 * @param base - Values of the template the row belongs to
 * @param label - `Type "<name>"` for the warnings
 * @param warnings - Receives the warnings
 */
function typeValues(
	row: Record<string, unknown>,
	base: TypeThresholds,
	label: string,
	warnings: string[],
): TypeThresholds {
	const out: TypeThresholds = {
		startVal: base.startVal,
		endVal: base.endVal,
		standby: base.standby,
		startCount: base.startCount,
		endCount: base.endCount,
	};
	for (const key of LEGACY_VALUE_KEYS) {
		const raw = row[key];
		const old = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : JSON.stringify(raw);
		const val = parseNumber(raw);
		if (val === null) {
			warnings.push(`${label}: ${key} "${old}" is not a number, using ${base[key]}`);
		} else if (val < 0) {
			warnings.push(`${label}: ${key} "${old}" is negative, using 0`);
			out[key] = 0;
		} else {
			// 3.1.2 compared "12,5" as NaN (the device never started); V4 reads the value the user entered
			if (typeof raw === "string" && Number.isNaN(Number(raw))) {
				warnings.push(`${label}: ${key} "${old}" read as ${val}`);
			}
			out[key] = val;
		}
	}
	return out;
}

/**
 * Read `default.ids` and `custom.ids`: values per row (with warnings for comments and invalid values) and the id
 * each row gets in the archive (built-in id or `customN`, as before; unique).
 *
 * @param native - 3.1.2 native
 * @param warnings - Receives the warnings
 */
function readTypeRows(
	native: Record<string, unknown>,
	warnings: string[],
): { defaults: LegacyTypeRow[]; customs: LegacyTypeRow[] } {
	const read = (raw: Record<string, unknown>, table: LegacyTypeRow["table"], template?: Template): LegacyTypeRow => {
		const name = rawText(raw.name);
		const label = `Type "${name.trim()}"`;
		const comment = rawText(raw.comment).trim();
		if (comment !== "") {
			warnings.push(`${label}: comment "${comment}" not migrated`);
		}
		const values = typeValues(raw, (template ?? CUSTOM_TEMPLATE).detection, label, warnings);
		return { raw, table, name, template, values, archiveId: "" };
	};
	const builtin = (name: string): Template | undefined =>
		TEMPLATES.find(t => t.id !== CUSTOM_TEMPLATE.id && t.id === name.trim().toLowerCase());
	const defaults = rows(native, "default")
		.filter(isRecord)
		.map(raw => read(raw, "default", builtin(rawText(raw.name))));
	const customs = rows(native, "custom")
		.filter(isRecord)
		.map(raw => read(raw, "custom"));

	const taken = new Set<string>();
	const take = (row: LegacyTypeRow, id: string): void => {
		row.archiveId = taken.has(id) ? allocateDeviceId(id, taken) : id;
		taken.add(row.archiveId);
	};
	for (const row of defaults.filter(r => r.template)) {
		take(row, (row.template as Template).id);
	}
	// 3.1.2 row id 0..9 belongs to custom1..custom10 (the name may have been changed by the user)
	const pending: LegacyTypeRow[] = [];
	for (const row of customs) {
		const rowId = parseNumber(row.raw.id);
		const fromName = CUSTOM_ID.exec(row.name.trim());
		const n =
			rowId !== null && Number.isInteger(rowId) && rowId >= 0 ? rowId + 1 : fromName ? Number(fromName[1]) : null;
		if (n === null || taken.has(`custom${n}`)) {
			pending.push(row);
		} else {
			take(row, `custom${n}`);
		}
	}
	for (const row of pending) {
		let n = 1;
		while (taken.has(`custom${n}`)) {
			n++;
		}
		take(row, `custom${n}`);
	}
	for (const row of defaults.filter(r => !r.template)) {
		take(row, sanitizeId(row.name.trim() || "type"));
	}
	return { defaults, customs };
}

/**
 * Archive (`native.types`): the type rows no device uses whose values or name differ from their template (built-in
 * template of the same name, "Custom" with the slot name `customN` for custom rows), in the order of the tables.
 *
 * @param typeRows - Rows of both tables
 * @param used - Raw rows a device uses
 */
function archiveOf(typeRows: readonly LegacyTypeRow[], used: ReadonlySet<Record<string, unknown>>): DeviceTypeConfig[] {
	const out: DeviceTypeConfig[] = [];
	for (const row of typeRows) {
		if (used.has(row.raw)) {
			continue;
		}
		const ref = (row.template ?? CUSTOM_TEMPLATE).detection;
		// a default row with a foreign name has no template: it always differs
		const refName = row.template?.id ?? (row.table === "custom" ? row.archiveId : null);
		const same = refName !== null && row.name === refName && LEGACY_VALUE_KEYS.every(k => row.values[k] === ref[k]);
		if (same) {
			continue;
		}
		out.push({
			id: row.archiveId,
			name: row.name.trim() || row.archiveId,
			builtin: row.template !== undefined && row.template.id === row.archiveId,
			...row.values,
			mode: "count",
			startDurationSec: 60,
			endDurationSec: 300,
			pauseHoldSec: 0,
			pauseUntilSec: 0,
			pauseBelowVal: 0,
		});
	}
	return out;
}

/** Type rows of the 3.1.2 native, read once for all devices. */
interface TypeTables {
	/** Rows of `default.ids`. */
	defaults: LegacyTypeRow[];
	/** Rows of `custom.ids`. */
	customs: LegacyTypeRow[];
	/** Raw rows a device uses (filled while the devices are converted). */
	used: Set<Record<string, unknown>>;
}

/**
 * Detection values of a 3.1.2 device: a copy of the values of its type row (`matchLegacyType`) on the base of the
 * template (count, 60/300 s, pause protection, anti-crease filter and final phase off). Without an exact match the
 * device is disabled with a review hint.
 *
 * @param typeName - `type` of the 3.1.2 device
 * @param tables - Type rows
 */
function deviceDetection(
	typeName: string,
	tables: TypeTables,
): { detection: DetectionSettings; template?: string; reviewHint?: string } {
	const { row, via } = matchLegacyType(
		typeName,
		tables.defaults.map(r => r.raw),
		tables.customs.map(r => r.raw),
	);
	const found = row ? [...tables.defaults, ...tables.customs].find(r => r.raw === row) : undefined;
	if (!found) {
		return {
			detection: detectionOf(CUSTOM_TEMPLATE.detection),
			reviewHint: `3.1.2 type "${typeName}" not found exactly; values taken from template Custom`,
		};
	}
	tables.used.add(found.raw);
	const detection = detectionOf({ ...(found.template ?? CUSTOM_TEMPLATE).detection, ...found.values });
	if (via === "default" || via === "custom") {
		return via === "default" && found.template ? { detection, template: found.template.id } : { detection };
	}
	const from = via === "case" ? `case match "${found.name}"` : `renamed slot ${typeName.trim()}`;
	return { detection, reviewHint: `3.1.2 type "${typeName}" not found exactly; values taken from ${from}` };
}

function convertDevice(
	raw: Record<string, unknown>,
	tables: TypeTables,
	recipientIds: ReadonlySet<string>,
	warnings: string[],
): DeviceConfig {
	const name = str(raw.name);
	const label = `Device "${name}"`;
	for (const key of Object.keys(raw)) {
		if (!KNOWN_DEVICE_FIELDS.has(key)) {
			warnings.push(`${label}: unknown field "${key}" not migrated`);
		}
	}

	const { detection, template, reviewHint } = deviceDetection(rawText(raw.type), tables);
	if (reviewHint !== undefined) {
		warnings.push(`${label}: ${reviewHint}; device disabled`);
	}

	const recipients: string[] = [];
	for (const kind of LEGACY_MESSENGERS) {
		const refs = raw[kind];
		if (!Array.isArray(refs)) {
			continue;
		}
		for (const ref of refs) {
			const id = `${kind}-${str(ref)}`;
			if (!recipientIds.has(id)) {
				warnings.push(`${label}: recipient ${kind} #${str(ref)} does not exist, removed`);
			} else if (!recipients.includes(id)) {
				recipients.push(id);
			}
		}
	}

	const powerId = str(raw.pathConsumption);
	if (powerId === "") {
		warnings.push(`${label}: no power state configured`);
	}
	const config: DeviceConfig = {
		enabled: reviewHint === undefined && bool(raw.enabled),
		name,
		detection,
		powerId,
		startText: typeof raw.startText === "string" ? raw.startText : "",
		endText: typeof raw.endText === "string" ? raw.endText : "",
		abort: bool(raw.abort),
		abortFixed: false,
		autoOff: bool(raw.autoOff),
		autoOffMinutes: Math.max(0, Math.floor(parseNumber(raw.timer) ?? 0)),
		recipients,
		reminder: { ...DEFAULT_REMINDER },
		actions: [],
	};
	const switchId = str(raw.pathSwitch);
	if (switchId !== "") {
		config.switchId = switchId;
	}
	if (template !== undefined) {
		config.template = template;
	}
	if (reviewHint !== undefined) {
		config.needsReview = true;
		config.reviewHint = reviewHint;
	}
	return config;
}

/**
 * Detect a 3.1.2 native: no `configVersion` and at least one of the 3.1.2 tables.
 *
 * @param native - Adapter native object
 */
export function isLegacyConfig(native: Record<string, unknown>): boolean {
	if (!isRecord(native) || native.configVersion !== undefined) {
		return false;
	}
	return native.linkedDevice !== undefined || native.status !== undefined || native.default !== undefined;
}

/**
 * Convert a 3.1.2 native to the V4 instance configuration and device configurations (pure, no I/O).
 * Missing tables are treated as empty, all new options are off, nothing throws.
 *
 * @param native - 3.1.2 adapter native object
 */
export function migrateLegacyConfig(native: Record<string, unknown>): MigrationResult {
	const warnings: string[] = [];
	const src = isRecord(native) ? native : {};
	for (const key of Object.keys(src)) {
		if (!KNOWN_NATIVE_KEYS.has(key)) {
			warnings.push(`Unknown setting "${key}" not migrated`);
		}
	}

	const { recipients, paths } = convertRecipients(src, warnings);
	const { defaults, customs } = readTypeRows(src, warnings);
	const tables: TypeTables = { defaults, customs, used: new Set() };
	const statusRow = rows(src, "status")[0];
	const status = isRecord(statusRow) ? statusRow : {};
	const normalized = normalizeInstanceConfig({
		recipients,
		statusTexts: { running: str(status.stateAction), standby: str(status.stateStandby), off: str(status.stateOff) },
	});
	warnings.push(...normalized.warnings);
	const instance = normalized.config;
	for (const r of instance.recipients) {
		const path = paths.get(r.id);
		if (path !== undefined && r.stateId !== path) {
			warnings.push(`Recipient ${r.id}: target "${path}" replaced by "${r.stateId ?? ""}"`);
		}
	}

	const recipientIds = new Set(instance.recipients.map(r => r.id));
	const devices: MigrationResult["devices"] = [];
	const taken = new Set<string>();
	const linked = isRecord(src.linkedDevice) ? src.linkedDevice.finalIds : undefined;
	if (isRecord(linked)) {
		for (const [key, raw] of Object.entries(linked)) {
			if (!isRecord(raw)) {
				warnings.push(`Device #${key} ignored: not an object`);
				continue;
			}
			const config = convertDevice(raw, tables, recipientIds, warnings);
			const id = allocateDeviceId(config.name, taken);
			taken.add(id);
			// 3.1.2 used the untrimmed name as state prefix
			const oldName = typeof raw.name === "string" && raw.name !== "" ? raw.name : config.name;
			devices.push({ id, oldName, config });
		}
	}
	return { instance, archive: archiveOf([...defaults, ...customs], tables.used), devices, warnings };
}

/**
 * Convert an old state value to the type of the new state; null if it does not fit.
 *
 * @param newLeaf - V4 state ID relative to the device
 * @param val - Old value
 */
function coerce(newLeaf: string, val: ioBroker.StateValue): ioBroker.StateValue {
	const type = DEVICE_STATES.find(d => d.id === newLeaf)?.type;
	switch (type) {
		case "number":
			return parseNumber(val);
		case "boolean":
			if (val === true || val === "true" || val === 1 || val === "1") {
				return true;
			}
			if (val === false || val === "false" || val === 0 || val === "0") {
				return false;
			}
			return null;
		default:
			return typeof val === "string" ? val : String(val);
	}
}

/**
 * Move the 3.1.2 states: read the old values, delete the old objects `<oldName>.<LEGACY_LEAVES>`,
 * create the V4 device objects and write the values according to `LEGACY_STATE_MAP`.
 * Errors of one device are reported as warning, the other devices are migrated anyway.
 *
 * @param io - Object/state access
 * @param devices - Devices from `migrateLegacyConfig`
 * @returns Warnings
 */
export async function migrateLegacyStates(io: LegacyStateIo, devices: MigrationResult["devices"]): Promise<string[]> {
	const warnings: string[] = [];

	// 1. read all old values first: devices with the same 3.1.2 name shared their states
	const oldValues = new Map<string, Map<string, ioBroker.StateValue>>();
	for (const d of devices) {
		if (oldValues.has(d.oldName)) {
			continue;
		}
		const values = new Map<string, ioBroker.StateValue>();
		oldValues.set(d.oldName, values);
		try {
			for (const [oldLeaf, newLeaf] of Object.entries(LEGACY_STATE_MAP)) {
				const val = await io.getOwnState(`${d.oldName}.${oldLeaf}`);
				if (val !== null && val !== undefined) {
					values.set(newLeaf, val);
				}
			}
		} catch (err) {
			warnings.push(`Device "${d.oldName}": reading old states failed: ${errorMessage(err)}`);
		}
	}

	// 2. delete only the states 3.1.2 created, before the new objects exist (IDs may be equal)
	for (const oldName of oldValues.keys()) {
		try {
			const leaves = new Set(LEGACY_LEAVES.map(l => `${oldName}.${l}`));
			for (const id of await io.getObjectIds(oldName)) {
				if (leaves.has(id)) {
					await io.delObject(id);
				}
			}
		} catch (err) {
			warnings.push(`Device "${oldName}": deleting old states failed: ${errorMessage(err)}`);
		}
	}

	// 3. create the new device objects and write the values
	for (const d of devices) {
		const label = `Device "${d.config.name}"`;
		try {
			await io.ensureDevice(d.id, d.config);
			if (d.config.powerId !== "" && !(await io.foreignObjectExists(d.config.powerId))) {
				warnings.push(`${label}: power state "${d.config.powerId}" does not exist`);
			}
			for (const [newLeaf, val] of oldValues.get(d.oldName) ?? []) {
				const v = coerce(newLeaf, val);
				if (v !== null) {
					await io.setOwnState(`${d.id}.${newLeaf}`, v);
				}
			}
		} catch (err) {
			warnings.push(`${label}: state migration failed: ${errorMessage(err)}`);
		}
	}
	return warnings;
}
