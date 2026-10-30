import type { AdapterInstance } from "@iobroker/adapter-core";
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
import type { DeviceConfig, DeviceTypeConfig, InstanceConfig } from "./config.js";
import { DEFAULT_REMINDER, findType, normalizeDeviceConfig } from "./config.js";
import type { DeviceFormData } from "./deviceForm.js";
import { buildDeviceSchema, buildSourceSchema, deviceConfigToForm, formToDeviceConfig } from "./deviceForm.js";
import type { ObjectWriter } from "./deviceObjects.js";
import { ensureDeviceObjects } from "./deviceObjects.js";
import { type EnumMembers, type EnumOption, enumLabel, membershipOf, planEnumUpdate } from "./enums.js";
import type { DeviceRegistry } from "./deviceRegistry.js";
import { plain, TEXT } from "./dmTexts.js";
import { allocateDeviceId } from "./ids.js";
import type { DetectionMode } from "./detector/types.js";
import { analyzeHistory } from "./historyLearning.js";
import type { ModeEvaluation } from "./historyLearning.js";
import { findHistoryInstance, loadHistory } from "./historySource.js";
import type { HistoryEnv } from "./historySource.js";
import type { LearningSuggestion } from "./learning.js";
import type { Notifier } from "./notifier.js";
import { detectFromHost } from "./typeDetection.js";
import type { DetectionResult } from "./typeDetection.js";
import { errorMessage, parseNumber } from "./utils.js";

/** The adapter parts the device manager needs. */
export interface DeviceReminderLike extends AdapterInstance {
	/** Current instance configuration. */
	readonly instanceConfig: InstanceConfig;
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
		const inst = this.adapter.instanceConfig;
		const type = findType(inst, cfg.typeId);
		const items: PanelItems = {};
		const data: JsonFormData = {};

		items.opsHeader = { type: "header", text: "dm_detailsOperations", size: 4, newLine: true, xs: 12 };
		items.lastOperations = {
			type: "table",
			label: "dm_detailsOperations",
			disabled: true,
			noDelete: true,
			xs: 12,
			items: [
				{ type: "text", attr: "start", title: "dm_detailsStart", width: "35%" },
				{ type: "text", attr: "end", title: "dm_detailsEnd", width: "35%" },
				{ type: "text", attr: "runtime", title: "dm_detailsRuntime", width: "30%" },
			],
		};
		data.lastOperations = await this.readOperations(id);

		items.typeHeader = { type: "header", text: "dm_detailsType", size: 4, newLine: true, xs: 12 };
		if (type) {
			const rows: [string, string | number, string?][] = [
				["dm_detailsTypeName", type.name],
				["dm_detailsStartVal", type.startVal, "W"],
				["dm_detailsEndVal", type.endVal, "W"],
				["dm_detailsStandby", type.standby, "W"],
				["dm_detailsStartCount", type.startCount],
				["dm_detailsEndCount", type.endCount],
				["dm_detailsMode", type.mode],
			];
			if (type.mode !== "count") {
				rows.push(
					["dm_detailsStartDuration", type.startDurationSec, "s"],
					["dm_detailsEndDuration", type.endDurationSec, "s"],
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
		} else {
			items.typeUnknown = {
				type: "infoBox",
				boxType: "warning",
				text: "dm_detailsTypeUnknown",
				newLine: true,
				xs: 12,
			};
		}

		items.reminderHeader = { type: "header", text: "dm_detailsReminder", size: 4, newLine: true, xs: 12 };
		const finished = await this.adapter.getStateAsync(`${id}.finished`);
		items.reminderState = {
			type: "staticInfo",
			label: "dm_detailsReminderState",
			data: cfg.reminder.enabled ? TEXT.on : TEXT.off,
			newLine: true,
			xs: 12,
			sm: 6,
		};
		if (cfg.reminder.enabled) {
			items.reminderInterval = {
				type: "staticInfo",
				label: "dm_detailsReminderInterval",
				data: cfg.reminder.intervalMin,
				unit: "min",
				xs: 12,
				sm: 6,
			};
			items.reminderMax = {
				type: "staticInfo",
				label: "dm_detailsReminderMax",
				data: cfg.reminder.maxCount,
				xs: 12,
				sm: 6,
			};
		}
		items.reminderPending = {
			type: "staticInfo",
			label: "dm_detailsReminderPending",
			data: finished?.val === true ? TEXT.yes : TEXT.no,
			xs: 12,
			sm: 6,
		};

		return { id, schema: { type: "panel", i18n: true, items }, data };
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
		const direct = normalizeDeviceConfig(native).config;
		if (direct) {
			return direct;
		}
		const repaired = normalizeDeviceConfig({ ...native, powerId: "-" }).config;
		return repaired ? { ...repaired, powerId: "" } : null;
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
			await this.adapter.setObjectAsync(id, {
				...old,
				common: { ...old.common, name: cfg.name },
				native: { ...cfg },
			} as ioBroker.Object);
		}
		await ensureDeviceObjects(this.objectWriter(), id, cfg, this.adapter.instanceConfig);
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
				actions: this.deviceActions(id, false, false, false),
			};
		}

		const inst = this.adapter.instanceConfig;
		const type = findType(inst, cfg.typeId);
		const runtime = this.adapter.registry.get(id);
		const powerMissing =
			cfg.powerId === "" ||
			runtime?.powerMissing === true ||
			!(await this.adapter.getForeignObjectAsync(cfg.powerId));
		let warning: ioBroker.StringOrTranslated | boolean | { stateId: string } = sid("alertRuntime");
		if (powerMissing) {
			warning = TEXT.powerMissing(cfg.powerId);
		} else if (!type) {
			warning = TEXT.unknownType(cfg.typeId);
		}
		const learning = (await this.adapter.getStateAsync(`${id}.learning.active`))?.val === true;
		const dnd = runtime?.doNotDisturb ?? false;

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
			model: type?.name ?? cfg.typeId,
			icon: GENERIC_ICON,
			enabled: cfg.enabled,
			status: { warning },
			indicators,
			hasDetails: true,
			actions: this.deviceActions(id, cfg.enabled, dnd, learning),
		};
	}

	private deviceActions(id: Id, enabled: boolean, dnd: boolean, learning: boolean): DeviceAction<Id>[] {
		return [
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
	 */
	private async askDevice(
		ctx: ActionContext,
		title: ioBroker.StringOrTranslated,
		data: DeviceFormData,
		enums: { rooms: EnumOption[]; functions: EnumOption[] },
		detection?: DetectionResult,
	): Promise<{ config: DeviceConfig; rooms: string[]; functions: string[] } | null> {
		let current: JsonFormData = { ...data };
		for (;;) {
			const result = await ctx.showForm(buildDeviceSchema(this.adapter.instanceConfig, detection, enums), {
				data: current,
				title,
			});
			if (!result) {
				return null;
			}
			const { config, errors } = formToDeviceConfig(toFormData(result));
			if (config) {
				return { config, rooms: idList(result.rooms), functions: idList(result.functions) };
			}
			await ctx.showMessage(errors.join("\n"));
			current = result;
		}
	}

	private async addDevice(ctx: ActionContext): Promise<InstanceRefreshResponse> {
		let manual = false;
		let sourceId = "";
		for (;;) {
			const first = await ctx.showForm(buildSourceSchema(), {
				title: TEXT.addTitle,
				data: { manual, sourceId },
			});
			if (!first) {
				return { refresh: false };
			}
			manual = first.manual === true;
			sourceId = textOf(first.sourceId).trim();
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
		const prefill: DeviceFormData = {
			enabled: true,
			name,
			typeId: inst.types[0]?.id ?? "",
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
		const answer = await this.askDevice(ctx, TEXT.addTitle, prefill, enums.options, detection);
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

	private async editDevice(id: Id, ctx: ActionContext): Promise<DeviceRefresh> {
		const obj = await this.adapter.getObjectAsync(id);
		const cfg = obj ? this.configOf(obj) : null;
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
		const edited = await this.askDevice(ctx, TEXT.editTitle, form, enums.options);
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
			await registry.startLearning(id);
			await ctx.showMessage(TEXT.learnStarted);
			return this.updateOf(id);
		}

		const result = await registry.stopLearning(id);
		if ("error" in result) {
			await ctx.showMessage(LEARN_ERRORS[result.error] ?? plain(result.error));
			return this.updateOf(id);
		}
		await this.saveLearnedType(id, result, ctx);
		return this.updateOf(id);
	}

	/**
	 * Offer to learn from the stored history of the power state instead of recording a run.
	 *
	 * @param id - Device id
	 * @param ctx - Action context
	 * @returns true if the learning was handled (or cancelled), false to record a run instead
	 */
	private async learnFromHistory(id: Id, ctx: ActionContext): Promise<boolean> {
		const powerId = this.adapter.registry.get(id)?.config.powerId;
		const env = this.historyEnv();
		let instance: string | undefined;
		try {
			instance = powerId ? await findHistoryInstance(env, powerId) : undefined;
		} catch (err) {
			this.adapter.log.debug(`No history for ${powerId}: ${errorMessage(err)}`);
		}
		if (!powerId || !instance) {
			return false;
		}
		const choice = await ctx.showForm(buildLearnSourceSchema(), {
			data: { source: "history", instance },
			title: TEXT.learnTitle,
		});
		if (!choice) {
			return true;
		}
		if (choice.source !== "history") {
			return false;
		}
		const progress = await ctx.openProgress(TEXT.learnAnalysing, { indeterminate: true });
		let result: ReturnType<typeof analyzeHistory>;
		try {
			const points = await loadHistory(env, instance, powerId, Date.now());
			result = analyzeHistory(points, this.adapter.instanceConfig.pollIntervalSec);
		} catch (err) {
			this.adapter.log.warn(`Reading the history of ${powerId} from ${instance} failed: ${errorMessage(err)}`);
			result = { error: "noHistory" };
		} finally {
			await progress.close();
		}
		if ("error" in result) {
			await ctx.showMessage(TEXT.learnHistoryTooFewRuns);
			return false;
		}
		await this.adapter.setStateAsync(`${id}.learning.result`, JSON.stringify(result), true);
		await this.saveLearnedType(id, result, ctx);
		return true;
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
	 * Let the user adjust the suggestion and store it as new custom type.
	 * This changes the instance configuration and therefore restarts the instance.
	 *
	 * @param id - Device id
	 * @param suggestion - Suggested type settings
	 * @param ctx - Action context
	 */
	private async saveLearnedType(id: Id, suggestion: LearningSuggestion, ctx: ActionContext): Promise<void> {
		const deviceName = this.adapter.registry.get(id)?.config.name ?? id;
		let data: JsonFormData = {
			name: `${deviceName} (learned)`,
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
			...(suggestion.evaluation ? { runs: suggestion.runs, ...evaluationTexts(suggestion.evaluation) } : {}),
		};
		const fromHistory = suggestion.evaluation !== undefined;
		let type: DeviceTypeConfig | null = null;
		const inst = this.adapter.instanceConfig;
		while (!type) {
			const result = await ctx.showForm(buildLearnSchema(fromHistory), { data, title: TEXT.learnTitle });
			if (!result) {
				return;
			}
			const parsed = parseLearnForm(result);
			if (!parsed.type) {
				await ctx.showMessage(parsed.error);
				data = result;
				continue;
			}
			const typeId = allocateDeviceId(parsed.type.name, new Set(inst.types.map(t => t.id)));
			type = { ...parsed.type, id: typeId, builtin: false };
		}
		if (!(await ctx.showConfirmation(TEXT.learnConfirm))) {
			return;
		}
		const instanceId = `system.adapter.${this.adapter.namespace}`;
		const stored = await this.adapter.getForeignObjectAsync(instanceId);
		const rawTypes = (stored?.native as Record<string, unknown> | undefined)?.types;
		const types = Array.isArray(rawTypes) && rawTypes.length > 0 ? (rawTypes as unknown[]) : inst.types;
		await ctx.showMessage(TEXT.learnSaved);
		await this.adapter.extendForeignObjectAsync(instanceId, { native: { types: [...types, type] } });
	}
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
		const delay = e.detected > 0 ? ` · ${Math.round(e.endDelaySec / 60)} min` : "";
		const spikes = e.falseStarts > 0 ? ` · ${e.falseStarts}×!` : "";
		out[`eval_${e.mode}`] = `${e.detected}/${e.runs}${delay}${spikes}`;
	}
	return out;
}

/** Schema of the dialog that asks whether to learn from the history or to record a run. */
export function buildLearnSourceSchema(): JsonFormSchema {
	return {
		type: "panel",
		i18n: true,
		items: {
			info: { type: "infoBox", boxType: "info", text: "dm_learnSourceInfo", xs: 12 },
			source: {
				type: "select",
				label: "dm_learnSource",
				options: [
					{ label: "dm_learnSourceHistory", value: "history" },
					{ label: "dm_learnSourceRecord", value: "record" },
				],
				newLine: true,
				xs: 12,
				sm: 8,
			},
			instance: { type: "text", label: "dm_learnHistoryInstance", disabled: true, xs: 12, sm: 4 },
		},
	};
}

/**
 * Schema of the dialog that shows the learned thresholds.
 *
 * @param fromHistory - Show the detection mode and the result of each mode over the history runs
 */
export function buildLearnSchema(fromHistory = false): JsonFormSchema {
	const num = (label: string, step: number, min: number, unit?: string): PanelItem => ({
		type: "number",
		label,
		min,
		step,
		...(unit ? { unit } : {}),
		xs: 12,
		sm: 4,
	});
	return {
		type: "panel",
		i18n: true,
		items: {
			info: { type: "infoBox", boxType: "info", text: "dm_learnInfo", xs: 12 },
			name: {
				type: "text",
				label: "dm_learnName",
				validator: "data.name && String(data.name).trim() !== ''",
				validatorErrorText: "dev_required",
				newLine: true,
				xs: 12,
			},
			startVal: { ...num("dm_learnStartVal", 0.05, 0, "W"), newLine: true },
			endVal: num("dm_learnEndVal", 0.05, 0, "W"),
			standby: num("dm_learnStandby", 0.05, 0, "W"),
			startCount: { ...num("dm_learnStartCount", 0.5, 1), newLine: true },
			endCount: num("dm_learnEndCount", 1, 2),
			startDurationSec: { ...num("dm_learnStartDuration", 1, 0, "s"), newLine: true },
			endDurationSec: num("dm_learnEndDuration", 1, 0, "s"),
			durationSec: {
				type: "number",
				label: "dm_learnDuration",
				unit: "s",
				disabled: true,
				newLine: true,
				xs: 12,
				sm: 4,
			},
			samples: {
				type: "number",
				label: fromHistory ? "dm_learnHistorySamples" : "dm_learnSamples",
				disabled: true,
				xs: 12,
				sm: 4,
			},
			...(fromHistory ? historyItems() : {}),
		},
	};
}

/** Detection mode and result per mode of the learn dialog (history analysis only). */
function historyItems(): PanelItems {
	const items: PanelItems = {
		runs: { type: "number", label: "dm_learnRuns", disabled: true, xs: 12, sm: 4 },
		mode: {
			type: "select",
			label: "dm_detailsMode",
			options: DETECTION_MODES.map(m => ({ label: MODE_LABELS[m], value: m })),
			newLine: true,
			xs: 12,
			sm: 4,
		},
		evalInfo: { type: "staticText", text: "dm_learnEvalInfo", newLine: true, xs: 12 },
	};
	for (const m of DETECTION_MODES) {
		items[`eval_${m}`] = { type: "text", label: MODE_LABELS[m], disabled: true, xs: 12, sm: 4 };
	}
	return items;
}

type LearnedType = Pick<
	DeviceTypeConfig,
	| "name"
	| "mode"
	| "startVal"
	| "endVal"
	| "standby"
	| "startCount"
	| "endCount"
	| "startDurationSec"
	| "endDurationSec"
>;

/**
 * Validate the learn dialog.
 *
 * @param data - Form data
 * @returns The type settings or an error text
 */
function parseLearnForm(
	data: JsonFormData,
): { type: LearnedType; error?: never } | { type?: never; error: ioBroker.Translated } {
	const name = textOf(data.name).trim();
	const n = (key: string): number => parseNumber(data[key]) ?? Number.NaN;
	const parsed = {
		startVal: n("startVal"),
		endVal: n("endVal"),
		standby: n("standby"),
		startCount: n("startCount"),
		endCount: n("endCount"),
		startDurationSec: n("startDurationSec"),
		endDurationSec: n("endDurationSec"),
	};
	if (name === "") {
		return { error: TEXT.typeNeedsName };
	}
	if (Object.values(parsed).some(v => !Number.isFinite(v) || v < 0) || parsed.startCount < 1 || parsed.endCount < 2) {
		return {
			error: TEXT.typeValuesInvalid,
		};
	}
	const mode = DETECTION_MODES.find(m => m === data.mode) ?? "count";
	return { type: { name, mode, ...parsed } };
}
