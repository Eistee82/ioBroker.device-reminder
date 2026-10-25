import assert from "node:assert";
import { readFileSync } from "node:fs";
import { MESSENGER_ADAPTERS, defaultInstance, messengerKindOptions } from "../build/lib/messenger/adapters.js";

const cfg = JSON.parse(readFileSync(new URL("../admin/jsonConfig.json", import.meta.url), "utf8"));
const items = cfg.items._tabRecipients.items.recipients.items;

/**
 * Attributes visible for a recipient (evaluates the jsonConfig `hidden` expressions like admin does).
 *
 * @param {object} data - Recipient row
 */
function visible(data) {
	return items
		.filter(it => !it.hidden || !new Function("data", `return (${it.hidden});`)(data))
		.map(it => (it.type === "instance" ? `instance:${it.adapter}` : it.attr || it.type));
}

const COMMON = ["enabled", "name", "kind", "id", "activeFrom", "activeUntil", "sendTo"];

describe("recipient settings UI", () => {
	const expected = {
		alexa: ["stateId", "volume", "volumeStateId"],
		sayit: ["stateId", "volume", "volumeStateId"],
		whatsapp: ["stateId"],
		telegram: ["instance:telegram", "telegramTarget"],
		pushover: ["instance:pushover", "title", "device", "priority", "sound", "ttl"],
		signal: ["instance:signal-cmb"],
		email: ["instance:email", "emailFrom", "emailTo"],
		matrix: ["instance:matrix-org"],
		discord: ["instance:discord", "userId", "userTag", "userName", "serverId", "channelId"],
		ntfy: ["instance:ntfy", "title", "priority", "topic"],
		pushsafer: ["instance:pushsafer", "title", "device", "priority", "sound"],
		gotify: ["instance:gotify", "title", "priority"],
	};
	for (const [kind, fields] of Object.entries(expected)) {
		it(`shows only the fields used by ${kind}`, () => {
			assert.deepStrictEqual(visible({ kind }).sort(), [...COMMON, ...fields].sort());
		});
	}

	it("shows the telegram target only for user or chat id", () => {
		assert.ok(!visible({ kind: "telegram", telegramTarget: "none" }).includes("target"));
		assert.ok(visible({ kind: "telegram", telegramTarget: "user" }).includes("target"));
		assert.ok(visible({ kind: "telegram", telegramTarget: "chatId" }).includes("target"));
	});

	it("state fields open the object browser for states", () => {
		for (const attr of ["stateId", "volumeStateId"]) {
			const it2 = items.find(i => i.attr === attr);
			assert.strictEqual(it2.type, "objectId");
			assert.strictEqual(it2.types, "state");
		}
	});

	it("the messenger select asks the adapter for the installed messengers", () => {
		const kind = items.find(i => i.attr === "kind");
		assert.strictEqual(kind.type, "selectSendTo");
		assert.strictEqual(kind.command, "getMessengerKinds");
	});

	it("instance pickers use the real adapter names", () => {
		const adapters = items.filter(i => i.type === "instance").map(i => i.adapter);
		for (const a of adapters) {
			assert.ok(
				Object.values(MESSENGER_ADAPTERS).some(m => m.adapter === a),
				`unknown adapter ${a}`,
			);
		}
	});
});

describe("messengerKindOptions", () => {
	it("lists only installed messengers", () => {
		assert.deepStrictEqual(messengerKindOptions(new Set(["telegram", "alexa2", "admin"])), [
			{ label: "Alexa", value: "alexa" },
			{ label: "Telegram", value: "telegram" },
		]);
	});

	it("keeps the kind of the edited recipient even if its adapter is missing", () => {
		assert.deepStrictEqual(messengerKindOptions(new Set(), "discord"), [
			{ label: "Discord (not installed)", value: "discord" },
		]);
	});

	it("knows the default instances", () => {
		assert.strictEqual(defaultInstance("matrix"), "matrix-org.0");
		assert.strictEqual(defaultInstance("signal"), "signal-cmb.0");
		assert.strictEqual(defaultInstance("unknown"), "");
	});
});
