export class PauseGuard {
    enabled;
    holdMs;
    untilMs;
    belowVal;
    runStart = null;
    stretchSince = null;
    stretchMax = -Infinity;
    constructor(s) {
        const clean = (v) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
        this.holdMs = clean(s.pauseHoldSec) * 1000;
        this.untilMs = clean(s.pauseUntilSec) * 1000;
        this.belowVal = clean(s.pauseBelowVal);
        this.enabled = this.holdMs > 0 && (this.untilMs > 0 || this.belowVal > 0);
    }
    onStarted(now) {
        this.runStart = now;
    }
    reset() {
        this.runStart = null;
        this.stretchSince = null;
        this.stretchMax = -Infinity;
    }
    observe(power, belowEndSince) {
        if (belowEndSince === null) {
            this.stretchSince = null;
            this.stretchMax = -Infinity;
        }
        else if (belowEndSince !== this.stretchSince) {
            this.stretchSince = belowEndSince;
            this.stretchMax = power;
        }
        else {
            this.stretchMax = Math.max(this.stretchMax, power);
        }
    }
    met(now) {
        if (!this.enabled) {
            return true;
        }
        if (this.stretchSince === null) {
            return false;
        }
        const early = this.untilMs <= 0 || this.runStart === null || this.stretchSince - this.runStart < this.untilMs;
        const low = this.belowVal <= 0 || this.stretchMax < this.belowVal;
        return !(early && low) || now - this.stretchSince >= this.holdMs;
    }
}
//# sourceMappingURL=pauseGuard.js.map