import { holdProfile, learnBands } from "../learn/bands.js";
import { admitted } from "../learn/quality.js";
import { SYSTEM_PHASES } from "./model.js";
import { replayPhases } from "./tracker.js";
const CONTINUOUS_RUNS_PER_DAY = 6;
const CONTINUOUS_REST_MIN = 30;
const JUMP_RATIO = 2;
const RHYTHM_JUMPS_PER_MIN = 1;
const DEBOUNCE_SEC = 5;
const MEDIAN_DIP_SEC = 60;
const BLOCK_DIP_SEC = 30;
const LEVEL_DIPS_PER_MIN = 1;
const LEVEL_DIP_MAX_SEC = 30;
const LEVEL_WINDOW_FACTOR = 3;
const LEVEL_HOLD_SHARE = 0.75;
const ROUND_SEC = 15;
const PEAK_FACTOR = 2;
const PEAK_EXCURSION_SHARE = 0.5;
const CLASS_RATIO = 2;
const MIN_UNITS = 3;
const EVENT_SHARE = 0.8;
const EVENT_MAX_CONFIRM = 2;
const EVENT_Q = 0.95;
const STABLE_RATIO = 1.1;
const STABLE_SEC = 30;
const AGREE_MIN = 0.99;
const FLICKER_MAX = 1.2;
const OPEN_FACTOR = 10;
const START_SHARE = 0.5;
const NEUTRAL_TEMPLATE = "Phase {n}";
const OLD_GENERATED = / · ≈ -?\d+ \S+ · \d+–\d+ \S+$/u;
const BAND_GENERATED = /^≈ -?\d+ W$/u;
export function scopeOf(runsPerDay, medianRestMin) {
    return runsPerDay > CONTINUOUS_RUNS_PER_DAY || medianRestMin < CONTINUOUS_REST_MIN ? "continuous" : "run";
}
function quantile(sorted, q) {
    if (sorted.length === 0) {
        return Number.NaN;
    }
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
function median(values) {
    const s = [...values].sort((a, b) => a - b);
    if (s.length === 0) {
        return Number.NaN;
    }
    const m = s.length >> 1;
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round15(sec) {
    return Math.max(ROUND_SEC, Math.round(sec / ROUND_SEC) * ROUND_SEC);
}
function overlap(a, b) {
    const finite = [a[0], a[1], b[0], b[1]].filter(x => Number.isFinite(x) && x > 0);
    const cap = OPEN_FACTOR * Math.max(1, ...finite);
    const lo = (x) => Math.log(Math.max(1e-9, x));
    const hi = (x) => Math.log(Math.min(cap, Number.isFinite(x) ? x : cap));
    const [a0, a1, b0, b1] = [lo(a[0]), hi(a[1]), lo(b[0]), hi(b[1])];
    const inter = Math.min(a1, b1) - Math.max(a0, b0);
    const union = Math.max(a1, b1) - Math.min(a0, b0);
    return inter > 0 && union > 0 ? inter / union : 0;
}
function rhythmic(units, runLimit) {
    const rates = [];
    for (const u of units) {
        const p = u.points;
        let jumps = 0;
        let active = 0;
        for (let i = 0; i + 1 < p.length; i++) {
            if (p[i].val <= runLimit && p[i + 1].val <= runLimit) {
                continue;
            }
            active += p[i + 1].ts - p[i].ts;
            const x = Math.max(p[i].val, runLimit);
            const y = Math.max(p[i + 1].val, runLimit);
            if (Math.max(x, y) >= JUMP_RATIO * Math.min(x, y)) {
                jumps++;
            }
        }
        if (active > 0) {
            rates.push(jumps / (active / 60_000));
        }
    }
    return rates.length > 0 && median(rates) >= RHYTHM_JUMPS_PER_MIN;
}
function runOf(u) {
    return { start: u.facts.start, end: Math.max(u.facts.start, u.facts.coreEnd) };
}
function bandSegments(model, units, pollSec, holds) {
    const index = new Map(model.bands.map((b, k) => [b.id, k]));
    return units.map((u, n) => {
        const runs = model.scope === "run" ? [runOf(u)] : undefined;
        const { timeline } = replayPhases(model, u.points, pollSec, runs, { holds });
        const out = [];
        let pred = model.scope === "run" ? "idle" : null;
        for (const s of timeline) {
            const band = s.id === SYSTEM_PHASES.rest ? -1 : (index.get(s.id) ?? -2);
            const seg = { band, from: s.from, to: s.to, pred, unit: n, closed: s.final, next: null };
            const prev = out.at(-1);
            if (prev) {
                prev.next = seg;
            }
            out.push(seg);
            pred = band === -1 ? "idle" : band >= 0 ? "active" : null;
        }
        return out;
    });
}
function smoothingOf(bands, units, raw, scope, pollSec, holds) {
    if (raw) {
        const lengths = bands.map(() => []);
        const above = bands.map(() => 0);
        const bandIdx = (v) => bands.findIndex(b => v >= b.min && v < b.max);
        for (const u of units) {
            const p = u.points;
            const runs = [];
            for (const x of p) {
                const k = bandIdx(x.val);
                const last = runs.at(-1);
                if (last && last.k === k) {
                    continue;
                }
                if (last) {
                    last.to = x.ts;
                }
                runs.push({ k, from: x.ts, to: x.ts });
            }
            for (let i = 1; i + 1 < runs.length; i++) {
                const r = runs[i];
                if (r.k < 0) {
                    continue;
                }
                lengths[r.k].push((r.to - r.from) / 1000);
                if (runs[i - 1].k < r.k && runs[i + 1].k < r.k) {
                    above[r.k]++;
                }
            }
        }
        return bands.map((b, k) => {
            const peak = lengths[k].length > 0 &&
                median(lengths[k]) < PEAK_FACTOR * DEBOUNCE_SEC &&
                above[k] >= PEAK_EXCURSION_SHARE * lengths[k].length;
            return {
                id: b.id,
                name: b.id,
                min: b.min,
                max: b.max,
                smoothing: peak ? "peak" : "debounce",
                dipSec: DEBOUNCE_SEC,
                windowSec: 0,
            };
        });
    }
    const provisional = modelOf(scope, bands.map(b => ({ ...b, name: b.id, smoothing: "block", dipSec: BLOCK_DIP_SEC, windowSec: 0 })), []);
    const segs = bandSegments(provisional, units, pollSec, holds);
    const dips = bands.map(() => []);
    const minutes = bands.map(() => 0);
    segs.forEach((list, n) => {
        const p = units[n].points;
        for (const s of list) {
            if (s.band < 0) {
                continue;
            }
            const b = bands[s.band];
            minutes[s.band] += (s.to - s.from) / 60_000;
            let below = null;
            for (const x of p) {
                if (x.ts < s.from || x.ts >= s.to) {
                    continue;
                }
                if (x.val < b.min) {
                    below ??= x.ts;
                }
                else if (below !== null) {
                    dips[s.band].push((x.ts - below) / 1000);
                    below = null;
                }
            }
        }
    });
    return bands.map((b, k) => {
        const d = [...dips[k]].sort((x, y) => x - y);
        const p99 = quantile(d, 0.99);
        const level = minutes[k] > 0 && d.length / minutes[k] >= LEVEL_DIPS_PER_MIN && p99 < LEVEL_DIP_MAX_SEC;
        const smoothing = level ? "level" : "block";
        const windowSec = level ? round15(LEVEL_WINDOW_FACTOR * p99) : 0;
        return {
            id: b.id,
            name: b.id,
            min: b.min,
            max: b.max,
            smoothing,
            dipSec: level ? round15(LEVEL_HOLD_SHARE * windowSec) : BLOCK_DIP_SEC,
            windowSec,
        };
    });
}
function modelOf(scope, bands, phases) {
    return { v: 1, enabled: false, scope, bands, phases, learnedAt: 0, quality: { agreement: 0, runsUsed: 0 } };
}
function eventOf(k, segs, units) {
    const entries = segs.flat().filter(s => s.band === k && s.next !== null);
    if (entries.length === 0) {
        return null;
    }
    const count = new Map();
    for (const s of entries) {
        const b = s.next.band;
        if (b >= 0) {
            count.set(b, (count.get(b) ?? 0) + 1);
        }
    }
    const order = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const confirm = [];
    let covered = 0;
    for (const [b, c] of order) {
        if (covered >= EVENT_SHARE * entries.length || confirm.length >= EVENT_MAX_CONFIRM) {
            break;
        }
        confirm.push(b);
        covered += c;
    }
    if (covered < EVENT_SHARE * entries.length) {
        return null;
    }
    const hits = entries.filter(s => confirm.includes(s.next.band));
    const unitsSeen = new Set(hits.map(s => s.unit));
    if (unitsSeen.size < MIN_UNITS) {
        return null;
    }
    const toConfirm = hits.map(s => (s.next.from - s.from) / 1000).sort((a, b) => a - b);
    const tails = hits
        .map(s => {
        const p = units[s.unit].points;
        const follow = s.next;
        for (let i = 0; i < p.length; i++) {
            if (p[i].ts < follow.from) {
                continue;
            }
            if (p[i].ts >= follow.to) {
                break;
            }
            const base = p[i].val;
            let stable = true;
            for (let j = i; j < p.length && p[j].ts < p[i].ts + STABLE_SEC * 1000; j++) {
                const v = p[j].val;
                if (v > base * STABLE_RATIO || v * STABLE_RATIO < base) {
                    stable = false;
                    break;
                }
            }
            if (stable) {
                return (p[i].ts - s.from) / 1000;
            }
        }
        return (follow.to - s.from) / 1000;
    })
        .sort((a, b) => a - b);
    const tailSec = Math.ceil(quantile(tails, EVENT_Q));
    return {
        band: k,
        minSec: 0,
        maxSec: 0,
        decided: "live",
        trigger: { confirm, confirmSec: Math.max(1, Math.ceil(quantile(toConfirm, EVENT_Q))), tailSec },
        lo: tails[0],
        hi: tails.at(-1),
        units: unitsSeen,
        lastSeen: Math.max(...hits.map(s => s.next.from)),
    };
}
function classesOf(k, segs) {
    const list = segs
        .flat()
        .filter(s => s.band === k && s.closed)
        .map(s => ({ s, sec: (s.to - s.from) / 1000 }))
        .filter(x => x.sec > 0)
        .sort((a, b) => a.sec - b.sec);
    if (new Set(list.map(x => x.s.unit)).size < MIN_UNITS) {
        return [];
    }
    const groups = [];
    for (const x of list) {
        const g = groups.at(-1);
        if (g && x.sec < CLASS_RATIO * g.at(-1).sec) {
            g.push(x);
        }
        else {
            groups.push([x]);
        }
    }
    const unitsOf = (g) => new Set(g.map(x => x.s.unit)).size;
    for (;;) {
        const weak = groups
            .map((g, i) => ({ i, n: unitsOf(g) }))
            .filter(x => x.n < MIN_UNITS)
            .sort((a, b) => a.n - b.n || a.i - b.i)[0];
        if (!weak || groups.length === 1) {
            break;
        }
        const i = weak.i;
        const gapLeft = i > 0 ? groups[i][0].sec / groups[i - 1].at(-1).sec : Infinity;
        const gapRight = i + 1 < groups.length ? groups[i + 1][0].sec / groups[i].at(-1).sec : Infinity;
        const j = gapLeft <= gapRight ? i - 1 : i + 1;
        const [a, b] = j < i ? [j, i] : [i, j];
        groups.splice(a, 2, [...groups[a], ...groups[b]]);
    }
    const bounds = groups.slice(1).map((g, i) => Math.round(Math.sqrt(groups[i].at(-1).sec * g[0].sec)));
    const out = [];
    groups.forEach((g, i) => {
        const base = {
            band: k,
            minSec: i > 0 ? bounds[i - 1] : 0,
            maxSec: i < bounds.length ? bounds[i] : 0,
            decided: i < bounds.length ? "end" : "live",
        };
        const draft = (members, ctx) => ({
            ...base,
            ...(ctx ? { ctx } : {}),
            lo: members[0].sec,
            hi: members.at(-1).sec,
            units: new Set(members.map(x => x.s.unit)),
            lastSeen: Math.max(...members.map(x => x.s.to)),
        });
        const idle = g.filter(x => x.s.pred === "idle");
        const active = g.filter(x => x.s.pred === "active");
        const enough = (m) => m.length >= MIN_UNITS && unitsOf(m) >= MIN_UNITS;
        if (enough(idle) && enough(active)) {
            out.push(draft(idle, "idle"), draft(active, "active"));
        }
        else {
            out.push(draft(g));
        }
    });
    return out;
}
function mergedOf(k, segs, scope) {
    const runs = segs.filter(list => list.length > 0).length;
    const list = segs.flat().filter(s => s.band === k && s.closed && s.to > s.from);
    const unitsOf = (m) => new Set(m.map(s => s.unit)).size;
    const all = unitsOf(list);
    if (all < MIN_UNITS) {
        return [];
    }
    const draft = (members, ctx) => {
        const sec = members.map(s => (s.to - s.from) / 1000).sort((a, b) => a - b);
        return {
            band: k,
            minSec: 0,
            maxSec: 0,
            decided: "live",
            ...(ctx ? { ctx } : {}),
            lo: sec[0],
            hi: sec.at(-1),
            units: new Set(members.map(s => s.unit)),
            lastSeen: Math.max(...members.map(s => s.to)),
        };
    };
    const idle = list.filter(s => s.pred === "idle");
    const active = list.filter(s => s.pred === "active");
    const enough = (m) => m.length >= MIN_UNITS && unitsOf(m) >= MIN_UNITS;
    const common = scope === "continuous" || unitsOf(idle) >= START_SHARE * runs;
    if (enough(idle) && enough(active) && common) {
        return [draft(idle, "idle"), draft(active, "active")];
    }
    return [draft(list)];
}
function draftsOf(bands, segs, units, scope) {
    const out = [];
    bands.forEach((b, k) => {
        const ev = b.smoothing === "peak" ? eventOf(k, segs, units) : null;
        if (ev) {
            out.push(ev);
        }
        else {
            out.push(...mergedOf(k, segs, scope));
        }
    });
    return out;
}
function phasesOf(drafts, ids, bands, scope) {
    return drafts.map((d, i) => {
        const p = {
            id: ids[i],
            name: ids[i],
            band: bands[d.band].id,
            minSec: d.minSec,
            maxSec: d.maxSec,
            decided: d.decided,
            show: true,
            stats: { runs: d.units.size, agreement: 0, lastSeen: d.lastSeen },
        };
        if (d.ctx === "idle") {
            p.after = scope === "run" ? ["start", "idle"] : ["idle"];
        }
        else if (d.ctx === "active") {
            p.after = drafts.flatMap((o, j) => (o.band !== d.band ? [ids[j]] : []));
        }
        if (d.trigger) {
            p.trigger = {
                confirm: d.trigger.confirm.map(k => bands[k].id),
                confirmSec: d.trigger.confirmSec,
                tailSec: d.trigger.tailSec,
            };
        }
        return p;
    });
}
function mapDrafts(fold, full) {
    const pairs = [];
    fold.forEach((f, i) => full.forEach((g, j) => {
        if (f.band !== g.band || !f.trigger !== !g.trigger || f.ctx !== g.ctx) {
            return;
        }
        const score = f.trigger ? 1 : overlap([f.lo, f.hi], [g.lo, g.hi]);
        if (score > 0) {
            pairs.push({ i, j, score });
        }
    }));
    pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
    const out = fold.map(() => null);
    const used = new Set();
    for (const p of pairs) {
        if (out[p.i] === null && !used.has(p.j)) {
            out[p.i] = p.j;
            used.add(p.j);
        }
    }
    return out;
}
function withoutPhases(m, drop) {
    let phases = m.phases.filter(p => !drop.has(p.id));
    for (;;) {
        const ids = new Set(phases.map(p => p.id));
        const next = phases
            .map(p => (p.after ? { ...p, after: p.after.filter(a => a === "idle" || a === "start" || ids.has(a)) } : p))
            .filter(p => !p.after || p.after.length > 0);
        if (next.length === phases.length) {
            phases = next;
            break;
        }
        phases = next;
    }
    return { ...m, phases };
}
function retro(m, ids) {
    return { ...m, phases: m.phases.map(p => (ids.has(p.id) ? { ...p, decided: "end" } : p)) };
}
function crossCheck(full, folds, units, pollSec, holds) {
    const stepMs = Math.max(1, pollSec) * 1000;
    const lagMs = Math.max(...full.bands.map(b => {
        const enter = b.smoothing === "block" ? 20 : b.smoothing === "debounce" ? b.dipSec : 0;
        return Math.max(enter + b.dipSec, b.windowSec);
    }), 0) *
        1000 +
        2 * stepMs;
    const per = new Map();
    const of = (id) => {
        let c = per.get(id);
        if (!c) {
            c = { ok: 0, ref: 0, wrong: 0, wrongSegs: 0 };
            per.set(id, c);
        }
        return c;
    };
    let ok = 0;
    let total = 0;
    let liveChanges = 0;
    let offline = 0;
    units.forEach((u, n) => {
        const fold = folds[n];
        const bandOfId = new Map();
        const phaseIds = new Set();
        for (const m of [full, fold]) {
            for (const p of m.phases) {
                bandOfId.set(p.id, p.band);
                phaseIds.add(p.id);
            }
        }
        const runs = full.scope === "run" ? [runOf(u)] : undefined;
        const ref = replayPhases(full, u.points, pollSec, runs, { holds }).timeline;
        const live = replayPhases(fold, u.points, pollSec, runs, { holds }).live;
        const end = ref.at(-1)?.to ?? 0;
        offline += ref.filter(x => x.to - x.from >= lagMs).length;
        let lastBand = null;
        live.forEach((x, i) => {
            if ((live[i + 1]?.t ?? end) - x.t < lagMs) {
                return;
            }
            const band = x.id === null ? null : (bandOfId.get(x.id) ?? x.id);
            if (band !== lastBand && band !== null) {
                liveChanges++;
            }
            lastBand = band;
        });
        const zones = ref.flatMap((s) => [s.from, s.to]).sort((a, b) => a - b);
        const inZone = (t) => {
            let lo = 0;
            let hi = zones.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (zones[mid] <= t + stepMs) {
                    lo = mid + 1;
                }
                else {
                    hi = mid;
                }
            }
            return lo > 0 && t < zones[lo - 1] + lagMs && t >= zones[lo - 1] - stepMs;
        };
        let r = 0;
        let l = 0;
        const episode = { id: null, wrong: false };
        const closeEpisode = () => {
            if (episode.id !== null && episode.wrong) {
                of(episode.id).wrongSegs++;
            }
            episode.id = null;
            episode.wrong = false;
        };
        const from = ref[0]?.from ?? 0;
        for (let t = from; t < end; t += stepMs) {
            while (r < ref.length && ref[r].to <= t) {
                r++;
            }
            while (l + 1 < live.length && live[l + 1].t <= t) {
                l++;
            }
            const refId = r < ref.length && ref[r].from <= t ? ref[r].id : null;
            const liveId = live[l] && live[l].t <= t ? live[l].id : null;
            if (liveId === null || !phaseIds.has(liveId)) {
                closeEpisode();
            }
            else if (episode.id !== liveId) {
                closeEpisode();
                episode.id = liveId;
            }
            if (refId === null || inZone(t)) {
                continue;
            }
            const refPhase = phaseIds.has(refId);
            const right = liveId === refId || (refPhase && liveId === bandOfId.get(refId));
            total += stepMs;
            if (refPhase) {
                of(refId).ref += stepMs;
            }
            if (right) {
                ok += stepMs;
                if (refPhase) {
                    of(refId).ok += stepMs;
                }
            }
            else if (liveId !== null && phaseIds.has(liveId)) {
                of(liveId).wrong += stepMs;
                episode.wrong = true;
            }
        }
        closeEpisode();
    });
    return { agreement: total > 0 ? ok / total : 1, per, flicker: offline > 0 ? liveChanges / offline : 0 };
}
function agreementOf(c) {
    if (!c || c.ref + c.wrong === 0) {
        return 1;
    }
    return c.ok / (c.ref + c.wrong);
}
function weightedMedian(pairs) {
    const x = [...pairs].sort((a, b) => a[0] - b[0]);
    const total = x.reduce((acc, y) => acc + y[1], 0);
    let acc = 0;
    for (const [v, w] of x) {
        acc += w;
        if (acc >= total / 2) {
            return v;
        }
    }
    return x.at(-1)?.[0] ?? Number.NaN;
}
function typicalW(bands, units, factor) {
    const pairs = bands.map(() => []);
    for (const u of units) {
        const p = u.points;
        for (let i = 0; i + 1 < p.length; i++) {
            const k = bands.findIndex(b => p[i].val >= b.min && p[i].val < b.max);
            if (k >= 0) {
                pairs[k].push([p[i].val, p[i + 1].ts - p[i].ts]);
            }
        }
    }
    return pairs.map((x, k) => Math.round((x.length > 0 ? weightedMedian(x) : bands[k].min) * factor));
}
function phaseFactsOf(model, units, pollSec, holds, factor) {
    const ids = new Set(model.phases.map(p => p.id));
    const pos = new Map();
    const totals = new Map();
    const held = new Map();
    const push = (m, id, ...v) => {
        const list = m.get(id);
        if (list) {
            list.push(...v);
        }
        else {
            m.set(id, [...v]);
        }
    };
    for (const u of units) {
        const runs = model.scope === "run" ? [runOf(u)] : undefined;
        const tl = replayPhases(model, u.points, pollSec, runs, { holds }).timeline;
        const spans = [];
        let open = false;
        for (const x of tl) {
            if (model.scope === "continuous" && x.id === SYSTEM_PHASES.rest) {
                open = false;
                continue;
            }
            if (open) {
                spans.at(-1).segs.push(x);
            }
            else {
                spans.push({ from: x.from, segs: [x] });
                open = true;
            }
        }
        const own = new Map();
        for (const sp of spans) {
            const to = sp.segs.at(-1).to;
            const len = Math.max(1, to - sp.from);
            for (const x of sp.segs) {
                if (ids.has(x.id) && x.to > x.from) {
                    push(own, x.id, [((x.from + x.to) / 2 - sp.from) / len, x.to - x.from]);
                }
            }
        }
        for (const [id, list] of own) {
            push(pos, id, weightedMedian(list));
            push(totals, id, list.reduce((acc, y) => acc + y[1], 0) / 1000);
        }
        const p = u.points;
        let i = 0;
        for (const x of tl) {
            if (!ids.has(x.id)) {
                continue;
            }
            while (i + 1 < p.length && p[i + 1].ts <= x.from) {
                i++;
            }
            for (let j = i; j < p.length && p[j].ts < x.to; j++) {
                const from = Math.max(p[j].ts, x.from);
                const to = Math.min(p[j + 1]?.ts ?? x.to, x.to);
                if (to > from) {
                    push(held, x.id, [p[j].val, to - from]);
                }
            }
        }
    }
    const out = new Map();
    for (const [id, list] of pos) {
        const t = totals.get(id);
        const v = held.get(id) ?? [];
        out.set(id, {
            pos: median(list),
            shortSec: Math.round(Math.min(...t)),
            longSec: Math.round(Math.max(...t)),
            watts: v.length > 0 ? Math.round(weightedMedian(v) * factor) : 0,
        });
    }
    return out;
}
function trailerOf(units, bands, factor) {
    const runs = units.filter(u => u.sample.kind === "run" &&
        admitted(u.verdict, "phases") &&
        admitted(u.verdict, "trailer") &&
        (u.sample.facts.feat?.trailerSec ?? 0) > 0);
    if (runs.length < MIN_UNITS || bands.length === 0) {
        return null;
    }
    const watts = median(runs.map(u => u.sample.facts.feat.burstMaxW));
    const sec = runs.map(u => u.sample.facts.feat.trailerSec);
    const v = watts / factor;
    const k = bands.findIndex(b => v >= b.min && v < b.max);
    return {
        band: k >= 0 ? k : v < bands[0].min ? 0 : bands.length - 1,
        runs: runs.length,
        lastSeen: Math.max(...runs.map(u => u.sample.facts.end)),
        watts: Math.round(watts),
        shortSec: Math.round(Math.min(...sec)),
        longSec: Math.round(Math.max(...sec)),
    };
}
function defaultNeutral(n) {
    return NEUTRAL_TEMPLATE.replace("{n}", String(n));
}
function freeId(prefix, used) {
    for (let n = 1;; n++) {
        const id = `${prefix}${n}`;
        if (!used.has(id)) {
            used.add(id);
            return id;
        }
    }
}
function contextOf(p) {
    if (!p.after) {
        return undefined;
    }
    return p.after.some(a => a === "idle" || a === "start") ? "idle" : "active";
}
function rangeOf(p) {
    return [Math.max(1, p.minSec), p.maxSec > 0 ? p.maxSec : Infinity];
}
export function learnPhases(units, ctx) {
    const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
    const runLimit = ctx.runLimitW / factor;
    const pollSec = Math.max(1, ctx.pollSec);
    const used = units
        .filter(u => u.sample.kind === "run" && admitted(u.verdict, "phases"))
        .map(u => u.sample)
        .sort((a, b) => a.facts.start - b.facts.start);
    let scope = ctx.scope;
    if (!scope) {
        const days = used.length > 0 ? Math.max(1, (used.at(-1).facts.end - used[0].facts.start) / 86_400_000) : 1;
        const rests = used.slice(1).map((u, i) => (u.facts.start - used[i].facts.end) / 60_000);
        scope = used.length < 2 ? "run" : scopeOf(used.length / days, median(rests));
    }
    const raw = !rhythmic(used, runLimit);
    const opts = raw
        ? { mode: "raw", dipSec: DEBOUNCE_SEC }
        : { mode: "median60", dipSec: MEDIAN_DIP_SEC };
    const learned = learnBands(used, runLimit, opts);
    const holds = holdProfile(used, learned);
    const bands = smoothingOf(learned, used, raw, scope, pollSec, holds);
    const segs = bandSegments(modelOf(scope, bands, []), used, pollSec, holds);
    const drafts = draftsOf(bands, segs, used, scope);
    const keys = drafts.map((_, i) => `k${i + 1}`);
    let full = modelOf(scope, bands, phasesOf(drafts, keys, bands, scope));
    let folds = used.map((_, n) => {
        const fd = draftsOf(bands, segs.filter((__, i) => i !== n), used, scope);
        const map = mapDrafts(fd, drafts);
        const seen = new Set(keys);
        const ids = fd.map((__, i) => (map[i] !== null ? keys[map[i]] : freeId("x", seen)));
        return modelOf(scope, bands, phasesOf(fd, ids, bands, scope));
    });
    const retroOnly = new Set();
    const liveAgreement = new Map();
    const prune = (f) => {
        const ids = new Set(full.phases.map(p => p.id));
        return withoutPhases(f, new Set(f.phases.filter(p => !ids.has(p.id)).map(p => p.id)));
    };
    folds = folds.map(prune);
    let check = crossCheck(full, folds, used, pollSec, holds);
    for (let pass = 0; pass < 5; pass++) {
        if (check.flicker > FLICKER_MAX) {
            const live = full.phases.filter(p => p.decided === "live");
            live.filter(p => p.trigger).forEach(p => retroOnly.add(p.id));
            const all = new Set(live.map(p => p.id));
            full = retro(full, all);
            folds = folds.map(f => retro(f, all));
            check = crossCheck(full, folds, used, pollSec, holds);
            break;
        }
        const failing = full.phases.filter(p => {
            const c = check.per.get(p.id);
            return agreementOf(c) < AGREE_MIN || (c?.wrongSegs ?? 0) > 0;
        });
        if (failing.length === 0) {
            break;
        }
        const drop = new Set();
        const late = new Set();
        for (const p of failing) {
            if (p.trigger && p.decided === "live") {
                late.add(p.id);
                retroOnly.add(p.id);
                liveAgreement.set(p.id, agreementOf(check.per.get(p.id)));
            }
            else if (!p.trigger) {
                drop.add(p.id);
            }
        }
        if (drop.size === 0 && late.size === 0) {
            break;
        }
        full = retro(withoutPhases(full, drop), late);
        folds = folds.map(f => prune(retro(withoutPhases(f, drop), late)));
        check = crossCheck(full, folds, used, pollSec, holds);
    }
    const agreement = used.length > 0 ? check.agreement : 0;
    const tail = scope === "run" ? trailerOf(units, bands, factor) : null;
    const facts = phaseFactsOf(full, used, pollSec, holds, factor);
    const typical = typicalW(bands, used, factor);
    const neutral = ctx.neutralName ?? defaultNeutral;
    const prev = ctx.previous;
    const usedIds = new Set([
        ...(prev?.bands.map(b => b.id) ?? []),
        ...(prev?.phases.map(p => p.id) ?? []),
        ...Object.values(SYSTEM_PHASES),
        "idle",
        "start",
    ]);
    const most = (prev?.phases.length ?? 0) + full.phases.length + 1;
    const generated = (name) => {
        if (OLD_GENERATED.test(name) || BAND_GENERATED.test(name)) {
            return true;
        }
        for (let n = 1; n <= most; n++) {
            if (name === neutral(n) || name === defaultNeutral(n)) {
                return true;
            }
        }
        return false;
    };
    const bandIds = bands.map(() => "");
    const bandNames = bands.map(() => "");
    if (prev) {
        const pairs = [];
        bands.forEach((b, i) => prev.bands.forEach((o, j) => {
            const score = overlap([b.min, b.max], [o.min, o.max]);
            if (score > 0) {
                pairs.push({ i, j, score });
            }
        }));
        pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
        const taken = new Set();
        for (const p of pairs) {
            if (bandIds[p.i] === "" && !taken.has(p.j)) {
                bandIds[p.i] = prev.bands[p.j].id;
                const name = prev.bands[p.j].name;
                bandNames[p.i] = generated(name) ? "" : name;
                taken.add(p.j);
            }
        }
    }
    bands.forEach((_, k) => {
        if (bandIds[k] === "") {
            bandIds[k] = freeId("b", usedIds);
        }
        if (bandNames[k] === "") {
            bandNames[k] = `≈ ${typical[k]} W`;
        }
    });
    const draftOf = new Map(keys.map((key, i) => [key, drafts[i]]));
    const phaseIds = new Map();
    const keep = new Map();
    const dropped = [];
    const TAIL = "tail";
    if (prev) {
        const pairs = [];
        for (const old of prev.phases) {
            const ob = prev.bands.find(b => b.id === old.band);
            if (old.trailer) {
                if (tail) {
                    pairs.push({ key: TAIL, old, score: 1 });
                }
                continue;
            }
            for (const p of full.phases) {
                const d = draftOf.get(p.id);
                if (!ob || !old.trigger !== !p.trigger) {
                    continue;
                }
                const nb = bands[d.band];
                const open = old.minSec === 0 && old.maxSec === 0;
                const score = overlap([ob.min, ob.max], [nb.min, nb.max]) *
                    (open ? 1 : overlap(rangeOf(old), [Math.max(1, d.lo), Math.max(1, d.hi)])) *
                    (contextOf(old) === d.ctx ? 1 : 0.5);
                if (score > 0) {
                    pairs.push({ key: p.id, old, score });
                }
            }
        }
        pairs.sort((a, b) => b.score - a.score || a.old.id.localeCompare(b.old.id) || a.key.localeCompare(b.key));
        for (const p of pairs) {
            if (!phaseIds.has(p.key) && !keep.has(p.old.id)) {
                phaseIds.set(p.key, p.old.id);
                keep.set(p.old.id, p.old);
            }
        }
        for (const old of prev.phases) {
            if (!keep.has(old.id)) {
                dropped.push({ id: old.id, name: old.name, actions: ctx.actionsOf?.(old.id) ?? 0 });
            }
        }
    }
    const ordered = full.phases
        .map((p, i) => ({ p, i, d: draftOf.get(p.id), f: facts.get(p.id) }))
        .sort((x, y) => (x.f?.pos ?? 1) - (y.f?.pos ?? 1) ||
        x.d.band - y.d.band ||
        Number(x.d.ctx !== "idle") - Number(y.d.ctx !== "idle") ||
        x.i - y.i);
    for (const { p } of ordered) {
        if (!phaseIds.has(p.id)) {
            phaseIds.set(p.id, freeId("p", usedIds));
        }
    }
    if (tail && !phaseIds.has(TAIL)) {
        phaseIds.set(TAIL, freeId("p", usedIds));
    }
    const nameOf = (id, n) => {
        const old = keep.get(id)?.name;
        return old !== undefined && old.trim() !== "" && !generated(old) ? old : neutral(n);
    };
    const kept = (out, old) => {
        if (old?.final) {
            out.final = true;
        }
        if (old?.notify) {
            out.notify = { ...old.notify };
        }
        return out;
    };
    const bandIdOf = new Map(bands.map((b, k) => [b.id, bandIds[k]]));
    const outBands = bands.map((b, k) => ({ ...b, id: bandIds[k], name: bandNames[k] }));
    const outPhases = ordered.map(({ p, d, f }, n) => {
        const id = phaseIds.get(p.id);
        const old = keep.get(id);
        const c = check.per.get(p.id);
        const out = {
            id,
            name: nameOf(id, n + 1),
            band: bandIdOf.get(p.band),
            minSec: p.minSec,
            maxSec: p.maxSec,
            decided: p.decided,
            show: old?.show ?? true,
            stats: {
                runs: p.stats.runs,
                agreement: liveAgreement.get(p.id) ?? agreementOf(c),
                lastSeen: p.stats.lastSeen,
                watts: f?.watts ?? typical[d.band],
                shortSec: f?.shortSec ?? Math.round(d.lo),
                longSec: f?.longSec ?? Math.round(d.hi),
            },
        };
        if (p.after) {
            out.after = p.after.map(a => phaseIds.get(a) ?? a);
        }
        if (p.trigger) {
            out.trigger = { ...p.trigger, confirm: p.trigger.confirm.map(b => bandIdOf.get(b)) };
        }
        return kept(out, old);
    });
    if (tail) {
        const id = phaseIds.get(TAIL);
        const old = keep.get(id);
        outPhases.push(kept({
            id,
            name: nameOf(id, outPhases.length + 1),
            band: bandIds[tail.band],
            minSec: 0,
            maxSec: 0,
            decided: "live",
            trailer: true,
            show: old?.show ?? true,
            stats: {
                runs: tail.runs,
                agreement: 1,
                lastSeen: tail.lastSeen,
                watts: tail.watts,
                shortSec: tail.shortSec,
                longSec: tail.longSec,
            },
        }, old));
    }
    return {
        model: {
            v: 1,
            enabled: prev?.enabled ?? false,
            scope,
            bands: outBands,
            phases: outPhases,
            learnedAt: ctx.now ?? Date.now(),
            quality: { agreement, runsUsed: used.length },
        },
        looAgreement: agreement,
        retroOnly: [...retroOnly].map(k => phaseIds.get(k)).filter(id => outPhases.some(p => p.id === id)),
        dropped,
    };
}
const TUNE_STEP = 0.15;
function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}
function round3(x) {
    if (!Number.isFinite(x) || x === 0) {
        return x;
    }
    const e = Math.floor(Math.log10(Math.abs(x))) - 2;
    return e >= 0 ? Math.round(x / 10 ** e) * 10 ** e : Math.round(x * 10 ** -e) / 10 ** -e;
}
function stepTo(from, to) {
    if (!(from > 0) || !Number.isFinite(to)) {
        return from;
    }
    return Math.min(from * (1 + TUNE_STEP), Math.max(from * (1 - TUNE_STEP), to));
}
export function phaseTuneBase(model) {
    return fnv(JSON.stringify([
        model.scope,
        model.bands.map(b => [b.id, b.min, b.max, b.smoothing, b.dipSec, b.windowSec]),
        model.phases.map(p => [p.id, p.band, p.minSec, p.maxSec, p.after ?? null, p.decided, p.trigger ?? null]),
    ]));
}
export function applyPhaseTune(model, p) {
    if (!p) {
        return model;
    }
    const fin = (x, keep) => (typeof x === "number" && Number.isFinite(x) ? x : keep);
    const bands = model.bands.map(b => {
        const t = p.bands.find(x => x.id === b.id);
        return t ? { ...b, min: fin(t.min, b.min), max: Number.isFinite(b.max) ? fin(t.max, b.max) : b.max } : b;
    });
    if (bands.some((b, i) => !(b.max > b.min) || (i > 0 && b.min < bands[i - 1].max))) {
        return model;
    }
    const phases = model.phases.map(ph => {
        const t = p.phases.find(x => x.id === ph.id);
        if (!t) {
            return ph;
        }
        const out = { ...ph, minSec: fin(t.minSec, ph.minSec), maxSec: fin(t.maxSec, ph.maxSec) };
        if (ph.trigger) {
            out.trigger = {
                ...ph.trigger,
                confirmSec: fin(t.confirmSec, ph.trigger.confirmSec),
                tailSec: fin(t.tailSec, ph.trigger.tailSec),
            };
        }
        return out;
    });
    return { ...model, bands, phases };
}
function tunedBands(model, used) {
    const out = model.bands.map(b => ({ id: b.id, min: b.min, max: b.max }));
    if (used.length < MIN_UNITS || model.bands.length < 2) {
        return out;
    }
    const raw = model.bands.some(b => b.smoothing === "debounce" || b.smoothing === "peak");
    const learned = learnBands(used, model.bands[0].min, raw ? { mode: "raw", dipSec: DEBOUNCE_SEC } : { mode: "median60", dipSec: MEDIAN_DIP_SEC });
    const found = learned.slice(1).map(b => b.min);
    for (let i = 0; i + 1 < out.length; i++) {
        const v = model.bands[i].max;
        if (v !== model.bands[i + 1].min || !Number.isFinite(v)) {
            continue;
        }
        const near = found
            .filter(x => x >= v * (1 - TUNE_STEP) && x <= v * (1 + TUNE_STEP))
            .sort((a, b) => Math.abs(Math.log(a / v)) - Math.abs(Math.log(b / v)))[0];
        if (near === undefined) {
            continue;
        }
        const x = round3(near);
        if (x > out[i].min && x < out[i + 1].max) {
            out[i].max = x;
            out[i + 1].min = x;
        }
    }
    return out;
}
function classLimits(a, c, durations) {
    if (!(a.maxSec > 0) || !(c.minSec >= a.maxSec)) {
        return null;
    }
    const mid = Math.sqrt(a.maxSec * c.minSec);
    const shorter = durations.filter(d => d <= mid);
    const longer = durations.filter(d => d > mid);
    if (shorter.length === 0 || longer.length === 0) {
        return null;
    }
    const hiA = Math.max(...shorter);
    const loC = Math.min(...longer);
    if (!(hiA < loC)) {
        return null;
    }
    const g = Math.sqrt(hiA * loC);
    const gap = Math.sqrt(c.minSec / a.maxSec);
    const maxA = Math.round(stepTo(a.maxSec, Math.min(g, Math.max(hiA, g / gap))));
    const minC = Math.round(stepTo(c.minSec, Math.max(g, Math.min(loC, g * gap))));
    return maxA >= 1 && minC >= maxA ? [maxA, minC] : null;
}
function proposalOf(model, used, pollSec, holds) {
    const bands = tunedBands(model, used);
    const tuned = applyPhaseTune(model, { hash: "", bands, phases: [] });
    const phases = model.phases.map(p => ({
        id: p.id,
        minSec: p.minSec,
        maxSec: p.maxSec,
        ...(p.trigger ? { confirmSec: p.trigger.confirmSec, tailSec: p.trigger.tailSec } : {}),
    }));
    if (used.length < MIN_UNITS) {
        return { bands, phases };
    }
    const segs = bandSegments({ ...tuned, phases: [] }, used, pollSec, holds);
    tuned.bands.forEach((b, k) => {
        const durations = segs
            .flat()
            .filter(s => s.band === k && s.closed)
            .map(s => (s.to - s.from) / 1000)
            .filter(sec => sec > 0);
        const own = model.phases
            .map((p, i) => ({ p, i }))
            .filter(x => x.p.band === b.id && !x.p.trigger && !x.p.after && !x.p.trailer)
            .sort((x, y) => x.p.minSec - y.p.minSec);
        for (let j = 0; j + 1 < own.length; j++) {
            const lim = classLimits(own[j].p, own[j + 1].p, durations);
            if (lim) {
                phases[own[j].i].maxSec = lim[0];
                phases[own[j + 1].i].minSec = lim[1];
            }
        }
        const ev = b.smoothing === "peak" ? eventOf(k, segs, used) : null;
        const trigger = ev?.trigger;
        if (!trigger) {
            return;
        }
        const confirm = JSON.stringify(trigger.confirm.map(x => tuned.bands[x].id).sort());
        model.phases.forEach((p, i) => {
            if (p.band === b.id && p.trigger && JSON.stringify([...p.trigger.confirm].sort()) === confirm) {
                phases[i].confirmSec = Math.max(1, Math.round(stepTo(p.trigger.confirmSec, trigger.confirmSec)));
                phases[i].tailSec = Math.max(1, Math.round(stepTo(p.trigger.tailSec, trigger.tailSec)));
            }
        });
    });
    return { bands, phases };
}
export function tunePhases(model, units, prev, opts = {}) {
    const pollSec = Math.max(1, opts.pollSec ?? 10);
    const holds = opts.holds ?? [];
    const used = units
        .filter(u => u.sample.kind === "run" && admitted(u.verdict, "phases"))
        .map(u => u.sample)
        .sort((a, b) => a.facts.start - b.facts.start);
    const body = proposalOf(model, used, pollSec, holds);
    const proposal = { hash: fnv(JSON.stringify(body)), ...body };
    let newPattern = false;
    if (used.length >= MIN_UNITS) {
        const segs = bandSegments({ ...model, phases: [] }, used, pollSec, holds);
        newPattern = model.bands.some((b, k) => {
            const own = model.phases.filter(p => p.band === b.id && !p.trailer);
            return classesOf(k, segs).some(d => d.units.size >= MIN_UNITS &&
                !own.some(p => {
                    const [lo, hi] = rangeOf(p);
                    return d.hi >= lo && d.lo <= hi;
                }));
        });
    }
    const tuned = applyPhaseTune(model, proposal);
    if (prev?.hash !== proposal.hash || phaseTuneBase(tuned) === phaseTuneBase(model)) {
        return { model: null, proposal, newPattern };
    }
    const self = crossCheck(model, used.map(() => model), used, pollSec, holds);
    const stored = model.quality?.agreement;
    const before = {
        agreement: typeof stored === "number" && stored > 0 && stored <= 1 ? stored : self.agreement,
        flicker: self.flicker,
    };
    const folds = used.map((_, n) => applyPhaseTune(model, {
        hash: "",
        ...proposalOf(model, used.filter((__, i) => i !== n), pollSec, holds),
    }));
    const after = crossCheck(tuned, folds, used, pollSec, holds);
    if (after.agreement + 1e-9 < before.agreement || after.flicker > Math.max(FLICKER_MAX, before.flicker)) {
        return { model: null, proposal, newPattern };
    }
    return {
        model: { ...tuned, quality: { agreement: after.agreement, runsUsed: used.length } },
        proposal,
        newPattern,
    };
}
//# sourceMappingURL=learn.js.map