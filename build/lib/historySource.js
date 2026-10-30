import { HISTORY_DAYS } from "./learn/analyze.js";
import { createSeries, finalize, foldPoints, markInvalid } from "./learn/ticks.js";
import { errorMessage } from "./utils.js";
const DAY_MS = 24 * 60 * 60 * 1000;
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
export const CHUNK_CAP = 50_000;
export const MIN_CHUNK_MS = 15 * 60_000;
export const MAX_QUERIES = 400;
export const TICK_BUDGET = 1_000_000;
function numberOf(val) {
    const n = typeof val === "string" ? Number(val) : val;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
}
export async function loadHistorySeries(env, instance, powerId, now, pollSec, onProgress) {
    const poll = Math.max(pollSec, 1);
    const obj = await env.object(powerId);
    const common = (obj?.common ?? {});
    const unit = typeof common.unit === "string" ? common.unit.trim() : "";
    const role = typeof common.role === "string" ? common.role : "";
    const custom = (common.custom?.[instance] ?? {});
    const retention = numberOf(custom.retention);
    let days = Math.min(HISTORY_DAYS, retention > 0 ? Math.floor(retention / 86_400) : HISTORY_DAYS);
    days = Math.max(1, Math.min(days, Math.floor((TICK_BUDGET * poll) / 86_400)));
    const meta = {
        unit,
        unitFactor: /^kW$/i.test(unit) ? 1000 : 1,
        minDelta: Math.max(0, numberOf(custom.changesMinDelta)),
        days,
        energyCounter: /wh$/i.test(unit) || role.startsWith("value.energy"),
        failedChunks: 0,
        truncatedChunks: 0,
        queries: 0,
    };
    const stepMs = poll * 1000;
    const start = now - days * DAY_MS;
    if (meta.energyCounter) {
        return { series: createSeries(start, stepMs, 0), meta };
    }
    const series = createSeries(start, stepMs, Math.floor((now - start) / stepMs) + 1);
    const load = async (from, to) => {
        if (meta.queries >= MAX_QUERIES) {
            markInvalid(series, from, to);
            return;
        }
        meta.queries++;
        let rows;
        try {
            const res = await env.getHistory(powerId, {
                instance,
                start: from,
                end: to - 1,
                aggregate: "none",
                count: CHUNK_CAP,
                ignoreNull: true,
                returnNewestEntries: false,
                removeBorderValues: true,
            });
            rows = Array.isArray(res?.result) ? res.result : [];
        }
        catch (err) {
            meta.failedChunks++;
            meta.error ??= errorMessage(err);
            markInvalid(series, from, to);
            return;
        }
        if (rows.length >= CHUNK_CAP) {
            if (to - from > MIN_CHUNK_MS) {
                const mid = from + Math.ceil((to - from) / 2);
                await load(from, mid);
                await load(mid, to);
                return;
            }
            meta.truncatedChunks++;
        }
        const points = [];
        for (const row of rows) {
            const val = typeof row?.val === "string" ? Number(row.val) : row?.val;
            if (typeof row?.ts === "number" && typeof val === "number" && Number.isFinite(val)) {
                points.push({ ts: row.ts, val: val * meta.unitFactor });
            }
        }
        foldPoints(series, points);
    };
    for (let k = 1; k <= days; k++) {
        await load(now - k * DAY_MS, now - (k - 1) * DAY_MS);
        onProgress?.(k / days);
    }
    finalize(series);
    return { series, meta };
}
//# sourceMappingURL=historySource.js.map