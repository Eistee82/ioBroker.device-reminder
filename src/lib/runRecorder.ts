import { MAX_PAUSE_MS, PAD_AFTER_MS, PAD_BEFORE_MS } from "./learn/runs.js";
import type { TickCell } from "./learn/ticks.js";

export type { TickCell } from "./learn/ticks.js";

/** Event of the runtime in a capture: start, finish, abort. */
export type CaptureEvent = "s" | "f" | "a";

/** Longest capture. */
export const CAPTURE_MAX_MS = 12 * 60 * 60_000;
/** Most cells of a capture. */
export const CAPTURE_MAX_CELLS = 25_000;
/** A pending capture is resumed after a restart if its last cell is at most this many polls old. */
export const RESUME_STEPS = 10;

/** Power cells around one run as the runtime saw them (unit of the state). */
export interface Capture {
	/** Time of cell 0 in ms. */
	t0: number;
	/** Poll interval in ms. */
	stepMs: number;
	/** Factor from the unit of the state to W. */
	unitFactor: number;
	/** One cell per poll. */
	cells: TickCell[];
	/** Events of the runtime with their time. */
	ev: [number, CaptureEvent][];
	/** Whether the time after the end is cut short (restart). */
	postTruncated: boolean;
}

/**
 * Records the power around every run for the automatic optimisation: a pre-roll of 30 minutes is
 * kept all the time, a capture opens at a start and closes after the end when the device was quiet
 * for 30 minutes (or 3 hours after the end, or at 12 hours / 25 000 cells). A start while the capture
 * is open extends it, so that false ends and false restarts stay in one capture.
 */
export class RunRecorder {
	private ring: { t: number; cell: TickCell }[] = [];
	private open: Capture | null = null;
	private pendingMin: number | null = null;
	private pendingMax: number | null = null;
	private readonly padCells: number;

	/**
	 * @param stepMs - Poll interval in ms
	 * @param unitFactor - Factor from the unit of the state to W
	 */
	public constructor(
		private readonly stepMs: number,
		private readonly unitFactor: number,
	) {
		this.padCells = Math.ceil(PAD_BEFORE_MS / stepMs);
	}

	/** Whether a capture is open. */
	public get capturing(): boolean {
		return this.open !== null;
	}

	/**
	 * Close the cell of one poll.
	 *
	 * @param power - Value at the poll
	 * @param now - Time of the poll in ms
	 */
	public sample(power: number, now: number): void {
		const cell: TickCell = {
			last: power,
			min: Math.min(power, this.pendingMin ?? power),
			max: Math.max(power, this.pendingMax ?? power),
			valid: Number.isFinite(power),
		};
		this.pendingMin = null;
		this.pendingMax = null;
		const open = this.open;
		if (open) {
			const expected = open.t0 + open.cells.length * open.stepMs;
			const missing = Math.round((now - expected) / open.stepMs);
			for (let k = 0; k < missing && open.cells.length < CAPTURE_MAX_CELLS; k++) {
				open.cells.push({ min: 0, max: 0, last: 0, valid: false });
			}
			if (open.cells.length < CAPTURE_MAX_CELLS) {
				open.cells.push(cell);
			}
			return;
		}
		const lastT = this.ring.at(-1)?.t;
		if (lastT !== undefined && now - lastT > 1.5 * this.stepMs) {
			this.ring = [];
		}
		this.ring.push({ t: now, cell });
		if (this.ring.length > this.padCells) {
			this.ring.shift();
		}
	}

	/**
	 * A new value between two polls: its extremes go into the open cell.
	 *
	 * @param power - New value
	 */
	public event(power: number): void {
		if (!Number.isFinite(power)) {
			return;
		}
		this.pendingMin = Math.min(power, this.pendingMin ?? power);
		this.pendingMax = Math.max(power, this.pendingMax ?? power);
	}

	/**
	 * An event of the runtime.
	 *
	 * @param ev - Start, finish or abort
	 * @param now - Time of the event in ms
	 */
	public onEvent(ev: CaptureEvent, now: number): void {
		if (!this.open) {
			if (ev !== "s") {
				return;
			}
			const first = this.ring[0];
			this.open = {
				t0: first ? first.t : now,
				stepMs: this.stepMs,
				unitFactor: this.unitFactor,
				cells: this.ring.map(r => r.cell),
				ev: [],
				postTruncated: false,
			};
			this.ring = [];
		}
		this.open.ev.push([now, ev]);
	}

	/**
	 * Close the capture if it is due.
	 *
	 * @param now - Current time in ms
	 * @param endVal - End threshold (unit of the state)
	 * @returns the closed capture or null
	 */
	public closeIfDue(now: number, endVal: number): Capture | null {
		const open = this.open;
		if (!open) {
			return null;
		}
		const lastEv = open.ev.at(-1);
		let due = open.cells.length >= CAPTURE_MAX_CELLS || now - open.t0 >= CAPTURE_MAX_MS;
		if (!due && lastEv && lastEv[1] !== "s") {
			const since = now - lastEv[0];
			const quietCells = Math.ceil(MAX_PAUSE_MS / open.stepMs);
			const tail = open.cells.slice(-quietCells);
			const quiet = tail.length >= quietCells && tail.every(c => !c.valid || c.max < endVal);
			due = since >= PAD_AFTER_MS || (since >= MAX_PAUSE_MS && quiet);
		}
		if (!due) {
			return null;
		}
		this.open = null;
		// the end of this capture is the pre-roll of the next one
		const tail = open.cells.slice(-this.padCells);
		const lastT = open.t0 + (open.cells.length - 1) * open.stepMs;
		this.ring = tail.map((cell, k) => ({ t: lastT - (tail.length - 1 - k) * open.stepMs, cell }));
		return open;
	}

	/** Open capture (to persist it at the end of a run), or null. */
	public snapshot(): Capture | null {
		return this.open ? { ...this.open, cells: [...this.open.cells], ev: [...this.open.ev] } : null;
	}

	/**
	 * Resume a capture persisted before a restart.
	 *
	 * @param c - Persisted capture
	 * @param now - Current time in ms
	 * @returns the capture closed with `postTruncated` if it is too old to resume, otherwise null
	 */
	public restore(c: Capture, now: number): Capture | null {
		const lastT = c.t0 + (c.cells.length - 1) * c.stepMs;
		if (c.stepMs === this.stepMs && now - lastT < RESUME_STEPS * c.stepMs) {
			this.open = { ...c, cells: [...c.cells], ev: [...c.ev] };
			return null;
		}
		return { ...c, postTruncated: true };
	}
}
