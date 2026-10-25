/**
 * Convert an unknown thrown value into a log-friendly message.
 *
 * @param err - Anything caught in a catch clause
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const HHMM = /^(\d{1,2}):(\d{2})$/;
const MINUTES_PER_DAY = 24 * 60;

/**
 * Parse a value that may be a number or a numeric string (decimal comma allowed).
 *
 * @param val - Raw state value
 * @returns The finite number, or null if the value is not numeric
 */
export function parseNumber(val: unknown): number | null {
	if (typeof val === "number") {
		return Number.isFinite(val) ? val : null;
	}
	if (typeof val !== "string") {
		return null;
	}
	const normalized = val.trim().replace(",", ".");
	if (!NUMERIC_STRING.test(normalized)) {
		return null;
	}
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Format a duration as "hh:mm:ss"; hours keep counting beyond 24.
 *
 * @param ms - Duration in milliseconds (negative values are clamped to 0)
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Format a date as "DD.MM.YYYY hh:mm:ss" in local time.
 *
 * @param d - Date to format
 */
export function formatTimestamp(d: Date): string {
	return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Parse "HH:MM" into minutes since midnight.
 *
 * @param s - Time string, e.g. "07:30"
 * @returns Minutes since midnight, or null if missing or invalid
 */
export function parseHhmm(s: string | undefined): number | null {
	if (s === undefined) {
		return null;
	}
	const match = HHMM.exec(s.trim());
	if (!match) {
		return null;
	}
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) {
		return null;
	}
	return hours * 60 + minutes;
}

/**
 * Check whether the time of day of `now` lies inside the window [from, until].
 * A missing bound defaults to 00:00 (from) or 23:59 (until). A window with from > until wraps midnight.
 *
 * @param now - Point in time to check
 * @param from - Window start "HH:MM"
 * @param until - Window end "HH:MM"
 */
export function isInWindow(now: Date, from?: string, until?: string): boolean {
	const start = parseHhmm(from) ?? 0;
	const end = parseHhmm(until) ?? MINUTES_PER_DAY - 1;
	const current = now.getHours() * 60 + now.getMinutes();
	if (start <= end) {
		return start <= current && current <= end;
	}
	return current >= start || current <= end;
}

/**
 * Return `now` if it lies inside the window, otherwise the next point in time the window starts.
 *
 * @param now - Reference point in time
 * @param from - Window start "HH:MM"
 * @param until - Window end "HH:MM"
 */
export function nextWindowStart(now: Date, from?: string, until?: string): Date {
	if (isInWindow(now, from, until)) {
		return now;
	}
	const start = parseHhmm(from) ?? 0;
	const candidate = new Date(now.getTime());
	candidate.setHours(Math.floor(start / 60), start % 60, 0, 0);
	if (candidate.getTime() <= now.getTime()) {
		candidate.setDate(candidate.getDate() + 1);
	}
	return candidate;
}

/**
 * Convert a string value into the type declared for a state.
 * "boolean" and "number" are converted strictly; "string" stays a string;
 * for any other or missing type "true"/"false" become booleans and numeric strings become numbers.
 *
 * @param value - Raw string value
 * @param type - Declared common.type of the state
 */
export function coerceToType(value: string, type: ioBroker.CommonType | undefined): ioBroker.StateValue {
	if (type === "string") {
		return value;
	}
	if (type === "boolean") {
		return value === "true" ? true : value === "false" ? false : value;
	}
	if (type === "number") {
		return parseNumber(value) ?? value;
	}
	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	return parseNumber(value) ?? value;
}

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
