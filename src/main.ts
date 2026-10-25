import * as utils from "@iobroker/adapter-core";
import { fileURLToPath } from "node:url";
import { errorMessage } from "./lib/utils.js";

class DeviceReminder extends utils.Adapter {
	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({ ...options, name: "device-reminder" });
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		await this.setState("info.connection", true, true);
		this.log.debug("device-reminder started");
	}

	private onStateChange(_id: string, _state: ioBroker.State | null | undefined): void {
		// Wired up in later tasks.
	}

	private onObjectChange(_id: string, _obj: ioBroker.Object | null | undefined): void {
		// Wired up in later tasks.
	}

	private onMessage(_obj: ioBroker.Message): void {
		// Wired up in later tasks.
	}

	private onUnload(callback: () => void): void {
		this.setState("info.connection", false, true)
			.catch(err => this.log.debug(`Shutdown state update skipped: ${errorMessage(err)}`))
			.finally(() => callback());
	}
}

/**
 * Create a new device-reminder adapter instance (compact mode entry point).
 *
 * @param options - Adapter options passed to the ioBroker adapter core
 */
export default function startAdapter(options: Partial<utils.AdapterOptions> = {}): DeviceReminder {
	return new DeviceReminder(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	new DeviceReminder();
}
