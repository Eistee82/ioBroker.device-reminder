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
}

/** Runs closer than this (RMS of the z-normalised features) belong to one programme group. */
export const FAMILY_DISTANCE = 0.35;

/**
 * Feature vector of a run.
 *
 * @param f - Features
 */
function vectorOf(f: RunFeatures): number[] {
	return [
		Math.log(Math.max(1, f.coreSec)),
		Math.log(Math.max(0.001, f.energyWh)),
		f.hiShare,
		f.maxPauseSec / 600,
		f.nPause / 10,
		f.trailer ? 1 : 0,
		Math.log(Math.max(0, f.blockMean) + 1),
	];
}

/**
 * Group runs into programme families (single linkage over z-normalised features). Ids are stable:
 * a group keeps the smallest id known for one of its members, new groups get new ids.
 *
 * @param features - Features per run
 * @param known - Known family id per run (-1 = new run)
 * @param nextId - Next free family id
 * @returns family id per run and the next free id
 */
export function assignFamilies(
	features: readonly RunFeatures[],
	known: readonly number[],
	nextId: number,
): { families: number[]; nextId: number } {
	const n = features.length;
	if (n === 0) {
		return { families: [], nextId };
	}
	const vecs = features.map(vectorOf);
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
			if (dist < FAMILY_DISTANCE) {
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
