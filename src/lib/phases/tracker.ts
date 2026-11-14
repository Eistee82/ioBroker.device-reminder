import type { HoldProfile } from "../learn/bands.js";
import { DEFAULT_PHASE_NAMES, SYSTEM_PHASES } from "./model.js";
import type { BandDef, PhaseDef, PhaseModel, PhaseTrigger } from "./model.js";

/**
 * Phase tracker (Spec A.5): names the phase of a device from its raw values. Purely functional, without
 * timers of its own: it only sees the values (`observe`), the poll clock (`advance`), the run events
 * (`onRun`) and the context of the detection (`setContext`), and it never changes a message of the
 * detection. The same code runs live and offline (`replayPhases`). Times follow the held value; the time
 * between two calls is capped like in the final phase (max(2 · poll, 60 s)).
 */

/** Shortest block of a `block` band in ms. */
const BLOCK_MIN_MS = 20_000;
/** Closed segments a live tracker keeps (the oldest are dropped first). */
const MAX_SEGMENTS = 1000;

/** Phase shown now. */
export interface PhaseState {
	/** Phase id, band id or system phase id; null outside a run (scope run) and before the first value. */
	id: string | null;
	/** Name (empty when `id` is null). */
	name: string;
	/** Begin of the segment the phase belongs to (ms). */
	since: number;
	/** The held value is older than the suspect limit of its band (missing values). */
	unknown: boolean;
}

/** One segment of the timeline. */
export interface Segment {
	/** Phase id, band id or system phase id. */
	id: string;
	/** Name. */
	name: string;
	/** Begin (ms). */
	from: number;
	/** End (ms); for the open segment the time processed last. */
	to: number;
	/** The segment is closed and its class decided; false for the open segment (class can still change). */
	final: boolean;
}

/** Start or end of a phase. */
export type PhaseEdge = {
	/** Phase id, band id or system phase id. */
	id: string;
	/** Start or end. */
	edge: "start" | "end";
	/** Time (ms). */
	at: number;
};

/** Further options of the tracker. */
export interface TrackerOptions {
	/** Closed segments to keep (default 1000; `Infinity` for an offline replay). */
	maxSegments?: number;
}

/** A segment of the band reading (before the classes). */
interface BaseSeg {
	/** Band index, -1 = outside all bands. */
	band: number;
	/** Begin (ms). */
	from: number;
	/** Counted time (ms). */
	dur: number;
}

/** The open segment of the timeline. */
interface Disp {
	kind: "band" | "trigger" | "system" | "unknown";
	/** Band index (-1 = rest) for kind band. */
	band: number;
	/** Event phase for kind trigger. */
	phase: PhaseDef | null;
	/** System phase id for kind system. */
	sys: string | null;
	from: number;
	/** Counted time (ms). */
	dur: number;
	/** Predecessor id (`idle`, `start`, a phase, band or system id; null = no context). */
	pred: string | null;
}

/** An event phase waiting for its confirmation, or running its tail. */
interface Trig {
	band: number;
	phases: PhaseDef[];
	entry: number;
	/** Counted time since the entry (ms). */
	elapsed: number;
	/** Counted time since the raw value last entered the band of the event phase (ms). */
	sinceIn: number;
	/** The raw value left the band of the event phase since it last entered it. */
	wasOut: boolean;
	/** Stretch of raw values in a confirm band: counted time since the last entry at its begin, its length. */
	inConf: { startSince: number; dur: number } | null;
	/** Confirmed phase (tail running). */
	phase: PhaseDef | null;
	/** Band segments since the entry (to undo a confirmation). */
	hist: BaseSeg[];
}

/** Window entry of the level smoothing. */
interface WinEntry {
	val: number;
	ms: number;
}

/**
 * Tracker of one device.
 */
export class PhaseTracker {
	private readonly bands: BandDef[];
	private readonly classes: PhaseDef[][];
	private readonly triggers: PhaseDef[][];
	private readonly suspectMs: number[];
	private readonly levelIdx: number[];
	private readonly windowMs: number;
	private readonly dtCapMs: number;
	private readonly names: Record<string, string>;
	private readonly maxSegments: number;
	private readonly continuous: boolean;

	// raw values
	private queue: { val: number; ts: number }[] = [];
	private lastT: number | undefined;
	private held: number | undefined;
	private lastObs = 0;
	private win: WinEntry[] = [];
	private winMs = 0;

	// band reading
	private cur = -1;
	private out: { dur: number } | null = null;
	private cand: BaseSeg | null = null;

	// timeline
	private segs: Segment[] = [];
	private segPreds: (string | null)[] = [];
	private disp: Disp | null = null;
	private nextPred: string | null = null;
	private trig: Trig | null = null;
	private inRun = false;
	private runStart: number | null = null;
	private emptySince = 0;
	private sys: string | null = null;
	private ctx = { inTrailer: false, settling: false };

	// edges
	private liveId: string | null = null;
	private edges: PhaseEdge[] = [];

	/**
	 * @param model - Phase model (normalized)
	 * @param holds - Hold time profile of the bands (by band id); null = no suspect limit
	 * @param pollSec - Poll interval in s
	 * @param names - Names of the system phases (`SYSTEM_PHASES` ids; default English)
	 * @param opts - Further options
	 */
	public constructor(
		model: PhaseModel,
		holds: HoldProfile[] | null,
		pollSec: number,
		names?: Record<string, string>,
		opts: TrackerOptions = {},
	) {
		this.bands = model.bands;
		this.classes = this.bands.map(b => model.phases.filter(p => p.band === b.id && !p.trigger));
		this.triggers = this.bands.map(b => model.phases.filter(p => p.band === b.id && p.trigger));
		this.suspectMs = this.bands.map(b => {
			const h = holds?.find(x => x.band === b.id);
			return h && h.suspectSec > 0 ? h.suspectSec * 1000 : Infinity;
		});
		this.levelIdx = this.bands.flatMap((b, k) => (b.smoothing === "level" ? [k] : []));
		this.windowMs = Math.max(0, ...this.levelIdx.map(k => this.bands[k].windowSec * 1000));
		this.dtCapMs = Math.max(2 * Math.max(1, pollSec), 60) * 1000;
		this.names = { ...DEFAULT_PHASE_NAMES, ...(names ?? {}) };
		this.maxSegments = opts.maxSegments ?? MAX_SEGMENTS;
		this.continuous = model.scope === "continuous";
	}

	/**
	 * A raw value of the power state (every report, also equal values).
	 *
	 * @param val - Value in the unit of the state
	 * @param t - Time of the report (ms)
	 */
	public observe(val: number, t: number): void {
		if (!Number.isFinite(val) || !Number.isFinite(t)) {
			return;
		}
		const last = this.queue.at(-1);
		this.queue.push({ val, ts: last && last.ts > t ? last.ts : t });
	}

	/**
	 * Let the time run to `t` (poll clock).
	 *
	 * @param t - Now (ms)
	 * @returns Starts and ends of phases since the last call
	 */
	public advance(t: number): PhaseEdge[] {
		this.processTo(t);
		this.applyContext(t);
		this.sync();
		const out = this.edges;
		this.edges = [];
		return out;
	}

	/**
	 * Start, end or abort of a run (scope run: a start begins a new timeline; scope continuous: ignored).
	 *
	 * @param kind - Event
	 * @param at - Time of the event (ms)
	 */
	public onRun(kind: "start" | "end" | "abort", at: number): void {
		if (this.continuous) {
			return;
		}
		this.processTo(at);
		if (kind === "start") {
			this.segs = [];
			this.segPreds = [];
			this.trig = null;
			this.inRun = true;
			this.runStart = at;
			if (!this.sys) {
				this.disp = null;
				this.nextPred = "start";
				this.openBand(this.cur, at, 0);
			}
		} else if (this.inRun) {
			this.inRun = false;
			if (!this.sys) {
				this.closeDisp(at);
				this.disp = null;
				this.trig = null;
			}
			this.emptySince = at;
		}
		this.sync();
	}

	/**
	 * Context of the detection: anti-crease phase and lock phase (system phases). Applied at the next
	 * `advance`.
	 *
	 * @param c - Context
	 * @param c.inTrailer - The anti-crease phase runs
	 * @param c.settling - The lock phase of the final phase runs
	 */
	public setContext(c: { inTrailer: boolean; settling: boolean }): void {
		this.ctx = { inTrailer: c.inTrailer, settling: c.settling };
	}

	/** Phase shown now. */
	public get current(): PhaseState {
		const d = this.disp;
		if (!d) {
			return { id: null, name: "", since: this.emptySince, unknown: false };
		}
		const { id, name } = this.liveOf(d);
		return { id, name, since: d.from, unknown: d.kind === "unknown" };
	}

	/** Segments of the current run (scope run) or the newest segments (scope continuous), oldest first. */
	public timeline(): Segment[] {
		const out = this.segs.map(s => ({ ...s }));
		const d = this.disp;
		if (d && this.lastT !== undefined && this.lastT > d.from) {
			const { id, name } = this.liveOf(d);
			out.push({ id, name, from: d.from, to: this.lastT, final: false });
		}
		return out;
	}

	/** Back to the state of a new tracker. */
	public reset(): void {
		this.queue = [];
		this.lastT = undefined;
		this.held = undefined;
		this.lastObs = 0;
		this.win = [];
		this.winMs = 0;
		this.cur = -1;
		this.out = null;
		this.cand = null;
		this.segs = [];
		this.segPreds = [];
		this.disp = null;
		this.nextPred = null;
		this.trig = null;
		this.inRun = false;
		this.runStart = null;
		this.emptySince = 0;
		this.sys = null;
		this.ctx = { inTrailer: false, settling: false };
		this.liveId = null;
		this.edges = [];
	}

	// ---------------------------------------------------------------- raw values and time

	private processTo(t: number): void {
		if (this.lastT === undefined) {
			const first = this.queue[0];
			if (!first || first.ts > t) {
				return;
			}
			this.lastT = first.ts;
		}
		if (t <= this.lastT) {
			return;
		}
		if (t - this.lastT > this.dtCapMs) {
			// time without a poll counts only up to the cap: values before it just set the held value
			const skipTo = t - this.dtCapMs;
			while (this.queue.length > 0 && this.queue[0].ts <= skipTo) {
				this.take(this.queue.shift()!);
			}
			this.lastT = skipTo;
		}
		while (this.queue.length > 0 && this.queue[0].ts <= t) {
			const e = this.queue.shift()!;
			if (e.ts > this.lastT && this.held !== undefined) {
				this.step(this.lastT, e.ts, this.held);
			}
			this.lastT = Math.max(this.lastT, e.ts);
			this.take(e);
		}
		if (t > this.lastT) {
			if (this.held !== undefined) {
				this.step(this.lastT, t, this.held);
			}
			this.lastT = t;
		}
	}

	/**
	 * A new value is held from now on.
	 *
	 * @param e - Value and time
	 * @param e.val - Value
	 * @param e.ts - Time (ms)
	 */
	private take(e: { val: number; ts: number }): void {
		const first = this.held === undefined;
		this.held = e.val;
		this.lastObs = e.ts;
		if (this.disp?.kind === "unknown") {
			// values again: the context is lost, the reading starts anew
			this.closeDisp(e.ts);
			this.cur = -1;
			this.out = null;
			this.cand = null;
			this.win = [];
			this.winMs = 0;
			this.openBand(-1, e.ts, 0);
		} else if (first && this.continuous && !this.disp) {
			this.openBand(-1, e.ts, 0);
		}
	}

	private bandIndex(val: number): number {
		for (let k = 0; k < this.bands.length; k++) {
			if (val >= this.bands[k].min && val < this.bands[k].max) {
				return k;
			}
		}
		return -1;
	}

	private enterMs(k: number): number {
		if (k < 0) {
			return 0;
		}
		const b = this.bands[k];
		switch (b.smoothing) {
			case "block":
				return BLOCK_MIN_MS;
			case "debounce":
				return b.dipSec * 1000;
			default:
				return 0;
		}
	}

	private tolMs(k: number): number {
		return k < 0 ? 0 : this.bands[k].dipSec * 1000;
	}

	/**
	 * One stretch with a constant held value.
	 *
	 * @param a - Begin (ms)
	 * @param b - End (ms)
	 * @param v - Held value
	 */
	private step(a: number, b: number, v: number): void {
		const len = b - a;
		if (len <= 0) {
			return;
		}
		const raw = this.bandIndex(v);
		this.pushWindow(v, len);
		const label = this.levelLabel(raw);
		if (this.disp) {
			this.disp.dur += len;
		}
		const t = this.trig;
		const hist = t?.hist.at(-1);
		if (hist) {
			hist.dur += len;
		}
		this.readBands(label, a, len);
		this.trackTrigger(raw, a, b, len, this.trig !== t);
		if (
			this.disp &&
			this.disp.kind !== "unknown" &&
			this.disp.kind !== "system" &&
			this.held !== undefined &&
			raw >= 0 &&
			b - this.lastObs > this.suspectMs[raw]
		) {
			this.enterUnknown(Math.max(this.lastObs + this.suspectMs[raw], this.disp.from));
		}
	}

	private pushWindow(v: number, len: number): void {
		if (this.windowMs <= 0) {
			return;
		}
		const last = this.win.at(-1);
		if (last && last.val === v) {
			last.ms += len;
		} else {
			this.win.push({ val: v, ms: len });
		}
		this.winMs += len;
		while (this.win.length > 1 && this.winMs - this.win[0].ms >= this.windowMs) {
			this.winMs -= this.win.shift()!.ms;
		}
	}

	/**
	 * Median and maximum of the held values in the last `ms` (time-weighted).
	 *
	 * @param ms - Window length
	 */
	private windowStats(ms: number): { median: number; max: number } {
		const take: WinEntry[] = [];
		let left = ms;
		for (let i = this.win.length - 1; i >= 0 && left > 0; i--) {
			const part = Math.min(left, this.win[i].ms);
			take.push({ val: this.win[i].val, ms: part });
			left -= part;
		}
		const total = ms - Math.max(0, left);
		const max = Math.max(...take.map(x => x.val));
		take.sort((x, y) => x.val - y.val);
		let acc = 0;
		let median = take[0]?.val ?? 0;
		for (const x of take) {
			acc += x.ms;
			median = x.val;
			if (acc >= total / 2) {
				break;
			}
		}
		return { median, max };
	}

	/**
	 * Band of a value after the level smoothing: a value below a level band still belongs to it while the
	 * window shows its level (median) or its activity (maximum, with the median below the band).
	 *
	 * @param raw - Band of the raw value
	 */
	private levelLabel(raw: number): number {
		let best = raw;
		for (const k of this.levelIdx) {
			if (k <= raw) {
				continue;
			}
			const b = this.bands[k];
			const { median, max } = this.windowStats(Math.max(1, b.windowSec * 1000));
			const inBand = (x: number): boolean => x >= b.min && x < b.max;
			if (inBand(median) || (inBand(max) && median < b.min)) {
				if (k === this.cur) {
					return k;
				}
				best = Math.max(best, k);
			}
		}
		return best;
	}

	/**
	 * Band reading with enter and leave times; a change is dated back to where the value went there.
	 *
	 * @param label - Band of the value after the level smoothing
	 * @param a - Begin of the stretch (ms)
	 * @param len - Length of the stretch (ms)
	 */
	private readBands(label: number, a: number, len: number): void {
		if (label === this.cur) {
			this.out = null;
			this.cand = null;
			return;
		}
		this.out ??= { dur: 0 };
		this.out.dur += len;
		if (!this.cand || this.cand.band !== label) {
			this.cand = { band: label, from: a, dur: 0 };
		}
		this.cand.dur += len;
		const c = this.cand;
		const peak = c.band >= 0 && this.bands[c.band].smoothing === "peak";
		if (!peak) {
			if (c.dur < this.enterMs(c.band)) {
				return;
			}
			if (c.band < this.cur && this.out.dur < this.tolMs(this.cur)) {
				return;
			}
		}
		this.switchBand(c.band, c.from, c.dur);
	}

	private switchBand(band: number, from: number, dur: number): void {
		this.cur = band;
		this.out = null;
		this.cand = null;
		const t = this.trig;
		if (t) {
			const last = t.hist.at(-1)!;
			last.dur = Math.max(0, last.dur - dur);
			t.hist.push({ band, from: Math.max(from, last.from), dur });
			if (t.phase) {
				return; // tail of an event phase: the band changes only show up afterwards
			}
		}
		const d = this.disp;
		if (!d || d.kind !== "band") {
			return;
		}
		const f = Math.max(from, d.from);
		this.closeDisp(f, Math.max(0, d.dur - dur));
		this.openBand(band, f, dur, true);
	}

	// ---------------------------------------------------------------- event phases

	private trackTrigger(raw: number, a: number, b: number, len: number, fresh: boolean): void {
		const t = this.trig;
		if (!t) {
			return;
		}
		if (!fresh || t.phase) {
			t.elapsed += len;
		}
		if (t.phase) {
			const trig = t.phase.trigger!;
			if (raw !== t.band && !trig.confirm.includes(this.bands[raw]?.id ?? "")) {
				this.revoke();
				return;
			}
			const tailMs = trig.tailSec * 1000;
			if (t.elapsed >= tailMs) {
				this.endTail(Math.max(a, b - (t.elapsed - tailMs)), b);
			}
			return;
		}
		// the confirmation time counts from the last entry: a peak may dip and come back
		if (raw === t.band) {
			if (t.wasOut) {
				t.sinceIn = 0;
				t.wasOut = false;
			}
		} else {
			t.wasOut = true;
		}
		if (!fresh) {
			t.sinceIn += len;
		}
		const before = fresh ? t.sinceIn : t.sinceIn - len;
		const id = this.bands[raw]?.id;
		const phase = id === undefined ? undefined : t.phases.find(p => p.trigger!.confirm.includes(id));
		if (phase) {
			t.inConf ??= { startSince: before, dur: 0 };
			t.inConf.dur += len;
			const trig: PhaseTrigger = phase.trigger!;
			if (t.inConf.startSince <= trig.confirmSec * 1000 && t.inConf.dur >= this.enterMs(raw)) {
				this.confirm(t, phase);
				return;
			}
		} else {
			t.inConf = null;
		}
		const maxConfirm = Math.max(...t.phases.map(p => p.trigger!.confirmSec * 1000));
		if (t.sinceIn > maxConfirm && !(t.inConf && t.inConf.startSince <= maxConfirm)) {
			this.trig = null;
		}
	}

	private startTrigger(band: number, from: number, dur: number): void {
		const phases = this.triggers[band]?.filter(p => this.fits(p, this.disp?.pred ?? null, from));
		this.trig =
			phases && phases.length > 0
				? {
						band,
						phases,
						entry: from,
						elapsed: dur,
						sinceIn: dur,
						wasOut: false,
						inConf: null,
						phase: null,
						hist: [{ band, from, dur }],
					}
				: null;
	}

	private confirm(t: Trig, phase: PhaseDef): void {
		// the event phase holds from the entry on: segments closed since then become part of it
		let pred = this.disp?.from === t.entry ? this.disp.pred : null;
		while (this.segs.length > 0 && this.segs.at(-1)!.from >= t.entry) {
			this.segs.pop();
			pred = this.segPreds.pop() ?? null;
		}
		this.disp = { kind: "trigger", band: t.band, phase, sys: null, from: t.entry, dur: t.elapsed, pred };
		t.phase = phase;
	}

	/** The value left the bands of the event phase during its tail: back to the band reading. */
	private revoke(): void {
		const t = this.trig!;
		const d = this.disp!;
		this.trig = null;
		this.disp = null;
		this.nextPred = d.pred;
		t.hist.forEach((h, i) => {
			const next = t.hist[i + 1];
			this.disp = {
				kind: "band",
				band: h.band,
				phase: null,
				sys: null,
				from: h.from,
				dur: h.dur,
				pred: this.nextPred,
			};
			if (next) {
				this.closeDisp(next.from, h.dur);
			}
		});
	}

	private endTail(at: number, b: number): void {
		this.closeDisp(at);
		this.trig = null;
		this.openBand(this.cur, at, b - at);
	}

	// ---------------------------------------------------------------- unknown and system phases

	private enterUnknown(at: number): void {
		this.trig = null;
		this.closeDisp(at);
		this.disp = { kind: "unknown", band: -1, phase: null, sys: null, from: at, dur: 0, pred: this.nextPred };
	}

	private applyContext(t: number): void {
		const want = this.ctx.inTrailer ? SYSTEM_PHASES.antiCrease : this.ctx.settling ? SYSTEM_PHASES.afterRun : null;
		if (want === this.sys) {
			return;
		}
		this.sys = want;
		this.closeDisp(t);
		this.trig = null;
		if (want) {
			this.disp = { kind: "system", band: -1, phase: null, sys: want, from: t, dur: 0, pred: this.nextPred };
		} else if (this.continuous || this.inRun) {
			this.openBand(this.cur, t, 0);
		} else {
			this.disp = null;
			this.emptySince = t;
		}
	}

	// ---------------------------------------------------------------- timeline

	/**
	 * Open a band segment.
	 *
	 * @param band - Band index (-1 = rest)
	 * @param from - Begin (ms)
	 * @param dur - Counted time so far (ms)
	 * @param entry - The value entered the band here (only then an event phase can begin)
	 */
	private openBand(band: number, from: number, dur: number, entry = false): void {
		this.disp = { kind: "band", band, phase: null, sys: null, from, dur, pred: this.nextPred };
		if (entry && band >= 0 && this.triggers[band].length > 0) {
			this.startTrigger(band, from, dur);
		}
	}

	/**
	 * Close the open segment.
	 *
	 * @param to - End (ms)
	 * @param dur - Counted time of the segment (default: as counted so far)
	 */
	private closeDisp(to: number, dur?: number): void {
		const d = this.disp;
		if (!d) {
			return;
		}
		this.disp = null;
		const end = Math.max(to, d.from);
		if (end <= d.from) {
			this.nextPred = d.pred; // empty segment: the next one keeps its predecessor
			return;
		}
		const fin = this.finalOf(d, dur ?? d.dur);
		this.segs.push({ id: fin.id, name: fin.name, from: d.from, to: end, final: true });
		this.segPreds.push(d.pred);
		while (this.segs.length > this.maxSegments) {
			this.segs.shift();
			this.segPreds.shift();
		}
		const live = this.liveOf(d, dur ?? d.dur);
		if (fin.phase && fin.id !== live.id) {
			this.edges.push({ id: fin.id, edge: "end", at: end });
		}
		this.nextPred = d.kind === "band" && d.band < 0 ? "idle" : fin.id;
	}

	/**
	 * Whether a phase may follow `pred` and begin at `from`.
	 *
	 * @param p - Phase
	 * @param pred - Predecessor id
	 * @param from - Begin of the segment (ms)
	 */
	private fits(p: PhaseDef, pred: string | null, from: number): boolean {
		if (p.after && (pred === null || !p.after.includes(pred))) {
			return false;
		}
		if (p.notBeforeSec !== undefined && !this.continuous) {
			return this.runStart !== null && from - this.runStart >= p.notBeforeSec * 1000;
		}
		return true;
	}

	/**
	 * Classes of a band segment whose duration range holds `dur`.
	 *
	 * @param d - Segment
	 * @param dur - Counted time (ms)
	 */
	private matching(d: Disp, dur: number): PhaseDef[] {
		return this.classes[d.band].filter(
			p => this.fits(p, d.pred, d.from) && dur >= p.minSec * 1000 && (p.maxSec === 0 || dur <= p.maxSec * 1000),
		);
	}

	private bandName(d: Disp): { id: string; name: string; phase: PhaseDef | null } {
		switch (d.kind) {
			case "unknown":
				return { id: SYSTEM_PHASES.unknown, name: this.names.unknown, phase: null };
			case "system":
				return { id: d.sys!, name: this.names[d.sys!] ?? d.sys!, phase: null };
			case "trigger":
				return { id: d.phase!.id, name: d.phase!.name, phase: d.phase };
			default:
				if (d.band < 0) {
					return { id: SYSTEM_PHASES.rest, name: this.names.rest, phase: null };
				}
				return { id: this.bands[d.band].id, name: this.bands[d.band].name, phase: null };
		}
	}

	/**
	 * Name shown live: the class only if it is the one class that matches the duration and is decided live.
	 *
	 * @param d - Segment
	 * @param dur - Counted time (default: as counted so far)
	 */
	private liveOf(d: Disp, dur = d.dur): { id: string; name: string; phase: PhaseDef | null } {
		if (d.kind === "band" && d.band >= 0) {
			const m = this.matching(d, dur);
			if (m.length === 1 && m[0].decided === "live") {
				return { id: m[0].id, name: m[0].name, phase: m[0] };
			}
		}
		if (d.kind === "trigger" && d.phase!.decided === "end") {
			// event phase that did not pass the cross-check (Spec B.5 step 7): timeline only, live the band
			const b = this.bands[d.band];
			return { id: b.id, name: b.name, phase: null };
		}
		return this.bandName(d);
	}

	/**
	 * Class decided at the end of a segment: the one class that matches the duration, otherwise the band.
	 *
	 * @param d - Segment
	 * @param dur - Counted time
	 */
	private finalOf(d: Disp, dur: number): { id: string; name: string; phase: PhaseDef | null } {
		if (d.kind === "band" && d.band >= 0) {
			const m = this.matching(d, dur);
			if (m.length === 1) {
				return { id: m[0].id, name: m[0].name, phase: m[0] };
			}
		}
		return this.bandName(d);
	}

	/** Report a change of the phase shown. */
	private sync(): void {
		const st = this.current;
		if (st.id === this.liveId) {
			return;
		}
		if (this.liveId !== null) {
			this.edges.push({ id: this.liveId, edge: "end", at: st.since });
		}
		if (st.id !== null) {
			this.edges.push({ id: st.id, edge: "start", at: st.since });
		}
		this.liveId = st.id;
	}
}

/**
 * Replay stored values offline with the tracker code: values up to each poll, run events, then the poll.
 *
 * @param model - Phase model
 * @param points - Stored values (unit of the state)
 * @param pollSec - Poll interval in s
 * @param runs - Runs (scope run): start and end in ms
 * @param opts - Hold time profile and names of the system phases
 * @param opts.holds - Hold time profile (default none)
 * @param opts.names - Names of the system phases
 * @returns Timeline over all runs and the changes of the phase shown live
 */
export function replayPhases(
	model: PhaseModel,
	points: readonly { ts: number; val: number }[],
	pollSec: number,
	runs?: readonly { start: number; end: number }[],
	opts: { holds?: HoldProfile[] | null; names?: Record<string, string> } = {},
): { timeline: Segment[]; live: { t: number; id: string | null; name: string }[] } {
	const pts = points.filter(p => Number.isFinite(p.ts) && Number.isFinite(p.val)).sort((x, y) => x.ts - y.ts);
	const timeline: Segment[] = [];
	const live: { t: number; id: string | null; name: string }[] = [];
	if (pts.length === 0) {
		return { timeline, live };
	}
	const tr = new PhaseTracker(model, opts.holds ?? null, pollSec, opts.names, { maxSegments: Infinity });
	const events = (runs ?? [])
		.flatMap(r => [
			{ at: r.start, kind: "start" as const },
			{ at: r.end, kind: "end" as const },
		])
		.sort((x, y) => x.at - y.at || (x.kind === "end" ? -1 : 1));
	const stepMs = Math.max(1, pollSec) * 1000;
	let shown: { id: string | null; name: string } = { id: null, name: "" };
	const note = (t: number): void => {
		const st = tr.current;
		if (st.id !== shown.id || st.name !== shown.name) {
			shown = { id: st.id, name: st.name };
			live.push({ t, id: st.id, name: st.name });
		}
	};
	let k = 0;
	let e = 0;
	const last = pts.at(-1)!.ts;
	for (let now = pts[0].ts; now <= last; now += stepMs) {
		while (k < pts.length && pts[k].ts <= now) {
			tr.observe(pts[k].val, pts[k].ts);
			k++;
		}
		while (e < events.length && events[e].at <= now) {
			const ev = events[e++];
			if (ev.kind === "start" && model.scope === "run") {
				timeline.push(...tr.timeline());
			}
			tr.onRun(ev.kind, ev.at);
			note(ev.at);
		}
		tr.advance(now);
		note(now);
	}
	timeline.push(...tr.timeline());
	return { timeline, live };
}
