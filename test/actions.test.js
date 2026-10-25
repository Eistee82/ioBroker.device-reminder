import assert from "node:assert";
import { runActions } from "../build/lib/actions.js";

/**
 * Fake host for actions.
 *
 * @param {Record<string, string>} types common types by state id
 */
function makeHost(types) {
	const host = {
		writes: [],
		warns: [],
		log: { debug() {}, info() {}, error() {}, warn: m => host.warns.push(m) },
		async getForeignObjectCommonType(id) {
			return types[id] ?? null;
		},
		async setForeignValue(id, val) {
			host.writes.push({ id, val });
		},
	};
	return host;
}

describe("runActions", () => {
	it("coerces the value to the common type of the target", async () => {
		const host = makeHost({ "lamp.on": "boolean" });
		await runActions(host, [{ event: "end", stateId: "lamp.on", value: "true" }], "end");
		assert.deepStrictEqual(host.writes, [{ id: "lamp.on", val: true }]);
	});

	it("does not run actions of other events (abort runs nothing)", async () => {
		const host = makeHost({ "lamp.on": "boolean" });
		await runActions(host, [{ event: "end", stateId: "lamp.on", value: "true" }], "start");
		assert.strictEqual(host.writes.length, 0);
	});

	it("warns on a missing object and continues with the next action", async () => {
		const host = makeHost({ "lamp.on": "boolean" });
		await runActions(
			host,
			[
				{ event: "end", stateId: "gone.state", value: "1" },
				{ event: "end", stateId: "lamp.on", value: "false" },
			],
			"end",
		);
		assert.strictEqual(host.warns.length, 1);
		assert.deepStrictEqual(host.writes, [{ id: "lamp.on", val: false }]);
	});
});
