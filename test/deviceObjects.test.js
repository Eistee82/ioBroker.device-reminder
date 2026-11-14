import assert from "node:assert";
import { ChannelDetector } from "@iobroker/type-detector";
import { normalizeDeviceConfig, normalizeInstanceConfig } from "../build/lib/config.js";
import { ensureDeviceObjects } from "../build/lib/deviceObjects.js";
import { DEVICE_STATES } from "../build/lib/stateDefinitions.js";
import { deviceConfig, instanceConfig, WASHER } from "./helpers/devices.js";
import { WM_FINAL } from "./helpers/final.js";
import { WM_PHASES } from "./helpers/phases.js";

const FIN = { ...WASHER, ...WM_FINAL };
const PHASE_IDS = ["phase", "phaseId", "phaseSince", "phases"];

function makeWriter() {
	const objects = {};
	const deleted = [];
	return {
		objects,
		deleted,
		async extendObject(id, obj) {
			objects[id] = { ...(objects[id] ?? {}), ...obj, _id: id };
		},
		async setObjectNotExists(id, obj) {
			objects[id] ??= obj;
		},
		async delObject(id) {
			deleted.push(id);
			delete objects[id];
		},
	};
}

const cfg = normalizeDeviceConfig({ name: "Waschmaschine", detection: WASHER, powerId: "x.0.power" }).config;
const inst = normalizeInstanceConfig({}).config;

describe("deviceObjects", () => {
	it("creates settlingUntil only with an active final phase, also when only the override has one", async () => {
		const ids = [];
		const del = [];
		const w = {
			extendObject: async id => ids.push(id),
			setObjectNotExists: async () => {},
			delObject: async id => del.push(id),
		};
		await ensureDeviceObjects(w, "wm", deviceConfig(), instanceConfig());
		assert.ok(del.includes("wm.settlingUntil"));
		ids.length = 0;
		del.length = 0;
		await ensureDeviceObjects(w, "wm", deviceConfig({ detection: FIN }), instanceConfig());
		assert.ok(ids.includes("wm.settlingUntil"));
		assert.ok(!del.includes("wm.settlingUntil"));
		ids.length = 0;
		await ensureDeviceObjects(w, "wm", deviceConfig(), instanceConfig(), { ...WM_FINAL });
		assert.ok(ids.includes("wm.settlingUntil"), "final phase switched on by the optimisation");
		ids.length = 0;
		del.length = 0;
		await ensureDeviceObjects(w, "wm", deviceConfig({ detection: FIN }), instanceConfig(), { finalMinVal: 0 });
		assert.ok(del.includes("wm.settlingUntil"), "final phase switched off by the optimisation");
	});

	it("creates device, channels and states", async () => {
		const w = makeWriter();
		await ensureDeviceObjects(w, "waschmaschine", cfg, { ...inst, historyHtml: false });
		assert.strictEqual(w.objects.waschmaschine.type, "device");
		assert.strictEqual(w.objects.waschmaschine.native.powerId, "x.0.power");
		assert.strictEqual(w.objects["waschmaschine.config"].type, "channel");
		assert.strictEqual(w.objects["waschmaschine.learning"].type, "channel");
		for (const def of DEVICE_STATES.filter(
			d => d.when !== "historyHtml" && d.when !== "final" && d.when !== "phases",
		)) {
			const obj = w.objects[`waschmaschine.${def.id}`];
			assert.strictEqual(obj?.type, "state", def.id);
			assert.strictEqual(obj.common.role, def.role);
		}
	});

	it("creates phase states only with enabled phases and removes them again", async () => {
		const ids = [];
		const del = [];
		const w = {
			extendObject: async id => ids.push(id),
			setObjectNotExists: async () => {},
			delObject: async id => del.push(id),
		};
		await ensureDeviceObjects(w, "wm", deviceConfig(), instanceConfig());
		assert.ok(PHASE_IDS.every(id => del.includes(`wm.${id}`)));
		await ensureDeviceObjects(w, "wm", deviceConfig({ phases: WM_PHASES }), instanceConfig());
		assert.ok(PHASE_IDS.every(id => ids.includes(`wm.${id}`)));
		const def = id => DEVICE_STATES.find(d => d.id === id);
		assert.deepStrictEqual(
			PHASE_IDS.map(id => [def(id).type, def(id).role]),
			[
				["string", "text"],
				["string", "text"],
				["number", "date"],
				["string", "json"],
			],
		);
	});

	it("removes lastOperationsHtml when historyHtml is off and creates it when on", async () => {
		const off = makeWriter();
		await ensureDeviceObjects(off, "d", cfg, { ...inst, historyHtml: false });
		assert.deepStrictEqual(off.deleted, [
			"d.settlingUntil",
			...PHASE_IDS.map(id => `d.${id}`),
			"d.lastOperationsHtml",
		]);
		assert.strictEqual(off.objects["d.lastOperationsHtml"], undefined);

		const on = makeWriter();
		await ensureDeviceObjects(on, "d", cfg, { ...inst, historyHtml: true });
		assert.deepStrictEqual(on.deleted, ["d.settlingUntil", ...PHASE_IDS.map(id => `d.${id}`)]);
		assert.strictEqual(on.objects["d.lastOperationsHtml"].common.role, "html");
	});

	it("is recognisable by the type detector (spec 9a.1)", async () => {
		const w = makeWriter();
		await ensureDeviceObjects(w, "waschmaschine", cfg, { ...inst, historyHtml: true });
		const objects = {};
		for (const [id, obj] of Object.entries(w.objects)) {
			objects[`device-reminder.0.${id}`] = { ...obj, _id: `device-reminder.0.${id}` };
		}
		const patterns = new ChannelDetector().detect({ objects, id: "device-reminder.0.waschmaschine" });
		assert.ok(patterns && patterns.length > 0, "no pattern detected");
		// the main pattern is a power meter with the running indicator, never a socket: a "socket" would
		// take do-not-disturb as its on/off switch in the devices adapter, material or Matter
		assert.strictEqual(patterns[0].type, "electricity");
		const main = Object.fromEntries(patterns[0].states.filter(s => s.id).map(s => [s.name, s.id]));
		assert.strictEqual(main.ELECTRIC_POWER, "device-reminder.0.waschmaschine.consumption");
		assert.strictEqual(main.WORKING, "device-reminder.0.waschmaschine.running");
		assert.ok(!patterns.some(p => p.type === "socket"), "detected as socket");
	});
});
