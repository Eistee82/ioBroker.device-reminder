import assert from "node:assert";
import { analyzeHistory } from "../build/lib/historyLearning.js";
import { buildLayout } from "../build/lib/learn/runs.js";
import { fromPoints } from "../build/lib/learn/ticks.js";
import { historyOf, runStarts } from "./helpers/history.js";
import { runOf, times } from "./helpers/programmes.js";
import { replay } from "./helpers/replay.js";

const START = 1_700_000_000_000;
const SHAPES = ["T1", "T2", "T3", "T4", "T5", "T6"];
const PROGRAMMES = {
	washer: ["cotton60", "quick30", "eco4060", "wool", "spinOnly"],
	dryer: ["cupboard", "iron", "refresh", "heatPump"],
};

/**
 * Runs of a device, programmes and anti-crease shapes mixed.
 *
 * @param {"washer" | "dryer"} device device
 * @param {number} n number of runs
 * @param {number} seed first seed
 * @param {object} [o] options of runOf
 * @returns {{ values: number[], start: number, coreEnd: number }[]} runs
 */
function runsOf(device, n, seed, o = {}) {
	const progs = PROGRAMMES[device];
	return Array.from({ length: n }, (_, k) =>
		runOf({
			device,
			programme: progs[(k + seed) % progs.length],
			shape: SHAPES[k % 6],
			seed: seed + k,
			after: 0,
			...o,
		}),
	);
}

/**
 * Replay a history of runs with the learned settings and check every run.
 *
 * @param {object} s learned suggestion
 * @param {{ values: number[], coreEnd: number }[]} runs runs
 * @param {number} maxDelaySec longest allowed delay after the programme end
 * @param {object} [o] options
 * @param {number} [o.stepMs] poll interval
 * @param {number} [o.deadband] deadband of the history
 * @returns {number[]} delays in s
 */
function check(s, runs, maxDelaySec, o = {}) {
	const curves = runs.map(r => r.values);
	const points = historyOf(curves, START, { idle: 0.3, deadband: o.deadband ?? 0 });
	const r = replay(points, s, { stepMs: o.stepMs ?? 10_000 });
	const starts = runStarts(curves, START);
	assert.strictEqual(r.started, runs.length, `starts ${JSON.stringify(r.startedAt.map(t => (t - START) / 10_000))}`);
	assert.strictEqual(r.finished, runs.length);
	assert.strictEqual(r.aborted ?? 0, 0);
	return runs.map((run, i) => {
		const coreEnd = starts[i] + run.coreEnd * 10_000;
		const delay = (r.finishedAt[i] - coreEnd) / 1000;
		assert.ok(delay >= 0 && delay <= maxDelaySec, `run ${i}: delay ${delay} s (max ${maxDelaySec})`);
		assert.ok(r.startedAt[i] < coreEnd && (i === 0 || r.startedAt[i] > r.finishedAt[i - 1]));
		return delay;
	});
}

describe("learning with anti-crease phases", () => {
	for (const device of ["washer", "dryer"]) {
		it(`${device}: every programme ends shortly after the programme end, bursts start nothing`, async () => {
			const train = runsOf(device, 6, 1);
			const s = await analyzeHistory(
				historyOf(
					train.map(r => r.values),
					START,
					{ idle: 0.3 },
				),
				10,
			);
			assert.ok(!("error" in s), JSON.stringify(s));
			assert.strictEqual(s.runs, 6);
			assert.deepStrictEqual(s.trailerRuns, [6, 6]);
			assert.strictEqual(s.delays.length, 6);
			assert.ok(
				s.delays.every(d => d <= 150),
				JSON.stringify(s.delays),
			);
			check(s, train, 150);
			// new variants of every programme with every shape
			check(s, runsOf(device, 12, 100), 150);
		});
	}

	it("washer: the same with change-only values (deadband) and a poll of 60 s", async () => {
		const train = runsOf("washer", 6, 1);
		const curves = train.map(r => r.values);
		const changes = await analyzeHistory(historyOf(curves, START, { idle: 0.3, deadband: 2 }), 10, { minDelta: 2 });
		assert.ok(!("error" in changes), JSON.stringify(changes));
		check(changes, runsOf("washer", 6, 50), 150 + 20, { deadband: 2 });
		// with a poll of 60 s only bursts at least 3 polls apart can be told from tumbling (T1, T4, T5); the
		// shortest end wait is 3 polls (minEndSec), plus the poll grid
		const wide = ["T1", "T4", "T5", "T1", "T4", "T5"].map((shape, k) =>
			runOf({ device: "washer", programme: PROGRAMMES.washer[k % 5], shape, seed: 70 + k, after: 0 }),
		);
		const slow = await analyzeHistory(
			historyOf(
				wide.map(r => r.values),
				START,
				{ idle: 0.3 },
			),
			60,
		);
		assert.ok(!("error" in slow), JSON.stringify(slow));
		check(slow, wide, 180 + 2 * 60, { stepMs: 60_000 });
	});

	it("hard: pauses at the level of the anti-crease phase are told apart by the block before them", async () => {
		const o = { idle: 2, pause: 2 };
		const train = runsOf("washer", 6, 1, o);
		const s = await analyzeHistory(
			historyOf(
				train.map(r => r.values),
				START,
				{ idle: 0.3 },
			),
			10,
		);
		assert.ok(!("error" in s), JSON.stringify(s));
		const wait = s.thresholds.endCount * 10;
		if (s.trailer === "used") {
			assert.ok(s.trailerBlockVal > 0 || s.trailerAfterSec > 0, JSON.stringify(s));
			check(s, train, wait + 20);
			check(s, runsOf("washer", 10, 200, o), wait + 20);
		} else {
			assert.strictEqual(s.trailer, "notSeparable");
			check(s, train, 4 * 3600);
		}
	});

	it("not separable: an in-programme phase identical to the anti-crease phase never ends a run early", async () => {
		// spinning, then 20 min with drum bursts as in the anti-crease phase, then the programme goes on
		const programme = seed => {
			const r = runOf({ device: "washer", programme: "spinOnly", shape: "T2", seed, after: 0 });
			const head = r.values.slice(0, r.coreEnd + 1);
			const fake = r.values.slice(r.coreEnd + 1, r.coreEnd + 121);
			const tail = [...times(2000, 60), ...times(600, 30)];
			const values = [...head, ...fake, ...tail, ...r.values.slice(r.coreEnd + 1)];
			return { values, start: r.start, coreEnd: head.length + fake.length + tail.length - 1 };
		};
		const train = [1, 2, 3, 4].map(programme);
		const s = await analyzeHistory(
			historyOf(
				train.map(r => r.values),
				START,
				{ idle: 0.3 },
			),
			10,
		);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.notStrictEqual(s.trailer, undefined);
		// whatever was chosen: one start, one end, never before the end of the programme
		check(s, train, 4 * 3600);
	});

	it("segmentation: short gaps, the bursts are no end level and the delay counts from the programme end", () => {
		for (const shape of ["T2", "T4", "T5"]) {
			const run = runOf({ device: "washer", programme: "quick30", shape, seed: 3, after: 400 });
			const series = fromPoints(
				run.values.map((val, i) => ({ ts: i * 10_000, val })),
				10_000,
			);
			const layout = buildLayout(series, { recording: true });
			assert.strictEqual(layout.runs.length, 1, shape);
			const r = layout.runs[0];
			assert.ok(r.bursts.length >= 2, `${shape}: ${r.bursts.length} bursts`);
			assert.ok(Math.abs(r.coreEnd - run.coreEnd) <= 1, `${shape}: core end ${r.coreEnd} / ${run.coreEnd}`);
			assert.ok(r.postEnd < 5, `${shape}: level after the end ${r.postEnd}`);
			assert.ok(r.burstP10W > 100 && r.blockMean > 300, JSON.stringify(r.blockMean));
		}
	});

	it("T3 (100 W bursts): the end threshold stays below half the burst power", async () => {
		const train = [1, 2, 3].map(seed =>
			runOf({ device: "dryer", programme: "refresh", shape: "T3", seed, after: 0, idle: 3 }),
		);
		const s = await analyzeHistory(
			historyOf(
				train.map(r => r.values),
				START,
				{ idle: 0.3 },
			),
			10,
		);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.ok(s.thresholds.endVal <= 50, `endVal ${s.thresholds.endVal}`);
		check(s, train, 4 * 3600);
	});
});
