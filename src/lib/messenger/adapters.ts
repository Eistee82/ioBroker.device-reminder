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
 * Options for the messenger select of the admin UI: only messengers whose adapter is installed.
 * The kind of the edited recipient is always kept, so an existing entry stays readable.
 *
 * @param installed - Names of the installed adapters (`system.adapter.<name>`)
 * @param current - Kind of the recipient being edited
 */
export function messengerKindOptions(
	installed: ReadonlySet<string>,
	current?: string,
): { label: string; value: string }[] {
	return (Object.entries(MESSENGER_ADAPTERS) as [MessengerKind, { adapter: string; label: string }][])
		.filter(([kind, m]) => installed.has(m.adapter) || kind === current)
		.map(([kind, m]) => ({
			label: installed.has(m.adapter) ? m.label : `${m.label} (not installed)`,
			value: kind,
		}));
}
