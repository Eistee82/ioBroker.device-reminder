const ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};
function escapeHtml(text) {
    return text.replace(/[&<>"']/g, c => ESCAPES[c]);
}
export function renderHistoryHtml(ops) {
    const rows = ops
        .map(op => `<tr><td>${escapeHtml(op.start)}</td><td>${escapeHtml(op.end)}</td><td>${escapeHtml(op.runtime)}</td></tr>`)
        .join("");
    return `<table><thead><tr><th>Start</th><th>End</th><th>Runtime</th></tr></thead><tbody>${rows}</tbody></table>`;
}
//# sourceMappingURL=historyHtml.js.map