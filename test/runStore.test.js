import assert from "node:assert";
import { decodeCells, encodeCells, fromStored, quantOf } from "../build/lib/learn/ticks.js";
import {
	addRun,
	emptyStore,
	labelCapture,
	loadStore,
	MAX_RUNS,
	MAX_STORE_BYTES,
	reconcileStore,
	removeStore,
	saveStore,
	sizeOf,
	typeHash,
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

	it("stores 20 runs below 400 KB, keeps the last two of every programme group and history runs go first", () => {
		const store = emptyStore("dev", "washing-machine", typeHash(WASHER), STEP, 1);
		const progs = ["cotton60", "quick30", "eco4060", "wool", "spinOnly"];
		let t = 0;
		for (let k = 0; k < 30; k++) {
			const run = runOf({ device: "washer", programme: progs[k % 5], shape: "T1", seed: k + 1, after: 400 });
			const res = labelCapture(captureOf(run, t), 15, k < 3 ? "history" : "live");
			assert.strictEqual(res.label, "run", `run ${k}`);
			addRun(store, res.run);
			t += 86_400_000;
		}
		assert.strictEqual(store.runs.length, MAX_RUNS);
		assert.ok(sizeOf(store) < MAX_STORE_BYTES, `${sizeOf(store)} bytes`);
		assert.ok(
			store.runs.every(r => r.src === "live"),
			"history runs are evicted first",
		);
		const perFamily = new Map();
		for (const r of store.runs) {
			perFamily.set(r.family, (perFamily.get(r.family) ?? 0) + 1);
		}
		assert.ok(
			[...perFamily.values()].every(n => n >= 2),
			JSON.stringify([...perFamily]),
		);
		assert.strictEqual(store.envelope.n, 30);
		const env = { ...store.envelope };
		// the envelope never shrinks
		addRun(
			store,
			labelCapture(captureOf(runOf({ device: "washer", programme: "quick30", seed: 99, after: 400 }), t), 15).run,
		);
		assert.ok(store.envelope.maxTrailerSec >= env.maxTrailerSec && store.envelope.minCoreSec <= env.minCoreSec);
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
		const failing = {
			read: async () => Promise.reject(new Error("x")),
			write: async () => {},
			remove: async () => {},
		};
		assert.strictEqual(await loadStore(failing, "dev", log), null);
	});

	it("discards the override when the type changes and the runs when poll or unit change", () => {
		const store = emptyStore("dev", "washing-machine", typeHash(WASHER), STEP, 1);
		const run = runOf({ device: "washer", programme: "quick30", shape: "T1", seed: 1, after: 400 });
		addRun(store, labelCapture(captureOf(run, 0), 15).run);
		store.override = { endCount: 30 };
		const env = { ...store.envelope };
		assert.deepStrictEqual(reconcileStore(store, "washing-machine", typeHash(WASHER), STEP, 1, 5), []);
		const msgs = reconcileStore(store, "washing-machine", typeHash({ ...WASHER, endCount: 40 }), STEP, 1, 5);
		assert.strictEqual(msgs.length, 1);
		assert.strictEqual(store.override, null);
		assert.strictEqual(store.changes.at(-1).kind, "typeChanged");
		assert.strictEqual(store.runs.length, 1);
		reconcileStore(store, "washing-machine", store.typeHash, 60_000, 1, 6);
		assert.strictEqual(store.runs.length, 0);
		assert.deepStrictEqual(store.envelope, env);
		assert.notStrictEqual(typeHash(WASHER), typeHash({ ...WASHER, trailerBurstSec: 30 }));
	});
});
