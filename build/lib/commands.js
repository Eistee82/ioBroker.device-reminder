import { alexaDeviceChoices, messengerInstanceChoices, telegramTargetChoices, } from "./messenger/choices.js";
function field(msg, key) {
    return typeof msg === "object" && msg !== null ? msg[key] : undefined;
}
function text(msg, key) {
    const v = field(msg, key);
    return typeof v === "string" ? v : "";
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
        case "getMessengerInstances":
            return env ? messengerInstanceChoices(env, text(msg, "current")) : [];
        case "getAlexaDevices":
            return env ? alexaDeviceChoices(env, text(msg, "instance")) : [];
        case "getTelegramTargets":
            return env ? telegramTargetChoices(env, text(msg, "instance"), text(msg, "target")) : [];
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