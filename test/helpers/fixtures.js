// Real-data fixtures (neutral times) and helpers to replay and damage them.
import { readFileSync } from "node:fs";
import { createDetector } from "../../build/lib/detector/index.js";
import { buildLayout } from "../../build/lib/learn/runs.js";
import { fromPoints } from "../../build/lib/learn/ticks.js";

/** Start of every fixture (neutral, like `washerAntiCrease.json`). */
export const BASE_TS = 1_700_000_000_000;

const MIN = 60_000;
const cache = new Map();

/**
 * Fixture file.
 *
 * @param {"washer30d" | "dryer" | "boiler4d"} name fixture
 * @returns {{ note: string, runs: { id: string, fromSec: number }[], points: [number, number][] }} content
 */
function file(name) {
	let f = cache.get(name);
	if (!f) {
		f = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
		cache.set(name, f);
	}
	return f;
}

/**
 * Whole recording of a device.
 *
 * @param {"washer30d" | "dryer" | "boiler4d"} name fixture
 * @returns {{ ts: number, val: number }[]} stored values in W
 */
export function loadSeries(name) {
	return file(name).points.map(([rel, val]) => ({ ts: BASE_TS + Math.round(rel * 1000), val }));
}

/**
 * Runs of a fixture as indexed by the evaluation (start times).
 *
 * @param {"washer30d" | "dryer" | "boiler4d"} name fixture
 * @returns {{ id: string, ts: number }[]} index
 */
export function runIndex(name) {
	return file(name).runs.map(r => ({ id: r.id, ts: BASE_TS + Math.round(r.fromSec * 1000) }));
}

/**
 * Tick series and layout of stored values.
 *
 * @param {{ ts: number, val: number }[]} points stored values in W
 * @param {number} [stepMs] poll interval
 * @param {object} [opts] layout options
 * @returns {{ s: object, L: object }} series and layout
 */
export function layoutOf(points, stepMs = 10_000, opts = {}) {
	const s = fromPoints(points, stepMs);
	return { s, L: buildLayout(s, opts) };
}

/**
 * Layout run of a fixture whose start lies within 5 min of the index entry.
 *
 * @param {"washer30d" | "dryer" | "boiler4d"} name fixture
 * @param {string} id run id, e.g. `w01`
 * @param {number} [stepMs] poll interval
 * @returns {{ info: object, s: object, L: object, idx: number }} run, series, layout, index into `L.runs`
 */
export function layoutRun(name, id, stepMs = 10_000) {
	const entry = runIndex(name).find(r => r.id === id);
	if (!entry) {
		throw new Error(`no run ${id} in ${name}`);
	}
	const key = `${name}/${stepMs}`;
	let lay = cache.get(key);
	if (!lay) {
		lay = layoutOf(loadSeries(name), stepMs);
		cache.set(key, lay);
	}
	const { s, L } = lay;
	const idx = L.runs.findIndex(r => Math.abs(s.t0 + r.from * s.stepMs - entry.ts) <= 5 * MIN);
	if (idx < 0) {
		throw new Error(`run ${id} of ${name} is not in the layout`);
	}
	return { info: L.runs[idx], s, L, idx };
}

/**
 * Values on the poll grid (last value at or before the tick, missing = 0), like the replay of the
 * evaluation scripts.
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} [stepMs] poll interval
 * @param {number} [t0] time of tick 0 (default: first value)
 * @returns {number[]} one value per tick
 */
export function ticksOf(points, stepMs = 10_000, t0) {
	const s = fromPoints(points, stepMs);
	if (t0 === undefined || t0 === s.t0) {
		return Array.from({ length: s.length }, (_, i) => (Number.isFinite(s.last[i]) ? s.last[i] : 0));
	}
	const sorted = [...points].sort((a, b) => a.ts - b.ts);
	const end = sorted.at(-1).ts;
	const n = Math.floor((end - t0) / stepMs) + 2;
	const out = new Array(Math.max(0, n)).fill(0);
	let j = -1;
	for (let i = 0; i < n; i++) {
		const t = t0 + i * stepMs;
		while (j + 1 < sorted.length && sorted[j + 1].ts <= t) {
			j++;
		}
		out[i] = j >= 0 ? sorted[j].val : 0;
	}
	return out;
}

/**
 * Feed values to the real detector, one tick per value.
 *
 * @param {number[]} values power per tick
 * @param {object} settings detection settings
 * @param {object} [o] options
 * @param {number} [o.pollSec] poll interval in s (10)
 * @param {boolean} [o.abort] abort detection
 * @param {boolean} [o.abortFixed] corrected abort detection
 * @param {(i: number) => boolean} [o.switchOff] switch state per tick
 * @param {number} [o.resumeLockAt] start in the lock phase (time of the early end)
 * @param {boolean} [o.timedFeed] in mode timed `feed` only on a changed value (default true)
 * @returns {{ ev: { e: string, i: number, at: number, exit: string | null }[], ticks: { status: string | null, settling: boolean }[], det: object }} events, one entry per tick, detector
 */
export function detectorRun(values, settings, o = {}) {
	const { pollSec = 10, abort = false, abortFixed = false, switchOff = () => false, timedFeed = true } = o;
	const det = createDetector(settings, { pollSec, abort, abortFixed, resumeLockAt: o.resumeLockAt });
	const ev = [];
	const ticks = [];
	const take = (res, i, now) => {
		res.events.forEach((e, k) => {
			ev.push({ e, i, at: res.times?.[k] ?? now, exit: det.finalExit ?? null });
		});
	};
	let prev = null;
	values.forEach((v, i) => {
		const now = i * pollSec * 1000;
		if (settings.mode === "timed" && timedFeed && det.feed && v !== prev) {
			take(det.feed(v, now), i, now);
		}
		prev = v;
		const res = det.tick(v, now, { switchOff: switchOff(i) });
		take(res, i, now);
		ticks.push({ status: res.status, settling: det.settling ?? false });
	});
	return { ev, ticks, det };
}

/**
 * Stored values of one run: 30 min before the start to 3 h after the core end (the held value is set
 * at both borders, so the window is a complete recording).
 *
 * @param {"washer30d" | "dryer" | "boiler4d"} name fixture
 * @param {string} id run id
 * @returns {{ ts: number, val: number }[]} stored values
 */
export function runWindow(name, id) {
	const { info, s } = layoutRun(name, id);
	const from = s.t0 + info.from * s.stepMs - 30 * MIN;
	const to = s.t0 + info.coreEnd * s.stepMs + 180 * MIN;
	const all = loadSeries(name);
	const win = all.filter(p => p.ts >= from && p.ts <= to);
	// the logger stores changes only: the held value at both borders keeps the window self-contained
	const before = all.findLast(p => p.ts < from);
	const after = win.at(-1) ?? before;
	return [
		...(before && (win.length === 0 || win[0].ts > from) ? [{ ts: from, val: before.val }] : []),
		...win,
		...(after && (win.at(-1)?.ts ?? from) < to ? [{ ts: to, val: after.val }] : []),
	];
}

/**
 * Windows one after the other, the start of window k at `everyMs * k` after the first one.
 *
 * @param {{ ts: number, val: number }[][]} windows windows of stored values
 * @param {number} everyMs distance between the window starts
 * @returns {{ ts: number, val: number }[]} one timeline
 */
export function timelineOf(windows, everyMs) {
	const base = windows[0][0].ts;
	return windows.flatMap((w, k) => w.map(p => ({ ts: p.ts - w[0].ts + base + k * everyMs, val: p.val })));
}

/**
 * Held value sampled densely.
 *
 * @param {{ ts: number, val: number }[]} points stored values (sorted)
 * @param {number} fromMs first time
 * @param {number} toMs end (exclusive)
 * @param {number} everyMs distance
 * @returns {{ ts: number, val: number }[]} resampled values in [fromMs, toMs)
 */
export function resample(points, fromMs, toMs, everyMs) {
	const out = [];
	let j = -1;
	for (let t = fromMs; t < toMs; t += everyMs) {
		while (j + 1 < points.length && points[j + 1].ts <= t) {
			j++;
		}
		if (j >= 0) {
			out.push({ ts: t, val: points[j].val });
		}
	}
	return out;
}

/**
 * Seeded random numbers 0..1.
 *
 * @param {number} seed seed
 * @returns {() => number} generator
 */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Drop a share of the values (random).
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} share share 0..1 to drop
 * @param {number} seed seed
 * @returns {{ ts: number, val: number }[]} remaining values
 */
export function dropRandom(points, share, seed) {
	const r = rng(seed);
	return points.filter(() => r() >= share);
}

/**
 * Multiply every value.
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} factor factor
 * @returns {{ ts: number, val: number }[]} scaled values
 */
export function scale(points, factor) {
	return points.map(p => ({ ts: p.ts, val: p.val * factor }));
}

/**
 * Shift every value in time.
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} ms shift
 * @returns {{ ts: number, val: number }[]} shifted values
 */
export function shift(points, ms) {
	return points.map(p => ({ ts: p.ts + ms, val: p.val }));
}

/**
 * The 72 scenarios of an early end followed by unloading and a new start (evaluation `y_actexit.mjs`):
 * run A = w01, run B = w03; B cold (values from 1500 W become 60 W) or warm; display level and rest
 * value after the unloading; minutes between the core end of A and the end of the A part; gap ticks.
 *
 * @returns {{ key: string, values: number[], aEnd: number, bOn: number, restVal: number, cold: boolean, lvl: number, unload: number, gapTicks: number }[]} scenarios
 */
export function restartScenarios() {
	const a = layoutRun("washer30d", "w01");
	const b = layoutRun("washer30d", "w03");
	const s = a.s;
	const seg = (x, y) => {
		const o = [];
		for (let i = x; i <= y; i++) {
			o.push(Number.isFinite(s.last[i]) ? s.last[i] : 0);
		}
		return o;
	};
	const out = [];
	for (const cold of [false, true]) {
		for (const [lvl, restVal] of [
			[0, 5.5],
			[5, 5.5],
			[5, 1],
		]) {
			for (const unload of [5, 10, 20]) {
				for (const gapTicks of [3, 6, 18, 36]) {
					const av = seg(a.info.from - 30, a.info.coreEnd + unload * 6);
					let bv = seg(b.info.from - 3, b.info.to + 200);
					if (cold) {
						bv = bv.map(v => (v >= 1500 ? 60 : v));
					}
					out.push({
						key: `${cold ? "cold" : "warm"}/${lvl}/${restVal}/${unload}/${gapTicks}`,
						values: [...av, ...new Array(gapTicks).fill(lvl), ...bv],
						aEnd: 30 + (a.info.coreEnd - a.info.from),
						bOn: av.length + gapTicks + 3,
						restVal,
						cold,
						lvl,
						unload,
						gapTicks,
					});
				}
			}
		}
	}
	return out;
}

/**
 * Remove the values of a stretch (logger or connection failure).
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} atMs start
 * @param {number} minutes length
 * @returns {{ ts: number, val: number }[]} values without the stretch
 */
export function withGap(points, atMs, minutes) {
	return points.filter(p => p.ts < atMs || p.ts >= atMs + minutes * MIN);
}

/**
 * Replace a stretch by one value (the logger stores changes only, the value stays).
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} atMs start
 * @param {number} minutes length
 * @param {number} val the one value in W
 * @returns {{ ts: number, val: number }[]} values
 */
export function withHold(points, atMs, minutes, val) {
	return [...points.filter(p => p.ts < atMs || p.ts >= atMs + minutes * MIN), { ts: atMs, val }].sort(
		(a, b) => a.ts - b.ts,
	);
}

/**
 * Add a foreign load to a stretch.
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} atMs start
 * @param {number} minutes length
 * @param {number} addW added power in W
 * @returns {{ ts: number, val: number }[]} values
 */
export function withForeign(points, atMs, minutes, addW) {
	return points.map(p => (p.ts >= atMs && p.ts < atMs + minutes * MIN ? { ts: p.ts, val: p.val + addW } : p));
}

/**
 * Insert single-value spikes at random times: one report of the spike, then the value held before (the logger
 * stores the next report as a change one poll later).
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} n number of spikes
 * @param {number} valW value of a spike in W
 * @param {number} seed seed
 * @returns {{ ts: number, val: number }[]} values
 */
export function withSpikes(points, n, valW, seed) {
	const r = rng(seed);
	const from = points[0].ts;
	const span = points.at(-1).ts - from;
	const out = [...points];
	for (let k = 0; k < n; k++) {
		const ts = from + Math.floor(r() * span);
		// one report: the logger stores the next value (the one held before) one poll later
		const held = points.findLast(p => p.ts <= ts)?.val ?? 0;
		out.push({ ts, val: valW });
		if (!points.some(p => p.ts > ts && p.ts <= ts + 10_000)) {
			out.push({ ts: ts + 10_000, val: held });
		}
	}
	return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Values in kW instead of W.
 *
 * @param {{ ts: number, val: number }[]} points stored values in W
 * @returns {{ ts: number, val: number }[]} values in kW
 */
export function asKw(points) {
	return points.map(p => ({ ts: p.ts, val: p.val / 1000 }));
}

/**
 * Repeat unchanged values (a logger that stores every poll).
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} everyMs distance between the repeated values
 * @returns {{ ts: number, val: number }[]} values
 */
export function withRelog(points, everyMs) {
	const out = [];
	points.forEach((p, i) => {
		out.push(p);
		const next = points[i + 1]?.ts ?? p.ts;
		for (let t = p.ts + everyMs; t < next; t += everyMs) {
			out.push({ ts: t, val: p.val });
		}
	});
	return out;
}

/**
 * Keep only every n-th value (sparse logger).
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} keepEvery keep every n-th value
 * @returns {{ ts: number, val: number }[]} values
 */
export function sparse(points, keepEvery) {
	return points.filter((_, i) => i % keepEvery === 0);
}

/**
 * Set every value of a stretch to one value.
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} fromMs start
 * @param {number} toMs end (exclusive)
 * @param {number} val value in W
 * @returns {{ ts: number, val: number }[]} values
 */
export function bridge(points, fromMs, toMs, val) {
	return points.map(p => (p.ts >= fromMs && p.ts < toMs ? { ts: p.ts, val } : p));
}

/**
 * Recording of a manual test: 30 min of 0.5 W, the load, 30 min of 0.5 W (one value per 10 s).
 *
 * @param {number} atMs start of the load
 * @param {number} minutes length of the load
 * @param {number} valW load in W
 * @returns {{ ts: number, val: number }[]} stored values
 */
export function handTest(atMs, minutes, valW) {
	const out = [];
	for (let t = atMs - 30 * MIN; t < atMs + (minutes + 30) * MIN; t += 10_000) {
		out.push({ ts: t, val: t >= atMs && t < atMs + minutes * MIN ? valW : 0.5 });
	}
	return out;
}

/**
 * Cut the anti-crease phase: 0 W for 60 min from a time on.
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {number} atMs start of the cut
 * @returns {{ ts: number, val: number }[]} values
 */
export function cutTrailer(points, atMs) {
	const rest = points.filter(p => p.ts < atMs || p.ts >= atMs + 60 * MIN);
	return [...rest, { ts: atMs, val: 0 }].sort((a, b) => a.ts - b.ts);
}
