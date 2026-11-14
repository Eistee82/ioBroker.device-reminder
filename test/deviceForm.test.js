import assert from "node:assert";
import * as I18n from "@iobroker/adapter-core/i18n";
import { DEFAULT_REMINDER, FINAL_BOUNDS, normalizeInstanceConfig } from "../build/lib/config.js";
import {
	buildDeviceSchema,
	buildSourceSchema,
	deviceConfigToForm,
	formToDeviceConfig,
} from "../build/lib/deviceForm.js";
import { TEMPLATES } from "../build/lib/templates.js";
import { FINAL_KEYS } from "../build/lib/detector/types.js";
import { deviceConfig, DRYER, WASHER } from "./helpers/devices.js";

/**
 * Form data without the detection values.
 *
 * @param {object} form form data
 * @returns {object} form data without the detection fields
 */
function withoutValues(form) {
	return Object.fromEntries(Object.entries(form).filter(([k]) => !(k in WASHER)));
}

/**
 * All items of a schema, panels flattened (test helper).
 *
 * @param {object} schema schema
 * @param {object} [out] result
 * @returns {object} items by key
 */
function flatItems(schema, out = {}) {
	for (const [key, item] of Object.entries(schema.items ?? {})) {
		if (item.type === "panel") {
			flatItems(item, out);
		} else {
			out[key] = item;
		}
	}
	return out;
}

/** Source of the values of a new device: the washing machine template (in W). */
const SOURCE = { detection: TEMPLATES[0].detection, template: "washing-machine", unitFactor: 1 };
/** Options of a new device on a W state. */
const NEW = { isNew: true, unitFactor: 1, source: SOURCE };
/** Options of an edited device on a W state. */
const EDIT = { isNew: false, unitFactor: 1 };

function instanceConfig() {
	return normalizeInstanceConfig({}).config;
}

function formOf(overrides = {}) {
	return {
		enabled: true,
		name: "Waschmaschine",
		...WASHER,
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

		it("lists templates, archive templates and other devices as the source of the values", () => {
			const s = buildSourceSchema(
				[{ id: "custom2", name: "Pumpe", detection: WASHER }],
				[{ id: "wm", name: "WM" }],
			);
			assert.deepStrictEqual(
				s.items.source.options.map(o => o.value),
				[
					"template:washing-machine",
					"template:dryer",
					"template:dishwasher",
					"template:custom",
					"archive:custom2",
					"device:wm",
				],
			);
			assert.deepStrictEqual(
				buildSourceSchema().items.source.options.map(o => o.value),
				TEMPLATES.map(t => `template:${t.id}`),
			);
		});
	});

	describe("buildDeviceSchema", () => {
		it("has no template or type field: the source is chosen in the first step", () => {
			const items = flatItems(buildDeviceSchema(instanceConfig()));
			assert.strictEqual(items.template, undefined);
			assert.strictEqual(items.typeId, undefined);
		});

		it("detection panel: mode, five thresholds, two durations; durations only outside the count mode", () => {
			const items = flatItems(buildDeviceSchema(instanceConfig()));
			for (const key of [
				"mode",
				"startVal",
				"endVal",
				"standby",
				"startCount",
				"endCount",
				"startDurationSec",
				"endDurationSec",
			]) {
				assert.ok(items[key], key);
			}
			assert.strictEqual(items.startDurationSec.hidden, "data.mode === 'count'");
			assert.strictEqual(items.startVal.unit, "W");
			assert.strictEqual(
				flatItems(buildDeviceSchema(instanceConfig(), undefined, undefined, "kW")).startVal.unit,
				"kW",
			);
		});

		it("expert values: final fields hidden while the master switch is off, time bounds from FINAL_BOUNDS", () => {
			const items = flatItems(buildDeviceSchema(instanceConfig()));
			assert.strictEqual(items.finalMaxVal.hidden, "!data.finalMinVal || !data.finalMinSec");
			assert.strictEqual(items.finalMinVal.hidden, undefined);
			assert.strictEqual(items.finalMinSec.hidden, undefined);
			assert.deepStrictEqual([items.finalLockSec.min, items.finalLockSec.max], FINAL_BOUNDS.finalLockSec);
			assert.deepStrictEqual([items.finalActShare.min, items.finalActShare.max], FINAL_BOUNDS.finalActShare);
			for (const key of FINAL_KEYS) {
				assert.ok(items[key], key);
				assert.ok(!items[key].label.en.startsWith("final"), `${key} translated`);
			}
			assert.ok(items.pauseHoldSec && items.trailerBurstSec, "pause and anti-crease protection");
		});

		it("shows the hint to learn the final phase and phases only when asked for", () => {
			assert.strictEqual(buildDeviceSchema(instanceConfig()).items.copyFinalHint, undefined);
			const hint = buildDeviceSchema(instanceConfig(), undefined, undefined, "W", true).items.copyFinalHint;
			assert.strictEqual(hint.type, "infoBox");
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
			assert.deepStrictEqual(notFound.items.hint.text, I18n.getTranslatedObject("dev_hintNotFound"));

			const noPattern = buildDeviceSchema(cfg, {
				type: "electricity",
				powerId: "a.b",
				switchId: null,
				hint: "noPattern",
			});
			assert.deepStrictEqual(noPattern.items.hint.text, I18n.getTranslatedObject("dev_hintNoPattern"));
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
			const form = formOf();
			const { config, errors } = formToDeviceConfig(form, NEW);
			assert.deepStrictEqual(errors, []);
			assert.deepStrictEqual(config, {
				enabled: true,
				name: "Waschmaschine",
				detection: WASHER,
				template: "washing-machine",
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

		it("stores the automatic optimisation only when it is on", () => {
			const off = formToDeviceConfig(formOf({ optimizeNotify: true }), NEW).config;
			assert.ok(!("autoOptimize" in off) && !("optimizeNotify" in off), "off: 3.1.2 configuration unchanged");
			assert.ok(!("autoOptimize" in deviceConfigToForm(off)));
			const on = formToDeviceConfig(formOf({ autoOptimize: true, optimizeNotify: true }), NEW).config;
			assert.strictEqual(on.autoOptimize, true);
			assert.strictEqual(on.optimizeNotify, true);
			const back = deviceConfigToForm(on);
			assert.strictEqual(back.autoOptimize, true);
			assert.strictEqual(back.optimizeNotify, true);
			const items = buildDeviceSchema(instanceConfig()).items.advancedSection.items;
			assert.strictEqual(items.autoOptimize.type, "checkbox");
			assert.strictEqual(items.optimizeNotify.hidden, "!data.autoOptimize");
			assert.ok(!items.autoOptimize.label.en.startsWith("dm_"), "translated");
		});

		it("omits empty optional ids", () => {
			const { config } = formToDeviceConfig(formOf({ sourceId: " ", switchId: "" }), NEW);
			assert.ok(config);
			assert.ok(!("sourceId" in config));
			assert.ok(!("switchId" in config));
			const back = deviceConfigToForm(config);
			assert.strictEqual(back.sourceId, "");
			assert.strictEqual(back.switchId, "");
		});

		it("trims name and ids", () => {
			const { config } = formToDeviceConfig(formOf({ name: "  Trockner ", powerId: " a.b.c " }), NEW);
			assert.strictEqual(config.name, "Trockner");
			assert.strictEqual(config.powerId, "a.b.c");
		});

		it("rejects a missing power state", () => {
			const { config, errors } = formToDeviceConfig(formOf({ powerId: "  " }), NEW);
			assert.strictEqual(config, null);
			assert.strictEqual(errors.length, 1);
			assert.match(errors[0], /power/i);
		});

		it("rejects a missing name, an invalid value and reports every problem", () => {
			const { config, errors } = formToDeviceConfig(formOf({ name: "", startVal: "x", powerId: "" }), NEW);
			assert.strictEqual(config, null);
			assert.strictEqual(errors.length, 3);
			assert.match(errors.join(" "), /startVal/);
			const counts = formToDeviceConfig(formOf({ startCount: 0, endCount: 1 }), NEW);
			assert.strictEqual(counts.errors.length, 2);
		});

		it("form values become detection; invalid final values are corrected with the normalizer", () => {
			const { config, warnings } = formToDeviceConfig(
				{ ...formOf(), ...WASHER, finalMinVal: 150, finalMinSec: 168, finalMaxVal: 100 },
				EDIT,
			);
			assert.strictEqual(config.detection.finalMinVal, 0);
			assert.ok(warnings.length > 0, "the correction is reported");
		});

		it("rejects a negative or invalid auto-off time", () => {
			assert.strictEqual(formToDeviceConfig(formOf({ autoOffMinutes: -1 }), NEW).config, null);
			assert.strictEqual(formToDeviceConfig(formOf({ autoOffMinutes: Number.NaN }), NEW).config, null);
			const ok = formToDeviceConfig(formOf({ autoOff: false, autoOffMinutes: 0 }), NEW);
			assert.deepStrictEqual(ok.errors, []);
		});

		it("rejects a reminder with a maximum count below 1", () => {
			const reminder = { ...DEFAULT_REMINDER, maxCount: 0 };
			const { config, errors } = formToDeviceConfig(formOf({ reminder }), NEW);
			assert.strictEqual(config, null);
			assert.match(errors[0], /reminder/i);
		});

		it("accepts numeric strings from the form", () => {
			const form = formOf({ autoOffMinutes: "7" });
			form.reminder = { ...form.reminder, intervalMin: "15", maxCount: "4" };
			const { config, errors } = formToDeviceConfig(form, NEW);
			assert.deepStrictEqual(errors, []);
			assert.strictEqual(config.autoOffMinutes, 7);
			assert.strictEqual(config.reminder.intervalMin, 15);
			assert.strictEqual(config.reminder.maxCount, 4);
		});

		it("drops empty action rows and rejects rows without a state", () => {
			const empty = formToDeviceConfig(formOf({ actions: [{ event: "start", stateId: " ", value: "" }] }), NEW);
			assert.deepStrictEqual(empty.errors, []);
			assert.deepStrictEqual(empty.config.actions, []);

			const broken = formToDeviceConfig(formOf({ actions: [{ event: "start", stateId: "", value: "1" }] }), NEW);
			assert.strictEqual(broken.config, null);
			assert.match(broken.errors[0], /action/i);
		});

		it("rejects an unknown action event", () => {
			const { config, errors } = formToDeviceConfig(
				formOf({ actions: [{ event: "boom", stateId: "a.b", value: "1" }] }),
				NEW,
			);
			assert.strictEqual(config, null);
			assert.match(errors[0], /action/i);
		});

		it("produces a form with defaults for a minimal device config", () => {
			const form = deviceConfigToForm({
				enabled: true,
				name: "Spuelmaschine",
				detection: WASHER,
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
			assert.strictEqual(form.template, undefined);
			assert.deepStrictEqual(
				[form.startVal, form.endCount, form.finalLockSec, form.mode],
				[WASHER.startVal, WASHER.endCount, 0, "count"],
			);
		});

		it("does not share references with the config", () => {
			const { config } = formToDeviceConfig(formOf(), NEW);
			const form = deviceConfigToForm(config);
			form.recipients.push("x");
			form.actions[0].value = "changed";
			form.reminder.text = "changed";
			assert.deepStrictEqual(config.recipients, ["rcp1", "rcp2"]);
			assert.strictEqual(config.actions[0].value, "true");
			assert.strictEqual(config.reminder.text, "Bitte ausraeumen");
		});

		it("a new device takes the values of the source; saving clears needsReview", () => {
			const dryer = { detection: TEMPLATES[1].detection, template: "dryer", unitFactor: 1 };
			const { config } = formToDeviceConfig(
				{ ...formOf({ needsReview: true, reviewHint: "x" }), ...DRYER },
				{ isNew: true, unitFactor: 1, source: dryer },
			);
			assert.deepStrictEqual(
				[config.detection.startVal, config.template, config.needsReview, config.reviewHint],
				[120, "dryer", undefined, undefined],
			);
			// no values in the form (unit of the state only known now): the source is divided by the unit factor
			const kw = formToDeviceConfig(withoutValues(formOf()), {
				isNew: true,
				unitFactor: 1000,
				source: dryer,
			}).config;
			assert.deepStrictEqual([kw.detection.startVal, kw.detection.endVal, kw.template], [0.12, 0.015, "dryer"]);
		});

		it("a state in kW chosen after the values were prefilled rescales untouched power values only", () => {
			const dryer = { detection: TEMPLATES[1].detection, template: "dryer", unitFactor: 1 };
			const form = { ...formOf(), ...DRYER, endVal: 20 };
			const { config } = formToDeviceConfig(form, { isNew: true, unitFactor: 1000, source: dryer });
			assert.deepStrictEqual(
				[config.detection.startVal, config.detection.endVal, config.template],
				[0.12, 20, undefined],
				"the edited value stays as entered, so the values no longer equal the template",
			);
		});

		it("without a source the values of the template Custom are used", () => {
			const { config } = formToDeviceConfig(withoutValues(formOf()), { isNew: true, unitFactor: 1 });
			assert.deepStrictEqual([config.detection.startVal, config.template], [30, "custom"]);
		});

		it("editing keeps the detection values", () => {
			const detection = { ...WASHER, endCount: 77 };
			const { config } = formToDeviceConfig({ ...formOf(), ...detection }, EDIT);
			assert.strictEqual(config.detection.endCount, 77);
			assert.strictEqual(config.template, undefined, "values differ from the template");
		});

		it("editing keeps fields the form does not show (phases, learned, template) – writeDevice replaces native", () => {
			const phases = {
				v: 1,
				enabled: true,
				scope: "run",
				bands: [],
				phases: [],
				learnedAt: 1,
				quality: { agreement: 1, runsUsed: 3 },
			};
			const previous = { ...deviceConfig({ template: "washing-machine" }), phases, learned: true };
			const { config } = formToDeviceConfig(
				{ ...formOf(), endText: "Done!" },
				{ isNew: false, unitFactor: 1, previous },
			);
			assert.deepStrictEqual(
				[config.endText, config.phases, config.learned, config.template],
				["Done!", phases, true, "washing-machine"],
			);
			const changed = formToDeviceConfig(
				{ ...formOf(), endCount: 77 },
				{ isNew: false, unitFactor: 1, previous },
			);
			assert.strictEqual(changed.config.template, undefined, "values differ from the template");
		});

		it("editing drops the old type id and the review hint, and keeps the stored values without form values", () => {
			const previous = {
				...deviceConfig({ detection: { ...WASHER, endCount: 66 } }),
				typeId: "washing-machine",
				needsReview: true,
				reviewHint: "check",
				switchId: "old.switch",
				autoOptimize: true,
			};
			const form = withoutValues(formOf({ switchId: "", autoOptimize: false }));
			const { config } = formToDeviceConfig(form, { isNew: false, unitFactor: 1, previous });
			assert.strictEqual(config.detection.endCount, 66);
			for (const key of ["typeId", "needsReview", "reviewHint", "switchId", "autoOptimize"]) {
				assert.ok(!(key in config), key);
			}
		});
	});
});
