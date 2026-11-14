import { MAX_PAUSE_MS, MIN_ACTIVE_MS, PAD_AFTER_MS, PAD_BEFORE_MS } from "./learn/runs.js";
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
/** Most report times of a capture; beyond, the report times of this capture are unknown. */
export const CAPTURE_MAX_REPORTS = 100_000;

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
	/**
	 * Times of the reports of the power state (also of equal values) in ms after `t0`; values of cell 0 can be
	 * up to one poll before `t0`. Missing: unknown (older file, too many reports).
	 */
	rep?: number[];
}

/**
 * Records the power around every run for the automatic optimisation: a pre-roll of 30 minutes is
 * kept all the time, a capture opens at a start and closes after the end when the device was quiet
 * for 30 minutes (or 3 hours after the end, or at 12 hours / 25 000 cells). A start while the capture
 * is open extends it, so that false ends and false restarts stay in one capture. Activity above the
 * activity limit for 5 minutes opens a capture without a start (a start the runtime missed); it closes
 * after 30 quiet minutes.
 */
export class RunRecorder {
	private ring: { t: number; cell: TickCell }[] = [];
	private open: Capture | null = null;
	private pendingMin: number | null = null;
	private pendingMax: number | null = null;
	private readonly padCells: number;
	/** Report times while no capture is open (absolute, pre-roll). */
	private ringRep: number[] = [];
	private activityLimit = Number.POSITIVE_INFINITY;
	private activeSince: number | null = null;

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

	/**
	 * Level above which held activity opens a capture without a start (unit of the state).
	 *
	 * @param limit - Activity limit (infinite = only at a start)
	 */
	public setActivityLimit(limit: number): void {
		this.activityLimit = Number.isNaN(limit) ? Number.POSITIVE_INFINITY : limit;
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
			this.activeSince = null;
		}
		this.ring.push({ t: now, cell });
		if (this.ring.length > this.padCells) {
			this.ring.shift();
		}
		this.pruneRingRep();
		if (cell.valid && cell.last > this.activityLimit) {
			this.activeSince ??= now;
			if (now - this.activeSince >= MIN_ACTIVE_MS) {
				this.openCapture(now);
			}
		} else {
			this.activeSince = null;
		}
	}

	/** Drop report times older than the pre-roll. */
	private pruneRingRep(): void {
		const first = this.ring[0];
		if (!first) {
			this.ringRep = [];
			return;
		}
		const keepAfter = first.t - this.stepMs;
		let k = 0;
		while (k < this.ringRep.length && this.ringRep[k] <= keepAfter) {
			k++;
		}
		if (k > 0) {
			this.ringRep = this.ringRep.slice(k);
		}
	}

	/**
	 * Open a capture with the pre-roll.
	 *
	 * @param now - Current time in ms
	 */
	private openCapture(now: number): Capture {
		const first = this.ring[0];
		const t0 = first ? first.t : now;
		const open: Capture = {
			t0,
			stepMs: this.stepMs,
			unitFactor: this.unitFactor,
			cells: this.ring.map(r => r.cell),
			ev: [],
			postTruncated: false,
			rep: this.ringRep.filter(t => t > t0 - this.stepMs).map(t => t - t0),
		};
		this.open = open;
		this.ring = [];
		this.ringRep = [];
		this.activeSince = null;
		return open;
	}

	/**
	 * A new value between two polls (also an equal value): its extremes go into the open cell, its time
	 * into the report times.
	 *
	 * @param power - New value
	 * @param now - Time of the report in ms
	 */
	public event(power: number, now: number): void {
		if (!Number.isFinite(power)) {
			return;
		}
		if (Number.isFinite(now)) {
			this.report(now);
		}
		this.pendingMin = Math.min(power, this.pendingMin ?? power);
		this.pendingMax = Math.max(power, this.pendingMax ?? power);
	}

	/**
	 * Remember the time of a report.
	 *
	 * @param now - Time of the report in ms
	 */
	private report(now: number): void {
		const open = this.open;
		if (!open) {
			this.ringRep.push(now);
			return;
		}
		if (open.rep && open.rep.length >= CAPTURE_MAX_REPORTS) {
			// too many to keep: the report times of this capture are unknown
			delete open.rep;
		}
		open.rep?.push(now - open.t0);
	}

	/**
	 * An event of the runtime.
	 *
	 * @param ev - Start, finish or abort
	 * @param now - Time of the event in ms
	 */
	public onEvent(ev: CaptureEvent, now: number): void {
		let open = this.open;
		if (!open) {
			if (ev !== "s") {
				return;
			}
			open = this.openCapture(now);
		}
		open.ev.push([now, ev]);
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
		if (!due && (!lastEv || lastEv[1] !== "s")) {
			const quietCells = Math.ceil(MAX_PAUSE_MS / open.stepMs);
			const tail = open.cells.slice(-quietCells);
			const quiet = tail.length >= quietCells && tail.every(c => !c.valid || c.max < endVal);
			if (lastEv) {
				const since = now - lastEv[0];
				due = since >= PAD_AFTER_MS || (since >= MAX_PAUSE_MS && quiet);
			} else {
				// capture without a start (activity): closes after 30 quiet minutes
				due = quiet;
			}
		}
		if (!due) {
			return null;
		}
		this.open = null;
		// the end of this capture is the pre-roll of the next one
		const tail = open.cells.slice(-this.padCells);
		const lastT = open.t0 + (open.cells.length - 1) * open.stepMs;
		this.ring = tail.map((cell, k) => ({ t: lastT - (tail.length - 1 - k) * open.stepMs, cell }));
		this.ringRep = (open.rep ?? []).map(t => t + open.t0);
		this.pruneRingRep();
		this.activeSince = null;
		return open;
	}

	/** Open capture (to persist it at the end of a run), or null. */
	public snapshot(): Capture | null {
		return this.open ? copyOf(this.open) : null;
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
			this.open = copyOf(c);
			return null;
		}
		return { ...c, postTruncated: true };
	}
}

/**
 * Copy of a capture (cells, events and report times are new arrays).
 *
 * @param c - Capture
 */
function copyOf(c: Capture): Capture {
	const copy: Capture = { ...c, cells: [...c.cells], ev: [...c.ev] };
	if (c.rep) {
		copy.rep = [...c.rep];
	}
	return copy;
}
