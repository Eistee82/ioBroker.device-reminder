import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
const BLOCKS = ["device_reminder_send"];
const source = fs.readFileSync(path.join(process.cwd(), "admin", "blockly.js"), "utf8");

function load(generatorStyle, { withOid = true, objects = {} } = {}) {
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
		FieldDropdown: function (options) {
			this.kind = "dropdown";
			this.options = options;
		},
		FieldTextInput: function (value) {
			this.kind = "text";
			this.value = value;
		},
	};
	if (withOid) {
		Blockly.FieldOID = function (value, filter) {
			this.kind = "oid";
			this.value = value;
			this.filter = filter;
		};
	}
	const sandbox = {
		Blockly,
		systemLang: "en",
		main: { instances: ["system.adapter.device-reminder.0"], objects },
	};
	if (generatorStyle === "legacy") {
		Blockly.JavaScript = generator;
	} else {
		sandbox.javascript = { javascriptGenerator: generator };
	}
	vm.runInNewContext(source, sandbox);
	return { Blockly, generator };
}

/**
 * Block as created by Blockly: collects the fields appended in init().
 *
 * @param {object} Blockly fake Blockly of load()
 * @param {string} name block type
 * @param {string} [instanceValue] value of the INSTANCE field
 */
function initBlock(Blockly, name, instanceValue = "0") {
	const fields = {};
	const input = {
		appendField(field, fieldName) {
			if (fieldName) {
				fields[fieldName] = field;
			}
			return input;
		},
		setCheck: () => input,
	};
	const block = {
		...Blockly.Blocks[name],
		fields,
		appendDummyInput: () => input,
		appendValueInput: () => input,
		setOutput() {},
		setPreviousStatement() {},
		setNextStatement() {},
		setColour() {},
		setTooltip() {},
		getFieldValue: fieldName => (fieldName === "INSTANCE" ? instanceValue : undefined),
	};
	block.init();
	return block;
}

function fakeBlock(fields, values) {
	return { values, getFieldValue: name => fields[name] };
}

describe("blockly blocks", () => {
	for (const style of ["legacy", "modern"]) {
		describe(`generator ${style}`, () => {
			it("registers the send block and its generator", () => {
				const { Blockly, generator } = load(style);
				assert.deepStrictEqual(Object.keys(Blockly.Blocks).sort(), [...BLOCKS].sort());
				for (const name of BLOCKS) {
					assert.strictEqual(typeof generator.forBlock[name], "function", name);
					assert.ok(Blockly.Sendto.blocks[name], name);
				}
			});

			it("send generates sendTo with recipient and text", () => {
				const { generator } = load(style);
				const block = fakeBlock({ INSTANCE: "1", RECIPIENT: "r1" }, { TEXT: '"Hallo"' });
				assert.strictEqual(
					generator.forBlock.device_reminder_send(block, generator).trim(),
					'sendTo("device-reminder.1", "send", {"recipients": "r1", "text": "Hallo"});',
				);
				const empty = fakeBlock({ INSTANCE: "0", RECIPIENT: "*" });
				assert.strictEqual(
					generator.forBlock.device_reminder_send(empty, generator).trim(),
					'sendTo("device-reminder.0", "send", {"recipients": "*", "text": ""});',
				);
			});
		});
	}

	describe("recipient fields", () => {
		it("lists the recipients of the instance object as [name, id] pairs", () => {
			const objects = {
				"system.adapter.device-reminder.0": {
					native: {
						recipients: [
							{ id: "telegram-abc1", name: "Anna" },
							{ id: "pushover-def2", name: "" },
						],
					},
				},
			};
			const { Blockly } = load("modern", { objects });
			const block = initBlock(Blockly, "device_reminder_send");
			assert.strictEqual(block.fields.RECIPIENT.kind, "dropdown");
			assert.deepStrictEqual(JSON.parse(JSON.stringify(block.fields.RECIPIENT.options())), [
				["all recipients", "*"],
				["Anna (telegram-abc1)", "telegram-abc1"],
				["pushover-def2", "pushover-def2"],
			]);
		});

		it("offers only all recipients without configured recipients", () => {
			const { Blockly } = load("modern");
			const block = initBlock(Blockly, "device_reminder_send");
			assert.deepStrictEqual(JSON.parse(JSON.stringify(block.fields.RECIPIENT.options())), [
				["all recipients", "*"],
			]);
		});
	});

	it("has texts in 11 languages for every block", () => {
		const { Blockly } = load("legacy");
		const keys = BLOCKS.flatMap(name => [name, `${name}_tooltip`]).concat(
			"device_reminder_to",
			"device_reminder_all_recipients",
			"device_reminder_text",
		);
		for (const key of keys) {
			assert.ok(Blockly.Words[key], key);
			for (const lang of LANGS) {
				assert.ok(Blockly.Words[key][lang], `${key} ${lang}`);
			}
		}
	});
});
