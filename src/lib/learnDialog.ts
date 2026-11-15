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
 * Neutral name of a learned phase from the translated template.
 *
 * @param n - Number
 * @param w - Typical power in W
 * @param min - Shortest duration in min
 * @param max - Longest duration in min
 */
export function neutralName(n: number, w: number, min: number, max: number): string {
	let template: string;
	try {
		template = I18n.translate("phase_neutral");
	} catch {
		template = "Level {n} · ≈ {w} W · {min}–{max} min";
	}
	return template
		.replace("{n}", String(n))
		.replace("{w}", String(Math.round(w)))
		.replace("{min}", String(min))
		.replace("{max}", String(max));
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
 * Key figures of the proposed final phase (Spec B.7 step 2), followed by the reasons when it cannot be offered.
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
					? figures
					: `${figures}. ${fill(TEXT.finalNoActivity, lang, { lock: Math.round((c.values.finalLockSec > 0 ? c.values.finalLockSec : LOCK_DEFAULT_SEC) / 60) })}`;
		} else {
			out[lang] = c.endRuns === 0 ? reasons : `${figures} – ${reasons}`;
		}
	}
	return out as ioBroker.Translated;
}

/**
 * Items of the final phase in the dialog: the key figures and the checkbox "use" (off by default; not offered when a
 * release check failed).
 *
 * @param c - Result of `learnFinal`
 */
export function finalItems(c: FinalCandidate): PanelItems {
	return {
		finalHeader: {
			type: "header",
			text: I18n.getTranslatedObject("dm_learnFinalHeader"),
			size: 4,
			newLine: true,
			xs: 12,
		},
		final_text: {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnFinalText"),
			disabled: true,
			newLine: true,
			xs: 12,
		},
		final_apply: {
			type: "checkbox",
			label: I18n.getTranslatedObject("dm_learnFinalApply"),
			help: I18n.getTranslatedObject("dm_learnFinalHelp"),
			disabled: !c.ok,
			newLine: true,
			xs: 12,
		},
	};
}

/**
 * Name of a form field of a phase.
 *
 * @param id - Phase id
 * @param field - Field
 */
export function phaseKey(id: string, field: "name" | "show" | "notifyStart" | "notifyEnd" | "final" | "info"): string {
	return `phase_${id}_${field}`;
}

/**
 * Whether "finished afterwards" can be offered for a phase: its band lies in the final band of the released final
 * phase (from P up to the hot value).
 *
 * @param model - Phase model
 * @param p - Phase
 * @param final - Released final phase, or null
 */
export function finalAllowed(model: PhaseModel, p: PhaseDef, final: FinalCandidate | null): boolean {
	if (!final?.ok) {
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
 * Hint on the phases of the previous model that fall away (Spec B.5 step 8): their names and, if actions use them, how
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
 * Items of the phases step: the checkbox "show phases" and, below it, one block per phase (name, shown, messages,
 * finished afterwards); all hidden while phases are off.
 *
 * @param model - Learned model
 * @param final - Released final phase, or null
 * @param retro - Event phases that only appear in the timeline
 * @param dropped - Phases of the old model that fall away
 */
export function phaseItems(
	model: PhaseModel,
	final: FinalCandidate | null,
	retro: readonly string[],
	dropped: readonly { id: string; name: string; actions: number }[],
): PanelItems {
	const hidden = "!data.showPhases";
	const items: PanelItems = {
		phasesHeader: {
			type: "header",
			text: I18n.getTranslatedObject("dm_learnPhasesHeader"),
			size: 4,
			newLine: true,
			xs: 12,
		},
		showPhases: {
			type: "checkbox",
			label: I18n.getTranslatedObject("dm_learnShowPhases"),
			help: I18n.getTranslatedObject("dm_learnPhasesHelp"),
			newLine: true,
			xs: 12,
		},
	};
	if (dropped.length > 0) {
		items.phasesDropped = {
			type: "infoBox",
			boxType: dropped.some(d => d.actions > 0) ? "warning" : "info",
			text: droppedText(dropped),
			hidden,
			newLine: true,
			xs: 12,
		};
	}
	for (const p of model.phases) {
		items[phaseKey(p.id, "info")] = {
			type: "text",
			label: p.name,
			disabled: true,
			hidden,
			newLine: true,
			xs: 12,
			sm: 4,
		};
		items[phaseKey(p.id, "name")] = {
			type: "text",
			label: I18n.getTranslatedObject("dm_learnPhaseName"),
			hidden,
			xs: 12,
			sm: 4,
		};
		items[phaseKey(p.id, "show")] = {
			type: "checkbox",
			label: I18n.getTranslatedObject("dm_learnPhaseShow"),
			hidden,
			xs: 6,
			sm: 1,
		};
		items[phaseKey(p.id, "notifyStart")] = {
			type: "checkbox",
			label: I18n.getTranslatedObject("dm_learnPhaseNotifyStart"),
			hidden,
			xs: 6,
			sm: 1,
		};
		items[phaseKey(p.id, "notifyEnd")] = {
			type: "checkbox",
			label: I18n.getTranslatedObject("dm_learnPhaseNotifyEnd"),
			hidden,
			xs: 6,
			sm: 1,
		};
		if (finalAllowed(model, p, final)) {
			items[phaseKey(p.id, "final")] = {
				type: "checkbox",
				label: I18n.getTranslatedObject("dm_learnPhaseFinal"),
				hidden,
				xs: 6,
				sm: 1,
			};
		}
		if (retro.includes(p.id)) {
			items[`phase_${p.id}_retro`] = {
				type: "staticText",
				text: I18n.getTranslatedObject("dm_learnPhaseRetro"),
				hidden,
				newLine: true,
				xs: 12,
			};
		}
	}
	return items;
}

/**
 * Data of the phases step.
 *
 * @param model - Learned model
 * @param final - Released final phase, or null
 * @param showPhases - Preset of "show phases"
 */
export function phaseData(model: PhaseModel, final: FinalCandidate | null, showPhases: boolean): JsonFormData {
	const data: JsonFormData = { showPhases };
	const bandName = (id: string): string => model.bands.find(b => b.id === id)?.name ?? id;
	for (const p of model.phases) {
		const dur = `${Math.round(p.minSec / 60)}–${p.maxSec > 0 ? Math.round(p.maxSec / 60) : "∞"} min`;
		const after = (p.after ?? []).map(a => model.phases.find(x => x.id === a)?.name ?? a);
		const pre = `${after.slice(0, 3).join(", ")}${after.length > 3 ? ", …" : ""}`;
		data[phaseKey(p.id, "info")] =
			`${bandName(p.band)} · ${dur}${pre ? ` · ← ${pre}` : ""} · ${Math.round(p.stats.agreement * 100)} %`;
		data[phaseKey(p.id, "name")] = p.name;
		data[phaseKey(p.id, "show")] = p.show;
		data[phaseKey(p.id, "notifyStart")] = p.notify?.start === true;
		data[phaseKey(p.id, "notifyEnd")] = p.notify?.end === true;
		if (finalAllowed(model, p, final)) {
			data[phaseKey(p.id, "final")] = p.final === true;
		}
	}
	return data;
}

/**
 * The model with the edits of the phases step (names, shown, messages, finished afterwards).
 *
 * @param model - Learned model
 * @param data - Form data
 * @param final - Released final phase, or null
 * @param enabled - Whether phases are switched on
 */
export function phasesFromForm(
	model: PhaseModel,
	data: JsonFormData,
	final: FinalCandidate | null,
	enabled: boolean,
): PhaseModel {
	const phases = model.phases.map(p => {
		const typed = data[phaseKey(p.id, "name")];
		const name = typeof typed === "string" ? typed.trim() : "";
		const start = data[phaseKey(p.id, "notifyStart")] === true;
		const end = data[phaseKey(p.id, "notifyEnd")] === true;
		const { notify: oldNotify, final: _final, ...rest } = p;
		const next: PhaseDef = { ...rest, name: name || p.name, show: data[phaseKey(p.id, "show")] !== false };
		if (start || end) {
			next.notify = {
				...(oldNotify?.text ? { text: oldNotify.text } : {}),
				...(start ? { start } : {}),
				...(end ? { end } : {}),
			};
		}
		if (finalAllowed(model, p, final) && data[phaseKey(p.id, "final")] === true) {
			next.final = true;
		}
		return next;
	});
	return { ...model, enabled, phases };
}
