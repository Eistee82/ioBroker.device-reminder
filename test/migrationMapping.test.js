import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createDetector } from "../build/lib/detector/index.js";
import { FINAL_KEYS } from "../build/lib/detector/types.js";
import { LEGACY_STATE_MAP, matchLegacyType, migrateLegacyConfig } from "../build/lib/migration.js";
import { archiveTemplates } from "../build/lib/templates.js";
import { goldenCurves } from "./helpers/golden.js";

const { createOracle } = createRequire(import.meta.url)("./fixtures/legacyOracle.cjs");
const load = name =>
	JSON.parse(readFileSync(new URL(`./fixtures/legacy-config/${name}.json`, import.meta.url), "utf8"));
const full = migrateLegacyConfig(load("full"));
const edge = migrateLegacyConfig(load("edgeTypes"));
const dev = (r, name) => r.devices.find(d => d.oldName === name).config;
const rec = (r, id) => r.instance.recipients.find(x => x.id === id);
const src = load("full");

describe("3.1.2 → V4 mapping (Spec C.5, one test per row)", () => {
	it("status texts → native.statusTexts", () => {
		const s = src.status.ids[0];
		assert.deepStrictEqual(full.instance.statusTexts, {
			running: s.stateAction,
			standby: s.stateStandby,
			off: s.stateOff,
		});
		const empty = migrateLegacyConfig({
			...src,
			status: { ids: [{ stateAction: "", stateStandby: "", stateOff: "" }] },
		});
		assert.deepStrictEqual(empty.instance.statusTexts, {
			running: "in action",
			standby: "standby",
			off: "switched off",
		});
	});
	it("fixed 10 s poll → pollIntervalSec 10; no HTML table", () => {
		assert.deepStrictEqual(
			[full.instance.pollIntervalSec, full.instance.historyHtml, full.instance.configVersion],
			[10, false, 5],
		);
	});
	it("alexa row → recipient with stateId, instance from the path, volume rule and window", () => {
		for (const row of src.alexa.ids) {
			const r = rec(full, `alexa-${row.id}`);
			const vol = Number(row.volume);
			assert.deepStrictEqual(
				[r.kind, r.stateId, r.instance, r.volume, r.activeFrom, r.activeUntil],
				[
					"alexa",
					row.path,
					row.path.split(".").slice(0, 2).join("."),
					vol >= 0 && vol <= 100 && row.volume !== "" ? vol : 50,
					row.activeFrom,
					row.activeUntil,
				],
			);
		}
	});
	it("sayit row → stateId <instance>.tts.text, warning when the path differs (M7)", () => {
		const r = rec(edge, "sayit-0");
		assert.deepStrictEqual(
			[r.instance, r.stateId, r.volume, r.activeFrom, r.activeUntil],
			["sayit.1", "sayit.1.tts.text", 40, "07:00", "22:00"],
		);
		assert.ok(
			edge.warnings.includes('Recipient sayit-0: target "sayit.1.tts.cachetts" replaced by "sayit.1.tts.text"'),
		);
		assert.ok(!full.warnings.some(w => w.startsWith("Recipient sayit-")), "an equal path gives no warning");
	});
	it("whatsapp row → whatsapp-cmb instance, warning when the path differs (M7)", () => {
		const r = rec(edge, "whatsapp-0");
		assert.deepStrictEqual([r.instance, r.stateId], ["whatsapp-cmb.0", "whatsapp-cmb.0.sendMessage"]);
		assert.ok(
			edge.warnings.includes(
				'Recipient whatsapp-0: target "javascript.0.wa" replaced by "whatsapp-cmb.0.sendMessage"',
			),
		);
		assert.ok(!full.warnings.some(w => w.startsWith("Recipient whatsapp-")), "an equal path gives no warning");
	});
	it("telegram row → telegram.N, target and target kind", () => {
		for (const row of src.telegram.ids) {
			const r = rec(full, `telegram-${row.id}`);
			assert.deepStrictEqual(
				[r.instance, r.target, r.telegramTarget],
				[
					`telegram.${String(row.inst).replace(".", "")}`,
					row.username,
					row.key === "chatID" ? "chatId" : "user",
				],
			);
		}
	});
	it("pushover row → instance, title, device, priority, sound, ttl", () => {
		const prio = { normal: 0, high: 1, quiet: -1, confirmation: 2 };
		for (const row of src.pushover.ids) {
			const r = rec(full, `pushover-${row.id}`);
			assert.deepStrictEqual(
				[r.instance, r.title, r.device, r.priority, r.sound],
				[
					`pushover.${String(row.inst).replace(".", "")}`,
					row.title.trim() || undefined,
					row.deviceID.trim() || undefined,
					prio[row.prio] ?? 0,
					row.sound.trim() || undefined,
				],
			);
			assert.strictEqual(r.ttl, row.ttl === "" || row.ttl === undefined ? undefined : Number(row.ttl));
		}
	});
	it("signal, email, matrix, discord rows → instance and fields", () => {
		for (const row of src.signal.ids) {
			assert.strictEqual(
				rec(full, `signal-${row.id}`).instance,
				`signal-cmb.${String(row.inst).replace(".", "")}`,
			);
		}
		for (const row of src.email.ids) {
			const r = rec(full, `email-${row.id}`);
			assert.deepStrictEqual([r.instance, r.emailFrom, r.emailTo], ["email.0", row.emailFrom, row.emailTo]);
		}
		for (const row of src.matrix.ids) {
			assert.strictEqual(
				rec(full, `matrix-${row.id}`).instance,
				`matrix-org.${String(row.inst).replace(".", "")}`,
			);
		}
		for (const row of src.discord.ids) {
			const r = rec(full, `discord-${row.id}`);
			for (const k of ["userId", "userTag", "userName", "serverId", "channelId"]) {
				assert.strictEqual(r[k], row[k] || undefined, k);
			}
		}
	});
	it("device fields → device native", () => {
		for (const [key, raw] of Object.entries(src.linkedDevice.finalIds)) {
			const c = full.devices.find(d => d.oldName === raw.name).config;
			assert.deepStrictEqual(
				[
					c.name,
					c.powerId,
					c.switchId,
					c.startText,
					c.endText,
					c.abort,
					c.abortFixed,
					c.autoOff,
					c.autoOffMinutes,
				],
				[
					raw.name.trim(),
					raw.pathConsumption,
					raw.pathSwitch || undefined,
					raw.startText,
					raw.endText,
					raw.abort === true || raw.abort === "true",
					false,
					raw.autoOff === true || raw.autoOff === "true",
					Math.floor(Number(raw.timer) || 0),
				],
				key,
			);
			const order = [
				"alexa",
				"sayit",
				"whatsapp",
				"telegram",
				"pushover",
				"signal",
				"email",
				"matrix",
				"discord",
			];
			assert.deepStrictEqual(
				c.recipients,
				order.flatMap(k => (raw[k] ?? []).map(id => `${k}-${id}`)),
				key,
			);
			assert.deepStrictEqual(
				[c.reminder.enabled, c.actions, c.autoOptimize, c.optimizeNotify, c.phases],
				[false, [], undefined, undefined, undefined],
			);
			assert.ok(!("typeId" in c), "no device type any more");
		}
	});
	it("exact type → detection copy of the row, template, enabled, no final phase", () => {
		const c = dev(edge, "Waschen");
		assert.deepStrictEqual(
			[
				c.detection.startVal,
				c.detection.endVal,
				c.detection.endCount,
				c.detection.mode,
				c.detection.startDurationSec,
				c.detection.endDurationSec,
				c.template,
				c.enabled,
				c.needsReview,
			],
			[25, 12, 40, "count", 60, 300, "washing-machine", true, undefined],
		);
		assert.ok(FINAL_KEYS.every(k => !c.detection[k]));
		assert.strictEqual(
			dev(edge, "Waschen2").detection.startVal,
			35,
			"a case variant is a different 3.1.2 row (M2)",
		);
	});
	it("case-only, renamed slot and unknown types → disabled with review hint (M1, M3)", () => {
		assert.deepStrictEqual(
			["Pumpe1", "Pumpe2", "Kessel"].map(n => {
				const c = dev(edge, n);
				return [c.enabled, c.needsReview, c.detection.startVal, c.template];
			}),
			[
				[false, true, 60, undefined],
				[false, true, 60, undefined],
				[false, true, 30, undefined],
			],
		);
		assert.match(dev(edge, "Pumpe1").reviewHint, /renamed slot custom3/);
		assert.match(dev(edge, "Pumpe2").reviewHint, /case match "Pumpe"/);
		assert.match(dev(edge, "Kessel").reviewHint, /template Custom/);
		assert.ok(edge.warnings.includes(`Device "Kessel": ${dev(edge, "Kessel").reviewHint}; device disabled`));
	});
	it("shared type → each device gets its own copy (M4)", () => {
		const a = dev(edge, "Trockner1").detection;
		const b = dev(edge, "Trockner2").detection;
		assert.deepStrictEqual(a, b);
		assert.notStrictEqual(a, b);
	});
	it("non-numeric value → template value with warning (M5); comment → warning (M6)", () => {
		assert.strictEqual(dev(edge, "Heizer").detection.startVal, 30);
		assert.ok(edge.warnings.includes('Type "custom5": startVal "" is not a number, using 30'));
		assert.ok(edge.warnings.includes('Type "Pumpe": comment "Keller" not migrated'));
	});
	it("archive holds only unused types whose values or name differ (P17)", () => {
		assert.deepStrictEqual(
			edge.archive.map(t => [t.id, t.name, t.startVal]),
			[["custom7", "custom7", 40]],
		);
		assert.ok(full.archive.every(t => !full.devices.some(d => d.config.template === t.id)));
		// native.types = archive: each row is offered as archive template with its name and values
		assert.deepStrictEqual(
			archiveTemplates({ types: edge.archive }).map(t => [t.id, t.name, t.detection.startVal]),
			[["custom7", "custom7", 40]],
		);
	});
	it("old states → new states", () => {
		assert.deepStrictEqual(LEGACY_STATE_MAP, {
			"last operations": "lastOperations",
			lastRuntime: "lastRuntime",
			"config.do not disturb": "config.doNotDisturb",
			"config.runtime max": "config.runtimeMax",
		});
	});
	it("golden: old detection via the type equals new detection in the device", () => {
		let compared = 0;
		for (const name of ["full", "real312", "renamedCustom"]) {
			const native = load(name);
			const result = migrateLegacyConfig(native);
			for (const raw of Object.values(native.linkedDevice.finalIds)) {
				const c = result.devices.find(d => d.oldName === raw.name).config;
				if (c.needsReview) {
					continue;
				}
				const rows = [...native.default.ids, ...native.custom.ids].filter(r => r.name === raw.type);
				const row = native.default.ids.filter(r => r.name === raw.type).at(-1) ?? rows.at(-1);
				const objVal = {
					startVal: +row.startVal,
					endVal: +row.endVal,
					standby: +row.standby,
					startCount: +row.startCount,
					endCount: +row.endCount,
				};
				// "12,5": 3.1.2 compared against NaN and never started; V4 reads 12.5 and warns (test in migration.test.js)
				if (Object.values(objVal).some(Number.isNaN)) {
					continue;
				}
				for (const [curve, values] of Object.entries(goldenCurves()).slice(0, 20)) {
					const oracle = createOracle(objVal, { abort: c.abort });
					const det = createDetector(c.detection, { abort: c.abort, abortFixed: false });
					values.forEach((p, i) => {
						assert.deepStrictEqual(
							det.tick(p, i * 10_000),
							oracle.tick(p),
							`${name}/${raw.name}/${curve}@${i}`,
						);
					});
				}
				compared++;
			}
		}
		assert.strictEqual(compared, 7);
	});
});

describe("matchLegacyType (3.1.2 main.js 456-503)", () => {
	const row = (name, startVal, id) => ({ name, startVal, id });
	const d1 = row("washing-machine", 25, 0);
	const d2 = row("washing-machine", 35, 1);
	const c1 = row("washing-machine", 45, 0);
	const c2 = row("Pumpe", 60, 2);
	const c3 = row("Pumpe", 70, 5);
	it("exact and untrimmed in default.ids, the last match wins", () => {
		assert.deepStrictEqual(matchLegacyType("washing-machine", [d1, d2], [c1]), { row: d2, via: "default" });
	});
	it("custom.ids only without a default match, the last match wins", () => {
		assert.deepStrictEqual(matchLegacyType("Pumpe", [d1], [c2, c3]), { row: c3, via: "custom" });
		assert.deepStrictEqual(matchLegacyType("washing-machine", [], [c1]), { row: c1, via: "custom" });
	});
	it("trimmed and case-insensitive only without an exact match, default first", () => {
		assert.deepStrictEqual(matchLegacyType(" Washing-Machine", [d1], [c1]), { row: d1, via: "case" });
		assert.deepStrictEqual(matchLegacyType("pumpe ", [d1], [c2, c3]), { row: c3, via: "case" });
	});
	it("customN → the custom row with id N-1 (renamed slot)", () => {
		assert.deepStrictEqual(matchLegacyType("custom3", [d1], [c2, c3]), { row: c2, via: "slot" });
		assert.deepStrictEqual(matchLegacyType("custom6", [d1], [c2, { ...c3, id: "5" }]).via, "slot");
	});
	it("nothing found → none", () => {
		assert.deepStrictEqual(matchLegacyType("Kessel", [d1], [c2]), { row: null, via: "none" });
		assert.deepStrictEqual(matchLegacyType("custom9", [d1], [c2]), { row: null, via: "none" });
		assert.deepStrictEqual(matchLegacyType("", [{ name: "" }], []), { row: null, via: "none" });
	});
});
