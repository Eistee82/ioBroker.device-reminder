import assert from "node:assert";
import { readFileSync } from "node:fs";
import * as I18n from "@iobroker/adapter-core/i18n";
import { normalizeDeviceConfig } from "../build/lib/config.js";
import { normalizePhases, SYSTEM_PHASE_KEYS, SYSTEM_PHASES, systemPhaseNames } from "../build/lib/phases/model.js";
import { PhaseTracker, replayPhases } from "../build/lib/phases/tracker.js";
import { layoutOf, loadSeries } from "./helpers/fixtures.js";
import { BOILER_PHASES, peaksOf, WM_PHASES } from "./helpers/phases.js";

const W = loadSeries("washer30d");
const WM_312_LIKE = {
	startVal: 30,
	endVal: 15,
	standby: 1,
	startCount: 2,
	endCount: 50,
	mode: "count",
	startDurationSec: 60,
	endDurationSec: 300,
};
const B = loadSeries("boiler4d");

describe("phase tracker (Spec A.5)", function () {
	this.timeout(300_000);
	it("does not import anything from the detector (G2)", () => {
		const src = readFileSync(new URL("../build/lib/phases/tracker.js", import.meta.url), "utf8");
		assert.ok(!src.includes("/detector/"));
	});
	it("washer: band name first, 'Endschleudern' after 168 s in the final spin; intermediate spins only in the timeline", () => {
		const { L, s } = layoutOf(W);
		const runs = L.runs.map(r => ({ start: s.t0 + r.from * s.stepMs, end: s.t0 + r.coreEnd * s.stepMs }));
		const { live, timeline } = replayPhases(WM_PHASES, W, 10, runs);
		const nameAt = t => live.filter(x => x.t <= t).at(-1)?.name;
		for (const r of L.runs.filter((r, k) => k !== 3)) {
			const t0 = s.t0 + r.endBlockFrom * s.stepMs;
			assert.strictEqual(nameAt(t0 + 60_000), "Schleudern");
			assert.strictEqual(nameAt(t0 + 190_000), "Endschleudern");
		}
		assert.ok(timeline.some(x => x.name === "Zwischenschleudern"));
		assert.ok(!live.some(x => x.name === "Zwischenschleudern"), "decided at the end only");
	});
	it("boiler: 86 peaks, 79 into the burner; ignition named from the peak on for ≥ 90 % of the 79, live ≤ 10 s after the burner proves it, never for the 7", () => {
		const peaks = peaksOf(B);
		assert.deepStrictEqual([peaks.length, peaks.filter(p => p.intoBurner).length], [86, 79]);
		const { live, timeline } = replayPhases(BOILER_PHASES, B, 2);
		const nameAt = t => live.filter(x => x.t <= t).at(-1)?.name;
		const into = peaks.filter(p => p.intoBurner);
		// 35 of the 79 peaks last 21–25 s before the value reaches the burner: before that the data cannot
		// tell them from the other peaks, so "live" is measured from the proof (5 s in the burner band)
		const liveHits = into.filter(p => nameAt(p.ts + p.settleMs + 10_000) === "Zündung");
		assert.ok(liveHits.length >= 0.9 * 79, String(liveHits.length));
		const named = into.filter(p => timeline.some(x => x.name === "Zündung" && x.from <= p.ts && x.to > p.ts));
		assert.ok(named.length >= 0.9 * 79, String(named.length));
		for (const p of peaks.filter(x => !x.intoBurner)) {
			assert.ok(!timeline.some(x => x.name === "Zündung" && x.from <= p.ts + 1000 && x.to >= p.ts), String(p.ts));
		}
	});
	it("start-up and run-on are told apart by the predecessor", () => {
		const t0 = 1_700_000_000_000;
		const pts = [
			[0, 0],
			[60, 80],
			[120, 250],
			[720, 80],
			[780, 0],
			[900, 0],
		].map(([sec, val]) => ({ ts: t0 + sec * 1000, val }));
		const ids = replayPhases(BOILER_PHASES, pts, 2).timeline.map(x => x.id);
		assert.deepStrictEqual(
			ids.filter(id => id !== "rest"),
			["q1", "q3", "q2"],
		);
	});
	it("a hold over the suspect limit shows 'unknown'; a new tracker starts empty; a run start resets the timeline", () => {
		const t = new PhaseTracker(BOILER_PHASES, [{ band: "burner", p99Sec: 100, suspectSec: 600, n: 50 }], 2);
		t.observe(250, 0);
		t.advance(30_000);
		assert.strictEqual(t.current.name, "Brenner mit Pumpe");
		t.advance(700_000);
		assert.deepStrictEqual([t.current.unknown, t.current.id], [true, "unknown"]);
		assert.deepStrictEqual(new PhaseTracker(WM_PHASES, null, 10).current, {
			id: null,
			name: "",
			since: 0,
			unknown: false,
		});
		const w = new PhaseTracker(WM_PHASES, null, 10);
		w.onRun("start", 0);
		w.observe(2100, 0);
		w.advance(60_000);
		w.onRun("end", 70_000);
		w.onRun("start", 80_000);
		assert.deepStrictEqual(w.timeline(), []);
	});
	it("live from raw values equals the offline replay", () => {
		const day = B.filter(p => p.ts < B[0].ts + 86_400_000);
		const t = new PhaseTracker(BOILER_PHASES, null, 2);
		let k = 0;
		for (let now = day[0].ts; now <= day.at(-1).ts; now += 2000) {
			while (k < day.length && day[k].ts <= now) {
				t.observe(day[k].val, day[k++].ts);
			}
			t.advance(now);
		}
		assert.deepStrictEqual(t.timeline(), replayPhases(BOILER_PHASES, day, 2).timeline);
	});
	it("validator drops notBeforeSec for continuous and rejects overlapping bands", () => {
		const w = [];
		const m = normalizePhases(
			{ ...BOILER_PHASES, phases: BOILER_PHASES.phases.map(p => ({ ...p, notBeforeSec: 60 })) },
			w,
			"K",
		);
		assert.ok(m.phases.every(p => p.notBeforeSec === undefined) && w.length === 1);
		const bad = { ...WM_PHASES, bands: [{ ...WM_PHASES.bands[0], max: 200 }, ...WM_PHASES.bands.slice(1)] };
		assert.strictEqual(normalizePhases(bad, w, "WM"), undefined);
	});
	it("reports live starts and ends; a class decided at the end only gets an end", () => {
		const t = new PhaseTracker(WM_PHASES, null, 10);
		const edges = [];
		const play = (from, to, val) => {
			t.observe(val, from);
			for (let now = from + 10_000; now <= to; now += 10_000) {
				edges.push(...t.advance(now));
			}
		};
		t.onRun("start", 0);
		play(0, 60_000, 50); // washing
		play(60_000, 120_000, 500); // a short spin: intermediate spin (≤ 114 s)
		play(120_000, 240_000, 50);
		play(240_000, 480_000, 600); // final spin (≥ 168 s)
		t.onRun("end", 480_000);
		edges.push(...t.advance(480_000));
		const ids = t.timeline().map(x => x.id);
		assert.deepStrictEqual(ids, ["p2", "p3", "p2", "p4"]);
		assert.ok(
			edges.some(e => e.id === "p3" && e.edge === "end" && e.at === 120_000),
			JSON.stringify(edges),
		);
		assert.ok(!edges.some(e => e.id === "p3" && e.edge === "start"), "decided at the end");
		assert.ok(edges.some(e => e.id === "p4" && e.edge === "start"));
		assert.ok(edges.some(e => e.id === "p4" && e.edge === "end" && e.at === 480_000));
		assert.ok(t.timeline().every(x => x.final));
		assert.deepStrictEqual(t.current, { id: null, name: "", since: 480_000, unknown: false });
	});
	it("system phases: anti-crease while the trailer runs, after the run while the lock phase runs", () => {
		const t = new PhaseTracker(WM_PHASES, null, 10, { antiCrease: "AC", afterRun: "AR", rest: "R", unknown: "U" });
		t.onRun("start", 0);
		t.observe(2100, 0);
		t.advance(60_000);
		t.setContext({ inTrailer: true, settling: false });
		t.advance(70_000);
		assert.deepStrictEqual([t.current.id, t.current.name], [SYSTEM_PHASES.antiCrease, "AC"]);
		t.onRun("end", 100_000);
		t.setContext({ inTrailer: false, settling: true });
		t.advance(110_000);
		assert.deepStrictEqual([t.current.id, t.current.name], [SYSTEM_PHASES.afterRun, "AR"]);
		t.setContext({ inTrailer: false, settling: false });
		t.advance(120_000);
		assert.strictEqual(t.current.id, null, "outside a run (scope run) nothing is shown");
		assert.deepStrictEqual(
			t.timeline().map(x => [x.id, x.from, x.to]),
			[
				["p1", 0, 70_000],
				["antiCrease", 70_000, 110_000],
				["afterRun", 110_000, 120_000],
			],
		);
	});
	it("continuous: rest outside all bands, a debounced entry is dated back, a time gap counts only up to the cap", () => {
		const t = new PhaseTracker(BOILER_PHASES, null, 2);
		t.observe(0, 0);
		t.advance(2000);
		assert.strictEqual(t.current.id, SYSTEM_PHASES.rest);
		t.observe(80, 2000);
		t.advance(4000);
		assert.strictEqual(t.current.id, "rest", "debounce 5 s");
		t.advance(8000);
		assert.deepStrictEqual([t.current.id, t.current.since], ["q1", 2000]);
		// 10 min without a poll count only 60 s (max(2 · poll, 60 s)): a class with minSec 120 is not
		// reached by the gap alone
		const slow = { ...BOILER_PHASES, phases: [{ ...BOILER_PHASES.phases[2], minSec: 120 }] };
		const g = new PhaseTracker(slow, null, 2);
		g.observe(250, 0);
		g.advance(2000);
		g.advance(600_000);
		assert.strictEqual(g.current.id, "burner", "gap counted as 60 s");
		g.advance(662_000);
		assert.strictEqual(g.current.id, "q3", "62 s + 60 s ≥ 120 s");
		t.reset();
		assert.deepStrictEqual([t.current, t.timeline()], [{ id: null, name: "", since: 0, unknown: false }, []]);
	});
	it("a peak that falls to the pump band is no ignition, also when it touches the burner for a moment", () => {
		const t0 = 1_700_000_000_000;
		const pts = [
			[0, 0],
			[60, 330],
			[62, 140],
			[64, 100],
			[66, 90],
			[200, 0],
			[300, 0],
		].map(([sec, val]) => ({ ts: t0 + sec * 1000, val }));
		const { timeline } = replayPhases(BOILER_PHASES, pts, 2);
		assert.ok(!timeline.some(x => x.id === "q4"), JSON.stringify(timeline));
		assert.ok(timeline.some(x => x.id === "peak"));
		const back = [
			[0, 0],
			[60, 330],
			[62, 250],
			[100, 80],
			[140, 0],
			[300, 0],
		].map(([sec, val]) => ({ ts: t0 + sec * 1000, val }));
		assert.ok(
			!replayPhases(BOILER_PHASES, back, 2).timeline.some(x => x.id === "q4"),
			"left the burner within the tail",
		);
		const ok = [
			[0, 0],
			[60, 330],
			[62, 280],
			[90, 250],
			[300, 0],
			[400, 0],
		].map(([sec, val]) => ({ ts: t0 + sec * 1000, val }));
		const seg = replayPhases(BOILER_PHASES, ok, 2).timeline.find(x => x.id === "q4");
		assert.deepStrictEqual([seg?.from, seg?.to], [t0 + 60_000, t0 + 120_000]);
	});
});

describe("phase model (Spec A.4)", () => {
	it("validator: JSON null as the open top, unknown references and reserved ids", () => {
		const w = [];
		const json = JSON.parse(JSON.stringify(WM_PHASES));
		assert.strictEqual(json.bands.at(-1).max, null);
		assert.strictEqual(normalizePhases(json, w, "WM").bands.at(-1).max, Infinity);
		assert.deepStrictEqual(w, []);
		assert.deepStrictEqual(normalizePhases(json, w, "WM"), normalizePhases(WM_PHASES, w, "WM"));
		const bad = [
			{ ...WM_PHASES, phases: [{ ...WM_PHASES.phases[0], band: "dry" }] },
			{ ...WM_PHASES, phases: [{ ...WM_PHASES.phases[0], after: ["p7"] }] },
			{ ...WM_PHASES, phases: [{ ...WM_PHASES.phases[0], id: "rest" }] },
			{ ...WM_PHASES, phases: [{ ...WM_PHASES.phases[0], id: "spin" }] },
			{ ...WM_PHASES, bands: [WM_PHASES.bands[1], WM_PHASES.bands[0]] },
			{ ...WM_PHASES, bands: [{ ...WM_PHASES.bands[0], smoothing: "median" }, ...WM_PHASES.bands.slice(1)] },
			{
				...BOILER_PHASES,
				phases: [{ ...BOILER_PHASES.phases[3], trigger: { confirm: ["oven"], confirmSec: 10, tailSec: 60 } }],
			},
			"x",
		];
		for (const m of bad) {
			const out = [];
			assert.strictEqual(normalizePhases(m, out, "D"), undefined, JSON.stringify(m).slice(0, 80));
			assert.strictEqual(out.length, 1);
			assert.match(out[0], /^Device "D": phases ignored \(/);
		}
		assert.strictEqual(normalizePhases(undefined, w, "D"), undefined);
		assert.deepStrictEqual(w, [], "no phases: no warning");
	});
	it("the device config keeps a usable model and drops one that cannot be used", () => {
		const base = { name: "WM", powerId: "x.power", detection: { ...WM_312_LIKE } };
		const ok = normalizeDeviceConfig({ ...base, phases: WM_PHASES });
		assert.deepStrictEqual(ok.config.phases, normalizePhases(WM_PHASES, [], "WM"));
		const bad = normalizeDeviceConfig({ ...base, phases: { ...WM_PHASES, bands: [] } });
		assert.strictEqual(bad.config.phases, undefined);
		assert.ok(bad.warnings.some(x => x.startsWith('Device "WM": phases ignored')));
		assert.strictEqual(normalizeDeviceConfig(base).config.phases, undefined, "default: no phases (3.1.2)");
	});
	it("system phase names come from the translations (11 languages), with English as fallback", () => {
		const en = systemPhaseNames(key => I18n.translate(key));
		assert.deepStrictEqual(en, {
			antiCrease: "Anti-crease",
			afterRun: "After the run",
			rest: "Rest",
			unknown: "Unknown",
		});
		assert.deepStrictEqual(
			systemPhaseNames(key => key),
			en,
			"missing translation",
		);
		for (const lang of ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"]) {
			const dict = JSON.parse(readFileSync(new URL(`../admin/i18n/${lang}.json`, import.meta.url), "utf8"));
			for (const key of Object.values(SYSTEM_PHASE_KEYS)) {
				assert.ok(dict[key], `${lang}:${key}`);
			}
			assert.ok(
				["{n}", "{w}", "{min}", "{max}"].every(x => dict.phase_neutral.includes(x)),
				lang,
			);
		}
	});
});
