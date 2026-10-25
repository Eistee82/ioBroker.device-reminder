import type { DeviceRegistry } from "./deviceRegistry.js";
import type { Notifier } from "./notifier.js";

/** Commands accepted via `sendTo`. */
export type Command = "testRecipient" | "status" | "acknowledge" | "setDnd" | "list";

function field(msg: unknown, key: string): unknown {
	return typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>)[key] : undefined;
}

function deviceIdOf(msg: unknown): string {
	const id = field(msg, "deviceId");
	return typeof id === "string" ? id : "";
}

function toBool(val: unknown): boolean {
	return val === true || val === 1 || val === "true" || val === "1";
}

/**
 * Handle a `sendTo` command and return the answer for the callback.
 *
 * @param reg - Device registry
 * @param notifier - Notifier (for test messages)
 * @param cmd - Command name
 * @param msg - Message payload
 */
export async function handleCommand(
	reg: DeviceRegistry,
	notifier: Notifier,
	cmd: string,
	msg: unknown,
): Promise<unknown> {
	switch (cmd as Command) {
		case "list":
			return reg.ids().map(id => ({ id, name: reg.get(id)?.config.name ?? id }));
		case "testRecipient": {
			const id = field(msg, "id");
			if (typeof id !== "string" || id === "") {
				return { ok: false, error: "missingRecipient" };
			}
			return notifier.sendTest(id);
		}
		case "status": {
			const snapshot = await reg.status(deviceIdOf(msg));
			return snapshot ?? { error: "unknownDevice" };
		}
		case "acknowledge": {
			const id = deviceIdOf(msg);
			if (!reg.get(id)) {
				return { error: "unknownDevice" };
			}
			await reg.acknowledge(id);
			return { ok: true };
		}
		case "setDnd": {
			const id = deviceIdOf(msg);
			if (!reg.get(id)) {
				return { error: "unknownDevice" };
			}
			await reg.routeOwnState(`${id}.config.doNotDisturb`, toBool(field(msg, "value")), false);
			return { ok: true };
		}
		default:
			return { error: "unknownCommand" };
	}
}
