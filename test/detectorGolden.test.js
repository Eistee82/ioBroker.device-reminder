import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createDetector } from "../build/lib/detector/index.js";
import { goldenHashes } from "./helpers/golden.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/detectorGolden.json", import.meta.url), "utf8"));

/**
 * Keys whose output differs from the 3.1.2 fixture.
 *
 * @param {object} extra settings added to every type
 */
function differences(extra) {
	const now = goldenHashes(createDetector, extra);
	assert.deepStrictEqual(Object.keys(now).sort(), Object.keys(golden).sort());
	return Object.keys(golden).filter(k => golden[k] !== now[k]);
}

describe("detector behaviour of 3.1.2 (golden fixture of commit cd5e67f)", () => {
	it("is unchanged without the pause protection fields", () => {
		assert.deepStrictEqual(differences({}), []);
	});

	it("is unchanged with all pause protection fields 0", () => {
		assert.deepStrictEqual(differences({ pauseHoldSec: 0, pauseUntilSec: 0, pauseBelowVal: 0 }), []);
	});

	it("is unchanged with a hold time but no pause condition (inactive)", () => {
		assert.deepStrictEqual(differences({ pauseHoldSec: 600, pauseUntilSec: 0, pauseBelowVal: 0 }), []);
	});

	it("is unchanged with all anti-crease fields 0 (no filter is built)", () => {
		const zero = { trailerBurstSec: 0, trailerGapSec: 0, trailerAfterSec: 0, trailerBlockVal: 0, trailerMaxSec: 0 };
		assert.deepStrictEqual(differences(zero), []);
		assert.deepStrictEqual(differences({ ...zero, trailerGapSec: 60, trailerMaxSec: 3600 }), []);
	});

	it("notices an active anti-crease filter (the fixture is sensitive)", () => {
		assert.ok(differences({ trailerBurstSec: 60 }).length > 0);
	});

	it("notices an active pause protection (the fixture is sensitive)", () => {
		assert.ok(differences({ pauseHoldSec: 600, pauseUntilSec: 0, pauseBelowVal: 100 }).length > 0);
	});
});
