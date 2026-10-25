import assert from "node:assert";
import { DEFAULT_REMINDER, normalizeInstanceConfig } from "../build/lib/config.js";
import { DeviceRegistry } from "../build/lib/deviceRegistry.js";
import { Notifier } from "../build/lib/notifier.js";
import { createFakeHost } from "./helpers/fakeHost.js";

const P1 = "plug.0.power";
const P2 = "plug.1.power";
const SW = "plug.0.switch";
const ACK = "0_userdata.0.ack";
const ACTION = "0_userdata.0.lamp";

const testType = {
	id: "test",
	name: "Test",
	builtin: false,
	startVal: 30,
	endVal: 5,
	startCount: 1,
	endCount: 1,
	standby: 1,
	mode: "count",
	startDurationSec: 60,
	endDurationSec: 300,
};

function makeInst() {
	return normalizeInstanceConfig({
		types: [testType, { ...testType, id: "other", name: "Other" }],
		recipients: [{ id: "tg", name: "Telegram", enabled: true, kind: "telegram", instance: "telegram.0" }],
		pollIntervalSec: 10,
	}).config;
}

function makeCfg(over = {}) {
	return {
		enabled: true,
		name: "Washer",
		typeId: "test",
		powerId: P1,
		startText: "Started",
		endText: "Finished",
		abort: false,
		abortFixed: false,
		autoOff: false,
		autoOffMinutes: 0,
		recipients: ["tg"],
		reminder: { ...DEFAULT_REMINDER },
		actions: [],
		...over,
	};
}

function setup() {
	const host = createFakeHost({ objects: { [P1]: "number", [P2]: "number", [ACTION]: "boolean", [SW]: "boolean" } });
	const inst = makeInst();
	const notifier = new Notifier(host, () => inst.recipients);
	const reg = new DeviceRegistry(host, notifier, () => inst);
	return { host, inst, notifier, reg };
}

async function flush() {
	for (let i = 0; i < 5; i++) {
		await new Promise(resolve => setImmediate(resolve));
	}
}

/**
 * Feed a power value and run poll steps.
 *
 * @param {ReturnType<typeof setup>} ctx test context
 * @param {string} id power state id
 * @param {number} watt power
 * @param {number} ticks number of poll steps
 */
async function feed(ctx, id, watt, ticks) {
	for (let i = 0; i < ticks; i++) {
		ctx.host.setValue(id, watt);
		await ctx.reg.routeForeignState(id, watt);
		ctx.host.tickClock(10_000);
		await ctx.reg.tickAll();
	}
	await flush();
}

async function runCycle(ctx, id = P1) {
	await feed(ctx, id, 200, 4);
	await feed(ctx, id, 0, 4);
}

describe("DeviceRegistry", () => {
	it("routes power values to the right device", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg());
		await ctx.reg.upsert("dryer", makeCfg({ name: "Dryer", powerId: P2 }));
		assert.deepStrictEqual(ctx.reg.ids().sort(), ["dryer", "washer"]);
		await feed(ctx, P2, 200, 4);
		assert.strictEqual(ctx.reg.get("dryer").isRunning, true);
		assert.strictEqual(ctx.reg.get("washer").isRunning, false);
		assert.strictEqual(ctx.reg.get("dryer").lastPower, 200);
		assert.strictEqual(ctx.reg.get("washer").lastPower, null);
	});

	it("lists foreign ids to subscribe without duplicates", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg({ switchId: SW, reminder: { ...DEFAULT_REMINDER, ackStateId: ACK } }));
		await ctx.reg.upsert("dryer", makeCfg({ name: "Dryer" }));
		assert.deepStrictEqual(ctx.reg.foreignIdsToSubscribe().sort(), [ACK, P1, SW].sort());
	});

	it("keeps the running cycle when only texts change (Review Focus 4)", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg());
		await feed(ctx, P1, 200, 4);
		const before = ctx.reg.get("washer");
		assert.strictEqual(before.isRunning, true);
		const startsBefore = ctx.host.sent.length;
		await ctx.reg.upsert("washer", makeCfg({ startText: "Los", endText: "Fertig" }));
		assert.strictEqual(ctx.reg.get("washer"), before);
		assert.strictEqual(before.isRunning, true);
		await feed(ctx, P1, 200, 3);
		assert.strictEqual(ctx.host.sent.length, startsBefore, "no second start message");
		assert.strictEqual(before.config.endText, "Fertig");
	});

	it("resets the device with an info log when the type changes (Review Focus 4)", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg());
		await feed(ctx, P1, 200, 4);
		const before = ctx.reg.get("washer");
		await ctx.reg.upsert("washer", makeCfg({ typeId: "other" }));
		const after = ctx.reg.get("washer");
		assert.notStrictEqual(after, before);
		assert.strictEqual(after.isRunning, false);
		assert.ok(ctx.host.logs.info.some(m => m.includes("reset")));
	});

	it("ignores a device with an unknown type", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg({ typeId: "nope" }));
		assert.strictEqual(ctx.reg.get("washer"), undefined);
		assert.ok(ctx.host.logs.warn.some(m => m.includes("unknown device type")));
	});

	it("starts the reminder and runs the end actions at the end of a run", async () => {
		const ctx = setup();
		await ctx.reg.upsert(
			"washer",
			makeCfg({
				reminder: { ...DEFAULT_REMINDER, enabled: true, intervalMin: 1 },
				actions: [
					{ event: "start", stateId: ACTION, value: "false" },
					{ event: "end", stateId: ACTION, value: "true" },
				],
			}),
		);
		await runCycle(ctx);
		assert.deepStrictEqual(
			ctx.host.writes.filter(w => w.id === ACTION).map(w => w.val),
			[false, true],
		);
		assert.strictEqual(ctx.host.own("washer.finished"), true);
		const messages = ctx.host.sent.length;
		await ctx.host.advance(60_000);
		await flush();
		assert.strictEqual(ctx.host.sent.length, messages + 1, "reminder sent");
		assert.strictEqual(ctx.host.sent.at(-1).message.text, "Finished");
	});

	it("acknowledge stops the reminder and runs the acknowledged action", async () => {
		const ctx = setup();
		await ctx.reg.upsert(
			"washer",
			makeCfg({
				reminder: { ...DEFAULT_REMINDER, enabled: true, intervalMin: 1, ackStateId: ACK },
				actions: [{ event: "acknowledged", stateId: ACTION, value: "true" }],
			}),
		);
		await runCycle(ctx);
		assert.ok(ctx.host.openTimers() > 0);
		await ctx.reg.routeOwnState("washer.acknowledge", true, false);
		await flush();
		assert.strictEqual(ctx.host.openTimers(), 0);
		assert.strictEqual(ctx.host.own("washer.finished"), false);
		assert.deepStrictEqual(
			ctx.host.writes.filter(w => w.id === ACTION).map(w => w.val),
			[true],
		);
	});

	it("runs the acknowledged actions even when reminders are off, and only once", async () => {
		const ctx = setup();
		await ctx.reg.upsert(
			"washer",
			makeCfg({
				reminder: { ...DEFAULT_REMINDER, enabled: false },
				actions: [
					{ event: "end", stateId: ACTION, value: "true" },
					{ event: "acknowledged", stateId: ACTION, value: "false" },
				],
			}),
		);
		await runCycle(ctx);
		assert.strictEqual(ctx.host.own("washer.finished"), true);
		assert.deepStrictEqual(
			ctx.host.writes.filter(w => w.id === ACTION).map(w => w.val),
			[true],
		);
		await ctx.reg.routeOwnState("washer.acknowledge", true, false);
		await flush();
		assert.strictEqual(ctx.host.own("washer.finished"), false);
		assert.deepStrictEqual(
			ctx.host.writes.filter(w => w.id === ACTION).map(w => w.val),
			[true, false],
		);
		await ctx.reg.routeOwnState("washer.acknowledge", true, false);
		await flush();
		assert.strictEqual(ctx.host.writes.filter(w => w.id === ACTION).length, 2, "repeated press runs nothing");
	});

	it("an external acknowledge state stops the reminder", async () => {
		const ctx = setup();
		await ctx.reg.upsert(
			"washer",
			makeCfg({ reminder: { ...DEFAULT_REMINDER, enabled: true, intervalMin: 1, ackStateId: ACK } }),
		);
		await runCycle(ctx);
		await ctx.reg.routeForeignState(ACK, false);
		assert.ok(ctx.host.openTimers() > 0);
		await ctx.reg.routeForeignState(ACK, true);
		assert.strictEqual(ctx.host.openTimers(), 0);
	});

	it("routes config states and ignores acked buttons", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg());
		await ctx.reg.routeOwnState("washer.config.doNotDisturb", true, false);
		assert.strictEqual(ctx.reg.get("washer").doNotDisturb, true);
		await ctx.reg.routeOwnState("washer.learning.start", true, true);
		assert.strictEqual(ctx.host.own("washer.learning.active"), false);
		await ctx.reg.routeOwnState("unknown.acknowledge", true, false);
		await ctx.reg.routeOwnState("nodot", true, false);
	});

	it("learning start/stop writes learning.active and learning.result", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg());
		await ctx.reg.routeOwnState("washer.learning.start", true, false);
		assert.strictEqual(ctx.host.own("washer.learning.active"), true);
		await feed(ctx, P1, 1, 5);
		await feed(ctx, P1, 200, 30);
		await feed(ctx, P1, 1, 10);
		await ctx.reg.routeOwnState("washer.learning.stop", true, false);
		assert.strictEqual(ctx.host.own("washer.learning.active"), false);
		const result = JSON.parse(ctx.host.own("washer.learning.result"));
		assert.ok(result.thresholds, JSON.stringify(result));
		assert.strictEqual(result.samples, 45);
	});

	it("learning stop with too few samples stores the error", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg());
		await ctx.reg.startLearning("washer");
		const res = await ctx.reg.stopLearning("washer");
		assert.deepStrictEqual(res, { error: "tooFewSamples" });
		assert.deepStrictEqual(JSON.parse(ctx.host.own("washer.learning.result")), { error: "tooFewSamples" });
		assert.deepStrictEqual(await ctx.reg.stopLearning("nope"), { error: "unknownDevice" });
	});

	it("a throwing device does not stop the others", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg());
		await ctx.reg.upsert("dryer", makeCfg({ name: "Dryer", powerId: P2 }));
		ctx.reg.get("washer").tick = async () => {
			throw new Error("boom");
		};
		await feed(ctx, P2, 200, 4);
		assert.strictEqual(ctx.reg.get("dryer").isRunning, true);
		assert.ok(ctx.host.logs.error.some(m => m.includes("boom")));
	});

	it("does not tick disabled devices", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg({ enabled: false }));
		await feed(ctx, P1, 200, 4);
		assert.strictEqual(ctx.reg.get("washer").isRunning, false);
	});

	it("status returns the main states", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg());
		await feed(ctx, P1, 200, 4);
		const s = await ctx.reg.status("washer");
		assert.strictEqual(s.running, true);
		assert.strictEqual(s.finished, false);
		assert.strictEqual(s.consumption, 200);
		assert.strictEqual(s.status, ctx.inst.statusTexts.running);
		assert.strictEqual(await ctx.reg.status("nope"), null);
	});

	it("remove stops the device", async () => {
		const ctx = setup();
		await ctx.reg.upsert("washer", makeCfg({ reminder: { ...DEFAULT_REMINDER, enabled: true } }));
		await runCycle(ctx);
		ctx.reg.remove("washer");
		ctx.reg.remove("washer");
		assert.strictEqual(ctx.reg.get("washer"), undefined);
		assert.strictEqual(ctx.host.openTimers(), 0);
	});

	it("disposeAll leaves no open timers and writes nothing afterwards (Review Focus 5)", async () => {
		const ctx = setup();
		await ctx.reg.upsert(
			"washer",
			makeCfg({
				switchId: SW,
				autoOff: true,
				autoOffMinutes: 5,
				reminder: { ...DEFAULT_REMINDER, enabled: true },
			}),
		);
		await ctx.reg.upsert(
			"dryer",
			makeCfg({ name: "Dryer", powerId: P2, reminder: { ...DEFAULT_REMINDER, enabled: true } }),
		);
		await ctx.reg.startLearning("dryer");
		await runCycle(ctx, P1);
		await runCycle(ctx, P2);
		assert.ok(ctx.host.openTimers() >= 3);
		ctx.reg.disposeAll();
		assert.strictEqual(ctx.host.openTimers(), 0);
		assert.deepStrictEqual(ctx.reg.ids(), []);
		const writes = ctx.host.ownWrites.length;
		await ctx.reg.tickAll();
		await ctx.host.runTimers();
		assert.strictEqual(ctx.host.ownWrites.length, writes);
	});
});
