import { PauseGuard } from "./pauseGuard.js";
export function legacyAverage(values) {
    let sum = 0;
    for (const value of values) {
        sum = sum + value;
    }
    return Math.round((sum / values.length) * 100) / 100;
}
export class LegacyDetector {
    startValue;
    endValue;
    standbyValue;
    startCount;
    endCount;
    standbyCount;
    valCancel;
    abort;
    abortNeedsSwitch;
    minStartMs;
    minEndMs;
    guard;
    isStarted = false;
    aboveStartSince = null;
    belowEndSince = null;
    buffers = { start: [], end: [], standby: [] };
    averages = { start: 0, end: 0, standby: 0 };
    constructor(thresholds, options) {
        this.startValue = thresholds.startVal;
        this.endValue = thresholds.endVal;
        this.standbyValue = thresholds.standby || 1;
        this.startCount = thresholds.startCount;
        this.endCount = thresholds.endCount;
        this.standbyCount = options.abortFixed
            ? Math.max(Math.ceil(thresholds.endCount / 2), 2)
            : thresholds.endVal <= 10
                ? thresholds.endVal || 10
                : 10;
        this.valCancel = thresholds.endCount / 2;
        this.abort = options.abort;
        this.abortNeedsSwitch = options.abortFixed === true;
        this.minStartMs = options.minStartMs ?? 0;
        this.minEndMs = options.minEndMs ?? 0;
        this.guard = new PauseGuard(options.pauseGuard ?? {});
    }
    get started() {
        return this.isStarted;
    }
    get bufferLengths() {
        return {
            start: this.buffers.start.length,
            end: this.buffers.end.length,
            standby: this.buffers.standby.length,
        };
    }
    reset() {
        this.isStarted = false;
        this.buffers = { start: [], end: [], standby: [] };
        this.averages = { start: 0, end: 0, standby: 0 };
        this.aboveStartSince = null;
        this.belowEndSince = null;
        this.guard.reset();
    }
    tick(power, now, hints) {
        const out = { events: [], status: null, average: null };
        this.trackDurations(power, now);
        this.fillBuffers(power, out);
        this.evaluate(out, now, hints?.switchOff === true);
        return { events: out.events, status: out.status, average: out.average, started: this.isStarted };
    }
    trackDurations(power, now) {
        if (power >= this.startValue) {
            this.aboveStartSince ??= now;
        }
        else {
            this.aboveStartSince = null;
        }
        if (power < this.endValue) {
            this.belowEndSince ??= now;
        }
        else {
            this.belowEndSince = null;
        }
        this.guard.observe(power, this.belowEndSince);
    }
    startDurationMet(now) {
        return this.minStartMs <= 0 || (this.aboveStartSince !== null && now - this.aboveStartSince >= this.minStartMs);
    }
    endDurationMet(now) {
        return this.minEndMs <= 0 || (this.belowEndSince !== null && now - this.belowEndSince >= this.minEndMs);
    }
    countOf(name) {
        switch (name) {
            case "start":
                return this.startCount;
            case "end":
                return this.endCount;
            default:
                return this.standbyCount;
        }
    }
    push(name, power, out) {
        const buffer = this.buffers[name];
        buffer.push(power);
        this.averages[name] = legacyAverage(buffer);
        out.average = this.averages[name];
        if (buffer.length > this.countOf(name)) {
            buffer.shift();
        }
    }
    fillBuffers(power, out) {
        if (this.isStarted) {
            this.push("standby", power, out);
            this.push("end", power, out);
            this.buffers.start = [];
        }
        else if (power < this.startValue) {
            this.buffers.start = [];
            this.push("standby", power, out);
        }
        else {
            this.push("start", power, out);
            this.buffers.standby = [];
        }
    }
    evaluate(out, now, switchOff) {
        const avg = this.averages;
        if (this.abort &&
            this.isStarted &&
            (!this.abortNeedsSwitch || switchOff) &&
            avg.standby < this.standbyValue &&
            this.buffers.standby.length >= this.valCancel &&
            (this.abortNeedsSwitch || this.guard.met(now))) {
            out.events.push("aborted");
            out.status = "off";
            out.average = avg.standby;
            this.isStarted = false;
            this.buffers = { start: [], end: [], standby: [] };
        }
        if (avg.start > this.startValue &&
            this.buffers.start.length >= this.startCount &&
            !this.isStarted &&
            this.startDurationMet(now)) {
            this.isStarted = true;
            this.guard.onStarted(now);
            out.events.push("started");
            out.status = "running";
        }
        if (this.isStarted && avg.end > this.endValue) {
            this.guard.onActive();
            out.events.push("running");
            out.status = "running";
        }
        else if (this.isStarted &&
            avg.end < this.endValue &&
            this.buffers.end.length >= this.endCount * (2 / 3) &&
            this.endDurationMet(now) &&
            this.guard.met(now)) {
            out.events.push("finished");
            this.isStarted = false;
            if (avg.end < this.standbyValue) {
                avg.standby = avg.end;
                this.buffers.standby = [];
                out.status = "off";
            }
            else {
                out.status = "standby";
            }
            this.buffers.start = [];
            this.buffers.end = [];
        }
        if (!this.isStarted) {
            if (avg.standby >= this.standbyValue && avg.standby < this.endValue) {
                out.status = "standby";
            }
            else if (avg.standby <= this.standbyValue) {
                out.status = "off";
            }
        }
    }
}
//# sourceMappingURL=legacy.js.map