import type { AdapterInstance } from "@iobroker/adapter-core";
import * as I18n from "@iobroker/adapter-core/i18n";
import { ACTIONS, DeviceManagement } from "@iobroker/dm-utils";
import type {
	ActionContext,
	DeviceAction,
	DeviceDetails,
	DeviceInfo,
	DeviceLoadContext,
	DeviceRefreshResponse,
	InstanceDetails,
	InstanceRefreshResponse,
	JsonFormData,
	JsonFormSchema,
	StatusIndicator,
} from "@iobroker/dm-utils";
import type { DeviceConfig, InstanceConfig } from "./config.js";
import { DEFAULT_REMINDER, normalizeDetection, normalizeDeviceConfig } from "./config.js";
import type { DeviceFormData, FormSource } from "./deviceForm.js";
import {
	buildDeviceSchema,
	buildSourceSchema,
	DEFAULT_SOURCE,
	deviceConfigToForm,
	formToDeviceConfig,
	parseSourceChoice,
} from "./deviceForm.js";
import type { ObjectWriter } from "./deviceObjects.js";
import { ensureDeviceObjects } from "./deviceObjects.js";
import { type EnumMembers, type EnumOption, enumLabel, membershipOf, planEnumUpdate } from "./enums.js";
import type { DeviceRegistry } from "./deviceRegistry.js";
import { BUDGET_WARN_JOBS, formatDate } from "./deviceRegistry.js";
import { fill, plain, TEMPLATE_NAMES, TEXT } from "./dmTexts.js";
import { allocateDeviceId } from "./ids.js";
import { finalOn } from "./detector/index.js";
import { FINAL_KEYS } from "./detector/types.js";
import type { DetectionMode, DetectionSettings, FinalSettings } from "./detector/types.js";
import { analyzeHistory, MIN_RUNS } from "./historyLearning.js";
import type { HistorySuggestion, ModeEvaluation } from "./historyLearning.js";
import { storedRunsOfHistory } from "./historyRuns.js";
import { findHistoryInstance, loadHistorySeries } from "./historySource.js";
import type { HistoryEnv } from "./historySource.js";
import { describeChange } from "./learn/autoOptimize.js";
import type { BaseBands } from "./learn/bands.js";
import type { FinalCandidate } from "./learn/finalLearn.js";
import { learnFinal } from "./learn/finalLearn.js";
import type { Verdict } from "./learn/quality.js";
import { admitted, sameRun, verdictKey } from "./learn/quality.js";
import { buildLayout } from "./learn/runs.js";
import type { Evaluation, FinishChoice, LearnInput, RunUse } from "./learnDialog.js";
import {
	buildRunsSchema,
	checkText,
	evaluateRuns,
	finishChoiceOf,
	finishData,
	finishItems,
	heldBackSpans,
	marked,
	learnInputOf,
	neutralName,
	phaseData,
	phaseItems,
	phaseSequences,
	phasesFromForm,
	rowsOf,
	runSummary,
	runTableData,
	usesOfAnswer,
} from "./learnDialog.js";
import type { LearningSuggestion } from "./learning.js";
import type { PhaseModel } from "./phases/model.js";
import { normalizePhases } from "./phases/model.js";
import type { PhaseLearnResult } from "./phases/learn.js";
import { learnPhases } from "./phases/learn.js";
import type { DeviceTypeConfig } from "./legacyTypes.js";
import type { Notifier } from "./notifier.js";
import type { DetectionKey, StoreFile, StoredRun } from "./runStore.js";
import { BASE_KEYS, boundaryInfo, decisionOf, detectionOf, startOf, typeHash } from "./runStore.js";
import { archiveTemplates, CUSTOM_TEMPLATE, findTemplate, scalePowers } from "./templates.js";
import { detectFromHost } from "./typeDetection.js";
import type { DetectionResult } from "./typeDetection.js";
import { errorMessage, parseNumber } from "./utils.js";

/** The adapter parts the device manager needs. */
export interface DeviceReminderLike extends AdapterInstance {
	/** Current instance configuration. */
	readonly instanceConfig: InstanceConfig;
	/** Device types of an earlier version, read for devices that still have a `typeId`. */
	readonly legacyTypes?: DeviceTypeConfig[];
	/** Registry of the running devices. */
	readonly registry: DeviceRegistry;
	/** Notifier used for test messages. */
	readonly notifier: Notifier;
}

type Id = string;
type PanelItems = Extract<JsonFormSchema, { type: "panel" }>["items"];
type PanelItem = PanelItems[string];
type DeviceRefresh = DeviceRefreshResponse<Id>;

/** Object IDs below the namespace that are no devices and must not be used as device ID. */
const RESERVED_IDS = ["info"];

const LEARN_ERRORS: Record<string, ioBroker.Translated> = {
	tooFewSamples: TEXT.learnTooFewSamples,
	noRun: TEXT.learnNoRun,
};

const GENERIC_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#607d8b" d="M16 3h-2v4h-4V3H8v4H7a2 2 0 0 0-2 2v3a6 6 0 0 0 5 5.9V21h4v-3.1a6 6 0 0 0 5-5.9V9a2 2 0 0 0-2-2h-1V3z"/></svg>';
const GENERIC_ICON = `data:image/svg+xml;base64,${Buffer.from(GENERIC_ICON_SVG).toString("base64")}`;

/**
 * Model line of the device card: "learned" once the values were learned or an optimisation changes them,
 * otherwise the name of the template the values come from, otherwise "own values".
 *
 * @param cfg - Device configuration
 * @param hasOverride - The automatic optimisation changes the values at the moment
 */
export function deviceModel(cfg: DeviceConfig, hasOverride: boolean): ioBroker.Translated {
	if (cfg.learned === true || hasOverride) {
		return TEXT.modelLearned;
	}
	const template = findTemplate(cfg.template);
	return template ? TEMPLATE_NAMES[template.id] : TEXT.modelOwn;
}

function isRecord(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

function textOf(val: unknown): string {
	return typeof val === "string" ? val : "";
}

function nameOf(name: ioBroker.StringOrTranslated | undefined, fallback: string): string {
	if (typeof name === "string") {
		return name;
	}
	if (isRecord(name)) {
		const value = name.en ?? Object.values(name).find(v => typeof v === "string" && v !== "");
		return typeof value === "string" ? value : fallback;
	}
	return fallback;
}

/**
 * String entries of a multi select value.
 *
 * @param val - Value of the select
 */
function idList(val: unknown): string[] {
	return Array.isArray(val) ? val.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Fold the data returned by the device form back into `DeviceFormData`.
 * The GUI returns nested `reminder` data, flat `reminder.xyz` keys are accepted too.
 *
 * @param data - Raw form data
 */
function toFormData(data: JsonFormData): DeviceFormData {
	const reminder: Record<string, unknown> = { ...DEFAULT_REMINDER };
	if (isRecord(data.reminder)) {
		Object.assign(reminder, data.reminder);
	}
	for (const [key, val] of Object.entries(data)) {
		if (key.startsWith("reminder.")) {
			reminder[key.slice("reminder.".length)] = val;
		}
	}
	return { ...(data as Partial<DeviceFormData>), reminder } as unknown as DeviceFormData;
}

/** Device manager (config manager) of the adapter: add, edit, delete and operate devices. */
export class ReminderDeviceManagement extends DeviceManagement<DeviceReminderLike> {
	protected override getInstanceInfo(): InstanceDetails {
		return {
			apiVersion: "v3",
			identifierLabel: TEXT.identifier,
			actions: [
				{
					id: "add",
					icon: "add",
					description: TEXT.addDevice,
					handler: ctx => this.addDevice(ctx),
				},
				{
					id: "removeArchive",
					icon: "delete",
					description: I18n.getTranslatedObject("dm_removeArchive"),
					handler: ctx => this.removeArchive(ctx),
				},
			],
		};
	}

	protected override async loadDevices(context: DeviceLoadContext<Id>): Promise<void> {
		const devices = await this.deviceObjects();
		const ids = [...devices.keys()].sort();
		context.setTotalDevices(ids.length);
		for (const id of ids) {
			try {
				context.addDevice(await this.buildDeviceInfo(id, devices.get(id)));
			} catch (err) {
				this.log.error(`Cannot load device ${id}: ${errorMessage(err)}`);
			}
		}
	}

	protected override async getDeviceDetails(id: Id): Promise<DeviceDetails<Id> | { error: string }> {
		const obj = await this.adapter.getObjectAsync(id);
		const cfg = obj ? this.configOf(obj) : null;
		if (!cfg) {
			return { error: "unknownDevice" };
		}
		const d = detectionOf(cfg.detection);
		const items: PanelItems = {};
		const data: JsonFormData = {};

		items.opsHeader = {
			type: "header",
			text: I18n.getTranslatedObject("dm_detailsOperations"),
			size: 4,
			newLine: true,
			xs: 12,
		};
		items.lastOperations = {
			type: "table",
			label: I18n.getTranslatedObject("dm_detailsOperations"),
			disabled: true,
			noDelete: true,
			xs: 12,
			items: [
				{ type: "text", attr: "start", title: I18n.translate("dm_detailsStart"), width: "35%" },
				{ type: "text", attr: "end", title: I18n.translate("dm_detailsEnd"), width: "35%" },
				{ type: "text", attr: "runtime", title: I18n.translate("dm_detailsRuntime"), width: "30%" },
			],
		};
		data.lastOperations = await this.readOperations(id);

		items.typeHeader = {
			type: "header",
			text: I18n.getTranslatedObject("dm_detailsDetection"),
			size: 4,
			newLine: true,
			xs: 12,
		};
		if (cfg.needsReview) {
			items.needsReview = {
				type: "infoBox",
				boxType: "warning",
				text: TEXT.needsReview(cfg.reviewHint ?? ""),
				newLine: true,
				xs: 12,
			};
		}
		const rows: [ioBroker.StringOrTranslated, string | number, string?][] = [];
		const template = findTemplate(cfg.template);
		if (template) {
			rows.push([I18n.getTranslatedObject("dev_template"), TEMPLATE_NAMES[template.id].en]);
		}
		rows.push(
			[I18n.getTranslatedObject("dm_detailsStartVal"), d.startVal, "W"],
			[I18n.getTranslatedObject("dm_detailsEndVal"), d.endVal, "W"],
			[I18n.getTranslatedObject("dm_detailsStandby"), d.standby, "W"],
			[I18n.getTranslatedObject("dm_detailsStartCount"), d.startCount],
			[I18n.getTranslatedObject("dm_detailsEndCount"), d.endCount],
			[I18n.getTranslatedObject("dm_detailsMode"), d.mode],
		);
		if (d.mode !== "count") {
			rows.push(
				[I18n.getTranslatedObject("dm_detailsStartDuration"), d.startDurationSec, "s"],
				[I18n.getTranslatedObject("dm_detailsEndDuration"), d.endDurationSec, "s"],
			);
		}
		if ((d.pauseHoldSec ?? 0) > 0) {
			rows.push(
				[I18n.getTranslatedObject("dm_detailsPauseHold"), d.pauseHoldSec ?? 0, "s"],
				[I18n.getTranslatedObject("dm_detailsPauseUntil"), d.pauseUntilSec ?? 0, "s"],
				[I18n.getTranslatedObject("dm_detailsPauseBelow"), d.pauseBelowVal ?? 0, "W"],
			);
		}
		if ((d.trailerBurstSec ?? 0) > 0) {
			rows.push(
				[I18n.getTranslatedObject("dm_learnTrailerBurst"), d.trailerBurstSec ?? 0, "s"],
				[I18n.getTranslatedObject("dm_learnTrailerGap"), d.trailerGapSec ?? 0, "s"],
				[I18n.getTranslatedObject("dm_learnTrailerAfter"), d.trailerAfterSec ?? 0, "s"],
				[I18n.getTranslatedObject("dm_learnTrailerBlock"), d.trailerBlockVal ?? 0, "W"],
				[I18n.getTranslatedObject("dm_learnTrailerMax"), d.trailerMaxSec ?? 0, "s"],
			);
		}
		rows.forEach(([label, value, unit], i) => {
			items[`type${i}`] = {
				type: "staticInfo",
				label,
				data: value,
				...(unit ? { unit } : {}),
				newLine: true,
				xs: 12,
				sm: 6,
			};
		});
		items.autoOptimize = {
			type: "staticInfo",
			label: I18n.getTranslatedObject("dm_autoOptimize"),
			data: cfg.autoOptimize ? TEXT.on : TEXT.off,
			newLine: true,
			xs: 12,
			sm: 6,
		};

		items.reminderHeader = {
			type: "header",
			text: I18n.getTranslatedObject("dm_detailsReminder"),
			size: 4,
			newLine: true,
			xs: 12,
		};
		const finished = await this.adapter.getStateAsync(`${id}.finished`);
		items.reminderState = {
			type: "staticInfo",
			label: I18n.getTranslatedObject("dm_detailsReminderState"),
			data: cfg.reminder.enabled ? TEXT.on : TEXT.off,
			newLine: true,
			xs: 12,
			sm: 6,
		};
		if (cfg.reminder.enabled) {
			items.reminderInterval = {
				type: "staticInfo",
				label: I18n.getTranslatedObject("dm_detailsReminderInterval"),
				data: cfg.reminder.intervalMin,
				unit: "min",
				xs: 12,
				sm: 6,
			};
			items.reminderMax = {
				type: "staticInfo",
				label: I18n.getTranslatedObject("dm_detailsReminderMax"),
				data: cfg.reminder.maxCount,
				xs: 12,
				sm: 6,
			};
		}
		items.reminderPending = {
			type: "staticInfo",
			label: I18n.getTranslatedObject("dm_detailsReminderPending"),
			data: finished?.val === true ? TEXT.yes : TEXT.no,
			xs: 12,
			sm: 6,
		};

		return { id, schema: { type: "panel", items }, data };
	}

	/** Device objects directly below the namespace. */
	private async deviceObjects(): Promise<Map<Id, ioBroker.Object>> {
		const prefix = `${this.adapter.namespace}.`;
		const res = await this.adapter.getObjectViewAsync("system", "device", {
			startkey: prefix,
			endkey: `${prefix}香`,
		});
		const result = new Map<Id, ioBroker.Object>();
		for (const row of res?.rows ?? []) {
			const id = row.id.slice(prefix.length);
			if (row.value && id !== "" && !id.includes(".")) {
				result.set(id, row.value);
			}
		}
		return result;
	}

	/**
	 * Device configuration of a device object; an invalid one (no power state) is completed with an empty power state
	 * so that it can still be edited and deleted.
	 *
	 * @param obj - Device object
	 */
	private configOf(obj: ioBroker.Object): DeviceConfig | null {
		const native = (obj.native ?? {}) as Record<string, unknown>;
		const legacy = this.adapter.legacyTypes;
		const direct = normalizeDeviceConfig(native, legacy).config;
		if (direct) {
			return direct;
		}
		const repaired = normalizeDeviceConfig({ ...native, powerId: "-" }, legacy).config;
		return repaired ? { ...repaired, powerId: "" } : null;
	}

	/**
	 * Stored configuration of a device for saving it again: the normalized configuration over the raw native, so
	 * that fields the forms do not know are kept (`writeDevice` replaces the native).
	 *
	 * @param obj - Device object
	 */
	private storedConfigOf(obj: ioBroker.Object): DeviceConfig | null {
		const cfg = this.configOf(obj);
		return cfg ? { ...(obj.native ?? {}), ...cfg } : null;
	}

	/**
	 * Unit factor of a power state (kW: 1000, otherwise 1).
	 *
	 * @param powerId - Power state id
	 */
	private async unitFactorOf(powerId: string): Promise<number> {
		if (powerId === "") {
			return 1;
		}
		const unit = (await this.adapter.getForeignObjectAsync(powerId))?.common?.unit;
		return typeof unit === "string" && unit.trim().toLowerCase() === "kw" ? 1000 : 1;
	}

	private objectWriter(): ObjectWriter {
		return {
			extendObject: (id, obj) => this.adapter.extendObjectAsync(id, obj),
			setObjectNotExists: (id, obj) => this.adapter.setObjectNotExistsAsync(id, obj),
			delObject: async id => {
				if (await this.adapter.getObjectAsync(id)) {
					await this.adapter.delObjectAsync(id);
				}
			},
		};
	}

	/**
	 * All objects below `id` including `id` itself (input of the type detection).
	 *
	 * @param id - Root id
	 */
	private async getObjectsUnder(id: string): Promise<Record<string, ioBroker.Object>> {
		const result: Record<string, ioBroker.Object> = {};
		const own = await this.adapter.getForeignObjectAsync(id);
		if (own) {
			result[id] = own;
		}
		const children = await this.adapter.getForeignObjectsAsync(`${id}.*`);
		for (const [key, obj] of Object.entries(children ?? {})) {
			result[key] = obj;
		}
		return result;
	}

	/**
	 * Store a device configuration. The native part is replaced (not merged) so that removed list entries disappear.
	 *
	 * @param id - Device id
	 * @param cfg - Device configuration
	 */
	private async writeDevice(id: Id, cfg: DeviceConfig): Promise<void> {
		const old = await this.adapter.getObjectAsync(id);
		if (old) {
			// js-controller only allows common.custom on states and warns about it on a device
			const { custom: _custom, ...common } = old.common as ioBroker.ObjectCommon & { custom?: unknown };
			await this.adapter.setObjectAsync(id, {
				...old,
				common: { ...common, name: cfg.name },
				native: { ...cfg },
			} as ioBroker.Object);
		}
		// a final phase switched on only by the optimisation keeps its states
		const override = this.adapter.registry.get(id)?.currentOverride ?? null;
		await ensureDeviceObjects(this.objectWriter(), id, cfg, this.adapter.instanceConfig, override);
	}

	private async readOperations(id: Id): Promise<Record<string, unknown>[]> {
		const raw = (await this.adapter.getStateAsync(`${id}.lastOperations`))?.val;
		if (typeof raw !== "string" || raw === "") {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter(isRecord).reverse() : [];
		} catch {
			return [];
		}
	}

	/**
	 * Build the card of a device.
	 *
	 * @param id - Device id
	 * @param known - Device object if already loaded
	 */
	private async buildDeviceInfo(id: Id, known?: ioBroker.Object): Promise<DeviceInfo<Id>> {
		const obj = known ?? (await this.adapter.getObjectAsync(id));
		const cfg = obj ? this.configOf(obj) : null;
		const ns = this.adapter.namespace;
		const sid = (rel: string): { stateId: string } => ({ stateId: `${ns}.${id}.${rel}` });
		if (!obj || !cfg) {
			return {
				id,
				name: nameOf(obj?.common?.name, id),
				icon: GENERIC_ICON,
				actions: this.deviceActions(id, false, false, false, false),
			};
		}

		const runtime = this.adapter.registry.get(id);
		const powerMissing =
			cfg.powerId === "" ||
			runtime?.powerMissing === true ||
			!(await this.adapter.getForeignObjectAsync(cfg.powerId));
		let warning: ioBroker.StringOrTranslated | boolean | { stateId: string } = sid("alertRuntime");
		if (powerMissing) {
			warning = TEXT.powerMissing(cfg.powerId);
		} else if (cfg.needsReview) {
			warning = TEXT.needsReview(cfg.reviewHint ?? "");
		} else if (this.adapter.registry.learningData(id)?.final?.state === "suspended") {
			warning = TEXT.finalSuspendedCard;
		} else if ((this.adapter.registry.learningData(id)?.info.review?.length ?? 0) > 0) {
			warning = TEXT.reviewCard;
		} else if (this.adapter.registry.learningData(id)?.info.status === "drift") {
			warning = TEXT.driftCard;
		} else if (this.adapter.registry.learningData(id)?.info.status === "cannotCover") {
			warning = TEXT.cannotCoverCard;
		} else if ((this.adapter.registry.learningData(id)?.info.budget ?? 0) >= BUDGET_WARN_JOBS) {
			warning = TEXT.budgetCard;
		}
		const learning = (await this.adapter.getStateAsync(`${id}.learning.active`))?.val === true;
		const dnd = runtime?.doNotDisturb ?? false;
		const optimize = cfg.autoOptimize === true || (await this.adapter.registry.readLearningData(id)) !== null;

		const indicators: StatusIndicator[] = [
			{
				id: "running",
				label: TEXT.running,
				value: sid("running"),
				icon: "play",
				color: "inactive",
				colorOn: "ok",
				defaultVisible: true,
				order: 1,
			},
			{
				id: "finished",
				label: TEXT.finished,
				value: sid("finished"),
				icon: "info",
				color: "inactive",
				colorOn: "warning",
				defaultVisible: true,
				order: 2,
			},
			{
				id: "statusText",
				label: TEXT.status,
				value: sid("status"),
				showValue: true,
				defaultVisible: true,
				order: 3,
			},
			{
				id: "consumption",
				label: TEXT.consumption,
				value: sid("consumption"),
				showValue: true,
				unit: "W",
				defaultVisible: true,
				order: 4,
			},
			{
				id: "runtime",
				label: TEXT.runtime,
				value: sid("runtime"),
				showValue: true,
				defaultVisible: true,
				order: 5,
			},
		];

		return {
			id,
			name: cfg.name,
			identifier: cfg.powerId,
			model: deviceModel(cfg, (runtime?.currentOverride ?? null) !== null),
			icon: GENERIC_ICON,
			enabled: cfg.enabled,
			status: { warning },
			indicators,
			hasDetails: true,
			actions: this.deviceActions(id, cfg.enabled, dnd, learning, optimize),
		};
	}

	private deviceActions(
		id: Id,
		enabled: boolean,
		dnd: boolean,
		learning: boolean,
		optimize: boolean,
	): DeviceAction<Id>[] {
		const actions: DeviceAction<Id>[] = [
			{ id: "edit", icon: "edit", description: TEXT.edit, handler: (_id, ctx) => this.editDevice(id, ctx) },
			{
				id: "delete",
				icon: "delete",
				description: TEXT.delete,
				handler: (_id, ctx) => this.deleteDevice(id, ctx),
			},
			{
				id: ACTIONS.ENABLE_DISABLE,
				description: TEXT.toggleEnabled,
				handler: () => this.setEnabled(id, !enabled),
			},
			{
				id: "dnd",
				icon: "pause",
				description: dnd ? TEXT.dndOff : TEXT.dndOn,
				handler: () => this.toggleDnd(id, !dnd),
			},
			{
				id: "acknowledge",
				icon: "identify",
				description: TEXT.acknowledge,
				handler: () => this.acknowledge(id),
			},
			{
				id: "learn",
				icon: learning ? "stop" : "play",
				description: learning ? TEXT.learnStop : TEXT.learnStart,
				handler: (_id, ctx) => this.learn(id, ctx),
			},
			{ id: "test", icon: "send", description: TEXT.test, handler: (_id, ctx) => this.sendTest(id, ctx) },
		];
		if (optimize) {
			actions.push({
				id: "optimization",
				icon: "lines",
				description: I18n.getTranslatedObject("dm_optimization"),
				handler: (_id, ctx) => this.optimization(id, ctx),
			});
		}
		return actions;
	}

	/** Rooms and functions of the installation with their members. */
	private async loadEnums(): Promise<{
		members: EnumMembers;
		options: { rooms: EnumOption[]; functions: EnumOption[] };
	}> {
		const members: EnumMembers = {};
		const options: { rooms: EnumOption[]; functions: EnumOption[] } = { rooms: [], functions: [] };
		// language of the installation (system.config), the adapter property is not set in every js-controller
		const sysLang = (await this.adapter.getForeignObjectAsync("system.config"))?.common?.language;
		const lang = (typeof sysLang === "string" && sysLang) || this.adapter.language || "en";
		for (const kind of ["rooms", "functions"] as const) {
			const objs = (await this.adapter.getForeignObjectsAsync(`enum.${kind}.*`, "enum")) ?? {};
			for (const [id, obj] of Object.entries(objs)) {
				members[id] = Array.isArray(obj.common?.members) ? [...obj.common.members] : [];
				options[kind].push({ value: id, label: enumLabel(id, obj.common?.name, lang) });
			}
			options[kind].sort((a, b) => a.label.localeCompare(b.label));
		}
		return { members, options };
	}

	/**
	 * Make the device object a member of exactly the chosen rooms and functions.
	 *
	 * @param id - Device id (relative)
	 * @param members - Current members per enum
	 * @param rooms - Chosen rooms
	 * @param functions - Chosen functions
	 */
	private async assignEnums(id: Id, members: EnumMembers, rooms: string[], functions: string[]): Promise<void> {
		const full = `${this.adapter.namespace}.${id}`;
		for (const [kind, selected] of [
			["rooms", rooms],
			["functions", functions],
		] as const) {
			const { add, remove } = planEnumUpdate(members, kind, full, selected);
			for (const enumId of [...add, ...remove]) {
				const list = members[enumId].filter(m => m !== full);
				if (add.includes(enumId)) {
					list.push(full);
				}
				try {
					await this.adapter.extendForeignObjectAsync(enumId, { common: { members: list } });
				} catch (err) {
					this.log.warn(`Cannot update ${enumId}: ${errorMessage(err)}`);
				}
			}
		}
	}

	private async updateOf(id: Id): Promise<DeviceRefresh> {
		return { update: await this.buildDeviceInfo(id) };
	}

	/**
	 * Show the device form until it is valid or cancelled.
	 *
	 * @param ctx - Action context
	 * @param title - Dialog title
	 * @param data - Initial form data
	 * @param enums - Rooms and functions offered in the form
	 * @param enums.rooms - Room options
	 * @param enums.functions - Function options
	 * @param detection - Result of the type detection (for the hint)
	 * @param previous - Stored configuration when editing (null: the device is added)
	 * @param source - Values the form was prefilled with when the device is added
	 * @param copyHint - The values were copied from a device that has a final phase or phases
	 */
	private async askDevice(
		ctx: ActionContext,
		title: ioBroker.StringOrTranslated,
		data: DeviceFormData,
		enums: { rooms: EnumOption[]; functions: EnumOption[] },
		detection?: DetectionResult,
		previous: DeviceConfig | null = null,
		source?: FormSource,
		copyHint = false,
	): Promise<{ config: DeviceConfig; rooms: string[]; functions: string[] } | null> {
		let current: JsonFormData = { ...data };
		const isNew = previous === null;
		for (;;) {
			const shownFactor = await this.unitFactorOf(textOf(current.powerId).trim());
			const result = await ctx.showForm(
				buildDeviceSchema(
					this.adapter.instanceConfig,
					detection,
					enums,
					shownFactor === 1000 ? "kW" : "W",
					copyHint,
				),
				{ data: current, title },
			);
			if (!result) {
				return null;
			}
			const form = toFormData(result);
			const { config, errors, warnings } = formToDeviceConfig(form, {
				isNew,
				unitFactor: await this.unitFactorOf(textOf(form.powerId).trim()),
				...(previous ? { previous } : {}),
				...(source ? { source } : {}),
			});
			if (config) {
				if (warnings.length > 0) {
					for (const warning of warnings) {
						this.adapter.log.warn(warning);
					}
					await ctx.showMessage(warnings.join("\n"));
				}
				return { config, rooms: idList(result.rooms), functions: idList(result.functions) };
			}
			await ctx.showMessage(errors.join("\n"));
			current = result;
		}
	}

	/**
	 * Values a new device starts with (in W) and whether they come from a device with a final phase or phases.
	 *
	 * @param value - Value of the field `source` (falls back to the template "Custom")
	 * @param archive - Archive templates
	 * @param devices - Existing device objects by id
	 */
	private async sourceValues(
		value: unknown,
		archive: ReturnType<typeof archiveTemplates>,
		devices: Map<string, ioBroker.Object>,
	): Promise<{ detection: DetectionSettings; template?: string; copyHint: boolean }> {
		const choice = parseSourceChoice(value);
		if (choice?.kind === "archive") {
			const found = archive.find(a => a.id === choice.id);
			if (found) {
				return { detection: found.detection, copyHint: false };
			}
		} else if (choice?.kind === "device") {
			const obj = devices.get(choice.id);
			const cfg = obj ? this.configOf(obj) : null;
			if (obj && cfg) {
				// only the 16 base values; final phase and phases are learned at the new device (Spec C.2)
				const base = detectionOf(cfg.detection);
				for (const key of FINAL_KEYS) {
					base[key] = 0;
				}
				const unitFactor = await this.unitFactorOf(cfg.powerId);
				const used = FINAL_KEYS.some(key => (cfg.detection[key] ?? 0) !== 0) || isRecord(obj.native?.phases);
				return { detection: scalePowers(base, unitFactor, 1), copyHint: used };
			}
		} else if (choice?.kind === "template") {
			const template = findTemplate(choice.id);
			if (template) {
				return { detection: template.detection, template: template.id, copyHint: false };
			}
		}
		return { detection: CUSTOM_TEMPLATE.detection, template: CUSTOM_TEMPLATE.id, copyHint: false };
	}

	private async addDevice(ctx: ActionContext): Promise<InstanceRefreshResponse> {
		let manual = false;
		let sourceId = "";
		let sourceChoice = DEFAULT_SOURCE;
		const instanceObj = await this.adapter.getForeignObjectAsync(`system.adapter.${this.adapter.namespace}`);
		const archive = archiveTemplates((instanceObj?.native ?? {}) as Record<string, unknown>);
		const existing = await this.deviceObjects();
		const known = [...existing.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([id, obj]) => ({ id, name: this.configOf(obj)?.name ?? id }));
		for (;;) {
			const first = await ctx.showForm(buildSourceSchema(archive, known), {
				title: TEXT.addTitle,
				data: { manual, sourceId, source: sourceChoice },
				ignoreApplyDisabled: true,
			});
			if (!first) {
				return { refresh: false };
			}
			manual = first.manual === true;
			sourceId = textOf(first.sourceId).trim();
			sourceChoice = textOf(first.source) || DEFAULT_SOURCE;
			if (manual || sourceId !== "") {
				break;
			}
			await ctx.showMessage(TEXT.sourceMissing);
		}

		const inst = this.adapter.instanceConfig;
		let detection: DetectionResult | undefined;
		let name = "";
		if (!manual) {
			detection = await detectFromHost(id => this.getObjectsUnder(id), sourceId);
			const source = await this.adapter.getForeignObjectAsync(sourceId);
			name = nameOf(source?.common?.name, sourceId.split(".").pop() ?? "");
		}
		const enums = await this.loadEnums();
		const values = await this.sourceValues(sourceChoice, archive, existing);
		const prefillFactor = await this.unitFactorOf(detection?.powerId ?? "");
		const prefill: DeviceFormData = {
			...scalePowers(values.detection, 1, prefillFactor),
			enabled: true,
			name,
			sourceId: manual ? "" : sourceId,
			powerId: detection?.powerId ?? "",
			switchId: detection?.switchId ?? "",
			startText: "",
			endText: "",
			abort: false,
			abortFixed: false,
			autoOff: false,
			autoOffMinutes: 0,
			recipients: [],
			reminder: { ...DEFAULT_REMINDER },
			actions: [],
			rooms: [],
			functions: [],
		};
		const answer = await this.askDevice(
			ctx,
			TEXT.addTitle,
			prefill,
			enums.options,
			detection,
			null,
			{
				detection: values.detection,
				...(values.template ? { template: values.template } : {}),
				unitFactor: prefillFactor,
			},
			values.copyHint,
		);
		if (!answer) {
			return { refresh: false };
		}
		const { config } = answer;

		const taken = new Set<string>([...RESERVED_IDS, ...(await this.deviceObjects()).keys()]);
		const id = allocateDeviceId(config.name, taken);
		await ensureDeviceObjects(this.objectWriter(), id, config, inst);
		await this.assignEnums(id, enums.members, answer.rooms, answer.functions);
		this.log.info(`Device ${config.name} added as ${id}`);
		return { refresh: true };
	}

	/**
	 * Instance action: remove the archive of old device types (`native.types`) after a confirmation. Writing the
	 * instance object restarts the instance, the confirmation says so.
	 *
	 * @param ctx - Action context
	 */
	private async removeArchive(ctx: ActionContext): Promise<InstanceRefreshResponse> {
		const objId = `system.adapter.${this.adapter.namespace}`;
		const obj = await this.adapter.getForeignObjectAsync(objId);
		const types: unknown = obj?.native?.types;
		if (!obj || !Array.isArray(types) || types.length === 0) {
			await ctx.showMessage(TEXT.archiveEmpty);
			return { refresh: false };
		}
		if (!(await ctx.showConfirmation(I18n.getTranslatedObject("dm_removeArchiveConfirm")))) {
			return { refresh: false };
		}
		await this.adapter.setForeignObjectAsync(objId, {
			...obj,
			native: { ...obj.native, types: [] },
		} as ioBroker.Object);
		this.log.info(`Old templates removed (${types.length})`);
		return { refresh: false };
	}

	private async editDevice(id: Id, ctx: ActionContext): Promise<DeviceRefresh> {
		const obj = await this.adapter.getObjectAsync(id);
		const cfg = obj ? this.storedConfigOf(obj) : null;
		if (!cfg) {
			await ctx.showMessage(TEXT.notFound);
			return { delete: id };
		}
		const enums = await this.loadEnums();
		const full = `${this.adapter.namespace}.${id}`;
		const form: DeviceFormData = {
			...deviceConfigToForm(cfg),
			rooms: membershipOf(enums.members, "rooms", full),
			functions: membershipOf(enums.members, "functions", full),
		};
		const edited = await this.askDevice(ctx, TEXT.editTitle, form, enums.options, undefined, cfg);
		if (edited) {
			await this.writeDevice(id, edited.config);
			await this.assignEnums(id, enums.members, edited.rooms, edited.functions);
		}
		return this.updateOf(id);
	}

	private async deleteDevice(id: Id, ctx: ActionContext): Promise<DeviceRefresh> {
		if (!(await ctx.showConfirmation(TEXT.deleteConfirm))) {
			return { refresh: "none" };
		}
		await this.adapter.registry.removeLearningData(id);
		this.adapter.registry.remove(id);
		await this.assignEnums(id, (await this.loadEnums()).members, [], []);
		await this.adapter.delObjectAsync(id, { recursive: true });
		this.log.info(`Device ${id} deleted`);
		return { delete: id };
	}

	private async setEnabled(id: Id, enabled: boolean): Promise<DeviceRefresh> {
		const obj = await this.adapter.getObjectAsync(id);
		const cfg = obj ? this.configOf(obj) : null;
		if (!cfg) {
			return { delete: id };
		}
		await this.writeDevice(id, { ...cfg, enabled });
		return this.updateOf(id);
	}

	private async toggleDnd(id: Id, value: boolean): Promise<DeviceRefresh> {
		await this.adapter.registry.routeOwnState(`${id}.config.doNotDisturb`, value, false);
		return this.updateOf(id);
	}

	private async acknowledge(id: Id): Promise<DeviceRefresh> {
		await this.adapter.registry.acknowledge(id);
		return this.updateOf(id);
	}

	private async sendTest(id: Id, ctx: ActionContext): Promise<DeviceRefresh> {
		const cfg = this.adapter.registry.get(id)?.config;
		if (!cfg) {
			await ctx.showMessage(TEXT.notFound);
			return { refresh: "none" };
		}
		const res = await this.adapter.notifier.notify(
			cfg.recipients,
			`Test message from device-reminder (${cfg.name})`,
			{
				doNotDisturb: false,
				test: true,
			},
		);
		await ctx.showMessage(res.sent.length > 0 ? TEXT.testSent : TEXT.testNobody);
		return { refresh: "none" };
	}

	/**
	 * Dialog of the automatic optimisation: status, values, stored runs (with their check, use and limits) and
	 * changes, with the use of a run, undo, reset, clearing the learning data, adopting the values in use as base
	 * values, using the final phase again and discarding the old limits.
	 *
	 * @param id - Device id
	 * @param ctx - Action context
	 */
	private async optimization(id: Id, ctx: ActionContext): Promise<DeviceRefresh> {
		const registry = this.adapter.registry;
		const runtime = registry.get(id);
		if (!runtime) {
			await ctx.showMessage(TEXT.notFound);
			return { refresh: "none" };
		}
		const store = await registry.readLearningData(id);
		const active = registry.learningData(id) !== null;
		if (!store) {
			await ctx.showMessage(TEXT.optOff);
			return this.updateOf(id);
		}
		const check = active ? await registry.checkStoredRuns(id) : null;
		const view = buildOptimizationView(
			store,
			check,
			runtime.baseDetection,
			runtime.effective,
			active,
			registry.verdictsOf(id),
		);
		const result = await ctx.showForm(view.schema, {
			data: view.data,
			title: I18n.getTranslatedObject("dm_optimization"),
			maxWidth: "lg",
		});
		const op = textOf(result?.operation);
		switch (op) {
			case "undo":
				await this.undoDialog(id, store, ctx);
				break;
			case "reset":
				await registry.resetOptimization(id);
				await ctx.showMessage(TEXT.optResetDone);
				break;
			case "use":
				await this.useDialog(id, store, textOf(result?.runKey), textOf(result?.use), ctx);
				break;
			case "clear":
				if (await ctx.showConfirmation(I18n.getTranslatedObject("dm_optClearConfirm"))) {
					await registry.deleteLearningData(id, result?.clearDecisions !== true);
					await ctx.showMessage(TEXT.optCleared);
				}
				break;
			case "adopt": {
				const current = registry.get(id);
				if (!current || current.currentOverride === null) {
					await ctx.showMessage(TEXT.optNothingToAdopt);
					break;
				}
				const changes = describeChange(current.baseDetection, current.effective) || "-";
				if (await ctx.showConfirmation(filled(TEXT.optAdoptConfirm, { changes }))) {
					await ctx.showMessage((await this.adoptAsBase(id)) ? TEXT.optAdopted : TEXT.optAdoptFailed);
				}
				break;
			}
			case "finalOn":
				await ctx.showMessage(
					(await registry.resumeFinal(id, "user")) ? TEXT.optFinalOnDone : TEXT.optFinalNotSuspended,
				);
				break;
			case "newRun": {
				const key = textOf(result?.runKey);
				if (key === "") {
					await ctx.showMessage(TEXT.optNoRunSelected);
					break;
				}
				await ctx.showMessage(
					(await registry.resumeFinal(id, "newRun", key)) ? TEXT.optNewRunDone : TEXT.optNewRunLeft,
				);
				break;
			}
			case "dropLegacy":
				if (await ctx.showConfirmation(I18n.getTranslatedObject("dm_optDropLegacyConfirm"))) {
					await ctx.showMessage(
						(await registry.dropLegacyLimits(id)) ? TEXT.optDropLegacyDone : TEXT.optNoLegacy,
					);
				}
				break;
			default:
				break;
		}
		return this.updateOf(id);
	}

	/**
	 * Undo of the dialog: when the values before the change would not detect every admitted run, the runs are
	 * named, and for a repair a boundary run caused, the user can exclude that run and undo in one step.
	 *
	 * @param id - Device id
	 * @param store - Learning data
	 * @param ctx - Action context
	 */
	private async undoDialog(id: Id, store: StoreFile, ctx: ActionContext): Promise<void> {
		const registry = this.adapter.registry;
		const first = await registry.undoOptimization(id);
		if (first.ok) {
			await ctx.showMessage(TEXT.optUndone);
			return;
		}
		if (first.failing.length === 0 && first.offerExclude === null) {
			await ctx.showMessage(TEXT.optNothingToUndo);
			return;
		}
		const dates = (keys: readonly string[]): string =>
			keys
				.map(k => {
					const run = [...store.runs, ...store.spikes].find(r => r.key === k || sameRun(r.key, k));
					return run ? formatDate(startOf(run)) : k;
				})
				.join(", ");
		const runs = dates(first.failing) || "-";
		if (first.offerExclude !== null) {
			const question = filled(TEXT.optUndoExcludeConfirm, { runs, date: dates([first.offerExclude]) });
			if (await ctx.showConfirmation(question)) {
				const second = await registry.undoOptimization(id, true);
				await ctx.showMessage(
					second.ok ? TEXT.optUndone : filled(TEXT.optUndoBlocked, { runs: dates(second.failing) || "-" }),
				);
				return;
			}
		}
		await ctx.showMessage(filled(TEXT.optUndoBlocked, { runs }));
	}

	/**
	 * Use of a run chosen in the dialog; before a boundary run is excluded the user is warned.
	 *
	 * @param id - Device id
	 * @param store - Learning data
	 * @param key - Key of the run
	 * @param use - `auto`, `include` or `exclude`
	 * @param ctx - Action context
	 */
	private async useDialog(id: Id, store: StoreFile, key: string, use: string, ctx: ActionContext): Promise<void> {
		const registry = this.adapter.registry;
		if (key === "" || !["auto", "include", "exclude"].includes(use)) {
			await ctx.showMessage(TEXT.optNoRunSelected);
			return;
		}
		const decision = use === "auto" ? null : (use as "include" | "exclude");
		if (decision === "exclude" && boundaryInfo(store, registry.verdictsOf(id) ?? undefined).has(key)) {
			if (!(await ctx.showConfirmation(TEXT.optExcludeWarn))) {
				return;
			}
		}
		const done = await registry.setRunUse(id, key, decision);
		await ctx.showMessage(done.reverted ? TEXT.optUseReverted : TEXT.optUseDone);
	}

	private async learn(id: Id, ctx: ActionContext): Promise<DeviceRefresh> {
		const registry = this.adapter.registry;
		if (!registry.get(id)) {
			await ctx.showMessage(TEXT.notFound);
			return { refresh: "none" };
		}
		const active = (await this.adapter.getStateAsync(`${id}.learning.active`))?.val === true;
		if (!active) {
			if (await this.learnFromHistory(id, ctx)) {
				return this.updateOf(id);
			}
			// an energy meter (Wh) shows no power: recording it would only teach wrong values (Spec B.7 `counter`)
			const powerId = registry.get(id)?.config.powerId;
			const obj = powerId ? await this.adapter.getForeignObjectAsync(powerId) : null;
			const common = (obj?.common ?? {}) as { unit?: unknown; role?: unknown };
			const unitText = typeof common.unit === "string" ? common.unit.trim() : "";
			const role = typeof common.role === "string" ? common.role : "";
			if (/wh$/i.test(unitText) || role.startsWith("value.energy")) {
				await ctx.showMessage(TEXT.learnEnergyCounter);
				return this.updateOf(id);
			}
			await registry.startLearning(id);
			await ctx.showMessage(TEXT.learnStarted);
			return this.updateOf(id);
		}

		const result = await registry.stopLearning(id);
		if ("error" in result) {
			await ctx.showMessage(LEARN_ERRORS[result.error] ?? plain(result.error));
			return this.updateOf(id);
		}
		await this.applyLearned(id, result, ctx);
		return this.updateOf(id);
	}

	/**
	 * Learn from the stored history of the power state instead of recording a run (Spec B.7). The history is loaded
	 * and every run is checked first; only if it holds enough runs the user is asked whether to use it. Then the
	 * dialog shows every run with its check and use, the suggestion (detection values from the chosen runs, the final
	 * phase with its key figures) and the phases.
	 *
	 * @param id - Device id
	 * @param ctx - Action context
	 * @returns true if the learning was handled (or cancelled), false to record a run instead
	 */
	private async learnFromHistory(id: Id, ctx: ActionContext): Promise<boolean> {
		const registry = this.adapter.registry;
		const cfg = registry.get(id)?.config;
		const powerId = cfg?.powerId;
		const env = this.historyEnv();
		let instance: string | undefined;
		try {
			instance = powerId ? await findHistoryInstance(env, powerId) : undefined;
		} catch (err) {
			this.adapter.log.debug(`No history for ${powerId}: ${errorMessage(err)}`);
		}
		if (!cfg || !powerId || !instance) {
			return false;
		}
		const poll = this.adapter.instanceConfig.pollIntervalSec;
		const loading = await this.progressOf(ctx);
		let input: LearnInput | null = null;
		let unit = "W";
		let minDelta = 0;
		let unreadable = false;
		let energyCounter = false;
		try {
			const loaded = await loadHistorySeries(env, instance, powerId, Date.now(), poll, f =>
				loading.report(Math.round(60 * f), TEXT.learnReading),
			);
			const { meta } = loaded;
			unit = meta.unit || "W";
			minDelta = meta.minDelta;
			if (meta.error) {
				this.adapter.log.warn(
					`History of ${powerId} from ${instance}: ${meta.failedChunks} of ${meta.queries} queries failed: ${meta.error}`,
				);
			}
			unreadable = meta.queries > 0 && meta.failedChunks === meta.queries;
			energyCounter = meta.energyCounter;
			if (!energyCounter && loaded.series.points >= 20) {
				loading.report(80, TEXT.learnChecking);
				input = learnInputOf(id, loaded.series, loaded.clean, meta.unitFactor, meta.settings);
			}
			loading.report(100, TEXT.learnChecking);
		} catch (err) {
			this.adapter.log.warn(`Reading the history of ${powerId} from ${instance} failed: ${errorMessage(err)}`);
		} finally {
			await loading.close();
		}
		if (energyCounter) {
			await ctx.showMessage(TEXT.learnEnergyCounter);
			return true;
		}
		const runCount = input?.samples.filter(x => x.kind === "run").length ?? 0;
		if (!input || runCount < MIN_RUNS) {
			await ctx.showMessage(unreadable ? TEXT.learnHistoryUnreadable : TEXT.learnHistoryTooFewRuns);
			return false;
		}
		const choice = await ctx.showForm(buildLearnSourceSchema(), {
			data: { source: "history", instance, runs: runCount },
			title: TEXT.learnSourceTitle,
			// the preset choice is a valid answer: OK must work without a change
			ignoreApplyDisabled: true,
		});
		if (!choice) {
			return true;
		}
		if (choice.source !== "history") {
			return false;
		}

		const store = await registry.readLearningData(id);
		let uses = initialUses(input, store);
		const oldStore = oldStoreOf(store);
		let ev: Evaluation;
		let result: HistorySuggestion;
		for (;;) {
			// step 1 (only on request): the runs with their check and use; "recalculate" shows them again for the
			// chosen set. Without the request the check decides on its own.
			while (choice.reviewRuns === true) {
				ev = evaluateRuns(input, uses, oldStore);
				const learned = this.learnPhasesOf(cfg, input, ev, poll);
				const seq = learned ? phaseSequences(learned.model, ev.bands, input, poll) : new Map<string, string>();
				const rows = rowsOf(input, ev, uses, seq);
				const answer = await ctx.showForm(
					buildRunsSchema(
						rows,
						ev.verdicts.some(v => v.reasons.some(r => r.code === "formerlyDropped")),
					),
					{ data: runTableData(rows), title: TEXT.learnRunsTitle, ignoreApplyDisabled: true },
				);
				if (!answer) {
					return true;
				}
				uses = usesOfAnswer(answer, rows);
				if (answer.recalc !== true) {
					break;
				}
			}
			ev = evaluateRuns(input, uses, oldStore);
			// step 2: detection values from the chosen runs
			const analysing = await this.progressOf(ctx);
			let analysed: Awaited<ReturnType<typeof analyzeHistory>>;
			try {
				analysed = await analyzeHistory(input.points, poll, {
					abort: cfg.abort,
					abortFixed: cfg.abortFixed,
					unitFactor: input.factor,
					minDelta,
					currentType: detectionOf(cfg.detection),
					// only the values of a built-in template stand for the wanted end (drying of a dishwasher)
					keepCurrentLevel: findTemplate(cfg.template) !== undefined,
					heldBack: heldBackSpans(input, ev),
					yieldFn: () =>
						new Promise<void>(resolve => {
							this.adapter.setTimeout(resolve, 0);
						}),
					onProgress: f => analysing.report(Math.round(100 * f), TEXT.learnChecking),
				});
				analysing.report(100, TEXT.learnChecking);
			} catch (err) {
				this.adapter.log.warn(`Learning from the history of ${powerId} failed: ${errorMessage(err)}`);
				analysed = { error: "noHistory" };
			} finally {
				await analysing.close();
			}
			if ("error" in analysed) {
				await ctx.showMessage(TEXT.learnHistoryTooFewRuns);
				// with the run list the user can choose other runs; without it the same runs would fail again
				if (choice.reviewRuns === true) {
					continue;
				}
				return true;
			}
			result = analysed;
			break;
		}
		await this.adapter.setStateAsync(`${id}.learning.result`, JSON.stringify(result), true);

		// steps 3 and 4: final phase and phases from the chosen runs
		const suggested = settingsOfSuggestion(detectionOf(cfg.detection), result);
		const learned = this.learnPhasesOf(cfg, input, ev, poll);
		let finalCandidate: FinalCandidate | null = null;
		if (ev.bands) {
			const runs = input.samples.map((sample, k) => ({ sample, verdict: ev.verdicts[k], series: input.series }));
			finalCandidate = await learnFinal(runs, {
				base: suggested,
				pollSec: poll,
				unitFactor: input.factor,
				abort: cfg.abort,
				abortFixed: cfg.abortFixed,
				bands: ev.bands,
				minRuns: 5,
				minPerGroup: 1,
				scope: learned?.result.model.scope ?? "run",
				yieldFn: () =>
					new Promise<void>(resolve => {
						this.adapter.setTimeout(resolve, 0);
					}),
			});
		}
		const decisions: Record<string, "include" | "exclude" | null> = {};
		for (const x of input.samples) {
			const u = uses.get(x.key) ?? "auto";
			decisions[x.key] = u === "auto" ? null : u;
		}
		const chosen = input;
		const chosenEv = ev;
		await this.applyLearned(id, result, ctx, unit, TEXT.learnConfirm, {
			final: finalCandidate,
			model: learned?.model ?? null,
			retro: learned?.result.retroOnly ?? [],
			dropped: learned?.result.dropped ?? [],
			decisions,
			runsText: runSummary(chosen, chosenEv, this.adapter.language ?? "en"),
			bands: ev.bands,
			storedRuns: eff => this.storedRunsOf(chosen, chosenEv, eff, cfg, poll),
		});
		return true;
	}

	/**
	 * Progress dialog with a throttled update.
	 *
	 * @param ctx - Action context
	 */
	private async progressOf(
		ctx: ActionContext,
	): Promise<{ report: (value: number, label: ioBroker.Translated) => void; close: () => Promise<void> }> {
		const progress = await ctx.openProgress(TEXT.learnAnalysing, { value: 0, label: TEXT.learnReading });
		let sent = 0;
		let updates: Promise<void> = Promise.resolve();
		return {
			report: (value, label) => {
				if (value < sent + 5 && !(value === 100 && sent < 100)) {
					return;
				}
				sent = value;
				updates = updates.then(() => progress.update({ value, label })).catch(() => undefined);
			},
			close: async () => {
				await updates;
				await progress.close();
			},
		};
	}

	/**
	 * Phases from the chosen runs (null when no usable model comes out).
	 *
	 * @param cfg - Device configuration
	 * @param input - Samples
	 * @param ev - Run check
	 * @param poll - Poll interval in s
	 */
	private learnPhasesOf(
		cfg: DeviceConfig,
		input: LearnInput,
		ev: Evaluation,
		poll: number,
	): { model: PhaseModel; result: PhaseLearnResult } | null {
		if (!ev.bands) {
			return null;
		}
		const result = learnPhases(
			input.samples.map((sample, k) => ({ sample, verdict: ev.verdicts[k] })),
			{
				runLimitW: input.layout.runLimit,
				unitFactor: input.factor,
				pollSec: poll,
				...(cfg.phases ? { previous: cfg.phases } : {}),
				neutralName,
				neutralTemplates: Object.values(I18n.getTranslatedObject("phase_neutral") as Record<string, string>),
				now: Date.now(),
				actionsOf: phaseId => cfg.actions.filter(a => a.phaseId === phaseId).length,
			},
		);
		const model = normalizePhases(result.model, [], cfg.name);
		return model ? { model, result } : null;
	}

	/**
	 * The runs of the dialog that count for the end as stored runs (`src: "history"`), labelled with the new values:
	 * comparison data for the judgement afterwards (Spec A.3) and for the optimisation.
	 *
	 * @param input - Samples
	 * @param ev - Run check
	 * @param eff - New detection values (unit of the state)
	 * @param cfg - Device configuration
	 * @param poll - Poll interval in s
	 */
	private async storedRunsOf(
		input: LearnInput,
		ev: Evaluation,
		eff: DetectionSettings,
		cfg: DeviceConfig,
		poll: number,
	): Promise<StoredRun[]> {
		const keys = input.samples
			.filter((x, k) => x.kind === "run" && admitted(ev.verdicts[k], "end"))
			.map(x => x.key);
		const layout = buildLayout(input.series, {
			keepAbove: eff.endVal * input.factor,
			maxRuns: Number.POSITIVE_INFINITY,
		});
		return storedRunsOfHistory(input.series, layout, {
			eff,
			abort: cfg.abort,
			abortFixed: cfg.abortFixed,
			pollSec: poll,
			unitFactor: input.factor,
			skip: startMs => {
				const key = verdictKey(input.deviceId, startMs);
				return !keys.some(k => sameRun(k, key));
			},
			yieldFn: () =>
				new Promise<void>(resolve => {
					this.adapter.setTimeout(resolve, 0);
				}),
		});
	}

	/** Installation access for the history analysis. */
	private historyEnv(): HistoryEnv {
		return {
			object: id => this.adapter.getForeignObjectAsync(id),
			alive: async instance =>
				(await this.adapter.getForeignStateAsync(`system.adapter.${instance}.alive`))?.val === true,
			getHistory: (id, options) => this.adapter.getHistoryAsync(id, options),
		};
	}

	/**
	 * "Adopt as base values": write the values in use (base values with the optimised values, never masked) into
	 * the device first. The registry then sees base values that equal the values in use and drops the override
	 * without loss (`adopted`); if writing the device fails, everything stays as it was. No restart.
	 *
	 * @param id - Device id
	 * @returns whether the device was written
	 */
	public async adoptAsBase(id: Id): Promise<boolean> {
		const runtime = this.adapter.registry.get(id);
		const obj = await this.adapter.getObjectAsync(id);
		const cfg = obj ? this.storedConfigOf(obj) : null;
		if (!runtime || runtime.currentOverride === null || !cfg) {
			return false;
		}
		const detection = runtime.effective;
		const changes = describeChange(runtime.baseDetection, detection) || "-";
		const { template: _template, typeId: _typeId, ...rest } = cfg as DeviceConfig & { typeId?: unknown };
		try {
			await this.writeDevice(id, { ...rest, detection, learned: true });
		} catch (err) {
			this.adapter.log.warn(
				`${cfg.name}: values in use not adopted, the device was not saved: ${errorMessage(err)}`,
			);
			return false;
		}
		this.adapter.log.info(`${cfg.name}: values in use saved as base values of the device (${changes})`);
		return true;
	}

	/**
	 * Let the user adjust the suggestion and write it into the detection values of the device (unit of the power
	 * state). The final phase of the device is kept, the template is dropped. No restart, the instance object is
	 * not touched.
	 *
	 * @param id - Device id
	 * @param suggestion - Suggested detection values
	 * @param ctx - Action context
	 * @param unit - Unit of the power state
	 * @param confirm - Confirmation before saving; `{changes}` lists the values old → new
	 * @param extras - Learning from the history: final phase, phases and the decisions about the runs
	 */
	public async applyLearned(
		id: Id,
		suggestion: LearningSuggestion,
		ctx: ActionContext,
		unit = "W",
		confirm: ioBroker.Translated = TEXT.learnConfirm,
		extras?: LearnExtras,
	): Promise<void> {
		const obj = await this.adapter.getObjectAsync(id);
		const cfg = obj ? this.storedConfigOf(obj) : null;
		if (!cfg) {
			await ctx.showMessage(TEXT.notFound);
			return;
		}
		// the after-run filter has no fields in the dialog: its values come from the suggestion, not from the answer
		const afterRun = trailerValuesOf(suggestion);
		const before = detectionOf(cfg.detection);
		const oldFinish = { active: finalOn(before), ...(cfg.phases ? { model: cfg.phases } : {}) };
		const model = extras?.model ?? null;
		const finalCandidate = extras?.final ?? null;
		let data: JsonFormData = {
			startVal: suggestion.thresholds.startVal,
			endVal: suggestion.thresholds.endVal,
			standby: suggestion.thresholds.standby,
			startCount: suggestion.thresholds.startCount,
			endCount: suggestion.thresholds.endCount,
			startDurationSec: suggestion.startDurationSec,
			endDurationSec: suggestion.endDurationSec,
			durationSec: suggestion.durationSec,
			samples: suggestion.samples,
			mode: suggestion.mode ?? "count",
			pauseHoldSec: suggestion.pauseHoldSec,
			pauseUntilSec: suggestion.pauseUntilSec,
			pauseBelowVal: suggestion.pauseBelowVal,
			...(suggestion.evaluation ? { runs: suggestion.runs, ...evaluationTexts(suggestion.evaluation) } : {}),
			...(suggestion.looDetected !== undefined
				? { looText: `${suggestion.looDetected}/${suggestion.runs}` }
				: {}),
			...(suggestion.longestPauseSec !== undefined
				? { longestPauseMin: Math.round(suggestion.longestPauseSec / 60) }
				: {}),
			...(suggestion.current ? { eval_current: evaluationText(suggestion.current) } : {}),
			...(suggestion.checks && suggestion.checks.length > 0
				? { checksText: suggestion.checks.map(code => checkLabel(code)).join(", ") }
				: {}),
			...(extras ? finishData(model, finalCandidate, oldFinish) : {}),
			...(model ? phaseData(model, cfg.phases) : {}),
		};
		data = { ...data, ...oldValuesOf(before, unit), ...afterRunData(before, afterRun, unit) };
		const fromHistory = suggestion.looDetected !== undefined;
		const base = buildLearnSchema({
			fromHistory,
			unit,
			withCurrent: suggestion.current !== undefined,
			withEval: suggestion.evaluation !== undefined,
			notSeparable: suggestion.trailer === "notSeparable",
			withSamples: suggestion.samples > 0,
			changed: changedValues(before, data),
			afterRun: afterRunChanged(before, afterRun),
		});
		const schema: JsonFormSchema = {
			...base,
			items: {
				...(extras?.runsText
					? { runsText: { type: "staticText", text: extras.runsText, newLine: true, xs: 12 } }
					: {}),
				...(base as Extract<JsonFormSchema, { type: "panel" }>).items,
				...(suggestion.checks && suggestion.checks.length > 0
					? {
							checks: {
								type: "infoBox",
								boxType: "warning",
								text: I18n.getTranslatedObject("dm_learnChecks"),
								newLine: true,
								xs: 12,
							},
							checksText: { type: "text", disabled: true, xs: 12 },
						}
					: {}),
				...(model ? phaseItems(model, extras?.retro ?? [], extras?.dropped ?? []) : {}),
				...(extras ? finishItems(model, finalCandidate, oldFinish) : {}),
			},
		} as JsonFormSchema;
		let next: DetectionSettings | null = null;
		// without "finished from" (recording a run) the final phase of the device stays
		let choice: FinishChoice = { useFinal: false, keep: true, finalId: null };
		let answered: JsonFormData = data;
		while (!next) {
			const result = await ctx.showForm(schema, { data, title: TEXT.learnTitle, ignoreApplyDisabled: true });
			if (!result) {
				return;
			}
			// an answer that holds only the changed fields keeps the suggestion for the others
			answered = { ...data, ...result };
			const parsed = parseLearnForm(answered);
			if (!parsed.values) {
				await ctx.showMessage(parsed.error);
				data = answered;
				continue;
			}
			// the learned values replace the base values; "finished from" decides the final phase: standby (3.1.2,
			// no final phase), the learned one (offered only when every release check passed) or the one of the device
			if (extras) {
				choice = finishChoiceOf(answered.finishAt, model, finalCandidate, oldFinish);
			}
			const final: FinalSettings = {};
			for (const key of FINAL_KEYS) {
				final[key] = choice.useFinal
					? (finalCandidate?.values[key] ?? 0)
					: choice.keep
						? (before[key] ?? 0)
						: 0;
			}
			next = normalizeDetection({ ...final, ...parsed.values, ...afterRun }, [], cfg.name);
		}
		const useFinal = choice.useFinal;
		const changes = describeChange(before, next) || "-";
		if (!(await ctx.showConfirmation(filled(confirm, { changes })))) {
			return;
		}
		const { template: _template, typeId: _typeId, ...rest } = cfg as DeviceConfig & { typeId?: unknown };
		// a learned model is always saved and shown (Spec B.7); without learning nothing changes (3.1.2)
		const phases = model ? phasesFromForm(model, answered, choice) : undefined;
		await this.writeDevice(id, { ...rest, detection: next, learned: true, ...(phases ? { phases } : {}) });
		if (extras) {
			// the decisions about the runs go to the learning data; with the final phase the admitted runs and the
			// base bands too, so that the judgement afterwards has comparison data (Spec A.3)
			const runs = useFinal ? await extras.storedRuns(next) : [];
			await this.adapter.registry.setDecisions(
				id,
				extras.decisions,
				runs,
				useFinal && extras.bands ? extras.bands : undefined,
				typeHash(next),
			);
		}
		this.adapter.log.info(`${cfg.name}: learned detection values saved (${changes})`);
		await ctx.showMessage(TEXT.learnSaved);
	}
}

/** What learning from the history hands to the last step of the dialog. */
export interface LearnExtras {
	/** Final phase learned from the chosen runs, or null without base bands. */
	final: FinalCandidate | null;
	/** Phase model learned from the chosen runs, or null. */
	model: PhaseModel | null;
	/** Event phases that only appear in the timeline. */
	retro: string[];
	/** Phases of the old model that fall away. */
	dropped: { id: string; name: string; actions: number }[];
	/** Decision per run key (`null` removes it). */
	decisions: Record<string, "include" | "exclude" | null>;
	/** Which runs the suggestion comes from (shown above the values). */
	runsText?: string;
	/** Base bands of the chosen runs. */
	bands: BaseBands | null;
	/** The admitted runs as stored runs, labelled with the new values. */
	storedRuns: (eff: DetectionSettings) => Promise<StoredRun[]>;
}

/**
 * Text of a finding of the run check in the system language.
 *
 * @param code - Finding
 */
function checkLabel(code: string): string {
	const key = `dm_check_${code}`;
	const t = I18n.translate(key);
	return t === key ? code : t;
}

/**
 * Use of each run at the start of the dialog: the decisions stored in the learning data.
 *
 * @param input - Samples
 * @param store - Learning data of the device, or null
 */
function initialUses(input: LearnInput, store: StoreFile | null): Map<string, RunUse> {
	const out = new Map<string, RunUse>();
	const decided = Object.entries(store?.verdicts ?? {});
	for (const x of input.samples) {
		const d = decided.find(([key]) => sameRun(key, x.key))?.[1];
		out.set(x.key, d?.user ?? "auto");
	}
	return out;
}

/**
 * Range and keys of the runs of an old learning file (before this version), for the finding `formerlyDropped`.
 *
 * @param store - Learning data of the device, or null
 */
function oldStoreOf(store: StoreFile | null): { from: number; to: number; keys: string[] } | undefined {
	if (!store || (store.legacyEnvelope?.n ?? 0) === 0 || store.runs.length === 0) {
		return undefined;
	}
	const runs = [...store.runs, ...store.spikes];
	return {
		from: Math.min(...runs.map(r => startOf(r))),
		to: Math.max(...runs.map(r => r.ts + (r.seg.runEndIdx + 1) * r.step)),
		keys: runs.map(r => verdictKey(store.deviceId, startOf(r))),
	};
}

/**
 * Detection values with the suggestion of the analysis (after-run filter only when the suggestion uses it).
 *
 * @param before - Values of the device
 * @param s - Suggestion
 */
function settingsOfSuggestion(before: DetectionSettings, s: LearningSuggestion): DetectionSettings {
	const withTrailer = (s.trailerBurstSec ?? 0) > 0;
	return {
		...before,
		startVal: s.thresholds.startVal,
		endVal: s.thresholds.endVal,
		standby: s.thresholds.standby,
		startCount: s.thresholds.startCount,
		endCount: s.thresholds.endCount,
		startDurationSec: s.startDurationSec,
		endDurationSec: s.endDurationSec,
		mode: s.mode ?? before.mode,
		pauseHoldSec: s.pauseHoldSec,
		pauseUntilSec: s.pauseUntilSec,
		pauseBelowVal: s.pauseBelowVal,
		trailerBurstSec: withTrailer ? s.trailerBurstSec : 0,
		trailerGapSec: withTrailer ? (s.trailerGapSec ?? 0) : 0,
		trailerAfterSec: withTrailer ? (s.trailerAfterSec ?? 0) : 0,
		trailerBlockVal: withTrailer ? (s.trailerBlockVal ?? 0) : 0,
		trailerMaxSec: withTrailer ? (s.trailerMaxSec ?? 0) : 0,
	};
}

/**
 * A text with its placeholders filled in, in every language.
 *
 * @param text - Text with placeholders `{name}`
 * @param vars - Values of the placeholders
 */
function filled(text: ioBroker.Translated, vars: Record<string, string | number>): ioBroker.Translated {
	const out: Record<string, string> = {};
	for (const lang of Object.keys(text)) {
		out[lang] = fill(text, lang, vars);
	}
	return out as ioBroker.Translated;
}

const DETECTION_MODES: readonly DetectionMode[] = ["count", "timed", "combined"];
const MODE_LABELS: Record<DetectionMode, string> = { count: "modeCount", timed: "modeTimed", combined: "modeCombined" };

/**
 * Result of each detection mode over the runs of the history, e.g. `5/5 · 4 min`.
 *
 * @param evaluation - Result per mode
 */
export function evaluationTexts(evaluation: readonly ModeEvaluation[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of evaluation) {
		out[`eval_${e.mode}`] = evaluationText(e);
	}
	return out;
}

/**
 * Result of one detection mode, e.g. `5/5 · 4 min (max 6 min)`.
 *
 * @param e - Result of the mode
 */
export function evaluationText(e: ModeEvaluation): string {
	const delay =
		e.detected > 0 ? ` · ${Math.round(e.endDelaySec / 60)} min (max ${Math.round(e.endDelayMaxSec / 60)} min)` : "";
	const spikes = e.falseStarts > 0 ? ` · ${e.falseStarts}×!` : "";
	return `${e.detected}/${e.runs}${delay}${spikes}`;
}

/**
 * Learning suggestion from detection settings (to save the optimised values in the device).
 *
 * @param p - Detection settings
 */
export function suggestionOf(p: DetectionSettings): LearningSuggestion {
	return {
		thresholds: {
			startVal: p.startVal,
			endVal: p.endVal,
			standby: p.standby,
			startCount: p.startCount,
			endCount: p.endCount,
		},
		mode: p.mode,
		startDurationSec: p.startDurationSec,
		endDurationSec: p.endDurationSec,
		durationSec: 0,
		samples: 0,
		pauseHoldSec: p.pauseHoldSec ?? 0,
		pauseUntilSec: p.pauseUntilSec ?? 0,
		pauseBelowVal: p.pauseBelowVal ?? 0,
		...((p.trailerBurstSec ?? 0) > 0
			? {
					trailerBurstSec: p.trailerBurstSec,
					trailerGapSec: p.trailerGapSec ?? 0,
					trailerAfterSec: p.trailerAfterSec ?? 0,
					trailerBlockVal: p.trailerBlockVal ?? 0,
					trailerMaxSec: p.trailerMaxSec ?? 0,
				}
			: {}),
	};
}

/** Status values of the automatic optimisation with their translation keys. */
const OPT_KINDS = [
	"repair",
	"tighten",
	"undo",
	"reset",
	"adopted",
	"baseChanged",
	"revert",
	"finalOn",
	"finalSuspend",
	"finalResume",
	"finalRepair",
	"finalTune",
] as const;

/**
 * Translated kind of a change; entries `typeChanged` of earlier versions are shown like `baseChanged`.
 *
 * @param kind - Kind of the change
 * @param tr - Translation
 */
function kindText(kind: string, tr: (key: string) => string): string {
	const k = kind === "typeChanged" ? "baseChanged" : kind;
	return (OPT_KINDS as readonly string[]).includes(k) ? tr(`dm_optKind_${k}`) : kind;
}

/**
 * Value of a detection field for the parameter table.
 *
 * @param p - Detection settings
 * @param key - Field
 */
function fieldText(p: DetectionSettings, key: DetectionKey): string {
	const v = (p as unknown as Record<string, number | string | undefined>)[key];
	return v === undefined ? "0" : String(v);
}

/**
 * Changed fields of a change as text, e.g. `endCount 38, trailerBurstSec 45`.
 *
 * @param c - Change
 */
function changeText(c: StoreFile["changes"][number]): string {
	return (
		c.reason ||
		Object.entries(c.to ?? {})
			.map(([k, v]) => `${k} ${String(v)}`)
			.join(", ")
	);
}

/**
 * Schema and data of the optimisation dialog.
 *
 * @param store - Learning data
 * @param check - Replay of all stored runs with the current values (null while the optimisation is off)
 * @param type - Detection values of the device (without optimised values)
 * @param effective - Values in use
 * @param active - Whether the automatic optimisation is on (undo, reset and adopt need it)
 * @param verdicts - Run check of the stored runs by key (null while the learning data are not loaded)
 */
export function buildOptimizationView(
	store: StoreFile,
	check: { perRun: { id: string; ok: boolean; delaySec: number }[]; spikesOk: boolean } | null,
	type: DetectionSettings,
	effective: DetectionSettings,
	active: boolean,
	verdicts: ReadonlyMap<string, Verdict> | null = null,
): { schema: JsonFormSchema; data: JsonFormData } {
	const items: PanelItems = {};
	const data: JsonFormData = {};
	const tr = (key: string): string => I18n.translate(key);
	items.info = { type: "staticText", text: I18n.getTranslatedObject("dm_optInfo"), xs: 12 };
	items.status = {
		type: "staticInfo",
		label: I18n.getTranslatedObject("dm_optStatus"),
		data: I18n.getTranslatedObject(`dm_optStatus_${active ? store.info.status : "off"}`),
		newLine: true,
		xs: 12,
		sm: 6,
	};
	items.trailer = {
		type: "staticInfo",
		label: I18n.getTranslatedObject("dm_optTrailer"),
		data: I18n.getTranslatedObject(`dm_optTrailer_${store.info.trailer}`),
		xs: 12,
		sm: 6,
	};

	items.paramsHeader = {
		type: "header",
		text: I18n.getTranslatedObject("dm_optParameter"),
		size: 4,
		newLine: true,
		xs: 12,
	};
	items.params = {
		type: "table",
		label: I18n.getTranslatedObject("dm_optParameter"),
		disabled: true,
		noDelete: true,
		xs: 12,
		items: [
			{ type: "text", attr: "name", title: tr("dm_optParameter"), width: "40%" },
			{ type: "text", attr: "type", title: tr("dm_optBaseValue"), width: "30%" },
			{ type: "text", attr: "effective", title: tr("dm_optEffective"), width: "30%" },
		],
	};
	// final phase fields only when they are used (otherwise the table stays as before)
	const finalUsed = FINAL_KEYS.filter(k => (type[k] ?? 0) !== 0 || (effective[k] ?? 0) !== 0);
	data.params = [...BASE_KEYS, ...finalUsed].map(key => {
		const a = fieldText(type, key);
		const b = fieldText(effective, key);
		return { name: key, type: a, effective: a === b ? b : `${b} *` };
	});

	items.runsHeader = { type: "header", text: I18n.getTranslatedObject("dm_optRuns"), size: 4, newLine: true, xs: 12 };
	// every stored run is listed, also the ones the user excluded (they can be used again)
	const all = [...store.runs, ...store.spikes].sort((x, y) => x.ts - y.ts);
	const boundary = boundaryInfo(store, verdicts ?? undefined);
	if (all.length === 0) {
		items.none = { type: "staticText", text: I18n.getTranslatedObject("dm_optNone"), newLine: true, xs: 12 };
	} else {
		items.runs = {
			type: "table",
			label: I18n.getTranslatedObject("dm_optRuns"),
			disabled: true,
			noDelete: true,
			xs: 12,
			items: [
				{ type: "text", attr: "date", title: tr("dm_optRunDate"), width: "15%" },
				{ type: "text", attr: "duration", title: tr("dm_optRunDuration"), width: "8%" },
				{ type: "text", attr: "family", title: tr("dm_optRunFamily"), width: "7%" },
				{ type: "text", attr: "source", title: tr("dm_optRunSource"), width: "8%" },
				{ type: "text", attr: "label", title: tr("dm_learnColCheck"), width: "21%" },
				{ type: "text", attr: "use", title: tr("dm_learnColUse"), width: "11%" },
				{ type: "text", attr: "boundary", title: tr("dm_learnColBoundary"), width: "24%" },
				{ type: "text", attr: "gate", title: tr("dm_optRunGate"), width: "6%" },
			],
		};
		data.runs = all.map(r => {
			const res = check?.perRun.find(x => x.id === r.id);
			const spike = r.label === "spike";
			const minutes = ((r.seg.runEndIdx - r.seg.startIdx + 1) * r.step) / 60_000;
			const user = decisionOf(store, r.key)?.user;
			let gateText = "";
			if (check && user !== "exclude") {
				const ok = spike ? check.spikesOk : res?.ok === true;
				gateText = ok ? "✓" : "✗";
			}
			const verdict = verdicts?.get(r.key);
			const found = verdict && verdict.reasons.length > 0 ? checkText(verdict) : "";
			const b = boundary.get(r.key);
			const limits = (b?.limits ?? []).map(
				l =>
					`${tr(`dm_optLimit_${l.quantity}`)} ${Math.round(l.value * 10) / 10} (${tr("dm_optWithout")} ${Math.round(l.without * 10) / 10})`,
			);
			if (b?.veto) {
				limits.push(tr("dm_optVeto"));
			}
			return {
				key: r.key,
				date: formatDate(startOf(r)),
				duration: spike ? "" : `${Math.round(minutes)} min`,
				family: spike || r.family < 0 ? "" : String(r.family + 1),
				source: tr(`dm_optSource_${r.src}`),
				label: [tr(`dm_optLabel_${r.label}`), found].filter(x => x !== "").join(": "),
				use: tr(`dm_learnUse_${user ?? "auto"}`),
				boundary: limits.join(", "),
				gate: gateText,
			};
		});
	}

	if (store.changes.length > 0) {
		items.changesHeader = {
			type: "header",
			text: I18n.getTranslatedObject("dm_optChanges"),
			size: 4,
			newLine: true,
			xs: 12,
		};
		items.changes = {
			type: "table",
			label: I18n.getTranslatedObject("dm_optChanges"),
			disabled: true,
			noDelete: true,
			xs: 12,
			items: [
				{ type: "text", attr: "date", title: tr("dm_optRunDate"), width: "22%" },
				{ type: "text", attr: "kind", title: tr("dm_optChangeKind"), width: "20%" },
				{ type: "text", attr: "reason", title: tr("dm_optChangeReason"), width: "58%" },
			],
		};
		data.changes = [...store.changes].reverse().map(c => ({
			date: formatDate(c.ts),
			kind: kindText(c.kind, tr),
			reason: changeText(c),
		}));
	}

	const ops: { label: ioBroker.StringOrTranslated; value: string }[] = [
		{ label: I18n.getTranslatedObject("dm_optOpNone"), value: "" },
	];
	const splits = store.final?.splits ?? [];
	const suspended = store.final?.state === "suspended";
	if (all.length > 0) {
		ops.push({ label: I18n.getTranslatedObject("dm_optUse"), value: "use" });
	}
	if (active) {
		ops.push(
			{ label: I18n.getTranslatedObject("dm_optUndo"), value: "undo" },
			{ label: I18n.getTranslatedObject("dm_optReset"), value: "reset" },
		);
	}
	ops.push({ label: I18n.getTranslatedObject("dm_optClear"), value: "clear" });
	if (active) {
		ops.push({ label: I18n.getTranslatedObject("dm_optAdopt"), value: "adopt" });
	}
	if (suspended) {
		ops.push({ label: I18n.getTranslatedObject("dm_optFinalOn"), value: "finalOn" });
	}
	if (splits.length > 0) {
		ops.push({ label: I18n.getTranslatedObject("dm_optNewRun"), value: "newRun" });
	}
	if ((store.legacyEnvelope?.n ?? 0) > 0) {
		ops.push({ label: I18n.getTranslatedObject("dm_optDropLegacy"), value: "dropLegacy" });
	}
	items.operation = {
		type: "select",
		label: I18n.getTranslatedObject("dm_optOperation"),
		options: ops,
		newLine: true,
		xs: 12,
		sm: 6,
	};
	data.operation = "";
	if (all.length > 0 || splits.length > 0) {
		const known = new Map(all.map(r => [r.key, `${formatDate(startOf(r))} · ${tr(`dm_optLabel_${r.label}`)}`]));
		const options = [
			...all.map(r => ({ label: known.get(r.key) ?? r.key, value: r.key })),
			// split runs that are no longer stored are still named by their key
			...splits.filter(k => !known.has(k)).map(k => ({ label: k, value: k })),
		];
		items.runKey = {
			type: "select",
			label: I18n.getTranslatedObject("dm_optUseRun"),
			options,
			hidden: "data.operation !== 'use' && data.operation !== 'newRun'",
			xs: 12,
			sm: 6,
		};
		data.runKey = "";
		items.use = {
			type: "select",
			label: I18n.getTranslatedObject("dm_learnColUse"),
			options: (["auto", "include", "exclude"] as const).map(u => ({
				label: I18n.getTranslatedObject(`dm_learnUse_${u}`),
				value: u,
			})),
			hidden: "data.operation !== 'use'",
			newLine: true,
			xs: 12,
			sm: 6,
		};
		data.use = "auto";
	}
	items.clearDecisions = {
		type: "checkbox",
		label: I18n.getTranslatedObject("dm_optClearDecisions"),
		hidden: "data.operation !== 'clear'",
		newLine: true,
		xs: 12,
		sm: 6,
	};
	data.clearDecisions = false;
	return { schema: { type: "panel", items }, data };
}

/** Schema of the dialog that asks whether to learn from the history or to record a run. */
export function buildLearnSourceSchema(): JsonFormSchema {
	return {
		type: "panel",
		items: {
			info: { type: "infoBox", boxType: "info", text: I18n.getTranslatedObject("dm_learnSourceInfo"), xs: 12 },
			source: {
				type: "select",
				label: I18n.getTranslatedObject("dm_learnSource"),
				options: [
					{ label: I18n.getTranslatedObject("dm_learnSourceHistory"), value: "history" },
					{ label: I18n.getTranslatedObject("dm_learnSourceRecord"), value: "record" },
				],
				newLine: true,
				xs: 12,
				sm: 6,
			},
			instance: {
				type: "text",
				label: I18n.getTranslatedObject("dm_learnHistoryInstance"),
				disabled: true,
				xs: 12,
				sm: 3,
			},
			runs: { type: "number", label: I18n.getTranslatedObject("dm_learnRuns"), disabled: true, xs: 12, sm: 3 },
			reviewRuns: {
				type: "checkbox",
				label: I18n.getTranslatedObject("dm_learnReviewRuns"),
				help: I18n.getTranslatedObject("dm_learnReviewRunsHelp"),
				newLine: true,
				xs: 12,
				hidden: "data.source !== 'history'",
			},
		},
	};
}

/** Values of the after-run filter (taken over from the suggestion, without fields in the dialog). */
export type AfterRunValues = Pick<
	DetectionSettings,
	"trailerBurstSec" | "trailerGapSec" | "trailerAfterSec" | "trailerBlockVal" | "trailerMaxSec"
>;

/** The values of the after-run filter with the i18n key of their label and their unit, in the order of the dialog. */
const AFTER_RUN_ROWS: readonly { key: keyof AfterRunValues; label: string; unit: "power" | "s" }[] = [
	{ key: "trailerBurstSec", label: "dm_learnTrailerBurst", unit: "s" },
	{ key: "trailerGapSec", label: "dm_learnTrailerGap", unit: "s" },
	{ key: "trailerAfterSec", label: "dm_learnTrailerAfter", unit: "s" },
	{ key: "trailerBlockVal", label: "dm_learnTrailerBlock", unit: "power" },
	{ key: "trailerMaxSec", label: "dm_learnTrailerMax", unit: "s" },
];

/**
 * Values of the after-run filter the dialog takes over: those of the suggestion when it uses the filter, otherwise
 * none (filter off, 3.1.2 behaviour).
 *
 * @param s - Suggestion
 */
export function trailerValuesOf(s: LearningSuggestion): AfterRunValues {
	if ((s.trailerBurstSec ?? 0) <= 0) {
		return {};
	}
	return {
		trailerBurstSec: s.trailerBurstSec,
		trailerGapSec: s.trailerGapSec ?? 0,
		trailerAfterSec: s.trailerAfterSec ?? 0,
		trailerBlockVal: s.trailerBlockVal ?? 0,
		trailerMaxSec: s.trailerMaxSec ?? 0,
	};
}

/**
 * Data of the read-only rows of the after-run filter in "Details" (`afterRun_old_<field>`, `afterRun_new_<field>`):
 * the values of the device and the ones taken over, with their unit. Empty when neither uses the filter.
 *
 * @param before - Detection values of the device
 * @param next - Values of the after-run filter taken over
 * @param unit - Unit of the power state
 */
export function afterRunData(before: DetectionSettings, next: AfterRunValues, unit = "W"): JsonFormData {
	if ((before.trailerBurstSec ?? 0) <= 0 && (next.trailerBurstSec ?? 0) <= 0) {
		return {};
	}
	const data: JsonFormData = {};
	for (const row of AFTER_RUN_ROWS) {
		const u = row.unit === "power" ? unit : row.unit;
		data[`afterRun_old_${row.key}`] = `${(before.trailerBurstSec ?? 0) > 0 ? (before[row.key] ?? 0) : 0} ${u}`;
		data[`afterRun_new_${row.key}`] = `${next[row.key] ?? 0} ${u}`;
	}
	return data;
}

/**
 * Fields of the after-run filter that change (marked with "≠"), or undefined when neither the device nor the
 * suggestion uses the filter (no rows).
 *
 * @param before - Detection values of the device
 * @param next - Values of the after-run filter taken over
 */
export function afterRunChanged(before: DetectionSettings, next: AfterRunValues): Set<string> | undefined {
	const on = (before.trailerBurstSec ?? 0) > 0;
	if (!on && (next.trailerBurstSec ?? 0) <= 0) {
		return undefined;
	}
	return new Set(
		AFTER_RUN_ROWS.filter(r => Math.abs((on ? (before[r.key] ?? 0) : 0) - (next[r.key] ?? 0)) > 1e-9).map(
			r => r.key,
		),
	);
}

/** A detection value of the learn dialog: a row "label | before | new" (Spec B.7 step 2.2). */
interface LearnRow {
	/** Field of the value (`DetectionSettings`). */
	key: Exclude<keyof LearnedValues, "mode">;
	/** i18n key of the label. */
	label: string;
	/** Step of the number field. */
	step: number;
	/** Smallest value. */
	min: number;
	/** Unit: the unit of the state (`power`), seconds or none. */
	unit?: "power" | "s";
}

/** The rows of the detection values in the order of the dialog (the mode first, the pause protection last). */
const LEARN_ROWS: readonly LearnRow[] = [
	{ key: "startVal", label: "dm_learnStartVal", step: 0.05, min: 0, unit: "power" },
	{ key: "endVal", label: "dm_learnEndVal", step: 0.05, min: 0, unit: "power" },
	{ key: "standby", label: "dm_learnStandby", step: 0.05, min: 0, unit: "power" },
	{ key: "startCount", label: "dm_learnStartCount", step: 0.5, min: 1 },
	{ key: "endCount", label: "dm_learnEndCount", step: 1, min: 2 },
	{ key: "startDurationSec", label: "dm_learnStartDuration", step: 1, min: 0, unit: "s" },
	{ key: "endDurationSec", label: "dm_learnEndDuration", step: 1, min: 0, unit: "s" },
	{ key: "pauseHoldSec", label: "dm_learnPauseHold", step: 1, min: 0, unit: "s" },
	{ key: "pauseUntilSec", label: "dm_learnPauseUntil", step: 1, min: 0, unit: "s" },
	{ key: "pauseBelowVal", label: "dm_learnPauseBelow", step: 0.05, min: 0, unit: "power" },
];

/**
 * Values of the device before learning for the column "before" (`old_<field>`), with their unit.
 *
 * @param before - Detection values of the device
 * @param unit - Unit of the power state
 */
export function oldValuesOf(before: DetectionSettings, unit = "W"): JsonFormData {
	const data: JsonFormData = { old_mode: I18n.translate(MODE_LABELS[before.mode ?? "count"]) };
	for (const row of LEARN_ROWS) {
		const v = before[row.key] ?? 0;
		const u = row.unit === "power" ? unit : row.unit;
		data[`old_${row.key}`] = u ? `${v} ${u}` : String(v);
	}
	return data;
}

/**
 * Detection values the suggestion changes against the device (marked with "≠" in the dialog).
 *
 * @param before - Detection values of the device
 * @param data - Form data with the suggestion
 */
export function changedValues(before: DetectionSettings, data: JsonFormData): Set<string> {
	const out = new Set<string>();
	if ((data.mode ?? "count") !== (before.mode ?? "count")) {
		out.add("mode");
	}
	for (const row of LEARN_ROWS) {
		const v = parseNumber(data[row.key]) ?? 0;
		if (Math.abs(v - (before[row.key] ?? 0)) > 1e-9) {
			out.add(row.key);
		}
	}
	return out;
}

/** What the learn dialog shows besides the detection values. */
export interface LearnSchemaOptions {
	/** Show the runs, the longest pause and the cross-check of the history. */
	fromHistory?: boolean;
	/** Unit of the power state. */
	unit?: string;
	/** Show the result of the current values. */
	withCurrent?: boolean;
	/** Show the result of each mode (default: fromHistory). */
	withEval?: boolean;
	/** Show that the after-run cannot be told apart from phases inside a programme. */
	notSeparable?: boolean;
	/** Show the duration and the number of samples (default true). */
	withSamples?: boolean;
	/** Fields whose suggestion differs from the value of the device. */
	changed?: ReadonlySet<string>;
	/** Read-only rows of the after-run filter in "Details", with the fields that change; none when undefined. */
	afterRun?: ReadonlySet<string>;
}

/**
 * Schema of the dialog that shows the learned values (Spec B.7 step 2): every detection value as a row "label |
 * before | new" (a changed one marked with "≠"), the figures behind the suggestion in a collapsible "Details" panel.
 * The values of the after-run filter are taken over without fields of their own; "Details" shows them read-only as
 * "label | before | new".
 *
 * @param opts - What to show
 */
export function buildLearnSchema(opts: LearnSchemaOptions = {}): JsonFormSchema {
	const fromHistory = opts.fromHistory ?? false;
	const unit = opts.unit ?? "W";
	const withEval = opts.withEval ?? fromHistory;
	const changed = opts.changed ?? new Set<string>();
	const before = I18n.getTranslatedObject("dm_learnColOld");
	const after = I18n.getTranslatedObject("dm_learnColNew");
	const items: PanelItems = {
		info: { type: "infoBox", boxType: "info", text: I18n.getTranslatedObject("dm_learnInfo"), xs: 12 },
	};
	const row = (key: string, label: ioBroker.StringOrTranslated, field: PanelItem): void => {
		items[`lbl_${key}`] = {
			type: "staticText",
			text: changed.has(key) ? marked(label) : label,
			newLine: true,
			xs: 12,
			sm: 4,
		};
		items[`old_${key}`] = { type: "text", label: before, disabled: true, xs: 6, sm: 4 };
		items[key] = field;
	};
	row("mode", I18n.getTranslatedObject("dm_detailsMode"), {
		type: "select",
		label: after,
		options: DETECTION_MODES.map(m => ({ label: MODE_LABELS[m], value: m })),
		xs: 6,
		sm: 4,
	});
	for (const r of LEARN_ROWS) {
		if (r.key === "pauseHoldSec") {
			items.pauseInfo = {
				type: "staticText",
				text: I18n.getTranslatedObject("dm_learnPauseInfo"),
				newLine: true,
				xs: 12,
			};
		}
		const u = r.unit === "power" ? unit : r.unit;
		row(r.key, I18n.getTranslatedObject(r.label), {
			type: "number",
			label: after,
			min: r.min,
			step: r.step,
			...(u ? { unit: u } : {}),
			xs: 6,
			sm: 4,
		});
	}
	if (opts.notSeparable) {
		items.trailerNotSeparable = {
			type: "infoBox",
			boxType: "warning",
			text: I18n.getTranslatedObject("dm_learnTrailerNotSeparable"),
			newLine: true,
			xs: 12,
		};
	}
	const details: PanelItems = {
		...((opts.withSamples ?? true)
			? {
					// "duration of the recorded run" only for a recording, not for 30 days of history
					...(fromHistory
						? {}
						: {
								durationSec: {
									type: "number",
									label: I18n.getTranslatedObject("dm_learnDuration"),
									unit: "s",
									disabled: true,
									xs: 12,
									sm: 4,
								},
							}),
					samples: {
						type: "number",
						label: fromHistory
							? I18n.getTranslatedObject("dm_learnHistorySamples")
							: I18n.getTranslatedObject("dm_learnSamples"),
						disabled: true,
						xs: 12,
						sm: 4,
					},
				}
			: {}),
		...(withEval ? historyItems(fromHistory, opts.withCurrent ?? false) : {}),
		...(opts.afterRun ? afterRunItems(opts.afterRun, before, after) : {}),
	};
	if (Object.keys(details).length > 0) {
		// no colour: a coloured panel is hard to read in the dark theme of the Admin
		items.details = {
			type: "panel",
			label: I18n.getTranslatedObject("dm_learnDetails"),
			collapsable: true,
			newLine: true,
			xs: 12,
			items: details,
		};
	}
	return { type: "panel", items };
}

/**
 * Read-only rows "label | before | new" of the after-run filter (in "Details"), a changed one marked with "≠".
 *
 * @param changed - Fields that change
 * @param before - Label of the column "before"
 * @param after - Label of the column "new"
 */
function afterRunItems(
	changed: ReadonlySet<string>,
	before: ioBroker.StringOrTranslated,
	after: ioBroker.StringOrTranslated,
): PanelItems {
	const items: PanelItems = {};
	for (const r of AFTER_RUN_ROWS) {
		const label = I18n.getTranslatedObject(r.label);
		items[`afterRun_lbl_${r.key}`] = {
			type: "staticText",
			text: changed.has(r.key) ? marked(label) : label,
			newLine: true,
			xs: 12,
			sm: 4,
		};
		items[`afterRun_old_${r.key}`] = { type: "text", label: before, disabled: true, xs: 6, sm: 4 };
		items[`afterRun_new_${r.key}`] = { type: "text", label: after, disabled: true, xs: 6, sm: 4 };
	}
	return items;
}

/**
 * The figures behind the suggestion of the history analysis (in "Details"): runs, longest pause, the result of each
 * mode, the cross-check and the result of the current values.
 *
 * @param fromHistory - Show the runs, the longest pause and the cross-check of the history
 * @param withCurrent - Show the result of the current values
 */
function historyItems(fromHistory: boolean, withCurrent: boolean): PanelItems {
	const items: PanelItems = {};
	if (fromHistory) {
		// no run count here: the analysis splits the history on its own and can count other runs than the line at
		// the top of the dialog; the result of each mode below names its runs
		items.longestPauseMin = {
			type: "number",
			label: I18n.getTranslatedObject("dm_learnLongestPause"),
			disabled: true,
			newLine: true,
			xs: 12,
			sm: 4,
		};
	}
	items.evalInfo = { type: "staticText", text: I18n.getTranslatedObject("dm_learnEvalInfo"), newLine: true, xs: 12 };
	for (const m of DETECTION_MODES) {
		items[`eval_${m}`] = { type: "text", label: MODE_LABELS[m], disabled: true, xs: 12, sm: 4 };
	}
	if (fromHistory) {
		items.looText = {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnLoo"),
			disabled: true,
			newLine: true,
			xs: 12,
			sm: 4,
		};
	}
	if (withCurrent) {
		items.eval_current = {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnCurrent"),
			disabled: true,
			xs: 12,
			sm: 4,
		};
	}
	return items;
}

/** Detection values taken from the fields of the learn dialog (the after-run filter has no fields there). */
type LearnedValues = Pick<
	DetectionSettings,
	| "mode"
	| "startVal"
	| "endVal"
	| "standby"
	| "startCount"
	| "endCount"
	| "startDurationSec"
	| "endDurationSec"
	| "pauseHoldSec"
	| "pauseUntilSec"
	| "pauseBelowVal"
>;

/**
 * Validate the learn dialog.
 *
 * @param data - Form data
 * @returns The detection values or an error text
 */
export function parseLearnForm(
	data: JsonFormData,
): { values: LearnedValues; error?: never } | { values?: never; error: ioBroker.Translated } {
	const n = (key: string): number => parseNumber(data[key]) ?? Number.NaN;
	const optional = (key: string): number => (data[key] === undefined || data[key] === "" ? 0 : n(key));
	const parsed = {
		startVal: n("startVal"),
		endVal: n("endVal"),
		standby: n("standby"),
		startCount: n("startCount"),
		endCount: n("endCount"),
		startDurationSec: n("startDurationSec"),
		endDurationSec: n("endDurationSec"),
		pauseHoldSec: optional("pauseHoldSec"),
		pauseUntilSec: optional("pauseUntilSec"),
		pauseBelowVal: optional("pauseBelowVal"),
	};
	if (Object.values(parsed).some(v => !Number.isFinite(v) || v < 0) || parsed.startCount < 1 || parsed.endCount < 2) {
		return {
			error: TEXT.typeValuesInvalid,
		};
	}
	const mode = DETECTION_MODES.find(m => m === data.mode) ?? "count";
	return { values: { mode, ...parsed } };
}

export { buildRunTable, RUN_TABLE_MODE } from "./learnDialog.js";
