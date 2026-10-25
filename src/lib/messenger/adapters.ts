import type { MessengerKind } from "../config.js";

/** ioBroker adapter (npm name without `iobroker.`) and display name per messenger kind. */
export const MESSENGER_ADAPTERS: Record<MessengerKind, { adapter: string; label: string }> = {
	alexa: { adapter: "alexa2", label: "Alexa" },
	sayit: { adapter: "sayit", label: "SayIt" },
	whatsapp: { adapter: "whatsapp-cmb", label: "WhatsApp" },
	telegram: { adapter: "telegram", label: "Telegram" },
	pushover: { adapter: "pushover", label: "Pushover" },
	signal: { adapter: "signal-cmb", label: "Signal" },
	email: { adapter: "email", label: "E-Mail" },
	matrix: { adapter: "matrix-org", label: "Matrix" },
	discord: { adapter: "discord", label: "Discord" },
	ntfy: { adapter: "ntfy", label: "ntfy" },
	pushsafer: { adapter: "pushsafer", label: "Pushsafer" },
	gotify: { adapter: "gotify", label: "Gotify" },
};

/**
 * Default instance of a messenger kind, e.g. `matrix-org.0`.
 *
 * @param kind - Messenger kind
 */
export function defaultInstance(kind: string): string {
	const entry = MESSENGER_ADAPTERS[kind as MessengerKind];
	return entry ? `${entry.adapter}.0` : "";
}

/**
 * Messenger kind of an instance id such as `alexa2.0`.
 *
 * @param instance - Adapter instance id
 */
export function kindFromInstance(instance: string | undefined): MessengerKind | undefined {
	const adapter = (instance ?? "").split(".")[0];
	return (Object.keys(MESSENGER_ADAPTERS) as MessengerKind[]).find(k => MESSENGER_ADAPTERS[k].adapter === adapter);
}

/**
 * State a messenger without own target selection writes the text to (SayIt, WhatsApp).
 *
 * @param kind - Messenger kind
 * @param instance - Adapter instance id
 */
export function fixedTextState(kind: MessengerKind, instance: string): string | undefined {
	if (kind === "sayit") {
		return `${instance}.tts.text`;
	}
	if (kind === "whatsapp") {
		return `${instance}.sendMessage`;
	}
	return undefined;
}
