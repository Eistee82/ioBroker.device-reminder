// Phase models of the washer and the boiler (names given by a user, not translated) and the peaks of the
// boiler data (Spec A.4, A.5, 3; S13).

const stats = { runs: 3, agreement: 1, lastSeen: 0 };

/** Washer: washing, spin and heating; intermediate spins only known at their end. */
export const WM_PHASES = {
	v: 1,
	enabled: true,
	scope: "run",
	bands: [
		{ id: "wash", name: "Waschen", min: 5.5, max: 150, smoothing: "level", dipSec: 45, windowSec: 60 },
		{ id: "spin", name: "Schleudern", min: 150, max: 1311, smoothing: "block", dipSec: 30, windowSec: 0 },
		{ id: "heat", name: "Heizen", min: 1311, max: Infinity, smoothing: "block", dipSec: 30, windowSec: 0 },
	],
	phases: [
		{ id: "p1", name: "Heizen", band: "heat", minSec: 0, maxSec: 0, decided: "live", show: true, stats },
		{ id: "p2", name: "Waschen", band: "wash", minSec: 0, maxSec: 0, decided: "live", show: true, stats },
		{
			id: "p3",
			name: "Zwischenschleudern",
			band: "spin",
			minSec: 0,
			maxSec: 114,
			decided: "end",
			show: true,
			stats,
		},
		{ id: "p4", name: "Endschleudern", band: "spin", minSec: 168, maxSec: 0, decided: "live", show: true, stats },
	],
	learnedAt: 0,
	quality: { agreement: 1, runsUsed: 12 },
};

/**
 * Boiler: start-up and run-on in the same band, told apart by the predecessor; ignition as an event phase.
 * `confirmSec` is the p95 of the time from the peak to the burner band in the data (24 s, Spec B.5 step 6).
 */
export const BOILER_PHASES = {
	v: 1,
	enabled: true,
	scope: "continuous",
	bands: [
		{ id: "low", name: "Pumpe", min: 35, max: 120, smoothing: "debounce", dipSec: 5, windowSec: 0 },
		{ id: "burner", name: "Brenner", min: 120, max: 294, smoothing: "debounce", dipSec: 5, windowSec: 0 },
		{ id: "peak", name: "Spitze", min: 294, max: Infinity, smoothing: "peak", dipSec: 5, windowSec: 0 },
	],
	phases: [
		{
			id: "q1",
			name: "Anlauf",
			band: "low",
			minSec: 0,
			maxSec: 0,
			after: ["idle"],
			decided: "live",
			show: true,
			stats,
		},
		{
			id: "q2",
			name: "Nachlauf",
			band: "low",
			minSec: 0,
			maxSec: 0,
			after: ["q3", "q4"],
			decided: "live",
			show: true,
			stats,
		},
		{
			id: "q3",
			name: "Brenner mit Pumpe",
			band: "burner",
			minSec: 0,
			maxSec: 0,
			decided: "live",
			show: true,
			stats,
		},
		{
			id: "q4",
			name: "Zündung",
			band: "peak",
			minSec: 0,
			maxSec: 0,
			trigger: { confirm: ["burner"], confirmSec: 25, tailSec: 60 },
			decided: "live",
			show: true,
			stats,
		},
	],
	learnedAt: 0,
	quality: { agreement: 1, runsUsed: 4 },
};

/**
 * Peaks of the boiler data: a value above 294 W after one at or below it. `intoBurner`: the value held
 * 60 s after the begin of the peak lies in [120, 294) (Spec 3, S13). `settleMs`: time from the begin of
 * the peak to the first stretch of values in [120, 294) that lasts at least 5 s (the debounce of the
 * burner band: from then on the data prove the transition).
 *
 * @param {{ ts: number, val: number }[]} points stored values (sorted)
 * @returns {{ ts: number, intoBurner: boolean, settleMs: number }[]} peaks
 */
export function peaksOf(points) {
	const out = [];
	const heldAt = (from, t) => {
		let v = points[from].val;
		for (let j = from; j < points.length && points[j].ts <= t; j++) {
			v = points[j].val;
		}
		return v;
	};
	for (let i = 0; i < points.length; i++) {
		if (points[i].val > 294 && (i === 0 || points[i - 1].val <= 294)) {
			const ts = points[i].ts;
			const v = heldAt(i, ts + 60_000);
			const inBurner = x => x.val >= 120 && x.val < 294;
			let settleMs = Infinity;
			for (let k = i; k < points.length && settleMs === Infinity; k++) {
				if (inBurner(points[k]) && (k === i || !inBurner(points[k - 1]))) {
					let j = k;
					while (j < points.length && inBurner(points[j])) {
						j++;
					}
					if (j === points.length || points[j].ts - points[k].ts >= 5000) {
						settleMs = points[k].ts - ts;
					}
				}
			}
			out.push({ ts, intoBurner: v >= 120 && v < 294, settleMs });
		}
	}
	return out;
}
