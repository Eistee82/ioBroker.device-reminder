import { normalizeTrailer } from "./config.js";
import type { DetectionMode, TypeThresholds } from "./detector/types.js";
import { allocateDeviceId } from "./ids.js";
import { parseNumber } from "./utils.js";

/**
 * Device types of earlier versions (`native.types`). The detection values live in the device; the types are
 * only read to move old configurations into the devices and to offer them as archive templates.
 */

/** Device type of an earlier version. */
export interface DeviceTypeConfig extends TypeThresholds {
	/** Id. */
	id: string;
	/** Name. */
	name: string;
	/** Builtin. */
	builtin: boolean;
	/** Mode. */
	mode: DetectionMode;
	/** Start duration (seconds). */
	startDurationSec: number;
	/** End duration (seconds). */
	endDurationSec: number;
	/** Pause protection: hold time in seconds before a pause counts as the end (0 = off). */
	pauseHoldSec: number;
	/** Pause protection: a phase below endVal beginning within this many seconds of the start is a pause (0 = unused). */
	pauseUntilSec: number;
	/** Pause protection: a phase below endVal staying below this power is a pause (0 = unused). */
	pauseBelowVal: number;
	/** Anti-crease filter: longest drum burst in s (missing or 0 = off; all trailer fields are set only when on). */
	trailerBurstSec?: number;
	/** Anti-crease filter: minimum quiet time before a burst in s (0 = automatic). */
	trailerGapSec?: number;
	/** Anti-crease filter: bursts are held only this many seconds after the start (0 = unused). */
	trailerAfterSec?: number;
	/** Anti-crease filter: bursts are held only after a block of at least this mean power (0 = unused). */
	trailerBlockVal?: number;
	/** Anti-crease filter: length of the anti-crease phase after the end in s. */
	trailerMaxSec?: number;
}

const DETECTION_MODES: readonly DetectionMode[] = ["count", "timed", "combined"];

function builtinType(
	id: string,
	name: string,
	startVal: number,
	endVal: number,
	standby: number,
	startCount: number,
	endCount: number,
): DeviceTypeConfig {
	return {
		id,
		name,
		builtin: true,
		startVal,
		endVal,
		startCount,
		endCount,
		standby,
		mode: "count",
		startDurationSec: 60,
		endDurationSec: 300,
		pauseHoldSec: 0,
		pauseUntilSec: 0,
		pauseBelowVal: 0,
	};
}

function customType(index: number): DeviceTypeConfig {
	return {
		id: `custom${index}`,
		name: `Custom ${index}`,
		builtin: false,
		startVal: 30,
		endVal: 5,
		standby: 1,
		startCount: 1,
		endCount: 20,
		mode: "count",
		startDurationSec: 60,
		endDurationSec: 300,
		pauseHoldSec: 0,
		pauseUntilSec: 0,
		pauseBelowVal: 0,
	};
}

/** The 13 default types of earlier versions (3.1.2 values). */
export const DEFAULT_TYPES: DeviceTypeConfig[] = [
	builtinType("washing-machine", "Washing machine", 30, 15, 1, 2, 50),
	builtinType("dryer", "Dryer", 120, 15, 1, 2, 20),
	builtinType("dishwasher", "Dishwasher", 15, 0.25, 0.5, 2, 120),
	...Array.from({ length: 10 }, (_, i) => customType(i + 1)),
];

function isRecord(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

function str(val: unknown): string {
	if (typeof val === "string") {
		return val;
	}
	if (typeof val === "number" && Number.isFinite(val)) {
		return String(val);
	}
	return "";
}

function num(val: unknown, fallback: number): number {
	return parseNumber(val) ?? fallback;
}

/**
 * Normalized device type of one row of `native.types`; null (with a warning) if the row is no object.
 *
 * @param raw - Raw row
 * @param index - Position of the row (for the warning)
 * @param id - Id of the type
 * @param warnings - Receives the warnings
 */
export function normalizeType(raw: unknown, index: number, id: string, warnings: string[]): DeviceTypeConfig | null {
	if (!isRecord(raw)) {
		warnings.push(`Device type #${index + 1} ignored: not an object`);
		return null;
	}
	const builtin = DEFAULT_TYPES.find(t => t.id === id);
	const base = builtin ?? customType(0);
	const mode = DETECTION_MODES.find(m => m === raw.mode) ?? "count";
	return {
		id,
		name: str(raw.name).trim() || base.name,
		builtin: builtin?.builtin ?? false,
		startVal: Math.max(0, num(raw.startVal, base.startVal)),
		endVal: Math.max(0, num(raw.endVal, base.endVal)),
		standby: Math.max(0, num(raw.standby, base.standby)),
		startCount: Math.max(0, num(raw.startCount, base.startCount)),
		endCount: Math.max(0, num(raw.endCount, base.endCount)),
		mode,
		startDurationSec: Math.max(0, num(raw.startDurationSec, 60)),
		endDurationSec: Math.max(0, num(raw.endDurationSec, 300)),
		pauseHoldSec: Math.max(0, num(raw.pauseHoldSec, 0)),
		pauseUntilSec: Math.max(0, num(raw.pauseUntilSec, 0)),
		pauseBelowVal: Math.max(0, num(raw.pauseBelowVal, 0)),
		...normalizeTrailer(raw),
	};
}

/**
 * Device types of an instance native exactly as earlier versions resolved them: missing built-in types are
 * added, an empty or missing table gives all 13 default types, rows without an id get the same id as before
 * (derived from the name like `allocateDeviceId`, nothing is written), duplicate ids are dropped.
 *
 * @param native - Instance native
 * @param warnings - Receives the warnings (optional)
 */
export function resolveLegacyTypes(native: Record<string, unknown>, warnings: string[] = []): DeviceTypeConfig[] {
	const src = isRecord(native) ? native : {};
	let types: DeviceTypeConfig[] = [];
	if (Array.isArray(src.types)) {
		const seen = new Set<string>();
		const taken = new Set<string>([
			...DEFAULT_TYPES.map(t => t.id),
			...src.types.map(raw => (isRecord(raw) ? str(raw.id).trim() : "")).filter(id => id !== ""),
		]);
		src.types.forEach((raw, i) => {
			let id = isRecord(raw) ? str(raw.id).trim() : "";
			if (isRecord(raw) && id === "") {
				// a type added in the admin table had no id yet: the same stable id as before, derived from its name
				id = allocateDeviceId(str(raw.name).trim() || "custom", taken);
				taken.add(id);
			}
			const t = normalizeType(raw, i, id, warnings);
			if (!t) {
				return;
			}
			if (seen.has(t.id)) {
				warnings.push(`Device type "${t.id}" ignored: duplicate id`);
				return;
			}
			seen.add(t.id);
			types.push(t);
		});
	}
	if (types.length === 0) {
		types = DEFAULT_TYPES.map(t => ({ ...t }));
	} else {
		const missing = DEFAULT_TYPES.filter(d => d.builtin && !types.some(t => t.id === d.id));
		types = [...missing.map(t => ({ ...t })), ...types];
	}
	return types;
}

/**
 * Find a device type by id.
 *
 * @param types - Device types
 * @param id - Type id
 */
export function findType(types: readonly DeviceTypeConfig[], id: string): DeviceTypeConfig | undefined {
	return types.find(t => t.id === id);
}
