import assert from "node:assert";
import fs from "node:fs";
import {
	DEFAULT_REMINDER,
	FINAL_BOUNDS,
	finalViolations,
	normalizeDetection,
	normalizeDeviceConfig,
	normalizeFinal,
	normalizeInstanceConfig,
} from "../build/lib/config.js";
import { DEFAULT_TYPES, findType, resolveLegacyTypes } from "../build/lib/legacyTypes.js";
import { WASHER } from "./helpers/devices.js";

describe("configuration model", () => {
	describe("normalizeInstanceConfig", () => {
		it("returns defaults for empty native", () => {
			const { config, warnings } = normalizeInstanceConfig({});
			assert.strictEqual("types" in config, false, "the values live in the devices");
			assert.strictEqual(resolveLegacyTypes({}).length, 13);
			assert.strictEqual(resolveLegacyTypes({}).length, DEFAULT_TYPES.length);
			assert.deepStrictEqual(config.statusTexts, {
				running: "in action",
				standby: "standby",
				off: "switched off",
			});
			assert.strictEqual(config.pollIntervalSec, 10);
			assert.strictEqual(config.historyHtml, false);
			assert.strictEqual(config.configVersion, 5);
			assert.deepStrictEqual(warnings, []);
		});

		it("has the documented built-in defaults", () => {
			const config = resolveLegacyTypes({});
			const wm = findType(config, "washing-machine");
			assert.deepStrictEqual(
				[wm.startVal, wm.endVal, wm.standby, wm.startCount, wm.endCount, wm.builtin, wm.mode],
				[30, 15, 1, 2, 50, true, "count"],
			);
			assert.strictEqual(findType(config, "custom10").builtin, false);
			assert.strictEqual(findType(config, "nope"), undefined);
		});

		it("default types match the 3.1.2 values; io-package.json has no types and configVersion 5", () => {
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
			assert.strictEqual(DEFAULT_TYPES.length, Object.keys(legacy).length);
			for (const t of DEFAULT_TYPES) {
				assert.deepStrictEqual(pick(t), legacy[t.id], t.id);
			}
			assert.strictEqual(pkg.native.types, undefined);
			assert.strictEqual(pkg.native.configVersion, 5);
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

		it("resolves a device type row without id to the same id as before, without writing anything", () => {
			const native = { types: [{ name: "Coffee machine", startVal: 100 }, { name: "Coffee machine" }] };
			const warnings = [];
			const coffee = resolveLegacyTypes(native, warnings).filter(t => !t.builtin);
			assert.deepStrictEqual(warnings, []);
			assert.deepStrictEqual(
				coffee.map(t => t.id),
				["coffee_machine", "coffee_machine_2"],
			);
			assert.strictEqual(coffee[0].startVal, 100);
			assert.strictEqual(native.types[0].id, undefined);
			const res = normalizeInstanceConfig(native);
			assert.strictEqual(res.generatedIds, false, "types are no longer part of the instance configuration");
			assert.deepStrictEqual(res.idPatch, {});
		});

		it("does not generate ids when all rows have one", () => {
			const res = normalizeInstanceConfig({
				types: [{ id: "x", name: "X" }],
				recipients: [{ id: "a", kind: "email", instance: "email.0" }],
			});
			assert.strictEqual(res.generatedIds, false);
			assert.deepStrictEqual(res.idPatch, {});
		});

		it("normalizes the pause protection fields (default 0 = off)", () => {
			const pause = t => [t.pauseHoldSec, t.pauseUntilSec, t.pauseBelowVal];
			for (const t of DEFAULT_TYPES) {
				assert.deepStrictEqual(pause(t), [0, 0, 0], t.id);
			}
			const config = resolveLegacyTypes({
				types: [
					{ id: "a", name: "A" },
					{ id: "b", name: "B", pauseHoldSec: -5, pauseUntilSec: "x", pauseBelowVal: -1 },
					{ id: "c", name: "C", pauseHoldSec: "12", pauseUntilSec: 900, pauseBelowVal: "0.25" },
				],
			});
			assert.deepStrictEqual(pause(findType(config, "a")), [0, 0, 0]);
			assert.deepStrictEqual(pause(findType(config, "b")), [0, 0, 0]);
			assert.deepStrictEqual(pause(findType(config, "c")), [12, 900, 0.25]);
		});

		it("keeps standby 0", () => {
			const config = resolveLegacyTypes({ types: [{ id: "x", name: "X", standby: 0 }] });
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
			const { config } = normalizeDeviceConfig({
				name: "W",
				powerId: "a.b",
				detection: WASHER,
				autoOffMinutes: "5",
			});
			assert.strictEqual(config.autoOffMinutes, 5);
		});

		it("fills defaults for reminder, actions and abortFixed", () => {
			const { config } = normalizeDeviceConfig({ name: "W", powerId: "a.b", detection: WASHER });
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
				detection: WASHER,
				actions: [
					{ event: "start", stateId: "", value: "1" },
					{ event: "end", stateId: "x.y", value: "0" },
				],
			});
			assert.deepStrictEqual(config.actions, [{ event: "end", stateId: "x.y", value: "0" }]);
			assert.strictEqual(warnings.length, 1);
		});

		it("reads a V4 device with typeId through the legacy types without writing", () => {
			const raw = { name: "WM", powerId: "a.0.p", typeId: "dryer" };
			const { config } = normalizeDeviceConfig(raw, resolveLegacyTypes({}));
			assert.deepStrictEqual([config.detection.startVal, config.detection.endCount], [120, 20]);
			assert.strictEqual(raw.detection, undefined);
			assert.deepStrictEqual([config.template, config.enabled, config.needsReview], ["dryer", true, undefined]);
			assert.ok(!("typeId" in config), "the read config has no typeId");
		});

		it("falls back to Custom, disabled with a review hint, when the detection is missing", () => {
			for (const raw of [
				{ name: "WM", powerId: "a.0.p", enabled: true },
				{ name: "WM", powerId: "a.0.p", enabled: true, typeId: "gone" },
			]) {
				const { config, warnings } = normalizeDeviceConfig(raw, resolveLegacyTypes({}));
				assert.deepStrictEqual(
					[config.detection.startVal, config.detection.endVal, config.detection.endCount],
					[30, 5, 20],
				);
				assert.deepStrictEqual([config.enabled, config.needsReview], [false, true]);
				assert.strictEqual(config.reviewHint, 'detection values missing, using "Custom"');
				assert.deepStrictEqual(warnings, [
					'Device "WM": detection values missing, using "Custom", device disabled until it is checked',
				]);
			}
		});

		it("normalizes detection like a type and keeps the final fields", () => {
			const { config } = normalizeDeviceConfig({
				name: "WM",
				powerId: "a.0.p",
				detection: {
					startVal: "30",
					endVal: 15,
					standby: 1,
					startCount: 2,
					endCount: 50,
					mode: "bogus",
					finalMinVal: 150,
					finalMinSec: 168,
				},
			});
			assert.deepStrictEqual(
				[config.detection.startVal, config.detection.mode, config.detection.finalMinVal],
				[30, "count", 150],
			);
		});

		it("keeps the stored detection, template and review hint; prefers detection over typeId", () => {
			const { config, warnings } = normalizeDeviceConfig(
				{
					name: "WM",
					powerId: "a.0.p",
					detection: { ...WASHER, endCount: 77 },
					template: "washing-machine",
					needsReview: true,
					reviewHint: "check",
					enabled: false,
					typeId: "dryer",
				},
				resolveLegacyTypes({}),
			);
			assert.deepStrictEqual(warnings, []);
			assert.deepStrictEqual(
				[config.detection.endCount, config.template, config.needsReview, config.reviewHint, "typeId" in config],
				[77, "washing-machine", true, "check", false],
			);
		});
	});

	describe("normalizeDetection", () => {
		it("fills every field and warns about missing or invalid base values", () => {
			const w = [];
			const d = normalizeDetection(
				{ startVal: "x", endVal: -3, standby: 1, startCount: 2, endCount: 5, mode: "timed" },
				w,
				"WM",
			);
			assert.strictEqual(Object.keys(d).length, 29);
			assert.deepStrictEqual(
				[d.startVal, d.endVal, d.mode, d.startDurationSec, d.endDurationSec],
				[30, 0, "timed", 60, 300],
			);
			assert.deepStrictEqual(w, [
				'Device "WM": startVal "x" → 30 (not a number)',
				'Device "WM": startDurationSec missing → 60 (not a number)',
				'Device "WM": endDurationSec missing → 300 (not a number)',
			]);
			assert.strictEqual(normalizeDetection("nope", [], "WM"), null);
			assert.strictEqual(normalizeDetection(undefined, [], "WM"), null);
		});

		it("keeps a complete set of values unchanged and without warning", () => {
			const w = [];
			assert.deepStrictEqual(normalizeDetection(WASHER, w, "WM"), WASHER);
			assert.deepStrictEqual(w, []);
		});

		it("corrects the final phase with normalizeFinal", () => {
			const w = [];
			const d = normalizeDetection({ ...WASHER, finalMinVal: 150, finalMinSec: 168, finalMaxVal: 100 }, w, "WM");
			assert.strictEqual(d.finalMinVal, 0);
			assert.strictEqual(w.length, 1);
		});
	});
});

/** Final phase of the washer as checked on the real data (Spec A.3 "Geprüft", y_actexit.mjs). */
const WM_FINAL = {
	finalMinVal: 150,
	finalMaxVal: 1311,
	finalHotVal: 1311,
	finalAfterSec: 3600,
	finalMinSec: 168,
	finalQuietSec: 120,
	finalDipSec: 60,
	finalRestVal: 5.5,
	finalRestSec: 60,
	finalActVal: 9,
	finalActShare: 0.7,
	finalCheckSec: 2400,
	finalLockSec: 2700,
};
const norm = (over, standby = 1) => {
	const w = [];
	return { f: normalizeFinal({ standby, ...WM_FINAL, ...over }, w, "WM"), w };
};

describe("final phase bounds", () => {
	it("is off without the master switch, silently", () => {
		const w = [];
		assert.deepStrictEqual(normalizeFinal({ standby: 1, finalMinVal: 150 }, w, "WM"), {});
		assert.deepStrictEqual(normalizeFinal({ standby: 1, finalMinSec: 168 }, w, "WM"), {});
		assert.deepStrictEqual(w, []);
	});

	it("keeps the learned washer values unchanged and without warning", () => {
		const { f, w } = norm({});
		assert.deepStrictEqual(f, WM_FINAL);
		assert.deepStrictEqual(w, []);
		assert.deepStrictEqual(finalViolations(WM_FINAL, 1, 10), []);
	});

	it("keeps the same values of a kW state (÷ 1000) unchanged", () => {
		const kw = {
			...WM_FINAL,
			finalMinVal: 0.15,
			finalMaxVal: 1.311,
			finalHotVal: 1.311,
			finalRestVal: 0.0055,
			finalActVal: 0.009,
		};
		const w = [];
		assert.deepStrictEqual(normalizeFinal({ standby: 0.001, ...kw }, w, "WM"), kw);
		assert.deepStrictEqual(w, []);
	});

	it("accepts extreme but real devices: kettle Y 30 s, 3D printer X 1 day, charger P 0.4 W", () => {
		assert.deepStrictEqual(norm({ finalMinSec: 30 }).w, []);
		assert.deepStrictEqual(norm({ finalAfterSec: 86_400 }).w, []);
		const charger = {
			finalMinVal: 0.4,
			finalMaxVal: 0,
			finalHotVal: 0,
			finalRestVal: 0.1,
			finalActVal: 0,
			finalActShare: 0,
		};
		const { f, w } = norm(charger, 0.05);
		assert.strictEqual(f.finalMinVal, 0.4);
		assert.deepStrictEqual(w, []);
	});

	const CLAMP = [
		// key, below, clamped low, above, clamped high, extra settings so that no other rule interferes
		["finalAfterSec", -5, 0, 700_000, 604_800, {}],
		["finalMinSec", 5, 10, 90_000, 86_400, {}],
		["finalQuietSec", 10, 30, 8000, 7200, { finalDipSec: 10 }],
		["finalDipSec", 5, 10, 4000, 3600, { finalQuietSec: 7200 }],
		["finalRestSec", 5, 10, 20_000, 14_400, {}],
		["finalCheckSec", 100, 300, 20_000, 14_400, { finalLockSec: 14_400 }],
		["finalLockSec", 100, 600, 20_000, 14_400, { finalCheckSec: 300 }],
		["finalActShare", 0.3, 0.5, 0.95, 0.9, {}],
	];
	for (const [key, below, lo, above, hi, extra] of CLAMP) {
		it(`clamps ${key} to [${lo}; ${hi}] with a warning`, () => {
			const a = norm({ ...extra, [key]: below });
			assert.strictEqual(a.f[key], lo);
			assert.ok(
				a.w.some(m => m.includes(key)),
				a.w.join(),
			);
			const b = norm({ ...extra, [key]: above });
			assert.strictEqual(b.f[key], hi);
			assert.ok(
				b.w.some(m => m.includes(key)),
				b.w.join(),
			);
		});
	}

	it("FINAL_BOUNDS hold the time ranges of the table", () => {
		assert.deepStrictEqual(FINAL_BOUNDS.finalAfterSec, [0, 604_800]);
		assert.deepStrictEqual(FINAL_BOUNDS.finalLockSec, [600, 14_400]);
		assert.deepStrictEqual(FINAL_BOUNDS.finalActShare, [0.5, 0.9]);
	});

	it("switches the final phase off when the band is empty or below the rest level", () => {
		for (const over of [
			{ finalMaxVal: 150 },
			{ finalMaxVal: 100 },
			{ finalRestVal: 150 },
			{ finalRestVal: 0, finalMinVal: 0.8 },
		]) {
			const { f, w } = norm(over);
			assert.deepStrictEqual(f, {}, JSON.stringify(over));
			assert.strictEqual(w.length, 1, JSON.stringify(over));
		}
	});

	it("turns exit c off when finalHotVal is below Pmax or Pmax is open", () => {
		assert.strictEqual(norm({ finalHotVal: 900 }).f.finalHotVal, 0);
		assert.strictEqual(norm({ finalMaxVal: 0 }).f.finalHotVal, 0);
		assert.strictEqual(norm({ finalHotVal: 2000 }).f.finalHotVal, 2000);
	});

	it("turns exit f off when the activity level overlaps the band or the rest, or only one of both is set", () => {
		for (const over of [{ finalActVal: 150 }, { finalActVal: 3 }, { finalActShare: 0 }, { finalActVal: 0 }]) {
			const { f, w } = norm(over);
			assert.deepStrictEqual([f.finalActVal, f.finalActShare], [0, 0], JSON.stringify(over));
			assert.strictEqual(w.length, 1, JSON.stringify(over));
		}
	});

	it("raises Z to G and limits the check window to the lock", () => {
		assert.strictEqual(norm({ finalQuietSec: 60, finalDipSec: 300 }).f.finalQuietSec, 300);
		assert.strictEqual(norm({ finalCheckSec: 3600, finalLockSec: 2700 }).f.finalCheckSec, 2700);
	});

	it("reads numbers given as text and treats NaN and negatives as 0", () => {
		assert.strictEqual(normalizeFinal({ standby: 1, ...WM_FINAL, finalMinVal: "150" }, [], "WM").finalMinVal, 150);
		assert.deepStrictEqual(normalizeFinal({ standby: 1, ...WM_FINAL, finalMinVal: Number.NaN }, [], "WM"), {});
		assert.deepStrictEqual(normalizeFinal({ standby: 1, ...WM_FINAL, finalMinSec: -1 }, [], "WM"), {});
	});

	it("finalViolations reports the per-poll floors without changing anything", () => {
		assert.deepStrictEqual(finalViolations(WM_FINAL, 1, 10), []);
		assert.deepStrictEqual(finalViolations(WM_FINAL, 1, 100).sort(), [
			"finalDipSec",
			"finalMinSec",
			"finalQuietSec",
			"finalRestSec",
		]);
		assert.deepStrictEqual(finalViolations({ ...WM_FINAL, finalMaxVal: 100 }, 1, 10), ["finalMaxVal"]);
	});
});
