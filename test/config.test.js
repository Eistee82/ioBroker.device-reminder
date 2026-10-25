import assert from "node:assert";
import fs from "node:fs";
import {
	DEFAULT_REMINDER,
	DEFAULT_TYPES,
	findType,
	normalizeDeviceConfig,
	normalizeInstanceConfig,
} from "../build/lib/config.js";

describe("configuration model", () => {
	describe("normalizeInstanceConfig", () => {
		it("returns defaults for empty native", () => {
			const { config, warnings } = normalizeInstanceConfig({});
			assert.strictEqual(config.types.length, 13);
			assert.strictEqual(config.types.length, DEFAULT_TYPES.length);
			assert.deepStrictEqual(config.statusTexts, {
				running: "in action",
				standby: "standby",
				off: "switched off",
			});
			assert.strictEqual(config.pollIntervalSec, 10);
			assert.strictEqual(config.historyHtml, false);
			assert.strictEqual(config.configVersion, 4);
			assert.deepStrictEqual(warnings, []);
		});

		it("has the documented built-in defaults", () => {
			const { config } = normalizeInstanceConfig({});
			const wm = findType(config, "washing-machine");
			assert.deepStrictEqual(
				[wm.startVal, wm.endVal, wm.standby, wm.startCount, wm.endCount, wm.builtin, wm.mode],
				[30, 15, 1, 2, 50, true, "count"],
			);
			assert.strictEqual(findType(config, "custom10").builtin, false);
			assert.strictEqual(findType(config, "nope"), undefined);
		});

		it("default types match the 3.1.2 values (config.ts and io-package.json)", () => {
			const legacy = {
				"washing-machine": [30, 15, 1, 2, 50],
				dryer: [120, 15, 1, 2, 20],
				dishwasher: [15, 0.25, 0.5, 2, 120],
			};
			for (let i = 1; i <= 10; i++) {
				legacy[`custom${i}`] = [30, 5, 1, 1, 20];
			}
			const pick = t => [t.startVal, t.endVal, t.standby, t.startCount, t.endCount];
			const pkg = JSON.parse(fs.readFileSync(new URL("../io-package.json", import.meta.url), "utf8"));
			for (const list of [DEFAULT_TYPES, pkg.native.types]) {
				assert.strictEqual(list.length, Object.keys(legacy).length);
				for (const t of list) {
					assert.deepStrictEqual(pick(t), legacy[t.id], t.id);
				}
			}
		});

		it("generates stable ids for recipients without id and keeps them when the first is deleted", () => {
			const first = normalizeInstanceConfig({
				recipients: [
					{ name: "A", kind: "telegram" },
					{ name: "B", kind: "email" },
					{ id: "keep", name: "C", kind: "email" },
				],
			});
			assert.strictEqual(first.generatedIds, true);
			const ids = first.config.recipients.map(r => r.id);
			assert.strictEqual(new Set(ids).size, 3);
			assert.ok(ids.every(id => !/^recipientd+$/.test(id)));
			assert.strictEqual(ids[2], "keep");
			// the admin stores the patched rows; the first one is then deleted
			const stored = first.idPatch.recipients;
			assert.strictEqual(stored.length, 3);
			const second = normalizeInstanceConfig({ recipients: stored.slice(1) });
			assert.strictEqual(second.generatedIds, false);
			assert.deepStrictEqual(
				second.config.recipients.map(r => r.id),
				ids.slice(1),
			);
		});

		it("gives a cloned recipient (duplicate id) a new id instead of dropping it", () => {
			const { config, generatedIds } = normalizeInstanceConfig({
				recipients: [
					{ id: "telegram-x", name: "A", kind: "telegram" },
					{ id: "telegram-x", name: "A copy", kind: "telegram" },
				],
			});
			assert.strictEqual(generatedIds, true);
			assert.strictEqual(config.recipients.length, 2);
			assert.strictEqual(config.recipients[0].id, "telegram-x");
			assert.notStrictEqual(config.recipients[1].id, "telegram-x");
		});

		it("keeps a device type row without id and keeps its id across a second run", () => {
			const first = normalizeInstanceConfig({
				types: [{ name: "Coffee machine", startVal: 100 }, { name: "Coffee machine" }],
			});
			assert.strictEqual(first.generatedIds, true);
			assert.deepStrictEqual(first.warnings, []);
			const coffee = first.config.types.filter(t => !t.builtin);
			assert.deepStrictEqual(
				coffee.map(t => t.id),
				["coffee_machine", "coffee_machine_2"],
			);
			assert.strictEqual(coffee[0].startVal, 100);
			const second = normalizeInstanceConfig({ types: first.idPatch.types.slice(1) });
			assert.strictEqual(second.generatedIds, false);
			assert.ok(second.config.types.some(t => t.id === "coffee_machine_2"));
		});

		it("does not generate ids when all rows have one", () => {
			const res = normalizeInstanceConfig({
				types: [{ id: "x", name: "X" }],
				recipients: [{ id: "a", kind: "email", instance: "email.0" }],
			});
			assert.strictEqual(res.generatedIds, false);
			assert.deepStrictEqual(res.idPatch, {});
		});

		it("keeps standby 0", () => {
			const { config } = normalizeInstanceConfig({ types: [{ id: "x", name: "X", standby: 0 }] });
			assert.strictEqual(findType(config, "x").standby, 0);
		});

		it("drops recipients without kind and warns", () => {
			const { config, warnings } = normalizeInstanceConfig({
				recipients: [
					{ id: "a", name: "A" },
					{ id: "b", name: "B", kind: "telegram" },
				],
			});
			assert.deepStrictEqual(
				config.recipients.map(r => r.id),
				["b"],
			);
			assert.strictEqual(warnings.length, 1);
		});

		it("clamps the poll interval and parses numeric strings", () => {
			assert.strictEqual(normalizeInstanceConfig({ pollIntervalSec: 9999 }).config.pollIntervalSec, 600);
			assert.strictEqual(normalizeInstanceConfig({ pollIntervalSec: 0 }).config.pollIntervalSec, 1);
			assert.strictEqual(normalizeInstanceConfig({ pollIntervalSec: "30" }).config.pollIntervalSec, 30);
		});

		it("ignores unknown fields", () => {
			const { config } = normalizeInstanceConfig({ foo: 1, recipients: [{ id: "a", kind: "email", bar: 2 }] });
			assert.strictEqual("foo" in config, false);
			assert.strictEqual("bar" in config.recipients[0], false);
		});
	});

	describe("normalizeDeviceConfig", () => {
		it("returns null with a warning without powerId", () => {
			const { config, warnings } = normalizeDeviceConfig({ name: "W" });
			assert.strictEqual(config, null);
			assert.strictEqual(warnings.length, 1);
		});

		it("parses autoOffMinutes strings", () => {
			const { config } = normalizeDeviceConfig({ name: "W", powerId: "a.b", autoOffMinutes: "5" });
			assert.strictEqual(config.autoOffMinutes, 5);
		});

		it("fills defaults for reminder, actions and abortFixed", () => {
			const { config } = normalizeDeviceConfig({ name: "W", powerId: "a.b" });
			assert.deepStrictEqual(config.reminder, DEFAULT_REMINDER);
			assert.deepStrictEqual(config.actions, []);
			assert.strictEqual(config.abortFixed, false);
			assert.strictEqual(config.autoOff, false);
			assert.strictEqual(config.abort, false);
		});

		it("drops actions without stateId", () => {
			const { config, warnings } = normalizeDeviceConfig({
				name: "W",
				powerId: "a.b",
				actions: [
					{ event: "start", stateId: "", value: "1" },
					{ event: "end", stateId: "x.y", value: "0" },
				],
			});
			assert.deepStrictEqual(config.actions, [{ event: "end", stateId: "x.y", value: "0" }]);
			assert.strictEqual(warnings.length, 1);
		});
	});
});
