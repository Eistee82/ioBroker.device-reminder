import assert from "node:assert";
import { DEFAULT_REMINDER, normalizeInstanceConfig } from "../build/lib/config.js";
import { DeviceRegistry } from "../build/lib/deviceRegistry.js";
import { DeviceSync } from "../build/lib/deviceSync.js";
import { Notifier } from "../build/lib/notifier.js";
import { createFakeHost } from "./helpers/fakeHost.js";

const POWER = "plug.0.power";

function makeCfg(over = {}) {
	return {
		enabled: true,
		name: "Washer",
		typeId: "washing-machine",
		powerId: POWER,
		startText: "",
		endText: "",
		abort: false,
		abortFixed: false,
		autoOff: false,
		autoOffMinutes: 0,
		recipients: [],
		reminder: { ...DEFAULT_REMINDER },
		actions: [],
		...over,
	};
}

function setup() {
	const host = createFakeHost({ objects: { [POWER]: "number" } });
	const inst = normalizeInstanceConfig({}).config;
	const registry = new DeviceRegistry(host, new Notifier(host, () => inst.recipients), () => inst);
	const extended = [];
	const writer = {
		extendObject: async id => {
			extended.push(id);
		},
		setObjectNotExists: async () => {},
		delObject: async () => {},
	};
	const sync = new DeviceSync(registry, writer, () => inst, host.log);
	return { host, registry, sync, extended };
}

describe("DeviceSync", () => {
	it("writes the device object at most once for a device with an unknown type (no object change loop)", async () => {
		const { host, sync, extended } = setup();
		const cfg = makeCfg({ typeId: "" });
		for (let i = 0; i < 5; i++) {
			await sync.apply("washer", cfg);
		}
		assert.strictEqual(extended.filter(id => id === "washer").length, 1);
		assert.strictEqual(host.logs.warn.filter(m => m.includes("unknown device type")).length, 1);
		assert.ok(!host.logs.info.some(m => m.includes("added")), "no misleading 'added' message");
	});

	it("applies a changed configuration of a registered device and logs it as added once", async () => {
		const { host, registry, sync } = setup();
		await sync.apply("washer", makeCfg());
		await sync.apply("washer", makeCfg());
		assert.strictEqual(host.logs.info.filter(m => m.includes("added")).length, 1);
		await sync.apply("washer", makeCfg({ startText: "Go" }));
		assert.strictEqual(registry.get("washer").config.startText, "Go");
	});

	it("re-registers after removal and after the type was fixed", async () => {
		const { registry, sync, extended } = setup();
		await sync.apply("washer", makeCfg({ typeId: "" }));
		assert.strictEqual(registry.get("washer"), undefined);
		await sync.apply("washer", makeCfg({ typeId: "dryer" }));
		assert.ok(registry.get("washer"));
		await sync.apply("washer", null);
		assert.strictEqual(registry.get("washer"), undefined);
		await sync.apply("washer", makeCfg({ typeId: "dryer" }));
		assert.ok(registry.get("washer"));
		assert.strictEqual(extended.filter(id => id === "washer").length, 3);
	});
});
