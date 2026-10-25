import assert from "node:assert";
import { DEFAULT_REMINDER, normalizeInstanceConfig } from "../build/lib/config.js";
import { DeviceRegistry } from "../build/lib/deviceRegistry.js";
import { ReminderDeviceManagement } from "../build/lib/deviceManagement.js";
import { ensureDeviceObjects } from "../build/lib/deviceObjects.js";
import { Notifier } from "../build/lib/notifier.js";
import { createFakeHost } from "./helpers/fakeHost.js";

const NS = "device-reminder.0";
const POWER = "plug.0.power";
const INSTANCE_OBJ = `system.adapter.${NS}`;

const testType = {
	id: "test",
	name: "Test",
	builtin: false,
	startVal: 30,
	endVal: 5,
	startCount: 1,
	endCount: 2,
	standby: 1,
	mode: "count",
	startDurationSec: 60,
	endDurationSec: 300,
};

function deviceCfg(over = {}) {
	return {
		enabled: true,
		name: "Trockner",
		typeId: "test",
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
	return { ...deviceCfg(), sourceId: "", switchId: "", ...over };
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
				await adapter.registry.upsert(id, object.native);
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
		instanceConfig: inst,
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
		types: [testType],
		recipients: [
			{ id: "tg", name: "Telegram", enabled: true, kind: "telegram", instance: "telegram.0" },
			{ id: "tg2", name: "Telegram 2", enabled: true, kind: "telegram", instance: "telegram.1" },
		],
		pollIntervalSec: 10,
	}).config;
	const notifier = new Notifier(host, () => inst.recipients);
	const registry = new DeviceRegistry(host, notifier, () => inst);
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
		openProgress: async () => {
			throw new Error("not used");
		},
	};
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
			["add"],
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
			assert.strictEqual(info.model, "Test");
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

		it("lists a device with an unknown type with a warning instead of hiding it", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner", deviceCfg({ typeId: "gone" }));
			const [info] = await load(ctx);
			assert.ok(info.status.warning.en.includes("gone"));
			assert.ok(info.actions.some(a => a.id === "delete"));
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
			assert.strictEqual(obj.common.name, "Trockner neu");
			assert.strictEqual(result.update.name, "Trockner neu");
			assert.strictEqual(action.forms[0].options.data.name, "Trockner", "the form starts with the stored values");
			assert.strictEqual(ctx.registry.get("trockner").config.recipients.length, 1);
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

		it("shows the suggestion and stores the confirmed one as new custom type", async () => {
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
			assert.strictEqual(action.confirmations.length, 1, "the restart is confirmed first");
			assert.strictEqual(ctx.adapter.extendedForeign.length, 1);
			const { id, obj } = ctx.adapter.extendedForeign[0];
			assert.strictEqual(id, INSTANCE_OBJ);
			const added = obj.native.types.at(-1);
			assert.strictEqual(added.name, "Mein Trockner");
			assert.strictEqual(added.id, "mein_trockner");
			assert.strictEqual(added.builtin, false);
			assert.strictEqual(added.startVal, 20);
			assert.strictEqual(added.endCount, 4);
			assert.strictEqual(obj.native.types.length, ctx.inst.types.length + 1);
			assert.strictEqual(ctx.host.own("trockner.learning.active"), false);
		});

		it("changes nothing when the restart is not confirmed", async () => {
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
			const action = fakeAction({ forms: [{ ...valid, name: " " }, { ...valid, endCount: 1 }, valid] });
			await actionOf(info, "learn").handler("trockner", action);
			assert.strictEqual(action.messages.length, 3, "two validation errors and the saved hint");
			assert.strictEqual(ctx.adapter.extendedForeign.length, 1);
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
	});

	describe("getDeviceDetails", () => {
		it("shows the last operations, the thresholds of the type and the reminder status", async () => {
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
			assert.ok(values.some(i => i.label === "dm_detailsStartVal" && i.data === 30 && i.unit === "W"));
			assert.ok(values.some(i => i.label === "dm_detailsReminderInterval" && i.data === 15));
			assert.ok(values.some(i => i.label === "dm_detailsReminderMax" && i.data === 4));
		});

		it("tolerates a broken lastOperations state and an unknown type", async () => {
			const ctx = setup();
			await addDevice(ctx, "trockner", deviceCfg({ typeId: "gone" }));
			ctx.adapter.states.set("trockner.lastOperations", "{not json");
			const details = await ctx.dm.getDeviceDetails("trockner");
			assert.deepStrictEqual(details.data.lastOperations, []);
			assert.strictEqual(details.schema.items.typeUnknown.type, "infoBox");
		});

		it("answers an unknown device with an error", async () => {
			const ctx = setup();
			assert.deepStrictEqual(await ctx.dm.getDeviceDetails("nope"), { error: "unknownDevice" });
		});
	});
});
