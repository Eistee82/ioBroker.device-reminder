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
 * or advance it.
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
	}

	/** Back to the initial state. */
	public reset(): void {
		this.runStart = null;
		this.stretchSince = null;
		this.stretchMax = -Infinity;
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
	 * Whether the end (or abort) may be reported now.
	 *
	 * @param now - Timestamp in ms
	 */
	public met(now: number): boolean {
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
