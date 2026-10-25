const fs = require("node:fs");
const path = require("path");
const assert = require("node:assert");
const { before, it } = require("mocha");
const { tests } = require("@iobroker/testing");

const POWER = "0_userdata.0.testPower";

/**
 * Wait until a condition is met or the timeout expires.
 *
 * @param {() => Promise<boolean>} cond condition
 * @param {number} timeoutMs timeout in ms
 */
async function waitFor(cond, timeoutMs) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await cond()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	return cond();
}

function stateVal(harness, id) {
	return new Promise((resolve, reject) => {
		harness.states.getState(id, (err, state) => (err ? reject(err) : resolve(state ? state.val : null)));
	});
}

function setForeign(harness, id, val) {
	return new Promise((resolve, reject) => {
		harness.states.setState(id, { val, ack: true }, err => (err ? reject(err) : resolve()));
	});
}

function getObj(harness, id) {
	return new Promise((resolve, reject) => {
		harness.objects.getObject(id, (err, obj) => (err ? reject(err) : resolve(obj ?? null)));
	});
}

function setObj(harness, id, obj) {
	return new Promise((resolve, reject) => {
		harness.objects.setObject(id, obj, err => (err ? reject(err) : resolve()));
	});
}

tests.integration(path.join(__dirname, ".."), {
	defineAdditionalTests({ suite }) {
		suite("Device detection", getHarness => {
			let harness;
			before(async function () {
				this.timeout(60_000);
				harness = getHarness();
				await harness.changeAdapterConfig("device-reminder", {
					native: {
						pollIntervalSec: 1,
						types: [
							{
								id: "itest",
								name: "Integration",
								startVal: 30,
								endVal: 5,
								startCount: 1,
								endCount: 1,
								standby: 1,
								mode: "count",
							},
						],
					},
				});
				await setObj(harness, POWER, {
					type: "state",
					common: { name: "Test power", type: "number", role: "value.power", read: true, write: true },
					native: {},
				});
				await setForeign(harness, POWER, 0);
				await setObj(harness, "device-reminder.0.washer", {
					type: "device",
					common: { name: "Washer" },
					native: { name: "Washer", typeId: "itest", powerId: POWER, startText: "", endText: "" },
				});
				await harness.startAdapterAndWait();
			});

			it("detects start and end of a run", async function () {
				this.timeout(60_000);
				for (let i = 0; i < 3; i++) {
					await setForeign(harness, POWER, 200);
					await new Promise(resolve => setTimeout(resolve, 1100));
				}
				const running = await waitFor(
					async () => (await stateVal(harness, "device-reminder.0.washer.running")) === true,
					10_000,
				);
				assert.strictEqual(running, true, "running should be true");

				await setForeign(harness, POWER, 0);
				const finished = await waitFor(
					async () => (await stateVal(harness, "device-reminder.0.washer.finished")) === true,
					15_000,
				);
				assert.strictEqual(finished, true, "finished should be true");
				assert.strictEqual(await stateVal(harness, "device-reminder.0.washer.running"), false);
			});
		});

		suite("Migration from 3.1.2", getHarness => {
			const NS = "device-reminder.0";
			const OPS = JSON.stringify([{ start: "01.01.2026 10:00", end: "01.01.2026 11:30" }]);
			const legacy = JSON.parse(
				fs.readFileSync(path.join(__dirname, "fixtures", "legacy-config", "full.json"), "utf8"),
			);
			delete legacy._comment;
			let harness;

			before(async function () {
				this.timeout(60_000);
				harness = getHarness();
				// Like an upgrade: the 3.1.2 native plus the V4 defaults from io-package.json.
				// Not via changeAdapterConfig, its deep merge turns the 3.1.2 arrays into objects.
				const inst = await getObj(harness, `system.adapter.${NS}`);
				inst.native = { ...inst.native, ...legacy };
				await setObj(harness, `system.adapter.${NS}`, inst);
				const oldStates = [
					["last operations", "string", OPS],
					["config.runtime max", "number", 90],
					["Status", "string", "Aus"],
				];
				for (const [leaf, type, val] of oldStates) {
					const id = `${NS}.Waschmaschine.${leaf}`;
					await setObj(harness, id, {
						type: "state",
						common: { name: leaf, type, role: "state", read: true, write: true },
						native: {},
					});
					await setForeign(harness, id, val);
				}
				await harness.startAdapterAndWait();
			});

			it("converts the configuration and moves the states", async function () {
				this.timeout(60_000);
				const migrated = await waitFor(async () => {
					const obj = await getObj(harness, `system.adapter.${NS}`);
					return obj?.native?.configVersion === 4 && obj.native.linkedDevice === undefined;
				}, 20_000);
				assert.strictEqual(migrated, true, "instance native should be the V4 configuration");

				const inst = await getObj(harness, `system.adapter.${NS}`);
				for (const key of ["linkedDevice", "devices", "default", "custom", "status", "telegram"]) {
					assert.strictEqual(inst.native[key], undefined, `legacy key ${key} should be removed`);
				}
				assert.ok(Array.isArray(inst.native.recipients) && inst.native.recipients.length > 0);
				assert.ok(Array.isArray(inst.native.types) && inst.native.types.length > 0);

				const device = await getObj(harness, `${NS}.waschmaschine`);
				assert.ok(device, "device object waschmaschine should exist");
				assert.strictEqual(device.type, "device");
				assert.strictEqual(device.native.name, "Waschmaschine");
				assert.strictEqual(device.native.powerId, "shelly.0.SHPLG-S#1A2B3C#1.Relay0.Power");
				assert.ok(await getObj(harness, `${NS}.trockner`), "device object trockner should exist");

				assert.strictEqual(await stateVal(harness, `${NS}.waschmaschine.lastOperations`), OPS);
				assert.strictEqual(await stateVal(harness, `${NS}.waschmaschine.config.runtimeMax`), 90);
				assert.strictEqual(await getObj(harness, `${NS}.Waschmaschine.last operations`), null);
				assert.strictEqual(await getObj(harness, `${NS}.Waschmaschine.Status`), null);

				const saved = await stateVal(harness, `${NS}.info.legacyConfig`);
				assert.ok(typeof saved === "string" && saved !== "", "info.legacyConfig should be filled");
				assert.deepStrictEqual(JSON.parse(saved).linkedDevice, legacy.linkedDevice);
			});
		});
	},
});
