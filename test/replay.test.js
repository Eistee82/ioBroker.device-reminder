import assert from "node:assert";
import { endOk, runOk, simulate } from "../build/lib/learn/replay.js";
import { DENSE_MIN_MS } from "../build/lib/learn/runs.js";
import { WASHER } from "./helpers/devices.js";
import { layoutOf, layoutRun, loadSeries } from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const D = loadSeries("dryer");
const res = (s, i) => ({ started: 1, aborted: 0, finished: [s.t0 + i * s.stepMs], startedAt: [] });
const winOf = (L, k) => L.windows.find(w => w.run === k);

describe("end criterion endOk (Spec B.4)", () => {
	it("w02: an end 10 s before the core end is fine (S3: early end −0.2 min judged ok)", () => {
		const { info, s, L, idx } = layoutRun("washer30d", "w02");
		assert.strictEqual(endOk(s, winOf(L, idx), res(s, info.coreEnd - 1), info.progEnd), true);
	});
	it("every washer run: an end 10 min before progEnd is too early", () => {
		const { L, s } = layoutOf(W);
		L.runs.forEach((r, k) =>
			assert.strictEqual(endOk(s, winOf(L, k), res(s, r.progEnd - 60), r.progEnd), false, `run ${k}`),
		);
	});
	it("an end after progEnd and at most 5 min before runEnd is fine; earlier than 5 min is not", () => {
		const { L, s } = layoutOf(W);
		const step = s.stepMs;
		L.runs.forEach((r, k) => {
			if (r.runEnd - r.progEnd < 2) {
				return;
			}
			const f = Math.max(r.progEnd + 1, r.runEnd - DENSE_MIN_MS / step);
			assert.strictEqual(endOk(s, winOf(L, k), res(s, f), r.progEnd), true, `run ${k}`);
			if (r.runEnd - DENSE_MIN_MS / step - 1 > r.progEnd) {
				assert.strictEqual(endOk(s, winOf(L, k), res(s, r.runEnd - DENSE_MIN_MS / step - 1), r.progEnd), false);
			}
		});
	});
	it("without progEnd endOk equals runOk", () => {
		const { L, s } = layoutOf(W);
		L.runs.forEach((r, k) => {
			for (const i of [r.coreEnd - 30, r.runEnd, r.runEnd + 30]) {
				assert.strictEqual(endOk(s, winOf(L, k), res(s, i), null), runOk(s, winOf(L, k), res(s, i)));
			}
		});
	});
	it("dryer: endOk equals today's runOk with the 3.1.2 dryer values in every window (P6)", () => {
		const { L, s } = layoutOf(D);
		const dryer = { ...WASHER, startVal: 120, endCount: 20 };
		L.windows
			.filter(w => w.run !== null)
			.forEach(w => {
				const r = simulate(s, w, dryer, { abort: false, abortFixed: false, pollSec: 10 });
				assert.strictEqual(endOk(s, w, r, L.runs[w.run].progEnd), runOk(s, w, r));
			});
	});
});
