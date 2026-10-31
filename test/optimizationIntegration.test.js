import assert from "node:assert";
import { DEFAULT_REMINDER, normalizeInstanceConfig } from "../build/lib/config.js";
import { DeviceRegistry, formatDate } from "../build/lib/deviceRegistry.js";
import { fill, TEXT } from "../build/lib/dmTexts.js";
import { Notifier } from "../build/lib/notifier.js";
import { createFakeHost } from "./helpers/fakeHost.js";
import { memoryFiles } from "./helpers/files.js";
import { washingMachine } from "./helpers/curves.js";
import { historyOf } from "./helpers/history.js";
import { runOf } from "./helpers/programmes.js";

const P = "plug.0.power";
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
 * @param {object} [o] options
 * @returns {Promise<object>} context
 */
async function setup(o = {}) {
	const host = o.host ?? createFakeHost({ objects: { [P]: "number" } });
	const files = o.files ?? memoryFiles();
	const inst = normalizeInstanceConfig({
		pollIntervalSec: 10,
		recipients: [{ id: "tg", name: "Telegram", enabled: true, kind: "telegram", instance: "telegram.0" }],
	}).config;
	const reg = new DeviceRegistry(host, new Notifier(host, () => inst.recipients), () => inst, files, {
		language: () => o.lang ?? "de",
		...(o.history ? { history: o.history } : {}),
	});
	const cfg = {
		enabled: true,
		name: "Waschmaschine",
		typeId: o.typeId ?? "washing-machine",
		powerId: P,
		startText: "",
		endText: "",
		abort: false,
		abortFixed: false,
		autoOff: false,
		autoOffMinutes: 0,
		recipients: ["tg"],
		reminder: { ...DEFAULT_REMINDER },
		actions: [],
		...(o.autoOptimize === false ? {} : { autoOptimize: true }),
		...(o.notify ? { optimizeNotify: true } : {}),
	};
	await reg.upsert("dev", cfg);
	return { host, files, inst, reg, cfg };
}

/**
 * Wait until the queued jobs are done (their yields run as fake timers).
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
 * Feed values through the registry, one per poll.
 *
 * @param {object} ctx context
 * @param {number[]} values power values
 */
async function play(ctx, values) {
	for (const v of values) {
		ctx.host.setValue(P, v);
		await ctx.reg.routeForeignState(P, v);
		ctx.host.tickClock(STEP);
		await ctx.reg.tickAll();
	}
	await drain(ctx);
}

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

	it("does not read the history while the optimisation is off", async () => {
		const history = historyEnv([]);
		const ctx = await setup({ history, autoOptimize: false });
		await drain(ctx);
		assert.strictEqual(ctx.reg.learningData("dev"), null);
		assert.strictEqual(await ctx.reg.readLearningData("dev"), null);
		assert.strictEqual(ctx.files.writes, 0);
	});

	it("discards a stored run, keeps the extremes and reads the data while the optimisation is off", async () => {
		const ctx = await setup({ typeId: "dryer" });
		const run = runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 3, after: 400 });
		await play(ctx, run.values);
		const store = ctx.reg.learningData("dev");
		const ids = [...store.runs, ...store.spikes].map(r => r.id);
		assert.ok(ids.length > 0, "a run was stored");
		const envelope = { ...store.envelope };
		const check = await ctx.reg.checkStoredRuns("dev");
		assert.strictEqual(check.perRun.length, store.runs.length);

		assert.strictEqual(await ctx.reg.discardRun("dev", "nope"), false);
		assert.strictEqual(await ctx.reg.discardRun("dev", ids[0]), true);
		const after = ctx.reg.learningData("dev");
		assert.ok(![...after.runs, ...after.spikes].some(r => r.id === ids[0]));
		assert.deepStrictEqual(after.envelope, envelope, "the envelope never shrinks");

		// switched off: the data stays in the file and can still be read
		await ctx.reg.upsert("dev", { ...ctx.cfg, autoOptimize: undefined });
		assert.strictEqual(ctx.reg.learningData("dev"), null);
		assert.strictEqual(await ctx.reg.checkStoredRuns("dev"), null);
		assert.strictEqual(await ctx.reg.discardRun("dev", ids[0]), false);
		const read = await ctx.reg.readLearningData("dev");
		assert.strictEqual(read.runs.length + read.spikes.length, ids.length - 1);
		await ctx.reg.deleteLearningData("dev");
		assert.strictEqual(await ctx.reg.readLearningData("dev"), null);
	});

	it("sends the changes in the language of the installation and logs them in English", async () => {
		const ctx = await setup({ typeId: "dryer", notify: true, lang: "de" });
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

	it("sends nothing without the message option", async () => {
		const ctx = await setup({ typeId: "dryer" });
		const run = runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 3, after: 400 });
		await play(ctx, run.values);
		assert.strictEqual(ctx.reg.learningData("dev").changes.at(-1)?.kind, "repair");
		assert.ok(!ctx.host.sent.some(s => JSON.stringify(s.message).includes("detection")));
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
			fill(TEXT.optTypeChanged, "en"),
			"{device}: device type changed, optimised values discarded.",
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
