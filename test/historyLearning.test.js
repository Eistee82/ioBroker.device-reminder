import assert from "node:assert";
import { createDetector } from "../build/lib/detector/index.js";
import { analyzeHistory, pickMode } from "../build/lib/historyLearning.js";
import { findHistoryInstance, loadHistory } from "../build/lib/historySource.js";
import { washingMachine } from "./helpers/curves.js";
import { historyOf, longPause, shortRun } from "./helpers/history.js";

/**
 * Replay the whole history like the runtime does (values fed on arrival, poll every 10 s).
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {object} s suggestion
 */
function replay(points, s) {
	const detector = createDetector(
		{ ...s.thresholds, mode: s.mode, startDurationSec: s.startDurationSec, endDurationSec: s.endDurationSec },
		{ abort: false, abortFixed: false },
	);
	const counts = { started: 0, finished: 0 };
	const count = events => events.forEach(e => (counts[e] = (counts[e] ?? 0) + 1));
	let idx = 0;
	let value = points[0].val;
	for (let t = points[0].ts; t <= points.at(-1).ts; t += 10_000) {
		while (idx < points.length && points[idx].ts <= t) {
			value = points[idx].val;
			if (s.mode === "timed") {
				count(detector.feed(value, points[idx].ts).events);
			}
			idx++;
		}
		count(detector.tick(value, t).events);
	}
	return { started: counts.started, finished: counts.finished };
}

const evalOf = (mode, detected, falseStarts, endDelaySec) => ({ mode, detected, runs: 5, falseStarts, endDelaySec });

describe("learning from the history", () => {
	it("finds every run, whatever programme, and suggests a type detecting each exactly once", () => {
		const points = historyOf([washingMachine, longPause, shortRun, washingMachine]);
		const s = analyzeHistory(points, 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.strictEqual(s.runs, 4);
		const chosen = s.evaluation.find(e => e.mode === s.mode);
		assert.deepStrictEqual([chosen.detected, chosen.falseStarts], [4, 0]);
		assert.deepStrictEqual(replay(points, s), { started: 4, finished: 4 });
		assert.strictEqual(s.samples, points.length);
	});

	it("evaluates all three detection modes", () => {
		const s = analyzeHistory(historyOf([washingMachine, longPause]), 10);
		assert.deepStrictEqual(
			s.evaluation.map(e => e.mode),
			["count", "combined", "timed"],
		);
		assert.ok(s.evaluation.every(e => e.runs === 2));
	});

	it("needs at least two runs", () => {
		assert.deepStrictEqual(analyzeHistory(historyOf([washingMachine]), 10), { error: "tooFewRuns", runs: 1 });
		assert.deepStrictEqual(analyzeHistory([], 10), { error: "noHistory" });
	});

	it("ignores short spikes as runs", () => {
		const points = historyOf([washingMachine, washingMachine]);
		assert.strictEqual(analyzeHistory(points, 10).runs, 2);
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
			return { result: o.result ?? [] };
		},
	};
}

const historyAdapter = { common: { getHistory: true } };

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

	it("reads the raw values of the last 30 days", async () => {
		const e = env({
			result: [
				{ ts: 3, val: "7.5" },
				{ ts: 1, val: 2 },
				{ ts: 2, val: null },
				{ ts: 4, val: "x" },
			],
		});
		assert.deepStrictEqual(await loadHistory(e, "influxdb.0", "plug.0.power", 30 * 86_400_000), [
			{ ts: 1, val: 2 },
			{ ts: 3, val: 7.5 },
		]);
		const { id, options } = e.calls[0];
		assert.strictEqual(id, "plug.0.power");
		assert.deepStrictEqual(
			{ instance: options.instance, start: options.start, aggregate: options.aggregate },
			{ instance: "influxdb.0", start: 0, aggregate: "none" },
		);
	});
});
