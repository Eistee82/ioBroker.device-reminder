// Detector behaviour of 3.1.2 (commit cd5e67f) over many curves, used to prove that new optional
// detector parameters with their default values change nothing.
import { createHash } from "node:crypto";
import { curves } from "./curves.js";

/**
 * Small deterministic pseudo random generator (LCG).
 *
 * @param {number} seed start value
 * @returns {() => number} generator returning values in [0, 1)
 */
function lcg(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * Random curve of 400 ticks: blocks of 0 W pauses, standby, low and high power.
 *
 * @param {number} seed seed of the generator
 * @returns {number[]} power values
 */
export function randomCurve(seed) {
	const rnd = lcg(seed);
	const out = [];
	while (out.length < 400) {
		const kind = rnd();
		const len = 1 + Math.floor(rnd() * 40);
		for (let i = 0; i < len && out.length < 400; i++) {
			if (kind < 0.25) {
				out.push(0);
			} else if (kind < 0.4) {
				out.push(Math.round(rnd() * 30) / 10);
			} else if (kind < 0.7) {
				out.push(Math.round(rnd() * 4000) / 10);
			} else {
				out.push(Math.round(rnd() * 25000) / 10);
			}
		}
	}
	return out;
}

/** Thresholds of the default types (3.1.2) and of a custom type. */
export const GOLDEN_TYPES = {
	washingMachine: { startVal: 30, endVal: 15, standby: 1, startCount: 2, endCount: 50 },
	dryer: { startVal: 120, endVal: 15, standby: 1, startCount: 2, endCount: 20 },
	dishwasher: { startVal: 15, endVal: 0.25, standby: 0.5, startCount: 2, endCount: 120 },
	custom: { startVal: 30, endVal: 5, standby: 1, startCount: 1, endCount: 20 },
};

/** Device options: abort off, abort on, corrected abort with the switch off now and then. */
export const GOLDEN_OPTIONS = {
	plain: { abort: false, abortFixed: false },
	abort: { abort: true, abortFixed: false },
	abortFixed: { abort: true, abortFixed: true },
};

/** All curves of the golden fixture by name. */
export function goldenCurves() {
	const out = { ...curves };
	for (let seed = 1; seed <= 200; seed++) {
		out[`random${seed}`] = randomCurve(seed);
	}
	return out;
}

/**
 * Hash of the outputs of one detector over one curve: per tick `[events, status, average, started]`
 * (timed: feed and tick).
 *
 * @param {(s: object, o: object) => object} createDetector factory of the build under test
 * @param {number[]} curve power values (10 s ticks)
 * @param {object} settings detection settings
 * @param {object} options device options
 * @returns {string} sha256 of the output sequence
 */
export function runHash(createDetector, curve, settings, options) {
	const detector = createDetector(settings, options);
	const out = [];
	const record = r => out.push([r.events, r.status, r.average, r.started]);
	curve.forEach((power, i) => {
		const now = i * 10_000;
		if (settings.mode === "timed") {
			record(detector.feed(power, now));
		}
		record(detector.tick(power, now, { switchOff: options.abortFixed && i % 50 > 40 }));
	});
	return createHash("sha256").update(JSON.stringify(out)).digest("hex").slice(0, 16);
}

/**
 * Hashes of every combination of curve, mode, device options and type.
 *
 * @param {(s: object, o: object) => object} createDetector factory of the build under test
 * @param {object} [extra] additional settings merged into every type (new optional parameters)
 * @returns {Record<string, string>} hash per combination
 */
export function goldenHashes(createDetector, extra = {}) {
	const result = {};
	for (const [curveName, curve] of Object.entries(goldenCurves())) {
		for (const mode of ["count", "combined", "timed"]) {
			for (const [optName, options] of Object.entries(GOLDEN_OPTIONS)) {
				for (const [typeName, thresholds] of Object.entries(GOLDEN_TYPES)) {
					const settings = { ...thresholds, mode, startDurationSec: 60, endDurationSec: 300, ...extra };
					result[`${curveName}/${mode}/${optName}/${typeName}`] = runHash(
						createDetector,
						curve,
						settings,
						options,
					);
				}
			}
		}
	}
	return result;
}
