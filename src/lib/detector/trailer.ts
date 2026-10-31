import type { Detector, DetectorEvent, DeviceStatus, TickHints, TickResult } from "./types.js";

/** A phase continuously >= endVal for at least this long is a sustained block (programme activity). */
export const TRAILER_BLOCK_SEC = 120;
/** The anti-crease phase is over when no value >= endVal arrives for this long. */
export const TRAILER_QUIET_END_MS = 20 * 60_000;
/** Default length of the anti-crease phase when the filter is on and no length is set. */
export const TRAILER_MAX_DEFAULT_SEC = 7200;
/** Hard cap of queued calls. */
const QUEUE_HARD_CAP = 200;
/** Number of recent quiet values whose median is the replacement level. */
const BASE_VALUES = 5;

/** Settings of the anti-crease filter. */
export interface TrailerSettings {
	/** Longest phase >= endVal that still counts as a drum burst (s, > 0). */
	trailerBurstSec: number;
	/** Minimum quiet time (< endVal) before a burst can be held (s, > 0). */
	trailerGapSec: number;
	/** Bursts are held only this many seconds after the start (0 = unused). */
	trailerAfterSec: number;
	/** Bursts are held only after a sustained block with at least this mean power (0 = unused). */
	trailerBlockVal: number;
	/** Length of the anti-crease phase after the end (s). */
	trailerMaxSec: number;
	/** End threshold of the device type. */
	endVal: number;
	/** Standby threshold of the device type (fallback replacement level). */
	standby: number;
	/** Poll interval in s. */
	pollSec: number;
}

interface Call {
	kind: "tick" | "feed";
	power: number;
	now: number;
	hints?: TickHints;
}

/**
 * Anti-crease filter around a detector (washing machine and dryer move the drum now and then after
 * the programme). A phase >= endVal that starts after a quiet time is held back; if it ends within
 * `trailerBurstSec` it was a drum burst and the inner detector gets the quiet level instead, otherwise
 * it was real activity and the inner detector gets the original values (at most `trailerBurstSec`
 * plus one poll late, in order and with their original timestamps).
 *
 * Bursts are held while a run is in progress after a sustained block (optionally only some time after
 * the start or after a block of at least `trailerBlockVal`), so that the end is reported when the
 * programme finishes, and during the anti-crease phase after the end, so that bursts start no run.
 * The inner detector is unchanged; without the filter (trailerBurstSec 0) it is not built at all.
 */
export class TrailerFilter implements Detector {
	private readonly burstMs: number;
	private readonly gapMs: number;
	private readonly afterMs: number;
	private readonly blockVal: number;
	private readonly maxMs: number;
	private readonly endVal: number;
	private readonly standby: number;
	private readonly bridgeMs: number;
	private readonly cap: number;
	private quietSince: number | null = null;
	private recentQuiet: number[] = [];
	private phaseStart: number | null = null;
	private phaseLast = 0;
	private phaseValues: { t: number; p: number }[] = [];
	private block: { mean: number; end: number } | null = null;
	private startedAt: number | null = null;
	private trailerSince: number | null = null;
	private trailerUntil: number | null = null;
	private lastAbove: number | null = null;
	private queue: Call[] = [];
	private holdStart = 0;
	private suppressedInTrailer = 0;
	/** Number of bursts replaced by the quiet level since the last reset. */
	public burstsSuppressed = 0;

	/**
	 * @param inner - Detector that gets the filtered values
	 * @param s - Filter settings
	 */
	public constructor(
		private readonly inner: Detector,
		s: TrailerSettings,
	) {
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

	/** Whether a run is in progress (of the inner detector). */
	public get started(): boolean {
		return this.inner.started;
	}

	/** Whether the anti-crease phase is active and at least one burst was suppressed in it. */
	public get inTrailer(): boolean {
		return this.trailerUntil !== null && this.suppressedInTrailer > 0;
	}

	/** Whether calls are held back right now. */
	public get holding(): boolean {
		return this.queue.length > 0;
	}

	/** Reset the filter and the inner detector. */
	public reset(): void {
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

	/**
	 * Evaluate one poll step.
	 *
	 * @param power - Last known power
	 * @param now - Timestamp in ms
	 * @param hints - Additional evidence
	 */
	public tick(power: number, now: number, hints?: TickHints): TickResult {
		return this.step({ kind: "tick", power, now, hints });
	}

	/**
	 * Evaluate a newly arrived power value (only meaningful if the inner detector is time-based).
	 *
	 * @param power - New power value
	 * @param now - Timestamp of the value in ms
	 */
	public feed(power: number, now: number): TickResult {
		if (!this.inner.feed) {
			return this.held();
		}
		return this.step({ kind: "feed", power, now });
	}

	private held(): TickResult {
		return { events: [], status: null, average: null, started: this.inner.started };
	}

	private step(call: Call): TickResult {
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

	/**
	 * Pass one call on unchanged (fast path of `forward`).
	 *
	 * @param call - Call
	 */
	private pass(call: Call): TickResult {
		this.trackBlock(call);
		let r: TickResult;
		if (call.kind === "feed") {
			if (!this.inner.feed) {
				return this.held();
			}
			r = this.inner.feed(call.power, call.now);
		} else {
			r = this.inner.tick(call.power, call.now, call.hints);
		}
		for (const ev of r.events) {
			this.note(ev, call.now);
		}
		return r;
	}

	/**
	 * Bookkeeping of an event of the inner detector.
	 *
	 * @param ev - Event
	 * @param now - Time of the call that raised it
	 */
	private note(ev: DetectorEvent, now: number): void {
		if (ev === "started") {
			this.startedAt = now;
			this.endTrailer();
		} else if (ev === "finished") {
			this.trailerSince = now;
			this.trailerUntil = now + this.maxMs;
			this.suppressedInTrailer = 0;
		}
	}

	/**
	 * A call while calls are held back.
	 *
	 * @param call - Current call
	 */
	private resolve(call: Call): TickResult {
		this.trackQuiet(call);
		if (call.power >= this.endVal) {
			if (call.now - this.holdStart > this.burstMs || this.queue.length >= this.cap) {
				// real activity: pass everything on unchanged
				const calls = [...this.queue, call];
				this.queue = [];
				this.endTrailer();
				return this.forward(calls, null);
			}
			this.queue.push(call);
			return this.held();
		}
		// a drum burst: the inner detector gets the quiet level instead
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

	/**
	 * Whether a phase >= endVal arriving now is held back.
	 *
	 * @param now - Timestamp in ms
	 * @param quietMs - Quiet time before the phase
	 */
	private armed(now: number, quietMs: number): boolean {
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

	private updateTrailer(now: number): void {
		if (this.trailerUntil === null) {
			return;
		}
		const since = Math.max(this.lastAbove ?? 0, this.trailerSince ?? 0);
		if (now > this.trailerUntil || now - since >= TRAILER_QUIET_END_MS) {
			this.endTrailer();
		}
	}

	private endTrailer(): void {
		this.trailerUntil = null;
		this.trailerSince = null;
		this.suppressedInTrailer = 0;
	}

	/** Replacement level: median of the last quiet values. */
	private base(): number {
		const vals = [...this.recentQuiet].sort((a, b) => a - b);
		if (vals.length === 0) {
			return Math.min(this.standby, this.endVal);
		}
		const mid = Math.floor(vals.length / 2);
		return vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
	}

	/**
	 * Quiet time and replacement level (every value, also held ones).
	 *
	 * @param call - Call
	 */
	private trackQuiet(call: Call): void {
		if (call.power < this.endVal) {
			this.quietSince ??= call.now;
			this.recentQuiet.push(call.power);
			if (this.recentQuiet.length > BASE_VALUES) {
				this.recentQuiet.shift();
			}
		} else {
			this.quietSince = null;
			this.lastAbove = call.now;
		}
	}

	/**
	 * Sustained blocks (only values the inner detector gets unchanged).
	 *
	 * @param call - Call
	 */
	private trackBlock(call: Call): void {
		if (call.power < this.endVal) {
			return;
		}
		if (this.phaseStart === null || call.now - this.phaseLast > this.bridgeMs) {
			this.phaseStart = call.now;
			this.phaseValues = [];
		}
		this.phaseLast = call.now;
		// mean of the last TRAILER_BLOCK_SEC of the phase: the end of a programme (spinning) differs
		// from the washing before a soaking phase, a long phase before (heating) does not count
		this.phaseValues.push({ t: call.now, p: call.power });
		while (this.phaseValues.length > 0 && call.now - this.phaseValues[0].t > TRAILER_BLOCK_SEC * 1000) {
			this.phaseValues.shift();
		}
		if (call.now - this.phaseStart >= TRAILER_BLOCK_SEC * 1000) {
			const sum = this.phaseValues.reduce((a, v) => a + v.p, 0);
			this.block = { mean: sum / this.phaseValues.length, end: call.now };
		}
	}

	/**
	 * Pass calls on to the inner detector.
	 *
	 * @param calls - Calls in order
	 * @param replace - Power that replaces the values (burst) or null (unchanged)
	 */
	private forward(calls: readonly Call[], replace: number | null): TickResult {
		const events: DetectorEvent[] = [];
		const times: number[] = [];
		let status: DeviceStatus | null = null;
		let average: number | null = null;
		for (const c of calls) {
			const power = replace ?? c.power;
			if (replace === null) {
				this.trackBlock(c);
			}
			let r: TickResult;
			if (c.kind === "feed") {
				if (!this.inner.feed) {
					continue;
				}
				r = this.inner.feed(power, c.now);
			} else {
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

/**
 * Merge two results in order.
 *
 * @param a - Earlier result
 * @param b - Later result
 * @param started - Run state after both
 */
function merge(a: TickResult, b: TickResult, started: boolean): TickResult {
	return {
		events: [...a.events, ...b.events],
		times: [...(a.times ?? []), ...(b.times ?? [])],
		status: b.status ?? a.status,
		average: b.average ?? a.average,
		started,
	};
}
