/** Optional pause protection of a device type (all 0 = off, 3.1.2 behaviour). */
export interface PauseGuardSettings {
	/** Seconds a pause has to last continuously below endVal before it counts as the end (0 = off). */
	pauseHoldSec?: number;
	/** A phase below endVal is a pause if it began less than this many seconds after the start (0 = unused). */
	pauseUntilSec?: number;
	/** A phase below endVal is a pause if all of its values stayed below this power (0 = unused). */
	pauseBelowVal?: number;
}

/**
 * Pause protection: a phase below the end threshold that looks like a pause inside a run (early in
 * the run and/or at a lower power than after a real end) only counts as the end after a hold time.
 * It adds a condition before "finished"/"aborted" and therefore can only delay an end, never prevent
 * or advance it: once the detector would report the end, it is reported after the hold time at the
 * latest, even if short blips keep restarting the phase below endVal.
 */
export class PauseGuard {
	/** Whether the protection is active (hold time and at least one condition set). */
	public readonly enabled: boolean;
	private readonly holdMs: number;
	private readonly untilMs: number;
	private readonly belowVal: number;
	private runStart: number | null = null;
	private stretchSince: number | null = null;
	private stretchMax = -Infinity;
	/** Since when the detector wants to report the end but the protection holds it back. */
	private blockedSince: number | null = null;

	/**
	 * @param s - Pause protection settings of the device type
	 */
	public constructor(s: PauseGuardSettings) {
		const clean = (v: number | undefined): number =>
			typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
		this.holdMs = clean(s.pauseHoldSec) * 1000;
		this.untilMs = clean(s.pauseUntilSec) * 1000;
		this.belowVal = clean(s.pauseBelowVal);
		this.enabled = this.holdMs > 0 && (this.untilMs > 0 || this.belowVal > 0);
	}

	/**
	 * A run started.
	 *
	 * @param now - Timestamp in ms
	 */
	public onStarted(now: number): void {
		this.runStart = now;
		this.blockedSince = null;
	}

	/** The device is clearly running again (the end is no longer pending). */
	public onActive(): void {
		this.blockedSince = null;
	}

	/** Back to the initial state. */
	public reset(): void {
		this.runStart = null;
		this.stretchSince = null;
		this.stretchMax = -Infinity;
		this.blockedSince = null;
	}

	/**
	 * Follow the current phase below endVal; call after every processed value.
	 *
	 * @param power - Processed power value
	 * @param belowEndSince - Start of the phase below endVal of the detector, or null
	 */
	public observe(power: number, belowEndSince: number | null): void {
		if (belowEndSince === null) {
			this.stretchSince = null;
			this.stretchMax = -Infinity;
		} else if (belowEndSince !== this.stretchSince) {
			this.stretchSince = belowEndSince;
			this.stretchMax = power;
		} else {
			this.stretchMax = Math.max(this.stretchMax, power);
		}
	}

	/**
	 * Whether the end (or abort) may be reported now; call only when the detector would report it.
	 * The hold time counts from the begin of the pause, but at the latest from the first time the
	 * detector wanted to report the end (bounded delay).
	 *
	 * @param now - Timestamp in ms
	 */
	public met(now: number): boolean {
		if (!this.enabled) {
			return true;
		}
		if (this.stretchSince !== null) {
			const early =
				this.untilMs <= 0 || this.runStart === null || this.stretchSince - this.runStart < this.untilMs;
			const low = this.belowVal <= 0 || this.stretchMax < this.belowVal;
			if (!(early && low) || now - this.stretchSince >= this.holdMs) {
				return true;
			}
		}
		this.blockedSince ??= now;
		return now - this.blockedSince >= this.holdMs;
	}
}
