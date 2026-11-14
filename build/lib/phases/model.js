export const SYSTEM_PHASES = {
    antiCrease: "antiCrease",
    afterRun: "afterRun",
    rest: "rest",
    unknown: "unknown",
};
export const UNKNOWN_PHASE = SYSTEM_PHASES.unknown;
export const SYSTEM_PHASE_KEYS = {
    antiCrease: "phase_antiCrease",
    afterRun: "phase_afterRun",
    rest: "phase_rest",
    unknown: "phase_unknown",
    neutral: "phase_neutral",
};
export const DEFAULT_PHASE_NAMES = {
    antiCrease: "Anti-crease",
    afterRun: "After the run",
    rest: "Rest",
    unknown: "Unknown",
};
const CONTEXT_IDS = ["idle", "start"];
const SMOOTHINGS = ["block", "level", "debounce", "peak"];
const RESERVED = new Set([...Object.values(SYSTEM_PHASES), ...CONTEXT_IDS]);
export function systemPhaseNames(translate) {
    const out = {};
    for (const id of Object.values(SYSTEM_PHASES)) {
        const text = translate(SYSTEM_PHASE_KEYS[id]);
        out[id] = text && text !== SYSTEM_PHASE_KEYS[id] ? text : DEFAULT_PHASE_NAMES[id];
    }
    return out;
}
function isRecord(val) {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}
class InvalidModel extends Error {
}
function fail(reason) {
    throw new InvalidModel(reason);
}
function nonNegative(val, fallback, what) {
    if (val === undefined || val === null) {
        return fallback;
    }
    const n = typeof val === "number" ? val : Number.NaN;
    if (!Number.isFinite(n) || n < 0) {
        fail(`${what} is not a number ≥ 0`);
    }
    return n;
}
function text(val, what) {
    if (typeof val !== "string" || val.trim() === "") {
        fail(`${what} is missing`);
    }
    return val;
}
function bandOfRaw(raw, k, last) {
    if (!isRecord(raw)) {
        fail(`band #${k + 1} is not an object`);
    }
    const id = text(raw.id, `id of band #${k + 1}`);
    const min = nonNegative(raw.min, Number.NaN, `min of band "${id}"`);
    if (!Number.isFinite(min)) {
        fail(`min of band "${id}" is missing`);
    }
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
function idList(val, what) {
    if (!Array.isArray(val) || val.some(x => typeof x !== "string" || x === "")) {
        fail(`${what} is not a list of ids`);
    }
    return [...val];
}
function phaseOfRaw(raw, k, bandIds) {
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
    const out = {
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
    if (isRecord(raw.notify)) {
        const notify = {};
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
export function normalizePhases(raw, warnings, label) {
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
        const rawBands = raw.bands;
        const bands = rawBands.map((b, k) => bandOfRaw(b, k, k === rawBands.length - 1));
        const ids = new Set();
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
        const phaseIds = new Set(phases.map(p => p.id));
        for (const p of phases) {
            const bad = p.after?.find(a => !phaseIds.has(a) && !CONTEXT_IDS.includes(a));
            if (bad !== undefined) {
                fail(`after of phase "${p.id}" refers to the unknown phase "${bad}"`);
            }
        }
        if (scope === "continuous" && phases.some(p => p.notBeforeSec !== undefined)) {
            for (const p of phases) {
                delete p.notBeforeSec;
            }
            warnings.push(`Device "${label}": notBeforeSec removed from the phases (not allowed with scope continuous)`);
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
    }
    catch (err) {
        if (!(err instanceof InvalidModel)) {
            throw err;
        }
        warnings.push(`Device "${label}": phases ignored (${err.message})`);
        return undefined;
    }
}
//# sourceMappingURL=model.js.map