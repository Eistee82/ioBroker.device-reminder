import { PauseGuard } from "./pauseGuard.js";
export class TimedDetector {
    startValue;
    endValue;
    standbyValue;
    startMs;
    endMs;
    abort;
    guard;
    isStarted = false;
    aboveStartSince = null;
    belowEndSince = null;
    belowStandbySince = null;
    constructor(settings, options) {
        this.startValue = settings.startVal;
        this.endValue = settings.endVal;
        this.standbyValue = settings.standby || 1;
        this.startMs = Math.max(settings.startDurationSec, 0) * 1000;
        this.endMs = Math.max(settings.endDurationSec, 0) * 1000;
        this.abort = options.abort;
        this.guard = new PauseGuard(settings);
    }
    get started() {
        return this.isStarted;
    }
    reset() {
        this.isStarted = false;
        this.aboveStartSince = null;
        this.belowEndSince = null;
        this.belowStandbySince = null;
        this.guard.reset();
    }
    feed(power, now) {
        return this.step(power, now);
    }
    tick(power, now) {
        return this.step(power, now);
    }
    step(power, now) {
        this.track(power, now);
        const events = [];
        let status = null;
        if (!this.isStarted) {
            if (this.elapsed(this.aboveStartSince, now, this.startMs)) {
                this.isStarted = true;
                this.guard.onStarted(now);
                events.push("started");
                status = "running";
            }
            else {
                status = this.idleStatus(power);
            }
        }
        else if (this.abort && this.elapsed(this.belowStandbySince, now, this.endMs / 2) && this.guard.met(now)) {
            this.isStarted = false;
            events.push("aborted");
            status = "off";
        }
        else if (this.elapsed(this.belowEndSince, now, this.endMs) && this.guard.met(now)) {
            this.isStarted = false;
            events.push("finished");
            status = power < this.standbyValue ? "off" : "standby";
        }
        else {
            events.push("running");
            status = "running";
        }
        return { events, status, average: power, started: this.isStarted };
    }
    track(power, now) {
        this.aboveStartSince = power >= this.startValue ? (this.aboveStartSince ?? now) : null;
        this.belowEndSince = power < this.endValue ? (this.belowEndSince ?? now) : null;
        this.belowStandbySince = power < this.standbyValue ? (this.belowStandbySince ?? now) : null;
        this.guard.observe(power, this.belowEndSince);
    }
    elapsed(since, now, durationMs) {
        return since !== null && now - since >= durationMs;
    }
    idleStatus(power) {
        if (power < this.standbyValue) {
            return "off";
        }
        if (power < this.endValue) {
            return "standby";
        }
        return null;
    }
}
//# sourceMappingURL=timed.js.map