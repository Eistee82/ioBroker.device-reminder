import { DEFAULT_REMINDER, normalizeInstanceConfig, } from "./config.js";
import { allocateDeviceId, sanitizeId } from "./ids.js";
import { findType, resolveLegacyTypes } from "./legacyTypes.js";
import { detectionOf, typeHash } from "./runStore.js";
import { CUSTOM_TEMPLATE, findTemplate, TEMPLATES } from "./templates.js";
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
    const paths = new Map();
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
            if ((kind === "sayit" || kind === "whatsapp") && str(row.path) !== "") {
                paths.set(id, str(row.path));
            }
        });
    }
    return { recipients: result, paths };
}
const LEGACY_VALUE_KEYS = ["startVal", "endVal", "standby", "startCount", "endCount"];
function rawText(val) {
    if (typeof val === "string") {
        return val;
    }
    return typeof val === "number" && Number.isFinite(val) ? String(val) : "";
}
function lastOf(list, pred) {
    for (let i = list.length - 1; i >= 0; i--) {
        if (pred(list[i])) {
            return list[i];
        }
    }
    return null;
}
export function matchLegacyType(typeName, defaults, customs) {
    if (typeName === "") {
        return { row: null, via: "none" };
    }
    const exact = (r) => rawText(r.name) === typeName;
    const fromDefault = lastOf(defaults, exact);
    if (fromDefault) {
        return { row: fromDefault, via: "default" };
    }
    const fromCustom = lastOf(customs, exact);
    if (fromCustom) {
        return { row: fromCustom, via: "custom" };
    }
    const key = typeName.trim().toLowerCase();
    const loose = (r) => rawText(r.name).trim().toLowerCase() === key;
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
function typeValues(row, base, label, warnings) {
    const out = {
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
        }
        else if (val < 0) {
            warnings.push(`${label}: ${key} "${old}" is negative, using 0`);
            out[key] = 0;
        }
        else {
            if (typeof raw === "string" && Number.isNaN(Number(raw))) {
                warnings.push(`${label}: ${key} "${old}" read as ${val}`);
            }
            out[key] = val;
        }
    }
    return out;
}
function readTypeRows(native, warnings) {
    const read = (raw, table, template) => {
        const name = rawText(raw.name);
        const label = `Type "${name.trim()}"`;
        const comment = rawText(raw.comment).trim();
        if (comment !== "") {
            warnings.push(`${label}: comment "${comment}" not migrated`);
        }
        const values = typeValues(raw, (template ?? CUSTOM_TEMPLATE).detection, label, warnings);
        return { raw, table, name, template, values, archiveId: "" };
    };
    const builtin = (name) => TEMPLATES.find(t => t.id !== CUSTOM_TEMPLATE.id && t.id === name.trim().toLowerCase());
    const defaults = rows(native, "default")
        .filter(isRecord)
        .map(raw => read(raw, "default", builtin(rawText(raw.name))));
    const customs = rows(native, "custom")
        .filter(isRecord)
        .map(raw => read(raw, "custom"));
    const taken = new Set();
    const take = (row, id) => {
        row.archiveId = taken.has(id) ? allocateDeviceId(id, taken) : id;
        taken.add(row.archiveId);
    };
    for (const row of defaults.filter(r => r.template)) {
        take(row, row.template.id);
    }
    const pending = [];
    for (const row of customs) {
        const rowId = parseNumber(row.raw.id);
        const fromName = CUSTOM_ID.exec(row.name.trim());
        const n = rowId !== null && Number.isInteger(rowId) && rowId >= 0 ? rowId + 1 : fromName ? Number(fromName[1]) : null;
        if (n === null || taken.has(`custom${n}`)) {
            pending.push(row);
        }
        else {
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
function archiveOf(typeRows, used) {
    const out = [];
    for (const row of typeRows) {
        if (used.has(row.raw)) {
            continue;
        }
        const ref = (row.template ?? CUSTOM_TEMPLATE).detection;
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
function sameAsTemplate(detection, id) {
    const t = findTemplate(id);
    return t !== undefined && typeHash(t.detection) === typeHash(detection);
}
function deviceDetection(typeName, tables) {
    const { row, via } = matchLegacyType(typeName, tables.defaults.map(r => r.raw), tables.customs.map(r => r.raw));
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
        return via === "default" && found.template && sameAsTemplate(detection, found.template.id)
            ? { detection, template: found.template.id }
            : { detection };
    }
    const from = via === "case" ? `case match "${found.name}"` : `renamed slot ${typeName.trim()}`;
    return { detection, reviewHint: `3.1.2 type "${typeName}" not found exactly; values taken from ${from}` };
}
function convertDevice(raw, tables, recipientIds, warnings) {
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
    const { recipients, paths } = convertRecipients(src, warnings);
    const { defaults, customs } = readTypeRows(src, warnings);
    const tables = { defaults, customs, used: new Set() };
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
    const devices = [];
    const taken = new Set();
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
            const oldName = typeof raw.name === "string" && raw.name !== "" ? raw.name : config.name;
            devices.push({ id, oldName, config });
        }
    }
    return { instance, archive: archiveOf([...defaults, ...customs], tables.used), devices, warnings };
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
export function migrateV4Device(raw, native) {
    const warnings = [];
    if (!isRecord(raw) ||
        (typeof raw.typeId !== "string" && typeof raw.typeId !== "number") ||
        isRecord(raw.detection)) {
        return { native: null, warnings };
    }
    const { typeId: rawId, ...rest } = raw;
    const typeId = str(rawId);
    const type = findType(resolveLegacyTypes(isRecord(native) ? native : {}, warnings), typeId);
    if (type) {
        const detection = detectionOf(type);
        const out = { ...rest, detection };
        if (type.builtin && sameAsTemplate(detection, type.id)) {
            out.template = type.id;
        }
        else {
            delete out.template;
        }
        return { native: out, warnings };
    }
    const reviewHint = `device type "${typeId}" not found; values taken from template Custom`;
    const label = typeof raw.name === "string" ? raw.name.trim() : "";
    warnings.push(`Device "${label}": ${reviewHint}; device disabled`);
    const out = {
        ...rest,
        enabled: false,
        detection: detectionOf(CUSTOM_TEMPLATE.detection),
        needsReview: true,
        reviewHint,
    };
    delete out.template;
    return { native: out, warnings };
}
export function planV4Migration(objects, native) {
    const plan = [];
    for (const [id, obj] of Object.entries(objects)) {
        if (obj?.type !== "device" || !isRecord(obj.native)) {
            continue;
        }
        const { native: next, warnings } = migrateV4Device(obj.native, native);
        if (next) {
            plan.push({ id, native: next, warnings });
        }
    }
    return plan;
}
export async function applyV4Migration(io, native) {
    const migrated = [];
    const warnings = new Set();
    for (const { id } of planV4Migration(await io.deviceObjects(), native)) {
        try {
            const obj = await io.getObject(id);
            const result = obj && isRecord(obj.native) ? migrateV4Device(obj.native, native) : null;
            if (!obj || !result?.native) {
                continue;
            }
            for (const w of result.warnings) {
                warnings.add(w);
            }
            obj.native = result.native;
            await io.setObject(id, obj);
            migrated.push(id);
        }
        catch (err) {
            warnings.add(`${id}: moving the device type values failed, retried at the next start: ${errorMessage(err)}`);
        }
    }
    return { migrated, warnings: [...warnings] };
}
//# sourceMappingURL=migration.js.map