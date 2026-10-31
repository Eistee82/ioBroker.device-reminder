export const TRAILER_BLOCK_SEC = 120;
export const TRAILER_QUIET_END_MS = 20 * 60_000;
export const TRAILER_MAX_DEFAULT_SEC = 7200;
const QUEUE_HARD_CAP = 200;
const BASE_VALUES = 5;
export class TrailerFilter {
    inner;
    burstMs;
    gapMs;
    afterMs;
    blockVal;
    maxMs;
    endVal;
    standby;
    bridgeMs;
    cap;
    quietSince = null;
    recentQuiet = [];
    phaseStart = null;
    phaseLast = 0;
    phaseValues = [];
    block = null;
    startedAt = null;
    trailerSince = null;
    trailerUntil = null;
    lastAbove = null;
    queue = [];
    holdStart = 0;
    suppressedInTrailer = 0;
    burstsSuppressed = 0;
    constructor(inner, s) {
        this.inner = inner;
        const poll = Math.max(1, s.pollSec);
        this.burstMs = Math.max(1, s.trailerBurstSec) * 1000;
        this.gapMs = Math.max(0, s.trailerGapSec) * 1000;
        this.afterMs = Math.max(0, s.trailerAfterSec) * 1000;
        this.blockVal = Math.max(0, s.trailerBlockVal);
        this.maxMs = (s.trailerMaxSec > 0 ? s.trailerMaxSec : TRAILER_MAX_DEFAULT_SEC) * 1000;
        this.endVal = s.endVal;
        this.standby = s.standby;
        this.bridgeMs = 2 * poll * 1000;
        this.cap = Math.min(QUEUE_HARD_CAP, Math.ceil(s.trailerBurstSec / poll) + 2);
    }
    get started() {
        return this.inner.started;
    }
    get inTrailer() {
        return this.trailerUntil !== null && this.suppressedInTrailer > 0;
    }
    get holding() {
        return this.queue.length > 0;
    }
    reset() {
        this.inner.reset();
        this.quietSince = null;
        this.recentQuiet = [];
        this.phaseStart = null;
        this.phaseLast = 0;
        this.phaseValues = [];
        this.block = null;
        this.startedAt = null;
        this.trailerSince = null;
        this.trailerUntil = null;
        this.lastAbove = null;
        this.queue = [];
        this.holdStart = 0;
        this.suppressedInTrailer = 0;
        this.burstsSuppressed = 0;
    }
    tick(power, now, hints) {
        return this.step({ kind: "tick", power, now, hints });
    }
    feed(power, now) {
        if (!this.inner.feed) {
            return this.held();
        }
        return this.step({ kind: "feed", power, now });
    }
    held() {
        return { events: [], status: null, average: null, started: this.inner.started };
    }
    step(call) {
        if (this.queue.length > 0) {
            return this.resolve(call);
        }
        this.updateTrailer(call.now);
        const quietMs = this.quietSince === null ? 0 : call.now - this.quietSince;
        if (call.power >= this.endVal && this.armed(call.now, quietMs)) {
            this.trackQuiet(call);
            this.holdStart = call.now;
            this.queue = [call];
            return this.held();
        }
        this.trackQuiet(call);
        return this.pass(call);
    }
    pass(call) {
        this.trackBlock(call);
        let r;
        if (call.kind === "feed") {
            if (!this.inner.feed) {
                return this.held();
            }
            r = this.inner.feed(call.power, call.now);
        }
        else {
            r = this.inner.tick(call.power, call.now, call.hints);
        }
        for (const ev of r.events) {
            this.note(ev, call.now);
        }
        return r;
    }
    note(ev, now) {
        if (ev === "started") {
            this.startedAt = now;
            this.endTrailer();
        }
        else if (ev === "finished") {
            this.trailerSince = now;
            this.trailerUntil = now + this.maxMs;
            this.suppressedInTrailer = 0;
        }
    }
    resolve(call) {
        this.trackQuiet(call);
        if (call.power >= this.endVal) {
            if (call.now - this.holdStart > this.burstMs || this.queue.length >= this.cap) {
                const calls = [...this.queue, call];
                this.queue = [];
                this.endTrailer();
                return this.forward(calls, null);
            }
            this.queue.push(call);
            return this.held();
        }
        const calls = this.queue;
        this.queue = [];
        this.burstsSuppressed++;
        if (this.trailerUntil !== null) {
            this.suppressedInTrailer++;
        }
        const replaced = this.forward(calls, this.base());
        const current = this.pass(call);
        return merge(replaced, { ...current, times: current.events.map(() => call.now) }, this.inner.started);
    }
    armed(now, quietMs) {
        if (this.quietSince === null || quietMs < this.gapMs) {
            return false;
        }
        if (this.trailerUntil !== null) {
            return true;
        }
        if (!this.inner.started || this.startedAt === null || this.block === null) {
            return false;
        }
        if (this.block.end < this.startedAt) {
            return false;
        }
        if (this.afterMs > 0 && now - this.startedAt < this.afterMs) {
            return false;
        }
        return this.blockVal <= 0 || this.block.mean >= this.blockVal;
    }
    updateTrailer(now) {
        if (this.trailerUntil === null) {
            return;
        }
        const since = Math.max(this.lastAbove ?? 0, this.trailerSince ?? 0);
        if (now > this.trailerUntil || now - since >= TRAILER_QUIET_END_MS) {
            this.endTrailer();
        }
    }
    endTrailer() {
        this.trailerUntil = null;
        this.trailerSince = null;
        this.suppressedInTrailer = 0;
    }
    base() {
        const vals = [...this.recentQuiet].sort((a, b) => a - b);
        if (vals.length === 0) {
            return Math.min(this.standby, this.endVal);
        }
        const mid = Math.floor(vals.length / 2);
        return vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    }
    trackQuiet(call) {
        if (call.power < this.endVal) {
            this.quietSince ??= call.now;
            this.recentQuiet.push(call.power);
            if (this.recentQuiet.length > BASE_VALUES) {
                this.recentQuiet.shift();
            }
        }
        else {
            this.quietSince = null;
            this.lastAbove = call.now;
        }
    }
    trackBlock(call) {
        if (call.power < this.endVal) {
            return;
        }
        if (this.phaseStart === null || call.now - this.phaseLast > this.bridgeMs) {
            this.phaseStart = call.now;
            this.phaseValues = [];
        }
        this.phaseLast = call.now;
        this.phaseValues.push({ t: call.now, p: call.power });
        while (this.phaseValues.length > 0 && call.now - this.phaseValues[0].t > TRAILER_BLOCK_SEC * 1000) {
            this.phaseValues.shift();
        }
        if (call.now - this.phaseStart >= TRAILER_BLOCK_SEC * 1000) {
            const sum = this.phaseValues.reduce((a, v) => a + v.p, 0);
            this.block = { mean: sum / this.phaseValues.length, end: call.now };
        }
    }
    forward(calls, replace) {
        const events = [];
        const times = [];
        let status = null;
        let average = null;
        for (const c of calls) {
            const power = replace ?? c.power;
            if (replace === null) {
                this.trackBlock(c);
            }
            let r;
            if (c.kind === "feed") {
                if (!this.inner.feed) {
                    continue;
                }
                r = this.inner.feed(power, c.now);
            }
            else {
                r = this.inner.tick(power, c.now, c.hints);
            }
            for (const ev of r.events) {
                events.push(ev);
                times.push(c.now);
                this.note(ev, c.now);
            }
            status = r.status ?? status;
            average = r.average ?? average;
        }
        return { events, status, average, started: this.inner.started, times };
    }
}
function merge(a, b, started) {
    return {
        events: [...a.events, ...b.events],
        times: [...(a.times ?? []), ...(b.times ?? [])],
        status: b.status ?? a.status,
        average: b.average ?? a.average,
        started,
    };
}
//# sourceMappingURL=trailer.js.map