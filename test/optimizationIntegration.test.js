import assert from "node:assert";
import { DeviceSync } from "../build/lib/deviceSync.js";
import { fill, TEXT } from "../build/lib/dmTexts.js";
import { emptyStore, MAX_CHANGES, pushChange, saveStore, typeHash } from "../build/lib/runStore.js";
import { createFakeHost } from "./helpers/fakeHost.js";
import { memoryFiles } from "./helpers/files.js";
import { washingMachine } from "./helpers/curves.js";
import { Notifier } from "../build/lib/notifier.js";
import { DeviceRegistry, formatDate } from "../build/lib/deviceRegistry.js";
import {
	deviceConfig,
	drain,
	DRYER,
	feed,
	feedPoints,
	instanceConfig,
	P,
	pauseRun,
	registrySetup,
	WASHER,
} from "./helpers/devices.js";
import { syntheticRun, WM_FINAL } from "./helpers/final.js";
import { layoutOf, loadSeries, restartScenarios } from "./helpers/fixtures.js";
import { historyOf } from "./helpers/history.js";
import { runOf } from "./helpers/programmes.js";

const STEP = 10_000;
const DAY = 86_400_000;

/**
 * Fake installation with a history instance holding `points` for the power state.
 *
 * @param {{ ts: number, val: number }[]} points stored values
 * @returns {object} history access
 */
function historyEnv(points) {
	const objects = {
		[P]: { common: { unit: "W", role: "value.power", custom: { "history.0": { enabled: true } } } },
		"system.adapter.history.0": { common: { getHistory: true } },
	};
	return {
		queries: 0,
		object: async id => objects[id] ?? null,
		alive: async instance => instance === "history.0",
		async getHistory(_id, options) {
			this.queries++;
			return { result: points.filter(p => p.ts >= options.start && p.ts <= options.end) };
		},
	};
}

/**
 * Registry with one device.
 *
 * @param {object} [o] options of `registrySetup`
 * @returns {Promise<object>} context
 */
const setup = registrySetup;
const play = feed;

describe("automatic optimisation in the registry", function () {
	this.timeout(120_000);

	it("takes over the runs of the history when it starts without learning data", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const points = historyOf(
			[washingMachine, washingMachine, washingMachine, washingMachine],
			host.now() - 2 * DAY,
		);
		const history = historyEnv(points);
		const ctx = await setup({ host, history });
		await drain(ctx);
		const store = ctx.reg.learningData("dev");
		assert.ok(history.queries > 0, "the history was read");
		assert.ok(store.runs.length >= 3, `runs taken over: ${store.runs.length}`);
		assert.ok(store.runs.every(r => r.src === "history"));
		assert.ok(ctx.host.logs.info.some(m => m.includes("taken over from the history (history.0)")));
		assert.ok(ctx.files.files.has("dev.a.json") || ctx.files.files.has("dev.b.json"), "store saved");

		// a restart with stored learning data does not read the history again
		const again = historyEnv(points);
		const next = await setup({ host, history: again, files: ctx.files });
		await drain(next);
		assert.strictEqual(again.queries, 0);
		assert.strictEqual(next.reg.learningData("dev").runs.length, store.runs.length);
	});

	it("works without a history adapter and without history access", async () => {
		const ctx = await setup({ history: historyEnv([]) });
		await drain(ctx);
		assert.strictEqual(ctx.reg.learningData("dev").runs.length, 0);
		const plain = await setup();
		await drain(plain);
		assert.strictEqual(plain.reg.learningData("dev").runs.length, 0);
	});

	it("records a run whose start the values miss (capture without a start event)", async () => {
		const ctx = await setup({ detection: { ...WASHER, startVal: 5000 } });
		await play(ctx, [...new Array(200).fill(0.5), ...new Array(180).fill(500), ...new Array(250).fill(0.5)]);
		const store = ctx.reg.learningData("dev");
		assert.strictEqual(store.runs.length, 1, "the run is stored");
		assert.deepStrictEqual(store.runs[0].ev, [], "without a start of the runtime");
		assert.strictEqual(store.pending, null);
	});

	it("does not read the history while the optimisation is off", async () => {
		const history = historyEnv([]);
		const ctx = await setup({ history, autoOptimize: false });
		await drain(ctx);
		assert.strictEqual(ctx.reg.learningData("dev"), null);
		assert.strictEqual(await ctx.reg.readLearningData("dev"), null);
		assert.strictEqual(ctx.files.writes, 0);
	});

	it("discards a stored run as decision of the user, replays it no more and reads the data while the optimisation is off", async () => {
		const ctx = await setup({ detection: DRYER });
		const run = runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 3, after: 400 });
		await play(ctx, run.values);
		const store = ctx.reg.learningData("dev");
		const ids = [...store.runs, ...store.spikes].map(r => r.id);
		assert.ok(ids.length > 0, "a run was stored");
		const check = await ctx.reg.checkStoredRuns("dev");
		assert.strictEqual(check.perRun.length, store.runs.length);

		assert.strictEqual(await ctx.reg.discardRun("dev", "nope"), false);
		assert.strictEqual(await ctx.reg.discardRun("dev", ids[0]), true);
		assert.strictEqual(await ctx.reg.discardRun("dev", ids[0]), false, "already excluded");
		const after = ctx.reg.learningData("dev");
		const gone = [...after.runs, ...after.spikes].find(r => r.id === ids[0]);
		assert.deepStrictEqual(after.verdicts[gone.key], { user: "exclude" }, "kept as decision over its key");
		const replayed = await ctx.reg.checkStoredRuns("dev");
		assert.ok(!replayed.perRun.some(r => r.id === ids[0]), "no longer replayed");

		// switched off: the data stays in the file and can still be read
		await ctx.reg.upsert("dev", { ...ctx.cfg, autoOptimize: undefined });
		assert.strictEqual(ctx.reg.learningData("dev"), null);
		assert.strictEqual(await ctx.reg.checkStoredRuns("dev"), null);
		assert.strictEqual(await ctx.reg.discardRun("dev", ids[0]), false);
		const read = await ctx.reg.readLearningData("dev");
		assert.strictEqual(read.runs.length + read.spikes.length, ids.length);
		assert.strictEqual(Object.keys(read.verdicts).length, 1);
		// "clear learning data" keeps the decision, only the extra option removes it
		await ctx.reg.deleteLearningData("dev");
		const cleared = await ctx.reg.readLearningData("dev");
		assert.deepStrictEqual([cleared.runs.length, Object.keys(cleared.verdicts).length], [0, 1]);
		await ctx.reg.deleteLearningData("dev", false);
		assert.strictEqual(await ctx.reg.readLearningData("dev"), null);
	});

	it("sends the changes in the language of the installation and logs them in English", async () => {
		const ctx = await setup({ detection: DRYER, notify: true, lang: "de" });
		const run = runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 3, after: 400 });
		await play(ctx, run.values);
		const store = ctx.reg.learningData("dev");
		assert.strictEqual(store.changes.at(-1)?.kind, "repair", "the false starts are repaired after one run");
		assert.ok(ctx.host.logs.info.some(m => m.startsWith("Waschmaschine: detection made safer after the run of")));
		const sent = ctx.host.sent.filter(s => s.instance === "telegram.0").map(s => JSON.stringify(s.message));
		assert.ok(
			sent.some(m => m.includes("Erkennung nach dem Lauf vom")),
			`German message sent: ${sent.join(" | ")}`,
		);
	});

	it("an undo or reset during a running optimisation job is not overwritten by the job", async () => {
		for (const op of ["reset", "undo"]) {
			const ctx = await setup({ detection: DRYER });
			if (op === "undo") {
				// a first change to undo later
				await play(ctx, runOf({ device: "dryer", programme: "iron", shape: "T1", seed: 2, after: 400 }).values);
				assert.ok(ctx.reg.learningData("dev").changes.length > 0);
			}
			const instBefore = JSON.stringify(ctx.inst);
			const run = runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 1, after: 400 });
			// feed the run without waiting: the capture closes and the job starts
			for (const v of run.values) {
				ctx.host.setValue(P, v);
				await ctx.reg.routeForeignState(P, v);
				ctx.host.tickClock(STEP);
				await ctx.reg.tickAll();
			}
			// the job waits at its first yield (fake timers run only in drain)
			const store = ctx.reg.learningData("dev");
			const user = op === "reset" ? ctx.reg.resetOptimization("dev") : ctx.reg.undoOptimization("dev");
			await drain(ctx);
			assert.strictEqual(await user, true);
			assert.strictEqual(store.changes.at(-1).kind, op, `${op}: ${store.changes.map(c => c.kind)}`);
			assert.deepStrictEqual(ctx.reg.get("dev").currentOverride, store.override);
			if (op === "reset") {
				assert.strictEqual(store.override, null);
			}
			// the optimiser never writes the instance configuration (that would restart the instance)
			assert.strictEqual(JSON.stringify(ctx.inst), instBefore);
			assert.ok(!ctx.host.writes.some(w => w.id.startsWith("system.adapter.")));
		}
	});

	it("a read error of the learning data keeps the optimisation off instead of overwriting the data", async () => {
		const ctx = await setup({ detection: DRYER });
		await play(ctx, runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 1, after: 400 }).values);
		const saved = new Map(ctx.files.files);
		const before = ctx.reg.learningData("dev");
		const broken = {
			...ctx.files,
			writes: 0,
			read: async () => Promise.reject(new Error("connection lost")),
			write: async (name, data) => {
				broken.writes++;
				ctx.files.files.set(name, data);
			},
		};
		const next = await setup({ detection: DRYER, files: broken });
		await drain(next);
		assert.strictEqual(next.reg.learningData("dev"), null, "optimisation off");
		assert.strictEqual(broken.writes, 0, "nothing written");
		assert.ok(next.host.logs.warn.some(m => m.includes("learning data not readable")));
		assert.deepStrictEqual(ctx.files.files, saved);
		// the next start reads the data again
		const again = await setup({ detection: DRYER, files: ctx.files });
		assert.strictEqual(again.reg.learningData("dev").runs.length, before.runs.length);
		assert.deepStrictEqual(again.reg.learningData("dev").override, before.override);
	});

	it("deleting the device deletes its learning data, also while the history is read", async () => {
		// deleted in the object browser: DeviceSync gets the deleted object
		const ctx = await setup({ detection: DRYER });
		await play(ctx, runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 1, after: 400 }).values);
		const writer = { extendObject: async () => {}, setObjectNotExists: async () => {}, delObject: async () => {} };
		const sync = new DeviceSync(ctx.reg, writer, () => ctx.inst, ctx.host.log);
		await sync.apply("dev", null);
		assert.ok(ctx.files.files.size > 0, "an unusable configuration keeps the data");
		await ctx.reg.upsert("dev", ctx.cfg);
		await sync.apply("dev", null, true);
		assert.strictEqual(ctx.files.files.size, 0);
		assert.strictEqual(ctx.reg.get("dev"), undefined);

		// deleted while the history is read: nothing is written for the deleted device
		let release = () => {};
		const gateHistory = new Promise(resolve => {
			release = resolve;
		});
		const host = createFakeHost({ objects: { [P]: "number" } });
		const history = historyEnv(historyOf([washingMachine, washingMachine, washingMachine], host.now() - DAY));
		const read = history.getHistory.bind(history);
		history.getHistory = async (id, options) => {
			await gateHistory;
			return read(id, options);
		};
		const slow = await setup({ host, history });
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setImmediate(resolve));
		}
		const removed = slow.reg.deleteLearningData("dev");
		slow.reg.remove("dev");
		release();
		await drain(slow);
		await removed;
		assert.strictEqual(slow.files.files.size, 0, [...slow.files.files.keys()].join());
	});

	it("sends nothing without the message option", async () => {
		const ctx = await setup({ detection: DRYER });
		const run = runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 3, after: 400 });
		await play(ctx, run.values);
		assert.strictEqual(ctx.reg.learningData("dev").changes.at(-1)?.kind, "repair");
		assert.ok(!ctx.host.sent.some(s => JSON.stringify(s.message).includes("detection")));
	});
});

describe("base, effective and active values at runtime", function () {
	this.timeout(120_000);

	it("a base change at runtime with an override drops it and the new values apply at once", async () => {
		const ctx = await registrySetup();
		const store = ctx.reg.learningData("dev");
		store.override = { endCount: 30 };
		ctx.reg.get("dev").setOverride({ endCount: 30 });
		await ctx.reg.upsert("dev", { ...ctx.cfg, detection: { ...WASHER, endVal: 10 } });
		assert.deepStrictEqual([store.override, store.changes.at(-1).kind], [null, "baseChanged"]);
		assert.deepStrictEqual([ctx.reg.get("dev").effective.endVal, ctx.reg.get("dev").effective.endCount], [10, 50]);
		assert.strictEqual(JSON.parse(ctx.host.own("dev.learning.parameters")).override, null);
	});

	it("adopting the values in use as base keeps them and drops the override without loss", async () => {
		const ctx = await registrySetup();
		const store = ctx.reg.learningData("dev");
		store.override = { endCount: 30 };
		ctx.reg.get("dev").setOverride({ endCount: 30 });
		const before = ctx.reg.get("dev").effective;
		await ctx.reg.upsert("dev", { ...ctx.cfg, detection: before });
		assert.deepStrictEqual([store.override, store.changes.at(-1).kind], [null, "adopted"]);
		assert.deepStrictEqual(ctx.reg.get("dev").effective, before);
		assert.strictEqual(ctx.reg.get("dev").currentOverride, null);
		assert.ok(ctx.host.logs.info.some(m => m.includes("adopted as base values")));
	});

	it("at load an adoption that was not saved any more is caught up and other base values drop the override (P29)", async () => {
		for (const adopt of [true, false]) {
			// learning data saved with other base values and an override, e.g. the instance stopped right after
			// the device was saved with the adopted values
			const files = memoryFiles();
			const old = emptyStore("dev", "", typeHash({ ...WASHER, endVal: 7 }), STEP, 1);
			old.override = { endCount: 30 };
			await saveStore(files, old);
			const detection = adopt ? { ...WASHER, endCount: 30 } : { ...WASHER, endVal: 10 };
			const ctx = await registrySetup({ files, detection, notify: true });
			const store = ctx.reg.learningData("dev");
			const what = adopt ? "adopted" : "baseChanged";
			assert.deepStrictEqual([store.override, store.changes.at(-1).kind], [null, what]);
			assert.strictEqual(ctx.reg.get("dev").currentOverride, null);
			const logged = adopt
				? "values in use adopted as base values"
				: "detection values changed, optimised values discarded";
			assert.strictEqual(ctx.host.logs.info.filter(m => m.includes(logged)).length, 1, what);
			const sent = ctx.host.sent.some(s => JSON.stringify(s.message).includes("Erkennungswerte geändert"));
			assert.strictEqual(sent, !adopt, `${what}: message to the recipients`);
		}
	});

	it("undo does not reach back over a base change or an adoption", async () => {
		for (const adopt of [true, false]) {
			const ctx = await registrySetup();
			const store = ctx.reg.learningData("dev");
			store.changes.push({
				ts: ctx.host.now(),
				kind: "repair",
				from: { endCount: 40 },
				to: { endCount: 30 },
				reason: "test",
				runs: 1,
				gainSec: 0,
			});
			store.override = { endCount: 30 };
			ctx.reg.get("dev").setOverride({ endCount: 30 });
			const detection = adopt ? ctx.reg.get("dev").effective : { ...WASHER, endVal: 10 };
			await ctx.reg.upsert("dev", { ...ctx.cfg, detection });
			const what = adopt ? "adopted" : "baseChanged";
			assert.strictEqual(store.changes.at(-1).kind, what);
			assert.strictEqual(await ctx.reg.undoOptimization("dev"), false, what);
			assert.deepStrictEqual([store.override, ctx.reg.get("dev").currentOverride], [null, null], what);
			assert.strictEqual(store.changes.at(-1).kind, what);
		}
	});

	it("an optimisation result is discarded when the base changed meanwhile (G13)", async () => {
		let changed = false;
		const ctx = await registrySetup({
			detection: { ...WASHER, endCount: 20 },
			// between the result of optimize() and the write: the user changes the base values
			beforeOptimizeWrite: async () => {
				if (changed) {
					return;
				}
				changed = true;
				await ctx.reg.upsert("dev", { ...ctx.cfg, detection: { ...WASHER, endCount: 25 } });
			},
		});
		await feed(ctx, runOf({ device: "washer", programme: "eco4060", seed: 2 }).values);
		assert.ok(changed, "an optimisation ran");
		assert.ok(
			ctx.host.logs.info.some(m => m.includes("base values changed during the optimisation, result discarded")),
		);
		assert.strictEqual(ctx.reg.learningData("dev").override, null);
		assert.strictEqual(ctx.reg.get("dev").effective.endCount, 25);
	});

	it("learning.parameters holds base, override, effective, active", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, finalMinVal: 150, finalMinSec: 168 } });
		ctx.reg.get("dev").setFinalSuspended(true);
		await ctx.reg.upsert("dev", ctx.cfg);
		const p = JSON.parse(ctx.host.own("dev.learning.parameters"));
		assert.deepStrictEqual(Object.keys(p), ["base", "override", "effective", "active"]);
		assert.deepStrictEqual([p.base.finalMinVal, p.effective.finalMinVal, p.active.finalMinVal], [150, 150, 0]);
	});

	it("DeviceSync keeps settlingUntil of a final phase that only the stored optimised values switch on", async () => {
		const files = memoryFiles();
		const stored = emptyStore("dev", "", typeHash(WASHER), STEP, 1);
		stored.override = { ...WM_FINAL };
		await saveStore(files, stored);
		const host = createFakeHost({ objects: { [P]: "number" } });
		const inst = instanceConfig();
		const reg = new DeviceRegistry(host, new Notifier(host, () => inst.recipients), () => inst, files);
		const made = [];
		const deleted = [];
		const writer = {
			extendObject: async id => made.push(id),
			setObjectNotExists: async () => {},
			delObject: async id => deleted.push(id),
		};
		const sync = new DeviceSync(reg, writer, () => inst, host.log);
		await sync.apply("dev", deviceConfig({ autoOptimize: true }));
		assert.ok(made.includes("dev.settlingUntil"), "created with the stored override");
		assert.ok(!deleted.includes("dev.settlingUntil"));
		made.length = 0;
		const plain = new DeviceSync(
			new DeviceRegistry(host, new Notifier(host, () => inst.recipients), () => inst, files),
			writer,
			() => inst,
			host.log,
		);
		await plain.apply("dev", deviceConfig());
		assert.ok(
			deleted.includes("dev.settlingUntil"),
			"without the automatic optimisation the override does not count",
		);
	});

	it("an unusable configuration ends the lock phase: settlingUntil 0, the device stops", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: { ...WASHER, ...WM_FINAL } });
		await play(ctx, syntheticRun().values.slice(0, syntheticRun().coreEnd + 14));
		assert.ok(ctx.host.own("dev.settlingUntil") > ctx.host.now());
		const writer = { extendObject: async () => {}, setObjectNotExists: async () => {}, delObject: async () => {} };
		const sync = new DeviceSync(ctx.reg, writer, () => ctx.inst, ctx.host.log);
		await sync.apply("dev", null);
		assert.strictEqual(ctx.host.own("dev.settlingUntil"), 0);
		assert.strictEqual(ctx.reg.get("dev"), undefined);
	});
});

const W = loadSeries("washer30d");
const FIN = { ...WASHER, ...WM_FINAL };

/**
 * Fixture values of the washer from 30 min before run 0 up to `toMs` (exclusive unless `inclusive`), shifted to
 * the clock of the registry.
 *
 * @param {object} ctx registry context
 * @param {number} toMs end (fixture time)
 * @param {boolean} [inclusive] the end belongs to the window
 * @returns {{ ts: number, val: number }[]} points
 */
function washerWindow(ctx, toMs, inclusive = false) {
	const { L, s } = layoutOf(W);
	const from = s.t0 + (L.runs[0].from - 180) * s.stepMs;
	const shift = ctx.host.now() - from;
	return W.filter(p => p.ts >= from && (inclusive ? p.ts <= toMs : p.ts < toMs)).map(p => ({
		ts: p.ts + shift,
		val: p.val,
	}));
}

/**
 * Fixture time 30 min before run 1 (the window of run 0 with its trailer).
 *
 * @returns {number} time in ms
 */
function beforeRun1() {
	const { L, s } = layoutOf(W);
	return s.t0 + (L.runs[1].from - 180) * s.stepMs;
}

describe("judging afterwards (Spec A.3)", function () {
	this.timeout(600_000);
	for (const autoOptimize of [false, true]) {
		it(`Y 30 s: the first split rest suspends the final phase (auto-optimisation ${autoOptimize ? "on" : "off"})`, async () => {
			const ctx = await registrySetup({ autoOptimize, detection: { ...FIN, finalMinSec: 30 } });
			await feedPoints(ctx, washerWindow(ctx, beforeRun1()));
			const st = ctx.reg.learningData("dev");
			assert.deepStrictEqual(
				[st.final.state, st.final.splits.length, st.final.reason],
				["suspended", 1, "finalSplit"],
			);
			assert.strictEqual(ctx.reg.get("dev").active.finalMinVal, 0);
			assert.strictEqual(ctx.reg.get("dev").effective.finalMinVal, 150);
			assert.ok(ctx.host.logs.warn.some(m => m.includes("final phase suspended (finalSplit)")));
			assert.deepStrictEqual(
				ctx.host.sent.filter(x => x.instance === "telegram.0"),
				[],
				"no message without optimizeNotify (G14)",
			);
			assert.strictEqual(JSON.parse(ctx.host.own("dev.learning.optimizeInfo")).finalState, "suspended");
			assert.ok(st.changes.some(c => c.kind === "finalSuspend" && c.trigger === st.final.splits[0]));
		});
	}
	it("with optimizeNotify the suspension is sent once", async () => {
		const ctx = await registrySetup({ autoOptimize: false, notify: true, detection: { ...FIN, finalMinSec: 30 } });
		await feedPoints(ctx, washerWindow(ctx, beforeRun1()));
		assert.strictEqual(ctx.host.sent.filter(x => x.instance === "telegram.0").length, 1);
	});
	it("a real restart after unloading does not suspend", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: FIN });
		const sc = restartScenarios().find(x => x.key === "warm/0/5.5/10/18");
		await feed(ctx, [...sc.values, ...new Array(400).fill(0.5)]);
		assert.notStrictEqual(ctx.reg.learningData("dev").final?.state, "suspended");
	});
	it("'was a new run' resumes only when no other split is left (also without auto-optimisation)", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: { ...FIN, finalMinSec: 30 } });
		await feedPoints(ctx, washerWindow(ctx, beforeRun1()));
		const st = ctx.reg.learningData("dev");
		const first = st.final.splits[0];
		st.final.splits.push("dev@1");
		assert.strictEqual(await ctx.reg.resumeFinal("dev", "newRun", first), false, "another split is left");
		assert.deepStrictEqual(st.final.splits, ["dev@1"]);
		assert.strictEqual(await ctx.reg.resumeFinal("dev", "newRun", "dev@1"), true);
		assert.deepStrictEqual(
			[st.final.state, ctx.reg.get("dev").active.finalMinVal, st.changes.at(-1).kind],
			["on", 150, "finalResume"],
		);
	});
	it("two real runs 15 min apart in one capture → two stored runs, no change (review/cap.mjs)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, trailerBurstSec: 0 } });
		const a = runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: 1, after: 90 }).values;
		const b = runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: 2, after: 400 }).values;
		await feed(ctx, [...a, ...b]);
		const st = ctx.reg.learningData("dev");
		assert.strictEqual(st.runs.length, 2);
		assert.ok(
			st.runs.every(r => r.label === "run"),
			JSON.stringify(st.runs.map(r => r.label)),
		);
		assert.ok(!st.changes.some(c => c.kind === "repair"));
		assert.strictEqual(st.override, null);
	});
	it("a pause inside the programme with a reported end stays one split run (repair trigger)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, pauseRun(4, 25));
		const st = ctx.reg.learningData("dev");
		assert.deepStrictEqual(
			st.runs.map(r => r.label),
			["split"],
		);
	});
	it("final phase without auto-optimisation: a split run changes no override and repairs nothing", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: { ...FIN, endCount: 20 } });
		const st0 = ctx.reg.learningData("dev");
		st0.override = { endCount: 200 };
		await ctx.reg.upsert("dev", ctx.cfg);
		assert.strictEqual(
			ctx.reg.get("dev").currentOverride,
			null,
			"the override is never applied without auto-optimisation",
		);
		await feed(ctx, pauseRun(4, 25));
		const st = ctx.reg.learningData("dev");
		assert.ok(st.runs.length > 0, "the run is stored");
		assert.ok(!st.changes.some(c => c.kind === "repair" || c.kind === "tighten"));
		assert.deepStrictEqual(st.override, { endCount: 200 }, "kept untouched in the store");
	});
	for (const key of ["warm/0/5.5/10/18", "warm/0/5.5/5/3", "cold/0/5.5/20/36"]) {
		it(`set up by hand (no comparison runs): restart after unloading ${key} does not suspend`, async () => {
			const ctx = await registrySetup({ autoOptimize: false, detection: FIN });
			const sc = restartScenarios().find(x => x.key === key);
			await feed(ctx, [...sc.values, ...new Array(400).fill(0.5)]);
			assert.notStrictEqual(ctx.reg.learningData("dev").final?.state, "suspended", key);
		});
	}
	it("the split is judged at the end of the afterFinal run, not when the capture closes", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: { ...FIN, finalMinSec: 30 } });
		// up to the poll of the second end: the early end, then the end of the rest of the split programme
		await feedPoints(
			ctx,
			washerWindow(ctx, beforeRun1()),
			10_000,
			c => c.host.ownHistory("dev.lastFinished").length >= 2,
		);
		const snap = ctx.reg.get("dev").runRecorder.snapshot();
		assert.ok(snap, "the capture is still open");
		assert.deepStrictEqual(
			snap.ev.map(e => e[1]),
			["s", "f", "s", "f"],
		);
		assert.strictEqual(ctx.reg.learningData("dev").final?.state, "suspended");
	});
	it("a final phase without auto-optimisation reads the history once for comparison runs, applies no override", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const points = historyOf(
			[washingMachine, washingMachine, washingMachine, washingMachine],
			host.now() - 2 * DAY,
		);
		const history = historyEnv(points);
		const ctx = await registrySetup({ host, history, autoOptimize: false, detection: FIN });
		await drain(ctx);
		const st = ctx.reg.learningData("dev");
		assert.ok(history.queries > 0, "the history was read");
		assert.ok(st.runs.length >= 3, `runs taken over: ${st.runs.length}`);
		assert.strictEqual(ctx.reg.get("dev").currentOverride, null);
		assert.strictEqual(st.override, null, "nothing optimised");
		assert.strictEqual(JSON.parse(ctx.host.own("dev.learning.optimizeInfo")).finalState, "on");
	});
	it("pushChange keeps the entries of runs still stored and the last base change", () => {
		const st = emptyStore("dev", "", "x", 10_000, 1);
		st.runs.push({ key: "dev@100", ts: 0, seg: { startIdx: 0 } });
		const c = (kind, extra = {}) => ({
			ts: 0,
			kind,
			from: null,
			to: null,
			reason: "",
			runs: 0,
			gainSec: 0,
			...extra,
		});
		pushChange(st, c("baseChanged"));
		pushChange(st, c("finalSuspend", { trigger: "dev@101" }));
		pushChange(st, c("finalSuspend", { trigger: "dev@900" }));
		for (let k = 0; k < 12; k++) {
			pushChange(st, c("tighten", { gainSec: k }));
		}
		assert.strictEqual(st.changes.length, MAX_CHANGES);
		assert.strictEqual(st.changes[0].kind, "baseChanged");
		assert.strictEqual(st.changes[1].trigger, "dev@101", "its run (within 5 min) is still stored");
		assert.ok(!st.changes.some(x => x.trigger === "dev@900"), "its run is gone");
		assert.strictEqual(st.changes.at(-1).gainSec, 11);
	});
});

describe("texts of the automatic optimisation", () => {
	it("fill replaces the placeholders and falls back to English", () => {
		assert.strictEqual(
			fill(TEXT.optCannotCover, "de", { device: "WM" }),
			"WM: Keine Einstellung erkennt alle gespeicherten Läufe richtig; Werte unverändert.",
		);
		assert.ok(fill(TEXT.optCannotCover, "xx", { device: "WM" }).startsWith("WM: no setting"));
		assert.strictEqual(
			fill(TEXT.optBaseChanged, "en"),
			"{device}: detection values changed, optimised values discarded.",
		);
		for (const key of ["optChanged", "optRepaired", "optCannotCover", "optDrift", "antiCreaseNotSeparable"]) {
			for (const [lang, text] of Object.entries(TEXT[key])) {
				assert.ok(text.includes("{device}"), `${key}.${lang}`);
			}
		}
	});

	it("formatDate is local and sortable", () => {
		assert.strictEqual(formatDate(new Date(2026, 0, 5, 7, 3).getTime()), "2026-01-05 07:03");
	});
});
