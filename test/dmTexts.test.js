import assert from "node:assert";
import { plain, TEXT } from "../build/lib/dmTexts.js";

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

	it("plain repeats a text in all languages", () => {
		const text = plain("x");
		assert.ok(LANGS.every(l => text[l] === "x"));
	});
});
