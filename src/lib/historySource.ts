import { HISTORY_DAYS } from "./learn/analyze.js";
import type { HistoryPoint, TickSeries } from "./learn/ticks.js";
import { createSeries, finalize, foldPoints, markInvalid } from "./learn/ticks.js";
import { errorMessage } from "./utils.js";

/** Access to the objects and history adapters of the installation. */
export interface HistoryEnv {
	/**
	 * Read a foreign object.
	 *
	 * @param id - Object id
	 */
	object(id: string): Promise<ioBroker.Object | null | undefined>;
	/**
	 * Whether an adapter instance is running.
	 *
	 * @param instance - Instance, e.g. `influxdb.0`
	 */
	alive(instance: string): Promise<boolean>;
	/**
	 * Read stored values (`getHistory` of a history, sql or influxdb instance).
	 *
	 * @param id - State id
	 * @param options - Query including the instance
	 */
	getHistory(id: string, options: ioBroker.GetHistoryOptions): Promise<{ result?: unknown }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Running history instance that stores the power state: any adapter that answers `getHistory`
 * (history, sql, influxdb, ...) and has logging enabled for the state. The default history of the
 * system settings is preferred.
 *
 * @param env - Installation access
 * @param powerId - Power state of the device
 */
export async function findHistoryInstance(env: HistoryEnv, powerId: string): Promise<string | undefined> {
	const custom = (await env.object(powerId))?.common?.custom as Record<string, { enabled?: boolean }> | undefined;
	const enabled = Object.entries(custom ?? {})
		.filter(([, settings]) => settings?.enabled === true)
		.map(([instance]) => instance);
	const defaultHistory = (await env.object("system.config"))?.common as { defaultHistory?: string } | undefined;
	const ordered = [...enabled].sort(
		(a, b) => Number(b === defaultHistory?.defaultHistory) - Number(a === defaultHistory?.defaultHistory),
	);
	for (const instance of ordered) {
		const adapter = await env.object(`system.adapter.${instance}`);
		if (
			(adapter?.common as { getHistory?: boolean } | undefined)?.getHistory === true &&
			(await env.alive(instance))
		) {
			return instance;
		}
	}
	return undefined;
}

/** What was learned about the stored values while loading them. */
export interface HistoryMeta {
	/** Unit of the state. */
	unit: string;
	/** Factor from the unit of the state to W. */
	unitFactor: number;
	/** Deadband of the history adapter (`changesMinDelta`), unit of the state. */
	minDelta: number;
	/** Days that were loaded. */
	days: number;
	/** The state looks like an energy meter (Wh/kWh); nothing was loaded. */
	energyCounter: boolean;
	/** Chunks whose query failed (their time is unknown). */
	failedChunks: number;
	/** Chunks that still had too many values at the smallest size. */
	truncatedChunks: number;
	/** Number of queries. */
	queries: number;
	/** Error of the first failed query. */
	error?: string;
}

/** Most values requested per query. */
export const CHUNK_CAP = 50_000;
/** Smallest chunk; a full chunk is halved down to this size. */
export const MIN_CHUNK_MS = 15 * 60_000;
/** Most queries per learning. */
export const MAX_QUERIES = 400;
/** Most ticks of the series (limits the days for short poll intervals). */
export const TICK_BUDGET = 1_000_000;

function numberOf(val: unknown): number {
	const n = typeof val === "string" ? Number(val) : val;
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Stored values of the power state on the poll grid (W), loaded day by day so that plugs reporting
 * every second deliver the full period; a full chunk is halved, a failed chunk is unknown.
 *
 * @param env - Installation access
 * @param instance - History instance
 * @param powerId - Power state
 * @param now - Current time in ms
 * @param pollSec - Poll interval in s
 * @param onProgress - Progress 0..1
 */
export async function loadHistorySeries(
	env: HistoryEnv,
	instance: string,
	powerId: string,
	now: number,
	pollSec: number,
	onProgress?: (fraction: number) => void,
): Promise<{ series: TickSeries; meta: HistoryMeta }> {
	const poll = Math.max(pollSec, 1);
	const obj = await env.object(powerId);
	const common = (obj?.common ?? {}) as { unit?: unknown; role?: unknown; custom?: Record<string, unknown> };
	const unit = typeof common.unit === "string" ? common.unit.trim() : "";
	const role = typeof common.role === "string" ? common.role : "";
	const custom = (common.custom?.[instance] ?? {}) as { changesMinDelta?: unknown; retention?: unknown };
	const retention = numberOf(custom.retention);
	let days = Math.min(HISTORY_DAYS, retention > 0 ? Math.floor(retention / 86_400) : HISTORY_DAYS);
	days = Math.max(1, Math.min(days, Math.floor((TICK_BUDGET * poll) / 86_400)));
	const meta: HistoryMeta = {
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

	const load = async (from: number, to: number): Promise<void> => {
		if (meta.queries >= MAX_QUERIES) {
			markInvalid(series, from, to);
			return;
		}
		meta.queries++;
		let rows: { ts?: unknown; val?: unknown }[];
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
			rows = Array.isArray(res?.result) ? (res.result as { ts?: unknown; val?: unknown }[]) : [];
		} catch (err) {
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
		const points: HistoryPoint[] = [];
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
