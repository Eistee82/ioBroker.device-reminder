import assert from "node:assert";
import { readFileSync } from "node:fs";
import { plain, TEMPLATE_NAMES, TEXT } from "../build/lib/dmTexts.js";

const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

describe("device manager texts", () => {
	it("every text exists in all 11 languages", () => {
		for (const [key, value] of Object.entries(TEXT)) {
			const text = typeof value === "function" ? value("some.id") : value;
			assert.deepStrictEqual(Object.keys(text).sort(), [...LANGS].sort(), key);
			for (const lang of LANGS) {
				assert.ok(typeof text[lang] === "string" && text[lang].trim() !== "", `${key}.${lang}`);
			}
			if (typeof value === "function") {
				for (const lang of LANGS) {
					assert.ok(text[lang].includes("some.id"), `${key}.${lang} contains the id`);
				}
			}
		}
	});

	it("only the short technical texts may equal the English one in all languages", () => {
		const same = Object.entries(TEXT)
			.filter(([, v]) => typeof v !== "function")
			.filter(([, v]) => LANGS.every(l => v[l] === v.en))
			.map(([k]) => k);
		assert.deepStrictEqual(same, []);
	});

	it("a run is a cycle, not a race, and the final band no music band (machine translations)", () => {
		// the terms of dmTexts.ts: ciclo, cycle, ciclo, ciclo, cykl, цикл, цикл, 运行
		const wrong = {
			es: /carrera/i,
			fr: /\bcourses?\b/i,
			it: /\bcors[ae]\b/i,
			pt: /corrida/i,
			pl: /\bbieg/i,
			ru: /пробег|забег|\bбег\b/i,
			uk: /\bбіг\b|біжать|забіг/i,
			"zh-cn": /跑步|比赛|乐队/,
			nl: /rennen/i,
		};
		for (const [lang, bad] of Object.entries(wrong)) {
			const dict = JSON.parse(readFileSync(new URL(`../admin/i18n/${lang}.json`, import.meta.url), "utf8"));
			for (const [k, v] of Object.entries(dict)) {
				assert.doesNotMatch(v, bad, `${lang}:${k}`);
			}
			for (const [k, v] of Object.entries(TEXT)) {
				const text = typeof v === "function" ? v("x") : v;
				assert.doesNotMatch(text[lang], bad, `TEXT.${k}.${lang}`);
			}
		}
	});
	it("plain repeats a text in all languages", () => {
		const text = plain("x");
		assert.ok(LANGS.every(l => text[l] === "x"));
	});
	it("removed type texts are gone and the new texts exist in 11 languages", () => {
		const de = JSON.parse(readFileSync(new URL("../admin/i18n/de.json", import.meta.url), "utf8"));
		for (const k of [
			"tabTypes",
			"typesHelp",
			"dev_typeId",
			"dm_detailsType",
			"dm_learnName",
			"dm_learnCurrentType",
			"dm_optSaveType",
			"dm_optTypeValue",
		]) {
			assert.strictEqual(de[k], undefined, k);
		}
		// typeNeedsName and unknownType are TEXT entries in dmTexts.ts, not i18n keys
		for (const k of ["typeNeedsName", "unknownType"]) {
			assert.strictEqual(TEXT[k], undefined, k);
		}
		for (const lang of LANGS) {
			const dict = JSON.parse(readFileSync(new URL(`../admin/i18n/${lang}.json`, import.meta.url), "utf8"));
			for (const k of [
				"valuesInDeviceHelp",
				"dev_template",
				"dev_expertValues",
				"dev_detectionSection",
				"finalMinVal",
				"finalLockSecTooltip",
				"dm_removeArchive",
				"dm_copyFinalHint",
				"dm_detailsDetection",
				"dev_sourceValues",
			]) {
				assert.ok(dict[k], `${lang}:${k}`);
			}
		}
	});

	it("the texts of the device manager no longer speak of a device type", () => {
		const texts = Object.values(TEXT)
			.map(v => (typeof v === "function" ? v("x") : v))
			.flatMap(t => [t.en, t.de]);
		assert.deepStrictEqual(
			texts.filter(t => /device type|Gerätetyp/i.test(t)),
			[],
		);
	});

	it("the built-in templates have names in 11 languages", () => {
		for (const id of ["washing-machine", "dryer", "dishwasher", "custom"]) {
			assert.deepStrictEqual(Object.keys(TEMPLATE_NAMES[id]).sort(), [...LANGS].sort(), id);
		}
	});
});
