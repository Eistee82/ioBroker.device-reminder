const UMLAUTS: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/**
 * Turn a device name into a valid, lower-case object ID part.
 * Umlauts are transliterated; every character outside `a-z0-9_-` (spaces, dots and all
 * characters forbidden in ioBroker IDs) becomes `_`, repeated `_` are merged and trimmed.
 *
 * @param name - Device name as entered by the user
 */
export function sanitizeId(name: string): string {
	const id = name
		.toLowerCase()
		.replace(/[äöüß]/g, ch => UMLAUTS[ch])
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
	return id === "" ? "device" : id;
}

/**
 * Create a unique device ID from a name. On collision `_2`, `_3` ... is appended.
 *
 * @param name - Device name as entered by the user
 * @param existingIds - IDs that are already taken
 */
export function allocateDeviceId(name: string, existingIds: ReadonlySet<string>): string {
	const base = sanitizeId(name);
	if (!existingIds.has(base)) {
		return base;
	}
	let n = 2;
	while (existingIds.has(`${base}_${n}`)) {
		n++;
	}
	return `${base}_${n}`;
}
