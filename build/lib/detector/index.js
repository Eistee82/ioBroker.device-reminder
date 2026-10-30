import { LegacyDetector } from "./legacy.js";
import { TimedDetector } from "./timed.js";
export { LegacyDetector } from "./legacy.js";
export { TimedDetector } from "./timed.js";
export { PauseGuard } from "./pauseGuard.js";
export function createDetector(s, o) {
    const pauseGuard = { pauseHoldSec: s.pauseHoldSec, pauseUntilSec: s.pauseUntilSec, pauseBelowVal: s.pauseBelowVal };
    switch (s.mode) {
        case "timed":
            return new TimedDetector(s, { abort: o.abort });
        case "combined":
            return new LegacyDetector(s, {
                abort: o.abort,
                abortFixed: o.abortFixed,
                minStartMs: Math.max(s.startDurationSec, 0) * 1000,
                minEndMs: Math.max(s.endDurationSec, 0) * 1000,
                pauseGuard,
            });
        default:
            return new LegacyDetector(s, { abort: o.abort, abortFixed: o.abortFixed, pauseGuard });
    }
}
//# sourceMappingURL=index.js.map