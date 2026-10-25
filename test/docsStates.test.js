import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEVICE_STATES } from "../build/lib/stateDefinitions.js";

/** Instance-level states that are documented next to the device states. */
const INFO_STATES = ["info.connection", "info.legacyConfig"];
const BEGIN = "<!-- BEGIN STATES -->";
const END = "<!-- END STATES -->";

/**
 * Read the state IDs (backtick text in the first column) from the generated states block.
 *
 * @param {string} lang - Documentation language folder (en or de).
 */
function documentedStateIds(lang) {
	const file = fileURLToPath(new URL(`../docs/${lang}/README.md`, import.meta.url));
	const text = readFileSync(file, "utf8");
	const start = text.indexOf(BEGIN);
	const end = text.indexOf(END);
	assert.ok(start !== -1 && end > start, `${lang}: states markers missing`);
	const block = text.slice(start, end);
	return [...block.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
}

describe("docs states tables", () => {
	const expected = [...DEVICE_STATES.map(def => def.id), ...INFO_STATES];

	for (const lang of ["en", "de"]) {
		it(`${lang} lists exactly the DEVICE_STATES ids plus the info states`, () => {
			assert.deepStrictEqual(documentedStateIds(lang), expected);
		});
	}
});
