import { HISTORY_DAYS } from "./historyLearning.js";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS = 100_000;
export async function findHistoryInstance(env, powerId) {
    const custom = (await env.object(powerId))?.common?.custom;
    const enabled = Object.entries(custom ?? {})
        .filter(([, settings]) => settings?.enabled === true)
        .map(([instance]) => instance);
    const defaultHistory = (await env.object("system.config"))?.common;
    const ordered = [...enabled].sort((a, b) => Number(b === defaultHistory?.defaultHistory) - Number(a === defaultHistory?.defaultHistory));
    for (const instance of ordered) {
        const adapter = await env.object(`system.adapter.${instance}`);
        if (adapter?.common?.getHistory === true &&
            (await env.alive(instance))) {
            return instance;
        }
    }
    return undefined;
}
export async function loadHistory(env, instance, powerId, now) {
    const res = await env.getHistory(powerId, {
        instance,
        start: now - HISTORY_DAYS * DAY_MS,
        end: now,
        aggregate: "none",
        count: MAX_POINTS,
        ignoreNull: true,
        returnNewestEntries: true,
    });
    const rows = Array.isArray(res?.result) ? res.result : [];
    const points = [];
    for (const row of rows) {
        const val = typeof row?.val === "string" ? Number(row.val) : row?.val;
        if (typeof row?.ts === "number" && typeof val === "number" && Number.isFinite(val)) {
            points.push({ ts: row.ts, val });
        }
    }
    return points.sort((a, b) => a.ts - b.ts);
}
//# sourceMappingURL=historySource.js.map