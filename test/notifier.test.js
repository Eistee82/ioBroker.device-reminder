import assert from "node:assert";
import { Notifier } from "../build/lib/notifier.js";

/**
 * Minimal fake host with manual timers.
 *
 * @param {object} [opts] options
 */
function makeHost(opts = {}) {
	let nowMs = opts.now ?? new Date(2026, 0, 5, 12, 0).getTime();
	let seq = 0;
	const timers = new Map();
	const values = { ...(opts.values ?? {}) };
	const objects = new Set(opts.objects ?? []);
	const host = {
		writes: [],
		sent: [],
		logs: { debug: [], info: [], warn: [], error: [] },
		log: {
			debug: m => host.logs.debug.push(m),
			info: m => host.logs.info.push(m),
			warn: m => host.logs.warn.push(m),
			error: m => host.logs.error.push(m),
		},
		async setOwnState() {},
		async getOwnState() {
			return null;
		},
		async getForeignValue(id) {
			return values[id] ?? null;
		},
		async setForeignValue(id, val) {
			host.writes.push({ id, val, at: nowMs });
			values[id] = val;
		},
		async getForeignObjectCommonType(id) {
			return objects.has(id) ? "number" : null;
		},
		sendTo(instance, command, message) {
			host.sent.push({ instance, command, message });
		},
		setTimeout(cb, ms) {
			const h = ++seq;
			timers.set(h, { cb, at: nowMs + ms });
			return h;
		},
		clearTimeout(h) {
			timers.delete(h);
		},
		now: () => nowMs,
		openTimers: () => timers.size,
		/**
		 * Run timers in time order up to and including the given elapsed ms.
		 *
		 * @param ms elapsed milliseconds
		 */
		async advance(ms) {
			const end = nowMs + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) {
					break;
				}
				timers.delete(due[0]);
				nowMs = due[1].at;
				due[1].cb();
				await new Promise(resolve => setImmediate(resolve));
			}
			nowMs = end;
		},
	};
	return host;
}

const alexa = {
	id: "alexa",
	name: "Echo",
	enabled: true,
	kind: "alexa",
	stateId: "alexa2.0.Echo.Commands.speak",
	volume: 50,
};
const telegram = { id: "tg", name: "Telegram", enabled: true, kind: "telegram", instance: "telegram.0" };

describe("Notifier", () => {
	it("do not disturb suppresses alexa but not telegram", async () => {
		const host = makeHost({ objects: ["alexa2.0.Echo.Commands.speak-volume"] });
		const n = new Notifier(host, () => [alexa, telegram]);
		const res = await n.notify(["alexa", "tg"], "Done", { doNotDisturb: true });
		assert.deepStrictEqual(res.sent, ["tg"]);
		assert.strictEqual(host.sent.length, 1);
		assert.strictEqual(host.writes.length, 0);
		n.dispose();
	});

	it("skips disabled and unknown recipients", async () => {
		const host = makeHost();
		const n = new Notifier(host, () => [{ ...telegram, enabled: false }]);
		const res = await n.notify(["tg", "nope"], "x", { doNotDisturb: false });
		assert.deepStrictEqual(res, { sent: [], skippedWindow: [] });
		assert.strictEqual(host.sent.length, 0);
	});

	it("applies the time window to every recipient", async () => {
		const host = makeHost({ now: new Date(2026, 0, 5, 22, 0).getTime() });
		const n = new Notifier(host, () => [{ ...telegram, activeFrom: "08:00", activeUntil: "20:00" }]);
		const res = await n.notify(["tg"], "x", { doNotDisturb: false });
		assert.deepStrictEqual(res, { sent: [], skippedWindow: ["tg"] });
		assert.strictEqual(host.sent.length, 0);
	});

	it("test messages ignore window and do not disturb", async () => {
		const host = makeHost({ now: new Date(2026, 0, 5, 22, 0).getTime() });
		const n = new Notifier(host, () => [{ ...telegram, activeFrom: "08:00", activeUntil: "20:00" }]);
		const res = await n.notify(["tg"], "x", { doNotDisturb: true, test: true });
		assert.deepStrictEqual(res.sent, ["tg"]);
	});

	it("voice sequence: volume at 0, text at 1000, reset at 2000 ms", async () => {
		const host = makeHost({
			objects: ["alexa2.0.Echo.Commands.speak-volume"],
			values: { "alexa2.0.Echo.Commands.speak-volume": 20 },
		});
		const n = new Notifier(host, () => [alexa]);
		const t0 = host.now();
		await n.notify(["alexa"], "Done", { doNotDisturb: false });
		assert.deepStrictEqual(
			host.writes.map(w => [w.id, w.val, w.at - t0]),
			[["alexa2.0.Echo.Commands.speak-volume", 50, 0]],
		);
		await host.advance(2000);
		assert.deepStrictEqual(
			host.writes.map(w => [w.id, w.val, w.at - t0]),
			[
				["alexa2.0.Echo.Commands.speak-volume", 50, 0],
				["alexa2.0.Echo.Commands.speak", "Done", 1000],
				["alexa2.0.Echo.Commands.speak-volume", 20, 2000],
			],
		);
		assert.strictEqual(host.openTimers(), 0);
		n.dispose();
	});

	it("empty old volume resets to 30", async () => {
		const host = makeHost({ objects: ["alexa2.0.Echo.Commands.speak-volume"] });
		const n = new Notifier(host, () => [alexa]);
		await n.notify(["alexa"], "Done", { doNotDisturb: false });
		await host.advance(2000);
		assert.strictEqual(host.writes.at(-1).val, 30);
	});

	it("sayit uses the .volume state", async () => {
		const host = makeHost({ objects: ["sayit.0.tts.volume"] });
		const n = new Notifier(host, () => [
			{ id: "s", name: "S", enabled: true, kind: "sayit", stateId: "sayit.0.tts.text", volume: 40 },
		]);
		await n.notify(["s"], "Hi", { doNotDisturb: false });
		assert.strictEqual(host.writes[0].id, "sayit.0.tts.volume");
		n.dispose();
	});

	it("missing volume state: only the speech write", async () => {
		const host = makeHost();
		const n = new Notifier(host, () => [alexa]);
		const res = await n.notify(["alexa"], "Done", { doNotDisturb: false });
		assert.deepStrictEqual(res.sent, ["alexa"]);
		assert.deepStrictEqual(
			host.writes.map(w => [w.id, w.val]),
			[["alexa2.0.Echo.Commands.speak", "Done"]],
		);
		assert.strictEqual(host.openTimers(), 0);
	});

	it("a new output replaces the running one and keeps the original volume", async () => {
		const vol = "alexa2.0.Echo.Commands.speak-volume";
		const host = makeHost({ objects: [vol], values: { [vol]: 20 } });
		const n = new Notifier(host, () => [alexa]);
		await n.notify(["alexa"], "One", { doNotDisturb: false });
		await host.advance(500);
		await n.notify(["alexa"], "Two", { doNotDisturb: false });
		await host.advance(2000);
		const speaks = host.writes.filter(w => w.id.endsWith(".speak")).map(w => w.val);
		assert.deepStrictEqual(speaks, ["Two"]);
		assert.strictEqual(host.writes.at(-1).val, 20);
		assert.strictEqual(host.openTimers(), 0);
	});

	it("dispose before 2000 ms leaves no timers and no writes", async () => {
		const vol = "alexa2.0.Echo.Commands.speak-volume";
		const host = makeHost({ objects: [vol] });
		const n = new Notifier(host, () => [alexa]);
		await n.notify(["alexa"], "Done", { doNotDisturb: false });
		const before = host.writes.length;
		n.dispose();
		assert.strictEqual(host.openTimers(), 0);
		await host.advance(3000);
		assert.strictEqual(host.writes.length, before);
	});

	it("nextWindowStartFor returns the earliest start of active recipients", () => {
		const host = makeHost();
		const n = new Notifier(host, () => [
			{ ...telegram, id: "a", activeFrom: "08:00", activeUntil: "10:00" },
			{ ...telegram, id: "b", activeFrom: "14:00", activeUntil: "16:00" },
			{ ...telegram, id: "c", enabled: false, activeFrom: "12:30", activeUntil: "13:00" },
		]);
		const now = new Date(2026, 0, 5, 12, 0);
		const next = n.nextWindowStartFor(["a", "b", "c", "zzz"], now);
		assert.strictEqual(next.getHours(), 14);
		assert.strictEqual(n.nextWindowStartFor(["zzz"], now), null);
	});

	it("sendTest reports unknown recipients and succeeds for known ones", async () => {
		const host = makeHost();
		const n = new Notifier(host, () => [telegram]);
		assert.strictEqual((await n.sendTest("nope")).ok, false);
		assert.deepStrictEqual(await n.sendTest("tg"), { ok: true });
		assert.strictEqual(host.sent.length, 1);
	});
});
