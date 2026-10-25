import assert from "node:assert";
import { ChannelDetector } from "@iobroker/type-detector";
import { normalizeDeviceConfig, normalizeInstanceConfig } from "../build/lib/config.js";
import { ensureDeviceObjects } from "../build/lib/deviceObjects.js";
import { DEVICE_STATES } from "../build/lib/stateDefinitions.js";

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

const cfg = normalizeDeviceConfig({ name: "Waschmaschine", typeId: "washer", powerId: "x.0.power" }).config;
const inst = normalizeInstanceConfig({}).config;

describe("deviceObjects", () => {
	it("creates device, channels and states", async () => {
		const w = makeWriter();
		await ensureDeviceObjects(w, "waschmaschine", cfg, { ...inst, historyHtml: false });
		assert.strictEqual(w.objects.waschmaschine.type, "device");
		assert.strictEqual(w.objects.waschmaschine.native.powerId, "x.0.power");
		assert.strictEqual(w.objects["waschmaschine.config"].type, "channel");
		assert.strictEqual(w.objects["waschmaschine.learning"].type, "channel");
		for (const def of DEVICE_STATES.filter(d => d.when !== "historyHtml")) {
			const obj = w.objects[`waschmaschine.${def.id}`];
			assert.strictEqual(obj?.type, "state", def.id);
			assert.strictEqual(obj.common.role, def.role);
		}
	});

	it("removes lastOperationsHtml when historyHtml is off and creates it when on", async () => {
		const off = makeWriter();
		await ensureDeviceObjects(off, "d", cfg, { ...inst, historyHtml: false });
		assert.deepStrictEqual(off.deleted, ["d.lastOperationsHtml"]);
		assert.strictEqual(off.objects["d.lastOperationsHtml"], undefined);

		const on = makeWriter();
		await ensureDeviceObjects(on, "d", cfg, { ...inst, historyHtml: true });
		assert.deepStrictEqual(on.deleted, []);
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
		assert.ok(
			patterns.some(p => ["info", "electricity"].includes(p.type)),
			`unexpected types: ${patterns.map(p => p.type).join(",")}`,
		);
	});
});
