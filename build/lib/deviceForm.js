import * as I18n from "@iobroker/adapter-core/i18n";
import { DEFAULT_REMINDER, FINAL_BOUNDS, normalizeDetection, } from "./config.js";
import { TEMPLATE_NAMES } from "./dmTexts.js";
import { DETECTION_KEYS, detectionOf, typeHash } from "./runStore.js";
import { CUSTOM_TEMPLATE, findTemplate, scalePowers, templateDetection, TEMPLATES, } from "./templates.js";
import { parseNumber } from "./utils.js";
const ACTION_EVENT_KEYS = {
    start: "dev_eventStart",
    end: "dev_eventEnd",
    reminder: "dev_eventReminder",
    acknowledged: "dev_eventAcknowledged",
    phaseStart: "dev_eventPhaseStart",
    phaseEnd: "dev_eventPhaseEnd",
};
const ACTION_EVENTS = Object.keys(ACTION_EVENT_KEYS);
const DETECTION_MODES = ["count", "timed", "combined"];
const POWER_FIELDS = new Set([
    "startVal",
    "endVal",
    "standby",
    "pauseBelowVal",
    "trailerBlockVal",
]);
const REQUIRED_FIELDS = [
    "startVal",
    "endVal",
    "standby",
    "startCount",
    "endCount",
    "startDurationSec",
    "endDurationSec",
];
const HINT_KEYS = { notFound: "dev_hintNotFound", noPattern: "dev_hintNoPattern" };
export function parseSourceChoice(value) {
    const m = /^(template|archive|device):(.+)$/.exec(typeof value === "string" ? value : "");
    return m ? { kind: m[1], id: m[2] } : null;
}
export const DEFAULT_SOURCE = `template:${CUSTOM_TEMPLATE.id}`;
function sourceLabel(kindKey, name) {
    const kind = I18n.getTranslatedObject(kindKey);
    const per = typeof name === "string" ? {} : { ...name };
    const out = {};
    for (const lang of Object.keys(kind)) {
        out[lang] = `${kind[lang]}: ${typeof name === "string" ? name : (per[lang] ?? per.en)}`;
    }
    return out;
}
export function buildSourceSchema(archive = [], devices = []) {
    return {
        type: "panel",
        items: {
            source: {
                type: "select",
                label: I18n.getTranslatedObject("dev_sourceValues"),
                help: I18n.getTranslatedObject("dev_sourceValuesHelp"),
                options: [
                    ...TEMPLATES.map(t => ({
                        label: sourceLabel("dev_sourceKindTemplate", TEMPLATE_NAMES[t.id]),
                        value: `template:${t.id}`,
                    })),
                    ...archive.map(a => ({
                        label: sourceLabel("dev_sourceKindArchive", a.name),
                        value: `archive:${a.id}`,
                    })),
                    ...devices.map(d => ({
                        label: sourceLabel("dev_sourceKindDevice", d.name),
                        value: `device:${d.id}`,
                    })),
                ],
                newLine: true,
                xs: 12,
            },
            sourceInfo: {
                type: "staticText",
                text: I18n.getTranslatedObject("dev_sourceInfo"),
                newLine: true,
                xs: 12,
            },
            sourceId: {
                type: "objectId",
                label: I18n.getTranslatedObject("dev_sourceId"),
                types: ["state", "channel", "device"],
                hidden: "data.manual === true",
                newLine: true,
                xs: 12,
                sm: 12,
                md: 12,
            },
            manual: {
                type: "checkbox",
                label: I18n.getTranslatedObject("dev_manual"),
                newLine: true,
                xs: 12,
            },
        },
    };
}
export function buildDeviceSchema(cfg, detection, enums, unit = "W", copyHint = false) {
    const items = {};
    if (detection?.hint) {
        items.hint = {
            type: "infoBox",
            boxType: "warning",
            text: I18n.getTranslatedObject(HINT_KEYS[detection.hint]),
            newLine: true,
            xs: 12,
        };
    }
    if (copyHint) {
        items.copyFinalHint = {
            type: "infoBox",
            boxType: "info",
            text: I18n.getTranslatedObject("dm_copyFinalHint"),
            newLine: true,
            xs: 12,
        };
    }
    items.enabled = {
        type: "checkbox",
        label: I18n.getTranslatedObject("dev_enabled"),
        newLine: true,
        xs: 12,
        sm: 4,
        md: 3,
    };
    items.name = {
        type: "text",
        label: I18n.getTranslatedObject("dev_name"),
        validator: "data.name && String(data.name).trim() !== ''",
        validatorErrorText: I18n.translate("dev_required"),
        xs: 12,
        sm: 8,
        md: 5,
    };
    items.sourceId = {
        type: "objectId",
        label: I18n.getTranslatedObject("dev_sourceId"),
        types: ["state", "channel", "device"],
        newLine: true,
        xs: 12,
    };
    items.powerId = {
        type: "objectId",
        label: I18n.getTranslatedObject("dev_powerId"),
        validator: "data.powerId && String(data.powerId).trim() !== ''",
        validatorErrorText: I18n.translate("dev_required"),
        newLine: true,
        xs: 12,
        sm: 6,
    };
    items.switchId = {
        type: "objectId",
        label: I18n.getTranslatedObject("dev_switchId"),
        help: I18n.getTranslatedObject("dev_switchIdHelp"),
        xs: 12,
        sm: 6,
    };
    items.startText = { type: "text", label: I18n.getTranslatedObject("dev_startText"), newLine: true, xs: 12, sm: 6 };
    items.endText = { type: "text", label: I18n.getTranslatedObject("dev_endText"), xs: 12, sm: 6 };
    items.abort = {
        type: "checkbox",
        label: I18n.getTranslatedObject("dev_abort"),
        help: I18n.getTranslatedObject("dev_abortHelp"),
        newLine: true,
        xs: 12,
        sm: 6,
    };
    items.autoOff = {
        type: "checkbox",
        label: I18n.getTranslatedObject("dev_autoOff"),
        help: I18n.getTranslatedObject("dev_autoOffHelp"),
        xs: 12,
        sm: 3,
    };
    items.autoOffMinutes = {
        type: "number",
        label: I18n.getTranslatedObject("dev_autoOffMinutes"),
        min: 0,
        unit: "min",
        hidden: "!data.autoOff",
        xs: 12,
        sm: 3,
    };
    items.recipients = {
        type: "select",
        label: I18n.getTranslatedObject("dev_recipients"),
        help: I18n.getTranslatedObject("dev_recipientsHelp"),
        multiple: true,
        options: cfg.recipients.map(r => ({ label: r.name, value: r.id })),
        newLine: true,
        xs: 12,
    };
    if (enums) {
        items.rooms = {
            type: "select",
            label: I18n.getTranslatedObject("dev_rooms"),
            help: I18n.getTranslatedObject("dev_enumsHelp"),
            multiple: true,
            options: enums.rooms,
            newLine: true,
            xs: 12,
            sm: 6,
        };
        items.functions = {
            type: "select",
            label: I18n.getTranslatedObject("dev_functions"),
            multiple: true,
            options: enums.functions,
            xs: 12,
            sm: 6,
        };
    }
    items.detectionSection = detectionPanel(unit);
    items.reminderSection = {
        type: "panel",
        label: I18n.getTranslatedObject("dev_reminderSection"),
        collapsable: true,
        newLine: true,
        xs: 12,
        items: {
            "reminder.enabled": {
                type: "checkbox",
                label: I18n.getTranslatedObject("dev_reminderEnabled"),
                help: I18n.getTranslatedObject("dev_reminderHelp"),
                xs: 12,
            },
            "reminder.intervalMin": {
                type: "number",
                label: I18n.getTranslatedObject("dev_reminderInterval"),
                min: 1,
                unit: "min",
                newLine: true,
                xs: 12,
                sm: 6,
            },
            "reminder.maxCount": {
                type: "number",
                label: I18n.getTranslatedObject("dev_reminderMaxCount"),
                min: 1,
                xs: 12,
                sm: 6,
            },
            "reminder.text": {
                type: "text",
                label: I18n.getTranslatedObject("dev_reminderText"),
                newLine: true,
                xs: 12,
            },
            "reminder.ackStateId": {
                type: "objectId",
                label: I18n.getTranslatedObject("dev_reminderAckState"),
                help: I18n.getTranslatedObject("dev_reminderAckStateHelp"),
                newLine: true,
                xs: 12,
            },
        },
    };
    items.actionsSection = {
        type: "panel",
        label: I18n.getTranslatedObject("dev_actionsSection"),
        collapsable: true,
        newLine: true,
        xs: 12,
        items: {
            actions: {
                type: "table",
                label: I18n.getTranslatedObject("dev_actionsTable"),
                xs: 12,
                noDelete: false,
                items: [
                    {
                        type: "select",
                        attr: "event",
                        title: I18n.translate("dev_actionEvent"),
                        noTranslation: false,
                        options: ACTION_EVENTS.map(event => ({
                            label: I18n.translate(ACTION_EVENT_KEYS[event]),
                            value: event,
                        })),
                        default: "end",
                        width: "20%",
                    },
                    { type: "objectId", attr: "stateId", title: I18n.translate("dev_actionState"), width: "40%" },
                    { type: "text", attr: "value", title: I18n.translate("dev_actionValue"), width: "20%" },
                    { type: "text", attr: "phaseId", title: I18n.translate("dev_actionPhaseId"), width: "20%" },
                ],
            },
        },
    };
    items.advancedSection = {
        type: "panel",
        label: I18n.getTranslatedObject("dev_advancedSection"),
        collapsable: true,
        newLine: true,
        xs: 12,
        items: {
            abortFixed: {
                type: "checkbox",
                label: I18n.getTranslatedObject("dev_abortFixed"),
                help: I18n.getTranslatedObject("dev_abortFixedHelp"),
                xs: 12,
            },
            autoOptimize: {
                type: "checkbox",
                label: I18n.getTranslatedObject("dm_autoOptimize"),
                help: I18n.getTranslatedObject("dm_autoOptimizeHelp"),
                newLine: true,
                xs: 12,
                sm: 6,
            },
            optimizeNotify: {
                type: "checkbox",
                label: I18n.getTranslatedObject("dm_optimizeNotify"),
                help: I18n.getTranslatedObject("dm_optimizeNotifyHelp"),
                hidden: "!data.autoOptimize",
                xs: 12,
                sm: 6,
            },
        },
    };
    items.expertSection = expertPanel(unit);
    return { type: "panel", items };
}
const FINAL_HIDDEN = "!data.finalMinVal || !data.finalMinSec";
function numberItem(key, label, extra = {}) {
    const tooltip = I18n.getTranslatedObject(`${label}Tooltip`);
    const hasTooltip = Object.values(tooltip).some(v => v !== `${label}Tooltip`);
    return [
        key,
        {
            type: "number",
            label: I18n.getTranslatedObject(label),
            ...(hasTooltip ? { tooltip } : {}),
            xs: 12,
            sm: 6,
            md: 4,
            ...extra,
        },
    ];
}
function detectionPanel(unit) {
    return {
        type: "panel",
        label: I18n.getTranslatedObject("dev_detectionSection"),
        collapsable: true,
        newLine: true,
        xs: 12,
        items: {
            mode: {
                type: "select",
                label: I18n.getTranslatedObject("typeMode"),
                options: [
                    { label: I18n.getTranslatedObject("modeCount"), value: "count" },
                    { label: I18n.getTranslatedObject("modeTimed"), value: "timed" },
                    { label: I18n.getTranslatedObject("modeCombined"), value: "combined" },
                ],
                xs: 12,
                sm: 6,
                md: 4,
            },
            ...Object.fromEntries([
                numberItem("startVal", "typeStartVal", { min: 0, step: 0.05, unit, newLine: true }),
                numberItem("endVal", "typeEndVal", { min: 0, step: 0.05, unit }),
                numberItem("standby", "typeStandby", { min: 0, step: 0.05, unit }),
                numberItem("startCount", "typeStartCount", { min: 1, step: 0.5, newLine: true }),
                numberItem("endCount", "typeEndCount", { min: 2, step: 1 }),
                numberItem("startDurationSec", "typeStartDuration", {
                    min: 0,
                    unit: "s",
                    newLine: true,
                    hidden: "data.mode === 'count'",
                }),
                numberItem("endDurationSec", "typeEndDuration", { min: 0, unit: "s", hidden: "data.mode === 'count'" }),
            ]),
        },
    };
}
const FINAL_FIELDS = [
    ["finalMinVal", "power"],
    ["finalMinSec", "s"],
    ["finalMaxVal", "power"],
    ["finalHotVal", "power"],
    ["finalAfterSec", "s"],
    ["finalQuietSec", "s"],
    ["finalDipSec", "s"],
    ["finalRestVal", "power"],
    ["finalRestSec", "s"],
    ["finalActVal", "power"],
    ["finalActShare", "share"],
    ["finalCheckSec", "s"],
    ["finalLockSec", "s"],
];
function expertPanel(unit) {
    const bounds = FINAL_BOUNDS;
    const trailer = "!data.trailerBurstSec";
    return {
        type: "panel",
        label: I18n.getTranslatedObject("dev_expertValues"),
        collapsable: true,
        newLine: true,
        xs: 12,
        items: Object.fromEntries([
            numberItem("pauseHoldSec", "typePauseHold", { min: 0, step: 1, unit: "s", newLine: true }),
            numberItem("pauseUntilSec", "typePauseUntil", { min: 0, step: 1, unit: "s" }),
            numberItem("pauseBelowVal", "typePauseBelow", { min: 0, step: 0.05, unit }),
            numberItem("trailerBurstSec", "typeTrailerBurst", { min: 0, max: 180, step: 1, unit: "s", newLine: true }),
            numberItem("trailerGapSec", "typeTrailerGap", { min: 0, max: 600, step: 1, unit: "s", hidden: trailer }),
            numberItem("trailerAfterSec", "typeTrailerAfter", {
                min: 0,
                max: 21_600,
                step: 1,
                unit: "s",
                hidden: trailer,
            }),
            numberItem("trailerBlockVal", "typeTrailerBlock", {
                min: 0,
                max: 10_000,
                step: 0.05,
                unit,
                hidden: trailer,
            }),
            numberItem("trailerMaxSec", "typeTrailerMax", { min: 0, max: 14_400, step: 1, unit: "s", hidden: trailer }),
            ...FINAL_FIELDS.map(([key, kind], i) => {
                const range = bounds[key];
                const master = key === "finalMinVal" || key === "finalMinSec";
                return numberItem(key, key, {
                    min: range ? range[0] : 0,
                    ...(range ? { max: range[1] } : {}),
                    step: kind === "s" ? 1 : 0.05,
                    ...(kind === "power" ? { unit } : kind === "s" ? { unit: "s" } : {}),
                    ...(i === 0 ? { newLine: true } : {}),
                    ...(master ? {} : { hidden: FINAL_HIDDEN }),
                });
            }),
        ]),
    };
}
function toNumber(val) {
    if (typeof val === "number") {
        return val;
    }
    return parseNumber(val) ?? Number.NaN;
}
function toText(val) {
    return typeof val === "string" ? val : "";
}
const FORM_KEYS = [
    "enabled",
    "name",
    "detection",
    "template",
    "sourceId",
    "powerId",
    "switchId",
    "startText",
    "endText",
    "abort",
    "abortFixed",
    "autoOff",
    "autoOffMinutes",
    "recipients",
    "reminder",
    "actions",
    "autoOptimize",
    "optimizeNotify",
    "needsReview",
    "reviewHint",
    "typeId",
];
function sameValue(a, b) {
    const n = parseNumber(a);
    return n !== null && b !== undefined && Math.abs(n - b) <= 1e-9 * Math.max(1, Math.abs(b));
}
function formDetection(f, o, errors) {
    const flat = {};
    for (const key of DETECTION_KEYS) {
        if (f[key] !== undefined) {
            flat[key] = f[key];
        }
    }
    if (f.mode !== undefined) {
        flat.mode = f.mode;
        if (!DETECTION_MODES.includes(f.mode)) {
            errors.push("The detection mode must be count, timed or combined.");
        }
    }
    const required = REQUIRED_FIELDS;
    for (const [key, val] of Object.entries(flat)) {
        if (key === "mode") {
            continue;
        }
        const n = parseNumber(val);
        const optional = !required.includes(key) && (val === "" || val === null);
        if (!optional && (n === null || n < 0)) {
            errors.push(`${key} must be a number of 0 or more.`);
        }
        else if (key === "startCount" && n !== null && n < 1) {
            errors.push("startCount must be at least 1.");
        }
        else if (key === "endCount" && n !== null && n < 2) {
            errors.push("endCount must be at least 2.");
        }
    }
    if (!o.isNew) {
        return { ...(o.previous?.detection ?? CUSTOM_TEMPLATE.detection), ...flat };
    }
    const src = o.source ?? { detection: CUSTOM_TEMPLATE.detection, unitFactor: o.unitFactor };
    const start = scalePowers(src.detection, 1, o.unitFactor);
    const prefilled = scalePowers(src.detection, 1, src.unitFactor);
    const values = { ...start };
    for (const [key, val] of Object.entries(flat)) {
        const untouched = POWER_FIELDS.has(key) && sameValue(val, prefilled[key]);
        if (!untouched) {
            values[key] = val;
        }
    }
    return values;
}
export function formToDeviceConfig(f, o) {
    const errors = [];
    const warnings = [];
    const name = toText(f.name).trim();
    const powerId = toText(f.powerId).trim();
    if (name === "") {
        errors.push("The device needs a name.");
    }
    const detectionErrors = [];
    const detection = normalizeDetection(formDetection(f, o, detectionErrors), warnings, name);
    errors.push(...detectionErrors);
    const candidate = o.isNew ? (o.source ? o.source.template : CUSTOM_TEMPLATE.id) : o.previous?.template;
    const values = candidate ? templateDetection(candidate, o.unitFactor) : null;
    const template = detection && values && typeHash(values) === typeHash(detection) ? candidate : undefined;
    if (powerId === "") {
        errors.push("The device needs a power state.");
    }
    const autoOffMinutes = toNumber(f.autoOffMinutes);
    if (!Number.isFinite(autoOffMinutes) || autoOffMinutes < 0) {
        errors.push("The auto-off delay must be 0 minutes or more.");
    }
    const rawReminder = f.reminder ?? DEFAULT_REMINDER;
    const intervalMin = toNumber(rawReminder.intervalMin ?? DEFAULT_REMINDER.intervalMin);
    const maxCount = toNumber(rawReminder.maxCount ?? DEFAULT_REMINDER.maxCount);
    if (!Number.isFinite(intervalMin) || intervalMin < 1) {
        errors.push("The reminder interval must be at least 1 minute.");
    }
    if (!Number.isFinite(maxCount) || maxCount < 1) {
        errors.push("The reminder count must be at least 1.");
    }
    const actions = [];
    const rawActions = Array.isArray(f.actions) ? f.actions : [];
    rawActions.forEach((raw, i) => {
        const row = (typeof raw === "object" && raw !== null ? raw : {});
        const stateId = toText(row.stateId).trim();
        const value = toText(row.value);
        if (stateId === "" && value === "") {
            return;
        }
        const event = ACTION_EVENTS.find(e => e === row.event);
        if (stateId === "" || !event) {
            errors.push(`Action ${i + 1} needs an event and a state.`);
            return;
        }
        const phaseId = event === "phaseStart" || event === "phaseEnd" ? toText(row.phaseId).trim() : "";
        actions.push({ event, stateId, value, ...(phaseId !== "" ? { phaseId } : {}) });
    });
    if (errors.length > 0 || !detection) {
        return { config: null, errors, warnings };
    }
    const kept = { ...(o.isNew ? {} : (o.previous ?? {})) };
    for (const key of FORM_KEYS) {
        delete kept[key];
    }
    const config = {
        ...kept,
        enabled: f.enabled !== false,
        name,
        detection,
        powerId,
        startText: toText(f.startText),
        endText: toText(f.endText),
        abort: f.abort === true,
        abortFixed: f.abortFixed === true,
        autoOff: f.autoOff === true,
        autoOffMinutes,
        recipients: (Array.isArray(f.recipients) ? f.recipients : []).filter((r) => typeof r === "string" && r !== ""),
        reminder: {
            enabled: rawReminder.enabled === true,
            intervalMin,
            maxCount: Math.floor(maxCount),
            text: toText(rawReminder.text),
            ackStateId: toText(rawReminder.ackStateId).trim(),
        },
        actions,
    };
    const sourceId = toText(f.sourceId).trim();
    if (sourceId !== "") {
        config.sourceId = sourceId;
    }
    const switchId = toText(f.switchId).trim();
    if (switchId !== "") {
        config.switchId = switchId;
    }
    if (f.autoOptimize === true) {
        config.autoOptimize = true;
        if (f.optimizeNotify === true) {
            config.optimizeNotify = true;
        }
    }
    if (template !== undefined && findTemplate(template)) {
        config.template = template;
    }
    if (!o.isNew && o.previous && typeHash(o.previous.detection) !== typeHash(detection)) {
        delete config.learned;
    }
    return { config, errors, warnings };
}
export function deviceConfigToForm(c) {
    return {
        enabled: c.enabled,
        name: c.name,
        ...detectionOf(c.detection),
        sourceId: c.sourceId ?? "",
        powerId: c.powerId,
        switchId: c.switchId ?? "",
        startText: c.startText,
        endText: c.endText,
        abort: c.abort,
        abortFixed: c.abortFixed,
        autoOff: c.autoOff,
        autoOffMinutes: c.autoOffMinutes,
        recipients: [...c.recipients],
        reminder: { ...c.reminder },
        actions: c.actions.map(a => ({ ...a })),
        ...(c.autoOptimize ? { autoOptimize: true } : {}),
        ...(c.optimizeNotify ? { optimizeNotify: true } : {}),
    };
}
//# sourceMappingURL=deviceForm.js.map