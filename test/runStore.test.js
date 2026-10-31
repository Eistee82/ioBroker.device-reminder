import assert from "node:assert";
import { decodeCells, encodeCells, fromStored, quantOf } from "../build/lib/learn/ticks.js";
import {
	addRun,
	emptyStore,
	fitSize,
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

	it("never evicts a binding run (the one that sets an extreme of the envelope) while others can go", () => {
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
		store.envelope.maxPauseSec = binding.feat.maxPauseSec;
		for (let k = 1; k < MAX_RUNS + 6; k++) {
			add(k);
		}
		assert.strictEqual(store.runs.length, MAX_RUNS);
		assert.ok(
			store.runs.some(r => r.id === binding.id),
			"the binding run is kept",
		);
		assert.ok(store.runs[1].ts > 86_400_000, "the oldest non-binding runs were evicted");
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
		for (let k = 0; k < MAX_RUNS; k++) {
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
