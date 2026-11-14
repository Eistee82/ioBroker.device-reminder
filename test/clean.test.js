import assert from "node:assert";
import { cleanPoints } from "../build/lib/learn/clean.js";
import { historySettingsOf, loadHistorySeries, loadHistorySeriesForTest } from "../build/lib/historySource.js";
import { RunRecorder } from "../build/lib/runRecorder.js";
import { decodePendingForTest, encodePending, emptyStore, fitSize, MAX_PENDING_BYTES } from "../build/lib/runStore.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * History access answering every query from one list of stored values.
 *
 * @param {{ ts: number, val: unknown }[]} rows stored values
 * @param {Record<string, unknown>} [custom] custom block of the power state for history.0
 * @param {Record<string, unknown>} [instanceNative] native of the history instance
 */
function historyEnv(rows, custom = {}, instanceNative = {}) {
	const calls = [];
	return {
		calls,
		object: async id => {
			if (id === "plug.0.power") {
				return {
					common: { unit: "W", role: "value.power", custom: { "history.0": { enabled: true, ...custom } } },
				};
			}
			if (id === "system.adapter.history.0") {
				return { common: { getHistory: true }, native: instanceNative };
			}
			return null;
		},
		alive: async () => true,
		getHistory: async (_id, o) => {
			calls.push(o);
			return { result: rows.filter(r => r.ts >= o.start && r.ts <= o.end) };
		},
	};
}

describe("raw data", () => {
	it("cleans null, NaN, negatives, order and exact duplicates", () => {
		const r = cleanPoints([
			{ ts: 3, val: 5 },
			{ ts: 1, val: null },
			{ ts: 2, val: -4 },
			{ ts: 2, val: -4 },
			{ ts: 4, val: Number.NaN },
		]);
		assert.deepStrictEqual(r.points, [
			{ ts: 2, val: 0 },
			{ ts: 3, val: 5 },
		]);
		assert.strictEqual(r.invalidShare, 0.6);
	});
	it("a jump back of more than a minute is unknown time; 30 s is only reordered", () => {
		const r = cleanPoints([
			{ ts: 100_000, val: 1 },
			{ ts: 200_000, val: 2 },
			{ ts: 120_000, val: 3 },
			{ ts: 300_000, val: 4 },
		]);
		assert.deepStrictEqual(r.timeJumps, [{ at: 120_000, backMs: 80_000 }]);
		assert.deepStrictEqual(r.unknown, [{ from: 120_000, to: 200_000 }]);
		assert.deepStrictEqual(
			cleanPoints([
				{ ts: 100_000, val: 1 },
				{ ts: 90_000, val: 2 },
			]).timeJumps,
			[],
		);
	});
	it("overlapping unknown ranges are merged and an empty input has no invalid share", () => {
		const r = cleanPoints([
			{ ts: 500_000, val: 1 },
			{ ts: 300_000, val: 1 },
			{ ts: 400_000, val: 1 },
			{ ts: 200_000, val: 1 },
		]);
		assert.strictEqual(r.timeJumps.length, 2);
		assert.deepStrictEqual(r.unknown, [{ from: 200_000, to: 500_000 }]);
		assert.strictEqual(cleanPoints([]).invalidShare, 0);
	});
	it("history settings are read from the custom block, missing fields stay neutral", () => {
		assert.deepStrictEqual(
			historySettingsOf({ changesRelogInterval: 300, ignoreZero: true, debounceTime: 1000, round: 1 }),
			{ relogSec: 300, ignoreZero: true, ignoreBelowZero: false, debounceMs: 1000, blockTimeMs: 0, round: 1 },
		);
		assert.deepStrictEqual(historySettingsOf({}), {
			relogSec: 0,
			ignoreZero: false,
			ignoreBelowZero: false,
			debounceMs: 0,
			blockTimeMs: 0,
			round: null,
		});
	});
	it("history settings: influxdb strings, ignoreBelowNumber and an empty round", () => {
		assert.deepStrictEqual(
			historySettingsOf({
				changesRelogInterval: "60",
				debounceTime: 100,
				blockTime: 100,
				ignoreBelowNumber: "0",
				round: "",
			}),
			{ relogSec: 60, ignoreZero: false, ignoreBelowZero: true, debounceMs: 100, blockTimeMs: 100, round: null },
		);
		assert.strictEqual(historySettingsOf({ ignoreBelowNumber: "" }).ignoreBelowZero, false);
		assert.strictEqual(historySettingsOf({ ignoreBelowZero: true }).ignoreBelowZero, true);
	});
	it("the recorder keeps report times of equal values and they survive the file", () => {
		const rec = new RunRecorder(10_000, 1);
		rec.sample(0.5, 0);
		rec.onEvent("s", 10_000);
		rec.event(100, 15_000);
		rec.sample(100, 20_000);
		rec.event(100, 25_000);
		rec.sample(100, 30_000);
		const snap = rec.snapshot();
		assert.strictEqual(snap.rep.length, 2);
		assert.deepStrictEqual(decodePendingForTest(JSON.parse(JSON.stringify(encodePending(snap)))).rep, snap.rep);
	});
	it("report times of the pre-roll go into the capture; a file without report times stays without", () => {
		const rec = new RunRecorder(10_000, 1);
		rec.event(0.5, 5_000);
		rec.sample(0.5, 10_000);
		rec.event(0.6, 15_000);
		rec.sample(0.6, 20_000);
		rec.onEvent("s", 20_000);
		assert.deepStrictEqual(rec.snapshot().rep, [-5_000, 5_000]);
		const old = encodePending(rec.snapshot());
		delete old.rep;
		assert.strictEqual(decodePendingForTest(JSON.parse(JSON.stringify(old))).rep, undefined);
	});
	it("a capture too large for the file keeps its cells and loses only the report times", () => {
		const st = emptyStore("d", "", "h", 10_000, 1);
		const cells = Array.from({ length: 100 }, () => ({ min: 1, max: 1, last: 1, valid: true }));
		const rep = Array.from({ length: MAX_PENDING_BYTES / 4 }, (_, i) => i * 997);
		st.pending = { t0: 0, stepMs: 10_000, unitFactor: 1, cells, ev: [], postTruncated: false, rep };
		fitSize(st);
		assert.ok(st.pending);
		assert.strictEqual(st.pending.rep, undefined);
		assert.strictEqual(st.pending.cells.length, 100);
	});
	it("the recorder opens a capture on activity without a start (missed start)", () => {
		const rec = new RunRecorder(10_000, 1);
		rec.setActivityLimit(15);
		for (let i = 0; i < 40; i++) {
			rec.event(i < 3 ? 0.5 : 300, i * 10_000);
			rec.sample(i < 3 ? 0.5 : 300, i * 10_000);
		}
		const snap = rec.snapshot();
		assert.ok(snap, "capture open");
		assert.deepStrictEqual(snap.ev, []);
	});
	it("without an activity limit and with short activity no capture opens; a capture without start closes after quiet", () => {
		const plain = new RunRecorder(10_000, 1);
		for (let i = 0; i < 60; i++) {
			plain.sample(300, i * 10_000);
		}
		assert.strictEqual(plain.capturing, false);
		const short = new RunRecorder(10_000, 1);
		short.setActivityLimit(15);
		for (let i = 0; i < 60; i++) {
			short.sample(i % 20 < 10 ? 300 : 0.5, i * 10_000);
		}
		assert.strictEqual(short.capturing, false);
		const rec = new RunRecorder(10_000, 1);
		rec.setActivityLimit(15);
		let closed = null;
		for (let i = 0; i < 400 && !closed; i++) {
			const v = i < 60 ? 300 : 0.5;
			rec.sample(v, i * 10_000);
			closed = rec.closeIfDue(i * 10_000, 15);
		}
		assert.ok(closed, "closed");
		assert.deepStrictEqual(closed.ev, []);
		// 30 minutes of quiet after the last activity (index 59)
		assert.ok(closed.t0 + (closed.cells.length - 1) * 10_000 >= 59 * 10_000 + 30 * 60_000);
	});
	it("history statistics are kept per tick, not as raw point objects", async () => {
		const pts = Array.from({ length: 3600 }, (_, i) => ({
			ts: 1_700_000_000_000 + i * 1000,
			val: i % 2 ? 300 : 301,
		}));
		const s = await loadHistorySeriesForTest(pts, { stepMs: 10_000 });
		assert.strictEqual(s.raw, undefined);
		assert.strictEqual(s.rep.count[5], 10);
		assert.ok(s.rep.maxGapMs[5] <= 1000);
	});
	it("the history loader reports gaps across day borders, cleaning results and the settings", async () => {
		const now = 10 * DAY;
		const rows = [
			{ ts: now - DAY - 60_000, val: 5 },
			{ ts: now - DAY + 120_000, val: -3 },
			{ ts: now - DAY + 130_000, val: null },
			{ ts: now - 30_000, val: 7 },
		];
		const e = historyEnv(rows, { changesRelogInterval: 600, blockTime: 50 }, { round: 2 });
		const { series, meta, rep, clean } = await loadHistorySeries(e, "history.0", "plug.0.power", now, 10);
		assert.deepStrictEqual(meta.settings, {
			relogSec: 600,
			ignoreZero: false,
			ignoreBelowZero: false,
			debounceMs: 0,
			blockTimeMs: 50,
			round: 2,
		});
		const tick = ts => Math.ceil((ts - series.t0) / series.stepMs);
		assert.strictEqual(rep.count[tick(now - DAY + 120_000)], 1);
		assert.strictEqual(rep.maxGapMs[tick(now - DAY + 120_000)], 180_000);
		assert.strictEqual(rep.maxGapMs[tick(now - 30_000)], DAY - 150_000);
		assert.strictEqual(series.last[tick(now - DAY + 120_000)], 0);
		assert.strictEqual(clean.invalidShare, 0.5);
	});
	it("the history loader can start at a given time", async () => {
		const now = 10 * DAY;
		const e = historyEnv([{ ts: now - 2 * HOUR, val: 4 }]);
		const { series, meta } = await loadHistorySeries(
			e,
			"history.0",
			"plug.0.power",
			now,
			10,
			undefined,
			now - 3 * HOUR,
		);
		assert.strictEqual(series.t0, now - 3 * HOUR);
		assert.strictEqual(meta.days, 1);
		assert.strictEqual(e.calls.length, 1);
		assert.strictEqual(e.calls[0].start, now - 3 * HOUR);
	});
	it("a jump back in the history marks the time as unknown", async () => {
		const pts = [
			{ ts: 1_000_000, val: 1 },
			{ ts: 1_500_000, val: 2 },
			{ ts: 1_200_000, val: 3 },
			{ ts: 2_000_000, val: 4 },
		];
		const s = await loadHistorySeriesForTest(pts, { stepMs: 10_000 });
		assert.deepStrictEqual(s.clean.unknown, [{ from: 1_200_000, to: 1_500_000 }]);
		const tick = ts => Math.ceil((ts - s.series.t0) / s.series.stepMs);
		assert.strictEqual(s.series.valid[tick(1_300_000)], 0);
		assert.strictEqual(s.series.valid[tick(1_800_000)], 1);
	});
});
