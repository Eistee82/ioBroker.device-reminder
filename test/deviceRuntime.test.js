import assert from "node:assert";
import { renderHistoryHtml } from "../build/lib/historyHtml.js";
import { washingMachine } from "./helpers/curves.js";
import { saveStore } from "../build/lib/runStore.js";
import { createFakeHost } from "./helpers/fakeHost.js";
import { syntheticRun, WM_FINAL } from "./helpers/final.js";
import { layoutOf, layoutRun, loadSeries } from "./helpers/fixtures.js";
import { BOILER_PHASES, WM_PHASES } from "./helpers/phases.js";
import {
	deviceConfig,
	feed,
	feedPoints,
	P as POWER,
	play,
	playPoints,
	registrySetup,
	runtimeSetup,
	SW as SWITCH,
	STEP,
	WASHER,
} from "./helpers/devices.js";
import { runOf } from "./helpers/programmes.js";

const ID = "washer";
const makeCfg = deviceConfig;
const setup = runtimeSetup;

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

	it("abort + abortFixed: a normal end below standby is finished (switch stays on)", async () => {
		const ctx = setup({
			cfg: { abort: true, abortFixed: true, switchId: SWITCH },
			hostOpts: { values: { [SWITCH]: true } },
		});
		await ctx.rt.init();
		await play(ctx, washingMachine);
		assert.deepStrictEqual(ctx.events, [`${ID}:start`, `${ID}:end`]);
		assert.deepStrictEqual(
			ctx.messages.map(m => m.text),
			["Started", "Finished"],
		);
		assert.strictEqual(ctx.host.own(`${ID}.finished`), true);
		ctx.rt.dispose();
	});

	it("abort + abortFixed: switching the plug off during the run is an abort", async () => {
		const ctx = setup({
			cfg: { abort: true, abortFixed: true, switchId: SWITCH },
			hostOpts: { values: { [SWITCH]: true } },
		});
		await ctx.rt.init();
		await play(ctx, [...Array(5).fill(500)]);
		ctx.rt.onSwitch(false);
		await play(ctx, Array(60).fill(0));
		assert.deepStrictEqual(ctx.events, [`${ID}:start`, `${ID}:abort`]);
		assert.deepStrictEqual(
			ctx.messages.map(m => m.text),
			["Started"],
		);
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
		const timed = {
			...WASHER,
			mode: "timed",
			startVal: 30,
			endVal: 15,
			standby: 5,
			startDurationSec: 60,
			endDurationSec: 120,
		};
		const ctx = setup({ cfg: { detection: timed } });
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

	it("keeps the cycle on a config change with the same power state", async () => {
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
		assert.strictEqual(ctx.rt.canKeepStateFor(makeCfg({ template: "dryer" })), true, "the template is no reason");
		ctx.rt.dispose();
	});

	it("keeps the cycle when only the detection values change; the new values apply after the run", async () => {
		const ctx = runtimeSetup();
		await ctx.rt.init();
		const run = runOf({ device: "washer", programme: "cotton60", seed: 1 });
		await play(ctx, run.values.slice(0, run.start + 20));
		assert.strictEqual(ctx.rt.isRunning, true);
		assert.strictEqual(ctx.rt.canKeepStateFor(deviceConfig({ detection: { ...WASHER, endVal: 10 } })), true);
		ctx.rt.updateConfig(deviceConfig({ detection: { ...WASHER, endVal: 10 } }));
		assert.strictEqual(ctx.rt.isRunning, true);
		assert.deepStrictEqual(ctx.events, ["washer:start"]);
		assert.strictEqual(ctx.rt.effective.endVal, 10);
		assert.strictEqual(ctx.rt.canKeepStateFor(deviceConfig({ powerId: "other.0.power" })), false);
		ctx.rt.dispose();
	});
	it("suspension masks finalMinVal only in active", () => {
		const ctx = runtimeSetup({ cfg: { detection: { ...WASHER, finalMinVal: 150, finalMinSec: 168 } } });
		ctx.rt.setOverride({ finalMinSec: 180 });
		ctx.rt.setFinalSuspended(true);
		assert.deepStrictEqual(
			[
				ctx.rt.active.finalMinVal,
				ctx.rt.effective.finalMinVal,
				ctx.rt.baseDetection.finalMinVal,
				ctx.rt.currentOverride,
			],
			[0, 150, 150, { finalMinSec: 180 }],
		);
		ctx.rt.setFinalSuspended(false);
		assert.strictEqual(ctx.rt.active.finalMinVal, 150);
	});
});

const FIN = { ...WASHER, ...WM_FINAL };
const fill = (v, n) => new Array(n).fill(v);
const { values: synth, coreEnd: synthEnd } = syntheticRun();
// up to and including the early end (core end + 13)
const pre = synth.slice(0, synthEnd + 14);
const switchWrites = ctx => ctx.host.writes.filter(w => w.id === SWITCH);

describe("runtime with a final phase", function () {
	this.timeout(600_000);
	for (const [exit, after, off] of [
		["a", fill(6, 80), true],
		["b", fill(0.8, 10), true],
		["e", fill(20, 280), true],
		["c", [...fill(2000, 7), ...fill(20, 20)], false],
		["d", [...fill(20, 245), ...fill(300, 3)], false],
		["f", fill(20, 40), false],
		["g", [...fill(300, 12), ...fill(20, 20)], false],
	]) {
		it(`AutoOff with 0 minutes ${off ? "switches off after" : "waits for the new run after"} exit ${exit}`, async () => {
			const noF = exit === "d" || exit === "e" ? { finalActVal: 0, finalActShare: 0 } : {};
			const ctx = runtimeSetup({
				cfg: { detection: { ...FIN, ...noF }, switchId: SWITCH, autoOff: true, autoOffMinutes: 0 },
			});
			await ctx.rt.init();
			ctx.rt.onSwitch(true);
			await play(ctx, pre);
			assert.deepStrictEqual(switchWrites(ctx), [], "not at the early end");
			await play(ctx, after);
			assert.strictEqual(switchWrites(ctx).length, off ? 1 : 0, exit);
		});
	}
	it("AutoOff after an activity exit without a new run switches off after finalCheckSec", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN, switchId: SWITCH, autoOff: true, autoOffMinutes: 0 } });
		await ctx.rt.init();
		ctx.rt.onSwitch(true);
		await play(ctx, [...pre, ...fill(20, 40)]); // exit f, 20 W < startVal 30: no start
		assert.deepStrictEqual(switchWrites(ctx), []);
		await play(ctx, fill(20, WM_FINAL.finalCheckSec / 10 + 2));
		assert.strictEqual(switchWrites(ctx).length, 1);
		assert.deepStrictEqual(ctx.events, ["washer:start", "washer:end"]);
	});
	it("AutoOff after an activity exit without a new run switches off at once with a rest proof", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN, switchId: SWITCH, autoOff: true, autoOffMinutes: 0 } });
		await ctx.rt.init();
		ctx.rt.onSwitch(true);
		await play(ctx, [...pre, ...fill(2000, 7), ...fill(20, 5)]); // exit c, no start
		assert.strictEqual(ctx.rt.settling, false);
		assert.deepStrictEqual(switchWrites(ctx), []);
		await play(ctx, fill(0.8, WM_FINAL.finalRestSec / 10));
		assert.deepStrictEqual(switchWrites(ctx), [], "rest not proven yet");
		await play(ctx, fill(0.8, 2));
		assert.strictEqual(switchWrites(ctx).length, 1);
		assert.deepStrictEqual(ctx.events, ["washer:start", "washer:end"]);
	});
	it("AutoOff after an activity exit with a new run switches off only after that run", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN, switchId: SWITCH, autoOff: true, autoOffMinutes: 0 } });
		await ctx.rt.init();
		ctx.rt.onSwitch(true);
		await play(ctx, [...pre, ...fill(2000, 7), ...synth.slice(0, 300)]); // exit c, new run under way
		assert.deepStrictEqual(switchWrites(ctx), []);
		await play(ctx, [...synth.slice(300), ...fill(0.5, 300)]);
		assert.strictEqual(switchWrites(ctx).length, 1);
		assert.strictEqual(ctx.events.filter(e => e === "washer:end").length, 2);
	});
	it("restart 0–10 min after each early end on washer30d → 0 phantom starts, 0 second ends (P5)", async () => {
		const W = loadSeries("washer30d");
		const { L, s } = layoutOf(W);
		for (const k of [0, 2, 4, 5, 6, 7, 8, 9, 10, 11]) {
			const r = L.runs[k];
			for (const m of [0, 1, 2, 3, 5, 10]) {
				const host = createFakeHost({ objects: [POWER, SWITCH], now: s.t0 + (r.from - 180) * s.stepMs });
				const a = runtimeSetup({ host, cfg: { detection: FIN } });
				await a.rt.init();
				// up to 3 h after the run, but before the next run of the recording (its start is no phantom start)
				const last = Math.min(r.runEnd + 1080, (L.runs[k + 1]?.from ?? Infinity) - 1);
				const win = W.filter(p => p.ts >= host.now() && p.ts <= s.t0 + last * s.stepMs);
				const stop = await playPoints(a, win, 10_000, c => c.events.includes("washer:end"));
				assert.strictEqual(a.rt.settling, true, `run ${k}: early end`);
				const cut = win[stop].ts + m * 60_000;
				await playPoints(
					a,
					win.slice(stop).filter(p => p.ts < cut),
				);
				assert.deepStrictEqual(a.events, ["washer:start", "washer:end"], `run ${k} +${m}`);
				a.rt.dispose();
				const b = runtimeSetup({ host, cfg: { detection: FIN } });
				await b.rt.init();
				await playPoints(
					b,
					win.filter(p => p.ts >= cut),
				);
				assert.deepStrictEqual(b.events, [], `run ${k} restart +${m}: ${b.events}`);
			}
		}
	});
	it("a run after an early end is an ordinary run with its own messages, operations and back-dated runtime", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN } });
		await ctx.rt.init();
		await play(ctx, [...pre, ...fill(2000, 7), ...synth.slice(0, 200)]);
		assert.deepStrictEqual(ctx.events.slice(0, 3), ["washer:start", "washer:end", "washer:start"]);
		assert.deepStrictEqual(ctx.messages.map(m => m.text).slice(0, 3), ["Started", "Finished", "Started"]);
		await play(ctx, synth.slice(200));
		assert.strictEqual(JSON.parse(ctx.host.own("washer.lastOperations")).length, 2);
		assert.ok(!ctx.events.some(e => e.includes("resume")));
	});
	it("a config change during settling rebuilds nothing until the lock ends (Review Focus 1)", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN } });
		await ctx.rt.init();
		await play(ctx, pre);
		const rev = ctx.rt.detectorRev;
		ctx.rt.updateConfig(
			deviceConfig({ endText: "Fertig!", recipients: ["tg"], abort: true, detection: { ...FIN, endCount: 60 } }),
		);
		await play(ctx, fill(6, 30));
		assert.strictEqual(ctx.rt.detectorRev, rev, "not rebuilt while settling");
		assert.deepStrictEqual(ctx.events, ["washer:start", "washer:end"]);
		await play(ctx, fill(6, 60));
		assert.ok(ctx.rt.detectorRev > rev, "rebuilt after the lock");
		assert.deepStrictEqual(ctx.events, ["washer:start", "washer:end"], "no phantom start, no second end");
	});
	it("power state change or disabling while settling clears settlingUntil (Review Focus 2)", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: FIN });
		await feed(ctx, pre);
		assert.ok(ctx.host.own("dev.settlingUntil") > ctx.host.now());
		await ctx.reg.upsert("dev", { ...ctx.cfg, powerId: "plug.1.power" });
		assert.strictEqual(ctx.host.own("dev.settlingUntil"), 0);
		const ctx2 = await registrySetup({ autoOptimize: false, detection: FIN });
		await feed(ctx2, pre);
		await ctx2.reg.upsert("dev", { ...ctx2.cfg, enabled: false });
		assert.strictEqual(ctx2.host.own("dev.settlingUntil"), 0);
	});
	it("final phase only in the override (switched on by the optimisation): restart 1 min after the early end → no phantom start", async () => {
		const ctx = await registrySetup({ detection: WASHER });
		const store = ctx.reg.learningData("dev");
		store.override = { ...WM_FINAL };
		store.final = { state: "on", splits: [], suspendedAt: 0 };
		await ctx.reg.upsert("dev", ctx.cfg); // restore: override applied, settlingUntil created (stateWanted with override)
		await feed(ctx, pre);
		assert.ok(
			ctx.host.own("dev.settlingUntil") > ctx.host.now(),
			"settlingUntil exists without final values in the base",
		);
		await saveStore(ctx.files, store);
		ctx.reg.disposeAll();
		ctx.host.tickClock(60_000);
		const again = await registrySetup({ host: ctx.host, files: ctx.files, detection: WASHER });
		assert.strictEqual(again.reg.get("dev").settling, true, "lock phase continued after the restart");
		const n = again.host.ownWrites.length;
		await feed(again, fill(6, 120));
		assert.ok(
			!again.host.ownWrites.slice(n).some(w => w.id === "dev.running" && w.val === true),
			"no phantom start",
		);
		assert.strictEqual(again.reg.get("dev").currentOverride.finalMinVal, 150);
	});
	it("an acknowledged run (finished = false) still resumes the lock after a restart", async () => {
		const now0 = new Date(2026, 0, 5, 12, 0).getTime(); // default clock of createFakeHost
		const host = createFakeHost({
			objects: [POWER, SWITCH],
			own: { "washer.finished": false, "washer.settlingUntil": now0 + 600_000 },
		});
		const ctx = runtimeSetup({ host, cfg: { detection: FIN } });
		await ctx.rt.init();
		await play(ctx, fill(6, 30));
		assert.deepStrictEqual(ctx.events, []);
		assert.strictEqual(ctx.rt.settling, true);
	});
	it("settlingUntil far in the future → the lock ends at most finalLockSec after the restart (Review Focus 3)", async () => {
		const now0 = new Date(2026, 0, 5, 12, 0).getTime(); // default clock of createFakeHost
		const host = createFakeHost({
			objects: [POWER, SWITCH],
			own: { "washer.finished": true, "washer.settlingUntil": now0 + 10 * 3_600_000 },
		});
		const ctx = runtimeSetup({ host, cfg: { detection: { ...FIN, finalActVal: 0, finalActShare: 0 } } });
		await ctx.rt.init();
		await play(ctx, fill(20, 271));
		assert.strictEqual(ctx.host.own("washer.settlingUntil"), 0);
		assert.deepStrictEqual(ctx.events, []);
	});
	it("the first start after a lock carries afterFinal in the capture", async () => {
		const ctx = await registrySetup({ detection: FIN });
		await feed(ctx, [...pre, ...fill(2000, 7), ...synth.slice(0, 50)]);
		const pend = ctx.reg.get("dev").runRecorder.snapshot() ?? ctx.reg.learningData("dev").pending;
		assert.ok(
			pend.ev.some(e => e[1] === "s" && e[2] === "c"),
			JSON.stringify(pend.ev),
		);
	});
});

describe("phase outputs", function () {
	this.timeout(300_000);
	const series = loadSeries("washer30d");
	/** The values of run w08 with 3 min before and 20 min after (fixture format; the next run starts 50 min after). */
	const w08 = () => {
		const { info, s } = layoutRun("washer30d", "w08");
		return series.filter(
			p => p.ts >= s.t0 + (info.from - 180) * s.stepMs && p.ts <= s.t0 + (info.runEnd + 120) * s.stepMs,
		);
	};
	/**
	 * A fake host whose clock starts at the first value of w08 (the fixture is from 2023).
	 *
	 * @param {Record<string, string> | string[]} [objects] foreign objects
	 */
	const w08Host = (objects = [POWER, SWITCH]) => createFakeHost({ objects, now: w08()[0].ts });
	const strip = ctx => ctx.host.ownWrites.filter(w => !/\.phase/.test(w.id)).map(w => [w.id, w.val]);

	it("status, events and messages are identical with and without phases (G2)", async () => {
		const a = runtimeSetup({ host: w08Host() });
		const b = runtimeSetup({ host: w08Host(), cfg: { phases: WM_PHASES } });
		for (const c of [a, b]) {
			await c.rt.init();
			await playPoints(c, w08());
		}
		assert.ok(a.events.length >= 2);
		assert.deepStrictEqual(
			b.events.filter(e => !e.includes(":phase:")),
			a.events,
		);
		assert.deepStrictEqual(b.messages, a.messages);
		assert.deepStrictEqual(strip(b), strip(a));
	});
	it("writes phase, phaseId, phaseSince and the timeline", async () => {
		const ctx = runtimeSetup({ host: w08Host(), cfg: { phases: WM_PHASES } });
		await ctx.rt.init();
		await playPoints(ctx, w08());
		assert.ok(ctx.host.ownHistory("washer.phase").includes("Endschleudern"));
		assert.ok(ctx.host.ownHistory("washer.phaseId").includes("p4"));
		assert.ok(ctx.host.ownHistory("washer.phaseSince").some(v => v > 0));
		assert.ok(JSON.parse(ctx.host.own("washer.phases")).some(x => x.id === "p3"));
		assert.ok(ctx.events.includes("washer:phase:p4:start"));
		assert.ok(ctx.events.includes("washer:phase:p4:end"));
	});
	it("no phase states are written without phases", async () => {
		const ctx = runtimeSetup({ host: w08Host() });
		await ctx.rt.init();
		await playPoints(ctx, w08());
		assert.ok(!ctx.host.ownWrites.some(w => /\.phase/.test(w.id)));
	});
	it("phaseStart action filtered by phaseId; an empty phaseId means every phase", async () => {
		const actions = [
			{ event: "phaseStart", stateId: "x.0.a", value: "1", phaseId: "p4" },
			{ event: "phaseStart", stateId: "x.0.b", value: "1" },
		];
		const host = w08Host({ [POWER]: "number", "x.0.a": "string", "x.0.b": "string" });
		const ctx = await registrySetup({ host, autoOptimize: false, cfg: { phases: WM_PHASES, actions } });
		await feedPoints(ctx, w08());
		const a = ctx.host.writes.filter(w => w.id === "x.0.a").length;
		const b = ctx.host.writes.filter(w => w.id === "x.0.b").length;
		assert.strictEqual(a, 1);
		assert.ok(b >= 3 && b > a, String(b));
	});
	it("a phase message is sent once per run and phase; continuous at most every 10 min", async () => {
		const notifyP4 = {
			...WM_PHASES,
			phases: WM_PHASES.phases.map(p =>
				p.id === "p4" ? { ...p, notify: { start: true, text: "Endschleudern" } } : p,
			),
		};
		const ctx = runtimeSetup({ host: w08Host(), cfg: { phases: notifyP4 } });
		await ctx.rt.init();
		await playPoints(ctx, w08());
		assert.strictEqual(ctx.messages.filter(m => m.text === "Endschleudern").length, 1);
		const boiler = {
			...BOILER_PHASES,
			phases: BOILER_PHASES.phases.map(p =>
				p.id === "q3" ? { ...p, notify: { start: true, text: "Brenner" } } : p,
			),
		};
		const k = runtimeSetup({ cfg: { phases: boiler, startText: "", endText: "" } });
		await k.rt.init();
		const t0 = k.host.now();
		const pts = [];
		for (let m = 0; m < 30; m += 2) {
			pts.push({ ts: t0 + m * 60_000, val: m % 4 === 0 ? 250 : 0 });
		}
		await playPoints(k, pts, 2000);
		assert.strictEqual(k.messages.filter(m => m.text === "Brenner").length, 3, "minutes 0, 12, 24 of 0-28");
	});
	it("continuous over 24 h with more than 200 segments keeps exactly the 200 newest (Review Focus 5)", async () => {
		const ctx = runtimeSetup({ cfg: { phases: BOILER_PHASES, startText: "", endText: "" } });
		await ctx.rt.init();
		const t0 = ctx.host.now();
		const pts = Array.from({ length: 480 }, (_, i) => ({ ts: t0 + i * 180_000, val: i % 2 ? 0 : 250 }));
		await playPoints(ctx, pts, 10_000);
		const tl = JSON.parse(ctx.host.own("washer.phases"));
		assert.strictEqual(tl.length, 200);
		assert.ok(tl.every((x, i) => i === 0 || x.from >= tl[i - 1].from));
		assert.ok(tl.at(-1).from >= t0 + 470 * 180_000);
	});
	it("system phase afterRun while settling", async () => {
		const ctx = runtimeSetup({
			host: w08Host(),
			cfg: { phases: WM_PHASES, detection: { ...WASHER, ...WM_FINAL } },
		});
		await ctx.rt.init();
		await playPoints(ctx, w08());
		assert.ok(ctx.host.ownHistory("washer.phaseId").includes("afterRun"));
	});
	it("the timeline state is written on segment changes only", async () => {
		const ctx = runtimeSetup({ host: w08Host(), cfg: { phases: WM_PHASES } });
		await ctx.rt.init();
		await playPoints(ctx, w08());
		const writes = ctx.host.ownWrites.filter(w => w.id === "washer.phases").length;
		const segments = JSON.parse(ctx.host.own("washer.phases")).length;
		assert.ok(writes <= 2 * segments + 2, `${writes} writes for ${segments} segments`);
	});
	it("a changed phase model is applied between two runs only", async () => {
		const ctx = runtimeSetup({ host: w08Host(), cfg: { phases: WM_PHASES } });
		await ctx.rt.init();
		const pts = w08();
		const mid = pts.findIndex(p => p.ts >= pts[0].ts + 20 * 60_000);
		await playPoints(ctx, pts.slice(0, mid));
		assert.strictEqual(ctx.rt.isRunning, true);
		const builds = ctx.rt.phaseRev;
		ctx.rt.updateConfig(deviceConfig({ phases: { ...WM_PHASES, learnedAt: 1 } }));
		assert.strictEqual(ctx.rt.phaseRev, builds, "not rebuilt during the run");
		await playPoints(ctx, pts.slice(mid));
		assert.ok(ctx.rt.phaseRev > builds, "rebuilt after the run");
		assert.ok(ctx.events.includes("washer:end"));
	});
});
