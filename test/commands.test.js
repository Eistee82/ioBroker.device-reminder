import assert from "node:assert";
import { DEFAULT_REMINDER, normalizeInstanceConfig } from "../build/lib/config.js";
import { handleCommand } from "../build/lib/commands.js";
import { DeviceRegistry } from "../build/lib/deviceRegistry.js";
import { Notifier } from "../build/lib/notifier.js";
import { createFakeHost } from "./helpers/fakeHost.js";

const P1 = "plug.0.power";

function makeCfg(over = {}) {
	return {
		enabled: true,
		name: "Washer",
		typeId: "washing-machine",
		powerId: P1,
		startText: "",
		endText: "",
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

async function setup() {
	const host = createFakeHost({ objects: { [P1]: "number" }, values: { [P1]: 3 } });
	const inst = normalizeInstanceConfig({
		recipients: [{ id: "tg", name: "Telegram", enabled: true, kind: "telegram", instance: "telegram.0" }],
	}).config;
	const notifier = new Notifier(host, () => inst.recipients);
	const reg = new DeviceRegistry(host, notifier, () => inst);
	await reg.upsert("washer", makeCfg());
	return { host, inst, notifier, reg };
}

describe("handleCommand", () => {
	it("list returns id and name of all devices", async () => {
		const { reg, notifier } = await setup();
		assert.deepStrictEqual(await handleCommand(reg, notifier, "list", {}), [{ id: "washer", name: "Washer" }]);
	});

	it("status returns the main states", async () => {
		const { reg, notifier, inst } = await setup();
		assert.deepStrictEqual(await handleCommand(reg, notifier, "status", { deviceId: "washer" }), {
			status: inst.statusTexts.off,
			running: false,
			finished: false,
			consumption: 3,
			runtime: "00:00:00",
		});
		assert.deepStrictEqual(await handleCommand(reg, notifier, "status", { deviceId: "nope" }), {
			error: "unknownDevice",
		});
		assert.deepStrictEqual(await handleCommand(reg, notifier, "status", null), { error: "unknownDevice" });
	});

	it("acknowledge resets finished", async () => {
		const { reg, notifier, host } = await setup();
		await host.setOwnState("washer.finished", true);
		assert.deepStrictEqual(await handleCommand(reg, notifier, "acknowledge", { deviceId: "washer" }), { ok: true });
		assert.strictEqual(host.own("washer.finished"), false);
		assert.deepStrictEqual(await handleCommand(reg, notifier, "acknowledge", { deviceId: "x" }), {
			error: "unknownDevice",
		});
	});

	it("setDnd switches do-not-disturb", async () => {
		const { reg, notifier, host } = await setup();
		assert.deepStrictEqual(await handleCommand(reg, notifier, "setDnd", { deviceId: "washer", value: true }), {
			ok: true,
		});
		assert.strictEqual(reg.get("washer").doNotDisturb, true);
		assert.strictEqual(host.own("washer.config.doNotDisturb"), true);
		await handleCommand(reg, notifier, "setDnd", { deviceId: "washer", value: false });
		assert.strictEqual(reg.get("washer").doNotDisturb, false);
		assert.deepStrictEqual(await handleCommand(reg, notifier, "setDnd", { deviceId: "x", value: true }), {
			error: "unknownDevice",
		});
	});

	it("testRecipient sends a test message", async () => {
		const { reg, notifier, host } = await setup();
		assert.deepStrictEqual(await handleCommand(reg, notifier, "testRecipient", { id: "tg" }), { ok: true });
		assert.strictEqual(host.sent.length, 1);
		assert.strictEqual(host.sent[0].instance, "telegram.0");
		const missing = await handleCommand(reg, notifier, "testRecipient", { id: "nope" });
		assert.strictEqual(missing.ok, false);
		assert.deepStrictEqual(await handleCommand(reg, notifier, "testRecipient", {}), {
			ok: false,
			error: "missingRecipient",
		});
	});

	it("testRecipient tests an unsaved row of the settings", async () => {
		const { reg, notifier, host } = await setup();
		const row = { name: "New", enabled: true, instance: "telegram.1", telegramTarget: "chatId", target: "-100" };
		assert.deepStrictEqual(await handleCommand(reg, notifier, "testRecipient", { recipient: row }), { ok: true });
		const last = host.sent.at(-1);
		assert.strictEqual(last.instance, "telegram.1");
		assert.deepStrictEqual(last.message, { text: "Test message from device-reminder", chatId: "-100" });
		const bad = await handleCommand(reg, notifier, "testRecipient", { recipient: { name: "x" } });
		assert.strictEqual(bad.ok, false);
	});

	it("select commands answer with the choices of the installation", async () => {
		const { reg, notifier } = await setup();
		const env = {
			instances: async () => ["telegram.0", "admin.0"],
			stateIds: async () => ["alexa2.0.Echo-Devices.G1.Commands.speak"],
			objectName: async () => "Küche",
			objectNative: async () => ({}),
			stateValue: async () => JSON.stringify({ 1: { firstName: "Anna" } }),
		};
		assert.deepStrictEqual(await handleCommand(reg, notifier, "getMessengerInstances", {}, env), [
			{ label: "Telegram (telegram.0)", value: "telegram.0" },
		]);
		assert.deepStrictEqual(await handleCommand(reg, notifier, "getAlexaDevices", { instance: "alexa2.0" }, env), [
			{ label: "Küche (G1)", value: "alexa2.0.Echo-Devices.G1.Commands.speak" },
		]);
		assert.deepStrictEqual(
			await handleCommand(reg, notifier, "getTelegramTargets", { instance: "telegram.0", target: "user" }, env),
			[{ label: "Anna", value: "Anna" }],
		);
	});

	it("unknown command returns an error", async () => {
		const { reg, notifier } = await setup();
		assert.deepStrictEqual(await handleCommand(reg, notifier, "foo", {}), { error: "unknownCommand" });
	});
});
