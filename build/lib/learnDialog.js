import * as I18n from "@iobroker/adapter-core/i18n";
import { LOCK_DEFAULT_SEC } from "./detector/finalPhase.js";
import { formatDate } from "./deviceRegistry.js";
import { fill, TEXT } from "./dmTexts.js";
import { baseBandsOf } from "./learn/bands.js";
import { admitted, checkRuns, samplesOf } from "./learn/quality.js";
import { buildLayout } from "./learn/runs.js";
import { systemPhaseNames } from "./phases/model.js";
import { phaseHolds, replayPhases } from "./phases/tracker.js";
export const RUN_TABLE_MODE = "fallback";
export const AUTO_HOLD_MIN_RUNS = 8;
const BANDS_MIN_RUNS = 3;
const SEQUENCE_MAX = 6;
const USES = ["auto", "include", "exclude"];
function tr(key) {
    return I18n.translate(key);
}
export function buildRunTable(rows, mode) {
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
    const items = {};
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
export function runLabel(r, k) {
    return `${k + 1}. ${r.date} · ${r.durationMin} min · ${r.energyWh} Wh · ${r.check}${r.boundary ? ` · ${r.boundary}` : ""}`;
}
export function runTableData(rows) {
    return {
        runs: rows.map(r => ({ ...r })),
        ...Object.fromEntries(rows.map((r, k) => [`use_${k}`, r.use])),
        recalc: false,
    };
}
export function buildRunsSchema(rows, formerlyDropped, mode = RUN_TABLE_MODE) {
    const items = {
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
export function usesOfAnswer(answer, rows) {
    const out = new Map(rows.map(r => [r.key, r.use]));
    const valid = (v) => USES.includes(v);
    const table = Array.isArray(answer.runs) ? answer.runs : [];
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
export function pointsOfSeries(s, factor) {
    const out = [];
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
export function learnInputOf(deviceId, series, clean, factor, settings) {
    const points = pointsOfSeries(series, factor);
    const layout = buildLayout(series, { maxRuns: Number.POSITIVE_INFINITY });
    const samples = samplesOf(deviceId, points, series, layout, {
        src: "history",
        unitFactor: factor,
        timeJumps: clean.timeJumps.map(j => j.at),
    });
    return { deviceId, series, points, layout, samples, factor, pollMs: series.stepMs, settings };
}
export function evaluateRuns(input, uses, oldStore) {
    const runLimit = input.layout.runLimit / input.factor;
    const ctx = {
        unitFactor: input.factor,
        unit: input.factor === 1000 ? "kW" : "W",
        settings: input.settings,
        pollMs: input.pollMs,
        outages: [],
        scope: "run",
        ...(oldStore ? { oldStore } : {}),
    };
    const decide = (list, vs) => vs.map((v, k) => {
        const u = uses.get(list[k].key);
        return u === "include" || u === "exclude" ? { ...v, user: u } : v;
    });
    const pass = (list) => {
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
    const all = chosen.length === input.samples.length ? own : pass(input.samples);
    const verdicts = input.samples.map((x, k) => byKey.get(x.key) ?? all.verdicts[k]);
    return { verdicts, bands: own.bands };
}
export function counts(x, v, runs) {
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
export function heldBackSpans(input, ev) {
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
export function runSummary(input, ev, lang) {
    const runs = input.samples.filter(x => x.kind === "run").length;
    let used = 0;
    const left = [];
    input.samples.forEach((x, k) => {
        if (x.kind !== "run") {
            return;
        }
        if (counts(x, ev.verdicts[k], runs)) {
            used++;
        }
        else {
            left.push(`${formatDate(x.facts.start)} (${checkText(ev.verdicts[k])})`);
        }
    });
    const head = fill(TEXT.learnRunsUsed, lang, { used, total: runs });
    return left.length === 0 ? head : `${head} ${fill(TEXT.learnRunsHeldBack, lang, { list: left.join(", ") })}`;
}
export function checkText(v) {
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
export function phaseNames() {
    return systemPhaseNames(key => {
        try {
            return I18n.translate(key);
        }
        catch {
            return key;
        }
    });
}
export function neutralName(n) {
    let template;
    try {
        template = I18n.translate("phase_neutral");
    }
    catch {
        template = "Phase {n}";
    }
    if (!template.includes("{n}")) {
        template = "Phase {n}";
    }
    return template.replace("{n}", String(n));
}
export function phaseSequences(model, bands, input, pollSec) {
    const out = new Map();
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
        const seq = [];
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
export function rowsOf(input, ev, uses, phases) {
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
function reasonText(r, lang) {
    const obj = I18n.getTranslatedObject(`dm_finalReject_${r}`);
    return obj[lang] ?? obj.en ?? r;
}
export function finalText(c) {
    const base = TEXT.finalSummary;
    const out = {};
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
            out[lang] =
                c.values.finalActVal > 0 && c.values.finalActShare > 0
                    ? figures
                    : `${figures}. ${fill(TEXT.finalNoActivity, lang, { lock: Math.round((c.values.finalLockSec > 0 ? c.values.finalLockSec : LOCK_DEFAULT_SEC) / 60) })}`;
        }
        else {
            out[lang] = c.endRuns === 0 ? reasons : `${figures} – ${reasons}`;
        }
    }
    return out;
}
export function finalItems(c) {
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
export function phaseKey(id, field) {
    return `phase_${id}_${field}`;
}
export function finalAllowed(model, p, final) {
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
export function droppedText(dropped) {
    const phases = dropped.map(d => d.name || d.id).join(", ");
    const n = dropped.reduce((a, d) => a + d.actions, 0);
    const out = {};
    for (const lang of Object.keys(TEXT.phasesDropped)) {
        const text = fill(TEXT.phasesDropped, lang, { phases });
        out[lang] = n > 0 ? `${text} ${fill(TEXT.phasesDroppedActions, lang, { n })}` : text;
    }
    return out;
}
export function phaseItems(model, final, retro, dropped) {
    const hidden = "!data.showPhases";
    const items = {
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
export function phaseData(model, final, showPhases) {
    const data = { showPhases };
    const bandName = (id) => model.bands.find(b => b.id === id)?.name ?? id;
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
export function phasesFromForm(model, data, final, enabled) {
    const phases = model.phases.map(p => {
        const typed = data[phaseKey(p.id, "name")];
        const name = typeof typed === "string" ? typed.trim() : "";
        const start = data[phaseKey(p.id, "notifyStart")] === true;
        const end = data[phaseKey(p.id, "notifyEnd")] === true;
        const { notify: oldNotify, final: _final, ...rest } = p;
        const next = { ...rest, name: name || p.name, show: data[phaseKey(p.id, "show")] !== false };
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
//# sourceMappingURL=learnDialog.js.map