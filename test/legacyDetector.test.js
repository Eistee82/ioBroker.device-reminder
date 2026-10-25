import assert from "node:assert";
import { LegacyDetector } from "../build/lib/detector/legacy.js";
import { createDetector } from "../build/lib/detector/index.js";
import oracleModule from "./fixtures/legacyOracle.cjs";
import { curves, abortedRun, dishwasher, flapping, washingMachine, withTimes } from "./helpers/curves.js";

const { createOracle } = oracleModule;

/** Default types (Spec 4.4) and the custom type default. */
const TYPES = {
	"washing-machine": { startVal: 30, endVal: 15, standby: 1, startCount: 2, endCount: 50 },
	dryer: { startVal: 120, endVal: 15, standby: 1, startCount: 2, endCount: 20 },
	dishwasher: { startVal: 15, endVal: 0.25, standby: 0.5, startCount: 2, endCount: 120 },
	custom: { startVal: 30, endVal: 5, standby: 1, startCount: 1, endCount: 20 },
};

/** Parity matrix: the types above plus a custom type whose abort detection can fire (standbyCount 10 >= valCancel 10). */
const MATRIX_TYPES = { ...TYPES, "custom-endVal10": { ...TYPES.custom, endVal: 10 } };

/**
 * Run a curve through detector and oracle and return both result lists.
 *
 * @param {object} thresholds type thresholds
 * @param {{abort: boolean}} options detector options
 * @param {number[]} curve power values
 */
function runBoth(thresholds, options, curve) {
	const detector = new LegacyDetector(thresholds, options);
	const oracle = createOracle(thresholds, options);
	const actual = [];
	const expected = [];
	for (const { power, now } of withTimes(curve)) {
		actual.push(detector.tick(power, now));
		expected.push(oracle.tick(power));
	}
	return { actual, expected, detector };
}

/**
 * @param {object} thresholds type thresholds
 * @param {{abort: boolean}} options detector options
 * @param {number[]} curve power values
 * @param {boolean} [switchOff] whether the switch is reported off
 * @returns {string[]} all events in order
 */
function eventsOf(thresholds, options, curve, switchOff = false) {
	const detector = new LegacyDetector(thresholds, options);
	return withTimes(curve).flatMap(({ power, now }) => detector.tick(power, now, { switchOff }).events);
}

describe("LegacyDetector", () => {
	describe("parity with 3.1.2", () => {
		const allCurves = { ...curves, allConcatenated: Object.values(curves).flat() };
		for (const [curveName, curve] of Object.entries(allCurves)) {
			for (const [typeName, thresholds] of Object.entries(MATRIX_TYPES)) {
				for (const abort of [true, false]) {
					it(`${curveName} x ${typeName} x abort=${abort}`, () => {
						const { actual, expected } = runBoth(thresholds, { abort }, curve);
						assert.deepStrictEqual(actual, expected);
					});
				}
			}
		}

		it("the matrix exercises every event and status", () => {
			const events = new Set();
			const statuses = new Set();
			for (const curve of Object.values(curves)) {
				for (const thresholds of Object.values(MATRIX_TYPES)) {
					for (const abort of [true, false]) {
						for (const result of runBoth(thresholds, { abort }, curve).actual) {
							result.events.forEach(e => events.add(e));
							statuses.add(result.status);
						}
					}
				}
			}
			assert.deepStrictEqual([...events].sort(), ["aborted", "finished", "running", "started"]);
			assert.deepStrictEqual([...statuses].sort(), [null, "off", "running", "standby"].sort());
		});
	});

	describe("derived values", () => {
		it("standbyCount of the washing machine is 10", () => {
			const detector = new LegacyDetector(TYPES["washing-machine"], { abort: false });
			assert.strictEqual(detector.standbyCount, 10);
			assert.strictEqual(detector.valCancel, 25);
		});

		it("standbyCount follows endVal when endVal <= 10", () => {
			assert.strictEqual(new LegacyDetector(TYPES.custom, { abort: false }).standbyCount, 5);
			assert.strictEqual(new LegacyDetector({ ...TYPES.custom, endVal: 0 }, { abort: false }).standbyCount, 10);
		});

		it("dishwasher keeps the standby buffer empty after every tick", () => {
			const detector = new LegacyDetector(TYPES.dishwasher, { abort: false });
			for (const { power, now } of withTimes(dishwasher)) {
				detector.tick(power, now);
				assert.strictEqual(detector.bufferLengths.standby, 0);
			}
		});

		it("standby: 0 behaves like standby: 1", () => {
			for (const curve of Object.values(curves)) {
				const zero = new LegacyDetector({ ...TYPES.custom, standby: 0 }, { abort: true });
				const one = new LegacyDetector({ ...TYPES.custom, standby: 1 }, { abort: true });
				assert.strictEqual(zero.standbyValue, 1);
				for (const { power, now } of withTimes(curve)) {
					assert.deepStrictEqual(zero.tick(power, now), one.tick(power, now));
				}
			}
		});
	});

	describe("abort detection", () => {
		it("washing machine + abort + abortedRun: no aborted event", () => {
			const events = eventsOf(TYPES["washing-machine"], { abort: true }, abortedRun);
			assert.ok(events.includes("started"));
			assert.ok(!events.includes("aborted"));
		});

		it("custom 30/5/1/1/20 + abort + abortedRun: no aborted event (3.1.2: standbyCount 5 < valCancel 10)", () => {
			const events = eventsOf(TYPES.custom, { abort: true }, abortedRun);
			assert.ok(events.includes("started"));
			assert.ok(!events.includes("aborted"));
		});

		it("custom type with standbyCount >= valCancel + abort + abortedRun: aborted, no finished", () => {
			const thresholds = { ...TYPES.custom, endVal: 10 }; // standbyCount 10, valCancel 10
			const events = eventsOf(thresholds, { abort: true }, abortedRun);
			assert.deepStrictEqual(
				events.filter(e => e !== "running"),
				["started", "aborted"],
			);
		});

		it("aborted resets the detector and reports status off", () => {
			const thresholds = { ...TYPES.custom, endVal: 10 };
			const detector = new LegacyDetector(thresholds, { abort: true });
			let aborted;
			for (const { power, now } of withTimes(abortedRun)) {
				const result = detector.tick(power, now);
				if (result.events.includes("aborted")) {
					aborted = result;
					break;
				}
			}
			assert.ok(aborted);
			assert.strictEqual(aborted.started, false);
			assert.strictEqual(aborted.status, "off");
			assert.deepStrictEqual(detector.bufferLengths, { start: 0, end: 0, standby: 0 });
		});

		it("without abort the same run ends with finished", () => {
			const thresholds = { ...TYPES.custom, endVal: 10 };
			const events = eventsOf(thresholds, { abort: false }, abortedRun);
			assert.ok(events.includes("finished"));
			assert.ok(!events.includes("aborted"));
		});
	});

	describe("end detection", () => {
		it('"finished" only once len(end) >= endCount * 2/3', () => {
			const thresholds = { startVal: 30, endVal: 15, standby: 1, startCount: 1, endCount: 30 };
			const detector = new LegacyDetector(thresholds, { abort: false });
			const curve = [100, ...Array(40).fill(0)];
			let finishedAt = -1;
			curve.forEach((power, i) => {
				if (detector.tick(power, i * 10_000).events.includes("finished")) {
					finishedAt = i;
				}
				if (finishedAt < 0 && detector.started) {
					// while running the end buffer has fewer than 20 values
					assert.ok(detector.bufferLengths.end < 20);
				}
			});
			// tick 0 starts (end buffer empty), ticks 1..20 fill the end buffer to 20 = 30 * 2/3
			assert.strictEqual(finishedAt, 20);
		});

		it("average is computed over count + 1 values before trimming and rounded to 2 decimals", () => {
			const thresholds = { startVal: 30, endVal: 15, standby: 1, startCount: 2, endCount: 50 };
			const detector = new LegacyDetector(thresholds, { abort: false });
			assert.strictEqual(detector.tick(30, 0).average, 30);
			assert.strictEqual(detector.tick(30, 1).average, 30); // not > startVal
			// third value: buffer [30, 30, 30.1] averaged before trimming to 2
			const third = detector.tick(30.1, 2);
			assert.strictEqual(third.average, 30.03);
			assert.deepStrictEqual(third.events, ["started"]);
			assert.strictEqual(detector.bufferLengths.start, 2);
		});

		it("standbyAfterRun ends in standby", () => {
			const detector = new LegacyDetector(TYPES["washing-machine"], { abort: false });
			let last;
			for (const { power, now } of withTimes(curves.standbyAfterRun)) {
				const result = detector.tick(power, now);
				if (result.events.includes("finished")) {
					last = result;
				}
			}
			assert.ok(last);
			assert.strictEqual(last.status, "standby");
		});
	});

	describe("reset", () => {
		it("returns to the initial state", () => {
			const detector = new LegacyDetector(TYPES["washing-machine"], { abort: false });
			for (const { power, now } of withTimes(washingMachine.slice(0, 50))) {
				detector.tick(power, now);
			}
			assert.strictEqual(detector.started, true);
			detector.reset();
			assert.strictEqual(detector.started, false);
			assert.deepStrictEqual(detector.bufferLengths, { start: 0, end: 0, standby: 0 });
			const oracle = createOracle(TYPES["washing-machine"], { abort: false });
			for (const { power, now } of withTimes(washingMachine)) {
				assert.deepStrictEqual(detector.tick(power, now), oracle.tick(power));
			}
		});
	});

	describe("corrected abort detection (abortFixed)", () => {
		it("standbyCount = max(ceil(endCount / 2), 2)", () => {
			const opts = { abort: true, abortFixed: true };
			assert.strictEqual(new LegacyDetector(TYPES["washing-machine"], opts).standbyCount, 25);
			assert.strictEqual(new LegacyDetector(TYPES.custom, opts).standbyCount, 10);
			assert.strictEqual(new LegacyDetector({ ...TYPES.custom, endCount: 3 }, opts).standbyCount, 2);
			assert.strictEqual(new LegacyDetector({ ...TYPES.custom, endCount: 1 }, opts).standbyCount, 2);
		});

		it("washing machine + abortFixed + abortedRun + switch off: aborted, no finished", () => {
			const events = eventsOf(TYPES["washing-machine"], { abort: true, abortFixed: true }, abortedRun, true);
			assert.deepStrictEqual(
				events.filter(e => e !== "running"),
				["started", "aborted"],
			);
		});

		it("abortFixed without switch evidence never aborts", () => {
			const events = eventsOf(TYPES["washing-machine"], { abort: true, abortFixed: true }, abortedRun);
			assert.ok(!events.includes("aborted"));
		});

		for (const [name, curve, thresholds] of [
			["washing machine (idle 0.5 W < standby 1 W)", washingMachine, TYPES["washing-machine"]],
			// the default dishwasher endVal (0.25 W) lies below the curve idle power, so use 0.4 W to reach a normal end
			["dishwasher (idle 0.3 W < standby 0.5 W)", dishwasher, { ...TYPES.dishwasher, endVal: 0.4 }],
		]) {
			it(`${name}: a normal end with abort + abortFixed is finished, not aborted`, () => {
				const events = eventsOf(thresholds, { abort: true, abortFixed: true }, curve);
				assert.ok(events.includes("started"));
				assert.ok(events.includes("finished"));
				assert.ok(!events.includes("aborted"));
			});
		}

		it("abortFixed without abort changes nothing at the events", () => {
			for (const curve of Object.values(curves)) {
				const fixed = eventsOf(TYPES["washing-machine"], { abort: false, abortFixed: true }, curve);
				const plain = eventsOf(TYPES["washing-machine"], { abort: false }, curve);
				assert.deepStrictEqual(fixed, plain);
			}
		});

		it("abortFixed: false stays identical to 3.1.2", () => {
			for (const curve of Object.values(curves)) {
				const detector = new LegacyDetector(TYPES["washing-machine"], {
					abort: true,
					abortFixed: false,
					minStartMs: 0,
					minEndMs: 0,
				});
				const oracle = createOracle(TYPES["washing-machine"], { abort: true });
				for (const { power, now } of withTimes(curve)) {
					assert.deepStrictEqual(detector.tick(power, now), oracle.tick(power));
				}
			}
		});
	});

	describe("combined mode (count + duration)", () => {
		/**
		 * @param {object} thresholds type thresholds
		 * @param {number} startDurationSec minimum start duration
		 * @param {number} endDurationSec minimum end duration
		 */
		function combined(thresholds, startDurationSec, endDurationSec) {
			return createDetector(
				{ ...thresholds, mode: "combined", startDurationSec, endDurationSec },
				{ abort: false, abortFixed: false },
			);
		}

		/**
		 * @param {object} detector detector under test
		 * @param {number[]} curve power values
		 * @param {number} endVal end threshold
		 * @returns {{ finishedAt: number[], lastHighBefore: number[], startedAt: number[] }} event times in ms
		 */
		function timeline(detector, curve, endVal) {
			const out = { finishedAt: [], lastHighBefore: [], startedAt: [] };
			let lastHigh = -1;
			for (const { power, now } of withTimes(curve)) {
				if (power >= endVal) {
					lastHigh = now;
				}
				const { events } = detector.tick(power, now);
				if (events.includes("started")) {
					out.startedAt.push(now);
				}
				if (events.includes("finished")) {
					out.finishedAt.push(now);
					out.lastHighBefore.push(lastHigh);
				}
			}
			return out;
		}

		it("washing machine + endDurationSec 300: finished at the earliest 300 s after the last value >= endVal", () => {
			const thresholds = TYPES["washing-machine"];
			const t = timeline(combined(thresholds, 0, 300), washingMachine, thresholds.endVal);
			assert.strictEqual(t.finishedAt.length, 1);
			assert.ok(t.finishedAt[0] - t.lastHighBefore[0] >= 300_000);
		});

		it("short endCount: count ends early, combined waits for endDurationSec", () => {
			const thresholds = { ...TYPES["washing-machine"], endCount: 3 };
			const count = timeline(new LegacyDetector(thresholds, { abort: false }), washingMachine, thresholds.endVal);
			const comb = timeline(combined(thresholds, 0, 300), washingMachine, thresholds.endVal);
			// count ends during the first pause already
			assert.ok(count.finishedAt.length > 1);
			assert.ok(count.finishedAt[0] - count.lastHighBefore[0] < 300_000);
			assert.strictEqual(comb.finishedAt.length, 1);
			assert.ok(comb.finishedAt[0] - comb.lastHighBefore[0] >= 300_000);
			// exactly when the power has been below endVal for 300 s (first sample below + 300 s)
			assert.strictEqual(comb.finishedAt[0], comb.lastHighBefore[0] + 10_000 + 300_000);
		});

		it("startDurationSec: flapping around the start threshold does not start", () => {
			const thresholds = { ...TYPES.custom, startCount: 1 };
			const count = timeline(new LegacyDetector(thresholds, { abort: false }), flapping, thresholds.endVal);
			const comb = timeline(combined(thresholds, 30, 0), flapping, thresholds.endVal);
			assert.ok(count.startedAt.length > 0);
			assert.strictEqual(comb.startedAt.length, 0);
		});

		it("startDurationSec delays the start until the power has been >= startVal long enough", () => {
			const thresholds = { ...TYPES["washing-machine"] };
			const count = timeline(new LegacyDetector(thresholds, { abort: false }), washingMachine, thresholds.endVal);
			const comb = timeline(combined(thresholds, 60, 0), washingMachine, thresholds.endVal);
			// count: startCount 2 reached at tick 4 (40 s); first value >= startVal at tick 3 (30 s), 60 s later = 90 s
			assert.strictEqual(count.startedAt[0], 40_000);
			assert.strictEqual(comb.startedAt[0], 90_000);
		});

		it("durations 0 are identical to 3.1.2", () => {
			for (const curve of Object.values(curves)) {
				for (const thresholds of Object.values(MATRIX_TYPES)) {
					const detector = combined(thresholds, 0, 0);
					const oracle = createOracle(thresholds, { abort: false });
					for (const { power, now } of withTimes(curve)) {
						assert.deepStrictEqual(detector.tick(power, now), oracle.tick(power));
					}
				}
			}
		});

		it("reset clears the duration tracking", () => {
			const thresholds = TYPES["washing-machine"];
			const detector = combined(thresholds, 60, 0);
			detector.tick(100, 0);
			detector.tick(100, 30_000);
			detector.reset();
			assert.deepStrictEqual(detector.tick(100, 60_000).events, []);
			assert.deepStrictEqual(detector.tick(100, 70_000).events, []);
			assert.deepStrictEqual(detector.tick(100, 120_000).events, ["started"]);
		});
	});
});
