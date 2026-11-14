import assert from "node:assert";
import { checkFinalSplit, learnFinal } from "../build/lib/learn/finalLearn.js";
import { admitted } from "../build/lib/learn/quality.js";
import { endOk } from "../build/lib/learn/replay.js";
import { learnInput, soaking, splitPairs, splitPairsOfTicks, WM_312 } from "./helpers/final.js";
import {
	asKw,
	bridge,
	detectorRun,
	dropRandom,
	layoutOf,
	layoutRun,
	loadSeries,
	resample,
	restartScenarios,
	runIndex,
	scale,
	shift,
	ticksOf,
} from "./helpers/fixtures.js";
import { runOf } from "./helpers/programmes.js";

const W = loadSeries("washer30d");
const D = loadSeries("dryer");
const ctxOf = (inp, over = {}) => ({
	base: WM_312,
	pollSec: 10,
	unitFactor: 1,
	abort: false,
	abortFixed: false,
	bands: inp.bands,
	minRuns: 5,
	minPerGroup: 1,
	yieldFn: async () => {},
	...over,
});
const learn = async (pts, over = {}, o = {}) => {
	const inp = learnInput(pts, o);
	return { c: await learnFinal(inp.runs, ctxOf(inp, over)), inp };
};

describe("learn the final phase (Spec B.6)", function () {
	this.timeout(600_000);
	let wm;
	before(async () => {
		wm = await learn(W);
	});

	it("washer: released with 0 early ends and at most 2 fallbacks in the cross-check [S9]", () => {
		assert.deepStrictEqual([wm.c.ok, wm.c.reasons, wm.c.earlyEnds], [true, [], 0]);
		assert.ok(wm.c.fallbacks <= 2 && wm.c.covered >= 5 && wm.c.gainSec >= 60);
	});
	it("washer: P above the tail (113 W) and below the spin (839 W); Pmax between spin and heating; hot = Pmax [S1]", () => {
		const v = wm.c.values;
		assert.ok(v.finalMinVal > 113 && v.finalMinVal < 839, String(v.finalMinVal));
		assert.ok(v.finalMaxVal > 839 && v.finalMaxVal <= 2047, String(v.finalMaxVal));
		assert.strictEqual(v.finalHotVal, v.finalMaxVal);
	});
	it("washer: Y above the longest intermediate spin (1.9 min) and below the shortest final spin (4 min)", () => {
		assert.ok(wm.c.values.finalMinSec > 114 && wm.c.values.finalMinSec < 240, String(wm.c.values.finalMinSec));
	});
	it("washer: X = 0.5 × p10 of the final block start; G 60; Z = max(120, 2 × longest dip in the final block)", () => {
		const L = wm.inp.layout;
		const s = wm.inp.series;
		const starts = L.runs.map(r => (r.endBlockFrom - r.from) * 10).sort((a, b) => a - b);
		assert.ok(wm.c.values.finalAfterSec >= 0.5 * starts[0] && wm.c.values.finalAfterSec <= 0.5 * starts[2]);
		assert.strictEqual(wm.c.values.finalDipSec, 60);
		let dip = 0;
		for (const r of L.runs) {
			let run = 0;
			for (let i = r.endBlockFrom; i <= r.endBlockTo; i++) {
				run = s.last[i] < wm.c.values.finalMinVal ? run + 10 : 0;
				dip = Math.max(dip, run);
			}
		}
		assert.strictEqual(wm.c.values.finalQuietSec, Math.max(120, 2 * dip));
	});
	it("washer: rest = run limit (5.5 W) for 60 s; activity 1.5 × tail rest level 6 W = 9 W, share 0.6–0.8 [S1, S12]", () => {
		const v = wm.c.values;
		assert.deepStrictEqual([v.finalRestVal, v.finalRestSec], [wm.inp.layout.runLimit, 60]);
		assert.ok(
			Math.abs(v.finalActVal - 9) <= 0.5 && v.finalActShare >= 0.6 && v.finalActShare <= 0.8,
			JSON.stringify(v),
		);
	});
	it("washer: check window ≥ 30 min and ≤ lock; lock = max(30 min, 1.5 × longest early end → inner end), ≤ 4 h", () => {
		const v = wm.c.values;
		const vals = ticksOf(W);
		const a = detectorRun(vals, WM_312);
		const b = detectorRun(vals, { ...WM_312, ...v });
		let longest = 0;
		for (const r of wm.inp.layout.runs) {
			const fa = a.ev.find(x => x.e === "finished" && x.i >= r.from);
			const fb = b.ev.find(x => x.e === "finished" && x.i >= r.from);
			longest = Math.max(longest, (fa.i - fb.i) * 10);
		}
		assert.ok(Math.abs(v.finalLockSec - Math.min(14_400, Math.max(1800, 1.5 * longest))) <= 10);
		assert.ok(v.finalCheckSec >= 1800 && v.finalCheckSec <= v.finalLockSec);
	});
	it("the released values give no early end under ±10 % power, poll ×3, 30 % missing values, one poll later", () => {
		// judged against the runs of the 10-s recording admitted for the end: w04 (sparse, quarantine) is reported
		// 8.5 min early also without the final phase, and a layout at 30 s does not find the trailer of w07
		const v = { ...WM_312, ...wm.c.values };
		const { layout: L, series: s } = wm.inp;
		const usedAt = wm.inp.runs
			.filter(x => x.sample.kind === "run" && admitted(x.verdict, "end"))
			.map(x => x.sample.facts.start);
		const used = w => usedAt.includes(s.t0 + w.runStartIdx * s.stepMs);
		for (const [name, pts, step] of [
			["×0.9", scale(W, 0.9), 10_000],
			["×1.1", scale(W, 1.1), 10_000],
			["poll×3", W, 30_000],
			["30 % missing", dropRandom(W, 0.3, 5), 10_000],
			["one poll later", shift(W, 10_000), 10_000],
		]) {
			const r = detectorRun(ticksOf(pts, step, s.t0), v, { pollSec: step / 1000 });
			const ws = L.windows.filter(w => w.run !== null && used(w));
			assert.ok(ws.length >= 10);
			ws.forEach(w => {
				const f = r.ev.find(x => x.e === "finished" && x.i * step >= w.runStartIdx * s.stepMs);
				const sim = { started: 1, aborted: 0, finished: f ? [s.t0 + f.i * step] : [], startedAt: [] };
				assert.ok(endOk(s, w, sim, L.runs[w.run].progEnd), `${name} run ${w.run}`);
			});
		}
	});
	it("dryer: no candidate, reason noSeparation", async () => {
		const { c } = await learn(D, { base: { ...WM_312, startVal: 120, endCount: 20 } });
		assert.strictEqual(c.ok, false);
		assert.ok(c.reasons.includes("noSeparation"), c.reasons.join());
	});
	it("device without a tail and a short end wait (≤ Z): reason noGain", async () => {
		// with WM_312 (endCount 50 = 500 s) the final phase would gain against Z = 120 s; endCount 10 = 100 s ≤ Z gains nothing
		const pts = [];
		for (let k = 0; k < 8; k++) {
			const r = runOf({ device: "washer", programme: "cotton60", seed: k + 1, after: 200 });
			r.values.forEach((v, i) => pts.push({ ts: 1_700_000_000_000 + k * 86_400_000 + i * 10_000, val: v }));
		}
		const { c } = await learn(pts, { base: { ...WM_312, endCount: 10 } });
		assert.ok(!c.ok && c.reasons.includes("noGain"), c.reasons.join());
	});
	it("two runs grown together (merged): only the end of the whole run counts, the inner end and start block nothing (decision 9)", async () => {
		// 40 W stored every 10 s from the core end of w10 to the start of w11 (as in the run check test of merged)
		const { info: a, s } = layoutRun("washer30d", "w10");
		const from = s.t0 + (a.coreEnd + 1) * s.stepMs;
		const w11 = runIndex("washer30d").find(r => r.id === "w11").ts;
		const pts = bridge(
			[...W.filter(p => p.ts < from || p.ts >= w11), ...resample(W, from, w11, 10_000)].sort(
				(x, y) => x.ts - y.ts,
			),
			from,
			w11,
			40,
		);
		const { c, inp } = await learn(pts);
		const m = inp.runs.find(x => x.verdict.reasons.some(r => r.code === "merged"));
		assert.ok(m && admitted(m.verdict, "end") && !admitted(m.verdict, "final"));
		assert.deepStrictEqual([c.ok, c.reasons, c.earlyEnds], [true, [], 0]);
		// the last end of the whole run comes after its end
		const r = detectorRun(ticksOf(pts, 10_000, inp.series.t0), { ...WM_312, ...c.values });
		const i0 = (m.sample.facts.start - inp.series.t0) / 10_000;
		const i1 = (m.sample.facts.runEnd - inp.series.t0) / 10_000;
		const last = r.ev.filter(x => x.e === "finished" && x.i >= i0 && x.i <= i1 + 360).at(-1);
		assert.ok(last && last.i >= i1, JSON.stringify(last));
	});
	it("scope continuous: no final phase", async () => {
		const inp = learnInput(W);
		const c = await learnFinal(inp.runs, ctxOf(inp, { scope: "continuous" }));
		assert.deepStrictEqual([c.ok, c.reasons], [false, ["continuous"]]);
	});
	it("high load after the final block in one run → finalHotVal 0", async () => {
		const { L, s } = layoutOf(W);
		const r = L.runs[8];
		const at = s.t0 + (r.coreEnd + 30) * s.stepMs;
		const pts = W.map(p => (p.ts >= at && p.ts < at + 70_000 ? { ts: p.ts, val: 2100 } : p));
		const { c } = await learn(pts);
		assert.strictEqual(c.values.finalHotVal, 0);
	});
	it("tail with values in the final band → tailInBand", async () => {
		const { L, s } = layoutOf(W);
		const at = s.t0 + (L.runs[8].coreEnd + 60) * s.stepMs;
		const pts = [
			...W.filter(p => p.ts < at || p.ts > at + 40_000),
			{ ts: at, val: 300 },
			{ ts: at + 40_000, val: 6 },
		].sort((a, b) => a.ts - b.ts);
		const { c } = await learn(pts);
		assert.ok(c.reasons.includes("tailInBand"), c.reasons.join());
	});
	it("a too active tail switches exit f off (finalActVal 0)", async () => {
		// bursts over ≥ 70 % of the tail time; raising the rest values instead would raise the learned rest level with them
		const { L, s } = layoutOf(W);
		let pts = W;
		for (const r of L.runs) {
			const from = s.t0 + (r.coreEnd + 20) * s.stepMs;
			pts = pts.filter(p => p.ts < from || p.ts >= from + 1_800_000);
			for (let t = from; t < from + 1_800_000; t += 10_000) {
				pts.push({ ts: t, val: (t - from) % 100_000 < 70_000 ? 60 : 6 });
			}
		}
		pts.sort((a, b) => a.ts - b.ts);
		const { c } = await learn(pts);
		assert.deepStrictEqual([c.values.finalActVal, c.values.finalActShare], [0, 0]);
	});
	it("kW state: power values ÷ 1000, times unchanged (Review Focus 4)", async () => {
		const { c } = await learn(
			asKw(W),
			{ unitFactor: 1000, base: { ...WM_312, startVal: 0.03, endVal: 0.015, standby: 0.001 } },
			{ unitFactor: 1000 },
		);
		for (const k of ["finalMinVal", "finalMaxVal", "finalHotVal", "finalRestVal", "finalActVal"]) {
			assert.ok(Math.abs(c.values[k] * 1000 - wm.c.values[k]) <= 1e-6 * Math.max(1, wm.c.values[k]), k);
		}
		for (const k of ["finalAfterSec", "finalMinSec", "finalQuietSec", "finalLockSec"]) {
			assert.strictEqual(c.values[k], wm.c.values[k], k);
		}
	});
	it("poll 600 s: learned Y below 2 polls → outOfRange instead of clamping", async () => {
		const { c } = await learn(W, { pollSec: 600 });
		assert.ok(c.reasons.includes("outOfRange"), c.reasons.join());
	});
	it("too few runs or too few per group", async () => {
		const few = learnInput(W);
		assert.ok((await learnFinal(few.runs.slice(0, 4), ctxOf(few))).reasons.includes("tooFewRuns"));
		const alone = learnInput(W);
		alone.runs[2].sample.family = 99;
		assert.ok((await learnFinal(alone.runs, ctxOf(alone, { minPerGroup: 2 }))).reasons.includes("fewPerGroup"));
	});
	it("finalSplit: the rest of a soaking programme → true; a real restart after unloading → false", () => {
		const clean = learnInput(W);
		const others = clean.runs.map(x => x.sample);
		const soak = splitPairs(soaking(W, 8), wm.c.values);
		assert.strictEqual(soak.length, 1);
		assert.strictEqual(
			checkFinalSplit(soak[0].prev, soak[0].next, others, clean.bands, wm.c.values.finalRestVal),
			true,
		);
		const sc = restartScenarios().find(x => x.key === "warm/0/5.5/10/18");
		const real = splitPairsOfTicks(sc.values, wm.c.values);
		assert.strictEqual(real.length, 1);
		assert.strictEqual(
			checkFinalSplit(real[0].prev, real[0].next, others, clean.bands, wm.c.values.finalRestVal),
			false,
		);
		// without comparison data: a real restart after unloading (rest between the parts) is no split
		assert.strictEqual(checkFinalSplit(real[0].prev, real[0].next, [], null, wm.c.values.finalRestVal), false);
	});
	it("finalSplit without comparison data: a pause longer than every rest of the early part is no split (known limit)", () => {
		const clean = learnInput(W);
		const others = clean.runs.map(x => x.sample);
		const [p] = splitPairs(soaking(W, 8), wm.c.values);
		const rest = wm.c.values.finalRestVal;
		// the 45 min soaking pause looks like unloading as long as only the rest counts (exit b proves at least 60 s)
		assert.strictEqual(p.next.afterFinal, "b");
		assert.strictEqual(checkFinalSplit(p.prev, p.next, [], null, rest), false);
		assert.strictEqual(checkFinalSplit(p.prev, p.next, others.slice(0, 2), clean.bands, rest), false, "2 runs");
		assert.strictEqual(checkFinalSplit(p.prev, p.next, others, null, rest), false, "no bands");
		// from 3 clean runs with bands the missing start sequence finds it
		assert.strictEqual(checkFinalSplit(p.prev, p.next, others.slice(0, 3), clean.bands, rest), true);
	});
	it("too small Y on washer30d: all 11 rests are judged finalSplit (acceptance [S7])", () => {
		// 11 layout runs (w01–w12 without the short w04) plus w13 at the data end, a whole programme for the detector
		const inp = learnInput(W);
		const small = { ...wm.c.values, finalMinSec: 30, finalActVal: 0, finalActShare: 0 };
		const pairs = splitPairs(W, small);
		assert.strictEqual(pairs.length, 12);
		assert.ok(
			pairs.every(p =>
				checkFinalSplit(
					p.prev,
					p.next,
					inp.runs.map(x => x.sample),
					inp.bands,
					small.finalRestVal,
				),
			),
		);
		// without comparison data the programme continuing without a rest is still a split
		assert.ok(pairs.every(p => checkFinalSplit(p.prev, p.next, [], null, small.finalRestVal)));
	});
});
