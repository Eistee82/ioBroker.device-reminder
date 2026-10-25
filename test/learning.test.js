import assert from "node:assert";
import { LegacyDetector } from "../build/lib/detector/legacy.js";
import { LearningRecorder, suggestType } from "../build/lib/learning.js";
import { dishwasher, washingMachine, withTimes } from "./helpers/curves.js";

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
function detect(curve) {
	const suggestion = suggestType(toSamples(curve), 10);
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
	it("suggests thresholds detecting the washing machine run exactly once", () => {
		assert.deepStrictEqual(detect(washingMachine), { started: 1, finished: 1 });
	});

	it("suggests thresholds detecting the dishwasher run exactly once", () => {
		assert.deepStrictEqual(detect(dishwasher), { started: 1, finished: 1 });
	});

	it("reports noRun for only zero values", () => {
		const result = suggestType(toSamples(new Array(50).fill(0)), 10);
		assert.deepStrictEqual(result, { error: "noRun" });
	});

	it("reports tooFewSamples for 5 samples", () => {
		const result = suggestType(toSamples([0, 100, 100, 100, 0]), 10);
		assert.deepStrictEqual(result, { error: "tooFewSamples" });
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
