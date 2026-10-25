import assert from "node:assert";
import { DEFAULT_REMINDER, DEFAULT_TYPES } from "../build/lib/config.js";
import { DeviceRuntime } from "../build/lib/deviceRuntime.js";
import { renderHistoryHtml } from "../build/lib/historyHtml.js";
import { washingMachine } from "./helpers/curves.js";
import { createFakeHost } from "./helpers/fakeHost.js";

const POWER = "plug.0.power";
const SWITCH = "plug.0.switch";
const ID = "washer";
const STEP = 10_000;

// 3.1.2 defaults of the washing machine (set explicitly, independent of DEFAULT_TYPES).
const washerType = {
	...DEFAULT_TYPES.find(t => t.id === "washing-machine"),
	startVal: 30,
	endVal: 15,
	standby: 1,
	startCount: 2,
	endCount: 50,
};

function makeCfg(over = {}) {
	return {
		enabled: true,
		name: "Washer",
		typeId: "washing-machine",
		powerId: POWER,
		startText: "Started",
		endText: "Finished",
		abort: false,
		abortFixed: false,
		autoOff: false,
		autoOffMinutes: 0,
		recipients: [],
		reminder: { ...DEFAULT_REMINDER },
		actions: [],
		...over,
	};
}

function makeInst(over = {}) {
	return {
		configVersion: 4,
		types: DEFAULT_TYPES,
		recipients: [],
		statusTexts: { running: "in action", standby: "standby", off: "switched off" },
		pollIntervalSec: 10,
		historyHtml: false,
		...over,
	};
}

function setup({ cfg = {}, inst = {}, type = washerType, hostOpts = {} } = {}) {
	const host = createFakeHost({ objects: [POWER, SWITCH], ...hostOpts });
	const messages = [];
	const events = [];
	const sink = {
		async send(deviceId, text) {
			messages.push({ deviceId, text });
		},
	};
	const listener = {
		onRuntimeEvent(deviceId, ev) {
			events.push(`${deviceId}:${ev}`);
		},
	};
	const rt = new DeviceRuntime(host, ID, makeCfg(cfg), type, makeInst(inst), sink, listener);
	return { host, rt, messages, events };
}

/**
 * Play a curve: one power value and one poll per 10 s.
 *
 * @param {ReturnType<typeof setup>} ctx setup result
 * @param {number[]} curve power values
 */
async function play(ctx, curve) {
	for (const p of curve) {
		ctx.host.setValue(POWER, p);
		await ctx.rt.onPower(p);
		await ctx.rt.tick();
		await ctx.host.advance(STEP);
	}
}

/**
 * Play a curve and stop right after the end event (before the next clock step).
 *
 * @param {ReturnType<typeof setup>} ctx setup result
 * @param {number[]} curve power values
 */
async function playUntilEnd(ctx, curve) {
	const before = ctx.events.filter(e => e.endsWith(":end")).length;
	for (const p of curve) {
		ctx.host.setValue(POWER, p);
		await ctx.rt.onPower(p);
		await ctx.rt.tick();
		if (ctx.events.filter(e => e.endsWith(":end")).length > before) {
			return;
		}
		await ctx.host.advance(STEP);
	}
	assert.fail("curve did not end");
}

describe("DeviceRuntime", () => {
	it("sends the start and end message exactly once and fires start/end", async () => {
		const ctx = setup();
		await ctx.rt.init();
		await play(ctx, washingMachine);
		assert.deepStrictEqual(
			ctx.messages.map(m => m.text),
			["Started", "Finished"],
		);
		assert.deepStrictEqual(ctx.events, [`${ID}:start`, `${ID}:end`]);
		assert.strictEqual(ctx.host.own(`${ID}.message`), "Finished");
		assert.strictEqual(ctx.host.own(`${ID}.running`), false);
		assert.strictEqual(ctx.host.own(`${ID}.status`), "switched off");
		assert.ok(ctx.host.ownHistory(`${ID}.status`).includes("in action"));
		ctx.rt.dispose();
	});

	it("sends no message without start and end text", async () => {
		const ctx = setup({ cfg: { startText: "", endText: "" } });
		await ctx.rt.init();
		await play(ctx, washingMachine);
		assert.deepStrictEqual(ctx.messages, []);
		assert.deepStrictEqual(ctx.events, [`${ID}:start`, `${ID}:end`]);
		ctx.rt.dispose();
	});

	it("appends one lastOperations entry in the 3.1.2 format and keeps at most 14", async () => {
		const ctx = setup();
		await ctx.rt.init();
		await play(ctx, washingMachine);
		const ops = JSON.parse(ctx.host.own(`${ID}.lastOperations`));
		assert.strictEqual(ops.length, 1);
		assert.match(ops[0].start, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/);
		assert.match(ops[0].end, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/);
		assert.match(ops[0].runtime, /^\d{2}:\d{2}:\d{2}$/);
		assert.strictEqual(ctx.host.own(`${ID}.lastRuntime`), ops[0].runtime);
		for (let i = 0; i < 14; i++) {
			await play(ctx, washingMachine);
		}
		assert.strictEqual(JSON.parse(ctx.host.own(`${ID}.lastOperations`)).length, 14);
		ctx.rt.dispose();
	});

	it("raises alertRuntime above the runtime limit and clears it after the end", async () => {
		const ctx = setup({ hostOpts: { own: { [`${ID}.config.runtimeMax`]: 1 } } });
		await ctx.rt.init();
		await play(ctx, washingMachine);
		const history = ctx.host.ownHistory(`${ID}.alertRuntime`);
		assert.ok(history.includes(true));
		assert.strictEqual(ctx.host.own(`${ID}.alertRuntime`), false);
		ctx.rt.dispose();
	});

	it("never writes alertRuntime=true without a runtime limit", async () => {
		const ctx = setup();
		await ctx.rt.init();
		await play(ctx, washingMachine);
		assert.ok(!ctx.host.ownHistory(`${ID}.alertRuntime`).includes(true));
		ctx.rt.dispose();
	});

	it("switches the plug off after autoOffMinutes if it is on", async () => {
		const ctx = setup({
			cfg: { autoOff: true, autoOffMinutes: 2, switchId: SWITCH },
			hostOpts: { values: { [SWITCH]: true } },
		});
		await ctx.rt.init();
		await playUntilEnd(ctx, washingMachine);
		assert.strictEqual(ctx.host.openTimers(), 1);
		await ctx.host.advance(119_000);
		assert.strictEqual(ctx.host.writes.length, 0);
		await ctx.host.advance(1000);
		assert.deepStrictEqual(
			ctx.host.writes.map(w => [w.id, w.val]),
			[[SWITCH, false]],
		);
		ctx.rt.dispose();
	});

	it("switches off immediately with autoOffMinutes 0 and not if the plug is already off", async () => {
		const on = setup({
			cfg: { autoOff: true, autoOffMinutes: 0, switchId: SWITCH },
			hostOpts: { values: { [SWITCH]: true } },
		});
		await on.rt.init();
		await play(on, washingMachine);
		assert.strictEqual(on.host.writes.length, 1);
		const off = setup({
			cfg: { autoOff: true, autoOffMinutes: 0, switchId: SWITCH },
			hostOpts: { values: { [SWITCH]: true } },
		});
		await off.rt.init();
		off.rt.onSwitch(false);
		await play(off, washingMachine);
		assert.strictEqual(off.host.writes.length, 0);
		on.rt.dispose();
		off.rt.dispose();
	});

	it("does not switch off when the device restarts within the delay", async () => {
		const ctx = setup({
			cfg: { autoOff: true, autoOffMinutes: 2, switchId: SWITCH },
			hostOpts: { values: { [SWITCH]: true } },
		});
		await ctx.rt.init();
		await playUntilEnd(ctx, washingMachine);
		assert.strictEqual(ctx.host.openTimers(), 1);
		await play(ctx, [2000, 2000, 2000]);
		assert.strictEqual(ctx.host.openTimers(), 0);
		await ctx.host.advance(300_000);
		assert.strictEqual(ctx.host.writes.length, 0);
		ctx.rt.dispose();
	});

	it("uses the value of an existing state as text", async () => {
		const ctx = setup({
			cfg: { endText: "javascript.0.texts.done" },
			hostOpts: {
				values: { "javascript.0.texts.done": "Laundry is done" },
				objects: [POWER, "javascript.0.texts.done"],
			},
		});
		await ctx.rt.init();
		await play(ctx, washingMachine);
		assert.deepStrictEqual(
			ctx.messages.map(m => m.text),
			["Started", "Laundry is done"],
		);
		ctx.rt.dispose();
	});

	it("resolveText keeps plain text, trailing dots and unknown ids", async () => {
		const ctx = setup({ hostOpts: { objects: [POWER, "a.b"], values: { "a.b": 5 } } });
		assert.strictEqual(await ctx.rt.resolveText("Hello world"), "Hello world");
		assert.strictEqual(await ctx.rt.resolveText("Done."), "Done.");
		assert.strictEqual(await ctx.rt.resolveText("x.y"), "x.y");
		assert.strictEqual(await ctx.rt.resolveText("a.b"), "5");
	});

	it("sets finished and lastFinished at the end; acknowledge resets finished without an event", async () => {
		const ctx = setup();
		await ctx.rt.init();
		await play(ctx, washingMachine);
		assert.strictEqual(ctx.host.own(`${ID}.finished`), true);
		assert.ok(Number(ctx.host.own(`${ID}.lastFinished`)) > 0);
		const before = ctx.events.length;
		await ctx.rt.onOwnStateChange("acknowledge", true, false);
		assert.strictEqual(ctx.host.own(`${ID}.finished`), false);
		assert.strictEqual(ctx.events.length, before);
		ctx.rt.dispose();
	});

	it("start clears finished", async () => {
		const ctx = setup();
		await ctx.rt.init();
		await play(ctx, washingMachine);
		await play(ctx, [2000, 2000]);
		assert.strictEqual(ctx.host.own(`${ID}.finished`), false);
		assert.strictEqual(ctx.host.own(`${ID}.running`), true);
		ctx.rt.dispose();
	});

	it("writes the history table only if enabled", async () => {
		const on = setup({ inst: { historyHtml: true } });
		await on.rt.init();
		await play(on, washingMachine);
		assert.ok(String(on.host.own(`${ID}.lastOperationsHtml`)).includes("<table"));
		const off = setup();
		await off.rt.init();
		await play(off, washingMachine);
		assert.strictEqual(off.host.own(`${ID}.lastOperationsHtml`), null);
		on.rt.dispose();
		off.rt.dispose();
	});

	it("renderHistoryHtml escapes HTML", () => {
		const html = renderHistoryHtml([{ start: "<b>1</b>", end: "a&b", runtime: '"x"' }]);
		assert.ok(html.includes("<thead>"));
		assert.ok(html.includes("&lt;b&gt;1&lt;/b&gt;"));
		assert.ok(html.includes("a&amp;b"));
		assert.ok(html.includes("&quot;x&quot;"));
		assert.ok(!html.includes("<b>"));
	});

	it("ignores non-numeric power values and parses numeric strings", async () => {
		const ctx = setup();
		await ctx.rt.init();
		await ctx.rt.onPower("12,5");
		assert.strictEqual(ctx.rt.lastPower, 12.5);
		for (const bad of [null, true, false, "", "abc", "12 W", Number.NaN]) {
			await ctx.rt.onPower(bad);
			assert.strictEqual(ctx.rt.lastPower, 12.5);
		}
		await ctx.rt.tick();
		await ctx.rt.tick();
		for (const w of ctx.host.ownWrites) {
			if (typeof w.val === "number") {
				assert.ok(Number.isFinite(w.val), `${w.id} must stay finite`);
			}
		}
		assert.strictEqual(ctx.host.own(`${ID}.consumption`), 12.5);
		ctx.rt.dispose();
	});

	it("warns exactly once if the power state is missing and stays off", async () => {
		const ctx = setup({ hostOpts: { objects: [] } });
		await ctx.rt.init();
		for (let i = 0; i < 5; i++) {
			await ctx.rt.tick();
			await ctx.host.advance(STEP);
		}
		assert.strictEqual(ctx.host.logs.warn.length, 1);
		assert.match(ctx.host.logs.warn[0], /Power state plug\.0\.power of device Washer not found/);
		assert.deepStrictEqual(ctx.events, []);
		assert.strictEqual(ctx.host.own(`${ID}.status`), "switched off");
		assert.strictEqual(ctx.rt.powerMissing, true);
		ctx.rt.dispose();
	});

	it("init keeps lastRuntime, lastOperations, config, finished and lastFinished", async () => {
		const keep = {
			[`${ID}.lastRuntime`]: "01:02:03",
			[`${ID}.lastOperations`]: '[{"start":"a","end":"b","runtime":"c"}]',
			[`${ID}.finished`]: true,
			[`${ID}.lastFinished`]: 123,
			[`${ID}.config.doNotDisturb`]: true,
			[`${ID}.config.runtimeMax`]: 90,
			[`${ID}.runtime`]: "05:00:00",
			[`${ID}.status`]: "initialize",
		};
		const ctx = setup({ hostOpts: { own: keep, values: { [POWER]: 7 } } });
		await ctx.rt.init();
		for (const key of [
			"lastRuntime",
			"lastOperations",
			"finished",
			"lastFinished",
			"config.doNotDisturb",
			"config.runtimeMax",
		]) {
			assert.strictEqual(ctx.host.own(`${ID}.${key}`), keep[`${ID}.${key}`], key);
		}
		assert.strictEqual(ctx.host.own(`${ID}.status`), "switched off");
		assert.strictEqual(ctx.host.own(`${ID}.runtime`), "00:00:00");
		assert.strictEqual(ctx.host.own(`${ID}.runtimeMs`), 0);
		assert.strictEqual(ctx.host.own(`${ID}.running`), false);
		assert.strictEqual(ctx.host.own(`${ID}.consumption`), 7);
		assert.strictEqual(ctx.rt.doNotDisturb, true);
		ctx.rt.dispose();
	});

	it("confirms config states written with ack=false", async () => {
		const ctx = setup();
		await ctx.rt.init();
		await ctx.rt.onOwnStateChange("config.doNotDisturb", true, false);
		assert.strictEqual(ctx.rt.doNotDisturb, true);
		assert.strictEqual(ctx.host.own(`${ID}.config.doNotDisturb`), true);
		await ctx.rt.onOwnStateChange("config.runtimeMax", "45", false);
		assert.strictEqual(ctx.host.own(`${ID}.config.runtimeMax`), 45);
		ctx.rt.dispose();
	});

	it("time-based mode: onPower raises the events without a tick", async () => {
		const timedType = {
			...washerType,
			id: "timed",
			mode: "timed",
			startVal: 30,
			endVal: 15,
			standby: 5,
			startDurationSec: 60,
			endDurationSec: 120,
		};
		const ctx = setup({ type: timedType, cfg: { typeId: "timed" } });
		await ctx.rt.init();
		await ctx.rt.onPower(100);
		assert.deepStrictEqual(ctx.events, []);
		ctx.host.tickClock(60_000);
		await ctx.rt.onPower(100);
		assert.deepStrictEqual(ctx.events, [`${ID}:start`]);
		assert.strictEqual(ctx.rt.isRunning, true);
		await ctx.rt.onPower(0);
		ctx.host.tickClock(120_000);
		await ctx.rt.onPower(0);
		assert.deepStrictEqual(ctx.events, [`${ID}:start`, `${ID}:end`]);
		assert.deepStrictEqual(
			ctx.messages.map(m => m.text),
			["Started", "Finished"],
		);
		ctx.rt.dispose();
	});

	it("dispose clears the auto-off timer and writes nothing afterwards", async () => {
		const ctx = setup({
			cfg: { autoOff: true, autoOffMinutes: 5, switchId: SWITCH },
			hostOpts: { values: { [SWITCH]: true } },
		});
		await ctx.rt.init();
		await playUntilEnd(ctx, washingMachine);
		assert.strictEqual(ctx.host.openTimers(), 1);
		ctx.rt.dispose();
		assert.strictEqual(ctx.host.openTimers(), 0);
		const writes = ctx.host.ownWrites.length;
		await ctx.rt.onPower(2000);
		await ctx.rt.tick();
		await ctx.host.advance(600_000);
		assert.strictEqual(ctx.host.writes.length, 0);
		assert.strictEqual(ctx.host.ownWrites.length, writes);
	});

	it("keeps the cycle on a config change with the same type and power state", async () => {
		const ctx = setup();
		await ctx.rt.init();
		await play(ctx, washingMachine.slice(3, 10));
		assert.strictEqual(ctx.rt.isRunning, true);
		const same = makeCfg({ name: "Renamed", endText: "New end" });
		assert.strictEqual(ctx.rt.canKeepStateFor(same), true);
		ctx.rt.updateConfig(same);
		assert.strictEqual(ctx.rt.config.endText, "New end");
		assert.strictEqual(ctx.rt.isRunning, true);
		assert.strictEqual(ctx.rt.canKeepStateFor(makeCfg({ powerId: "other.0.power" })), false);
		assert.strictEqual(ctx.rt.canKeepStateFor(makeCfg({ typeId: "dryer" })), false);
		ctx.rt.dispose();
	});
});
