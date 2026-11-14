/** A jump back in time of more than this is unknown time (clock set back, logger replayed old values). */
export const TIME_JUMP_MS = 60_000;

/** Stored value as read (value may be missing or invalid). */
export interface RawPoint {
	/** Timestamp in ms. */
	ts: number;
	/** Value, or null. */
	val: number | null;
}

/** A jump back in time between two values in the order they arrived. */
export interface TimeJump {
	/** Timestamp of the value that jumped back. */
	at: number;
	/** How far it jumped back in ms. */
	backMs: number;
}

/** Result of `cleanPoints`. */
export interface CleanResult {
	/** Valid values, sorted by time, exact duplicates removed, negative values as 0. */
	points: { ts: number; val: number }[];
	/** Share of the input that was missing, not a number or negative (0..1). */
	invalidShare: number;
	/** Jumps back of more than TIME_JUMP_MS. */
	timeJumps: TimeJump[];
	/** Time ranges whose values cannot be placed (from the value that jumped back to the latest time before it). */
	unknown: { from: number; to: number }[];
}

/**
 * Clean raw values before any evaluation: missing and non-numeric values are dropped, negative values
 * become 0, the values are sorted by time and exact duplicates (same time and value) are dropped. A
 * jump back of more than a minute in the order of arrival is reported as unknown time; a smaller one
 * is only reordered.
 *
 * @param input - Values in the order they arrived
 */
export function cleanPoints(input: readonly RawPoint[]): CleanResult {
	const timeJumps: TimeJump[] = [];
	const unknown: { from: number; to: number }[] = [];
	const kept: { ts: number; val: number }[] = [];
	let invalid = 0;
	let prevTs: number | null = null;
	let maxTs = Number.NEGATIVE_INFINITY;
	// exact duplicates: values already seen at a time (raw value, so -4 twice counts once)
	const seen = new Map<number, Set<number>>();
	for (const p of input) {
		if (!Number.isFinite(p.ts)) {
			invalid++;
			continue;
		}
		const raw = p.val;
		if (raw !== null && Number.isFinite(raw)) {
			let atTs = seen.get(p.ts);
			if (atTs?.has(raw)) {
				continue;
			}
			if (!atTs) {
				atTs = new Set();
				seen.set(p.ts, atTs);
			}
			atTs.add(raw);
		}
		if (prevTs !== null && prevTs - p.ts > TIME_JUMP_MS) {
			timeJumps.push({ at: p.ts, backMs: prevTs - p.ts });
			unknown.push({ from: p.ts, to: maxTs });
		}
		prevTs = p.ts;
		maxTs = Math.max(maxTs, p.ts);
		if (raw === null || !Number.isFinite(raw)) {
			invalid++;
			continue;
		}
		if (raw < 0) {
			invalid++;
		}
		kept.push({ ts: p.ts, val: Math.max(0, raw) });
	}
	// stable: values with the same time keep the order of arrival
	kept.sort((a, b) => a.ts - b.ts);
	unknown.sort((a, b) => a.from - b.from);
	const merged: { from: number; to: number }[] = [];
	for (const u of unknown) {
		const top = merged.at(-1);
		if (top && u.from <= top.to) {
			top.to = Math.max(top.to, u.to);
		} else {
			merged.push({ ...u });
		}
	}
	return {
		points: kept,
		invalidShare: input.length > 0 ? invalid / input.length : 0,
		timeJumps,
		unknown: merged,
	};
}
