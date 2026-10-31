import { MAX_PAUSE_MS, PAD_AFTER_MS, PAD_BEFORE_MS } from "./learn/runs.js";
export const CAPTURE_MAX_MS = 12 * 60 * 60_000;
export const CAPTURE_MAX_CELLS = 25_000;
export const RESUME_STEPS = 10;
export class RunRecorder {
    stepMs;
    unitFactor;
    ring = [];
    open = null;
    pendingMin = null;
    pendingMax = null;
    padCells;
    constructor(stepMs, unitFactor) {
        this.stepMs = stepMs;
        this.unitFactor = unitFactor;
        this.padCells = Math.ceil(PAD_BEFORE_MS / stepMs);
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
        }
        this.ring.push({ t: now, cell });
        if (this.ring.length > this.padCells) {
            this.ring.shift();
        }
    }
    event(power) {
        if (!Number.isFinite(power)) {
            return;
        }
        this.pendingMin = Math.min(power, this.pendingMin ?? power);
        this.pendingMax = Math.max(power, this.pendingMax ?? power);
    }
    onEvent(ev, now) {
        if (!this.open) {
            if (ev !== "s") {
                return;
            }
            const first = this.ring[0];
            this.open = {
                t0: first ? first.t : now,
                stepMs: this.stepMs,
                unitFactor: this.unitFactor,
                cells: this.ring.map(r => r.cell),
                ev: [],
                postTruncated: false,
            };
            this.ring = [];
        }
        this.open.ev.push([now, ev]);
    }
    closeIfDue(now, endVal) {
        const open = this.open;
        if (!open) {
            return null;
        }
        const lastEv = open.ev.at(-1);
        let due = open.cells.length >= CAPTURE_MAX_CELLS || now - open.t0 >= CAPTURE_MAX_MS;
        if (!due && lastEv && lastEv[1] !== "s") {
            const since = now - lastEv[0];
            const quietCells = Math.ceil(MAX_PAUSE_MS / open.stepMs);
            const tail = open.cells.slice(-quietCells);
            const quiet = tail.length >= quietCells && tail.every(c => !c.valid || c.max < endVal);
            due = since >= PAD_AFTER_MS || (since >= MAX_PAUSE_MS && quiet);
        }
        if (!due) {
            return null;
        }
        this.open = null;
        const tail = open.cells.slice(-this.padCells);
        const lastT = open.t0 + (open.cells.length - 1) * open.stepMs;
        this.ring = tail.map((cell, k) => ({ t: lastT - (tail.length - 1 - k) * open.stepMs, cell }));
        return open;
    }
    snapshot() {
        return this.open ? { ...this.open, cells: [...this.open.cells], ev: [...this.open.ev] } : null;
    }
    restore(c, now) {
        const lastT = c.t0 + (c.cells.length - 1) * c.stepMs;
        if (c.stepMs === this.stepMs && now - lastT < RESUME_STEPS * c.stepMs) {
            this.open = { ...c, cells: [...c.cells], ev: [...c.ev] };
            return null;
        }
        return { ...c, postTruncated: true };
    }
}
//# sourceMappingURL=runRecorder.js.map