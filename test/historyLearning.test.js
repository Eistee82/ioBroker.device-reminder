import assert from "node:assert";
import { DEFAULT_TYPES } from "../build/lib/config.js";
import { analyzeHistory, pickMode } from "../build/lib/historyLearning.js";
import { CHUNK_CAP, findHistoryInstance, loadHistorySeries, MAX_QUERIES } from "../build/lib/historySource.js";
import { dishwasher, dryer, washingMachine as wm } from "./helpers/curves.js";
import {
	dishwasherLongDrying,
	dryerAntiCrease,
	historyOf,
	longPause,
	runEnds,
	runStarts,
	shortRun,
	steadyHeat,
	times,
	zeroTail,
} from "./helpers/history.js";
import { replay } from "./helpers/replay.js";

const START = 1_700_000_000_000;
const HOUR = 3_600_000;

/**
 * Assert that every run got exactly one end, not before the run end and at most `maxDelay` later.
 *
 * @param {number[]} finishedAt timestamps of the reported ends
 * @param {number[]} ends real ends of the runs
 * @param {number} maxDelaySec longest allowed delay per run (array or number)
 * @returns {number[]} delay per run in s
 */
function delaysOf(finishedAt, ends, maxDelaySec) {
	assert.strictEqual(finishedAt.length, ends.length, `ends ${JSON.stringify(finishedAt)}`);
	return ends.map((end, i) => {
		const delay = (finishedAt[i] - end) / 1000;
		const max = Array.isArray(maxDelaySec) ? maxDelaySec[i] : maxDelaySec;
		assert.ok(delay >= 0 && delay <= max, `run ${i}: delay ${delay} s, max ${max} s`);
		return delay;
	});
}

const chosenOf = s => s.evaluation.find(e => e.mode === s.mode);
const evalOf = (mode, detected, falseStarts, endDelaySec) => ({
	mode,
	detected,
	runs: 5,
	falseStarts,
	endDelaySec,
	endDelayMaxSec: endDelaySec,
});

describe("learning from the history", () => {
	const runsA = [wm, longPause, shortRun, wm];

	it("A: a long soaking pause at a lower level delays only itself (pause protection by level)", async () => {
		const points = historyOf(runsA);
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 4);
		const chosen = chosenOf(s);
		assert.deepStrictEqual([chosen.detected, chosen.falseStarts], [4, 0]);
		assert.ok(s.pauseBelowVal > 0 && s.pauseBelowVal < 0.5, `pauseBelowVal ${s.pauseBelowVal}`);
		assert.strictEqual(s.pauseUntilSec, 0);
		assert.ok(s.pauseHoldSec >= 1340 && s.pauseHoldSec <= 2000, `pauseHoldSec ${s.pauseHoldSec}`);
		assert.ok(chosen.endDelaySec <= 360 && chosen.endDelayMaxSec <= 360, JSON.stringify(chosen));
		const r = replay(points, s);
		assert.deepStrictEqual([r.started, r.finished], [4, 4]);
		delaysOf(r.finishedAt, runEnds(runsA, 3.5), 360);
		assert.strictEqual(s.looDetected, 3);
		assert.ok(s.longestPauseSec >= 1300);
		assert.strictEqual(s.samples, points.length);
		assert.strictEqual(s.gapsDropped, 0);
	});

	it("B: the same pause at the end level is told apart by the time since the start", async () => {
		const runs = runsA.map(zeroTail);
		const points = historyOf(runs, START, { idle: 0 });
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 4);
		assert.ok(s.pauseUntilSec > 0, JSON.stringify(s));
		assert.strictEqual(s.pauseBelowVal, 0);
		const r = replay(points, s);
		assert.deepStrictEqual([r.started, r.finished], [4, 4], "no run is split");
		const delays = delaysOf(r.finishedAt, runEnds(runs, 2), [360, 360, s.pauseHoldSec + 120, 360]);
		assert.ok(delays.reduce((a, b) => a + b, 0) / delays.length <= 720, `delays ${delays}`);
		assert.strictEqual(s.looDetected, 3);
	});

	it("C: anti-crease bursts of a dryer belong to the run and start nothing", async () => {
		const runs = [dryerAntiCrease, dryerAntiCrease, dryerAntiCrease];
		const points = historyOf(runs);
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 3);
		assert.ok(s.durationSec < 1800, `durationSec ${s.durationSec}`);
		if (s.mode === "count") {
			assert.ok(s.thresholds.startCount >= 3);
		} else {
			assert.ok(s.startDurationSec >= 30);
		}
		assert.ok(chosenOf(s).endDelaySec <= 360);
		const r = replay(points, s);
		assert.deepStrictEqual([r.started, r.finished], [3, 3]);
		const coreEnds = runStarts(runs).map(t => t + 152 * 10_000);
		delaysOf(r.finishedAt, coreEnds, 360);
	});

	it("D: a long drying phase of a dishwasher belongs to the run", async () => {
		const runs = [dishwasherLongDrying, dishwasherLongDrying, dishwasherLongDrying];
		const points = historyOf(runs, START, { idle: 0.3 });
		// the current dishwasher type (endVal 0.25 W) keeps running while drying at 1 W
		const s = await analyzeHistory(points, 10, { currentType: DEFAULT_TYPES.find(t => t.id === "dishwasher") });
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 3);
		const coreSec = (238 - 3 - 1) * 10;
		assert.ok(s.durationSec >= coreSec + 3600 - 60, `durationSec ${s.durationSec}`);
		assert.ok(s.thresholds.endVal >= 0.5 && s.thresholds.endVal < 1, `endVal ${s.thresholds.endVal}`);
		const r = replay(points, s);
		assert.strictEqual(r.started, 3);
		delaysOf(r.finishedAt, runEnds(runs, 0.6, START, {}), 360);
	});

	it("D2: a short raised level after the end (display) is no part of the run", async () => {
		const runs = [dishwasher, dishwasher, dishwasher];
		const s = await analyzeHistory(historyOf(runs), 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.ok(s.durationSec <= (238 - 3) * 10, `durationSec ${s.durationSec}`);
		assert.ok(chosenOf(s).endDelaySec <= 360);
	});

	it("D3: a long display phase after the end is no part of the run unless the current type runs there", async () => {
		// 25 min display at 1.5 W after the end, then 0.3 W
		const run = [...wm.slice(0, 203), ...times(1.5, 150), ...times(0.3, 100)];
		const runs = [run, run, run];
		const points = historyOf(runs, START, { idle: 0.3 });
		const ends = runEnds(runs, 5);
		for (const currentType of [undefined, DEFAULT_TYPES.find(t => t.id === "washing-machine")]) {
			const s = await analyzeHistory(points, 10, { currentType });
			assert.ok(!("error" in s), JSON.stringify(s));
			assert.ok(s.durationSec < 2100, `durationSec ${s.durationSec}`);
			const r = replay(points, s);
			assert.strictEqual(r.started, 3);
			delaysOf(r.finishedAt, ends, 360);
		}
		// with the dishwasher type (endVal 0.25 W) the phase belongs to the run as before
		const dish = await analyzeHistory(points, 10, { currentType: DEFAULT_TYPES.find(t => t.id === "dishwasher") });
		assert.ok(dish.durationSec >= 2030 + 1500 - 60, `durationSec ${dish.durationSec}`);
	});

	it("D4: the electronics between anti-crease bursts is no drying phase", async () => {
		// bursts every 5 min for 30 min, 2 W in between, idle 0.2 W
		const run = [
			...dryer.slice(0, 153),
			...Array.from({ length: 6 }, () => [...times(2, 28), 400, 400]).flat(),
			...times(0.2, 200),
		];
		const runs = [run, run, run];
		const points = historyOf(runs, START, { idle: 0.2 });
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 3);
		assert.ok(s.durationSec < 1600, `durationSec ${s.durationSec}`);
		const r = replay(points, s);
		assert.strictEqual(r.started, 3);
		const coreEnds = runStarts(runs, START).map(t => t + 152 * 10_000);
		const delays = delaysOf(r.finishedAt, coreEnds, 360);
		assert.ok(chosenOf(s).endDelayMaxSec >= Math.max(...delays) - 10, "the dialog shows the real delay");
	});

	it("E: plugs that only report changes (deadband) are no gaps", async () => {
		const runs = [steadyHeat, wm, dryer];
		const points = historyOf(runs, START, { relog: false, deadband: 2 });
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 3);
		assert.strictEqual(s.gapsDropped, 0);
		for (const mode of ["timed", "count"]) {
			assert.strictEqual(s.evaluation.find(e => e.mode === mode).detected, 3, mode);
		}
		const r = replay(points, s);
		assert.deepStrictEqual([r.started, r.finished], [3, 3]);
		const withDelta = await analyzeHistory(points, 10, { minDelta: 5 });
		assert.ok(withDelta.thresholds.endVal >= 0.5 + 5, `endVal ${withDelta.thresholds.endVal}`);
	});

	it("F: two runs shortly after each other are split by the level between them", async () => {
		const between = [times(0.5, 72)];
		const points = historyOf([wm, wm, longPause], START, { between });
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 3, "split after 12 min, the long pause is not split");
		assert.strictEqual(chosenOf(s).detected, 3);
		assert.deepStrictEqual(replay(points, s).started, 3);

		const same = historyOf([zeroTail(wm), wm, longPause], START, { between: [times(0, 72)] });
		const t = await analyzeHistory(same, 10);
		assert.strictEqual(t.runs, 2, "no split without a different level");
		assert.strictEqual(chosenOf(t).detected, 2);
	});

	it("F2: runs 10 min apart are split when the pauses inside a run are above the level after an end", async () => {
		// electronics at 2 W during the pauses, 0.3 W after the end
		const run = wm.map(v => (v === 0 ? 2 : v === 0.5 ? 0.3 : v));
		const runs = [run, run, run, run];
		const o = { idle: 0.3, between: [undefined, times(0.3, 60)] };
		const points = historyOf(runs, START, o);
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 4, "the pair is split");
		assert.strictEqual(s.pauseHoldSec, 0, "the time between the pair is no pause");
		const r = replay(points, s);
		assert.deepStrictEqual([r.started, r.finished], [4, 4]);
		delaysOf(r.finishedAt, runEnds(runs, 2.5, START, o), 360);
	});

	it("G: a run with a gap in the history is dropped, the others are detected", async () => {
		const runs = [wm, wm, wm, wm];
		const gapAt = runStarts(runs)[1] + (3 + 120) * 10_000;
		const points = historyOf(runs).filter(p => p.ts < gapAt || p.ts >= gapAt + 4 * HOUR);
		points.push({ ts: gapAt, val: 1500 });
		points.sort((a, b) => a.ts - b.ts);
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.ok(s.gapsDropped >= 1);
		assert.strictEqual(s.runs, 3);
		const chosen = chosenOf(s);
		assert.deepStrictEqual([chosen.detected, chosen.falseStarts], [3, 0]);
	});

	it("H: a state in kW learns the same type in kW", async () => {
		const points = historyOf(runsA);
		const w = await analyzeHistory(points, 10);
		const kw = await analyzeHistory(
			points.map(p => ({ ts: p.ts, val: p.val / 1000 })),
			10,
			{ unitFactor: 1000 },
		);
		assert.strictEqual(kw.mode, w.mode);
		assert.strictEqual(kw.thresholds.startCount, w.thresholds.startCount);
		assert.strictEqual(kw.thresholds.endCount, w.thresholds.endCount);
		for (const key of ["startVal", "endVal", "standby"]) {
			const expected = w.thresholds[key] / 1000;
			assert.ok(Math.abs(kw.thresholds[key] - expected) <= expected * 0.01, key);
		}
	});

	it("H2: a state in kW is replayed in kW (rounding of the count mode)", async () => {
		// pauses at 4 W: in kW the count mode rounds every average below 5 W to 0.00
		const lp4 = [...wm.slice(0, 80), ...times(4, 120), ...wm.slice(80)].map(v => (v === 0 ? 4 : v));
		const wm4 = wm.map(v => (v === 0 ? 4 : v));
		const points = historyOf([wm4, lp4, wm4, wm4]).map(p => ({ ts: p.ts, val: p.val / 1000 }));
		const s = await analyzeHistory(points, 10, { unitFactor: 1000 });
		assert.ok(!("error" in s), JSON.stringify(s));
		const chosen = chosenOf(s);
		const r = replay(points, s);
		assert.deepStrictEqual([r.started, r.finished], [chosen.detected, chosen.detected], JSON.stringify(s));
		assert.strictEqual(chosen.detected, 4);
		assert.ok(s.evaluation.find(e => e.mode === "count").detected < 4, "the dialog shows the kW rounding");
	});

	it("I: with the abort detection the learned type reports no abort", async () => {
		const points = historyOf(runsA);
		const s = await analyzeHistory(points, 10, { abort: true });
		assert.ok(!("error" in s), JSON.stringify(s));
		const r = replay(points, s, { abort: true });
		assert.strictEqual(r.aborted, 0);
		assert.deepStrictEqual([r.started, r.finished], [4, 4]);
	});

	it("J: the current device type is evaluated over the same runs", async () => {
		const washer = DEFAULT_TYPES.find(t => t.id === "washing-machine");
		const s = await analyzeHistory(historyOf(runsA), 10, { currentType: washer });
		assert.strictEqual(s.current.mode, "count");
		assert.strictEqual(s.current.runs, 4);
	});

	it("N: a negative idle level gives no negative thresholds", async () => {
		const points = historyOf([wm, wm, wm], START, { idle: -0.4 });
		const s = await analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.ok(s.thresholds.standby > 0, `standby ${s.thresholds.standby}`);
		assert.ok(s.thresholds.endVal > 0 && s.pauseBelowVal >= 0, JSON.stringify(s.thresholds));
		const r = replay(points, s);
		assert.deepStrictEqual([r.started, r.finished], [3, 3]);
	});

	it("K: evaluates all three detection modes", async () => {
		const s = await analyzeHistory(historyOf([wm, longPause]), 10);
		assert.deepStrictEqual(
			s.evaluation.map(e => e.mode),
			["count", "combined", "timed"],
		);
		assert.ok(s.evaluation.every(e => e.runs === 2));
	});

	it("K: needs at least two runs", async () => {
		assert.deepStrictEqual(await analyzeHistory(historyOf([wm]), 10), { error: "tooFewRuns", runs: 1 });
		assert.deepStrictEqual(await analyzeHistory([], 10), { error: "noHistory" });
		const one = await analyzeHistory(historyOf([wm]), 10, { minRuns: 1 });
		assert.strictEqual(one.runs, 1);
	});

	it("K: ignores short spikes as runs", async () => {
		assert.strictEqual((await analyzeHistory(historyOf([wm, wm]), 10)).runs, 2);
	});

	it("L: 20 runs over 30 days are analysed within 3 s and yield regularly", async () => {
		const runs = Array.from({ length: 20 }, (_, i) => [wm, longPause, shortRun, dryer][i % 4]);
		const between = runs.map(r => times(0.5, 12_960 - r.length));
		const points = historyOf(runs, START, { between });
		let yields = 0;
		const progress = [];
		const t0 = Date.now();
		const s = await analyzeHistory(points, 10, {
			yieldFn: async () => {
				yields++;
			},
			onProgress: f => progress.push(f),
		});
		const ms = Date.now() - t0;
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 20);
		assert.ok(ms < 3000, `${ms} ms`);
		assert.ok(yields >= 10, `${yields} yields`);
		assert.ok(progress.every((f, i) => i === 0 || f >= progress[i - 1]));
		assert.strictEqual(progress.at(-1), 1);
	});
});

describe("pickMode", () => {
	it("prefers the mode that detects more runs", () => {
		assert.strictEqual(
			pickMode([evalOf("count", 4, 0, 100), evalOf("combined", 4, 0, 100), evalOf("timed", 5, 0, 900)]),
			"timed",
		);
	});

	it("prefers fewer false starts", () => {
		assert.strictEqual(
			pickMode([evalOf("count", 5, 2, 100), evalOf("combined", 5, 0, 300), evalOf("timed", 5, 1, 50)]),
			"combined",
		);
	});

	it("keeps the count mode (3.1.2) when another mode is at most a minute faster", () => {
		assert.strictEqual(
			pickMode([evalOf("count", 5, 0, 200), evalOf("combined", 5, 0, 180), evalOf("timed", 5, 0, 150)]),
			"count",
		);
		assert.strictEqual(
			pickMode([evalOf("count", 5, 0, 600), evalOf("combined", 5, 0, 580), evalOf("timed", 5, 0, 120)]),
			"timed",
		);
	});
});

/**
 * Fake installation with history instances.
 *
 * @param {object} o content
 */
function env(o = {}) {
	const calls = [];
	return {
		calls,
		object: async id => (o.objects ?? {})[id] ?? null,
		alive: async instance => (o.alive ?? []).includes(instance),
		getHistory: async (id, options) => {
			calls.push({ id, options });
			if (o.getHistory) {
				return o.getHistory(options, calls.length);
			}
			return { result: o.result ?? [] };
		},
	};
}

const historyAdapter = { common: { getHistory: true } };

/**
 * One value per second of three washing machine runs over three days, newest value 1 h before now.
 *
 * @param {number} now current time
 */
function secondData(now) {
	const start = now - 3 * 24 * HOUR;
	const out = [];
	const runAt = [5, 30, 55].map(h => start + h * HOUR);
	for (let ts = start; ts <= now - HOUR; ts += 1000) {
		let val = 0.5;
		for (const at of runAt) {
			const i = Math.floor((ts - at) / 10_000);
			if (i >= 0 && i < wm.length) {
				val = wm[i];
			}
		}
		out.push({ ts, val });
	}
	return out;
}

/**
 * History adapter answering like a database with a hard limit.
 *
 * @param {{ ts: number, val: number }[]} data stored values (sorted)
 * @param {number} [overlap] extra milliseconds returned on both sides of the range
 */
function databaseOf(data, overlap = 0) {
	const answers = [];
	return {
		answers,
		getHistory: options => {
			const from = options.start - overlap;
			const to = options.end + overlap;
			let lo = 0;
			while (lo < data.length && data[lo].ts < from) {
				lo++;
			}
			const result = [];
			for (let i = lo; i < data.length && data[i].ts <= to && result.length < options.count; i++) {
				result.push(data[i]);
			}
			answers.push(result.length);
			return { result };
		},
	};
}

const powerObject = (custom = {}, common = {}) => ({
	common: { unit: "W", role: "value.power", custom: { "history.0": { enabled: true, ...custom } }, ...common },
});

describe("history source", () => {
	it("finds the running history instance that logs the power state", async () => {
		const e = env({
			objects: {
				"plug.0.power": {
					common: {
						custom: {
							"statistics.0": { enabled: true },
							"sql.0": { enabled: true },
							"history.0": { enabled: false },
						},
					},
				},
				"system.adapter.statistics.0": { common: {} },
				"system.adapter.sql.0": historyAdapter,
				"system.adapter.history.0": historyAdapter,
			},
			alive: ["statistics.0", "sql.0", "history.0"],
		});
		assert.strictEqual(await findHistoryInstance(e, "plug.0.power"), "sql.0");
	});

	it("prefers the default history and skips stopped instances", async () => {
		const objects = {
			"plug.0.power": { common: { custom: { "history.0": { enabled: true }, "influxdb.0": { enabled: true } } } },
			"system.config": { common: { defaultHistory: "influxdb.0" } },
			"system.adapter.history.0": historyAdapter,
			"system.adapter.influxdb.0": historyAdapter,
		};
		assert.strictEqual(
			await findHistoryInstance(env({ objects, alive: ["history.0", "influxdb.0"] }), "plug.0.power"),
			"influxdb.0",
		);
		assert.strictEqual(
			await findHistoryInstance(env({ objects, alive: ["history.0"] }), "plug.0.power"),
			"history.0",
		);
		assert.strictEqual(await findHistoryInstance(env({ objects, alive: [] }), "plug.0.power"), undefined);
		assert.strictEqual(await findHistoryInstance(env(), "plug.0.power"), undefined);
	});

	it("loads the raw values day by day and with the right query", async () => {
		const now = 40 * 24 * HOUR;
		const e = env({
			objects: { "plug.0.power": powerObject() },
			result: [
				{ ts: now - 3000, val: "7.5" },
				{ ts: now - 1000, val: 2 },
				{ ts: now - 2000, val: null },
				{ ts: now - 500, val: "x" },
			],
		});
		const progress = [];
		const { series, meta } = await loadHistorySeries(e, "history.0", "plug.0.power", now, 10, f =>
			progress.push(f),
		);
		assert.strictEqual(meta.days, 30);
		assert.strictEqual(e.calls.length, 30);
		assert.strictEqual(progress.at(-1), 1);
		const { id, options } = e.calls[0];
		assert.strictEqual(id, "plug.0.power");
		assert.deepStrictEqual(
			{
				instance: options.instance,
				start: options.start,
				end: options.end,
				aggregate: options.aggregate,
				returnNewestEntries: options.returnNewestEntries,
				count: options.count,
			},
			{
				instance: "history.0",
				start: now - 24 * HOUR,
				end: now - 1,
				aggregate: "none",
				returnNewestEntries: false,
				count: CHUNK_CAP,
			},
		);
		assert.ok(series.points >= 2);
	});

	it("finds every run in values stored every second, with a hard limit per query", async () => {
		const now = 60 * 24 * HOUR;
		const data = secondData(now);
		const db = databaseOf(data);
		const e = env({ objects: { "plug.0.power": powerObject() }, getHistory: db.getHistory });
		const { series, meta } = await loadHistorySeries(e, "history.0", "plug.0.power", now, 10);
		assert.ok(Math.max(...db.answers) <= CHUNK_CAP);
		assert.ok(meta.queries <= MAX_QUERIES);
		assert.strictEqual(meta.failedChunks, 0);
		const s = await analyzeHistory(series, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 3);

		const overlapping = databaseOf(data, 1000);
		const e2 = env({ objects: { "plug.0.power": powerObject() }, getHistory: overlapping.getHistory });
		const second = await loadHistorySeries(e2, "history.0", "plug.0.power", now, 10);
		const t = await analyzeHistory(second.series, 10);
		assert.deepStrictEqual(
			[t.thresholds, t.mode, t.runs],
			[s.thresholds, s.mode, s.runs],
			"overlapping borders change nothing",
		);
	});

	it("limits the days by the retention and the poll interval", async () => {
		const now = 60 * 24 * HOUR;
		const e = env({ objects: { "plug.0.power": powerObject({ retention: 604800 }) } });
		assert.strictEqual((await loadHistorySeries(e, "history.0", "plug.0.power", now, 10)).meta.days, 7);
		const f = env({ objects: { "plug.0.power": powerObject() } });
		assert.ok((await loadHistorySeries(f, "history.0", "plug.0.power", now, 1)).meta.days <= 11);
	});

	it("reads unit and deadband of the state", async () => {
		const now = 60 * 24 * HOUR;
		const e = env({ objects: { "plug.0.power": powerObject({ changesMinDelta: "2" }, { unit: "kW" }) } });
		const { meta } = await loadHistorySeries(e, "history.0", "plug.0.power", now, 10);
		assert.deepStrictEqual([meta.unit, meta.unitFactor, meta.minDelta], ["kW", 1000, 2]);
	});

	it("rejects energy meters without a query", async () => {
		const now = 60 * 24 * HOUR;
		for (const common of [{ unit: "kWh" }, { role: "value.energy.consumed" }]) {
			const e = env({ objects: { "plug.0.power": powerObject({}, common) } });
			const { meta } = await loadHistorySeries(e, "history.0", "plug.0.power", now, 10);
			assert.strictEqual(meta.energyCounter, true);
			assert.strictEqual(e.calls.length, 0);
		}
	});

	it("keeps the oldest run when only changes are stored and no value comes before it", async () => {
		const now = 60 * 24 * HOUR;
		for (const daysAgo of [
			[10, 5],
			[10, 5, 2],
		]) {
			const data = [];
			for (const d of daysAgo) {
				const at = now - d * 24 * HOUR;
				wm.forEach((val, i) => {
					if (data.at(-1)?.val !== val) {
						data.push({ ts: at + i * 10_000, val });
					}
				});
			}
			const db = databaseOf(data);
			const e = env({ objects: { "plug.0.power": powerObject() }, getHistory: db.getHistory });
			const { series } = await loadHistorySeries(e, "history.0", "plug.0.power", now, 10);
			const s = await analyzeHistory(series, 10);
			assert.ok(!("error" in s), JSON.stringify(s));
			assert.deepStrictEqual([s.runs, s.gapsDropped], [daysAgo.length, 0]);
		}
	});

	it("goes on after a failed query", async () => {
		const now = 60 * 24 * HOUR;
		const e = env({
			objects: { "plug.0.power": powerObject() },
			getHistory: (_options, n) => {
				if (n === 2) {
					throw new Error("timeout");
				}
				return { result: [] };
			},
		});
		const { meta } = await loadHistorySeries(e, "history.0", "plug.0.power", now, 10);
		assert.strictEqual(meta.failedChunks, 1);
		assert.strictEqual(meta.queries, 30);
		assert.strictEqual(meta.error, "timeout");
	});
});
