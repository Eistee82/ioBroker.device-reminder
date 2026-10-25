import assert from "node:assert";
import { readFileSync } from "node:fs";
import { DEFAULT_REMINDER, DEFAULT_TYPES, findType, normalizeInstanceConfig } from "../build/lib/config.js";
import {
	isLegacyConfig,
	LEGACY_LEAVES,
	LEGACY_STATE_MAP,
	migrateLegacyConfig,
	migrateLegacyStates,
} from "../build/lib/migration.js";

/**
 * Load a legacy fixture without its `_comment` (derivation notes, not part of a real native).
 *
 * @param {string} name - Fixture name
 */
function fixture(name) {
	const raw = JSON.parse(readFileSync(new URL(`./fixtures/legacy-config/${name}.json`, import.meta.url), "utf8"));
	delete raw._comment;
	return raw;
}

function device(result, id) {
	const d = result.devices.find(x => x.id === id);
	assert.ok(d, `device ${id} missing, got ${result.devices.map(x => x.id).join(", ")}`);
	return d;
}

function recipient(result, id) {
	const r = result.instance.recipients.find(x => x.id === id);
	assert.ok(r, `recipient ${id} missing`);
	return r;
}

/**
 * Fake object/state store of the own adapter namespace.
 *
 * @param {Record<string, unknown>} states - Old states (id relative to the namespace -> value)
 * @param {Set<string>} [foreign] - Existing foreign object ids
 */
function makeIo(states, foreign = new Set()) {
	const objects = new Map(Object.entries(states));
	const log = [];
	return {
		objects,
		log,
		async getOwnState(id) {
			log.push(["get", id]);
			return objects.has(id) ? objects.get(id) : null;
		},
		async setOwnState(id, val) {
			log.push(["set", id, val]);
			if (!objects.has(id)) {
				throw new Error(`object ${id} does not exist`);
			}
			objects.set(id, val);
		},
		async getObjectIds(prefix) {
			return [...objects.keys()].filter(id => id.startsWith(`${prefix}.`));
		},
		async delObject(id) {
			log.push(["del", id]);
			if (!objects.has(id)) {
				throw new Error(`object ${id} not found`);
			}
			objects.delete(id);
		},
		async ensureDevice(id, config) {
			log.push(["ensure", id, config.name]);
			for (const leaf of [
				"status",
				"lastRuntime",
				"lastOperations",
				"config.doNotDisturb",
				"config.runtimeMax",
			]) {
				if (!objects.has(`${id}.${leaf}`)) {
					objects.set(`${id}.${leaf}`, null);
				}
			}
		},
		async foreignObjectExists(id) {
			return foreign.has(id);
		},
	};
}

describe("migration", () => {
	describe("isLegacyConfig", () => {
		it("detects 3.1.2 natives", () => {
			for (const name of ["full", "minimal", "empty", "missingArrays", "renamedCustom", "duplicateNames"]) {
				assert.strictEqual(isLegacyConfig(fixture(name)), true, name);
			}
		});

		it("rejects V4 natives and unrelated objects", () => {
			assert.strictEqual(isLegacyConfig(normalizeInstanceConfig({}).config), false);
			assert.strictEqual(isLegacyConfig({}), false);
			assert.strictEqual(isLegacyConfig({ types: [], recipients: [] }), false);
			assert.strictEqual(isLegacyConfig({ ...fixture("full"), configVersion: 4 }), false);
		});

		it("is false after the migration (idempotent)", () => {
			const legacy = fixture("full");
			const { instance } = migrateLegacyConfig(legacy);
			assert.strictEqual(isLegacyConfig({ ...instance }), false);
			// extendForeignObject merges: old keys may survive next to the new ones
			assert.strictEqual(isLegacyConfig({ ...legacy, ...instance }), false);
		});
	});

	describe("migrateLegacyConfig: full", () => {
		const result = migrateLegacyConfig(fixture("full"));

		it("migrates all devices with stable ids", () => {
			assert.deepStrictEqual(
				result.devices.map(d => [d.id, d.oldName]),
				[
					["waschmaschine", "Waschmaschine"],
					["trockner", "Trockner"],
					["spuelmaschine", "Spülmaschine"],
				],
			);
		});

		it("converts a device exactly", () => {
			assert.deepStrictEqual(device(result, "waschmaschine").config, {
				enabled: true,
				name: "Waschmaschine",
				typeId: "washing-machine",
				powerId: "shelly.0.SHPLG-S#1A2B3C#1.Relay0.Power",
				switchId: "shelly.0.SHPLG-S#1A2B3C#1.Relay0.Switch",
				startText: "Waschmaschine gestartet",
				endText: "Waschmaschine ist fertig",
				abort: false,
				abortFixed: false,
				autoOff: true,
				autoOffMinutes: 30,
				recipients: ["alexa-0", "telegram-0", "telegram-1", "pushover-0"],
				reminder: { ...DEFAULT_REMINDER },
				actions: [],
			});
			assert.deepStrictEqual(device(result, "trockner").config, {
				enabled: true,
				name: "Trockner",
				typeId: "dryer",
				powerId: "sonoff.0.Trockner.ENERGY_Power",
				startText: "Trockner gestartet",
				endText: "Trockner ist fertig",
				abort: true,
				abortFixed: false,
				autoOff: false,
				autoOffMinutes: 0,
				recipients: [
					"sayit-0",
					"whatsapp-0",
					"telegram-2",
					"pushover-1",
					"pushover-2",
					"pushover-3",
					"signal-0",
					"email-0",
					"matrix-0",
					"discord-0",
				],
				reminder: { ...DEFAULT_REMINDER },
				actions: [],
			});
			const spuel = device(result, "spuelmaschine").config;
			assert.strictEqual(spuel.enabled, false);
			assert.strictEqual(spuel.typeId, "dishwasher");
			assert.strictEqual(spuel.switchId, "zigbee.0.a4c138d1e2f3a4b5.state");
			assert.deepStrictEqual(spuel.recipients, []);
		});

		it("migrates all recipients with ids <messenger>-<oldId>", () => {
			assert.deepStrictEqual(
				result.instance.recipients.map(r => r.id),
				[
					"alexa-0",
					"sayit-0",
					"whatsapp-0",
					"telegram-0",
					"telegram-1",
					"telegram-2",
					"pushover-0",
					"pushover-1",
					"pushover-2",
					"pushover-3",
					"signal-0",
					"email-0",
					"matrix-0",
					"discord-0",
				],
			);
			assert.ok(result.instance.recipients.every(r => r.enabled === true));
		});

		it("converts voice outputs and state messengers", () => {
			assert.deepStrictEqual(recipient(result, "alexa-0"), {
				id: "alexa-0",
				name: "Echo Küche",
				enabled: true,
				kind: "alexa",
				stateId: "alexa2.0.Echo-Devices.G0911A0B12345678.Commands.speak",
				volume: 40,
				activeFrom: "08:00",
				activeUntil: "22:00",
			});
			// empty volume -> 50 like 3.1.2 admin
			assert.strictEqual(recipient(result, "sayit-0").volume, 50);
			assert.strictEqual(recipient(result, "sayit-0").stateId, "sayit.0.tts.text");
			assert.deepStrictEqual(recipient(result, "whatsapp-0"), {
				id: "whatsapp-0",
				name: "WhatsApp Max",
				enabled: true,
				kind: "whatsapp",
				stateId: "whatsapp-cmb.0.sendMessage",
			});
		});

		it("converts telegram key/username to the telegram adapter fields", () => {
			assert.deepStrictEqual(recipient(result, "telegram-0"), {
				id: "telegram-0",
				name: "Max",
				enabled: true,
				kind: "telegram",
				instance: "telegram.0",
				telegramTarget: "user",
				target: "max_m",
			});
			const erika = recipient(result, "telegram-1");
			assert.strictEqual(erika.instance, "telegram.1");
			assert.strictEqual(erika.telegramTarget, "user");
			assert.strictEqual(erika.target, "Erika");
			const family = recipient(result, "telegram-2");
			assert.strictEqual(family.telegramTarget, "chatId");
			assert.strictEqual(family.target, "-1001234567890");
		});

		it("converts pushover prio/deviceID/ttl/sound", () => {
			assert.deepStrictEqual(recipient(result, "pushover-0"), {
				id: "pushover-0",
				name: "Handy",
				enabled: true,
				kind: "pushover",
				instance: "pushover.0",
				title: "Device-Reminder",
				device: "pixel7",
				priority: 1,
				sound: "bike",
			});
			assert.deepStrictEqual(recipient(result, "pushover-1"), {
				id: "pushover-1",
				name: "Tablet",
				enabled: true,
				kind: "pushover",
				instance: "pushover.2",
				priority: 2,
				sound: "pushover",
				ttl: 3600,
			});
			assert.strictEqual(recipient(result, "pushover-2").priority, -1);
			assert.strictEqual(recipient(result, "pushover-2").sound, "none");
			assert.strictEqual(recipient(result, "pushover-3").priority, 0);
			assert.ok(!("ttl" in recipient(result, "pushover-3")));
		});

		it("converts signal, email, matrix and discord", () => {
			assert.strictEqual(recipient(result, "signal-0").instance, "signal-cmb.0");
			assert.deepStrictEqual(recipient(result, "email-0"), {
				id: "email-0",
				name: "Mail Max",
				enabled: true,
				kind: "email",
				emailFrom: "iobroker@example.com",
				emailTo: "max@example.com",
			});
			assert.strictEqual(recipient(result, "matrix-0").instance, "matrix.0");
			assert.deepStrictEqual(recipient(result, "discord-0"), {
				id: "discord-0",
				name: "Discord Max",
				enabled: true,
				kind: "discord",
				instance: "discord.0",
				userId: "123456789012345678",
				userName: "max",
			});
		});

		it("takes over types with the 3.1.2 values and the status texts", () => {
			assert.strictEqual(result.instance.configVersion, 4);
			assert.deepStrictEqual(
				result.instance.types.map(t => t.id),
				DEFAULT_TYPES.map(t => t.id),
			);
			assert.deepStrictEqual(findType(result.instance, "washing-machine"), {
				id: "washing-machine",
				name: "Washing machine",
				builtin: true,
				startVal: 30,
				endVal: 15,
				standby: 1,
				startCount: 2,
				endCount: 50,
				mode: "count",
				startDurationSec: 60,
				endDurationSec: 300,
			});
			const dish = findType(result.instance, "dishwasher");
			assert.deepStrictEqual(
				[dish.startVal, dish.endVal, dish.standby, dish.startCount, dish.endCount],
				[15, 0.25, 0.5, 2, 120],
			);
			const c1 = findType(result.instance, "custom1");
			assert.deepStrictEqual(
				[c1.name, c1.builtin, c1.startVal, c1.endVal, c1.standby, c1.startCount, c1.endCount],
				["Custom 1", false, 30, 5, 1, 1, 20],
			);
			assert.deepStrictEqual(result.instance.statusTexts, {
				running: "läuft",
				standby: "Bereitschaft",
				off: "device off",
			});
			assert.strictEqual(result.instance.historyHtml, false);
			assert.strictEqual(result.instance.pollIntervalSec, 10);
		});

		it("warns about unknown fields only", () => {
			assert.deepStrictEqual(result.warnings, ['Device "Trockner": unknown field "gotify" not migrated']);
		});
	});

	describe("migrateLegacyConfig: variants", () => {
		it("minimal: one device without recipients", () => {
			const result = migrateLegacyConfig(fixture("minimal"));
			assert.strictEqual(result.devices.length, 1);
			const d = device(result, "waschmaschine").config;
			assert.strictEqual(d.powerId, "hm-rpc.0.MEQ0123456.2.POWER");
			assert.ok(!("switchId" in d));
			assert.strictEqual(d.autoOffMinutes, 0);
			assert.deepStrictEqual(d.recipients, []);
			assert.deepStrictEqual(result.instance.recipients, []);
			assert.deepStrictEqual(result.warnings, []);
		});

		it("missingArrays: no throw, recipients empty, dangling references warned", () => {
			let result;
			assert.doesNotThrow(() => {
				result = migrateLegacyConfig(fixture("missingArrays"));
			});
			assert.deepStrictEqual(result.instance.recipients, []);
			const d = device(result, "trockner").config;
			assert.deepStrictEqual(d.recipients, []);
			assert.strictEqual(d.typeId, "dryer");
			assert.strictEqual(d.switchId, "sonoff.0.Trockner.POWER");
			assert.strictEqual(d.autoOff, true);
			assert.strictEqual(d.autoOffMinutes, 15);
			assert.deepStrictEqual(result.instance.statusTexts, {
				running: "in action",
				standby: "standby",
				off: "switched off",
			});
			// custom table missing -> V4 custom types
			assert.strictEqual(result.instance.types.length, DEFAULT_TYPES.length);
			assert.deepStrictEqual(result.warnings, [
				'Device "Trockner": recipient telegram #0 does not exist, removed',
			]);
		});

		it("empty: default instance, 0 devices", () => {
			const result = migrateLegacyConfig(fixture("empty"));
			assert.deepStrictEqual(result.devices, []);
			assert.deepStrictEqual(result.instance.recipients, []);
			assert.deepStrictEqual(
				result.instance.types.map(t => t.id),
				DEFAULT_TYPES.map(t => t.id),
			);
			assert.deepStrictEqual(result.instance.statusTexts, {
				running: "in action",
				standby: "standby",
				off: "switched off",
			});
			assert.deepStrictEqual(result.warnings, []);
		});

		it("does not throw on garbage", () => {
			for (const native of [
				{},
				{ linkedDevice: null, status: "x", default: 5 },
				{ linkedDevice: { finalIds: { 0: null, 1: "x" } }, telegram: { ids: [null, 7, { name: "no id" }] } },
				{ status: { ids: [null] }, default: { ids: "nope" }, custom: { ids: [{ name: 3 }] } },
			]) {
				const result = migrateLegacyConfig(native);
				assert.strictEqual(result.instance.configVersion, 4);
			}
			const result = migrateLegacyConfig({
				linkedDevice: { finalIds: { 0: null } },
				telegram: { ids: [{ name: "no id" }] },
			});
			assert.deepStrictEqual(result.devices, []);
			assert.deepStrictEqual(result.instance.recipients, []);
			assert.strictEqual(result.warnings.length, 2);
		});

		it("warns about unknown top-level settings", () => {
			const result = migrateLegacyConfig({ ...fixture("minimal"), gotify: { ids: [] } });
			assert.deepStrictEqual(result.warnings, ['Unknown setting "gotify" not migrated']);
		});

		it("renamedCustom: custom ids kept, renamed names kept, lookup by name", () => {
			const result = migrateLegacyConfig(fixture("renamedCustom"));
			const c2 = findType(result.instance, "custom2");
			assert.deepStrictEqual(
				[c2.name, c2.startVal, c2.endVal, c2.standby, c2.startCount, c2.endCount],
				["Kaffeemaschine", 800, 20, 2, 1, 6],
			);
			assert.strictEqual(findType(result.instance, "custom10").name, "Pumpe");
			assert.strictEqual(findType(result.instance, "custom10").startVal, 100);
			assert.strictEqual(findType(result.instance, "custom5").name, "Custom 5");
			assert.strictEqual(findType(result.instance, "custom5").startVal, 1500);
			const dish = findType(result.instance, "dishwasher");
			assert.deepStrictEqual(
				[dish.name, dish.startVal, dish.endVal, dish.standby, dish.startCount, dish.endCount],
				["Dishwasher", 12.5, 1, 0.3, 3, 90],
			);
			assert.strictEqual(device(result, "kaffee").config.typeId, "custom2");
			assert.strictEqual(device(result, "heizluefter").config.typeId, "custom5");
			assert.strictEqual(device(result, "spueler").config.typeId, "dishwasher");
			assert.strictEqual(device(result, "pool").config.typeId, "");
			assert.deepStrictEqual(result.warnings, ['Device "Pool": device type "Poolpumpe" not found']);
		});

		it("duplicateNames: unique, valid ids (Review Focus 3)", () => {
			const result = migrateLegacyConfig(fixture("duplicateNames"));
			assert.deepStrictEqual(
				result.devices.map(d => [d.id, d.oldName]),
				[
					["waschmaschine", "Waschmaschine"],
					["waschmaschine_2", "Waschmaschine"],
					["wasch_maschine_keller", "Wasch.Maschine Keller"],
					["spuelmaschine", "Spülmaschine"],
				],
			);
			for (const d of result.devices) {
				assert.match(d.id, /^[a-z0-9_-]+$/);
			}
			assert.strictEqual(device(result, "waschmaschine_2").config.endText, "Wäsche unten fertig");
		});

		it("keeps the untrimmed 3.1.2 name as state prefix", () => {
			const legacy = fixture("minimal");
			legacy.linkedDevice.finalIds["0"].name = "Waschmaschine ";
			const [d] = migrateLegacyConfig(legacy).devices;
			assert.deepStrictEqual(
				[d.id, d.oldName, d.config.name],
				["waschmaschine", "Waschmaschine ", "Waschmaschine"],
			);
		});

		it("keeps a device without power state and warns (Review Focus 2)", () => {
			const legacy = fixture("minimal");
			legacy.linkedDevice.finalIds["0"].pathConsumption = "";
			const result = migrateLegacyConfig(legacy);
			assert.strictEqual(result.devices.length, 1);
			assert.strictEqual(result.devices[0].config.powerId, "");
			assert.deepStrictEqual(result.warnings, ['Device "Waschmaschine": no power state configured']);
		});
	});

	describe("migrateLegacyConfig: real 3.1.2 export", () => {
		const native = fixture("real312");
		const result = migrateLegacyConfig(native);

		it("is detected and migrated without warnings", () => {
			assert.strictEqual(isLegacyConfig(native), true);
			assert.deepStrictEqual(result.warnings, []);
		});

		it("takes over both devices from finalIds", () => {
			assert.deepStrictEqual(
				result.devices.map(d => [d.id, d.oldName]),
				[
					["waschmaschine", "Waschmaschine"],
					["trockner", "Trockner"],
				],
			);
			const w = device(result, "waschmaschine").config;
			assert.strictEqual(w.typeId, "washing-machine");
			assert.strictEqual(w.powerId, "zigbee2mqtt.0.0x0000000000000001.load_power");
			assert.strictEqual(w.switchId, "zigbee2mqtt.0.0x0000000000000001.state");
			assert.strictEqual(w.startText, "device started");
			assert.strictEqual(w.endText, "device finished");
			assert.strictEqual(w.abort, true);
			assert.strictEqual(w.autoOff, false);
			assert.strictEqual(w.autoOffMinutes, 0);
			assert.deepStrictEqual(w.recipients, []);
			assert.strictEqual(device(result, "trockner").config.typeId, "dryer");
		});

		it("takes over the discord recipients and the stored type values (strings to numbers)", () => {
			assert.deepStrictEqual(
				result.instance.recipients.map(r => [r.id, r.kind, r.instance, r.userName]),
				[
					["discord-1", "discord", "discord.0", "user_a"],
					["discord-2", "discord", "discord.0", "user_b"],
				],
			);
			const dryer = findType(result.instance, "dryer");
			assert.deepStrictEqual(
				[dryer.startVal, dryer.endVal, dryer.standby, dryer.startCount, dryer.endCount],
				[120, 15, 1, 2, 50],
			);
			const dish = findType(result.instance, "dishwasher");
			assert.deepStrictEqual([dish.startVal, dish.endVal], [15, 10]);
			assert.deepStrictEqual(result.instance.statusTexts, {
				running: "in action",
				standby: "standby",
				off: "switched off",
			});
		});
	});

	describe("LEGACY constants", () => {
		it("map the documented states", () => {
			assert.deepStrictEqual(LEGACY_STATE_MAP, {
				"last operations": "lastOperations",
				lastRuntime: "lastRuntime",
				"config.do not disturb": "config.doNotDisturb",
				"config.runtime max": "config.runtimeMax",
			});
			assert.deepStrictEqual(LEGACY_LEAVES, [
				"Status",
				"live consumption",
				"runtime",
				"runtime in ms",
				"lastRuntime",
				"messageDP",
				"average consumption",
				"alert runtime",
				"last operations",
				"config.do not disturb",
				"config.runtime max",
			]);
		});
	});

	describe("migrateLegacyStates", () => {
		const ops = JSON.stringify([{ start: "01.01.2025 10:00", end: "01.01.2025 11:30" }]);

		function oldStates(name, values = {}) {
			const s = {};
			for (const leaf of LEGACY_LEAVES) {
				s[`${name}.${leaf}`] = values[leaf] ?? null;
			}
			return s;
		}

		it("takes over values, deletes only legacy leaves, creates the new device", async () => {
			const { devices } = migrateLegacyConfig(fixture("full"));
			const io = makeIo(
				{
					...oldStates("Waschmaschine", {
						"last operations": ops,
						lastRuntime: "01:30:00",
						"config.do not disturb": "true",
						"config.runtime max": "90",
						Status: "in action",
					}),
					...oldStates("Trockner", { "config.runtime max": 45 }),
					"Waschmaschine.myScriptState": 7,
					"Waschmaschinen.Status": "foreign",
					"info.connection": true,
				},
				new Set(devices.map(d => d.config.powerId)),
			);
			const warnings = await migrateLegacyStates(io, devices);
			assert.deepStrictEqual(warnings, []);

			assert.strictEqual(io.objects.get("waschmaschine.lastOperations"), ops);
			assert.strictEqual(io.objects.get("waschmaschine.lastRuntime"), "01:30:00");
			assert.strictEqual(io.objects.get("waschmaschine.config.doNotDisturb"), true);
			assert.strictEqual(io.objects.get("waschmaschine.config.runtimeMax"), 90);
			assert.strictEqual(io.objects.get("trockner.config.runtimeMax"), 45);
			assert.strictEqual(io.objects.get("trockner.lastOperations"), null);

			const deleted = io.log.filter(e => e[0] === "del").map(e => e[1]);
			assert.deepStrictEqual(
				deleted.sort(),
				[...LEGACY_LEAVES.map(l => `Trockner.${l}`), ...LEGACY_LEAVES.map(l => `Waschmaschine.${l}`)].sort(),
			);
			assert.strictEqual(io.objects.get("Waschmaschine.myScriptState"), 7);
			assert.strictEqual(io.objects.get("Waschmaschinen.Status"), "foreign");
			assert.ok(io.objects.has("info.connection"));
			assert.deepStrictEqual(
				io.log.filter(e => e[0] === "ensure").map(e => e[1]),
				["waschmaschine", "trockner", "spuelmaschine"],
			);
		});

		it("reads and deletes before creating, writes after creating", async () => {
			const devices = [{ id: "trockner", oldName: "trockner", config: { name: "trockner", powerId: "p" } }];
			const io = makeIo(oldStates("trockner", { lastRuntime: "00:42:00" }), new Set(["p"]));
			await migrateLegacyStates(io, devices);
			const kinds = io.log.map(e => `${e[0]}:${e[1]}`);
			const lastDel = kinds.lastIndexOf("del:trockner.lastRuntime");
			const ensure = kinds.indexOf("ensure:trockner");
			const set = kinds.indexOf("set:trockner.lastRuntime");
			assert.ok(kinds.indexOf("get:trockner.lastRuntime") < lastDel);
			assert.ok(lastDel < ensure && ensure < set, kinds.join(" "));
			assert.strictEqual(io.objects.get("trockner.lastRuntime"), "00:42:00");
		});

		it("does nothing harmful without old states (second run)", async () => {
			const { devices } = migrateLegacyConfig(fixture("minimal"));
			const io = makeIo({}, new Set(["hm-rpc.0.MEQ0123456.2.POWER"]));
			const warnings = await migrateLegacyStates(io, devices);
			assert.deepStrictEqual(warnings, []);
			assert.strictEqual(io.log.filter(e => e[0] === "del" || e[0] === "set").length, 0);
			assert.strictEqual(io.objects.get("waschmaschine.config.runtimeMax"), null);
		});

		it("migrates a device whose power state does not exist and warns (Review Focus 2)", async () => {
			const { devices } = migrateLegacyConfig(fixture("minimal"));
			const io = makeIo(oldStates("Waschmaschine", { "config.runtime max": 120 }));
			const warnings = await migrateLegacyStates(io, devices);
			assert.deepStrictEqual(warnings, [
				'Device "Waschmaschine": power state "hm-rpc.0.MEQ0123456.2.POWER" does not exist',
			]);
			assert.strictEqual(io.objects.get("waschmaschine.config.runtimeMax"), 120);
		});

		it("continues with the next device when one fails", async () => {
			const { devices } = migrateLegacyConfig(fixture("duplicateNames"));
			const io = makeIo(
				{ ...oldStates("Waschmaschine", { lastRuntime: "00:10:00" }), ...oldStates("Spülmaschine") },
				new Set(devices.map(d => d.config.powerId)),
			);
			const ensure = io.ensureDevice;
			io.ensureDevice = async (id, cfg) => {
				if (id === "wasch_maschine_keller") {
					throw new Error("boom");
				}
				return ensure(id, cfg);
			};
			const warnings = await migrateLegacyStates(io, devices);
			assert.deepStrictEqual(warnings, ['Device "Wasch.Maschine Keller": state migration failed: boom']);
			assert.strictEqual(io.objects.get("waschmaschine.lastRuntime"), "00:10:00");
			// 3.1.2 states were shared by both "Waschmaschine" devices: both get the values
			assert.strictEqual(io.objects.get("waschmaschine_2.lastRuntime"), "00:10:00");
			assert.strictEqual(io.log.filter(e => e[0] === "del" && e[1] === "Waschmaschine.lastRuntime").length, 1);
			assert.ok(io.objects.has("spuelmaschine.lastRuntime"));
		});

		it("ignores values that do not fit the new state type", async () => {
			const devices = [{ id: "x", oldName: "X", config: { name: "X", powerId: "p" } }];
			const io = makeIo(
				oldStates("X", { "config.runtime max": "abc", "config.do not disturb": 1, lastRuntime: 5 }),
				new Set(["p"]),
			);
			await migrateLegacyStates(io, devices);
			assert.strictEqual(io.objects.get("x.config.runtimeMax"), null);
			assert.strictEqual(io.objects.get("x.config.doNotDisturb"), true);
			assert.strictEqual(io.objects.get("x.lastRuntime"), "5");
		});
	});
});
