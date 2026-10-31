import type { RecipientConfig } from "./config.js";
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
	"testRecipient" | "send" | "list" | "getMessengerInstances" | "getAlexaDevices" | "getTelegramTargets";

/** Access to the ioBroker installation needed by the select commands of the admin UI. */
export type CommandEnv = ChoiceEnv;

function field(msg: unknown, key: string): unknown {
	return typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>)[key] : undefined;
}

function text(msg: unknown, key: string): string {
	const v = field(msg, key);
	return typeof v === "string" ? v : "";
}

/**
 * Recipient ids of a message: one id, a list of ids, or `*` for all enabled recipients.
 *
 * @param msg - Message payload
 * @param all - Configured recipients
 */
function recipientIdsOf(msg: unknown, all: readonly RecipientConfig[]): string[] {
	const raw = field(msg, "recipients");
	const ids = (Array.isArray(raw) ? raw : [raw]).filter((id): id is string => typeof id === "string" && id !== "");
	return ids.includes("*") ? all.filter(r => r.enabled !== false).map(r => r.id) : ids;
}

/**
 * Handle a `sendTo` command and return the answer for the callback.
 *
 * @param reg - Device registry
 * @param notifier - Notifier (for messages and test messages)
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
		case "send": {
			const msgText = text(msg, "text").trim();
			if (msgText === "") {
				return { ok: false, error: "missingText" };
			}
			const all = notifier.recipients();
			const ids = recipientIdsOf(msg, all);
			if (ids.length === 0) {
				return { ok: false, error: "missingRecipient" };
			}
			const unknown = ids.filter(id => !all.some(r => r.id === id));
			const res = await notifier.notify(ids, msgText, { doNotDisturb: field(msg, "doNotDisturb") === true });
			return { ok: res.sent.length > 0, ...res, unknown };
		}
		default:
			return { error: "unknownCommand" };
	}
}
