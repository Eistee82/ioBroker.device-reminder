import assert from "node:assert";
import { readFileSync } from "node:fs";
import { detectFromHost, detectPowerAndSwitch } from "../build/lib/typeDetection.js";

function loadObjects(name) {
	const url = new URL(`./fixtures/objects/${name}.json`, import.meta.url);
	return JSON.parse(readFileSync(url, "utf8"));
}

function hostFor(objects) {
	return async id =>
		Object.fromEntries(Object.entries(objects).filter(([key]) => key === id || key.startsWith(`${id}.`)));
}

describe("typeDetection", () => {
	describe("detectPowerAndSwitch", () => {
		it("finds switch and power of a Shelly-like socket", () => {
			const result = detectPowerAndSwitch(loadObjects("shellyPlug"), "shelly.0.SHPLG1");
			assert.deepStrictEqual(result, {
				type: "socket",
				powerId: "shelly.0.SHPLG1.Relay0.Power",
				switchId: "shelly.0.SHPLG1.Relay0.Switch",
			});
		});

		it("finds switch and power of an alias socket from the device manager", () => {
			const result = detectPowerAndSwitch(loadObjects("aliasSocket"), "alias.0.Waschmaschine");
			assert.deepStrictEqual(result, {
				type: "socket",
				powerId: "alias.0.Waschmaschine.POWER",
				switchId: "alias.0.Waschmaschine.SWITCH",
			});
		});

		it("detects a meter without switch as electricity", () => {
			const result = detectPowerAndSwitch(loadObjects("meterOnly"), "zigbee.0.plug1");
			assert.deepStrictEqual(result, {
				type: "electricity",
				powerId: "zigbee.0.plug1.power",
				switchId: null,
			});
		});

		it("returns nothing with hint notFound for wrong roles", () => {
			const result = detectPowerAndSwitch(loadObjects("badRoles"), "tuya.0.dev1");
			assert.deepStrictEqual(result, {
				type: null,
				powerId: null,
				switchId: null,
				hint: "notFound",
			});
		});

		it("uses the id itself when it is a value.power state", () => {
			const result = detectPowerAndSwitch(loadObjects("singleState"), "sensor.0.kitchen.power");
			assert.deepStrictEqual(result, {
				type: "electricity",
				powerId: "sensor.0.kitchen.power",
				switchId: null,
			});
		});

		it("falls back to a single value.power state with hint noPattern", () => {
			const result = detectPowerAndSwitch(loadObjects("powerNoPattern"), "custom.0.plug");
			assert.deepStrictEqual(result, {
				type: "electricity",
				powerId: "custom.0.plug.power",
				switchId: null,
				hint: "noPattern",
			});
		});
	});

	describe("detectFromHost", () => {
		it("returns the same result as the synchronous detection", async () => {
			const objects = loadObjects("shellyPlug");
			const result = await detectFromHost(hostFor(objects), "shelly.0.SHPLG1");
			assert.deepStrictEqual(result, detectPowerAndSwitch(objects, "shelly.0.SHPLG1"));
		});
	});
});
