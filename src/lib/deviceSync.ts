import type { DeviceConfig, InstanceConfig } from "./config.js";
import type { ObjectWriter } from "./deviceObjects.js";
import { ensureDeviceObjects } from "./deviceObjects.js";
import type { DeviceRegistry } from "./deviceRegistry.js";

/** Minimal logger used by the sync. */
interface SyncLog {
	/** Info message. */
	info(msg: string): void;
	/** Debug message. */
	debug(msg: string): void;
}

/**
 * Applies added, changed and deleted device objects to the registry.
 * Remembers the last applied configuration per device independent of the result, so a device that
 * cannot be registered (e.g. unknown type) does not retrigger itself through the object it writes.
 */
export class DeviceSync {
	private readonly applied = new Map<string, string>();

	/**
	 * Create the sync.
	 *
	 * @param registry - Device registry
	 * @param writer - Object writer
	 * @param getConfig - Returns the current instance configuration
	 * @param log - Logger
	 */
	public constructor(
		private readonly registry: DeviceRegistry,
		private readonly writer: ObjectWriter,
		private readonly getConfig: () => InstanceConfig,
		private readonly log: SyncLog,
	) {}

	/**
	 * Apply the configuration of a device (null: deleted or unusable).
	 *
	 * @param deviceId - Device id below the namespace
	 * @param cfg - Normalized device configuration, or null
	 * @param deleted - The device object was deleted (its learning data is deleted too)
	 */
	public async apply(deviceId: string, cfg: DeviceConfig | null, deleted = false): Promise<void> {
		if (!cfg) {
			this.applied.delete(deviceId);
			if (deleted) {
				await this.registry.deleteLearningData(deviceId);
			}
			if (this.registry.get(deviceId)) {
				this.registry.remove(deviceId);
				this.log.info(`Device ${deviceId} removed`);
			}
			return;
		}
		const key = JSON.stringify(cfg);
		if (this.applied.get(deviceId) === key) {
			return;
		}
		this.applied.set(deviceId, key);
		const current = this.registry.get(deviceId);
		if (!current) {
			await ensureDeviceObjects(this.writer, deviceId, cfg, this.getConfig());
			await this.registry.upsert(deviceId, cfg);
			if (this.registry.get(deviceId)) {
				this.log.info(`Device ${cfg.name} added`);
			}
		} else if (JSON.stringify(current.config) !== key) {
			await this.registry.upsert(deviceId, cfg);
			this.log.debug(`Configuration of device ${cfg.name} updated`);
		}
	}
}
