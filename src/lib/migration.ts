import {
	DEFAULT_REMINDER,
	DEFAULT_TYPES,
	normalizeInstanceConfig,
	type DeviceConfig,
	type DeviceTypeConfig,
	type InstanceConfig,
	type MessengerKind,
	type RecipientConfig,
} from "./config.js";
import { allocateDeviceId } from "./ids.js";
import { DEVICE_STATES } from "./stateDefinitions.js";
import { errorMessage, parseNumber } from "./utils.js";

/** Result of the conversion of a 3.1.2 configuration. */
export interface MigrationResult {
	/** New instance configuration (adapter native). */
	instance: InstanceConfig;
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
	matrix: "matrix",
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

function convertRecipients(native: Record<string, unknown>, warnings: string[]): RecipientConfig[] {
	const result: RecipientConfig[] = [];
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
		});
	}
	return result;
}

function thresholds(row: Record<string, unknown>, base: DeviceTypeConfig): DeviceTypeConfig {
	const n = (val: unknown, fallback: number): number => Math.max(0, parseNumber(val) ?? fallback);
	return {
		...base,
		startVal: n(row.startVal, base.startVal),
		endVal: n(row.endVal, base.endVal),
		standby: n(row.standby, base.standby),
		startCount: n(row.startCount, base.startCount),
		endCount: n(row.endCount, base.endCount),
	};
}

/**
 * Convert `default.ids`/`custom.ids` to V4 types.
 *
 * @param native - 3.1.2 native
 * @returns The types and the 3.1.2 type name → V4 type ID lookup (default types before custom types, as in 3.1.2)
 */
function convertTypes(native: Record<string, unknown>): { types: DeviceTypeConfig[]; byName: Map<string, string> } {
	const types = DEFAULT_TYPES.map(t => ({ ...t }));
	const defaultNames = new Map<string, string>();
	const customNames = new Map<string, string>();
	const replace = (t: DeviceTypeConfig): void => {
		const idx = types.findIndex(x => x.id === t.id);
		if (idx >= 0) {
			types[idx] = t;
		} else {
			types.push(t);
		}
	};

	for (const row of rows(native, "default")) {
		if (!isRecord(row)) {
			continue;
		}
		const name = str(row.name);
		const base = types.find(t => t.builtin && (t.id === name || t.name.toLowerCase() === name.toLowerCase()));
		if (!base) {
			continue;
		}
		replace(thresholds(row, base));
		defaultNames.set(name, base.id);
	}

	const addCustom = (row: Record<string, unknown>, id: string): void => {
		const base = types.find(t => t.id === id) ?? { ...DEFAULT_TYPES[DEFAULT_TYPES.length - 1], id, name: id };
		const legacyName = str(row.name);
		// renamed custom types keep their name, unchanged ones (`customN`) get the V4 default name
		const name = legacyName !== "" && legacyName !== id ? legacyName : base.name;
		replace({ ...thresholds(row, base), id, name, builtin: false });
		if (legacyName !== "") {
			customNames.set(legacyName, id);
		}
	};

	const used = new Set<string>();
	const customRows = rows(native, "custom").filter(isRecord);
	const pending: Record<string, unknown>[] = [];
	for (const row of customRows) {
		// 3.1.2 row id 0..9 belongs to custom1..custom10 (the name may have been changed by the user)
		const rowId = parseNumber(row.id);
		const fromName = CUSTOM_ID.exec(str(row.name));
		const n =
			rowId !== null && Number.isInteger(rowId) && rowId >= 0 ? rowId + 1 : fromName ? Number(fromName[1]) : null;
		if (n === null || used.has(`custom${n}`)) {
			pending.push(row);
			continue;
		}
		used.add(`custom${n}`);
		addCustom(row, `custom${n}`);
	}
	for (const row of pending) {
		let n = 1;
		while (used.has(`custom${n}`)) {
			n++;
		}
		used.add(`custom${n}`);
		addCustom(row, `custom${n}`);
	}

	const byName = new Map<string, string>();
	for (const t of types) {
		byName.set(t.id, t.id);
	}
	for (const [name, id] of customNames) {
		byName.set(name, id);
	}
	for (const [name, id] of defaultNames) {
		byName.set(name, id);
	}
	return { types, byName };
}

function convertDevice(
	raw: Record<string, unknown>,
	byName: Map<string, string>,
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

	const typeName = str(raw.type);
	const typeId = byName.get(typeName);
	if (typeId === undefined) {
		warnings.push(`${label}: device type "${typeName}" not found`);
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
		enabled: bool(raw.enabled),
		name,
		typeId: typeId ?? "",
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

	const recipients = convertRecipients(src, warnings);
	const { types, byName } = convertTypes(src);
	const statusRow = rows(src, "status")[0];
	const status = isRecord(statusRow) ? statusRow : {};
	const normalized = normalizeInstanceConfig({
		types,
		recipients,
		statusTexts: { running: str(status.stateAction), standby: str(status.stateStandby), off: str(status.stateOff) },
	});
	warnings.push(...normalized.warnings);
	const instance = normalized.config;

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
			const config = convertDevice(raw, byName, recipientIds, warnings);
			const id = allocateDeviceId(config.name, taken);
			taken.add(id);
			// 3.1.2 used the untrimmed name as state prefix
			const oldName = typeof raw.name === "string" && raw.name !== "" ? raw.name : config.name;
			devices.push({ id, oldName, config });
		}
	}
	return { instance, devices, warnings };
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
