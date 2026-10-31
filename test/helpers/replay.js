// Replay stored values through the real detector like the runtime does.
import { createDetector } from "../../build/lib/detector/index.js";

/**
 * Replay the whole history like the runtime does (values fed on arrival in the time-based mode, a
 * poll every `stepMs` with the last known value).
 *
 * @param {{ ts: number, val: number }[]} points stored values (sorted)
 * @param {object} s suggestion (thresholds, mode, durations, pause protection)
 * @param {object} [o] options
 * @param {boolean} [o.abort] abort detection
 * @param {boolean} [o.abortFixed] corrected abort detection
 * @param {number} [o.stepMs] poll interval
 * @param {(t: number) => boolean} [o.switchOff] switch state per tick
 * @returns {{ started: number, finished: number, aborted: number, finishedAt: number[], startedAt: number[] }} events
 */
export function replay(points, s, o = {}) {
	const { abort = false, abortFixed = false, stepMs = 10_000, switchOff = () => false } = o;
	const detector = createDetector(
		{
			...s.thresholds,
			mode: s.mode,
			startDurationSec: s.startDurationSec,
			endDurationSec: s.endDurationSec,
			pauseHoldSec: s.pauseHoldSec,
			pauseUntilSec: s.pauseUntilSec,
			pauseBelowVal: s.pauseBelowVal,
			trailerBurstSec: s.trailerBurstSec,
			trailerGapSec: s.trailerGapSec,
			trailerAfterSec: s.trailerAfterSec,
			trailerBlockVal: s.trailerBlockVal,
			trailerMaxSec: s.trailerMaxSec,
		},
		{ abort, abortFixed, pollSec: stepMs / 1000 },
	);
	const out = { started: 0, finished: 0, aborted: 0, finishedAt: [], startedAt: [] };
	const count = (res, t) => {
		res.events.forEach((e, k) => {
			const at = res.times?.[k] ?? t;
			out[e] = (out[e] ?? 0) + 1;
			if (e === "finished") {
				out.finishedAt.push(at);
			} else if (e === "started") {
				out.startedAt.push(at);
			}
		});
	};
	let idx = 0;
	let value = points[0].val;
	for (let t = points[0].ts; t <= points.at(-1).ts + 3 * 3_600_000; t += stepMs) {
		while (idx < points.length && points[idx].ts <= t) {
			value = points[idx].val;
			if (s.mode === "timed") {
				count(detector.feed(value, points[idx].ts), points[idx].ts);
			}
			idx++;
		}
		count(detector.tick(value, t, { switchOff: switchOff(t) }), t);
	}
	delete out.running;
	return out;
}
