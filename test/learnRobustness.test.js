import assert from "node:assert";
import { analyzeHistory, heldBackOf, withoutSpans } from "../build/lib/historyLearning.js";
import { baseBandsOf } from "../build/lib/learn/bands.js";
import { learnFinal } from "../build/lib/learn/finalLearn.js";
import { admitted, checkRuns } from "../build/lib/learn/quality.js";
import { learnInput, WM_312 } from "./helpers/final.js";
import {
	asKw,
	bridge,
	cutTrailer,
	handTest,
	loadSeries,
	runIndex,
	withForeign,
	withGap,
	withHold,
	withSpikes,
} from "./helpers/fixtures.js";

const MIN = 60_000;
const DAY = 86_400_000;
const day = id => runIndex("washer30d").find(r => r.id === id).ts;
// up to 30 min before w13 with the idle value held up to there: the data end inside w13 (and right after w12, the
// logger stores changes only) would make a run incomplete in the base only, and every defect appended after the end
// would complete it
const CUT = day("w13") - 30 * MIN;
const W0 = loadSeries("washer30d").filter(p => p.ts < CUT);
const W = [...W0, { ts: CUT, val: W0.at(-1).val }];
const end = CUT + 60 * MIN;
const near = (a, b) => Math.abs(a - b) <= 0.05 * Math.max(Math.abs(b), 1e-9);
const ALL_KEYS = ["startVal", "standby", "startCount", "endVal", "endCount"];

/**
 * Defects (Spec 8.4) with the finding expected at their stretch (`held`: the run check holds the stretch back with
 * one of these findings; `limited`: a run gets this finding and stays in use; none: nothing to find, see `spikes`).
 */
const DEFECTS = {
	"foreign +150 W 20 min": {
		pts: withForeign(W, day("w09") - 25 * MIN, 20, 150),
		at: day("w09") - 25 * MIN,
		held: ["foreign", "gap"],
	},
	"logger gap 20 min at 250 W": { pts: withHold(W, day("w08") + 60 * MIN, 20, 250), at: day("w08"), held: ["gap"] },
	"abort after 112 min": { pts: withGap(W, day("w10") + 112 * MIN, 30), at: day("w10"), held: ["gap", "aborted"] },
	"50 spikes 3000 W": { pts: withSpikes(W, 50, 3000, 1), spikes: true },
	"50 spikes 400 W": { pts: withSpikes(W, 50, 400, 2), spikes: true },
	"hand test 3 min 2000 W": { pts: [...W, ...handTest(end, 3, 2000)], at: end, held: ["test"] },
	"hand test 5 min 300 W": {
		pts: [...W, ...handTest(end + DAY, 5, 300)],
		at: end + DAY,
		held: ["test", "incomplete"],
	},
	"tail cut after 2 min": { pts: cutTrailer(W, day("w09") + 141 * MIN), at: day("w09"), limited: "trailerCut" },
	// 6 min each: short runs (a stretch below 5 min is a short activity, Spec B.2 `test` (2) and "keine Gruppe")
	"three equal hand tests": {
		pts: [...W, ...[1, 2, 3].flatMap(k => handTest(end + k * DAY, 6, 2000))],
		at: end + DAY,
		held: ["test"],
	},
	"two runs grown together": {
		pts: bridge(W, day("w10") + 150 * MIN, day("w11"), 40),
		at: day("w10"),
		held: ["merged", "gap"],
	},
};
/**
 * Input of `learnFinal` as the run store builds it (`recomputeBands`): base bands from the clean runs only, then the
 * run check again with them.
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @param {(start: number) => boolean} [excluded] runs excluded by the user (by start)
 * @returns {{ runs: object[], bands: object }} runs with verdicts and bands
 */
function storeInput(points, excluded = () => false) {
	const a = learnInput(points);
	const out = x => excluded(x.sample.facts.start);
	const clean = a.runs
		.filter(x => x.sample.kind === "run" && !out(x) && admitted(x.verdict, "phases"))
		.map(x => x.sample);
	const bands = baseBandsOf(clean, a.layout.runLimit);
	const verdicts = checkRuns(
		a.runs.map(x => x.sample),
		{ bands, unitFactor: 1, unit: "W", settings: null, pollMs: 10_000, outages: [], scope: "run" },
	);
	return {
		runs: a.runs.map((x, k) => ({ ...x, verdict: out(x) ? { ...verdicts[k], user: "exclude" } : verdicts[k] })),
		bands,
	};
}
const finalCtx = inp => ({
	base: WM_312,
	pollSec: 10,
	unitFactor: 1,
	abort: false,
	abortFixed: false,
	bands: inp.bands,
	minRuns: 5,
	minPerGroup: 1,
	yieldFn: async () => {},
});

describe("injected defects change no value (Spec 8.4)", function () {
	this.timeout(900_000);
	let base;
	let baseFinal;
	before(async () => {
		base = await analyzeHistory(W, 10, {});
		const inp = storeInput(W);
		baseFinal = await learnFinal(inp.runs, finalCtx(inp));
		assert.ok(baseFinal.ok, JSON.stringify(baseFinal.reasons));
	});
	for (const [name, d] of Object.entries(DEFECTS)) {
		it(`${name}: right finding; suggestion and final phase as without the stretches held back (±5 %)`, async () => {
			const held = heldBackOf(d.pts, 10, 1);
			if (d.held) {
				const hit = held.spans.find(s => s.from <= d.at + 30 * MIN && s.to >= d.at);
				assert.ok(hit && d.held.includes(hit.code), JSON.stringify(held.spans));
			}
			const inp = learnInput(d.pts);
			if (d.limited) {
				assert.ok(
					inp.runs.some(
						x =>
							Math.abs(x.sample.facts.start - d.at) <= 5 * MIN &&
							x.verdict.reasons.some(r => r.code === d.limited),
					),
					d.limited,
				);
			}
			const sg = await analyzeHistory(d.pts, 10, {});
			// the defect changes nothing beyond the runs it takes out of use
			const ref = await analyzeHistory(withoutSpans(W, held.spans), 10, {});
			for (const k of ALL_KEYS) {
				assert.ok(
					near(sg.thresholds[k], ref.thresholds[k]),
					`${k} ${sg.thresholds[k]} vs ${ref.thresholds[k]}`,
				);
			}
			// a single report next to a run does not extend it (LAYOUT_REV 3), so the spikes change no end value either
			assert.strictEqual(sg.mode, ref.mode);
			// the final phase: released only if it reports no real run early, and then as without the stretches
			const fin = storeInput(d.pts);
			const f = await learnFinal(fin.runs, finalCtx(fin));
			if (f.ok) {
				assert.strictEqual(f.earlyEnds, 0, "no early end on a real run");
				// the base runs with the runs of the stretches excluded
				const refInp = storeInput(W, t => held.spans.some(sp => sp.from <= t && t < sp.to));
				const fr = await learnFinal(refInp.runs, finalCtx(refInp));
				assert.ok(fr.ok, JSON.stringify(fr.reasons));
				for (const k of ["finalMinVal", "finalMaxVal", "finalMinSec", "finalAfterSec"]) {
					assert.ok(near(f.values[k], fr.values[k]), `${k} ${f.values[k]} vs ${fr.values[k]}`);
				}
			} else if (!d.spikes) {
				assert.ok(baseFinal.ok);
			}
		});
	}
	it("the stretches of the defects are the only difference: without them every value is the base", async () => {
		assert.deepStrictEqual(
			heldBackOf(W, 10, 1)
				.spans.map(s => s.code)
				.sort(),
			["sparse", "test"],
		);
		const again = await analyzeHistory(W, 10, {});
		for (const k of ALL_KEYS) {
			assert.strictEqual(again.thresholds[k], base.thresholds[k]);
		}
	});
	it("kW without unit text: with the template peak unusable, no suggestion from it", async () => {
		const sg = await analyzeHistory(asKw(W), 10, { unitFactor: 1, templatePeakW: 2000 });
		assert.ok("error" in sg || sg.thresholds.startVal < 1, "the analysis never treats kW values as W");
	});
	it("two devices silent at the same time: proven gap via the other device", () => {
		const from = day("w08") + 60 * MIN;
		const inp = learnInput(withGap(W, from, 20), { outages: [{ from, to: from + 20 * MIN }] });
		const k = inp.runs.findIndex(x => Math.abs(x.sample.facts.start - day("w08")) <= 5 * MIN);
		assert.ok(inp.runs[k].verdict.reasons.some(r => r.code === "gap" && r.detail.startsWith("proven")));
	});
});
