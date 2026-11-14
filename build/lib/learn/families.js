export const FAMILY_DISTANCE = 0.35;
function vectorOf(f, bands) {
    const v = [
        Math.log(Math.max(1, f.coreSec)),
        Math.log(Math.max(0.001, f.energyWh)),
        f.hiShare,
        f.maxPauseSec / 600,
        f.nPause / 10,
        f.trailer ? 1 : 0,
        Math.log(Math.max(0, f.blockMean) + 1),
    ];
    if (bands) {
        v.push(Math.log(Math.max(0, f.topBandSec ?? 0) + 1), f.finalBandBlocks ?? 0);
    }
    return v;
}
function hasBandFeatures(f) {
    return Number.isFinite(f.topBandSec) && Number.isFinite(f.finalBandBlocks);
}
export function assignFamilies(features, known, nextId) {
    const n = features.length;
    if (n === 0) {
        return { families: [], nextId };
    }
    const bands = features.every(hasBandFeatures);
    const vecs = features.map(f => vectorOf(f, bands));
    const dim = vecs[0].length;
    const mean = Array.from({ length: dim }, (_, d) => vecs.reduce((s, v) => s + v[d], 0) / n);
    const sd = Array.from({ length: dim }, (_, d) => Math.sqrt(vecs.reduce((s, v) => s + (v[d] - mean[d]) ** 2, 0) / n));
    const z = vecs.map(v => v.map((x, d) => (sd[d] > 1e-9 ? (x - mean[d]) / sd[d] : 0)));
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i) => {
        let r = i;
        while (parent[r] !== r) {
            r = parent[r];
        }
        return r;
    };
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dist = Math.sqrt(z[i].reduce((s, x, d) => s + (x - z[j][d]) ** 2, 0) / dim);
            if (dist < FAMILY_DISTANCE) {
                parent[find(i)] = find(j);
            }
        }
    }
    const groupId = new Map();
    for (let i = 0; i < n; i++) {
        if (known[i] >= 0) {
            const root = find(i);
            groupId.set(root, Math.min(groupId.get(root) ?? Number.POSITIVE_INFINITY, known[i]));
        }
    }
    let next = nextId;
    const families = features.map((_, i) => {
        const root = find(i);
        let id = groupId.get(root);
        if (id === undefined) {
            id = next++;
            groupId.set(root, id);
        }
        return id;
    });
    return { families, nextId: next };
}
//# sourceMappingURL=families.js.map