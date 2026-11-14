import assert from "node:assert";
import { finalFloors } from "../build/lib/detector/finalPhase.js";
import { createDetector } from "../build/lib/detector/index.js";
import { analyzeHistory } from "../build/lib/historyLearning.js";
import { simulate } from "../build/lib/learn/replay.js";
import { finalRun, ends, LOCK_FINAL, SHORT_FINAL, starts, syntheticRun, WM_312, WM_FINAL } from "./helpers/final.js";
import { detectorRun, layoutOf, loadSeries, restartScenarios, ticksOf, withGap } from "./helpers/fixtures.js";
import { differences, goldenHashes, randomCurve } from "./helpers/golden.js";
import { runOf } from "./helpers/programmes.js";

const W = loadSeries("washer30d");
const VALS = ticksOf(W);
const { L } = layoutOf(W);
const NORMAL = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11]; // Layout-Läufe w01, w03, w05–w12 (ohne w02, w04)
const firstEndAfter = (r, from) => ends(r).find(e => e.i >= from).i;
const minutes = ticks => ticks / 6;

describe("final phase filter (Spec A.3)", function () {
	this.timeout(300_000);

	it("I1–I5 on 200 random curves × modes × abort options, with and without the anti-crease filter", () => {
		// SHORT_FINAL fires on 400-tick curves (WM_FINAL with X 60 min never does: 0 of 1648, review/gold.mjs);
		// there the rest proof (b) or the final band (g) nearly always ends the lock phase first, LOCK_FINAL
		// (no rest proof, activity above 0.6 W) reaches the exits a and c–g
		const FILTER = {
			trailerBurstSec: 45,
			trailerGapSec: 30,
			trailerAfterSec: 0,
			trailerBlockVal: 0,
			trailerMaxSec: 7200,
		};
		const seen = {};
		for (let seed = 1; seed <= 200; seed++) {
			const curve = randomCurve(seed);
			for (const mode of ["count", "combined", "timed"]) {
				for (const abort of [false, true]) {
					for (const trailer of [false, true]) {
						const s = { ...WM_312, mode, ...(trailer ? FILTER : {}) };
						const o = { abort, abortFixed: abort, switchOff: i => abort && i % 50 > 40 };
						// I1: never firing (P above every value) → identical to the inner detector
						const never = detectorRun(
							curve,
							{
								...s,
								...SHORT_FINAL,
								finalMinVal: 1e9,
								finalMaxVal: 0,
								finalHotVal: 0,
								finalActVal: 0,
								finalActShare: 0,
							},
							o,
						);
						const plain = detectorRun(curve, s, o);
						assert.deepStrictEqual(
							never.ev.map(x => [x.e, x.i]),
							plain.ev.map(x => [x.e, x.i]),
							`I1 ${seed}/${mode}`,
						);
						for (const F of [SHORT_FINAL, LOCK_FINAL]) {
							const r = detectorRun(curve, { ...s, ...F }, o);
							const st = (seen[mode] ??= { early: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 });
							for (const k of Object.keys(st)) {
								st[k] += r.det.stats[k];
							}
							let early = false;
							let perRun = 0;
							r.ev.forEach(x => {
								if (x.e === "started") {
									assert.ok(!early || x.exit !== null, `I4 ${seed}`);
									early = false;
									perRun = 0;
								} else if (x.e === "finished" && r.ticks[x.i].settling) {
									perRun++;
									assert.ok(perRun <= 1, `I2 ${seed}`);
									early = true;
								} else if (early) {
									// I3: no finished, running or aborted until the next started (running stops auto-off, onRunning)
									assert.fail(`I3 ${seed}/${mode}: ${x.e} after an early end`);
								}
							});
							r.ticks.forEach((t, i) => {
								if (t.settling) {
									assert.ok(
										t.status === null || t.status === "off" || t.status === "standby",
										`I5 ${seed}@${i}`,
									);
								}
							});
							const times = r.ev.map(x => x.at);
							assert.ok(
								times.every((t, k) => k === 0 || t >= times[k - 1]),
								`I5 times ${seed}`,
							);
						}
					}
				}
			}
		}
		// the property test is not empty: early ends in every mode, every exit a–g at least once
		for (const mode of ["count", "combined", "timed"]) {
			assert.ok(seen[mode].early > 0, `${mode}: ${JSON.stringify(seen[mode])}`);
		}
		for (const x of ["a", "b", "c", "d", "e", "f", "g"]) {
			assert.ok(
				Object.values(seen).some(st => st[x] > 0),
				`exit ${x}: ${JSON.stringify(seen)}`,
			);
		}
	});
	it("golden: notices an active final phase (the fixture is sensitive), also per field", () => {
		assert.ok(differences({ ...SHORT_FINAL }).length > 0);
		// Spec 8.2: each field changes the output when the final phase is on (hashes per combination; the
		// fields of the lock phase on LOCK_FINAL, where the rest proof does not end every lock phase first)
		const base = {
			short: goldenHashes(createDetector, SHORT_FINAL),
			lock: goldenHashes(createDetector, LOCK_FINAL),
		};
		const fields = [
			["short", "finalMinVal", 300],
			["short", "finalMaxVal", 600],
			["short", "finalAfterSec", 1200],
			["short", "finalMinSec", 90],
			["short", "finalQuietSec", 120],
			["short", "finalDipSec", 120],
			["short", "finalRestVal", 2],
			["short", "finalRestSec", 120],
			["lock", "finalHotVal", 0],
			["lock", "finalActVal", 30],
			["lock", "finalActShare", 0.9],
			["lock", "finalCheckSec", 600],
			["lock", "finalLockSec", 1800],
		];
		assert.strictEqual(new Set(fields.map(f => f[1])).size, 13, "every final field");
		for (const [b, k, v] of fields) {
			const h = goldenHashes(createDetector, { ...(b === "short" ? SHORT_FINAL : LOCK_FINAL), [k]: v });
			assert.ok(
				Object.keys(h).some(x => h[x] !== base[b][x]),
				k,
			);
		}
	});
	it("only the first start after a lock carries the mark; later starts without a lock carry none", () => {
		const { values, coreEnd } = syntheticRun();
		// plain cotton60 without the 3 W rest before the final spin: no early end (review/synth.mjs)
		const plain = runOf({ device: "washer", programme: "cotton60", seed: 1 }).values;
		const rest = new Array(400).fill(0.5);
		const r = finalRun([
			...values.slice(0, coreEnd + 13),
			...new Array(80).fill(6),
			...rest,
			...plain,
			...rest,
			...plain,
		]);
		assert.deepStrictEqual(
			starts(r).map(s => s.exit),
			[null, "a", null],
		);
		assert.strictEqual(r.det.finalExit, null);
	});
	it("whole washer recording: 14 starts and 14 ends like without wrapper; 12 early ends: 11 via a, 1 via b [f_lock, y_actexit]", () => {
		const a = detectorRun(VALS, WM_312);
		const b = finalRun(VALS);
		assert.deepStrictEqual(
			starts(b).map(x => x.i),
			starts(a).map(x => x.i),
		);
		assert.deepStrictEqual([starts(b).length, ends(a).length, ends(b).length], [14, 14, 14]);
		assert.deepStrictEqual(b.det.stats, { early: 12, a: 11, b: 1, c: 0, d: 0, e: 0, f: 0, g: 0 });
	});
	it("finished 1.5–2.2 min after the core end in w01, w03, w05–w12 (before: 11.3–30.7 min); w02 at −0.2 min; w04 unchanged [f_lock]", () => {
		const a = detectorRun(VALS, WM_312);
		const b = finalRun(VALS);
		for (const k of NORMAL) {
			const r = L.runs[k];
			const with_ = minutes(firstEndAfter(b, r.from) - r.coreEnd);
			const without = minutes(firstEndAfter(a, r.from) - r.coreEnd);
			assert.ok(with_ >= 1.5 - 1 / 6 && with_ <= 2.2 + 1 / 6, `run ${k}: ${with_}`);
			assert.ok(without >= 11.3 - 1 / 6, `run ${k}: ${without}`);
		}
		const w02 = L.runs[1];
		assert.ok(Math.abs(minutes(firstEndAfter(b, w02.from) - w02.coreEnd) + 0.2) <= 1 / 6);
		const w04 = L.runs[3];
		assert.strictEqual(firstEndAfter(b, w04.from), firstEndAfter(a, w04.from));
	});
	it("72 unload-and-restart scenarios: 2 starts, 2 ends, no exit g, second start ≤ 5 min after switching on [y_actexit: 72/72, 0.8–3.7 min]", () => {
		for (const sc of restartScenarios()) {
			const r = finalRun(sc.values, { finalRestVal: sc.restVal });
			assert.deepStrictEqual([starts(r).length, ends(r).length, r.det.stats.g], [2, 2, 0], sc.key);
			assert.ok(minutes(starts(r)[1].i - sc.bOn) <= 5, `${sc.key}: ${minutes(starts(r)[1].i - sc.bOn)}`);
		}
	});
	it("too small Y (30 s / 60 s): early end before the core end, then a new run via an activity exit ending at the end without wrapper [f_viol 11/11]", () => {
		const a = detectorRun(VALS, WM_312);
		for (const Y of [30, 60]) {
			const r = finalRun(VALS, { finalMinSec: Y });
			for (const k of [0, 1, ...NORMAL.slice(1)]) {
				const run = L.runs[k];
				// w12 is the last layout run: the incomplete run at the end of the data is not part of it
				const next = L.runs[k + 1]?.from ?? starts(a).find(s => s.i > run.to)?.i ?? VALS.length;
				const fin = ends(r).filter(e => e.i >= run.from && e.i < next);
				assert.ok(fin[0].i < run.coreEnd, `Y${Y} run ${k}: first end ${fin[0].i} core ${run.coreEnd}`);
				const st = starts(r).find(s => s.i > fin[0].i && s.i < next);
				assert.ok(st && ["c", "d", "f", "g"].includes(st.exit), `Y${Y} run ${k}: ${st?.exit}`);
				assert.ok(Math.abs(fin.at(-1).i - firstEndAfter(a, run.from)) <= 1, `Y${Y} run ${k}`);
			}
		}
	});
	it("the same four checks with an active TrailerFilter and the learned washer values (P13, acceptance)", async () => {
		const sg = await analyzeHistory(W, 10, {});
		assert.ok(sg.trailerBurstSec > 0, "the washer anti-crease filter is learned");
		// the learned values: thresholds and durations with the anti-crease filter learned for them (the
		// filter with the 3.1.2 thresholds splits w01 even without a final phase)
		const T = {
			...sg.thresholds,
			mode: sg.mode,
			startDurationSec: sg.startDurationSec,
			endDurationSec: sg.endDurationSec,
			trailerBurstSec: sg.trailerBurstSec,
			trailerGapSec: sg.trailerGapSec,
			trailerAfterSec: sg.trailerAfterSec,
			trailerBlockVal: sg.trailerBlockVal,
			trailerMaxSec: sg.trailerMaxSec,
		};
		const a = detectorRun(VALS, { ...WM_312, ...T });
		const b = finalRun(VALS, T);
		assert.deepStrictEqual(
			starts(b).map(x => x.i),
			starts(a).map(x => x.i),
		);
		assert.strictEqual(b.det.stats.f, 0);
		for (const k of NORMAL) {
			assert.ok(minutes(firstEndAfter(b, L.runs[k].from) - L.runs[k].coreEnd) <= 2.2 + 1 / 6, `run ${k}`);
		}
		for (const sc of restartScenarios()) {
			const r = finalRun(sc.values, { ...T, finalRestVal: sc.restVal });
			assert.deepStrictEqual([starts(r).length, ends(r).length], [2, 2], sc.key);
		}
		const small = finalRun(VALS, { ...T, finalMinSec: 30 });
		for (const k of NORMAL) {
			const run = L.runs[k];
			const next = L.runs[k + 1]?.from ?? VALS.length;
			const st = starts(small).filter(s => s.i > run.from && s.i < next);
			assert.ok(
				st.some(s => s.exit !== null),
				`run ${k}: rest of the programme carries afterFinal`,
			);
		}
	});
	it("145 s without a new value in the final spin still qualifies [S8]", () => {
		const r = L.runs[8];
		const gapAt = layoutOf(W).s.t0 + (r.endBlockFrom + 3) * 10_000;
		const r2 = finalRun(ticksOf(withGap(W, gapAt, 145 / 60)));
		assert.ok(minutes(firstEndAfter(r2, r.from) - r.coreEnd) <= 2.2 + 1 / 6);
	});
	it("Z runs out without new values (timed mode, feed only on change)", () => {
		const { values, coreEnd } = syntheticRun();
		for (const mode of ["count", "timed"]) {
			const r = finalRun(values, { mode }, { timedFeed: true });
			assert.strictEqual(r.det.stats.early, 1, mode);
			const f = ends(r)[0].i;
			assert.ok(f - coreEnd >= 12 && f - coreEnd <= 13, `${mode}: ${f - coreEnd}`);
		}
	});
	it("timed mode: live and simulate give the same events with a final phase (G10; times only from tick)", () => {
		const { L, s } = layoutOf(W);
		const set = { ...WM_312, ...WM_FINAL, mode: "timed" };
		for (const w of L.windows.filter(x => x.run !== null)) {
			const sim = simulate(s, w, set, { abort: false, abortFixed: false, pollSec: 10 });
			// live: every real report goes to feed at its own time, tick once per poll with the held value
			const det = createDetector(set, { abort: false, abortFixed: false, pollSec: 10 });
			const fin = [];
			let k = W.findIndex(p => p.ts > s.t0 + (w.fromIdx - 1) * s.stepMs);
			let held = 0;
			const collect = (r, t) => r.events.forEach((e, j) => e === "finished" && fin.push(r.times?.[j] ?? t));
			for (let i = w.fromIdx; i <= w.toIdx; i++) {
				const t = s.t0 + i * s.stepMs;
				while (k < W.length && W[k].ts <= t) {
					held = W[k].val;
					collect(det.feed(held, W[k].ts), W[k++].ts);
				}
				collect(det.tick(held, t, { switchOff: false }), t);
			}
			assert.strictEqual(fin.length, sim.finished.length, `window ${w.run}`);
			fin.forEach((t, j) =>
				assert.ok(Math.abs(t - sim.finished[j]) <= s.stepMs, `window ${w.run}: ${t} vs ${sim.finished[j]}`),
			);
		}
	});
	it("anti-crease state is on while the lock passes calls through", () => {
		const { values, coreEnd } = syntheticRun();
		const T = {
			trailerBurstSec: 45,
			trailerGapSec: 30,
			trailerAfterSec: 0,
			trailerBlockVal: 0,
			trailerMaxSec: 7200,
		};
		const r = finalRun([...values.slice(0, coreEnd + 13), ...new Array(30).fill(6)], T);
		assert.strictEqual(r.det.stats.early, 1);
		assert.strictEqual(r.det.settling, true);
		assert.strictEqual(r.det.inTrailer, true, "inTrailer = trailerUntil set, also without a suppressed burst");
		assert.strictEqual(r.det.lockAt, ends(r)[0].at, "the lock began with the early end");
	});
	describe("each exit alone after the early end of the synthetic run", () => {
		const { values, coreEnd } = syntheticRun();
		const pre = values.slice(0, coreEnd + 13);
		const exitOf = (after, extra = {}) => {
			const r = finalRun([...pre, ...after], extra);
			assert.strictEqual(r.det.stats.early, 1);
			return r;
		};
		const fill = (v, n) => new Array(n).fill(v);
		it("a: inner end (tail at 6 W, above rest, below activity)", () =>
			assert.strictEqual(exitOf(fill(6, 80)).det.stats.a, 1));
		it("b: rest proof (0.8 W for 60 s)", () => assert.strictEqual(exitOf(fill(0.8, 10)).det.stats.b, 1));
		it("c: high load ≥ finalHotVal for G; off with finalHotVal 0", () => {
			assert.strictEqual(exitOf([...fill(2000, 7), ...fill(0.8, 20)]).det.stats.c, 1);
			assert.strictEqual(exitOf([...fill(2000, 7), ...fill(0.8, 20)], { finalHotVal: 0 }).det.stats.c, 0);
		});
		it("d: final band after the check window (activity exit off)", () => {
			const r = exitOf([...fill(20, 245), ...fill(300, 3)], { finalActVal: 0, finalActShare: 0 });
			assert.strictEqual(r.det.stats.d, 1);
		});
		it("e: maximum duration", () => {
			const r = exitOf(fill(20, 280), { finalActVal: 0, finalActShare: 0 });
			assert.strictEqual(r.det.stats.e, 1);
			assert.strictEqual(r.det.settling, false);
		});
		it("f: activity share ≥ 0.7 over 5 min", () => assert.strictEqual(exitOf(fill(20, 40)).det.stats.f, 1));
		it("g: final band ≥ Y/2 inside the check window; the new start is back-dated, never before the early end", () => {
			const r = exitOf([...fill(0.8, 3), ...fill(20, 2), ...fill(300, 12), ...fill(0.8, 60)]);
			assert.strictEqual(r.det.stats.g, 1);
			const early = ends(r)[0];
			const st = starts(r).at(-1);
			assert.strictEqual(st.exit, "g");
			assert.ok(st.at >= early.at, "not before the early end");
			assert.strictEqual(
				st.at,
				(coreEnd + 13 + 3) * 10_000,
				"first activity above the rest level after the last rest",
			);
		});
		it("g with the anti-crease filter outside: the back-dated start and its mark come through", () => {
			const T = {
				trailerBurstSec: 45,
				trailerGapSec: 30,
				trailerAfterSec: 0,
				trailerBlockVal: 0,
				trailerMaxSec: 7200,
			};
			const r = exitOf([...fill(0.8, 3), ...fill(20, 2), ...fill(300, 12), ...fill(0.8, 60)], T);
			assert.strictEqual(r.det.stats.g, 1);
			const st = starts(r).at(-1);
			assert.strictEqual(st.exit, "g");
			assert.strictEqual(st.at, (coreEnd + 13 + 3) * 10_000);
		});
		it("a time jump back in the lock starts the lock counters again", () => {
			const det = createDetector({ ...WM_312, ...WM_FINAL }, { abort: false, abortFixed: false, pollSec: 10 });
			pre.forEach((v, i) => det.tick(v, i * 10_000));
			assert.strictEqual(det.tick(0.8, pre.length * 10_000).events.at(-1), "finished");
			const t = pre.length * 10_000;
			// 50 s of rest, then the clock goes back 1 h: the rest proof needs 60 s from there on
			for (let k = 1; k <= 5; k++) {
				det.tick(0.8, t + k * 10_000);
			}
			assert.strictEqual(det.settling, true);
			for (let k = 0; k < 6; k++) {
				det.tick(0.8, t - 3_600_000 + k * 10_000);
			}
			assert.strictEqual(det.settling, true, "50 s before plus 50 s after the jump is no rest proof");
			det.tick(0.8, t - 3_600_000 + 60_000);
			assert.strictEqual(det.settling, false);
			assert.strictEqual(det.stats.b, 1);
			assert.strictEqual(det.lockAt, null);
			// count mode: there is no feed of the inner detector, nothing is passed on
			assert.deepStrictEqual(det.feed(500, t).events, []);
		});
	});
	it("abort before the early end is passed on; in the lock it is swallowed", () => {
		const { values, coreEnd } = syntheticRun();
		// switched off 100 ticks before the end of the programme: power 0 W with the switch off
		const cut = [...values.slice(0, coreEnd - 100), ...new Array(40).fill(0)];
		const opt = { abort: true, abortFixed: true, switchOff: i => i >= coreEnd - 100 };
		const before = finalRun(cut, {}, opt);
		assert.deepStrictEqual(
			before.ev.filter(x => x.e !== "running").map(x => [x.e, x.i]),
			detectorRun(cut, WM_312, opt)
				.ev.filter(x => x.e !== "running")
				.map(x => [x.e, x.i]),
		);
		assert.ok(before.ev.some(x => x.e === "aborted"));
		assert.strictEqual(before.det.stats.early, 0);
		// in the lock (rest proof off): the inner abort is exit a and is swallowed
		const after = finalRun(
			[...values.slice(0, coreEnd + 13), ...new Array(40).fill(0)],
			{ finalRestSec: 14_400 },
			{ abort: true, abortFixed: true, switchOff: i => i > coreEnd + 14 },
		);
		assert.strictEqual(after.det.stats.early, 1, "the lock was reached");
		assert.strictEqual(after.det.stats.a, 1, "the inner abort ends the lock");
		assert.ok(!after.ev.some(x => x.e === "aborted"));
	});
	it("resumeLockAt starts in the lock and keeps check window and maximum", () => {
		const r = detectorRun(
			new Array(300).fill(20),
			{ ...WM_312, ...WM_FINAL, finalActVal: 0, finalActShare: 0 },
			{ resumeLockAt: -600_000 },
		);
		assert.strictEqual(r.ticks[0].settling, true);
		assert.strictEqual(
			r.ticks.findIndex(t => !t.settling),
			210,
			"2700 s − 600 s = 2100 s",
		);
	});
	it("per-poll floors only make values safer", () => {
		const f = finalFloors(
			{
				...WM_FINAL,
				finalQuietSec: 0,
				finalDipSec: 0,
				finalRestVal: 0,
				finalRestSec: 0,
				finalCheckSec: 0,
				finalLockSec: 0,
			},
			100,
			1,
		);
		assert.deepStrictEqual(
			[
				f.finalMinSec,
				f.finalDipSec,
				f.finalQuietSec,
				f.finalRestVal,
				f.finalRestSec,
				f.finalCheckSec,
				f.finalLockSec,
			],
			[200, 200, 200, 1, 300, 1800, 14_400],
		);
		assert.deepStrictEqual(finalFloors(WM_FINAL, 10, 1), WM_FINAL);
	});
});
