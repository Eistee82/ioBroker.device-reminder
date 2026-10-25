const DEFAULT_INSTANCE = {
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
function put(target, key, value) {
    if (value === undefined || value === "") {
        return;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
        return;
    }
    target[key] = value;
}
export function mailSubject(text) {
    return text
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, 200);
}
export function buildDelivery(r, text) {
    const instance = r.instance || DEFAULT_INSTANCE[r.kind] || "";
    const send = (message) => ({ kind: "sendTo", instance, command: "send", message });
    const m = {};
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
//# sourceMappingURL=payloads.js.map