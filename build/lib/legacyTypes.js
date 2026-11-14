import { normalizeTrailer } from "./config.js";
import { allocateDeviceId } from "./ids.js";
import { parseNumber } from "./utils.js";
const DETECTION_MODES = ["count", "timed", "combined"];
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
function isRecord(val) {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}
function str(val) {
    if (typeof val === "string") {
        return val;
    }
    if (typeof val === "number" && Number.isFinite(val)) {
        return String(val);
    }
    return "";
}
function num(val, fallback) {
    return parseNumber(val) ?? fallback;
}
export function normalizeType(raw, index, id, warnings) {
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
export function resolveLegacyTypes(native, warnings = []) {
    const src = isRecord(native) ? native : {};
    let types = [];
    if (Array.isArray(src.types)) {
        const seen = new Set();
        const taken = new Set([
            ...DEFAULT_TYPES.map(t => t.id),
            ...src.types.map(raw => (isRecord(raw) ? str(raw.id).trim() : "")).filter(id => id !== ""),
        ]);
        src.types.forEach((raw, i) => {
            let id = isRecord(raw) ? str(raw.id).trim() : "";
            if (isRecord(raw) && id === "") {
                id = allocateDeviceId(str(raw.name).trim() || "custom", taken);
                taken.add(id);
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
    return types;
}
export function findType(types, id) {
    return types.find(t => t.id === id);
}
//# sourceMappingURL=legacyTypes.js.map