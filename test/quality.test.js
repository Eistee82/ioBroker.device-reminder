import assert from "node:assert";
import { baseBandsOf } from "../build/lib/learn/bands.js";
import {
	admitted,
	checkRuns,
	daySamples,
	primaryOf,
	runSamples,
	sameRun,
	stageOf,
	usesOf,
	verdictKey,
} from "../build/lib/learn/quality.js";
import {
	asKw,
	BASE_TS,
	bridge,
	handTest,
	layoutRun,
	loadSeries,
	resample,
	runIndex,
	shift,
	withForeign,
	withGap,
	withHold,
	withRelog,
	withSpikes,
} from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const ctx0 = { unitFactor: 1, unit: "W", settings: null, pollMs: 10_000, outages: [], scope: "run" };
function judge(points, over = {}, o = { stepMs: 10_000, src: "history", unitFactor: 1 }) {
	const { samples, layout } = runSamples("wm", points, o);
	const bands = baseBandsOf(samples, layout.runLimit);
	const v = checkRuns(samples, { ...ctx0, bands, ...over });
	const of = id => {
		const ts = runIndex("washer30d").find(r => r.id === id).ts;
		const k = samples.findIndex(s => Math.abs(s.info ? s.from - ts : Infinity) <= 300_000);
		return { v: v[k], s: samples[k], codes: v[k].reasons.map(r => r.code).sort() };
	};
	return { samples, v, of };
}
const base = judge(W);
const day = id => runIndex("washer30d").find(r => r.id === id).ts;

describe("run check (Spec B.2)", () => {
	it("w04 (06.11. 13:37) is sparse, not test, in quarantine", () => {
		const { codes, v } = base.of("w04");
		assert.ok(codes.includes("sparse") && !codes.includes("test"), codes.join());
		assert.strictEqual(v.stage, "quarantine");
	});
	it("the same 41-min programme sampled densely, among the other runs, is rare and used (P1)", () => {
		// w04 inside the whole recording replaced by its densely re-sampled version: the run check compares it with the other runs
		const from = day("w04") - 60_000;
		const to = day("w04") + 45 * 60_000;
		const dense = [...W.filter(p => p.ts < from || p.ts >= to), ...resample(W, from, to, 5_000)].sort(
			(a, b) => a.ts - b.ts,
		);
		const { v, codes } = judge(dense).of("w04");
		assert.ok(!codes.includes("sparse") && !codes.includes("test"), codes.join());
		assert.ok(codes.includes("rare"), codes.join());
		assert.ok(admitted(v, "end"));
	});
	it("w02 is rare and trailerCut (limited, used for the end); w07 only rare; w06 used", () => {
		const a = base.of("w02");
		assert.ok(a.codes.includes("rare") && a.codes.includes("trailerCut"), a.codes.join());
		assert.deepStrictEqual([a.v.stage, a.v.uses.end, a.v.uses.trailer], ["limited", true, false]);
		assert.deepStrictEqual(base.of("w07").codes, ["rare"]);
		assert.strictEqual(base.of("w07").v.stage, "ok");
		assert.ok(["ok", "limited"].includes(base.of("w06").v.stage));
	});
	it("w05 is trailerCut, w12 has no finding (P8)", () => {
		assert.deepStrictEqual(base.of("w05").codes, ["trailerCut"]);
		assert.deepStrictEqual(base.of("w12").codes, []);
	});
	it("the other normal runs are never in quarantine", () => {
		for (const id of ["w01", "w03", "w08", "w09", "w10", "w11"]) {
			assert.ok(["ok", "limited"].includes(base.of(id).v.stage), id);
		}
	});
	it("w13 at the data end is incomplete and unusable", () => {
		const k = base.samples.findIndex(s => s.from >= day("w13") - 300_000);
		assert.ok(
			k >= 0 && base.samples[k].kind === "incomplete",
			"the layout drops it, runSamples keeps it as incomplete",
		);
		assert.ok(base.v[k].reasons.some(r => r.code === "incomplete"));
		assert.strictEqual(base.v[k].stage, "unusable");
	});
	it("three equal clean short runs form a group of their own and are used", () => {
		// up to 68 min: after the rest level (switched off at 66 min), before w05 starts (71 min); the recording
		// goes on after the last copy (otherwise it touches the data end and is incomplete)
		const short = resample(W, day("w04") - 60_000, day("w04") + 68 * 60_000, 5_000);
		const end = W.at(-1).ts + 3_600_000;
		const extra = [1, 2, 3].flatMap(k => shift(short, end + k * 86_400_000 - short[0].ts));
		const r = judge([...W, ...extra, { ts: end + 4 * 86_400_000, val: 0 }]);
		const ks = r.samples.map((s, i) => i).filter(i => r.samples[i].from > end);
		assert.strictEqual(ks.length, 3);
		assert.strictEqual(new Set(ks.map(i => r.samples[i].family)).size, 1);
		assert.ok(ks.every(i => admitted(r.v[i], "end")));
	});
	it("a proven gap via relog makes the run unusable", () => {
		const pts = withGap(withRelog(W, 300_000), day("w08") + 3_600_000, 20);
		const { v, codes } = judge(pts, {
			settings: {
				relogSec: 300,
				ignoreZero: false,
				ignoreBelowZero: false,
				debounceMs: 0,
				blockTimeMs: 0,
				round: null,
			},
		}).of("w08");
		assert.ok(codes.includes("gap") && v.reasons.find(r => r.code === "gap").detail.startsWith("proven"));
		assert.strictEqual(v.stage, "unusable");
	});
	it("a hold of 20 min at 250 W is a suspect gap with a profile, nothing without one (P2, P28)", () => {
		const pts = withHold(W, day("w08") + 3_600_000, 20, 250);
		const a = judge(pts).of("w08");
		assert.ok(a.v.reasons.find(r => r.code === "gap")?.detail.startsWith("suspect"));
		assert.strictEqual(a.v.stage, "quarantine");
		// two runs only (w10, w11 with idle after them; w08 ends 21 min before w09 and would touch the data end)
		const two = withHold(W, day("w11") + 3_600_000, 20, 250).filter(
			p => p.ts >= day("w10") - 1_800_000 && p.ts < day("w12") - 1_800_000,
		);
		const b = judge(two).of("w11");
		assert.ok(!b.codes.includes("gap"), b.codes.join());
	});
	it("stuck needs 20 equal reports; a long hold without reports is never stuck (P2)", () => {
		const { samples, layout } = runSamples("wm", withHold(W, day("w08") + 3_600_000, 15, 250), {
			stepMs: 10_000,
			src: "live",
			unitFactor: 1,
		});
		const k = samples.findIndex(s => Math.abs(s.from - day("w08")) <= 300_000);
		const bands = baseBandsOf(samples, layout.runLimit);
		samples[k].reports = Array.from({ length: 25 }, (_, i) => day("w08") + 3_600_000 + i * 36_000);
		assert.ok(checkRuns(samples, { ...ctx0, bands })[k].reasons.some(r => r.code === "stuck"));
		samples[k].reports = [];
		assert.ok(!checkRuns(samples, { ...ctx0, bands })[k].reasons.some(r => r.code === "stuck"));
	});
	it("boiler: 52 min at 254 W is no finding; 4 usable day units (the last one only ends at the data end)", () => {
		const B = loadSeries("boiler4d");
		const s = daySamples("kessel", B, { stepMs: 10_000, src: "history", unitFactor: 1 });
		const v = checkRuns(s, { ...ctx0, scope: "continuous", bands: baseBandsOf(s, 35, { mode: "raw", dipSec: 5 }) });
		assert.strictEqual(v.length, 4);
		assert.ok(
			v.every(x => x.stage !== "unusable" && x.stage !== "quarantine"),
			JSON.stringify(v.map(x => x.reasons)),
		);
	});
	it("kW without unit text → unit (template peak); Wh → counter", () => {
		const kw = judge(asKw(W), { unitFactor: 1, templatePeakW: 2000 });
		assert.ok(kw.v.length > 0, "the layout finds the runs in kW values");
		assert.ok(kw.v.every(x => x.reasons.some(r => r.code === "unit") && x.stage === "unusable"));
		const wh = judge(W, { unit: "Wh" });
		assert.ok(wh.v.every(x => x.reasons.some(r => r.code === "counter")));
	});
	it("raised level before a run → foreign (1); long heating inside the known band is never foreign (P7)", () => {
		// a foreign load next to a running washer is activity (run level 5.5 W) and joins the run, so (1) is
		// shown on a device with a standby of 30 W (run level 92 W): +50 W in the 30 min before run 3
		const pts = [];
		for (let k = 0; k < 6; k++) {
			const t0 = BASE_TS + k * 86_400_000;
			for (let t = t0; t < t0 + 3 * 3_600_000; t += 10_000) {
				const m = (t - t0) / 60_000;
				const val = m >= 60 && m < 120 ? (Math.floor(m / 2) % 2 ? 600 : 400) : 30;
				pts.push({ ts: t, val: val + (k === 3 && m >= 30 && m < 60 ? 50 : 0) });
			}
		}
		const r = judge(pts);
		const runs = r.v.filter((_, i) => r.samples[i].kind === "run");
		assert.strictEqual(runs.length, 6);
		assert.deepStrictEqual(
			runs.map(x => x.reasons.some(y => y.code === "foreign")),
			[false, false, false, true, false, false],
		);
		assert.ok(!base.of("w07").codes.includes("foreign"));
	});
	it("a foreign load far above the highest band for more than 5 % of the run → foreign (2)", () => {
		// +2000 W during both heating blocks of w09 (14.5 min): about 4100 W > 1.5 × p99.9 of the other runs
		const a = judge(withForeign(W, day("w09") + 60_000, 17, 2000)).of("w09");
		assert.ok(a.codes.includes("foreign"), a.codes.join());
		assert.strictEqual(a.v.stage, "quarantine");
	});
	it("devices whose clean runs touch one band only never get test by feature 3", () => {
		const pts = [];
		for (let k = 0; k < 6; k++) {
			const t0 = BASE_TS + k * 86_400_000;
			pts.push(
				{ ts: t0, val: 0.3 },
				{ ts: t0 + 3_600_000, val: 10 },
				{ ts: t0 + 3_600_000 + 7_200_000, val: 0.3 },
			);
		}
		const r = judge(pts);
		assert.ok(r.v.every(x => !x.reasons.some(y => y.code === "test")));
	});
	it("a device whose runs are all short (kettle) keeps its runs (5–9 min): no test by feature 2", () => {
		const pts = [];
		for (let k = 0; k < 12; k++) {
			const t0 = BASE_TS + k * 86_400_000;
			const len = (5 + (k % 5)) * 60_000;
			pts.push({ ts: t0, val: 0.4 });
			for (let x = 0; x < len; x += 5_000) {
				pts.push({ ts: t0 + 3_600_000 + x, val: 1800 + ((k * 37 + x / 5_000) % 7) * 40 });
			}
			pts.push({ ts: t0 + 3_600_000 + len, val: 0.4 });
		}
		pts.push({ ts: BASE_TS + 12 * 86_400_000, val: 0.4 });
		const r = judge(pts);
		const runs = r.v.filter((x, i) => r.samples[i].kind === "run");
		assert.ok(runs.length >= 10, `${runs.length} runs`);
		assert.ok(
			runs.every(x => !x.reasons.some(y => y.code === "test") && x.stage !== "quarantine"),
			JSON.stringify(runs.map(x => x.reasons)),
		);
	});
	it("hand tests of 3 min 2000 W and 5 min 300 W are test (quarantine)", () => {
		const end = W.at(-1).ts + 3_600_000;
		// the recording goes on after the second test (otherwise it touches the data end and is incomplete)
		// the first load 1 min after `end`, so that its sample (from the tick before the load) lies after `end`
		const r = judge([
			...W,
			...handTest(end + 60_000, 3, 2000),
			...handTest(end + 86_400_000, 5, 300),
			{ ts: end + 2 * 86_400_000, val: 0.5 },
		]);
		const late = r.v.filter((x, i) => r.samples[i].from > end);
		assert.strictEqual(late.length, 2, "the 3-min test is a spike sample, the 5-min test a run sample");
		assert.deepStrictEqual(
			r.samples
				.filter(s => s.from > end)
				.map(s => s.kind)
				.sort(),
			["run", "spike"],
		);
		assert.ok(late.every(x => x.reasons.some(y => y.code === "test") && x.stage === "quarantine"));
	});
	it("two runs grown together → merged: limited, used for the end of the whole run only, never quarantine (decision 9)", () => {
		const { info: a, s } = layoutRun("washer30d", "w10");
		// 40 W stored every 10 s between the core end of w10 and the start of w11 (a logger storing changes only
		// would hold one value for 20 min there, which is a suspect gap and not what this test is about)
		const from = s.t0 + (a.coreEnd + 1) * s.stepMs;
		const dense = [
			...W.filter(p => p.ts < from || p.ts >= day("w11")),
			...resample(W, from, day("w11"), 10_000),
		].sort((x, y) => x.ts - y.ts);
		const pts = bridge(dense, from, day("w11"), 40);
		const r = judge(pts);
		const m = r.v.find(x => x.reasons.some(y => y.code === "merged"));
		assert.ok(m, "found by layout features: duration > 1.8 × group maximum and two end blocks");
		assert.deepStrictEqual([m.stage, m.uses.end, m.uses.final, m.uses.phases], ["limited", true, false, false]);
		assert.strictEqual(primaryOf(m.reasons), "merged");
	});
	it("spikes, aborted, invalid, historyCfg are limited with their uses", () => {
		// spike = single value > 3 × p99.9 of the runs (p99.9 ≈ 2268 W, review/p999.mjs) → 9000 W
		const sp = judge(withSpikes(W, 3, 9000, 7)).v;
		assert.ok(sp.some(x => x.reasons.some(y => y.code === "spike") && x.stage === "limited"));
		const { samples, layout } = runSamples("wm", W, { stepMs: 10_000, src: "live", unitFactor: 1 });
		samples[7].aborted = true;
		const v = checkRuns(samples, { ...ctx0, bands: baseBandsOf(samples, layout.runLimit) });
		assert.deepStrictEqual([v[7].stage, v[7].uses.start, v[7].uses.end], ["limited", true, false]);
		const deb = judge(W, {
			settings: {
				relogSec: 0,
				ignoreZero: true,
				ignoreBelowZero: false,
				debounceMs: 20_000,
				blockTimeMs: 0,
				round: null,
			},
		}).v[0];
		assert.ok(deb.reasons.some(r => r.code === "historyCfg"));
		assert.deepStrictEqual([deb.uses.phases, deb.uses.trailer, deb.uses.rest], [false, false, false]);
	});
	it("formerlyDropped inside the range of an old store, use unchanged (P16)", () => {
		const keys = base.samples.filter(s => Math.abs(s.from - day("w05")) > 300_000).map(s => s.key);
		const r = judge(W, { oldStore: { from: day("w01") - 1, to: day("w12") + 1, keys } }).of("w05");
		assert.ok(r.codes.includes("formerlyDropped"));
		assert.deepStrictEqual(r.v.uses, base.of("w05").v.uses);
	});
	it("ranking and keys", () => {
		const R = codes => codes.map(code => ({ code, detail: code === "gap" ? "suspect" : "" }));
		assert.strictEqual(stageOf(R(["incomplete", "test"])), "unusable");
		assert.strictEqual(stageOf(R(["sparse", "rare"])), "quarantine");
		assert.strictEqual(primaryOf(R(["test", "sparse"])), "sparse");
		assert.strictEqual(stageOf(R(["trailerCut", "rare"])), "limited");
		assert.strictEqual(stageOf(R(["rare"])), "ok");
		assert.strictEqual(stageOf(R(["finalSplit"])), "ok");
		assert.strictEqual(stageOf(R(["merged"])), "limited");
		assert.strictEqual(verdictKey("wm", 1_700_000_123_456), "wm@28333335");
	});
	it("user decisions win except over unusable", () => {
		const v = { ...base.of("w04").v, user: "include" };
		assert.strictEqual(admitted(v, "end"), true);
		assert.strictEqual(admitted({ ...base.of("w12").v, user: "exclude" }, "end"), false);
		assert.strictEqual(admitted({ ...base.of("w04").v, stage: "unusable", user: "include" }, "end"), false);
	});
});

describe("run check – further findings", () => {
	const live = runSamples("wm", W, { stepMs: 10_000, src: "live", unitFactor: 1 });
	const liveBands = baseBandsOf(live.samples, live.layout.runLimit);
	const k08 = live.samples.findIndex(s => s.info && Math.abs(s.from - day("w08")) <= 300_000);
	it("a silence in the live report log or an outage is a proven gap (unusable)", () => {
		// a report every 10 s in every run (the p99.9 of the intervals comes from all runs), none for 15 min in w08
		const from = live.samples[k08].facts.start;
		const s = live.samples.map(x => {
			const reports = [];
			for (let t = x.facts.start; t <= x.facts.end; t += 10_000) {
				if (x !== live.samples[k08] || t < from + 3_600_000 || t >= from + 4_500_000) {
					reports.push(t);
				}
			}
			// the source reports at every poll, also unchanged values
			return { ...x, reports, repeats: reports.length };
		});
		const v = checkRuns(s, { ...ctx0, bands: liveBands });
		assert.ok(
			v[k08].reasons.some(r => r.code === "gap" && r.detail.startsWith("proven")),
			JSON.stringify(v[k08].reasons),
		);
		assert.strictEqual(v[k08].stage, "unusable");
		const o = checkRuns(live.samples, {
			...ctx0,
			bands: liveBands,
			outages: [{ from: from + 600_000, to: from + 900_000 }],
		});
		assert.strictEqual(o[k08].stage, "unusable");
		assert.strictEqual(checkRuns(live.samples, { ...ctx0, bands: liveBands })[k08].stage, "ok");
	});
	it("a source that reports only changes: a long silence is a hold, no proven gap (Spec 3, B.2 gap (2))", () => {
		// the same report log, but no report carried an unchanged value: 25 min without a report at a constant value
		const from = live.samples[k08].facts.start;
		const s = live.samples.map(x => {
			const reports = [];
			for (let t = x.facts.start; t <= x.facts.end; t += 10_000) {
				if (x !== live.samples[k08] || t < from + 3_600_000 || t >= from + 5_100_000) {
					reports.push(t);
				}
			}
			return { ...x, reports, repeats: 0 };
		});
		const v = checkRuns(s, { ...ctx0, bands: liveBands });
		assert.ok(
			!v[k08].reasons.some(r => r.code === "gap" && r.detail.startsWith("proven: no report")),
			JSON.stringify(v[k08].reasons),
		);
		assert.notStrictEqual(v[k08].stage, "unusable");
	});
	it("invalid values above 1 % and a jump back in time are limited; the jump makes its range unknown", () => {
		const t0 = day("w08") + 3_600_000;
		const bad = [...W, ...Array.from({ length: 200 }, (_, i) => ({ ts: t0 + i * 1000 + 1, val: null }))].sort(
			(x, y) => x.ts - y.ts,
		);
		const a = judge(bad).of("w08");
		assert.ok(a.codes.includes("invalid"), a.codes.join());
		assert.strictEqual(a.v.stage, "limited");
		// a value of w08 arriving again after w09 (jump back of more than a minute)
		const late = [...W.filter(p => p.ts < day("w10")), { ts: t0, val: 300 }, ...W.filter(p => p.ts >= day("w10"))];
		const { samples, layout } = runSamples("wm", late, { stepMs: 10_000, src: "history", unitFactor: 1 });
		const v = checkRuns(samples, { ...ctx0, bands: baseBandsOf(samples, layout.runLimit) });
		const k = samples.findIndex(s => s.facts.timeJumps > 0);
		assert.ok(k >= 0 && v[k].reasons.some(r => r.code === "timeJump"), JSON.stringify(v[k]?.reasons));
		assert.strictEqual(v[k].stage, "unusable", "the unknown range after the jump lies in the run");
	});
	it("a counter unit makes every sample unusable, also short activity", () => {
		const v = judge(W, { unit: "kWh" }).v;
		assert.ok(v.every(x => x.stage === "unusable" && x.reasons.some(r => r.code === "counter")));
	});
	it("dryer: every run is ok or limited, the anti-crease phase is not cut", () => {
		const D = loadSeries("dryer");
		const { samples, layout } = runSamples("tr", D, { stepMs: 10_000, src: "history", unitFactor: 1 });
		const v = checkRuns(samples, { ...ctx0, bands: baseBandsOf(samples, layout.runLimit) });
		const runs = v.filter((_, i) => samples[i].kind === "run");
		assert.strictEqual(runs.length, 7);
		assert.ok(
			runs.every(x => ["ok", "limited"].includes(x.stage) && !x.reasons.some(r => r.code === "trailerCut")),
			JSON.stringify(runs.map(x => x.reasons)),
		);
	});
	it("scope continuous: a suspect hold is a segment finding, the day stays usable", () => {
		const B = loadSeries("boiler4d");
		// 100 min at 254 W, then the value stored before (suspect limit of the burner band 4951 s; over 2 h
		// without a value the tick series would mark the time unknown)
		const at = B[0].ts + 86_400_000 + 3_600_000;
		const after = B.findLast(p => p.ts <= at + 100 * 60_000);
		const held = [...withHold(B, at, 100, 254), { ts: at + 100 * 60_000, val: after.val }].sort(
			(x, y) => x.ts - y.ts,
		);
		const s = daySamples("kessel", held, { stepMs: 10_000, src: "history", unitFactor: 1 });
		const v = checkRuns(s, {
			...ctx0,
			scope: "continuous",
			bands: baseBandsOf(daySamples("kessel", B, { stepMs: 10_000, src: "history", unitFactor: 1 }), 35, {
				mode: "raw",
				dipSec: 5,
			}),
		});
		assert.ok(
			v[1].reasons.some(r => r.code === "gap" && r.detail.startsWith("suspect segment")),
			JSON.stringify(v[1].reasons),
		);
		assert.strictEqual(v[1].stage, "ok");
		assert.strictEqual(admitted(v[1], "phases"), true);
	});
	it("keys of live and history runs match within 5 minutes of the same device", () => {
		assert.ok(sameRun("wm@100", "wm@105") && !sameRun("wm@100", "wm@106") && !sameRun("wm@100", "tr@100"));
		assert.ok(sameRun("a@b@7", "a@b@9"), "the device id may contain @");
		assert.strictEqual(primaryOf([]), null);
		assert.deepStrictEqual(usesOf([{ code: "historyCfg", detail: "debounce 20000 ms > poll 10000 ms" }]), {
			start: true,
			end: true,
			phases: false,
			final: true,
			trailer: false,
			rest: true,
		});
		assert.deepStrictEqual(usesOf([{ code: "aborted", detail: "" }]), {
			start: true,
			end: false,
			phases: false,
			final: false,
			trailer: false,
			rest: false,
		});
	});
});
