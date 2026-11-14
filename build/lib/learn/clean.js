export const TIME_JUMP_MS = 60_000;
export function cleanPoints(input) {
    const timeJumps = [];
    const unknown = [];
    const kept = [];
    let invalid = 0;
    let prevTs = null;
    let maxTs = Number.NEGATIVE_INFINITY;
    const seen = new Map();
    for (const p of input) {
        if (!Number.isFinite(p.ts)) {
            invalid++;
            continue;
        }
        const raw = p.val;
        if (raw !== null && Number.isFinite(raw)) {
            let atTs = seen.get(p.ts);
            if (atTs?.has(raw)) {
                continue;
            }
            if (!atTs) {
                atTs = new Set();
                seen.set(p.ts, atTs);
            }
            atTs.add(raw);
        }
        if (prevTs !== null && prevTs - p.ts > TIME_JUMP_MS) {
            timeJumps.push({ at: p.ts, backMs: prevTs - p.ts });
            unknown.push({ from: p.ts, to: maxTs });
        }
        prevTs = p.ts;
        maxTs = Math.max(maxTs, p.ts);
        if (raw === null || !Number.isFinite(raw)) {
            invalid++;
            continue;
        }
        if (raw < 0) {
            invalid++;
        }
        kept.push({ ts: p.ts, val: Math.max(0, raw) });
    }
    kept.sort((a, b) => a.ts - b.ts);
    unknown.sort((a, b) => a.from - b.from);
    const merged = [];
    for (const u of unknown) {
        const top = merged.at(-1);
        if (top && u.from <= top.to) {
            top.to = Math.max(top.to, u.to);
        }
        else {
            merged.push({ ...u });
        }
    }
    return {
        points: kept,
        invalid,
        invalidShare: input.length > 0 ? invalid / input.length : 0,
        timeJumps,
        unknown: merged,
    };
}
//# sourceMappingURL=clean.js.map