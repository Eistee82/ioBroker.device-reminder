import assert from "node:assert";
import { formatDate } from "../build/lib/deviceRegistry.js";
import { DeviceSync } from "../build/lib/deviceSync.js";
import { fill, TEXT } from "../build/lib/dmTexts.js";
import { emptyStore, saveStore, typeHash } from "../build/lib/runStore.js";
import { createFakeHost } from "./helpers/fakeHost.js";
import { memoryFiles } from "./helpers/files.js";
import { washingMachine } from "./helpers/curves.js";
import { drain, DRYER, feed, P, registrySetup, WASHER } from "./helpers/devices.js";
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
