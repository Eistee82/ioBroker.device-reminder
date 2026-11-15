import { DEFAULT_PHASE_NAMES, SYSTEM_PHASES } from "./model.js";
const BLOCK_MIN_MS = 20_000;
const MAX_SEGMENTS = 1000;
function suspectOf(bands, holds) {
    return bands.map(b => {
        const h = holds?.find(x => x.band === b.id);
        return h && h.suspectSec > 0 ? h.suspectSec * 1000 : Infinity;
    });
}
export function phaseHolds(model, base) {
    if (!base || base.holds.length === 0) {
        return null;
    }
    const out = [];
    for (const b of model.bands) {
        let best = null;
        for (const own of base.bands) {
            if (own.max <= b.min || own.min >= b.max) {
                continue;
            }
            const h = base.holds.find(x => x.band === own.id);
            if (h && (!best || h.suspectSec > best.suspectSec)) {
                best = h;
            }
        }
        if (best) {
            out.push({ ...best, band: b.id });
        }
    }
    return out.length > 0 ? out : null;
}
export class PhaseTracker {
    bands;
    classes;
    triggers;
    suspectMs;
    levelIdx;
    windowMs;
    dtCapMs;
    names;
    maxSegments;
    continuous;
    trailerPhase;
    queue = [];
    lastT;
    held;
    lastObs = 0;
    win = [];
    winMs = 0;
    cur = -1;
    out = null;
    cand = null;
    segs = [];
    segPreds = [];
    disp = null;
    nextPred = null;
    trig = null;
    inRun = false;
    runStart = null;
    emptySince = 0;
    sys = null;
    ctx = { inTrailer: false, settling: false };
    liveId = null;
    edges = [];
    constructor(model, holds, pollSec, names, opts = {}) {
        this.bands = model.bands;
        this.classes = this.bands.map(b => model.phases.filter(p => p.band === b.id && !p.trigger && !p.trailer));
        this.triggers = this.bands.map(b => model.phases.filter(p => p.band === b.id && p.trigger && !p.trailer));
        this.trailerPhase = model.phases.find(p => p.trailer) ?? null;
        this.suspectMs = suspectOf(this.bands, holds);
        this.levelIdx = this.bands.flatMap((b, k) => (b.smoothing === "level" ? [k] : []));
        this.windowMs = Math.max(0, ...this.levelIdx.map(k => this.bands[k].windowSec * 1000));
        this.dtCapMs = Math.max(2 * Math.max(1, pollSec), 60) * 1000;
        this.names = { ...DEFAULT_PHASE_NAMES, ...(names ?? {}) };
        this.maxSegments = opts.maxSegments ?? MAX_SEGMENTS;
        this.continuous = model.scope === "continuous";
    }
    setHolds(holds) {
        this.suspectMs = suspectOf(this.bands, holds);
    }
    observe(val, t) {
        if (!Number.isFinite(val) || !Number.isFinite(t)) {
            return;
        }
        const last = this.queue.at(-1);
        this.queue.push({ val, ts: last && last.ts > t ? last.ts : t });
    }
    advance(t) {
        this.processTo(t);
        this.applyContext(t);
        this.sync();
        const out = this.edges;
        this.edges = [];
        return out;
    }
    onRun(kind, at) {
        if (this.continuous) {
            return;
        }
        this.processTo(at);
        if (kind === "start") {
            this.segs = [];
            this.segPreds = [];
            this.trig = null;
            this.inRun = true;
            this.runStart = at;
            if (!this.sys) {
                this.disp = null;
                this.nextPred = "start";
                this.openBand(this.cur, at, 0);
            }
        }
        else if (this.inRun) {
            this.inRun = false;
            if (!this.sys) {
                this.closeDisp(at);
                this.disp = null;
                this.trig = null;
            }
            this.emptySince = at;
        }
        this.sync();
    }
    setContext(c) {
        this.ctx = { inTrailer: c.inTrailer, settling: c.settling };
    }
    get current() {
        const d = this.disp;
        if (!d) {
            return { id: null, name: "", since: this.emptySince, unknown: false };
        }
        const { id, name } = this.liveOf(d);
        return { id, name, since: d.from, unknown: d.kind === "unknown" };
    }
    timeline() {
        const out = this.segs.map(s => ({ ...s }));
        const d = this.disp;
        if (d && this.lastT !== undefined && this.lastT > d.from) {
            const { id, name } = this.liveOf(d);
            out.push({ id, name, from: d.from, to: this.lastT, final: false });
        }
        return out;
    }
    reset() {
        this.queue = [];
        this.lastT = undefined;
        this.held = undefined;
        this.lastObs = 0;
        this.win = [];
        this.winMs = 0;
        this.cur = -1;
        this.out = null;
        this.cand = null;
        this.segs = [];
        this.segPreds = [];
        this.disp = null;
        this.nextPred = null;
        this.trig = null;
        this.inRun = false;
        this.runStart = null;
        this.emptySince = 0;
        this.sys = null;
        this.ctx = { inTrailer: false, settling: false };
        this.liveId = null;
        this.edges = [];
    }
    processTo(t) {
        if (this.lastT === undefined) {
            const first = this.queue[0];
            if (!first || first.ts > t) {
                return;
            }
            this.lastT = first.ts;
        }
        if (t <= this.lastT) {
            return;
        }
        if (t - this.lastT > this.dtCapMs) {
            const skipTo = t - this.dtCapMs;
            while (this.queue.length > 0 && this.queue[0].ts <= skipTo) {
                this.take(this.queue.shift());
            }
            this.lastT = skipTo;
        }
        while (this.queue.length > 0 && this.queue[0].ts <= t) {
            const e = this.queue.shift();
            if (e.ts > this.lastT && this.held !== undefined) {
                this.step(this.lastT, e.ts, this.held);
            }
            this.lastT = Math.max(this.lastT, e.ts);
            this.take(e);
        }
        if (t > this.lastT) {
            if (this.held !== undefined) {
                this.step(this.lastT, t, this.held);
            }
            this.lastT = t;
        }
    }
    take(e) {
        const first = this.held === undefined;
        this.held = e.val;
        this.lastObs = e.ts;
        if (this.disp?.kind === "unknown") {
            this.closeDisp(e.ts);
            this.cur = -1;
            this.out = null;
            this.cand = null;
            this.win = [];
            this.winMs = 0;
            this.openBand(-1, e.ts, 0);
        }
        else if (first && this.continuous && !this.disp) {
            this.openBand(-1, e.ts, 0);
        }
    }
    bandIndex(val) {
        for (let k = 0; k < this.bands.length; k++) {
            if (val >= this.bands[k].min && val < this.bands[k].max) {
                return k;
            }
        }
        return -1;
    }
    enterMs(k) {
        if (k < 0) {
            return 0;
        }
        const b = this.bands[k];
        switch (b.smoothing) {
            case "block":
                return BLOCK_MIN_MS;
            case "debounce":
                return b.dipSec * 1000;
            default:
                return 0;
        }
    }
    tolMs(k) {
        return k < 0 ? 0 : this.bands[k].dipSec * 1000;
    }
    step(a, b, v) {
        const len = b - a;
        if (len <= 0) {
            return;
        }
        const raw = this.bandIndex(v);
        this.pushWindow(v, len);
        const label = this.levelLabel(raw);
        if (this.disp) {
            this.disp.dur += len;
        }
        const t = this.trig;
        const hist = t?.hist.at(-1);
        if (hist) {
            hist.dur += len;
        }
        this.readBands(label, a, len);
        this.trackTrigger(raw, a, b, len, this.trig !== t);
        if (this.disp &&
            this.disp.kind !== "unknown" &&
            this.disp.kind !== "system" &&
            this.held !== undefined &&
            raw >= 0 &&
            b - this.lastObs > this.suspectMs[raw]) {
            this.enterUnknown(Math.max(this.lastObs + this.suspectMs[raw], this.disp.from));
        }
    }
    pushWindow(v, len) {
        if (this.windowMs <= 0) {
            return;
        }
        const last = this.win.at(-1);
        if (last && last.val === v) {
            last.ms += len;
        }
        else {
            this.win.push({ val: v, ms: len });
        }
        this.winMs += len;
        while (this.win.length > 1 && this.winMs - this.win[0].ms >= this.windowMs) {
            this.winMs -= this.win.shift().ms;
        }
    }
    windowStats(ms) {
        const take = [];
        let left = ms;
        for (let i = this.win.length - 1; i >= 0 && left > 0; i--) {
            const part = Math.min(left, this.win[i].ms);
            take.push({ val: this.win[i].val, ms: part });
            left -= part;
        }
        const total = ms - Math.max(0, left);
        const max = Math.max(...take.map(x => x.val));
        take.sort((x, y) => x.val - y.val);
        let acc = 0;
        let median = take[0]?.val ?? 0;
        for (const x of take) {
            acc += x.ms;
            median = x.val;
            if (acc >= total / 2) {
                break;
            }
        }
        return { median, max };
    }
    levelLabel(raw) {
        let best = raw;
        for (const k of this.levelIdx) {
            if (k <= raw) {
                continue;
            }
            const b = this.bands[k];
            const { median, max } = this.windowStats(Math.max(1, b.windowSec * 1000));
            const inBand = (x) => x >= b.min && x < b.max;
            if (inBand(median) || (inBand(max) && median < b.min)) {
                if (k === this.cur) {
                    return k;
                }
                best = Math.max(best, k);
            }
        }
        return best;
    }
    readBands(label, a, len) {
        if (label === this.cur) {
            this.out = null;
            this.cand = null;
            return;
        }
        this.out ??= { dur: 0 };
        this.out.dur += len;
        if (!this.cand || this.cand.band !== label) {
            this.cand = { band: label, from: a, dur: 0 };
        }
        this.cand.dur += len;
        const c = this.cand;
        const peak = c.band >= 0 && this.bands[c.band].smoothing === "peak";
        if (!peak) {
            if (c.dur < this.enterMs(c.band)) {
                return;
            }
            if (c.band < this.cur && this.out.dur < this.tolMs(this.cur)) {
                return;
            }
        }
        this.switchBand(c.band, c.from, c.dur);
    }
    switchBand(band, from, dur) {
        this.cur = band;
        this.out = null;
        this.cand = null;
        const t = this.trig;
        if (t) {
            const last = t.hist.at(-1);
            last.dur = Math.max(0, last.dur - dur);
            t.hist.push({ band, from: Math.max(from, last.from), dur });
            if (t.phase) {
                return;
            }
        }
        const d = this.disp;
        if (!d || d.kind !== "band") {
            return;
        }
        const f = Math.max(from, d.from);
        this.closeDisp(f, Math.max(0, d.dur - dur));
        this.openBand(band, f, dur, true);
    }
    trackTrigger(raw, a, b, len, fresh) {
        const t = this.trig;
        if (!t) {
            return;
        }
        if (!fresh || t.phase) {
            t.elapsed += len;
        }
        if (t.phase) {
            const trig = t.phase.trigger;
            if (raw !== t.band && !trig.confirm.includes(this.bands[raw]?.id ?? "")) {
                this.revoke();
                return;
            }
            const tailMs = trig.tailSec * 1000;
            if (t.elapsed >= tailMs) {
                this.endTail(Math.max(a, b - (t.elapsed - tailMs)), b);
            }
            return;
        }
        if (raw === t.band) {
            if (t.wasOut) {
                t.sinceIn = 0;
                t.wasOut = false;
            }
        }
        else {
            t.wasOut = true;
        }
        if (!fresh) {
            t.sinceIn += len;
        }
        const before = fresh ? t.sinceIn : t.sinceIn - len;
        const id = this.bands[raw]?.id;
        const phase = id === undefined ? undefined : t.phases.find(p => p.trigger.confirm.includes(id));
        if (phase) {
            t.inConf ??= { startSince: before, dur: 0 };
            t.inConf.dur += len;
            const trig = phase.trigger;
            if (t.inConf.startSince <= trig.confirmSec * 1000 && t.inConf.dur >= this.enterMs(raw)) {
                this.confirm(t, phase);
                return;
            }
        }
        else {
            t.inConf = null;
        }
        const maxConfirm = Math.max(...t.phases.map(p => p.trigger.confirmSec * 1000));
        if (t.sinceIn > maxConfirm && !(t.inConf && t.inConf.startSince <= maxConfirm)) {
            this.trig = null;
        }
    }
    startTrigger(band, from, dur) {
        const phases = this.triggers[band]?.filter(p => this.fits(p, this.disp?.pred ?? null, from));
        this.trig =
            phases && phases.length > 0
                ? {
                    band,
                    phases,
                    entry: from,
                    elapsed: dur,
                    sinceIn: dur,
                    wasOut: false,
                    inConf: null,
                    phase: null,
                    hist: [{ band, from, dur }],
                }
                : null;
    }
    confirm(t, phase) {
        let pred = this.disp?.from === t.entry ? this.disp.pred : null;
        while (this.segs.length > 0 && this.segs.at(-1).from >= t.entry) {
            this.segs.pop();
            pred = this.segPreds.pop() ?? null;
        }
        this.disp = { kind: "trigger", band: t.band, phase, sys: null, from: t.entry, dur: t.elapsed, pred };
        t.phase = phase;
    }
    revoke() {
        const t = this.trig;
        const d = this.disp;
        this.trig = null;
        this.disp = null;
        this.nextPred = d.pred;
        t.hist.forEach((h, i) => {
            const next = t.hist[i + 1];
            this.disp = {
                kind: "band",
                band: h.band,
                phase: null,
                sys: null,
                from: h.from,
                dur: h.dur,
                pred: this.nextPred,
            };
            if (next) {
                this.closeDisp(next.from, h.dur);
            }
        });
    }
    endTail(at, b) {
        this.closeDisp(at);
        this.trig = null;
        this.openBand(this.cur, at, b - at);
    }
    enterUnknown(at) {
        this.trig = null;
        this.closeDisp(at);
        this.disp = { kind: "unknown", band: -1, phase: null, sys: null, from: at, dur: 0, pred: this.nextPred };
    }
    applyContext(t) {
        const want = this.ctx.inTrailer ? SYSTEM_PHASES.antiCrease : this.ctx.settling ? SYSTEM_PHASES.afterRun : null;
        if (want === this.sys) {
            return;
        }
        this.sys = want;
        this.closeDisp(t);
        this.trig = null;
        if (want) {
            this.disp = { kind: "system", band: -1, phase: null, sys: want, from: t, dur: 0, pred: this.nextPred };
        }
        else if (this.continuous || this.inRun) {
            this.openBand(this.cur, t, 0);
        }
        else {
            this.disp = null;
            this.emptySince = t;
        }
    }
    openBand(band, from, dur, entry = false) {
        this.disp = { kind: "band", band, phase: null, sys: null, from, dur, pred: this.nextPred };
        if (entry && band >= 0 && this.triggers[band].length > 0) {
            this.startTrigger(band, from, dur);
        }
    }
    closeDisp(to, dur) {
        const d = this.disp;
        if (!d) {
            return;
        }
        this.disp = null;
        const end = Math.max(to, d.from);
        if (end <= d.from) {
            this.nextPred = d.pred;
            return;
        }
        const fin = this.finalOf(d, dur ?? d.dur);
        this.segs.push({ id: fin.id, name: fin.name, from: d.from, to: end, final: true });
        this.segPreds.push(d.pred);
        while (this.segs.length > this.maxSegments) {
            this.segs.shift();
            this.segPreds.shift();
        }
        const live = this.liveOf(d, dur ?? d.dur);
        if (fin.phase && fin.id !== live.id) {
            this.edges.push({ id: fin.id, edge: "end", at: end });
        }
        this.nextPred = d.kind === "band" && d.band < 0 ? "idle" : fin.id;
    }
    fits(p, pred, from) {
        if (p.after && (pred === null || !p.after.includes(pred))) {
            return false;
        }
        if (p.notBeforeSec !== undefined && !this.continuous) {
            return this.runStart !== null && from - this.runStart >= p.notBeforeSec * 1000;
        }
        return true;
    }
    matching(d, dur) {
        return this.classes[d.band].filter(p => this.fits(p, d.pred, d.from) && dur >= p.minSec * 1000 && (p.maxSec === 0 || dur <= p.maxSec * 1000));
    }
    bandName(d) {
        switch (d.kind) {
            case "unknown":
                return { id: SYSTEM_PHASES.unknown, name: this.names.unknown, phase: null };
            case "system":
                if (d.sys === SYSTEM_PHASES.antiCrease && this.trailerPhase) {
                    return { id: this.trailerPhase.id, name: this.trailerPhase.name, phase: this.trailerPhase };
                }
                return { id: d.sys, name: this.names[d.sys] ?? d.sys, phase: null };
            case "trigger":
                return { id: d.phase.id, name: d.phase.name, phase: d.phase };
            default:
                if (d.band < 0) {
                    return { id: SYSTEM_PHASES.rest, name: this.names.rest, phase: null };
                }
                return { id: this.bands[d.band].id, name: this.bands[d.band].name, phase: null };
        }
    }
    liveOf(d, dur = d.dur) {
        if (d.kind === "band" && d.band >= 0) {
            const m = this.matching(d, dur);
            if (m.length === 1 && m[0].decided === "live") {
                return { id: m[0].id, name: m[0].name, phase: m[0] };
            }
        }
        if (d.kind === "trigger" && d.phase.decided === "end") {
            const b = this.bands[d.band];
            return { id: b.id, name: b.name, phase: null };
        }
        return this.bandName(d);
    }
    finalOf(d, dur) {
        if (d.kind === "band" && d.band >= 0) {
            const m = this.matching(d, dur);
            if (m.length === 1) {
                return { id: m[0].id, name: m[0].name, phase: m[0] };
            }
        }
        return this.bandName(d);
    }
    sync() {
        const st = this.current;
        if (st.id === this.liveId) {
            return;
        }
        if (this.liveId !== null) {
            this.edges.push({ id: this.liveId, edge: "end", at: st.since });
        }
        if (st.id !== null) {
            this.edges.push({ id: st.id, edge: "start", at: st.since });
        }
        this.liveId = st.id;
    }
}
export function replayPhases(model, points, pollSec, runs, opts = {}) {
    const pts = points.filter(p => Number.isFinite(p.ts) && Number.isFinite(p.val)).sort((x, y) => x.ts - y.ts);
    const timeline = [];
    const live = [];
    if (pts.length === 0) {
        return { timeline, live };
    }
    const tr = new PhaseTracker(model, opts.holds ?? null, pollSec, opts.names, { maxSegments: Infinity });
    const events = (runs ?? [])
        .flatMap(r => [
        { at: r.start, kind: "start" },
        { at: r.end, kind: "end" },
    ])
        .sort((x, y) => x.at - y.at || (x.kind === "end" ? -1 : 1));
    const stepMs = Math.max(1, pollSec) * 1000;
    let shown = { id: null, name: "" };
    const note = (t) => {
        const st = tr.current;
        if (st.id !== shown.id || st.name !== shown.name) {
            shown = { id: st.id, name: st.name };
            live.push({ t, id: st.id, name: st.name });
        }
    };
    let k = 0;
    let e = 0;
    const last = pts.at(-1).ts;
    for (let now = pts[0].ts; now <= last; now += stepMs) {
        while (k < pts.length && pts[k].ts <= now) {
            tr.observe(pts[k].val, pts[k].ts);
            k++;
        }
        while (e < events.length && events[e].at <= now) {
            const ev = events[e++];
            if (ev.kind === "start" && model.scope === "run") {
                timeline.push(...tr.timeline());
            }
            tr.onRun(ev.kind, ev.at);
            note(ev.at);
        }
        tr.advance(now);
        note(now);
    }
    timeline.push(...tr.timeline());
    return { timeline, live };
}
//# sourceMappingURL=tracker.js.map