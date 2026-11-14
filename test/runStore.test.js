import assert from "node:assert";
import { readFileSync } from "node:fs";
import { DEFAULT_TYPES } from "../build/lib/legacyTypes.js";
import { LAYOUT_REV } from "../build/lib/learn/runs.js";
import { decodeCells, encodeCells, fromStored, quantOf } from "../build/lib/learn/ticks.js";
import {
	addRun,
	boundaryRuns,
	clearLearningData,
	convertRuns,
	DETECTION_KEYS,
	detectionOf,
	emptyStore,
	evict,
	fitSize,
	labelCapture,
	loadStore,
	MAX_RUN_META,
	MAX_STORE_BYTES,
	MIN_PER_FAMILY,
	recompute,
	recomputeEnvelope,
	reconcileBase,
	reconcileStore,
	removeStore,
	saveStore,
	setDecision,
	sizeOf,
	storeSamples,
	typeHash,
	upgradeStore,
	WINDOW_MS,
} from "../build/lib/runStore.js";
import { memoryFiles } from "./helpers/files.js";
import { runOf } from "./helpers/programmes.js";

const STEP = 10_000;
const WASHER = {
	startVal: 30,
	endVal: 15,
	standby: 1,
	startCount: 2,
	endCount: 50,
	mode: "count",
	startDurationSec: 60,
	endDurationSec: 300,
};

const log = { warn: () => {}, debug: () => {} };

/**
 * Capture of a run as the recorder closes it.
 *
 * @param {object} run run of runOf
 * @param {number} t0 time of the first cell
 * @param {Array<[number, string]>} [ev] events as [cell index, kind]
 * @param {number} [unitFactor] unit factor
 * @returns {object} capture
 */
function captureOf(run, t0, ev, unitFactor = 1) {
	const cells = run.values.map(v => ({
		min: v / unitFactor,
		max: v / unitFactor,
		last: v / unitFactor,
		valid: true,
	}));
	const events = ev ?? [
		[run.start + 2, "s"],
		[run.coreEnd + 30, "f"],
	];
	return {
		t0,
		stepMs: STEP,
		unitFactor,
		cells,
		ev: events.map(([i, k]) => [t0 + i * STEP, k]),
		postTruncated: false,
	};
}

describe("run store", () => {
	it("encodes cells compactly and decodes them in W and kW", () => {
		const cells = [
			{ min: 0.3, max: 0.3, last: 0.3, valid: true },
			{ min: 0.3, max: 0.3, last: 0.3, valid: true },
			{ min: 0, max: 0, last: 0, valid: false },
			{ min: 12.34, max: 2200.5, last: 1999.99, valid: true },
		];
		for (const factor of [1, 1000]) {
			const scaled = cells.map(c => ({ ...c, min: c.min / factor, max: c.max / factor, last: c.last / factor }));
			const q = quantOf(factor);
			const data = encodeCells(scaled, q);
			const back = decodeCells(data, q);
			assert.strictEqual(back.length, 4);
			assert.strictEqual(back[2].valid, false);
			back.forEach((c, i) => {
				if (c.valid) {
					assert.ok(Math.abs(c.last * factor - cells[i].last) < 0.01, `${factor}: ${c.last}`);
					assert.ok(Math.abs(c.max * factor - cells[i].max) < 0.01);
				}
			});
			const s = fromStored({ ts: 0, step: STEP, q, data }, factor);
			assert.strictEqual(s.length, 4);
			assert.strictEqual(s.valid[2], 0);
		}
		assert.throws(() => decodeCells("{}", 100));
		assert.throws(() => decodeCells("[[0, 1]]", 100));
	});

	it("labels a run, a false start and a split run", () => {
		const run = runOf({ device: "washer", programme: "quick30", shape: "T1", seed: 1, after: 400 });
		const ok = labelCapture(captureOf(run, 0), 15);
		assert.strictEqual(ok.label, "run");
		assert.strictEqual(ok.trusted, true);
		assert.ok(Math.abs(ok.run.seg.coreEndIdx - run.coreEnd) <= 1);
		assert.ok(ok.run.feat.trailer);
		assert.ok(Math.abs(ok.endDelaySec - 300) <= 10, `${ok.endDelaySec}`);
		const split = labelCapture(
			captureOf(run, 0, [
				[8, "s"],
				[100, "f"],
				[110, "s"],
				[run.coreEnd + 30, "f"],
			]),
			15,
		);
		assert.strictEqual(split.label, "split");
		const spikeValues = [...new Array(200).fill(0.5), 600, 600, ...new Array(200).fill(0.5)];
		const spike = labelCapture(captureOf({ values: spikeValues, start: 200, coreEnd: 201 }, 0, [[201, "s"]]), 15);
		assert.strictEqual(spike.label, "spike");
		const nothing = labelCapture(captureOf({ values: new Array(200).fill(0.5), start: 0, coreEnd: 0 }, 0, []), 15);
		assert.strictEqual(nothing.label, "unclear");
		// a start far from the run: unclear
		const far = labelCapture(
			captureOf(run, 0, [
				[run.coreEnd, "s"],
				[run.coreEnd + 30, "f"],
			]),
			15,
		);
		assert.strictEqual(far.label, "unclear");
	});

	it("keeps the runs of 30 days; older ones go with two per programme group left, history runs first", () => {
		const store = emptyStore("dev", "washing-machine", typeHash(WASHER), STEP, 1);
		const progs = ["cotton60", "quick30", "eco4060", "wool", "spinOnly"];
		let t = 0;
		for (let k = 0; k < 45; k++) {
			const run = runOf({ device: "washer", programme: progs[k % 5], shape: "T1", seed: k + 1, after: 400 });
			const res = labelCapture(captureOf(run, t), 15, k < 3 ? "history" : "live");
			assert.strictEqual(res.label, "run", `run ${k}`);
			addRun(store, res.run);
			t += 86_400_000;
		}
		assert.ok(sizeOf(store) < MAX_STORE_BYTES, `${sizeOf(store)} bytes`);
		assert.ok(store.runs.every(r => typeof r.key === "string" && r.key.startsWith("dev@")));
		// days 15 to 44 lie within 30 days of the last run (day 14 is a few hours older)
		const now = store.runs.at(-1).ts;
		const recent = store.runs.filter(r => r.ts >= now - WINDOW_MS + 86_400_000).length;
		assert.strictEqual(recent, 30, "every run of the last 30 days stays");
		assert.ok(store.runs.length > 30 || store.runs[0].ts >= now - WINDOW_MS);
		assert.ok(
			store.runs.every(r => r.src === "live"),
			"history runs are evicted first",
		);
		const perFamily = new Map();
		for (const r of store.runs) {
			perFamily.set(r.family, (perFamily.get(r.family) ?? 0) + 1);
		}
		assert.ok(
			[...perFamily.values()].every(n => n >= MIN_PER_FAMILY),
			JSON.stringify([...perFamily]),
		);
		// the envelope comes from the stored runs again (no frozen envelope of an earlier version)
		const env = { ...store.envelope };
		recomputeEnvelope(store);
		assert.deepStrictEqual(store.envelope, env);
	});

	it("never evicts a boundary run (the one that sets an extreme of the envelope) while others can go", () => {
		const store = emptyStore("dev", "washing-machine", typeHash(WASHER), STEP, 1);
		let t = 0;
		const add = k => {
			const run = runOf({ device: "washer", programme: "quick30", shape: "T4", seed: k + 1, after: 400 });
			addRun(store, labelCapture(captureOf(run, t), 15).run);
			t += 86_400_000;
		};
		add(0);
		// the oldest run has the longest pause of all (slightly, so it stays in the same group)
		const binding = store.runs[0];
		binding.feat.maxPauseSec += 5;
		recomputeEnvelope(store);
		for (let k = 1; k < 40; k++) {
			add(k);
		}
		assert.ok(
			store.runs.some(r => r.id === binding.id),
			"the boundary run is kept",
		);
		assert.ok(boundaryRuns(store).has(binding.key));
		assert.ok(store.runs[1].ts > 86_400_000, "the oldest runs that bind nothing were evicted");
		assert.strictEqual(store.envelope.maxPauseSec, binding.feat.maxPauseSec);
	});

	it("over the size limit the cells of excluded runs go first, then history runs; 400 runs at most", () => {
		const store = emptyStore("dev", "washing-machine", typeHash(WASHER), STEP, 1);
		for (let k = 0; k < 6; k++) {
			const run = runOf({ device: "washer", programme: "cotton60", shape: "T4", seed: k + 1, after: 400 });
			addRun(store, labelCapture(captureOf(run, k * 3_600_000), 15, k < 2 ? "history" : "live").run);
		}
		const excluded = store.runs[3];
		setDecision(store, excluded.key, "exclude");
		const size = sizeOf(store);
		// a limit just below the size: emulated with a run that carries a large report log
		store.runs[4].rep = new Array(Math.ceil((MAX_STORE_BYTES - size) / 2) + 10).fill(1);
		evict(store, store.runs.at(-1).ts);
		assert.strictEqual(excluded.data, undefined, "the excluded run keeps only its metadata");
		assert.ok(store.runs.includes(excluded));
		assert.strictEqual(store.runs.length, 6, "the excluded cells were enough");
		assert.ok(sizeOf(store) <= MAX_STORE_BYTES);
		assert.strictEqual(MAX_RUN_META, 400);
	});

	it("keeps ten false starts first in first out", () => {
		const store = emptyStore("dev", "dryer", "h", STEP, 1);
		const values = [...new Array(200).fill(0.5), 600, 600, ...new Array(200).fill(0.5)];
		for (let k = 0; k < 12; k++) {
			addRun(store, labelCapture(captureOf({ values, start: 200, coreEnd: 201 }, k * 1e7, [[201, "s"]]), 15).run);
		}
		assert.strictEqual(store.spikes.length, 10);
		assert.strictEqual(store.spikes[0].ts, 2e7);
	});

	it("writes alternating slots, falls back to the other slot and removes both", async () => {
		const io = memoryFiles();
		const store = emptyStore("dev", "washing-machine", "h", STEP, 1);
		await saveStore(io, store);
		store.override = { endCount: 30 };
		await saveStore(io, store);
		assert.deepStrictEqual([...io.files.keys()].sort(), ["dev.a.json", "dev.b.json"]);
		assert.deepStrictEqual((await loadStore(io, "dev", log)).override, { endCount: 30 });
		// the newer slot is corrupt: the older one is used
		const newer = store.seq % 2 === 0 ? "dev.a.json" : "dev.b.json";
		io.files.set(newer, "{broken");
		const warns = [];
		const back = await loadStore(io, "dev", { warn: m => warns.push(m), debug: () => {} });
		assert.strictEqual(back.override, null);
		assert.strictEqual(warns.length, 1);
		io.files.set(newer, JSON.stringify({ v: 99 }));
		assert.ok(await loadStore(io, "dev", { warn: m => warns.push(m), debug: () => {} }));
		assert.strictEqual(warns.length, 2);
		await removeStore(io, "dev");
		assert.strictEqual(await loadStore(io, "dev", log), null);
		// a read error is not "no learning data" (an empty store would overwrite both slots)
		const failing = {
			read: async () => Promise.reject(new Error("x")),
			write: async () => {},
			remove: async () => {},
		};
		await assert.rejects(loadStore(failing, "dev", log), /x/);
	});

	it("stores the capture of a run in progress encoded and within the size limit", async () => {
		const io = memoryFiles();
		const store = emptyStore("dev", "washing-machine", "h", 1000, 1);
		// 30 min pre-roll plus a 3 h run at a 1 s poll with noisy values
		let seed = 7;
		const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		const cells = Array.from({ length: 12_600 }, () => {
			const v = Math.round((300 + rnd() * 1700) * 10) / 10;
			return { min: v - 3, max: v + 3, last: v, valid: true };
		});
		store.pending = {
			t0: 1e12,
			stepMs: 1000,
			unitFactor: 1,
			cells,
			ev: [[1e12 + 1_800_000, "s"]],
			postTruncated: false,
		};
		const raw = JSON.stringify(store).length;
		await saveStore(io, store);
		const text = [...io.files.values()][0];
		assert.ok(text.length < raw / 2, `encoded ${text.length} < raw ${raw} / 2`);
		assert.strictEqual(sizeOf(store), text.length);
		const back = await loadStore(io, "dev", log);
		assert.strictEqual(back.pending.cells.length, cells.length);
		assert.deepStrictEqual(back.pending.cells[5], cells[5]);
		assert.deepStrictEqual(back.pending.ev, store.pending.ev);

		// with 20 stored runs the file still stays below the limit
		for (let k = 0; k < 20; k++) {
			const run = runOf({ device: "washer", programme: "cotton60", shape: "T4", seed: k + 1, after: 400 });
			addRun(store, labelCapture(captureOf(run, 2e12 + k * 1e8), 15).run);
		}
		fitSize(store);
		assert.ok(sizeOf(store) <= MAX_STORE_BYTES, `size ${sizeOf(store)}`);
		// a capture too large to persist is dropped instead of growing the file
		const huge = Array.from({ length: 25_000 }, (_, i) => ({ min: i, max: i + 1, last: i + 0.5, valid: true }));
		store.pending = { ...store.pending, cells: huge };
		fitSize(store);
		assert.strictEqual(store.pending, null);
		assert.ok(sizeOf(store) <= MAX_STORE_BYTES);
	});

	it("discards the override when the detection values change and converts the runs when poll or unit change", () => {
		const store = emptyStore("dev", "washing-machine", typeHash(WASHER), STEP, 1);
		const run = runOf({ device: "washer", programme: "quick30", shape: "T1", seed: 1, after: 400 });
		addRun(store, labelCapture(captureOf(run, 0), 15).run);
		store.override = { endCount: 30 };
		const env = { ...store.envelope };
		assert.deepStrictEqual(reconcileStore(store, typeHash(WASHER), STEP, 1, 5), []);
		const msgs = reconcileStore(store, typeHash({ ...WASHER, endCount: 40 }), STEP, 1, 5);
		assert.strictEqual(msgs.length, 1);
		assert.strictEqual(store.override, null);
		assert.strictEqual(store.changes.at(-1).kind, "baseChanged");
		assert.strictEqual(store.runs.length, 1);
		const msgs2 = reconcileStore(store, store.typeHash, 60_000, 1, 6);
		assert.ok(msgs2[0].includes("converted"), msgs2[0]);
		assert.deepStrictEqual([store.runs.length, store.runs[0].step, store.step], [1, 60_000, 60_000]);
		assert.deepStrictEqual(store.envelope, env);
		assert.notStrictEqual(typeHash(WASHER), typeHash({ ...WASHER, trailerBurstSec: 30 }));
	});

	it("keeps the override when only the type id of the store differs (migration, M9)", () => {
		const st = emptyStore("wm", "washing-machine", "39417b8a", 10000, 1);
		st.override = { endCount: 30 };
		assert.deepStrictEqual(reconcileStore(st, "39417b8a", 10000, 1, 0), []);
		assert.deepStrictEqual(st.override, { endCount: 30 });
		reconcileStore(st, "0af5b9bf", 10000, 1, 5);
		assert.strictEqual(st.override, null);
		assert.strictEqual(st.changes.at(-1).kind, "baseChanged");
	});

	it("reconcileBase: adopted when the new base equals the old effective values", () => {
		const st = emptyStore("wm", "", typeHash(WASHER), 10000, 1);
		st.override = { endCount: 30 };
		const eff = typeHash({ ...WASHER, endCount: 30 });
		assert.strictEqual(reconcileBase(st, eff, eff, 7), "adopted");
		assert.deepStrictEqual([st.override, st.typeHash, st.changes.at(-1).kind], [null, eff, "adopted"]);
		assert.strictEqual(reconcileBase(st, eff, eff, 8), "none");
	});

	it("reconcileBase: another base drops the override with baseChanged", () => {
		const st = emptyStore("wm", "", typeHash(WASHER), 10000, 1);
		st.override = { endCount: 30 };
		assert.strictEqual(
			reconcileBase(st, typeHash({ ...WASHER, endVal: 10 }), typeHash({ ...WASHER, endCount: 30 }), 9),
			"baseChanged",
		);
		assert.deepStrictEqual(
			[st.override, st.changes.at(-1).kind, st.changes.at(-1).from],
			[null, "baseChanged", { endCount: 30 }],
		);
	});

	describe("hash of the detection values", () => {
		it("keeps the hashes of existing values", () => {
			assert.deepStrictEqual(DEFAULT_TYPES.slice(0, 4).map(typeHash), [
				"39417b8a",
				"0af5b9bf",
				"8b9f87e6",
				"37a6b30f",
			]);
			assert.strictEqual(typeHash({ ...DEFAULT_TYPES[0], finalMinVal: 0, finalLockSec: 0 }), "39417b8a");
		});

		it("appends non-zero final fields as name=value, without collisions", () => {
			const a = typeHash({ ...DEFAULT_TYPES[0], finalMinVal: 150, finalMinSec: 160 });
			const b = typeHash({ ...DEFAULT_TYPES[0], finalMinVal: 160, finalMinSec: 150 });
			assert.notStrictEqual(a, "39417b8a");
			assert.notStrictEqual(a, b);
		});

		it("detectionOf fills 29 fields, final fields 0", () => {
			const d = detectionOf(DEFAULT_TYPES[0]);
			assert.strictEqual(DETECTION_KEYS.length, 29);
			assert.strictEqual(Object.keys(d).length, 29);
			assert.strictEqual(d.finalLockSec, 0);
		});
	});
});

const rawStore = readFileSync(new URL("./fixtures/v4store.json", import.meta.url), "utf8");
const fresh = () => {
	const st = JSON.parse(rawStore);
	upgradeStore(st);
	return st;
};
const DAY = 86_400_000;
const QCTX = { bands: null, unitFactor: 1, unit: "W", settings: null, pollMs: 10_000, outages: [], scope: "run" };

describe("learning data of V5", () => {
	it("v4store: legacyEnvelope frozen once, runs re-segmented, families stable, no NaN", () => {
		const st = JSON.parse(rawStore);
		const before = st.runs.map(r => r.family);
		upgradeStore(st);
		assert.deepStrictEqual(st.legacyEnvelope, JSON.parse(rawStore).envelope);
		assert.ok(st.runs.every(r => r.rev === LAYOUT_REV && typeof r.key === "string"));
		assert.deepStrictEqual(
			st.runs.map(r => r.family),
			before,
		);
		assert.ok(st.runs.every(r => Object.values(r.feat).every(x => typeof x !== "number" || Number.isFinite(x))));
		const again = structuredClone(st.legacyEnvelope);
		assert.deepStrictEqual(upgradeStore(st), [], "a store of the current version stays as it is");
		assert.deepStrictEqual(st.legacyEnvelope, again);
	});

	it("the recomputed envelope is never narrower than legacyEnvelope (P10)", () => {
		const st = fresh();
		st.runs = st.runs.slice(0, 3);
		recomputeEnvelope(st);
		const L = st.legacyEnvelope;
		for (const k of ["maxPauseSec", "maxBurstSec", "maxTrailSec", "maxTrailerSec"]) {
			assert.ok(st.envelope[k] >= L[k], k);
		}
		for (const k of ["minRunW", "minCoreSec"]) {
			assert.ok(L[k] === 0 || st.envelope[k] <= L[k], k);
		}
	});

	it("eviction after 30 days keeps 2 per family and every boundary run (P23)", () => {
		const st = fresh();
		const keep = boundaryRuns(st);
		const families = new Map();
		for (const r of st.runs) {
			families.set(r.family, (families.get(r.family) ?? 0) + 1);
		}
		evict(st, Math.max(...st.runs.map(r => r.ts)) + WINDOW_MS + 10 * DAY);
		for (const [f, n] of families) {
			assert.ok(st.runs.filter(r => r.family === f).length >= Math.min(2, n), `family ${f}`);
		}
		for (const k of keep) {
			assert.ok(
				st.runs.some(r => r.key === k),
				k,
			);
		}
		assert.ok(st.runs.length < 10, "older runs that keep nothing went");
	});

	it("two equally extreme runs → at least one stays", () => {
		// the order of the step-wise eviction is not fixed, and "at least 2 per family" may keep both
		const st = fresh();
		const b = st.runs.find(r => boundaryRuns(st).has(r.key));
		const twin = { ...structuredClone(b), key: `${b.key}-twin`, id: `${b.id}t`, ts: b.ts + 1000 };
		st.runs.push(twin);
		for (let k = 0; k < 6; k++) {
			st.runs.push({ ...structuredClone(st.runs[0]), key: `x${k}`, id: `x${k}`, family: b.family });
		}
		evict(st, Math.max(...st.runs.map(r => r.ts)) + WINDOW_MS + DAY);
		assert.ok(st.runs.filter(r => r.key === b.key || r.key === twin.key).length >= 1);
	});

	it("the store carries the tail separation of all admitted runs; storeSamples rebuilds samples with verdicts", () => {
		const st = fresh();
		assert.deepStrictEqual([st.tail.separated, Math.round(st.tail.ceil)], [true, 124]);
		assert.ok(
			st.runs.every(r => Number.isInteger(r.seg.progEndIdx) && r.feat.burstMaxW >= 0 && r.feat.endBlockMinW > 0),
		);
		const out = storeSamples(st, QCTX);
		assert.strictEqual(out.length, st.runs.filter(r => r.data).length);
		assert.ok(out.every(x => x.sample.key === x.verdict.key && x.series.length > 0));
	});

	it("excluding and including again restores the envelope exactly", () => {
		const st = fresh();
		recomputeEnvelope(st);
		const env = structuredClone(st.envelope);
		const key = [...boundaryRuns(st)][0];
		setDecision(st, key, "exclude");
		recomputeEnvelope(st);
		setDecision(st, key, null);
		recomputeEnvelope(st);
		assert.deepStrictEqual(st.envelope, env);
	});

	it("poll and unit changes convert runs instead of discarding them; boundaries stay in W (P27)", () => {
		const st = fresh();
		const n = st.runs.length;
		const env = structuredClone(st.envelope);
		assert.ok(convertRuns(st, 30_000, 1).length > 0);
		assert.deepStrictEqual([st.runs.length, st.step], [n, 30_000]);
		convertRuns(st, 10_000, 1000);
		assert.deepStrictEqual([st.runs.length, st.unitFactor, st.step], [n, 1000, 10_000]);
		assert.deepStrictEqual(st.envelope, env);
		assert.ok(
			st.runs.every(r => r.gridFrom === 30_000),
			"finer grid: property of the run (no phases, no trailer)",
		);
		assert.ok(
			Object.values(st.verdicts).every(v => v.reason !== "finerGrid"),
			"not mixed with user decisions",
		);
	});

	it("clearing keeps the decisions unless asked (P26)", () => {
		const st = fresh();
		setDecision(st, "wm@100", "exclude");
		assert.deepStrictEqual(clearLearningData(st, true).verdicts, { "wm@100": { user: "exclude" } });
		assert.deepStrictEqual(clearLearningData(st, false).verdicts, {});
		assert.deepStrictEqual(clearLearningData(st, true).runs, []);
	});

	it("limits: 1 MB, metadata of 400 runs, 30-day window", () => {
		assert.deepStrictEqual([MAX_STORE_BYTES, MAX_RUN_META, WINDOW_MS], [1_000_000, 400, 30 * DAY]);
	});

	it("converted runs keep their cells in time and value; a finer grid repeats the held value", () => {
		const st = fresh();
		const r = st.runs[0];
		const before = fromStored(r, r.unitFactor);
		const peak = Math.max(...before.max);
		const startT = r.ts + r.seg.startIdx * r.step;
		convertRuns(st, 20_000, 1000);
		const coarse = fromStored(r, r.unitFactor);
		assert.strictEqual(coarse.length, Math.floor(((before.length - 1) * 10_000) / 20_000) + 1);
		assert.ok(Math.abs(Math.max(...coarse.max) - peak) < 0.01, "extremes of the time between two grid points");
		assert.ok(Math.abs(r.ts + r.seg.startIdx * r.step - startT) <= 10_000);
		convertRuns(st, 5_000, 1);
		const fine = fromStored(r, r.unitFactor);
		assert.strictEqual(fine.last[3], fine.last[2], "the held value is repeated");
		assert.deepStrictEqual([r.gridFrom, r.step], [20_000, 5_000]);
		const back = storeSamples(st, { ...QCTX, pollMs: 5_000 }).find(x => x.run === r);
		assert.deepStrictEqual([back.verdict.uses.phases, back.verdict.uses.trailer], [false, false]);
	});

	it("recompute: bands of the clean runs, band features in every run, verdicts with the decisions", () => {
		const st = fresh();
		setDecision(st, st.runs[2].key, "exclude");
		const verdicts = recompute(st, QCTX);
		assert.ok(st.bands && st.bands.bands.length >= 3, "bands learned from the stored runs");
		assert.ok(st.runs.every(r => Number.isFinite(r.feat.topBandSec) && Number.isFinite(r.feat.finalBandBlocks)));
		assert.strictEqual(verdicts.get(st.runs[2].key).user, "exclude");
		assert.strictEqual(verdicts.size, st.runs.length);
		assert.ok(
			[...verdicts.values()].filter(v => v.stage === "ok" || v.stage === "limited").length >= 8,
			"most washer runs are usable",
		);
		// bands survive the file (the open upper limit is written as null)
		const back = JSON.parse(JSON.stringify(st));
		back.layoutRev = 0;
		upgradeStore(back);
		assert.strictEqual(back.bands.bands.at(-1).max, Number.POSITIVE_INFINITY);
	});
});
