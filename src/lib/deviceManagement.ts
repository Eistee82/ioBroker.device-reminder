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
import type { DeviceRegistry } from "./deviceRegistry.js";
import { allocateDeviceId } from "./ids.js";
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

function tr(en: string, de: string): ioBroker.Translated {
	return { en, de };
}

const TEXT = {
	addDevice: tr("Add device", "Gerät hinzufügen"),
	addTitle: tr("Add device", "Gerät hinzufügen"),
	editTitle: tr("Edit device", "Gerät bearbeiten"),
	sourceMissing: tr(
		"Select a source object or choose manual entry.",
		"Wähle ein Quell-Objekt oder aktiviere die manuelle Eingabe.",
	),
	edit: tr("Edit", "Bearbeiten"),
	delete: tr("Delete", "Löschen"),
	deleteConfirm: tr(
		"Delete this device with all its states? This cannot be undone.",
		"Dieses Gerät mit allen States löschen? Das kann nicht rückgängig gemacht werden.",
	),
	toggleEnabled: tr("Enable or disable", "Aktivieren oder deaktivieren"),
	dndOn: tr("Do not disturb: switch on", "Nicht stören: einschalten"),
	dndOff: tr("Do not disturb: switch off", "Nicht stören: ausschalten"),
	acknowledge: tr("Acknowledge", "Quittieren"),
	learnStart: tr("Start learning", "Anlernen starten"),
	learnStop: tr("Stop learning", "Anlernen beenden"),
	test: tr("Send test message", "Testnachricht senden"),
	testSent: tr("The test message was sent.", "Die Testnachricht wurde gesendet."),
	testNobody: tr(
		"The test message reached nobody. Check the recipients of the device.",
		"Die Testnachricht hat niemanden erreicht. Prüfe die Empfänger des Geräts.",
	),
	learnStarted: tr(
		"Recording started. Run the device once completely, then choose Stop learning.",
		"Aufzeichnung gestartet. Lass das Gerät einmal komplett laufen und wähle danach Anlernen beenden.",
	),
	learnTitle: tr("Learned device type", "Angelernter Gerätetyp"),
	learnConfirm: tr(
		"Saving creates a new device type and restarts the adapter instance. Continue?",
		"Das Speichern legt einen neuen Gerätetyp an und startet die Adapter-Instanz neu. Fortfahren?",
	),
	learnSaved: tr(
		"The device type was saved. Select it for your device after the restart.",
		"Der Gerätetyp wurde gespeichert. Wähle ihn nach dem Neustart für dein Gerät aus.",
	),
	learnTooFewSamples: tr(
		"The recording is too short to derive a device type.",
		"Die Aufzeichnung ist zu kurz, um einen Gerätetyp abzuleiten.",
	),
	learnNoRun: tr("No run was detected in the recording.", "In der Aufzeichnung wurde kein Lauf erkannt."),
	running: tr("Running", "Läuft"),
	finished: tr("Finished, not acknowledged", "Fertig, nicht quittiert"),
	status: tr("Status", "Status"),
	consumption: tr("Power", "Leistung"),
	runtime: tr("Runtime", "Laufzeit"),
	identifier: tr("Power state", "Leistungs-State"),
	powerMissing: (id: string): ioBroker.Translated =>
		tr(`Power state ${id} not found`, `Leistungs-State ${id} nicht gefunden`),
	unknownType: (id: string): ioBroker.Translated =>
		tr(`Unknown device type "${id}"`, `Unbekannter Gerätetyp "${id}"`),
	notFound: tr("Device not found.", "Gerät nicht gefunden."),
	on: tr("On", "Ein"),
	off: tr("Off", "Aus"),
	yes: tr("Yes", "Ja"),
	no: tr("No", "Nein"),
};

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

	private async updateOf(id: Id): Promise<DeviceRefresh> {
		return { update: await this.buildDeviceInfo(id) };
	}

	/**
	 * Show the device form until it is valid or cancelled.
	 *
	 * @param ctx - Action context
	 * @param title - Dialog title
	 * @param data - Initial form data
	 * @param detection - Result of the type detection (for the hint)
	 */
	private async askDevice(
		ctx: ActionContext,
		title: ioBroker.StringOrTranslated,
		data: DeviceFormData,
		detection?: DetectionResult,
	): Promise<DeviceConfig | null> {
		let current: JsonFormData = { ...data };
		for (;;) {
			const result = await ctx.showForm(buildDeviceSchema(this.adapter.instanceConfig, detection), {
				data: current,
				title,
			});
			if (!result) {
				return null;
			}
			const { config, errors } = formToDeviceConfig(toFormData(result));
			if (config) {
				return config;
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
		};
		const config = await this.askDevice(ctx, TEXT.addTitle, prefill, detection);
		if (!config) {
			return { refresh: false };
		}

		const taken = new Set<string>([...RESERVED_IDS, ...(await this.deviceObjects()).keys()]);
		const id = allocateDeviceId(config.name, taken);
		await ensureDeviceObjects(this.objectWriter(), id, config, inst);
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
		const edited = await this.askDevice(ctx, TEXT.editTitle, deviceConfigToForm(cfg));
		if (edited) {
			await this.writeDevice(id, edited);
		}
		return this.updateOf(id);
	}

	private async deleteDevice(id: Id, ctx: ActionContext): Promise<DeviceRefresh> {
		if (!(await ctx.showConfirmation(TEXT.deleteConfirm))) {
			return { refresh: "none" };
		}
		this.adapter.registry.remove(id);
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
			await registry.startLearning(id);
			await ctx.showMessage(TEXT.learnStarted);
			return this.updateOf(id);
		}

		const result = await registry.stopLearning(id);
		if ("error" in result) {
			await ctx.showMessage(LEARN_ERRORS[result.error] ?? tr(result.error, result.error));
			return this.updateOf(id);
		}
		await this.saveLearnedType(id, result, ctx);
		return this.updateOf(id);
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
		};
		let type: DeviceTypeConfig | null = null;
		const inst = this.adapter.instanceConfig;
		while (!type) {
			const result = await ctx.showForm(buildLearnSchema(), { data, title: TEXT.learnTitle });
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
			type = { ...parsed.type, id: typeId, builtin: false, mode: "count" };
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

/** Schema of the dialog that shows the learned thresholds. */
export function buildLearnSchema(): JsonFormSchema {
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
			samples: { type: "number", label: "dm_learnSamples", disabled: true, xs: 12, sm: 4 },
		},
	};
}

type LearnedType = Pick<
	DeviceTypeConfig,
	"name" | "startVal" | "endVal" | "standby" | "startCount" | "endCount" | "startDurationSec" | "endDurationSec"
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
		return { error: tr("The device type needs a name.", "Der Gerätetyp braucht einen Namen.") };
	}
	if (Object.values(parsed).some(v => !Number.isFinite(v) || v < 0) || parsed.startCount < 1 || parsed.endCount < 2) {
		return {
			error: tr(
				"All values must be numbers of 0 or more; start count at least 1, end count at least 2.",
				"Alle Werte müssen Zahlen ab 0 sein; Start-Anzahl mindestens 1, End-Anzahl mindestens 2.",
			),
		};
	}
	return { type: { name, ...parsed } };
}
