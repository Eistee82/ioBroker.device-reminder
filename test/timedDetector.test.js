import assert from "node:assert";
import { TimedDetector } from "../build/lib/detector/timed.js";
import { createDetector } from "../build/lib/detector/index.js";
import { LegacyDetector } from "../build/lib/detector/legacy.js";
import { abortedRun, washingMachine, withTimes } from "./helpers/curves.js";

const T0 = 1_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

/** Washing machine thresholds with time-based settings. */
const SETTINGS = {
	startVal: 30,
	endVal: 15,
	standby: 1,
	startCount: 2,
	endCount: 50,
	mode: "timed",
	startDurationSec: 60,
	endDurationSec: 300,
};

/**
 * Simulate a plug that only reports changes, plus a poll every 10 s.
 * At every poll time a value arriving at that time is fed first, then tick() runs with the last value.
 *
 * @param {object} detector detector under test
 * @param {{ power: number, now: number }[]} values reported values
 * @param {number} untilMs end of the simulation
 * @returns {{ now: number, event: string }[]} all events with time
 */
function simulate(detector, values, untilMs) {
	const out = [];
	let last = 0;
	const pending = [...values];
	for (let now = T0; now <= untilMs; now += 10 * SEC) {
		while (pending.length && pending[0].now <= now) {
			const v = pending.shift();
			last = v.power;
			detector.feed(v.power, v.now).events.forEach(event => out.push({ now: v.now, event }));
		}
		detector.tick(last, now).events.forEach(event => out.push({ now, event }));
	}
	return out;
}

describe("TimedDetector", () => {
	it("plug reporting only changes (#435): finished exactly endDurationSec after the drop", () => {
		const detector = new TimedDetector(SETTINGS, { abort: false });
		const events = simulate(
			detector,
			[
				{ power: 0, now: T0 },
				{ power: 1500, now: T0 + 10 * SEC },
				{ power: 0, now: T0 + 30 * MIN },
			],
			T0 + 45 * MIN,
		);
		const started = events.filter(e => e.event === "started");
		const finished = events.filter(e => e.event === "finished");
		assert.deepStrictEqual(
			started.map(e => e.now),
			[T0 + 10 * SEC + 60 * SEC],
		);
		assert.deepStrictEqual(
			finished.map(e => e.now),
			[T0 + 30 * MIN + 300 * SEC],
		);
		assert.ok(!events.some(e => e.event === "aborted"));
		assert.strictEqual(detector.started, false);
	});

	it("a short 0 W dip below endDurationSec does not end the run", () => {
		const detector = new TimedDetector(SETTINGS, { abort: false });
		const events = simulate(
			detector,
			[
				{ power: 1500, now: T0 },
				{ power: 0, now: T0 + 10 * MIN },
				{ power: 800, now: T0 + 10 * MIN + 290 * SEC },
				{ power: 0, now: T0 + 20 * MIN },
			],
			T0 + 30 * MIN,
		);
		assert.deepStrictEqual(
			events.filter(e => e.event !== "running").map(e => [e.event, e.now]),
			[
				["started", T0 + 60 * SEC],
				["finished", T0 + 20 * MIN + 300 * SEC],
			],
		);
	});

	it("start needs startDurationSec without interruption", () => {
		const detector = new TimedDetector(SETTINGS, { abort: false });
		const events = simulate(
			detector,
			[
				{ power: 100, now: T0 },
				{ power: 20, now: T0 + 50 * SEC },
				{ power: 100, now: T0 + 60 * SEC },
			],
			T0 + 3 * MIN,
		);
		assert.deepStrictEqual(
			events.filter(e => e.event === "started").map(e => e.now),
			[T0 + 120 * SEC],
		);
	});

	it("abort: running and below standby for endDurationSec/2 → aborted", () => {
		const detector = new TimedDetector(SETTINGS, { abort: true });
		const events = simulate(
			detector,
			[
				{ power: 1500, now: T0 },
				{ power: 0, now: T0 + 10 * MIN },
			],
			T0 + 20 * MIN,
		);
		assert.deepStrictEqual(
			events.filter(e => e.event !== "running").map(e => [e.event, e.now]),
			[
				["started", T0 + 60 * SEC],
				["aborted", T0 + 10 * MIN + 150 * SEC],
			],
		);
		assert.strictEqual(detector.started, false);
	});

	it("abort does not fire while the power stays between standby and endVal", () => {
		const detector = new TimedDetector(SETTINGS, { abort: true });
		const events = simulate(
			detector,
			[
				{ power: 1500, now: T0 },
				{ power: 5, now: T0 + 10 * MIN },
			],
			T0 + 20 * MIN,
		);
		const relevant = events.filter(e => e.event !== "running").map(e => e.event);
		assert.deepStrictEqual(relevant, ["started", "finished"]);
	});

	it("status: off below standby, standby below endVal, running while started; average = current value", () => {
		const detector = new TimedDetector({ ...SETTINGS, startDurationSec: 0 }, { abort: false });
		assert.deepStrictEqual(detector.feed(0.5, T0), { events: [], status: "off", average: 0.5, started: false });
		assert.deepStrictEqual(detector.feed(5, T0 + SEC), {
			events: [],
			status: "standby",
			average: 5,
			started: false,
		});
		assert.deepStrictEqual(detector.feed(20, T0 + 2 * SEC), {
			events: [],
			status: null,
			average: 20,
			started: false,
		});
		assert.deepStrictEqual(detector.feed(100, T0 + 3 * SEC), {
			events: ["started"],
			status: "running",
			average: 100,
			started: true,
		});
		assert.deepStrictEqual(detector.tick(100, T0 + 13 * SEC), {
			events: ["running"],
			status: "running",
			average: 100,
			started: true,
		});
	});

	it("after the end: 3 W → standby, 0 W → off", () => {
		for (const [power, status] of [
			[3, "standby"],
			[0, "off"],
		]) {
			const detector = new TimedDetector({ ...SETTINGS, startDurationSec: 0 }, { abort: false });
			detector.feed(500, T0);
			detector.feed(power, T0 + MIN);
			const result = detector.tick(power, T0 + MIN + 300 * SEC);
			assert.deepStrictEqual(result.events, ["finished"]);
			assert.strictEqual(result.status, status);
			assert.strictEqual(result.started, false);
		}
	});

	it("tick() without any feed() works with the polled value", () => {
		const detector = new TimedDetector(SETTINGS, { abort: false });
		const events = withTimes(washingMachine).flatMap(({ power, now }) => detector.tick(power, now).events);
		assert.strictEqual(events.filter(e => e === "started").length, 1);
		assert.ok(events.includes("finished"));
	});

	it("reset() returns to the initial state", () => {
		const detector = new TimedDetector({ ...SETTINGS, startDurationSec: 0 }, { abort: false });
		detector.feed(500, T0);
		assert.strictEqual(detector.started, true);
		detector.reset();
		assert.strictEqual(detector.started, false);
		// timers are cleared: the old drop no longer counts
		detector.feed(0, T0 + MIN);
		detector.reset();
		assert.deepStrictEqual(detector.tick(500, T0 + 10 * MIN).events, ["started"]);
		assert.deepStrictEqual(detector.tick(0, T0 + 11 * MIN).events, ["running"]);
		assert.deepStrictEqual(detector.tick(0, T0 + 15 * MIN).events, ["running"]);
		assert.deepStrictEqual(detector.tick(0, T0 + 16 * MIN).events, ["finished"]);
	});
});

describe("createDetector", () => {
	const base = { startVal: 30, endVal: 15, standby: 1, startCount: 2, endCount: 50, startDurationSec: 0 };

	it("count → LegacyDetector, timed → TimedDetector", () => {
		assert.ok(
			createDetector(
				{ ...base, mode: "count", endDurationSec: 0 },
				{ abort: false, abortFixed: false },
			) instanceof LegacyDetector,
		);
		const timed = createDetector(
			{ ...base, mode: "timed", endDurationSec: 0 },
			{ abort: false, abortFixed: false },
		);
		assert.ok(timed instanceof TimedDetector);
		assert.strictEqual(typeof timed.feed, "function");
	});

	it("timed + abort + abortedRun → aborted", () => {
		const detector = createDetector(
			{ ...base, mode: "timed", endDurationSec: 300 },
			{ abort: true, abortFixed: false },
		);
		const events = withTimes(abortedRun).flatMap(({ power, now }) => detector.tick(power, now).events);
		assert.deepStrictEqual(
			events.filter(e => e !== "running"),
			["started", "aborted"],
		);
	});
});
