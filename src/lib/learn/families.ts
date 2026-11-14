import type { RunInfo } from "./runs.js";
import { median } from "./runs.js";
import type { TickSeries } from "./ticks.js";

/** Features of a stored run used to group programmes. */
export interface RunFeatures {
	/** Duration of the programme (start to core end) in s. */
	coreSec: number;
	/** Energy of the programme in Wh. */
	energyWh: number;
	/** Share of active ticks at or above half of the highest value. */
	hiShare: number;
	/** Longest pause inside the programme in s. */
	maxPauseSec: number;
	/** Number of pauses inside the programme. */
	nPause: number;
	/** Whether the run has an anti-crease phase. */
	trailer: boolean;
	/** Mean power of the terminal block in W. */
	blockMean: number;
	/** Time in the highest base band in s (`bandFeaturesOf`). */
	topBandSec?: number;
	/** Number of blocks in the band of the final block (`bandFeaturesOf`). */
	finalBandBlocks?: number;
}

/** Features of a stored run: the group features plus the extremes the optimisation needs (W, s). */
export interface StoredFeatures extends RunFeatures {
	/** Longest burst of the trailer in s. */
	burstMaxSec: number;
	/** Length of the anti-crease phase in s. */
	trailerSec: number;
	/** Median power of the active ticks in W. */
	minRunW: number;
	/** Longest gap between two anti-crease bursts in s. */
	trailerGapMaxSec: number;
	/** Shortest quiet time before a burst of the trailer in s. */
	trailerGapMinSec: number;
}

/** Runs closer than this (RMS of the z-normalised features) belong to one programme group. */
export const FAMILY_DISTANCE = 0.35;

/**
 * Feature vector of a run.
 *
 * @param f - Features
 * @param bands - Use the base band features (only when every run has them)
 */
function vectorOf(f: RunFeatures, bands: boolean): number[] {
	const v = [
		Math.log(Math.max(1, f.coreSec)),
		Math.log(Math.max(0.001, f.energyWh)),
		f.hiShare,
		f.maxPauseSec / 600,
		f.nPause / 10,
		f.trailer ? 1 : 0,
		Math.log(Math.max(0, f.blockMean) + 1),
	];
	if (bands) {
		v.push(Math.log(Math.max(0, f.topBandSec ?? 0) + 1), f.finalBandBlocks ?? 0);
	}
	return v;
}

/**
 * Whether a run has both base band features as numbers.
 *
 * @param f - Features
 */
function hasBandFeatures(f: RunFeatures): boolean {
	return Number.isFinite(f.topBandSec) && Number.isFinite(f.finalBandBlocks);
}

/**
 * Group runs into programme families (single linkage over z-normalised features). Ids are stable:
 * a group keeps the smallest id known for one of its members, new groups get new ids. The base band
 * features (`topBandSec`, `finalBandBlocks`) count only when every run has them.
 *
 * @param features - Features per run
 * @param known - Known family id per run (-1 = new run)
 * @param nextId - Next free family id
 * @param distance - Runs closer than this belong to one group (default FAMILY_DISTANCE)
 * @returns family id per run and the next free id
 */
export function assignFamilies(
	features: readonly RunFeatures[],
	known: readonly number[],
	nextId: number,
	distance = FAMILY_DISTANCE,
): { families: number[]; nextId: number } {
	const n = features.length;
	if (n === 0) {
		return { families: [], nextId };
	}
	const bands = features.every(hasBandFeatures);
	const vecs = features.map(f => vectorOf(f, bands));
	const dim = vecs[0].length;
	const mean = Array.from({ length: dim }, (_, d) => vecs.reduce((s, v) => s + v[d], 0) / n);
	const sd = Array.from({ length: dim }, (_, d) =>
		Math.sqrt(vecs.reduce((s, v) => s + (v[d] - mean[d]) ** 2, 0) / n),
	);
	const z = vecs.map(v => v.map((x, d) => (sd[d] > 1e-9 ? (x - mean[d]) / sd[d] : 0)));
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		let r = i;
		while (parent[r] !== r) {
			r = parent[r];
		}
		return r;
	};
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const dist = Math.sqrt(z[i].reduce((s, x, d) => s + (x - z[j][d]) ** 2, 0) / dim);
			if (dist < distance) {
				parent[find(i)] = find(j);
			}
		}
	}
	const groupId = new Map<number, number>();
	for (let i = 0; i < n; i++) {
		if (known[i] >= 0) {
			const root = find(i);
			groupId.set(root, Math.min(groupId.get(root) ?? Number.POSITIVE_INFINITY, known[i]));
		}
	}
	let next = nextId;
	const families = features.map((_, i) => {
		const root = find(i);
		let id = groupId.get(root);
		if (id === undefined) {
			id = next++;
			groupId.set(root, id);
		}
		return id;
	});
	return { families, nextId: next };
}

/**
 * Features of a run of a series in W.
 *
 * @param s - Series in W
 * @param r - Run
 * @param runLimit - Run level in W
 */
export function featuresOf(s: TickSeries, r: RunInfo, runLimit: number): StoredFeatures {
	const stepSec = s.stepMs / 1000;
	const active: number[] = [];
	let energy = 0;
	let peak = 0;
	for (let i = r.from; i <= r.coreEnd; i++) {
		energy += s.last[i] * stepSec;
		if (s.last[i] > runLimit) {
			active.push(s.last[i]);
			peak = Math.max(peak, s.last[i]);
		}
	}
	const hi = active.filter(v => v >= 0.5 * peak).length;
	const pauses = r.gaps.map(g => (g.to - g.from + 1) * stepSec);
	let trailGap = 0;
	for (let k = 1; k < r.bursts.length; k++) {
		trailGap = Math.max(trailGap, (r.bursts[k].from - r.bursts[k - 1].to - 1) * stepSec);
	}
	return {
		coreSec: (r.coreEnd - r.from + 1) * stepSec,
		energyWh: energy / 3600,
		hiShare: active.length > 0 ? hi / active.length : 0,
		maxPauseSec: pauses.length > 0 ? Math.max(...pauses) : 0,
		nPause: pauses.length,
		trailer: r.bursts.length >= 2,
		blockMean: r.blockMean,
		burstMaxSec: r.burstMaxMs / 1000,
		trailerSec: r.trailerTo !== null ? (r.trailerTo - r.coreEnd) * stepSec : 0,
		minRunW: median(active),
		trailerGapMaxSec: trailGap,
		trailerGapMinSec: r.gapMinMs / 1000,
	};
}
