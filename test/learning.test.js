import assert from "node:assert";
import { LegacyDetector } from "../build/lib/detector/legacy.js";
import { analyzeHistory } from "../build/lib/historyLearning.js";
import { LearningRecorder, suggestType } from "../build/lib/learning.js";
import { dishwasher, washingMachine, withTimes } from "./helpers/curves.js";
import { historyOf, longPause } from "./helpers/history.js";
import { replay } from "./helpers/replay.js";

/**
 * Convert a curve to learning samples (10 s steps).
 *
 * @param {number[]} curve power values
 */
function toSamples(curve) {
	return curve.map((p, i) => ({ t: i * 10_000, p }));
}

/**
 * Count started/finished events of the legacy detector with the suggestion.
 *
 * @param {number[]} curve power values
 */
async function detect(curve) {
	const suggestion = await suggestType(toSamples(curve), 10);
	assert.ok(!("error" in suggestion), JSON.stringify(suggestion));
	const detector = new LegacyDetector(suggestion.thresholds, { abort: false });
	const events = [];
	for (const { power, now } of withTimes(curve)) {
		events.push(...detector.tick(power, now).events);
	}
	return {
		started: events.filter(e => e === "started").length,
		finished: events.filter(e => e === "finished").length,
	};
}

describe("learning", () => {
	it("suggests thresholds detecting the washing machine run exactly once", async () => {
		assert.deepStrictEqual(await detect(washingMachine), { started: 1, finished: 1 });
	});

	it("suggests thresholds detecting the dishwasher run exactly once", async () => {
		assert.deepStrictEqual(await detect(dishwasher), { started: 1, finished: 1 });
	});

	it("reports noRun for only zero values", async () => {
		const result = await suggestType(toSamples(new Array(50).fill(0)), 10);
		assert.deepStrictEqual(result, { error: "noRun" });
	});

	it("reports tooFewSamples for 5 samples", async () => {
		const result = await suggestType(toSamples([0, 100, 100, 100, 0]), 10);
		assert.deepStrictEqual(result, { error: "tooFewSamples" });
	});

	it("learns mode and pause protection from a run with a long pause", async () => {
		const s = await suggestType(toSamples(longPause), 10);
		assert.ok(!("error" in s), JSON.stringify(s));
		assert.ok(s.mode);
		assert.strictEqual(s.evaluation[0].runs, 1);
		assert.ok(s.pauseHoldSec > 0 && (s.pauseBelowVal > 0 || s.pauseUntilSec > 0), JSON.stringify(s));
		const points = longPause.map((val, i) => ({ ts: i * 10_000, val }));
		const r = replay(points, s);
		assert.deepStrictEqual([r.started, r.finished], [1, 1]);
	});

	it("uses the same analysis as the history", async () => {
		const rec = await suggestType(toSamples(washingMachine), 10);
		const hist = await analyzeHistory(historyOf([washingMachine]), 10, { minRuns: 1 });
		for (const key of ["startVal", "endVal", "standby"]) {
			assert.strictEqual(rec.thresholds[key], hist.thresholds[key], key);
		}
	});

	it("stops the recorder at 10 000 samples", () => {
		const recorder = new LearningRecorder();
		recorder.start(0);
		assert.strictEqual(recorder.active, true);
		for (let i = 0; i < 10_050; i++) {
			recorder.add(5, i * 1000);
		}
		assert.strictEqual(recorder.active, false);
		assert.strictEqual(recorder.sampleCount, 10_000);
		assert.strictEqual(recorder.stop(0).length, 10_000);
	});
});
