import { DEFAULT_REMINDER, } from "./config.js";
import { parseNumber } from "./utils.js";
const ACTION_EVENT_KEYS = {
    start: "dev_eventStart",
    end: "dev_eventEnd",
    reminder: "dev_eventReminder",
    acknowledged: "dev_eventAcknowledged",
};
const ACTION_EVENTS = Object.keys(ACTION_EVENT_KEYS);
const HINT_KEYS = { notFound: "dev_hintNotFound", noPattern: "dev_hintNoPattern" };
export function buildSourceSchema() {
    return {
        type: "panel",
        i18n: true,
        items: {
            sourceInfo: {
                type: "staticText",
                text: "dev_sourceInfo",
                newLine: true,
                xs: 12,
            },
            sourceId: {
                type: "objectId",
                label: "dev_sourceId",
                types: ["state", "channel", "device"],
                hidden: "data.manual === true",
                newLine: true,
                xs: 12,
                sm: 12,
                md: 12,
            },
            manual: {
                type: "checkbox",
                label: "dev_manual",
                newLine: true,
                xs: 12,
            },
        },
    };
}
export function buildDeviceSchema(cfg, detection) {
    const items = {};
    if (detection?.hint) {
        items.hint = {
            type: "infoBox",
            boxType: "warning",
            text: HINT_KEYS[detection.hint],
            newLine: true,
            xs: 12,
        };
    }
    items.enabled = { type: "checkbox", label: "dev_enabled", newLine: true, xs: 12, sm: 4, md: 3 };
    items.name = {
        type: "text",
        label: "dev_name",
        validator: "data.name && String(data.name).trim() !== ''",
        validatorErrorText: "dev_required",
        xs: 12,
        sm: 8,
        md: 5,
    };
    items.typeId = {
        type: "select",
        label: "dev_typeId",
        noTranslation: true,
        options: cfg.types.map(t => ({ label: t.name, value: t.id })),
        xs: 12,
        sm: 6,
        md: 4,
    };
    items.sourceId = {
        type: "objectId",
        label: "dev_sourceId",
        types: ["state", "channel", "device"],
        newLine: true,
        xs: 12,
    };
    items.powerId = {
        type: "objectId",
        label: "dev_powerId",
        validator: "data.powerId && String(data.powerId).trim() !== ''",
        validatorErrorText: "dev_required",
        newLine: true,
        xs: 12,
        sm: 6,
    };
    items.switchId = {
        type: "objectId",
        label: "dev_switchId",
        help: "dev_switchIdHelp",
        xs: 12,
        sm: 6,
    };
    items.startText = { type: "text", label: "dev_startText", newLine: true, xs: 12, sm: 6 };
    items.endText = { type: "text", label: "dev_endText", xs: 12, sm: 6 };
    items.abort = { type: "checkbox", label: "dev_abort", help: "dev_abortHelp", newLine: true, xs: 12, sm: 6 };
    items.autoOff = { type: "checkbox", label: "dev_autoOff", help: "dev_autoOffHelp", xs: 12, sm: 3 };
    items.autoOffMinutes = {
        type: "number",
        label: "dev_autoOffMinutes",
        min: 0,
        unit: "min",
        hidden: "!data.autoOff",
        xs: 12,
        sm: 3,
    };
    items.recipients = {
        type: "select",
        label: "dev_recipients",
        help: "dev_recipientsHelp",
        multiple: true,
        noTranslation: true,
        options: cfg.recipients.map(r => ({ label: r.name, value: r.id })),
        newLine: true,
        xs: 12,
    };
    items.reminderSection = {
        type: "panel",
        label: "dev_reminderSection",
        collapsable: true,
        color: "secondary",
        newLine: true,
        xs: 12,
        items: {
            "reminder.enabled": { type: "checkbox", label: "dev_reminderEnabled", help: "dev_reminderHelp", xs: 12 },
            "reminder.intervalMin": {
                type: "number",
                label: "dev_reminderInterval",
                min: 1,
                unit: "min",
                newLine: true,
                xs: 12,
                sm: 6,
            },
            "reminder.maxCount": {
                type: "number",
                label: "dev_reminderMaxCount",
                min: 1,
                xs: 12,
                sm: 6,
            },
            "reminder.text": { type: "text", label: "dev_reminderText", newLine: true, xs: 12 },
            "reminder.ackStateId": {
                type: "objectId",
                label: "dev_reminderAckState",
                help: "dev_reminderAckStateHelp",
                newLine: true,
                xs: 12,
            },
        },
    };
    items.actionsSection = {
        type: "panel",
        label: "dev_actionsSection",
        collapsable: true,
        color: "secondary",
        newLine: true,
        xs: 12,
        items: {
            actions: {
                type: "table",
                label: "dev_actionsTable",
                xs: 12,
                noDelete: false,
                items: [
                    {
                        type: "select",
                        attr: "event",
                        title: "dev_actionEvent",
                        noTranslation: false,
                        options: ACTION_EVENTS.map(event => ({ label: ACTION_EVENT_KEYS[event], value: event })),
                        default: "end",
                        width: "20%",
                    },
                    { type: "objectId", attr: "stateId", title: "dev_actionState", width: "55%" },
                    { type: "text", attr: "value", title: "dev_actionValue", width: "25%" },
                ],
            },
        },
    };
    items.advancedSection = {
        type: "panel",
        label: "dev_advancedSection",
        collapsable: true,
        color: "secondary",
        newLine: true,
        xs: 12,
        items: {
            abortFixed: { type: "checkbox", label: "dev_abortFixed", help: "dev_abortFixedHelp", xs: 12 },
        },
    };
    return { type: "panel", i18n: true, items };
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
export function formToDeviceConfig(f) {
    const errors = [];
    const name = toText(f.name).trim();
    const typeId = toText(f.typeId).trim();
    const powerId = toText(f.powerId).trim();
    if (name === "") {
        errors.push("The device needs a name.");
    }
    if (typeId === "") {
        errors.push("Select a device type.");
    }
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
        actions.push({ event, stateId, value });
    });
    if (errors.length > 0) {
        return { config: null, errors };
    }
    const config = {
        enabled: f.enabled !== false,
        name,
        typeId,
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
    return { config, errors };
}
export function deviceConfigToForm(c) {
    return {
        enabled: c.enabled,
        name: c.name,
        typeId: c.typeId,
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
    };
}
//# sourceMappingURL=deviceForm.js.map