import { performance } from "node:perf_hooks";
import { runActions } from "./actions.js";
import type { DeviceConfig, InstanceConfig } from "./config.js";
import { finalOn, finalValuesOf } from "./detector/index.js";
import type { DetectionSettings } from "./detector/types.js";
import type { ObjectWriter } from "./deviceObjects.js";
import { ensureDeviceObjects } from "./deviceObjects.js";
import { DeviceRuntime } from "./deviceRuntime.js";
import { fill, TEXT } from "./dmTexts.js";
import type { HistoryEnv } from "./historySource.js";
import { storedRunsOfHistory } from "./historyRuns.js";
import { findHistoryInstance, loadHistorySeries } from "./historySource.js";
import type { FileIO, MessageSink, NotifierHost, RuntimeEvent, RuntimeListener } from "./host.js";
import type { FinalEvent, GateResult, Hint, OptimizeContext, OptimizeOutcome } from "./learn/autoOptimize.js";
import type { QualityContext, Verdict } from "./learn/quality.js";
import { admitted, sameRun, verdictKey } from "./learn/quality.js";
import { applyVetoes, effectiveOf, gate, LOCK_MS, LOCK_RUNS, optimize } from "./learn/autoOptimize.js";
import { checkFinalSplit } from "./learn/finalLearn.js";
import { buildLayout } from "./learn/runs.js";
import type { LearningSuggestion } from "./learning.js";
import { LearningRecorder, recordingChecks, suggestType } from "./learning.js";
import type { Notifier } from "./notifier.js";
import { ReminderScheduler } from "./reminder.js";
import type { Capture } from "./runRecorder.js";
import { RunRecorder } from "./runRecorder.js";
import type { BaseBands } from "./learn/bands.js";
import type { FinalState, FinalSplitPair, PhaseTuneState, StoredRun, StoreFile } from "./runStore.js";
import {
	addRun,
	clearLearningData,
	convertRuns,
	decisionOf,
	detectionOf,
	emptyStore,
	finalSplitPairs,
	fitSize,
	joinedCapture,
	labelCapture,
	loadStore,
	markFinalResumed,
	markFinalSuspended,
	pushChange,
	recompute,
	reconcileBase,
	reconcileStore,
	refreshInfo,
	removeStore,
	saveStore,
	setDecision,
	startOf,
	splitCapture,
	storeSamples,
	typeHash,
	upgradeStore,
	WINDOW_MS,
} from "./runStore.js";
import { errorMessage } from "./utils.js";

interface Entry {
	runtime: DeviceRuntime;
	reminder: ReminderScheduler;
	recorder: LearningRecorder;
	/** Last message text delivered for the device (resolved end text after a finished run). */
	lastMessage: string;
	/** Automatic optimisation (null = off). */
	opt: OptEntry | null;
	/** The stored optimised values failed the check at load: not used until the optimisation ran again. */
	holdOverride?: boolean;
}

interface OptEntry {
	store: StoreFile;
	recorder: RunRecorder;
	/** Verdicts of the run check of the stored runs by key (computed again whenever the runs change). */
	verdicts?: ReadonlyMap<string, Verdict>;
}

/** Time budget of one optimisation job (active computing time, Spec D.3). */
const OPTIMIZE_BUDGET_MS = 30_000;
/** Jobs in a row stopped by the time budget before a warning (log, card; a message only with `optimizeNotify`). */
export const BUDGET_WARN_JOBS = 3;
/** A device not seen for longer than this reads the history of the outage (Spec D.2). */
const OUTAGE_MS = 60 * 60_000;
/** Most keys of runs judged afterwards that are remembered (`FinalState.checked`). */
const CHECKED_MAX = 20;

/** Changes that "undo" takes back (the last one of these). */
const UNDOABLE = new Set<string>(["repair", "tighten", "finalOn", "finalRepair", "finalTune"]);

/** Why the final phase is suspended. */
export type FinalSuspendReason = "finalSplit" | "earlyEnd";
/** Why the final phase is used again. */
export type FinalResumeReason = "user" | "newRun" | "repair" | "endOk" | "cleared";

/**
 * Learning data of a device: `full` with the automatic optimisation; `final` only for the final phase (the device
 * has a final phase but no automatic optimisation: runs are recorded and judged afterwards, the only change of the
 * values is the suspension, an override is never applied or computed); `off` without.
 */
type OptMode = "full" | "final" | "off";

/** Optional parts of the registry. */
export interface RegistryOptions {
	/** Language of the installation for messages (default English). */
	language?: () => string;
	/** History adapters: runs of the history are taken over when the automatic optimisation starts. */
	history?: HistoryEnv;
	/**
	 * Only for tests: called between the result of an optimisation and the check whether the base values changed
	 * meanwhile (without it nothing differs).
	 */
	beforeOptimizeWrite?: (deviceId: string) => Promise<void>;
	/** Time budget of one optimisation job in ms (active computing time, default 30 000; for tests). */
	budgetMs?: number;
	/** Clock of the time budget in ms (default `performance.now`; for tests). */
	clock?: () => number;
	/**
	 * Objects of the adapter: the states of a device are created again when the automatic optimisation switches its
	 * final phase on or off (`settlingUntil`, Spec 7.1). Without it the objects are left as they are.
	 */
	objects?: ObjectWriter;
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
	 * (same power state). A disabled device that needs a review is not run.
	 *
	 * @param deviceId - Device id below the namespace
	 * @param cfg - Normalized device configuration
	 */
	public async upsert(deviceId: string, cfg: DeviceConfig): Promise<void> {
		const existing = this.devices.get(deviceId);
		if (cfg.needsReview && !cfg.enabled) {
			if (existing) {
				await existing.runtime.dropSettling();
				this.disposeEntry(existing);
				this.devices.delete(deviceId);
			}
			this.host.log.warn(
				`Device ${cfg.name} not started: ${cfg.reviewHint ?? "values need a check"}. Check and save it in the device settings.`,
			);
			return;
		}
		if (existing) {
			if (existing.runtime.canKeepStateFor(cfg)) {
				if (!cfg.enabled) {
					// a disabled device does not continue a lock phase (also not after a restart)
					await existing.runtime.dropSettling();
				}
				const oldBase = existing.runtime.baseDetection;
				existing.runtime.updateConfig(cfg);
				await this.reconcileRuntime(existing, oldBase);
				await this.syncOptimize(deviceId, existing);
				this.applyStoredState(existing);
				await this.writeOptStates(deviceId, existing);
				return;
			}
			this.host.log.info(`Device ${cfg.name} reset: power state changed`);
			// the lock phase belonged to the old sensor
			await existing.runtime.dropSettling();
			this.disposeEntry(existing);
			this.devices.delete(deviceId);
		}

		const inst = this.getConfig();
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
		const runtime = new DeviceRuntime(this.host, deviceId, cfg, inst, sink, this);
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
		// the optimised values and the suspension of the final phase come with the learning data: a lock phase
		// active before the restart is continued only after they are loaded (no detection step until then)
		await runtime.init({ restoreLater: true });
		try {
			await this.host.setOwnState(`${deviceId}.learning.active`, false);
			await this.syncOptimize(deviceId, entry);
		} finally {
			await runtime.restore({ suspended: this.suspendedOf(entry) });
		}
	}

	/**
	 * Whether the final phase of a device is suspended according to its learning data (undefined: the learning
	 * data say nothing about it, the runtime keeps its state).
	 *
	 * @param entry - Entry
	 */
	private suspendedOf(entry: Entry): boolean | undefined {
		const final = entry.opt?.store.final;
		return final ? final.state === "suspended" : undefined;
	}

	/**
	 * Use the optimised values and the suspension of the final phase of the learning data (also when they were
	 * changed while the device kept running). The detector is rebuilt between two runs and lock phases.
	 *
	 * @param entry - Entry
	 */
	private applyStoredState(entry: Entry): void {
		const store = entry.opt?.store;
		if (!store) {
			return;
		}
		if (this.modeOf(entry.runtime.config) !== "full") {
			// "automatic optimisation off" means the values of the device; a stored override stays in the store
			entry.runtime.setOverride(null);
		} else if (!entry.holdOverride) {
			entry.runtime.setOverride(store.override);
		}
		const suspended = this.suspendedOf(entry);
		if (suspended !== undefined) {
			entry.runtime.setFinalSuspended(suspended);
		}
	}

	/**
	 * Optimised values of a device as far as known before it runs (from its learning data), so that the states of
	 * a final phase switched on only by the optimisation are not removed when the objects are created.
	 *
	 * @param deviceId - Device id
	 * @param cfg - Device configuration
	 */
	public async storedOverride(deviceId: string, cfg: DeviceConfig): Promise<Partial<DetectionSettings> | null> {
		const entry = this.devices.get(deviceId);
		if (entry) {
			return entry.runtime.currentOverride;
		}
		if (cfg.autoOptimize !== true || !this.files) {
			return null;
		}
		try {
			// read once more when the device starts: its messages come from there
			const quiet = { warn: (m: string) => this.host.log.debug(m), debug: (m: string) => this.host.log.debug(m) };
			return (await loadStore(this.files, deviceId, quiet))?.override ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * End a lock phase of a device for good (its configuration became unusable): `settlingUntil` goes to 0.
	 *
	 * @param deviceId - Device id
	 */
	public async clearSettling(deviceId: string): Promise<void> {
		await this.devices.get(deviceId)?.runtime.dropSettling();
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
				// a start the runtime misses is still recorded (activity above the end threshold and the run level)
				if (entry.opt) {
					const store = entry.opt.store;
					const runLevel = (store.tail?.runLimit ?? 0) / (store.unitFactor > 0 ? store.unitFactor : 1);
					entry.opt.recorder.setActivityLimit(Math.max(entry.runtime.effective.endVal, runLevel));
					store.lastSeenTs = this.host.now();
				}
				entry.runtime.setHoldBands(entry.opt?.store.bands ?? null);
				entry.runtime.setPhaseTune(this.phaseTuneOf(entry));
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
		const unitFactor = await this.unitFactorOf(cfg.powerId);
		const result = await suggestType(samples, inst.pollIntervalSec, {
			abort: cfg.abort,
			abortFixed: cfg.abortFixed,
			currentType: entry.runtime.baseDetection,
			unitFactor,
		});
		if (!("error" in result)) {
			const checks = recordingChecks(samples, inst.pollIntervalSec, unitFactor);
			if (checks.length > 0) {
				result.checks = checks;
			}
		}
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
		if (typeof ev === "object") {
			void runActions(this.host, cfg.actions, ev.edge === "start" ? "phaseStart" : "phaseEnd", ev.id);
			return;
		}
		switch (ev) {
			case "start":
				entry.reminder.onStarted();
				void runActions(this.host, cfg.actions, "start");
				break;
			case "end":
				entry.reminder.onFinished();
				void runActions(this.host, cfg.actions, "end");
				this.persistPending(entry);
				this.judgeAtEnd(deviceId, entry);
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
			const read = await loadStore(this.files, deviceId, this.host.log);
			if (read) {
				// for the display only, not saved
				upgradeStore(read);
			}
			return read;
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
	 * Exclude one stored run or false start (e.g. a run that was no normal use of the device): the decision is kept
	 * over the key of the run (also by "clear learning data" and a new import), the run is no longer replayed and the
	 * envelope is computed again without it.
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
		const run = [...store.runs, ...store.spikes].find(r => r.id === runId);
		if (!run || decisionOf(store, run.key)?.user === "exclude") {
			return false;
		}
		setDecision(store, run.key, "exclude");
		entry.opt!.verdicts = recompute(store, this.qualityContext(store));
		refreshInfo(store);
		await this.saveOpt(entry);
		await this.writeOptStates(deviceId, entry);
		this.host.log.info(`${entry.runtime.config.name}: stored run ${runId} discarded`);
		return true;
	}

	/**
	 * Write decisions of the user about runs (and, from the learning dialog, the runs of the dialog and the base
	 * bands) into the learning data, also without a loaded store: the file is read or created (the decisions are
	 * kept over the keys of the runs, also by "clear learning data"). Runs already stored (same start within 5 min)
	 * are not taken twice.
	 *
	 * @param deviceId - Device id
	 * @param decisions - Decision per run key (`null` removes the decision)
	 * @param runs - Runs of the dialog (`src: "history"`) as comparison data for the judgement afterwards
	 * @param bands - Base bands of the dialog (only used when the run check computes none)
	 * @param baseHash - Hash of the detection values of the device (for a file that is created)
	 */
	public setDecisions(
		deviceId: string,
		decisions: Record<string, "include" | "exclude" | null>,
		runs: StoredRun[] = [],
		bands?: BaseBands,
		baseHash = "",
	): Promise<void> {
		return this.serialized(() => this.setDecisionsNow(deviceId, decisions, runs, bands, baseHash));
	}

	private async setDecisionsNow(
		deviceId: string,
		decisions: Record<string, "include" | "exclude" | null>,
		runs: StoredRun[],
		bands: BaseBands | undefined,
		baseHash: string,
	): Promise<void> {
		const entry = this.devices.get(deviceId);
		const now = this.host.now();
		const apply = (store: StoreFile): void => {
			for (const [key, user] of Object.entries(decisions)) {
				setDecision(store, key, user);
			}
			const known = [...store.runs, ...store.spikes].map(r => verdictKey(store.deviceId, startOf(r)));
			for (const run of runs) {
				const key = verdictKey(store.deviceId, startOf(run));
				if (
					run.step !== store.step ||
					run.unitFactor !== store.unitFactor ||
					known.some(k => sameRun(k, key))
				) {
					continue;
				}
				addRun(store, run, { now, deferred: true });
				known.push(key);
			}
		};
		const opt = entry?.opt;
		if (entry && opt) {
			apply(opt.store);
			opt.verdicts = recompute(opt.store, this.qualityContext(opt.store));
			if (bands && !opt.store.bands) {
				opt.store.bands = bands;
			}
			fitSize(opt.store, now, opt.verdicts);
			refreshInfo(opt.store);
			await this.saveOpt(entry);
			await this.writeOptStates(deviceId, entry);
			return;
		}
		if (!this.files) {
			return;
		}
		try {
			const read = await loadStore(this.files, deviceId, this.host.log);
			const first = runs[0];
			const step = read?.step ?? first?.step ?? this.getConfig().pollIntervalSec * 1000;
			const unitFactor = read?.unitFactor ?? first?.unitFactor ?? 1;
			const store =
				read ?? emptyStore(deviceId, entry?.runtime.config.template ?? "", baseHash, step, unitFactor);
			upgradeStore(store);
			apply(store);
			const verdicts = recompute(store, this.qualityContext(store));
			if (bands && !store.bands) {
				store.bands = bands;
			}
			fitSize(store, now, verdicts);
			refreshInfo(store);
			await saveStore(this.files, store);
		} catch (err) {
			this.host.log.warn(`Cannot write the decisions about the runs of ${deviceId}: ${errorMessage(err)}`);
		}
	}

	/**
	 * "Clear learning data" (P26): runs, optimised values and changes go; the decisions of the user about runs stay
	 * unless `keepDecisions` is false.
	 *
	 * @param deviceId - Device id
	 * @param keepDecisions - Keep the decisions of the user
	 */
	public deleteLearningData(deviceId: string, keepDecisions = true): Promise<void> {
		return this.serialized(() => this.clearLearningDataNow(deviceId, keepDecisions));
	}

	/**
	 * Remove the learning data of a deleted device with its decisions, so that a new device with the same id starts
	 * empty.
	 *
	 * @param deviceId - Device id
	 */
	public removeLearningData(deviceId: string): Promise<void> {
		return this.serialized(() => this.clearLearningDataNow(deviceId, false));
	}

	private async clearLearningDataNow(deviceId: string, keepDecisions: boolean): Promise<void> {
		const entry = this.devices.get(deviceId);
		let kept: StoreFile | null = null;
		if (entry?.opt) {
			const cfg = entry.runtime.config;
			entry.runtime.setOverride(null);
			// the split runs go with the learning data: the final phase is used again
			entry.runtime.setFinalSuspended(false);
			const cleared = clearLearningData(entry.opt.store, keepDecisions);
			cleared.typeId = cfg.template ?? "";
			cleared.typeHash = typeHash(entry.runtime.baseDetection);
			entry.opt.store = cleared;
			entry.opt.verdicts = new Map();
			kept = cleared;
			this.driftReported.delete(entry);
			await this.writeOptStates(deviceId, entry);
			if (this.opts.history) {
				// an empty store reads the history again (Spec D.2); the decisions kept apply over the keys
				this.enqueue(deviceId, () => this.bootstrapFromHistory(deviceId));
			}
		} else if (keepDecisions && this.files) {
			const read = await this.readLearningData(deviceId);
			kept = read ? clearLearningData(read, true) : null;
		}
		if (!this.files) {
			return;
		}
		try {
			// both slots go first: the older one would otherwise come back if the new file cannot be read
			await removeStore(this.files, deviceId);
			if (kept && Object.keys(kept.verdicts).length > 0) {
				await saveStore(this.files, kept);
			}
		} catch (err) {
			this.host.log.warn(`Cannot delete the learning data of ${deviceId}: ${errorMessage(err)}`);
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
		// a change of the base values (also adopting) ends what can be undone: an older override belongs to other
		// base values
		// suspending and using the final phase again change no values; undoing "switched on" switches it off
		const last = [...store.changes]
			.reverse()
			.find(c => !["undo", "reset", "finalSuspend", "finalResume"].includes(c.kind));
		if (!last || !UNDOABLE.has(last.kind)) {
			return false;
		}
		const wasOn = finalOn(entry.runtime.effective);
		this.setOverrideByUser(entry, store, last.from, "undo", "undo of the last change");
		await this.saveOpt(entry);
		await this.syncFinalObjects(deviceId, entry, wasOn);
		await this.writeOptStates(deviceId, entry);
		this.host.log.info(`${entry.runtime.config.name}: last optimisation undone`);
		return true;
	}

	/**
	 * Back to the detection values of the device (locks the tightening for 14 days).
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
		const wasOn = finalOn(entry.runtime.effective);
		this.setOverrideByUser(entry, store, null, "reset", "reset to the detection values of the device");
		await this.saveOpt(entry);
		await this.syncFinalObjects(deviceId, entry, wasOn);
		await this.writeOptStates(deviceId, entry);
		this.host.log.info(
			`${entry.runtime.config.name}: optimised values reset to the detection values of the device`,
		);
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
		delete store.job;
		if (kind === "reset") {
			delete store.phaseTune;
			delete store.checks;
		}
		store.lockUntilTs = now + LOCK_MS;
		store.lockRuns = LOCK_RUNS;
		store.lastChangeTs = now;
		store.newSinceChange = 0;
		store.failStreak = 0;
		store.info.status = "locked";
		entry.runtime.setOverride(override);
		entry.runtime.setPhaseTune(this.phaseTuneOf(entry));
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
	 * Compare the changed base values of a running device with its learning data (at runtime, also while the
	 * learning data is loaded): base values that equal the values in use with the old override ("adopt as base
	 * values") drop the override without loss, any other change drops it. The detector is rebuilt between two runs.
	 *
	 * @param entry - Entry
	 * @param oldBase - Base values before the change
	 */
	private async reconcileRuntime(entry: Entry, oldBase: DetectionSettings): Promise<void> {
		const store = entry.opt?.store;
		if (!store || entry.runtime.config.autoOptimize !== true) {
			return;
		}
		const hadOverride = store.override !== null;
		const kind = reconcileBase(
			store,
			typeHash(entry.runtime.baseDetection),
			typeHash(effectiveOf(oldBase, store.override)),
			this.host.now(),
		);
		if (kind === "none") {
			return;
		}
		refreshInfo(store);
		entry.runtime.setOverride(store.override);
		await this.saveOpt(entry);
		if (kind === "adopted") {
			this.host.log.info(`${entry.runtime.config.name}: values in use adopted as base values`);
		} else if (hadOverride) {
			await this.notifyOptimization(entry, TEXT.optBaseChanged, {});
		}
	}

	/**
	 * What the learning data of a device are kept for (`OptMode`).
	 *
	 * @param cfg - Device configuration
	 */
	private modeOf(cfg: DeviceConfig): OptMode {
		if (!this.files) {
			return "off";
		}
		if (cfg.autoOptimize === true) {
			return "full";
		}
		return finalOn(detectionOf(cfg.detection)) ? "final" : "off";
	}

	/**
	 * Start or stop the automatic optimisation of a device (or the learning data of its final phase) according to
	 * its configuration.
	 *
	 * @param deviceId - Device id
	 * @param entry - Entry
	 */
	private async syncOptimize(deviceId: string, entry: Entry): Promise<void> {
		const cfg = entry.runtime.config;
		const mode = this.modeOf(cfg);
		if (mode === "off") {
			if (entry.opt) {
				entry.runtime.attachRecorder(null);
				entry.runtime.setOverride(null);
				// the suspension belongs to the learning data: they are read again when the final phase comes back
				// (also cleared meanwhile), a mask kept here would outlive them
				entry.runtime.setFinalSuspended(false);
				entry.opt = null;
				await this.host.setOwnState(`${deviceId}.learning.optimized`, false);
				await this.host.setOwnState(`${deviceId}.learning.optimizeInfo`, JSON.stringify({ status: "off" }));
			}
			return;
		}
		if (entry.opt || !this.files) {
			if (entry.opt && mode !== "full") {
				entry.runtime.setOverride(null);
			}
			return;
		}
		const full = mode === "full";
		const inst = this.getConfig();
		const step = inst.pollIntervalSec * 1000;
		const unitFactor = await this.unitFactorOf(cfg.powerId);
		const type = entry.runtime.baseDetection;
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
		const store = loaded ?? emptyStore(deviceId, cfg.template ?? "", typeHash(type), step, unitFactor);
		// learning data of an earlier version: envelope frozen, runs segmented again, keys
		const upgraded = upgradeStore(store, effectiveOf(type, store.override).endVal * unitFactor);
		for (const msg of upgraded) {
			this.host.log.info(`${cfg.name}: ${msg}`);
		}
		const hadOverride = store.override !== null;
		// an adoption whose learning data was not saved any more (instance stopped in between): the stored override
		// is already part of the new base values; only for the final phase the override stays untouched
		const base = full
			? reconcileBase(store, typeHash(type), typeHash(effectiveOf(type, store.override)), now)
			: "none";
		if (base === "adopted") {
			this.host.log.info(`${cfg.name}: values in use adopted as base values`);
		}
		const converted = store.step !== step || store.unitFactor !== unitFactor;
		const msgs = full
			? reconcileStore(store, typeHash(type), step, unitFactor, now)
			: convertRuns(store, step, unitFactor);
		for (const msg of msgs) {
			this.host.log.info(`${cfg.name}: ${msg}`);
		}
		refreshInfo(store);
		// the run check of the stored runs (also for learning data of the current version: the stages are computed
		// again at every evaluation)
		const verdicts =
			upgraded.length > 0 || converted || store.runs.length + store.spikes.length > 0
				? recompute(store, this.qualityContext(store))
				: new Map<string, Verdict>();
		// the history is read once (also when it held no runs); older learning data with runs is not read again
		const wantHistory = store.historyReadTs === undefined && store.runs.length + store.spikes.length === 0;
		// after an outage of more than an hour: the history of the outage (at most 30 days)
		const lastSeen = store.lastSeenTs ?? lastSeenOf(store);
		const outageFrom =
			!wantHistory && lastSeen > 0 && now - lastSeen > OUTAGE_MS ? Math.max(lastSeen, now - WINDOW_MS) : null;
		if (base === "baseChanged" && hadOverride) {
			await this.notifyOptimization(entry, TEXT.optBaseChanged, {});
		}
		const recorder = new RunRecorder(step, unitFactor);
		entry.opt = { store, recorder, verdicts };
		entry.holdOverride = false;
		entry.runtime.attachRecorder(recorder);
		if (!full) {
			entry.runtime.setOverride(null);
		} else if (store.override) {
			const g = await gate(store, effectiveOf(type, store.override), this.optimizeContext(entry));
			if (g.ok) {
				entry.runtime.setOverride(store.override);
			} else {
				entry.holdOverride = true;
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
		if (wantHistory && this.opts.history) {
			this.enqueue(deviceId, () => this.bootstrapFromHistory(deviceId));
		} else if (outageFrom !== null && this.opts.history) {
			this.enqueue(deviceId, () => this.bootstrapFromHistory(deviceId, outageFrom));
		}
	}

	/**
	 * Take over the runs of the history (Spec D.2): when the automatic optimisation starts without learning data (also
	 * after "clear learning data"), and after an outage of more than an hour only for the outage. Every run and false
	 * start of the history is replayed with the current values to get the events the runtime would have seen, then
	 * labelled and stored like a recorded run; runs already stored (live or history, within 5 min) or being recorded
	 * are not taken twice, and the decisions of the user apply over the keys.
	 *
	 * @param deviceId - Device id
	 * @param from - Only from this time on (outage); default: the whole history
	 */
	private async bootstrapFromHistory(deviceId: string, from?: number): Promise<void> {
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
			loadedHistory = await loadHistorySeries(env, instance, cfg.powerId, this.host.now(), poll, undefined, from);
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
		const now = this.host.now();
		const layout = buildLayout(series, { keepAbove: eff.endVal * factor, maxRuns: Number.POSITIVE_INFINITY });
		let runs = 0;
		let spikes = 0;
		const known = [...store.runs, ...store.spikes].map(r => r.key);
		const open = opt.recorder.snapshot();
		const recording = open ? { from: open.t0, to: open.t0 + open.cells.length * open.stepMs } : null;
		const found = await storedRunsOfHistory(series, layout, {
			eff,
			abort: cfg.abort,
			abortFixed: cfg.abortFixed,
			pollSec: poll,
			unitFactor: factor,
			skip: startMs => {
				const key = verdictKey(store.deviceId, startMs);
				return (
					known.some(k => k === key || sameRun(k, key)) ||
					(recording !== null && startMs >= recording.from && startMs <= recording.to)
				);
			},
			yieldFn: () => this.yieldNow(),
		});
		for (const run of found) {
			addRun(store, run, { now, deferred: true });
			if (run.label === "spike") {
				spikes++;
			} else {
				runs++;
			}
		}
		if (entry.opt !== opt || this.devices.get(deviceId) !== entry) {
			return;
		}
		store.historyReadTs ??= now;
		store.lastSeenTs = Math.max(store.lastSeenTs ?? 0, now);
		if (runs + spikes === 0) {
			// the file marks the history as read, so it is not loaded again at every start
			await this.saveOpt(entry);
			return;
		}
		opt.verdicts = recompute(store, this.qualityContext(store));
		fitSize(store, now, opt.verdicts);
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
	 * Context of the run check for the stored runs of a device (live recordings, one sample per run).
	 *
	 * @param store - Store
	 */
	private qualityContext(store: StoreFile): QualityContext {
		return {
			bands: store.bands ?? null,
			unitFactor: store.unitFactor,
			unit: store.unitFactor === 1000 ? "kW" : "W",
			settings: null,
			pollMs: store.step,
			outages: [],
			scope: "run",
		};
	}

	/**
	 * Context of an optimisation job.
	 *
	 * @param entry - Entry
	 */
	private optimizeContext(entry: Entry): OptimizeContext {
		const cfg = entry.runtime.config;
		return {
			type: entry.runtime.baseDetection,
			pollSec: this.getConfig().pollIntervalSec,
			abort: cfg.abort,
			abortFixed: cfg.abortFixed,
			yieldFn: () =>
				new Promise<void>(resolve => {
					this.host.setTimeout(resolve, 0);
				}),
			now: this.host.now(),
			budgetMs: this.opts.budgetMs ?? OPTIMIZE_BUDGET_MS,
			clock: this.opts.clock ?? (() => performance.now()),
			...(cfg.phases?.enabled ? { phases: cfg.phases } : {}),
			...(entry.opt?.verdicts ? { verdicts: entry.opt.verdicts } : {}),
			finalSuspended: entry.opt?.store.final?.state === "suspended",
			...(entry.opt ? { quality: this.qualityContext(entry.opt.store) } : {}),
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
		const keepAboveW = entry.runtime.effective.endVal * cap.unitFactor;
		store.pending = null;
		let stored = false;
		let endDelaySec: number | null = null;
		// two real runs shortly one after the other, or a run after an early end, are stored as runs of their own
		for (const part of splitCapture(cap)) {
			const res = labelCapture(part.capture, keepAboveW, "live", { followed: part.followed });
			if (res.label === "unclear" || !res.run) {
				store.info.unclear++;
			} else {
				const run = res.run;
				addRun(store, run, {
					ctx: this.qualityContext(store),
					now: this.host.now(),
					onVerdicts: v => {
						opt.verdicts = v;
						// a merged run (two runs grown together) is no detection error (decision 9)
						if (run.label === "split" && v.get(run.key)?.reasons.some(x => x.code === "merged")) {
							run.label = "run";
						}
					},
				});
				stored = true;
				if (res.trusted) {
					store.newSinceChange++;
					store.lockRuns = Math.max(0, store.lockRuns - 1);
				}
			}
			endDelaySec = res.endDelaySec ?? endDelaySec;
		}
		if (endDelaySec !== null) {
			store.info.lastEndDelaySec = endDelaySec;
			await this.host.setOwnState(`${deviceId}.learning.lastEndDelay`, endDelaySec);
		}
		refreshInfo(store);
		await this.saveOpt(entry);
		// a run after an early end that was not judged at its end yet (e.g. restart in between)
		if (this.unjudged(store, this.splitPairsOf(store, cap)).length > 0) {
			this.enqueue(deviceId, () => this.judgeSplits(deviceId, cap));
		}
		if (stored) {
			this.enqueueOptimize(deviceId);
		} else {
			await this.writeOptStates(deviceId, entry);
		}
	}

	/**
	 * At the end of a run: judge a run after an early end of the final phase on a snapshot of the open capture
	 * (Spec A.3 "Beurteilung im Nachhinein"), so that a programme started meanwhile already meets the suspended final
	 * phase. The capture is stored later as usual; the judgement is not repeated then.
	 *
	 * @param deviceId - Device id
	 * @param entry - Entry
	 */
	private judgeAtEnd(deviceId: string, entry: Entry): void {
		const opt = entry.opt;
		const snap = opt?.recorder.snapshot();
		if (!opt || !snap || this.unjudged(opt.store, this.splitPairsOf(opt.store, snap)).length === 0) {
			return;
		}
		this.enqueue(deviceId, () => this.judgeSplits(deviceId, snap));
	}

	/**
	 * Runs of a capture that started after an early end, each with its early part; the early part may be the stored
	 * run before the capture (a rest of more than 30 quiet minutes closed its capture, `joinedCapture`).
	 *
	 * @param store - Store
	 * @param cap - Capture or snapshot of the open capture
	 */
	private splitPairsOf(store: StoreFile, cap: Capture): FinalSplitPair[] {
		const own = finalSplitPairs(cap, store.deviceId);
		const joined = joinedCapture(store, cap);
		if (!joined) {
			return own;
		}
		return [...own, ...finalSplitPairs(joined, store.deviceId).filter(p => !own.some(o => o.key === p.key))];
	}

	/**
	 * Runs after an early end that were not judged yet.
	 *
	 * @param store - Store
	 * @param pairs - Runs after an early end with their early part
	 */
	private unjudged(store: StoreFile, pairs: FinalSplitPair[]): FinalSplitPair[] {
		const known = [...(store.final?.checked ?? []), ...(store.final?.splits ?? [])];
		return pairs.filter(p => !known.some(k => k === p.key || sameRun(k, p.key)));
	}

	/**
	 * Judge the runs of a capture that started after an early end (`checkFinalSplit`): if the run is the rest of the
	 * split programme, the final phase is suspended (also without the automatic optimisation). Comparison data are
	 * the stored runs admitted for the final phase and the base bands; without them only the rest between the parts
	 * counts (Task 16).
	 *
	 * @param deviceId - Device id
	 * @param cap - Capture or snapshot of the open capture
	 */
	private async judgeSplits(deviceId: string, cap: Capture): Promise<void> {
		const entry = this.devices.get(deviceId);
		const store = entry?.opt?.store;
		if (!entry || !store) {
			return;
		}
		const pairs = this.unjudged(store, this.splitPairsOf(store, cap));
		if (pairs.length === 0) {
			return;
		}
		const ctx = this.qualityContext(store);
		const clean = storeSamples(store, ctx)
			// a start after exit a (the inner detector ended the lock phase) is an ordinary run
			.filter(
				x => x.sample.kind === "run" && (x.sample.afterFinal ?? "a") === "a" && admitted(x.verdict, "final"),
			)
			.map(x => x.sample);
		const restVal = finalValuesOf(entry.runtime.effective, this.getConfig().pollIntervalSec).finalRestVal;
		const final = this.finalOf(entry, store);
		for (const p of pairs) {
			final.checked = [...(final.checked ?? []), p.key].slice(-CHECKED_MAX);
			if (checkFinalSplit(p.prev, p.next, clean, store.bands ?? null, restVal)) {
				await this.suspendFinalNow(deviceId, "finalSplit", p.key);
			}
		}
		await this.saveOpt(entry);
		await this.writeOptStates(deviceId, entry);
	}

	/**
	 * State of the final phase in the store, created if missing (`on`/`off` from the values in use).
	 *
	 * @param entry - Entry
	 * @param store - Store
	 */
	private finalOf(entry: Entry, store: StoreFile): FinalState {
		store.final ??= { state: finalOn(entry.runtime.effective) ? "on" : "off", splits: [], suspendedAt: 0 };
		return store.final;
	}

	/**
	 * Suspend the final phase of a device (Spec A.3, D.3 point 3): only a mask of the values the detector is built
	 * with, kept in the store until it is used again. Log warning, `optimizeInfo.finalState`, change entry and the
	 * warning on the card; a message to the recipients only with `optimizeNotify`.
	 *
	 * @param deviceId - Device id
	 * @param reason - `finalSplit` (judged afterwards) or `earlyEnd` (early end when an admitted run was replayed)
	 * @param key - Key of the run that caused it
	 */
	public suspendFinal(deviceId: string, reason: FinalSuspendReason, key: string): Promise<void> {
		return this.serialized(async () => {
			await this.suspendFinalNow(deviceId, reason, key);
		});
	}

	private async suspendFinalNow(deviceId: string, reason: FinalSuspendReason, key: string): Promise<boolean> {
		const entry = this.devices.get(deviceId);
		const store = entry?.opt?.store;
		if (!entry || !store) {
			return false;
		}
		const was = markFinalSuspended(store, reason, key, this.host.now(), finalOn(entry.runtime.effective));
		entry.runtime.setFinalSuspended(true);
		await this.saveOpt(entry);
		await this.writeOptStates(deviceId, entry);
		if (!was) {
			this.host.log.warn(`${entry.runtime.config.name}: final phase suspended (${reason})`);
			await this.sendOptimization(entry, TEXT.finalSuspended, {});
		}
		return true;
	}

	/**
	 * Use the suspended final phase again (Spec A.3 point 6, D.5, D.7). With `newRun` (the user confirmed that the
	 * run after the early end was a new run) only the key of that run is removed, and the final phase is used again
	 * only when no other split run is left; the other reasons clear all split runs.
	 *
	 * @param deviceId - Device id
	 * @param why - Reason
	 * @param key - Key of the run (needed with `newRun`)
	 * @returns whether the final phase is used again
	 */
	public resumeFinal(deviceId: string, why: FinalResumeReason, key?: string): Promise<boolean> {
		return this.serialized(() => this.resumeFinalNow(deviceId, why, key));
	}

	private async resumeFinalNow(deviceId: string, why: FinalResumeReason, key?: string): Promise<boolean> {
		const entry = this.devices.get(deviceId);
		const store = entry?.opt?.store;
		const final = store?.final;
		if (!entry || !store || !final || (why === "newRun" && !key)) {
			return false;
		}
		const left =
			why === "newRun" ? final.splits.filter(k => k !== key && !sameRun(k, key ?? "")) : ([] as string[]);
		final.splits = left;
		if (why === "newRun" && final.joined) {
			// a new run: no rest of a split programme, not replayed with its early part
			final.joined = final.joined.filter(k => k !== key && !sameRun(k, key ?? ""));
		}
		if (left.length > 0 || final.state !== "suspended") {
			await this.saveOpt(entry);
			await this.writeOptStates(deviceId, entry);
			return false;
		}
		markFinalResumed(store, why, this.host.now(), finalOn(entry.runtime.effective), key);
		entry.runtime.setFinalSuspended(false);
		await this.saveOpt(entry);
		await this.writeOptStates(deviceId, entry);
		this.host.log.info(`${entry.runtime.config.name}: final phase used again (${why})`);
		if (why === "repair" || why === "endOk") {
			await this.sendOptimization(entry, TEXT.finalResumed, {});
		}
		return true;
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
		const store = opt.store;
		if (this.modeOf(entry.runtime.config) !== "full") {
			// only the final phase: run check and judgement afterwards, no repair, no tightening
			await this.saveOpt(entry);
			await this.writeOptStates(deviceId, entry);
			return;
		}
		const trailerBefore = store.info.trailer;
		opt.verdicts ??= recompute(store, this.qualityContext(store));
		const ctx = this.optimizeContext(entry);
		const baseHash = typeHash(ctx.type);
		// the job works on a copy, so that a result computed from old base values is never written (G13)
		const fork = forkStore(store);
		const outcome = await optimize(fork.work, ctx);
		await this.opts.beforeOptimizeWrite?.(deviceId);
		if (entry.opt !== opt || opt.store !== store || this.devices.get(deviceId) !== entry) {
			return;
		}
		if (typeHash(entry.runtime.baseDetection) !== baseHash || store.typeHash !== baseHash) {
			this.host.log.info(
				`${entry.runtime.config.name}: base values changed during the optimisation, result discarded`,
			);
			return;
		}
		const wasOn = finalOn(entry.runtime.effective);
		mergeFork(store, fork);
		applyVetoes(store, outcome, ctx.now);
		entry.holdOverride = false;
		entry.runtime.setOverride(store.override);
		if (store.final) {
			entry.runtime.setFinalSuspended(store.final.state === "suspended");
		}
		await this.saveOpt(entry);
		await this.syncFinalObjects(deviceId, entry, wasOn);
		await this.writeOptStates(deviceId, entry);
		entry.runtime.setPhaseTune(this.phaseTuneOf(entry));
		await this.reportHints(entry, outcome.hints);
		await this.reportOutcome(entry, outcome);
		await this.reportFinal(entry, outcome.final);
		await this.reportPhases(entry, outcome.phases);
		if (outcome.interrupted && store.info.budget === BUDGET_WARN_JOBS) {
			await this.notifyOptimization(entry, TEXT.optTooSlow, { jobs: BUDGET_WARN_JOBS }, "warn");
		}
		if (store.info.trailer === "notSeparable" && trailerBefore !== "notSeparable") {
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
				this.host.log.warn(
					`${entry.runtime.config.name}: no values detect every admitted run, keeping the current values`,
				);
				await this.sendOptimization(entry, TEXT.optCannotCover, {});
				break;
			case "drift":
				if (!this.driftReported.has(entry)) {
					this.driftReported.add(entry);
					await this.notifyOptimization(entry, TEXT.optDrift, {}, "warn");
				}
				break;
			case "budget":
				this.host.log.debug(
					`${entry.runtime.config.name}: optimisation stopped by the time budget, it goes on with the next run`,
				);
				break;
			default:
				break;
		}
	}

	/**
	 * Fine tuning of the phases a device uses: only with the automatic optimisation on (like the optimised values).
	 *
	 * @param entry - Entry
	 */
	private phaseTuneOf(entry: Entry): PhaseTuneState | null {
		return this.modeOf(entry.runtime.config) === "full" ? (entry.opt?.store.phaseTune ?? null) : null;
	}

	/**
	 * Log (and optionally send) what the phase fine tuning did (Spec D.6): new limits in use (log only), a new phase
	 * found (hint, a message to the recipients only with `optimizeNotify`).
	 *
	 * @param entry - Entry
	 * @param events - Events
	 */
	private async reportPhases(entry: Entry, events: OptimizeOutcome["phases"]): Promise<void> {
		for (const ev of events) {
			if (ev === "tuned") {
				this.host.log.info(`${entry.runtime.config.name}: limits of the phases fine-tuned`);
			} else {
				await this.notifyOptimization(entry, TEXT.phaseNewPattern, {});
			}
		}
	}

	/**
	 * Log (and optionally send) what the optimisation did with the final phase (Spec D.5): switched on, adjusted,
	 * suspended, repaired, used again or still suspended. Messages to the recipients only with `optimizeNotify`.
	 *
	 * @param entry - Entry
	 * @param events - Events in order
	 */
	private async reportFinal(entry: Entry, events: readonly FinalEvent[]): Promise<void> {
		const name = entry.runtime.config.name;
		const runs = entry.opt ? entry.opt.store.runs.length + entry.opt.store.spikes.length : 0;
		for (const ev of events) {
			const changes = ev.change?.reason ?? "";
			switch (ev.kind) {
				case "on":
					await this.notifyOptimization(entry, TEXT.optFinalOn, {
						changes,
						runs,
						gain: formatMinutes(ev.change?.gainSec ?? 0),
					});
					break;
				case "tuned":
					await this.notifyOptimization(entry, TEXT.optFinalTuned, { changes, runs });
					break;
				case "suspended":
					this.host.log.warn(`${name}: final phase suspended (${ev.reason ?? ""})`);
					await this.sendOptimization(entry, TEXT.finalSuspended, {});
					break;
				case "repaired": {
					const run = entry.opt?.store.runs.find(r => r.key === ev.key);
					await this.notifyOptimization(entry, TEXT.optFinalRepaired, {
						changes,
						date: formatDate(run ? run.ts + run.seg.startIdx * run.step : this.host.now()),
					});
					break;
				}
				case "resumed":
					this.host.log.info(`${name}: final phase used again (${ev.reason ?? ""})`);
					if (ev.reason === "endOk") {
						await this.sendOptimization(entry, TEXT.finalResumed, {});
					}
					break;
				case "stays":
					this.host.log.info(
						ev.reason === "notStored"
							? `${name}: final phase stays suspended until the split run is stored`
							: `${name}: final phase stays suspended: no values of the final phase detect every admitted run`,
					);
					break;
			}
		}
	}

	/**
	 * Create the states of a device again when its final phase was switched on or off by the values in use
	 * (`settlingUntil` exists only with an active final phase, Spec 7.1); a suspension changes nothing.
	 *
	 * @param deviceId - Device id
	 * @param entry - Entry
	 * @param wasOn - Whether the values in use had a final phase before
	 */
	private async syncFinalObjects(deviceId: string, entry: Entry, wasOn: boolean): Promise<void> {
		const objects = this.opts.objects;
		if (!objects || finalOn(entry.runtime.effective) === wasOn) {
			return;
		}
		try {
			await ensureDeviceObjects(
				objects,
				deviceId,
				entry.runtime.config,
				this.getConfig(),
				entry.runtime.currentOverride,
			);
		} catch (err) {
			this.host.log.warn(`Cannot update the states of ${entry.runtime.config.name}: ${errorMessage(err)}`);
		}
	}

	/**
	 * Hints about runs in quarantine that the values in use do not detect correctly (Spec B.3), each run once: always
	 * a log warning (for a reason that can be a real programme also `optimizeInfo.review` and the card), a message to
	 * the recipients only with `optimizeNotify`.
	 *
	 * @param entry - Entry
	 * @param hints - New hints
	 */
	private async reportHints(entry: Entry, hints: readonly Hint[]): Promise<void> {
		for (const h of hints) {
			await this.notifyOptimization(
				entry,
				h.kind === "use" ? TEXT.reviewUse : TEXT.reviewBroken,
				{ date: formatDate(h.ts) },
				"warn",
			);
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
		this.host.log[level](fill(text, "en", { device: entry.runtime.config.name, ...vars }));
		await this.sendOptimization(entry, text, vars);
	}

	/**
	 * Send a message of the automatic optimisation to the recipients of the device, only if it wants them
	 * (`optimizeNotify`), in the language of the installation; nothing is logged.
	 *
	 * @param entry - Entry
	 * @param text - Text with the placeholders `{device}` and `vars`
	 * @param vars - Values of the placeholders
	 */
	private async sendOptimization(
		entry: Entry,
		text: ioBroker.Translated,
		vars: Record<string, string | number>,
	): Promise<void> {
		const cfg = entry.runtime.config;
		const all = { device: cfg.name, ...vars };
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
		const runtime = entry.runtime;
		// only "suspended" is a kept state; on and off follow the values in use
		const on = finalOn(runtime.effective);
		if (store.final && store.final.state !== "suspended") {
			store.final.state = on ? "on" : "off";
		}
		store.info.finalState = store.final?.state === "suspended" ? "suspended" : on ? "on" : "off";
		await this.host.setOwnState(`${deviceId}.learning.optimized`, runtime.currentOverride !== null);
		await this.host.setOwnState(
			`${deviceId}.learning.parameters`,
			JSON.stringify({
				base: effectiveOf(runtime.baseDetection, null),
				override: store.override,
				effective: runtime.effective,
				active: runtime.active,
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

/** Working copy of a store for one optimisation job. */
interface StoreFork {
	/** Copy the job works on (`info` and `changes` are copied, everything else is shared). */
	work: StoreFile;
	/** Top-level values of the store when the job started. */
	start: StoreFile;
}

/**
 * Working copy of a store for an optimisation job. The job may assign top-level fields, change `info` and append
 * to `changes`; nested data such as the runs is shared and must not be changed in place by the job (the engine
 * tests check this with `optimizeShared`).
 *
 * @param store - Store
 */
function forkStore(store: StoreFile): StoreFork {
	return {
		work: { ...store, info: { ...store.info }, changes: [...store.changes] },
		start: { ...store, info: { ...store.info } },
	};
}

/**
 * Write back what an optimisation job changed in its working copy. Only the fields the job changed are written, so
 * that runs stored meanwhile (and their counters) stay.
 *
 * @param store - Store
 * @param fork - Working copy and start values
 */
function mergeFork(store: StoreFile, fork: StoreFork): void {
	const { work, start } = fork;
	const changed = (dst: object, src: object, was: object): void => {
		const d = dst as Record<string, unknown>;
		const s = src as Record<string, unknown>;
		const w = was as Record<string, unknown>;
		for (const key of new Set([...Object.keys(s), ...Object.keys(w)])) {
			if (key === "info" || key === "changes" || s[key] === w[key]) {
				continue;
			}
			if (key in s) {
				d[key] = s[key];
			} else {
				// removed by the job (e.g. the progress of a step that is done)
				delete d[key];
			}
		}
	};
	changed(store, work, start);
	changed(store.info, work.info, start.info);
	if (work.changes.length !== start.changes.length || work.changes.at(-1) !== start.changes.at(-1)) {
		store.changes = work.changes;
	}
	refreshInfo(store);
}

/**
 * Time a store was last in use, for learning data without `lastSeenTs` (V4): the end of the newest run, of the
 * capture of a run in progress, the last check and the last change; 0 for an empty store.
 *
 * @param store - Store
 */
function lastSeenOf(store: StoreFile): number {
	const endOf = (r: StoredRun): number => r.ts + ((r.seg.trailerTo ?? r.seg.runEndIdx) + 1) * r.step;
	const pending = store.pending ? store.pending.t0 + store.pending.cells.length * store.pending.stepMs : 0;
	return Math.max(
		0,
		...[...store.runs, ...store.spikes].map(endOf),
		pending,
		store.info.lastCheckTs ?? 0,
		store.changes.at(-1)?.ts ?? 0,
	);
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
