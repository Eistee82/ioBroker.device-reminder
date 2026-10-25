// Generates the states tables in docs/en/README.md and docs/de/README.md from DEVICE_STATES.
// Run after `npm run build`: node scripts/generate-docs-states.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEVICE_STATES } from "../build/lib/stateDefinitions.js";

const BEGIN = "<!-- BEGIN STATES -->";
const END = "<!-- END STATES -->";

/** Instance-level states (not part of DEVICE_STATES). */
const INFO_STATES = [
	{
		id: "info.connection",
		type: "boolean",
		role: "indicator.connected",
		rw: "r",
		unit: "",
		name: { en: "Adapter connected", de: "Adapter verbunden" },
	},
];

const INTRO = {
	en: "Device states are relative to the device object `<deviceId>`. Info states are on the adapter instance.",
	de: "Gerätezustände sind relativ zum Geräteobjekt `<deviceId>` angegeben. Info-Zustände liegen an der Adapterinstanz.",
};

const LABELS = {
	en: { id: "ID", type: "Type", role: "Role", rw: "rw", unit: "Unit", name: "Name" },
	de: { id: "ID", type: "Typ", role: "Rolle", rw: "rw", unit: "Einheit", name: "Name" },
};

/**
 * Build the markdown table rows for one language.
 *
 * @param {"en" | "de"} lang - Language of the names and headers.
 */
function buildBlock(lang) {
	const l = LABELS[lang];
	const rows = [
		...DEVICE_STATES.map(def => ({
			id: def.id,
			type: def.type,
			role: def.role,
			rw: `${def.read ? "r" : ""}${def.write ? "w" : ""}` || "-",
			unit: def.unit ?? "",
			name: def.name[lang],
		})),
		...INFO_STATES.map(def => ({ ...def, name: def.name[lang] })),
	];
	const lines = [
		INTRO[lang],
		"",
		`| ${l.id} | ${l.type} | ${l.role} | ${l.rw} | ${l.unit} | ${l.name} |`,
		"| --- | --- | --- | --- | --- | --- |",
		...rows.map(r => `| \`${r.id}\` | ${r.type} | ${r.role} | ${r.rw} | ${r.unit || "-"} | ${r.name} |`),
	];
	return lines.join("\n");
}

/**
 * Replace the block between the markers of one docs file.
 *
 * @param {"en" | "de"} lang - Documentation language.
 */
function updateDocs(lang) {
	const file = fileURLToPath(new URL(`../docs/${lang}/README.md`, import.meta.url));
	const text = readFileSync(file, "utf8");
	const start = text.indexOf(BEGIN);
	const end = text.indexOf(END);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`${lang}: markers ${BEGIN} / ${END} not found in ${file}`);
	}
	const head = text.slice(0, start + BEGIN.length);
	const tail = text.slice(end);
	writeFileSync(file, `${head}\n${buildBlock(lang)}\n${tail}`, "utf8");
	console.log(`updated ${file}`);
}

updateDocs("en");
updateDocs("de");
