import { MESSENGER_ADAPTERS, kindFromInstance } from "./adapters.js";
export async function messengerInstanceChoices(env, current) {
    const instances = (await env.instances()).filter(id => kindFromInstance(id) !== undefined);
    const choices = instances.sort().map(id => ({ label: `${label(id)} (${id})`, value: id }));
    if (current && kindFromInstance(current) && !instances.includes(current)) {
        choices.push({ label: `${label(current)} (${current}, not installed)`, value: current });
    }
    return choices;
}
export async function alexaDeviceChoices(env, instance) {
    if (kindFromInstance(instance) !== "alexa") {
        return [];
    }
    const speak = (await env.stateIds(`${instance}.Echo-Devices.`)).filter(id => id.endsWith(".Commands.speak"));
    const choices = [];
    for (const id of speak) {
        const deviceId = id.slice(0, -".Commands.speak".length);
        const serial = deviceId.split(".").pop() ?? deviceId;
        const name = await env.objectName(deviceId);
        choices.push({ label: name && name !== serial ? `${name} (${serial})` : serial, value: id });
    }
    return choices.sort((a, b) => a.label.localeCompare(b.label));
}
export async function telegramTargetChoices(env, instance, target) {
    if (kindFromInstance(instance) !== "telegram") {
        return [];
    }
    let users = {};
    try {
        const raw = await env.stateValue(`${instance}.communicate.users`);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === "object") {
            users = parsed;
        }
    }
    catch {
        return [];
    }
    return Object.entries(users).map(([chatId, u]) => {
        const name = u.firstName || u.userName || chatId;
        if (target === "chatId") {
            return { label: name, value: chatId, description: `Chat ID ${chatId}` };
        }
        const value = u.userName || u.firstName || chatId;
        return { label: name, value, description: u.userName ? `@${u.userName}` : undefined };
    });
}
function label(instance) {
    const kind = kindFromInstance(instance);
    return kind ? MESSENGER_ADAPTERS[kind].label : instance;
}
//# sourceMappingURL=choices.js.map