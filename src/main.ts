import * as utils from "@iobroker/adapter-core";
import { fileURLToPath } from "node:url";
import { type CommandEnv, handleCommand } from "./lib/commands.js";
import type { DeviceConfig, IdPatch, InstanceConfig } from "./lib/config.js";
import { normalizeDeviceConfig, normalizeInstanceConfig } from "./lib/config.js";
import type { DeviceReminderLike } from "./lib/deviceManagement.js";
import { ReminderDeviceManagement } from "./lib/deviceManagement.js";
import { DeviceRegistry } from "./lib/deviceRegistry.js";
import type { ObjectWriter } from "./lib/deviceObjects.js";
import { DeviceSync } from "./lib/deviceSync.js";
import { ensureDeviceObjects } from "./lib/deviceObjects.js";
import type { NotifierHost } from "./lib/host.js";
import type { LegacyStateIo } from "./lib/migration.js";
import { isLegacyConfig, migrateLegacyConfig, migrateLegacyStates } from "./lib/migration.js";
import { Notifier } from "./lib/notifier.js";
import { errorMessage } from "./lib/utils.js";

/** Own states (relative to the namespace) that are handled by the registry. */
const OWN_SUBSCRIPTIONS = ["*.config.*", "*.acknowledge", "*.learning.*"];

class DeviceReminder extends utils.Adapter {
	private instanceConfig: InstanceConfig = normalizeInstanceConfig({}).config;
	private notifier: Notifier | null = null;
	private registry: DeviceRegistry | null = null;
	private sync: DeviceSync | null = null;
	private pollTimer: ioBroker.Interval | undefined = undefined;
	private subscribed = new Set<string>();
	private objectQueue: Promise<void> = Promise.resolve();
	private unloading = false;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({ ...options, name: "device-reminder" });
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		try {
			// texts of the device manager forms (admin/i18n)
			await utils.I18n.init(fileURLToPath(new URL("../admin", import.meta.url)), this);
			await this.initMigration();

			const { config, warnings, generatedIds, idPatch } = normalizeInstanceConfig(
				this.config as unknown as Record<string, unknown>,
			);
			for (const w of warnings) {
				this.log.warn(w);
			}
			this.instanceConfig = config;
			if (generatedIds) {
				await this.persistGeneratedIds(idPatch);
			}

			const host = this.createHost();
			this.notifier = new Notifier(host, () => this.instanceConfig.recipients);
			const registry = new DeviceRegistry(host, this.notifier, () => this.instanceConfig);
			this.registry = registry;
			const sync = new DeviceSync(registry, this.objectWriter(), () => this.instanceConfig, this.log);
			this.sync = sync;

			for (const [deviceId, obj] of await this.loadDeviceObjects()) {
				const cfg = this.deviceConfigOf(deviceId, obj);
				if (!cfg) {
					continue;
				}
				await sync.apply(deviceId, cfg);
			}

			for (const pattern of OWN_SUBSCRIPTIONS) {
				await this.subscribeStatesAsync(pattern);
			}
			await this.syncForeignSubscriptions();
			await this.subscribeObjectsAsync("*");

			await this.initDeviceManagement();

			this.pollTimer = this.setInterval(() => {
				registry.tickAll().catch(err => this.log.error(`Poll failed: ${errorMessage(err)}`));
			}, this.instanceConfig.pollIntervalSec * 1000);

			await this.setState("info.connection", true, true);
			this.log.info(`device-reminder started with ${registry.ids().length} device(s)`);
		} catch (err) {
			this.log.error(`Start failed: ${errorMessage(err)}`);
		}
	}

	/**
	 * Migrate a 3.1.2 configuration (Task 14): convert it, move the old states to the new device objects
	 * and replace the instance native (the adapter restarts). The old configuration is not kept.
	 * On errors the native stays unchanged and the adapter keeps running.
	 */
	private async initMigration(): Promise<void> {
		const native = this.config as unknown as Record<string, unknown>;
		// On an upgrade js-controller adds the new default keys of io-package.json (configVersion, types, ...)
		// to the old native, so these keys must not prevent the detection of a 3.1.2 configuration.
		const v4Keys = new Set([
			"configVersion",
			"types",
			"recipients",
			"statusTexts",
			"pollIntervalSec",
			"historyHtml",
		]);
		const legacy = Object.fromEntries(Object.entries(native).filter(([key]) => !v4Keys.has(key)));
		// earlier test builds kept a backup of the 3.1.2 configuration here; it is not needed
		if (await this.getObjectAsync("info.legacyConfig")) {
			await this.delObjectAsync("info.legacyConfig");
		}
		if (!isLegacyConfig(legacy)) {
			return;
		}
		try {
			this.log.info("3.1.2 configuration found, starting migration");
			const result = migrateLegacyConfig(legacy);
			const prefix = `${this.namespace}.`;
			const io: LegacyStateIo = {
				getOwnState: async id => (await this.getStateAsync(id))?.val ?? null,
				setOwnState: async (id, v) => {
					await this.setState(id, v, true);
				},
				getObjectIds: async oldName => {
					const res = await this.getObjectViewAsync("system", "state", {
						startkey: `${prefix}${oldName}.`,
						endkey: `${prefix}${oldName}.香`,
					});
					return (res?.rows ?? []).map(row => row.id.slice(prefix.length));
				},
				delObject: id => this.delObjectAsync(id),
				ensureDevice: (id, cfg) => ensureDeviceObjects(this.objectWriter(), id, cfg, result.instance),
				foreignObjectExists: async id => !!(await this.getForeignObjectAsync(id)),
			};
			const warnings = [...result.warnings, ...(await migrateLegacyStates(io, result.devices))];

			const objId = `system.adapter.${this.namespace}`;
			const obj = await this.getForeignObjectAsync(objId);
			if (!obj) {
				throw new Error(`${objId} not found`);
			}
			this.log.info(
				`Migrated ${result.devices.length} devices, ${result.instance.recipients.length} recipients from 3.1.2`,
			);
			for (const w of warnings) {
				this.log.warn(`Migration: ${w}`);
			}
			// Continue with the new configuration until js-controller restarts the instance
			this.config = { ...result.instance };
			// Replace (not merge) the native, so no 3.1.2 key is left
			obj.native = { ...result.instance };
			await this.setForeignObjectAsync(objId, obj);
		} catch (err) {
			this.log.error(`Migration from 3.1.2 failed, configuration left unchanged: ${errorMessage(err)}`);
		}
	}

	/**
	 * Store ids that were generated for new recipients or device types in the instance native, so
	 * references of devices stay valid when rows are deleted or reordered (js-controller restarts the instance).
	 *
	 * @param patch - Raw `recipients` / `types` rows with the generated ids
	 */
	private async persistGeneratedIds(patch: IdPatch): Promise<void> {
		try {
			const objId = `system.adapter.${this.namespace}`;
			const obj = await this.getForeignObjectAsync(objId);
			if (!obj) {
				throw new Error(`${objId} not found`);
			}
			const native = obj.native as Record<string, unknown>;
			if (patch.recipients) {
				native.recipients = patch.recipients;
			}
			if (patch.types) {
				native.types = patch.types;
			}
			await this.setForeignObjectAsync(objId, obj);
			this.log.info("Ids generated for new recipients or device types and saved, the adapter restarts once");
		} catch (err) {
			this.log.warn(`Generated ids could not be saved: ${errorMessage(err)}`);
		}
	}

	/** Hook for the device manager (Task 13). */
	private async initDeviceManagement(): Promise<void> {
		if (!this.registry || !this.notifier) {
			return;
		}
		// The device manager reads `instanceConfig`, `registry` and `notifier` of this adapter (all set at this point)
		// and answers the `dm:*` messages, which `onMessage` leaves alone.
		new ReminderDeviceManagement(this as unknown as DeviceReminderLike);
		this.log.debug("Device manager ready");
		// Admin lists an instance in the device manager only if its instance object announces it
		const own = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
		const supported = (own?.common as { supportedMessages?: { deviceManager?: boolean } } | undefined)
			?.supportedMessages?.deviceManager;
		if (supported !== true) {
			this.log.warn(
				`The instance object does not announce the device manager (common.supportedMessages.deviceManager), so admin does not show the devices. Run "iobroker upload device-reminder" and restart the instance.`,
			);
		}
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		const registry = this.registry;
		if (!state || !registry || this.unloading) {
			return;
		}
		const prefix = `${this.namespace}.`;
		const work = id.startsWith(prefix)
			? registry.routeOwnState(id.slice(prefix.length), state.val, state.ack)
			: registry.routeForeignState(id, state.val);
		work.catch(err => this.log.error(`State change of ${id} failed: ${errorMessage(err)}`));
	}

	private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
		const prefix = `${this.namespace}.`;
		if (!this.registry || this.unloading || !id.startsWith(prefix)) {
			return;
		}
		const deviceId = id.slice(prefix.length);
		if (deviceId === "" || deviceId.includes(".")) {
			return;
		}
		if (obj && obj.type !== "device") {
			return;
		}
		this.objectQueue = this.objectQueue
			.then(() => this.applyDeviceObject(deviceId, obj ?? null))
			.catch(err => this.log.error(`Change of device ${deviceId} failed: ${errorMessage(err)}`));
	}

	private onMessage(obj: ioBroker.Message): void {
		if (typeof obj?.command !== "string" || obj.command.startsWith("dm:")) {
			return;
		}
		const registry = this.registry;
		const notifier = this.notifier;
		const reply = (result: unknown): void => {
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, result as ioBroker.MessagePayload, obj.callback);
			}
		};
		if (!registry || !notifier) {
			reply({ error: "notReady" });
			return;
		}
		handleCommand(registry, notifier, obj.command, obj.message, this.choiceEnv())
			.then(reply)
			.catch(err => reply({ error: errorMessage(err) }));
	}

	/** Installation access for the selects of the admin UI (instances, Echo devices, telegram users). */
	private choiceEnv(): CommandEnv {
		return {
			instances: async () => {
				const res = await this.getObjectViewAsync("system", "instance", {
					startkey: "system.adapter.",
					endkey: "system.adapter.香",
				});
				return (res?.rows ?? []).map(row => row.id.slice("system.adapter.".length));
			},
			stateIds: async prefix => {
				const res = await this.getObjectViewAsync("system", "state", {
					startkey: prefix,
					endkey: `${prefix}香`,
				});
				return (res?.rows ?? []).map(row => row.id);
			},
			objectName: async id => {
				const name = (await this.getForeignObjectAsync(id))?.common?.name;
				if (typeof name === "string") {
					return name;
				}
				return name ? (name[this.language ?? "en"] ?? name.en) : undefined;
			},
			objectNative: async id =>
				(await this.getForeignObjectAsync(id))?.native as Record<string, unknown> | undefined,
			stateValue: async id => (await this.getForeignStateAsync(id))?.val,
		};
	}

	private onUnload(callback: () => void): void {
		this.unloading = true;
		try {
			if (this.pollTimer !== undefined) {
				this.clearInterval(this.pollTimer);
				this.pollTimer = undefined;
			}
			this.registry?.disposeAll();
			this.notifier?.dispose();
			this.setState("info.connection", false, true).catch(err =>
				this.log.debug(`Shutdown state update skipped: ${errorMessage(err)}`),
			);
		} catch (err) {
			this.log.debug(`Shutdown failed: ${errorMessage(err)}`);
		} finally {
			callback();
		}
	}

	/**
	 * Apply an added, changed or deleted device object.
	 *
	 * @param deviceId - Device id below the namespace
	 * @param obj - Device object, or null if it was deleted
	 */
	private async applyDeviceObject(deviceId: string, obj: ioBroker.Object | null): Promise<void> {
		if (!this.registry || !this.sync || this.unloading) {
			return;
		}
		const cfg = obj ? this.deviceConfigOf(deviceId, obj) : null;
		await this.sync.apply(deviceId, cfg);
		await this.syncForeignSubscriptions();
	}

	/**
	 * Normalize the configuration stored in a device object and log its warnings.
	 *
	 * @param deviceId - Device id
	 * @param obj - Device object
	 */
	private deviceConfigOf(deviceId: string, obj: ioBroker.Object): DeviceConfig | null {
		const { config, warnings } = normalizeDeviceConfig(obj.native ?? {});
		for (const w of warnings) {
			this.log.warn(`${deviceId}: ${w}`);
		}
		return config;
	}

	/** All device objects directly below the namespace. */
	private async loadDeviceObjects(): Promise<[string, ioBroker.Object][]> {
		const prefix = `${this.namespace}.`;
		const res = await this.getObjectViewAsync("system", "device", {
			startkey: prefix,
			endkey: `${prefix}香`,
		});
		const result: [string, ioBroker.Object][] = [];
		for (const row of res?.rows ?? []) {
			const deviceId = row.id.slice(prefix.length);
			if (row.value && deviceId !== "" && !deviceId.includes(".")) {
				result.push([deviceId, row.value]);
			}
		}
		return result;
	}

	/** Subscribe new and unsubscribe no longer used foreign states. */
	private async syncForeignSubscriptions(): Promise<void> {
		if (!this.registry) {
			return;
		}
		const wanted = new Set(this.registry.foreignIdsToSubscribe());
		for (const id of this.subscribed) {
			if (!wanted.has(id)) {
				await this.unsubscribeForeignStatesAsync(id);
				this.subscribed.delete(id);
			}
		}
		for (const id of wanted) {
			if (!this.subscribed.has(id)) {
				await this.subscribeForeignStatesAsync(id);
				this.subscribed.add(id);
			}
		}
	}

	private objectWriter(): ObjectWriter {
		return {
			extendObject: (id, obj) => this.extendObjectAsync(id, obj),
			setObjectNotExists: (id, obj) => this.setObjectNotExistsAsync(id, obj),
			delObject: async id => {
				try {
					if (await this.getObjectAsync(id)) {
						await this.delObjectAsync(id);
					}
				} catch (err) {
					this.log.debug(`Cannot delete ${id}: ${errorMessage(err)}`);
				}
			},
		};
	}

	/** Map the narrow host interfaces of the library onto the adapter. */
	private createHost(): NotifierHost {
		return {
			setOwnState: async (id, val) => {
				if (this.unloading) {
					return;
				}
				await this.setState(id, val, true);
			},
			getOwnState: async id => (await this.getStateAsync(id))?.val ?? null,
			getForeignValue: async id => (await this.getForeignStateAsync(id))?.val ?? null,
			setForeignValue: async (id, val) => {
				if (this.unloading) {
					return;
				}
				await this.setForeignStateAsync(id, val, false);
			},
			getForeignObjectCommonType: async id => {
				const obj = await this.getForeignObjectAsync(id);
				if (!obj) {
					return null;
				}
				return (obj.common as Partial<ioBroker.StateCommon>).type ?? "mixed";
			},
			setTimeout: (cb, ms) => this.setTimeout(cb, ms),
			clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout),
			now: () => Date.now(),
			log: this.log,
			sendTo: (instance, command, message) => {
				if (this.unloading) {
					return;
				}
				this.sendTo(instance, command, message as ioBroker.MessagePayload);
			},
		};
	}
}

/**
 * Create a new device-reminder adapter instance (compact mode entry point).
 *
 * @param options - Adapter options passed to the ioBroker adapter core
 */
export default function startAdapter(options: Partial<utils.AdapterOptions> = {}): DeviceReminder {
	return new DeviceReminder(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	new DeviceReminder();
}
