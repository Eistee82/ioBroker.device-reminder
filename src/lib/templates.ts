import type { DetectionSettings } from "./detector/types.js";
import { resolveLegacyTypes } from "./legacyTypes.js";
import { detectionOf, typeHash } from "./runStore.js";

/** Id of a built-in template. */
export type TemplateId = "washing-machine" | "dryer" | "dishwasher" | "custom";

/** Built-in template: start and end values for a new device (in W). */
export interface Template {
	/** Id. */
	id: TemplateId;
	/** Name (English). */
	name: string;
	/** Detection values in W (no final phase, no phases). */
	detection: DetectionSettings;
}

/** Template from the archive (`native.types` of an earlier version, values in W). */
export interface ArchiveTemplate {
	/** Id of the old type. */
	id: string;
	/** Name of the old type. */
	name: string;
	/** Detection values in W. */
	detection: DetectionSettings;
}

/** Fields holding a power (scaled with the unit of the power state). */
const POWER_KEYS = ["startVal", "endVal", "standby", "pauseBelowVal", "trailerBlockVal"] as const;

function template(
	id: TemplateId,
	name: string,
	startVal: number,
	endVal: number,
	standby: number,
	startCount: number,
	endCount: number,
): Template {
	return {
		id,
		name,
		detection: detectionOf({
			startVal,
			endVal,
			standby,
			startCount,
			endCount,
			mode: "count",
			startDurationSec: 60,
			endDurationSec: 300,
		}),
	};
}

/** Template "Custom" for every device without a template of its own (also used when values are missing). */
export const CUSTOM_TEMPLATE: Template = template("custom", "Custom", 30, 5, 1, 1, 20);

/** Built-in templates with the 3.1.2 values; "Custom" stands for every other device. */
export const TEMPLATES: readonly Template[] = [
	template("washing-machine", "Washing machine", 30, 15, 1, 2, 50),
	template("dryer", "Dryer", 120, 15, 1, 2, 20),
	template("dishwasher", "Dishwasher", 15, 0.25, 0.5, 2, 120),
	CUSTOM_TEMPLATE,
];

/**
 * Built-in template by id.
 *
 * @param id - Template id
 */
export function findTemplate(id: string | undefined): Template | undefined {
	return TEMPLATES.find(t => t.id === id);
}

/**
 * Detection values with the powers converted from one unit to another (the other fields are copied).
 *
 * @param d - Detection values
 * @param from - Factor from the unit of the values to W (kW: 1000)
 * @param to - Factor from the target unit to W (kW: 1000)
 */
export function scalePowers(d: DetectionSettings, from: number, to: number): DetectionSettings {
	const out = detectionOf(d);
	if (from === to) {
		return out;
	}
	for (const key of POWER_KEYS) {
		out[key] = ((out[key] ?? 0) * from) / to;
	}
	return out;
}

/**
 * Detection values of a built-in template in the unit of the power state, or null for an unknown id.
 *
 * @param id - Template id
 * @param unitFactor - Factor from the unit of the state to W (kW: 1000)
 */
export function templateDetection(id: string, unitFactor: number): DetectionSettings | null {
	const t = findTemplate(id);
	if (!t) {
		return null;
	}
	return scalePowers(t.detection, 1, unitFactor > 0 ? unitFactor : 1);
}

/**
 * Hash of the values and name a stored type has when it was never changed, or null for a type of the user.
 *
 * @param id - Type id
 */
function unchanged(id: string): { hash: string; names: string[] } | null {
	const builtin = TEMPLATES.find(t => t.id === id && t.id !== "custom");
	if (builtin) {
		return { hash: typeHash(builtin.detection), names: [builtin.name] };
	}
	const slot = /^custom(\d+)$/.exec(id);
	if (slot) {
		return { hash: typeHash(CUSTOM_TEMPLATE.detection), names: [`Custom ${slot[1]}`, `custom${slot[1]}`] };
	}
	return null;
}

/**
 * Archive templates: the device types of `native.types` whose values or name differ from the template of the
 * same id (or from "Custom N"/`customN` with 30/5/1/1/20), in the order of `native.types`.
 *
 * @param native - Instance native
 */
export function archiveTemplates(native: Record<string, unknown>): ArchiveTemplate[] {
	if (!Array.isArray(native?.types) || native.types.length === 0) {
		return [];
	}
	const out: ArchiveTemplate[] = [];
	for (const t of resolveLegacyTypes(native)) {
		const detection = detectionOf(t);
		const ref = unchanged(t.id);
		if (ref && ref.hash === typeHash(detection) && ref.names.includes(t.name)) {
			continue;
		}
		out.push({ id: t.id, name: t.name, detection });
	}
	return out;
}
