import { ChannelDetector, Types } from "@iobroker/type-detector";

/** Result of the power/switch detection for one source object. */
export interface DetectionResult {
	/** Detected device kind, `null` when nothing usable was found. */
	type: "socket" | "electricity" | null;
	/** ID of the power state (`value.power`), `null` if none. */
	powerId: string | null;
	/** ID of the switch state (`SET`), `null` if none. */
	switchId: string | null;
	/** Set only when the result is incomplete and the UI/log should explain why. */
	hint?: "noPattern" | "notFound";
}

const POWER_ROLE = /^value\.power$/;

function isPowerState(obj: ioBroker.Object | undefined): boolean {
	return obj?.type === "state" && POWER_ROLE.test(obj.common.role ?? "");
}

/**
 * Fallback without a type-detector pattern: a single `value.power` state under `id`, or `id` itself.
 *
 * @param objects - All objects that may belong to the device, keyed by ID
 * @param id - Root ID of the device, channel or state
 */
function findPowerFallback(objects: Record<string, ioBroker.Object>, id: string): DetectionResult | null {
	if (isPowerState(objects[id])) {
		return { type: "electricity", powerId: id, switchId: null };
	}
	const candidates = Object.keys(objects).filter(key => key.startsWith(`${id}.`) && isPowerState(objects[key]));
	if (candidates.length === 1) {
		return { type: "electricity", powerId: candidates[0], switchId: null, hint: "noPattern" };
	}
	return null;
}

/**
 * Find the power and switch states of a device below `id` with the type-detector package.
 *
 * @param objects - All objects that may belong to the device, keyed by ID
 * @param id - Root ID of the device, channel or state
 */
export function detectPowerAndSwitch(objects: Record<string, ioBroker.Object>, id: string): DetectionResult {
	const patterns =
		new ChannelDetector().detect({ objects, id, allowedTypes: [Types.socket, Types.electricity] }) ?? [];

	let switchId: string | null = null;
	let powerId: string | null = null;
	for (const pattern of patterns) {
		for (const state of pattern.states) {
			if (state.name === "SET" && switchId === null) {
				switchId = state.id;
			}
			if (state.name === "ELECTRIC_POWER" && powerId === null) {
				powerId = state.id;
			}
		}
	}

	if (switchId !== null) {
		return { type: "socket", powerId, switchId };
	}
	if (powerId !== null) {
		return { type: "electricity", powerId, switchId: null };
	}
	return findPowerFallback(objects, id) ?? { type: null, powerId: null, switchId: null, hint: "notFound" };
}

/**
 * Same as `detectPowerAndSwitch`, but the objects are loaded from the host first.
 *
 * @param getObjectsUnder - Loads all objects below an ID (including the ID itself)
 * @param id - Root ID of the device, channel or state
 */
export async function detectFromHost(
	getObjectsUnder: (id: string) => Promise<Record<string, ioBroker.Object>>,
	id: string,
): Promise<DetectionResult> {
	const objects = await getObjectsUnder(id);
	return detectPowerAndSwitch(objects, id);
}
