import assert from "node:assert";
import {
	createDetector,
	LegacyDetector,
	TimedDetector,
	TRAILER_MAX_DEFAULT_SEC,
	TrailerFilter,
} from "../build/lib/detector/index.js";
import { TRAILER_QUIET_END_MS } from "../build/lib/detector/trailer.js";
import { lcg, times } from "./helpers/programmes.js";

const STEP = 10_000;
const WASHER = { startVal: 30, endVal: 15, standby: 1, startCount: 2, endCount: 50, mode: "count" };
const FILTER = { trailerBurstSec: 45, trailerGapSec: 30, trailerAfterSec: 0, trailerBlockVal: 0, trailerMaxSec: 7200 };

/**
 * Settings of a detector.
 *
 * @param {object} [over] overrides
 * @returns {object} detection settings
 */
function settings(over = {}) {
	return { ...WASHER, startDurationSec: 60, endDurationSec: 300, ...over };
}

/**
 * Feed values (one per poll) and collect the events with their times.
 *
 * @param {object} detector detector
 * @param {number[]} values power values
 * @param {object} [o] options
 * @param {boolean} [o.feed] also call feed before every tick (timed mode)
 * @returns {{ started: number[], finished: number[], aborted: number[] }} event times as tick indices
 */
function run(detector, values, o = {}) {
	const out = { started: [], finished: [], aborted: [] };
	values.forEach((v, i) => {
		const t = i * STEP;
		const results = [];
		if (o.feed) {
			results.push([detector.feed(v, t), t]);
		}
		results.push([detector.tick(v, t, { switchOff: false }), t]);
		for (const [res, at] of results) {
			res.events.forEach((ev, k) => {
				if (ev !== "running") {
					out[ev].push((res.times?.[k] ?? at) / STEP);
				}
			});
		}
	});
	return out;
}

/** Programme: 10 min at 2000 W, 5 min spinning at 600 W. */
const programme = [...times(0.5, 6), ...times(2000, 60), ...times(600, 30)];
const coreEnd = programme.length - 1;

/**
 * Anti-crease phase: 2 ticks at `power` every `every` ticks, `n` times, then idle.
 *
 * @param {number} every distance in ticks
 * @param {number} n bursts
 * @param {number} [power] burst power
 * @returns {number[]} values
 */
function trailer(every, n, power = 500) {
	const out = [];
	for (let k = 0; k < n; k++) {
		out.push(...times(0.8, every - 2), power, power);
	}
	return [...out, ...times(0.3, 200)];
}

describe("anti-crease filter", () => {
	it("is not built when trailerBurstSec is 0 (3.1.2 detector unchanged)", () => {
		assert.ok(createDetector(settings(), { abort: false, abortFixed: false }) instanceof LegacyDetector);
		assert.ok(
			createDetector(settings({ mode: "timed", trailerBurstSec: 0 }), {
				abort: false,
				abortFixed: false,
			}) instanceof TimedDetector,
		);
		assert.ok(createDetector(settings(FILTER), { abort: false, abortFixed: false }) instanceof TrailerFilter);
		assert.strictEqual(TRAILER_MAX_DEFAULT_SEC, 7200);
	});

	it("reports the end at the programme end and starts nothing on the bursts", () => {
		const values = [...programme, ...trailer(30, 12)];
		const plain = run(createDetector(settings({ endCount: 12 }), { abort: false, abortFixed: false }), values);
		// without the filter every burst starts a new run (3.1.2 behaviour)
		assert.ok(plain.started.length > 1, JSON.stringify(plain));
		const det = createDetector(settings({ endCount: 12, ...FILTER }), {
			abort: false,
			abortFixed: false,
			pollSec: 10,
		});
		const r = run(det, values);
		assert.deepStrictEqual(r.started.length, 1);
		assert.deepStrictEqual(r.finished.length, 1);
		assert.ok(r.finished[0] >= coreEnd && r.finished[0] <= coreEnd + 14, JSON.stringify(r));
		assert.ok(det.burstsSuppressed >= 11, `${det.burstsSuppressed}`);
	});

	it("keeps the run going through bursts with a long end wait and ends at the programme end plus the wait", () => {
		// end wait 120 ticks (20 min) > distance of the bursts (5 min): without filter the end comes after the phase
		const values = [...programme, ...trailer(30, 12)];
		const plain = run(
			createDetector(settings({ endCount: 120, startCount: 3 }), { abort: false, abortFixed: false }),
			values,
		);
		assert.ok(plain.finished[0] > coreEnd + 12 * 30, JSON.stringify(plain));
		const r = run(
			createDetector(settings({ endCount: 120, startCount: 3, ...FILTER }), { abort: false, abortFixed: false }),
			values,
		);
		assert.deepStrictEqual([r.started.length, r.finished.length], [1, 1]);
		assert.ok(r.finished[0] <= coreEnd + 125, JSON.stringify(r));
	});

	it("passes real activity on unchanged, in order and with the original times", () => {
		const inner = [];
		const spy = {
			started: false,
			tick(power, now) {
				inner.push([power, now]);
				const events = [];
				if (!this.started && power >= 30) {
					this.started = true;
					events.push("started");
				}
				return { events, status: null, average: null, started: this.started };
			},
			reset() {},
		};
		const f = new TrailerFilter(spy, { ...FILTER, endVal: 15, standby: 1, pollSec: 10 });
		// start, sustained block of 3 min, quiet 1 min, then a 2 min phase (real activity)
		const values = [0, ...times(500, 18), ...times(1, 6), ...times(300, 12), ...times(1, 3)];
		const seenTimes = [];
		values.forEach((v, i) => {
			const res = f.tick(v, i * STEP);
			if (res.times) {
				seenTimes.push(...res.times);
			}
		});
		assert.deepStrictEqual(
			inner.map(c => c[1]),
			values.map((_, i) => i * STEP),
		);
		assert.deepStrictEqual(
			inner.map(c => c[0]),
			values,
		);
		assert.ok(seenTimes.every((t, i) => i === 0 || t >= seenTimes[i - 1]));
	});

	it("property: the inner detector gets monotonic times, every value once and only short phases replaced", () => {
		for (let seed = 1; seed <= 1000; seed++) {
			const rnd = lcg(seed);
			const values = [];
			while (values.length < 300) {
				const kind = rnd();
				const len = 1 + Math.floor(rnd() * (kind < 0.5 ? 30 : 8));
				const v = kind < 0.4 ? 0.5 : kind < 0.6 ? 5 : Math.round(rnd() * 2000);
				values.push(...times(v, len));
			}
			const forwarded = [];
			const inner = new LegacyDetector(WASHER, { abort: false });
			const spy = {
				get started() {
					return inner.started;
				},
				tick(power, now) {
					forwarded.push([power, now]);
					return inner.tick(power, now);
				},
				reset() {
					inner.reset();
				},
			};
			const f = new TrailerFilter(spy, { ...FILTER, endVal: 15, standby: 1, pollSec: 10 });
			values.forEach((v, i) => f.tick(v, i * STEP));
			// flush a held phase
			f.tick(0, values.length * STEP);
			const ts = forwarded.map(c => c[1]);
			assert.ok(
				ts.every((t, i) => i === 0 || t > ts[i - 1]),
				`seed ${seed}: times`,
			);
			assert.deepStrictEqual(
				ts,
				[...values, 0].map((_, i) => i * STEP),
				`seed ${seed}: every value once`,
			);
			// a replaced value is a phase >= endVal of at most trailerBurstSec, replaced by a quiet level
			let k = 0;
			while (k < values.length) {
				if (forwarded[k][0] !== values[k]) {
					let j = k;
					while (j < values.length && forwarded[j][0] !== values[j]) {
						assert.ok(values[j] >= 15 && forwarded[j][0] < 15, `seed ${seed}: replaced ${j}`);
						j++;
					}
					assert.ok((j - k - 1) * STEP <= FILTER.trailerBurstSec * 1000, `seed ${seed}: burst ${k}-${j}`);
					k = j;
				} else {
					k++;
				}
			}
		}
	});

	it("detects a new run started in the anti-crease phase at most a burst plus a poll late", () => {
		const values = [...programme, ...trailer(30, 2).slice(0, 60), ...times(0.8, 10), ...times(800, 60)];
		const restart = programme.length + 70;
		const r = run(
			createDetector(settings({ endCount: 12, ...FILTER }), { abort: false, abortFixed: false }),
			values,
		);
		assert.strictEqual(r.started.length, 2, JSON.stringify(r));
		assert.ok(r.started[1] - restart <= FILTER.trailerBurstSec / 10 + 2, JSON.stringify(r));
	});

	it("does not hold tumbling with short stops (minimum quiet time)", () => {
		// drum 20 s on, 10 s off: shorter quiet time than trailerGapSec, never held
		const tumble = Array.from({ length: 40 }, () => [400, 400, 1]).flat();
		const det = createDetector(settings({ endCount: 12, ...FILTER }), { abort: false, abortFixed: false });
		run(det, [...programme, ...tumble]);
		assert.strictEqual(det.burstsSuppressed, 0);
	});

	it("holds bursts only after trailerAfterSec and after a block of trailerBlockVal", () => {
		const soak = trailer(12, 6, 150).slice(0, 72);
		// soaking (drum every 2 min) after a washing block of 150 W, then the spin and the anti-crease phase
		const values = [...times(0.5, 6), ...times(150, 60), ...soak, ...times(600, 30), ...trailer(30, 4)];
		const end = 6 + 60 + 72 + 30 - 1;
		const opts = { abort: false, abortFixed: false };
		const loose = run(createDetector(settings({ endCount: 12, ...FILTER }), opts), values);
		// the soaking phase looks like the anti-crease phase: the end comes too early
		assert.ok(loose.finished[0] < end, JSON.stringify(loose));
		for (const extra of [{ trailerBlockVal: 400 }, { trailerAfterSec: 1500 }]) {
			const r = run(createDetector(settings({ endCount: 12, ...FILTER, ...extra }), opts), values);
			assert.deepStrictEqual([r.started.length, r.finished.length], [1, 1], JSON.stringify(extra));
			assert.ok(r.finished[0] >= end && r.finished[0] <= end + 14, JSON.stringify({ extra, r }));
		}
	});

	it("ends the anti-crease phase after a quiet time and after trailerMaxSec", () => {
		const opts = { abort: false, abortFixed: false };
		// quiet for longer than TRAILER_QUIET_END_MS: a later burst starts a run again
		const quiet = TRAILER_QUIET_END_MS / STEP + 10;
		const a = createDetector(settings({ endCount: 12, ...FILTER }), opts);
		const ra = run(a, [...programme, ...trailer(30, 2).slice(0, 60), ...times(0.8, quiet), 500, 500, 500]);
		assert.strictEqual(ra.started.length, 2, JSON.stringify(ra));
		// trailerMaxSec 900 s: bursts after 15 min start runs again
		const b = createDetector(settings({ endCount: 12, ...FILTER, trailerMaxSec: 900 }), opts);
		const rb = run(b, [...programme, ...trailer(30, 6)]);
		assert.ok(rb.started.length > 1, JSON.stringify(rb));
		assert.strictEqual(b.inTrailer, false);
	});

	it("reports the anti-crease phase (inTrailer) and works in the time-based mode", () => {
		const det = createDetector(settings({ mode: "timed", endDurationSec: 120, startDurationSec: 20, ...FILTER }), {
			abort: false,
			abortFixed: false,
			pollSec: 10,
		});
		const values = [...programme, ...trailer(30, 12)];
		let sawTrailer = false;
		const out = { started: 0, finished: [] };
		values.forEach((v, i) => {
			for (const res of [det.feed(v, i * STEP), det.tick(v, i * STEP)]) {
				res.events.forEach((ev, k) => {
					if (ev === "started") {
						out.started++;
					} else if (ev === "finished") {
						out.finished.push((res.times?.[k] ?? i * STEP) / STEP);
					}
				});
			}
			sawTrailer ||= det.inTrailer;
		});
		assert.strictEqual(out.started, 1);
		assert.strictEqual(out.finished.length, 1);
		assert.ok(out.finished[0] >= coreEnd && out.finished[0] <= coreEnd + 14, JSON.stringify(out));
		assert.ok(sawTrailer);
		assert.strictEqual(det.holding, false);
		det.reset();
		assert.strictEqual(det.started, false);
		// a filter around a count detector ignores feed
		const count = createDetector(settings(FILTER), { abort: false, abortFixed: false });
		assert.deepStrictEqual(count.feed(500, 0).events, []);
	});

	it("time-based mode: power reports more often than the poll do not release a burst early", () => {
		// 20 min at 2000 W, then 300 W bursts of 30 s every 3 min for 1 h (plug reports every 1-5 s)
		const power = t => (t < 60 ? 1 : t < 1260 ? 2000 : t < 4860 && (t - 1260) % 180 >= 150 ? 300 : 1);
		for (const every of [10, 5, 2, 1]) {
			const det = createDetector(
				settings({ mode: "timed", startDurationSec: 20, endDurationSec: 120, ...FILTER }),
				{ abort: false, abortFixed: false, pollSec: 10 },
			);
			const events = [];
			let last = power(0);
			for (let t = 0; t <= 8000; t++) {
				const results = [];
				if (t % every === 0) {
					last = power(t);
					results.push(det.feed(last, t * 1000));
				}
				if (t % 10 === 0) {
					results.push(det.tick(last, t * 1000, { switchOff: false }));
				}
				for (const r of results) {
					r.events.forEach((ev, k) => {
						if (ev !== "running") {
							events.push(`${ev}@${(r.times?.[k] ?? t * 1000) / 1000}`);
						}
					});
				}
			}
			assert.deepStrictEqual(events, ["started@80", "finished@1380"], `report every ${every} s`);
		}
	});
});
