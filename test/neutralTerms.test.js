import assert from "node:assert";
import { readFileSync } from "node:fs";
import { TEXT } from "../build/lib/dmTexts.js";

const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

// The adapter is universal: no device-specific terms (e.g. "anti-crease") in the interface.
const FORBIDDEN = {
	de: ["knitterschutz"],
	en: ["anti-crease", "anticrease", "anti crease", "crease"],
	fr: ["anti-froissage", "antifroissage"],
	it: ["antipiega", "anti-piega"],
	es: ["antiarrugas", "anti-arrugas"],
	nl: ["kreukbescherming", "anti-kreuk", "antikreuk"],
	pl: ["przeciw zagnieceniom", "zagniece", "zagnieceń"],
	pt: ["anti-rugas", "antirrugas"],
	ru: ["от сминания", "сминан"],
	uk: ["від зминання", "зминан"],
	"zh-cn": ["防皱"],
};
const PHASE_NAME = /(?:^|[^\p{L}])(?:Level|Stufe)\s*\d/iu;

function check(lang, where, text) {
	const lower = text.toLowerCase();
	for (const word of [...FORBIDDEN[lang], ...Object.values(FORBIDDEN).flat()]) {
		assert.ok(!lower.includes(word.toLowerCase()), `${where} contains "${word}": ${text}`);
	}
	assert.ok(!PHASE_NAME.test(text), `${where} contains a level name: ${text}`);
}

describe("neutral terms in the interface", () => {
	for (const lang of LANGS) {
		it(`admin/i18n/${lang}.json has no device-specific terms`, () => {
			const json = JSON.parse(readFileSync(new URL(`../admin/i18n/${lang}.json`, import.meta.url), "utf8"));
			for (const [key, value] of Object.entries(json)) {
				check(lang, `${lang}.json ${key}`, String(value));
			}
		});
	}

	it("device manager texts have no device-specific terms in any language", () => {
		for (const [key, value] of Object.entries(TEXT)) {
			const text = typeof value === "function" ? value("some.id") : value;
			for (const lang of LANGS) {
				check(lang, `dmTexts ${key}.${lang}`, text[lang]);
			}
		}
	});

	it("io-package.json descriptions have no device-specific terms", () => {
		const io = JSON.parse(readFileSync(new URL("../io-package.json", import.meta.url), "utf8"));
		const walk = (node, path) => {
			if (typeof node === "string") {
				check("en", path, node);
			} else if (node && typeof node === "object") {
				for (const [k, v] of Object.entries(node)) {
					walk(v, `${path}.${k}`);
				}
			}
		};
		walk(io.common, "common");
	});

	it("state names and the generated state tree have no device-specific terms", async () => {
		const defs = await import("../build/lib/stateDefinitions.js");
		const walk = (node, path) => {
			if (typeof node === "string") {
				check("en", path, node);
			} else if (node && typeof node === "object") {
				for (const [k, v] of Object.entries(node)) {
					if (k !== "id") {
						walk(v, `${path}.${k}`);
					}
				}
			}
		};
		for (const [name, value] of Object.entries(defs)) {
			if (typeof value !== "function") {
				walk(value, `stateDefinitions.${name}`);
			}
		}
	});

	it("the docs mention such terms only as an example", () => {
		for (const file of ["docs/en/README.md", "docs/de/README.md", "docs/release-notes-4.0.0.md", "README.md"]) {
			const lines = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n");
			lines.forEach((line, i) => {
				for (const word of ["knitterschutz", "anti-crease"]) {
					if (line.toLowerCase().includes(word)) {
						assert.ok(
							/z\. ?B\.|e\.g\.|for example|zum Beispiel/.test(line),
							`${file}:${i + 1} mentions ${word} without an example marker`,
						);
					}
				}
				assert.ok(!/(?:Level|Stufe) ?[0-9]/.test(line), `${file}:${i + 1} contains a level name`);
			});
		}
	});
});
