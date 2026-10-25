import assert from "node:assert";
import { buildDelivery, mailSubject } from "../build/lib/messenger/payloads.js";

const base = { id: "r1", name: "R", enabled: true };

/**
 * @param {object} r recipient fields
 * @param {string} [text] message
 */
function msg(r, text = "Hello") {
	const call = buildDelivery({ ...base, ...r }, text);
	assert.ok(call && call.kind === "sendTo");
	return call;
}

describe("buildDelivery payloads", () => {
	it("returns null for alexa and sayit", () => {
		assert.strictEqual(buildDelivery({ ...base, kind: "alexa", stateId: "a.b" }, "x"), null);
		assert.strictEqual(buildDelivery({ ...base, kind: "sayit", stateId: "a.b" }, "x"), null);
	});

	it("whatsapp writes the configured state", () => {
		assert.deepStrictEqual(buildDelivery({ ...base, kind: "whatsapp", stateId: "wa.0.send" }, "Hi"), {
			kind: "setState",
			id: "wa.0.send",
			val: "Hi",
		});
	});

	it("telegram with user, chatId and without target", () => {
		const user = msg({ kind: "telegram", instance: "telegram.1", telegramTarget: "user", target: "bob" });
		assert.deepStrictEqual(user, {
			kind: "sendTo",
			instance: "telegram.1",
			command: "send",
			message: { text: "Hello", user: "bob" },
		});
		assert.deepStrictEqual(
			msg({ kind: "telegram", instance: "telegram.0", telegramTarget: "chatId", target: "-100123" }).message,
			{ text: "Hello", chatId: "-100123" },
		);
		assert.deepStrictEqual(msg({ kind: "telegram", instance: "telegram.0", telegramTarget: "none" }).message, {
			text: "Hello",
		});
	});

	it("pushover priority 0 has no retry/expire", () => {
		const m = msg({ kind: "pushover", instance: "pushover.0", priority: 0 }).message;
		assert.deepStrictEqual(m, { message: "Hello", priority: 0 });
	});

	it("pushover priority 2 adds retry and expire", () => {
		const m = msg({ kind: "pushover", instance: "pushover.0", priority: 2, sound: "bike", title: "T" }).message;
		assert.deepStrictEqual(m, {
			message: "Hello",
			sound: "bike",
			title: "T",
			priority: 2,
			retry: 60,
			expire: 3600,
		});
	});

	it("pushover omits empty ttl and sends device", () => {
		const m = msg({ kind: "pushover", instance: "pushover.0", device: "phone", ttl: undefined }).message;
		assert.deepStrictEqual(m, { message: "Hello", device: "phone" });
		const m2 = msg({ kind: "pushover", instance: "pushover.0", ttl: 120 }).message;
		assert.deepStrictEqual(m2, { message: "Hello", ttl: 120 });
	});

	it("signal uses signal-cmb instance", () => {
		assert.deepStrictEqual(msg({ kind: "signal", instance: "signal-cmb.0" }), {
			kind: "sendTo",
			instance: "signal-cmb.0",
			command: "send",
			message: { text: "Hello" },
		});
	});

	it("email", () => {
		assert.deepStrictEqual(
			msg({ kind: "email", instance: "email.0", emailTo: "a@b.c", emailFrom: "x@y.z" }).message,
			{
				text: "Hello",
				to: "a@b.c",
				subject: "Hello",
				from: "x@y.z",
			},
		);
	});

	it("matrix sends plain text", () => {
		assert.strictEqual(msg({ kind: "matrix", instance: "matrix.0" }).message, "Hello");
	});

	it("discord omits empty fields", () => {
		assert.deepStrictEqual(
			msg({ kind: "discord", instance: "discord.0", userId: "42", userTag: "", channelId: "9" }).message,
			{ content: "Hello", userId: "42", channelId: "9" },
		);
	});

	it("ntfy with topic", () => {
		assert.deepStrictEqual(msg({ kind: "ntfy", instance: "ntfy.0", topic: "laundry", priority: 4 }).message, {
			message: "Hello",
			topic: "laundry",
			priority: 4,
		});
	});

	it("pushsafer", () => {
		assert.deepStrictEqual(
			msg({ kind: "pushsafer", instance: "pushsafer.0", title: "T", device: "7", sound: "3", priority: 1 })
				.message,
			{ message: "Hello", title: "T", device: "7", sound: "3", priority: 1 },
		);
	});

	it("gotify without title has no title field", () => {
		assert.deepStrictEqual(msg({ kind: "gotify", instance: "gotify.0" }).message, { message: "Hello" });
		assert.deepStrictEqual(msg({ kind: "gotify", instance: "gotify.0", title: "T", priority: 5 }).message, {
			message: "Hello",
			title: "T",
			priority: 5,
		});
	});

	it("falls back to the default instance", () => {
		assert.strictEqual(msg({ kind: "telegram" }).instance, "telegram.0");
	});
	it("skips recipients whose required target is empty instead of broadcasting", () => {
		assert.strictEqual(buildDelivery({ ...base, kind: "telegram", telegramTarget: "user", target: "" }, "x"), null);
		assert.strictEqual(buildDelivery({ ...base, kind: "telegram", telegramTarget: "chatId" }, "x"), null);
		assert.strictEqual(buildDelivery({ ...base, kind: "discord", serverId: "s" }, "x"), null);
		assert.strictEqual(buildDelivery({ ...base, kind: "ntfy", title: "t" }, "x"), null);
	});

	it("email subject is a single line of at most 200 characters", () => {
		assert.strictEqual(mailSubject("Done\r\nBcc: evil@example.com"), "Done Bcc: evil@example.com");
		assert.strictEqual(mailSubject("x".repeat(300)).length, 200);
		const m = msg({ kind: "email", emailTo: "a@b.c" }, "Line1\nLine2").message;
		assert.strictEqual(m.subject, "Line1 Line2");
		assert.strictEqual(m.text, "Line1\nLine2");
	});
});
