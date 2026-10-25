import { runActions } from "./actions.js";
import type { DeviceConfig, InstanceConfig } from "./config.js";
import { findType } from "./config.js";
import { DeviceRuntime } from "./deviceRuntime.js";
import type { MessageSink, NotifierHost, RuntimeEvent, RuntimeListener } from "./host.js";
import type { LearningSuggestion } from "./learning.js";
import { LearningRecorder, suggestType } from "./learning.js";
import type { Notifier } from "./notifier.js";
import { ReminderScheduler } from "./reminder.js";
import { errorMessage } from "./utils.js";

/** Snapshot of the main states of a device (answer of the `status` command). */
export interface DeviceStatusSnapshot {
	/** Status text. */
	status: ioBroker.StateValue | null;
	/** Whether a run is in progress. */
	running: boolean;
	/** Whether the last run finished and was not acknowledged yet. */
	finished: boolean;
	/** Current power in W. */
	consumption: ioBroker.StateValue | null;
	/** Runtime of the current run. */
	runtime: ioBroker.StateValue | null;
}

interface Entry {
	runtime: DeviceRuntime;
	reminder: ReminderScheduler;
	recorder: LearningRecorder;
	/** Last message text delivered for the device (resolved end text after a finished run). */
	lastMessage: string;
}

function isTrue(val: unknown): boolean {
	return val === true || val === 1 || val === "true" || val === "1";
}

/** Holds all device runtimes and routes states, events and commands to them. */
export class DeviceRegistry implements RuntimeListener {
	private readonly devices = new Map<string, Entry>();

	/**
	 * Create the registry.
	 *
	 * @param host - Adapter host
	 * @param notifier - Notifier used for all messages
	 * @param getConfig - Returns the current instance configuration
	 */
	public constructor(
		private readonly host: NotifierHost,
		private readonly notifier: Notifier,
		private readonly getConfig: () => InstanceConfig,
	) {}

	/**
	 * Add a device, replace it, or apply a changed configuration while keeping its state
	 * (same type and power state).
	 *
	 * @param deviceId - Device id below the namespace
	 * @param cfg - Normalized device configuration
	 */
	public async upsert(deviceId: string, cfg: DeviceConfig): Promise<void> {
		const existing = this.devices.get(deviceId);
		if (existing) {
			if (existing.runtime.canKeepStateFor(cfg)) {
				existing.runtime.updateConfig(cfg);
				return;
			}
			this.host.log.info(`Device ${cfg.name} reset: type or power state changed`);
			this.disposeEntry(existing);
			this.devices.delete(deviceId);
		}

		const inst = this.getConfig();
		const type = findType(inst, cfg.typeId);
		if (!type) {
			this.host.log.warn(`Device ${cfg.name} ignored: unknown device type "${cfg.typeId}"`);
			return;
		}
		const sink: MessageSink = {
			send: async (id: string, text: string): Promise<void> => {
				const entry = this.devices.get(id);
				if (!entry) {
					return;
				}
				entry.lastMessage = text;
				await this.notifier.notify(entry.runtime.config.recipients, text, {
					doNotDisturb: entry.runtime.doNotDisturb,
				});
			},
		};
		const runtime = new DeviceRuntime(this.host, deviceId, cfg, type, inst, sink, this);
		const entry: Entry = {
			runtime,
			recorder: new LearningRecorder(),
			lastMessage: "",
			reminder: new ReminderScheduler(this.host, this.notifier, () => ({
				cfg: runtime.config,
				text: runtime.config.endText ? entry.lastMessage || runtime.config.endText : "",
				doNotDisturb: runtime.doNotDisturb,
			})),
		};
		this.devices.set(deviceId, entry);
		await runtime.init();
		await this.host.setOwnState(`${deviceId}.learning.active`, false);
	}

	/**
	 * Remove a device and stop all its timers.
	 *
	 * @param deviceId - Device id
	 */
	public remove(deviceId: string): void {
		const entry = this.devices.get(deviceId);
		if (entry) {
			this.disposeEntry(entry);
			this.devices.delete(deviceId);
		}
	}

	/**
	 * Runtime of a device.
	 *
	 * @param deviceId - Device id
	 */
	public get(deviceId: string): DeviceRuntime | undefined {
		return this.devices.get(deviceId)?.runtime;
	}

	/** Ids of all registered devices. */
	public ids(): string[] {
		return [...this.devices.keys()];
	}

	/** Foreign states that must be subscribed: power, switch and acknowledge states of all devices. */
	public foreignIdsToSubscribe(): string[] {
		const ids = new Set<string>();
		for (const { runtime } of this.devices.values()) {
			const cfg = runtime.config;
			for (const id of [cfg.powerId, cfg.switchId, cfg.reminder.ackStateId]) {
				if (id) {
					ids.add(id);
				}
			}
		}
		return [...ids];
	}

	/**
	 * Route a change of a foreign state to all devices using it.
	 *
	 * @param id - Foreign state id
	 * @param val - New value
	 */
	public async routeForeignState(id: string, val: ioBroker.StateValue): Promise<void> {
		for (const [deviceId, entry] of this.devices) {
			const cfg = entry.runtime.config;
			try {
				if (cfg.switchId === id) {
					entry.runtime.onSwitch(val);
				}
				if (cfg.powerId === id && cfg.enabled) {
					await entry.runtime.onPower(val);
				}
				if (cfg.reminder.ackStateId === id && isTrue(val)) {
					await this.acknowledge(deviceId);
				}
			} catch (err) {
				this.host.log.error(`Device ${cfg.name}: ${errorMessage(err)}`);
			}
		}
	}

	/**
	 * Route a change of an own state (`<dev>.config.*`, `<dev>.acknowledge`, `<dev>.learning.start/stop`).
	 *
	 * @param relId - State id relative to the namespace
	 * @param val - New value
	 * @param ack - Acknowledge flag
	 */
	public async routeOwnState(relId: string, val: ioBroker.StateValue, ack: boolean): Promise<void> {
		const dot = relId.indexOf(".");
		if (dot <= 0) {
			return;
		}
		const deviceId = relId.slice(0, dot);
		const rest = relId.slice(dot + 1);
		const entry = this.devices.get(deviceId);
		if (!entry) {
			return;
		}
		try {
			if (rest.startsWith("config.")) {
				await entry.runtime.onOwnStateChange(rest, val, ack);
				return;
			}
			if (ack || !isTrue(val)) {
				return;
			}
			switch (rest) {
				case "acknowledge":
					await this.acknowledge(deviceId);
					break;
				case "learning.start":
					await this.startLearning(deviceId);
					break;
				case "learning.stop":
					await this.stopLearning(deviceId);
					break;
				default:
					break;
			}
		} catch (err) {
			this.host.log.error(`Device ${entry.runtime.config.name}: ${errorMessage(err)}`);
		}
	}

	/** One poll step for every enabled device; an error of one device does not affect the others. */
	public async tickAll(): Promise<void> {
		for (const [deviceId, entry] of this.devices) {
			if (!entry.runtime.config.enabled) {
				continue;
			}
			try {
				await entry.runtime.tick();
				if (entry.recorder.active) {
					const power = entry.runtime.lastPower;
					if (power !== null) {
						entry.recorder.add(power, this.host.now());
					}
					if (!entry.recorder.active) {
						await this.host.setOwnState(`${deviceId}.learning.active`, false);
					}
				}
			} catch (err) {
				this.host.log.error(`Device ${entry.runtime.config.name}: ${errorMessage(err)}`);
			}
		}
	}

	/**
	 * Start recording a run for learning thresholds.
	 *
	 * @param deviceId - Device id
	 */
	public async startLearning(deviceId: string): Promise<void> {
		const entry = this.devices.get(deviceId);
		if (!entry) {
			return;
		}
		entry.recorder.start(this.host.now());
		await this.host.setOwnState(`${deviceId}.learning.active`, true);
		this.host.log.info(`Learning started for device ${entry.runtime.config.name}`);
	}

	/**
	 * Stop recording and derive suggested type settings (stored in `learning.result`).
	 *
	 * @param deviceId - Device id
	 */
	public async stopLearning(deviceId: string): Promise<LearningSuggestion | { error: string }> {
		const entry = this.devices.get(deviceId);
		if (!entry) {
			return { error: "unknownDevice" };
		}
		const samples = entry.recorder.stop(this.host.now());
		const result = suggestType(samples, this.getConfig().pollIntervalSec);
		await this.host.setOwnState(`${deviceId}.learning.active`, false);
		await this.host.setOwnState(`${deviceId}.learning.result`, JSON.stringify(result));
		this.host.log.info(`Learning stopped for device ${entry.runtime.config.name}`);
		return result;
	}

	/**
	 * Acknowledge a finished run: stops the reminders and runs the `acknowledged` actions.
	 *
	 * @param deviceId - Device id
	 */
	public async acknowledge(deviceId: string): Promise<void> {
		const entry = this.devices.get(deviceId);
		if (!entry) {
			return;
		}
		const wasFinished = isTrue(await this.host.getOwnState(`${deviceId}.finished`));
		entry.reminder.acknowledge();
		await entry.runtime.onOwnStateChange("acknowledge", true, false);
		if (wasFinished) {
			await runActions(this.host, entry.runtime.config.actions, "acknowledged");
		}
	}

	/**
	 * Read the main states of a device.
	 *
	 * @param deviceId - Device id
	 */
	public async status(deviceId: string): Promise<DeviceStatusSnapshot | null> {
		const entry = this.devices.get(deviceId);
		if (!entry) {
			return null;
		}
		const read = (rel: string): Promise<ioBroker.StateValue | null> => this.host.getOwnState(`${deviceId}.${rel}`);
		return {
			status: await read("status"),
			running: entry.runtime.isRunning,
			finished: isTrue(await read("finished")),
			consumption: entry.runtime.lastPower ?? (await read("consumption")),
			runtime: await read("runtime"),
		};
	}

	/**
	 * Lifecycle event of a device: drives the reminders and runs the configured actions.
	 *
	 * @param deviceId - Device id
	 * @param ev - Event
	 */
	public onRuntimeEvent(deviceId: string, ev: RuntimeEvent): void {
		const entry = this.devices.get(deviceId);
		if (!entry) {
			return;
		}
		const cfg = entry.runtime.config;
		switch (ev) {
			case "start":
				entry.reminder.onStarted();
				void runActions(this.host, cfg.actions, "start");
				break;
			case "end":
				entry.reminder.onFinished();
				void runActions(this.host, cfg.actions, "end");
				break;
			case "abort":
				break;
		}
	}

	/** Stop all devices and timers. */
	public disposeAll(): void {
		for (const entry of this.devices.values()) {
			this.disposeEntry(entry);
		}
		this.devices.clear();
	}

	private disposeEntry(entry: Entry): void {
		entry.runtime.dispose();
		entry.reminder.dispose();
		entry.recorder.stop(this.host.now());
	}
}
