import * as utils from "@iobroker/adapter-core";
import { fileURLToPath } from "node:url";
import { handleCommand } from "./lib/commands.js";
import type { DeviceConfig, InstanceConfig } from "./lib/config.js";
import { normalizeDeviceConfig, normalizeInstanceConfig } from "./lib/config.js";
import { DeviceRegistry } from "./lib/deviceRegistry.js";
import type { ObjectWriter } from "./lib/deviceObjects.js";
import { ensureDeviceObjects } from "./lib/deviceObjects.js";
import type { NotifierHost } from "./lib/host.js";
import { Notifier } from "./lib/notifier.js";
import { errorMessage } from "./lib/utils.js";

/** Own states (relative to the namespace) that are handled by the registry. */
const OWN_SUBSCRIPTIONS = ["*.config.*", "*.acknowledge", "*.learning.*"];

class DeviceReminder extends utils.Adapter {
	private instanceConfig: InstanceConfig = normalizeInstanceConfig({}).config;
	private notifier: Notifier | null = null;
	private registry: DeviceRegistry | null = null;
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
			await this.initMigration();

			const { config, warnings } = normalizeInstanceConfig(this.config as unknown as Record<string, unknown>);
			for (const w of warnings) {
				this.log.warn(w);
			}
			this.instanceConfig = config;

			const host = this.createHost();
			this.notifier = new Notifier(host, () => this.instanceConfig.recipients);
			const registry = new DeviceRegistry(host, this.notifier, () => this.instanceConfig);
			this.registry = registry;

			for (const [deviceId, obj] of await this.loadDeviceObjects()) {
				const cfg = this.deviceConfigOf(deviceId, obj);
				if (!cfg) {
					continue;
				}
				await ensureDeviceObjects(this.objectWriter(), deviceId, cfg, this.instanceConfig);
				await registry.upsert(deviceId, cfg);
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

	/** Hook for the migration of a 3.1.2 configuration (Task 14). */
	private async initMigration(): Promise<void> {
		// Filled in by the migration task.
	}

	/** Hook for the device manager (Task 13). */
	private async initDeviceManagement(): Promise<void> {
		// Filled in by the device manager task.
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
		handleCommand(registry, notifier, obj.command, obj.message)
			.then(reply)
			.catch(err => reply({ error: errorMessage(err) }));
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
		const registry = this.registry;
		if (!registry || this.unloading) {
			return;
		}
		const cfg = obj ? this.deviceConfigOf(deviceId, obj) : null;
		const current = registry.get(deviceId);
		if (!cfg) {
			if (current) {
				registry.remove(deviceId);
				this.log.info(`Device ${deviceId} removed`);
			}
		} else if (!current) {
			await ensureDeviceObjects(this.objectWriter(), deviceId, cfg, this.instanceConfig);
			await registry.upsert(deviceId, cfg);
			this.log.info(`Device ${cfg.name} added`);
		} else if (JSON.stringify(current.config) !== JSON.stringify(cfg)) {
			await registry.upsert(deviceId, cfg);
			this.log.debug(`Configuration of device ${cfg.name} updated`);
		}
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
