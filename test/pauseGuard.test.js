import assert from "node:assert";
import { createDetector, PauseGuard } from "../build/lib/detector/index.js";
import { washingMachine } from "./helpers/curves.js";
import { longPause } from "./helpers/history.js";

const thresholds = { startVal: 30, endVal: 5, standby: 0.3, startCount: 2, endCount: 20 };

/**
 * Run a detector over a curve (10 s ticks; time-based mode: feed and tick).
 *
 * @param {number[]} curve power values
 * @param {object} settings detection settings
 * @param {object} [o] device options and switch state per tick
 * @returns {{ events: { e: string, i: number }[], finishedAt: number[] }} events with tick index
 */
function run(curve, settings, o = {}) {
	const { abort = false, abortFixed = false, switchOff = () => false } = o;
	const detector = createDetector(
		{ startDurationSec: 20, endDurationSec: 300, mode: "count", ...thresholds, ...settings },
		{ abort, abortFixed },
	);
	const events = [];
	curve.forEach((power, i) => {
		const now = i * 10_000;
		const res = [];
		if (settings.mode === "timed") {
			res.push(...detector.feed(power, now).events);
		}
		res.push(...detector.tick(power, now, { switchOff: switchOff(i) }).events);
		for (const e of res) {
			if (e !== "running") {
				events.push({ e, i });
			}
		}
	});
	return { events, finishedAt: events.filter(x => x.e === "finished").map(x => x.i) };
}

const curve = [...longPause, ...new Array(200).fill(0.5)];
const pauseFrom = 73;
const pauseTo = 73 + 132 - 1;
const lastActive = curve.findLastIndex(v => v > 5);

describe("pause protection", () => {
	it("is off by default and when no condition is set", () => {
		assert.strictEqual(new PauseGuard({}).enabled, false);
		assert.strictEqual(new PauseGuard({ pauseHoldSec: 600 }).enabled, false);
		assert.strictEqual(new PauseGuard({ pauseHoldSec: 600, pauseUntilSec: -5 }).enabled, false);
		assert.strictEqual(new PauseGuard({ pauseHoldSec: 600, pauseBelowVal: 0.2 }).enabled, true);
		assert.strictEqual(new PauseGuard({}).met(0), true);
	});

	it("count: without it the soaking pause ends the run", () => {
		const { finishedAt } = run(curve, {});
		assert.ok(finishedAt[0] >= pauseFrom && finishedAt[0] <= pauseTo, `${finishedAt}`);
	});

	for (const [name, guard] of [
		["the time since the start", { pauseHoldSec: 1700, pauseUntilSec: 1000 }],
		["the level", { pauseHoldSec: 1700, pauseBelowVal: 0.25 }],
	]) {
		it(`count: a pause recognised by ${name} only delays`, () => {
			const { events, finishedAt } = run(curve, guard);
			assert.strictEqual(events.filter(x => x.e === "started").length, 1);
			assert.strictEqual(finishedAt.length, 1, JSON.stringify(events));
			assert.ok(finishedAt[0] > lastActive && finishedAt[0] <= lastActive + 22, `${finishedAt} / ${lastActive}`);
		});
	}

	it("count: blips after the end delay the end by at most the hold time", () => {
		// 0 W after the end with a single 5 W blip every 10 min: every stretch below endVal looks like a pause
		const tail = Array.from({ length: 1000 }, (_, i) => (i % 60 === 59 ? 5 : 0));
		const blips = [...washingMachine.slice(0, 203), ...tail];
		const settings = { endVal: 2, endCount: 20 };
		const without = run(blips, settings).finishedAt;
		const guarded = run(blips, { ...settings, pauseHoldSec: 1700, pauseBelowVal: 0.25 }).finishedAt;
		assert.strictEqual(without.length, 1);
		assert.strictEqual(guarded.length, 1, "the end is reported");
		assert.ok(guarded[0] >= without[0] && guarded[0] <= without[0] + 170, `${guarded} / ${without}`);
	});

	it("timed: the abort detection does not fire in a pause", () => {
		const timed = { mode: "timed" };
		const without = run(curve, timed, { abort: true });
		assert.ok(without.events.some(x => x.e === "aborted" && x.i >= pauseFrom && x.i <= pauseTo));
		const withGuard = run(curve, { ...timed, pauseHoldSec: 1700, pauseBelowVal: 0.25 }, { abort: true });
		assert.ok(!withGuard.events.some(x => x.e === "aborted"), JSON.stringify(withGuard.events));
		assert.strictEqual(withGuard.finishedAt.length, 1);
		assert.ok(withGuard.finishedAt[0] > lastActive);
	});

	it("count: a switch-off by hand (corrected abort detection) is not delayed", () => {
		const off = i => i >= pauseFrom + 20 && i <= pauseTo;
		const { events } = run(
			curve,
			{ pauseHoldSec: 1700, pauseBelowVal: 0.25 },
			{
				abort: true,
				abortFixed: true,
				switchOff: off,
			},
		);
		const aborted = events.find(x => x.e === "aborted");
		assert.ok(aborted && aborted.i >= pauseFrom && aborted.i <= pauseFrom + 25, JSON.stringify(events));
	});

	it("level gate: an end above the level is not delayed at all", () => {
		const wm = [...washingMachine, ...new Array(100).fill(0.5)];
		const plain = run(wm, { endCount: 30 });
		const guarded = run(wm, { endCount: 30, pauseHoldSec: 600, pauseBelowVal: 0.25 });
		assert.strictEqual(plain.finishedAt.length, 1);
		assert.deepStrictEqual(guarded.finishedAt, plain.finishedAt);
	});

	it("combined: delays the end in the pause as well", () => {
		const settings = { mode: "combined", endDurationSec: 200, endCount: 3 };
		assert.ok(run(curve, settings).finishedAt[0] <= pauseTo);
		const guarded = run(curve, { ...settings, pauseHoldSec: 1700, pauseUntilSec: 1000 });
		assert.strictEqual(guarded.finishedAt.length, 1);
		assert.ok(guarded.finishedAt[0] > lastActive);
	});
});
