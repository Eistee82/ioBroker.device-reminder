import assert from "node:assert";
import { drain, feed, pauseRun, registrySetup, WASHER } from "./helpers/devices.js";
import { boundaryInfo } from "../build/lib/runStore.js";
import { runOf } from "./helpers/programmes.js";

/**
 * Wait for a user action on the registry; its checks yield to the (fake) timers, which only run in `drain`.
 *
 * @param {object} ctx registry context
 * @param {Promise<unknown>} action the action
 * @returns {Promise<unknown>} its result
 */
async function settled(ctx, action) {
	await drain(ctx);
	return action;
}

describe("outliers in the optimisation (Spec D.4, D.7)", function () {
	this.timeout(120_000);

	it("a clean boundary run repairs at once; excluding and including it again restores envelope and values", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 1 }).values);
		const st = ctx.reg.learningData("dev");
		const env0 = structuredClone(st.envelope);
		const ov0 = structuredClone(st.override);
		await feed(ctx, pauseRun(2, 30));
		assert.strictEqual(st.changes.at(-1).kind, "repair");
		const key = st.runs.at(-1).key;
		const env1 = structuredClone(st.envelope);
		const ov1 = structuredClone(st.override);
		await settled(ctx, ctx.reg.setRunUse("dev", key, "exclude"));
		assert.deepStrictEqual([st.envelope, st.override], [env0, ov0]);
		await settled(ctx, ctx.reg.setRunUse("dev", key, null));
		assert.deepStrictEqual([st.envelope, st.override], [env1, ov1]);
	});

	it("a run in form quarantine (hand test) changes nothing until 'use'", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, [...new Array(6).fill(0.3), ...new Array(18).fill(2000), ...new Array(300).fill(0.3)]);
		const st = ctx.reg.learningData("dev");
		assert.ok(!st.changes.some(c => c.kind === "repair"));
		const key = [...st.runs, ...st.spikes].at(-1).key;
		await settled(ctx, ctx.reg.setRunUse("dev", key, "include"));
		assert.strictEqual(ctx.reg.learningData("dev").verdicts[key].user, "include");
	});

	it("excluding a boundary run that triggered a repair reverts the repair and lifts the lock (P25)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 1 }).values);
		await feed(ctx, pauseRun(2, 30));
		const st = ctx.reg.learningData("dev");
		const before = st.changes.at(-1).from;
		const r = await settled(ctx, ctx.reg.setRunUse("dev", st.runs.at(-1).key, "exclude"));
		assert.strictEqual(r.reverted, true);
		assert.deepStrictEqual(
			[st.override, st.changes.at(-1).kind, st.lockRuns, st.lockUntilTs],
			[before, "revert", 0, 0],
		);
	});

	it("undo offers to exclude the triggering run; undo only back to the last base change and only if the gate passes", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, pauseRun(2, 30));
		const st = ctx.reg.learningData("dev");
		const r = await settled(ctx, ctx.reg.undoOptimization("dev"));
		assert.deepStrictEqual([r.ok, r.offerExclude], [false, st.runs.at(-1).key]);
		assert.ok(r.failing.includes(st.runs.at(-1).key));
		const r2 = await settled(ctx, ctx.reg.undoOptimization("dev", true));
		assert.strictEqual(r2.ok, true);
		await ctx.reg.upsert("dev", { ...ctx.cfg, detection: { ...WASHER, endCount: 40 } });
		assert.strictEqual(
			(await settled(ctx, ctx.reg.undoOptimization("dev"))).ok,
			false,
			"nothing before the base change",
		);
	});

	it("a boundary run shows the limit it sets alone and the value without it", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 1 }).values);
		await feed(ctx, pauseRun(2, 30));
		const st = ctx.reg.learningData("dev");
		const key = st.runs.at(-1).key;
		const info = boundaryInfo(st, ctx.reg.verdictsOf("dev")).get(key);
		assert.ok(info, "the run that caused the repair is a boundary run");
		assert.strictEqual(info.veto, true);
		const pause = info.limits.find(l => l.quantity === "maxPauseSec");
		assert.ok(pause && pause.without < pause.value, "its pause is longer than every other");
		await settled(ctx, ctx.reg.setRunUse("dev", key, "exclude"));
		assert.strictEqual(boundaryInfo(st, ctx.reg.verdictsOf("dev")).has(key), false, "excluded: no limit");
	});

	it("the decision is kept without automatic optimisation", async () => {
		const ctx = await registrySetup({ autoOptimize: false });
		assert.strictEqual(ctx.reg.learningData("dev"), null);
		const r = await settled(ctx, ctx.reg.setRunUse("dev", "dev@1", "exclude"));
		assert.deepStrictEqual(r, { reverted: false });
		assert.strictEqual((await ctx.reg.readLearningData("dev"))?.verdicts["dev@1"]?.user, "exclude");
	});

	it("undo without a change says there is nothing to undo", async () => {
		const ctx = await registrySetup();
		assert.deepStrictEqual(await settled(ctx, ctx.reg.undoOptimization("dev")), {
			ok: false,
			failing: [],
			offerExclude: null,
		});
		assert.deepStrictEqual(await settled(ctx, ctx.reg.undoOptimization("nope")), {
			ok: false,
			failing: [],
			offerExclude: null,
		});
	});
});
