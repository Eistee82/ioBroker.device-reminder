const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, c => ESCAPES[c]);
}

/**
 * Render the last operations of a device as an HTML table (for the `lastOperationsHtml` state).
 *
 * @param ops - Operations with formatted start, end and runtime
 */
export function renderHistoryHtml(ops: { start: string; end: string; runtime: string }[]): string {
	const rows = ops
		.map(
			op =>
				`<tr><td>${escapeHtml(op.start)}</td><td>${escapeHtml(op.end)}</td><td>${escapeHtml(op.runtime)}</td></tr>`,
		)
		.join("");
	return `<table><thead><tr><th>Start</th><th>End</th><th>Runtime</th></tr></thead><tbody>${rows}</tbody></table>`;
}
