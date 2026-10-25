/** Rooms and functions (ioBroker categories) a device object can be assigned to. */
export interface EnumOption {
	/** Enum id, e.g. `enum.rooms.kitchen`. */
	value: string;
	/** Display name. */
	label: string;
}

/** Members of the room and function enums, keyed by enum id. */
export type EnumMembers = Record<string, string[]>;

/** Enum ids a device has to be added to or removed from. */
export interface EnumUpdate {
	/** Enums that get the device as member. */
	add: string[];
	/** Enums that lose the device as member. */
	remove: string[];
}

/**
 * Display name of an enum (translated name in the given language, English, or the last id part).
 *
 * @param id - Enum id
 * @param name - `common.name` of the enum
 * @param lang - Admin language
 */
export function enumLabel(id: string, name: ioBroker.StringOrTranslated | undefined, lang: string): string {
	if (typeof name === "string" && name) {
		return name;
	}
	if (name && typeof name === "object") {
		const n = name as Record<string, string | undefined>;
		const any = Object.values(n).find(v => typeof v === "string" && v !== "");
		return n[lang] || n.en || n.de || any || id.split(".").pop() || id;
	}
	return id.split(".").pop() || id;
}

/**
 * Enums (of the given kind) the device object is a member of.
 *
 * @param members - Members per enum id
 * @param kind - `rooms` or `functions`
 * @param objectId - Full id of the device object
 */
export function membershipOf(members: EnumMembers, kind: "rooms" | "functions", objectId: string): string[] {
	return Object.entries(members)
		.filter(([id, list]) => id.startsWith(`enum.${kind}.`) && list.includes(objectId))
		.map(([id]) => id)
		.sort();
}

/**
 * Which enums of one kind have to change so that the device is a member of exactly the selected ones.
 *
 * @param members - Members per enum id
 * @param kind - `rooms` or `functions`
 * @param objectId - Full id of the device object
 * @param selected - Enum ids chosen in the form
 */
export function planEnumUpdate(
	members: EnumMembers,
	kind: "rooms" | "functions",
	objectId: string,
	selected: readonly string[],
): EnumUpdate {
	const current = membershipOf(members, kind, objectId);
	const wanted = selected.filter(id => id.startsWith(`enum.${kind}.`) && id in members);
	return {
		add: wanted.filter(id => !current.includes(id)),
		remove: current.filter(id => !wanted.includes(id)),
	};
}
