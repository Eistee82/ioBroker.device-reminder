import assert from "node:assert";
import { applyV4Migration, migrateV4Device, planV4Migration } from "../build/lib/migration.js";
import { emptyStore, reconcileStore, typeHash } from "../build/lib/runStore.js";

const raw = {
	enabled: true,
	name: "WM",
	powerId: "p",
	switchId: "s",
	startText: "a",
	endText: "b",
	abort: true,
	abortFixed: true,
	autoOff: true,
	autoOffMinutes: 3,
	recipients: ["x"],
	reminder: { enabled: true, intervalMin: 5, maxCount: 2, text: "r", ackStateId: "" },
	actions: [{ event: "end", stateId: "q", value: "1" }],
	autoOptimize: true,
	optimizeNotify: true,
	sourceId: "dev",
	typeId: "washing-machine",
};
const custom = (id, name, startVal) => ({
	id,
	name,
	startVal,
	endVal: 5,
	standby: 1,
	startCount: 1,
	endCount: 20,
	mode: "count",
	startDurationSec: 60,
	endDurationSec: 300,
});

describe("V4 test installation → values in the device (Spec C.6)", () => {
	it("is detected by structure, also with configVersion 5", () => {
		assert.ok(migrateV4Device(raw, { configVersion: 5 }).native);
		assert.strictEqual(migrateV4Device({ ...raw, typeId: undefined }, {}).native, null);
	});
	it("keeps every device field except typeId; detection equals the type", () => {
		const { native } = migrateV4Device(raw, {});
		const { typeId: _typeId, ...rest } = raw;
		const { detection, template, ...kept } = native;
		assert.deepStrictEqual(kept, rest);
		assert.strictEqual(template, "washing-machine");
		assert.strictEqual(typeHash(detection), "39417b8a");
		assert.ok(!("typeId" in native));
	});
	it("resolves like today: deleted built-in row, empty and missing table, row without id, custom1..10 from defaults", () => {
		const cases = [
			[{ types: [custom("custom1", "Custom 1", 40)] }, "dryer", 120],
			[{ types: [] }, "custom4", 30],
			[{}, "dishwasher", 15],
			[{ types: [{ ...custom(undefined, "Kaffee", 55), id: undefined }] }, "kaffee", 55],
			[{ types: [custom("custom2", "Custom 2", 44)] }, "custom2", 44],
		];
		for (const [native, typeId, startVal] of cases) {
			const r = migrateV4Device({ ...raw, typeId }, native).native;
			assert.deepStrictEqual(
				[r.detection.startVal, r.needsReview],
				[startVal, undefined],
				`${typeId} ${JSON.stringify(native)}`,
			);
		}
	});
	it("generated ids are deterministic when persistGeneratedIds failed", () => {
		const native = {
			types: [
				{ ...custom(undefined, "Kaffee", 55), id: undefined },
				{ ...custom(undefined, "Kaffee", 66), id: undefined },
			],
		};
		const a = migrateV4Device({ ...raw, typeId: "kaffee_2" }, native).native;
		assert.strictEqual(a.detection.startVal, 66);
	});
	it("no hit → review hint, values Custom, disabled (it was ignored before)", () => {
		const r = migrateV4Device({ ...raw, typeId: "gone" }, {}).native;
		assert.deepStrictEqual([r.needsReview, r.detection.startVal, r.enabled], [true, 30, false]);
		assert.match(r.reviewHint, /gone/);
	});
	it("is idempotent", () => {
		const once = migrateV4Device(raw, {}).native;
		assert.strictEqual(migrateV4Device(once, {}).native, null);
	});
	it("plans device objects only and never the instance object", () => {
		const objects = {
			"device-reminder.0.wm": { type: "device", common: {}, native: raw },
			"device-reminder.0.done": { type: "device", common: {}, native: migrateV4Device(raw, {}).native },
			"system.adapter.device-reminder.0": { type: "instance", common: {}, native: { types: [] } },
		};
		assert.deepStrictEqual(
			planV4Migration(objects, {}).map(p => p.id),
			["device-reminder.0.wm"],
		);
	});
	it("an override of the learning data survives (same hash)", () => {
		const st = emptyStore("wm", "washing-machine", "39417b8a", 10000, 1);
		st.override = { endCount: 30 };
		reconcileStore(st, typeHash(migrateV4Device(raw, {}).native.detection), 10000, 1, 0);
		assert.deepStrictEqual(st.override, { endCount: 30 });
	});
	it("an outdated override is discarded (other hash)", () => {
		const st = emptyStore("wm", "washing-machine", "deadbeef", 10000, 1);
		st.override = { endCount: 30 };
		reconcileStore(st, typeHash(migrateV4Device(raw, {}).native.detection), 10000, 1, 0);
		assert.strictEqual(st.override, null);
		assert.strictEqual(st.changes.at(-1).kind, "baseChanged");
	});
	it("empty typeId (device type not found by an earlier test build) → review hint, disabled", () => {
		const r = migrateV4Device({ ...raw, typeId: "" }, {});
		assert.deepStrictEqual([r.native.needsReview, r.native.enabled, "typeId" in r.native], [true, false, false]);
		assert.deepStrictEqual(r.warnings, [
			'Device "WM": device type "" not found; values taken from template Custom; device disabled',
		]);
	});
	it("a typeId with spaces at the edge or as a number is resolved like before (trimmed)", () => {
		const native = { types: [custom("kaffee", "Kaffee", 55), custom("7", "Seven", 77)] };
		const r = migrateV4Device({ ...raw, typeId: "kaffee " }, native).native;
		assert.deepStrictEqual(
			[r.detection.startVal, r.enabled, r.needsReview, "typeId" in r],
			[55, true, undefined, false],
		);
		const n = migrateV4Device({ ...raw, typeId: 7 }, native).native;
		assert.deepStrictEqual([n.detection.startVal, n.needsReview], [77, undefined]);
	});
	it("a built-in type with changed values gives no template (own values)", () => {
		const native = {
			types: [{ ...custom("dryer", "Dryer", 120), endVal: 15, standby: 1, startCount: 2, endCount: 50 }],
		};
		const r = migrateV4Device({ ...raw, typeId: "dryer" }, native).native;
		assert.deepStrictEqual([r.detection.endCount, "template" in r], [50, false]);
		const same = migrateV4Device(
			{ ...raw, typeId: "dryer" },
			{ types: [{ ...custom("dryer", "Dryer", 120), endVal: 15, standby: 1, startCount: 2, endCount: 20 }] },
		).native;
		assert.strictEqual(same.template, "dryer");
	});
	it("a custom type gives no template; a stale template is dropped", () => {
		const r = migrateV4Device({ ...raw, typeId: "custom3", template: "dryer" }, {}).native;
		assert.deepStrictEqual([r.detection.startVal, "template" in r], [30, false]);
	});

	describe("applyV4Migration", () => {
		const NS = "device-reminder.0";
		function fakeIo(objects, failOnce = new Set()) {
			const written = [];
			const io = {
				deviceObjects: async () => structuredClone(objects),
				getObject: async id => structuredClone(objects[id]),
				setObject: async (id, obj) => {
					if (failOnce.delete(id)) {
						throw new Error("disk full");
					}
					assert.ok(!id.startsWith("system."), `never writes ${id}`);
					written.push(id);
					objects[id] = structuredClone(obj);
				},
			};
			return { io, written };
		}

		it("replaces the native (typeId gone), leaves common and the instance alone, needs no restart", async () => {
			const objects = {
				[`${NS}.wm`]: { type: "device", common: { name: "WM" }, native: raw },
				[`${NS}.dw`]: {
					type: "device",
					common: { name: "DW" },
					native: { ...raw, name: "DW", typeId: "gone" },
				},
			};
			const instanceNative = { types: [custom("custom1", "Custom 1", 40)] };
			const before = structuredClone(instanceNative);
			const { io, written } = fakeIo(objects);
			const res = await applyV4Migration(io, instanceNative);
			assert.deepStrictEqual(res.migrated, [`${NS}.wm`, `${NS}.dw`]);
			assert.deepStrictEqual(written, res.migrated);
			assert.ok(!("typeId" in objects[`${NS}.wm`].native));
			assert.deepStrictEqual(objects[`${NS}.wm`].common, { name: "WM" });
			assert.strictEqual(objects[`${NS}.wm`].native.detection.startVal, 30);
			assert.strictEqual(objects[`${NS}.dw`].native.enabled, false);
			assert.deepStrictEqual(res.warnings, [
				'Device "DW": device type "gone" not found; values taken from template Custom; device disabled',
			]);
			assert.deepStrictEqual(instanceNative, before, "the instance native is only read");
		});

		it("twice = once", async () => {
			const objects = { [`${NS}.wm`]: { type: "device", common: {}, native: raw } };
			const { io, written } = fakeIo(objects);
			await applyV4Migration(io, {});
			const after = structuredClone(objects);
			const second = await applyV4Migration(io, {});
			assert.deepStrictEqual([second.migrated, written.length], [[], 1]);
			assert.deepStrictEqual(objects, after);
		});

		it("a failed write leaves the device unchanged and the next start continues with it", async () => {
			const objects = {
				[`${NS}.a`]: { type: "device", common: {}, native: { ...raw, name: "A" } },
				[`${NS}.b`]: { type: "device", common: {}, native: { ...raw, name: "B", typeId: "dryer" } },
			};
			const { io } = fakeIo(objects, new Set([`${NS}.a`]));
			const first = await applyV4Migration(io, {});
			assert.deepStrictEqual(first.migrated, [`${NS}.b`]);
			assert.match(first.warnings[0], /device-reminder\.0\.a: .*retried at the next start: disk full/);
			assert.strictEqual(objects[`${NS}.a`].native.typeId, "washing-machine");
			const second = await applyV4Migration(io, {});
			assert.deepStrictEqual([second.migrated, second.warnings], [[`${NS}.a`], []]);
			assert.strictEqual(typeHash(objects[`${NS}.a`].native.detection), "39417b8a");
			assert.strictEqual(objects[`${NS}.b`].native.detection.startVal, 120);
		});

		it("skips an object that changed in between and already has detection", async () => {
			const objects = { [`${NS}.wm`]: { type: "device", common: {}, native: raw } };
			const { io, written } = fakeIo(objects);
			io.getObject = async () => ({ type: "device", common: {}, native: migrateV4Device(raw, {}).native });
			assert.deepStrictEqual((await applyV4Migration(io, {})).migrated, []);
			assert.deepStrictEqual(written, []);
		});
	});
});
