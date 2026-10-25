import type { DeviceConfig, InstanceConfig } from "./config.js";
import { buildStateCommon, DEVICE_CHANNELS, DEVICE_STATES } from "./stateDefinitions.js";

/** Minimal object API needed to create device objects (implemented by the adapter). */
export interface ObjectWriter {
	/** Create or update an object. */
	extendObject(id: string, obj: Partial<ioBroker.Object>): Promise<unknown>;
	/** Create an object if it does not exist. */
	setObjectNotExists(id: string, obj: ioBroker.Object): Promise<unknown>;
	/** Delete an object. */
	delObject(id: string): Promise<unknown>;
}

/**
 * Create or update the device object with its channels and states.
 * `lastOperationsHtml` exists only if enabled in the instance settings, otherwise it is removed.
 *
 * @param w - Object writer
 * @param deviceId - Stable device ID (already sanitized)
 * @param cfg - Device configuration, stored in `native`
 * @param inst - Instance configuration
 */
export async function ensureDeviceObjects(
	w: ObjectWriter,
	deviceId: string,
	cfg: DeviceConfig,
	inst: InstanceConfig,
): Promise<void> {
	await w.extendObject(deviceId, {
		type: "device",
		common: { name: cfg.name },
		native: { ...cfg },
	});
	for (const channel of DEVICE_CHANNELS) {
		await w.extendObject(`${deviceId}.${channel.id}`, {
			type: "channel",
			common: { name: channel.name },
			native: {},
		});
	}
	for (const def of DEVICE_STATES) {
		const id = `${deviceId}.${def.id}`;
		if (def.when === "historyHtml" && !inst.historyHtml) {
			await w.delObject(id);
			continue;
		}
		await w.extendObject(id, { type: "state", common: buildStateCommon(def), native: {} });
	}
}
