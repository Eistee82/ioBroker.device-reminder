import assert from "node:assert";
import { learnPhases, scopeOf } from "../build/lib/phases/learn.js";
import { checkRuns, daySamples } from "../build/lib/learn/quality.js";
import { baseBandsOf } from "../build/lib/learn/bands.js";
import { replayPhases } from "../build/lib/phases/tracker.js";
import { phaseInput } from "./helpers/final.js";
import { asKw, BASE_TS, loadSeries } from "./helpers/fixtures.js";
import { BOILER_PHASES, WM_PHASES } from "./helpers/phases.js";

const W = loadSeries("washer30d");
const B = loadSeries("boiler4d");
const DAY = 86_400_000;
const OK = {
	stage: "ok",
	reasons: [],
	uses: { start: true, end: true, phases: true, final: true, trailer: true, rest: true },
};

/**
 * A synthetic run: rest, one block of 1000 W for `sec`, rest; one run per day.
 *
 * @param {number} k day
 * @param {number} sec length of the block
 * @param {object} [verdict] verdict
 * @returns {{ sample: object, verdict: object }} unit
 */
function blockRun(k, sec, verdict = OK) {
	const start = BASE_TS + k * DAY;
	const end = start + sec * 1000;
	const points = [
		{ ts: start - 60_000, val: 0 },
		{ ts: start, val: 1000 },
		{ ts: end, val: 0 },
		{ ts: end + 60_000, val: 0 },
	];
	const facts = { start, coreEnd: end, progEnd: end, runEnd: end, end, coreSec: sec, feat: null, offSec: null };
	return {
		sample: {
			points,
			from: start - 60_000,
			to: end + 60_000,
			key: `s@${k}`,
			kind: "run",
			src: "history",
			info: null,
			family: -1,
			facts,
		},
		verdict: { ...verdict, key: `s@${k}` },
	};
}

describe("learn phases (Spec B.5)", function () {
	this.timeout(600_000);
	it("washer: cross-check ≥ 99 %, a boundary between spin (≤ 839 W) and heating (≥ 2047 W)", () => {
		const { units, runLimit } = phaseInput(W);
		const r = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10 });
		assert.strictEqual(r.model.scope, "run");
		assert.ok(r.looAgreement >= 0.99, String(r.looAgreement));
		assert.ok(r.model.bands.some(b => b.min > 839 && b.min < 2047));
		assert.ok(
			r.model.phases.every(p => p.stats.runs >= 3 && p.show === true && p.notify === undefined),
			"a class needs ≥ 3 runs, otherwise it is merged",
		);
	});
	it("boiler: scope continuous from runs per day or rest, peak band kept, ≥ 3 days without help (P2, P3)", () => {
		assert.strictEqual(scopeOf(19, 12), "continuous");
		assert.strictEqual(scopeOf(1, 600), "run");
		const s = daySamples("kessel", B, { stepMs: 2000, src: "history", unitFactor: 1 });
		const v = checkRuns(s, {
			unitFactor: 1,
			unit: "W",
			settings: null,
			pollMs: 2000,
			outages: [],
			scope: "continuous",
			bands: baseBandsOf(s, 35, { mode: "raw", dipSec: 5 }),
		});
		const r = learnPhases(
			s.map((sample, i) => ({ sample, verdict: v[i] })),
			{ runLimitW: 35, unitFactor: 1, pollSec: 2, scope: "continuous" },
		);
		assert.strictEqual(r.model.scope, "continuous");
		assert.ok(r.model.quality.runsUsed >= 3);
		assert.ok(r.model.bands.at(-1).min > 290);
		const ign = r.model.phases.find(p => p.trigger);
		assert.ok(
			!ign || ign.stats.agreement >= 0.99 || r.retroOnly.includes(ign.id),
			"ignition live only when it passes the cross-check",
		);
	});
	it("relearning keeps ids, names and notify; unmatched phases are reported with their actions", () => {
		const { units, runLimit } = phaseInput(W);
		const previous = {
			...WM_PHASES,
			phases: [
				...WM_PHASES.phases.map(p =>
					p.id === "p4" ? { ...p, name: "Final", notify: { end: true, text: "Fertig geschleudert" } } : p,
				),
				{
					id: "p9",
					name: "Trocknen",
					band: "heat",
					minSec: 36_000,
					maxSec: 0,
					decided: "live",
					show: true,
					stats: { runs: 3, agreement: 1, lastSeen: 0 },
				},
			],
		};
		const r = learnPhases(units, {
			runLimitW: runLimit,
			unitFactor: 1,
			pollSec: 10,
			previous,
			actionsOf: id => (id === "p9" ? 2 : 0),
		});
		const p4 = r.model.phases.find(p => p.id === "p4");
		assert.deepStrictEqual([p4?.name, p4?.notify], ["Final", { end: true, text: "Fertig geschleudert" }]);
		assert.deepStrictEqual(r.dropped, [{ id: "p9", actions: 2 }]);
	});
	it("neutral names without a vocabulary, from the translated template", () => {
		const { units, runLimit } = phaseInput(W);
		const r = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10 });
		assert.ok(
			r.model.phases.every(p => /^Level \d+ · ≈ \d+ W · \d+–\d+ min$/.test(p.name)),
			r.model.phases.map(p => p.name).join(),
		);
		const de = learnPhases(units, {
			runLimitW: runLimit,
			unitFactor: 1,
			pollSec: 10,
			neutralName: (n, w, a, b) => `Stufe ${n} · ≈ ${w} W · ${a}–${b} min`,
		});
		assert.deepStrictEqual(
			de.model.phases.map(p => p.id),
			r.model.phases.map(p => p.id),
			"ids do not depend on the language",
		);
	});
	it("a duration class seen in fewer than 3 runs is merged; excluded runs are not used", () => {
		const ctx = { runLimitW: 5, unitFactor: 1, pollSec: 10, now: 0 };
		const two = learnPhases(
			[0, 1, 2, 3].map(k => blockRun(k, 300)).concat([4, 5].map(k => blockRun(k, 3000))),
			ctx,
		);
		assert.strictEqual(two.model.scope, "run", "one run per day, rest of a day in between");
		assert.deepStrictEqual(
			two.model.phases.map(p => [p.minSec, p.maxSec, p.decided, p.stats.runs]),
			[[0, 0, "live", 6]],
		);
		const three = learnPhases(
			[0, 1, 2, 3].map(k => blockRun(k, 300)).concat([4, 5, 6].map(k => blockRun(k, 3000))),
			ctx,
		);
		assert.deepStrictEqual(
			three.model.phases.map(p => [p.minSec, p.maxSec, p.decided, p.stats.runs]),
			[
				[0, 949, "end", 4],
				[949, 0, "live", 3],
			],
		);
		const excluded = learnPhases(
			[0, 1, 2, 3]
				.map(k => blockRun(k, 300))
				.concat(
					[4, 5].map(k => blockRun(k, 3000)),
					[blockRun(6, 3000, { ...OK, user: "exclude" })],
				),
			ctx,
		);
		assert.deepStrictEqual([excluded.model.quality.runsUsed, excluded.model.phases.length], [6, 1]);
		const none = learnPhases([], ctx);
		assert.deepStrictEqual(
			[none.model.bands, none.model.phases, none.looAgreement, none.model.quality.runsUsed],
			[[], [], 0, 0],
		);
	});
	it("scope continuous from the data; a kW state gives the same phases with bands in kW", () => {
		const s = daySamples("kessel", B, { stepMs: 2000, src: "history", unitFactor: 1 });
		const v = checkRuns(s, {
			unitFactor: 1,
			unit: "W",
			settings: null,
			pollMs: 2000,
			outages: [],
			scope: "continuous",
			bands: baseBandsOf(s, 35, { mode: "raw", dipSec: 5 }),
		});
		const r = learnPhases(
			s.map((sample, i) => ({ sample, verdict: v[i] })),
			{ runLimitW: 35, unitFactor: 1, pollSec: 2 },
		);
		assert.strictEqual(r.model.scope, "continuous", "day sections follow each other without rest");
		assert.ok(r.model.bands.at(-1).smoothing === "peak" && r.model.bands.every(b => b.smoothing !== "level"));
		const w = phaseInput(W);
		const kw = phaseInput(asKw(W), { unitFactor: 1000 });
		const a = learnPhases(w.units, { runLimitW: w.runLimit, unitFactor: 1, pollSec: 10, now: 0 });
		const b = learnPhases(kw.units, { runLimitW: kw.runLimit, unitFactor: 1000, pollSec: 10, now: 0 });
		assert.deepStrictEqual(
			b.model.bands.map(x => [x.id, Math.round(x.min * 1000 * 10) / 10, x.smoothing]),
			a.model.bands.map(x => [x.id, Math.round(x.min * 10) / 10, x.smoothing]),
		);
		assert.deepStrictEqual(b.model.phases, a.model.phases, "same classes and names (≈ W) in kW");
		assert.ok(
			a.model.bands.some(x => x.smoothing === "level"),
			"the washing rhythm is read as a level",
		);
	});
	it("an event phase that only passes in the timeline is not shown live", () => {
		const late = {
			...BOILER_PHASES,
			phases: BOILER_PHASES.phases.map(p => (p.trigger ? { ...p, decided: "end" } : p)),
		};
		const day = B.filter(p => p.ts < B[0].ts + DAY);
		const { live, timeline } = replayPhases(late, day, 2);
		assert.ok(timeline.some(x => x.id === "q4"));
		assert.ok(!live.some(x => x.id === "q4"));
		assert.ok(
			live.some(x => x.id === "peak"),
			"the band name instead",
		);
	});
});
