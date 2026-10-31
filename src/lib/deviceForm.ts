import * as I18n from "@iobroker/adapter-core/i18n";
import type { JsonFormSchema } from "@iobroker/dm-utils";
import {
	DEFAULT_REMINDER,
	type ActionEvent,
	type DeviceAction,
	type DeviceConfig,
	type InstanceConfig,
	type ReminderConfig,
} from "./config.js";
import type { EnumOption } from "./enums.js";
import type { DetectionResult } from "./typeDetection.js";
import { parseNumber } from "./utils.js";

/** Flat form data of the device dialog (what the Device Manager form edits). */
export interface DeviceFormData {
	/** Device is active. */
	enabled: boolean;
	/** Display name. */
	name: string;
	/** ID of the device type. */
	typeId: string;
	/** Source object the states were detected from, empty if entered manually. */
	sourceId: string;
	/** Power state ID. */
	powerId: string;
	/** Switch state ID, empty if there is none. */
	switchId: string;
	/** Notification text on start. */
	startText: string;
	/** Notification text on end. */
	endText: string;
	/** Abort detection. */
	abort: boolean;
	/** Fixed abort detection (3.1.2 bug fixed). */
	abortFixed: boolean;
	/** Switch the device off automatically after the end. */
	autoOff: boolean;
	/** Delay before switching off in minutes. */
	autoOffMinutes: number;
	/** IDs of the notified recipients. */
	recipients: string[];
	/** Reminder settings. */
	reminder: ReminderConfig;
	/** Actions on events. */
	actions: DeviceAction[];
	/** Rooms (enum ids) the device object belongs to; not part of the device configuration. */
	rooms?: string[];
	/** Functions (enum ids) the device object belongs to; not part of the device configuration. */
	functions?: string[];
}

const ACTION_EVENT_KEYS: Record<ActionEvent, string> = {
	start: "dev_eventStart",
	end: "dev_eventEnd",
	reminder: "dev_eventReminder",
	acknowledged: "dev_eventAcknowledged",
};
const ACTION_EVENTS = Object.keys(ACTION_EVENT_KEYS) as ActionEvent[];

const HINT_KEYS = { notFound: "dev_hintNotFound", noPattern: "dev_hintNoPattern" } as const;

/**
 * Schema of the first "add device" step: choose the source object or switch to manual entry.
 */
export function buildSourceSchema(): JsonFormSchema {
	return {
		type: "panel",
		items: {
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

/**
 * Schema of the device form (add and edit).
 *
 * @param cfg - Instance configuration (provides device types and recipients)
 * @param detection - Result of the power/switch detection to explain an incomplete result
 * @param enums - Rooms and functions the device can be assigned to
 * @param enums.rooms - Room options
 * @param enums.functions - Function options
 */
export function buildDeviceSchema(
	cfg: InstanceConfig,
	detection?: DetectionResult,
	enums?: { rooms: EnumOption[]; functions: EnumOption[] },
): JsonFormSchema {
	const items: Extract<JsonFormSchema, { type: "panel" }>["items"] = {};

	if (detection?.hint) {
		items.hint = {
			type: "infoBox",
			boxType: "warning",
			text: I18n.getTranslatedObject(HINT_KEYS[detection.hint]),
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
	items.typeId = {
		type: "select",
		label: I18n.getTranslatedObject("dev_typeId"),
		options: cfg.types.map(t => ({ label: t.name, value: t.id })),
		xs: 12,
		sm: 6,
		md: 4,
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

	items.reminderSection = {
		type: "panel",
		label: I18n.getTranslatedObject("dev_reminderSection"),
		collapsable: true,
		color: "secondary",
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
		color: "secondary",
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
					{ type: "objectId", attr: "stateId", title: I18n.translate("dev_actionState"), width: "55%" },
					{ type: "text", attr: "value", title: I18n.translate("dev_actionValue"), width: "25%" },
				],
			},
		},
	};

	items.advancedSection = {
		type: "panel",
		label: I18n.getTranslatedObject("dev_advancedSection"),
		collapsable: true,
		color: "secondary",
		newLine: true,
		xs: 12,
		items: {
			abortFixed: {
				type: "checkbox",
				label: I18n.getTranslatedObject("dev_abortFixed"),
				help: I18n.getTranslatedObject("dev_abortFixedHelp"),
				xs: 12,
			},
		},
	};

	return { type: "panel", items };
}

function toNumber(val: unknown): number {
	if (typeof val === "number") {
		return val;
	}
	return parseNumber(val) ?? Number.NaN;
}

function toText(val: unknown): string {
	return typeof val === "string" ? val : "";
}

/**
 * Validate the form and convert it to a device configuration.
 *
 * Error messages are English sentences meant to be shown to the user.
 *
 * @param f - Form data
 */
export function formToDeviceConfig(f: DeviceFormData): { config: DeviceConfig | null; errors: string[] } {
	const errors: string[] = [];
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

	const rawReminder: Partial<ReminderConfig> = f.reminder ?? DEFAULT_REMINDER;
	const intervalMin = toNumber(rawReminder.intervalMin ?? DEFAULT_REMINDER.intervalMin);
	const maxCount = toNumber(rawReminder.maxCount ?? DEFAULT_REMINDER.maxCount);
	if (!Number.isFinite(intervalMin) || intervalMin < 1) {
		errors.push("The reminder interval must be at least 1 minute.");
	}
	if (!Number.isFinite(maxCount) || maxCount < 1) {
		errors.push("The reminder count must be at least 1.");
	}

	const actions: DeviceAction[] = [];
	const rawActions: unknown[] = Array.isArray(f.actions) ? f.actions : [];
	rawActions.forEach((raw, i) => {
		const row = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<DeviceAction>;
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

	const config: DeviceConfig = {
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
		recipients: (Array.isArray(f.recipients) ? f.recipients : []).filter(
			(r): r is string => typeof r === "string" && r !== "",
		),
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

/**
 * Convert a device configuration to form data; the result shares no references with `c`.
 *
 * @param c - Device configuration
 */
export function deviceConfigToForm(c: DeviceConfig): DeviceFormData {
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
