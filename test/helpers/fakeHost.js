// In-memory DeviceHost for runtime, notifier and registry tests.

/**
 * Create a fake host with a manual clock and manual timers.
 *
 * @param {object} [opts] options
 * @param {number} [opts.now] start time in ms since epoch
 * @param {Record<string, unknown>} [opts.values] foreign state values by id
 * @param {Record<string, string> | string[]} [opts.objects] foreign objects (id -> common.type, or ids as "number")
 * @param {Record<string, unknown>} [opts.own] own state values by id relative to the namespace
 * @returns {ReturnType<typeof createFakeHost>} the fake host
 */
export function createFakeHost(opts = {}) {
	let nowMs = opts.now ?? new Date(2026, 0, 5, 12, 0).getTime();
	let seq = 0;
	const timers = new Map();
	const values = { ...(opts.values ?? {}) };
	const objects = Array.isArray(opts.objects)
		? new Map(opts.objects.map(id => [id, "number"]))
		: new Map(Object.entries(opts.objects ?? {}));
	const own = new Map(Object.entries(opts.own ?? {}));

	const host = {
		/** Own state writes (ack=true) in order. */
		ownWrites: [],
		/** Foreign state writes (ack=false) in order. */
		writes: [],
		/** Calls of sendTo in order. */
		sent: [],
		logs: { debug: [], info: [], warn: [], error: [] },
		log: {
			debug: m => host.logs.debug.push(m),
			info: m => host.logs.info.push(m),
			warn: m => host.logs.warn.push(m),
			error: m => host.logs.error.push(m),
		},
		async setOwnState(id, val) {
			own.set(id, val);
			host.ownWrites.push({ id, val, at: nowMs });
		},
		async getOwnState(id) {
			return own.has(id) ? own.get(id) : null;
		},
		/**
		 * Current own state value (test helper).
		 *
		 * @param {string} id id relative to the namespace
		 */
		own(id) {
			return own.has(id) ? own.get(id) : null;
		},
		/**
		 * All values written to an own state, in order (test helper).
		 *
		 * @param {string} id id relative to the namespace
		 */
		ownHistory(id) {
			return host.ownWrites.filter(w => w.id === id).map(w => w.val);
		},
		async getForeignValue(id) {
			return values[id] ?? null;
		},
		async setForeignValue(id, val) {
			host.writes.push({ id, val, at: nowMs });
			values[id] = val;
		},
		async getForeignObjectCommonType(id) {
			return objects.get(id) ?? null;
		},
		/**
		 * Set a foreign state value without recording a write (test helper).
		 *
		 * @param {string} id state id
		 * @param {unknown} val value
		 */
		setValue(id, val) {
			values[id] = val;
		},
		/**
		 * Add a foreign object (test helper).
		 *
		 * @param {string} id object id
		 * @param {string} [type] common.type
		 */
		addObject(id, type = "number") {
			objects.set(id, type);
		},
		sendTo(instance, command, message) {
			host.sent.push({ instance, command, message });
		},
		setTimeout(cb, ms) {
			const h = ++seq;
			timers.set(h, { cb, at: nowMs + ms });
			return h;
		},
		clearTimeout(h) {
			timers.delete(h);
		},
		now: () => nowMs,
		/** Number of open timers. */
		openTimers: () => timers.size,
		/**
		 * Advance the clock without running timers.
		 *
		 * @param {number} ms milliseconds
		 */
		tickClock(ms) {
			nowMs += ms;
		},
		/**
		 * Advance the clock and run due timers in time order.
		 *
		 * @param {number} ms elapsed milliseconds
		 */
		async advance(ms) {
			const end = nowMs + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) {
					break;
				}
				timers.delete(due[0]);
				nowMs = due[1].at;
				due[1].cb();
				await new Promise(resolve => setImmediate(resolve));
			}
			nowMs = end;
		},
		/** Run all open timers in time order, advancing the clock to each. */
		async runTimers() {
			for (;;) {
				const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) {
					break;
				}
				timers.delete(due[0]);
				nowMs = Math.max(nowMs, due[1].at);
				due[1].cb();
				await new Promise(resolve => setImmediate(resolve));
			}
		},
	};
	return host;
}
