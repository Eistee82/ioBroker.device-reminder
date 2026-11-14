import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
	asKw,
	BASE_TS,
	layoutOf,
	layoutRun,
	loadSeries,
	restartScenarios,
	runIndex,
	ticksOf,
	withGap,
} from "./helpers/fixtures.js";

describe("real-data fixtures", () => {
	it("washer30d: 13 indexed runs, neutral times, 12 complete runs in the layout", () => {
		const pts = loadSeries("washer30d");
		assert.strictEqual(runIndex("washer30d").length, 13);
		assert.strictEqual(pts[0].ts, BASE_TS);
		assert.ok(pts.at(-1).ts - BASE_TS < 14 * 86_400_000);
		assert.strictEqual(pts.length, 19_816);
		assert.strictEqual(layoutOf(pts).L.runs.length, 12);
	});
	it("w01–w12 are found by the layout within 5 min of their index entry", () => {
		for (const { id } of runIndex("washer30d").slice(0, 12)) {
			assert.ok(layoutRun("washer30d", id).info, id);
		}
	});
	it("dryer: 7 runs; boiler4d: 2367 points over more than 3.5 days", () => {
		assert.strictEqual(layoutOf(loadSeries("dryer")).L.runs.length, 7);
		const b = loadSeries("boiler4d");
		assert.strictEqual(b.length, 2367);
		assert.ok(b.at(-1).ts - b[0].ts > 3.5 * 86_400_000);
	});
	it("72 restart scenarios with run B after the gap", () => {
		const sc = restartScenarios();
		assert.strictEqual(sc.length, 72);
		assert.strictEqual(new Set(sc.map(x => x.key)).size, 72);
		assert.ok(sc.every(x => x.bOn > x.aEnd && x.bOn < x.values.length));
	});
	it("defects change only what they say", () => {
		const pts = loadSeries("washer30d");
		const at = runIndex("washer30d")[7].ts + 3_600_000;
		const gap = withGap(pts, at, 20);
		assert.ok(gap.every(p => p.ts < at || p.ts >= at + 20 * 60_000));
		assert.strictEqual(asKw(pts)[100].val, pts[100].val / 1000);
		assert.strictEqual(ticksOf(pts).length, layoutOf(pts).s.length);
	});
	it("v4store is an old store: v 1, no rev, envelope fed by evicted runs", () => {
		const st = JSON.parse(readFileSync(new URL("./fixtures/v4store.json", import.meta.url), "utf8"));
		assert.strictEqual(st.v, 1);
		assert.strictEqual(st.typeHash, "39417b8a");
		assert.ok(st.runs.every(r => r.rev === undefined));
		assert.ok(st.envelope.n > st.runs.length);
		assert.ok(st.runs[0].ts >= BASE_TS);
	});
});
