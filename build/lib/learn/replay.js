import { createDetector } from "../detector/index.js";
export function simulate(s, win, settings, opts, stopAtFinish = false) {
    const detector = createDetector(settings, { abort: opts.abort, abortFixed: opts.abortFixed });
    const feed = settings.mode === "timed" ? detector.feed?.bind(detector) : undefined;
    const res = { started: 0, aborted: 0, finished: [] };
    const collect = (events, t) => {
        for (const ev of events) {
            if (ev === "started") {
                res.started++;
            }
            else if (ev === "aborted") {
                res.aborted++;
            }
            else if (ev === "finished") {
                res.finished.push(t);
            }
        }
    };
    const step = s.stepMs;
    for (let i = win.fromIdx; i <= win.toIdx; i++) {
        const t = s.t0 + i * step;
        const last = s.last[i];
        if (feed && s.has[i] === 1) {
            if (s.max[i] > last) {
                collect(feed(s.max[i], t - step / 2).events, t - step / 2);
            }
            if (s.min[i] < last) {
                collect(feed(s.min[i], t - step / 4).events, t - step / 4);
            }
            collect(feed(last, t).events, t);
        }
        collect(detector.tick(last, t, { switchOff: false }).events, t);
        if (stopAtFinish && res.finished.length > 0) {
            break;
        }
    }
    return res;
}
export function runOk(s, win, r) {
    const end = s.t0 + (win.runEndIdx ?? 0) * s.stepMs;
    return r.started === 1 && r.aborted === 0 && r.finished.length > 0 && r.finished[0] >= end;
}
export async function allOk(s, windows, settings, opts, yieldFn) {
    let ok = true;
    for (const win of windows) {
        if (!runOk(s, win, simulate(s, win, settings, opts, true))) {
            ok = false;
            break;
        }
    }
    await yieldFn?.();
    return ok;
}
export async function evaluate(s, windows, settings, opts, yieldFn) {
    let detected = 0;
    let falseStarts = 0;
    let delaySum = 0;
    let delayMax = 0;
    let runs = 0;
    for (const win of windows) {
        const res = simulate(s, win, settings, opts);
        if (win.runEndIdx === null) {
            falseStarts += res.started;
            continue;
        }
        runs++;
        if (runOk(s, win, res) && res.finished.length === 1) {
            detected++;
            const delay = (res.finished[0] - (s.t0 + win.runEndIdx * s.stepMs)) / 1000;
            delaySum += delay;
            delayMax = Math.max(delayMax, delay);
        }
    }
    await yieldFn?.();
    return {
        mode: settings.mode,
        detected,
        runs,
        falseStarts,
        endDelaySec: detected > 0 ? Math.round(delaySum / detected) : 0,
        endDelayMaxSec: Math.round(delayMax),
    };
}
export function compare(a, b) {
    return (b.detected - a.detected ||
        a.falseStarts - b.falseStarts ||
        a.endDelaySec - b.endDelaySec ||
        a.endDelayMaxSec - b.endDelayMaxSec);
}
//# sourceMappingURL=replay.js.map