import { ChannelDetector, Types } from "@iobroker/type-detector";
const POWER_ROLE = /^value\.power$/;
function isPowerState(obj) {
    return obj?.type === "state" && POWER_ROLE.test(obj.common.role ?? "");
}
function findPowerFallback(objects, id) {
    if (isPowerState(objects[id])) {
        return { type: "electricity", powerId: id, switchId: null };
    }
    const candidates = Object.keys(objects).filter(key => key.startsWith(`${id}.`) && isPowerState(objects[key]));
    if (candidates.length === 1) {
        return { type: "electricity", powerId: candidates[0], switchId: null, hint: "noPattern" };
    }
    return null;
}
export function detectPowerAndSwitch(objects, id) {
    const patterns = new ChannelDetector().detect({ objects, id, allowedTypes: [Types.socket, Types.electricity] }) ?? [];
    let switchId = null;
    let powerId = null;
    for (const pattern of patterns) {
        for (const state of pattern.states) {
            if (state.name === "SET" && switchId === null) {
                switchId = state.id;
            }
            if (state.name === "ELECTRIC_POWER" && powerId === null) {
                powerId = state.id;
            }
        }
    }
    if (switchId !== null) {
        return { type: "socket", powerId, switchId };
    }
    if (powerId !== null) {
        return { type: "electricity", powerId, switchId: null };
    }
    return findPowerFallback(objects, id) ?? { type: null, powerId: null, switchId: null, hint: "notFound" };
}
export async function detectFromHost(getObjectsUnder, id) {
    const objects = await getObjectsUnder(id);
    return detectPowerAndSwitch(objects, id);
}
//# sourceMappingURL=typeDetection.js.map