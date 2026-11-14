import assert from "node:assert";
import { readFileSync } from "node:fs";
import { checkSet, replayPick, targetSet, TIGHTEN_MIN_RUNS } from "../build/lib/learn/autoOptimize.js";
import { DeviceSync } from "../build/lib/deviceSync.js";
import { fill, TEXT } from "../build/lib/dmTexts.js";
import {
	boundaryRuns,
	emptyStore,
	MAX_CHANGES,
	pushChange,
	saveStore,
	setDecision,
	typeHash,
	upgradeStore,
} from "../build/lib/runStore.js";
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
	historyEnv,
	instanceConfig,
	P,
	pauseRun,
	registrySetup,
	WASHER,
	windowsFeed,
} from "./helpers/devices.js";
import { syntheticRun, WM_FINAL } from "./helpers/final.js";
import { layoutOf, loadSeries, restartScenarios, sparse } from "./helpers/fixtures.js";
import { historyOf, runStarts } from "./helpers/history.js";
import { runOf } from "./helpers/programmes.js";

const STEP = 10_000;
const DAY = 86_400_000;

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
	it("switching the final phase off and on keeps the stored suspension; cleared meanwhile, it is used again", async () => {
		const detection = { ...FIN, finalMinSec: 30 };
		const ctx = await registrySetup({ autoOptimize: false, detection });
		await feedPoints(ctx, washerWindow(ctx, beforeRun1()));
		assert.strictEqual(ctx.reg.learningData("dev").final.state, "suspended");
		await ctx.reg.upsert("dev", { ...ctx.cfg, detection: WASHER });
		assert.strictEqual(ctx.reg.learningData("dev"), null, "no learning data without final phase");
		await ctx.reg.upsert("dev", { ...ctx.cfg, detection });
		assert.strictEqual(ctx.reg.learningData("dev").final.state, "suspended", "only the user resumes it");
		assert.strictEqual(ctx.reg.get("dev").active.finalMinVal, 0);
		await ctx.reg.upsert("dev", { ...ctx.cfg, detection: WASHER });
		await ctx.reg.deleteLearningData("dev");
		await ctx.reg.upsert("dev", { ...ctx.cfg, detection });
		assert.notStrictEqual(ctx.reg.learningData("dev").final?.state, "suspended");
		assert.strictEqual(ctx.reg.get("dev").active.finalMinVal, 150, "no mask left from before");
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

const waitSec = d => (d.mode === "timed" ? d.endDurationSec : d.endCount * 10);
const nextDay = ctx => ctx.host.tickClock(25 * 3_600_000);

describe("optimisation over 30 days (Spec D.1–D.4)", function () {
	this.timeout(600_000);
	it("minimum runs: collecting with 7 admitted runs, tightening possible from the 8th (Spec D.3 point 4)", async () => {
		assert.strictEqual(TIGHTEN_MIN_RUNS, 8);
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 120 } });
		for (let k = 1; k <= 7; k++) {
			await feed(ctx, runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: k }).values);
			nextDay(ctx);
		}
		const st = ctx.reg.learningData("dev");
		assert.strictEqual(st.info.status, "collecting");
		assert.ok(!st.changes.some(c => c.kind === "tighten"));
		await feed(ctx, runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: 8 }).values);
		assert.notStrictEqual(ctx.reg.learningData("dev").info.status, "collecting");
	});
	it("repair first: a pause one poll longer than the end wait raises the wait right after the run, despite lock and minimum count (decision 8)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		for (let k = 1; k <= 3; k++) {
			await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: k }).values);
			nextDay(ctx);
		}
		const st = ctx.reg.learningData("dev");
		st.lockRuns = 5;
		st.lockUntilTs = ctx.host.now() + 10 * DAY;
		await feed(ctx, pauseRun(4, 21));
		assert.strictEqual(st.changes.at(-1).kind, "repair");
		assert.ok(waitSec(ctx.reg.get("dev").effective) > 210, JSON.stringify(ctx.reg.get("dev").effective));
		assert.strictEqual((await ctx.reg.checkStoredRuns("dev")).ok, true, "every stored run is detected again");
		const trigger = st.changes.at(-1).trigger;
		assert.ok(
			st.runs.some(r => r.key === trigger && r.veto !== undefined),
			"the run that triggered it is a boundary run",
		);
		assert.ok(boundaryRuns(st).has(trigger));
	});
	it("repair ignores the step limit: a pause of twice the wait at least doubles it", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, pauseRun(4, 40));
		assert.ok(waitSec(ctx.reg.get("dev").effective) > 400);
		assert.strictEqual((await ctx.reg.checkStoredRuns("dev")).ok, true);
	});
	for (const [name, detection, values] of [
		// missed start: the recorder opens a capture on activity without a start (Task 9)
		[
			"missed start",
			{ ...WASHER, startVal: 3000 },
			runOf({ device: "washer", programme: "cotton60", seed: 5 }).values,
		],
		["split run", { ...WASHER, endCount: 20 }, pauseRun(5, 25)],
		// phantom start: a single spike AFTER the reported end (at +31 ticks it is still inside the run)
		[
			"phantom start",
			{ ...WASHER, startCount: 1, startVal: 30 },
			[
				...runOf({ device: "washer", programme: "cotton60", seed: 5, after: 360 }).values,
				400,
				0.8,
				...new Array(400).fill(0.8),
			],
		],
	]) {
		it(`repair first: ${name} triggers an immediate repair`, async () => {
			const ctx = await registrySetup({ detection });
			await feed(ctx, values);
			if (name === "phantom start") {
				// a single short activity is a manual test (form quarantine, Spec B.2 `test` (1)): the false start
				// counts from the second one (Spec B.2 `spike`), then the repair follows at once
				assert.ok(!ctx.reg.learningData("dev").changes.some(c => c.kind === "repair"));
				nextDay(ctx);
				await feed(ctx, values);
			}
			assert.ok(
				ctx.reg.learningData("dev").changes.some(c => c.kind === "repair"),
				`${name}: ${JSON.stringify(ctx.reg.learningData("dev").info)}`,
			);
			assert.strictEqual((await ctx.reg.checkStoredRuns("dev")).ok, true, name);
		});
	}
	it("merged runs trigger no repair and the end of the combined run is detected (decision 9)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 100 } });
		const a = runOf({ device: "washer", programme: "quick30", seed: 5, after: 60 }).values;
		const b = runOf({ device: "washer", programme: "quick30", seed: 6 }).values;
		const warnBefore = ctx.host.logs.warn.length;
		await feed(ctx, [...a, ...b, ...new Array(400).fill(0.5)]);
		const st = ctx.reg.learningData("dev");
		assert.strictEqual(
			ctx.host.ownWrites.filter(w => w.id === "dev.finished" && w.val === true).length,
			1,
			"one end for both runs",
		);
		assert.ok(!st.changes.some(c => c.kind === "repair"), "merging is no detection error");
		assert.strictEqual(st.override, null, "the end wait is not shortened because of it");
		assert.deepStrictEqual(st.info.review ?? [], [], "no hint");
		assert.strictEqual(ctx.host.logs.warn.length, warnBefore, "no warning");
		const g = await ctx.reg.checkStoredRuns("dev");
		assert.strictEqual(g.ok, true, "the end of the combined run is detected (endOk of the whole run)");
	});
	it("an end that is never reported is repaired at once (end not detected)", async () => {
		// idle at 0.5 W stays above endVal 0.3: with the current values the run never ends
		const ctx = await registrySetup({ detection: { ...WASHER, endVal: 0.3, standby: 0.2 } });
		await feed(ctx, [
			...runOf({ device: "washer", programme: "cotton60", seed: 3 }).values,
			// the capture closes at the latest after 12 h (CAPTURE_MAX_MS)
			...new Array(4400).fill(0.5),
		]);
		const st = ctx.reg.learningData("dev");
		assert.ok(
			st.changes.some(c => c.kind === "repair") || st.info.status === "cannotCover",
			JSON.stringify(st.info),
		);
	});
	it("w02 as a live capture: an end 10 s before the core end needs no repair (store.tail, endOk)", async () => {
		const ctx = await registrySetup({ detection: WASHER });
		await windowsFeed(ctx, ["w01", "w03", "w05", "w02"]);
		const st = ctx.reg.learningData("dev");
		assert.ok(st.tail.separated);
		assert.ok(!st.changes.some(c => c.kind === "repair"), JSON.stringify(st.changes));
	});
	it("drift does not stop a repair (decision 8)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 1 }).values);
		ctx.reg.learningData("dev").info.status = "drift";
		await feed(ctx, pauseRun(2, 25));
		assert.strictEqual(ctx.reg.learningData("dev").changes.at(-1).kind, "repair");
	});
	it("the replay pick holds at most 60 runs: the newest of each group plus every boundary run", () => {
		const st = JSON.parse(readFileSync(new URL("./fixtures/v4store.json", import.meta.url), "utf8"));
		upgradeStore(st);
		while (st.runs.length < 120) {
			st.runs.push({
				...structuredClone(st.runs[st.runs.length % 10]),
				key: `k${st.runs.length}`,
				ts: st.runs.at(-1).ts + 3_600_000,
			});
		}
		const pick = replayPick(st, st.runs.at(-1).ts);
		assert.ok(pick.length <= 60);
		for (const k of boundaryRuns(st)) {
			assert.ok(
				pick.some(r => r.key === k),
				k,
			);
		}
		assert.ok(pick.includes(st.runs.at(-1)), "the newest run of its group");
	});
	it("an old V4 store without lastSeenTs is no 30-day outage; imported runs are not doubled", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const points = historyOf([washingMachine, washingMachine], host.now() - 2 * DAY);
		const ctx = await registrySetup({ host, history: historyEnv(points) });
		await drain(ctx);
		const st = ctx.reg.learningData("dev");
		const n = st.runs.length;
		assert.ok(n >= 2);
		delete st.lastSeenTs;
		await saveStore(ctx.files, st);
		ctx.reg.disposeAll();
		host.tickClock(2 * 3_600_000);
		const queries = [];
		const h = historyEnv(points);
		const getHistory = h.getHistory.bind(h);
		h.getHistory = async (id, o) => {
			queries.push(o);
			return getHistory(id, o);
		};
		const again = await registrySetup({ host, files: ctx.files, history: h });
		await drain(again);
		assert.strictEqual(again.reg.learningData("dev").runs.length, n, "no run imported twice");
		// only the time since the store was last in use is read, not 30 days
		assert.ok(
			queries.every(q => q.start >= host.now() - 3 * 3_600_000),
			JSON.stringify(queries.map(q => q.start)),
		);
	});
	it("a full read of the same history doubles nothing: the runs are recognised by their keys", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const points = historyOf([washingMachine, washingMachine], host.now() - 2 * DAY);
		const ctx = await registrySetup({ host, history: historyEnv(points) });
		await drain(ctx);
		const st = ctx.reg.learningData("dev");
		const n = st.runs.length;
		// the store was last in use before the runs (outage over the whole history)
		await saveStore(ctx.files, { ...st, lastSeenTs: host.now() - 3 * DAY });
		ctx.reg.disposeAll();
		const again = await registrySetup({ host, files: ctx.files, history: historyEnv(points) });
		await drain(again);
		assert.strictEqual(again.reg.learningData("dev").runs.length, n);
	});
	it("the same miss on a quarantined history run (sparse) triggers no repair and no 'use' hint (P22)", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		// one history: three normal runs, then the run with the pause stored only every 12th value (in a history of
		// its own the run would touch the data end and be incomplete)
		const runs = [washingMachine, washingMachine, washingMachine, pauseRun(9, 21)];
		const all = historyOf(runs, host.now() - 5 * DAY);
		const from = runStarts(runs, host.now() - 5 * DAY)[3];
		const to = from + runs[3].length * STEP;
		const broken = all.filter(p => p.ts < from || p.ts > to);
		broken.push(
			...sparse(
				all.filter(p => p.ts >= from && p.ts <= to),
				12,
			),
		);
		broken.sort((a, b) => a.ts - b.ts);
		const ctx = await registrySetup({
			host,
			history: historyEnv(broken),
			detection: { ...WASHER, endCount: 20 },
		});
		await drain(ctx);
		const st = ctx.reg.learningData("dev");
		assert.ok(!st.changes.some(c => c.kind === "repair"), JSON.stringify(st.changes));
		assert.deepStrictEqual(st.info.review ?? [], []);
		assert.ok(
			ctx.host.logs.warn.some(m => m.includes("recording disturbed, run not used")),
			ctx.host.logs.warn.join(" | "),
		);
	});
	it("no candidate covers every admitted run → values unchanged, cannotCover, warning", async () => {
		// the same recording stored as a run and twice as a false start: no values can start on it and not start on it
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, runOf({ device: "washer", programme: "quick30", seed: 2 }).values);
		const st = ctx.reg.learningData("dev");
		const run = st.runs[0];
		for (const k of [1, 2]) {
			st.spikes.push({ ...structuredClone(run), id: `x${k}`, key: `dev@${k}`, label: "spike" });
		}
		const before = structuredClone(st.override);
		nextDay(ctx);
		await feed(ctx, runOf({ device: "washer", programme: "quick30", seed: 3 }).values);
		assert.strictEqual(st.info.status, "cannotCover", JSON.stringify(st.info));
		assert.deepStrictEqual(st.override, before);
		assert.ok(ctx.host.logs.warn.some(m => m.includes("no values detect every admitted run")));
	});
	it("an old boundary run beyond 30 days stays in the check set and keeps its floor; target set is 30 days", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, pauseRun(1, 60));
		const st = ctx.reg.learningData("dev");
		const old = st.runs[0];
		ctx.host.tickClock(40 * DAY);
		for (let k = 2; k <= 10; k++) {
			await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: k }).values);
			nextDay(ctx);
		}
		const now = ctx.host.now();
		assert.ok(st.runs.includes(old), "a boundary run is not evicted");
		assert.ok(!targetSet(st, now).includes(old) && checkSet(st, now).includes(old));
		assert.ok(waitSec(ctx.reg.get("dev").effective) > 600, "no tightening below the old pause");
	});
	it("hint exactly once; as a message only with optimizeNotify (G14)", async () => {
		for (const notify of [false, true]) {
			const host = createFakeHost({ objects: { [P]: "number" } });
			// a manual test with a pause: one band only (form quarantine `test`), and the pause ends it too early; the
			// load varies a little, so every value is stored (a constant one would be a sparse recording)
			const load = Array.from({ length: 18 }, (_, i) => 2000 + (i % 2) * 10);
			const test = historyOf([[...load, ...new Array(60).fill(0.5), ...load]], host.now() - DAY);
			const ctx = await registrySetup({
				host,
				notify,
				history: historyEnv([
					...historyOf([washingMachine, washingMachine, washingMachine], host.now() - 5 * DAY),
					...test,
				]),
			});
			await drain(ctx);
			await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 3 }).values);
			const st = ctx.reg.learningData("dev");
			assert.strictEqual(
				(st.info.review ?? []).length,
				1,
				`the hand test was mis-detected and is in form quarantine: ${JSON.stringify(st.info)}`,
			);
			const sent = ctx.host.sent.filter(
				x => x.instance === "telegram.0" && JSON.stringify(x.message).includes("verwenden"),
			);
			assert.strictEqual(sent.length, notify ? 1 : 0);
			assert.strictEqual(ctx.host.logs.warn.filter(m => m.includes("was not detected correctly")).length, 1);
		}
	});
	it("decisions survive clear → restart → bootstrap from history (P26)", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const points = historyOf(
			[washingMachine, washingMachine, washingMachine, washingMachine],
			host.now() - 3 * DAY,
		);
		const ctx = await registrySetup({ host, history: historyEnv(points) });
		await drain(ctx);
		const st = ctx.reg.learningData("dev");
		const key = st.runs[1].key;
		setDecision(st, key, "exclude");
		await ctx.reg.deleteLearningData("dev");
		ctx.reg.disposeAll();
		const again = await registrySetup({ host, files: ctx.files, history: historyEnv(points) });
		await drain(again);
		const st2 = again.reg.learningData("dev");
		assert.ok(st2.runs.length >= 3, "read again from the history");
		assert.strictEqual(st2.verdicts[key].user, "exclude");
		assert.ok(!targetSet(st2, host.now()).some(r => r.key === key));
	});
	it("history is read after an outage > 1 h, only for the outage", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const ctx = await registrySetup({
			host,
			history: historyEnv(historyOf([washingMachine, washingMachine], host.now() - 3 * DAY)),
		});
		await drain(ctx);
		const lastSeen = host.now();
		await saveStore(ctx.files, { ...ctx.reg.learningData("dev"), lastSeenTs: lastSeen });
		ctx.reg.disposeAll();
		host.tickClock(2 * 3_600_000);
		const h = historyEnv(historyOf([washingMachine], host.now() - 3_000_000));
		const queries = [];
		const getHistory = h.getHistory.bind(h);
		h.getHistory = async (id, o) => {
			queries.push(o);
			return getHistory(id, o);
		};
		const again = await registrySetup({ host, files: ctx.files, history: h });
		await drain(again);
		assert.ok(
			queries.length > 0 && queries.every(q => q.start >= lastSeen - 1),
			JSON.stringify(queries.map(q => q.start - lastSeen)),
		);
	});
});
