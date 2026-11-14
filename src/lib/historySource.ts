import { HISTORY_DAYS } from "./learn/analyze.js";
import type { RawPoint, TimeJump } from "./learn/clean.js";
import { cleanPoints } from "./learn/clean.js";
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

/**
 * Settings of the history adapter for the power state that change what is stored. Field names in the
 * `common.custom.<instance>` block (checked read-only on a live system with influxdb 5.2.3; history and sql
 * use the same names in their custom settings):
 * - history, influxdb, sql: `changesRelogInterval` (s), `changesMinDelta`, `debounceTime` (ms), `blockTime`
 *   (ms), `ignoreBelowNumber` (number or "", replaces the older `ignoreBelowZero`), `retention` (s; influxdb
 *   keeps it only in the instance settings);
 * - history, sql: `ignoreZero`, `ignoreBelowZero` (older versions), `round` (digits, number or "");
 * - influxdb: `round` only in the instance settings (`native.round`), used when the custom block has none.
 *
 * A missing field stays neutral (0, false, null): only the findings that depend on it are missing.
 */
export interface HistorySettings {
	/** Value is stored again after this many s without a change (0 = off). */
	relogSec: number;
	/** Zero values are not stored. */
	ignoreZero: boolean;
	/** Negative values are not stored. */
	ignoreBelowZero: boolean;
	/** A value is stored only after it stayed this many ms (0 = off). */
	debounceMs: number;
	/** After a stored value, nothing is stored for this many ms (0 = off). */
	blockTimeMs: number;
	/** Digits the stored values are rounded to, or null. */
	round: number | null;
}

/**
 * Number of a setting (numbers and numeric strings), or null.
 *
 * @param val - Raw setting
 */
function settingOf(val: unknown): number | null {
	if (typeof val === "string" && val.trim() === "") {
		return null;
	}
	const n = typeof val === "string" ? Number(val) : val;
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * History settings from the custom block of the power state.
 *
 * @param custom - `common.custom.<instance>` of the power state
 */
export function historySettingsOf(custom: Record<string, unknown>): HistorySettings {
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

/** What was learned about the stored values while loading them. */
export interface HistoryMeta {
	/** Unit of the state. */
	unit: string;
	/** Factor from the unit of the state to W. */
	unitFactor: number;
	/** Deadband of the history adapter (`changesMinDelta`), unit of the state. */
	minDelta: number;
	/** Settings of the history adapter for the state. */
	settings: HistorySettings;
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

/**
 * Reports of the history per tick, instead of the raw values (a plug reporting every second would give
 * millions of objects): tick `i` covers `(t - step, t]` like the series.
 */
export interface ReportStats {
	/** Stored values in the tick (at most 65 535). */
	count: Uint16Array;
	/** Largest distance in ms from a value in the tick to the value before it (0 = none or unknown). */
	maxGapMs: Float64Array;
}

/** What the cleaning found in the stored values (see `cleanPoints`). */
export interface HistoryClean {
	/** Share of missing, non-numeric or negative values (0..1). */
	invalidShare: number;
	/** Jumps back of more than a minute. */
	timeJumps: TimeJump[];
	/** Time ranges that are unknown because of a jump back (also unknown in the series). */
	unknown: { from: number; to: number }[];
}

/** Result of loading the history. */
export interface HistoryLoad {
	/** Series in W. */
	series: TickSeries;
	/** Report statistics per tick. */
	rep: ReportStats;
	/** Cleaning results. */
	clean: HistoryClean;
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

/** One loaded (or failed) chunk, for the report gaps across chunk borders. */
interface ChunkMark {
	/** Start of the chunk in ms. */
	from: number;
	/** First stored value, or null. */
	first: number | null;
	/** Last stored value, or null. */
	last: number | null;
	/** The query failed or was not made. */
	failed: boolean;
}

/** Folds chunks of stored values into a series with report statistics and cleaning results. */
class SeriesBuilder {
	public readonly rep: ReportStats;
	private readonly marks: ChunkMark[] = [];
	private total = 0;
	private invalid = 0;
	private readonly timeJumps: TimeJump[] = [];
	private readonly unknown: { from: number; to: number }[] = [];

	/**
	 * @param series - Series under construction
	 * @param unitFactor - Factor from the unit of the state to W
	 */
	public constructor(
		public readonly series: TickSeries,
		private readonly unitFactor: number,
	) {
		this.rep = { count: new Uint16Array(series.length), maxGapMs: new Float64Array(series.length) };
	}

	/**
	 * Tick of a time, or -1 outside the series.
	 *
	 * @param ts - Time in ms
	 */
	private tickOf(ts: number): number {
		const i = Math.ceil((ts - this.series.t0) / this.series.stepMs);
		return i >= 0 && i < this.series.length ? i : -1;
	}

	/**
	 * Remember a report gap ending at a value.
	 *
	 * @param ts - Time of the value in ms
	 * @param ms - Distance to the value before it
	 */
	private gap(ts: number, ms: number): void {
		const i = this.tickOf(ts);
		if (i >= 0 && ms > this.rep.maxGapMs[i]) {
			this.rep.maxGapMs[i] = ms;
		}
	}

	/**
	 * A failed or skipped chunk: its time is unknown.
	 *
	 * @param from - Start in ms
	 * @param to - End in ms (exclusive)
	 */
	public fail(from: number, to: number): void {
		markInvalid(this.series, from, to);
		this.marks.push({ from, first: null, last: null, failed: true });
	}

	/**
	 * Stored values of one chunk as read.
	 *
	 * @param from - Start of the chunk in ms
	 * @param rows - Stored values (unit of the state)
	 */
	public add(from: number, rows: readonly { ts?: unknown; val?: unknown }[]): void {
		const raw: RawPoint[] = [];
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
		const points: HistoryPoint[] = [];
		let prev: number | null = null;
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

	/** Finish the series: gaps across chunk borders, unknown time of jumps back. */
	public finish(): HistoryLoad {
		let prevLast: number | null = null;
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

/**
 * Stored values of the power state on the poll grid (W), loaded day by day so that plugs reporting
 * every second deliver the full period; a full chunk is halved, a failed chunk is unknown. The values are
 * cleaned (`cleanPoints`) and the reports are counted per tick; the raw values are not kept.
 *
 * @param env - Installation access
 * @param instance - History instance
 * @param powerId - Power state
 * @param now - Current time in ms
 * @param pollSec - Poll interval in s
 * @param onProgress - Progress 0..1
 * @param from - Earliest time to load in ms (for example the start of an outage); default: as many days as allowed
 */
export async function loadHistorySeries(
	env: HistoryEnv,
	instance: string,
	powerId: string,
	now: number,
	pollSec: number,
	onProgress?: (fraction: number) => void,
	from?: number,
): Promise<HistoryLoad & { meta: HistoryMeta }> {
	const poll = Math.max(pollSec, 1);
	const obj = await env.object(powerId);
	const common = (obj?.common ?? {}) as { unit?: unknown; role?: unknown; custom?: Record<string, unknown> };
	const unit = typeof common.unit === "string" ? common.unit.trim() : "";
	const role = typeof common.role === "string" ? common.role : "";
	const custom = (common.custom?.[instance] ?? {}) as Record<string, unknown>;
	const retention = numberOf(custom.retention);
	let days = Math.min(HISTORY_DAYS, retention > 0 ? Math.floor(retention / 86_400) : HISTORY_DAYS);
	days = Math.max(1, Math.min(days, Math.floor((TICK_BUDGET * poll) / 86_400)));
	const settings = historySettingsOf(custom);
	if (settings.round === null) {
		// influxdb keeps the rounding in the instance settings
		const native = (await env.object(`system.adapter.${instance}`))?.native as Record<string, unknown> | undefined;
		settings.round = settingOf(native?.round);
	}
	const earliest = now - days * DAY_MS;
	const start = from !== undefined && Number.isFinite(from) ? Math.min(now, Math.max(earliest, from)) : earliest;
	days = Math.ceil((now - start) / DAY_MS);
	const meta: HistoryMeta = {
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
	const builder = new SeriesBuilder(
		createSeries(start, stepMs, Math.floor((now - start) / stepMs) + 1),
		meta.unitFactor,
	);

	const load = async (chunkFrom: number, to: number): Promise<void> => {
		if (meta.queries >= MAX_QUERIES) {
			builder.fail(chunkFrom, to);
			return;
		}
		meta.queries++;
		let rows: { ts?: unknown; val?: unknown }[];
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
			rows = Array.isArray(res?.result) ? (res.result as { ts?: unknown; val?: unknown }[]) : [];
		} catch (err) {
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

/**
 * Fold stored values like `loadHistorySeries`, without a history instance (tests): tick 0 is the first value.
 *
 * @param points - Stored values in W (order of arrival)
 * @param o - Options
 * @param o.stepMs - Poll interval in ms
 */
export function loadHistorySeriesForTest(
	points: readonly { ts: number; val: unknown }[],
	o: { stepMs: number },
): Promise<HistoryLoad> {
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
