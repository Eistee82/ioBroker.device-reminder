import assert from "node:assert";
import { enumLabel, membershipOf, planEnumUpdate } from "../build/lib/enums.js";

const members = {
	"enum.rooms.kitchen": ["a.0.x", "device-reminder.0.d"],
	"enum.rooms.bath": [],
	"enum.functions.energy": ["device-reminder.0.d"],
};

describe("enums", () => {
	it("finds the rooms and functions of a device", () => {
		assert.deepStrictEqual(membershipOf(members, "rooms", "device-reminder.0.d"), ["enum.rooms.kitchen"]);
		assert.deepStrictEqual(membershipOf(members, "functions", "device-reminder.0.d"), ["enum.functions.energy"]);
	});

	it("plans only the necessary changes and ignores unknown or foreign ids", () => {
		assert.deepStrictEqual(
			planEnumUpdate(members, "rooms", "device-reminder.0.d", [
				"enum.rooms.bath",
				"enum.rooms.gone",
				"enum.functions.energy",
			]),
			{ add: ["enum.rooms.bath"], remove: ["enum.rooms.kitchen"] },
		);
		assert.deepStrictEqual(planEnumUpdate(members, "functions", "device-reminder.0.d", ["enum.functions.energy"]), {
			add: [],
			remove: [],
		});
	});

	it("labels enums in the admin language", () => {
		assert.strictEqual(enumLabel("enum.rooms.k", { en: "Kitchen", de: "Küche" }, "de"), "Küche");
		assert.strictEqual(enumLabel("enum.rooms.k", { en: "Kitchen" }, "fr"), "Kitchen");
		assert.strictEqual(enumLabel("enum.rooms.k", undefined, "de"), "k");
		// a name that only exists in one language is still shown instead of the id
		assert.strictEqual(enumLabel("enum.rooms.k", { de: "Waschküche" }, "en"), "Waschküche");
	});
});
