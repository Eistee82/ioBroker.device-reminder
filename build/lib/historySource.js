import { HISTORY_DAYS } from "./learn/analyze.js";
import { cleanPoints } from "./learn/clean.js";
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
function settingOf(val) {
    if (typeof val === "string" && val.trim() === "") {
        return null;
    }
    const n = typeof val === "string" ? Number(val) : val;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
}
export function historySettingsOf(custom) {
    const below = settingOf(custom.ignoreBelowNumber);
    return {
        relogSec: Math.max(0, settingOf(custom.changesRelogInterval) ?? 0),
        ignoreZero: custom.ignoreZero === true,
        ignoreBelowZero: custom.ignoreBelowZero === true || (below !== null && below >= 0),
        debounceMs: Math.max(0, settingOf(custom.debounceTime) ?? 0),
        blockTimeMs: Math.max(0, settingOf(custom.blockTime) ?? 0),
        round: settingOf(custom.round),
    };
}
export const CHUNK_CAP = 50_000;
export const MIN_CHUNK_MS = 15 * 60_000;
export const MAX_QUERIES = 400;
export const TICK_BUDGET = 1_000_000;
function numberOf(val) {
    const n = typeof val === "string" ? Number(val) : val;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
}
class SeriesBuilder {
    series;
    unitFactor;
    rep;
    marks = [];
    total = 0;
    invalid = 0;
    timeJumps = [];
    unknown = [];
    constructor(series, unitFactor) {
        this.series = series;
        this.unitFactor = unitFactor;
        this.rep = { count: new Uint16Array(series.length), maxGapMs: new Float64Array(series.length) };
    }
    tickOf(ts) {
        const i = Math.ceil((ts - this.series.t0) / this.series.stepMs);
        return i >= 0 && i < this.series.length ? i : -1;
    }
    gap(ts, ms) {
        const i = this.tickOf(ts);
        if (i >= 0 && ms > this.rep.maxGapMs[i]) {
            this.rep.maxGapMs[i] = ms;
        }
    }
    fail(from, to) {
        markInvalid(this.series, from, to);
        this.marks.push({ from, first: null, last: null, failed: true });
    }
    add(from, rows) {
        const raw = [];
        for (const row of rows) {
            const val = typeof row?.val === "string" ? Number(row.val) : row?.val;
            raw.push({
                ts: typeof row?.ts === "number" ? row.ts : Number.NaN,
                val: typeof val === "number" ? val : null,
            });
        }
        const c = cleanPoints(raw);
        this.total += raw.length;
        this.invalid += Math.round(c.invalidShare * raw.length);
        this.timeJumps.push(...c.timeJumps);
        this.unknown.push(...c.unknown);
        const points = [];
        let prev = null;
        for (const p of c.points) {
            points.push({ ts: p.ts, val: p.val * this.unitFactor });
            const i = this.tickOf(p.ts);
            if (i >= 0 && this.rep.count[i] < 0xffff) {
                this.rep.count[i]++;
            }
            if (prev !== null && p.ts > prev) {
                this.gap(p.ts, p.ts - prev);
            }
            prev = p.ts;
        }
        foldPoints(this.series, points);
        this.marks.push({
            from,
            first: c.points[0]?.ts ?? null,
            last: c.points.at(-1)?.ts ?? null,
            failed: false,
        });
    }
    finish() {
        let prevLast = null;
        for (const m of [...this.marks].sort((a, b) => a.from - b.from)) {
            if (m.failed) {
                prevLast = null;
                continue;
            }
            if (m.first !== null && prevLast !== null && m.first > prevLast) {
                this.gap(m.first, m.first - prevLast);
            }
            prevLast = m.last ?? prevLast;
        }
        finalize(this.series);
        const unknown = [...this.unknown].sort((a, b) => a.from - b.from);
        for (const u of unknown) {
            markInvalid(this.series, u.from, u.to);
        }
        return {
            series: this.series,
            rep: this.rep,
            clean: {
                invalidShare: this.total > 0 ? this.invalid / this.total : 0,
                timeJumps: this.timeJumps,
                unknown,
            },
        };
    }
}
export async function loadHistorySeries(env, instance, powerId, now, pollSec, onProgress, from) {
    const poll = Math.max(pollSec, 1);
    const obj = await env.object(powerId);
    const common = (obj?.common ?? {});
    const unit = typeof common.unit === "string" ? common.unit.trim() : "";
    const role = typeof common.role === "string" ? common.role : "";
    const custom = (common.custom?.[instance] ?? {});
    const retention = numberOf(custom.retention);
    let days = Math.min(HISTORY_DAYS, retention > 0 ? Math.floor(retention / 86_400) : HISTORY_DAYS);
    days = Math.max(1, Math.min(days, Math.floor((TICK_BUDGET * poll) / 86_400)));
    const settings = historySettingsOf(custom);
    if (settings.round === null) {
        const native = (await env.object(`system.adapter.${instance}`))?.native;
        settings.round = settingOf(native?.round);
    }
    const earliest = now - days * DAY_MS;
    const start = from !== undefined && Number.isFinite(from) ? Math.min(now, Math.max(earliest, from)) : earliest;
    days = Math.ceil((now - start) / DAY_MS);
    const meta = {
        unit,
        unitFactor: /^kW$/i.test(unit) ? 1000 : 1,
        minDelta: Math.max(0, numberOf(custom.changesMinDelta)),
        settings,
        days,
        energyCounter: /wh$/i.test(unit) || role.startsWith("value.energy"),
        failedChunks: 0,
        truncatedChunks: 0,
        queries: 0,
    };
    const stepMs = poll * 1000;
    if (meta.energyCounter) {
        return { ...new SeriesBuilder(createSeries(start, stepMs, 0), 1).finish(), meta };
    }
    const builder = new SeriesBuilder(createSeries(start, stepMs, Math.floor((now - start) / stepMs) + 1), meta.unitFactor);
    const load = async (chunkFrom, to) => {
        if (meta.queries >= MAX_QUERIES) {
            builder.fail(chunkFrom, to);
            return;
        }
        meta.queries++;
        let rows;
        try {
            const res = await env.getHistory(powerId, {
                instance,
                start: chunkFrom,
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
            builder.fail(chunkFrom, to);
            return;
        }
        if (rows.length >= CHUNK_CAP) {
            if (to - chunkFrom > MIN_CHUNK_MS) {
                const mid = chunkFrom + Math.ceil((to - chunkFrom) / 2);
                await load(chunkFrom, mid);
                await load(mid, to);
                return;
            }
            meta.truncatedChunks++;
        }
        builder.add(chunkFrom, rows);
    };
    for (let k = 1; k <= days; k++) {
        await load(Math.max(start, now - k * DAY_MS), now - (k - 1) * DAY_MS);
        onProgress?.(k / days);
    }
    return { ...builder.finish(), meta };
}
export function loadHistorySeriesForTest(points, o) {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const p of points) {
        if (Number.isFinite(p.ts)) {
            first = Math.min(first, p.ts);
            last = Math.max(last, p.ts);
        }
    }
    if (first > last) {
        first = 0;
        last = 0;
    }
    const builder = new SeriesBuilder(createSeries(first, o.stepMs, Math.floor((last - first) / o.stepMs) + 2), 1);
    builder.add(first, points);
    return Promise.resolve(builder.finish());
}
//# sourceMappingURL=historySource.js.map