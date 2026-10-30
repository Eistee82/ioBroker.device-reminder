import type { HistoryPoint } from "./historyLearning.js";
import { HISTORY_DAYS } from "./historyLearning.js";

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
const MAX_POINTS = 100_000;

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

/**
 * Stored numeric values of the power state from the last HISTORY_DAYS days (newest MAX_POINTS).
 *
 * @param env - Installation access
 * @param instance - History instance
 * @param powerId - Power state
 * @param now - Current time in ms
 */
export async function loadHistory(
	env: HistoryEnv,
	instance: string,
	powerId: string,
	now: number,
): Promise<HistoryPoint[]> {
	const res = await env.getHistory(powerId, {
		instance,
		start: now - HISTORY_DAYS * DAY_MS,
		end: now,
		aggregate: "none",
		count: MAX_POINTS,
		ignoreNull: true,
		returnNewestEntries: true,
	});
	const rows = Array.isArray(res?.result) ? (res.result as { ts?: unknown; val?: unknown }[]) : [];
	const points: HistoryPoint[] = [];
	for (const row of rows) {
		const val = typeof row?.val === "string" ? Number(row.val) : row?.val;
		if (typeof row?.ts === "number" && typeof val === "number" && Number.isFinite(val)) {
			points.push({ ts: row.ts, val });
		}
	}
	return points.sort((a, b) => a.ts - b.ts);
}
