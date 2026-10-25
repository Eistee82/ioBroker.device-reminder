import assert from "node:assert";
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
				[wm.startVal, wm.endVal, wm.startCount, wm.endCount, wm.standby, wm.builtin, wm.mode],
				[30, 15, 1, 2, 50, true, "count"],
			);
			assert.strictEqual(findType(config, "custom10").builtin, false);
			assert.strictEqual(findType(config, "nope"), undefined);
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
