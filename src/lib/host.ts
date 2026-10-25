/** Narrow interface through which a device runtime talks to the adapter and the outside world. */
export interface DeviceHost {
	/** Write an own state with ack=true (id relative to the namespace). */
	setOwnState(id: string, val: ioBroker.StateValue): Promise<void>;
	/** Read an own state value (id relative to the namespace). */
	getOwnState(id: string): Promise<ioBroker.StateValue | null>;
	/** Read the value of a foreign state. */
	getForeignValue(id: string): Promise<ioBroker.StateValue | null>;
	/** Write a foreign state with ack=false. */
	setForeignValue(id: string, val: ioBroker.StateValue): Promise<void>;
	/** Common type of a foreign object; `null` means the object does not exist. */
	getForeignObjectCommonType(id: string): Promise<ioBroker.CommonType | null>;
	/** Adapter-managed timeout (never the global one). */
	setTimeout(cb: () => void, ms: number): unknown;
	/** Clear a timeout created with `setTimeout`. */
	clearTimeout(handle: unknown): void;
	/** Current time in ms since epoch. */
	now(): number;
	/** Logger of the adapter. */
	log: Pick<ioBroker.Logger, "debug" | "info" | "warn" | "error">;
}

/** Lifecycle events of a running device. */
export type RuntimeEvent = "start" | "end" | "abort";

/** Receives finished message texts of a device. */
export interface MessageSink {
	/** Deliver a message for a device. */
	send(deviceId: string, text: string): Promise<void>;
}

/** Receives lifecycle events of a device runtime (reminders, actions, learning). */
export interface RuntimeListener {
	/** Called when a device starts, ends or is aborted. */
	onRuntimeEvent(deviceId: string, ev: RuntimeEvent): void;
}

/** Host extension for the notifier, which also sends messages to other adapters. */
export interface NotifierHost extends DeviceHost {
	/** Send a message to another adapter instance. */
	sendTo(instance: string, command: string, message: unknown): void;
}
