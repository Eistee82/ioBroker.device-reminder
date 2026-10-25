export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const HHMM = /^(\d{1,2}):(\d{2})$/;
const MINUTES_PER_DAY = 24 * 60;
export function parseNumber(val) {
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
export function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
export function formatTimestamp(d) {
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function parseHhmm(s) {
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
export function isInWindow(now, from, until) {
    const start = parseHhmm(from) ?? 0;
    const end = parseHhmm(until) ?? MINUTES_PER_DAY - 1;
    if (start === end) {
        return true;
    }
    const current = now.getHours() * 60 + now.getMinutes();
    if (start <= end) {
        return start <= current && current <= end;
    }
    return current >= start || current <= end;
}
export function nextWindowStart(now, from, until) {
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
export function coerceToType(value, type) {
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
function pad(n) {
    return n.toString().padStart(2, "0");
}
//# sourceMappingURL=utils.js.map