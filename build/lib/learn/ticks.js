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
    for (let i = 0; i < series.length; i++) {
        if (series.has[i] === 1) {
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
export function fromPoints(points, stepMs) {
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
    const series = createSeries(first, stepMs, Math.floor((lastTs - first) / stepMs) + 2);
    foldPoints(series, finite);
    finalize(series);
    return series;
}
//# sourceMappingURL=ticks.js.map