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
	},
});
