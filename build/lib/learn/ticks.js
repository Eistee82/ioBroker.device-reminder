export const GAP_MS = 2 * 60 * 60_000;
export function createSeries(t0, stepMs, length) {
    const n = Math.max(0, Math.floor(length));
    const series = {
        t0,
        stepMs,
        length: n,
        last: new Float64Array(n).fill(Number.NaN),
        min: new Float64Array(n).fill(Number.NaN),
        max: new Float64Array(n).fill(Number.NaN),
        has: new Uint8Array(n),
        valid: new Uint8Array(n).fill(1),
        lastTs: new Float64Array(n).fill(Number.NEGATIVE_INFINITY),
        points: 0,
        firstIdx: 0,
    };
    return series;
}
export function foldPoints(series, points) {
    const lastTs = series.lastTs;
    if (!lastTs) {
        return;
    }
    for (const p of points) {
        if (!Number.isFinite(p.ts) || !Number.isFinite(p.val)) {
            continue;
        }
        const i = Math.ceil((p.ts - series.t0) / series.stepMs);
        if (i < 0 || i >= series.length) {
            continue;
        }
        series.points++;
        if (series.has[i] === 0) {
            series.has[i] = 1;
            series.min[i] = p.val;
            series.max[i] = p.val;
        }
        else {
            series.min[i] = Math.min(series.min[i], p.val);
            series.max[i] = Math.max(series.max[i], p.val);
        }
        if (p.ts >= lastTs[i]) {
            lastTs[i] = p.ts;
            series.last[i] = p.val;
        }
    }
}
export function markInvalid(series, from, to) {
    const a = Math.max(0, Math.ceil((from - series.t0) / series.stepMs));
    const b = Math.min(series.length - 1, Math.ceil((to - series.t0) / series.stepMs) - 1);
    for (let i = a; i <= b; i++) {
        series.valid[i] = 0;
    }
}
export function finalize(series) {
    let known = false;
    let value = 0;
    series.firstIdx = series.length;
    for (let i = 0; i < series.length; i++) {
        if (series.has[i] === 1) {
            if (!known) {
                series.firstIdx = i;
            }
            known = true;
            value = series.last[i];
            continue;
        }
        if (!known) {
            series.valid[i] = 0;
            series.last[i] = 0;
            series.min[i] = 0;
            series.max[i] = 0;
            continue;
        }
        series.last[i] = value;
        series.min[i] = value;
        series.max[i] = value;
    }
    series.lastTs = null;
}
export function applyGapRule(series, runLimit) {
    const gapTicks = Math.floor(GAP_MS / series.stepMs);
    let marked = 0;
    let i = 0;
    while (i < series.length) {
        if (series.has[i] === 1 || series.valid[i] === 0) {
            i++;
            continue;
        }
        let j = i;
        while (j + 1 < series.length && series.has[j + 1] === 0 && series.valid[j + 1] === 1) {
            j++;
        }
        if (j - i + 1 > gapTicks && i > 0 && series.last[i - 1] > runLimit) {
            for (let k = i; k <= j; k++) {
                series.valid[k] = 0;
            }
            marked += j - i + 1;
        }
        i = j + 1;
    }
    return marked;
}
export function scaled(series, factor) {
    const mul = (a) => a.map(v => v * factor);
    return { ...series, last: mul(series.last), min: mul(series.min), max: mul(series.max) };
}
export function fromPoints(points, stepMs, extendMs = 0) {
    const finite = points.filter(p => Number.isFinite(p.ts) && Number.isFinite(p.val));
    if (finite.length === 0) {
        return createSeries(0, stepMs, 0);
    }
    let first = finite[0].ts;
    let lastTs = finite[0].ts;
    for (const p of finite) {
        first = Math.min(first, p.ts);
        lastTs = Math.max(lastTs, p.ts);
    }
    const extra = Math.max(0, Math.ceil(extendMs / stepMs));
    const series = createSeries(first, stepMs, Math.floor((lastTs - first) / stepMs) + 2 + extra);
    foldPoints(series, finite);
    finalize(series);
    return series;
}
export function quantOf(unitFactor) {
    return unitFactor >= 1000 ? 100_000 : 100;
}
export function encodeCells(cells, q) {
    const out = [];
    let prev = "";
    for (const c of cells) {
        let entry;
        if (!c.valid || !Number.isFinite(c.last)) {
            entry = [1, null];
        }
        else {
            const last = Math.round(c.last * q);
            const min = Math.round(Math.min(c.min, c.last) * q);
            const max = Math.round(Math.max(c.max, c.last) * q);
            entry = min === last && max === last ? [1, last] : [1, last, min, max];
        }
        const key = JSON.stringify(entry.slice(1));
        const top = out.at(-1);
        if (top && key === prev) {
            top[0]++;
        }
        else {
            out.push(entry);
            prev = key;
        }
    }
    return JSON.stringify(out);
}
export function decodeCells(data, q) {
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
        throw new Error("invalid cell data");
    }
    const out = [];
    for (const raw of parsed) {
        if (!Array.isArray(raw) || typeof raw[0] !== "number" || raw[0] < 1) {
            throw new Error("invalid cell entry");
        }
        const [n, last, min, max] = raw;
        for (let k = 0; k < n; k++) {
            if (last === null || typeof last !== "number") {
                out.push({ min: 0, max: 0, last: 0, valid: false });
            }
            else {
                out.push({ last: last / q, min: (min ?? last) / q, max: (max ?? last) / q, valid: true });
            }
        }
    }
    return out;
}
export function fromCells(cells, t0, stepMs, factor = 1) {
    const s = createSeries(t0, stepMs, cells.length);
    let value = 0;
    let first = -1;
    cells.forEach((c, i) => {
        if (c.valid) {
            value = c.last * factor;
            s.last[i] = value;
            s.min[i] = Math.min(c.min, c.last) * factor;
            s.max[i] = Math.max(c.max, c.last) * factor;
            s.has[i] = 1;
            s.points++;
            if (first < 0) {
                first = i;
            }
        }
        else {
            s.last[i] = value;
            s.min[i] = value;
            s.max[i] = value;
            s.valid[i] = 0;
        }
    });
    s.lastTs = null;
    s.firstIdx = first < 0 ? cells.length : first;
    return s;
}
export function fromStored(run, factor = 1) {
    return fromCells(decodeCells(run.data, run.q), run.ts, run.step, factor);
}
//# sourceMappingURL=ticks.js.map