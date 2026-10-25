import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
const BLOCKS = ["device_reminder_status", "device_reminder_acknowledge", "device_reminder_dnd", "device_reminder_test"];
const source = fs.readFileSync(path.join(process.cwd(), "admin", "blockly.js"), "utf8");

function load(generatorStyle) {
	const generator = {
		ORDER_ATOMIC: 0,
		ORDER_MEMBER: 1,
		forBlock: {},
		valueToCode: (block, name) => block.values?.[name] ?? "",
	};
	const Blockly = {
		Blocks: {},
		Words: {},
		Sendto: { blocks: {} },
		FieldDropdown: function () {},
		FieldTextInput: function () {},
	};
	const sandbox = {
		Blockly,
		systemLang: "en",
		main: { instances: ["system.adapter.device-reminder.0"], objects: {} },
	};
	if (generatorStyle === "legacy") {
		Blockly.JavaScript = generator;
	} else {
		sandbox.javascript = { javascriptGenerator: generator };
	}
	vm.runInNewContext(source, sandbox);
	return { Blockly, generator };
}

function fakeBlock(fields, values) {
	return { values, getFieldValue: name => fields[name] };
}

describe("blockly blocks", () => {
	for (const style of ["legacy", "modern"]) {
		describe(`generator ${style}`, () => {
			it("registers 4 blocks and generators", () => {
				const { Blockly, generator } = load(style);
				assert.deepStrictEqual(Object.keys(Blockly.Blocks).sort(), [...BLOCKS].sort());
				for (const name of BLOCKS) {
					assert.strictEqual(typeof generator.forBlock[name], "function", name);
					assert.ok(Blockly.Sendto.blocks[name], name);
				}
			});

			it("acknowledge generates sendTo", () => {
				const { generator } = load(style);
				const block = fakeBlock({ INSTANCE: "0", DEVICE: "trockner" });
				assert.strictEqual(
					generator.forBlock.device_reminder_acknowledge(block, generator).trim(),
					'sendTo("device-reminder.0", "acknowledge", {"deviceId": "trockner"});',
				);
			});

			it("dnd generates sendTo with value", () => {
				const { generator } = load(style);
				const block = fakeBlock({ INSTANCE: "1", DEVICE: "a" }, { VALUE: "true" });
				assert.strictEqual(
					generator.forBlock.device_reminder_dnd(block, generator).trim(),
					'sendTo("device-reminder.1", "setDnd", {"deviceId": "a", "value": true});',
				);
			});

			it("test generates sendTo with recipient id", () => {
				const { generator } = load(style);
				const block = fakeBlock({ INSTANCE: "0", RECIPIENT: "r1" });
				assert.strictEqual(
					generator.forBlock.device_reminder_test(block, generator).trim(),
					'sendTo("device-reminder.0", "testRecipient", {"id": "r1"});',
				);
			});

			it("status reads the status state", () => {
				const { generator } = load(style);
				const block = fakeBlock({ INSTANCE: "0", DEVICE: "trockner" });
				const [code] = generator.forBlock.device_reminder_status(block, generator);
				assert.strictEqual(code, 'getState("device-reminder.0.trockner.status").val');
			});
		});
	}

	it("has texts in 11 languages for every block", () => {
		const { Blockly } = load("legacy");
		const keys = BLOCKS.flatMap(name => [name, `${name}_tooltip`]).concat("device_reminder_recipient_id");
		for (const key of keys) {
			assert.ok(Blockly.Words[key], key);
			for (const lang of LANGS) {
				assert.ok(Blockly.Words[key][lang], `${key} ${lang}`);
			}
		}
	});
});
