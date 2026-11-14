import { FINAL_KEYS } from "./detector/types.js";
import { allocateDeviceId } from "./ids.js";
import { defaultInstance, fixedTextState, kindFromInstance } from "./messenger/adapters.js";
import { parseNumber } from "./utils.js";
export const TRAILER_BOUNDS = {
    trailerBurstSec: [15, 180],
    trailerGapSec: [0, 600],
    trailerAfterSec: [0, 21600],
    trailerBlockVal: [0, 10000],
    trailerMaxSec: [900, 14400],
};
export const TRAILER_KEYS = Object.keys(TRAILER_BOUNDS);
export function normalizeTrailer(raw) {
    const val = (key) => {
        const v = parseNumber(raw[key]);
        return v !== null && Number.isFinite(v) ? Math.max(0, v) : 0;
    };
    const burst = val("trailerBurstSec");
    if (burst <= 0) {
        return {};
    }
    const clamp = (key, v, zeroOk) => {
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
export const FINAL_BOUNDS = {
    finalAfterSec: [0, 604_800],
    finalMinSec: [10, 86_400],
    finalQuietSec: [30, 7200],
    finalDipSec: [10, 3600],
    finalRestSec: [10, 14_400],
    finalActShare: [0.5, 0.9],
    finalCheckSec: [300, 14_400],
    finalLockSec: [600, 14_400],
};
const FINAL_RANGES = Object.entries(FINAL_BOUNDS);
const FINAL_ZERO = { finalQuietSec: 120, finalDipSec: 60, finalCheckSec: 1800, finalLockSec: 14_400 };
function finalEff(f, key) {
    return f[key] > 0 ? f[key] : FINAL_ZERO[key];
}
function finalRestOf(f, standby) {
    return f.finalRestVal > 0 ? f.finalRestVal : standby;
}
export function normalizeFinal(raw, warnings, label) {
    const notes = [];
    const note = (key, from, to, why) => {
        notes.push(`Device "${label}": ${key} ${from} → ${to} (${why})`);
    };
    const f = {};
    for (const key of FINAL_KEYS) {
        const v = parseNumber(raw[key]);
        if (v === null) {
            f[key] = 0;
        }
        else if (v < 0) {
            f[key] = 0;
            note(key, v, 0, "negative");
        }
        else {
            f[key] = v;
        }
    }
    if (f.finalMinVal <= 0 || f.finalMinSec <= 0) {
        return {};
    }
    const standby = Math.max(0, parseNumber(raw.standby) ?? 0);
    const rest = finalRestOf(f, standby);
    const off = (why) => {
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
        note("finalHotVal", f.finalHotVal, 0, f.finalMaxVal > 0 ? `below finalMaxVal ${f.finalMaxVal}` : "finalMaxVal open");
        f.finalHotVal = 0;
    }
    if (f.finalActVal !== 0 && (f.finalActVal < rest || f.finalActVal >= f.finalMinVal)) {
        note("finalActVal", f.finalActVal, 0, `outside ${rest}–${f.finalMinVal}, finalActShare 0 too`);
        f.finalActVal = 0;
        f.finalActShare = 0;
    }
    else if ((f.finalActVal === 0) !== (f.finalActShare === 0)) {
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
export function finalViolations(s, standby, pollSec) {
    const bad = new Set();
    const f = {};
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
        const floors = [
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
const MESSENGER_KINDS = [
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
const ACTION_EVENTS = ["start", "end", "reminder", "acknowledged"];
const DETECTION_MODES = ["count", "timed", "combined"];
const TELEGRAM_TARGETS = ["user", "chatId", "none"];
function builtinType(id, name, startVal, endVal, standby, startCount, endCount) {
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
        pauseHoldSec: 0,
        pauseUntilSec: 0,
        pauseBelowVal: 0,
    };
}
function customType(index) {
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
        pauseHoldSec: 0,
        pauseUntilSec: 0,
        pauseBelowVal: 0,
    };
}
export const DEFAULT_TYPES = [
    builtinType("washing-machine", "Washing machine", 30, 15, 1, 2, 50),
    builtinType("dryer", "Dryer", 120, 15, 1, 2, 20),
    builtinType("dishwasher", "Dishwasher", 15, 0.25, 0.5, 2, 120),
    ...Array.from({ length: 10 }, (_, i) => customType(i + 1)),
];
export const DEFAULT_REMINDER = {
    enabled: false,
    intervalMin: 30,
    maxCount: 10,
    text: "",
    ackStateId: "",
};
const DEFAULT_STATUS_TEXTS = { running: "in action", standby: "standby", off: "switched off" };
const DEFAULT_POLL_INTERVAL_SEC = 10;
function isRecord(val) {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}
function str(val, fallback = "") {
    if (typeof val === "string") {
        return val;
    }
    if (typeof val === "number" && Number.isFinite(val)) {
        return String(val);
    }
    return fallback;
}
function optStr(val) {
    const s = str(val).trim();
    return s === "" ? undefined : s;
}
function bool(val, fallback) {
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
function num(val, fallback) {
    return parseNumber(val) ?? fallback;
}
function optNum(val) {
    return parseNumber(val) ?? undefined;
}
function normalizeType(raw, index, id, warnings) {
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
        pauseHoldSec: Math.max(0, num(raw.pauseHoldSec, 0)),
        pauseUntilSec: Math.max(0, num(raw.pauseUntilSec, 0)),
        pauseBelowVal: Math.max(0, num(raw.pauseBelowVal, 0)),
        ...normalizeTrailer(raw),
    };
}
function normalizeRecipient(raw, index, id, warnings) {
    if (!isRecord(raw)) {
        warnings.push(`Recipient #${index + 1} ignored: not an object`);
        return null;
    }
    const kind = MESSENGER_KINDS.find(k => k === raw.kind);
    if (!kind) {
        warnings.push(`Recipient #${index + 1} ignored: missing or unknown kind`);
        return null;
    }
    const rec = {
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
    ];
    for (const key of strings) {
        const v = optStr(raw[key]);
        if (v !== undefined) {
            rec[key] = v;
        }
    }
    for (const key of ["volume", "priority", "ttl"]) {
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
export function completeRecipientRow(raw) {
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
    const next = { ...raw, kind, instance };
    const fixed = fixedTextState(kind, instance);
    if (fixed) {
        next.stateId = fixed;
    }
    const changed = ["kind", "instance", "stateId"].some(k => next[k] !== raw[k]);
    return changed ? next : raw;
}
export function recipientFromRow(raw) {
    const warnings = [];
    if (!isRecord(raw)) {
        return { recipient: null, warnings: ["Recipient #1 ignored: not an object"] };
    }
    const row = completeRecipientRow(raw);
    const recipient = normalizeRecipient(row, 0, str(row.id).trim() || "test", warnings);
    return { recipient, warnings };
}
function generateRecipientId(raw, index, taken) {
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
export function normalizeInstanceConfig(native) {
    const warnings = [];
    const src = isRecord(native) ? native : {};
    const idPatch = {};
    let types = [];
    if (Array.isArray(src.types)) {
        const seen = new Set();
        const taken = new Set([
            ...DEFAULT_TYPES.map(t => t.id),
            ...src.types.map(raw => (isRecord(raw) ? str(raw.id).trim() : "")).filter(id => id !== ""),
        ]);
        const rawRows = [...src.types];
        src.types.forEach((raw, i) => {
            let id = isRecord(raw) ? str(raw.id).trim() : "";
            if (isRecord(raw) && id === "") {
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
    }
    else {
        const missing = DEFAULT_TYPES.filter(d => d.builtin && !types.some(t => t.id === d.id));
        types = [...missing.map(t => ({ ...t })), ...types];
    }
    const recipients = [];
    if (Array.isArray(src.recipients)) {
        const seen = new Set();
        const taken = new Set(src.recipients.map(raw => (isRecord(raw) ? str(raw.id).trim() : "")).filter(id => id !== ""));
        const rawRows = [...src.recipients];
        src.recipients.forEach((original, i) => {
            const raw = isRecord(original) ? completeRecipientRow(original) : original;
            if (raw !== original) {
                rawRows[i] = raw;
                idPatch.recipients = rawRows;
            }
            let id = isRecord(raw) ? str(raw.id).trim() : "";
            if (isRecord(raw) && (id === "" || seen.has(id))) {
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
    const statusTexts = {
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
export function normalizeDeviceConfig(native) {
    const warnings = [];
    const src = isRecord(native) ? native : {};
    const name = str(src.name).trim();
    const powerId = str(src.powerId).trim();
    if (powerId === "") {
        warnings.push(`Device "${name}" ignored: no power state configured`);
        return { config: null, warnings };
    }
    const rawReminder = isRecord(src.reminder) ? src.reminder : {};
    const reminder = {
        enabled: bool(rawReminder.enabled, DEFAULT_REMINDER.enabled),
        intervalMin: Math.max(1, num(rawReminder.intervalMin, DEFAULT_REMINDER.intervalMin)),
        maxCount: Math.max(0, Math.floor(num(rawReminder.maxCount, DEFAULT_REMINDER.maxCount))),
        text: str(rawReminder.text),
        ackStateId: str(rawReminder.ackStateId).trim(),
    };
    const actions = [];
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
        ? src.recipients.filter((r) => typeof r === "string" && r !== "")
        : [];
    const config = {
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
    return { config, warnings };
}
export function findType(config, typeId) {
    return config.types.find(t => t.id === typeId);
}
//# sourceMappingURL=config.js.map