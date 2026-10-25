type StateHandler = (id: string, state: ioBroker.State | null | undefined) => void;

/** The part of the vis socket that the widgets use. */
export interface SocketLike {
	getState(id: string): Promise<{ val: unknown } | null | undefined>;
	setState(id: string, state: { val: unknown; ack: boolean }): Promise<unknown>;
	subscribeState(ids: string | string[], handler: StateHandler): void;
	unsubscribeState(ids: string | string[], handler: StateHandler): void;
}

/**
 * Text of a primitive value, otherwise the default
 *
 * @param x value
 * @param d default
 */
export function str(x: unknown, d = ""): string {
	return typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : d;
}

export interface OperationEntry {
	start: string;
	end: string;
	runtime: string;
}

/** Sub-states of a device that the widgets display. */
export const DEVICE_STATE_IDS = [
	"status",
	"consumption",
	"runtime",
	"runtimeMs",
	"lastOperations",
	"running",
	"finished",
	"alertRuntime",
	"config.doNotDisturb",
] as const;

/**
 * Format milliseconds as "h:mm:ss"
 *
 * @param ms duration in milliseconds
 */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Parse the JSON of the lastOperations state, ignoring anything that is not a list of runs
 *
 * @param raw state value
 */
export function parseOperations(raw: unknown): OperationEntry[] {
	if (typeof raw !== "string" || !raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed
			.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
			.map(e => ({ start: str(e.start), end: str(e.end), runtime: str(e.runtime) }));
	} catch {
		return [];
	}
}

/**
 * Subscribe to the displayed sub-states of one device and report every change
 *
 * @param socket vis socket
 * @param deviceId device object ID
 * @param onValues called with the full value map (keyed by sub-state ID) after every change
 * @returns function that stops the subscription
 */
export function watchDevice(
	socket: SocketLike,
	deviceId: string,
	onValues: (values: Record<string, unknown>) => void,
): () => void {
	const prefix = `${deviceId}.`;
	const ids = DEVICE_STATE_IDS.map(s => `${prefix}${s}`);
	const values: Record<string, unknown> = {};
	let active = true;
	const handler: StateHandler = (id, state) => {
		if (!active || !id.startsWith(prefix)) {
			return;
		}
		values[id.slice(prefix.length)] = state?.val;
		onValues({ ...values });
	};
	socket.subscribeState(ids, handler);
	void Promise.all(
		ids.map(async id => {
			try {
				const state = await socket.getState(id);
				const key = id.slice(prefix.length);
				if (active && state && !(key in values)) {
					values[key] = state.val;
				}
			} catch {
				// the state may not exist yet
			}
		}),
	).then(() => {
		if (active) {
			onValues({ ...values });
		}
	});
	return () => {
		active = false;
		socket.unsubscribeState(ids, handler);
	};
}
