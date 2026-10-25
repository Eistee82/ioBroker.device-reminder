import type { DeviceConfig } from "./config.js";
import type { DeviceHost } from "./host.js";
import type { Notifier } from "./notifier.js";
import { runActions } from "./actions.js";
import { errorMessage } from "./utils.js";

const MIN_DELAY_MS = 1000;

/** Sends reminders after a finished cycle until they are acknowledged. */
export class ReminderScheduler {
	private handle: unknown = null;
	private running = false;
	private sent = 0;
	private failedTries = 0;
	private generation = 0;

	/**
	 * Create the scheduler.
	 *
	 * @param host - Adapter host
	 * @param notifier - Notifier used for delivery
	 * @param getDevice - Returns the current device config, end text and do-not-disturb state
	 */
	public constructor(
		private readonly host: DeviceHost,
		private readonly notifier: Notifier,
		private readonly getDevice: () => { cfg: DeviceConfig; text: string; doNotDisturb: boolean },
	) {}

	/** Whether a reminder cycle is running. */
	public get active(): boolean {
		return this.running;
	}

	/** Number of reminders sent in the current cycle. */
	public get sentCount(): number {
		return this.sent;
	}

	/** Start the reminder cycle after a finished run (if enabled). */
	public onFinished(): void {
		this.stop();
		const { cfg } = this.getDevice();
		if (!cfg.reminder.enabled || cfg.recipients.length === 0) {
			return;
		}
		this.running = true;
		this.schedule(this.intervalMs());
	}

	/** Acknowledge: stops the cycle (the `acknowledged` actions are run by the device registry). */
	public acknowledge(): void {
		this.stop();
	}

	/** A restart of the device counts as acknowledgement. */
	public onStarted(): void {
		this.stop();
	}

	/** Clear all timers. */
	public dispose(): void {
		this.stop();
	}

	private intervalMs(): number {
		const min = this.getDevice().cfg.reminder.intervalMin;
		return Math.max(1, Number.isFinite(min) ? min : 30) * 60_000;
	}

	private maxCount(): number {
		const max = this.getDevice().cfg.reminder.maxCount;
		return Math.max(1, Number.isFinite(max) && max > 0 ? Math.floor(max) : 10);
	}

	private stop(): void {
		this.generation++;
		this.running = false;
		this.sent = 0;
		this.failedTries = 0;
		if (this.handle !== null) {
			this.host.clearTimeout(this.handle);
			this.handle = null;
		}
	}

	private schedule(ms: number): void {
		if (this.handle !== null) {
			this.host.clearTimeout(this.handle);
		}
		const gen = this.generation;
		this.handle = this.host.setTimeout(
			() => {
				this.handle = null;
				void this.fire(gen);
			},
			Math.max(MIN_DELAY_MS, ms),
		);
	}

	private async fire(gen: number): Promise<void> {
		if (gen !== this.generation) {
			return;
		}
		const { cfg, text, doNotDisturb } = this.getDevice();
		try {
			const res = await this.notifier.notify(cfg.recipients, cfg.reminder.text || text, { doNotDisturb });
			if (gen !== this.generation) {
				return;
			}
			if (res.sent.length > 0) {
				this.sent++;
				await runActions(this.host, cfg.actions, "reminder");
				if (gen !== this.generation) {
					return;
				}
				if (this.sent >= this.maxCount()) {
					this.stop();
					return;
				}
				this.schedule(this.intervalMs());
				return;
			}
			if (res.skippedWindow.length > 0) {
				// Only the recipients that were actually skipped decide when to retry; a recipient that is
				// inside its window but was not reached (do not disturb, no target) must not re-arm the timer at once.
				const next = this.notifier.nextWindowStartFor(res.skippedWindow, new Date(this.host.now()));
				if (next && next.getTime() > this.host.now()) {
					this.schedule(next.getTime() - this.host.now());
					return;
				}
			}
			this.failedTries++;
		} catch (err) {
			this.host.log.warn(`Reminder failed: ${errorMessage(err)}`);
			this.failedTries++;
		}
		if (gen !== this.generation) {
			return;
		}
		if (this.failedTries >= this.maxCount()) {
			this.stop();
			return;
		}
		this.schedule(this.intervalMs());
	}
}
