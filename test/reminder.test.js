import assert from "node:assert";
import { Notifier } from "../build/lib/notifier.js";
import { ReminderScheduler } from "../build/lib/reminder.js";

/**
 * Minimal fake host with manual timers.
 *
 * @param {number} start start time in ms
 */
function makeHost(start) {
	let nowMs = start;
	let seq = 0;
	const timers = new Map();
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
		async getForeignValue() {
			return null;
		},
		async setForeignValue(id, val) {
			host.writes.push({ id, val });
		},
		async getForeignObjectCommonType() {
			return "boolean";
		},
		sendTo(instance, command, message) {
			host.sent.push({ at: nowMs, instance, command, message });
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

const MIN = 60_000;
const tg = { id: "tg", name: "Telegram", enabled: true, kind: "telegram", instance: "telegram.0" };

/**
 * Build scheduler setup.
 *
 * @param {object} o options
 */
function setup(o = {}) {
	const host = makeHost(o.start ?? new Date(2026, 0, 5, 12, 0).getTime());
	const notifier = new Notifier(host, () => [{ ...tg, ...(o.recipient ?? {}) }]);
	const cfg = {
		recipients: ["tg"],
		actions: o.actions ?? [],
		reminder: { enabled: true, intervalMin: 30, maxCount: 3, text: "", ackStateId: "", ...(o.reminder ?? {}) },
	};
	const s = new ReminderScheduler(host, notifier, () => ({ cfg, text: "Done", doNotDisturb: false }));
	return { host, s };
}

describe("ReminderScheduler", () => {
	it("never sends when disabled", async () => {
		const { host, s } = setup({ reminder: { enabled: false } });
		s.onFinished();
		await host.advance(600 * MIN);
		assert.strictEqual(host.sent.length, 0);
		assert.strictEqual(s.active, false);
		assert.strictEqual(host.openTimers(), 0);
	});

	it("sends exactly maxCount reminders at 30/60/90 min", async () => {
		const { host, s } = setup();
		s.onFinished();
		await host.advance(29 * MIN);
		assert.strictEqual(host.sent.length, 0);
		await host.advance(600 * MIN);
		assert.strictEqual(host.sent.length, 3);
		const t0 = new Date(2026, 0, 5, 12, 0).getTime();
		assert.deepStrictEqual(
			host.sent.map(x => (x.at - t0) / MIN),
			[30, 60, 90],
		);
		assert.strictEqual(s.active, false);
		assert.strictEqual(host.openTimers(), 0);
	});

	it("skips a reminder outside the window without counting it", async () => {
		const { host, s } = setup({
			start: new Date(2026, 0, 5, 19, 50).getTime(),
			recipient: { activeFrom: "07:00", activeUntil: "20:00" },
		});
		s.onFinished();
		await host.advance(35 * MIN); // 20:25, first try is out of window
		assert.strictEqual(host.sent.length, 0);
		assert.strictEqual(s.sentCount, 0);
		assert.strictEqual(s.active, true);
		await host.advance(10 * 60 * MIN); // 06:25 next day
		assert.strictEqual(host.sent.length, 0);
		await host.advance(40 * MIN); // 07:05
		assert.strictEqual(host.sent.length, 1);
		assert.strictEqual(new Date(host.sent[0].at).getHours(), 7);
		assert.strictEqual(s.sentCount, 1);
	});

	it("acknowledge stops further reminders", async () => {
		const { host, s } = setup();
		s.onFinished();
		await host.advance(31 * MIN);
		assert.strictEqual(host.sent.length, 1);
		s.acknowledge();
		await host.advance(600 * MIN);
		assert.strictEqual(host.sent.length, 1);
		assert.strictEqual(s.active, false);
	});

	it("a restart stops the cycle", async () => {
		const { host, s } = setup();
		s.onFinished();
		s.onStarted();
		await host.advance(600 * MIN);
		assert.strictEqual(host.sent.length, 0);
	});

	it("runs reminder and acknowledged actions", async () => {
		const { host, s } = setup({
			actions: [
				{ event: "reminder", stateId: "lamp.on", value: "true" },
				{ event: "acknowledged", stateId: "lamp.on", value: "false" },
			],
		});
		s.onFinished();
		await host.advance(31 * MIN);
		assert.deepStrictEqual(host.writes, [{ id: "lamp.on", val: true }]);
		s.acknowledge();
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(host.writes[1], { id: "lamp.on", val: false });
	});

	it("dispose leaves no open timers", async () => {
		const { host, s } = setup();
		s.onFinished();
		assert.strictEqual(host.openTimers(), 1);
		s.dispose();
		assert.strictEqual(host.openTimers(), 0);
		await host.advance(600 * MIN);
		assert.strictEqual(host.sent.length, 0);
	});
});
