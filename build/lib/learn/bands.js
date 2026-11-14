export const RAW_POINTS_MAX = 200_000;
const LN_STEP = Math.log(1.07);
const PEAK_RATIO = 1.2;
const KEEP_UNITS = 3;
const KEEP_SEGMENTS = 3;
const KEEP_SHARE = 0.005;
const Q_EDGE = 0.001;
const MEDIAN_MS = 60_000;
const GRID_MS = 1000;
const HOLD_MIN_UNITS = 3;
const HOLD_MIN_N = 30;
const SUSPECT_MIN_SEC = 600;
const SUSPECT_FACTOR = 5;
const CHANGE_SHARE = 0.5;
const ALTERNATE_SHARE = 0.25;
export const DEFAULT_BAND_OPTIONS = { mode: "median60", dipSec: 60 };
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
export function unitsOf(points, L, s, unitFactor = 1) {
    const out = [];
    let budget = RAW_POINTS_MAX;
    for (let k = L.runs.length - 1; k >= 0; k--) {
        const r = L.runs[k];
        const fromIdx = Math.max(0, r.from - 1);
        const toIdx = Math.min(s.length - 1, r.runEnd + 1);
        const from = s.t0 + fromIdx * s.stepMs;
        const to = s.t0 + toIdx * s.stepMs;
        const a = lowerBound(points, from);
        const b = lowerBound(points, to + 1);
        if (b - a <= budget) {
            budget -= b - a;
            const unit = [];
            if (a > 0 && (a === points.length || points[a].ts > from)) {
                unit.push({ ts: from, val: points[a - 1].val });
            }
            for (let i = a; i < b; i++) {
                unit.push({ ts: points[i].ts, val: points[i].val });
            }
            out.push({ points: unit, from, to });
            continue;
        }
        budget = 0;
        const factor = unitFactor > 0 ? unitFactor : 1;
        const unit = [];
        for (let i = fromIdx; i <= toIdx; i++) {
            if (s.valid[i] === 1 && (unit.length === 0 || unit.at(-1).val !== s.last[i] / factor)) {
                unit.push({ ts: s.t0 + i * s.stepMs, val: s.last[i] / factor });
            }
        }
        out.push({ points: unit, from, to, fromTicks: true });
    }
    return out.reverse();
}
function heldOf(u) {
    const out = { t: [], d: [], v: [] };
    const pts = u.points;
    for (let k = 0; k < pts.length; k++) {
        const a = Math.max(pts[k].ts, u.from);
        const b = Math.min(k + 1 < pts.length ? pts[k + 1].ts : u.to, u.to);
        if (b <= a) {
            continue;
        }
        const val = pts[k].val;
        const last = out.v.length - 1;
        if (last >= 0 && out.v[last] === val && out.t[last] + out.d[last] === a) {
            out.d[last] += b - a;
        }
        else {
            out.t.push(a);
            out.d.push(b - a);
            out.v.push(val);
        }
    }
    return out;
}
function medianOf(u) {
    const held = heldOf(u);
    const out = { t: [], d: [], v: [] };
    const n = Math.floor((u.to - u.from) / GRID_MS);
    if (n <= 0 || held.t.length === 0) {
        return out;
    }
    const g = new Float64Array(n).fill(Number.NaN);
    let k = 0;
    for (let j = 0; j < n; j++) {
        const t = u.from + j * GRID_MS;
        while (k < held.t.length && held.t[k] + held.d[k] <= t) {
            k++;
        }
        if (k < held.t.length && held.t[k] <= t) {
            g[j] = held.v[k];
        }
    }
    const w = Math.round(MEDIAN_MS / GRID_MS);
    const half = w >> 1;
    const win = [];
    const insert = (x) => {
        let lo = 0;
        let hi = win.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (win[mid] < x) {
                lo = mid + 1;
            }
            else {
                hi = mid;
            }
        }
        win.splice(lo, 0, x);
    };
    const remove = (x) => {
        let lo = 0;
        let hi = win.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (win[mid] < x) {
                lo = mid + 1;
            }
            else {
                hi = mid;
            }
        }
        win.splice(lo, 1);
    };
    for (let j = 0; j < Math.min(n, w - half - 1); j++) {
        if (!Number.isNaN(g[j])) {
            insert(g[j]);
        }
    }
    for (let j = 0; j < n; j++) {
        const enter = j + w - half - 1;
        if (enter < n && !Number.isNaN(g[enter])) {
            insert(g[enter]);
        }
        const leave = j - half - 1;
        if (leave >= 0 && !Number.isNaN(g[leave])) {
            remove(g[leave]);
        }
        const val = Number.isNaN(g[j]) || win.length === 0 ? Number.NaN : win[(win.length - 1) >> 1];
        const t = u.from + j * GRID_MS;
        const last = out.v.length - 1;
        if (last >= 0 && (out.v[last] === val || (Number.isNaN(val) && Number.isNaN(out.v[last])))) {
            out.d[last] += GRID_MS;
        }
        else {
            out.t.push(t);
            out.d.push(GRID_MS);
            out.v.push(val);
        }
    }
    return out;
}
function binOf(v, runLimit) {
    return Math.max(0, Math.floor(Math.log(v / runLimit) / LN_STEP));
}
function edgeOf(bin, runLimit) {
    return runLimit * Math.exp((bin + 0.5) * LN_STEP);
}
function labelOf(v, runLimit, edges) {
    if (Number.isNaN(v)) {
        return -2;
    }
    if (v <= runLimit) {
        return -1;
    }
    let k = 0;
    while (k < edges.length && v >= edges[k]) {
        k++;
    }
    return k;
}
function blocksOf(lv, runLimit, edges, dipMs) {
    const st = [];
    for (let i = 0; i < lv.v.length; i++) {
        const lab = labelOf(lv.v[i], runLimit, edges);
        const top = st.at(-1);
        if (top && top.lab === lab) {
            top.d += lv.d[i];
            top.i1 = i;
        }
        else {
            st.push({ lab, d: lv.d[i], i0: i, i1: i });
        }
        while (st.length >= 3) {
            const [a, m, b] = st.slice(-3);
            if (a.lab < 0 || a.lab !== b.lab || m.lab === -2 || m.d >= dipMs) {
                break;
            }
            st.splice(-3, 3, { lab: a.lab, d: a.d + m.d + b.d, i0: a.i0, i1: b.i1 });
        }
    }
    return st;
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
function peaksOf(h) {
    const peaks = [];
    for (let i = 0; i < h.length; i++) {
        if (h[i] > 0 && (i === 0 || h[i] > h[i - 1]) && (i === h.length - 1 || h[i] >= h[i + 1])) {
            peaks.push(i);
        }
    }
    for (let changed = true; changed;) {
        changed = false;
        for (let k = 0; k + 1 < peaks.length; k++) {
            const a = peaks[k];
            const b = peaks[k + 1];
            const m = valleyOf(h, a, b);
            if (Math.min(h[a], h[b]) < PEAK_RATIO * h[m]) {
                peaks.splice(h[a] >= h[b] ? k + 1 : k, 1);
                changed = true;
                break;
            }
        }
    }
    return peaks;
}
function valleyOf(h, a, b) {
    let lo = Number.POSITIVE_INFINITY;
    for (let i = a; i <= b; i++) {
        lo = Math.min(lo, h[i]);
    }
    const at = [];
    for (let i = a; i <= b; i++) {
        if (h[i] === lo) {
            at.push(i);
        }
    }
    return at[(at.length - 1) >> 1];
}
function statsOf(levels, runLimit, edges, dipMs) {
    const nb = edges.length + 1;
    const time = new Array(nb).fill(0);
    const segs = Array.from({ length: nb }, () => new Array(levels.length).fill(0));
    const direct = Array.from({ length: nb }, () => [0, 0]);
    const enclosed = Array.from({ length: nb }, () => [0, 0]);
    const blocks = levels.map((lv, u) => {
        const bl = blocksOf(lv, runLimit, edges, dipMs);
        const own = [];
        for (const b of bl) {
            if (b.lab >= 0) {
                time[b.lab] += b.d;
            }
            if (b.lab < 0 || b.d >= dipMs) {
                if (own.at(-1) !== b.lab) {
                    own.push(b.lab);
                }
            }
        }
        own.forEach((lab, i) => {
            if (lab < 0) {
                return;
            }
            segs[lab][u]++;
            const prev = own[i - 1];
            const next = own[i + 1];
            [lab - 1, lab + 1].forEach((n, side) => {
                if (n >= 0 && n < nb) {
                    direct[lab][side] += prev === n || next === n ? 1 : 0;
                    enclosed[lab][side] += prev === n && next === n ? 1 : 0;
                }
            });
        });
        return bl;
    });
    return { blocks, time, segs, direct, enclosed };
}
function recurring(st, k) {
    return st.segs[k].filter(n => n >= KEEP_SEGMENTS).length >= KEEP_UNITS;
}
function changeWithin(st, k) {
    const count = (b) => st.segs[b].reduce((s, x) => s + x, 0);
    const rare = count(k) < count(k + 1) ? k : k + 1;
    const side = rare === k ? 1 : 0;
    const n = count(rare);
    const direct = st.direct[rare][side];
    if (n === 0 || st.enclosed[rare][side] >= CHANGE_SHARE * direct) {
        return false;
    }
    const lowDirect = st.direct[k][1];
    const highDirect = st.direct[k + 1][0];
    const mutual = lowDirect >= CHANGE_SHARE * count(k) && highDirect >= CHANGE_SHARE * count(k + 1);
    const turns = st.enclosed[k][1] + st.enclosed[k + 1][0];
    if (mutual && turns >= ALTERNATE_SHARE * Math.min(lowDirect, highDirect)) {
        return true;
    }
    return !recurring(st, rare) && direct >= CHANGE_SHARE * n;
}
export function learnBands(units, runLimit, opts) {
    if (!(runLimit > 0)) {
        return [];
    }
    const dipMs = Math.max(0, opts.dipSec) * 1000;
    const held = units.map(heldOf);
    const levels = opts.mode === "raw" ? held : units.map(medianOf);
    let maxBin = -1;
    for (const lv of levels) {
        for (const v of lv.v) {
            if (v > runLimit) {
                maxBin = Math.max(maxBin, binOf(v, runLimit));
            }
        }
    }
    if (maxBin < 0) {
        return [];
    }
    const perUnit = levels.map(lv => {
        const h = new Float64Array(maxBin + 1);
        lv.v.forEach((v, i) => {
            if (v > runLimit) {
                h[binOf(v, runLimit)] += lv.d[i];
            }
        });
        return h;
    });
    const hist = new Float64Array(maxBin + 1);
    for (const h of perUnit) {
        h.forEach((x, i) => (hist[i] += x));
    }
    const peaks = peaksOf(hist);
    const cuts = [];
    for (let k = 0; k + 1 < peaks.length; k++) {
        cuts.push(valleyOf(hist, peaks[k], peaks[k + 1]));
    }
    let edges = [];
    for (;;) {
        const valleyEdges = cuts.map(c => edgeOf(c, runLimit));
        const st = statsOf(levels, runLimit, valleyEdges, dipMs);
        const total = st.time.reduce((s, x) => s + x, 0);
        const weak = st.time
            .map((t, k) => ({ k, t }))
            .filter(({ k, t }) => !recurring(st, k) && t < KEEP_SHARE * total)
            .sort((a, b) => a.t - b.t);
        if (weak.length > 0 && cuts.length > 0) {
            const k = weak[0].k;
            const left = k > 0 ? k - 1 : -1;
            const right = k < cuts.length ? k : -1;
            const drop = left < 0 ? right : right < 0 ? left : hist[cuts[left]] >= hist[cuts[right]] ? left : right;
            cuts.splice(drop, 1);
            continue;
        }
        const change = cuts.findIndex((_, k) => changeWithin(st, k));
        if (change >= 0) {
            cuts.splice(change, 1);
            continue;
        }
        edges = boundariesOf(levels, held, st, cuts, valleyEdges, hist, runLimit, dipMs);
        const failed = edges.findIndex((e, k) => !inValleyLoo(hist, perUnit, edges, k, runLimit, e));
        if (failed >= 0) {
            cuts.splice(failed, 1);
            continue;
        }
        break;
    }
    const st = statsOf(levels, runLimit, edges, dipMs);
    const total = st.time.reduce((s, x) => s + x, 0);
    return st.time.map((t, k) => ({
        id: `b${k + 1}`,
        min: k === 0 ? runLimit : edges[k - 1],
        max: k < edges.length ? edges[k] : Number.POSITIVE_INFINITY,
        segments: st.segs[k].reduce((s, x) => s + x, 0),
        activeShare: total > 0 ? t / total : 0,
    }));
}
function boundariesOf(levels, held, st, cuts, valleyEdges, hist, runLimit, dipMs) {
    const values = valleyEdges.concat(0).map(() => []);
    st.blocks.forEach((bl, u) => {
        const lv = levels[u];
        const raw = held[u];
        let j = 0;
        for (const b of bl) {
            if (b.lab < 0 || b.d < dipMs) {
                continue;
            }
            const from = lv.t[b.i0];
            const to = lv.t[b.i1] + lv.d[b.i1];
            while (j < raw.t.length && raw.t[j] + raw.d[j] <= from) {
                j++;
            }
            for (let i = j; i < raw.t.length && raw.t[i] < to; i++) {
                const d = Math.min(to, raw.t[i] + raw.d[i]) - Math.max(from, raw.t[i]);
                if (d > 0 && raw.v[i] > runLimit) {
                    values[b.lab].push([raw.v[i], d]);
                }
            }
        }
    });
    const out = [];
    valleyEdges.forEach((valley, k) => {
        const below = k > 0 ? valleyEdges[k - 1] : runLimit;
        const above = k + 1 < valleyEdges.length ? valleyEdges[k + 1] : Number.POSITIVE_INFINITY;
        const inPair = (x) => x[0] > below && x[0] < above;
        const hi = weightedQuantile(values[k].filter(inPair), 1 - Q_EDGE);
        const lo = weightedQuantile(values[k + 1].filter(inPair), Q_EDGE);
        const geo = Math.sqrt(hi * lo);
        const floor = k > 0 ? out[k - 1] : runLimit;
        const ok = hi < lo && geo > floor && geo < above && hist[binOf(geo, runLimit)] <= hist[cuts[k]] * PEAK_RATIO;
        out.push(ok ? geo : valley);
    });
    return out;
}
function inValleyLoo(hist, perUnit, edges, k, runLimit, e) {
    const at = binOf(e, runLimit);
    const lo = k > 0 ? binOf(edges[k - 1], runLimit) : 0;
    const hi = k + 1 < edges.length ? binOf(edges[k + 1], runLimit) : hist.length - 1;
    for (const h of perUnit) {
        let peakA = 0;
        let peakB = 0;
        for (let i = lo; i < at; i++) {
            peakA = Math.max(peakA, hist[i] - h[i]);
        }
        for (let i = at + 1; i <= hi; i++) {
            peakB = Math.max(peakB, hist[i] - h[i]);
        }
        const valley = hist[at] - h[at];
        if (!(Math.min(peakA, peakB) > 0 && Math.min(peakA, peakB) >= PEAK_RATIO * valley)) {
            return false;
        }
    }
    return true;
}
function bandIndex(bands, val) {
    if (bands.length === 0 || !(val > bands[0].min)) {
        return -1;
    }
    return bands.findIndex(b => val >= b.min && val < b.max);
}
export function holdProfile(units, bands) {
    const holds = bands.map(() => []);
    const seen = bands.map(() => new Set());
    units.forEach((u, n) => {
        if (u.fromTicks) {
            return;
        }
        for (let i = 0; i + 1 < u.points.length; i++) {
            const k = bandIndex(bands, u.points[i].val);
            if (k >= 0) {
                holds[k].push((u.points[i + 1].ts - u.points[i].ts) / 1000);
                seen[k].add(n);
            }
        }
    });
    const out = [];
    bands.forEach((b, k) => {
        const h = holds[k];
        if (seen[k].size < HOLD_MIN_UNITS || h.length < HOLD_MIN_N) {
            return;
        }
        h.sort((x, y) => x - y);
        const p99Sec = h[Math.min(h.length - 1, Math.max(0, Math.ceil(0.99 * h.length) - 1))];
        out.push({ band: b.id, p99Sec, suspectSec: Math.max(SUSPECT_MIN_SEC, SUSPECT_FACTOR * p99Sec), n: h.length });
    });
    return out;
}
export function baseBandsOf(units, runLimit, opts = DEFAULT_BAND_OPTIONS) {
    const bands = learnBands(units, runLimit, opts);
    return { bands, holds: holdProfile(units, bands), units: units.length, runLimit, opts: { ...opts } };
}
export function bandOf(b, val) {
    const k = bandIndex(b.bands, val);
    return k >= 0 ? b.bands[k] : null;
}
export function suspectLimitOf(b, val) {
    const band = bandOf(b, val);
    return (band && b.holds.find(h => h.band === band.id)?.suspectSec) ?? null;
}
export function bandSegmentsOf(u, b, coreTo = u.to) {
    if (b.bands.length === 0) {
        return [];
    }
    const core = { points: u.points, from: u.from, to: Math.max(u.from, Math.min(u.to, coreTo)) };
    const lv = b.opts.mode === "raw" ? heldOf(core) : medianOf(core);
    const dipMs = Math.max(0, b.opts.dipSec) * 1000;
    const edges = b.bands.slice(1).map(x => x.min);
    return blocksOf(lv, b.runLimit, edges, dipMs)
        .filter(bl => bl.lab >= 0 && bl.d >= dipMs)
        .map(bl => ({ band: bl.lab, ms: bl.d }));
}
export function bandFeaturesOf(u, b, coreTo = u.to) {
    if (b.bands.length === 0) {
        return null;
    }
    const core = { points: u.points, from: u.from, to: Math.max(u.from, Math.min(u.to, coreTo)) };
    const lv = b.opts.mode === "raw" ? heldOf(core) : medianOf(core);
    const dipMs = Math.max(0, b.opts.dipSec) * 1000;
    const edges = b.bands.slice(1).map(x => x.min);
    const top = b.bands.length - 1;
    let topMs = 0;
    for (const bl of blocksOf(lv, b.runLimit, edges, dipMs)) {
        if (bl.lab === top) {
            topMs += bl.d;
        }
    }
    const own = bandSegmentsOf(u, b, coreTo).map(x => x.band);
    const last = own.at(-1);
    return { topBandSec: topMs / 1000, finalBandBlocks: last === undefined ? 0 : own.filter(x => x === last).length };
}
//# sourceMappingURL=bands.js.map