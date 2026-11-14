import { coerceToType, errorMessage } from "./utils.js";
export async function runActions(host, actions, event, phaseId) {
    for (const action of actions) {
        if (action.event !== event || !action.stateId) {
            continue;
        }
        if (phaseId !== undefined && action.phaseId && action.phaseId !== phaseId) {
            continue;
        }
        try {
            const type = await host.getForeignObjectCommonType(action.stateId);
            if (type === null) {
                host.log.warn(`Action state ${action.stateId} does not exist, skipped`);
                continue;
            }
            await host.setForeignValue(action.stateId, coerceToType(action.value, type));
        }
        catch (err) {
            host.log.warn(`Action on ${action.stateId} failed: ${errorMessage(err)}`);
        }
    }
}
//# sourceMappingURL=actions.js.map