import assert from "node:assert";
import { allocateDeviceId, sanitizeId } from "../build/lib/ids.js";
import { buildStateCommon, DEVICE_STATES } from "../build/lib/stateDefinitions.js";

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
});
