// Device, runtime, registry and history setup shared by the tests (detection values in the device).
import { DEFAULT_REMINDER, normalizeInstanceConfig } from "../../build/lib/config.js";
import { DeviceRegistry } from "../../build/lib/deviceRegistry.js";
import { DeviceRuntime } from "../../build/lib/deviceRuntime.js";
import { Notifier } from "../../build/lib/notifier.js";
import { detectionOf } from "../../build/lib/runStore.js";
import { TEMPLATES, templateDetection } from "../../build/lib/templates.js";
import { createFakeHost } from "./fakeHost.js";
import { memoryFiles } from "./files.js";

/** Power state of the test device. */
export const P = "plug.0.power";
/** Switch state of the test device. */
export const SW = "plug.0.switch";
/** Poll interval of the tests in ms. */
export const STEP = 10_000;

/** 3.1.2 values of the washing machine (30/15/1/2/50), all fields filled in. */
export const WASHER = detectionOf(TEMPLATES[0].detection);
/** 3.1.2 values of the dryer (120/15/1/2/20), all fields filled in. */
export const DRYER = templateDetection("dryer", 1);

/**
 * Device configuration of the washer.
 *
 * @param {object} [over] fields to change
 * @returns {object} device configuration
 */
export function deviceConfig(over = {}) {
	return {
		enabled: true,
		name: "Washer",
		detection: WASHER,
		powerId: P,
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

/**
 * Instance configuration: poll 10 s, recipient `tg` (telegram.0).
 *
 * @param {object} [over] fields to change
 * @returns {object} instance configuration
 */
export function instanceConfig(over = {}) {
	return {
		...normalizeInstanceConfig({
			pollIntervalSec: 10,
			recipients: [{ id: "tg", name: "Telegram", enabled: true, kind: "telegram", instance: "telegram.0" }],
		}).config,
		...over,
	};
}

/**
 * Runtime of one device on a fake host; events are recorded as `"<id>:start"` …
 *
 * @param {object} [o] options
 * @param {object} [o.cfg] device fields (mixed into `deviceConfig`)
 * @param {object} [o.inst] instance fields (mixed into `instanceConfig`)
 * @param {object} [o.hostOpts] options of the fake host
 * @param {object} [o.host] fake host to share
 * @param {string} [o.id] device id
 * @returns {{ host: object, rt: DeviceRuntime, messages: object[], events: string[] }} context
 */
export function runtimeSetup({ cfg = {}, inst = {}, hostOpts = {}, host, id = "washer" } = {}) {
	const h = host ?? createFakeHost({ objects: [P, SW], ...hostOpts });
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
	const rt = new DeviceRuntime(h, id, deviceConfig(cfg), instanceConfig(inst), sink, listener);
	return { host: h, rt, messages, events };
}

/**
 * Play values on a runtime: value, `onPower`, `tick`, then 10 s.
 *
 * @param {ReturnType<typeof runtimeSetup>} ctx context
 * @param {number[]} values power values
 */
export async function play(ctx, values) {
	for (const p of values) {
		ctx.host.setValue(P, p);
		await ctx.rt.onPower(p);
		await ctx.rt.tick();
		await ctx.host.advance(STEP);
	}
}

/**
 * Play timed points on a runtime: the clock jumps to every point, a poll runs every `stepMs`.
 *
 * @param {ReturnType<typeof runtimeSetup>} ctx context
 * @param {([number, number] | { ts: number, val: number })[]} points `[ts, value]` or `{ ts, val }` (fixtures),
 * ascending
 * @param {number} [stepMs] poll interval
 * @param {(ctx: object) => boolean} [stop] stops as soon as it returns true
 * @returns {Promise<number>} index of the next point
 */
export async function playPoints(ctx, points, stepMs = STEP, stop) {
	if (points.length === 0) {
		return 0;
	}
	const at = k => (Array.isArray(points[k]) ? points[k] : [points[k].ts, points[k].val]);
	let i = 0;
	let nextPoll = at(0)[0];
	while (i < points.length) {
		const [ts, v] = at(i);
		while (nextPoll <= ts) {
			await advanceTo(ctx.host, nextPoll);
			await ctx.rt.tick();
			nextPoll += stepMs;
			if (stop?.(ctx)) {
				return i;
			}
		}
		await advanceTo(ctx.host, ts);
		ctx.host.setValue(P, v);
		await ctx.rt.onPower(v);
		i++;
		if (stop?.(ctx)) {
			return i;
		}
	}
	return i;
}

/**
 * Move the clock of the fake host forward to `ts` (never back).
 *
 * @param {object} host fake host
 * @param {number} ts time in ms
 */
async function advanceTo(host, ts) {
	const d = ts - host.now();
	if (d > 0) {
		await host.advance(d);
	}
}

/**
 * Registry with the device `"dev"` (name "Waschmaschine", recipient `tg`), automatic optimisation on unless
 * `o.autoOptimize === false`.
 *
 * @param {object} [o] options
 * @param {object} [o.host] fake host to reuse
 * @param {object} [o.files] file io (default: in memory); null = none
 * @param {object} [o.history] history access
 * @param {string} [o.lang] language of the messages (default "de")
 * @param {object} [o.detection] detection values (default `WASHER`)
 * @param {object} [o.cfg] device fields (mixed in last)
 * @param {boolean} [o.autoOptimize] automatic optimisation
 * @param {boolean} [o.notify] send the changes of the optimisation
 * @param {object} [o.inst] instance fields
 * @param {(deviceId: string) => Promise<void>} [o.beforeOptimizeWrite] test hook between the result of an
 * optimisation and its write
 * @returns {Promise<object>} `{ host, files, inst, reg, cfg }`
 */
export async function registrySetup(o = {}) {
	const host = o.host ?? createFakeHost({ objects: { [P]: "number" } });
	const files = o.files === null ? undefined : (o.files ?? memoryFiles());
	const inst = instanceConfig(o.inst);
	const reg = new DeviceRegistry(host, new Notifier(host, () => inst.recipients), () => inst, files, {
		language: () => o.lang ?? "de",
		...(o.history ? { history: o.history } : {}),
		...(o.beforeOptimizeWrite ? { beforeOptimizeWrite: o.beforeOptimizeWrite } : {}),
	});
	const cfg = deviceConfig({
		name: "Waschmaschine",
		startText: "",
		endText: "",
		recipients: ["tg"],
		detection: o.detection ?? WASHER,
		...(o.autoOptimize === false ? {} : { autoOptimize: true }),
		...(o.notify ? { optimizeNotify: true } : {}),
		...(o.cfg ?? {}),
	});
	await reg.upsert("dev", cfg);
	return { host, files, inst, reg, cfg };
}

/**
 * Wait until the queued optimisation jobs are done (their yields run as fake timers).
 *
 * @param {object} ctx registry context
 */
export async function drain(ctx) {
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
 * Feed values through the registry, one per poll, then wait for the optimisation.
 *
 * @param {object} ctx registry context
 * @param {number[]} values power values
 * @returns {Promise<void>} done
 */
export async function feed(ctx, values) {
	for (const v of values) {
		ctx.host.setValue(P, v);
		await ctx.reg.routeForeignState(P, v);
		ctx.host.tickClock(STEP);
		await ctx.reg.tickAll();
	}
	await drain(ctx);
}

/**
 * Feed timed points through the registry (poll every `stepMs`), then wait for the optimisation.
 *
 * @param {object} ctx registry context
 * @param {[number, number][]} points `[ts, value]`, ascending
 * @param {number} [stepMs] poll interval
 */
export async function feedPoints(ctx, points, stepMs = STEP) {
	if (points.length > 0) {
		let nextPoll = points[0][0];
		for (const [ts, v] of points) {
			while (nextPoll <= ts) {
				await advanceTo(ctx.host, nextPoll);
				await ctx.reg.tickAll();
				nextPoll += stepMs;
			}
			await advanceTo(ctx.host, ts);
			ctx.host.setValue(P, v);
			await ctx.reg.routeForeignState(P, v);
		}
	}
	await drain(ctx);
}
