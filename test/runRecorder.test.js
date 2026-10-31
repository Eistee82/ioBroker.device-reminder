import assert from "node:assert";
import { CAPTURE_MAX_CELLS, RunRecorder } from "../build/lib/runRecorder.js";

const STEP = 10_000;
const MIN = 60_000;

/**
 * Feed values into a recorder, one per poll.
 *
 * @param {RunRecorder} rec recorder
 * @param {number[]} values values
 * @param {number} t0 time of the first value
 * @param {Record<number, "s" | "f" | "a">} [events] runtime events by value index
 * @param {number} [endVal] end threshold
 * @returns {{ t: number, closed: object[] }} time after the last value and closed captures
 */
function feed(rec, values, t0, events = {}, endVal = 15) {
	const closed = [];
	let t = t0;
	values.forEach((v, i) => {
		rec.sample(v, t);
		if (events[i]) {
			rec.onEvent(events[i], t);
		}
		const c = rec.closeIfDue(t, endVal);
		if (c) {
			closed.push(c);
		}
		t += STEP;
	});
	return { t, closed };
}

const idle = n => new Array(n).fill(0.5);
const busy = n => new Array(n).fill(500);

describe("run recorder", () => {
	it("keeps 30 minutes before the start and closes 30 quiet minutes after the end", () => {
		const rec = new RunRecorder(STEP, 1);
		const values = [...idle(400), ...busy(60), ...idle(400)];
		const { closed } = feed(rec, values, 0, { 401: "s", 470: "f" });
		assert.strictEqual(closed.length, 1);
		const c = closed[0];
		assert.strictEqual(c.cells.length - (470 - 400 + 1) >= 180, true);
		// pre-roll: 180 cells before the start cell
		assert.strictEqual(c.t0, (401 - 180 + 1) * STEP);
		assert.deepStrictEqual(
			c.ev.map(e => e[1]),
			["s", "f"],
		);
		assert.strictEqual(c.postTruncated, false);
		// closed at 30 min after the end
		const last = c.t0 + (c.cells.length - 1) * STEP;
		assert.ok(last - 470 * STEP >= 30 * MIN && last - 470 * STEP <= 31 * MIN);
		assert.strictEqual(rec.capturing, false);
	});

	it("stays open while bursts >= endVal come and closes 3 h after the end at the latest", () => {
		const rec = new RunRecorder(STEP, 1);
		const bursts = Array.from({ length: 120 }, () => [...idle(28), 500, 500]).flat();
		const { closed } = feed(rec, [...busy(30), ...bursts], 0, { 1: "s", 29: "f" });
		assert.strictEqual(closed.length, 1);
		const last = closed[0].t0 + (closed[0].cells.length - 1) * STEP;
		assert.ok(Math.abs(last - (29 * STEP + 3 * 60 * MIN)) <= STEP, `${(last - 29 * STEP) / MIN} min`);
	});

	it("a start after the end extends the capture (false end)", () => {
		const rec = new RunRecorder(STEP, 1);
		const values = [...busy(30), ...idle(60), ...busy(30), ...idle(400)];
		const { closed } = feed(rec, values, 0, { 1: "s", 40: "f", 91: "s", 130: "f" });
		assert.strictEqual(closed.length, 1);
		assert.deepStrictEqual(
			closed[0].ev.map(e => e[1]),
			["s", "f", "s", "f"],
		);
	});

	it("folds values between two polls into the extremes of the cell", () => {
		const rec = new RunRecorder(STEP, 1);
		rec.sample(1, 0);
		rec.onEvent("s", 0);
		rec.event(900);
		rec.event(0.2);
		rec.sample(5, STEP);
		const snap = rec.snapshot();
		assert.deepStrictEqual(snap.cells.at(-1), { last: 5, min: 0.2, max: 900, valid: true });
		// a missing poll becomes an invalid cell
		rec.sample(5, 3 * STEP);
		assert.deepStrictEqual(
			rec.snapshot().cells.map(c => c.valid),
			[true, true, false, true],
		);
		rec.event(Number.NaN);
	});

	it("resumes a pending capture after a short restart and closes an old one as truncated", () => {
		const rec = new RunRecorder(STEP, 1);
		feed(rec, [...idle(10), ...busy(20)], 0, { 11: "s", 29: "f" });
		const pending = rec.snapshot();
		const fresh = new RunRecorder(STEP, 1);
		const lastT = pending.t0 + (pending.cells.length - 1) * STEP;
		assert.strictEqual(fresh.restore(pending, lastT + 3 * STEP), null);
		assert.strictEqual(fresh.capturing, true);
		fresh.sample(0.5, lastT + 3 * STEP);
		assert.strictEqual(fresh.snapshot().cells.length, pending.cells.length + 3);
		const old = new RunRecorder(STEP, 1).restore(pending, lastT + 60 * MIN);
		assert.strictEqual(old.postTruncated, true);
	});

	it("closes at the cap of cells", () => {
		const rec = new RunRecorder(STEP, 1);
		rec.sample(500, 0);
		rec.onEvent("s", 0);
		let closed = null;
		for (let i = 1; i <= CAPTURE_MAX_CELLS + 5 && !closed; i++) {
			rec.sample(500, i * STEP);
			closed = rec.closeIfDue(i * STEP, 15);
		}
		assert.ok(closed);
		assert.ok(closed.cells.length <= CAPTURE_MAX_CELLS);
		// an end without a start opens nothing
		const other = new RunRecorder(STEP, 1);
		other.onEvent("f", 0);
		assert.strictEqual(other.capturing, false);
		assert.strictEqual(other.closeIfDue(0, 15), null);
	});
});
