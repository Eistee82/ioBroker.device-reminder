import assert from "node:assert";
import { readFileSync } from "node:fs";
import { completeRecipientRow, normalizeInstanceConfig } from "../build/lib/config.js";
import { MESSENGER_ADAPTERS, defaultInstance, kindFromInstance } from "../build/lib/messenger/adapters.js";
import { alexaDeviceChoices, messengerInstanceChoices, telegramTargetChoices } from "../build/lib/messenger/choices.js";
import { isInWindow } from "../build/lib/utils.js";

const cfg = JSON.parse(readFileSync(new URL("../admin/jsonConfig.json", import.meta.url), "utf8"));
const items = cfg.items._tabRecipients.items.recipients.items;

/**
 * Attributes visible for a recipient row (evaluates the `hidden` expressions of our own jsonConfig like admin).
 *
 * @param {object} data - Recipient row
 */
function visible(data) {
	return items
		.filter(it => !it.hidden || !new Function("data", `return (${it.hidden});`)(data))
		.map(it => it.attr || it.type);
}

const COMMON = ["enabled", "name", "instance", "activeFrom", "activeUntil", "sendTo"];

/**
 * Fake installation.
 *
 * @param {object} [o] - Content
 */
function env(o = {}) {
	return {
		instances: async () => o.instances ?? [],
		stateIds: async prefix => (o.states ?? []).filter(id => id.startsWith(prefix)),
		objectName: async id => (o.names ?? {})[id],
		stateValue: async id => (o.values ?? {})[id],
	};
}

describe("recipient settings UI", () => {
	const expected = {
		"alexa2.0": ["stateId", "volume", "volumeStateId"],
		"sayit.0": ["volume", "volumeStateId"],
		"whatsapp-cmb.0": [],
		"telegram.0": ["telegramTarget"],
		"pushover.0": ["title", "device", "priority", "sound", "ttl"],
		"signal-cmb.0": [],
		"email.0": ["emailFrom", "emailTo"],
		"matrix-org.0": [],
		"discord.0": ["userId", "userTag", "userName", "serverId", "channelId"],
		"ntfy.0": ["title", "priority", "topic"],
		"pushsafer.0": ["title", "device", "priority", "sound"],
		"gotify.0": ["title", "priority"],
	};
	for (const [instance, fields] of Object.entries(expected)) {
		it(`shows only the fields used by ${instance}`, () => {
			assert.deepStrictEqual(visible({ instance }).sort(), [...COMMON, ...fields].sort());
		});
	}

	it("has no field to type an id and no free state input", () => {
		assert.ok(!items.some(i => i.attr === "id"));
		assert.ok(!items.some(i => i.attr === "kind"));
		assert.ok(!items.some(i => i.type === "text" && /state/i.test(i.attr)));
	});

	it("messenger, echo device and telegram target are selects filled by the adapter", () => {
		const byAttr = Object.fromEntries(items.map(i => [i.attr, i]));
		assert.strictEqual(byAttr.instance.command, "getMessengerInstances");
		assert.strictEqual(byAttr.stateId.command, "getAlexaDevices");
		assert.strictEqual(byAttr.target.command, "getTelegramTargets");
		assert.strictEqual(byAttr.volumeStateId.type, "objectId");
	});

	it("shows the telegram target only for user or chat id", () => {
		assert.ok(!visible({ instance: "telegram.0", telegramTarget: "none" }).includes("target"));
		assert.ok(visible({ instance: "telegram.0", telegramTarget: "user" }).includes("target"));
	});
});

describe("messenger adapters", () => {
	it("maps instances to kinds and back", () => {
		assert.strictEqual(kindFromInstance("alexa2.1"), "alexa");
		assert.strictEqual(kindFromInstance("matrix-org.0"), "matrix");
		assert.strictEqual(kindFromInstance("admin.0"), undefined);
		assert.strictEqual(defaultInstance("signal"), "signal-cmb.0");
		assert.strictEqual(Object.keys(MESSENGER_ADAPTERS).length, 12);
	});
});

describe("completeRecipientRow", () => {
	it("derives the kind from the chosen instance", () => {
		assert.deepStrictEqual(completeRecipientRow({ id: "a", instance: "telegram.0" }), {
			id: "a",
			instance: "telegram.0",
			kind: "telegram",
		});
	});

	it("the kind follows a changed instance", () => {
		assert.strictEqual(completeRecipientRow({ kind: "alexa", instance: "pushover.0" }).kind, "pushover");
	});

	it("sets the fixed text state of SayIt and WhatsApp", () => {
		assert.strictEqual(completeRecipientRow({ instance: "sayit.1" }).stateId, "sayit.1.tts.text");
		assert.strictEqual(completeRecipientRow({ instance: "whatsapp-cmb.0" }).stateId, "whatsapp-cmb.0.sendMessage");
	});

	it("takes the instance of old rows from the speech state", () => {
		const row = completeRecipientRow({ kind: "alexa", stateId: "alexa2.1.Echo-Devices.G1.Commands.speak" });
		assert.strictEqual(row.instance, "alexa2.1");
	});

	it("returns the same object when nothing is missing", () => {
		const row = { kind: "email", instance: "email.0" };
		assert.strictEqual(completeRecipientRow(row), row);
	});

	it("completed rows are written back to the native", () => {
		const { idPatch, config } = normalizeInstanceConfig({
			recipients: [{ id: "x", name: "S", instance: "sayit.0" }],
		});
		assert.strictEqual(idPatch.recipients[0].kind, "sayit");
		assert.strictEqual(config.recipients[0].stateId, "sayit.0.tts.text");
	});
});

describe("choices for the admin UI", () => {
	it("lists the installed messenger instances only", async () => {
		const e = env({ instances: ["admin.0", "telegram.0", "alexa2.0", "discord.1"] });
		assert.deepStrictEqual(await messengerInstanceChoices(e), [
			{ label: "Alexa (alexa2.0)", value: "alexa2.0" },
			{ label: "Discord (discord.1)", value: "discord.1" },
			{ label: "Telegram (telegram.0)", value: "telegram.0" },
		]);
	});

	it("keeps the instance of the edited recipient when it is gone", async () => {
		assert.deepStrictEqual(await messengerInstanceChoices(env(), "pushover.0"), [
			{ label: "Pushover (pushover.0, not installed)", value: "pushover.0" },
		]);
	});

	it("lists the echo devices with their speak state", async () => {
		const e = env({
			states: [
				"alexa2.0.Echo-Devices.G1.Commands.speak",
				"alexa2.0.Echo-Devices.G1.Commands.speak-volume",
				"alexa2.0.Echo-Devices.G2.Commands.speak",
				"alexa2.0.Echo-Devices.G2.Player.volume",
			],
			names: { "alexa2.0.Echo-Devices.G1": "Küche", "alexa2.0.Echo-Devices.G2": "Wohnzimmer" },
		});
		assert.deepStrictEqual(await alexaDeviceChoices(e, "alexa2.0"), [
			{ label: "Küche (G1)", value: "alexa2.0.Echo-Devices.G1.Commands.speak" },
			{ label: "Wohnzimmer (G2)", value: "alexa2.0.Echo-Devices.G2.Commands.speak" },
		]);
		assert.deepStrictEqual(await alexaDeviceChoices(e, "telegram.0"), []);
	});

	it("lists telegram users and chats", async () => {
		const users = JSON.stringify({ 123: { firstName: "Anna", userName: "anna" }, "-100": { firstName: "Family" } });
		const e = env({ values: { "telegram.0.communicate.users": users } });
		assert.deepStrictEqual(await telegramTargetChoices(e, "telegram.0", "user"), [
			{ label: "Anna @anna", value: "anna" },
			{ label: "Family", value: "Family" },
		]);
		assert.deepStrictEqual(await telegramTargetChoices(e, "telegram.0", "chatId"), [
			{ label: "Anna @anna (123)", value: "123" },
			{ label: "Family (-100)", value: "-100" },
		]);
		assert.deepStrictEqual(await telegramTargetChoices(env(), "telegram.0", "user"), []);
	});
});

describe("time window", () => {
	it("equal start and end (default 00:00 - 00:00) means no restriction", () => {
		assert.strictEqual(isInWindow(new Date(2026, 0, 1, 12, 0), "00:00", "00:00"), true);
		assert.strictEqual(isInWindow(new Date(2026, 0, 1, 3, 0), "07:00", "07:00"), true);
	});
});
