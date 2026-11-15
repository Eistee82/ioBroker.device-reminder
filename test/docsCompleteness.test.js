import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Read a repository file.
 *
 * @param {string} rel - Path relative to the repository root.
 */
function read(rel) {
	return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

/** Terms both documentation languages have to mention (Spec 7.5). */
const TERMS = {
	de: ["Startverzögerung", "Restrisiko", "8 Läufe", "10 zugelassenen Läufe", "2 Läufen je Programmgruppe"],
	en: ["Start delay", "Remaining risk", "8 runs", "10 admitted runs", "2 runs per programme group"],
};

const COMMON_TERMS = [
	"keepCurrentLevel",
	"settlingUntil",
	"learning.parameters",
	"phaseStart",
	"phaseEnd",
	"finalMinVal",
	"604 800",
	"Pushover",
];

/** Longest changelog entry in characters. */
const CHANGELOG_MAX = 300;

describe("documentation completeness", () => {
	for (const lang of ["en", "de"]) {
		it(`${lang} documentation mentions every required term`, () => {
			const text = read(`docs/${lang}/README.md`);
			for (const term of [...COMMON_TERMS, ...TERMS[lang]]) {
				assert.ok(text.includes(term), `${lang}: ${term} missing`);
			}
		});
	}

	it("both languages have the same chapter structure", () => {
		const count = lang => (read(`docs/${lang}/README.md`).match(/^## \d+\./gm) ?? []).length;
		assert.strictEqual(count("de"), count("en"));
	});

	it("the work in progress block has exactly 6 changelog lines", () => {
		const readme = read("README.md");
		const start = readme.lastIndexOf("### **WORK IN PROGRESS**");
		const end = readme.indexOf("### ", start + 5);
		const lines = readme
			.slice(start, end)
			.split("\n")
			.filter(line => line.startsWith("- (Eistee82) "));
		assert.strictEqual(lines.length, 6);
		// each entry short (one line, no list of details; PR checklist)
		for (const line of lines) {
			assert.ok(line.length <= CHANGELOG_MAX, `${line.length} characters: ${line.slice(0, 60)}`);
		}
	});

	it("no e-mail address in the documentation (README and every Markdown file under docs/)", () => {
		const files = [
			"README.md",
			...readdirSync(fileURLToPath(new URL("../docs/", import.meta.url)), { recursive: true })
				.map(f => String(f).replaceAll("\\", "/"))
				.filter(f => f.endsWith(".md"))
				.map(f => `docs/${f}`),
		];
		assert.ok(files.includes("docs/superpowers/plans/2026-11-14-phasenerkennung.md"), files.join());
		for (const file of files) {
			assert.doesNotMatch(read(file), /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/, file);
		}
	});
});
