import assert from "node:assert";
import { DEFAULT_REMINDER, normalizeDeviceConfig, normalizeInstanceConfig } from "../build/lib/config.js";
import { detectionOf } from "../build/lib/runStore.js";
import { DRYER, WASHER } from "./helpers/devices.js";
import { loadSeries } from "./helpers/fixtures.js";
import { usesOfAnswer } from "../build/lib/learnDialog.js";
import { recordingChecks } from "../build/lib/learning.js";
import { DeviceRegistry } from "../build/lib/deviceRegistry.js";
import {
	buildLearnSchema,
	buildRunTable,
	RUN_TABLE_MODE,
	buildOptimizationView,
	deviceModel,
	parseLearnForm,
	ReminderDeviceManagement,
	suggestionOf,
} from "../build/lib/deviceManagement.js";
import { ensureDeviceObjects } from "../build/lib/deviceObjects.js";
import * as I18n from "@iobroker/adapter-core/i18n";
import { Notifier } from "../build/lib/notifier.js";
import { TEXT } from "../build/lib/dmTexts.js";
import { createFakeHost } from "./helpers/fakeHost.js";
import { washingMachine } from "./helpers/curves.js";
import { historyOf, longPause } from "./helpers/history.js";
import { memoryFiles } from "./helpers/files.js";
import { runOf } from "./helpers/programmes.js";

const NS = "device-reminder.0";
const POWER = "plug.0.power";
const INSTANCE_OBJ = `system.adapter.${NS}`;

/** Detection values of the test device: 30/5/1/1/2. */
const testDetection = { ...WASHER, endVal: 5, startCount: 1, endCount: 2 };

function deviceCfg(over = {}) {
	return {
		enabled: true,
		name: "Trockner",
		detection: testDetection,
		powerId: POWER,
		startText: "Started",
		endText: "Finished",
		abort: false,
		abortFixed: false,
		autoOff: false,
		autoOffMinutes: 0,
		recipients: ["tg", "tg2"],
		reminder: { ...DEFAULT_REMINDER },
		actions: [],
		...over,
	};
}

function formOf(over = {}) {
	return { ...deviceCfg(), template: "custom", sourceId: "", switchId: "", ...over };
}

function isDeepMergeTarget(v) {
	return typeof v === "object" && v !== null;
}

/**
 * Emulates the deep merge of js-controller: arrays are merged by index.
 *
 * @param {object} target merged into
 * @param {object} src merged from
 * @returns {object} target
 */
function deepExtend(target, src) {
	for (const [key, val] of Object.entries(src)) {
		if (isDeepMergeTarget(val) && isDeepMergeTarget(target[key])) {
			deepExtend(target[key], val);
		} else {
			target[key] = isDeepMergeTarget(val) ? structuredClone(val) : val;
		}
	}
	return target;
}

function createFakeAdapter(host, inst) {
	const objects = new Map();
	const states = new Map();
	const foreign = new Map();
	const adapter = {
		namespace: NS,
		log: host.log,
		objects,
		states,
		foreign,
		extendedForeign: [],
		setForeign: [],
		on() {},
		async getObjectViewAsync(_design, _search, opts) {
			const rows = [...objects.entries()]
				.filter(([id, obj]) => obj.type === "device" && id >= opts.startkey && id < opts.endkey)
				.map(([id, value]) => ({ id, value }));
			return { rows };
		},
		async getObjectAsync(id) {
			return objects.get(`${NS}.${id}`) ?? null;
		},
		async setObjectAsync(id, obj) {
			objects.set(`${NS}.${id}`, structuredClone(obj));
		},
		async extendObjectAsync(id, obj) {
			const full = `${NS}.${id}`;
			objects.set(full, deepExtend(objects.get(full) ?? {}, obj));
			const object = objects.get(full);
			if (object.type === "device") {
				// like the adapter: the normalized configuration reaches the registry
				const { config } = normalizeDeviceConfig(object.native);
				if (config) {
					await adapter.registry.upsert(id, config);
				}
			}
		},
		async setObjectNotExistsAsync(id, obj) {
			if (!objects.has(`${NS}.${id}`)) {
				objects.set(`${NS}.${id}`, structuredClone(obj));
			}
		},
		async delObjectAsync(id, opts) {
			const full = `${NS}.${id}`;
			objects.delete(full);
			if (opts?.recursive) {
				for (const key of [...objects.keys()]) {
					if (key.startsWith(`${full}.`)) {
						objects.delete(key);
					}
				}
			}
		},
		async getStateAsync(id) {
			return states.has(id) ? { val: states.get(id) } : null;
		},
		async getForeignObjectAsync(id) {
			return foreign.get(id) ?? null;
		},
		async getForeignObjectsAsync(pattern) {
			const prefix = pattern.replace(/\*$/, "");
			return Object.fromEntries([...foreign.entries()].filter(([id]) => id.startsWith(prefix)));
		},
		async extendForeignObjectAsync(id, obj) {
			adapter.extendedForeign.push({ id, obj });
		},
		async setForeignObjectAsync(id, obj) {
			adapter.setForeign.push({ id, obj: structuredClone(obj) });
		},
		instanceConfig: inst,
		setTimeout: (cb, ms) => setTimeout(cb, ms),
	};
	// own states written by the runtime are visible through getStateAsync
	const setOwnState = host.setOwnState.bind(host);
	host.setOwnState = async (id, val) => {
		states.set(id, val);
		await setOwnState(id, val);
	};
	return adapter;
}

function setup(opts = {}) {
	const host = createFakeHost({ objects: { [POWER]: "number" } });
	const inst = normalizeInstanceConfig({
		recipients: [
			{ id: "tg", name: "Telegram", enabled: true, kind: "telegram", instance: "telegram.0" },
			{ id: "tg2", name: "Telegram 2", enabled: true, kind: "telegram", instance: "telegram.1" },
		],
		pollIntervalSec: 10,
	}).config;
	const notifier = new Notifier(host, () => inst.recipients);
	const registry = new DeviceRegistry(host, notifier, () => inst, opts.files);
	const adapter = createFakeAdapter(host, inst);
	adapter.registry = registry;
	adapter.notifier = notifier;
	adapter.foreign.set(POWER, { type: "state", common: { type: "number", role: "value.power" }, native: {} });
	adapter.foreign.set(INSTANCE_OBJ, { type: "instance", common: {}, native: { types: [] } });
	const dm = new ReminderDeviceManagement(adapter);
	return { host, inst, adapter, registry, notifier, dm, opts };
}

async function addDevice(ctx, id, cfg = deviceCfg()) {
	await ensureDeviceObjects(
		{
			extendObject: (oid, obj) => ctx.adapter.extendObjectAsync(oid, obj),
			setObjectNotExists: (oid, obj) => ctx.adapter.setObjectNotExistsAsync(oid, obj),
			delObject: async oid => ctx.adapter.delObjectAsync(oid),
		},
		id,
		cfg,
		ctx.inst,
	);
}

async function load(ctx) {
	const devices = [];
	await ctx.dm.loadDevices({ addDevice: d => devices.push(d), setTotalDevices: () => {} });
	return devices;
}

function fakeAction(over = {}) {
	const messages = [];
	const confirmations = [];
	const forms = [];
	const answers = over.forms ?? [];
	return {
		messages,
		confirmations,
		forms,
		showMessage: async text => {
			messages.push(text);
		},
		showConfirmation: async text => {
			confirmations.push(text);
			return over.confirm ?? true;
		},
		showForm: async (schema, options) => {
			forms.push({ schema, options });
			return answers.shift();
		},
		progress: [],
		openProgress: async (title, options) => {
			const dialog = {
				title,
				closed: false,
				values: [options?.value],
				update: async u => {
					dialog.values.push(u.value);
				},
				close: async () => (dialog.closed = true),
			};
			forms.progress = dialog;
			return dialog;
		},
	};
}

function actionOfInstance(ctx, id) {
	const action = ctx.dm.getInstanceInfo().actions.find(a => a.id === id);
	assert.ok(action, `instance action ${id} missing`);
	return action;
}

function actionOf(info, id) {
	const action = info.actions.find(a => a.id === id);
	assert.ok(action, `action ${id} missing`);
	return action;
}

describe("deviceManagement", () => {
	it("offers the add action on the instance", () => {
		const { dm } = setup();
		const info = dm.getInstanceInfo();
		assert.deepStrictEqual(
			info.actions.map(a => a.id),
			["add", "removeArchive"],
		);
		assert.strictEqual(info.apiVersion, "v3");
	});

	describe("loadDevices", () => {
		it("lists every device with its actions, indicators and state links", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			await addDevice(ctx, "waschmaschine", deviceCfg({ name: "Waschmaschine", enabled: false }));
			const devices = await load(ctx);
			assert.deepStrictEqual(
				devices.map(d => d.id),
				["trockner", "waschmaschine"],
			);
			const info = devices[0];
			assert.strictEqual(info.name, "Trockner");
			assert.strictEqual(info.model.en, "own values", "no template");
			assert.strictEqual(info.identifier, POWER);
			assert.strictEqual(info.enabled, true);
			assert.strictEqual(devices[1].enabled, false);
			assert.deepStrictEqual(
				info.actions.map(a => a.id),
				["edit", "delete", "enable/disable", "dnd", "acknowledge", "learn", "test"],
			);
			for (const a of info.actions) {
				assert.strictEqual(typeof a.handler, "function", a.id);
			}
			const byId = Object.fromEntries(info.indicators.map(i => [i.id, i]));
			assert.deepStrictEqual(byId.running.value, { stateId: `${NS}.trockner.running` });
			assert.deepStrictEqual(byId.finished.value, { stateId: `${NS}.trockner.finished` });
			assert.deepStrictEqual(byId.statusText.value, { stateId: `${NS}.trockner.status` });
			assert.deepStrictEqual(byId.consumption.value, { stateId: `${NS}.trockner.consumption` });
			assert.deepStrictEqual(byId.runtime.value, { stateId: `${NS}.trockner.runtime` });
			assert.strictEqual(info.hasDetails, true);
		});

		it("links the warning to alertRuntime while the power state exists", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			assert.deepStrictEqual(info.status.warning, { stateId: `${NS}.trockner.alertRuntime` });
		});

		it("shows a warning when the power object does not exist (Review Focus 2)", async () => {
			const ctx = setup();
			ctx.adapter.foreign.delete(POWER);
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			assert.strictEqual(typeof info.status.warning, "object");
			assert.ok(info.status.warning.en.includes(POWER));
			assert.strictEqual(info.status.warning.stateId, undefined);
		});

		it("lists a device that needs a review with a warning instead of hiding it (M3)", async () => {
			const ctx = setup();
			await addDevice(
				ctx,
				"trockner",
				deviceCfg({ enabled: false, needsReview: true, reviewHint: 'type "gone" not found' }),
			);
			const [info] = await load(ctx);
			assert.ok(info.status.warning.en.includes("gone"));
			assert.ok(!info.status.warning.de.startsWith("Check"), "translated");
			assert.ok(info.actions.some(a => a.id === "delete"));
			assert.strictEqual(ctx.registry.get("trockner"), undefined, "it does not run");
		});

		it("shows the template as model", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner", deviceCfg({ detection: DRYER, template: "dryer" }));
			const [info] = await load(ctx);
			assert.strictEqual(info.model.en, "Dryer");
			assert.strictEqual(info.model.de, "Trockner");
		});

		it("card model: template name, learned, own values; review warning with hint", async () => {
			const ctx = setup();
			await addDevice(ctx, "a", deviceCfg({ name: "A", template: "dryer" }));
			await addDevice(ctx, "b", deviceCfg({ name: "B", learned: true }));
			await addDevice(ctx, "c", deviceCfg({ name: "C" }));
			await addDevice(
				ctx,
				"d",
				deviceCfg({ name: "D", enabled: false, needsReview: true, reviewHint: 'type "Kessel" not found' }),
			);
			const devices = await load(ctx);
			const en = id => devices.find(x => x.id === id).model.en;
			assert.deepStrictEqual(["a", "b", "c"].map(en), ["Dryer", "learned", "own values"]);
			assert.match(JSON.stringify(devices.find(x => x.id === "d").status), /Kessel/);
		});

		it("card warning: a suspended final phase (Spec A.3 point 3)", async () => {
			const ctx = setup({ files: memoryFiles() });
			await addDevice(ctx, "trockner", deviceCfg({ detection: DRYER, autoOptimize: true }));
			const st = ctx.registry.learningData("trockner");
			assert.ok(st, "learning data loaded");
			let [info] = await load(ctx);
			assert.notDeepStrictEqual(info.status.warning, TEXT.finalSuspendedCard);
			st.final = { state: "suspended", splits: ["trockner@1"], suspendedAt: 1, reason: "finalSplit" };
			[info] = await load(ctx);
			assert.deepStrictEqual(info.status.warning, TEXT.finalSuspendedCard);
		});

		it("card warning: optimisation too slow from the 3rd job in a row stopped by the time budget (Spec D.3)", async () => {
			const ctx = setup({ files: memoryFiles() });
			await addDevice(ctx, "trockner", deviceCfg({ detection: DRYER, autoOptimize: true }));
			const st = ctx.registry.learningData("trockner");
			st.info.budget = 2;
			let [info] = await load(ctx);
			assert.notDeepStrictEqual(info.status.warning, TEXT.budgetCard);
			st.info.budget = 3;
			[info] = await load(ctx);
			assert.deepStrictEqual(info.status.warning, TEXT.budgetCard);
		});

		it("card model: an active override of the optimisation counts as learned", async () => {
			const ctx = setup();
			await addDevice(ctx, "a", deviceCfg({ name: "A" }));
			assert.strictEqual(deviceModel(deviceCfg(), true).en, "learned");
			assert.strictEqual(deviceModel(deviceCfg(), false).en, "own values");
			assert.strictEqual(deviceModel(deviceCfg({ template: "dryer" }), true).en, "learned");
		});
	});

	describe("add", () => {
		it("creates trockner_2 when trockner exists (manual entry)", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const action = fakeAction({ forms: [{ manual: true }, formOf()] });
			const result = await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.deepStrictEqual(result, { refresh: true });
			assert.ok(ctx.adapter.objects.has(`${NS}.trockner_2`));
			assert.ok(ctx.adapter.objects.has(`${NS}.trockner_2.status`));
			assert.strictEqual(ctx.adapter.objects.get(`${NS}.trockner_2`).native.name, "Trockner");
			assert.strictEqual(ctx.adapter.objects.get(`${NS}.trockner_2`).common.name, "Trockner");
			assert.ok(ctx.adapter.objects.has(`${NS}.trockner`), "the existing device is untouched");
			const native = ctx.adapter.objects.get(`${NS}.trockner_2`).native;
			assert.deepStrictEqual(
				[native.template, native.detection.startVal, native.detection.endCount],
				["custom", 30, 20],
			);
			assert.strictEqual(
				action.forms[0].schema.items.source.type,
				"select",
				"the source of the values is chosen",
			);
			assert.strictEqual(action.forms[1].schema.items.template, undefined);
		});

		it("add with a template on a kW state divides the power values", async () => {
			const ctx = setup();
			ctx.adapter.foreign.set(POWER, {
				type: "state",
				common: { type: "number", role: "value.power", unit: "kW" },
				native: {},
			});
			const action = fakeAction({
				forms: [{ manual: true, source: "template:dryer" }, formOf({ name: "Trockner" })],
			});
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
			assert.deepStrictEqual(
				[native.detection.startVal, native.detection.endVal, native.template],
				[0.12, 0.015, "dryer"],
			);
		});

		it("the form shows the values of the source in the unit of the detected state", async () => {
			const ctx = setup();
			ctx.adapter.foreign.set(POWER, {
				type: "state",
				common: { type: "number", role: "value.power", unit: "kW" },
				native: {},
			});
			const action = fakeAction({
				forms: [{ manual: false, sourceId: POWER, source: "template:dryer" }, formOf({ name: "Trockner" })],
			});
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			const data = action.forms[1].options.data;
			assert.deepStrictEqual([data.startVal, data.endVal, data.mode], [0.12, 0.015, "count"]);
			assert.strictEqual(action.forms[1].schema.items.detectionSection.items.startVal.unit, "kW");
		});

		it("add from another device copies the 16 base values only; final phase and phases are learned at the new device", async () => {
			const ctx = setup();
			await addDevice(
				ctx,
				"wm",
				deviceCfg({
					name: "WM",
					detection: { ...WASHER, endCount: 77, finalMinVal: 150, finalMinSec: 168 },
					phases: {
						v: 1,
						enabled: true,
						scope: "run",
						bands: [],
						phases: [],
						learnedAt: 1,
						quality: { agreement: 1, runsUsed: 3 },
					},
				}),
			);
			const action = fakeAction({ forms: [{ manual: true, source: "device:wm" }, formOf({ name: "WM2" })] });
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			const native = ctx.adapter.objects.get(`${NS}.wm2`).native;
			assert.deepStrictEqual(detectionOf(native.detection), detectionOf({ ...WASHER, endCount: 77 }));
			assert.strictEqual(native.phases, undefined);
			assert.ok(action.forms[1].schema.items.copyFinalHint, "hint to learn the final phase and phases");
			assert.strictEqual(
				action.forms[1].options.data.finalMinVal,
				0,
				"the final phase is not part of the prefilled values",
			);
		});

		it("add from a device without final phase and phases shows no hint", async () => {
			const ctx = setup();
			await addDevice(ctx, "wm", deviceCfg({ name: "WM" }));
			const action = fakeAction({ forms: [{ manual: true, source: "device:wm" }, formOf({ name: "WM2" })] });
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.strictEqual(action.forms[1].schema.items.copyFinalHint, undefined);
		});

		it("copying between a W and a kW state converts the power values", async () => {
			const ctx = setup();
			ctx.adapter.foreign.set("plug.9.power", {
				type: "state",
				common: { type: "number", role: "value.power", unit: "W" },
				native: {},
			});
			await addDevice(
				ctx,
				"wm",
				deviceCfg({ name: "WM", powerId: "plug.9.power", detection: { ...WASHER, endCount: 77 } }),
			);
			ctx.adapter.foreign.set(POWER, {
				type: "state",
				common: { type: "number", role: "value.power", unit: "kW" },
				native: {},
			});
			const action = fakeAction({ forms: [{ manual: true, source: "device:wm" }, formOf({ name: "WM2" })] });
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			const d = ctx.adapter.objects.get(`${NS}.wm2`).native.detection;
			assert.deepStrictEqual([d.startVal, d.endVal, d.endCount], [0.03, 0.015, 77]);
		});

		it("add from an archive template takes its values", async () => {
			const ctx = setup();
			ctx.adapter.foreign.set(INSTANCE_OBJ, {
				type: "instance",
				common: {},
				native: {
					types: [
						{
							id: "custom2",
							name: "Pumpe",
							startVal: 7,
							endVal: 3,
							standby: 1,
							startCount: 1,
							endCount: 9,
						},
					],
				},
			});
			const action = fakeAction({
				forms: [{ manual: true, source: "archive:custom2" }, formOf({ name: "Pumpe" })],
			});
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.deepStrictEqual(action.forms[0].schema.items.source.options.map(o => o.value).slice(-1), [
				"archive:custom2",
			]);
			const native = ctx.adapter.objects.get(`${NS}.pumpe`).native;
			assert.deepStrictEqual(
				[native.detection.startVal, native.detection.endCount, native.template],
				[7, 9, undefined],
			);
		});

		it("an unknown source falls back to the template Custom", async () => {
			const ctx = setup();
			const action = fakeAction({ forms: [{ manual: true, source: "device:gone" }, formOf({ name: "X" })] });
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			const native = ctx.adapter.objects.get(`${NS}.x`).native;
			assert.deepStrictEqual([native.detection.startVal, native.template], [30, "custom"]);
		});

		it("instance action 'remove old templates' deletes native.types after confirmation", async () => {
			const ctx = setup();
			ctx.adapter.foreign.set(INSTANCE_OBJ, {
				type: "instance",
				common: {},
				native: { types: [{ id: "custom2", name: "Pumpe" }], configVersion: 5 },
			});
			const refused = fakeAction({ confirm: false });
			await actionOfInstance(ctx, "removeArchive").handler(refused);
			assert.strictEqual(ctx.adapter.setForeign.length, 0);
			const action = fakeAction({ confirm: true });
			await actionOfInstance(ctx, "removeArchive").handler(action);
			assert.ok(action.confirmations[0].en.includes("restart"), "the confirmation names the restart");
			const written = ctx.adapter.setForeign.at(-1);
			assert.strictEqual(written.id, INSTANCE_OBJ);
			assert.deepStrictEqual(written.obj.native, { types: [], configVersion: 5 });
		});

		it("instance action 'remove old templates' does nothing without an archive", async () => {
			const ctx = setup();
			const action = fakeAction({ confirm: true });
			await actionOfInstance(ctx, "removeArchive").handler(action);
			assert.strictEqual(action.confirmations.length, 0);
			assert.strictEqual(ctx.adapter.setForeign.length, 0);
			assert.strictEqual(action.messages.length, 1);
		});

		it("never uses the id of the info channel", async () => {
			const ctx = setup();
			const action = fakeAction({ forms: [{ manual: true }, formOf({ name: "Info" })] });
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.ok(ctx.adapter.objects.has(`${NS}.info_2`));
			assert.ok(!ctx.adapter.objects.has(`${NS}.info`));
		});

		it("detects the power state of the chosen source and prefills the form", async () => {
			const ctx = setup();
			const action = fakeAction({ forms: [{ manual: false, sourceId: POWER }, formOf()] });
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.strictEqual(action.forms.length, 2);
			assert.strictEqual(action.forms[1].options.data.powerId, POWER);
			assert.strictEqual(action.forms[1].options.data.sourceId, POWER);
			assert.strictEqual(action.forms[1].options.data.enabled, true);
		});

		it("shows the hint when nothing could be detected", async () => {
			const ctx = setup();
			ctx.adapter.foreign.set("plug.9.empty", {
				type: "state",
				common: { type: "number", role: "state" },
				native: {},
			});
			const action = fakeAction({ forms: [{ manual: false, sourceId: "plug.9.empty" }, undefined] });
			const result = await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.deepStrictEqual(result, { refresh: false });
			assert.strictEqual(action.forms[1].schema.items.hint.type, "infoBox");
		});

		it("shows the validation errors and asks again", async () => {
			const ctx = setup();
			const action = fakeAction({
				forms: [{ manual: true }, formOf({ powerId: "" }), formOf({ name: "Spuelmaschine" })],
			});
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.strictEqual(action.messages.length, 1);
			assert.ok(String(action.messages[0]).includes("power state"));
			assert.strictEqual(action.forms.length, 3);
			assert.strictEqual(action.forms[2].options.data.powerId, "", "the entered data is kept");
			assert.ok(ctx.adapter.objects.has(`${NS}.spuelmaschine`));
		});

		it("asks for a source when neither a source nor manual entry was chosen", async () => {
			const ctx = setup();
			const action = fakeAction({ forms: [{ manual: false, sourceId: "" }, undefined] });
			const result = await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.deepStrictEqual(result, { refresh: false });
			assert.strictEqual(action.messages.length, 1);
		});

		it("accepts the flat reminder keys of the form", async () => {
			const ctx = setup();
			const flat = { ...formOf(), reminder: undefined, "reminder.enabled": true, "reminder.intervalMin": 7 };
			const action = fakeAction({ forms: [{ manual: true }, flat] });
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
			assert.strictEqual(native.reminder.enabled, true);
			assert.strictEqual(native.reminder.intervalMin, 7);
		});

		it("does nothing when the wizard is cancelled", async () => {
			const ctx = setup();
			const action = fakeAction({ forms: [undefined] });
			const result = await ctx.dm.getInstanceInfo().actions[0].handler(action);
			assert.deepStrictEqual(result, { refresh: false });
			assert.strictEqual(ctx.adapter.objects.size, 0);
		});
	});

	describe("edit, delete, enable", () => {
		it("replaces the configuration so that removed recipients disappear", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [formOf({ name: "Trockner neu", recipients: ["tg"] })] });
			const result = await actionOf(info, "edit").handler("trockner", action);
			const obj = ctx.adapter.objects.get(`${NS}.trockner`);
			assert.deepStrictEqual(obj.native.recipients, ["tg"]);
			assert.deepStrictEqual(obj.native.detection, testDetection, "editing keeps the detection values");
			assert.strictEqual(action.forms[0].schema.items.template, undefined, "no template when editing");
			assert.strictEqual(obj.common.name, "Trockner neu");
			assert.strictEqual(result.update.name, "Trockner neu");
			assert.strictEqual(action.forms[0].options.data.name, "Trockner", "the form starts with the stored values");
			assert.strictEqual(ctx.registry.get("trockner").config.recipients.length, 1);
		});

		it("drops common.custom from the device object when saving", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			ctx.adapter.objects.get(`${NS}.trockner`).common.custom = null;
			const [info] = await load(ctx);
			await actionOf(info, "edit").handler("trockner", fakeAction({ forms: [formOf({ name: "Trockner" })] }));
			assert.ok(!("custom" in ctx.adapter.objects.get(`${NS}.trockner`).common));
		});

		it("keeps the device when editing is cancelled", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			const result = await actionOf(info, "edit").handler("trockner", fakeAction({ forms: [undefined] }));
			assert.strictEqual(result.update.name, "Trockner");
		});

		it("deletes the device with all its objects after the confirmation", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			await ctx.registry.upsert("trockner", deviceCfg());
			const [info] = await load(ctx);

			const refused = fakeAction({ confirm: false });
			assert.deepStrictEqual(await actionOf(info, "delete").handler("trockner", refused), { refresh: "none" });
			assert.ok(ctx.adapter.objects.has(`${NS}.trockner`));

			const accepted = fakeAction();
			const result = await actionOf(info, "delete").handler("trockner", accepted);
			assert.deepStrictEqual(result, { delete: "trockner" });
			assert.strictEqual(accepted.confirmations.length, 1);
			assert.ok(![...ctx.adapter.objects.keys()].some(k => k.startsWith(`${NS}.trockner`)));
			assert.strictEqual(ctx.registry.get("trockner"), undefined);
		});

		it("disables and enables a device", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			const off = await actionOf(info, "enable/disable").handler("trockner", fakeAction());
			assert.strictEqual(ctx.adapter.objects.get(`${NS}.trockner`).native.enabled, false);
			assert.strictEqual(off.update.enabled, false);
			const on = await actionOf(off.update, "enable/disable").handler("trockner", fakeAction());
			assert.strictEqual(ctx.adapter.objects.get(`${NS}.trockner`).native.enabled, true);
			assert.strictEqual(on.update.enabled, true);
		});
	});

	describe("rooms and functions", () => {
		/**
		 * Setup with two rooms and one function; the dryer is already in the laundry room.
		 */
		function withEnums() {
			const ctx = setup();
			ctx.adapter.foreign.set("enum.rooms.laundry", {
				type: "enum",
				common: { name: { en: "Laundry", de: "Waschküche" }, members: [`${NS}.trockner`] },
				native: {},
			});
			ctx.adapter.foreign.set("enum.rooms.kitchen", {
				type: "enum",
				common: { name: "Kitchen", members: ["hue.0.lamp"] },
				native: {},
			});
			ctx.adapter.foreign.set("enum.functions.energy", {
				type: "enum",
				common: { name: "Energy", members: [] },
				native: {},
			});
			return ctx;
		}
		const members = ctx => Object.fromEntries(ctx.adapter.extendedForeign.map(e => [e.id, e.obj.common.members]));

		it("offers the rooms and functions in the form and assigns a new device", async () => {
			const ctx = withEnums();
			const action = fakeAction({
				forms: [
					{ manual: true },
					formOf({
						name: "Waschmaschine",
						rooms: ["enum.rooms.kitchen"],
						functions: ["enum.functions.energy"],
					}),
				],
			});
			await ctx.dm.getInstanceInfo().actions[0].handler(action);
			const items = action.forms[1].schema.items;
			assert.deepStrictEqual(
				items.rooms.options.map(o => o.label),
				["Kitchen", "Laundry"],
			);
			assert.deepStrictEqual(items.functions.options, [{ value: "enum.functions.energy", label: "Energy" }]);
			assert.deepStrictEqual(members(ctx), {
				"enum.rooms.kitchen": ["hue.0.lamp", `${NS}.waschmaschine`],
				"enum.functions.energy": [`${NS}.waschmaschine`],
			});
		});

		it("preselects the current rooms when editing and moves the device", async () => {
			const ctx = withEnums();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [formOf({ rooms: ["enum.rooms.kitchen"], functions: [] })] });
			await actionOf(info, "edit").handler("trockner", action);
			assert.deepStrictEqual(action.forms[0].options.data.rooms, ["enum.rooms.laundry"]);
			assert.deepStrictEqual(members(ctx), {
				"enum.rooms.kitchen": ["hue.0.lamp", `${NS}.trockner`],
				"enum.rooms.laundry": [],
			});
		});

		it("removes a deleted device from its rooms", async () => {
			const ctx = withEnums();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			await actionOf(info, "delete").handler("trockner", fakeAction());
			assert.deepStrictEqual(members(ctx), { "enum.rooms.laundry": [] });
		});
	});

	describe("operation", () => {
		it("switches do-not-disturb and acknowledges", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			const dnd = await actionOf(info, "dnd").handler("trockner", fakeAction());
			assert.strictEqual(ctx.registry.get("trockner").doNotDisturb, true);
			assert.ok(dnd.update.actions.find(a => a.id === "dnd").description.en.includes("switch off"));

			await ctx.host.setOwnState("trockner.finished", true);
			await actionOf(info, "acknowledge").handler("trockner", fakeAction());
			assert.strictEqual(ctx.host.own("trockner.finished"), false);
		});

		it("sends a test message to the recipients of the device", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			const action = fakeAction();
			await actionOf(info, "test").handler("trockner", action);
			assert.strictEqual(ctx.host.sent.length, 2);
			assert.strictEqual(action.messages[0].en, "The test message was sent.");
		});

		it("tells when nobody was reached", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner", deviceCfg({ recipients: [] }));
			const [info] = await load(ctx);
			const action = fakeAction();
			await actionOf(info, "test").handler("trockner", action);
			assert.strictEqual(ctx.host.sent.length, 0);
			assert.ok(action.messages[0].en.includes("nobody"));
		});
	});

	describe("learn", () => {
		async function record(ctx) {
			await ctx.registry.startLearning("trockner");
			const curve = [...Array(5).fill(0), ...Array(25).fill(100), ...Array(12).fill(1)];
			for (const power of curve) {
				await ctx.registry.routeForeignState(POWER, power);
				ctx.host.tickClock(10_000);
				await ctx.registry.tickAll();
			}
		}

		it("starts the recording on the first call", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const [info] = await load(ctx);
			assert.strictEqual(info.actions.find(a => a.id === "learn").description.en, "Start learning");
			const action = fakeAction();
			const result = await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(ctx.host.own("trockner.learning.active"), true);
			assert.strictEqual(result.update.actions.find(a => a.id === "learn").description.en, "Stop learning");
			assert.strictEqual(action.messages.length, 1);
		});

		it("shows the suggestion and writes the confirmed one into the device", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			await record(ctx);
			const [info] = await load(ctx);
			const action = fakeAction({
				forms: [
					{
						name: "Mein Trockner",
						startVal: "20",
						endVal: 3,
						standby: 0.5,
						startCount: 2,
						endCount: 4,
						startDurationSec: 20,
						endDurationSec: 40,
					},
				],
			});
			const form = async () => action.forms[0];
			await actionOf(info, "learn").handler("trockner", action);
			const dialog = await form();
			assert.ok(dialog.options.data.startVal > 0, "the suggestion is offered");
			assert.strictEqual(dialog.options.data.samples, 42);
			assert.strictEqual(dialog.options.ignoreApplyDisabled, true, "the suggestion can be accepted as is");
			assert.strictEqual(dialog.schema.items.name, undefined, "no name field any more");
			assert.strictEqual(action.confirmations.length, 1, "the change is confirmed first");
			assert.ok(action.confirmations[0].en.includes("startVal 30 → 20"), action.confirmations[0].en);
			assert.ok(!action.confirmations[0].en.includes("restart"));
			assert.deepStrictEqual(ctx.adapter.extendedForeign, [], "the instance object is not touched");
			const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
			assert.deepStrictEqual(
				[
					native.detection.startVal,
					native.detection.endVal,
					native.detection.endCount,
					native.detection.startDurationSec,
				],
				[20, 3, 4, 20],
			);
			assert.strictEqual(native.learned, true, "the card shows the values as learned");
			assert.strictEqual(
				ctx.registry.get("trockner").config.detection.startVal,
				20,
				"the runtime uses the values",
			);
			assert.strictEqual(ctx.host.own("trockner.learning.active"), false);
		});

		it("changes nothing when the values are not confirmed", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			await record(ctx);
			const [info] = await load(ctx);
			const action = fakeAction({
				confirm: false,
				forms: [
					{
						name: "X",
						startVal: 20,
						endVal: 3,
						standby: 1,
						startCount: 2,
						endCount: 4,
						startDurationSec: 1,
						endDurationSec: 1,
					},
				],
			});
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(ctx.adapter.extendedForeign.length, 0);
			assert.deepStrictEqual(ctx.adapter.objects.get(`${NS}.trockner`).native.detection, testDetection);
		});

		it("asks again for invalid values", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			await record(ctx);
			const [info] = await load(ctx);
			const valid = {
				name: "Y",
				startVal: 20,
				endVal: 3,
				standby: 1,
				startCount: 2,
				endCount: 4,
				startDurationSec: 1,
				endDurationSec: 1,
			};
			const action = fakeAction({ forms: [{ ...valid, startVal: -1 }, { ...valid, endCount: 1 }, valid] });
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.messages.length, 3, "two validation errors and the saved hint");
			assert.strictEqual(ctx.adapter.objects.get(`${NS}.trockner`).native.detection.endCount, 4);
		});

		it("reports a recording that is too short", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			await ctx.registry.startLearning("trockner");
			const [info] = await load(ctx);
			const action = fakeAction();
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.forms.length, 0);
			assert.ok(action.messages[0].en.includes("too short"));
			assert.strictEqual(ctx.adapter.extendedForeign.length, 0);
		});

		/**
		 * Let history.0 log the power state with the given stored values.
		 *
		 * @param {object} ctx test context
		 * @param {{ ts: number, val: number }[]} points stored values
		 * @param {object} [common] additional common properties of the power state
		 */
		function withHistory(ctx, points, common = {}) {
			ctx.adapter.foreign.set(POWER, {
				type: "state",
				common: {
					type: "number",
					role: "value.power",
					unit: "W",
					custom: { "history.0": { enabled: true } },
					...common,
				},
				native: {},
			});
			ctx.adapter.foreign.set("system.adapter.history.0", { common: { getHistory: true } });
			ctx.adapter.getForeignStateAsync = async id => ({ val: id === "system.adapter.history.0.alive" });
			// the stored values end two hours ago
			const shift = points.length > 0 ? Date.now() - 2 * 3_600_000 - points.at(-1).ts : 0;
			const stored = points.map(p => ({ ts: p.ts + shift, val: p.val }));
			if (stored.length > 0) {
				// idle before the first run (a run right after the first stored value counts as incomplete)
				stored.unshift({ ts: stored[0].ts - 3_600_000, val: 0.5 });
			}
			ctx.historyQueries = [];
			ctx.adapter.getHistoryAsync = async (id, options) => {
				ctx.historyQuery = { id, options };
				ctx.historyQueries.push(options);
				return { result: stored.filter(p => p.ts >= options.start && p.ts <= options.end) };
			};
			ctx.adapter.setStateAsync = async (id, val) => ctx.adapter.states.set(id, val);
		}

		const learned = {
			startVal: 70,
			endVal: 1.5,
			standby: 0.7,
			startCount: 2,
			endCount: 200,
			startDurationSec: 20,
			endDurationSec: 2000,
			mode: "timed",
		};

		it("learns from the history when the power state is logged", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			withHistory(ctx, historyOf([washingMachine, longPause, washingMachine]));
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [{ source: "history", instance: "history.0" }, {}, learned] });
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.forms[0].options.data.instance, "history.0");
			assert.strictEqual(action.forms[0].options.data.runs, 3, "the source dialog shows the runs found");
			assert.strictEqual(action.forms[0].options.ignoreApplyDisabled, true, "OK works without a change");
			assert.strictEqual(
				action.forms[2].options.ignoreApplyDisabled,
				true,
				"the suggestion can be accepted as is",
			);
			assert.strictEqual(ctx.historyQuery.options.instance, "history.0");
			assert.strictEqual(action.forms.progress.closed, true);
			const dialog = action.forms[2];
			assert.strictEqual(dialog.options.data.runs, 3);
			assert.strictEqual(dialog.options.data.mode, "count");
			assert.match(dialog.options.data.eval_count, /^3\/3 · \d+ min \(max \d+ min\)$/);
			assert.ok(dialog.schema.items.mode, "the detection mode can be chosen");
			assert.strictEqual(dialog.options.data.looText, "2/3");
			assert.ok(dialog.options.data.longestPauseMin >= 20);
			assert.ok(dialog.options.data.pauseHoldSec > 0, "pause protection is suggested");
			assert.match(dialog.options.data.eval_current, /^\d\/3/);
			assert.ok(dialog.schema.items.eval_current);
			const values = action.forms.progress.values;
			assert.strictEqual(values[0], 0);
			assert.strictEqual(values.at(-1), 100);
			assert.ok(
				values.every((v, i) => i === 0 || v >= values[i - 1]),
				`progress ${values}`,
			);
			const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
			assert.strictEqual(native.detection.mode, "timed", "the chosen mode is stored");
			assert.strictEqual(native.detection.endCount, 200);
			assert.notStrictEqual(ctx.host.own("trockner.learning.active"), true, "nothing was recorded");
			assert.ok(JSON.parse(ctx.adapter.states.get("trockner.learning.result")).runs === 3);
		});

		it("learning writes the values into the device and never touches the instance object (M10)", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner", deviceCfg({ detection: DRYER, template: "dryer" }));
			withHistory(ctx, historyOf([washingMachine, longPause, washingMachine]));
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [{ source: "history", instance: "history.0" }, {}, learned] });
			await actionOf(info, "learn").handler("trockner", action);
			const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
			assert.deepStrictEqual(
				[native.detection.mode, native.detection.endCount, native.detection.startVal],
				["timed", 200, 70],
			);
			assert.strictEqual(native.template, undefined);
			assert.deepStrictEqual(ctx.adapter.extendedForeign, []);
			assert.strictEqual(action.forms[2].schema.items.name, undefined, "no name field any more");
		});

		it("learning keeps the final phase of the device", async () => {
			const ctx = setup();
			const final = { finalMinVal: 150, finalMinSec: 168 };
			await addDevice(ctx, "trockner", deviceCfg({ detection: { ...testDetection, ...final } }));
			withHistory(ctx, historyOf([washingMachine, longPause, washingMachine]));
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [{ source: "history", instance: "history.0" }, {}, learned] });
			await actionOf(info, "learn").handler("trockner", action);
			const d = ctx.adapter.objects.get(`${NS}.trockner`).native.detection;
			assert.deepStrictEqual([d.finalMinVal, d.finalMinSec, d.endCount], [150, 168, 200]);
		});

		it("rejects an energy meter and records nothing", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			withHistory(ctx, historyOf([washingMachine, washingMachine]), { unit: "kWh" });
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [{ source: "history" }] });
			await actionOf(info, "learn").handler("trockner", action);
			assert.ok(action.messages[0].en.includes("energy meter"));
			assert.strictEqual(ctx.historyQueries.length, 0);
			assert.notStrictEqual(ctx.host.own("trockner.learning.active"), true);
		});

		it("offers the pause protection and the cross-check in the dialog", () => {
			const items = buildLearnSchema(true, "kW", true).items;
			for (const key of ["pauseHoldSec", "pauseUntilSec", "pauseBelowVal", "looText", "longestPauseMin"]) {
				assert.ok(items[key], key);
			}
			assert.strictEqual(items.endVal.unit, "kW");
			assert.ok(items.eval_current);
			assert.strictEqual(buildLearnSchema(true).items.eval_current, undefined);
			assert.strictEqual(buildLearnSchema(false).items.looText, undefined);
		});

		it("takes the pause protection from the dialog and rejects negative values", () => {
			const form = {
				name: "W",
				startVal: 20,
				endVal: 3,
				standby: 1,
				startCount: 2,
				endCount: 4,
				startDurationSec: 1,
				endDurationSec: 1,
			};
			assert.deepStrictEqual(
				[parseLearnForm(form).values.pauseHoldSec, parseLearnForm(form).values.pauseBelowVal],
				[0, 0],
			);
			const { values } = parseLearnForm({ ...form, pauseHoldSec: "1700", pauseUntilSec: 0, pauseBelowVal: 0.25 });
			assert.deepStrictEqual([values.pauseHoldSec, values.pauseUntilSec, values.pauseBelowVal], [1700, 0, 0.25]);
			assert.ok(parseLearnForm({ ...form, pauseHoldSec: -1 }).error);
		});

		it("offers and takes the anti-crease filter only when it is on", () => {
			const off = buildLearnSchema(true).items;
			assert.strictEqual(off.trailerBurstSec, undefined);
			assert.strictEqual(off.trailerNotSeparable, undefined);
			const on = buildLearnSchema(true, "W", false, true, true, true).items;
			for (const key of [
				"trailerBurstSec",
				"trailerGapSec",
				"trailerAfterSec",
				"trailerBlockVal",
				"trailerMaxSec",
			]) {
				assert.ok(on[key], key);
			}
			assert.strictEqual(on.trailerNotSeparable.boxType, "warning");
			assert.strictEqual(
				buildLearnSchema(false, "W", false, false, false, false, false).items.samples,
				undefined,
			);
			const form = {
				name: "T",
				startVal: 20,
				endVal: 3,
				standby: 1,
				startCount: 2,
				endCount: 4,
				startDurationSec: 1,
				endDurationSec: 1,
			};
			const plainType = parseLearnForm({ ...form, trailerBurstSec: 0, trailerGapSec: 40 }).values;
			assert.ok(!("trailerBurstSec" in plainType) && !("trailerGapSec" in plainType), "off: no trailer fields");
			const withFilter = parseLearnForm({
				...form,
				trailerBurstSec: "45",
				trailerGapSec: 40,
				trailerAfterSec: 0,
				trailerBlockVal: 0,
				trailerMaxSec: 7200,
			}).values;
			assert.deepStrictEqual(
				[withFilter.trailerBurstSec, withFilter.trailerGapSec, withFilter.trailerMaxSec],
				[45, 40, 7200],
			);
			assert.ok(parseLearnForm({ ...form, trailerBurstSec: 45, trailerGapSec: -1 }).error);
			assert.ok(parseLearnForm({ ...form, trailerBurstSec: -1 }).error);
		});

		it("records a new run when chosen instead of the history", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			withHistory(ctx, historyOf([washingMachine, washingMachine]));
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [{ source: "record" }] });
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(ctx.host.own("trockner.learning.active"), true);
		});

		it("does not offer an empty history and records a new run", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			withHistory(ctx, []);
			const [info] = await load(ctx);
			const action = fakeAction();
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.forms.length, 0, "the history is not offered");
			assert.ok(action.forms.progress.closed);
			assert.strictEqual(ctx.host.own("trockner.learning.active"), true);
		});

		it("records a new run when the history holds fewer than two runs", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			withHistory(ctx, historyOf([washingMachine]));
			const [info] = await load(ctx);
			const action = fakeAction();
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.forms.length, 0, "the history is not offered");
			assert.ok(action.messages[0].en.includes("Fewer than 2"));
			assert.strictEqual(ctx.host.own("trockner.learning.active"), true);
		});

		it("says so when the history cannot be read and records a new run", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			withHistory(ctx, historyOf([washingMachine, washingMachine]));
			ctx.adapter.getHistoryAsync = async () => {
				throw new Error("connection lost");
			};
			const [info] = await load(ctx);
			const action = fakeAction();
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.forms.length, 0, "the history is not offered");
			assert.ok(action.messages[0].en.includes("could not be read"), JSON.stringify(action.messages[0]));
			assert.ok(ctx.host.logs.warn.some(m => m.includes("connection lost")));
			assert.strictEqual(ctx.host.own("trockner.learning.active"), true);
		});

		it("cancelling the source dialog changes nothing", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			withHistory(ctx, historyOf([washingMachine, washingMachine]));
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [undefined] });
			await actionOf(info, "learn").handler("trockner", action);
			assert.notStrictEqual(ctx.host.own("trockner.learning.active"), true);
			assert.strictEqual(ctx.adapter.extendedForeign.length, 0);
		});

		it("cancelling the suggestion dialog changes nothing", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			await record(ctx);
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [undefined] });
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.confirmations.length, 0);
			assert.strictEqual(ctx.adapter.extendedForeign.length, 0);
		});

		describe("learning dialog with the run check (Spec B.7)", function () {
			this.timeout(600_000);
			const WPTS = loadSeries("washer30d");

			async function open(answers, cfg = {}) {
				const ctx = setup({ files: memoryFiles() });
				await addDevice(ctx, "wm", deviceCfg({ name: "WM", template: "washing-machine", ...cfg }));
				withHistory(ctx, WPTS);
				const [info] = await load(ctx);
				const action = fakeAction({ forms: answers });
				await actionOf(info, "learn").handler("wm", action);
				return { ctx, action };
			}

			it("lists every run with its check; sparse w04 marked, use column defaults to auto", async () => {
				const { action } = await open([{ source: "history", instance: "history.0" }]);
				const rows = action.forms[1].options.data.runs;
				assert.ok(rows.length >= 12, `${rows.length} rows`);
				assert.ok(rows.every(r => r.use === "auto"));
				assert.ok(rows.some(r => /sparse|gestört/i.test(r.check)));
				assert.ok(
					rows.some(r => r.check === "✓"),
					"a clean run shows a tick",
				);
				assert.ok(
					action.forms[1].schema.items.runs || action.forms[1].schema.items.runs_text,
					"table or fallback",
				);
			});

			it("suggestion from admitted runs only; final phase offered with key figures, checkbox off by default", async () => {
				const { action } = await open([{ source: "history", instance: "history.0" }, { operation: "next" }]);
				const d = action.forms[2].options.data;
				assert.strictEqual(d.final_apply, false);
				// the tests run with I18n "en" (test/helpers/i18n.js)
				assert.match(
					d.final_text,
					/^Finished \d+ min earlier \(median\), \d+ of \d+ runs, 0 too early, \d+ fallback/,
				);
				assert.ok(action.forms[2].schema.items.final_apply, "the checkbox exists");
				assert.ok(action.forms[2].schema.items.showPhases, "phases can be switched on");
			});

			it("both run table variants are built; fallback is the default until the real system check", () => {
				const rows = [
					{
						key: "wm@1",
						date: "01.11.",
						durationMin: 140,
						energyWh: 600,
						family: 0,
						phases: "",
						check: "✓",
						boundary: "",
						use: "auto",
					},
				];
				assert.strictEqual(buildRunTable(rows, "table").runs.type, "table");
				assert.ok(buildRunTable(rows, "table").runs.noDelete);
				assert.ok(buildRunTable(rows, "table").runs.items.some(i => i.attr === "use" && i.type === "select"));
				assert.ok(
					Object.values(buildRunTable(rows, "fallback")).some(
						i => i.type === "select" && i.multiple === true,
					),
				);
				assert.strictEqual(RUN_TABLE_MODE, "fallback");
			});

			it('"recalculate" shows the list again with the decision applied', async () => {
				const { action } = await open([
					{ source: "history", instance: "history.0" },
					{ runs: [{ use: "exclude" }], recalc: true },
					{},
				]);
				const first = action.forms[1].options.data.runs;
				const again = action.forms[2].options.data.runs;
				assert.strictEqual(again[0].use, "exclude");
				assert.deepStrictEqual(action.forms[2].options.data.useExclude, [first[0].key]);
				assert.ok(again.slice(1).every(r => r.use === "auto"));
			});

			it("reads the use of a run from the table and from the two selects of the fallback", () => {
				const row = (key, use = "auto") => ({ key, use });
				const rows = [row("a"), row("b"), row("c", "include")];
				const table = usesOfAnswer({ runs: [{ use: "include" }, { key: "b", use: "exclude" }] }, rows);
				assert.deepStrictEqual(
					[...table],
					[
						["a", "include"],
						["b", "exclude"],
						["c", "include"],
					],
				);
				const selects = usesOfAnswer({ useInclude: ["a", "b"], useExclude: ["b"] }, rows);
				assert.deepStrictEqual(
					[...selects],
					[
						["a", "include"],
						["b", "exclude"],
						["c", "auto"],
					],
				);
				assert.deepStrictEqual(
					[...usesOfAnswer({}, rows)],
					[
						["a", "auto"],
						["b", "auto"],
						["c", "include"],
					],
				);
			});

			it("apply writes detection, final values and phases into the device and decisions into the store, no restart", async () => {
				const { ctx, action } = await open([
					{ source: "history", instance: "history.0" },
					{ operation: "next", runs: [{ use: "exclude" }] },
					{ operation: "apply", final_apply: true, showPhases: true },
				]);
				assert.strictEqual(action.confirmations.length, 1);
				const native = ctx.adapter.objects.get(`${NS}.wm`).native;
				assert.ok(native.detection.finalMinVal > 0, "final phase taken over");
				assert.strictEqual(native.phases?.enabled, true);
				assert.strictEqual(native.template, undefined);
				assert.deepStrictEqual(ctx.adapter.extendedForeign, []);
				const st = await ctx.registry.readLearningData("wm");
				assert.ok(Object.values(st.verdicts).some(v => v.user === "exclude"));
				assert.ok(
					st.runs.length >= 5 && st.runs.every(r => r.src === "history"),
					"comparison runs for judging afterwards",
				);
				assert.ok(st.bands, "base bands stored");
				assert.strictEqual(action.messages.at(-1).en.includes("saved"), true);
			});

			it("without the checkbox the final phase of the device stays; decisions are still stored", async () => {
				const { ctx } = await open([
					{ source: "history", instance: "history.0" },
					{ runs: [{ use: "exclude" }] },
					{ final_apply: false },
				]);
				const native = ctx.adapter.objects.get(`${NS}.wm`).native;
				assert.ok(!native.detection.finalMinVal, "no final phase");
				assert.strictEqual(native.phases, undefined, "phases stay off");
				const st = await ctx.registry.readLearningData("wm");
				assert.ok(Object.values(st.verdicts).some(v => v.user === "exclude"));
				assert.strictEqual(st.runs.length, 0, "no comparison runs without the final phase");
			});

			it("cancelling after the runs changes nothing", async () => {
				const { ctx, action } = await open([
					{ source: "history", instance: "history.0" },
					{ useExclude: [] },
					undefined,
				]);
				assert.strictEqual(action.confirmations.length, 0);
				assert.strictEqual(await ctx.registry.readLearningData("wm"), null);
			});

			it("recording a run never offers a final phase", async () => {
				const ctx = setup();
				await addDevice(ctx, "trockner");
				await ctx.registry.startLearning("trockner");
				for (const v of runOf({ device: "washer", programme: "cotton60", seed: 1 }).values) {
					await ctx.registry.routeForeignState(POWER, v);
					ctx.host.tickClock(10_000);
					await ctx.registry.tickAll();
				}
				const [info] = await load(ctx);
				const action = fakeAction({ forms: [] });
				await actionOf(info, "learn").handler("trockner", action);
				assert.strictEqual(action.forms[0].options.data.final_apply, undefined);
				assert.strictEqual(action.forms[0].schema.items.final_apply, undefined);
				assert.strictEqual(action.forms[0].schema.items.showPhases, undefined);
			});

			it("an energy meter is not recorded either", async () => {
				const ctx = setup();
				await addDevice(ctx, "trockner");
				ctx.adapter.foreign.set(POWER, {
					type: "state",
					common: { type: "number", role: "value.energy", unit: "kWh" },
					native: {},
				});
				const [info] = await load(ctx);
				const action = fakeAction({ forms: [] });
				await actionOf(info, "learn").handler("trockner", action);
				assert.ok(action.messages.includes(TEXT.learnEnergyCounter));
				assert.notStrictEqual(ctx.host.own("trockner.learning.active"), true);
			});

			it("a recording gets only the checks that need no other runs", () => {
				const clean = Array.from({ length: 60 }, (_, i) => ({ t: i * 10_000, p: i >= 10 && i < 40 ? 100 : 1 }));
				assert.deepStrictEqual(recordingChecks(clean, 10), []);
				const broken = clean.map((s, i) => (i % 10 === 3 ? { ...s, p: Number.NaN } : s));
				assert.deepStrictEqual(recordingChecks(broken, 10), ["invalid"]);
			});

			it("an energy counter aborts with its reason", async () => {
				const ctx = setup();
				await addDevice(ctx, "trockner");
				withHistory(ctx, historyOf([washingMachine, washingMachine]), { unit: "kWh" });
				const [info] = await load(ctx);
				const action = fakeAction({ forms: [] });
				await actionOf(info, "learn").handler("trockner", action);
				assert.ok(action.messages.includes(TEXT.learnEnergyCounter));
			});
		});
	});

	describe("getDeviceDetails", () => {
		it("shows the last operations, the detection values and the reminder status", async () => {
			const ctx = setup();
			await addDevice(
				ctx,
				"trockner",
				deviceCfg({ reminder: { ...DEFAULT_REMINDER, enabled: true, intervalMin: 15, maxCount: 4 } }),
			);
			ctx.adapter.states.set(
				"trockner.lastOperations",
				JSON.stringify([
					{ start: "a", end: "b", runtime: "0:10:00" },
					{ start: "c", end: "d", runtime: "0:20:00" },
				]),
			);
			const details = await ctx.dm.getDeviceDetails("trockner");
			assert.strictEqual(details.id, "trockner");
			assert.strictEqual(details.schema.type, "panel");
			assert.deepStrictEqual(
				details.data.lastOperations.map(o => o.start),
				["c", "a"],
				"newest first",
			);
			assert.strictEqual(details.schema.items.lastOperations.type, "table");
			const values = Object.values(details.schema.items).filter(i => i.type === "staticInfo");
			assert.ok(
				values.some(
					i =>
						i.label.de === I18n.getTranslatedObject("dm_detailsStartVal").de &&
						i.data === 30 &&
						i.unit === "W",
				),
			);
			assert.ok(
				values.some(
					i => i.label.de === I18n.getTranslatedObject("dm_detailsReminderInterval").de && i.data === 15,
				),
			);
			assert.ok(
				values.some(i => i.label.de === I18n.getTranslatedObject("dm_detailsReminderMax").de && i.data === 4),
			);
			assert.ok(
				!values.some(i => i.label.de === I18n.getTranslatedObject("dm_detailsPauseHold").de),
				"no pause protection rows when off",
			);
		});

		it("shows the pause protection when it is on", async () => {
			const ctx = setup();
			await addDevice(
				ctx,
				"trockner",
				deviceCfg({ detection: { ...testDetection, pauseHoldSec: 1700, pauseBelowVal: 0.25 } }),
			);
			const details = await ctx.dm.getDeviceDetails("trockner");
			const values = Object.values(details.schema.items).filter(i => i.type === "staticInfo");
			assert.ok(
				values.some(i => i.label.de === I18n.getTranslatedObject("dm_detailsPauseHold").de && i.data === 1700),
			);
			assert.ok(
				values.some(i => i.label.de === I18n.getTranslatedObject("dm_detailsPauseBelow").de && i.data === 0.25),
			);
		});

		it("tolerates a broken lastOperations state and shows the review hint", async () => {
			const ctx = setup();
			const { detection: _d, ...noValues } = deviceCfg({ typeId: "gone" });
			await addDevice(ctx, "trockner", noValues);
			ctx.adapter.states.set("trockner.lastOperations", "{not json");
			const details = await ctx.dm.getDeviceDetails("trockner");
			assert.deepStrictEqual(details.data.lastOperations, []);
			assert.strictEqual(details.schema.items.needsReview.type, "infoBox");
			assert.ok(details.schema.items.needsReview.text.en.includes("Custom"));
		});

		it("answers an unknown device with an error", async () => {
			const ctx = setup();
			assert.deepStrictEqual(await ctx.dm.getDeviceDetails("nope"), { error: "unknownDevice" });
		});
	});
});

describe("texts of the device manager forms", () => {
	it("come from the admin translations in every language", async () => {
		const { buildLearnSourceSchema } = await import("../build/lib/deviceManagement.js");
		const schema = buildLearnSourceSchema();
		const keys = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
		for (const text of [schema.items.info.text, schema.items.source.label, schema.items.source.options[0].label]) {
			assert.deepStrictEqual(Object.keys(text).sort(), [...keys].sort());
			assert.ok(!text.en.startsWith("dm_"), `translated: ${text.en}`);
		}
	});
});

describe("optimisation in the device manager", function () {
	this.timeout(120_000);
	const dryerType = DRYER;

	/**
	 * Device manager with a dryer that has the automatic optimisation on.
	 *
	 * @param {object} [over] device options
	 * @param {boolean} [withRun] play one run with anti-crease bursts (repaired after the run)
	 * @returns {Promise<object>} context
	 */
	async function optSetup(over = {}, withRun = true) {
		const ctx = setup({ files: memoryFiles() });
		await addDevice(ctx, "trockner", deviceCfg({ detection: DRYER, autoOptimize: true, ...over }));
		if (withRun) {
			const run = runOf({ device: "dryer", programme: "cupboard", shape: "T1", seed: 3, after: 400 });
			for (const v of run.values) {
				await ctx.registry.routeForeignState(POWER, v);
				ctx.host.tickClock(10_000);
				await ctx.registry.tickAll();
			}
			let done = false;
			void ctx.registry.whenOptimized().then(() => (done = true));
			for (let i = 0; i < 100_000 && !done; i++) {
				await ctx.host.advance(0);
				await new Promise(resolve => setImmediate(resolve));
			}
		}
		return ctx;
	}

	async function openDialog(ctx, answer, confirm = true) {
		const [info] = await load(ctx);
		const action = fakeAction({ forms: [answer], confirm });
		await actionOf(info, "optimization").handler("trockner", action);
		return action;
	}

	it("shows the action only with the automatic optimisation or stored learning data", async () => {
		const plain = setup({ files: memoryFiles() });
		await addDevice(plain, "trockner");
		assert.ok(!(await load(plain))[0].actions.some(a => a.id === "optimization"));
		const ctx = await optSetup({}, false);
		const action = (await load(ctx))[0].actions.find(a => a.id === "optimization");
		assert.ok(action);
		assert.ok(!action.description.en.startsWith("dm_"));
	});

	it("shows status, values, runs and changes and does nothing without an action", async () => {
		const ctx = await optSetup();
		const action = await openDialog(ctx, { operation: "" });
		const { schema, options } = action.forms[0];
		assert.ok(!schema.items.status.data.en.startsWith("dm_"), "status translated");
		assert.ok(options.data.params.some(r => r.name === "trailerBurstSec"));
		assert.ok(
			options.data.params.some(r => r.effective.endsWith("*")),
			"optimised values are marked",
		);
		assert.ok(options.data.runs.length >= 1);
		assert.ok(
			options.data.runs.every(r => r.gate === "✓"),
			"every stored run passes after the repair",
		);
		assert.ok(options.data.changes[0].kind.length > 0);
		assert.deepStrictEqual(
			schema.items.operation.options.map(o => o.value),
			["", "undo", "reset", "discard", "clear", "adopt"],
		);
		assert.ok(schema.items.discardRun.options.length >= 1);
		assert.deepStrictEqual(action.messages, []);
	});

	it("undoes, resets, discards and clears", async () => {
		const ctx = await optSetup();
		assert.ok(ctx.registry.get("trockner").currentOverride !== null, "the repair is active");
		let action = await openDialog(ctx, { operation: "undo" });
		assert.ok(action.messages[0].en.includes("undone"));
		assert.strictEqual(ctx.registry.get("trockner").currentOverride, null);
		action = await openDialog(ctx, { operation: "reset" });
		assert.ok(action.messages[0].en.includes("base values"));
		assert.strictEqual(ctx.registry.learningData("trockner").changes.at(-1).kind, "reset");

		action = await openDialog(ctx, { operation: "discard" });
		assert.ok(action.messages[0].en.includes("Select"));
		const store = ctx.registry.learningData("trockner");
		const id = [...store.runs, ...store.spikes][0].id;
		const count = store.runs.length + store.spikes.length;
		action = await openDialog(ctx, { operation: "discard", discardRun: id });
		assert.ok(action.messages[0].en.includes("discarded"));
		const left = ctx.registry.learningData("trockner");
		const shown = [...left.runs, ...left.spikes].filter(r => left.verdicts[r.key]?.user !== "exclude");
		assert.strictEqual(shown.length, count - 1);
		const view = await openDialog(ctx, { operation: "" });
		assert.ok(
			!(view.forms[0].schema.items.discardRun?.options ?? []).some(o => o.value === id),
			"no longer listed",
		);

		action = await openDialog(ctx, { operation: "clear" }, false);
		assert.strictEqual(action.messages.length, 0, "cancelled");
		action = await openDialog(ctx, { operation: "clear" });
		assert.ok(!action.confirmations[0].en.startsWith("dm_"));
		assert.ok(action.messages[0].en.includes("cleared"));
		assert.strictEqual(ctx.registry.learningData("trockner").runs.length, 0);
		assert.strictEqual(ctx.registry.learningData("trockner").spikes.length, 0);
	});

	it("adopt as base writes the device first; failing write keeps the override (P29)", async () => {
		const ctx = await optSetup();
		const before = ctx.registry.learningData("trockner").override;
		assert.ok(before, "the run produced an override");
		const eff = ctx.registry.get("trockner").effective;
		const action = await openDialog(ctx, { operation: "adopt" });
		assert.strictEqual(action.confirmations.length, 1);
		assert.ok(action.confirmations[0].en.startsWith(TEXT.optAdoptConfirm.en.split("{")[0]), "own confirmation");
		assert.deepStrictEqual(ctx.adapter.extendedForeign, [], "the instance object is not touched");
		const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
		assert.deepStrictEqual(detectionOf(native.detection), ctx.registry.get("trockner").effective);
		assert.deepStrictEqual(ctx.registry.get("trockner").effective, eff, "same values in use");
		assert.strictEqual(native.learned, true);
		assert.deepStrictEqual(
			[ctx.registry.learningData("trockner").override, ctx.registry.learningData("trockner").changes.at(-1).kind],
			[null, "adopted"],
		);
		assert.deepStrictEqual(action.messages, [TEXT.optAdopted]);
		const again = await openDialog(ctx, { operation: "adopt" });
		assert.deepStrictEqual(again.messages, [TEXT.optNothingToAdopt]);

		const ctx2 = await optSetup();
		const ov = ctx2.registry.learningData("trockner").override;
		ctx2.adapter.setObjectAsync = async () => {
			throw new Error("disk full");
		}; // writeDevice writes with setObjectAsync first
		const failed = await openDialog(ctx2, { operation: "adopt" });
		assert.deepStrictEqual(ctx2.registry.learningData("trockner").override, ov);
		assert.deepStrictEqual(failed.messages, [TEXT.optAdoptFailed]);

		const ctx3 = await optSetup();
		const cancelled = await openDialog(ctx3, { operation: "adopt" }, false);
		assert.deepStrictEqual(cancelled.messages, []);
		assert.ok(ctx3.registry.learningData("trockner").override, "cancelled: nothing adopted");
	});

	it("explains that the optimisation is off when there is no learning data", async () => {
		const ctx = await optSetup({}, false);
		await ctx.registry.deleteLearningData("trockner");
		await ctx.registry.upsert("trockner", deviceCfg({ detection: DRYER }));
		const action = fakeAction();
		await ctx.dm.optimization("trockner", action);
		assert.ok(action.messages[0].en.includes("off"));
	});

	it("offers only clearing while the optimisation is off", () => {
		const store = { runs: [], spikes: [], changes: [], info: { status: "ok", trailer: "none" } };
		const view = buildOptimizationView(store, null, dryerType, dryerType, false);
		assert.deepStrictEqual(
			view.schema.items.operation.options.map(o => o.value),
			["", "clear"],
		);
		assert.ok(view.schema.items.none);
		assert.strictEqual(view.schema.items.status.data.en, "Off");
		assert.strictEqual(suggestionOf(dryerType).trailerBurstSec, undefined);
	});

	it("shows old 'typeChanged' entries like 'baseChanged'", () => {
		const change = kind => ({ ts: 1, kind, from: { endCount: 30 }, to: null, reason: "", runs: 0, gainSec: 0 });
		const store = {
			runs: [],
			spikes: [],
			changes: [change("typeChanged"), change("baseChanged")],
			info: { status: "ok", trailer: "none" },
		};
		const view = buildOptimizationView(store, null, DRYER, DRYER, false);
		const text = I18n.translate("dm_optKind_baseChanged");
		assert.ok(!text.startsWith("dm_"), "translated");
		assert.deepStrictEqual(
			view.data.changes.map(c => c.kind),
			[text, text],
		);
	});

	it("lists the final phase fields in the value table only when they are used", () => {
		const store = { runs: [], spikes: [], changes: [], info: { status: "ok", trailer: "none" } };
		const plainView = buildOptimizationView(store, null, dryerType, dryerType, false);
		assert.strictEqual(plainView.data.params.length, 16);
		assert.ok(!plainView.data.params.some(r => r.name.startsWith("final")));
		const used = { ...dryerType, finalMinVal: 150, finalMinSec: 168 };
		const view = buildOptimizationView(store, null, dryerType, used, false);
		assert.deepStrictEqual(
			view.data.params.filter(r => r.name.startsWith("final")),
			[
				{ name: "finalMinVal", type: "0", effective: "150 *" },
				{ name: "finalMinSec", type: "0", effective: "168 *" },
			],
		);
	});

	it("has all texts of the optimisation in every language", () => {
		const keys = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
		const ids = [
			"dm_autoOptimize",
			"dm_autoOptimizeHelp",
			"dm_optimizeNotify",
			"dm_optimization",
			"dm_optClearConfirm",
			"dm_optAdopt",
			"dm_optNone",
			"dm_optStatus_drift",
			"dm_optTrailer_notSeparable",
			"dm_optLabel_split",
			"dm_optKind_tighten",
			"dm_learnTrailerNotSeparable",
			"typeTrailerBurst",
			"typeTrailerMaxTooltip",
		];
		for (const id of ids) {
			const text = I18n.getTranslatedObject(id);
			assert.deepStrictEqual(Object.keys(text).sort(), [...keys].sort(), id);
			for (const lang of keys) {
				assert.ok(text[lang] && text[lang] !== id, `${id}.${lang}`);
			}
		}
	});
});
