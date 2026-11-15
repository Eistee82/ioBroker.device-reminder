import assert from "node:assert";
import { readFileSync } from "node:fs";
import { TEXT } from "../build/lib/dmTexts.js";

const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

// The adapter is universal: no device-specific terms (e.g. "anti-crease", or parts of a washing programme such as
// soaking or spinning as examples) in the interface.
const FORBIDDEN = {
	de: ["knitterschutz", "einweich", "schleuder"],
	en: ["anti-crease", "anticrease", "anti crease", "soaking", "spinning", "last spin"],
	fr: ["anti-froissage", "antifroissage", "trempage", "essorage"],
	it: ["antipiega", "anti-piega", "ammollo", "centrifuga"],
	es: ["antiarrugas", "anti-arrugas", "remojo", "centrifugado"],
	nl: ["kreukbescherming", "anti-kreuk", "antikreuk", "centrifuge"],
	pl: ["przeciw zagnieceniom", "zagniece", "namaczanie", "wirowanie"],
	pt: ["anti-rugas", "antirrugas", "centrifugação"],
	ru: ["от сминания", "сминан", "замачиван", "отжим"],
	uk: ["від зминання", "зминан", "замочуван", "віджим"],
	"zh-cn": ["防皱", "浸泡", "脱水"],
};
// Numbered level/step names ("Level 3", "Stufe 3") are no phase names; phases are "Phase n".
const PHASE_WORDS = {
	de: ["Stufe", "Level"],
	en: ["Level", "Step", "Stage"],
	fr: ["Niveau", "Étape", "Etape"],
	it: ["Livello", "Stadio"],
	es: ["Nivel", "Etapa", "Paso"],
	nl: ["Niveau", "Stap", "Trap"],
	pl: ["Poziom", "Etap", "Krok", "Stopień"],
	pt: ["Nível", "Nivel", "Etapa", "Passo"],
	ru: ["Уровень", "Ступень", "Этап", "Шаг"],
	uk: ["Рівень", "Ступінь", "Етап", "Крок"],
	"zh-cn": ["级别", "等级", "步骤", "档位"],
};
const PHASE_NAMES = Object.entries(PHASE_WORDS).map(([lang, words]) =>
	// Chinese has no spaces between words, so no word boundary there.
	lang === "zh-cn"
		? new RegExp(`(?:${words.join("|")})\\s*\\d`, "u")
		: new RegExp(`(?:^|[^\\p{L}])(?:${words.join("|")})\\s*\\d`, "iu"),
);
const ALL_FORBIDDEN = Object.values(FORBIDDEN)
	.flat()
	.map(word => word.toLowerCase());

// Every text is checked against the words of all languages (texts often mix languages).
function check(where, text) {
	const lower = text.toLowerCase();
	for (const word of ALL_FORBIDDEN) {
		assert.ok(!lower.includes(word), `${where} contains "${word}": ${text}`);
	}
	for (const pattern of PHASE_NAMES) {
		assert.ok(!pattern.test(text), `${where} contains a level name: ${text}`);
	}
}

function walkStrings(node, path, skip = () => false) {
	if (typeof node === "string") {
		check(path, node);
	} else if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node)) {
			if (!skip(k)) {
				walkStrings(v, `${path}.${k}`, skip);
			}
		}
	}
}

describe("neutral terms in the interface", () => {
	for (const lang of LANGS) {
		it(`admin/i18n/${lang}.json has no device-specific terms`, () => {
			const json = JSON.parse(readFileSync(new URL(`../admin/i18n/${lang}.json`, import.meta.url), "utf8"));
			for (const [key, value] of Object.entries(json)) {
				check(`${lang}.json ${key}`, String(value));
			}
		});
	}

	it("device manager texts have no device-specific terms in any language", () => {
		for (const [key, value] of Object.entries(TEXT)) {
			const text = typeof value === "function" ? value("some.id") : value;
			for (const lang of LANGS) {
				check(`dmTexts ${key}.${lang}`, text[lang]);
			}
		}
	});

	it("io-package.json descriptions have no device-specific terms", () => {
		const io = JSON.parse(readFileSync(new URL("../io-package.json", import.meta.url), "utf8"));
		walkStrings(io.common, "common");
	});

	it("admin/jsonConfig.json has no device-specific terms", () => {
		const config = JSON.parse(readFileSync(new URL("../admin/jsonConfig.json", import.meta.url), "utf8"));
		walkStrings(config, "jsonConfig");
	});

	it("state names and the generated state tree have no device-specific terms", async () => {
		const defs = await import("../build/lib/stateDefinitions.js");
		for (const [name, value] of Object.entries(defs)) {
			if (typeof value !== "function") {
				walkStrings(value, `stateDefinitions.${name}`, k => k === "id");
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
				// Case-sensitive on purpose: "activity level 0" is a value, not a phase name.
				assert.ok(!/(?:Level|Stufe)\s*\d/.test(line), `${file}:${i + 1} contains a level name`);
			});
		}
	});
});
