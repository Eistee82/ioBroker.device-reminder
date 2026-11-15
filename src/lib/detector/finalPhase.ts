import type {
	Detector,
	DetectorEvent,
	DeviceStatus,
	FinalExit,
	FinalSettings,
	FinalStats,
	TickHints,
	TickResult,
} from "./types.js";

/** Length of the sliding window of the activity exit (f) in ms. */
export const FINAL_ACT_WINDOW_MS = 5 * 60_000;
/** Default of `finalQuietSec` (Z) in s. */
const QUIET_DEFAULT_SEC = 120;
/** Default of `finalCheckSec` in s. */
const CHECK_DEFAULT_SEC = 1800;
/** Default of `finalLockSec` in s. */
export const LOCK_DEFAULT_SEC = 14_400;

/**
 * Defaults for the value 0 and the per-poll floors of the final phase (Spec A.2). The floors only make
 * the values safer (later early end, later exit): Y, G ≥ 2 · poll; Z ≥ max(2 · poll, G);
 * `finalRestSec` ≥ 3 · poll; `finalLockSec` ≥ 2 · poll.
 *
 * @param f - Final phase settings (every field set, 0 = default)
 * @param pollSec - Poll interval in s
 * @param standby - Standby threshold of the device (default of the rest level)
 */
export function finalFloors(f: Required<FinalSettings>, pollSec: number, standby: number): Required<FinalSettings> {
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

/** Options of the final phase filter. */
export interface FinalPhaseOptions {
	/** Poll interval in s. */
	pollSec: number;
	/** Standby threshold of the device (status in the lock phase, default rest level). */
	standby: number;
	/** Start in the lock phase that began at this time (restart of the adapter during the lock phase). */
	resumeLockAt?: number;
}

/** One stretch of the activity window. */
interface ActPart {
	ms: number;
	above: boolean;
}

/**
 * Final phase (Spec A.3): reports the end of a run once the last programme phase (the final band) is
 * over, before the inner detector would. After this early end a lock phase follows: the inner detector
 * keeps getting the real values, its events are swallowed, and the first matching exit ends the lock:
 *
 * - a) the inner detector ends (finished or aborted),
 * - b) rest proof: below `finalRestVal` for `finalRestSec`,
 * - c) high load: at or above `finalHotVal` for G,
 * - d) final band after the check window,
 * - e) maximum duration `finalLockSec`,
 * - f) activity: share above `finalActVal` in the last 5 min at least `finalActShare`,
 * - g) final band within the check window, summed at least Y / 2.
 *
 * After b–g the inner detector is reset and detects a new run with its normal start rules; the start is
 * dated back to the first activity after the last rest, at the earliest to the early end. There is no
 * resume: everything after an early end is a new run. Times only count over the value held at `tick`
 * (once per poll), `feed` only passes values on to the inner detector.
 */
export class FinalPhaseFilter implements Detector {
	private readonly minVal: number;
	private readonly maxVal: number;
	private readonly hotVal: number;
	private readonly afterMs: number;
	private readonly minMs: number;
	private readonly quietMs: number;
	private readonly dipMs: number;
	private readonly restVal: number;
	private readonly restMs: number;
	private readonly actVal: number;
	private readonly actShare: number;
	private readonly checkMs: number;
	private readonly lockMs: number;
	private readonly dtCapMs: number;
	private readonly standbyVal: number;
	private locked = false;
	private lastTick: number | null = null;
	private heldVal = 0;
	// pass: the block in the final band of the current run
	private runStart: number | null = null;
	private blockStart: number | null = null;
	private bandMs = 0;
	private belowMs = 0;
	private qualified = false;
	// lock: counters since the early end
	private lockTime: number | null = null;
	private hotMs = 0;
	private lockBandMs = 0;
	private restRunMs = 0;
	private act: ActPart[] = [];
	private actMs = 0;
	private actAboveMs = 0;
	// dating back the next start after the exits b–g
	private backdate = false;
	private backdateFloor = 0;
	private actFrom: number | null = null;
	// mark of the first start after a lock phase
	private pendingExit: FinalExit | null = null;
	private shownExit: FinalExit | null = null;
	private counts: FinalStats = { early: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 };

	/**
	 * @param inner - Detector of the mode (with pause protection)
	 * @param s - Final phase settings (every field set, 0 = default or rule off)
	 * @param o - Options
	 */
	public constructor(
		private readonly inner: Detector,
		s: Required<FinalSettings>,
		o: FinalPhaseOptions,
	) {
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

	/** Whether a run is in progress (never during the lock phase). */
	public get started(): boolean {
		return !this.locked && this.inner.started;
	}

	/** Whether the lock phase after an early end is active. */
	public get settling(): boolean {
		return this.locked;
	}

	/** Exit of the last lock phase, only during the call that returns the first start after it. */
	public get finalExit(): FinalExit | null {
		return this.shownExit;
	}

	/** Time of the early end that began the current lock phase, otherwise null. */
	public get lockAt(): number | null {
		return this.locked ? this.lockTime : null;
	}

	/** Counters of early ends and exits. */
	public get stats(): FinalStats {
		return { ...this.counts };
	}

	/** Reset to the initial state. */
	public reset(): void {
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

	/**
	 * Evaluate one poll step.
	 *
	 * @param power - Last known power
	 * @param now - Timestamp in ms
	 * @param hints - Additional evidence
	 */
	public tick(power: number, now: number, hints?: TickHints): TickResult {
		this.shownExit = null;
		const r = this.inner.tick(power, now, hints);
		const prev = this.lastTick;
		let dt = 0;
		if (prev !== null && now < prev) {
			// time jump back: block, interruption and lock counters start again
			this.clearBlock();
			this.clearLock();
		} else if (prev !== null) {
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
			// only the part of the held stretch inside the run counts
			const from = Math.max(prev, this.runStart);
			if (this.trackBlock(held, Math.max(0, Math.min(dt, now - from)), from)) {
				return this.earlyEnd(r, out, power, now);
			}
		}
		return out;
	}

	/**
	 * Evaluate a newly arrived power value (time-based mode): passed on to the inner detector only.
	 *
	 * @param power - New power value
	 * @param now - Timestamp of the value in ms
	 */
	public feed(power: number, now: number): TickResult {
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

	/**
	 * Bookkeeping of the events passed on outside the lock phase: run start (dated back after the exits
	 * b–g, mark of the first start after a lock phase) and run end.
	 *
	 * @param r - Result of the inner detector
	 * @param events - Events of `r` to pass on (all, or those after the inner end in the lock phase)
	 * @param now - Time of the call
	 */
	private passOn(r: TickResult, events: readonly DetectorEvent[], now: number): TickResult {
		const offset = r.events.length - events.length;
		let times: number[] | undefined = r.times ? r.times.slice(offset) : undefined;
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
			} else if (ev === "finished" || ev === "aborted") {
				this.clearRun();
			}
		});
		if (offset === 0 && times === r.times) {
			return r;
		}
		return { ...r, events: [...events], ...(times ? { times } : {}), started: this.started };
	}

	/**
	 * Block in the final band of the current run, counted over the held value (Spec A.3 pass 3–5).
	 *
	 * @param held - Value held since the last tick
	 * @param dt - Time of the held stretch inside the run (capped)
	 * @param from - Start of the held stretch inside the run
	 * @returns whether the early end is due now
	 */
	private trackBlock(held: number, dt: number, from: number): boolean {
		if (held >= this.maxVal) {
			this.clearBlock();
			return false;
		}
		if (held >= this.minVal) {
			this.blockStart ??= from;
			this.bandMs += dt;
			this.belowMs = 0;
		} else {
			this.belowMs += dt;
			if (!this.qualified && this.belowMs > this.dipMs) {
				this.blockStart = null;
				this.bandMs = 0;
			}
		}
		if (
			!this.qualified &&
			this.blockStart !== null &&
			this.runStart !== null &&
			this.blockStart >= this.runStart + this.afterMs &&
			this.bandMs >= this.minMs
		) {
			this.qualified = true;
		}
		return this.qualified && this.belowMs >= this.quietMs;
	}

	/**
	 * Early end: the events of the inner detector without running/finished plus an own finished, then
	 * the lock phase.
	 *
	 * @param r - Result of the inner detector
	 * @param out - Result after the bookkeeping
	 * @param power - Current power
	 * @param now - Time of the call
	 */
	private earlyEnd(r: TickResult, out: TickResult, power: number, now: number): TickResult {
		const events: DetectorEvent[] = [];
		const times: number[] = [];
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

	/**
	 * One call in the lock phase: the events of the inner detector are swallowed, the status follows the
	 * value; the first matching exit ends the lock phase.
	 *
	 * @param r - Result of the inner detector
	 * @param power - Current power
	 * @param now - Time of the call
	 * @param t - Held value and time since the last tick (tick only), or null (feed)
	 * @param t.held - Value held since the last tick
	 * @param t.dt - Time since the last tick (capped)
	 */
	private lockStep(r: TickResult, power: number, now: number, t: { held: number; dt: number } | null): TickResult {
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
		const swallowed: TickResult = {
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
		let exit: FinalExit | null = null;
		if (this.hotVal > 0 && this.hotMs >= this.dipMs) {
			exit = "c";
		} else if (since <= this.checkMs && this.lockBandMs >= this.minMs / 2) {
			exit = "g";
		} else if (since > this.checkMs && inBand) {
			exit = "d";
		} else if (
			this.actVal > 0 &&
			this.actShare > 0 &&
			this.actMs >= FINAL_ACT_WINDOW_MS &&
			this.actAboveMs >= this.actShare * this.actMs
		) {
			exit = "f";
		} else if (this.restRunMs >= this.restMs) {
			exit = "b";
		} else if (since >= this.lockMs) {
			exit = "e";
		}
		if (exit !== null) {
			this.leave(exit, true);
		}
		return swallowed;
	}

	/**
	 * Counters of the lock phase over the held value.
	 *
	 * @param held - Value held since the last tick
	 * @param dt - Time since the last tick (capped)
	 */
	private countLock(held: number, dt: number): void {
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

	/**
	 * First activity after the last rest (start of a new run after the exits b–g is dated back to it).
	 *
	 * @param power - Current power
	 * @param now - Time of the tick
	 */
	private trackActivity(power: number, now: number): void {
		if (power < this.restVal) {
			this.actFrom = null;
		} else {
			this.actFrom ??= now;
		}
	}

	/**
	 * Leave the lock phase.
	 *
	 * @param exit - Exit taken
	 * @param reset - Reset the inner detector (exits b–g: a new run is detected with the normal rules)
	 */
	private leave(exit: FinalExit, reset: boolean): void {
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

	/**
	 * Status in the lock phase.
	 *
	 * @param power - Current power
	 */
	private lockStatus(power: number): DeviceStatus {
		return power < this.standbyVal ? "off" : "standby";
	}

	private clearBlock(): void {
		this.blockStart = null;
		this.bandMs = 0;
		this.belowMs = 0;
		this.qualified = false;
	}

	private clearRun(): void {
		this.runStart = null;
		this.clearBlock();
	}

	private clearLock(): void {
		this.hotMs = 0;
		this.lockBandMs = 0;
		this.restRunMs = 0;
		this.act = [];
		this.actMs = 0;
		this.actAboveMs = 0;
	}
}
