export const MESSENGER_ADAPTERS = {
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
export function defaultInstance(kind) {
    const entry = MESSENGER_ADAPTERS[kind];
    return entry ? `${entry.adapter}.0` : "";
}
export function messengerKindOptions(installed, current) {
    return Object.entries(MESSENGER_ADAPTERS)
        .filter(([kind, m]) => installed.has(m.adapter) || kind === current)
        .map(([kind, m]) => ({
        label: installed.has(m.adapter) ? m.label : `${m.label} (not installed)`,
        value: kind,
    }));
}
//# sourceMappingURL=adapters.js.map