import assert from "node:assert";
import { DEFAULT_REMINDER, normalizeDeviceConfig, normalizeInstanceConfig } from "../build/lib/config.js";
import { decisionOf, detectionOf } from "../build/lib/runStore.js";
import { DRYER, WASHER } from "./helpers/devices.js";
import { WM_FINAL } from "./helpers/final.js";
import { detectorRun, layoutOf, layoutRun, loadSeries, runIndex, ticksOf } from "./helpers/fixtures.js";
import {
	droppedText,
	finalPhaseOf,
	finalText,
	finishChoiceOf,
	finishOptions,
	finishPreset,
	phaseData,
	phaseItems,
	phasesFromForm,
	usesOfAnswer,
} from "../build/lib/learnDialog.js";
import { FINAL_KEYS } from "../build/lib/detector/types.js";
import { recordingChecks } from "../build/lib/learning.js";
import { DeviceRegistry } from "../build/lib/deviceRegistry.js";
import {
	afterRunChanged,
	afterRunData,
	buildLearnSchema,
	changedValues,
	oldValuesOf,
	buildRunTable,
	RUN_TABLE_MODE,
	buildOptimizationView,
	deviceModel,
	parseLearnForm,
	ReminderDeviceManagement,
	suggestionOf,
	trailerValuesOf,
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
			// an answer may depend on the form (e.g. a phase id learned in the dialog)
			const answer = answers.shift();
			return typeof answer === "function" ? answer(schema, options) : answer;
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

		it("card warning: no setting detects every admitted run (cannotCover) and drift (Spec D.3 point 3, D.4)", async () => {
			const ctx = setup({ files: memoryFiles() });
			await addDevice(ctx, "trockner", deviceCfg({ detection: DRYER, autoOptimize: true }));
			const st = ctx.registry.learningData("trockner");
			let [info] = await load(ctx);
			assert.notDeepStrictEqual(info.status.warning, TEXT.cannotCoverCard);
			st.info.status = "cannotCover";
			[info] = await load(ctx);
			assert.deepStrictEqual(info.status.warning, TEXT.cannotCoverCard);
			st.info.status = "drift";
			[info] = await load(ctx);
			assert.deepStrictEqual(info.status.warning, TEXT.driftCard);
			st.info.status = "ok";
			[info] = await load(ctx);
			assert.notDeepStrictEqual(info.status.warning, TEXT.driftCard);
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
			const action = fakeAction({ forms: [{ source: "history", instance: "history.0" }, learned] });
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.forms[0].options.data.instance, "history.0");
			assert.strictEqual(action.forms[0].options.data.runs, 3, "the source dialog shows the runs found");
			assert.strictEqual(action.forms[0].options.ignoreApplyDisabled, true, "OK works without a change");
			assert.strictEqual(
				action.forms[1].options.ignoreApplyDisabled,
				true,
				"the suggestion can be accepted as is",
			);
			assert.strictEqual(ctx.historyQuery.options.instance, "history.0");
			assert.strictEqual(action.forms.progress.closed, true);
			const dialog = action.forms[1];
			assert.strictEqual(dialog.options.data.runs, 3);
			assert.strictEqual(dialog.options.data.mode, "count");
			assert.match(dialog.options.data.eval_count, /^3\/3 · \d+ min \(max \d+ min\)$/);
			assert.ok(dialog.schema.items.mode, "the detection mode can be chosen");
			assert.strictEqual(dialog.options.data.looText, "2/3");
			assert.ok(dialog.options.data.longestPauseMin >= 20);
			assert.ok(dialog.options.data.pauseHoldSec > 0, "pause protection is suggested");
			assert.match(dialog.options.data.eval_current, /^\d\/3/);
			assert.ok(dialog.schema.items.details.items.eval_current, "under Details");
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
			const action = fakeAction({ forms: [{ source: "history", instance: "history.0" }, learned] });
			await actionOf(info, "learn").handler("trockner", action);
			const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
			assert.deepStrictEqual(
				[native.detection.mode, native.detection.endCount, native.detection.startVal],
				["timed", 200, 70],
			);
			assert.strictEqual(native.template, undefined);
			assert.deepStrictEqual(ctx.adapter.extendedForeign, []);
			assert.strictEqual(action.forms[1].schema.items.name, undefined, "no name field any more");
		});

		it("learning keeps the final phase of the device", async () => {
			const ctx = setup();
			const final = { finalMinVal: 150, finalMinSec: 168 };
			await addDevice(ctx, "trockner", deviceCfg({ detection: { ...testDetection, ...final } }));
			withHistory(ctx, historyOf([washingMachine, longPause, washingMachine]));
			const [info] = await load(ctx);
			const action = fakeAction({ forms: [{ source: "history", instance: "history.0" }, learned] });
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

		it("offers the pause protection in the dialog and the cross-check under Details", () => {
			const items = buildLearnSchema({ fromHistory: true, unit: "kW", withCurrent: true }).items;
			for (const key of ["pauseHoldSec", "pauseUntilSec", "pauseBelowVal"]) {
				assert.ok(items[key], key);
			}
			const details = items.details.items;
			for (const key of ["looText", "longestPauseMin", "eval_count", "eval_current", "samples"]) {
				assert.ok(details[key], key);
			}
			assert.strictEqual(items.endVal.unit, "kW");
			assert.deepStrictEqual(
				[items.details.type, items.details.collapsable, items.details.color],
				["panel", true, undefined],
				"a collapsible panel without colour",
			);
			assert.strictEqual(buildLearnSchema({ fromHistory: true }).items.details.items.eval_current, undefined);
			assert.strictEqual(buildLearnSchema().items.details.items.looText, undefined);
		});

		it("shows every detection value next to the value of the device and marks the changed ones (Spec B.7)", () => {
			const before = {
				mode: "count",
				startVal: 20,
				endVal: 3,
				standby: 1,
				startCount: 2,
				endCount: 4,
				startDurationSec: 0,
				endDurationSec: 0,
			};
			const changed = changedValues(before, { ...before, endVal: "5", mode: "timed", pauseHoldSec: 0 });
			assert.deepStrictEqual([...changed].sort(), ["endVal", "mode"]);
			const items = buildLearnSchema({ changed }).items;
			const rows = ["mode", "startVal", "endVal", "standby", "startCount", "endCount", "startDurationSec"].concat(
				["endDurationSec", "pauseHoldSec", "pauseUntilSec", "pauseBelowVal"],
			);
			for (const key of rows) {
				assert.strictEqual(items[`lbl_${key}`].type, "staticText", key);
				assert.deepStrictEqual([items[`old_${key}`].type, items[`old_${key}`].disabled], ["text", true], key);
				assert.ok(!items[key].disabled, `${key} can be changed`);
			}
			assert.match(items.lbl_endVal.text.en, /^≠ End threshold$/);
			assert.match(items.lbl_mode.text.de, /^≠ /);
			assert.doesNotMatch(items.lbl_startVal.text.en, /≠/);
			assert.deepStrictEqual(
				Object.keys(items).filter(k => k.startsWith("trailer")),
				[],
				"no fields of the after-run filter",
			);
			const old = oldValuesOf(before, "W");
			assert.deepStrictEqual(
				[old.old_mode, old.old_endVal, old.old_startCount, old.old_endDurationSec, old.old_pauseBelowVal],
				["Count", "3 W", "2", "0 s", "0 W"],
			);
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

		it("takes the after-run filter without fields of its own, and only when it is on", () => {
			const off = buildLearnSchema({ fromHistory: true }).items;
			assert.strictEqual(off.trailerNotSeparable, undefined);
			const on = buildLearnSchema({ fromHistory: true, notSeparable: true }).items;
			for (const key of [
				"trailerBurstSec",
				"trailerGapSec",
				"trailerAfterSec",
				"trailerBlockVal",
				"trailerMaxSec",
			]) {
				assert.strictEqual(on[key], undefined, key);
			}
			assert.strictEqual(on.trailerNotSeparable.boxType, "warning");
			assert.match(I18n.translate("dm_learnTrailerNotSeparable"), /after-run/);
			assert.strictEqual(buildLearnSchema({ withSamples: false }).items.details, undefined, "no empty Details");
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
			// the answer never carries the after-run filter: its values come from the suggestion
			const parsed = parseLearnForm({ ...form, trailerBurstSec: 45, trailerGapSec: 40 }).values;
			assert.ok(!("trailerBurstSec" in parsed) && !("trailerGapSec" in parsed), "not read from the answer");
			assert.deepStrictEqual(trailerValuesOf({ trailerBurstSec: 0, trailerGapSec: 40 }), {}, "off: 3.1.2");
			const suggested = { trailerBurstSec: 45, trailerGapSec: 40, trailerMaxSec: 7200 };
			assert.deepStrictEqual(trailerValuesOf(suggested), {
				trailerBurstSec: 45,
				trailerGapSec: 40,
				trailerAfterSec: 0,
				trailerBlockVal: 0,
				trailerMaxSec: 7200,
			});
			// before | new in "Details", read-only, only when the device or the suggestion uses the filter
			const plain = { mode: "count", trailerGapSec: 99 };
			assert.deepStrictEqual(afterRunData(plain, {}), {});
			assert.strictEqual(afterRunChanged(plain, {}), undefined);
			assert.strictEqual(buildLearnSchema({}).items.details?.items.afterRun_new_trailerBurstSec, undefined);
			const next = trailerValuesOf(suggested);
			const changed = afterRunChanged(plain, next);
			assert.deepStrictEqual([...changed], ["trailerBurstSec", "trailerGapSec", "trailerMaxSec"]);
			const data = afterRunData(plain, next, "W");
			assert.deepStrictEqual(
				[data.afterRun_old_trailerGapSec, data.afterRun_new_trailerGapSec, data.afterRun_new_trailerBlockVal],
				["0 s", "40 s", "0 W"],
				"an old value of a filter that is off counts as 0",
			);
			const rows = buildLearnSchema({ afterRun: changed }).items.details.items;
			for (const key of [
				"trailerBurstSec",
				"trailerGapSec",
				"trailerAfterSec",
				"trailerBlockVal",
				"trailerMaxSec",
			]) {
				assert.ok(rows[`afterRun_old_${key}`].disabled && rows[`afterRun_new_${key}`].disabled, key);
			}
			assert.match(rows.afterRun_lbl_trailerBurstSec.text.en, /^≠ After-run: longest burst$/);
			assert.doesNotMatch(rows.afterRun_lbl_trailerAfterSec.text.en, /≠/);
			assert.deepStrictEqual([...afterRunChanged({ ...plain, ...next }, next)], [], "unchanged");
		});

		it("saves the after-run filter of the suggestion when the answer holds only the fields of the form", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner");
			const suggestion = {
				thresholds: { startVal: 20, endVal: 3, standby: 1, startCount: 2, endCount: 4 },
				startDurationSec: 1,
				endDurationSec: 1,
				durationSec: 3600,
				samples: 100,
				pauseHoldSec: 0,
				pauseUntilSec: 0,
				pauseBelowVal: 0,
				trailerBurstSec: 45,
				trailerGapSec: 40,
				trailerMaxSec: 7200,
			};
			const fields = [
				"mode",
				"startVal",
				"endVal",
				"standby",
				"startCount",
				"endCount",
				"startDurationSec",
			].concat(["endDurationSec", "pauseHoldSec", "pauseUntilSec", "pauseBelowVal"]);
			const action = fakeAction({
				// like a form that returns only its fields: the data keys without a field are left out
				forms: [(schema, options) => Object.fromEntries(fields.map(k => [k, options.data[k]]))],
			});
			await load(ctx);
			await ctx.dm.applyLearned("trockner", suggestion, action);
			const d = ctx.adapter.objects.get(`${NS}.trockner`).native.detection;
			assert.deepStrictEqual([d.trailerBurstSec, d.trailerGapSec, d.trailerMaxSec], [45, 40, 7200]);
			const { schema, options } = action.forms[0];
			assert.strictEqual(schema.items.trailerBurstSec, undefined, "no field of its own");
			assert.strictEqual(options.data.afterRun_new_trailerBurstSec, "45 s");
			assert.ok(schema.items.details.items.afterRun_old_trailerBurstSec.disabled, "before | new in Details");
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
			// the poll grid of the loaded history starts at "now - 30 days": a clock that runs on while a test learns
			// twice (slow under coverage) would shift the grid and with it the learned values between the two dialogs
			const realNow = Date.now;
			beforeEach(() => {
				const now = realNow();
				Date.now = () => now;
			});
			afterEach(() => {
				Date.now = realNow;
			});

			async function open(answers, cfg = {}) {
				const ctx = setup({ files: memoryFiles() });
				await addDevice(ctx, "wm", deviceCfg({ name: "WM", template: "washing-machine", ...cfg }));
				withHistory(ctx, WPTS);
				const [info] = await load(ctx);
				const action = fakeAction({ forms: answers });
				await actionOf(info, "learn").handler("wm", action);
				return { ctx, action };
			}

			it("without the run list the suggestion comes at once and names the runs it comes from", async () => {
				const { action } = await open([{ source: "history", instance: "history.0" }, undefined]);
				assert.strictEqual(action.forms[0].schema.items.reviewRuns.type, "checkbox");
				assert.strictEqual(action.forms[0].options.data.reviewRuns, undefined, "off by default");
				const suggestion = action.forms[1];
				assert.ok(suggestion.schema.items.startVal, "the second form is the suggestion, not the run list");
				assert.strictEqual(suggestion.schema.items.use_0, undefined);
				const text = suggestion.schema.items.runsText.text;
				assert.match(text, /^Learned from 12 of 13 runs found in the last 30 days\./);
				assert.match(text, /Left out automatically: .+\(.+\)\./);
			});

			it("lists every run with its check; sparse w04 marked, use column defaults to auto", async () => {
				const { action } = await open([{ source: "history", instance: "history.0", reviewRuns: true }]);
				const rows = action.forms[1].options.data.runs;
				assert.strictEqual(rows.length, 14, `${rows.length} rows`);
				assert.ok(rows.every(r => r.use === "auto"));
				assert.ok(rows.some(r => /sparse|gestört/i.test(r.check)));
				assert.ok(
					rows.some(r => r.check === "✓"),
					"a clean run shows a tick",
				);
				assert.ok(action.forms[1].schema.items.runs || action.forms[1].schema.items.use_0, "table or fallback");
			});

			it("suggestion from admitted runs only: values next to the old ones, phases as rows, finished from standby by default", async () => {
				const { action } = await open([
					{ source: "history", instance: "history.0", reviewRuns: true },
					{ operation: "next" },
				]);
				const { schema, options } = action.forms[2];
				const d = options.data;
				const items = schema.items;
				assert.strictEqual(d.finishAt, "standby", "standby by default (3.1.2)");
				assert.strictEqual(d.old_finishAt, "Standby (as before)");
				const choices = items.finishAt.options;
				assert.deepStrictEqual(
					choices.map(o => o.value === "standby"),
					[true, false],
					"standby and the one phase after the final band",
				);
				// the tests run with I18n "en" (test/helpers/i18n.js)
				assert.match(
					items.final_text.text.en,
					/^Finished \d+ min earlier \(median\), checked on \d+ of \d+ runs, 0 too early, \d+ fallback/,
				);
				assert.strictEqual(d.old_startVal, "30 W", "the values of the template are the old ones");
				const names = Object.keys(items).filter(k => /^phase_.+_name$/.test(k));
				// few real phases: the short dips of the washing rhythm on the poll grid are no phases of their own
				assert.ok(names.length >= 4 && names.length <= 6, names.join());
				const ids = names.map(k => k.slice(6, -5));
				for (const id of ids) {
					for (const f of ["no", "power", "duration", "old"]) {
						assert.ok(items[`phase_${id}_${f}`], `${id} ${f}`);
					}
					assert.strictEqual(d[`phase_${id}_old`], "new", "no phases before");
					assert.match(d[`phase_${id}_duration`], /min$/);
				}
				assert.deepStrictEqual(
					ids.map(id => d[`phase_${id}_name`]),
					ids.map((_, i) => `Phase ${i + 1}`),
				);
				assert.match(
					d[`phase_${ids.at(-1)}_power`],
					/^short bursts ≈ \d+ W$/,
					"the after-run is the last phase",
				);
				assert.match(d[`phase_${ids[0]}_power`], /^≈ \d+ W$/);
				const at = ids.indexOf(choices[1].value);
				assert.ok(at >= 0 && at < ids.length - 1, "a phase of the bands, not the after-run");
				assert.strictEqual(choices[1].label, `Phase ${at + 2}`, "finished from the phase that follows it");
				for (const gone of ["final_apply", "showPhases", "trailerBurstSec"]) {
					assert.strictEqual(items[gone], undefined, gone);
				}
				assert.ok(
					!Object.keys(items).some(k => /_(show|notifyStart|notifyEnd|final)$/.test(k)),
					"no show, messages or finished afterwards per phase",
				);
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
					buildRunTable(rows, "fallback").use_0.type === "select" &&
						buildRunTable(rows, "fallback").use_0.options.length === 3 &&
						/^1\. 01\.11\. · 140 min · 600 Wh · ✓$/.test(buildRunTable(rows, "fallback").use_0.label),
				);
				assert.strictEqual(RUN_TABLE_MODE, "fallback");
			});

			it('"recalculate" shows the list again with the decision applied', async () => {
				const { action } = await open([
					{ source: "history", instance: "history.0", reviewRuns: true },
					{ runs: [{ use: "exclude" }], recalc: true },
					{},
				]);
				const first = action.forms[1].options.data.runs;
				const again = action.forms[2].options.data.runs;
				assert.strictEqual(again[0].use, "exclude");
				assert.strictEqual(action.forms[2].options.data.use_0, "exclude");
				assert.strictEqual(first[0].key, again[0].key);
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
				const selects = usesOfAnswer({ use_0: "include", use_1: "exclude", use_2: "auto" }, rows);
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
				let chosen = "";
				let first = "";
				const { ctx, action } = await open([
					{ source: "history", instance: "history.0", reviewRuns: true },
					{ operation: "next", runs: [{ use: "exclude" }] },
					schema => {
						chosen = schema.items.finishAt.options[1].value;
						first = Object.keys(schema.items).find(k => /^phase_.+_name$/.test(k));
						return { operation: "apply", finishAt: chosen, [first]: " Heating " };
					},
				]);
				assert.strictEqual(action.confirmations.length, 1);
				const native = ctx.adapter.objects.get(`${NS}.wm`).native;
				assert.ok(native.detection.finalMinVal > 0, "final phase taken over");
				assert.strictEqual(native.phases?.enabled, true);
				assert.deepStrictEqual(
					native.phases.phases.filter(p => p.final).map(p => p.id),
					[chosen],
					"the phase in the final band carries finished afterwards",
				);
				assert.ok(!native.phases.phases.find(p => p.id === chosen).trailer);
				assert.strictEqual(native.phases.phases.find(p => `phase_${p.id}_name` === first).name, "Heating");
				assert.ok(native.phases.phases.every(p => p.notify === undefined && p.show === true));
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

			it("finished from standby: no final phase, the phases are still saved and shown; decisions are stored", async () => {
				const { ctx, action } = await open([
					{ source: "history", instance: "history.0", reviewRuns: true },
					{ runs: [{ use: "exclude" }] },
					{ finishAt: "standby" },
				]);
				const native = ctx.adapter.objects.get(`${NS}.wm`).native;
				assert.ok(!native.detection.finalMinVal, "no final phase");
				// the answers above hold only fields of the form: the after-run filter comes from the suggestion
				const shown = action.forms.at(-1).options.data;
				const burst = native.detection.trailerBurstSec ?? 0;
				assert.strictEqual(shown.afterRun_new_trailerBurstSec ?? "0 s", `${burst} s`, "as shown in Details");
				assert.strictEqual(shown.trailerBurstSec, undefined, "not in the form data");
				assert.strictEqual(native.phases?.enabled, true, "a learned model is always saved and switched on");
				assert.ok(native.phases.phases.every(p => !p.final));
				assert.ok(native.phases.phases.at(-1).trailer, "the after-run is the last phase");
				const st = await ctx.registry.readLearningData("wm");
				assert.ok(Object.values(st.verdicts).some(v => v.user === "exclude"));
				assert.strictEqual(st.runs.length, 0, "no comparison runs without the final phase");
			});

			it("learning again shows the values, the phases and finished from as before; keep leaves the final phase", async () => {
				const { ctx } = await open([
					{ source: "history", instance: "history.0" },
					schema => ({ finishAt: schema.items.finishAt.options[1].value }),
				]);
				const first = structuredClone(ctx.adapter.objects.get(`${NS}.wm`).native);
				const inUse = first.phases.phases.find(p => p.final);
				assert.ok(inUse && first.detection.finalMinVal > 0);
				const [info] = await load(ctx);
				const action = fakeAction({
					forms: [{ source: "history", instance: "history.0" }, { finishAt: "keep" }],
				});
				await actionOf(info, "learn").handler("wm", action);
				const { schema, options } = action.forms[1];
				const d = options.data;
				assert.strictEqual(d.finishAt, inUse.id, "the phase in use is preselected");
				assert.match(d.old_finishAt, /^Phase \d+/, "before: the phase chosen the first time");
				assert.deepStrictEqual(
					schema.items.finishAt.options.map(o => o.value),
					["standby", inUse.id, "keep"],
				);
				assert.strictEqual(
					d.old_endVal,
					`${first.detection.endVal} W`,
					"before: the values of the first learning",
				);
				assert.match(d[`phase_${inUse.id}_old`], /^Phase \d+ · ≈ \d+ W · \d+(–\d+)? min$/);
				const again = ctx.adapter.objects.get(`${NS}.wm`).native;
				for (const key of FINAL_KEYS) {
					assert.strictEqual(again.detection[key] ?? 0, first.detection[key] ?? 0, key);
				}
				assert.strictEqual(again.phases.phases.find(p => p.id === inUse.id)?.final, true);
			});

			describe("finished from the after-run (Spec B.6, B.7)", () => {
				// a washer with an after-run whose 30 days hold a new programme started during the after-run of the one
				// before (r15): learned with the values the device had (3.1.2 count mode, end after the after-run)
				const NPTS = loadSeries("washerNewStart");
				const own = {
					startVal: 10.25,
					endVal: 1,
					standby: 0.1,
					startCount: 2,
					endCount: 158,
					mode: "count",
					startDurationSec: 20,
					endDurationSec: 1580,
				};

				it("offers the after-run and ends every admitted run at the programme end, never too early", async () => {
					const ctx = setup({ files: memoryFiles() });
					await addDevice(ctx, "wm", deviceCfg({ name: "WM", detection: own }));
					withHistory(ctx, NPTS);
					const [info] = await load(ctx);
					let afterRun = "";
					const action = fakeAction({
						forms: [
							{ source: "history", instance: "history.0", reviewRuns: true },
							{ operation: "next" },
							(schema, options) => {
								const names = Object.keys(schema.items).filter(k => /^phase_.+_name$/.test(k));
								const last = names.at(-1);
								assert.match(options.data[last.replace(/_name$/, "_power")], /^short bursts/);
								afterRun = `Phase ${names.length}`;
								const choice = schema.items.finishAt.options.find(o => o.label === afterRun);
								assert.ok(
									choice,
									`${afterRun} (after-run) offered: ${JSON.stringify(schema.items.finishAt.options)} ${options.data.final_text?.en ?? schema.items.final_text?.text?.en}`,
								);
								return { finishAt: choice.value };
							},
						],
					});
					await actionOf(info, "learn").handler("wm", action);
					const rows = action.forms[1].options.data.runs;
					assert.ok(
						rows.some(r => /Two runs as one/.test(r.check)),
						`the new start in the after-run is found: ${rows.map(r => r.check).join(" | ")}`,
					);
					const settings = ctx.adapter.objects.get(`${NS}.wm`).native.detection;
					assert.ok(settings.finalMinVal > 0, "the final phase ends the run when the after-run begins");
					// the whole recording through the detector chain with the saved values
					const { s, L } = layoutOf(NPTS);
					const { ev } = detectorRun(ticksOf(NPTS), settings);
					const finishes = ev.filter(e => e.e === "finished").map(e => e.i);
					const starts = ev.filter(e => e.e === "started").map(e => e.i);
					const MIN = 60_000 / s.stepMs;
					// r04 (sparse) and r14 (a test) are held back, r15 holds two programmes
					const normal = runIndex("washerNewStart").filter(r => !["r04", "r14", "r15"].includes(r.id));
					assert.strictEqual(normal.length, 12);
					for (const { id } of normal) {
						const { info: r } = layoutRun("washerNewStart", id);
						const f = finishes.find(i => i > r.from);
						// not too early (Spec B.4 endOk): at the end of the run, or after the programme end at most 5 min before it
						const inTime = f !== undefined && (f >= r.runEnd || (f > r.progEnd && r.runEnd - f <= 5 * MIN));
						assert.ok(inTime, `${id} not too early: ${f} vs ${r.progEnd}/${r.runEnd}`);
						assert.ok(
							f - r.progEnd <= 3 * MIN,
							`${id} ends ${(f - r.progEnd) / MIN} min after the programme`,
						);
						assert.strictEqual(
							starts.filter(i => i >= r.from - MIN && i <= f).length,
							1,
							`${id} one start`,
						);
					}
					// grown together: the end of the whole run counts (an end at the programme end inside it is no early end, decision 9)
					const { info: m } = layoutRun("washerNewStart", "r15");
					const last = finishes.filter(i => i > m.from && i <= L.runs.at(-1).to + 180 * MIN).at(-1);
					assert.ok(last >= m.progEnd, `r15 ends with the whole run: ${last} vs ${m.progEnd}`);
				});
			});

			it("cancelling after the runs changes nothing", async () => {
				const { ctx, action } = await open([
					{ source: "history", instance: "history.0", reviewRuns: true },
					{ use_0: "auto" },
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
				assert.strictEqual(action.forms[0].options.data.finishAt, undefined);
				assert.strictEqual(action.forms[0].schema.items.finishAt, undefined);
				assert.ok(action.forms[0].schema.items.old_startVal, "the values next to the old ones as well");
				assert.ok(!Object.keys(action.forms[0].schema.items).some(k => k.startsWith("phase_")), "no phases");
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
		// the checks of the optimisation yield to the fake timers: advance them while the action runs
		const running = actionOf(info, "optimization").handler("trockner", action);
		let done = false;
		void running.then(
			() => (done = true),
			() => (done = true),
		);
		for (let i = 0; i < 100_000 && !done; i++) {
			await ctx.host.advance(0);
			await new Promise(resolve => setImmediate(resolve));
		}
		await running;
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
			["", "use", "undo", "reset", "clear", "adopt"],
		);
		assert.ok(schema.items.runKey.options.length >= 1);
		assert.deepStrictEqual(Object.keys(options.data.runs[0]).sort(), [
			"boundary",
			"date",
			"duration",
			"family",
			"gate",
			"key",
			"label",
			"source",
			"use",
		]);
		assert.deepStrictEqual(action.messages, []);
	});

	it("undoes, resets, sets the use of a run and clears", async () => {
		const ctx = await optSetup();
		assert.ok(ctx.registry.get("trockner").currentOverride !== null, "the repair is active");
		// the values before the repair would not detect the run that caused it: the dialog offers to exclude it
		let action = await openDialog(ctx, { operation: "undo" }, false);
		assert.strictEqual(action.confirmations.length, 1);
		assert.ok(action.messages[0].en.includes("Cannot undo"));
		assert.ok(ctx.registry.get("trockner").currentOverride !== null, "declined: nothing undone");
		action = await openDialog(ctx, { operation: "undo" });
		assert.ok(action.messages[0].en.includes("undone"));
		assert.strictEqual(ctx.registry.get("trockner").currentOverride, null);
		const store = ctx.registry.learningData("trockner");
		const first = [...store.runs, ...store.spikes][0];
		assert.strictEqual(store.verdicts[first.key].user, "exclude", "the run that caused the repair is excluded");
		action = await openDialog(ctx, { operation: "reset" });
		assert.ok(action.messages[0].en.includes("base values"));
		assert.strictEqual(ctx.registry.learningData("trockner").changes.at(-1).kind, "reset");

		action = await openDialog(ctx, { operation: "use" });
		assert.ok(action.messages[0].en.includes("Select"));
		const view = await openDialog(ctx, { operation: "" });
		const row = view.forms[0].options.data.runs.find(r => r.key === first.key);
		assert.ok(row, "an excluded run is still listed");
		assert.strictEqual(row.use, I18n.translate("dm_learnUse_exclude"));
		action = await openDialog(ctx, { operation: "use", runKey: first.key, use: "auto" });
		assert.ok(action.messages[0].en.includes("saved"));
		assert.strictEqual(decisionOf(ctx.registry.learningData("trockner"), first.key), undefined);
		assert.ok(ctx.registry.get("trockner").currentOverride !== null, "the run counts again: repaired at once");

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

	it("drop old limits removes legacyEnvelope after a warning", async () => {
		const ctx = await optSetup();
		ctx.registry.learningData("trockner").legacyEnvelope = {
			maxPauseSec: 900,
			maxBurstSec: 0,
			maxTrailSec: 0,
			maxTrailerSec: 0,
			minRunW: 0,
			minCoreSec: 0,
			n: 3,
		};
		const shown = await openDialog(ctx, { operation: "" });
		assert.ok(shown.forms[0].schema.items.operation.options.some(o => o.value === "dropLegacy"));
		const action = await openDialog(ctx, { operation: "dropLegacy" });
		assert.ok(action.confirmations.length === 1);
		assert.strictEqual(ctx.registry.learningData("trockner").legacyEnvelope, undefined);
		const again = await openDialog(ctx, { operation: "dropLegacy" });
		assert.ok(!again.forms[0].schema.items.operation.options.some(o => o.value === "dropLegacy"));
	});

	it("'was a new run' resumes the final phase without auto-optimisation", async () => {
		const ctx = await optSetup({ autoOptimize: undefined, detection: { ...WASHER, ...WM_FINAL } }, false);
		await ctx.registry.suspendFinal("trockner", "finalSplit", "trockner@5");
		const shown = await openDialog(ctx, { operation: "" });
		const ops = shown.forms[0].schema.items.operation.options.map(o => o.value);
		assert.ok(ops.includes("finalOn") && ops.includes("newRun"));
		assert.strictEqual(ctx.registry.get("trockner").active.finalMinVal, 0, "suspended");
		const action = await openDialog(ctx, { operation: "newRun", runKey: "trockner@5" });
		assert.ok(action.messages[0].en.includes("used again"));
		assert.strictEqual(ctx.registry.get("trockner").active.finalMinVal, WM_FINAL.finalMinVal);
		assert.deepStrictEqual(ctx.registry.learningData("trockner").final.splits, []);
		const none = await openDialog(ctx, { operation: "newRun" });
		assert.ok(none.messages[0].en.includes("Select"));
	});

	it("'use the final phase again' lifts the suspension and tells when there is none", async () => {
		const ctx = await optSetup({ autoOptimize: undefined, detection: { ...WASHER, ...WM_FINAL } }, false);
		await ctx.registry.suspendFinal("trockner", "finalSplit", "trockner@5");
		let action = await openDialog(ctx, { operation: "finalOn" });
		assert.ok(action.messages[0].en.includes("used again"));
		assert.strictEqual(ctx.registry.get("trockner").active.finalMinVal, WM_FINAL.finalMinVal);
		action = await openDialog(ctx, { operation: "finalOn" });
		assert.ok(action.messages[0].en.includes("not suspended"));
	});

	it("the run table shows the value without a boundary run and warns before excluding it", async () => {
		const ctx = await optSetup();
		const key = ctx.registry.learningData("trockner").runs[0].key;
		const shown = await openDialog(ctx, { operation: "" });
		const rows = shown.forms[0].options.data.runs;
		assert.ok(
			rows.some(r => /ohne ihn|without it/.test(r.boundary)),
			"the limits the run sets alone are shown",
		);
		const action = await openDialog(ctx, { operation: "use", runKey: key, use: "exclude" });
		assert.ok(action.confirmations.some(c => JSON.stringify(c).includes("zu früh als fertig")));
		assert.ok(action.confirmations.some(c => JSON.stringify(c).includes("too early")));
		const included = await openDialog(ctx, { operation: "use", runKey: key, use: "include" });
		assert.strictEqual(decisionOf(ctx.registry.learningData("trockner"), key).user, "include");
		assert.strictEqual(included.confirmations.length, 0, "no warning for using a run");
	});

	it("declining the warning leaves the run as it was", async () => {
		const ctx = await optSetup();
		const key = ctx.registry.learningData("trockner").runs[0].key;
		const action = await openDialog(ctx, { operation: "use", runKey: key, use: "exclude" }, false);
		assert.deepStrictEqual(action.messages, []);
		assert.strictEqual(decisionOf(ctx.registry.learningData("trockner"), key), undefined);
	});

	it("clear keeps decisions unless 'also discard decisions' is ticked", async () => {
		const ctx = await optSetup();
		const st = ctx.registry.learningData("trockner");
		const key = st.runs[0].key;
		await ctx.registry.setRunUse("trockner", key, "exclude");
		await openDialog(ctx, { operation: "clear", clearDecisions: false });
		assert.strictEqual((await ctx.registry.readLearningData("trockner")).verdicts[key].user, "exclude");
		await openDialog(ctx, { operation: "clear", clearDecisions: true });
		assert.deepStrictEqual((await ctx.registry.readLearningData("trockner")).verdicts, {});
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

describe("learn dialog texts", () => {
	const candidate = values => ({
		values: { finalActVal: 40, finalActShare: 0.3, finalLockSec: 2700, ...values },
		ok: true,
		reasons: [],
		covered: 11,
		gainSec: 1700,
		gainMedianSec: 1680,
		endRuns: 12,
		earlyEnds: 0,
		fallbacks: 0,
		perGroup: {},
	});
	it("names a switched-off exit f (activity) and the longest wait (Spec risk 3)", () => {
		const off = finalText(candidate({ finalActVal: 0, finalActShare: 0 }));
		assert.match(off.en, /^Finished 28 min earlier/);
		assert.match(off.en, /Exit f \(activity\) is off.*45 min/);
		assert.match(off.de, /Ausgang f \(Aktivität\) ist aus.*45 min/);
		const fourHours = finalText(candidate({ finalActVal: 0, finalActShare: 0, finalLockSec: 0 }));
		assert.match(fourHours.en, /240 min/);
		assert.doesNotMatch(finalText(candidate({})).en, /Exit f/);
	});
	it("lists the phases that fall away and the number of actions that no longer fire (Spec B.5 step 8)", () => {
		const both = droppedText([
			{ id: "p3", name: "Final spin", actions: 1 },
			{ id: "p4", name: "Rinse", actions: 0 },
		]);
		assert.match(both.en, /Final spin, Rinse/);
		assert.match(both.en, /1 action\(s\)/);
		assert.match(both.de, /Final spin, Rinse.*1 Aktion/);
		const none = droppedText([{ id: "p4", name: "Rinse", actions: 0 }]);
		assert.match(none.en, /Rinse/);
		assert.doesNotMatch(none.en, /action/);
		const model = { enabled: true, scope: "run", phases: [] };
		assert.strictEqual(
			phaseItems(model, [], [{ id: "p3", name: "x", actions: 2 }]).phasesDropped.boxType,
			"warning",
		);
		assert.strictEqual(phaseItems(model, [], [{ id: "p3", name: "x", actions: 0 }]).phasesDropped.boxType, "info");
	});

	describe("finished from and the phases of the dialog (Spec B.7)", () => {
		const phase = (id, band, extra = {}) => ({
			id,
			name: `Phase ${id.slice(1)}`,
			band,
			minSec: 0,
			maxSec: 0,
			decided: "live",
			show: true,
			stats: { runs: 5, agreement: 1, lastSeen: 0, watts: 500, shortSec: 120, longSec: 840 },
			...extra,
		});
		// heating (b3), spin (b2), after-run in the spin band: only a band phase can end the final band
		const model = {
			v: 1,
			enabled: false,
			scope: "run",
			bands: [
				{ id: "b1", name: "≈ 6 W", min: 5, max: 100, smoothing: "level", dipSec: 45, windowSec: 60 },
				{ id: "b2", name: "≈ 500 W", min: 100, max: 1000, smoothing: "block", dipSec: 30, windowSec: 0 },
				{ id: "b3", name: "≈ 2000 W", min: 1000, max: Infinity, smoothing: "block", dipSec: 30, windowSec: 0 },
			],
			phases: [
				phase("p1", "b3"),
				phase("p2", "b2", { notify: { end: true } }),
				phase("p3", "b2", {
					trailer: true,
					stats: { runs: 5, agreement: 0, lastSeen: 0, watts: 110, shortSec: 1500, longSec: 1800 },
				}),
			],
			learnedAt: 0,
			quality: { agreement: 1, runsUsed: 5 },
		};
		const ok = { ok: true, values: { finalMinVal: 150, finalHotVal: 0 } };
		const off = { active: false };

		it("offers standby and the phase after the last phase in the final band, never the after-run itself", () => {
			assert.strictEqual(finalPhaseOf(model, ok).id, "p2");
			assert.strictEqual(finalPhaseOf(model, { ...ok, ok: false }), null);
			assert.deepStrictEqual(finishOptions(model, ok, off), [
				{ label: "Standby (as before)", value: "standby" },
				{ label: "Phase 3", value: "p2" },
			]);
			assert.deepStrictEqual(
				finishOptions(model, null, { active: true }).map(o => o.value),
				["standby", "keep"],
			);
			const last = { ...model, phases: model.phases.slice(0, 2) };
			assert.strictEqual(finishOptions(last, ok, off)[1].label, "After Phase 2", "no phase after it");
			const named = { ...model, phases: model.phases.map(p => (p.id === "p3" ? { ...p, name: "Rest" } : p)) };
			assert.strictEqual(finishOptions(named, ok, off)[1].label, "Phase 3 – Rest");
		});
		it("presets standby, the phase in use or keep, and reads the answer", () => {
			assert.strictEqual(finishPreset(model, ok, off), "standby");
			const inUse = { ...model, phases: model.phases.map(p => (p.id === "p2" ? { ...p, final: true } : p)) };
			assert.strictEqual(finishPreset(inUse, ok, { active: true }), "p2");
			assert.strictEqual(finishPreset(model, ok, { active: true }), "keep");
			assert.deepStrictEqual(finishChoiceOf("p2", model, ok, off), {
				useFinal: true,
				keep: false,
				finalId: "p2",
			});
			assert.deepStrictEqual(finishChoiceOf("p3", model, ok, off).useFinal, false, "the after-run is no choice");
			assert.deepStrictEqual(finishChoiceOf("keep", model, ok, off).keep, false, "keep only with a final phase");
			assert.deepStrictEqual(finishChoiceOf("keep", model, ok, { active: true }).keep, true);
			assert.deepStrictEqual(finishChoiceOf(undefined, model, ok, off), {
				useFinal: false,
				keep: false,
				finalId: null,
			});
		});
		it("saves the phases switched on with the names of the form and finished afterwards at the chosen phase", () => {
			const inUse = { ...model, phases: model.phases.map(p => (p.id === "p1" ? { ...p, final: true } : p)) };
			const saved = phasesFromForm(
				inUse,
				{ phase_p1_name: " Heating ", phase_p2_name: "" },
				{
					useFinal: true,
					keep: false,
					finalId: "p2",
				},
			);
			assert.strictEqual(saved.enabled, true);
			assert.deepStrictEqual(
				saved.phases.map(p => [p.id, p.name, p.final]),
				[
					["p1", "Heating", undefined],
					["p2", "Phase 2", true],
					["p3", "Phase 3", undefined],
				],
			);
			assert.deepStrictEqual(saved.phases[1].notify, { end: true }, "messages of the model stay");
			const kept = phasesFromForm(inUse, {}, { useFinal: false, keep: true, finalId: null });
			assert.deepStrictEqual(
				kept.phases.map(p => p.final),
				[true, undefined, undefined],
			);
			const none = phasesFromForm(inUse, {}, { useFinal: false, keep: false, finalId: null });
			assert.ok(
				none.phases.every(p => !p.final),
				"standby: no phase carries it",
			);
		});
		it("shows power, duration and the phase before learning, or new", () => {
			const before = {
				...model,
				phases: [
					phase("p1", "b3", {
						name: "Heating",
						stats: { runs: 3, agreement: 1, lastSeen: 0, watts: 2100, shortSec: 60, longSec: 720 },
					}),
				],
			};
			const d = phaseData(model, before);
			assert.deepStrictEqual(
				[d.phase_p1_power, d.phase_p1_duration, d.phase_p1_old, d.phase_p2_old],
				["≈ 500 W", "2–14 min", "Heating · ≈ 2100 W · 1–12 min", "new"],
			);
			assert.deepStrictEqual([d.phase_p3_power, d.phase_p3_duration], ["short bursts ≈ 110 W", "25–30 min"]);
			assert.ok(!("agreement" in d), "no agreement shown");
		});
	});
});
