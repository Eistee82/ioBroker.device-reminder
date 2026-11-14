import assert from "node:assert";
import { FINAL_KEYS } from "../build/lib/detector/types.js";
import { differences } from "./helpers/golden.js";

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

	it("is unchanged with all final phase fields 0 (no wrapper is built)", () => {
		assert.deepStrictEqual(differences(Object.fromEntries(FINAL_KEYS.map(k => [k, 0]))), []);
	});

	it("is unchanged with the final phase on but a final band no value reaches (wrapper built, I1)", () => {
		assert.deepStrictEqual(differences({ finalMinVal: 1e9, finalMinSec: 168 }), []);
	});

	for (const k of FINAL_KEYS) {
		// Spec 8.2 / G1: golden per field – each field alone (without the master switch) changes nothing
		it(`is unchanged with only ${k} set (master switch off)`, () => {
			const v = k === "finalActShare" ? 0.7 : 100;
			assert.deepStrictEqual(differences({ [k]: v }), []);
		});
	}
});
