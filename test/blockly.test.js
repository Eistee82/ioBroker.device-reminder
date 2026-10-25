import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
const BLOCKS = ["device_reminder_status", "device_reminder_acknowledge", "device_reminder_dnd", "device_reminder_test"];
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

	describe("device and recipient fields", () => {
		it("the device field is an ID picker and works without any device object in main.objects", () => {
			const { Blockly } = load("modern", { objects: {} });
			for (const name of ["device_reminder_status", "device_reminder_acknowledge", "device_reminder_dnd"]) {
				const block = initBlock(Blockly, name);
				assert.strictEqual(block.fields.DEVICE.kind, "oid", name);
				assert.strictEqual(block.fields.DEVICE.filter, "all", name);
			}
		});

		it("falls back to a text input without the ID picker", () => {
			const { Blockly } = load("modern", { withOid: false });
			assert.strictEqual(initBlock(Blockly, "device_reminder_status").fields.DEVICE.kind, "text");
		});

		it("cuts the device ID out of an object ID picked with the ID dialog", () => {
			const { generator } = load("modern");
			const pick = DEVICE => fakeBlock({ INSTANCE: "0", DEVICE });
			assert.strictEqual(
				generator.forBlock
					.device_reminder_acknowledge(pick("device-reminder.0.trockner.status"), generator)
					.trim(),
				'sendTo("device-reminder.0", "acknowledge", {"deviceId": "trockner"});',
			);
			assert.strictEqual(
				generator.forBlock.device_reminder_acknowledge(pick("device-reminder.0.trockner"), generator).trim(),
				'sendTo("device-reminder.0", "acknowledge", {"deviceId": "trockner"});',
			);
			assert.strictEqual(
				generator.forBlock
					.device_reminder_dnd(pick("device-reminder.0.waschmaschine.config.doNotDisturb"), generator)
					.trim(),
				'sendTo("device-reminder.0", "setDnd", {"deviceId": "waschmaschine", "value": false});',
			);
			assert.strictEqual(
				generator.forBlock.device_reminder_status(pick("device-reminder.0.trockner.finished"), generator)[0],
				'getState("device-reminder.0.trockner.status").val',
			);
		});

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
			const block = initBlock(Blockly, "device_reminder_test");
			assert.strictEqual(block.fields.RECIPIENT.kind, "dropdown");
			assert.deepStrictEqual(JSON.parse(JSON.stringify(block.fields.RECIPIENT.options())), [
				["Anna (telegram-abc1)", "telegram-abc1"],
				["pushover-def2", "pushover-def2"],
			]);
		});

		it("shows a placeholder without recipients", () => {
			const { Blockly } = load("modern");
			const block = initBlock(Blockly, "device_reminder_test");
			assert.deepStrictEqual(JSON.parse(JSON.stringify(block.fields.RECIPIENT.options())), [["-", ""]]);
		});
	});

	it("has texts in 11 languages for every block", () => {
		const { Blockly } = load("legacy");
		const keys = BLOCKS.flatMap(name => [name, `${name}_tooltip`]).concat(
			"device_reminder_recipient_id",
			"device_reminder_device_id",
		);
		for (const key of keys) {
			assert.ok(Blockly.Words[key], key);
			for (const lang of LANGS) {
				assert.ok(Blockly.Words[key][lang], `${key} ${lang}`);
			}
		}
	});
});
