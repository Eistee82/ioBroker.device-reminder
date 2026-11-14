import assert from "node:assert";
import { layoutOf, loadSeries, runIndex, runWindow, timelineOf } from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const D = loadSeries("dryer");

describe("layout: programme end and tail", () => {
	it("washer: tail separated, tailCeil = 1.1 × 113 W", () => {
		const { L } = layoutOf(W);
		assert.strictEqual(L.tailSeparated, true);
		assert.strictEqual(Math.round(L.tailCeil), 124);
	});
	it("washer: progEnd lies in every run between from and runEnd, at the end of the final spin", () => {
		const { L, s } = layoutOf(W);
		L.runs.forEach((r, k) => {
			assert.ok(r.from < r.progEnd && r.progEnd <= r.runEnd, JSON.stringify(r));
			assert.ok(s.last[r.progEnd] > L.tailCeil);
			assert.ok(r.endBlockFrom <= r.progEnd, `run ${k}`);
			// w04 (k = 3): its final spin is shorter than 2 min, the end block is the heating before it
			if (k !== 3) {
				assert.ok(r.progEnd <= r.endBlockTo + 1, `run ${k}`);
			}
		});
	});
	it("dryer: anti-crease found in 7 of 7 runs, not separated, tailCeil = runLimit, progEnd = runEnd", () => {
		const { L } = layoutOf(D);
		assert.strictEqual(L.runs.filter(r => r.trailerFrom !== null).length, 7);
		assert.strictEqual(L.tailSeparated, false);
		assert.strictEqual(L.tailCeil, L.runLimit);
		assert.ok(L.runs.every(r => r.progEnd === r.runEnd));
	});
	it("washer: the end block is the final spin (above 1.25 × burst maximum), not the whole run", () => {
		const { L } = layoutOf(W);
		assert.ok(L.burstMaxW >= 100 && L.burstMaxW <= 113, String(L.burstMaxW));
		// w04 (k = 3) is the 41-min programme
		L.runs.forEach((r, k) => {
			if (k !== 3) {
				assert.ok((r.endBlockFrom - r.from) * 10 >= 3600, `run ${k}: end block starts after an hour`);
			}
		});
	});
	it("maxRuns: Infinity keeps all 25 runs of a 25-day timeline; the default keeps the newest 20", () => {
		// w01: its window holds no other run (the window of w08 ends inside w09)
		const pts = timelineOf(
			Array.from({ length: 25 }, () => runWindow("washer30d", "w01")),
			86_400_000,
		);
		assert.strictEqual(layoutOf(pts, 10_000, { maxRuns: Infinity }).L.runs.length, 25);
		assert.strictEqual(layoutOf(pts).L.runs.length, 20);
	});
	it("the run at the data end (w13) is listed as incomplete", () => {
		const { L, s } = layoutOf(W);
		const w13 = runIndex("washer30d").find(r => r.id === "w13").ts;
		assert.ok(
			L.incomplete.some(sp => Math.abs(s.t0 + sp.from * s.stepMs - w13) <= 300_000),
			JSON.stringify(L.incomplete),
		);
	});
});
