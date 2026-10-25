import assert from "node:assert";
import { DEFAULT_REMINDER, DEFAULT_TYPES, normalizeInstanceConfig } from "../build/lib/config.js";
import {
	buildDeviceSchema,
	buildSourceSchema,
	deviceConfigToForm,
	formToDeviceConfig,
} from "../build/lib/deviceForm.js";

function instanceConfig() {
	return normalizeInstanceConfig({}).config;
}

function validForm(overrides = {}) {
	return {
		enabled: true,
		name: "Waschmaschine",
		typeId: "washing-machine",
		sourceId: "alias.0.Waschmaschine",
		powerId: "alias.0.Waschmaschine.POWER",
		switchId: "alias.0.Waschmaschine.SWITCH",
		startText: "Waschmaschine gestartet",
		endText: "Waschmaschine fertig",
		abort: true,
		abortFixed: false,
		autoOff: true,
		autoOffMinutes: 5,
		recipients: ["rcp1", "rcp2"],
		reminder: {
			enabled: true,
			intervalMin: 20,
			maxCount: 3,
			text: "Bitte ausraeumen",
			ackStateId: "0_userdata.0.ack",
		},
		actions: [{ event: "end", stateId: "0_userdata.0.lamp", value: "true" }],
		...overrides,
	};
}

describe("deviceForm", () => {
	describe("buildSourceSchema", () => {
		it("offers the source picker and the manual checkbox", () => {
			const schema = buildSourceSchema();
			assert.strictEqual(schema.type, "panel");
			assert.strictEqual(schema.items.sourceId.type, "objectId");
			assert.strictEqual(schema.items.manual.type, "checkbox");
			assert.strictEqual(schema.items.sourceId.hidden, "data.manual === true");
		});
	});

	describe("buildDeviceSchema", () => {
		it("lists all 13 default types in the type select", () => {
			const schema = buildDeviceSchema(instanceConfig());
			const select = schema.items.typeId;
			assert.strictEqual(select.type, "select");
			assert.strictEqual(select.options.length, 13);
			assert.deepStrictEqual(
				select.options.map(o => o.value),
				DEFAULT_TYPES.map(t => t.id),
			);
			assert.strictEqual(select.options[0].label, "Washing machine");
		});

		it("lists the configured recipients as multi select", () => {
			const cfg = instanceConfig();
			cfg.recipients = [
				{ id: "rcp1", name: "Anna", enabled: true, kind: "telegram" },
				{ id: "rcp2", name: "Bob", enabled: false, kind: "email" },
			];
			const select = buildDeviceSchema(cfg).items.recipients;
			assert.strictEqual(select.type, "select");
			assert.strictEqual(select.multiple, true);
			assert.deepStrictEqual(
				select.options.map(o => o.value),
				["rcp1", "rcp2"],
			);
		});

		it("contains the required main fields", () => {
			const { items } = buildDeviceSchema(instanceConfig());
			for (const key of [
				"enabled",
				"name",
				"typeId",
				"sourceId",
				"powerId",
				"switchId",
				"startText",
				"endText",
				"abort",
				"autoOff",
				"autoOffMinutes",
				"recipients",
			]) {
				assert.ok(items[key], `missing item ${key}`);
			}
			assert.strictEqual(items.powerId.type, "objectId");
			assert.strictEqual(items.autoOffMinutes.min, 0);
		});

		it("shows a hint element only when the detection has a hint", () => {
			const cfg = instanceConfig();
			assert.strictEqual(buildDeviceSchema(cfg).items.hint, undefined);
			const none = buildDeviceSchema(cfg, { type: null, powerId: null, switchId: null });
			assert.strictEqual(none.items.hint, undefined);

			const notFound = buildDeviceSchema(cfg, { type: null, powerId: null, switchId: null, hint: "notFound" });
			assert.strictEqual(notFound.items.hint.type, "infoBox");
			assert.strictEqual(notFound.items.hint.text, "dev_hintNotFound");

			const noPattern = buildDeviceSchema(cfg, {
				type: "electricity",
				powerId: "a.b",
				switchId: null,
				hint: "noPattern",
			});
			assert.strictEqual(noPattern.items.hint.text, "dev_hintNoPattern");
		});

		it("has collapsed reminder, actions and advanced sections", () => {
			const { items } = buildDeviceSchema(instanceConfig());
			for (const key of ["reminderSection", "actionsSection", "advancedSection"]) {
				assert.strictEqual(items[key].type, "panel", key);
				assert.strictEqual(items[key].collapsable, true, key);
			}
			assert.ok(items.reminderSection.items["reminder.enabled"]);
			assert.strictEqual(items.reminderSection.items["reminder.maxCount"].min, 1);
			assert.strictEqual(items.actionsSection.items.actions.type, "table");
			assert.ok(items.advancedSection.items.abortFixed);
		});
	});

	describe("formToDeviceConfig / deviceConfigToForm", () => {
		it("round-trips a complete device", () => {
			const form = validForm();
			const { config, errors } = formToDeviceConfig(form);
			assert.deepStrictEqual(errors, []);
			assert.deepStrictEqual(config, {
				enabled: true,
				name: "Waschmaschine",
				typeId: "washing-machine",
				sourceId: "alias.0.Waschmaschine",
				powerId: "alias.0.Waschmaschine.POWER",
				switchId: "alias.0.Waschmaschine.SWITCH",
				startText: "Waschmaschine gestartet",
				endText: "Waschmaschine fertig",
				abort: true,
				abortFixed: false,
				autoOff: true,
				autoOffMinutes: 5,
				recipients: ["rcp1", "rcp2"],
				reminder: {
					enabled: true,
					intervalMin: 20,
					maxCount: 3,
					text: "Bitte ausraeumen",
					ackStateId: "0_userdata.0.ack",
				},
				actions: [{ event: "end", stateId: "0_userdata.0.lamp", value: "true" }],
			});
			assert.deepStrictEqual(deviceConfigToForm(config), form);
		});

		it("omits empty optional ids", () => {
			const { config } = formToDeviceConfig(validForm({ sourceId: " ", switchId: "" }));
			assert.ok(config);
			assert.ok(!("sourceId" in config));
			assert.ok(!("switchId" in config));
			const back = deviceConfigToForm(config);
			assert.strictEqual(back.sourceId, "");
			assert.strictEqual(back.switchId, "");
		});

		it("trims name and ids", () => {
			const { config } = formToDeviceConfig(validForm({ name: "  Trockner ", powerId: " a.b.c " }));
			assert.strictEqual(config.name, "Trockner");
			assert.strictEqual(config.powerId, "a.b.c");
		});

		it("rejects a missing power state", () => {
			const { config, errors } = formToDeviceConfig(validForm({ powerId: "  " }));
			assert.strictEqual(config, null);
			assert.strictEqual(errors.length, 1);
			assert.match(errors[0], /power/i);
		});

		it("rejects a missing name and type and reports every problem", () => {
			const { config, errors } = formToDeviceConfig(validForm({ name: "", typeId: "", powerId: "" }));
			assert.strictEqual(config, null);
			assert.strictEqual(errors.length, 3);
		});

		it("rejects a negative or invalid auto-off time", () => {
			assert.strictEqual(formToDeviceConfig(validForm({ autoOffMinutes: -1 })).config, null);
			assert.strictEqual(formToDeviceConfig(validForm({ autoOffMinutes: Number.NaN })).config, null);
			const ok = formToDeviceConfig(validForm({ autoOff: false, autoOffMinutes: 0 }));
			assert.deepStrictEqual(ok.errors, []);
		});

		it("rejects a reminder with a maximum count below 1", () => {
			const reminder = { ...DEFAULT_REMINDER, maxCount: 0 };
			const { config, errors } = formToDeviceConfig(validForm({ reminder }));
			assert.strictEqual(config, null);
			assert.match(errors[0], /reminder/i);
		});

		it("accepts numeric strings from the form", () => {
			const form = validForm({ autoOffMinutes: "7" });
			form.reminder = { ...form.reminder, intervalMin: "15", maxCount: "4" };
			const { config, errors } = formToDeviceConfig(form);
			assert.deepStrictEqual(errors, []);
			assert.strictEqual(config.autoOffMinutes, 7);
			assert.strictEqual(config.reminder.intervalMin, 15);
			assert.strictEqual(config.reminder.maxCount, 4);
		});

		it("drops empty action rows and rejects rows without a state", () => {
			const empty = formToDeviceConfig(validForm({ actions: [{ event: "start", stateId: " ", value: "" }] }));
			assert.deepStrictEqual(empty.errors, []);
			assert.deepStrictEqual(empty.config.actions, []);

			const broken = formToDeviceConfig(validForm({ actions: [{ event: "start", stateId: "", value: "1" }] }));
			assert.strictEqual(broken.config, null);
			assert.match(broken.errors[0], /action/i);
		});

		it("rejects an unknown action event", () => {
			const { config, errors } = formToDeviceConfig(
				validForm({ actions: [{ event: "boom", stateId: "a.b", value: "1" }] }),
			);
			assert.strictEqual(config, null);
			assert.match(errors[0], /action/i);
		});

		it("produces a form with defaults for a minimal device config", () => {
			const form = deviceConfigToForm({
				enabled: true,
				name: "Spuelmaschine",
				typeId: "dishwasher",
				powerId: "x.y.power",
				startText: "",
				endText: "",
				abort: false,
				abortFixed: false,
				autoOff: false,
				autoOffMinutes: 0,
				recipients: [],
				reminder: { ...DEFAULT_REMINDER },
				actions: [],
			});
			assert.strictEqual(form.sourceId, "");
			assert.strictEqual(form.switchId, "");
			assert.deepStrictEqual(form.reminder, DEFAULT_REMINDER);
			assert.deepStrictEqual(form.actions, []);
		});

		it("does not share references with the config", () => {
			const { config } = formToDeviceConfig(validForm());
			const form = deviceConfigToForm(config);
			form.recipients.push("x");
			form.actions[0].value = "changed";
			form.reminder.text = "changed";
			assert.deepStrictEqual(config.recipients, ["rcp1", "rcp2"]);
			assert.strictEqual(config.actions[0].value, "true");
			assert.strictEqual(config.reminder.text, "Bitte ausraeumen");
		});
	});
});
