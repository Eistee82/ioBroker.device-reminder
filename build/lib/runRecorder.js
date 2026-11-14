import { MAX_PAUSE_MS, MIN_ACTIVE_MS, PAD_AFTER_MS, PAD_BEFORE_MS } from "./learn/runs.js";
export const CAPTURE_MAX_MS = 12 * 60 * 60_000;
export const CAPTURE_MAX_CELLS = 25_000;
export const RESUME_STEPS = 10;
export const CAPTURE_MAX_REPORTS = 100_000;
export class RunRecorder {
    stepMs;
    unitFactor;
    ring = [];
    open = null;
    pendingMin = null;
    pendingMax = null;
    padCells;
    ringRep = [];
    activityLimit = Number.POSITIVE_INFINITY;
    activeSince = null;
    constructor(stepMs, unitFactor) {
        this.stepMs = stepMs;
        this.unitFactor = unitFactor;
        this.padCells = Math.ceil(PAD_BEFORE_MS / stepMs);
    }
    setActivityLimit(limit) {
        this.activityLimit = Number.isNaN(limit) ? Number.POSITIVE_INFINITY : limit;
    }
    get capturing() {
        return this.open !== null;
    }
    sample(power, now) {
        const cell = {
            last: power,
            min: Math.min(power, this.pendingMin ?? power),
            max: Math.max(power, this.pendingMax ?? power),
            valid: Number.isFinite(power),
        };
        this.pendingMin = null;
        this.pendingMax = null;
        const open = this.open;
        if (open) {
            const expected = open.t0 + open.cells.length * open.stepMs;
            const missing = Math.round((now - expected) / open.stepMs);
            for (let k = 0; k < missing && open.cells.length < CAPTURE_MAX_CELLS; k++) {
                open.cells.push({ min: 0, max: 0, last: 0, valid: false });
            }
            if (open.cells.length < CAPTURE_MAX_CELLS) {
                open.cells.push(cell);
            }
            return;
        }
        const lastT = this.ring.at(-1)?.t;
        if (lastT !== undefined && now - lastT > 1.5 * this.stepMs) {
            this.ring = [];
            this.activeSince = null;
        }
        this.ring.push({ t: now, cell });
        if (this.ring.length > this.padCells) {
            this.ring.shift();
        }
        this.pruneRingRep();
        if (cell.valid && cell.last > this.activityLimit) {
            this.activeSince ??= now;
            if (now - this.activeSince >= MIN_ACTIVE_MS) {
                this.openCapture(now);
            }
        }
        else {
            this.activeSince = null;
        }
    }
    pruneRingRep() {
        const first = this.ring[0];
        if (!first) {
            this.ringRep = [];
            return;
        }
        const keepAfter = first.t - this.stepMs;
        let k = 0;
        while (k < this.ringRep.length && this.ringRep[k] <= keepAfter) {
            k++;
        }
        if (k > 0) {
            this.ringRep = this.ringRep.slice(k);
        }
    }
    openCapture(now) {
        const first = this.ring[0];
        const t0 = first ? first.t : now;
        const open = {
            t0,
            stepMs: this.stepMs,
            unitFactor: this.unitFactor,
            cells: this.ring.map(r => r.cell),
            ev: [],
            postTruncated: false,
            rep: this.ringRep.filter(t => t > t0 - this.stepMs).map(t => t - t0),
        };
        this.open = open;
        this.ring = [];
        this.ringRep = [];
        this.activeSince = null;
        return open;
    }
    event(power, now) {
        if (!Number.isFinite(power)) {
            return;
        }
        if (Number.isFinite(now)) {
            this.report(now);
        }
        this.pendingMin = Math.min(power, this.pendingMin ?? power);
        this.pendingMax = Math.max(power, this.pendingMax ?? power);
    }
    report(now) {
        const open = this.open;
        if (!open) {
            this.ringRep.push(now);
            return;
        }
        if (open.rep && open.rep.length >= CAPTURE_MAX_REPORTS) {
            delete open.rep;
        }
        open.rep?.push(now - open.t0);
    }
    onEvent(ev, now, afterFinal) {
        let open = this.open;
        if (!open) {
            if (ev !== "s") {
                return;
            }
            open = this.openCapture(now);
        }
        open.ev.push(ev === "s" && afterFinal ? [now, ev, afterFinal] : [now, ev]);
    }
    closeIfDue(now, endVal) {
        const open = this.open;
        if (!open) {
            return null;
        }
        const lastEv = open.ev.at(-1);
        let due = open.cells.length >= CAPTURE_MAX_CELLS || now - open.t0 >= CAPTURE_MAX_MS;
        if (!due && (!lastEv || lastEv[1] !== "s")) {
            const quietCells = Math.ceil(MAX_PAUSE_MS / open.stepMs);
            const tail = open.cells.slice(-quietCells);
            const quiet = tail.length >= quietCells && tail.every(c => !c.valid || c.max < endVal);
            if (lastEv) {
                const since = now - lastEv[0];
                due = since >= PAD_AFTER_MS || (since >= MAX_PAUSE_MS && quiet);
            }
            else {
                due = quiet;
            }
        }
        if (!due) {
            return null;
        }
        this.open = null;
        const tail = open.cells.slice(-this.padCells);
        const lastT = open.t0 + (open.cells.length - 1) * open.stepMs;
        this.ring = tail.map((cell, k) => ({ t: lastT - (tail.length - 1 - k) * open.stepMs, cell }));
        this.ringRep = (open.rep ?? []).map(t => t + open.t0);
        this.pruneRingRep();
        this.activeSince = null;
        return open;
    }
    snapshot() {
        return this.open ? copyOf(this.open) : null;
    }
    restore(c, now) {
        const lastT = c.t0 + (c.cells.length - 1) * c.stepMs;
        if (c.stepMs === this.stepMs && now - lastT < RESUME_STEPS * c.stepMs) {
            this.open = copyOf(c);
            return null;
        }
        return { ...c, postTruncated: true };
    }
}
function copyOf(c) {
    const copy = { ...c, cells: [...c.cells], ev: [...c.ev] };
    if (c.rep) {
        copy.rep = [...c.rep];
    }
    return copy;
}
//# sourceMappingURL=runRecorder.js.map