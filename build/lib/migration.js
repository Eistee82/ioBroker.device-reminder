import { DEFAULT_REMINDER, DEFAULT_TYPES, normalizeInstanceConfig, } from "./config.js";
import { allocateDeviceId } from "./ids.js";
import { DEVICE_STATES } from "./stateDefinitions.js";
import { errorMessage, parseNumber } from "./utils.js";
export const LEGACY_STATE_MAP = {
    "last operations": "lastOperations",
    lastRuntime: "lastRuntime",
    "config.do not disturb": "config.doNotDisturb",
    "config.runtime max": "config.runtimeMax",
};
export const LEGACY_LEAVES = [
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
];
const KNOWN_NATIVE_KEYS = new Set([
    "linkedDevice",
    "devices",
    "default",
    "custom",
    "status",
    ...LEGACY_MESSENGERS,
]);
const KNOWN_DEVICE_FIELDS = new Set([
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
const INSTANCE_ADAPTER = {
    telegram: "telegram",
    pushover: "pushover",
    signal: "signal-cmb",
    matrix: "matrix-org",
    discord: "discord",
};
const PUSHOVER_PRIORITY = { normal: 0, high: 1, quiet: -1, confirmation: 2 };
const DEFAULT_VOICE_VOLUME = 50;
const CUSTOM_ID = /^custom(\d+)$/;
function isRecord(val) {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}
function str(val) {
    if (typeof val === "string") {
        return val.trim();
    }
    if (typeof val === "number" && Number.isFinite(val)) {
        return String(val);
    }
    return "";
}
function bool(val) {
    return val === true || val === "true";
}
function rows(native, table) {
    const t = native[table];
    return isRecord(t) && Array.isArray(t.ids) ? t.ids : [];
}
function putStr(rec, key, val) {
    const s = str(val);
    if (s !== "") {
        rec[key] = s;
    }
}
function instanceId(kind, inst) {
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
function convertRecipient(kind, row, id) {
    const rec = { id, name: str(row.name) || id, enabled: true, kind };
    const instance = instanceId(kind, row.inst);
    if (instance !== undefined) {
        rec.instance = instance;
    }
    switch (kind) {
        case "alexa":
        case "sayit": {
            putStr(rec, "stateId", row.path);
            const volume = parseNumber(row.volume);
            rec.volume = volume === null || volume < 0 || volume > 100 ? DEFAULT_VOICE_VOLUME : volume;
            putStr(rec, "activeFrom", row.activeFrom);
            putStr(rec, "activeUntil", row.activeUntil);
            break;
        }
        case "whatsapp":
            putStr(rec, "stateId", row.path);
            break;
        case "telegram":
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
function convertRecipients(native, warnings) {
    const result = [];
    const seen = new Set();
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
function thresholds(row, base) {
    const n = (val, fallback) => Math.max(0, parseNumber(val) ?? fallback);
    return {
        ...base,
        startVal: n(row.startVal, base.startVal),
        endVal: n(row.endVal, base.endVal),
        standby: n(row.standby, base.standby),
        startCount: n(row.startCount, base.startCount),
        endCount: n(row.endCount, base.endCount),
    };
}
function convertTypes(native) {
    const types = DEFAULT_TYPES.map(t => ({ ...t }));
    const defaultNames = new Map();
    const customNames = new Map();
    const replace = (t) => {
        const idx = types.findIndex(x => x.id === t.id);
        if (idx >= 0) {
            types[idx] = t;
        }
        else {
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
    const addCustom = (row, id) => {
        const base = types.find(t => t.id === id) ?? { ...DEFAULT_TYPES[DEFAULT_TYPES.length - 1], id, name: id };
        const legacyName = str(row.name);
        const name = legacyName !== "" && legacyName !== id ? legacyName : base.name;
        replace({ ...thresholds(row, base), id, name, builtin: false });
        if (legacyName !== "") {
            customNames.set(legacyName, id);
        }
    };
    const used = new Set();
    const customRows = rows(native, "custom").filter(isRecord);
    const pending = [];
    for (const row of customRows) {
        const rowId = parseNumber(row.id);
        const fromName = CUSTOM_ID.exec(str(row.name));
        const n = rowId !== null && Number.isInteger(rowId) && rowId >= 0 ? rowId + 1 : fromName ? Number(fromName[1]) : null;
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
    const byName = new Map();
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
function convertDevice(raw, byName, recipientIds, warnings) {
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
    const recipients = [];
    for (const kind of LEGACY_MESSENGERS) {
        const refs = raw[kind];
        if (!Array.isArray(refs)) {
            continue;
        }
        for (const ref of refs) {
            const id = `${kind}-${str(ref)}`;
            if (!recipientIds.has(id)) {
                warnings.push(`${label}: recipient ${kind} #${str(ref)} does not exist, removed`);
            }
            else if (!recipients.includes(id)) {
                recipients.push(id);
            }
        }
    }
    const powerId = str(raw.pathConsumption);
    if (powerId === "") {
        warnings.push(`${label}: no power state configured`);
    }
    const config = {
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
export function isLegacyConfig(native) {
    if (!isRecord(native) || native.configVersion !== undefined) {
        return false;
    }
    return native.linkedDevice !== undefined || native.status !== undefined || native.default !== undefined;
}
export function migrateLegacyConfig(native) {
    const warnings = [];
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
    const devices = [];
    const taken = new Set();
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
            const oldName = typeof raw.name === "string" && raw.name !== "" ? raw.name : config.name;
            devices.push({ id, oldName, config });
        }
    }
    return { instance, devices, warnings };
}
function coerce(newLeaf, val) {
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
export async function migrateLegacyStates(io, devices) {
    const warnings = [];
    const oldValues = new Map();
    for (const d of devices) {
        if (oldValues.has(d.oldName)) {
            continue;
        }
        const values = new Map();
        oldValues.set(d.oldName, values);
        try {
            for (const [oldLeaf, newLeaf] of Object.entries(LEGACY_STATE_MAP)) {
                const val = await io.getOwnState(`${d.oldName}.${oldLeaf}`);
                if (val !== null && val !== undefined) {
                    values.set(newLeaf, val);
                }
            }
        }
        catch (err) {
            warnings.push(`Device "${d.oldName}": reading old states failed: ${errorMessage(err)}`);
        }
    }
    for (const oldName of oldValues.keys()) {
        try {
            const leaves = new Set(LEGACY_LEAVES.map(l => `${oldName}.${l}`));
            for (const id of await io.getObjectIds(oldName)) {
                if (leaves.has(id)) {
                    await io.delObject(id);
                }
            }
        }
        catch (err) {
            warnings.push(`Device "${oldName}": deleting old states failed: ${errorMessage(err)}`);
        }
    }
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
        }
        catch (err) {
            warnings.push(`${label}: state migration failed: ${errorMessage(err)}`);
        }
    }
    return warnings;
}
//# sourceMappingURL=migration.js.map