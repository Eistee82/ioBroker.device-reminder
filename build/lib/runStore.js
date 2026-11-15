import { FINAL_KEYS } from "./detector/types.js";
import { bandFeaturesOf, baseBandsOf } from "./learn/bands.js";
import { assignFamilies, featuresOf } from "./learn/families.js";
import { admitted, checkRuns, sameRun, samplesOf, verdictKey } from "./learn/quality.js";
import { applyTail, buildLayout, LAYOUT_REV, LEVEL_SEP_W, MAX_PAUSE_MS, median, quantile, SPLIT_GAP_MIN_MS, tailRule, } from "./learn/runs.js";
import { decodeCells, encodeCells, fromCells, quantOf } from "./learn/ticks.js";
import { errorMessage } from "./utils.js";
export const STORE_VERSION = 1;
export const WINDOW_MS = 30 * 86_400_000;
export const MAX_RUN_META = 400;
export const MIN_PER_FAMILY = 2;
export const REPLAY_PICK_MAX = 60;
export const MAX_SPIKES = 10;
export const MAX_STORE_BYTES = 1_000_000;
export const MAX_PENDING_BYTES = 200_000;
export const MAX_CHANGES = 10;
const START_MATCH_MS = 5 * 60_000;
const POST_ROLL_MS = MAX_PAUSE_MS;
const BANDS_MIN_RUNS = 3;
const JOINED_MAX = 20;
export function markFinalSuspended(store, reason, key, now, on) {
    const final = store.final ?? { state: on ? "on" : "off", splits: [], suspendedAt: 0 };
    const was = final.state === "suspended";
    const joined = reason === "finalSplit" && !(final.joined ?? []).includes(key);
    store.final = {
        ...final,
        state: "suspended",
        splits: final.splits.includes(key) ? final.splits : [...final.splits, key],
        suspendedAt: was ? final.suspendedAt : now,
        reason,
        ...(joined ? { joined: [...(final.joined ?? []), key].slice(-JOINED_MAX) } : {}),
    };
    if (!was) {
        delete store.final.stays;
    }
    pushChange(store, {
        ts: now,
        kind: "finalSuspend",
        from: store.override,
        to: store.override,
        reason: `final phase suspended (${reason})`,
        runs: store.runs.length + store.spikes.length,
        gainSec: 0,
        trigger: key,
    });
    return was;
}
export function markFinalResumed(store, why, now, on, key) {
    const final = store.final ?? { state: "off", splits: [], suspendedAt: 0 };
    const next = { ...final, state: on ? "on" : "off", splits: [], suspendedAt: 0 };
    delete next.reason;
    delete next.stays;
    store.final = next;
    pushChange(store, {
        ts: now,
        kind: "finalResume",
        from: store.override,
        to: store.override,
        reason: `final phase used again (${why})`,
        runs: store.runs.length + store.spikes.length,
        gainSec: 0,
        ...(key ? { trigger: key } : {}),
    });
}
export const BASE_KEYS = [
    "startVal",
    "endVal",
    "standby",
    "startCount",
    "endCount",
    "mode",
    "startDurationSec",
    "endDurationSec",
    "pauseHoldSec",
    "pauseUntilSec",
    "pauseBelowVal",
    "trailerBurstSec",
    "trailerGapSec",
    "trailerAfterSec",
    "trailerBlockVal",
    "trailerMaxSec",
];
export const DETECTION_KEYS = [...BASE_KEYS, ...FINAL_KEYS];
export function detectionOf(t) {
    const out = {
        startVal: t.startVal,
        endVal: t.endVal,
        standby: t.standby,
        startCount: t.startCount,
        endCount: t.endCount,
        mode: t.mode,
        startDurationSec: t.startDurationSec,
        endDurationSec: t.endDurationSec,
        pauseHoldSec: t.pauseHoldSec ?? 0,
        pauseUntilSec: t.pauseUntilSec ?? 0,
        pauseBelowVal: t.pauseBelowVal ?? 0,
        trailerBurstSec: t.trailerBurstSec ?? 0,
        trailerGapSec: t.trailerGapSec ?? 0,
        trailerAfterSec: t.trailerAfterSec ?? 0,
        trailerBlockVal: t.trailerBlockVal ?? 0,
        trailerMaxSec: t.trailerMaxSec ?? 0,
    };
    for (const k of FINAL_KEYS) {
        out[k] = t[k] ?? 0;
    }
    return out;
}
export function typeHash(t) {
    const d = detectionOf(t);
    let text = JSON.stringify(BASE_KEYS.map(k => d[k]));
    for (const k of FINAL_KEYS) {
        const v = d[k] ?? 0;
        if (v !== 0) {
            text += `|${k}=${v}`;
        }
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}
export function emptyEnvelope() {
    return { maxPauseSec: 0, maxBurstSec: 0, maxTrailSec: 0, maxTrailerSec: 0, minRunW: 0, minCoreSec: 0, n: 0 };
}
export function emptyStore(deviceId, typeId, hash, step, unitFactor) {
    return {
        v: STORE_VERSION,
        seq: 0,
        deviceId,
        typeId,
        typeHash: hash,
        step,
        unitFactor,
        runs: [],
        spikes: [],
        pending: null,
        envelope: emptyEnvelope(),
        override: null,
        changes: [],
        lockUntilTs: 0,
        lockRuns: 0,
        lastChangeTs: 0,
        newSinceChange: 0,
        failStreak: 0,
        nextFamily: 0,
        info: {
            status: "collecting",
            runs: 0,
            spikes: 0,
            families: 0,
            trailer: "none",
            lastCheckTs: 0,
            nextPossibleTs: 0,
            lastEndDelaySec: 0,
            unclear: 0,
        },
        verdicts: {},
        legacyEnvelope: emptyEnvelope(),
        layoutRev: LAYOUT_REV,
    };
}
function slotName(deviceId, slot) {
    return `${deviceId}.${slot}.json`;
}
function isStore(val, deviceId) {
    if (typeof val !== "object" || val === null) {
        return false;
    }
    const s = val;
    return (s.v === STORE_VERSION &&
        s.deviceId === deviceId &&
        typeof s.seq === "number" &&
        Array.isArray(s.runs) &&
        Array.isArray(s.spikes) &&
        Array.isArray(s.changes) &&
        typeof s.envelope === "object");
}
export async function loadStore(io, deviceId, log) {
    let best = null;
    for (const slot of ["a", "b"]) {
        const text = await io.read(slotName(deviceId, slot));
        if (text === null) {
            continue;
        }
        try {
            const parsed = JSON.parse(text);
            if (!isStore(parsed, deviceId)) {
                log.warn(`Learning data ${slotName(deviceId, slot)} ignored: unknown format`);
                continue;
            }
            if (!best || parsed.seq > best.seq) {
                best = parsed;
            }
        }
        catch (err) {
            log.warn(`Learning data ${slotName(deviceId, slot)} ignored: ${errorMessage(err)}`);
        }
    }
    if (best) {
        best.nextFamily ??= Math.max(0, ...best.runs.map(r => r.family + 1));
        try {
            best.pending = decodePending(best.pending);
        }
        catch (err) {
            log.warn(`Learning data of ${deviceId}: capture of the last run ignored: ${errorMessage(err)}`);
            best.pending = null;
        }
    }
    return best;
}
export function toDiffs(times) {
    return times.map((t, i) => (i === 0 ? t : t - times[i - 1]));
}
export function fromDiffs(diffs) {
    if (!Array.isArray(diffs) || !diffs.every(d => typeof d === "number" && Number.isFinite(d))) {
        return undefined;
    }
    const times = [];
    for (const d of diffs) {
        times.push(times.length === 0 ? d : times.at(-1) + d);
    }
    return times;
}
export function encodePending(c) {
    const q = quantOf(c.unitFactor);
    const out = {
        t0: c.t0,
        stepMs: c.stepMs,
        unitFactor: c.unitFactor,
        ev: c.ev,
        postTruncated: c.postTruncated,
        q,
        data: encodeCells(c.cells, q),
    };
    if (c.rep) {
        out.rep = toDiffs(c.rep);
    }
    return out;
}
export function decodePendingForTest(raw) {
    return decodePending(raw);
}
function decodePending(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    const c = raw;
    if (typeof c.data !== "string" ||
        typeof c.q !== "number" ||
        typeof c.t0 !== "number" ||
        typeof c.stepMs !== "number" ||
        typeof c.unitFactor !== "number" ||
        !Array.isArray(c.ev)) {
        throw new Error("unknown format");
    }
    const out = {
        t0: c.t0,
        stepMs: c.stepMs,
        unitFactor: c.unitFactor,
        ev: c.ev,
        postTruncated: c.postTruncated === true,
        cells: decodeCells(c.data, c.q),
    };
    const rep = fromDiffs(c.rep);
    if (rep) {
        out.rep = rep;
    }
    return out;
}
export function serializeStore(store) {
    return JSON.stringify(store.pending ? { ...store, pending: encodePending(store.pending) } : store);
}
export async function saveStore(io, store) {
    store.seq++;
    await io.write(slotName(store.deviceId, store.seq % 2 === 0 ? "a" : "b"), serializeStore(store));
}
export async function removeStore(io, deviceId) {
    await io.remove(slotName(deviceId, "a"));
    await io.remove(slotName(deviceId, "b"));
}
export function reconcileBase(store, baseHash, effectiveHash, now) {
    if (store.typeHash === baseHash) {
        return "none";
    }
    store.typeHash = baseHash;
    if (store.override && effectiveHash === baseHash) {
        pushChange(store, {
            ts: now,
            kind: "adopted",
            from: store.override,
            to: null,
            reason: "values in use adopted as base values",
            runs: store.runs.length,
            gainSec: 0,
        });
        store.override = null;
        return "adopted";
    }
    pushChange(store, {
        ts: now,
        kind: "baseChanged",
        from: store.override,
        to: null,
        reason: "detection values changed",
        runs: store.runs.length,
        gainSec: 0,
    });
    store.override = null;
    store.failStreak = 0;
    if (store.info.status === "drift") {
        store.info.status = "collecting";
    }
    return "baseChanged";
}
export function reconcileStore(store, hash, step, unitFactor, now) {
    const msgs = [];
    const hadOverride = store.override !== null;
    if (reconcileBase(store, hash, null, now) === "baseChanged" && hadOverride) {
        msgs.push("detection values changed, optimised values discarded");
    }
    msgs.push(...convertRuns(store, step, unitFactor));
    refreshInfo(store);
    return msgs;
}
export function pushChange(store, c) {
    store.changes.push(c);
    while (store.changes.length > MAX_CHANGES) {
        const keys = [...store.runs, ...store.spikes].map(r => r.key);
        let lastBase = -1;
        store.changes.forEach((x, i) => {
            if (x.kind === "adopted" || x.kind === "baseChanged" || x.kind === "typeChanged") {
                lastBase = i;
            }
        });
        const kept = (x, i) => i === lastBase ||
            (x.trigger !== undefined && keys.some(k => k === x.trigger || sameRun(k, x.trigger ?? "")));
        const victim = store.changes.findIndex((x, i) => !kept(x, i));
        store.changes.splice(victim >= 0 ? victim : 0, 1);
    }
}
export function refreshInfo(store) {
    store.info.runs = store.runs.length;
    store.info.spikes = store.spikes.length;
    store.info.families = new Set(store.runs.map(r => r.family)).size;
    store.info.excluded = [...store.runs, ...store.spikes].filter(r => decisionOf(store, r.key)?.user === "exclude").length;
}
export function labelCapture(c, keepAboveW, src = "live", o = {}) {
    const sW = fromCells(c.cells, c.t0, c.stepMs, c.unitFactor);
    const unclear = { label: "unclear", run: null, endDelaySec: null, trusted: false };
    if (sW.points < 20) {
        return unclear;
    }
    const layout = buildLayout(sW, { recording: true, keepAbove: keepAboveW });
    const starts = c.ev.filter(e => e[1] === "s");
    const ends = c.ev.filter(e => e[1] !== "s");
    const mark = starts[0]?.[2];
    const q = quantOf(c.unitFactor);
    const base = {
        id: `${c.t0.toString(36)}${c.ev.length.toString(36)}`,
        ts: c.t0,
        step: c.stepMs,
        q,
        unitFactor: c.unitFactor,
        data: encodeCells(c.cells, q),
        ev: c.ev,
        src,
        postTruncated: c.postTruncated,
        family: -1,
        key: "",
        rev: LAYOUT_REV,
        ...(c.rep ? { rep: toDiffs(c.rep) } : {}),
        ...(mark ? { afterFinal: mark } : {}),
    };
    if (layout.runs.length === 0) {
        if (starts.length === 0) {
            return unclear;
        }
        const sp = layout.spikes.at(-1);
        const from = sp?.from ?? Math.max(0, Math.round((starts[0][0] - c.t0) / c.stepMs));
        const to = sp?.to ?? from;
        const run = {
            ...base,
            label: "spike",
            seg: {
                startIdx: from,
                coreEndIdx: to,
                runEndIdx: to,
                trailerFrom: null,
                trailerTo: null,
                progEndIdx: to,
                runLimit: layout.runLimit,
            },
            feat: {
                coreSec: 0,
                energyWh: 0,
                hiShare: 0,
                maxPauseSec: 0,
                nPause: 0,
                trailer: false,
                blockMean: 0,
                burstMaxSec: ((sp ? sp.to - sp.from : 0) + 1) * (c.stepMs / 1000),
                trailerSec: 0,
                minRunW: 0,
                trailerGapMaxSec: 0,
                trailerGapMinSec: 0,
                burstMaxW: 0,
                endBlockMinW: 0,
            },
        };
        return { label: "spike", run, endDelaySec: null, trusted: false };
    }
    if (layout.runs.length > 1) {
        return unclear;
    }
    const r = layout.runs[0];
    const startT = c.t0 + r.from * c.stepMs;
    const coreEndT = c.t0 + r.runEnd * c.stepMs;
    const run = {
        ...base,
        label: "run",
        seg: {
            startIdx: r.from,
            coreEndIdx: r.coreEnd,
            runEndIdx: r.runEnd,
            trailerFrom: r.trailerFrom,
            trailerTo: r.trailerTo,
            progEndIdx: r.progEnd,
            runLimit: layout.runLimit,
        },
        feat: featuresOf(sW, r, layout.runLimit),
    };
    const firstEnd = ends.find(e => e[0] >= startT);
    const endDelaySec = firstEnd ? Math.round((firstEnd[0] - coreEndT) / 1000) : null;
    if (starts.length >= 2 || ends.length >= 2 || ends.length === 0) {
        return { label: "split", run: { ...run, label: "split" }, endDelaySec, trusted: false };
    }
    const startOk = Math.abs(starts[0][0] - startT) <= START_MATCH_MS;
    let valid = true;
    for (let i = r.from; i <= r.runEnd; i++) {
        if (sW.valid[i] === 0) {
            valid = false;
            break;
        }
    }
    const postOk = (c.cells.length - 1 - r.runEnd) * c.stepMs >= POST_ROLL_MS || c.postTruncated || o.followed === true;
    if (!startOk || !valid || !postOk) {
        return unclear;
    }
    return { label: "run", run, endDelaySec, trusted: !c.postTruncated };
}
function wattsOf(c) {
    return c.cells.map(x => (x.valid && Number.isFinite(x.last) ? x.last * c.unitFactor : Number.NaN));
}
function idleOfCapture(w) {
    const valid = w.filter(x => Number.isFinite(x));
    if (valid.length === 0) {
        return 0;
    }
    const tail = valid.slice(-Math.max(3, Math.ceil(valid.length * 0.1)));
    return Math.max(0, Math.min(median(tail), tail.at(-1) ?? 0));
}
function pauseLevels(c, w, runLimit, idxOf, need) {
    const out = [];
    let runFrom = null;
    for (const e of c.ev) {
        if (e[1] === "s") {
            runFrom ??= idxOf(e[0]);
            continue;
        }
        if (runFrom === null) {
            continue;
        }
        const to = idxOf(e[0]);
        let k = runFrom;
        while (k <= to) {
            if (Number.isFinite(w[k]) && w[k] <= runLimit) {
                const from = k;
                while (k <= to && Number.isFinite(w[k]) && w[k] <= runLimit) {
                    k++;
                }
                if (k - from < need) {
                    out.push(median(w.slice(from, k)));
                }
            }
            else {
                k++;
            }
        }
        runFrom = null;
    }
    return out;
}
export function splitCapture(c) {
    const n = c.cells.length;
    const step = c.stepMs;
    const whole = [{ capture: c, ev: c.ev, followed: false }];
    if (n === 0 || c.ev.filter(e => e[1] === "s").length < 2) {
        return whole;
    }
    const w = wattsOf(c);
    const idle = idleOfCapture(w);
    const runLimit = idle * 3 + 2;
    const idxOf = (t) => Math.max(0, Math.min(n - 1, Math.round((t - c.t0) / step)));
    const need = Math.ceil(SPLIT_GAP_MIN_MS / step);
    const pauses = pauseLevels(c, w, runLimit, idxOf, need);
    const below = pauses.length === 0 || quantile(pauses, 0.9) * 1.5 + LEVEL_SEP_W < idle * 0.8;
    const above = pauses.length > 0 && quantile(pauses, 0.1) > idle * 1.5 + LEVEL_SEP_W;
    const lo = pauses.length > 0 && below ? 0.8 * idle : Number.NEGATIVE_INFINITY;
    const hi = 1.25 * idle + 0.1;
    const atRest = (k) => (below || above) && Number.isFinite(w[k]) && w[k] >= lo && w[k] <= hi;
    const cuts = [];
    const firstEv = [];
    let lastEnd = null;
    for (const [j, e] of c.ev.entries()) {
        if (e[1] !== "s") {
            lastEnd = e;
            continue;
        }
        if (!lastEnd) {
            continue;
        }
        const iE = idxOf(lastEnd[0]);
        const iS = idxOf(e[0]);
        lastEnd = null;
        let best = null;
        let k = iE + 1;
        while (k < iS) {
            if (atRest(k)) {
                const from = k;
                while (k < iS && atRest(k)) {
                    k++;
                }
                if (!best || k - from > best.len) {
                    best = { from, len: k - from };
                }
            }
            else {
                k++;
            }
        }
        let cut = null;
        if (best && best.len >= need) {
            cut = best.from + Math.floor(best.len / 2);
        }
        else if (e[2] !== undefined) {
            cut = iE + 1;
        }
        if (cut !== null && cut > (cuts.at(-1) ?? 0) && cut < n) {
            cuts.push(cut);
            firstEv.push(j);
        }
    }
    if (cuts.length === 0) {
        return whole;
    }
    const bounds = [0, ...cuts, n];
    const evBounds = [0, ...firstEv, c.ev.length];
    const parts = [];
    for (let p = 0; p + 1 < bounds.length; p++) {
        const from = bounds[p];
        const to = bounds[p + 1];
        const first = p === 0;
        const last = p + 2 === bounds.length;
        const t0 = c.t0 + from * step;
        const ev = c.ev.slice(evBounds[p], evBounds[p + 1]);
        const capture = {
            t0,
            stepMs: step,
            unitFactor: c.unitFactor,
            cells: c.cells.slice(from, to),
            ev,
            postTruncated: last ? c.postTruncated : false,
        };
        if (c.rep) {
            const lowRep = (from - 1) * step;
            const highRep = (to - 1) * step;
            capture.rep = c.rep.filter(t => (first || t > lowRep) && (last || t <= highRep)).map(t => t - from * step);
        }
        parts.push({ capture, ev, followed: !last });
    }
    return parts;
}
const JUDGED_EXITS = ["b", "c", "d", "e", "f", "g"];
function partSample(c, key, fromMs, startMs, endMs, exit) {
    const points = [];
    c.cells.forEach((x, i) => {
        const ts = c.t0 + i * c.stepMs;
        if (!x.valid || ts > endMs) {
            return;
        }
        if (ts <= fromMs) {
            points[0] = { ts: fromMs, val: x.last };
            return;
        }
        if (points.length === 0 || points[points.length - 1].val !== x.last) {
            points.push({ ts, val: x.last });
        }
    });
    return {
        points,
        from: fromMs,
        to: endMs,
        key,
        kind: "run",
        src: "live",
        info: null,
        family: -1,
        ...(exit ? { afterFinal: exit } : {}),
        starts: [startMs],
        facts: {
            start: startMs,
            coreEnd: endMs,
            progEnd: endMs,
            runEnd: endMs,
            end: endMs,
            coreSec: (endMs - startMs) / 1000,
            feat: null,
            offSec: null,
            preLevel: null,
            postLevel: null,
            restLevel: null,
            endBlocks: [],
            invalidShare: 0,
            timeJumps: 0,
        },
    };
}
export function finalSplitPairs(c, deviceId) {
    const out = [];
    c.ev.forEach((e, k) => {
        const exit = e[2];
        if (e[1] !== "s" || exit === undefined || !JUDGED_EXITS.includes(exit)) {
            return;
        }
        const before = c.ev.slice(0, k);
        const early = before.findLast(x => x[1] !== "s");
        const done = c.ev.slice(k + 1).find(x => x[1] !== "s");
        if (!early || !done) {
            return;
        }
        const begin = before.findLast(x => x[1] === "s" && x[0] <= early[0]);
        const startMs = begin ? begin[0] : c.t0;
        const key = verdictKey(deviceId, e[0]);
        out.push({
            key,
            exit,
            prev: partSample(c, verdictKey(deviceId, startMs), startMs - c.stepMs, startMs, early[0]),
            next: partSample(c, key, early[0], e[0], done[0], exit),
        });
    });
    return out;
}
const SPLIT_WITHIN_MS = 3 * 60 * 60_000;
export function joinedCapture(store, c) {
    const first = c.ev.find(e => e[1] === "s");
    if (!first || first[2] === undefined || !JUDGED_EXITS.includes(first[2])) {
        return null;
    }
    if (c.ev.some(e => e[1] !== "s" && e[0] < first[0])) {
        return null;
    }
    const prev = store.runs
        .filter(r => typeof r.data === "string" && r.step === c.stepMs && r.unitFactor === c.unitFactor && r.ts < c.t0)
        .sort((a, b) => b.ts - a.ts)[0];
    const last = prev?.ev.at(-1);
    if (!prev || !last || last[1] === "s" || first[0] - last[0] > SPLIT_WITHIN_MS) {
        return null;
    }
    const cells = decodeCells(prev.data, prev.q);
    const gap = Math.round((c.t0 - (prev.ts + cells.length * prev.step)) / c.stepMs);
    const head = gap >= 0 ? [...cells, ...new Array(gap).fill(cells[cells.length - 1])] : cells.slice(0, gap);
    return {
        t0: prev.ts,
        stepMs: c.stepMs,
        unitFactor: c.unitFactor,
        cells: [...head, ...c.cells],
        ev: [...prev.ev.filter(e => !c.ev.some(x => x[0] === e[0] && x[1] === e[1])), ...c.ev].sort((a, b) => a[0] - b[0]),
        postTruncated: c.postTruncated,
    };
}
export function envelopeOf(runs, spikes) {
    const env = emptyEnvelope();
    for (const r of runs) {
        addEnd(env, r);
        addTrailer(env, r);
    }
    for (const s of spikes) {
        env.maxBurstSec = Math.max(env.maxBurstSec, s.feat.burstMaxSec);
    }
    return env;
}
function addEnd(env, r) {
    env.maxPauseSec = Math.max(env.maxPauseSec, r.feat.maxPauseSec);
    env.minRunW = env.minRunW === 0 ? r.feat.minRunW : Math.min(env.minRunW, r.feat.minRunW);
    env.minCoreSec = env.minCoreSec === 0 ? r.feat.coreSec : Math.min(env.minCoreSec, r.feat.coreSec);
    env.n++;
}
function addTrailer(env, r) {
    env.maxBurstSec = Math.max(env.maxBurstSec, r.feat.burstMaxSec);
    env.maxTrailSec = Math.max(env.maxTrailSec, r.feat.trailerGapMaxSec ?? 0);
    env.maxTrailerSec = Math.max(env.maxTrailerSec, r.feat.trailerSec);
}
export function mergeEnvelope(a, b) {
    const lo = (x, y) => (x === 0 ? y : y === 0 ? x : Math.min(x, y));
    return {
        maxPauseSec: Math.max(a.maxPauseSec, b.maxPauseSec),
        maxBurstSec: Math.max(a.maxBurstSec, b.maxBurstSec),
        maxTrailSec: Math.max(a.maxTrailSec, b.maxTrailSec),
        maxTrailerSec: Math.max(a.maxTrailerSec, b.maxTrailerSec),
        minRunW: lo(a.minRunW, b.minRunW),
        minCoreSec: lo(a.minCoreSec, b.minCoreSec),
        n: Math.max(a.n, b.n),
    };
}
const ENVELOPE_KEYS = ["maxPauseSec", "maxBurstSec", "maxTrailSec", "maxTrailerSec", "minRunW", "minCoreSec"];
export function decisionOf(store, key) {
    const all = store.verdicts ?? {};
    const exact = all[key];
    if (exact || key === "") {
        return exact;
    }
    const near = Object.keys(all).find(k => sameRun(k, key));
    return near === undefined ? undefined : all[near];
}
export function setDecision(store, key, user, reason) {
    store.verdicts ??= {};
    if (user === null) {
        delete store.verdicts[key];
        return;
    }
    store.verdicts[key] = reason ? { user, reason } : { user };
}
export function inUse(store, r) {
    return typeof r.data === "string" && decisionOf(store, r.key)?.user !== "exclude";
}
function usesOfStore(store, verdicts) {
    const out = new Map();
    for (const r of [...store.runs, ...store.spikes]) {
        const d = decisionOf(store, r.key);
        const v = verdicts?.get(r.key);
        const ok = (purpose) => (v ? admitted({ ...v, user: d?.user }, purpose) : true);
        const excluded = d?.user === "exclude";
        const merged = v?.reasons.some(x => x.code === "merged") === true;
        const end = !excluded && !merged && ok("end");
        out.set(r, {
            excluded,
            end,
            trailer: end && r.gridFrom === undefined && ok("trailer"),
            start: !excluded && ok("start"),
        });
    }
    return out;
}
function envelopeWith(store, use, skip) {
    const env = emptyEnvelope();
    for (const r of store.runs) {
        const u = use.get(r);
        if (r === skip || !u?.end) {
            continue;
        }
        addEnd(env, r);
        if (u.trailer) {
            addTrailer(env, r);
        }
    }
    for (const s of store.spikes) {
        if (s !== skip && use.get(s)?.start) {
            env.maxBurstSec = Math.max(env.maxBurstSec, s.feat.burstMaxSec);
        }
    }
    return env;
}
function isBoundary(store, use, full, r) {
    if (use.get(r)?.excluded) {
        return false;
    }
    if (r.veto !== undefined) {
        return true;
    }
    const rest = envelopeWith(store, use, r);
    return ENVELOPE_KEYS.some(k => rest[k] !== full[k]);
}
export function boundaryRuns(store, verdicts) {
    const use = usesOfStore(store, verdicts);
    const full = envelopeWith(store, use);
    const out = new Set();
    for (const r of [...store.runs, ...store.spikes]) {
        if (isBoundary(store, use, full, r)) {
            out.add(r.key);
        }
    }
    return out;
}
export function boundaryInfo(store, verdicts) {
    const use = usesOfStore(store, verdicts);
    const legacy = store.legacyEnvelope ?? emptyEnvelope();
    const full = mergeEnvelope(legacy, envelopeWith(store, use));
    const out = new Map();
    for (const r of [...store.runs, ...store.spikes]) {
        if (use.get(r)?.excluded) {
            continue;
        }
        const rest = mergeEnvelope(legacy, envelopeWith(store, use, r));
        const limits = ENVELOPE_KEYS.filter(k => rest[k] !== full[k]).map(k => ({
            quantity: k,
            value: full[k],
            without: rest[k],
        }));
        if (limits.length > 0 || r.veto !== undefined) {
            out.set(r.key, { limits, veto: r.veto !== undefined });
        }
    }
    return out;
}
export function recomputeEnvelope(store, verdicts) {
    const own = envelopeWith(store, usesOfStore(store, verdicts));
    store.envelope = mergeEnvelope(store.legacyEnvelope ?? emptyEnvelope(), own);
}
function seriesOf(r) {
    if (typeof r.data !== "string") {
        return null;
    }
    const cells = decodeCells(r.data, r.q);
    return { cells, s: fromCells(cells, r.ts, r.step, r.unitFactor) };
}
export function recomputeTail(store, verdicts) {
    const use = usesOfStore(store, verdicts);
    const parts = [];
    for (const r of store.runs) {
        const dec = r.label === "spike" ? null : seriesOf(r);
        if (!dec) {
            continue;
        }
        const g = r.seg;
        parts.push({
            run: r,
            part: {
                s: dec.s,
                r: {
                    from: g.startIdx,
                    coreEnd: g.coreEndIdx,
                    runEnd: g.runEndIdx,
                    trailerFrom: g.trailerFrom,
                    burstMaxW: r.feat.burstMaxW ?? 0,
                    progEnd: g.progEndIdx,
                    endBlockFrom: g.coreEndIdx,
                    endBlockTo: g.coreEndIdx,
                    endBlockMinW: r.feat.endBlockMinW ?? 0,
                },
                runLimit: g.runLimit ?? 0,
            },
        });
    }
    const used = parts.filter(x => use.get(x.run)?.end);
    if (used.length === 0) {
        delete store.tail;
        return;
    }
    const tail = tailRule(used.map(x => x.part));
    for (const x of parts) {
        applyTail(x.part, tail);
        x.run.seg.progEndIdx = x.part.r.progEnd;
        x.run.feat.endBlockMinW = x.part.r.endBlockMinW;
    }
    store.tail = {
        ceil: tail.tailCeil,
        separated: tail.tailSeparated,
        burstMaxW: tail.burstMaxW,
        runLimit: median(used.map(x => x.part.runLimit)),
    };
}
function pointsOfStored(r, cells) {
    const out = [];
    const rep = r.src === "history" ? fromDiffs(r.rep) : undefined;
    if (rep && rep.length > 0) {
        for (const t of rep) {
            const c = cells[Math.max(0, Math.min(cells.length - 1, Math.ceil(t / r.step)))];
            if (c?.valid) {
                out.push({ ts: r.ts + t, val: c.last });
            }
        }
        return out;
    }
    cells.forEach((c, i) => {
        if (c.valid && (out.length === 0 || out[out.length - 1].val !== c.last)) {
            out.push({ ts: r.ts + i * r.step, val: c.last });
        }
    });
    return out;
}
function repeatsOf(cells, rep, step) {
    let n = 0;
    for (const t of rep) {
        const k = Math.ceil(t / step);
        const c = cells[k];
        const before = cells[k - 1];
        if (k >= 1 && c?.valid && before?.valid && c.min === c.max && c.last === c.min && before.last === c.last) {
            n++;
        }
    }
    return n;
}
function sampleOfStored(store, r) {
    const dec = seriesOf(r);
    if (!dec) {
        return null;
    }
    const { cells, s } = dec;
    const points = pointsOfStored(r, cells);
    const g = r.seg;
    const L0 = buildLayout(s, { recording: true, maxRuns: Number.POSITIVE_INFINITY });
    let L;
    if (r.label === "spike") {
        L = { ...L0, runs: [], spikes: [{ from: g.startIdx, to: g.coreEndIdx }], incomplete: [] };
    }
    else {
        const best = [...L0.runs].sort((a, b) => Math.abs(a.from - g.startIdx) - Math.abs(b.from - g.startIdx))[0];
        if (best) {
            const info = {
                ...best,
                from: g.startIdx,
                coreEnd: g.coreEndIdx,
                runEnd: g.runEndIdx,
                progEnd: g.progEndIdx,
                trailerFrom: g.trailerFrom,
                trailerTo: g.trailerTo,
                to: Math.max(best.to, g.trailerTo ?? g.runEndIdx),
            };
            L = {
                ...L0,
                runs: [info],
                spikes: [],
                incomplete: [],
                tailSeparated: store.tail?.separated ?? false,
                burstMaxW: store.tail?.burstMaxW ?? L0.burstMaxW,
                tailCeil: store.tail?.ceil ?? L0.tailCeil,
            };
        }
        else {
            L = { ...L0, runs: [], spikes: [], incomplete: [{ from: g.startIdx, to: g.runEndIdx }] };
        }
    }
    const sample = samplesOf(store.deviceId, points, s, L, { src: r.src, unitFactor: r.unitFactor })[0];
    if (!sample) {
        return null;
    }
    sample.key = r.key;
    sample.family = r.label === "spike" ? -1 : r.family;
    if (sample.kind === "run") {
        sample.facts.feat = r.feat;
        sample.facts.coreSec = r.feat.coreSec;
    }
    const rep = r.src === "live" ? fromDiffs(r.rep) : undefined;
    if (rep) {
        sample.reports = rep.map(t => r.ts + t);
        sample.repeats = repeatsOf(cells, rep, r.step);
    }
    sample.starts = r.ev.filter(e => e[1] === "s").map(e => e[0]);
    if (r.ev.some(e => e[1] === "a")) {
        sample.aborted = true;
    }
    if (r.afterFinal) {
        sample.afterFinal = r.afterFinal;
    }
    return { sample, series: s };
}
export function storeSamples(store, ctx) {
    const built = [];
    for (const r of [...store.runs, ...store.spikes].sort((a, b) => startOf(a) - startOf(b))) {
        const x = sampleOfStored(store, r);
        if (x) {
            built.push({ run: r, ...x });
        }
    }
    const verdicts = checkRuns(built.map(b => b.sample), ctx);
    return built.map((b, k) => ({ ...b, verdict: withDecision(store, b.run, verdicts[k]) }));
}
function withDecision(store, r, v) {
    const out = { ...v, uses: { ...v.uses } };
    const d = decisionOf(store, r.key);
    if (d?.user) {
        out.user = d.user;
    }
    if (r.gridFrom !== undefined) {
        out.uses.phases = false;
        out.uses.trailer = false;
    }
    return out;
}
export function recomputeBands(store, ctx) {
    const first = storeSamples(store, { ...ctx, bands: store.bands ? { ...store.bands, holds: [] } : null });
    const clean = first.filter(x => x.sample.kind === "run" && admitted(x.verdict, "phases"));
    const factor = store.unitFactor > 0 ? store.unitFactor : 1;
    if (clean.length >= BANDS_MIN_RUNS) {
        const runLimit = median(clean.map(x => (x.run.seg.runLimit ?? 0) / factor));
        const bands = baseBandsOf(clean.map(x => x.sample), runLimit);
        store.bands = bands;
        for (const x of first) {
            if (x.sample.kind === "run") {
                const f = bandFeaturesOf(x.sample, bands, x.sample.facts.coreEnd);
                if (f) {
                    x.run.feat.topBandSec = f.topBandSec;
                    x.run.feat.finalBandBlocks = f.finalBandBlocks;
                }
            }
        }
    }
    else {
        delete store.bands;
    }
    const second = checkRuns(first.map(x => x.sample), { ...ctx, bands: store.bands ?? null });
    return new Map(first.map((x, k) => [x.run.key, withDecision(store, x.run, second[k])]));
}
export function recompute(store, ctx) {
    const verdicts = recomputeBands(store, ctx);
    recomputeTail(store, verdicts);
    recomputeEnvelope(store, verdicts);
    return verdicts;
}
export function startOf(r) {
    return r.ts + r.seg.startIdx * r.step;
}
export function addRun(store, run, o = {}) {
    if (!run.key) {
        run.key = verdictKey(store.deviceId, startOf(run));
    }
    run.rev ??= LAYOUT_REV;
    if (run.label === "spike") {
        store.spikes.push(run);
    }
    else {
        store.runs.push(run);
    }
    const verdicts = o.ctx && !o.deferred ? recomputeBands(store, o.ctx) : undefined;
    if (verdicts) {
        o.onVerdicts?.(verdicts);
    }
    if (run.label !== "spike") {
        const fam = assignFamilies(store.runs.map(r => r.feat), store.runs.map(r => r.family), store.nextFamily ?? 0);
        store.runs.forEach((r, i) => {
            r.family = fam.families[i];
        });
        store.nextFamily = fam.nextId;
    }
    if (!o.deferred) {
        recomputeTail(store, verdicts);
    }
    recomputeEnvelope(store, verdicts);
    const now = o.now ?? run.ts + Math.max(0, (run.seg.runEndIdx + 1) * run.step);
    const evicted = fitSize(store, now, verdicts);
    refreshInfo(store);
    return evicted;
}
export function fitSize(store, now, verdicts) {
    if (store.pending?.rep && JSON.stringify(encodePending(store.pending)).length > MAX_PENDING_BYTES) {
        const lighter = { ...store.pending };
        delete lighter.rep;
        store.pending = lighter;
    }
    if (store.pending && JSON.stringify(encodePending(store.pending)).length > MAX_PENDING_BYTES) {
        store.pending = null;
    }
    const newest = Math.max(0, ...[...store.runs, ...store.spikes].map(startOf));
    return evict(store, now ?? newest, verdicts);
}
export function evict(store, now, verdicts) {
    const evicted = [];
    const use = usesOfStore(store, verdicts);
    const remove = (r) => {
        const list = store.runs.includes(r) ? store.runs : store.spikes;
        list.splice(list.indexOf(r), 1);
        evicted.push(r.id);
    };
    const counts = () => {
        const m = new Map();
        for (const r of store.runs) {
            if (!use.get(r)?.excluded) {
                m.set(r.family, (m.get(r.family) ?? 0) + 1);
            }
        }
        return m;
    };
    const step = (pool, perFamily) => {
        const full = envelopeWith(store, use);
        const count = counts();
        for (const r of pool()) {
            if (use.get(r)?.excluded) {
                remove(r);
                return true;
            }
            if (perFamily && (count.get(r.family) ?? 0) <= MIN_PER_FAMILY) {
                continue;
            }
            if (!isBoundary(store, use, full, r)) {
                remove(r);
                return true;
            }
        }
        return false;
    };
    const old = (r) => now - r.ts > WINDOW_MS;
    const byTs = (a, b) => a.ts - b.ts;
    const historyFirst = (a, b) => (a.src === "history" ? 0 : 1) - (b.src === "history" ? 0 : 1) || byTs(a, b);
    const over = () => store.runs.length > MAX_RUN_META || sizeOf(store) > MAX_STORE_BYTES;
    while (step(() => store.runs.filter(old).sort(historyFirst), true)) {
    }
    while (step(() => store.spikes.filter(old).sort(byTs), false)) {
    }
    if (sizeOf(store) > MAX_STORE_BYTES) {
        for (const r of [...store.runs, ...store.spikes].filter(x => use.get(x)?.excluded && x.data).sort(byTs)) {
            delete r.data;
            if (sizeOf(store) <= MAX_STORE_BYTES) {
                break;
            }
        }
    }
    while (store.runs.length > MAX_RUN_META) {
        const ex = store.runs.filter(x => use.get(x)?.excluded).sort(byTs)[0];
        if (!ex) {
            break;
        }
        remove(ex);
    }
    while (over() && step(() => store.runs.filter(r => r.src === "history").sort(byTs), true)) {
    }
    while (over() &&
        step(() => {
            const count = counts();
            return [...store.runs].sort((a, b) => (count.get(b.family) ?? 0) - (count.get(a.family) ?? 0) || byTs(a, b));
        }, true)) {
    }
    while (store.spikes.length > MAX_SPIKES || (sizeOf(store) > MAX_STORE_BYTES && store.spikes.length > 0)) {
        if (!step(() => [...store.spikes].sort(byTs), false)) {
            if (store.spikes.length <= MAX_SPIKES) {
                break;
            }
            remove([...store.spikes].sort(byTs)[0]);
        }
    }
    while (over() && step(() => [...store.runs].sort(byTs), false)) {
    }
    if (evicted.length > 0) {
        recomputeEnvelope(store, verdicts);
        refreshInfo(store);
    }
    return evicted;
}
export function sizeOf(store) {
    return serializeStore(store).length;
}
export function upgradeStore(store, keepAboveW) {
    const msgs = [];
    let changed = store.layoutRev !== LAYOUT_REV;
    if (typeof store.verdicts !== "object" || store.verdicts === null || Array.isArray(store.verdicts)) {
        store.verdicts = {};
    }
    if (!store.legacyEnvelope) {
        store.legacyEnvelope = { ...emptyEnvelope(), ...store.envelope };
        changed = true;
    }
    let again = 0;
    for (const r of [...store.runs, ...store.spikes]) {
        if (((r.rev ?? 0) < LAYOUT_REV || r.seg.runLimit === undefined) && typeof r.data === "string") {
            changed = true;
            if (resegment(r, keepAboveW)) {
                again++;
            }
        }
        const g = r.seg;
        if (!Number.isInteger(g.progEndIdx)) {
            g.progEndIdx = g.runEndIdx;
            changed = true;
        }
        if (!Number.isFinite(r.feat.burstMaxW)) {
            r.feat.burstMaxW = 0;
            changed = true;
        }
        if (!Number.isFinite(r.feat.endBlockMinW)) {
            r.feat.endBlockMinW = r.label === "spike" ? 0 : r.feat.minRunW;
            changed = true;
        }
        if (typeof r.key !== "string" || r.key === "") {
            r.key = verdictKey(store.deviceId, startOf(r));
            changed = true;
        }
    }
    if (store.bands) {
        for (const b of store.bands.bands) {
            if (typeof b.max !== "number") {
                b.max = Number.POSITIVE_INFINITY;
            }
        }
    }
    if (!changed) {
        return msgs;
    }
    store.layoutRev = LAYOUT_REV;
    recomputeTail(store);
    recomputeEnvelope(store);
    refreshInfo(store);
    msgs.push(again > 0
        ? `learning data brought to the current version, ${again} stored runs segmented again`
        : "learning data brought to the current version");
    return msgs;
}
function resegment(r, keepAboveW) {
    const dec = seriesOf(r);
    if (!dec) {
        return false;
    }
    const L = buildLayout(dec.s, {
        recording: true,
        maxRuns: Number.POSITIVE_INFINITY,
        ...(keepAboveW !== undefined ? { keepAbove: keepAboveW } : {}),
    });
    r.rev = LAYOUT_REV;
    r.seg.runLimit = L.runLimit;
    if (r.label === "spike") {
        return false;
    }
    const g = r.seg;
    const best = [...L.runs].sort((a, b) => Math.abs(a.from - g.startIdx) - Math.abs(b.from - g.startIdx))[0];
    if (!best) {
        return false;
    }
    const bands = { topBandSec: r.feat.topBandSec, finalBandBlocks: r.feat.finalBandBlocks };
    r.seg = {
        startIdx: best.from,
        coreEndIdx: best.coreEnd,
        runEndIdx: best.runEnd,
        trailerFrom: best.trailerFrom,
        trailerTo: best.trailerTo,
        progEndIdx: best.progEnd,
        runLimit: L.runLimit,
    };
    const feat = featuresOf(dec.s, best, L.runLimit);
    if (bands.topBandSec !== undefined && bands.finalBandBlocks !== undefined) {
        feat.topBandSec = bands.topBandSec;
        feat.finalBandBlocks = bands.finalBandBlocks;
    }
    r.feat = feat;
    return true;
}
function regrid(cells, from, to) {
    if (cells.length === 0 || from === to) {
        return [...cells];
    }
    const n = Math.floor(((cells.length - 1) * from) / to) + 1;
    const out = [];
    for (let j = 0; j < n; j++) {
        const t = j * to;
        const hi = Math.min(cells.length - 1, Math.floor(t / from));
        if (to > from) {
            const lo = j === 0 ? 0 : Math.floor((t - to) / from) + 1;
            let min = Number.POSITIVE_INFINITY;
            let max = Number.NEGATIVE_INFINITY;
            let valid = true;
            for (let i = Math.max(0, lo); i <= hi; i++) {
                const c = cells[i];
                valid &&= c.valid;
                if (c.valid) {
                    min = Math.min(min, c.min, c.last);
                    max = Math.max(max, c.max, c.last);
                }
            }
            const last = cells[hi].last;
            out.push({ min: Number.isFinite(min) ? min : last, max: Number.isFinite(max) ? max : last, last, valid });
        }
        else {
            const c = cells[hi];
            out.push(t === hi * from ? { ...c } : { min: c.last, max: c.last, last: c.last, valid: c.valid });
        }
    }
    return out;
}
function rescale(cells, factor) {
    return factor === 1
        ? cells
        : cells.map(c => ({ min: c.min * factor, max: c.max * factor, last: c.last * factor, valid: c.valid }));
}
function convertRun(r, step, unitFactor) {
    const q = quantOf(unitFactor);
    if (typeof r.data === "string") {
        const cells = rescale(regrid(decodeCells(r.data, r.q), r.step, step), r.unitFactor / unitFactor);
        r.data = encodeCells(cells, q);
        const last = cells.length - 1;
        const idx = (i) => Math.max(0, Math.min(last, Math.round((i * r.step) / step)));
        const g = r.seg;
        r.seg = {
            ...g,
            startIdx: idx(g.startIdx),
            coreEndIdx: idx(g.coreEndIdx),
            runEndIdx: idx(g.runEndIdx),
            trailerFrom: g.trailerFrom === null ? null : idx(g.trailerFrom),
            trailerTo: g.trailerTo === null ? null : idx(g.trailerTo),
            progEndIdx: idx(g.progEndIdx),
        };
    }
    if (step < r.step) {
        r.gridFrom = Math.max(r.gridFrom ?? r.step, r.step);
    }
    else if (r.gridFrom !== undefined && step >= r.gridFrom) {
        delete r.gridFrom;
    }
    r.step = step;
    r.unitFactor = unitFactor;
    r.q = q;
}
export function convertRuns(store, step, unitFactor) {
    if (store.step === step && store.unitFactor === unitFactor) {
        return [];
    }
    const all = [...store.runs, ...store.spikes];
    for (const r of all) {
        convertRun(r, step, unitFactor);
    }
    if (store.pending) {
        const c = store.pending;
        store.pending = {
            ...c,
            cells: rescale(regrid(c.cells, c.stepMs, step), c.unitFactor / unitFactor),
            stepMs: step,
            unitFactor,
        };
    }
    if (store.bands && store.unitFactor !== unitFactor) {
        const k = store.unitFactor / unitFactor;
        store.bands = {
            ...store.bands,
            runLimit: store.bands.runLimit * k,
            bands: store.bands.bands.map(b => ({ ...b, min: b.min * k, max: b.max * k })),
        };
    }
    const what = `poll interval ${store.step / 1000} s → ${step / 1000} s, unit factor ${store.unitFactor} → ${unitFactor}`;
    store.step = step;
    store.unitFactor = unitFactor;
    return all.length > 0 ? [`${what}: ${all.length} stored runs converted`] : [];
}
export function clearLearningData(store, keepDecisions) {
    const out = emptyStore(store.deviceId, store.typeId, store.typeHash, store.step, store.unitFactor);
    out.seq = store.seq;
    if (store.lastSeenTs !== undefined) {
        out.lastSeenTs = store.lastSeenTs;
    }
    if (keepDecisions) {
        for (const [key, d] of Object.entries(store.verdicts ?? {})) {
            if (d.user) {
                out.verdicts[key] = d.reason ? { user: d.user, reason: d.reason } : { user: d.user };
            }
        }
    }
    return out;
}
//# sourceMappingURL=runStore.js.map