export const FINAL_ACT_WINDOW_MS = 5 * 60_000;
const QUIET_DEFAULT_SEC = 120;
const CHECK_DEFAULT_SEC = 1800;
export const LOCK_DEFAULT_SEC = 14_400;
export function finalFloors(f, pollSec, standby) {
    const poll = Math.max(1, pollSec);
    const dip = Math.max(f.finalDipSec > 0 ? f.finalDipSec : Math.max(60, 2 * poll), 2 * poll);
    return {
        ...f,
        finalMinSec: Math.max(f.finalMinSec, 2 * poll),
        finalDipSec: dip,
        finalQuietSec: Math.max(f.finalQuietSec > 0 ? f.finalQuietSec : QUIET_DEFAULT_SEC, 2 * poll, dip),
        finalRestVal: f.finalRestVal > 0 ? f.finalRestVal : standby,
        finalRestSec: Math.max(f.finalRestSec > 0 ? f.finalRestSec : Math.max(60, 3 * poll), 3 * poll),
        finalCheckSec: f.finalCheckSec > 0 ? f.finalCheckSec : CHECK_DEFAULT_SEC,
        finalLockSec: Math.max(f.finalLockSec > 0 ? f.finalLockSec : LOCK_DEFAULT_SEC, 2 * poll),
    };
}
export class FinalPhaseFilter {
    inner;
    minVal;
    maxVal;
    hotVal;
    afterMs;
    minMs;
    quietMs;
    dipMs;
    restVal;
    restMs;
    actVal;
    actShare;
    checkMs;
    lockMs;
    dtCapMs;
    standbyVal;
    locked = false;
    lastTick = null;
    heldVal = 0;
    runStart = null;
    blockStart = null;
    bandMs = 0;
    belowMs = 0;
    qualified = false;
    lockTime = null;
    hotMs = 0;
    lockBandMs = 0;
    restRunMs = 0;
    act = [];
    actMs = 0;
    actAboveMs = 0;
    backdate = false;
    backdateFloor = 0;
    actFrom = null;
    pendingExit = null;
    shownExit = null;
    counts = { early: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 };
    constructor(inner, s, o) {
        this.inner = inner;
        const poll = Math.max(1, o.pollSec);
        const f = finalFloors(s, poll, o.standby);
        this.minVal = f.finalMinVal;
        this.maxVal = f.finalMaxVal > 0 ? f.finalMaxVal : Infinity;
        this.hotVal = f.finalHotVal;
        this.afterMs = Math.max(0, f.finalAfterSec) * 1000;
        this.minMs = f.finalMinSec * 1000;
        this.quietMs = f.finalQuietSec * 1000;
        this.dipMs = f.finalDipSec * 1000;
        this.restVal = f.finalRestVal;
        this.restMs = f.finalRestSec * 1000;
        this.actVal = f.finalActVal;
        this.actShare = f.finalActShare;
        this.checkMs = f.finalCheckSec * 1000;
        this.lockMs = f.finalLockSec * 1000;
        this.dtCapMs = Math.max(2 * poll, 60) * 1000;
        this.standbyVal = o.standby || 1;
        if (o.resumeLockAt !== undefined && Number.isFinite(o.resumeLockAt)) {
            this.locked = true;
            this.lockTime = o.resumeLockAt;
        }
    }
    get started() {
        return !this.locked && this.inner.started;
    }
    get settling() {
        return this.locked;
    }
    get finalExit() {
        return this.shownExit;
    }
    get lockAt() {
        return this.locked ? this.lockTime : null;
    }
    get stats() {
        return { ...this.counts };
    }
    reset() {
        this.inner.reset();
        this.locked = false;
        this.lockTime = null;
        this.lastTick = null;
        this.heldVal = 0;
        this.clearRun();
        this.clearLock();
        this.backdate = false;
        this.actFrom = null;
        this.pendingExit = null;
        this.shownExit = null;
        this.counts = { early: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 };
    }
    tick(power, now, hints) {
        this.shownExit = null;
        const r = this.inner.tick(power, now, hints);
        const prev = this.lastTick;
        let dt = 0;
        if (prev !== null && now < prev) {
            this.clearBlock();
            this.clearLock();
        }
        else if (prev !== null) {
            dt = Math.min(now - prev, this.dtCapMs);
        }
        const held = this.heldVal;
        this.heldVal = power;
        this.lastTick = now;
        if (this.locked || this.backdate) {
            this.trackActivity(power, now);
        }
        if (this.locked) {
            return this.lockStep(r, power, now, { held, dt });
        }
        const out = this.passOn(r, r.events, now);
        if (this.runStart !== null && this.inner.started && prev !== null && now >= prev) {
            const from = Math.max(prev, this.runStart);
            if (this.trackBlock(held, Math.max(0, Math.min(dt, now - from)), from)) {
                return this.earlyEnd(r, out, power, now);
            }
        }
        return out;
    }
    feed(power, now) {
        this.shownExit = null;
        if (!this.inner.feed) {
            return { events: [], status: null, average: null, started: this.started };
        }
        const r = this.inner.feed(power, now);
        if (this.locked) {
            return this.lockStep(r, power, now, null);
        }
        return this.passOn(r, r.events, now);
    }
    passOn(r, events, now) {
        const offset = r.events.length - events.length;
        let times = r.times ? r.times.slice(offset) : undefined;
        events.forEach((ev, k) => {
            let at = r.times?.[offset + k] ?? now;
            if (ev === "started") {
                if (this.backdate) {
                    const from = Math.max(this.backdateFloor, this.actFrom ?? at);
                    if (from < at) {
                        at = from;
                        times ??= events.map(() => now);
                        times[k] = at;
                    }
                    this.backdate = false;
                    this.actFrom = null;
                }
                this.runStart = at;
                this.clearBlock();
                if (this.pendingExit !== null) {
                    this.shownExit = this.pendingExit;
                    this.pendingExit = null;
                }
            }
            else if (ev === "finished" || ev === "aborted") {
                this.clearRun();
            }
        });
        if (offset === 0 && times === r.times) {
            return r;
        }
        return { ...r, events: [...events], ...(times ? { times } : {}), started: this.started };
    }
    trackBlock(held, dt, from) {
        if (held >= this.maxVal) {
            this.clearBlock();
            return false;
        }
        if (held >= this.minVal) {
            this.blockStart ??= from;
            this.bandMs += dt;
            this.belowMs = 0;
        }
        else {
            this.belowMs += dt;
            if (!this.qualified && this.belowMs > this.dipMs) {
                this.blockStart = null;
                this.bandMs = 0;
            }
        }
        if (!this.qualified &&
            this.blockStart !== null &&
            this.runStart !== null &&
            this.blockStart >= this.runStart + this.afterMs &&
            this.bandMs >= this.minMs) {
            this.qualified = true;
        }
        return this.qualified && this.belowMs >= this.quietMs;
    }
    earlyEnd(r, out, power, now) {
        const events = [];
        const times = [];
        out.events.forEach((ev, k) => {
            if (ev !== "running" && ev !== "finished") {
                events.push(ev);
                times.push(out.times?.[k] ?? now);
            }
        });
        events.push("finished");
        times.push(now);
        this.counts.early++;
        this.clearRun();
        this.clearLock();
        this.locked = true;
        this.lockTime = now;
        this.backdate = false;
        this.actFrom = power >= this.restVal ? now : null;
        return { events, times, status: this.lockStatus(power), average: r.average, started: false };
    }
    lockStep(r, power, now, t) {
        if (t !== null) {
            this.countLock(t.held, t.dt);
        }
        const endIdx = r.events.findIndex(ev => ev === "finished" || ev === "aborted");
        if (endIdx >= 0) {
            this.leave("a", false);
            const rest = this.passOn(r, r.events.slice(endIdx + 1), now);
            return {
                ...rest,
                status: rest.events.length > 0 ? r.status : this.lockStatus(power),
                started: this.started,
            };
        }
        const swallowed = {
            events: [],
            status: this.lockStatus(power),
            average: r.average,
            started: false,
        };
        if (t === null || this.lockTime === null) {
            return swallowed;
        }
        const since = now - this.lockTime;
        const inBand = t.held >= this.minVal && t.held < this.maxVal;
        let exit = null;
        if (this.hotVal > 0 && this.hotMs >= this.dipMs) {
            exit = "c";
        }
        else if (since <= this.checkMs && this.lockBandMs >= this.minMs / 2) {
            exit = "g";
        }
        else if (since > this.checkMs && inBand) {
            exit = "d";
        }
        else if (this.actVal > 0 &&
            this.actShare > 0 &&
            this.actMs >= FINAL_ACT_WINDOW_MS &&
            this.actAboveMs >= this.actShare * this.actMs) {
            exit = "f";
        }
        else if (this.restRunMs >= this.restMs) {
            exit = "b";
        }
        else if (since >= this.lockMs) {
            exit = "e";
        }
        if (exit !== null) {
            this.leave(exit, true);
        }
        return swallowed;
    }
    countLock(held, dt) {
        this.hotMs = this.hotVal > 0 && held >= this.hotVal ? this.hotMs + dt : 0;
        if (held >= this.minVal && held < this.maxVal) {
            this.lockBandMs += dt;
        }
        this.restRunMs = held < this.restVal ? this.restRunMs + dt : 0;
        if (dt <= 0) {
            return;
        }
        const above = this.actVal > 0 && held > this.actVal;
        this.act.push({ ms: dt, above });
        this.actMs += dt;
        if (above) {
            this.actAboveMs += dt;
        }
        while (this.actMs > FINAL_ACT_WINDOW_MS) {
            const first = this.act[0];
            const cut = Math.min(first.ms, this.actMs - FINAL_ACT_WINDOW_MS);
            first.ms -= cut;
            this.actMs -= cut;
            if (first.above) {
                this.actAboveMs -= cut;
            }
            if (first.ms <= 0) {
                this.act.shift();
            }
        }
    }
    trackActivity(power, now) {
        if (power < this.restVal) {
            this.actFrom = null;
        }
        else {
            this.actFrom ??= now;
        }
    }
    leave(exit, reset) {
        this.counts[exit]++;
        this.pendingExit = exit;
        this.locked = false;
        this.backdate = reset;
        this.backdateFloor = this.lockTime ?? 0;
        if (!reset) {
            this.actFrom = null;
        }
        this.lockTime = null;
        this.clearRun();
        this.clearLock();
        if (reset) {
            this.inner.reset();
        }
    }
    lockStatus(power) {
        return power < this.standbyVal ? "off" : "standby";
    }
    clearBlock() {
        this.blockStart = null;
        this.bandMs = 0;
        this.belowMs = 0;
        this.qualified = false;
    }
    clearRun() {
        this.runStart = null;
        this.clearBlock();
    }
    clearLock() {
        this.hotMs = 0;
        this.lockBandMs = 0;
        this.restRunMs = 0;
        this.act = [];
        this.actMs = 0;
        this.actAboveMs = 0;
    }
}
//# sourceMappingURL=finalPhase.js.map