import { assignFamilies } from "./learn/families.js";
import { buildLayout, MAX_PAUSE_MS, MAX_WINDOWS, median } from "./learn/runs.js";
import { encodeCells, fromCells, quantOf } from "./learn/ticks.js";
import { errorMessage } from "./utils.js";
export const STORE_VERSION = 1;
export const MAX_RUNS = MAX_WINDOWS;
export const MAX_SPIKES = 10;
export const MAX_STORE_BYTES = 400_000;
export const MAX_CHANGES = 10;
const START_MATCH_MS = 5 * 60_000;
const POST_ROLL_MS = MAX_PAUSE_MS;
export const DETECTION_KEYS = [
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
export function detectionOf(t) {
    return {
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
}
export function typeHash(t) {
    const text = JSON.stringify(DETECTION_KEYS.map(k => detectionOf(t)[k]));
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
        let text = null;
        try {
            text = await io.read(slotName(deviceId, slot));
        }
        catch (err) {
            log.debug(`Learning data ${slotName(deviceId, slot)} not readable: ${errorMessage(err)}`);
        }
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
    }
    return best;
}
export async function saveStore(io, store) {
    store.seq++;
    await io.write(slotName(store.deviceId, store.seq % 2 === 0 ? "a" : "b"), JSON.stringify(store));
}
export async function removeStore(io, deviceId) {
    await io.remove(slotName(deviceId, "a"));
    await io.remove(slotName(deviceId, "b"));
}
export function reconcileStore(store, typeId, hash, step, unitFactor, now) {
    const msgs = [];
    if (store.typeId !== typeId || store.typeHash !== hash) {
        if (store.override) {
            pushChange(store, {
                ts: now,
                kind: "typeChanged",
                from: store.override,
                to: null,
                reason: "device type changed",
                runs: store.runs.length,
                gainSec: 0,
            });
            msgs.push("device type changed, optimised values discarded");
        }
        store.override = null;
        store.typeId = typeId;
        store.typeHash = hash;
        store.failStreak = 0;
        if (store.info.status === "drift") {
            store.info.status = "collecting";
        }
    }
    if (store.step !== step || store.unitFactor !== unitFactor) {
        if (store.runs.length + store.spikes.length > 0) {
            msgs.push("poll interval or unit changed, stored runs discarded");
        }
        store.runs = [];
        store.spikes = [];
        store.pending = null;
        store.step = step;
        store.unitFactor = unitFactor;
    }
    refreshInfo(store);
    return msgs;
}
export function pushChange(store, c) {
    store.changes.push(c);
    if (store.changes.length > MAX_CHANGES) {
        store.changes.splice(0, store.changes.length - MAX_CHANGES);
    }
}
export function refreshInfo(store) {
    store.info.runs = store.runs.length;
    store.info.spikes = store.spikes.length;
    store.info.families = new Set(store.runs.map(r => r.family)).size;
}
function featuresOf(s, r, runLimit) {
    const stepSec = s.stepMs / 1000;
    const active = [];
    let energy = 0;
    let peak = 0;
    for (let i = r.from; i <= r.coreEnd; i++) {
        energy += s.last[i] * stepSec;
        if (s.last[i] > runLimit) {
            active.push(s.last[i]);
            peak = Math.max(peak, s.last[i]);
        }
    }
    const hi = active.filter(v => v >= 0.5 * peak).length;
    const pauses = r.gaps.map(g => (g.to - g.from + 1) * stepSec);
    let trailGap = 0;
    for (let k = 1; k < r.bursts.length; k++) {
        trailGap = Math.max(trailGap, (r.bursts[k].from - r.bursts[k - 1].to - 1) * stepSec);
    }
    return {
        coreSec: (r.coreEnd - r.from + 1) * stepSec,
        energyWh: energy / 3600,
        hiShare: active.length > 0 ? hi / active.length : 0,
        maxPauseSec: pauses.length > 0 ? Math.max(...pauses) : 0,
        nPause: pauses.length,
        trailer: r.bursts.length >= 2,
        blockMean: r.blockMean,
        burstMaxSec: r.burstMaxMs / 1000,
        trailerSec: r.trailerTo !== null ? (r.trailerTo - r.coreEnd) * stepSec : 0,
        minRunW: median(active),
        trailerGapMaxSec: trailGap,
        trailerGapMinSec: r.gapMinMs / 1000,
    };
}
export function labelCapture(c, keepAboveW, src = "live") {
    const sW = fromCells(c.cells, c.t0, c.stepMs, c.unitFactor);
    const unclear = { label: "unclear", run: null, endDelaySec: null, trusted: false };
    if (sW.points < 20) {
        return unclear;
    }
    const layout = buildLayout(sW, { recording: true, keepAbove: keepAboveW });
    const starts = c.ev.filter(e => e[1] === "s");
    const ends = c.ev.filter(e => e[1] !== "s");
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
            seg: { startIdx: from, coreEndIdx: to, runEndIdx: to, trailerFrom: null, trailerTo: null },
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
    const postOk = (c.cells.length - 1 - r.runEnd) * c.stepMs >= POST_ROLL_MS || c.postTruncated;
    if (!startOk || !valid || !postOk) {
        return unclear;
    }
    return { label: "run", run, endDelaySec, trusted: !c.postTruncated };
}
export function envelopeOf(runs, spikes) {
    const env = emptyEnvelope();
    for (const r of runs) {
        env.maxPauseSec = Math.max(env.maxPauseSec, r.feat.maxPauseSec);
        env.maxBurstSec = Math.max(env.maxBurstSec, r.feat.burstMaxSec);
        env.maxTrailSec = Math.max(env.maxTrailSec, r.feat.trailerGapMaxSec ?? 0);
        env.maxTrailerSec = Math.max(env.maxTrailerSec, r.feat.trailerSec);
        env.minRunW = env.minRunW === 0 ? r.feat.minRunW : Math.min(env.minRunW, r.feat.minRunW);
        env.minCoreSec = env.minCoreSec === 0 ? r.feat.coreSec : Math.min(env.minCoreSec, r.feat.coreSec);
        env.n++;
    }
    for (const s of spikes) {
        env.maxBurstSec = Math.max(env.maxBurstSec, s.feat.burstMaxSec);
    }
    return env;
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
export function addRun(store, run) {
    const evicted = [];
    if (run.label === "spike") {
        store.spikes.push(run);
        while (store.spikes.length > MAX_SPIKES) {
            evicted.push(store.spikes.shift().id);
        }
    }
    else {
        store.runs.push(run);
        const fam = assignFamilies(store.runs.map(r => r.feat), store.runs.map(r => r.family), store.nextFamily ?? 0);
        store.runs.forEach((r, i) => {
            r.family = fam.families[i];
        });
        store.nextFamily = fam.nextId;
    }
    const prevN = store.envelope.n;
    store.envelope = mergeEnvelope(store.envelope, envelopeOf(store.runs, store.spikes));
    store.envelope.n = prevN + (run.label === "spike" ? 0 : 1);
    while (store.runs.length > MAX_RUNS || (sizeOf(store) > MAX_STORE_BYTES && store.runs.length > 2)) {
        const victim = pickVictim(store);
        if (victim < 0) {
            break;
        }
        evicted.push(store.runs[victim].id);
        store.runs.splice(victim, 1);
    }
    while (sizeOf(store) > MAX_STORE_BYTES && store.spikes.length > 0) {
        evicted.push(store.spikes.shift().id);
    }
    refreshInfo(store);
    return evicted;
}
export function sizeOf(store) {
    return JSON.stringify(store).length;
}
function pickVictim(store) {
    const count = new Map();
    for (const r of store.runs) {
        count.set(r.family, (count.get(r.family) ?? 0) + 1);
    }
    const full = envelopeOf(store.runs, []);
    const binding = (i) => {
        const rest = envelopeOf(store.runs.filter((_, k) => k !== i), []);
        return ENVELOPE_KEYS.some(k => rest[k] !== full[k]);
    };
    const candidates = store.runs
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => (count.get(r.family) ?? 0) > 2)
        .sort((a, b) => (a.r.src === "history" ? 0 : 1) - (b.r.src === "history" ? 0 : 1) ||
        (count.get(b.r.family) ?? 0) - (count.get(a.r.family) ?? 0) ||
        a.r.ts - b.r.ts);
    const free = candidates.find(c => !binding(c.i));
    if (free) {
        return free.i;
    }
    if (candidates.length > 0) {
        return candidates[0].i;
    }
    return store.runs.length > 0 ? 0 : -1;
}
//# sourceMappingURL=runStore.js.map