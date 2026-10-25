export interface ProgressEstimate {
	percent: number | null;
	remainingMs: number | null;
}

const MAX_SAMPLES = 5;

/**
 * Parse a "hh:mm:ss" duration (hours may exceed 24) into milliseconds
 *
 * @param text duration text
 */
function parseDuration(text: string): number | null {
	const match = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(String(text).trim());
	if (!match) {
		return null;
	}
	return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000;
}

/**
 * Estimate the progress of a running cycle from the mean of the last runtimes
 *
 * @param lastOperations finished cycles, oldest first (as in the lastOperations state)
 * @param runtimeMs runtime of the current cycle in milliseconds
 */
export function estimateProgress(lastOperations: { runtime: string }[], runtimeMs: number): ProgressEstimate {
	const durations = lastOperations
		.slice(-MAX_SAMPLES)
		.map(op => parseDuration(op.runtime))
		.filter((d): d is number => d !== null && d > 0);
	if (durations.length < 1) {
		return { percent: null, remainingMs: null };
	}
	const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
	const percent = Math.min(99, Math.max(0, Math.round((runtimeMs / mean) * 100)));
	return { percent, remainingMs: Math.max(0, Math.round(mean - runtimeMs)) };
}
