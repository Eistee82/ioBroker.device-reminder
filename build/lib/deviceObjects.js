import { buildStateCommon, DEVICE_CHANNELS, DEVICE_STATES } from "./stateDefinitions.js";
export async function ensureDeviceObjects(w, deviceId, cfg, inst) {
    await w.extendObject(deviceId, {
        type: "device",
        common: { name: cfg.name },
        native: { ...cfg },
    });
    for (const channel of DEVICE_CHANNELS) {
        await w.extendObject(`${deviceId}.${channel.id}`, {
            type: "channel",
            common: { name: channel.name },
            native: {},
        });
    }
    for (const def of DEVICE_STATES) {
        const id = `${deviceId}.${def.id}`;
        if (def.when === "historyHtml" && !inst.historyHtml) {
            await w.delObject(id);
            continue;
        }
        await w.extendObject(id, { type: "state", common: buildStateCommon(def), native: {} });
    }
}
//# sourceMappingURL=deviceObjects.js.map