import assert from "node:assert";
import { assignFamilies } from "../build/lib/learn/families.js";
import {
	bandFeaturesOf,
	baseBandsOf,
	bandOf,
	holdProfile,
	learnBands,
	RAW_POINTS_MAX,
	suspectLimitOf,
	unitsOf,
} from "../build/lib/learn/bands.js";
import { asKw, layoutOf, loadSeries } from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
// The learning core works in W (`unitFactor`); points, run level and bands stay in the unit of the state.
const units = (pts, factor = 1) => {
	const { L, s } = layoutOf(pts.map(p => ({ ts: p.ts, val: p.val * factor })));
	return { u: unitsOf(pts, L, s), L, runLimit: L.runLimit / factor };
};
const days = pts => {
	const out = [];
	for (let t = pts[0].ts; t < pts.at(-1).ts; t += 86_400_000) {
		out.push({ points: pts.filter(p => p.ts >= t && p.ts < t + 86_400_000), from: t, to: t + 86_400_000 });
	}
	return out;
};

describe("base bands and hold time profile (Spec B.1a)", () => {
	it("washer: a boundary between spin (≤ 839 W) and heating (≥ 2047 W) [S1]", () => {
		const { u, runLimit } = units(W);
		const b = learnBands(u, runLimit, { mode: "median60", dipSec: 60 });
		const cut = b.find(x => x.min > 839 && x.min < 2047);
		assert.ok(cut, JSON.stringify(b.map(x => [x.min, x.max])));
		assert.ok(
			b.some(x => x.min <= 290 && x.max > 839),
			"one band holds every final spin (290–839 W)",
		);
	});
	it("washer: the spin band has p99 ≤ 145 s and a suspect limit of max(600, 5·p99) < 1200 s (r_hold: n 427, p99 94 s)", () => {
		const { u, runLimit } = units(W);
		const bb = baseBandsOf(u, runLimit);
		const h = bb.holds.find(x => x.band === bandOf(bb, 250).id);
		assert.ok(h.n >= 30 && h.p99Sec <= 145, JSON.stringify(h));
		assert.strictEqual(h.suspectSec, Math.max(600, 5 * h.p99Sec));
		assert.ok(h.suspectSec < 1200, "a 20-min logger gap at 250 W is suspicious");
		assert.strictEqual(suspectLimitOf(bb, 250), h.suspectSec);
	});
	it("boiler: the band above 290 W survives; the band of 254 W tolerates the real 52.2-min hold", () => {
		const B = loadSeries("boiler4d");
		const bb = baseBandsOf(days(B), 35, { mode: "raw", dipSec: 5 });
		const top = bb.bands.at(-1);
		assert.ok(top.min > 290 && top.segments >= 9, JSON.stringify(top));
		assert.ok(suspectLimitOf(bb, 254) > 52.2 * 60, String(suspectLimitOf(bb, 254)));
	});
	it("kW state: the same bands divided by 1000 (Review Focus 4)", () => {
		const w = units(W);
		const kw = units(asKw(W), 1000);
		const a = learnBands(w.u, w.runLimit, { mode: "median60", dipSec: 60 });
		const b = learnBands(kw.u, kw.runLimit, { mode: "median60", dipSec: 60 });
		assert.strictEqual(b.length, a.length);
		a.forEach((x, i) => assert.ok(Math.abs(b[i].min * 1000 - x.min) <= 1e-6 * Math.max(1, x.min)));
		const hw = baseBandsOf(w.u, w.runLimit).holds;
		const hk = baseBandsOf(kw.u, kw.runLimit).holds;
		assert.deepStrictEqual(hk, hw, "hold times do not depend on the unit");
	});
	it("fewer than 3 runs → no hold profile", () => {
		const { u, runLimit } = units(W);
		const b = learnBands(u, runLimit, { mode: "median60", dipSec: 60 });
		assert.deepStrictEqual(holdProfile(u.slice(0, 2), b), []);
	});
	it("families use the new features only when every run has them (no NaN distance)", () => {
		const f = {
			coreSec: 8000,
			energyWh: 600,
			hiShare: 0.2,
			maxPauseSec: 10,
			nPause: 3,
			trailer: true,
			blockMean: 300,
		};
		const r = assignFamilies(
			[{ ...f, topBandSec: 600, finalBandBlocks: 4 }, { ...f }, { ...f, coreSec: 8100 }],
			[-1, -1, -1],
			0,
		);
		// only "no NaN distance": with three inputs the z-normalisation separates coreSec 8000/8100 ([0,0,1], review/fam.mjs)
		assert.ok(r.families.every(x => Number.isInteger(x) && x >= 0));
	});
});

describe("units and band features", () => {
	it("one unit per layout run, from the tick before its start to the tick after its end", () => {
		const { u, L } = units(W);
		const { s } = layoutOf(W);
		assert.strictEqual(u.length, L.runs.length);
		u.forEach((x, k) => {
			assert.strictEqual(x.from, s.t0 + (L.runs[k].from - 1) * s.stepMs);
			assert.strictEqual(x.to, s.t0 + (L.runs[k].runEnd + 1) * s.stepMs);
			assert.strictEqual(x.points[0].ts, x.from, "the held value at the begin is the first point");
			assert.ok(x.points.every(p => p.ts >= x.from && p.ts <= x.to) && !x.fromTicks);
		});
	});
	it(`over ${RAW_POINTS_MAX} raw values the older runs come from the tick series and give no hold times`, () => {
		const { L, s } = layoutOf(W);
		// many values inside the first run: more raw values than allowed in one call
		const r0 = L.runs[0];
		const t1 = s.t0 + r0.from * s.stepMs;
		const t2 = s.t0 + r0.coreEnd * s.stepMs;
		const every = Math.floor((t2 - t1) / (RAW_POINTS_MAX + 10_000));
		const dense = [...W];
		for (let t = t1 + 1; t < t2; t += every) {
			dense.push({ ts: t, val: 60 });
		}
		dense.sort((a, b) => a.ts - b.ts);
		const u = unitsOf(dense, L, s);
		assert.strictEqual(u[0].fromTicks, true);
		assert.ok(
			u.slice(1).every(x => !x.fromTicks),
			"the newest runs keep their raw values",
		);
		assert.ok(u.reduce((n, x) => n + (x.fromTicks ? 0 : x.points.length), 0) <= RAW_POINTS_MAX);
		const b = learnBands(u, L.runLimit, { mode: "median60", dipSec: 60 });
		const one = holdProfile([u[0], u[0], u[0]], b);
		assert.deepStrictEqual(one, [], "units from ticks have no hold times");
		const kw = unitsOf(
			dense.map(p => ({ ts: p.ts, val: p.val / 1000 })),
			L,
			s,
			1000,
		);
		assert.ok(
			Math.abs(kw[0].points.at(-1).val * 1000 - u[0].points.at(-1).val) < 1e-9,
			"tick values in the unit of the state",
		);
	});
	it("no values above the run level → no bands, no hold profile, no features", () => {
		const idle = [
			{
				points: [
					{ ts: 0, val: 1 },
					{ ts: 600_000, val: 2 },
				],
				from: 0,
				to: 1_200_000,
			},
		];
		const bb = baseBandsOf(idle, 5.5);
		assert.deepStrictEqual([bb.bands, bb.holds, bb.units], [[], [], 1]);
		assert.strictEqual(bandOf(bb, 100), null);
		assert.strictEqual(suspectLimitOf(bb, 100), null);
		assert.strictEqual(bandFeaturesOf(idle[0], bb), null);
		assert.deepStrictEqual(learnBands(idle, 0, { mode: "raw", dipSec: 5 }), []);
	});
	it("the bands cover everything above the run level without gaps, ids b1…", () => {
		const { u, runLimit } = units(W);
		const bb = baseBandsOf(u, runLimit);
		assert.strictEqual(bb.bands[0].min, runLimit);
		assert.strictEqual(bb.bands.at(-1).max, Infinity);
		bb.bands.forEach((b, k) => {
			assert.strictEqual(b.id, `b${k + 1}`);
			if (k > 0) {
				assert.strictEqual(b.min, bb.bands[k - 1].max);
			}
		});
		assert.ok(Math.abs(bb.bands.reduce((s, b) => s + b.activeShare, 0) - 1) < 1e-9);
		assert.strictEqual(bandOf(bb, runLimit), null, "the run level itself is rest");
		assert.strictEqual(bandOf(bb, 3000).id, bb.bands.at(-1).id);
	});
	it("washer: heating time and final spin blocks as group features; families use them when every run has them", () => {
		const { u, runLimit } = units(W);
		const bb = baseBandsOf(u, runLimit);
		const f = u.map(x => bandFeaturesOf(x, bb));
		// heating 7–40 min per programme [B.5 step 9]
		assert.ok(
			f.every(x => x.topBandSec >= 5 * 60 && x.topBandSec <= 45 * 60),
			JSON.stringify(f),
		);
		assert.ok(f.every(x => x.finalBandBlocks >= 1));
		const base = {
			coreSec: 8000,
			energyWh: 600,
			hiShare: 0.2,
			maxPauseSec: 10,
			nPause: 3,
			trailer: true,
			blockMean: 300,
		};
		const short = { ...base, topBandSec: 420, finalBandBlocks: 4 };
		const long = { ...base, topBandSec: 2400, finalBandBlocks: 4 };
		const r = assignFamilies([short, short, long, long], [-1, -1, -1, -1], 0);
		assert.deepStrictEqual(r.families, [0, 0, 1, 1], "heating time separates the programmes");
		const without = assignFamilies([short, short, { ...base }, long], [-1, -1, -1, -1], 0);
		assert.strictEqual(new Set(without.families).size, 1, "one run without the features: as before");
	});
});
