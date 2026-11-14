import * as I18n from "@iobroker/adapter-core/i18n";
import type { JsonFormSchema } from "@iobroker/dm-utils";
import {
	DEFAULT_REMINDER,
	FINAL_BOUNDS,
	normalizeDetection,
	type ActionEvent,
	type DeviceAction,
	type DeviceConfig,
	type InstanceConfig,
	type ReminderConfig,
} from "./config.js";
import type { DetectionMode, DetectionSettings, FinalKey } from "./detector/types.js";
import { TEMPLATE_NAMES } from "./dmTexts.js";
import type { EnumOption } from "./enums.js";
import { DETECTION_KEYS, detectionOf, typeHash } from "./runStore.js";
import {
	type ArchiveTemplate,
	CUSTOM_TEMPLATE,
	findTemplate,
	scalePowers,
	templateDetection,
	TEMPLATES,
} from "./templates.js";
import type { DetectionResult } from "./typeDetection.js";
import { parseNumber } from "./utils.js";

/** Flat form data of the device dialog (what the Device Manager form edits); the detection values are flat fields. */
export interface DeviceFormData extends Partial<DetectionSettings> {
	/** Device is active. */
	enabled: boolean;
	/** Display name. */
	name: string;
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
	/** Automatic optimisation of the detection. */
	autoOptimize?: boolean;
	/** Report changes of the automatic optimisation as a message. */
	optimizeNotify?: boolean;
}

const ACTION_EVENT_KEYS: Record<ActionEvent, string> = {
	start: "dev_eventStart",
	end: "dev_eventEnd",
	reminder: "dev_eventReminder",
	acknowledged: "dev_eventAcknowledged",
};
const ACTION_EVENTS = Object.keys(ACTION_EVENT_KEYS) as ActionEvent[];

const DETECTION_MODES: readonly DetectionMode[] = ["count", "timed", "combined"];

/** Fields that are a power (converted between units). */
const POWER_FIELDS: ReadonlySet<string> = new Set([
	"startVal",
	"endVal",
	"standby",
	"pauseBelowVal",
	"trailerBlockVal",
]);

/** The values the device needs: a missing or invalid one is an error in the form. */
const REQUIRED_FIELDS = [
	"startVal",
	"endVal",
	"standby",
	"startCount",
	"endCount",
	"startDurationSec",
	"endDurationSec",
] as const;

const HINT_KEYS = { notFound: "dev_hintNotFound", noPattern: "dev_hintNoPattern" } as const;

/** Where the values of a new device come from (value of the field `source`). */
export interface SourceChoice {
	/** Built-in template, archive template or another device. */
	kind: "template" | "archive" | "device";
	/** Id of the template or device. */
	id: string;
}

/**
 * Split the value of the field `source` (`template:<id>`, `archive:<id>`, `device:<id>`); null if it is none of them.
 *
 * @param value - Value of the field
 */
export function parseSourceChoice(value: unknown): SourceChoice | null {
	const m = /^(template|archive|device):(.+)$/.exec(typeof value === "string" ? value : "");
	return m ? { kind: m[1] as SourceChoice["kind"], id: m[2] } : null;
}

/** Default source of the values: the template "Custom". */
export const DEFAULT_SOURCE = `template:${CUSTOM_TEMPLATE.id}`;

/**
 * Label of a source option: "<kind>: <name>" in every language.
 *
 * @param kindKey - i18n key of the kind
 * @param name - Name of the template or device (per language, or the same in all)
 */
function sourceLabel(kindKey: string, name: ioBroker.Translated | string): ioBroker.Translated {
	const kind = I18n.getTranslatedObject(kindKey) as Record<string, string>;
	const per: Record<string, string> = typeof name === "string" ? {} : { ...name };
	const out: Record<string, string> = {};
	for (const lang of Object.keys(kind)) {
		out[lang] = `${kind[lang]}: ${typeof name === "string" ? name : (per[lang] ?? per.en)}`;
	}
	return out as ioBroker.Translated;
}

/**
 * Schema of the first "add device" step: choose where the values of the device come from (built-in template,
 * archive template or another device) and the source object, or switch to manual entry.
 *
 * @param archive - Archive templates (old device types of an earlier version)
 * @param devices - Devices whose values can be taken over
 */
export function buildSourceSchema(
	archive: readonly Pick<ArchiveTemplate, "id" | "name">[] = [],
	devices: readonly { id: string; name: string }[] = [],
): JsonFormSchema {
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

/**
 * Schema of the device form (add and edit).
 *
 * @param cfg - Instance configuration (provides the recipients)
 * @param detection - Result of the power/switch detection to explain an incomplete result
 * @param enums - Rooms and functions the device can be assigned to
 * @param enums.rooms - Room options
 * @param enums.functions - Function options
 * @param unit - Unit of the power state (the powers of the detection values are in it)
 * @param copyHint - Values were copied from a device: hint that final phase and phases are learned at this device
 */
export function buildDeviceSchema(
	cfg: InstanceConfig,
	detection?: DetectionResult,
	enums?: { rooms: EnumOption[]; functions: EnumOption[] },
	unit = "W",
	copyHint = false,
): JsonFormSchema {
	const items: PanelItems = {};

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

type PanelItems = Extract<JsonFormSchema, { type: "panel" }>["items"];

/** Hidden expression of the final phase fields: only while the master switch (P and Y) is on. */
const FINAL_HIDDEN = "!data.finalMinVal || !data.finalMinSec";

/**
 * One number field of the detection values.
 *
 * @param key - Field of the detection values
 * @param label - Key of the label in the i18n files (a tooltip is added if `<label>Tooltip` exists)
 * @param extra - Further properties of the item
 */
function numberItem(key: string, label: string, extra: Record<string, unknown> = {}): [string, PanelItems[string]] {
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

/**
 * Panel "Detection": mode, five thresholds, two durations.
 *
 * @param unit - Unit of the power state
 */
function detectionPanel(unit: string): PanelItems[string] {
	return {
		type: "panel",
		label: I18n.getTranslatedObject("dev_detectionSection"),
		collapsable: true,
		color: "secondary",
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

/** Final phase fields in the order of the form with the kind of the value (power in the unit of the state, time in s). */
const FINAL_FIELDS: readonly (readonly [FinalKey, "power" | "s" | "share"])[] = [
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

/**
 * Panel "Expert values": pause protection, anti-crease protection and final phase (collapsed). The final phase
 * fields follow the master switch.
 *
 * @param unit - Unit of the power state
 */
function expertPanel(unit: string): PanelItems[string] {
	const bounds: Record<string, readonly [number, number]> = FINAL_BOUNDS;
	const trailer = "!data.trailerBurstSec";
	return {
		type: "panel",
		label: I18n.getTranslatedObject("dev_expertValues"),
		collapsable: true,
		color: "secondary",
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

function toNumber(val: unknown): number {
	if (typeof val === "number") {
		return val;
	}
	return parseNumber(val) ?? Number.NaN;
}

function toText(val: unknown): string {
	return typeof val === "string" ? val : "";
}

/** Values a new device starts with (chosen in the first step of "add device"). */
export interface FormSource {
	/** Detection values in W (no final phase). */
	detection: DetectionSettings;
	/** Id of the built-in template when the source is one. */
	template?: string;
	/** Factor of the unit the form was prefilled with (the powers of the form are `detection` divided by it). */
	unitFactor: number;
}

/** Options of `formToDeviceConfig`. */
export interface FormOptions {
	/** The device is added: the detection values start from `source`. */
	isNew: boolean;
	/** Factor from the unit of the power state to W (kW: 1000). */
	unitFactor: number;
	/** Source of the values of a new device (default: the template "Custom"). */
	source?: FormSource;
	/** Stored configuration when editing: fields the form does not show are kept from it. */
	previous?: DeviceConfig;
}

/** Fields of a device configuration the form sets (or leaves out); everything else is kept from `previous`. */
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
] as const;

/**
 * Whether two numbers from the form are the same value.
 *
 * @param a - Value of the form (number or numeric text)
 * @param b - Value to compare with
 */
function sameValue(a: unknown, b: number | undefined): boolean {
	const n = parseNumber(a);
	return n !== null && b !== undefined && Math.abs(n - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

/**
 * Detection values of the form: the values of the source (new device) or of the stored device (editing) with
 * the fields of the form laid over them. A power the user did not touch follows the unit of the state.
 * Errors name the field.
 *
 * @param f - Form data
 * @param o - New or edited device, unit and stored configuration
 * @param errors - Receives the errors
 */
function formDetection(f: DeviceFormData, o: FormOptions, errors: string[]): Record<string, unknown> {
	const flat: Record<string, unknown> = {};
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
	const required: readonly string[] = REQUIRED_FIELDS;
	for (const [key, val] of Object.entries(flat)) {
		if (key === "mode") {
			continue;
		}
		const n = parseNumber(val);
		const optional = !required.includes(key) && (val === "" || val === null);
		if (!optional && (n === null || n < 0)) {
			errors.push(`${key} must be a number of 0 or more.`);
		} else if (key === "startCount" && n !== null && n < 1) {
			errors.push("startCount must be at least 1.");
		} else if (key === "endCount" && n !== null && n < 2) {
			errors.push("endCount must be at least 2.");
		}
	}
	if (!o.isNew) {
		return { ...(o.previous?.detection ?? CUSTOM_TEMPLATE.detection), ...flat };
	}
	const src = o.source ?? { detection: CUSTOM_TEMPLATE.detection, unitFactor: o.unitFactor };
	const start = scalePowers(src.detection, 1, o.unitFactor);
	const prefilled = scalePowers(src.detection, 1, src.unitFactor);
	const values: Record<string, unknown> = { ...start };
	for (const [key, val] of Object.entries(flat)) {
		const untouched = POWER_FIELDS.has(key) && sameValue(val, prefilled[key as keyof DetectionSettings] as number);
		if (!untouched) {
			values[key] = val;
		}
	}
	return values;
}

/**
 * Validate the form and convert it to a device configuration.
 *
 * A new device starts with the values of its source (power values in the unit of the state), the fields of the
 * form win. When editing, the stored values stay and the fields of the form win; the template is kept only while
 * the values still equal it. The detection values are corrected by the normalizer; every correction is returned
 * as a warning. Saving clears a review hint. Error messages are English sentences meant to be shown to the user.
 *
 * @param f - Form data
 * @param o - New or edited device, unit and stored configuration
 */
export function formToDeviceConfig(
	f: DeviceFormData,
	o: FormOptions,
): { config: DeviceConfig | null; errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	const name = toText(f.name).trim();
	const powerId = toText(f.powerId).trim();
	if (name === "") {
		errors.push("The device needs a name.");
	}
	const detectionErrors: string[] = [];
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

	if (errors.length > 0 || !detection) {
		return { config: null, errors, warnings };
	}

	const kept: Record<string, unknown> = { ...(o.isNew ? {} : (o.previous ?? {})) };
	for (const key of FORM_KEYS) {
		delete kept[key];
	}
	const config: DeviceConfig = {
		...(kept as Partial<DeviceConfig>),
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
	// set only when on, so that the device configuration of 3.1.2 behaviour stays unchanged
	if (f.autoOptimize === true) {
		config.autoOptimize = true;
		if (f.optimizeNotify === true) {
			config.optimizeNotify = true;
		}
	}
	if (template !== undefined && findTemplate(template)) {
		config.template = template;
	}
	return { config, errors, warnings };
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
