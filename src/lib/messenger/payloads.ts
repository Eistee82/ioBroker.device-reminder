import type { RecipientConfig } from "../config.js";

/** Delivery through `sendTo` to another adapter instance. */
export interface SendToCall {
	/** Discriminator. */
	kind: "sendTo";
	/** Target instance id. */
	instance: string;
	/** Command. */
	command: string;
	/** Message payload. */
	message: unknown;
}
/** Delivery by writing a foreign state. */
export interface SetStateCall {
	/** Discriminator. */
	kind: "setState";
	/** Target state id. */
	id: string;
	/** Text to write. */
	val: string;
}

/**
 * Default adapter instance per messenger kind (used when the recipient has no instance configured).
 * `instance` of a recipient is the complete instance id such as `telegram.0`.
 */
const DEFAULT_INSTANCE: Record<string, string> = {
	telegram: "telegram.0",
	pushover: "pushover.0",
	signal: "signal-cmb.0",
	email: "email.0",
	matrix: "matrix.0",
	discord: "discord.0",
	ntfy: "ntfy.0",
	pushsafer: "pushsafer.0",
	gotify: "gotify.0",
};

/**
 * Add a field only if the value is set (non-empty string or finite number).
 *
 * @param target - Payload object to extend
 * @param key - Field name
 * @param value - Candidate value
 */
function put(target: Record<string, unknown>, key: string, value: string | number | undefined): void {
	if (value === undefined || value === "") {
		return;
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		return;
	}
	target[key] = value;
}

/**
 * Single-line mail subject: line breaks would allow header injection, so they are collapsed.
 *
 * @param text - Message text
 */
export function mailSubject(text: string): string {
	return text
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 200);
}

/**
 * Build the delivery for a recipient. Voice outputs (alexa, sayit) return `null` because they need
 * the volume handling of `VoiceOutput`; recipients without a required target (telegram user/chatId,
 * discord user or channel, ntfy topic) also return `null` instead of a broadcast. Field names follow the README of each target adapter:
 * ioBroker.telegram (`text`, `user`, `chatId`), ioBroker.pushover (`message`, `title`, `sound`, `priority`,
 * `device`, `ttl`, `retry`, `expire`), ioBroker.signal-cmb (`text`), ioBroker.email (`text`, `to`, `subject`,
 * `from`), ioBroker.matrix (plain text), ioBroker.discord (`content`, `userId`, `userTag`, `userName`,
 * `serverId`, `channelId`), ioBroker.ntfy (`message`, `title`, `topic`, `priority`), ioBroker.pushsafer
 * (`message`, `title`, `device`, `sound`, `priority`), ioBroker.gotify (`message`, `title`, `priority`).
 *
 * @param r - Recipient
 * @param text - Message text
 */
export function buildDelivery(r: RecipientConfig, text: string): SendToCall | SetStateCall | null {
	const instance = r.instance || DEFAULT_INSTANCE[r.kind] || "";
	const send = (message: unknown): SendToCall => ({ kind: "sendTo", instance, command: "send", message });
	const m: Record<string, unknown> = {};
	switch (r.kind) {
		case "alexa":
		case "sayit":
			return null;
		case "whatsapp":
			if (!r.stateId) {
				return null;
			}
			return { kind: "setState", id: r.stateId, val: text };
		case "telegram":
			m.text = text;
			if (r.telegramTarget === "user" || r.telegramTarget === "chatId") {
				// an empty target would make the telegram adapter broadcast to every user
				if (!r.target) {
					return null;
				}
				m[r.telegramTarget] = r.target;
			}
			return send(m);
		case "pushover":
			m.message = text;
			put(m, "sound", r.sound);
			put(m, "title", r.title);
			put(m, "device", r.device);
			put(m, "priority", r.priority);
			put(m, "ttl", r.ttl);
			if (r.priority === 2) {
				m.retry = 60;
				m.expire = 3600;
			}
			return send(m);
		case "signal":
			return send({ text });
		case "email":
			m.text = text;
			put(m, "to", r.emailTo);
			m.subject = mailSubject(text);
			put(m, "from", r.emailFrom);
			return send(m);
		case "matrix":
			return send(text);
		case "discord":
			if (!r.userId && !r.userTag && !r.userName && !r.channelId) {
				return null;
			}
			m.content = text;
			put(m, "userId", r.userId);
			put(m, "userTag", r.userTag);
			put(m, "userName", r.userName);
			put(m, "serverId", r.serverId);
			put(m, "channelId", r.channelId);
			return send(m);
		case "ntfy":
			if (!r.topic) {
				return null;
			}
			m.message = text;
			put(m, "title", r.title);
			put(m, "topic", r.topic);
			put(m, "priority", r.priority);
			return send(m);
		case "pushsafer":
			m.message = text;
			put(m, "title", r.title);
			put(m, "device", r.device);
			put(m, "sound", r.sound);
			put(m, "priority", r.priority);
			return send(m);
		case "gotify":
			m.message = text;
			put(m, "title", r.title);
			put(m, "priority", r.priority);
			return send(m);
		default:
			return null;
	}
}
