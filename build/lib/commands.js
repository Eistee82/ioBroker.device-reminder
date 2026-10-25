import { messengerKindOptions } from "./messenger/adapters.js";
function field(msg, key) {
    return typeof msg === "object" && msg !== null ? msg[key] : undefined;
}
function deviceIdOf(msg) {
    const id = field(msg, "deviceId");
    return typeof id === "string" ? id : "";
}
function toBool(val) {
    return val === true || val === 1 || val === "true" || val === "1";
}
export async function handleCommand(reg, notifier, cmd, msg, env) {
    switch (cmd) {
        case "getMessengerKinds": {
            const current = field(msg, "current");
            const installed = env ? await env.installedAdapters() : new Set();
            return messengerKindOptions(installed, typeof current === "string" ? current : undefined);
        }
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
//# sourceMappingURL=commands.js.map