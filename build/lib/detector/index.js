import { LegacyDetector } from "./legacy.js";
import { TimedDetector } from "./timed.js";
import { TrailerFilter } from "./trailer.js";
export { LegacyDetector } from "./legacy.js";
export { TimedDetector } from "./timed.js";
export { PauseGuard } from "./pauseGuard.js";
export { TRAILER_BLOCK_SEC, TRAILER_MAX_DEFAULT_SEC, TrailerFilter } from "./trailer.js";
export function trailerGapOf(s, pollSec) {
    return (s.trailerGapSec ?? 0) > 0 ? s.trailerGapSec : Math.max(3 * pollSec, 30);
}
export function createDetector(s, o) {
    const inner = createInner(s, o);
    if ((s.trailerBurstSec ?? 0) <= 0) {
        return inner;
    }
    const pollSec = Math.max(1, o.pollSec ?? 10);
    return new TrailerFilter(inner, {
        trailerBurstSec: s.trailerBurstSec,
        trailerGapSec: trailerGapOf(s, pollSec),
        trailerAfterSec: s.trailerAfterSec ?? 0,
        trailerBlockVal: s.trailerBlockVal ?? 0,
        trailerMaxSec: s.trailerMaxSec ?? 0,
        endVal: s.endVal,
        standby: s.standby,
        pollSec,
    });
}
function createInner(s, o) {
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