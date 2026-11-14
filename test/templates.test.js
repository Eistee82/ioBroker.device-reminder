import assert from "node:assert";
import { FINAL_KEYS } from "../build/lib/detector/types.js";
import { typeHash } from "../build/lib/runStore.js";
import { archiveTemplates, findTemplate, templateDetection, TEMPLATES } from "../build/lib/templates.js";

describe("templates", () => {
	it("built-in templates carry the 3.1.2 values and no final phase", () => {
		assert.deepStrictEqual(
			TEMPLATES.map(t => [
				t.id,
				t.detection.startVal,
				t.detection.endVal,
				t.detection.standby,
				t.detection.startCount,
				t.detection.endCount,
				t.detection.mode,
			]),
			[
				["washing-machine", 30, 15, 1, 2, 50, "count"],
				["dryer", 120, 15, 1, 2, 20, "count"],
				["dishwasher", 15, 0.25, 0.5, 2, 120, "count"],
				["custom", 30, 5, 1, 1, 20, "count"],
			],
		);
		assert.ok(TEMPLATES.every(t => FINAL_KEYS.every(k => !t.detection[k])));
		assert.deepStrictEqual(
			TEMPLATES.slice(0, 3).map(t => typeHash(t.detection)),
			["39417b8a", "0af5b9bf", "8b9f87e6"],
		);
		assert.ok(TEMPLATES.every(t => t.detection.startDurationSec === 60 && t.detection.endDurationSec === 300));
		assert.ok(TEMPLATES.every(t => !t.detection.pauseHoldSec && !t.detection.trailerBurstSec));
	});

	it("divides power values for a kW state, counts and times stay", () => {
		const d = templateDetection("washing-machine", 1000);
		assert.deepStrictEqual(
			[d.startVal, d.endVal, d.standby, d.startCount, d.endCount, d.endDurationSec],
			[0.03, 0.015, 0.001, 2, 50, 300],
		);
		assert.strictEqual(templateDetection("nope", 1), null);
		assert.notStrictEqual(templateDetection("dryer", 1), TEMPLATES[1].detection, "a copy");
		assert.strictEqual(findTemplate(undefined), undefined);
	});

	it("archive lists changed values and renamed unused types only, in native order", () => {
		const row = (id, name, startVal) => ({
			id,
			name,
			startVal,
			endVal: 5,
			standby: 1,
			startCount: 1,
			endCount: 20,
		});
		const native = {
			types: [
				row("custom1", "Custom 1", 30),
				row("custom2", "Pumpe", 30),
				{ id: "dryer", name: "Dryer", startVal: 100, endVal: 15, standby: 1, startCount: 2, endCount: 20 },
				row("custom3", "custom3", 30),
			],
		};
		assert.deepStrictEqual(
			archiveTemplates(native).map(t => [t.id, t.name]),
			[
				["custom2", "Pumpe"],
				["dryer", "Dryer"],
			],
		);
		assert.strictEqual(archiveTemplates(native)[1].detection.startVal, 100);
		assert.deepStrictEqual(archiveTemplates({}), []);
		assert.deepStrictEqual(archiveTemplates({ types: [] }), []);
	});
});
