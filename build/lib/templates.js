import { resolveLegacyTypes } from "./legacyTypes.js";
import { detectionOf, typeHash } from "./runStore.js";
const POWER_KEYS = ["startVal", "endVal", "standby", "pauseBelowVal", "trailerBlockVal"];
function template(id, name, startVal, endVal, standby, startCount, endCount) {
    return {
        id,
        name,
        detection: detectionOf({
            startVal,
            endVal,
            standby,
            startCount,
            endCount,
            mode: "count",
            startDurationSec: 60,
            endDurationSec: 300,
        }),
    };
}
export const CUSTOM_TEMPLATE = template("custom", "Custom", 30, 5, 1, 1, 20);
export const TEMPLATES = [
    template("washing-machine", "Washing machine", 30, 15, 1, 2, 50),
    template("dryer", "Dryer", 120, 15, 1, 2, 20),
    template("dishwasher", "Dishwasher", 15, 0.25, 0.5, 2, 120),
    CUSTOM_TEMPLATE,
];
export function findTemplate(id) {
    return TEMPLATES.find(t => t.id === id);
}
export function templateDetection(id, unitFactor) {
    const t = findTemplate(id);
    if (!t) {
        return null;
    }
    const out = detectionOf(t.detection);
    const factor = unitFactor > 0 ? unitFactor : 1;
    for (const key of POWER_KEYS) {
        out[key] = (out[key] ?? 0) / factor;
    }
    return out;
}
function unchanged(id) {
    const builtin = TEMPLATES.find(t => t.id === id && t.id !== "custom");
    if (builtin) {
        return { hash: typeHash(builtin.detection), names: [builtin.name] };
    }
    const slot = /^custom(\d+)$/.exec(id);
    if (slot) {
        return { hash: typeHash(CUSTOM_TEMPLATE.detection), names: [`Custom ${slot[1]}`, `custom${slot[1]}`] };
    }
    return null;
}
export function archiveTemplates(native) {
    if (!Array.isArray(native?.types) || native.types.length === 0) {
        return [];
    }
    const out = [];
    for (const t of resolveLegacyTypes(native)) {
        const detection = detectionOf(t);
        const ref = unchanged(t.id);
        if (ref && ref.hash === typeHash(detection) && ref.names.includes(t.name)) {
            continue;
        }
        out.push({ id: t.id, name: t.name, detection });
    }
    return out;
}
//# sourceMappingURL=templates.js.map