import assert from "node:assert";
import { allocateDeviceId, sanitizeId } from "../build/lib/ids.js";
import { buildStateCommon, DEVICE_STATES, stateWanted } from "../build/lib/stateDefinitions.js";
import { deviceConfig, instanceConfig, WASHER } from "./helpers/devices.js";
import { WM_FINAL } from "./helpers/final.js";

const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

describe("stateDefinitions", () => {
	it("defines every state completely with names in 11 languages", () => {
		for (const def of DEVICE_STATES) {
			assert.ok(def.id && def.type && def.role, def.id);
			assert.notStrictEqual(def.def, undefined, def.id);
			for (const lang of LANGS) {
				assert.ok(typeof def.name[lang] === "string" && def.name[lang] !== "", `${def.id}.${lang}`);
			}
		}
	});

	it("has unique IDs without spaces", () => {
		const ids = DEVICE_STATES.map(d => d.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		assert.ok(ids.every(id => !/\s/.test(id)));
	});

	it("uses specific roles (only finished and a few flags are plain indicators among the reading states)", () => {
		for (const def of DEVICE_STATES) {
			assert.notStrictEqual(def.role, "state", def.id);
			if (def.role === "indicator") {
				assert.ok(["finished", "learning.active", "antiCrease", "learning.optimized"].includes(def.id), def.id);
			}
		}
	});

	it("builds common with unit and min", () => {
		const common = buildStateCommon(DEVICE_STATES.find(d => d.id === "config.runtimeMax"));
		assert.strictEqual(common.min, 0);
		assert.strictEqual(common.unit, "min");
		assert.strictEqual(common.write, true);
	});

	describe("ids", () => {
		it("sanitizes spaces, dots and umlauts", () => {
			assert.strictEqual(sanitizeId("Wasch Maschine.1"), "wasch_maschine_1");
			assert.strictEqual(sanitizeId("Spülmaschine"), "spuelmaschine");
			assert.strictEqual(sanitizeId("Größe[1]*"), "groesse_1");
			assert.strictEqual(sanitizeId("..."), "device");
			assert.strictEqual(sanitizeId(""), "device");
		});

		it("allocates unique IDs on collision", () => {
			assert.strictEqual(allocateDeviceId("Trockner", new Set()), "trockner");
			assert.strictEqual(allocateDeviceId("Trockner", new Set(["trockner"])), "trockner_2");
			assert.strictEqual(allocateDeviceId("Trockner", new Set(["trockner", "trockner_2"])), "trockner_3");
			assert.strictEqual(allocateDeviceId("Trock ner", new Set(["trock_ner"])), "trock_ner_2");
		});
	});
	it("settlingUntil is a read-only date that exists only with an active final phase", () => {
		const def = DEVICE_STATES.find(d => d.id === "settlingUntil");
		assert.deepStrictEqual(
			[def.type, def.role, def.read, def.write, def.def, def.when],
			["number", "date", true, false, 0, "final"],
		);
		const inst = instanceConfig();
		assert.strictEqual(stateWanted(def, deviceConfig(), inst), false);
		assert.strictEqual(stateWanted(def, deviceConfig({ detection: { ...WASHER, ...WM_FINAL } }), inst), true);
		assert.strictEqual(stateWanted(def, deviceConfig(), inst, { ...WM_FINAL }), true, "override");
		assert.strictEqual(
			stateWanted(def, deviceConfig({ detection: { ...WASHER, ...WM_FINAL } }), inst, { finalMinSec: 0 }),
			false,
			"override switches it off",
		);
		assert.strictEqual(stateWanted(def, deviceConfig({ detection: { ...WASHER, finalMinVal: 150 } }), inst), false);
	});

	it("stateWanted: learning always, historyHtml with the instance setting, phases with enabled phases", () => {
		const by = id => DEVICE_STATES.find(d => d.id === id);
		const inst = instanceConfig();
		assert.strictEqual(stateWanted(by("learning.start"), deviceConfig(), inst), true);
		assert.strictEqual(stateWanted(by("status"), deviceConfig(), inst), true);
		assert.strictEqual(
			stateWanted(by("lastOperationsHtml"), deviceConfig(), { ...inst, historyHtml: false }),
			false,
		);
		assert.strictEqual(stateWanted(by("lastOperationsHtml"), deviceConfig(), { ...inst, historyHtml: true }), true);
		const phases = { ...by("status"), when: "phases" };
		assert.strictEqual(stateWanted(phases, deviceConfig(), inst), false);
		assert.strictEqual(stateWanted(phases, deviceConfig({ phases: { enabled: true } }), inst), true);
	});

	it("learning.reset is named after the base values", () => {
		const def = DEVICE_STATES.find(d => d.id === "learning.reset");
		assert.strictEqual(def.name.de, "Auf die Grundwerte des Geräts zurücksetzen");
	});
});
