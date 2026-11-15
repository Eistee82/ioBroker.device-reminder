import assert from "node:assert";
import { readFileSync } from "node:fs";
import { learnPhases, scopeOf, tunePhases } from "../build/lib/phases/learn.js";
import { checkRuns, daySamples } from "../build/lib/learn/quality.js";
import { baseBandsOf } from "../build/lib/learn/bands.js";
import { replayPhases } from "../build/lib/phases/tracker.js";
import { phaseInput } from "./helpers/final.js";
import { asKw, BASE_TS, loadSeries } from "./helpers/fixtures.js";
import { BOILER_PHASES, WM_PHASES } from "./helpers/phases.js";

const W = loadSeries("washer30d");
const B = loadSeries("boiler4d");
const D = loadSeries("dryer");
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
	// Spec B.5 step 7 and 8.3: the cross-check of the learned phases agrees in ≥ 99 % outside the transition zones
	// (washer30d and dryer agree in 100 %, boiler4d in more than 99 %)
	it("washer30d: 4–6 phases in run order, one per band and position, the after-run last; cross-check ≥ 99 %, a boundary between spin (≤ 839 W) and heating (≥ 2047 W)", () => {
		const { units, runLimit } = phaseInput(W);
		const r = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10 });
		assert.strictEqual(r.model.scope, "run");
		assert.ok(r.looAgreement >= 0.99, String(r.looAgreement));
		assert.ok(r.model.bands.some(b => b.min > 839 && b.min < 2047));
		const ph = r.model.phases;
		assert.ok(ph.length >= 4 && ph.length <= 6, ph.map(p => `${p.name} ${p.band}`).join());
		assert.ok(
			ph.every(p => p.stats.runs >= 3 && p.show === true && p.notify === undefined && p.decided === "live"),
			"a phase needs ≥ 3 runs",
		);
		assert.ok(ph.every(p => /^Phase \d+$/.test(p.name)));
		const own = ph.filter(p => !p.trailer);
		assert.strictEqual(new Set(own.map(p => `${p.band} ${JSON.stringify(p.after ?? null)}`)).size, own.length);
		assert.ok(own.length < 9, "the duration classes of a band are one phase");
		const heat = r.model.bands.at(-1);
		const heatAt = ph.findIndex(p => p.band === heat.id);
		const wash = own.filter(p => p.band !== heat.id).sort((a, b) => b.stats.longSec - a.stats.longSec)[0];
		const washAt = ph.indexOf(wash);
		assert.ok(heatAt >= 0 && heatAt < washAt, "heating comes before washing");
		const tail = ph.at(-1);
		assert.strictEqual(tail.trailer, true, "the after-run is the last phase");
		assert.strictEqual(ph.filter(p => p.trailer).length, 1);
		assert.ok(tail.stats.runs >= 3 && tail.stats.watts > 50 && tail.stats.watts < 150, JSON.stringify(tail.stats));
		assert.ok(tail.stats.shortSec >= 1200 && tail.stats.longSec <= 2400, JSON.stringify(tail.stats));
		assert.strictEqual(tail.stats.agreement, 0, "the after-run is not cross-checked, so it claims no agreement");
		assert.ok(
			own.every(p => p.stats.agreement >= 0.99),
			"every phase read from the bands passes the cross-check",
		);
		for (const p of own) {
			assert.ok(p.stats.watts > 0 && p.stats.shortSec > 0 && p.stats.longSec >= p.stats.shortSec, p.name);
		}
	});
	it("dryer: read over raw values, all 7 runs pass the cross-check, the after-run is learned, the unusable recording is not used", () => {
		const { units, runLimit } = phaseInput(D);
		assert.ok(
			units.some(u => u.verdict.stage === "unusable"),
			"the recording at the data end is unusable",
		);
		const r = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10, now: 0 });
		assert.strictEqual(r.model.scope, "run");
		assert.strictEqual(r.model.quality.runsUsed, 7);
		assert.ok(r.looAgreement >= 0.99, String(r.looAgreement));
		assert.ok(
			r.model.bands.every(b => b.smoothing !== "level" && b.windowSec === 0),
			"no rhythm: the bands are read over the raw values",
		);
		const heat = r.model.bands.at(-1);
		assert.ok(heat.min > 200 && heat.max === Infinity, String(heat.min));
		assert.ok(r.model.phases.some(p => p.band === heat.id && p.stats.runs === 7));
		const ph = r.model.phases;
		assert.ok(ph.length >= 3 && ph.length <= 6, ph.map(p => `${p.name} ${p.band}`).join());
		assert.ok(
			ph.every(p => p.stats.runs >= 3 && p.decided === "live" && p.show === true),
			"a phase needs ≥ 3 runs; every phase passes live",
		);
		assert.ok(ph.every((p, i) => p.name === `Phase ${i + 1}`));
		assert.deepStrictEqual([ph.at(-1).trailer, ph.at(-1).stats.runs], [true, 7], "the after-run is the last phase");
		assert.deepStrictEqual(r.retroOnly, []);
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
		assert.ok(r.looAgreement >= 0.99, String(r.looAgreement));
		assert.ok(
			r.model.phases.every((p, i) => p.name === `Phase ${i + 1}` && !p.trailer),
			"no after-run without runs",
		);
		const startUp = r.model.phases.findIndex(p => p.after?.includes("idle"));
		assert.ok(startUp >= 0, "start-up told apart by the predecessor");
		const ids = new Set([...r.model.phases.map(p => p.id), "idle", "start"]);
		assert.ok(
			r.model.phases.every(p => !p.after || (p.after.length > 0 && p.after.every(a => ids.has(a)))),
			"every predecessor is a phase of the model, the begin of the run or rest",
		);
		assert.ok(
			r.model.phases.some(p => p.after && !p.after.includes("idle")),
			"the rest of the band follows other phases",
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
		assert.deepStrictEqual(r.dropped, [{ id: "p9", name: "Trocknen", actions: 2 }]);
	});
	it("neutral names 'Phase n' in run order from the translated template; ids do not depend on the language", () => {
		const { units, runLimit } = phaseInput(W);
		const r = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10 });
		assert.deepStrictEqual(
			r.model.phases.map(p => p.name),
			r.model.phases.map((_, i) => `Phase ${i + 1}`),
		);
		assert.ok(
			r.model.bands.every(b => /^≈ \d+ W$/.test(b.name)),
			r.model.bands.map(b => b.name).join(),
		);
		const de = learnPhases(units, {
			runLimitW: runLimit,
			unitFactor: 1,
			pollSec: 10,
			neutralName: n => `Abschnitt ${n}`,
		});
		assert.deepStrictEqual(
			de.model.phases.map(p => p.name),
			r.model.phases.map((_, i) => `Abschnitt ${i + 1}`),
		);
		assert.deepStrictEqual(
			de.model.phases.map(p => p.id),
			r.model.phases.map(p => p.id),
			"ids do not depend on the language",
		);
	});
	it("relearning keeps the names given by the user and renames the generated ones", () => {
		const { units, runLimit } = phaseInput(W);
		const ctx = { runLimitW: runLimit, unitFactor: 1, pollSec: 10, now: 0 };
		const first = learnPhases(units, ctx).model;
		const own = {
			...first,
			phases: first.phases.map((p, i) =>
				i === 1 ? { ...p, name: "Heizen" } : i === 0 ? { ...p, name: "Level 3 · ≈ 63 W · 0–1 min" } : p,
			),
			bands: first.bands.map((b, i) => (i === 0 ? { ...b, name: "Level 1 · ≈ 6 W · 0–1 min" } : b)),
		};
		const again = learnPhases(units, { ...ctx, previous: own });
		assert.deepStrictEqual(
			again.model.phases.map(p => [p.id, p.name]),
			first.phases.map((p, i) => [p.id, i === 1 ? "Heizen" : `Phase ${i + 1}`]),
		);
		assert.strictEqual(again.model.bands[0].name, first.bands[0].name, "an old generated band name is replaced");
		assert.deepStrictEqual(again.dropped, []);
	});
	it("the after-run never carries 'finished afterwards' from the old model, but keeps its id, messages and name (Spec B.5 step 8)", () => {
		const { units, runLimit } = phaseInput(W);
		const ctx = { runLimitW: runLimit, unitFactor: 1, pollSec: 10, now: 0 };
		const first = learnPhases(units, ctx).model;
		const tailId = first.phases.at(-1).id;
		const previous = {
			...first,
			phases: first.phases.map(p =>
				p.trailer ? { ...p, name: "Rest of the run", final: true, notify: { start: true } } : p,
			),
		};
		const again = learnPhases(units, { ...ctx, previous }).model;
		const tail = again.phases.at(-1);
		assert.deepStrictEqual(
			[tail.trailer, tail.id, tail.name, tail.final, tail.notify],
			[true, tailId, "Rest of the run", undefined, { start: true }],
		);
		const own = first.phases.find(p => !p.trailer);
		const marked = learnPhases(units, {
			...ctx,
			previous: { ...first, phases: first.phases.map(p => (p.id === own.id ? { ...p, final: true } : p)) },
		}).model;
		assert.strictEqual(marked.phases.find(p => p.id === own.id).final, true, "a phase of the bands keeps it");
	});
	it("a name generated in another language of the instance is given anew; without the templates it would stay", () => {
		const { units, runLimit } = phaseInput(W);
		const ctx = { runLimitW: runLimit, unitFactor: 1, pollSec: 10, now: 0 };
		const first = learnPhases(units, ctx).model;
		const templates = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"].map(
			lang =>
				JSON.parse(readFileSync(new URL(`../admin/i18n/${lang}.json`, import.meta.url), "utf8")).phase_neutral,
		);
		const foreign = ["Fase 2", "Фаза 1", "阶段 3", "Faza 4"];
		const previous = {
			...first,
			phases: first.phases.map((p, i) => (i < foreign.length ? { ...p, name: foreign[i] } : p)),
		};
		const again = learnPhases(units, { ...ctx, previous, neutralTemplates: templates }).model;
		assert.deepStrictEqual(
			again.phases.map(p => p.name),
			first.phases.map((_, i) => `Phase ${i + 1}`),
		);
		const without = learnPhases(units, { ...ctx, previous }).model;
		assert.strictEqual(without.phases[0].name, "Fase 2", "only the templates tell a generated name apart");
	});
	it("without a previous model, or one without an after-run, the after-run gets a new id of its own", () => {
		const { units, runLimit } = phaseInput(W);
		const ctx = { runLimitW: runLimit, unitFactor: 1, pollSec: 10, now: 0 };
		const first = learnPhases(units, ctx);
		const ids = first.model.phases.map(p => p.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		assert.ok(first.model.phases.at(-1).trailer && /^p\d+$/.test(ids.at(-1)), ids.join());
		assert.deepStrictEqual(first.dropped, []);
		const previous = { ...first.model, phases: first.model.phases.filter(p => !p.trailer) };
		const again = learnPhases(units, { ...ctx, previous }).model;
		const tail = again.phases.at(-1);
		assert.ok(tail.trailer);
		assert.ok(!previous.phases.some(p => p.id === tail.id), `${tail.id} is new`);
		assert.deepStrictEqual(
			again.phases.slice(0, -1).map(p => p.id),
			previous.phases.map(p => p.id),
			"the other phases keep their ids",
		);
	});
	it("segments of one band are one phase whatever their duration; excluded runs are not used", () => {
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
			three.model.phases.map(p => [p.name, p.minSec, p.maxSec, p.decided, p.stats.runs]),
			[["Phase 1", 0, 0, "live", 7]],
		);
		assert.deepStrictEqual(
			[
				three.model.phases[0].stats.watts,
				three.model.phases[0].stats.shortSec,
				three.model.phases[0].stats.longSec,
			],
			[1000, 300, 3000],
			"typical power and the shortest and longest time per run",
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
	it("phase tuning needs two equal proposals, keeps ids and never adds or removes phases (D.6)", () => {
		const { units } = phaseInput(W);
		const first = tunePhases(WM_PHASES, units, null);
		assert.strictEqual(first.model, null);
		const second = tunePhases(WM_PHASES, units, first.proposal);
		const m = second.model ?? WM_PHASES;
		assert.deepStrictEqual(
			m.phases.map(p => [p.id, p.name]),
			WM_PHASES.phases.map(p => [p.id, p.name]),
		);
		for (const b of m.bands) {
			const o = WM_PHASES.bands.find(x => x.id === b.id);
			assert.ok(b.min >= o.min * 0.85 - 1e-9 && b.min <= o.min * 1.15 + 1e-9, b.id);
		}
		const other = tunePhases(WM_PHASES, units.slice(0, 6), first.proposal);
		assert.ok(other.proposal.hash === first.proposal.hash || other.model === null);
	});
	it("phase tuning: boiler limits taken over after two equal proposals, a class without a phase is a new pattern", () => {
		const { units } = phaseInput(B);
		const first = tunePhases(BOILER_PHASES, units, null, { pollSec: 2 });
		assert.strictEqual(first.model, null, "seen once");
		assert.strictEqual(first.newPattern, false, "every class of the model has its phase");
		const second = tunePhases(BOILER_PHASES, units, first.proposal, { pollSec: 2 });
		assert.ok(second.model, "the second equal proposal is taken over");
		assert.deepStrictEqual(
			second.model.phases.map(p => [p.id, p.name, p.band]),
			BOILER_PHASES.phases.map(p => [p.id, p.name, p.band]),
		);
		const q4 = second.model.phases.find(p => p.id === "q4").trigger;
		const o4 = BOILER_PHASES.phases.find(p => p.id === "q4").trigger;
		assert.ok(Math.abs(q4.tailSec - o4.tailSec) <= 0.15 * o4.tailSec + 1, "small steps");
		assert.ok(second.model.quality.agreement >= 0.99, "the cross-check agrees no less than before");
		// the washer model without its final spin: the long spins fit no phase
		const { units: wu } = phaseInput(W);
		const noFinal = { ...WM_PHASES, phases: WM_PHASES.phases.filter(p => p.id !== "p4") };
		assert.strictEqual(tunePhases(noFinal, wu, null).newPattern, true);
		const tail = { ...WM_PHASES.phases[3], id: "p5", minSec: 0, trailer: true };
		assert.strictEqual(
			tunePhases({ ...noFinal, phases: [...noFinal.phases, tail] }, wu, null).newPattern,
			true,
			"the after-run covers no pattern of its band",
		);
		assert.strictEqual(tunePhases(WM_PHASES, wu, null).newPattern, false);
	});
});
