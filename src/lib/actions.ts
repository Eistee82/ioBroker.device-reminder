import type { ActionEvent, DeviceAction } from "./config.js";
import type { DeviceHost } from "./host.js";
import { coerceToType, errorMessage } from "./utils.js";

/**
 * Run all configured actions of a device that match the event.
 *
 * @param host - Adapter host
 * @param actions - Configured actions of the device
 * @param event - Event that occurred
 * @param phaseId - Phase of a phase event: actions with another `phaseId` do not run (an empty one matches every phase)
 */
export async function runActions(
	host: DeviceHost,
	actions: DeviceAction[],
	event: ActionEvent,
	phaseId?: string,
): Promise<void> {
	for (const action of actions) {
		if (action.event !== event || !action.stateId) {
			continue;
		}
		if (phaseId !== undefined && action.phaseId && action.phaseId !== phaseId) {
			continue;
		}
		try {
			const type = await host.getForeignObjectCommonType(action.stateId);
			if (type === null) {
				host.log.warn(`Action state ${action.stateId} does not exist, skipped`);
				continue;
			}
			await host.setForeignValue(action.stateId, coerceToType(action.value, type));
		} catch (err) {
			host.log.warn(`Action on ${action.stateId} failed: ${errorMessage(err)}`);
		}
	}
}
