import assert from "node:assert";
import { errorMessage } from "../build/lib/utils.js";

describe("utils", () => {
	describe("errorMessage", () => {
		it("returns the message of an Error", () => {
			assert.strictEqual(errorMessage(new Error("x")), "x");
		});
		it("stringifies other values", () => {
			assert.strictEqual(errorMessage(42), "42");
		});
	});
});
