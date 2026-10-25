import { recipientFromRow } from "./config.js";
import type { DeviceRegistry } from "./deviceRegistry.js";
import {
	alexaDeviceChoices,
	type ChoiceEnv,
	messengerInstanceChoices,
	telegramTargetChoices,
} from "./messenger/choices.js";
import type { Notifier } from "./notifier.js";

/** Commands accepted via `sendTo`. */
export type Command =
	| "testRecipient"
	| "status"
	| "acknowledge"
	| "setDnd"
	| "list"
	| "getMessengerInstances"
	| "getAlexaDevices"
	| "getTelegramTargets";

/** Access to the ioBroker installation needed by the select commands of the admin UI. */
export type CommandEnv = ChoiceEnv;

function field(msg: unknown, key: string): unknown {
	return typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>)[key] : undefined;
}

function text(msg: unknown, key: string): string {
	const v = field(msg, key);
	return typeof v === "string" ? v : "";
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
 * @param env - Access to the installation (for the selects of the admin UI)
 */
export async function handleCommand(
	reg: DeviceRegistry,
	notifier: Notifier,
	cmd: string,
	msg: unknown,
	env?: CommandEnv,
): Promise<unknown> {
	switch (cmd as Command) {
		case "getMessengerInstances":
			return env ? messengerInstanceChoices(env, text(msg, "current")) : [];
		case "getAlexaDevices":
			return env ? alexaDeviceChoices(env, text(msg, "instance")) : [];
		case "getTelegramTargets":
			return env ? telegramTargetChoices(env, text(msg, "instance"), text(msg, "target")) : [];
		case "list":
			return reg.ids().map(id => ({ id, name: reg.get(id)?.config.name ?? id }));
		case "testRecipient": {
			const row = field(msg, "recipient");
			if (row && typeof row === "object") {
				// test button of the settings: the row may not be saved yet
				const { recipient, warnings } = recipientFromRow(row);
				return recipient ? notifier.sendTest(recipient) : { ok: false, error: warnings.join(", ") };
			}
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
