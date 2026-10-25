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
export function kindFromInstance(instance) {
    const adapter = (instance ?? "").split(".")[0];
    return Object.keys(MESSENGER_ADAPTERS).find(k => MESSENGER_ADAPTERS[k].adapter === adapter);
}
export function fixedTextState(kind, instance) {
    if (kind === "sayit") {
        return `${instance}.tts.text`;
    }
    if (kind === "whatsapp") {
        return `${instance}.sendMessage`;
    }
    return undefined;
}
//# sourceMappingURL=adapters.js.map