import type { Layout } from "./runs.js";
import type { TickSeries } from "./ticks.js";

/** Most raw values handed out by one call of `unitsOf`; further units are built from the tick series. */
export const RAW_POINTS_MAX = 200_000;
/** Width of a histogram class on the log scale (7 %). */
const LN_STEP = Math.log(1.07);
/** A peak of the histogram stays when it is this many times higher than the valley to its neighbour. */
const PEAK_RATIO = 1.2;
/** A band stays when it has at least KEEP_SEGMENTS own segments in at least KEEP_UNITS units … */
const KEEP_UNITS = 3;
/** … see KEEP_UNITS. */
const KEEP_SEGMENTS = 3;
/** … or at least this share of the active time. */
const KEEP_SHARE = 0.005;
/** Upper quantile of the lower band and lower quantile of the upper band for the boundary. */
const Q_EDGE = 0.001;
/** Window of the moving median (mode `median60`). */
const MEDIAN_MS = 60_000;
/** Grid of the moving median. */
const GRID_MS = 1000;
/** A hold time profile needs values of a band from this many units … */
const HOLD_MIN_UNITS = 3;
/** … and this many hold times. */
const HOLD_MIN_N = 30;
/** Lowest suspect limit in s. */
const SUSPECT_MIN_SEC = 600;
/** The suspect limit is this multiple of the p99 of the hold times. */
const SUSPECT_FACTOR = 5;
/** Share of the own segments of the rarer of two neighbouring bands that border on the other band: one band. */
const CHANGE_SHARE = 0.5;
/** Share of the contacts of two neighbouring bands with a back-and-forth change (a-b-a or b-a-b): one band. */
const ALTERNATE_SHARE = 0.25;

/** Stored values of one run or one day section. */
export interface Unit {
	/** Stored values in the unit of the state, sorted by time. */
	points: { ts: number; val: number }[];
	/** Begin in ms. */
	from: number;
	/** End in ms. */
	to: number;
	/** Built from the tick series (more than RAW_POINTS_MAX raw values): no hold times. */
	fromTicks?: boolean;
}

/**
 * A base band: a power range the device keeps for a while. `[min, max)` in the unit of the input; the
 * lowest band starts just above the run level, `max` of the highest band is `Infinity`.
 */
export interface Band {
	/** `b1`, `b2`, … from low to high. */
	id: string;
	/** Lower limit. */
	min: number;
	/** Upper limit (exclusive). */
	max: number;
	/** Number of own segments over all units. */
	segments: number;
	/** Share of the time above the run level. */
	activeShare: number;
}

/** Hold times of the stored values in one band. */
export interface HoldProfile {
	/** Band id. */
	band: string;
	/** p99 of the hold times in s. */
	p99Sec: number;
	/** A value held longer than this is suspicious (logger gap): max(600, 5 × p99). */
	suspectSec: number;
	/** Number of hold times. */
	n: number;
}

/** Base bands and hold time profile of a device. */
export interface BaseBands {
	/** Bands from low to high. */
	bands: Band[];
	/** Hold time profile of the bands with enough values. */
	holds: HoldProfile[];
	/** Number of units learned from. */
	units: number;
	/** Run level (unit of the input). */
	runLimit: number;
	/** How the levels were read. */
	opts: BandOptions;
}

/** How the level of a unit is read. */
export interface BandOptions {
	/** `median60`: moving 60-s median of the held values (rhythmic devices); `raw`: the held values (Zigbee). */
	mode: "median60" | "raw";
	/** Blocks shorter than this between two blocks of the same band belong to them; quantiles only use longer blocks. */
	dipSec: number;
}

/** Default of `baseBandsOf`. */
export const DEFAULT_BAND_OPTIONS: BandOptions = { mode: "median60", dipSec: 60 };

/** Level of a unit as held stretches. */
interface Levels {
	/** Begin of each stretch in ms. */
	t: number[];
	/** Duration in ms. */
	d: number[];
	/** Level (NaN = unknown). */
	v: number[];
}

/** A stretch of one label (band index, -1 = at or below the run level, -2 = unknown). */
interface Block {
	/** Label. */
	lab: number;
	/** Duration in ms. */
	d: number;
	/** First level stretch. */
	i0: number;
	/** Last level stretch. */
	i1: number;
}

/**
 * Index of the first point at or after `ts` (points sorted by time).
 *
 * @param points - Points
 * @param ts - Time
 */
function lowerBound(points: readonly { ts: number }[], ts: number): number {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].ts < ts) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/**
 * Units of the runs of a layout: from the tick before the first active tick to the tick after
 * `runEnd`. Each unit gets the held value at its begin as first point. Over RAW_POINTS_MAX raw values
 * the older runs are built from the tick series (`fromTicks`).
 *
 * @param points - Stored values in the unit of the state, sorted by time
 * @param L - Layout (built in W, only the tick indices are used)
 * @param s - Series of the layout
 * @param unitFactor - W per unit of the state (the series is in W)
 */
export function unitsOf(
	points: readonly { ts: number; val: number }[],
	L: Layout,
	s: TickSeries,
	unitFactor = 1,
): Unit[] {
	const out: Unit[] = [];
	let budget = RAW_POINTS_MAX;
	for (let k = L.runs.length - 1; k >= 0; k--) {
		const r = L.runs[k];
		const fromIdx = Math.max(0, r.from - 1);
		const toIdx = Math.min(s.length - 1, r.runEnd + 1);
		const from = s.t0 + fromIdx * s.stepMs;
		const to = s.t0 + toIdx * s.stepMs;
		const a = lowerBound(points, from);
		const b = lowerBound(points, to + 1);
		if (b - a <= budget) {
			budget -= b - a;
			const unit: { ts: number; val: number }[] = [];
			if (a > 0 && (a === points.length || points[a].ts > from)) {
				unit.push({ ts: from, val: points[a - 1].val });
			}
			for (let i = a; i < b; i++) {
				unit.push({ ts: points[i].ts, val: points[i].val });
			}
			out.push({ points: unit, from, to });
			continue;
		}
		budget = 0;
		// values on the poll grid, changes only (the series is in W, the units in the unit of the state)
		const factor = unitFactor > 0 ? unitFactor : 1;
		const unit: { ts: number; val: number }[] = [];
		for (let i = fromIdx; i <= toIdx; i++) {
			if (s.valid[i] === 1 && (unit.length === 0 || unit.at(-1)!.val !== s.last[i] / factor)) {
				unit.push({ ts: s.t0 + i * s.stepMs, val: s.last[i] / factor });
			}
		}
		out.push({ points: unit, from, to, fromTicks: true });
	}
	return out.reverse();
}

/**
 * Held values of a unit as stretches (time before the first value is unknown).
 *
 * @param u - Unit
 */
function heldOf(u: Unit): Levels {
	const out: Levels = { t: [], d: [], v: [] };
	const pts = u.points;
	for (let k = 0; k < pts.length; k++) {
		const a = Math.max(pts[k].ts, u.from);
		const b = Math.min(k + 1 < pts.length ? pts[k + 1].ts : u.to, u.to);
		if (b <= a) {
			continue;
		}
		const val = pts[k].val;
		const last = out.v.length - 1;
		if (last >= 0 && out.v[last] === val && out.t[last] + out.d[last] === a) {
			out.d[last] += b - a;
		} else {
			out.t.push(a);
			out.d.push(b - a);
			out.v.push(val);
		}
	}
	return out;
}

/**
 * Moving median (centred, MEDIAN_MS) of the held values on a GRID_MS grid.
 *
 * @param u - Unit
 */
function medianOf(u: Unit): Levels {
	const held = heldOf(u);
	const out: Levels = { t: [], d: [], v: [] };
	const n = Math.floor((u.to - u.from) / GRID_MS);
	if (n <= 0 || held.t.length === 0) {
		return out;
	}
	const g = new Float64Array(n).fill(Number.NaN);
	let k = 0;
	for (let j = 0; j < n; j++) {
		const t = u.from + j * GRID_MS;
		while (k < held.t.length && held.t[k] + held.d[k] <= t) {
			k++;
		}
		if (k < held.t.length && held.t[k] <= t) {
			g[j] = held.v[k];
		}
	}
	const w = Math.round(MEDIAN_MS / GRID_MS);
	const half = w >> 1;
	const win: number[] = [];
	const insert = (x: number): void => {
		let lo = 0;
		let hi = win.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (win[mid] < x) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		win.splice(lo, 0, x);
	};
	const remove = (x: number): void => {
		let lo = 0;
		let hi = win.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (win[mid] < x) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		win.splice(lo, 1);
	};
	// window of tick j: [j - half, j + w - half - 1]
	for (let j = 0; j < Math.min(n, w - half - 1); j++) {
		if (!Number.isNaN(g[j])) {
			insert(g[j]);
		}
	}
	for (let j = 0; j < n; j++) {
		const enter = j + w - half - 1;
		if (enter < n && !Number.isNaN(g[enter])) {
			insert(g[enter]);
		}
		const leave = j - half - 1;
		if (leave >= 0 && !Number.isNaN(g[leave])) {
			remove(g[leave]);
		}
		// unknown time stays unknown; the lower median is a stored value (exact in every unit)
		const val = Number.isNaN(g[j]) || win.length === 0 ? Number.NaN : win[(win.length - 1) >> 1];
		const t = u.from + j * GRID_MS;
		const last = out.v.length - 1;
		if (last >= 0 && (out.v[last] === val || (Number.isNaN(val) && Number.isNaN(out.v[last])))) {
			out.d[last] += GRID_MS;
		} else {
			out.t.push(t);
			out.d.push(GRID_MS);
			out.v.push(val);
		}
	}
	return out;
}

/**
 * Histogram class of a value above the run level.
 *
 * @param v - Value
 * @param runLimit - Run level
 */
function binOf(v: number, runLimit: number): number {
	return Math.max(0, Math.floor(Math.log(v / runLimit) / LN_STEP));
}

/**
 * Lower limit of a histogram class.
 *
 * @param bin - Class
 * @param runLimit - Run level
 */
function edgeOf(bin: number, runLimit: number): number {
	return runLimit * Math.exp((bin + 0.5) * LN_STEP);
}

/**
 * Label of a level: band index for the edges, -1 at or below the run level, -2 unknown.
 *
 * @param v - Level
 * @param runLimit - Run level
 * @param edges - Upper limits of all bands but the highest, ascending
 */
function labelOf(v: number, runLimit: number, edges: readonly number[]): number {
	if (Number.isNaN(v)) {
		return -2;
	}
	if (v <= runLimit) {
		return -1;
	}
	let k = 0;
	while (k < edges.length && v >= edges[k]) {
		k++;
	}
	return k;
}

/**
 * Blocks of a unit for the edges; a block shorter than `dipMs` between two blocks of the same band
 * belongs to them.
 *
 * @param lv - Levels of the unit
 * @param runLimit - Run level
 * @param edges - Band edges
 * @param dipMs - Longest bridged block
 */
function blocksOf(lv: Levels, runLimit: number, edges: readonly number[], dipMs: number): Block[] {
	const st: Block[] = [];
	for (let i = 0; i < lv.v.length; i++) {
		const lab = labelOf(lv.v[i], runLimit, edges);
		const top = st.at(-1);
		if (top && top.lab === lab) {
			top.d += lv.d[i];
			top.i1 = i;
		} else {
			st.push({ lab, d: lv.d[i], i0: i, i1: i });
		}
		while (st.length >= 3) {
			const [a, m, b] = st.slice(-3);
			if (a.lab < 0 || a.lab !== b.lab || m.lab === -2 || m.d >= dipMs) {
				break;
			}
			st.splice(-3, 3, { lab: a.lab, d: a.d + m.d + b.d, i0: a.i0, i1: b.i1 });
		}
	}
	return st;
}

/**
 * Time-weighted quantile of the levels above the run level in the given blocks.
 *
 * @param pairs - Level and duration
 * @param q - Fraction 0..1
 */
function weightedQuantile(pairs: [number, number][], q: number): number {
	if (pairs.length === 0) {
		return Number.NaN;
	}
	pairs.sort((a, b) => a[0] - b[0]);
	const total = pairs.reduce((s, p) => s + p[1], 0);
	let acc = 0;
	for (const [v, d] of pairs) {
		acc += d;
		if (acc >= q * total) {
			return v;
		}
	}
	return pairs.at(-1)![0];
}

/**
 * Peaks of a histogram; neighbouring peaks whose valley is not PEAK_RATIO times lower than the lower
 * of them are one peak.
 *
 * @param h - Histogram
 */
function peaksOf(h: Float64Array): number[] {
	const peaks: number[] = [];
	for (let i = 0; i < h.length; i++) {
		if (h[i] > 0 && (i === 0 || h[i] > h[i - 1]) && (i === h.length - 1 || h[i] >= h[i + 1])) {
			peaks.push(i);
		}
	}
	for (let changed = true; changed;) {
		changed = false;
		for (let k = 0; k + 1 < peaks.length; k++) {
			const a = peaks[k];
			const b = peaks[k + 1];
			const m = valleyOf(h, a, b);
			if (Math.min(h[a], h[b]) < PEAK_RATIO * h[m]) {
				peaks.splice(h[a] >= h[b] ? k + 1 : k, 1);
				changed = true;
				break;
			}
		}
	}
	return peaks;
}

/**
 * Lowest class between two classes (middle of a flat minimum).
 *
 * @param h - Histogram
 * @param a - Left class
 * @param b - Right class
 */
function valleyOf(h: Float64Array, a: number, b: number): number {
	let lo = Number.POSITIVE_INFINITY;
	for (let i = a; i <= b; i++) {
		lo = Math.min(lo, h[i]);
	}
	const at: number[] = [];
	for (let i = a; i <= b; i++) {
		if (h[i] === lo) {
			at.push(i);
		}
	}
	return at[(at.length - 1) >> 1];
}

/** Statistics of the bands for a set of edges. */
interface BandStats {
	/** Blocks per unit. */
	blocks: Block[][];
	/** Active time per band in ms. */
	time: number[];
	/** Own segments (blocks of at least `dipMs`) per band and unit. */
	segs: number[][];
	/** Own segments per band whose neighbouring own segment is the lower [0] or upper [1] neighbour band. */
	direct: [number, number][];
	/** Own segments per band with the lower [0] or upper [1] neighbour band on both sides. */
	enclosed: [number, number][];
}

/**
 * Statistics of the bands for the edges. Neighbours of an own segment are the own segments (or rest
 * and unknown stretches) before and after it; shorter blocks in between are passed through.
 *
 * @param levels - Levels per unit
 * @param runLimit - Run level
 * @param edges - Band edges
 * @param dipMs - Longest bridged block, shortest own segment
 */
function statsOf(levels: readonly Levels[], runLimit: number, edges: readonly number[], dipMs: number): BandStats {
	const nb = edges.length + 1;
	const time = new Array<number>(nb).fill(0);
	const segs = Array.from({ length: nb }, () => new Array<number>(levels.length).fill(0));
	const direct = Array.from({ length: nb }, (): [number, number] => [0, 0]);
	const enclosed = Array.from({ length: nb }, (): [number, number] => [0, 0]);
	const blocks = levels.map((lv, u) => {
		const bl = blocksOf(lv, runLimit, edges, dipMs);
		const own: number[] = [];
		for (const b of bl) {
			if (b.lab >= 0) {
				time[b.lab] += b.d;
			}
			if (b.lab < 0 || b.d >= dipMs) {
				if (own.at(-1) !== b.lab) {
					own.push(b.lab);
				}
			}
		}
		own.forEach((lab, i) => {
			if (lab < 0) {
				return;
			}
			segs[lab][u]++;
			const prev = own[i - 1];
			const next = own[i + 1];
			[lab - 1, lab + 1].forEach((n, side) => {
				if (n >= 0 && n < nb) {
					direct[lab][side] += prev === n || next === n ? 1 : 0;
					enclosed[lab][side] += prev === n && next === n ? 1 : 0;
				}
			});
		});
		return bl;
	});
	return { blocks, time, segs, direct, enclosed };
}

/**
 * Whether band k has its own segments in enough units to stay on its own.
 *
 * @param st - Statistics
 * @param k - Band
 */
function recurring(st: BandStats, k: number): boolean {
	return st.segs[k].filter(n => n >= KEEP_SEGMENTS).length >= KEEP_UNITS;
}

/**
 * Whether the bands k and k+1 change into each other within a block. The rarer band must not be an
 * excursion of the other band (the other band on both sides in at least half of its contacts), and
 * either
 * - the rarer band does not recur on its own and most of its own segments border directly on the
 *   other band, or
 * - both bands border on each other with most of their own segments and the values go back and forth
 *   (a-b-a or b-a-b in at least a quarter of the contacts; boiler: burner stages 177/249 W are one
 *   band, while the short ignition peak before the burner and start/after-run below it stay apart).
 *
 * @param st - Statistics
 * @param k - Lower band of the pair
 */
function changeWithin(st: BandStats, k: number): boolean {
	const count = (b: number): number => st.segs[b].reduce((s, x) => s + x, 0);
	const rare = count(k) < count(k + 1) ? k : k + 1;
	const side = rare === k ? 1 : 0;
	const n = count(rare);
	const direct = st.direct[rare][side];
	if (n === 0 || st.enclosed[rare][side] >= CHANGE_SHARE * direct) {
		return false;
	}
	const lowDirect = st.direct[k][1];
	const highDirect = st.direct[k + 1][0];
	const mutual = lowDirect >= CHANGE_SHARE * count(k) && highDirect >= CHANGE_SHARE * count(k + 1);
	const turns = st.enclosed[k][1] + st.enclosed[k + 1][0];
	if (mutual && turns >= ALTERNATE_SHARE * Math.min(lowDirect, highDirect)) {
		return true;
	}
	return !recurring(st, rare) && direct >= CHANGE_SHARE * n;
}

/**
 * Learn the base bands of a device (Spec B.1a, algorithm B.5 step 2 without names): time-weighted
 * histogram of the levels above the run level on a log scale (7 % classes), peaks with a peak/valley
 * ratio of at least 1.2; a band stays when it has at least 3 own segments in at least 3 units or at
 * least 0.5 % of the active time, and when its blocks do not keep changing to a neighbour; the boundary
 * is the geometric mean of p99.9 of the lower and p0.1 of the upper band (blocks of at least `dipSec`)
 * when they do not overlap, otherwise the valley; every boundary has to lie in a valley when any one
 * unit is left out. All rules are relative: the result does not depend on the unit of the values.
 *
 * @param units - Runs or day sections
 * @param runLimit - Run level (unit of the values)
 * @param opts - Options
 * @returns bands from low to high
 */
export function learnBands(units: readonly Unit[], runLimit: number, opts: BandOptions): Band[] {
	if (!(runLimit > 0)) {
		return [];
	}
	const dipMs = Math.max(0, opts.dipSec) * 1000;
	const held = units.map(heldOf);
	const levels = opts.mode === "raw" ? held : units.map(medianOf);
	let maxBin = -1;
	for (const lv of levels) {
		for (const v of lv.v) {
			if (v > runLimit) {
				maxBin = Math.max(maxBin, binOf(v, runLimit));
			}
		}
	}
	if (maxBin < 0) {
		return [];
	}
	const perUnit = levels.map(lv => {
		const h = new Float64Array(maxBin + 1);
		lv.v.forEach((v, i) => {
			if (v > runLimit) {
				h[binOf(v, runLimit)] += lv.d[i];
			}
		});
		return h;
	});
	const hist = new Float64Array(maxBin + 1);
	for (const h of perUnit) {
		h.forEach((x, i) => (hist[i] += x));
	}
	const peaks = peaksOf(hist);
	const cuts: number[] = [];
	for (let k = 0; k + 1 < peaks.length; k++) {
		cuts.push(valleyOf(hist, peaks[k], peaks[k + 1]));
	}
	let edges: number[] = [];
	for (;;) {
		const valleyEdges = cuts.map(c => edgeOf(c, runLimit));
		const st = statsOf(levels, runLimit, valleyEdges, dipMs);
		const total = st.time.reduce((s, x) => s + x, 0);
		// bands that are too rare: the weakest goes into the neighbour with the shallower valley
		const weak = st.time
			.map((t, k) => ({ k, t }))
			.filter(({ k, t }) => !recurring(st, k) && t < KEEP_SHARE * total)
			.sort((a, b) => a.t - b.t);
		if (weak.length > 0 && cuts.length > 0) {
			const k = weak[0].k;
			const left = k > 0 ? k - 1 : -1;
			const right = k < cuts.length ? k : -1;
			const drop = left < 0 ? right : right < 0 ? left : hist[cuts[left]] >= hist[cuts[right]] ? left : right;
			cuts.splice(drop, 1);
			continue;
		}
		// neighbours that change into each other within a block are one band
		const change = cuts.findIndex((_, k) => changeWithin(st, k));
		if (change >= 0) {
			cuts.splice(change, 1);
			continue;
		}
		edges = boundariesOf(levels, held, st, cuts, valleyEdges, hist, runLimit, dipMs);
		const failed = edges.findIndex((e, k) => !inValleyLoo(hist, perUnit, edges, k, runLimit, e));
		if (failed >= 0) {
			cuts.splice(failed, 1);
			continue;
		}
		break;
	}
	const st = statsOf(levels, runLimit, edges, dipMs);
	const total = st.time.reduce((s, x) => s + x, 0);
	return st.time.map((t, k) => ({
		id: `b${k + 1}`,
		min: k === 0 ? runLimit : edges[k - 1],
		max: k < edges.length ? edges[k] : Number.POSITIVE_INFINITY,
		segments: st.segs[k].reduce((s, x) => s + x, 0),
		activeShare: total > 0 ? t / total : 0,
	}));
}

/**
 * Boundaries between neighbouring bands: geometric mean of p99.9 of the lower and p0.1 of the upper
 * band, the valley when they overlap or the mean leaves the neighbours. The quantiles use the stored
 * (held) values inside the blocks of at least `dipMs` of each band, within the range of the pair.
 *
 * @param levels - Levels per unit
 * @param held - Held values per unit
 * @param st - Statistics for the valley edges
 * @param cuts - Valley classes
 * @param valleyEdges - Edges in the valleys
 * @param hist - Histogram
 * @param runLimit - Run level
 * @param dipMs - Shortest block for the quantiles
 */
function boundariesOf(
	levels: readonly Levels[],
	held: readonly Levels[],
	st: BandStats,
	cuts: readonly number[],
	valleyEdges: readonly number[],
	hist: Float64Array,
	runLimit: number,
	dipMs: number,
): number[] {
	const values: [number, number][][] = valleyEdges.concat(0).map(() => []);
	st.blocks.forEach((bl, u) => {
		const lv = levels[u];
		const raw = held[u];
		let j = 0;
		for (const b of bl) {
			if (b.lab < 0 || b.d < dipMs) {
				continue;
			}
			const from = lv.t[b.i0];
			const to = lv.t[b.i1] + lv.d[b.i1];
			while (j < raw.t.length && raw.t[j] + raw.d[j] <= from) {
				j++;
			}
			for (let i = j; i < raw.t.length && raw.t[i] < to; i++) {
				const d = Math.min(to, raw.t[i] + raw.d[i]) - Math.max(from, raw.t[i]);
				if (d > 0 && raw.v[i] > runLimit) {
					values[b.lab].push([raw.v[i], d]);
				}
			}
		}
	});
	const out: number[] = [];
	valleyEdges.forEach((valley, k) => {
		const below = k > 0 ? valleyEdges[k - 1] : runLimit;
		const above = k + 1 < valleyEdges.length ? valleyEdges[k + 1] : Number.POSITIVE_INFINITY;
		const inPair = (x: [number, number]): boolean => x[0] > below && x[0] < above;
		const hi = weightedQuantile(values[k].filter(inPair), 1 - Q_EDGE);
		const lo = weightedQuantile(values[k + 1].filter(inPair), Q_EDGE);
		const geo = Math.sqrt(hi * lo);
		const floor = k > 0 ? out[k - 1] : runLimit;
		const ok = hi < lo && geo > floor && geo < above && hist[binOf(geo, runLimit)] <= hist[cuts[k]] * PEAK_RATIO;
		out.push(ok ? geo : valley);
	});
	return out;
}

/**
 * Whether boundary `k` lies in a valley of the histogram when any one unit is left out.
 *
 * @param hist - Histogram of all units
 * @param perUnit - Histogram per unit
 * @param edges - Band edges
 * @param k - Boundary
 * @param runLimit - Run level
 * @param e - Value of the boundary
 */
function inValleyLoo(
	hist: Float64Array,
	perUnit: readonly Float64Array[],
	edges: readonly number[],
	k: number,
	runLimit: number,
	e: number,
): boolean {
	const at = binOf(e, runLimit);
	const lo = k > 0 ? binOf(edges[k - 1], runLimit) : 0;
	const hi = k + 1 < edges.length ? binOf(edges[k + 1], runLimit) : hist.length - 1;
	for (const h of perUnit) {
		let peakA = 0;
		let peakB = 0;
		for (let i = lo; i < at; i++) {
			peakA = Math.max(peakA, hist[i] - h[i]);
		}
		for (let i = at + 1; i <= hi; i++) {
			peakB = Math.max(peakB, hist[i] - h[i]);
		}
		const valley = hist[at] - h[at];
		if (!(Math.min(peakA, peakB) > 0 && Math.min(peakA, peakB) >= PEAK_RATIO * valley)) {
			return false;
		}
	}
	return true;
}

/**
 * Index of the band of a value (-1: at or below the run level or no band).
 *
 * @param bands - Bands
 * @param val - Value
 */
function bandIndex(bands: readonly Band[], val: number): number {
	if (bands.length === 0 || !(val > bands[0].min)) {
		return -1;
	}
	return bands.findIndex(b => val >= b.min && val < b.max);
}

/**
 * Hold times (time until the next stored value) per band; only bands with values from at least 3
 * units and at least 30 hold times. Units built from the tick series have no hold times.
 *
 * @param units - Runs or day sections
 * @param bands - Bands
 */
export function holdProfile(units: readonly Unit[], bands: readonly Band[]): HoldProfile[] {
	const holds = bands.map(() => [] as number[]);
	const seen = bands.map(() => new Set<number>());
	units.forEach((u, n) => {
		if (u.fromTicks) {
			return;
		}
		for (let i = 0; i + 1 < u.points.length; i++) {
			const k = bandIndex(bands, u.points[i].val);
			if (k >= 0) {
				holds[k].push((u.points[i + 1].ts - u.points[i].ts) / 1000);
				seen[k].add(n);
			}
		}
	});
	const out: HoldProfile[] = [];
	bands.forEach((b, k) => {
		const h = holds[k];
		if (seen[k].size < HOLD_MIN_UNITS || h.length < HOLD_MIN_N) {
			return;
		}
		h.sort((x, y) => x - y);
		const p99Sec = h[Math.min(h.length - 1, Math.max(0, Math.ceil(0.99 * h.length) - 1))];
		out.push({ band: b.id, p99Sec, suspectSec: Math.max(SUSPECT_MIN_SEC, SUSPECT_FACTOR * p99Sec), n: h.length });
	});
	return out;
}

/**
 * Base bands and hold time profile of a device.
 *
 * @param units - Runs or day sections
 * @param runLimit - Run level (unit of the values)
 * @param opts - Options (default: moving 60-s median, dips up to 60 s)
 */
export function baseBandsOf(
	units: readonly Unit[],
	runLimit: number,
	opts: BandOptions = DEFAULT_BAND_OPTIONS,
): BaseBands {
	const bands = learnBands(units, runLimit, opts);
	return { bands, holds: holdProfile(units, bands), units: units.length, runLimit, opts: { ...opts } };
}

/**
 * Band of a value, or null (at or below the run level).
 *
 * @param b - Base bands
 * @param val - Value
 */
export function bandOf(b: BaseBands, val: number): Band | null {
	const k = bandIndex(b.bands, val);
	return k >= 0 ? b.bands[k] : null;
}

/**
 * Suspect limit for a value held this long, or null without a hold time profile for its band.
 *
 * @param b - Base bands
 * @param val - Held value
 */
export function suspectLimitOf(b: BaseBands, val: number): number | null {
	const band = bandOf(b, val);
	return (band && b.holds.find(h => h.band === band.id)?.suspectSec) ?? null;
}

/**
 * Own segments of a unit in the base bands (blocks of at least `dipSec`, shorter blocks between two
 * blocks of the same band bridged), in order: band index (0 = lowest band) and duration in ms. Empty
 * without bands.
 *
 * @param u - Run or day section
 * @param b - Base bands
 * @param coreTo - Up to this time in ms (default: end of the unit)
 */
export function bandSegmentsOf(u: Unit, b: BaseBands, coreTo = u.to): { band: number; ms: number }[] {
	if (b.bands.length === 0) {
		return [];
	}
	const core: Unit = { points: u.points, from: u.from, to: Math.max(u.from, Math.min(u.to, coreTo)) };
	const lv = b.opts.mode === "raw" ? heldOf(core) : medianOf(core);
	const dipMs = Math.max(0, b.opts.dipSec) * 1000;
	const edges = b.bands.slice(1).map(x => x.min);
	return blocksOf(lv, b.runLimit, edges, dipMs)
		.filter(bl => bl.lab >= 0 && bl.d >= dipMs)
		.map(bl => ({ band: bl.lab, ms: bl.d }));
}

/**
 * Programme group features of a run from the base bands (Spec B.5 step 9): time in the highest band
 * and number of own segments in the band of the final block (the last own segment in a band up to
 * `coreTo`). Null without bands.
 *
 * @param u - Run
 * @param b - Base bands
 * @param coreTo - End of the programme in ms (default: end of the unit, i.e. with the trailer)
 */
export function bandFeaturesOf(
	u: Unit,
	b: BaseBands,
	coreTo = u.to,
): { topBandSec: number; finalBandBlocks: number } | null {
	if (b.bands.length === 0) {
		return null;
	}
	const core: Unit = { points: u.points, from: u.from, to: Math.max(u.from, Math.min(u.to, coreTo)) };
	const lv = b.opts.mode === "raw" ? heldOf(core) : medianOf(core);
	const dipMs = Math.max(0, b.opts.dipSec) * 1000;
	const edges = b.bands.slice(1).map(x => x.min);
	const top = b.bands.length - 1;
	let topMs = 0;
	for (const bl of blocksOf(lv, b.runLimit, edges, dipMs)) {
		if (bl.lab === top) {
			topMs += bl.d;
		}
	}
	const own = bandSegmentsOf(u, b, coreTo).map(x => x.band);
	const last = own.at(-1);
	return { topBandSec: topMs / 1000, finalBandBlocks: last === undefined ? 0 : own.filter(x => x === last).length };
}
