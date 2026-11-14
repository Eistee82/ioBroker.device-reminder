import type { BandOptions, HoldProfile, Unit } from "../learn/bands.js";
import { holdProfile, learnBands } from "../learn/bands.js";
import type { RunSample, Verdict } from "../learn/quality.js";
import { admitted } from "../learn/quality.js";
import type { BandDef, BandSmoothing, PhaseDef, PhaseModel } from "./model.js";
import { SYSTEM_PHASES } from "./model.js";
import type { Segment } from "./tracker.js";
import { replayPhases } from "./tracker.js";

/**
 * Learn the phase model of a device from its runs or day sections (Spec B.5): bands from the
 * time-weighted histogram, a smoothing per band, segments with the tracker code, duration classes,
 * predecessors and event phases, a leave-one-out cross-check with the tracker online, and neutral names.
 * All rules are relative to the data (no device knowledge, Decision 6); a class that cannot be proven
 * in the cross-check is not named live.
 */

/** More runs per day than this: scope continuous. */
const CONTINUOUS_RUNS_PER_DAY = 6;
/** Median rest between runs below this (min): scope continuous. */
const CONTINUOUS_REST_MIN = 30;
/** A change of the stored value by at least this factor is a jump (rhythm). */
const JUMP_RATIO = 2;
/** At least this many jumps per active minute (median over the units): rhythmic, bands over the 60-s median. */
const RHYTHM_JUMPS_PER_MIN = 1;
/** Debounce of raw values (Zigbee) in s. */
const DEBOUNCE_SEC = 5;
/** Bridged dips of the band reading over the 60-s median in s (`DEFAULT_BAND_OPTIONS`). */
const MEDIAN_DIP_SEC = 60;
/** Dip tolerance of a `block` band in s (Spec A.5). */
const BLOCK_DIP_SEC = 30;
/** `level`: dips below the band at least this often per minute of its segments … */
const LEVEL_DIPS_PER_MIN = 1;
/** … and their p99 shorter than this (s). */
const LEVEL_DIP_MAX_SEC = 30;
/** `level`: the window is this multiple of the p99 of the dips. */
const LEVEL_WINDOW_FACTOR = 3;
/** `level`: the hold time is this share of the window. */
const LEVEL_HOLD_SHARE = 0.75;
/** Window and hold time of a `level` band are rounded to this (s). */
const ROUND_SEC = 15;
/** `peak`: median length of the raw stretches in the band below this multiple of the debounce … */
const PEAK_FACTOR = 2;
/** … and at least this share of the stretches lie above both neighbours (an excursion, not a ramp). */
const PEAK_EXCURSION_SHARE = 0.5;
/** Neighbouring durations differing by at least this factor are two classes. */
const CLASS_RATIO = 2;
/** A class, a predecessor group and an event phase need evidence from this many runs or days. */
const MIN_UNITS = 3;
/** An event phase: this share of the entries goes into a fixed set of following bands … */
const EVENT_SHARE = 0.8;
/** … of at most this many bands. */
const EVENT_MAX_CONFIRM = 2;
/** Quantile of the confirmation time and of the tail. */
const EVENT_Q = 0.95;
/** The following level is stable when the value stays within this factor … */
const STABLE_RATIO = 1.1;
/** … for this long (s). */
const STABLE_SEC = 30;
/** A class stays live only with this agreement in the cross-check. */
const AGREE_MIN = 0.99;
/** More live band changes than this multiple of the offline segments: the bands flicker. */
const FLICKER_MAX = 1.2;
/** Upper limit of an open range for the overlap of ranges: this multiple of the largest finite bound. */
const OPEN_FACTOR = 10;
/** Default of the neutral name (i18n `phase_neutral`, English). */
const NEUTRAL_TEMPLATE = "Level {n} · ≈ {w} W · {min}–{max} min";

/** A run or a day section with its verdict. */
export interface PhaseUnit {
	/** Sample of the run check. */
	sample: RunSample;
	/** Verdict of the run check. */
	verdict: Verdict;
}

/** What `learnPhases` knows about the device. */
export interface PhaseLearnContext {
	/** Run level in W. */
	runLimitW: number;
	/** W per unit of the state. */
	unitFactor: number;
	/** Poll interval in s. */
	pollSec: number;
	/** Scope; default from the runs per day and the rest between them (`scopeOf`). */
	scope?: "run" | "continuous";
	/** Model learned before: matched phases keep id, name, `notify`, `show` and `final`. */
	previous?: PhaseModel;
	/**
	 * Words of the template for the names. The dialog offers them as a choice (Task 24); learning never
	 * picks one by itself (no guessing), it always proposes the neutral name.
	 */
	vocabulary?: string[];
	/** Number of actions that use a phase (for the phases that fall away). */
	actionsOf?: (phaseId: string) => number;
	/** Neutral name of a phase (translated template `phase_neutral`; default English). */
	neutralName?: (n: number, w: number, min: number, max: number) => string;
	/** Time of learning in ms (default now). */
	now?: number;
}

/** Result of `learnPhases`. */
export interface PhaseLearnResult {
	/** Learned model (`enabled` as before, otherwise off). */
	model: PhaseModel;
	/** Agreement of the cross-check outside the transition zones (0..1). */
	looAgreement: number;
	/** Event phases that did not pass the cross-check: named in the timeline only, not live. */
	retroOnly: string[];
	/** Phases of `previous` without a partner, with the number of actions that use them. */
	dropped: { id: string; actions: number }[];
}

/**
 * Scope of a device (Spec B.5 step 1): `continuous` with more than 6 runs per day or a median rest
 * between runs below 30 min, otherwise `run`.
 *
 * @param runsPerDay - Runs per day
 * @param medianRestMin - Median rest between two runs in min
 */
export function scopeOf(runsPerDay: number, medianRestMin: number): "run" | "continuous" {
	return runsPerDay > CONTINUOUS_RUNS_PER_DAY || medianRestMin < CONTINUOUS_REST_MIN ? "continuous" : "run";
}

/** A segment of the band reading (no classes). */
interface Seg {
	/** Band index; -1 rest, -2 unknown or system phase. */
	band: number;
	/** Begin (ms). */
	from: number;
	/** End (ms). */
	to: number;
	/** Predecessor: rest or start of the run, another band, or no context. */
	pred: "idle" | "active" | null;
	/** Unit index. */
	unit: number;
	/** Closed by the data (not cut by the end of a day section). */
	closed: boolean;
	/** Next segment of the unit, if any. */
	next: Seg | null;
}

/** A learned class before it gets an id. */
interface Draft {
	/** Band index. */
	band: number;
	/** Duration range (s, 0 = open). */
	minSec: number;
	maxSec: number;
	/** Decided at the end (all classes but the longest of a band). */
	decided: "live" | "end";
	/** Predecessor group (Spec B.5 step 6). */
	ctx?: "idle" | "active";
	/** Event phase: following bands (indices), confirmation time and tail (s). */
	trigger?: { confirm: number[]; confirmSec: number; tailSec: number };
	/** Shortest and longest duration seen (s). */
	lo: number;
	hi: number;
	/** Units with evidence. */
	units: Set<number>;
	/** End of the latest evidence (ms). */
	lastSeen: number;
}

/** What the cross-check found for one phase. */
interface ClassCheck {
	ok: number;
	ref: number;
	wrong: number;
	wrongSegs: number;
}

/**
 * Quantile of sorted values.
 *
 * @param sorted - Values, ascending
 * @param q - Fraction 0..1
 */
function quantile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) {
		return Number.NaN;
	}
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * Median of values.
 *
 * @param values - Values
 */
function median(values: readonly number[]): number {
	const s = [...values].sort((a, b) => a - b);
	if (s.length === 0) {
		return Number.NaN;
	}
	const m = s.length >> 1;
	return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Round to 15 s, at least 15 s.
 *
 * @param sec - Seconds
 */
function round15(sec: number): number {
	return Math.max(ROUND_SEC, Math.round(sec / ROUND_SEC) * ROUND_SEC);
}

/**
 * Overlap of two ranges on a log scale (intersection over union, 0..1); open ends are capped at
 * `OPEN_FACTOR` times the largest finite bound.
 *
 * @param a - Range [low, high] (high may be Infinity)
 * @param b - Range [low, high]
 */
function overlap(a: [number, number], b: [number, number]): number {
	const finite = [a[0], a[1], b[0], b[1]].filter(x => Number.isFinite(x) && x > 0);
	const cap = OPEN_FACTOR * Math.max(1, ...finite);
	const lo = (x: number): number => Math.log(Math.max(1e-9, x));
	const hi = (x: number): number => Math.log(Math.min(cap, Number.isFinite(x) ? x : cap));
	const [a0, a1, b0, b1] = [lo(a[0]), hi(a[1]), lo(b[0]), hi(b[1])];
	const inter = Math.min(a1, b1) - Math.max(a0, b0);
	const union = Math.max(a1, b1) - Math.min(a0, b0);
	return inter > 0 && union > 0 ? inter / union : 0;
}

/**
 * Whether the stored values change in a rhythm (Spec B.5 step 2): median over the units of the jumps by
 * at least a factor 2 per active minute.
 *
 * @param units - Runs or day sections
 * @param runLimit - Run level (unit of the state)
 */
function rhythmic(units: readonly Unit[], runLimit: number): boolean {
	const rates: number[] = [];
	for (const u of units) {
		const p = u.points;
		let jumps = 0;
		let active = 0;
		for (let i = 0; i + 1 < p.length; i++) {
			if (p[i].val <= runLimit && p[i + 1].val <= runLimit) {
				continue;
			}
			active += p[i + 1].ts - p[i].ts;
			const x = Math.max(p[i].val, runLimit);
			const y = Math.max(p[i + 1].val, runLimit);
			if (Math.max(x, y) >= JUMP_RATIO * Math.min(x, y)) {
				jumps++;
			}
		}
		if (active > 0) {
			rates.push(jumps / (active / 60_000));
		}
	}
	return rates.length > 0 && median(rates) >= RHYTHM_JUMPS_PER_MIN;
}

/**
 * Run window of a unit for the replay (scope run): start to core end.
 *
 * @param u - Unit
 */
function runOf(u: RunSample): { start: number; end: number } {
	return { start: u.facts.start, end: Math.max(u.facts.start, u.facts.coreEnd) };
}

/**
 * Band reading of every unit with the tracker code (a model without classes).
 *
 * @param model - Model with the bands only
 * @param units - Units
 * @param pollSec - Poll interval
 * @param holds - Hold time profile
 */
function bandSegments(model: PhaseModel, units: readonly RunSample[], pollSec: number, holds: HoldProfile[]): Seg[][] {
	const index = new Map(model.bands.map((b, k) => [b.id, k]));
	return units.map((u, n) => {
		const runs = model.scope === "run" ? [runOf(u)] : undefined;
		const { timeline } = replayPhases(model, u.points, pollSec, runs, { holds });
		const out: Seg[] = [];
		let pred: Seg["pred"] = model.scope === "run" ? "idle" : null;
		for (const s of timeline) {
			const band = s.id === SYSTEM_PHASES.rest ? -1 : (index.get(s.id) ?? -2);
			const seg: Seg = { band, from: s.from, to: s.to, pred, unit: n, closed: s.final, next: null };
			const prev = out.at(-1);
			if (prev) {
				prev.next = seg;
			}
			out.push(seg);
			pred = band === -1 ? "idle" : band >= 0 ? "active" : null;
		}
		return out;
	});
}

/**
 * Smoothing of each band (Spec B.5 step 3).
 *
 * @param bands - Bands (min/max)
 * @param units - Units
 * @param raw - Bands read from the raw values (otherwise over the 60-s median)
 * @param scope - Scope
 * @param pollSec - Poll interval
 * @param holds - Hold time profile
 */
function smoothingOf(
	bands: { id: string; min: number; max: number }[],
	units: readonly RunSample[],
	raw: boolean,
	scope: "run" | "continuous",
	pollSec: number,
	holds: HoldProfile[],
): BandDef[] {
	if (raw) {
		// raw stretches per band: median length and whether they lie above both neighbours
		const lengths = bands.map(() => [] as number[]);
		const above = bands.map(() => 0);
		const bandIdx = (v: number): number => bands.findIndex(b => v >= b.min && v < b.max);
		for (const u of units) {
			const p = u.points;
			const runs: { k: number; from: number; to: number }[] = [];
			for (const x of p) {
				const k = bandIdx(x.val);
				const last = runs.at(-1);
				if (last && last.k === k) {
					continue;
				}
				if (last) {
					last.to = x.ts;
				}
				runs.push({ k, from: x.ts, to: x.ts });
			}
			for (let i = 1; i + 1 < runs.length; i++) {
				const r = runs[i];
				if (r.k < 0) {
					continue;
				}
				lengths[r.k].push((r.to - r.from) / 1000);
				if (runs[i - 1].k < r.k && runs[i + 1].k < r.k) {
					above[r.k]++;
				}
			}
		}
		return bands.map((b, k) => {
			const peak =
				lengths[k].length > 0 &&
				median(lengths[k]) < PEAK_FACTOR * DEBOUNCE_SEC &&
				above[k] >= PEAK_EXCURSION_SHARE * lengths[k].length;
			return {
				id: b.id,
				name: b.id,
				min: b.min,
				max: b.max,
				smoothing: peak ? "peak" : "debounce",
				dipSec: DEBOUNCE_SEC,
				windowSec: 0,
			};
		});
	}
	// over the 60-s median: block unless the raw values dip below the band in a rhythm (level)
	const provisional = modelOf(
		scope,
		bands.map(b => ({ ...b, name: b.id, smoothing: "block", dipSec: BLOCK_DIP_SEC, windowSec: 0 })),
		[],
	);
	const segs = bandSegments(provisional, units, pollSec, holds);
	const dips = bands.map(() => [] as number[]);
	const minutes = bands.map(() => 0);
	segs.forEach((list, n) => {
		const p = units[n].points;
		for (const s of list) {
			if (s.band < 0) {
				continue;
			}
			const b = bands[s.band];
			minutes[s.band] += (s.to - s.from) / 60_000;
			let below: number | null = null;
			for (const x of p) {
				if (x.ts < s.from || x.ts >= s.to) {
					continue;
				}
				if (x.val < b.min) {
					below ??= x.ts;
				} else if (below !== null) {
					dips[s.band].push((x.ts - below) / 1000);
					below = null;
				}
			}
		}
	});
	return bands.map((b, k) => {
		const d = [...dips[k]].sort((x, y) => x - y);
		const p99 = quantile(d, 0.99);
		const level = minutes[k] > 0 && d.length / minutes[k] >= LEVEL_DIPS_PER_MIN && p99 < LEVEL_DIP_MAX_SEC;
		const smoothing: BandSmoothing = level ? "level" : "block";
		const windowSec = level ? round15(LEVEL_WINDOW_FACTOR * p99) : 0;
		return {
			id: b.id,
			name: b.id,
			min: b.min,
			max: b.max,
			smoothing,
			dipSec: level ? round15(LEVEL_HOLD_SHARE * windowSec) : BLOCK_DIP_SEC,
			windowSec,
		};
	});
}

/**
 * A model from bands and phases.
 *
 * @param scope - Scope
 * @param bands - Bands
 * @param phases - Phases
 */
function modelOf(scope: "run" | "continuous", bands: BandDef[], phases: PhaseDef[]): PhaseModel {
	return { v: 1, enabled: false, scope, bands, phases, learnedAt: 0, quality: { agreement: 0, runsUsed: 0 } };
}

/**
 * Event phase of a `peak` band (Spec B.5 step 6): at least 80 % of the entries go into a fixed set of
 * at most two following bands.
 *
 * @param k - Band index
 * @param segs - Segments per unit
 * @param units - Units (raw values for the stable level)
 */
function eventOf(k: number, segs: readonly Seg[][], units: readonly RunSample[]): Draft | null {
	const entries = segs.flat().filter(s => s.band === k && s.next !== null);
	if (entries.length === 0) {
		return null;
	}
	const count = new Map<number, number>();
	for (const s of entries) {
		const b = s.next!.band;
		if (b >= 0) {
			count.set(b, (count.get(b) ?? 0) + 1);
		}
	}
	const order = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	const confirm: number[] = [];
	let covered = 0;
	for (const [b, c] of order) {
		if (covered >= EVENT_SHARE * entries.length || confirm.length >= EVENT_MAX_CONFIRM) {
			break;
		}
		confirm.push(b);
		covered += c;
	}
	if (covered < EVENT_SHARE * entries.length) {
		return null;
	}
	const hits = entries.filter(s => confirm.includes(s.next!.band));
	const unitsSeen = new Set(hits.map(s => s.unit));
	if (unitsSeen.size < MIN_UNITS) {
		return null;
	}
	const toConfirm = hits.map(s => (s.next!.from - s.from) / 1000).sort((a, b) => a - b);
	const tails = hits
		.map(s => {
			const p = units[s.unit].points;
			const follow = s.next!;
			// first stored value from which the value stays within STABLE_RATIO for STABLE_SEC
			for (let i = 0; i < p.length; i++) {
				if (p[i].ts < follow.from) {
					continue;
				}
				if (p[i].ts >= follow.to) {
					break;
				}
				const base = p[i].val;
				let stable = true;
				for (let j = i; j < p.length && p[j].ts < p[i].ts + STABLE_SEC * 1000; j++) {
					const v = p[j].val;
					if (v > base * STABLE_RATIO || v * STABLE_RATIO < base) {
						stable = false;
						break;
					}
				}
				if (stable) {
					return (p[i].ts - s.from) / 1000;
				}
			}
			return (follow.to - s.from) / 1000;
		})
		.sort((a, b) => a - b);
	const tailSec = Math.ceil(quantile(tails, EVENT_Q));
	return {
		band: k,
		minSec: 0,
		maxSec: 0,
		decided: "live",
		trigger: { confirm, confirmSec: Math.max(1, Math.ceil(quantile(toConfirm, EVENT_Q))), tailSec },
		lo: tails[0],
		hi: tails.at(-1)!,
		units: unitsSeen,
		lastSeen: Math.max(...hits.map(s => s.next!.from)),
	};
}

/**
 * Duration classes of one band (Spec B.5 step 5) with their predecessor groups (step 6).
 *
 * @param k - Band index
 * @param segs - Segments per unit
 */
function classesOf(k: number, segs: readonly Seg[][]): Draft[] {
	const list = segs
		.flat()
		.filter(s => s.band === k && s.closed)
		.map(s => ({ s, sec: (s.to - s.from) / 1000 }))
		.filter(x => x.sec > 0)
		.sort((a, b) => a.sec - b.sec);
	if (new Set(list.map(x => x.s.unit)).size < MIN_UNITS) {
		return [];
	}
	const groups: (typeof list)[] = [];
	for (const x of list) {
		const g = groups.at(-1);
		if (g && x.sec < CLASS_RATIO * g.at(-1)!.sec) {
			g.push(x);
		} else {
			groups.push([x]);
		}
	}
	const unitsOf = (g: typeof list): number => new Set(g.map(x => x.s.unit)).size;
	for (;;) {
		const weak = groups
			.map((g, i) => ({ i, n: unitsOf(g) }))
			.filter(x => x.n < MIN_UNITS)
			.sort((a, b) => a.n - b.n || a.i - b.i)[0];
		if (!weak || groups.length === 1) {
			break;
		}
		const i = weak.i;
		const gapLeft = i > 0 ? groups[i][0].sec / groups[i - 1].at(-1)!.sec : Infinity;
		const gapRight = i + 1 < groups.length ? groups[i + 1][0].sec / groups[i].at(-1)!.sec : Infinity;
		const j = gapLeft <= gapRight ? i - 1 : i + 1;
		const [a, b] = j < i ? [j, i] : [i, j];
		groups.splice(a, 2, [...groups[a], ...groups[b]]);
	}
	const bounds = groups.slice(1).map((g, i) => Math.round(Math.sqrt(groups[i].at(-1)!.sec * g[0].sec)));
	const out: Draft[] = [];
	groups.forEach((g, i) => {
		const base = {
			band: k,
			minSec: i > 0 ? bounds[i - 1] : 0,
			maxSec: i < bounds.length ? bounds[i] : 0,
			decided: i < bounds.length ? ("end" as const) : ("live" as const),
		};
		const draft = (members: typeof list, ctx?: "idle" | "active"): Draft => ({
			...base,
			...(ctx ? { ctx } : {}),
			lo: members[0].sec,
			hi: members.at(-1)!.sec,
			units: new Set(members.map(x => x.s.unit)),
			lastSeen: Math.max(...members.map(x => x.s.to)),
		});
		const idle = g.filter(x => x.s.pred === "idle");
		const active = g.filter(x => x.s.pred === "active");
		const enough = (m: typeof list): boolean => m.length >= MIN_UNITS && unitsOf(m) >= MIN_UNITS;
		if (enough(idle) && enough(active)) {
			// the predecessor separates two classes that are otherwise the same
			out.push(draft(idle, "idle"), draft(active, "active"));
		} else {
			out.push(draft(g));
		}
	});
	return out;
}

/**
 * Classes, predecessors and event phases from the band reading of a set of units.
 *
 * @param bands - Bands
 * @param segs - Segments per unit (only the units to learn from)
 * @param units - All units (indexed by `Seg.unit`)
 */
function draftsOf(bands: readonly BandDef[], segs: readonly Seg[][], units: readonly RunSample[]): Draft[] {
	const out: Draft[] = [];
	bands.forEach((b, k) => {
		const ev = b.smoothing === "peak" ? eventOf(k, segs, units) : null;
		if (ev) {
			out.push(ev);
		} else {
			out.push(...classesOf(k, segs));
		}
	});
	return out;
}

/**
 * Phases of a model from drafts with the given ids.
 *
 * @param drafts - Drafts
 * @param ids - Id per draft
 * @param bands - Bands
 * @param scope - Scope
 */
function phasesOf(
	drafts: readonly Draft[],
	ids: readonly string[],
	bands: readonly BandDef[],
	scope: string,
): PhaseDef[] {
	return drafts.map((d, i) => {
		const p: PhaseDef = {
			id: ids[i],
			name: ids[i],
			band: bands[d.band].id,
			minSec: d.minSec,
			maxSec: d.maxSec,
			decided: d.decided,
			show: true,
			stats: { runs: d.units.size, agreement: 0, lastSeen: d.lastSeen },
		};
		if (d.ctx === "idle") {
			p.after = scope === "run" ? ["start", "idle"] : ["idle"];
		} else if (d.ctx === "active") {
			p.after = drafts.flatMap((o, j) => (o.band !== d.band ? [ids[j]] : []));
		}
		if (d.trigger) {
			p.trigger = {
				confirm: d.trigger.confirm.map(k => bands[k].id),
				confirmSec: d.trigger.confirmSec,
				tailSec: d.trigger.tailSec,
			};
		}
		return p;
	});
}

/**
 * Which full draft each fold draft stands for: same band, kind and predecessor group, the largest
 * overlap of the durations seen; one to one.
 *
 * @param fold - Drafts of the fold
 * @param full - Drafts of all units
 */
function mapDrafts(fold: readonly Draft[], full: readonly Draft[]): (number | null)[] {
	const pairs: { i: number; j: number; score: number }[] = [];
	fold.forEach((f, i) =>
		full.forEach((g, j) => {
			if (f.band !== g.band || !f.trigger !== !g.trigger || f.ctx !== g.ctx) {
				return;
			}
			const score = f.trigger ? 1 : overlap([f.lo, f.hi], [g.lo, g.hi]);
			if (score > 0) {
				pairs.push({ i, j, score });
			}
		}),
	);
	pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
	const out: (number | null)[] = fold.map(() => null);
	const used = new Set<number>();
	for (const p of pairs) {
		if (out[p.i] === null && !used.has(p.j)) {
			out[p.i] = p.j;
			used.add(p.j);
		}
	}
	return out;
}

/**
 * Remove phases from a model and from the `after` lists; phases left without a predecessor go too.
 *
 * @param m - Model
 * @param drop - Ids of the phases to remove
 */
function withoutPhases(m: PhaseModel, drop: ReadonlySet<string>): PhaseModel {
	let phases = m.phases.filter(p => !drop.has(p.id));
	for (;;) {
		const ids = new Set(phases.map(p => p.id));
		const next = phases
			.map(p => (p.after ? { ...p, after: p.after.filter(a => a === "idle" || a === "start" || ids.has(a)) } : p))
			.filter(p => !p.after || p.after.length > 0);
		if (next.length === phases.length) {
			phases = next;
			break;
		}
		phases = next;
	}
	return { ...m, phases };
}

/**
 * Make phases decided at the end (retro only).
 *
 * @param m - Model
 * @param ids - Ids of the phases
 */
function retro(m: PhaseModel, ids: ReadonlySet<string>): PhaseModel {
	return { ...m, phases: m.phases.map(p => (ids.has(p.id) ? { ...p, decided: "end" as const } : p)) };
}

/**
 * Cross-check (Spec B.5 step 7): each unit is replayed online with the model learned from the other
 * units; reference is its offline timeline with the model of all units. Outside the transition zones a
 * time counts as right when the live name is the reference or the band of the reference class (the
 * generic name is never wrong); a live class where the reference is something else is wrong.
 *
 * @param full - Model of all units
 * @param folds - Model per left-out unit
 * @param units - Units
 * @param pollSec - Poll interval
 * @param holds - Hold time profile
 */
function crossCheck(
	full: PhaseModel,
	folds: readonly PhaseModel[],
	units: readonly RunSample[],
	pollSec: number,
	holds: HoldProfile[],
): { agreement: number; per: Map<string, ClassCheck>; flicker: number } {
	const stepMs = Math.max(1, pollSec) * 1000;
	const lagMs =
		Math.max(
			...full.bands.map(b => {
				const enter = b.smoothing === "block" ? 20 : b.smoothing === "debounce" ? b.dipSec : 0;
				return Math.max(enter + b.dipSec, b.windowSec);
			}),
			0,
		) *
			1000 +
		2 * stepMs;
	const per = new Map<string, ClassCheck>();
	const of = (id: string): ClassCheck => {
		let c = per.get(id);
		if (!c) {
			c = { ok: 0, ref: 0, wrong: 0, wrongSegs: 0 };
			per.set(id, c);
		}
		return c;
	};
	let ok = 0;
	let total = 0;
	let liveChanges = 0;
	let offline = 0;
	units.forEach((u, n) => {
		const fold = folds[n];
		const bandOfId = new Map<string, string>();
		const phaseIds = new Set<string>();
		for (const m of [full, fold]) {
			for (const p of m.phases) {
				bandOfId.set(p.id, p.band);
				phaseIds.add(p.id);
			}
		}
		const runs = full.scope === "run" ? [runOf(u)] : undefined;
		const ref = replayPhases(full, u.points, pollSec, runs, { holds }).timeline;
		const live = replayPhases(fold, u.points, pollSec, runs, { holds }).live;
		// flicker: changes of the band shown live against the offline segments; a name shown for less
		// than the transition time (and a segment that short) is part of a transition, not a change
		const end = ref.at(-1)?.to ?? 0;
		offline += ref.filter(x => x.to - x.from >= lagMs).length;
		let lastBand: string | null = null;
		live.forEach((x, i) => {
			if ((live[i + 1]?.t ?? end) - x.t < lagMs) {
				return;
			}
			const band = x.id === null ? null : (bandOfId.get(x.id) ?? x.id);
			if (band !== lastBand && band !== null) {
				liveChanges++;
			}
			lastBand = band;
		});
		const zones = ref.flatMap((s: Segment) => [s.from, s.to]).sort((a, b) => a - b);
		const inZone = (t: number): boolean => {
			let lo = 0;
			let hi = zones.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (zones[mid] <= t + stepMs) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			// boundaries at or before t + step: the latest of them
			return lo > 0 && t < zones[lo - 1] + lagMs && t >= zones[lo - 1] - stepMs;
		};
		let r = 0;
		let l = 0;
		// live episode of one phase: wrong when any of its times outside the zones is wrong
		const episode: { id: string | null; wrong: boolean } = { id: null, wrong: false };
		const closeEpisode = (): void => {
			if (episode.id !== null && episode.wrong) {
				of(episode.id).wrongSegs++;
			}
			episode.id = null;
			episode.wrong = false;
		};
		const from = ref[0]?.from ?? 0;
		for (let t = from; t < end; t += stepMs) {
			while (r < ref.length && ref[r].to <= t) {
				r++;
			}
			while (l + 1 < live.length && live[l + 1].t <= t) {
				l++;
			}
			const refId = r < ref.length && ref[r].from <= t ? ref[r].id : null;
			const liveId = live[l] && live[l].t <= t ? live[l].id : null;
			if (liveId === null || !phaseIds.has(liveId)) {
				closeEpisode();
			} else if (episode.id !== liveId) {
				closeEpisode();
				episode.id = liveId;
			}
			if (refId === null || inZone(t)) {
				continue;
			}
			const refPhase = phaseIds.has(refId);
			const right = liveId === refId || (refPhase && liveId === bandOfId.get(refId));
			total += stepMs;
			if (refPhase) {
				of(refId).ref += stepMs;
			}
			if (right) {
				ok += stepMs;
				if (refPhase) {
					of(refId).ok += stepMs;
				}
			} else if (liveId !== null && phaseIds.has(liveId)) {
				of(liveId).wrong += stepMs;
				episode.wrong = true;
			}
		}
		closeEpisode();
	});
	return { agreement: total > 0 ? ok / total : 1, per, flicker: offline > 0 ? liveChanges / offline : 0 };
}

function agreementOf(c: ClassCheck | undefined): number {
	if (!c || c.ref + c.wrong === 0) {
		return 1;
	}
	return c.ok / (c.ref + c.wrong);
}

/**
 * Typical value of each band in W: time-weighted median of the held values in the band.
 *
 * @param bands - Bands
 * @param units - Units
 * @param factor - W per unit of the state
 */
function typicalW(bands: readonly BandDef[], units: readonly RunSample[], factor: number): number[] {
	const pairs = bands.map(() => [] as [number, number][]);
	for (const u of units) {
		const p = u.points;
		for (let i = 0; i + 1 < p.length; i++) {
			const k = bands.findIndex(b => p[i].val >= b.min && p[i].val < b.max);
			if (k >= 0) {
				pairs[k].push([p[i].val, p[i + 1].ts - p[i].ts]);
			}
		}
	}
	return pairs.map((x, k) => {
		if (x.length === 0) {
			return Math.round(bands[k].min * factor);
		}
		x.sort((a, b) => a[0] - b[0]);
		const total = x.reduce((s, y) => s + y[1], 0);
		let acc = 0;
		for (const [v, d] of x) {
			acc += d;
			if (acc >= total / 2) {
				return Math.round(v * factor);
			}
		}
		return Math.round(x.at(-1)![0] * factor);
	});
}

/**
 * Default neutral name (English template).
 *
 * @param n - Number of the band
 * @param w - Typical value in W
 * @param min - Shortest duration in min
 * @param max - Longest duration in min
 */
function defaultNeutral(n: number, w: number, min: number, max: number): string {
	return NEUTRAL_TEMPLATE.replace("{n}", String(n))
		.replace("{w}", String(w))
		.replace("{min}", String(min))
		.replace("{max}", String(max));
}

/**
 * Free id with a prefix.
 *
 * @param prefix - Prefix
 * @param used - Ids in use (the new id is added)
 */
function freeId(prefix: string, used: Set<string>): string {
	for (let n = 1; ; n++) {
		const id = `${prefix}${n}`;
		if (!used.has(id)) {
			used.add(id);
			return id;
		}
	}
}

/**
 * Duration range of a phase for the matching (s).
 *
 * @param p - Phase
 */
function rangeOf(p: PhaseDef): [number, number] {
	return [Math.max(1, p.minSec), p.maxSec > 0 ? p.maxSec : Infinity];
}

/**
 * Learn the phase model of a device (Spec B.5 steps 1–8). Uses the units admitted for phases (runs;
 * with scope continuous day sections).
 *
 * @param units - Samples with their verdicts
 * @param ctx - Device
 */
export function learnPhases(units: readonly PhaseUnit[], ctx: PhaseLearnContext): PhaseLearnResult {
	const factor = ctx.unitFactor > 0 ? ctx.unitFactor : 1;
	const runLimit = ctx.runLimitW / factor;
	const pollSec = Math.max(1, ctx.pollSec);
	const used = units
		.filter(u => u.sample.kind === "run" && admitted(u.verdict, "phases"))
		.map(u => u.sample)
		.sort((a, b) => a.facts.start - b.facts.start);
	// step 1: scope
	let scope = ctx.scope;
	if (!scope) {
		const days = used.length > 0 ? Math.max(1, (used.at(-1)!.facts.end - used[0].facts.start) / 86_400_000) : 1;
		const rests = used.slice(1).map((u, i) => (u.facts.start - used[i].facts.end) / 60_000);
		scope = used.length < 2 ? "run" : scopeOf(used.length / days, median(rests));
	}
	// step 2: bands
	const raw = !rhythmic(used, runLimit);
	const opts: BandOptions = raw
		? { mode: "raw", dipSec: DEBOUNCE_SEC }
		: { mode: "median60", dipSec: MEDIAN_DIP_SEC };
	const learned = learnBands(used, runLimit, opts);
	const holds = holdProfile(used, learned);
	// step 3: smoothing
	const bands = smoothingOf(learned, used, raw, scope, pollSec, holds);
	// steps 4–6: segments with the tracker code, classes, predecessors, event phases
	const segs = bandSegments(modelOf(scope, bands, []), used, pollSec, holds);
	const drafts = draftsOf(bands, segs, used);
	const keys = drafts.map((_, i) => `k${i + 1}`);
	let full = modelOf(scope, bands, phasesOf(drafts, keys, bands, scope));
	// step 7: cross-check, fold models with the ids of the full model
	let folds = used.map((_, n) => {
		const fd = draftsOf(
			bands,
			segs.filter((__, i) => i !== n),
			used,
		);
		const map = mapDrafts(fd, drafts);
		const seen = new Set(keys);
		const ids = fd.map((__, i) => (map[i] !== null ? keys[map[i]] : freeId("x", seen)));
		return modelOf(scope, bands, phasesOf(fd, ids, bands, scope));
	});
	const retroOnly = new Set<string>();
	const liveAgreement = new Map<string, number>();
	// a fold class without a partner in the model is not part of what is checked (its run is named with
	// the band); the classes of the model are checked with the values learned without the run
	const prune = (f: PhaseModel): PhaseModel => {
		const ids = new Set(full.phases.map(p => p.id));
		return withoutPhases(f, new Set(f.phases.filter(p => !ids.has(p.id)).map(p => p.id)));
	};
	folds = folds.map(prune);
	let check = crossCheck(full, folds, used, pollSec, holds);
	for (let pass = 0; pass < 5; pass++) {
		if (check.flicker > FLICKER_MAX) {
			// the band reading flickers live: no class is named live
			const live = full.phases.filter(p => p.decided === "live");
			live.filter(p => p.trigger).forEach(p => retroOnly.add(p.id));
			const all = new Set(live.map(p => p.id));
			full = retro(full, all);
			folds = folds.map(f => retro(f, all));
			check = crossCheck(full, folds, used, pollSec, holds);
			break;
		}
		const failing = full.phases.filter(p => {
			const c = check.per.get(p.id);
			return agreementOf(c) < AGREE_MIN || (c?.wrongSegs ?? 0) > 0;
		});
		if (failing.length === 0) {
			break;
		}
		const drop = new Set<string>();
		const late = new Set<string>();
		for (const p of failing) {
			if (p.trigger && p.decided === "live") {
				late.add(p.id);
				retroOnly.add(p.id);
				liveAgreement.set(p.id, agreementOf(check.per.get(p.id)));
			} else if (!p.trigger) {
				drop.add(p.id);
			}
		}
		if (drop.size === 0 && late.size === 0) {
			break;
		}
		full = retro(withoutPhases(full, drop), late);
		folds = folds.map(f => prune(retro(withoutPhases(f, drop), late)));
		check = crossCheck(full, folds, used, pollSec, holds);
	}
	// without runs nothing was checked
	const agreement = used.length > 0 ? check.agreement : 0;
	// step 8: names and ids (matched phases of the previous model keep theirs)
	const typical = typicalW(bands, used, factor);
	const neutral = ctx.neutralName ?? defaultNeutral;
	const prev = ctx.previous;
	const usedIds = new Set<string>([
		...(prev?.bands.map(b => b.id) ?? []),
		...(prev?.phases.map(p => p.id) ?? []),
		...Object.values(SYSTEM_PHASES),
		"idle",
		"start",
	]);
	// bands: one to one by the overlap of their ranges
	const bandIds: string[] = bands.map(() => "");
	const bandNames: string[] = bands.map(() => "");
	if (prev) {
		const pairs: { i: number; j: number; score: number }[] = [];
		bands.forEach((b, i) =>
			prev.bands.forEach((o, j) => {
				const score = overlap([b.min, b.max], [o.min, o.max]);
				if (score > 0) {
					pairs.push({ i, j, score });
				}
			}),
		);
		pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
		const taken = new Set<number>();
		for (const p of pairs) {
			if (bandIds[p.i] === "" && !taken.has(p.j)) {
				bandIds[p.i] = prev.bands[p.j].id;
				bandNames[p.i] = prev.bands[p.j].name;
				taken.add(p.j);
			}
		}
	}
	const segOfBand = (k: number): number[] =>
		segs
			.flat()
			.filter(s => s.band === k)
			.map(s => (s.to - s.from) / 1000);
	bands.forEach((_, k) => {
		if (bandIds[k] === "") {
			bandIds[k] = freeId("b", usedIds);
			const d = segOfBand(k);
			const lo = d.length > 0 ? Math.min(...d) : 0;
			const hi = d.length > 0 ? Math.max(...d) : 0;
			bandNames[k] = neutral(k + 1, typical[k], Math.floor(lo / 60), Math.max(1, Math.ceil(hi / 60)));
		}
	});
	const draftOf = new Map(keys.map((key, i) => [key, drafts[i]]));
	// phases: previous phases to learned ones by band overlap and duration
	const phaseIds = new Map<string, string>();
	const keep = new Map<string, PhaseDef>();
	const dropped: { id: string; actions: number }[] = [];
	if (prev) {
		const pairs: { key: string; old: PhaseDef; score: number }[] = [];
		for (const old of prev.phases) {
			const ob = prev.bands.find(b => b.id === old.band);
			for (const p of full.phases) {
				const d = draftOf.get(p.id)!;
				if (!ob || !old.trigger !== !p.trigger) {
					continue;
				}
				const nb = bands[d.band];
				const score =
					overlap([ob.min, ob.max], [nb.min, nb.max]) *
					overlap(rangeOf(old), [Math.max(1, d.lo), Math.max(1, d.hi)]);
				if (score > 0) {
					pairs.push({ key: p.id, old, score });
				}
			}
		}
		pairs.sort((a, b) => b.score - a.score || a.old.id.localeCompare(b.old.id) || a.key.localeCompare(b.key));
		for (const p of pairs) {
			if (!phaseIds.has(p.key) && !keep.has(p.old.id)) {
				phaseIds.set(p.key, p.old.id);
				keep.set(p.old.id, p.old);
			}
		}
		for (const old of prev.phases) {
			if (!keep.has(old.id)) {
				dropped.push({ id: old.id, actions: ctx.actionsOf?.(old.id) ?? 0 });
			}
		}
	}
	for (const p of full.phases) {
		if (!phaseIds.has(p.id)) {
			phaseIds.set(p.id, freeId("p", usedIds));
		}
	}
	const bandIdOf = new Map(bands.map((b, k) => [b.id, bandIds[k]]));
	const outBands: BandDef[] = bands.map((b, k) => ({ ...b, id: bandIds[k], name: bandNames[k] }));
	const outPhases: PhaseDef[] = full.phases.map(p => {
		const d = draftOf.get(p.id)!;
		const id = phaseIds.get(p.id)!;
		const old = keep.get(id);
		const c = check.per.get(p.id);
		const out: PhaseDef = {
			id,
			name:
				old?.name ??
				neutral(d.band + 1, typical[d.band], Math.floor(d.lo / 60), Math.max(1, Math.ceil(d.hi / 60))),
			band: bandIdOf.get(p.band)!,
			minSec: p.minSec,
			maxSec: p.maxSec,
			decided: p.decided,
			show: old?.show ?? true,
			stats: {
				runs: p.stats.runs,
				agreement: liveAgreement.get(p.id) ?? agreementOf(c),
				lastSeen: p.stats.lastSeen,
			},
		};
		if (p.after) {
			out.after = p.after.map(a => phaseIds.get(a) ?? a);
		}
		if (p.trigger) {
			out.trigger = { ...p.trigger, confirm: p.trigger.confirm.map(b => bandIdOf.get(b)!) };
		}
		if (old?.final) {
			out.final = true;
		}
		if (old?.notify) {
			out.notify = { ...old.notify };
		}
		return out;
	});
	return {
		model: {
			v: 1,
			enabled: prev?.enabled ?? false,
			scope,
			bands: outBands,
			phases: outPhases,
			learnedAt: ctx.now ?? Date.now(),
			quality: { agreement, runsUsed: used.length },
		},
		looAgreement: agreement,
		retroOnly: [...retroOnly].map(k => phaseIds.get(k)!).filter(id => outPhases.some(p => p.id === id)),
		dropped,
	};
}
