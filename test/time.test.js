import assert from "node:assert";
import {
	coerceToType,
	formatDuration,
	formatTimestamp,
	isInWindow,
	nextWindowStart,
	parseHhmm,
	parseNumber,
} from "../build/lib/utils.js";

describe("time and value helpers", () => {
	describe("parseNumber", () => {
		it("returns finite numbers unchanged", () => {
			assert.strictEqual(parseNumber(7), 7);
		});
		it("parses numeric strings with comma decimal separator", () => {
			assert.strictEqual(parseNumber("12,5"), 12.5);
		});
		it("returns null for empty strings and non-numeric values", () => {
			assert.strictEqual(parseNumber(""), null);
			assert.strictEqual(parseNumber(true), null);
			assert.strictEqual(parseNumber(null), null);
			assert.strictEqual(parseNumber(NaN), null);
		});
	});

	describe("formatDuration", () => {
		it("formats zero as 00:00:00", () => {
			assert.strictEqual(formatDuration(0), "00:00:00");
		});
		it("keeps counting hours beyond 24", () => {
			assert.strictEqual(formatDuration(90061000), "25:01:01");
		});
	});

	describe("formatTimestamp", () => {
		it("formats local time as DD.MM.YYYY hh:mm:ss", () => {
			assert.strictEqual(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5)), "02.01.2026 03:04:05");
		});
	});

	describe("parseHhmm", () => {
		it("converts HH:MM to minutes since midnight", () => {
			assert.strictEqual(parseHhmm("07:30"), 450);
		});
		it("returns null for invalid input", () => {
			assert.strictEqual(parseHhmm(undefined), null);
			assert.strictEqual(parseHhmm("25:00"), null);
			assert.strictEqual(parseHhmm("abc"), null);
		});
	});

	describe("isInWindow", () => {
		it("handles a window that wraps midnight", () => {
			assert.strictEqual(isInWindow(new Date(2026, 0, 1, 22, 30), "22:00", "06:00"), true);
			assert.strictEqual(isInWindow(new Date(2026, 0, 1, 12, 0), "22:00", "06:00"), false);
		});
		it("handles a window within one day", () => {
			assert.strictEqual(isInWindow(new Date(2026, 0, 1, 12, 0), "08:00", "20:00"), true);
		});
		it("defaults missing bounds to the whole day", () => {
			assert.strictEqual(isInWindow(new Date(2026, 0, 1, 0, 0)), true);
			assert.strictEqual(isInWindow(new Date(2026, 0, 1, 23, 59)), true);
		});
	});

	describe("nextWindowStart", () => {
		it("returns now when already inside the window", () => {
			const now = new Date(2026, 0, 1, 10, 0);
			assert.strictEqual(nextWindowStart(now, "07:00", "20:00").getTime(), now.getTime());
		});
		it("returns tomorrow's start when after the window", () => {
			const next = nextWindowStart(new Date(2026, 0, 1, 23, 0), "07:00", "20:00");
			assert.strictEqual(next.getFullYear(), 2026);
			assert.strictEqual(next.getMonth(), 0);
			assert.strictEqual(next.getDate(), 2);
			assert.strictEqual(next.getHours(), 7);
			assert.strictEqual(next.getMinutes(), 0);
		});
	});

	describe("coerceToType", () => {
		it("converts booleans", () => {
			assert.strictEqual(coerceToType("true", "boolean"), true);
			assert.strictEqual(coerceToType("false", "boolean"), false);
		});
		it("converts numbers", () => {
			assert.strictEqual(coerceToType("1", "number"), 1);
		});
		it("keeps other values as strings", () => {
			assert.strictEqual(coerceToType("abc", "string"), "abc");
			assert.strictEqual(coerceToType("abc", undefined), "abc");
		});
	});
});
