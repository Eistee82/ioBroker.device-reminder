import { bandOf, bandSegmentsOf, suspectLimitOf, unitsOf } from "./bands.js";
import { cleanPoints } from "./clean.js";
import { assignFamilies, FAMILY_DISTANCE, featuresOf } from "./families.js";
import { blocksOf, buildLayout, END_BLOCK_BRIDGE_MS, END_BLOCK_SHARE, LEVEL_SEP_W, median, mergeBlocks, quantile, SPLIT_GAP_MIN_MS, SUSTAINED_MS, } from "./runs.js";
import { fromPoints, markInvalid } from "./ticks.js";
const SAME_RUN_MIN = 5;
const AROUND_MS = 30 * 60_000;
const OFF_SCAN_MS = 6 * 60 * 60_000;
const RELOG_GAP_FACTOR = 2;
const REPORT_GAP_FACTOR = 3;
const REPORT_GAP_MIN_MS = 2 * 60_000;
const REPEAT_MIN = 10;
const REPEAT_MIN_SHARE = 0.01;
const STUCK_MIN_REPORTS = 20;
const STUCK_MIN_CV = 0.05;
const SPARSE_FACTOR = 4;
const UNIT_FACTOR = 50;
const UNIT_TEMPLATE_FACTOR = 100;
const FOREIGN_MIN_W = 20;
const FOREIGN_SPREAD = 3;
const FOREIGN_TOP_SHARE = 0.05;
const FOREIGN_TOP_FACTOR = 1.5;
const SPIKE_FACTOR = 3;
const TOP_Q = 0.999;
const REST_LEVEL_FACTOR = 1.25;
const REST_LEVEL_W = 0.1;
const TEST_RUN_MS = 10 * 60_000;
const TEST_SHORT_RATIO = 3;
const TEST_REF_MIN = 3;
const TEST_SPIKE_RATIO = 2;
const COMMON_SHARE = 0.5;
const TRAILER_SHARE = 0.5;
const TRAILER_EARLY_MIN_SEC = 5 * 60;
const TRAILER_EARLY_MAD = 4;
const TRAILER_MIN_RUNS = 2;
const MERGED_FACTOR = 1.8;
const END_LEVEL_RATIO = 2;
const INVALID_SHARE = 0.01;
const GROUP_DISTANCE = 2 * FAMILY_DISTANCE;
const RARE_Z = 3.5;
const RARE_GROUP_MIN = 3;
const RARE_Z_MIN = 5;
const RARE_SPREAD_MIN = 0.15;
const RARE_FAR = 2;
const RARE_TWIN = Math.log(1.2);
const ROUND_SHARE = 0.1;
const ABORT_OFF_SEC = 60;
const ABORT_Q = 0.1;
const ABORT_END_BLOCK_SHARE = 0.5;
const STAGE_OF = {
    incomplete: "unusable",
    gap: "quarantine",
    unit: "unusable",
    counter: "unusable",
    stuck: "quarantine",
    sparse: "quarantine",
    foreign: "quarantine",
    test: "quarantine",
    merged: "limited",
    trailerCut: "limited",
    aborted: "limited",
    spike: "limited",
    historyCfg: "limited",
    invalid: "limited",
    timeJump: "limited",
    finalSplit: "ok",
    rare: "ok",
    formerlyDropped: "ok",
};
const RANK = [
    "incomplete",
    "gap",
    "unit",
    "counter",
    "stuck",
    "sparse",
    "foreign",
    "test",
    "merged",
    "trailerCut",
    "aborted",
    "spike",
    "historyCfg",
    "invalid",
    "timeJump",
    "finalSplit",
    "rare",
    "formerlyDropped",
];
const STAGE_ORDER = ["ok", "limited", "quarantine", "unusable"];
export function verdictKey(deviceId, startMs) {
    return `${deviceId}@${Math.floor(startMs / 60_000)}`;
}
function parseKey(key) {
    const at = key.lastIndexOf("@");
    const minute = at >= 0 ? Number(key.slice(at + 1)) : Number.NaN;
    return Number.isFinite(minute) ? { device: key.slice(0, at), minute } : null;
}
export function sameRun(a, b) {
    const x = parseKey(a);
    const y = parseKey(b);
    return x !== null && y !== null && x.device === y.device && Math.abs(x.minute - y.minute) <= SAME_RUN_MIN;
}
function stageOfReason(r) {
    if (r.code === "gap" && r.detail.startsWith("proven")) {
        return "unusable";
    }
    if ((r.code === "gap" || r.code === "stuck") && r.detail.includes("segment")) {
        return "ok";
    }
    return STAGE_OF[r.code];
}
export function stageOf(reasons) {
    let k = 0;
    for (const r of reasons) {
        k = Math.max(k, STAGE_ORDER.indexOf(stageOfReason(r)));
    }
    return STAGE_ORDER[k];
}
export function primaryOf(reasons) {
    let best = null;
    for (const r of reasons) {
        if (best === null) {
            best = r;
            continue;
        }
        const a = STAGE_ORDER.indexOf(stageOfReason(r));
        const b = STAGE_ORDER.indexOf(stageOfReason(best));
        if (a > b || (a === b && RANK.indexOf(r.code) < RANK.indexOf(best.code))) {
            best = r;
        }
    }
    return best?.code ?? null;
}
export function usesOf(reasons) {
    const u = { start: true, end: true, phases: true, final: true, trailer: true, rest: true };
    const none = () => {
        u.start = u.end = u.phases = u.final = u.trailer = u.rest = false;
    };
    for (const r of reasons) {
        const stage = stageOfReason(r);
        if (stage === "unusable" || stage === "quarantine") {
            none();
            continue;
        }
        switch (r.code) {
            case "merged":
                u.phases = u.final = u.trailer = u.rest = false;
                break;
            case "trailerCut":
                u.trailer = u.rest = false;
                break;
            case "aborted":
                u.end = u.phases = u.final = u.trailer = u.rest = false;
                break;
            case "historyCfg":
                if (r.detail.startsWith("debounce")) {
                    u.phases = u.trailer = false;
                }
                else if (r.detail.startsWith("ignoreZero")) {
                    u.rest = false;
                }
                break;
            default:
                break;
        }
    }
    return u;
}
export function admitted(v, purpose) {
    if (v.user === "exclude") {
        return false;
    }
    if (v.user === "include") {
        return v.stage !== "unusable";
    }
    return (v.stage === "ok" || v.stage === "limited") && v.uses[purpose];
}
function lowerBound(points, ts) {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].ts < ts) {
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }
    return lo;
}
function lowerNum(a, x) {
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid] < x) {
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }
    return lo;
}
function sliceUnit(points, from, to) {
    const a = lowerBound(points, from);
    const b = lowerBound(points, to + 1);
    const out = [];
    if (a > 0 && (a === points.length || points[a].ts > from)) {
        out.push({ ts: from, val: points[a - 1].val });
    }
    for (let i = a; i < b; i++) {
        out.push({ ts: points[i].ts, val: points[i].val });
    }
    return { points: out, from, to };
}
function medianOfTicks(s, from, to) {
    const v = [];
    for (let i = Math.max(0, from); i <= Math.min(s.length - 1, to); i++) {
        if (s.valid[i] === 1) {
            v.push(s.last[i]);
        }
    }
    return v.length > 0 ? median(v) : null;
}
function madn(v) {
    if (v.length === 0) {
        return 0;
    }
    const m = median(v);
    return 1.4826 * median(v.map(x => Math.abs(x - m)));
}
function weightedQuantile(pairs, q) {
    if (pairs.length === 0) {
        return Number.NaN;
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const total = pairs.reduce((s, p) => s + p[1], 0);
    let acc = 0;
    for (const [v, d] of pairs) {
        acc += d;
        if (acc >= q * total) {
            return v;
        }
    }
    return pairs.at(-1)[0];
}
function heldPairs(u, from, to) {
    const out = [];
    const p = u.points;
    for (let i = 0; i < p.length; i++) {
        const a = Math.max(p[i].ts, from);
        const b = Math.min(i + 1 < p.length ? p[i + 1].ts : u.to, to);
        if (b > a) {
            out.push([p[i].val, b - a]);
        }
    }
    return out;
}
function heldAt(u, t) {
    const i = lowerBound(u.points, t + 1) - 1;
    return i >= 0 ? u.points[i].val : null;
}
function rawIndexOf(raw, jumps) {
    const all = [];
    const bad = [];
    for (const p of raw) {
        if (!Number.isFinite(p.ts)) {
            continue;
        }
        all.push(p.ts);
        if (p.val === null || typeof p.val !== "number" || !Number.isFinite(p.val) || p.val < 0) {
            bad.push(p.ts);
        }
    }
    all.sort((a, b) => a - b);
    bad.sort((a, b) => a - b);
    return { all, bad, jumps: [...jumps].sort((a, b) => a - b) };
}
function countIn(a, from, to) {
    return lowerNum(a, to + 1) - lowerNum(a, from);
}
function runFacts(s, L, r, all, factor) {
    const T = (i) => s.t0 + i * s.stepMs;
    const feat = featuresOf(s, r, L.runLimit);
    const last = Math.max(r.to, r.runEnd);
    const offLevel = L.rest !== null ? L.idle + Math.max(LEVEL_SEP_W, 0.5 * (L.rest - L.idle)) : L.runLimit;
    let offSec = null;
    const scan = Math.ceil(OFF_SCAN_MS / s.stepMs);
    for (let i = last + 1; i < Math.min(s.length, last + scan); i++) {
        if (s.valid[i] === 0 || s.last[i] > L.runLimit) {
            break;
        }
        if (s.last[i] <= offLevel) {
            offSec = ((i - r.coreEnd) * s.stepMs) / 1000;
            break;
        }
    }
    const around = Math.ceil(AROUND_MS / s.stepMs);
    const prev = [...all].reverse().find(x => x.to < r.from);
    const next = all.find(x => x.from > last);
    const pre = medianOfTicks(s, Math.max(r.from - around, prev ? prev.to + 1 : 0), r.from - 1);
    const post = medianOfTicks(s, last + 1, Math.min(last + around, next ? next.from - 1 : s.length - 1));
    const level = L.tailSeparated ? END_BLOCK_SHARE * L.burstMaxW : L.runLimit;
    const endBlocks = mergeBlocks(blocksOf(s, { from: r.from, to: r.coreEnd }, level), Math.floor(END_BLOCK_BRIDGE_MS / s.stepMs) + 1)
        .filter(b => (b.to - b.from + 1) * s.stepMs >= SUSTAINED_MS)
        .map(b => {
        const v = [];
        for (let i = b.from; i <= b.to; i++) {
            if (s.last[i] > level) {
                v.push(s.last[i]);
            }
        }
        return { from: T(b.from), to: T(b.to), level: median(v) / factor };
    });
    return {
        start: T(r.from),
        coreEnd: T(r.coreEnd),
        progEnd: T(r.progEnd),
        runEnd: T(r.runEnd),
        end: T(r.to),
        coreSec: feat.coreSec,
        feat,
        offSec,
        preLevel: pre === null ? null : pre / factor,
        postLevel: post === null ? null : post / factor,
        restLevel: r.postEnd / factor,
        endBlocks,
    };
}
export function samplesOf(deviceId, points, s, L, o) {
    const factor = o.unitFactor > 0 ? o.unitFactor : 1;
    const T = (i) => s.t0 + i * s.stepMs;
    const raw = rawIndexOf(o.raw ?? [], o.timeJumps ?? []);
    const quality = (from, to) => {
        const n = countIn(raw.all, from, to);
        return { invalidShare: n > 0 ? countIn(raw.bad, from, to) / n : 0, timeJumps: countIn(raw.jumps, from, to) };
    };
    const all = [...L.runs, ...L.spikes, ...L.incomplete]
        .map(x => ({ from: x.from, to: x.to }))
        .sort((a, b) => a.from - b.from);
    const units = unitsOf(points, L, s, factor);
    const feats = [];
    const out = L.runs.map((r, k) => {
        const facts = runFacts(s, L, r, all, factor);
        feats.push(facts.feat);
        return {
            ...units[k],
            key: verdictKey(deviceId, facts.start),
            kind: "run",
            src: o.src,
            info: r,
            family: -1,
            facts: { ...facts, ...quality(units[k].from, units[k].to) },
        };
    });
    const families = assignFamilies(feats, feats.map(() => -1), 0).families;
    out.forEach((x, k) => (x.family = families[k]));
    const other = (sp, kind) => {
        const from = T(Math.max(0, sp.from - 1));
        const to = T(Math.min(s.length - 1, sp.to + 1));
        const start = T(sp.from);
        const end = T(sp.to);
        return {
            ...sliceUnit(points, from, to),
            key: verdictKey(deviceId, start),
            kind,
            src: o.src,
            info: null,
            family: -1,
            facts: {
                start,
                coreEnd: end,
                progEnd: end,
                runEnd: end,
                end,
                coreSec: ((sp.to - sp.from + 1) * s.stepMs) / 1000,
                feat: null,
                offSec: null,
                preLevel: null,
                postLevel: null,
                restLevel: null,
                endBlocks: [],
                ...quality(from, to),
            },
        };
    };
    out.push(...L.spikes.map(sp => other(sp, "spike")), ...L.incomplete.map(sp => other(sp, "incomplete")));
    return out.sort((a, b) => a.facts.start - b.facts.start);
}
function prepare(points, stepMs, unitFactor) {
    const clean = cleanPoints(points);
    const factor = unitFactor > 0 ? unitFactor : 1;
    const series = fromPoints(clean.points.map(p => ({ ts: p.ts, val: p.val * factor })), stepMs);
    for (const u of clean.unknown) {
        markInvalid(series, u.from, u.to + 1);
    }
    const layout = buildLayout(series, { maxRuns: Number.POSITIVE_INFINITY });
    return { clean, series, layout, factor };
}
export function runSamples(deviceId, points, o) {
    const { clean, series, layout, factor } = prepare(points, o.stepMs, o.unitFactor);
    const samples = samplesOf(deviceId, clean.points, series, layout, {
        src: o.src,
        unitFactor: factor,
        raw: points,
        timeJumps: clean.timeJumps.map(j => j.at),
    });
    return { samples, layout, series, clean };
}
export function daySamples(deviceId, points, o) {
    const { clean, series: s } = prepare(points, o.stepMs, o.unitFactor);
    const pts = clean.points;
    if (pts.length === 0) {
        return [];
    }
    const raw = rawIndexOf(points, clean.timeJumps.map(j => j.at));
    const out = [];
    const first = pts[0].ts;
    const lastTs = pts.at(-1).ts;
    for (let from = first; from < lastTs; from += 86_400_000) {
        const to = Math.min(from + 86_400_000, lastTs);
        const a = Math.max(s.firstIdx, Math.ceil((from - s.t0) / s.stepMs));
        const b = Math.min(s.length - 1, Math.floor((to - s.t0) / s.stepMs));
        let unknown = false;
        for (let i = a; i <= b && !unknown; i++) {
            unknown = s.valid[i] === 0;
        }
        const n = countIn(raw.all, from, to);
        out.push({
            ...sliceUnit(pts, from, to),
            key: verdictKey(deviceId, from),
            kind: unknown ? "incomplete" : "run",
            src: o.src,
            info: null,
            family: -1,
            facts: {
                start: from,
                coreEnd: to,
                progEnd: to,
                runEnd: to,
                end: to,
                coreSec: (to - from) / 1000,
                feat: null,
                offSec: null,
                preLevel: null,
                postLevel: null,
                restLevel: null,
                endBlocks: [],
                invalidShare: n > 0 ? countIn(raw.bad, from, to) / n : 0,
                timeJumps: countIn(raw.jumps, from, to),
            },
        });
    }
    return out;
}
function excluded(reasons) {
    const st = stageOf(reasons);
    return st === "quarantine" || st === "unusable";
}
function fmt(x) {
    return String(Math.round(x * 100) / 100);
}
function intervalsIn(u, from, to) {
    const out = [];
    const p = u.points;
    for (let i = lowerBound(p, from) + 1; i < p.length && p[i].ts <= to; i++) {
        out.push(p[i].ts - p[i - 1].ts);
    }
    return out;
}
function longestSilence(u, from, to) {
    const p = u.points;
    let longest = 0;
    if (p.length === 0) {
        return u.to - u.from;
    }
    for (let i = Math.max(1, lowerBound(p, from)); i <= p.length; i++) {
        const a = p[i - 1].ts;
        const b = i < p.length ? p[i].ts : u.to;
        if (a > to) {
            break;
        }
        if (b >= from) {
            longest = Math.max(longest, b - a);
        }
    }
    return longest;
}
function checkGlobal(w, ctx) {
    if (/wh$/i.test(ctx.unit.trim())) {
        w.forEach(x => x.reasons.push({ code: "counter", detail: `unit ${ctx.unit.trim()}` }));
        return;
    }
    const peaks = w
        .filter(x => x.s.kind === "run" && x.s.info !== null)
        .map(x => peakOf(x.s))
        .filter(p => p > 0);
    if (peaks.length === 0) {
        return;
    }
    const typical = median(peaks);
    const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
    if (ctx.templatePeakW !== undefined &&
        ctx.templatePeakW > 0 &&
        typical * factor < ctx.templatePeakW / UNIT_TEMPLATE_FACTOR) {
        w.forEach(x => x.reasons.push({
            code: "unit",
            detail: `typical peak ${fmt(typical)} ${ctx.unit}, template ${fmt(ctx.templatePeakW)} W`,
        }));
        return;
    }
    for (const x of w) {
        if (x.s.kind !== "run" || x.s.info === null) {
            continue;
        }
        const p = peakOf(x.s);
        if (p < typical / UNIT_FACTOR || p > typical * UNIT_FACTOR) {
            x.reasons.push({ code: "unit", detail: `peak ${fmt(p)}, median of the runs ${fmt(typical)}` });
        }
    }
}
function peakOf(s) {
    let m = 0;
    for (const [v] of heldPairs(s, s.facts.start, Math.max(s.facts.runEnd, s.facts.end) + 1)) {
        m = Math.max(m, v);
    }
    return m;
}
function reportsOf(s, ctx) {
    if (s.reports && s.reports.length >= 2) {
        return s.reports;
    }
    if (s.src === "history" && ctx.settings !== null && ctx.settings.relogSec > 0) {
        return s.points.map(p => p.ts);
    }
    return null;
}
function checkData(x, ctx, reportP999, cv) {
    const s = x.s;
    const f = s.facts;
    const continuous = ctx.scope === "continuous";
    if (s.kind === "incomplete") {
        x.reasons.push({
            code: "incomplete",
            detail: continuous ? "unknown time in the section" : "touches a gap or the end of the data",
        });
    }
    if (s.restarted) {
        x.reasons.push({ code: "incomplete", detail: "adapter restarted during the run" });
    }
    const runTo = Math.max(f.runEnd, f.end);
    if (s.src === "history" && ctx.settings !== null && ctx.settings.relogSec > 0) {
        const limit = RELOG_GAP_FACTOR * ctx.settings.relogSec * 1000 + ctx.pollMs;
        const longest = longestSilence(s, f.start, runTo);
        if (longest > limit) {
            x.reasons.push({
                code: "gap",
                detail: `proven: no value for ${fmt(longest / 1000)} s with relog ${ctx.settings.relogSec} s`,
            });
        }
    }
    if (s.reports && s.reports.length >= 2 && reportP999 > 0) {
        const limit = Math.max(REPORT_GAP_MIN_MS, REPORT_GAP_FACTOR * reportP999);
        let longest = 0;
        for (let i = 1; i < s.reports.length; i++) {
            if (s.reports[i] >= f.start && s.reports[i - 1] <= runTo) {
                longest = Math.max(longest, s.reports[i] - s.reports[i - 1]);
            }
        }
        if (longest > limit) {
            x.reasons.push({ code: "gap", detail: `proven: no report for ${fmt(longest / 1000)} s` });
        }
    }
    const outage = ctx.outages.find(o => o.from <= runTo && o.to >= f.start);
    if (outage) {
        x.reasons.push({ code: "gap", detail: `proven: outage of ${fmt((outage.to - outage.from) / 1000)} s` });
    }
    if (ctx.bands !== null && !s.fromTicks) {
        const to = continuous ? f.end : Math.min(f.coreEnd, f.progEnd);
        const p = s.points;
        for (let i = 0; i < p.length; i++) {
            const next = i + 1 < p.length ? p[i + 1].ts : s.to;
            const a = Math.max(p[i].ts, f.start);
            const b = Math.min(next, to);
            if (b <= a) {
                continue;
            }
            const limit = suspectLimitOf(ctx.bands, p[i].val);
            if (limit !== null && (next - p[i].ts) / 1000 > limit) {
                x.reasons.push({
                    code: "gap",
                    detail: `suspect${continuous ? ` segment at ${p[i].ts}` : ""}: ${fmt(p[i].val)} held for ${fmt((next - p[i].ts) / 1000)} s (limit ${fmt(limit)} s)`,
                });
                if (!continuous) {
                    break;
                }
            }
        }
    }
    const reports = ctx.bands !== null ? reportsOf(s, ctx) : null;
    if (reports !== null && ctx.bands !== null) {
        let k = 0;
        while (k < reports.length) {
            const v = heldAt(s, reports[k]);
            let j = k;
            while (j + 1 < reports.length && heldAt(s, reports[j + 1]) === v) {
                j++;
            }
            const band = v === null ? null : bandOf(ctx.bands, v);
            const limit = v === null ? null : suspectLimitOf(ctx.bands, v);
            const idx = band ? ctx.bands.bands.indexOf(band) : -1;
            if (v !== null &&
                band !== null &&
                limit !== null &&
                j - k + 1 >= STUCK_MIN_REPORTS &&
                (reports[j] - reports[k]) / 1000 > limit &&
                (cv[idx] ?? 0) > STUCK_MIN_CV &&
                reports[j] >= f.start &&
                reports[k] <= (continuous ? f.end : f.coreEnd)) {
                x.reasons.push({
                    code: "stuck",
                    detail: `${continuous ? `segment at ${reports[k]}: ` : ""}${j - k + 1} reports of ${fmt(v)} over ${fmt((reports[j] - reports[k]) / 1000)} s`,
                });
                if (!continuous) {
                    break;
                }
            }
            k = j + 1;
        }
    }
    if (s.src === "history" && ctx.settings !== null) {
        const st = ctx.settings;
        if (st.ignoreZero) {
            x.reasons.push({ code: "historyCfg", detail: "ignoreZero: zero values are not stored" });
        }
        const debounce = Math.max(st.debounceMs, st.blockTimeMs);
        if (debounce > ctx.pollMs) {
            x.reasons.push({ code: "historyCfg", detail: `debounce ${debounce} ms > poll ${ctx.pollMs} ms` });
        }
        if (st.round !== null &&
            f.restLevel !== null &&
            f.restLevel > 0 &&
            10 ** -st.round > ROUND_SHARE * f.restLevel) {
            x.reasons.push({ code: "historyCfg", detail: `round ${st.round} digits, rest level ${fmt(f.restLevel)}` });
        }
    }
    if (f.invalidShare > INVALID_SHARE) {
        x.reasons.push({ code: "invalid", detail: `${fmt(100 * f.invalidShare)} % invalid values` });
    }
    if (f.timeJumps > 0) {
        x.reasons.push({ code: "timeJump", detail: `${f.timeJumps} jumps back in time` });
    }
}
function checkSparse(runs) {
    const p90 = runs.map(x => {
        const d = intervalsIn(x.s, x.s.facts.start, x.s.facts.coreEnd);
        return x.s.fromTicks || d.length === 0 ? null : quantile(d, 0.9);
    });
    runs.forEach((x, k) => {
        const own = p90[k];
        const others = p90.filter((v, j) => j !== k && v !== null);
        if (own === null || others.length < 2) {
            return;
        }
        const ref = median(others);
        if (own > SPARSE_FACTOR * ref) {
            x.reasons.push({
                code: "sparse",
                detail: `p90 of the intervals ${fmt(own / 1000)} s, others ${fmt(ref / 1000)} s`,
            });
        }
    });
}
function checkSpikes(w) {
    const pairs = [];
    for (const x of w) {
        if (x.s.kind === "run") {
            pairs.push(...heldPairs(x.s, x.s.facts.start, Math.max(x.s.facts.runEnd, x.s.facts.end) + 1));
        }
    }
    const top = weightedQuantile(pairs, TOP_Q);
    if (!(top > 0)) {
        return;
    }
    const limit = SPIKE_FACTOR * top;
    for (const x of w) {
        const p = x.s.points;
        const i = p.findIndex((q, k) => q.val > limit && !(k > 0 && p[k - 1].val > limit) && !(k + 1 < p.length && p[k + 1].val > limit));
        if (i >= 0) {
            x.reasons.push({ code: "spike", detail: `${fmt(p[i].val)} > ${fmt(limit)}` });
        }
    }
}
function commonBandsOf(clean, bands) {
    const touched = clean.map(x => new Set(bandSegmentsOf(x.s, bands, x.s.facts.coreEnd).map(b => b.band)));
    if (touched.length === 0 || median(touched.map(t => t.size)) <= 1) {
        return null;
    }
    const common = new Set();
    bands.bands.forEach((_, k) => {
        if (touched.filter(t => t.has(k)).length >= COMMON_SHARE * touched.length) {
            common.add(k);
        }
    });
    return common;
}
function checkForm(w, clean, ctx) {
    const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
    const minW = FOREIGN_MIN_W / factor;
    const levelRef = (pick, self) => {
        const v = clean
            .filter(x => x !== self)
            .map(x => pick(x.s.facts))
            .filter((l) => l !== null);
        return v.length >= 3 ? median(v) + Math.max(minW, FOREIGN_SPREAD * madn(v)) : null;
    };
    const tops = new Map();
    for (const x of clean) {
        tops.set(x, weightedQuantile(heldPairs(x.s, x.s.facts.start, x.s.facts.runEnd + 1), TOP_Q));
    }
    const spikes = w.filter(x => x.s.kind === "spike");
    const common = ctx.bands !== null && ctx.bands.bands.length > 0 ? commonBandsOf(clean, ctx.bands) : null;
    for (const x of w) {
        const f = x.s.facts;
        if (x.s.kind === "spike") {
            const second = Math.max(0, ...spikes.filter(y => y !== x).map(y => y.s.facts.coreSec));
            if (f.coreSec > TEST_SPIKE_RATIO * second) {
                x.reasons.push({
                    code: "test",
                    detail: `short activity of ${fmt(f.coreSec)} s, next longest ${fmt(second)} s`,
                });
            }
            continue;
        }
        if (x.s.kind !== "run" || x.s.info === null) {
            continue;
        }
        const pre = levelRef(g => g.preLevel, x);
        const post = levelRef(g => g.postLevel, x);
        if (pre !== null && f.preLevel !== null && f.preLevel > pre) {
            x.reasons.push({ code: "foreign", detail: `level before the run ${fmt(f.preLevel)} > ${fmt(pre)}` });
        }
        else if (post !== null && f.postLevel !== null && f.postLevel > post) {
            x.reasons.push({ code: "foreign", detail: `level after the run ${fmt(f.postLevel)} > ${fmt(post)}` });
        }
        else {
            const others = clean
                .filter(y => y !== x)
                .map(y => tops.get(y) ?? Number.NaN)
                .filter(t => t > 0);
            if (others.length >= 3) {
                const limit = FOREIGN_TOP_FACTOR * median(others);
                const pairs = heldPairs(x.s, f.start, f.runEnd + 1);
                const total = pairs.reduce((a, p) => a + p[1], 0);
                const above = pairs.filter(p => p[0] > limit).reduce((a, p) => a + p[1], 0);
                if (total > 0 && above > FOREIGN_TOP_SHARE * total) {
                    x.reasons.push({
                        code: "foreign",
                        detail: `${fmt((100 * above) / total)} % of the run above ${fmt(limit)}`,
                    });
                }
            }
        }
        const durations = clean.filter(y => y !== x).map(y => y.s.facts.coreSec);
        const shortDevice = durations.length >= TEST_REF_MIN && median(durations) < TEST_SHORT_RATIO * f.coreSec;
        if (f.coreSec * 1000 < TEST_RUN_MS && !shortDevice) {
            x.reasons.push({ code: "test", detail: `run of ${fmt(f.coreSec)} s` });
        }
        else if (common !== null && ctx.bands !== null) {
            const own = new Set(bandSegmentsOf(x.s, ctx.bands, f.coreEnd).map(b => b.band));
            if (own.size <= 1 || ![...own].some(b => common.has(b))) {
                x.reasons.push({
                    code: "test",
                    detail: `touches ${own.size} band(s), none or one of the typical sequence`,
                });
            }
        }
    }
}
function groupsOf(clean) {
    const feats = clean.map(x => x.s.facts.feat);
    const next = Math.max(-1, ...clean.map(x => x.s.family)) + 1;
    const { families } = assignFamilies(feats, clean.map(x => x.s.family), next, GROUP_DISTANCE);
    return new Map(clean.map((x, k) => [x, families[k]]));
}
function endLikeBlocks(f, bands) {
    return endLikeOf(f, bands).length;
}
function endLikeOf(f, bands) {
    const end = f.endBlocks.at(-1);
    if (!end) {
        return [];
    }
    const endBand = bands ? bandOf(bands, end.level) : null;
    return f.endBlocks.filter(b => endBand !== null && bands !== null
        ? bandOf(bands, b.level) === endBand
        : b.level >= end.level / END_LEVEL_RATIO && b.level <= end.level * END_LEVEL_RATIO);
}
function longestRest(s, from, to, unitFactor) {
    const level = s.facts.restLevel;
    if (level === null) {
        return 0;
    }
    const limit = REST_LEVEL_FACTOR * level + REST_LEVEL_W / (unitFactor > 0 ? unitFactor : 1);
    let best = 0;
    let since = null;
    for (const [v, ms, at] of heldSpans(s, from, to)) {
        if (v <= limit) {
            since ??= at;
            best = Math.max(best, at + ms - since);
        }
        else {
            since = null;
        }
    }
    return best;
}
function restBetweenEnds(x, ref, bands, unitFactor) {
    const ends = endLikeOf(x.s.facts, bands);
    if (ends.length < 2) {
        return false;
    }
    const rest = longestRest(x.s, ends[0].to, ends[ends.length - 1].from, unitFactor);
    return (rest >= SPLIT_GAP_MIN_MS &&
        ref.every(y => longestRest(y.s, y.s.facts.start, y.s.facts.coreEnd, unitFactor) < rest));
}
function heldSpans(u, from, to) {
    const out = [];
    const p = u.points;
    for (let i = 0; i < p.length; i++) {
        const a = Math.max(p[i].ts, from);
        const b = Math.min(i + 1 < p.length ? p[i + 1].ts : u.to, to);
        if (b > a) {
            out.push([p[i].val, b - a, a]);
        }
    }
    return out;
}
function checkShape(runs, clean, ctx) {
    const groups = groupsOf(clean);
    const groupOf = (x) => {
        const g = groups.get(x);
        return g === undefined ? [] : clean.filter(y => y !== x && groups.get(y) === g);
    };
    for (const x of runs) {
        const f = x.s.facts;
        const feat = f.feat;
        const others = clean.filter(y => y !== x);
        const trailers = others.map(y => y.s.facts.feat.trailerSec);
        if (trailers.filter(t => t > 0).length >= TRAILER_MIN_RUNS) {
            const med = median(trailers);
            const offs = others.map(y => y.s.facts.offSec).filter((o) => o !== null);
            const offMed = offs.length >= TRAILER_MIN_RUNS ? median(offs) : null;
            const offLimit = offMed === null ? null : offMed - Math.max(TRAILER_EARLY_MIN_SEC, TRAILER_EARLY_MAD * madn(offs));
            if (feat.trailerSec < TRAILER_SHARE * med) {
                x.reasons.push({
                    code: "trailerCut",
                    detail: `trailer ${fmt(feat.trailerSec)} s, median ${fmt(med)} s`,
                });
            }
            else if (offLimit !== null && f.offSec !== null && f.offSec < offLimit) {
                x.reasons.push({
                    code: "trailerCut",
                    detail: `switched off ${fmt(f.offSec)} s after the end, others ${fmt(offMed)} s`,
                });
            }
        }
        if (!groups.has(x)) {
            continue;
        }
        const group = groupOf(x);
        const ref = group.length > 0 ? group : others;
        if (x.s.src === "history" && ref.length >= RARE_GROUP_MIN && f.offSec !== null) {
            const blocks = ref.map(y => y.s.facts.endBlocks.at(-1)).filter(b => b !== undefined);
            const endMs = blocks.length > 0 ? median(blocks.map(b => b.to - b.from)) : 0;
            const own = f.endBlocks.at(-1);
            const noEndBlock = !own || own.to - own.from < ABORT_END_BLOCK_SHARE * endMs;
            const trailerElsewhere = ref.filter(y => y.s.facts.feat.trailerSec > 0).length >= TRAILER_MIN_RUNS;
            const abrupt = f.offSec - feat.trailerSec <= ABORT_OFF_SEC + ctx.pollMs / 1000 && feat.trailerSec === 0;
            if (abrupt &&
                noEndBlock &&
                trailerElsewhere &&
                f.coreSec <
                    quantile(ref.map(y => y.s.facts.coreSec), ABORT_Q)) {
                x.reasons.push({ code: "aborted", detail: `ends abruptly after ${fmt(f.coreSec)} s` });
            }
        }
        const longest = Math.max(0, ...ref.map(y => y.s.facts.coreSec));
        const longer = ref.length > 0 && f.coreSec > MERGED_FACTOR * longest && endLikeBlocks(f, ctx.bands) >= 2;
        if (longer || restBetweenEnds(x, ref, ctx.bands, ctx.unitFactor)) {
            x.reasons.push({
                code: "merged",
                detail: longer
                    ? `${fmt(f.coreSec)} s, longest of its group ${fmt(longest)} s, two end blocks`
                    : `${fmt(f.coreSec)} s, two end blocks with a rest at the level after the end between them`,
            });
            continue;
        }
        const dur = (y) => y.s.facts.coreSec;
        const energy = (y) => y.s.facts.feat.energyWh;
        const block = (y) => Math.max(0, ...y.s.facts.endBlocks.map(b => b.to - b.from));
        const lg = (v) => Math.log(Math.max(1e-3, v));
        const twin = others.some(y => [dur, energy, block].every(pick => Math.abs(lg(pick(y)) - lg(pick(x))) <= RARE_TWIN));
        if (group.length === 0 && !twin) {
            x.reasons.push({ code: "rare", detail: "only run of its programme group" });
            continue;
        }
        const logs = (ys, pick) => ys.map(y => Math.log(Math.max(1e-3, pick(y))));
        const zOf = (pick) => {
            const v = logs(group, pick);
            return (Math.log(Math.max(1e-3, pick(x))) - median(v)) / Math.max(RARE_SPREAD_MIN, madn(v));
        };
        const far = (pick) => {
            const v = others.map(pick);
            const own = pick(x);
            return own < Math.min(...v) / RARE_FAR || own > Math.max(...v) * RARE_FAR;
        };
        if (group.length >= RARE_Z_MIN && Math.max(Math.abs(zOf(dur)), Math.abs(zOf(energy))) > RARE_Z) {
            x.reasons.push({ code: "rare", detail: "duration or energy far off within its group" });
        }
        else if (others.length >= RARE_GROUP_MIN && (far(dur) || far(energy) || far(block))) {
            x.reasons.push({ code: "rare", detail: "duration, energy or longest block far off from all runs" });
        }
    }
}
export function checkRuns(runs, ctx) {
    const w = runs.map(s => ({ s, reasons: [] }));
    checkGlobal(w, ctx);
    const intervals = [];
    let repeats = 0;
    for (const x of w) {
        const r = x.s.reports;
        if (r && r.length >= 2) {
            for (let i = 1; i < r.length; i++) {
                intervals.push(r[i] - r[i - 1]);
            }
            repeats += x.s.repeats ?? 0;
        }
    }
    const repeating = repeats >= REPEAT_MIN && repeats >= REPEAT_MIN_SHARE * intervals.length;
    const reportP999 = intervals.length > 0 && repeating ? quantile(intervals, TOP_Q) : 0;
    const cv = [];
    if (ctx.bands !== null) {
        const per = ctx.bands.bands.map(() => ({ n: 0, sum: 0, sq: 0 }));
        for (const x of w) {
            for (const p of x.s.points) {
                const b = bandOf(ctx.bands, p.val);
                if (b) {
                    const acc = per[ctx.bands.bands.indexOf(b)];
                    acc.n++;
                    acc.sum += p.val;
                    acc.sq += p.val * p.val;
                }
            }
        }
        per.forEach((a, k) => {
            const mean = a.n > 0 ? a.sum / a.n : 0;
            cv[k] = mean > 0 ? Math.sqrt(Math.max(0, a.sq / a.n - mean * mean)) / mean : 0;
        });
    }
    for (const x of w) {
        checkData(x, ctx, reportP999, cv);
    }
    checkSpikes(w);
    if (ctx.scope === "run") {
        const runs = w.filter(x => x.s.kind === "run" && x.s.info !== null && x.s.facts.feat !== null);
        checkSparse(runs);
        checkForm(w, runs.filter(x => !excluded(x.reasons)), ctx);
        if (runs.some(x => x.s.aborted)) {
            runs.filter(x => x.s.aborted).forEach(x => x.reasons.push({ code: "aborted", detail: "aborted (live)" }));
        }
        checkShape(runs, runs.filter(x => !excluded(x.reasons)), ctx);
        const old = ctx.oldStore;
        if (old) {
            for (const x of runs) {
                const f = x.s.facts;
                if (x.s.src === "history" &&
                    f.start >= old.from &&
                    f.start <= old.to &&
                    !old.keys.some(k => sameRun(k, x.s.key))) {
                    x.reasons.push({ code: "formerlyDropped", detail: "not in the old store of this time" });
                }
            }
        }
    }
    return w.map(x => ({ key: x.s.key, stage: stageOf(x.reasons), reasons: x.reasons, uses: usesOf(x.reasons) }));
}
//# sourceMappingURL=quality.js.map