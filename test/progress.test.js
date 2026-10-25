import assert from "node:assert";
import { estimateProgress } from "../src-widgets/build-test/progress.js";

const HOUR = 3600000;

describe("estimateProgress", () => {
	it("returns null values without history", () => {
		assert.deepStrictEqual(estimateProgress([], 1000), { percent: null, remainingMs: null });
	});

	it("estimates from the mean of previous runtimes", () => {
		const ops = [{ runtime: "01:00:00" }, { runtime: "01:00:00" }, { runtime: "01:00:00" }];
		assert.deepStrictEqual(estimateProgress(ops, HOUR / 2), { percent: 50, remainingMs: HOUR / 2 });
	});

	it("caps at 99 percent while running", () => {
		const ops = [{ runtime: "01:00:00" }, { runtime: "01:00:00" }, { runtime: "01:00:00" }];
		assert.deepStrictEqual(estimateProgress(ops, 2 * HOUR), { percent: 99, remainingMs: 0 });
	});
});
