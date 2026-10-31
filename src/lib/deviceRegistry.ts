import { runActions } from "./actions.js";
import type { DeviceConfig, InstanceConfig } from "./config.js";
import { findType } from "./config.js";
import { DeviceRuntime } from "./deviceRuntime.js";
import { fill, TEXT } from "./dmTexts.js";
import type { HistoryEnv } from "./historySource.js";
import { findHistoryInstance, loadHistorySeries } from "./historySource.js";
import type { FileIO, MessageSink, NotifierHost, RuntimeEvent, RuntimeListener } from "./host.js";
import type { GateResult, OptimizeContext, OptimizeOutcome } from "./learn/autoOptimize.js";
import { effectiveOf, gate, LOCK_MS, LOCK_RUNS, optimize } from "./learn/autoOptimize.js";
import { simulate } from "./learn/replay.js";
import { buildLayout } from "./learn/runs.js";
import { scaled } from "./learn/ticks.js";
import type { LearningSuggestion } from "./learning.js";
import { LearningRecorder, suggestType } from "./learning.js";
import type { Notifier } from "./notifier.js";
import { ReminderScheduler } from "./reminder.js";
import type { Capture } from "./runRecorder.js";
import { RunRecorder } from "./runRecorder.js";
import type { StoreFile } from "./runStore.js";
import {
	addRun,
	emptyStore,
	fitSize,
	labelCapture,
	loadStore,
	pushChange,
	reconcileStore,
	refreshInfo,
	removeStore,
	saveStore,
	typeHash,
} from "./runStore.js";
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
	/** Automatic optimisation (null = off). */
	opt: OptEntry | null;
}

interface OptEntry {
	store: StoreFile;
	recorder: RunRecorder;
}

/** Time budget of one optimisation job. */
const OPTIMIZE_BUDGET_MS = 30_000;

/** Optional parts of the registry. */
export interface RegistryOptions {
	/** Language of the installation for messages (default English). */
	language?: () => string;
	/** History adapters: runs of the history are taken over when the automatic optimisation starts. */
	history?: HistoryEnv;
}

function isTrue(val: unknown): boolean {
	return val === true || val === 1 || val === "true" || val === "1";
}

/** Holds all device runtimes and routes states, events and commands to them. */
export class DeviceRegistry implements RuntimeListener {
	private readonly devices = new Map<string, Entry>();
	private optQueue: Promise<void> = Promise.resolve();
	private readonly driftReported = new WeakSet<Entry>();

	/**
	 * Create the registry.
	 *
	 * @param host - Adapter host
	 * @param notifier - Notifier used for all messages
	 * @param getConfig - Returns the current instance configuration
	 * @param files - Files for the learning data of the automatic optimisation (without: optimisation off)
	 * @param opts - Language and history access
	 */
	public constructor(
		private readonly host: NotifierHost,
		private readonly notifier: Notifier,
		private readonly getConfig: () => InstanceConfig,
		private readonly files?: FileIO,
		private readonly opts: RegistryOptions = {},
	) {}

	/** Language of the messages. */
	private lang(): string {
		return this.opts.language?.() || "en";
	}

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
				await this.syncOptimize(deviceId, existing);
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
			opt: null,
			reminder: new ReminderScheduler(this.host, this.notifier, () => ({
				cfg: runtime.config,
				text: runtime.config.endText ? entry.lastMessage || runtime.config.endText : "",
				doNotDisturb: runtime.doNotDisturb,
			})),
		};
		this.devices.set(deviceId, entry);
		await runtime.init();
		await this.host.setOwnState(`${deviceId}.learning.active`, false);
		await this.syncOptimize(deviceId, entry);
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
				case "learning.undo":
					await this.undoOptimization(deviceId);
					break;
				case "learning.reset":
					await this.resetOptimization(deviceId);
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
				if (entry.opt) {
					const cap = entry.opt.recorder.closeIfDue(this.host.now(), entry.runtime.effective.endVal);
					if (cap) {
						await this.storeCapture(deviceId, entry, cap);
					}
				}
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
		const cfg = entry.runtime.config;
		const inst = this.getConfig();
		const result = await suggestType(samples, inst.pollIntervalSec, {
			abort: cfg.abort,
			abortFixed: cfg.abortFixed,
			currentType: findType(inst, cfg.typeId),
			unitFactor: await this.unitFactorOf(cfg.powerId),
		});
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
				this.persistPending(entry);
				break;
			case "abort":
				break;
		}
	}

	/** Promise that resolves when all queued optimisation jobs are done. */
	public whenOptimized(): Promise<void> {
		return this.optQueue;
	}

	/**
	 * Learning data of a device (automatic optimisation), or null.
	 *
	 * @param deviceId - Device id
	 */
	public learningData(deviceId: string): StoreFile | null {
		return this.devices.get(deviceId)?.opt?.store ?? null;
	}

	/**
	 * Learning data of a device, also while the automatic optimisation is off (read from the file).
	 *
	 * @param deviceId - Device id
	 */
	public async readLearningData(deviceId: string): Promise<StoreFile | null> {
		const inMemory = this.learningData(deviceId);
		if (inMemory || !this.files) {
			return inMemory;
		}
		try {
			return await loadStore(this.files, deviceId, this.host.log);
		} catch (err) {
			this.host.log.debug(`Cannot read the learning data of ${deviceId}: ${errorMessage(err)}`);
			return null;
		}
	}

	/**
	 * Replay all stored runs with the current values (result per run for the Device Manager).
	 *
	 * @param deviceId - Device id
	 */
	public async checkStoredRuns(deviceId: string): Promise<GateResult | null> {
		const entry = this.devices.get(deviceId);
		const store = entry?.opt?.store;
		if (!entry || !store) {
			return null;
		}
		return gate(store, entry.runtime.effective, this.optimizeContext(entry));
	}

	/**
	 * Remove one stored run or false start (e.g. a run that was no normal use of the device).
	 * The extremes of all runs ever seen stay.
	 *
	 * @param deviceId - Device id
	 * @param runId - Id of the stored run
	 */
	public discardRun(deviceId: string, runId: string): Promise<boolean> {
		return this.serialized(() => this.discardRunNow(deviceId, runId));
	}

	private async discardRunNow(deviceId: string, runId: string): Promise<boolean> {
		const entry = this.devices.get(deviceId);
		const store = entry?.opt?.store;
		if (!entry || !store) {
			return false;
		}
		const before = store.runs.length + store.spikes.length;
		store.runs = store.runs.filter(r => r.id !== runId);
		store.spikes = store.spikes.filter(r => r.id !== runId);
		if (store.runs.length + store.spikes.length === before) {
			return false;
		}
		refreshInfo(store);
		await this.saveOpt(entry);
		await this.writeOptStates(deviceId, entry);
		this.host.log.info(`${entry.runtime.config.name}: stored run ${runId} discarded`);
		return true;
	}

	/**
	 * Delete the learning data of a device (device deleted, or "Clear learning data").
	 *
	 * @param deviceId - Device id
	 */
	public deleteLearningData(deviceId: string): Promise<void> {
		return this.serialized(() => this.deleteLearningDataNow(deviceId));
	}

	private async deleteLearningDataNow(deviceId: string): Promise<void> {
		const entry = this.devices.get(deviceId);
		if (entry?.opt) {
			const cfg = entry.runtime.config;
			entry.runtime.setOverride(null);
			entry.opt.store = emptyStore(
				deviceId,
				cfg.typeId,
				typeHash(entry.runtime.deviceType),
				entry.opt.store.step,
				entry.opt.store.unitFactor,
			);
			this.driftReported.delete(entry);
			await this.writeOptStates(deviceId, entry);
		}
		if (this.files) {
			try {
				await removeStore(this.files, deviceId);
			} catch (err) {
				this.host.log.warn(`Cannot delete the learning data of ${deviceId}: ${errorMessage(err)}`);
			}
		}
	}

	/**
	 * Undo the last change of the automatic optimisation (locks the tightening for 14 days).
	 *
	 * @param deviceId - Device id
	 */
	public undoOptimization(deviceId: string): Promise<boolean> {
		return this.serialized(() => this.undoOptimizationNow(deviceId));
	}

	private async undoOptimizationNow(deviceId: string): Promise<boolean> {
		const entry = this.devices.get(deviceId);
		const store = entry?.opt?.store;
		if (!entry || !store) {
			return false;
		}
		const last = [...store.changes].reverse().find(c => c.kind === "repair" || c.kind === "tighten");
		if (!last) {
			return false;
		}
		this.setOverrideByUser(entry, store, last.from, "undo", "undo of the last change");
		await this.saveOpt(entry);
		await this.writeOptStates(deviceId, entry);
		this.host.log.info(`${entry.runtime.config.name}: last optimisation undone`);
		return true;
	}

	/**
	 * Back to the values of the device type (locks the tightening for 14 days).
	 *
	 * @param deviceId - Device id
	 */
	public resetOptimization(deviceId: string): Promise<boolean> {
		return this.serialized(() => this.resetOptimizationNow(deviceId));
	}

	private async resetOptimizationNow(deviceId: string): Promise<boolean> {
		const entry = this.devices.get(deviceId);
		const store = entry?.opt?.store;
		if (!entry || !store) {
			return false;
		}
		this.setOverrideByUser(entry, store, null, "reset", "reset to the device type values");
		await this.saveOpt(entry);
		await this.writeOptStates(deviceId, entry);
		this.host.log.info(`${entry.runtime.config.name}: optimised values reset to the device type`);
		return true;
	}

	/**
	 * Set the override on request of the user and lock the tightening.
	 *
	 * @param entry - Entry
	 * @param store - Store
	 * @param override - New override
	 * @param kind - Kind of the change
	 * @param reason - Reason (English)
	 */
	private setOverrideByUser(
		entry: Entry,
		store: StoreFile,
		override: StoreFile["override"],
		kind: "undo" | "reset",
		reason: string,
	): void {
		const now = this.host.now();
		pushChange(store, {
			ts: now,
			kind,
			from: store.override,
			to: override,
			reason,
			runs: store.runs.length + store.spikes.length,
			gainSec: 0,
		});
		store.override = override;
		store.lockUntilTs = now + LOCK_MS;
		store.lockRuns = LOCK_RUNS;
		store.lastChangeTs = now;
		store.newSinceChange = 0;
		store.failStreak = 0;
		store.info.status = "locked";
		entry.runtime.setOverride(override);
	}

	/**
	 * Unit factor of a power state (kW: 1000, otherwise 1).
	 *
	 * @param powerId - Power state id
	 */
	private async unitFactorOf(powerId: string): Promise<number> {
		try {
			const unit = (await this.host.getForeignObjectUnit?.(powerId)) ?? null;
			return unit !== null && unit.trim().toLowerCase() === "kw" ? 1000 : 1;
		} catch {
			return 1;
		}
	}

	/**
	 * Start or stop the automatic optimisation of a device according to its configuration.
	 *
	 * @param deviceId - Device id
	 * @param entry - Entry
	 */
	private async syncOptimize(deviceId: string, entry: Entry): Promise<void> {
		const cfg = entry.runtime.config;
		const want = cfg.autoOptimize === true && this.files !== undefined;
		if (!want) {
			if (entry.opt) {
				entry.runtime.attachRecorder(null);
				entry.runtime.setOverride(null);
				entry.opt = null;
				await this.host.setOwnState(`${deviceId}.learning.optimized`, false);
				await this.host.setOwnState(`${deviceId}.learning.optimizeInfo`, JSON.stringify({ status: "off" }));
			}
			return;
		}
		if (entry.opt || !this.files) {
			return;
		}
		const inst = this.getConfig();
		const step = inst.pollIntervalSec * 1000;
		const unitFactor = await this.unitFactorOf(cfg.powerId);
		const type = entry.runtime.deviceType;
		const now = this.host.now();
		let loaded: StoreFile | null;
		try {
			loaded = await loadStore(this.files, deviceId, this.host.log);
		} catch (err) {
			// not "no learning data": starting empty would overwrite both slots with the next saves
			this.host.log.warn(
				`${cfg.name}: learning data not readable, automatic optimisation off until the next start: ${errorMessage(err)}`,
			);
			return;
		}
		const store = loaded ?? emptyStore(deviceId, cfg.typeId, typeHash(type), step, unitFactor);
		const hadOverride = store.override !== null;
		for (const msg of reconcileStore(store, cfg.typeId, typeHash(type), step, unitFactor, now)) {
			this.host.log.info(`${cfg.name}: ${msg}`);
		}
		if (hadOverride && store.override === null) {
			await this.notifyOptimization(entry, TEXT.optTypeChanged, {});
		}
		const recorder = new RunRecorder(step, unitFactor);
		entry.opt = { store, recorder };
		entry.runtime.attachRecorder(recorder);
		if (store.override) {
			const g = await gate(store, effectiveOf(type, store.override), this.optimizeContext(entry));
			if (g.ok) {
				entry.runtime.setOverride(store.override);
			} else {
				this.host.log.info(`${cfg.name}: optimised values no longer pass all stored runs, checking again`);
				this.enqueueOptimize(deviceId);
			}
		}
		const pending = store.pending;
		store.pending = null;
		if (pending) {
			const closed = recorder.restore(pending, now);
			if (closed) {
				await this.storeCapture(deviceId, entry, closed);
			}
		}
		await this.writeOptStates(deviceId, entry);
		if (!loaded && this.opts.history) {
			this.enqueue(deviceId, () => this.bootstrapFromHistory(deviceId));
		}
	}

	/**
	 * Take over the runs of the history when the automatic optimisation starts without learning data:
	 * every run and false start of the history is replayed with the current values to get the events
	 * the runtime would have seen, then labelled and stored like a recorded run.
	 *
	 * @param deviceId - Device id
	 */
	private async bootstrapFromHistory(deviceId: string): Promise<void> {
		const entry = this.devices.get(deviceId);
		const opt = entry?.opt;
		const env = this.opts.history;
		if (!entry || !opt || !env) {
			return;
		}
		const cfg = entry.runtime.config;
		let instance: string | undefined;
		try {
			instance = await findHistoryInstance(env, cfg.powerId);
		} catch (err) {
			this.host.log.debug(`${cfg.name}: no history for the automatic optimisation: ${errorMessage(err)}`);
		}
		if (!instance) {
			return;
		}
		const poll = this.getConfig().pollIntervalSec;
		let loadedHistory: Awaited<ReturnType<typeof loadHistorySeries>>;
		try {
			loadedHistory = await loadHistorySeries(env, instance, cfg.powerId, this.host.now(), poll);
		} catch (err) {
			this.host.log.warn(`${cfg.name}: reading the history from ${instance} failed: ${errorMessage(err)}`);
			return;
		}
		const { series, meta } = loadedHistory;
		const store = opt.store;
		if (
			entry.opt !== opt ||
			this.devices.get(deviceId) !== entry ||
			meta.energyCounter ||
			meta.unitFactor !== store.unitFactor ||
			series.stepMs !== store.step
		) {
			return;
		}
		const eff = entry.runtime.effective;
		const factor = store.unitFactor;
		const layout = buildLayout(series, { keepAbove: eff.endVal * factor });
		const sim = factor === 1 ? series : scaled(series, 1 / factor);
		let runs = 0;
		let spikes = 0;
		for (const w of [...layout.windows].sort((a, b) => a.fromIdx - b.fromIdx)) {
			const cells = [];
			for (let i = w.fromIdx; i <= w.toIdx; i++) {
				cells.push({ min: sim.min[i], max: sim.max[i], last: sim.last[i], valid: sim.valid[i] === 1 });
			}
			const r = simulate(sim, w, eff, { abort: cfg.abort, abortFixed: cfg.abortFixed, pollSec: poll });
			const ev: Capture["ev"] = [
				...r.startedAt.map((t): [number, "s"] => [t, "s"]),
				...r.finished.map((t): [number, "f"] => [t, "f"]),
			];
			ev.sort((a, b) => a[0] - b[0]);
			const cap: Capture = {
				t0: series.t0 + w.fromIdx * series.stepMs,
				stepMs: series.stepMs,
				unitFactor: factor,
				cells,
				ev,
				postTruncated: false,
			};
			const res = labelCapture(cap, eff.endVal * factor, "history");
			if (res.run) {
				addRun(store, res.run);
				if (res.label === "spike") {
					spikes++;
				} else {
					runs++;
				}
			}
			await this.yieldNow();
		}
		if (entry.opt !== opt || this.devices.get(deviceId) !== entry) {
			return;
		}
		if (runs + spikes === 0) {
			// the file marks the history as read, so it is not loaded again at every start
			await this.saveOpt(entry);
			return;
		}
		refreshInfo(store);
		this.host.log.info(
			`${cfg.name}: ${runs} runs and ${spikes} false starts taken over from the history (${instance})`,
		);
		await this.saveOpt(entry);
		await this.runOptimize(deviceId);
	}

	/** Let other work run. */
	private yieldNow(): Promise<void> {
		return new Promise<void>(resolve => {
			this.host.setTimeout(resolve, 0);
		});
	}

	/**
	 * Context of an optimisation job.
	 *
	 * @param entry - Entry
	 */
	private optimizeContext(entry: Entry): OptimizeContext {
		const cfg = entry.runtime.config;
		return {
			type: entry.runtime.deviceType,
			pollSec: this.getConfig().pollIntervalSec,
			abort: cfg.abort,
			abortFixed: cfg.abortFixed,
			yieldFn: () =>
				new Promise<void>(resolve => {
					this.host.setTimeout(resolve, 0);
				}),
			now: this.host.now(),
			budgetMs: OPTIMIZE_BUDGET_MS,
			clock: () => this.host.now(),
		};
	}

	/**
	 * Persist the open capture at the end of a run (survives a restart in the time after the run).
	 *
	 * @param entry - Entry
	 */
	private persistPending(entry: Entry): void {
		const opt = entry.opt;
		if (!opt) {
			return;
		}
		opt.store.pending = opt.recorder.snapshot();
		fitSize(opt.store);
		this.saveOpt(entry).catch(err => this.host.log.warn(errorMessage(err)));
	}

	/**
	 * Save the learning data of a device.
	 *
	 * @param entry - Entry
	 */
	private async saveOpt(entry: Entry): Promise<void> {
		if (!entry.opt || !this.files) {
			return;
		}
		try {
			await saveStore(this.files, entry.opt.store);
		} catch (err) {
			this.host.log.warn(`Cannot save the learning data of ${entry.runtime.config.name}: ${errorMessage(err)}`);
		}
	}

	/**
	 * Label a closed capture, store it and check the detection.
	 *
	 * @param deviceId - Device id
	 * @param entry - Entry
	 * @param cap - Closed capture
	 */
	private async storeCapture(deviceId: string, entry: Entry, cap: Capture): Promise<void> {
		const opt = entry.opt;
		if (!opt) {
			return;
		}
		const store = opt.store;
		const res = labelCapture(cap, entry.runtime.effective.endVal * cap.unitFactor);
		store.pending = null;
		if (res.label === "unclear" || !res.run) {
			store.info.unclear++;
		} else {
			addRun(store, res.run);
			if (res.trusted) {
				store.newSinceChange++;
				store.lockRuns = Math.max(0, store.lockRuns - 1);
			}
		}
		if (res.endDelaySec !== null) {
			store.info.lastEndDelaySec = res.endDelaySec;
			await this.host.setOwnState(`${deviceId}.learning.lastEndDelay`, res.endDelaySec);
		}
		refreshInfo(store);
		await this.saveOpt(entry);
		if (res.run) {
			this.enqueueOptimize(deviceId);
		} else {
			await this.writeOptStates(deviceId, entry);
		}
	}

	/**
	 * Queue an optimisation job (devices one after another).
	 *
	 * @param deviceId - Device id
	 */
	private enqueueOptimize(deviceId: string): void {
		this.enqueue(deviceId, () => this.runOptimize(deviceId));
	}

	/**
	 * Run a change of the learning data by the user after the queued optimisation jobs, so that a job
	 * computed from the old values cannot overwrite it.
	 *
	 * @param fn - Change
	 */
	private serialized<T>(fn: () => Promise<T>): Promise<T> {
		const res = this.optQueue.then(fn);
		this.optQueue = res.then(
			() => undefined,
			() => undefined,
		);
		return res;
	}

	/**
	 * Queue a job of the automatic optimisation (devices one after another).
	 *
	 * @param deviceId - Device id
	 * @param job - Job
	 */
	private enqueue(deviceId: string, job: () => Promise<void>): void {
		this.optQueue = this.optQueue
			.then(job)
			.catch(err => this.host.log.error(`Optimisation of ${deviceId} failed: ${errorMessage(err)}`));
	}

	/**
	 * Run one optimisation job and apply its result.
	 *
	 * @param deviceId - Device id
	 */
	private async runOptimize(deviceId: string): Promise<void> {
		const entry = this.devices.get(deviceId);
		const opt = entry?.opt;
		if (!entry || !opt) {
			return;
		}
		const trailerBefore = opt.store.info.trailer;
		const outcome = await optimize(opt.store, this.optimizeContext(entry));
		if (entry.opt !== opt || this.devices.get(deviceId) !== entry) {
			return;
		}
		entry.runtime.setOverride(opt.store.override);
		await this.saveOpt(entry);
		await this.writeOptStates(deviceId, entry);
		await this.reportOutcome(entry, outcome);
		if (opt.store.info.trailer === "notSeparable" && trailerBefore !== "notSeparable") {
			await this.notifyOptimization(entry, TEXT.antiCreaseNotSeparable, {});
		}
	}

	/**
	 * Log (and optionally send) the result of an optimisation job.
	 *
	 * @param entry - Entry
	 * @param outcome - Result
	 */
	private async reportOutcome(entry: Entry, outcome: OptimizeOutcome): Promise<void> {
		const c = outcome.change;
		const store = entry.opt?.store;
		const runs = (store?.runs.length ?? 0) + (store?.spikes.length ?? 0);
		switch (outcome.kind) {
			case "tighten":
				await this.notifyOptimization(entry, TEXT.optChanged, {
					changes: c?.reason ?? "",
					runs,
					gain: formatMinutes(c?.gainSec ?? 0),
				});
				break;
			case "repair": {
				const last = store ? Math.max(0, ...[...store.runs, ...store.spikes].map(r => r.ts)) : 0;
				await this.notifyOptimization(entry, TEXT.optRepaired, {
					changes: c?.reason ?? "",
					date: formatDate(last || this.host.now()),
				});
				break;
			}
			case "cannotCover":
				await this.notifyOptimization(entry, TEXT.optCannotCover, {}, "warn");
				break;
			case "drift":
				if (!this.driftReported.has(entry)) {
					this.driftReported.add(entry);
					await this.notifyOptimization(entry, TEXT.optDrift, {}, "warn");
				}
				break;
			case "budget":
				this.host.log.debug(`${entry.runtime.config.name}: optimisation stopped (time budget)`);
				break;
			default:
				break;
		}
	}

	/**
	 * Log a message of the automatic optimisation (English) and, if the device wants it, send it to its
	 * recipients in the language of the installation.
	 *
	 * @param entry - Entry
	 * @param text - Text with the placeholders `{device}` and `vars`
	 * @param vars - Values of the placeholders
	 * @param level - Log level
	 */
	private async notifyOptimization(
		entry: Entry,
		text: ioBroker.Translated,
		vars: Record<string, string | number>,
		level: "info" | "warn" = "info",
	): Promise<void> {
		const cfg = entry.runtime.config;
		const all = { device: cfg.name, ...vars };
		this.host.log[level](fill(text, "en", all));
		if (!cfg.optimizeNotify) {
			return;
		}
		try {
			await this.notifier.notify(cfg.recipients, fill(text, this.lang(), all), {
				doNotDisturb: entry.runtime.doNotDisturb,
			});
		} catch (err) {
			this.host.log.warn(`Message of device ${cfg.name} failed: ${errorMessage(err)}`);
		}
	}

	/**
	 * Write the states of the automatic optimisation.
	 *
	 * @param deviceId - Device id
	 * @param entry - Entry
	 */
	private async writeOptStates(deviceId: string, entry: Entry): Promise<void> {
		const store = entry.opt?.store;
		if (!store) {
			return;
		}
		const type = entry.runtime.deviceType;
		await this.host.setOwnState(`${deviceId}.learning.optimized`, entry.runtime.currentOverride !== null);
		await this.host.setOwnState(
			`${deviceId}.learning.parameters`,
			JSON.stringify({
				type: effectiveOf(type, null),
				override: store.override,
				effective: entry.runtime.effective,
			}),
		);
		await this.host.setOwnState(`${deviceId}.learning.lastChange`, JSON.stringify(store.changes.at(-1) ?? null));
		await this.host.setOwnState(`${deviceId}.learning.optimizeInfo`, JSON.stringify(store.info));
	}

	/** Stop all devices and timers. */
	public disposeAll(): void {
		for (const entry of this.devices.values()) {
			this.disposeEntry(entry);
		}
		this.devices.clear();
	}

	private disposeEntry(entry: Entry): void {
		// running optimisation jobs see that the entry is gone and write nothing
		entry.opt = null;
		entry.runtime.dispose();
		entry.reminder.dispose();
		entry.recorder.stop(this.host.now());
	}
}

/**
 * Duration as minutes with one decimal.
 *
 * @param sec - Seconds
 */
function formatMinutes(sec: number): string {
	return `${Math.round(sec / 6) / 10} min`;
}

/**
 * Local date and time as `YYYY-MM-DD HH:MM`.
 *
 * @param ts - Time in ms
 */
export function formatDate(ts: number): string {
	const d = new Date(ts);
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
