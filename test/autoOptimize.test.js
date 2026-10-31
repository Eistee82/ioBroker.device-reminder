import assert from "node:assert";
import { DEFAULT_REMINDER, normalizeInstanceConfig } from "../build/lib/config.js";
import { DeviceRegistry } from "../build/lib/deviceRegistry.js";
import { DeviceRuntime } from "../build/lib/deviceRuntime.js";
import {
	boundsOf,
	effectiveOf,
	gate,
	LOCK_MS,
	LOCK_RUNS,
	optimize,
	TIGHTEN_SPACING_MS,
	withinBounds,
} from "../build/lib/learn/autoOptimize.js";
import { simulate } from "../build/lib/learn/replay.js";
import { fromCells } from "../build/lib/learn/ticks.js";
import { Notifier } from "../build/lib/notifier.js";
import { addRun, emptyStore, labelCapture, typeHash } from "../build/lib/runStore.js";
import { createFakeHost } from "./helpers/fakeHost.js";
import { lcg, runOf, times } from "./helpers/programmes.js";
import { memoryFiles } from "./helpers/files.js";

const P = "plug.0.power";
const STEP = 10_000;
const DAY = 86_400_000;
const SHAPES = ["T1", "T2", "T3", "T4", "T5", "T6"];
const WASHER = ["cotton60", "quick30", "eco4060", "wool", "spinOnly"];
const DRYER = ["cupboard", "iron", "refresh", "heatPump"];

/**
 * Registry with one device on a fake host.
 *
 * @param {object} [o] options
 * @param {string} [o.typeId] device type
 * @param {boolean} [o.autoOptimize] automatic optimisation
 * @param {object} [o.files] file io (default: in memory); null = none
 * @param {object} [o.host] fake host to reuse
 * @param {object[]} [o.types] instance types
 * @returns {Promise<object>} context
 */
async function setup(o = {}) {
	const host = o.host ?? createFakeHost({ objects: { [P]: "number" } });
	const files = o.files === null ? undefined : (o.files ?? memoryFiles());
	const inst = normalizeInstanceConfig({ pollIntervalSec: 10, ...(o.types ? { types: o.types } : {}) }).config;
	const reg = new DeviceRegistry(host, new Notifier(host, () => inst.recipients), () => inst, files);
	const cfg = {
		enabled: true,
		name: "Dev",
		typeId: o.typeId ?? "washing-machine",
		powerId: P,
		startText: "",
		endText: "",
		abort: false,
		abortFixed: false,
		autoOff: false,
		autoOffMinutes: 0,
		recipients: [],
		reminder: { ...DEFAULT_REMINDER },
		actions: [],
		...(o.autoOptimize === false ? {} : { autoOptimize: true }),
	};
	await reg.upsert("dev", cfg);
	return { host, files, inst, reg, cfg };
}

/**
 * Wait until the queued optimisation jobs are done (their yields run as fake timers).
 *
 * @param {object} ctx context
 */
async function drain(ctx) {
	let done = false;
	void ctx.reg.whenOptimized().then(() => {
		done = true;
	});
	for (let i = 0; i < 1_000_000 && !done; i++) {
		await ctx.host.advance(0);
		await new Promise(resolve => setImmediate(resolve));
	}
}

/**
 * Feed one run through the registry and return when it started and ended (ticks after its first value).
 *
 * @param {object} ctx context
 * @param {{ values: number[], coreEnd: number }} run run
 * @returns {Promise<{ starts: number[], ends: number[], delays: number[] }>} events
 */
async function play(ctx, run) {
	const t0 = ctx.host.now();
	const from = ctx.host.ownWrites.length;
	for (const v of run.values) {
		ctx.host.setValue(P, v);
		await ctx.reg.routeForeignState(P, v);
		ctx.host.tickClock(STEP);
		await ctx.reg.tickAll();
	}
	await drain(ctx);
	const writes = ctx.host.ownWrites.slice(from);
	const at = (id, val) => writes.filter(w => w.id === id && w.val === val).map(w => (w.at - t0) / STEP);
	const ends = at("dev.finished", true);
	return { starts: at("dev.running", true), ends, delays: ends.map(e => (e - run.coreEnd - 1) * 10) };
}

describe("automatic optimisation", function () {
	this.timeout(120_000);

	it("is off by default: same events, no files, no learning states", async () => {
		const runs = [0, 1, 2].map(k =>
			runOf({ device: "dryer", programme: DRYER[k], shape: SHAPES[k], seed: k + 1, after: 400 }),
		);
		const plain = await setup({ typeId: "dryer", autoOptimize: false, files: null });
		const off = await setup({ typeId: "dryer", autoOptimize: false });
		for (const run of runs) {
			await play(plain, run);
			await play(off, run);
		}
		const strip = ctx => ctx.host.ownWrites.map(w => [w.id, w.val, w.at]);
		assert.deepStrictEqual(strip(off), strip(plain));
		assert.strictEqual(off.files.writes, 0);
		assert.ok(!off.host.ownWrites.some(w => /learning\.(optimi|param|lastChange)|antiCrease/.test(w.id)));
		assert.strictEqual(off.reg.learningData("dev"), null);
	});

	it("washing machine (default type): the anti-crease filter comes after 4 runs, then every programme ends early", async () => {
		const ctx = await setup();
		let changedAt = -1;
		for (let k = 0; k < 10; k++) {
			const run = runOf({
				device: "washer",
				programme: WASHER[k % 5],
				shape: SHAPES[k % 6],
				seed: k + 1,
				after: 400,
			});
			const r = await play(ctx, run);
			assert.strictEqual(r.starts.length, 1, `run ${k}: starts ${r.starts}`);
			assert.strictEqual(r.ends.length, 1, `run ${k}: ends ${r.ends}`);
			assert.ok(r.delays[0] >= 0, `run ${k}: end before the programme end`);
			if (changedAt >= 0) {
				assert.ok(r.delays[0] <= 400, `run ${k}: delay ${r.delays[0]} s`);
			}
			const store = ctx.reg.learningData("dev");
			if (changedAt < 0 && store.override) {
				changedAt = k;
				assert.ok(store.override.trailerBurstSec > 0, JSON.stringify(store.override));
			}
			ctx.host.tickClock(DAY);
		}
		assert.ok(changedAt >= 0 && changedAt <= 3, `first change after run ${changedAt}`);
		assert.strictEqual(ctx.host.own("dev.learning.optimized"), true);
		const params = JSON.parse(ctx.host.own("dev.learning.parameters"));
		assert.ok(params.effective.trailerBurstSec > 0 && params.type.trailerBurstSec === 0);
		const info = JSON.parse(ctx.host.own("dev.learning.optimizeInfo"));
		assert.strictEqual(info.trailer, "used");
		assert.ok(ctx.host.ownHistory("dev.antiCrease").includes(true));
		assert.ok(ctx.host.logs.info.some(m => m.includes("detection optimised")));
		// tightened at most once per day
		const changes = ctx.reg.learningData("dev").changes.filter(c => c.kind === "tighten");
		assert.ok(changes.every((c, i) => i === 0 || c.ts - changes[i - 1].ts >= TIGHTEN_SPACING_MS));
	});

	it("dryer (default type, bursts every 5 min): the false starts are repaired after one run", async () => {
		const ctx = await setup({ typeId: "dryer" });
		const first = await play(
			ctx,
			runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 1, after: 400 }),
		);
		assert.ok(first.starts.length > 1, "3.1.2 type starts on the bursts");
		const store = ctx.reg.learningData("dev");
		assert.strictEqual(store.runs[0].label, "split");
		assert.strictEqual(store.changes.at(-1).kind, "repair");
		assert.strictEqual(store.lockRuns, LOCK_RUNS);
		ctx.host.tickClock(DAY);
		for (let k = 1; k < 6; k++) {
			const run = runOf({
				device: "dryer",
				programme: DRYER[k % 4],
				shape: SHAPES[k % 6],
				seed: k + 1,
				after: 400,
			});
			const r = await play(ctx, run);
			assert.strictEqual(r.starts.length, 1, `run ${k}: starts ${r.starts}`);
			assert.strictEqual(r.ends.length, 1);
			assert.ok(r.delays[0] >= 0 && r.delays[0] <= 400, `run ${k}: delay ${r.delays[0]}`);
			ctx.host.tickClock(DAY);
		}
	});

	it("a phase inside the programme that looks like the anti-crease phase never ends a run early", async () => {
		// spinning, then 20 min of drum bursts exactly like an anti-crease phase, then the programme goes
		// on (heating, spinning) and ends with the real anti-crease phase
		const programme = seed => {
			const r = runOf({ device: "washer", programme: "spinOnly", shape: "T2", seed, after: 0 });
			const head = r.values.slice(0, r.coreEnd + 1);
			const fake = r.values.slice(r.coreEnd + 1, r.coreEnd + 121);
			const tail = [...times(2000, 60), ...times(600, 30)];
			const values = [...head, ...fake, ...tail, ...r.values.slice(r.coreEnd + 1), ...times(0.3, 400)];
			return { values, start: r.start, coreEnd: head.length + fake.length + tail.length - 1 };
		};
		const ctx = await setup();
		const typesBefore = JSON.stringify(ctx.inst.types);
		for (let k = 0; k < 8; k++) {
			const r = await play(ctx, programme(k + 1));
			assert.strictEqual(r.starts.length, 1, `run ${k}: starts ${r.starts}`);
			assert.strictEqual(r.ends.length, 1, `run ${k}: ends ${r.ends}`);
			assert.ok(r.delays[0] >= 0, `run ${k}: end ${r.delays[0]} s before the programme end`);
			ctx.host.tickClock(DAY);
		}
		const store = ctx.reg.learningData("dev");
		const eff = ctx.reg.get("dev").effective;
		assert.ok(["used", "notSeparable", "none"].includes(store.info.trailer), store.info.trailer);
		if ((eff.trailerBurstSec ?? 0) > 0) {
			// the filter is only on behind a guard that keeps the phase inside the programme
			assert.ok(eff.trailerBlockVal > 0 || eff.trailerAfterSec > 0 || eff.pauseHoldSec > 0, JSON.stringify(eff));
		}
		assert.strictEqual(JSON.stringify(ctx.inst.types), typesBefore, "instance configuration untouched");
		assert.ok(!ctx.host.writes.some(w => w.id.startsWith("system.adapter.")));
	});

	it("keeps the optimised values over a restart and discards them when the type changes", async () => {
		const ctx = await setup({ typeId: "dryer" });
		await play(ctx, runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 1, after: 400 }));
		const override = ctx.reg.learningData("dev").override;
		assert.ok(override);
		ctx.reg.disposeAll();
		const again = await setup({ typeId: "dryer", files: ctx.files, host: ctx.host });
		assert.deepStrictEqual(again.reg.learningData("dev").override, override);
		assert.deepStrictEqual(again.reg.get("dev").currentOverride, override);
		again.reg.disposeAll();
		const types = normalizeInstanceConfig({}).config.types.map(t =>
			t.id === "dryer" ? { ...t, endCount: 25 } : t,
		);
		const changed = await setup({ typeId: "dryer", files: ctx.files, host: ctx.host, types });
		assert.strictEqual(changed.reg.learningData("dev").override, null);
		assert.strictEqual(changed.reg.learningData("dev").changes.at(-1).kind, "typeChanged");
		assert.strictEqual(changed.reg.learningData("dev").runs.length, 1);
	});

	it("undo and reset restore the values and lock the tightening", async () => {
		const ctx = await setup({ typeId: "dryer" });
		await play(ctx, runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 1, after: 400 }));
		const store = ctx.reg.learningData("dev");
		assert.ok(store.override);
		await ctx.reg.routeOwnState("dev.learning.undo", true, false);
		assert.strictEqual(store.override, null);
		assert.strictEqual(store.changes.at(-1).kind, "undo");
		assert.strictEqual(store.lockUntilTs, ctx.host.now() + LOCK_MS);
		store.override = { endCount: 30 };
		await ctx.reg.routeOwnState("dev.learning.reset", true, false);
		assert.strictEqual(ctx.reg.get("dev").currentOverride, null);
		assert.strictEqual(store.changes.at(-1).kind, "reset");
		assert.strictEqual(ctx.host.own("dev.learning.optimized"), false);
		// clear the learning data
		await ctx.reg.deleteLearningData("dev");
		assert.strictEqual(ctx.reg.learningData("dev").runs.length, 0);
		assert.strictEqual(ctx.files.files.size, 0);
		assert.strictEqual(await ctx.reg.undoOptimization("dev"), false);
		assert.strictEqual(await ctx.reg.resetOptimization("nope"), false);
		// switching the option off goes back to the type values
		ctx.reg.get("dev").setOverride({ endCount: 30 });
		await ctx.reg.upsert("dev", { ...ctx.cfg, autoOptimize: undefined });
		assert.strictEqual(ctx.reg.get("dev").currentOverride, null);
		assert.strictEqual(ctx.reg.learningData("dev"), null);
	});

	it("changes the values only while no run is in progress", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const inst = normalizeInstanceConfig({ pollIntervalSec: 10 }).config;
		const type = inst.types.find(t => t.id === "washing-machine");
		const rt = new DeviceRuntime(
			host,
			"dev",
			{ name: "Dev", powerId: P, typeId: "washing-machine", abort: false, abortFixed: false, recipients: [] },
			type,
			inst,
			{ send: async () => {} },
			{ onRuntimeEvent: () => {} },
		);
		await rt.init();
		for (let i = 0; i < 5; i++) {
			await rt.onPower(500);
			host.tickClock(STEP);
			await rt.tick();
		}
		assert.strictEqual(rt.isRunning, true);
		rt.setOverride({ endCount: 3 });
		assert.strictEqual(rt.isRunning, true, "the detector is rebuilt after the run");
		assert.strictEqual(rt.effective.endCount, 3);
		for (let i = 0; i < 60; i++) {
			await rt.onPower(0.3);
			host.tickClock(STEP);
			await rt.tick();
		}
		assert.strictEqual(rt.isRunning, false);
		rt.setOverride(null);
		assert.strictEqual(rt.effective.endCount, 50);
	});
});

/**
 * Capture of a run as the runtime with values `p` would have recorded it.
 *
 * @param {{ values: number[] }} run run
 * @param {number} t0 time of the first value
 * @param {object} p detection values
 * @returns {object} capture
 */
function captureWith(run, t0, p) {
	const cells = run.values.map(v => ({ min: v, max: v, last: v, valid: true }));
	const s = fromCells(cells, t0, STEP);
	const res = simulate(s, { fromIdx: 0, toIdx: s.length - 1, runStartIdx: 0, runEndIdx: null, run: null }, p, {
		abort: false,
		abortFixed: false,
		pollSec: 10,
	});
	const ev = [...res.startedAt.map(t => [t, "s"]), ...res.finished.map(t => [t, "f"])].sort((a, b) => a[0] - b[0]);
	return { t0, stepMs: STEP, unitFactor: 1, cells, ev, postTruncated: false };
}

describe("automatic optimisation engine", function () {
	this.timeout(300_000);
	const type = normalizeInstanceConfig({}).config.types.find(t => t.id === "washing-machine");
	const ctxOf = now => ({
		type,
		pollSec: 10,
		abort: false,
		abortFixed: false,
		yieldFn: async () => {},
		now,
		budgetMs: 60_000,
		clock: () => Date.now(),
	});

	it("property: after every change all runs seen so far pass, no run gets later, values stay in bounds", async () => {
		let changes = 0;
		for (let seq = 0; seq < 4; seq++) {
			const store = emptyStore("dev", type.id, typeHash(type), STEP, 1);
			const seen = emptyStore("dev", type.id, typeHash(type), STEP, 1);
			let now = 1_700_000_000_000;
			let lastTighten = 0;
			for (let k = 0; k < 12; k++) {
				const p = effectiveOf(type, store.override);
				const run = runOf({
					device: "washer",
					programme: WASHER[(seq + k * 3) % 5],
					shape: SHAPES[(seq + k) % 6],
					seed: seq * 100 + k,
					after: 400,
				});
				const res = labelCapture(captureWith(run, now, p), p.endVal);
				if (res.run) {
					addRun(store, res.run);
					seen.runs.push(res.run);
					if (res.trusted) {
						store.newSinceChange++;
						store.lockRuns = Math.max(0, store.lockRuns - 1);
					}
				}
				const before = await gate(seen, effectiveOf(type, store.override), ctxOf(now));
				const out = await optimize(store, ctxOf(now));
				const q = effectiveOf(type, store.override);
				assert.ok(withinBounds(q, 10), `seq ${seq} run ${k}: bounds ${JSON.stringify(q)}`);
				const b = boundsOf(10);
				assert.ok(q.endCount <= b.endCount && q.startCount <= b.startCount);
				if (out.change) {
					changes++;
					const after = await gate(seen, q, ctxOf(now));
					assert.ok(after.ok, `seq ${seq} run ${k}: ${out.kind} breaks a run seen before`);
					if (out.kind === "tighten") {
						assert.ok(now - lastTighten >= TIGHTEN_SPACING_MS);
						lastTighten = now;
						after.perRun.forEach((r, i) => {
							assert.ok(
								r.delaySec <= before.perRun[i].delaySec + 10,
								`seq ${seq} run ${k}: run ${i} later`,
							);
						});
					}
				}
				now += DAY;
			}
		}
		assert.ok(changes >= 4, `${changes} changes`);
	});

	it("live: noisy runs of random programmes are detected correctly after every change, a repair never shortens a wait", async () => {
		// random programme, anti-crease shape and idle level per run, power with ±5 % noise; each run is
		// played with the values in use at that time (what the user gets), then stored and optimised
		const shapes = [...SHAPES, null];
		let changes = 0;
		for (let seq = 0; seq < 3; seq++) {
			const rnd = lcg(seq * 7919 + 13);
			const store = emptyStore("dev", type.id, typeHash(type), STEP, 1);
			let now = 1_700_000_000_000;
			let changed = false;
			for (let k = 0; k < 8; k++) {
				const programme = WASHER[Math.floor(rnd() * WASHER.length)];
				const shape = shapes[Math.floor(rnd() * shapes.length)];
				const idle = [0.3, 0.8, 1.5, 2][Math.floor(rnd() * 4)];
				const clean = runOf({ device: "washer", programme, shape, seed: seq * 1000 + k, after: 400, idle });
				const noise = lcg(seq * 31 + k);
				const run = {
					...clean,
					values: clean.values.map(v => Math.max(0, Math.round(v * (1 + 0.1 * (noise() - 0.5)) * 10) / 10)),
				};
				const p = effectiveOf(type, store.override);
				const cap = captureWith(run, now, p);
				const starts = cap.ev.filter(e => e[1] === "s").length;
				const ends = cap.ev.filter(e => e[1] === "f").map(e => e[0]);
				if (changed) {
					const what = `seq ${seq} run ${k} ${programme}/${shape}: ${starts} starts, ${ends.length} ends`;
					assert.strictEqual(starts, 1, what);
					assert.strictEqual(ends.length, 1, what);
					assert.ok(ends[0] >= now + run.coreEnd * STEP, `${what}: end before the programme end`);
				}
				const res = labelCapture(cap, p.endVal);
				if (res.run) {
					addRun(store, res.run);
					if (res.trusted) {
						store.newSinceChange++;
						store.lockRuns = Math.max(0, store.lockRuns - 1);
					}
				}
				const out = await optimize(store, ctxOf(now));
				if (out.change) {
					changes++;
					changed = true;
				}
				if (out.kind === "repair") {
					const q = effectiveOf(type, store.override);
					for (const key of ["startCount", "endCount", "startDurationSec", "endDurationSec"]) {
						assert.ok(q[key] >= p[key], `seq ${seq} run ${k}: repair lowers ${key} ${p[key]} → ${q[key]}`);
					}
				}
				now += DAY + 3_600_000;
			}
		}
		assert.ok(changes >= 3, `${changes} changes`);
	});

	it("a tightening switches the anti-crease filter on only behind a terminal block", async () => {
		// quick programmes and spinning only with anti-crease phases: the filter must not swallow the
		// soaking of the eco programme that comes later and was never seen
		const store = emptyStore("dev", type.id, typeHash(type), STEP, 1);
		let now = 1_700_000_000_000;
		const seenRuns = [
			["quick30", "T4"],
			["cotton60", "T1"],
			["spinOnly", "T4"],
			["quick30", "T5"],
			["cotton60", "T2"],
		];
		let filterOn = false;
		for (const [k, [programme, shape]] of seenRuns.entries()) {
			const run = runOf({ device: "washer", programme, shape, seed: 50 + k, after: 400 });
			const res = labelCapture(captureWith(run, now, effectiveOf(type, store.override)), 15);
			addRun(store, res.run);
			store.newSinceChange++;
			store.lockRuns = Math.max(0, store.lockRuns - 1);
			const out = await optimize(store, ctxOf(now));
			const q = effectiveOf(type, store.override);
			if (out.kind === "tighten" && (q.trailerBurstSec ?? 0) > 0) {
				filterOn = true;
				assert.ok(q.trailerBlockVal > 0, `filter without a block guard: ${JSON.stringify(store.override)}`);
			}
			now += DAY + 3_600_000;
		}
		assert.ok(filterOn, "the filter was switched on");
		for (const seed of [1, 2, 3]) {
			const eco = runOf({ device: "washer", programme: "eco4060", shape: "T4", seed, after: 400 });
			const cap = captureWith(eco, now, effectiveOf(type, store.override));
			const ends = cap.ev.filter(e => e[1] === "f").map(e => e[0]);
			assert.strictEqual(cap.ev.filter(e => e[1] === "s").length, 1, `eco ${seed}: one start`);
			assert.strictEqual(ends.length, 1, `eco ${seed}: one end`);
			assert.ok(ends[0] >= now + eco.coreEnd * STEP, `eco ${seed}: end not before the programme end`);
		}
	});

	it("a new programme that ends too early is repaired at once and locks the tightening", async () => {
		const now = 1_700_000_000_000;
		const store = emptyStore("dev", type.id, typeHash(type), STEP, 1);
		// a short end wait that the long pauses of the wool programme do not survive
		const tight = {
			endCount: 12,
			endDurationSec: 120,
			trailerBurstSec: 45,
			trailerGapSec: 30,
			trailerAfterSec: 0,
			trailerBlockVal: 0,
			trailerMaxSec: 9900,
		};
		store.override = tight;
		for (let k = 0; k < 6; k++) {
			const run = runOf({
				device: "washer",
				programme: ["quick30", "spinOnly"][k % 2],
				shape: "T1",
				seed: k + 1,
				after: 400,
			});
			addRun(store, labelCapture(captureWith(run, now + k * DAY, effectiveOf(type, tight)), 15).run);
		}
		assert.ok((await gate(store, effectiveOf(type, tight), ctxOf(now))).ok);
		const wool = runOf({ device: "washer", programme: "wool", shape: "T4", seed: 9, after: 400 });
		const cap = captureWith(wool, now + 7 * DAY, effectiveOf(type, tight));
		const res = labelCapture(cap, 15);
		assert.strictEqual(res.label, "split");
		addRun(store, res.run);
		const out = await optimize(store, ctxOf(now + 7 * DAY));
		assert.strictEqual(out.kind, "repair");
		assert.ok((await gate(store, effectiveOf(type, store.override), ctxOf(now))).ok);
		assert.strictEqual(store.lockRuns, LOCK_RUNS);
		assert.strictEqual(store.lockUntilTs, now + 7 * DAY + LOCK_MS);
		assert.strictEqual(out.info.status, "locked");
	});

	it("reports cannotCover and then drift when no setting detects the runs", async () => {
		const now = 1_700_000_000_000;
		const store = emptyStore("dev", type.id, typeHash(type), STEP, 1);
		const run = runOf({ device: "washer", programme: "quick30", seed: 1, after: 400 });
		const ok = labelCapture(captureWith(run, now, type), 15).run;
		// the same run once as a run and once as a false start: no setting can satisfy both
		addRun(store, ok);
		addRun(store, { ...ok, id: "x", label: "spike" });
		for (let k = 0; k < 3; k++) {
			const out = await optimize(store, ctxOf(now));
			assert.strictEqual(out.kind, k < 2 ? "cannotCover" : "drift");
		}
		assert.strictEqual((await optimize(store, ctxOf(now))).kind, "drift");
		const empty = emptyStore("dev", type.id, typeHash(type), STEP, 1);
		assert.strictEqual((await optimize(empty, ctxOf(now))).kind, "none");
	});

	it("20 runs and 10 false starts are checked within 5 s and yield at least every 50 ms", async () => {
		const now = 1_700_000_000_000;
		const store = emptyStore("dev", type.id, typeHash(type), STEP, 1);
		for (let k = 0; k < 20; k++) {
			const run = runOf({
				device: "washer",
				programme: WASHER[k % 5],
				shape: SHAPES[k % 6],
				seed: k + 1,
				after: 400,
			});
			addRun(store, labelCapture(captureWith(run, now + k * DAY, type), 15).run);
		}
		const spike = [...new Array(200).fill(0.5), 20, 20, ...new Array(200).fill(0.5)];
		for (let k = 0; k < 10; k++) {
			const cells = spike.map(v => ({ min: v, max: v, last: v, valid: true }));
			const cap = {
				t0: now + k * 1e7,
				stepMs: STEP,
				unitFactor: 1,
				cells,
				ev: [[now + k * 1e7 + 201 * STEP, "s"]],
				postTruncated: false,
			};
			addRun(store, labelCapture(cap, 15).run);
		}
		assert.strictEqual(store.runs.length, 20);
		assert.strictEqual(store.spikes.length, 10);
		store.newSinceChange = 20;
		const yields = [];
		const t0 = Date.now();
		const out = await optimize(store, {
			...ctxOf(now + 30 * DAY),
			yieldFn: async () => {
				yields.push(Date.now());
			},
		});
		const ms = Date.now() - t0;
		// the limits hold for an uninstrumented run; the coverage instrumentation makes the replay ~4x slower
		const slow = process.env.NODE_V8_COVERAGE ? 4 : 1;
		assert.ok(ms < 5000 * slow, `${ms} ms`);
		assert.strictEqual(out.kind, "tighten", JSON.stringify(out.info));
		const gaps = [t0, ...yields, Date.now()].map((t, i, a) => (i === 0 ? 0 : t - a[i - 1]));
		assert.ok(Math.max(...gaps) < 50 * slow, `longest stretch without yield ${Math.max(...gaps)} ms`);
		// a tiny budget stops the job without a change
		const budget = await optimize(store, { ...ctxOf(now + 60 * DAY), budgetMs: -1 });
		assert.strictEqual(budget.kind, "budget");
	});
});
