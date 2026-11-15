import * as I18n from "@iobroker/adapter-core/i18n";
import type { JsonFormData, JsonFormSchema } from "@iobroker/dm-utils";
import { LOCK_DEFAULT_SEC } from "./detector/finalPhase.js";
import { formatDate } from "./deviceRegistry.js";
import { fill, TEXT } from "./dmTexts.js";
import type { HistoryClean, HistoryMeta } from "./historySource.js";
import type { BaseBands } from "./learn/bands.js";
import { baseBandsOf } from "./learn/bands.js";
import type { FinalCandidate, FinalRejectReason } from "./learn/finalLearn.js";
import type { QualityContext, RunSample, Verdict } from "./learn/quality.js";
import { admitted, checkRuns, samplesOf } from "./learn/quality.js";
import type { Layout } from "./learn/runs.js";
import { buildLayout } from "./learn/runs.js";
import type { TickSeries } from "./learn/ticks.js";
import type { PhaseDef, PhaseModel } from "./phases/model.js";
import { systemPhaseNames } from "./phases/model.js";
import { phaseHolds, replayPhases } from "./phases/tracker.js";

type PanelItems = Extract<JsonFormSchema, { type: "panel" }>["items"];

/** What a run counts for in the dialog: the check decides (`auto`), the user decided (`include`, `exclude`). */
export type RunUse = "auto" | "include" | "exclude";

/** One row of the run table of the learning dialog (Spec B.7). */
export interface RunRow {
	/** Key of the run (`verdictKey`). */
	key: string;
	/** Start (local time). */
	date: string;
	/** Duration of the programme in minutes. */
	durationMin: number;
	/** Energy of the run in Wh. */
	energyWh: number;
	/** Programme group (1-based, 0 = none). */
	family: number;
	/** Sequence of the phases of the run, once phases are learned. */
	phases: string;
	/** Run check: a tick, or the findings. */
	check: string;
	/** Safety limits the run sets on its own (only runs stored by the optimisation know them). */
	boundary: string;
	/** Use of the run. */
	use: RunUse;
}

/**
 * Form of the run table. `table` is the editable jsonConfig table with a select column; `fallback` lists the runs as
 * one select per run (Auto / use / do not use) whose label names the run (works in every Admin).
 *
 * Both variants are built and tested. The fallback stays the default until the editable table was tried in the
 * Device Manager of a real system (a select column in a form table is not documented for `showForm` of dm-utils).
 * That check (plan, Task 24 step 1) needs the user's test system and has not been done yet, so there is no result
 * to note here.
 */
export const RUN_TABLE_MODE: "table" | "fallback" = "fallback";

/** From this many runs the run check holds runs back from the suggestion on its own (as the automatic analysis). */
export const AUTO_HOLD_MIN_RUNS = 8;
/** Fewest clean runs for base bands. */
const BANDS_MIN_RUNS = 3;

/** Most phases of a run named in the run table (the rest is cut off). */
const SEQUENCE_MAX = 6;

const USES: readonly RunUse[] = ["auto", "include", "exclude"];

function tr(key: string): string {
	return I18n.translate(key);
}

/**
 * The run table (or its fallback) as items of a panel.
 *
 * @param rows - Rows
 * @param mode - `table` or `fallback`
 */
export function buildRunTable(rows: readonly RunRow[], mode: "table" | "fallback"): PanelItems {
	if (mode === "table") {
		return {
			runs: {
				type: "table",
				label: I18n.getTranslatedObject("dm_learnRunsTable"),
				noDelete: true,
				xs: 12,
				items: [
					{ type: "text", attr: "date", title: tr("dm_optRunDate"), width: "16%", disabled: true },
					{ type: "text", attr: "durationMin", title: tr("dm_optRunDuration"), width: "8%", disabled: true },
					{ type: "text", attr: "energyWh", title: tr("dm_learnColEnergy"), width: "8%", disabled: true },
					{ type: "text", attr: "family", title: tr("dm_optRunFamily"), width: "6%", disabled: true },
					{ type: "text", attr: "phases", title: tr("dm_learnColPhases"), width: "20%", disabled: true },
					{ type: "text", attr: "check", title: tr("dm_learnColCheck"), width: "20%", disabled: true },
					{ type: "text", attr: "boundary", title: tr("dm_learnColBoundary"), width: "8%", disabled: true },
					{
						type: "select",
						attr: "use",
						title: tr("dm_learnColUse"),
						width: "14%",
						options: USES.map(u => ({ label: I18n.getTranslatedObject(`dm_learnUse_${u}`), value: u })),
						default: "auto",
					},
				],
			},
		};
	}
	// one select per run: the label names the run, the select its use (the multiple selects of an earlier version
	// put every run into one text block that the Admin shows as a single line)
	const items: PanelItems = {};
	rows.forEach((r, k) => {
		items[`use_${k}`] = {
			type: "select",
			label: runLabel(r, k),
			options: USES.map(u => ({ label: I18n.getTranslatedObject(`dm_learnUse_${u}`), value: u })),
			newLine: true,
			xs: 12,
			sm: 8,
			md: 6,
		};
	});
	return items;
}

/**
 * Label of one run in the fallback: number, start, duration, energy, check and boundary (no phase sequence: the
 * generic levels of an unconfirmed phase model mean nothing to the user).
 *
 * @param r - Row
 * @param k - Position
 */
export function runLabel(r: RunRow, k: number): string {
	return `${k + 1}. ${r.date} · ${r.durationMin} min · ${r.energyWh} Wh · ${r.check}${r.boundary ? ` · ${r.boundary}` : ""}`;
}

/**
 * Data of the run table form: the rows and, for the fallback, the runs chosen per use.
 *
 * @param rows - Rows
 */
export function runTableData(rows: readonly RunRow[]): JsonFormData {
	return {
		runs: rows.map(r => ({ ...r })),
		...Object.fromEntries(rows.map((r, k) => [`use_${k}`, r.use])),
		recalc: false,
	};
}

/**
 * Schema of the first step of the learning dialog: the runs with their check and use.
 *
 * @param rows - Rows
 * @param formerlyDropped - Whether runs carry `formerlyDropped` (hint)
 * @param mode - Variant of the run table
 */
export function buildRunsSchema(
	rows: readonly RunRow[],
	formerlyDropped: boolean,
	mode: "table" | "fallback" = RUN_TABLE_MODE,
): JsonFormSchema {
	const items: PanelItems = {
		info: { type: "infoBox", boxType: "info", text: I18n.getTranslatedObject("dm_learnRunsInfo"), xs: 12 },
	};
	if (formerlyDropped) {
		items.dropped = {
			type: "infoBox",
			boxType: "warning",
			text: I18n.getTranslatedObject("dm_learnFormerlyDropped"),
			newLine: true,
			xs: 12,
		};
	}
	Object.assign(items, buildRunTable(rows, mode));
	items.recalc = {
		type: "checkbox",
		label: I18n.getTranslatedObject("dm_learnRecalc"),
		help: I18n.getTranslatedObject("dm_learnRecalcHelp"),
		newLine: true,
		xs: 12,
	};
	return { type: "panel", items };
}

/**
 * Use of every run from the answer of the runs form: the table (`runs`, by key or, without a key, by position) and
 * the select per run of the fallback (`use_<position>`), which decides when present.
 *
 * @param answer - Answer
 * @param rows - Rows shown
 */
export function usesOfAnswer(answer: JsonFormData, rows: readonly RunRow[]): Map<string, RunUse> {
	const out = new Map<string, RunUse>(rows.map(r => [r.key, r.use]));
	const valid = (v: unknown): v is RunUse => USES.includes(v as RunUse);
	const table = Array.isArray(answer.runs) ? (answer.runs as Record<string, unknown>[]) : [];
	table.forEach((row, k) => {
		const key = typeof row?.key === "string" ? row.key : rows[k]?.key;
		if (key !== undefined && out.has(key) && valid(row?.use)) {
			out.set(key, row.use);
		}
	});
	rows.forEach((r, k) => {
		const v = answer[`use_${k}`];
		if (valid(v)) {
			out.set(r.key, v);
		}
	});
	return out;
}

/** Everything the run check needs about the history of the dialog. */
export interface LearnInput {
	/** Device id (keys). */
	deviceId: string;
	/** Series in W. */
	series: TickSeries;
	/** Stored values rebuilt from the series (unit of the state). */
	points: { ts: number; val: number }[];
	/** Layout of all runs. */
	layout: Layout;
	/** Samples: every run, short activity and dropped segment, sorted by time. */
	samples: RunSample[];
	/** W per unit of the state. */
	factor: number;
	/** Poll interval in ms. */
	pollMs: number;
	/** History settings (`historyCfg`). */
	settings: HistoryMeta["settings"] | null;
}

/**
 * Stored values of a series on the poll grid (a value per tick with a stored value, and the value held when a gap
 * ends), in the unit of the state. The history is loaded as a series; the values between two polls are not needed.
 *
 * @param s - Series in W
 * @param factor - W per unit of the state
 */
export function pointsOfSeries(s: TickSeries, factor: number): { ts: number; val: number }[] {
	const out: { ts: number; val: number }[] = [];
	let prevValid = false;
	for (let i = 0; i < s.length; i++) {
		const ok = s.valid[i] === 1 && Number.isFinite(s.last[i]);
		if (ok && (s.has[i] === 1 || !prevValid)) {
			out.push({ ts: s.t0 + i * s.stepMs, val: s.last[i] / factor });
		}
		prevValid = ok;
	}
	return out;
}

/**
 * Samples of the history of a device (Spec B.2).
 *
 * @param deviceId - Device id
 * @param series - Series in W
 * @param clean - Cleaning results of the loading
 * @param factor - W per unit of the state
 * @param settings - History settings
 */
export function learnInputOf(
	deviceId: string,
	series: TickSeries,
	clean: HistoryClean,
	factor: number,
	settings: HistoryMeta["settings"] | null,
): LearnInput {
	const points = pointsOfSeries(series, factor);
	const layout = buildLayout(series, { maxRuns: Number.POSITIVE_INFINITY });
	const samples = samplesOf(deviceId, points, series, layout, {
		src: "history",
		unitFactor: factor,
		timeJumps: clean.timeJumps.map(j => j.at),
	});
	return { deviceId, series, points, layout, samples, factor, pollMs: series.stepMs, settings };
}

/** Run check of the dialog for a chosen set of runs. */
export interface Evaluation {
	/** Verdicts in the order of `LearnInput.samples`. */
	verdicts: Verdict[];
	/** Base bands of the runs admitted for phases (at least 3), or null. */
	bands: BaseBands | null;
}

/**
 * Run check over the chosen runs: runs set to `exclude` take no part (they are no comparison data either), runs set
 * to `include` count although the check holds them back (not over `unusable`). The decisions are set as `user`.
 *
 * @param input - Samples
 * @param uses - Use per key
 * @param oldStore - Range and keys of an old store of this device (`formerlyDropped`)
 */
export function evaluateRuns(
	input: LearnInput,
	uses: ReadonlyMap<string, RunUse>,
	oldStore?: QualityContext["oldStore"],
): Evaluation {
	const runLimit = input.layout.runLimit / input.factor;
	const ctx: Omit<QualityContext, "bands"> = {
		unitFactor: input.factor,
		unit: input.factor === 1000 ? "kW" : "W",
		settings: input.settings,
		pollMs: input.pollMs,
		outages: [],
		scope: "run",
		...(oldStore ? { oldStore } : {}),
	};
	const decide = (list: readonly RunSample[], vs: Verdict[]): Verdict[] =>
		vs.map((v, k) => {
			const u = uses.get(list[k].key);
			return u === "include" || u === "exclude" ? { ...v, user: u } : v;
		});
	const pass = (list: readonly RunSample[]): Evaluation => {
		const first = decide(list, checkRuns(list, { ...ctx, bands: null }));
		const clean = list.filter((x, k) => x.kind === "run" && admitted(first[k], "phases"));
		if (clean.length < BANDS_MIN_RUNS) {
			return { verdicts: first, bands: null };
		}
		const bands = baseBandsOf(clean, runLimit);
		return { verdicts: decide(list, checkRuns(list, { ...ctx, bands })), bands };
	};
	const chosen = input.samples.filter(x => uses.get(x.key) !== "exclude");
	const own = pass(chosen);
	const byKey = new Map(chosen.map((x, k) => [x.key, own.verdicts[k]]));
	// a run that is left out keeps the verdict it gets among all runs
	const all = chosen.length === input.samples.length ? own : pass(input.samples);
	const verdicts = input.samples.map((x, k) => byKey.get(x.key) ?? all.verdicts[k]);
	return { verdicts, bands: own.bands };
}

/**
 * Whether a sample counts for the suggestion. With fewer than AUTO_HOLD_MIN_RUNS runs the check holds nothing back
 * on its own (as the automatic analysis); the decisions of the user always apply.
 *
 * @param x - Sample
 * @param v - Verdict
 * @param runs - Number of runs
 */
export function counts(x: RunSample, v: Verdict, runs: number): boolean {
	if (v.user === "exclude" || x.kind === "incomplete") {
		return false;
	}
	if (v.user === "include") {
		return v.stage !== "unusable";
	}
	if (runs < AUTO_HOLD_MIN_RUNS) {
		return true;
	}
	if (x.kind === "spike") {
		return admitted(v, "start");
	}
	return admitted(v, "end") && !v.reasons.some(r => r.code === "merged");
}

/**
 * Stretches of stored values that do not count for the suggestion (taken out of the values before the analysis).
 *
 * @param input - Samples
 * @param ev - Run check
 */
export function heldBackSpans(input: LearnInput, ev: Evaluation): { from: number; to: number }[] {
	const runs = input.samples.filter(x => x.kind === "run").length;
	return input.samples
		.map((x, k) => ({ x, v: ev.verdicts[k] }))
		.filter(({ x, v }) => !counts(x, v, runs))
		.map(({ x }) => ({
			from: x.facts.start - input.pollMs,
			to: Math.max(x.facts.end, x.facts.runEnd) + input.pollMs,
		}))
		.sort((a, b) => a.from - b.from);
}

/**
 * Summary of the runs behind a suggestion: how many of the runs found count and which ones the check left out, with
 * the reason (the user does not have to choose anything, Spec B.7).
 *
 * @param input - Samples
 * @param ev - Run check
 * @param lang - Language
 */
export function runSummary(input: LearnInput, ev: Evaluation, lang: string): string {
	const runs = input.samples.filter(x => x.kind === "run").length;
	let used = 0;
	const left: string[] = [];
	input.samples.forEach((x, k) => {
		if (x.kind !== "run") {
			return;
		}
		if (counts(x, ev.verdicts[k], runs)) {
			used++;
		} else {
			left.push(`${formatDate(x.facts.start)} (${checkText(ev.verdicts[k])})`);
		}
	});
	const head = fill(TEXT.learnRunsUsed, lang, { used, total: runs });
	return left.length === 0 ? head : `${head} ${fill(TEXT.learnRunsHeldBack, lang, { list: left.join(", ") })}`;
}

/**
 * Text of the findings of a run.
 *
 * @param v - Verdict
 */
export function checkText(v: Verdict): string {
	if (v.reasons.length === 0) {
		return "✓";
	}
	const texts = v.reasons.map(r => {
		const key = `dm_check_${r.code}`;
		const t = tr(key);
		return t === key ? r.code : t;
	});
	return [...new Set(texts)].join(", ");
}

/** Names of the system phases in the language of the system (English when the texts are not loaded). */
export function phaseNames(): Record<string, string> {
	return systemPhaseNames(key => {
		try {
			return I18n.translate(key);
		} catch {
			return key;
		}
	});
}

/**
 * Neutral name of a learned phase from the translated template ("Phase 3").
 *
 * @param n - Number of the phase in the order of the run
 */
export function neutralName(n: number): string {
	let template: string;
	try {
		template = I18n.translate("phase_neutral");
	} catch {
		template = "Phase {n}";
	}
	if (!template.includes("{n}")) {
		template = "Phase {n}";
	}
	return template.replace("{n}", String(n));
}

/**
 * Sequence of the phases of every run of the model (names, equal neighbours once).
 *
 * @param model - Phase model
 * @param bands - Base bands (hold time profile)
 * @param input - Samples
 * @param pollSec - Poll interval in s
 */
export function phaseSequences(
	model: PhaseModel,
	bands: BaseBands | null,
	input: LearnInput,
	pollSec: number,
): Map<string, string> {
	const out = new Map<string, string>();
	const names = phaseNames();
	const holds = phaseHolds(model, bands);
	for (const x of input.samples) {
		if (x.kind !== "run") {
			continue;
		}
		const { timeline } = replayPhases(model, x.points, pollSec, [{ start: x.facts.start, end: x.facts.end }], {
			holds,
			names,
		});
		const seq: string[] = [];
		for (const seg of timeline) {
			if (seg.to < x.facts.start || seg.from > x.facts.end || seg.id === "rest") {
				continue;
			}
			if (seq.at(-1) !== seg.name) {
				seq.push(seg.name);
			}
		}
		out.set(x.key, (seq.length > SEQUENCE_MAX ? [...seq.slice(0, SEQUENCE_MAX), "…"] : seq).join(" → "));
	}
	return out;
}

/**
 * Rows of the run table.
 *
 * @param input - Samples
 * @param ev - Run check
 * @param uses - Use per key
 * @param phases - Sequence of the phases per key
 */
export function rowsOf(
	input: LearnInput,
	ev: Evaluation,
	uses: ReadonlyMap<string, RunUse>,
	phases: ReadonlyMap<string, string>,
): RunRow[] {
	return input.samples.map((x, k) => {
		const b = ev.verdicts[k].boundary?.[0];
		return {
			key: x.key,
			date: formatDate(x.facts.start),
			durationMin: Math.round(x.facts.coreSec / 60),
			energyWh: Math.round(x.facts.feat?.energyWh ?? 0),
			family: x.family >= 0 ? x.family + 1 : 0,
			phases: phases.get(x.key) ?? "",
			check: checkText(ev.verdicts[k]),
			boundary: b ? `${b.quantity} ${b.value} (${b.without})` : "",
			use: uses.get(x.key) ?? "auto",
		};
	});
}

function reasonText(r: FinalRejectReason, lang: string): string {
	const obj = I18n.getTranslatedObject(`dm_finalReject_${r}`) as Record<string, string>;
	return obj[lang] ?? obj.en ?? r;
}

/**
 * Key figures of the proposed final phase (Spec B.7 step 2.4), followed by the reasons when it cannot be offered.
 * Without any replayed run only the reasons are shown.
 *
 * @param c - Result of `learnFinal`
 */
export function finalText(c: FinalCandidate): ioBroker.Translated {
	const base = TEXT.finalSummary;
	const out: Record<string, string> = {};
	for (const lang of Object.keys(base)) {
		const figures = fill(base, lang, {
			m: Math.round(c.gainMedianSec / 60),
			n: c.covered,
			k: c.endRuns,
			e: c.earlyEnds,
			f: c.fallbacks,
		});
		const reasons = c.reasons.map(r => reasonText(r, lang)).join(", ");
		if (c.ok) {
			// exit f off (the data do not separate it): a programme started right after clearing out waits longer
			// (Spec risk 3)
			out[lang] =
				c.values.finalActVal > 0 && c.values.finalActShare > 0
					? `${figures}.`
					: `${figures}. ${fill(TEXT.finalNoActivity, lang, { lock: Math.round((c.values.finalLockSec > 0 ? c.values.finalLockSec : LOCK_DEFAULT_SEC) / 60) })}`;
		} else {
			out[lang] = c.endRuns === 0 ? reasons : `${figures} – ${reasons}`;
		}
	}
	return out as ioBroker.Translated;
}

/** "Finished from": the end at standby as in 3.1.2 (no final phase). */
export const FINISH_STANDBY = "standby";
/** "Finished from": the final phase of the device stays as it is (offered only when the device has one). */
export const FINISH_KEEP = "keep";

/**
 * Whether "finished afterwards" can be offered for a phase: its band lies in the final band of the released final
 * phase (from P up to the hot value). The after-run is never such a phase (it is not read from the bands).
 *
 * @param model - Phase model
 * @param p - Phase
 * @param final - Released final phase, or null
 */
export function finalAllowed(model: PhaseModel, p: PhaseDef, final: FinalCandidate | null): boolean {
	if (!final?.ok || p.trailer) {
		return false;
	}
	const band = model.bands.find(b => b.id === p.band);
	if (!band) {
		return false;
	}
	const low = final.values.finalMinVal;
	const high = final.values.finalHotVal > 0 ? final.values.finalHotVal : Number.POSITIVE_INFINITY;
	return band.max > low && band.min < high;
}

/**
 * The phase whose end "finished from" reports (Spec B.7 step 2.4): the last phase in the final band in the order of
 * the run. There is one learned candidate (the last block in the final band), so earlier phases in the band are not
 * offered: they would promise an earlier end than the final phase filter gives.
 *
 * @param model - Phase model (phases in the order of the run)
 * @param final - Released final phase, or null
 */
export function finalPhaseOf(model: PhaseModel, final: FinalCandidate | null): PhaseDef | null {
	return model.phases.filter(p => finalAllowed(model, p, final)).at(-1) ?? null;
}

/**
 * Name of a phase with its number in the order of the run ("Phase 3 – Heating"; only "Phase 3" for a neutral name).
 *
 * @param model - Phase model
 * @param p - Phase
 */
export function phaseLabel(model: PhaseModel, p: PhaseDef): string {
	const neutral = neutralName(model.phases.indexOf(p) + 1);
	return p.name === neutral ? p.name : `${neutral} – ${p.name}`;
}

/**
 * Label of the choice "finished from" for the end of a phase: the phase that follows it, or "after <phase>" when it
 * is the last one.
 *
 * @param model - Phase model
 * @param p - Phase in the final band
 */
export function finishLabel(model: PhaseModel, p: PhaseDef): string {
	const next = model.phases[model.phases.indexOf(p) + 1];
	return next ? phaseLabel(model, next) : tr("dm_learnFinishAfter").replace("{phase}", phaseLabel(model, p));
}

/** Old state of the final phase of the device for the dialog. */
export interface OldFinish {
	/** Whether the device has an active final phase (`finalOn` of its values). */
	active: boolean;
	/** Phase model of the device before learning, or undefined. */
	model?: PhaseModel;
}

/**
 * Text of the choice of the device before learning.
 *
 * @param old - Old state
 */
function oldFinishText(old: OldFinish): string {
	if (!old.active) {
		return tr("dm_learnFinishStandby");
	}
	const p = old.model?.phases.find(x => x.final === true);
	return old.model && p ? finishLabel(old.model, p) : tr("dm_learnFinishDevice");
}

/**
 * Choices of "finished from": standby, the end of the phase in the final band (released only) and, with a final
 * phase in the device, "keep it".
 *
 * @param model - Learned model, or null
 * @param final - Result of `learnFinal`, or null
 * @param old - Old state
 */
export function finishOptions(
	model: PhaseModel | null,
	final: FinalCandidate | null,
	old: OldFinish,
): { label: string; value: string }[] {
	const out = [{ label: tr("dm_learnFinishStandby"), value: FINISH_STANDBY }];
	const p = model ? finalPhaseOf(model, final) : null;
	if (model && p) {
		out.push({ label: finishLabel(model, p), value: p.id });
	}
	if (old.active) {
		out.push({ label: tr("dm_learnFinishKeep"), value: FINISH_KEEP });
	}
	return out;
}

/**
 * Preset of "finished from": the end of the phase in the final band when the device already ends there (the phase
 * kept its `final` on relearning), "keep" for another final phase of the device, otherwise standby.
 *
 * @param model - Learned model, or null
 * @param final - Result of `learnFinal`, or null
 * @param old - Old state
 */
export function finishPreset(model: PhaseModel | null, final: FinalCandidate | null, old: OldFinish): string {
	if (!old.active) {
		return FINISH_STANDBY;
	}
	const p = model ? finalPhaseOf(model, final) : null;
	return p?.final === true ? p.id : FINISH_KEEP;
}

/**
 * A field label marked as changed ("≠ Start threshold").
 *
 * @param label - Label
 */
export function marked(label: ioBroker.StringOrTranslated): ioBroker.StringOrTranslated {
	if (typeof label === "string") {
		return `≠ ${label}`;
	}
	return Object.fromEntries(Object.entries(label).map(([lang, t]) => [lang, `≠ ${t}`])) as ioBroker.Translated;
}

/**
 * Items of "finished from" (Spec B.7 step 2.4): a row "label | before | new" and the key figures below it.
 *
 * @param model - Learned model, or null
 * @param final - Result of `learnFinal`, or null
 * @param old - Old state
 */
export function finishItems(model: PhaseModel | null, final: FinalCandidate | null, old: OldFinish): PanelItems {
	const options = finishOptions(model, final, old);
	const preset = finishPreset(model, final, old);
	const label = I18n.getTranslatedObject("dm_learnFinishAt");
	const changed = oldFinishText(old) !== options.find(o => o.value === preset)?.label;
	const items: PanelItems = {
		finalHeader: {
			type: "header",
			text: I18n.getTranslatedObject("dm_learnFinalHeader"),
			size: 4,
			newLine: true,
			xs: 12,
		},
		lbl_finishAt: { type: "staticText", text: changed ? marked(label) : label, newLine: true, xs: 12, sm: 4 },
		old_finishAt: {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnColOld"),
			disabled: true,
			xs: 6,
			sm: 4,
		},
		finishAt: {
			type: "select",
			label: I18n.getTranslatedObject("dm_learnColNew"),
			help: I18n.getTranslatedObject("dm_learnFinishHelp"),
			options,
			xs: 6,
			sm: 4,
		},
	};
	if (final) {
		items.final_text = { type: "staticText", text: finalText(final), newLine: true, xs: 12 };
	}
	return items;
}

/**
 * Data of "finished from".
 *
 * @param model - Learned model, or null
 * @param final - Result of `learnFinal`, or null
 * @param old - Old state
 */
export function finishData(model: PhaseModel | null, final: FinalCandidate | null, old: OldFinish): JsonFormData {
	return { old_finishAt: oldFinishText(old), finishAt: finishPreset(model, final, old) };
}

/** What the answer of "finished from" means for the device. */
export interface FinishChoice {
	/** Take the learned final values (a phase was chosen). */
	useFinal: boolean;
	/** Keep the final values of the device (and the `final` marks of the phases). */
	keep: boolean;
	/** Phase that carries `final` (the phase in the final band), or null. */
	finalId: string | null;
}

/**
 * Meaning of the answer of "finished from"; an unknown value (or a phase no longer offered) is standby.
 *
 * @param value - Answer
 * @param model - Learned model, or null
 * @param final - Result of `learnFinal`, or null
 * @param old - Old state
 */
export function finishChoiceOf(
	value: unknown,
	model: PhaseModel | null,
	final: FinalCandidate | null,
	old: OldFinish,
): FinishChoice {
	const p = model ? finalPhaseOf(model, final) : null;
	if (p && value === p.id) {
		return { useFinal: true, keep: false, finalId: p.id };
	}
	if (old.active && value === FINISH_KEEP) {
		return { useFinal: false, keep: true, finalId: null };
	}
	return { useFinal: false, keep: false, finalId: null };
}

/**
 * Name of a form field of a phase.
 *
 * @param id - Phase id
 * @param field - Field
 */
export function phaseKey(id: string, field: "no" | "name" | "power" | "duration" | "old" | "retro"): string {
	return `phase_${id}_${field}`;
}

/**
 * Hint on the phases of the previous model that fall away (Spec B.5 step 9): their names and, if actions use them, how
 * many actions no longer fire.
 *
 * @param dropped - Phases of the old model that fall away
 */
export function droppedText(dropped: readonly { id: string; name: string; actions: number }[]): ioBroker.Translated {
	const phases = dropped.map(d => d.name || d.id).join(", ");
	const n = dropped.reduce((a, d) => a + d.actions, 0);
	const out: Record<string, string> = {};
	for (const lang of Object.keys(TEXT.phasesDropped)) {
		const text = fill(TEXT.phasesDropped, lang, { phases });
		out[lang] = n > 0 ? `${text} ${fill(TEXT.phasesDroppedActions, lang, { n })}` : text;
	}
	return out as ioBroker.Translated;
}

/**
 * Power of a phase for the dialog: "≈ 2165 W", for the after-run "short bursts ≈ 110 W"; without a typical value the
 * name of its band.
 *
 * @param model - Phase model
 * @param p - Phase
 */
export function powerText(model: PhaseModel, p: PhaseDef): string {
	const w = p.stats.watts;
	if (w === undefined) {
		return model.bands.find(b => b.id === p.band)?.name ?? p.band;
	}
	return p.trailer ? tr("dm_learnPhaseBursts").replace("{w}", String(w)) : `≈ ${w} W`;
}

/**
 * Time per run in a phase: shortest to longest ("3–14 min"); without these facts the duration range of the phase.
 *
 * @param p - Phase
 */
export function durationText(p: PhaseDef): string {
	const lo = p.stats.shortSec ?? p.minSec;
	const hi = p.stats.longSec ?? p.maxSec;
	const a = Math.round(lo / 60);
	if (hi <= 0) {
		return `≥ ${a} min`;
	}
	const b = Math.round(hi / 60);
	return a === b ? `${a} min` : `${a}–${b} min`;
}

/**
 * Items of the phases (Spec B.7 step 2.3): a row per phase in the order of the run with number, name (editable),
 * power, duration and the phase of the old model with the same id ("new" for a new one). No table: a form table is
 * not checked in the Device Manager of a real system.
 *
 * @param model - Learned model
 * @param retro - Event phases that only appear in the timeline
 * @param dropped - Phases of the old model that fall away
 */
export function phaseItems(
	model: PhaseModel,
	retro: readonly string[],
	dropped: readonly { id: string; name: string; actions: number }[],
): PanelItems {
	const items: PanelItems = {
		phasesHeader: {
			type: "header",
			text: I18n.getTranslatedObject("dm_learnPhasesHeader"),
			size: 4,
			newLine: true,
			xs: 12,
		},
		phasesInfo: {
			type: "staticText",
			text: I18n.getTranslatedObject("dm_learnPhasesInfo"),
			newLine: true,
			xs: 12,
		},
	};
	if (dropped.length > 0) {
		items.phasesDropped = {
			type: "infoBox",
			boxType: dropped.some(d => d.actions > 0) ? "warning" : "info",
			text: droppedText(dropped),
			newLine: true,
			xs: 12,
		};
	}
	model.phases.forEach((p, k) => {
		items[phaseKey(p.id, "no")] = { type: "staticText", text: `${k + 1}.`, newLine: true, xs: 2, sm: 1 };
		items[phaseKey(p.id, "name")] = {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnPhaseName"),
			xs: 10,
			sm: 3,
		};
		items[phaseKey(p.id, "power")] = {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnPhasePower"),
			disabled: true,
			xs: 6,
			sm: 2,
		};
		items[phaseKey(p.id, "duration")] = {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnPhaseDuration"),
			disabled: true,
			xs: 6,
			sm: 2,
		};
		items[phaseKey(p.id, "old")] = {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnColOld"),
			disabled: true,
			xs: 12,
			sm: 4,
		};
		if (retro.includes(p.id)) {
			items[phaseKey(p.id, "retro")] = {
				type: "staticText",
				text: I18n.getTranslatedObject("dm_learnPhaseRetro"),
				newLine: true,
				xs: 12,
			};
		}
	});
	return items;
}

/**
 * Data of the phases.
 *
 * @param model - Learned model
 * @param previous - Model of the device before learning, or undefined
 */
export function phaseData(model: PhaseModel, previous?: PhaseModel): JsonFormData {
	const data: JsonFormData = {};
	for (const p of model.phases) {
		const old = previous?.phases.find(o => o.id === p.id);
		data[phaseKey(p.id, "name")] = p.name;
		data[phaseKey(p.id, "power")] = powerText(model, p);
		data[phaseKey(p.id, "duration")] = durationText(p);
		data[phaseKey(p.id, "old")] =
			old && previous
				? `${old.name} · ${powerText(previous, old)} · ${durationText(old)}`
				: tr("dm_learnPhaseNew");
	}
	return data;
}

/**
 * The model to save (Spec B.7): phases on, the names of the form and `final` at the phase whose end "finished from"
 * reports (with "keep" the marks of the model stay). `show` and `notify` stay as learned (kept from the old model);
 * messages of phases are set with the actions of the device.
 *
 * @param model - Learned model
 * @param data - Form data
 * @param choice - Meaning of "finished from"
 */
export function phasesFromForm(model: PhaseModel, data: JsonFormData, choice: FinishChoice): PhaseModel {
	const phases = model.phases.map(p => {
		const typed = data[phaseKey(p.id, "name")];
		const name = typeof typed === "string" ? typed.trim() : "";
		const { final: oldFinal, ...rest } = p;
		const next: PhaseDef = { ...rest, name: name || p.name };
		if (choice.keep ? oldFinal === true : p.id === choice.finalId) {
			next.final = true;
		}
		return next;
	});
	return { ...model, enabled: true, phases };
}
