import * as I18n from "@iobroker/adapter-core/i18n";
import type { DeviceConfig, InstanceConfig } from "./config.js";
import { createDetector, finalOn, finalValuesOf, TrailerFilter } from "./detector/index.js";
import type {
	DetectionSettings,
	Detector,
	FinalExit,
	FinalSettings,
	FinalStats,
	TickResult,
} from "./detector/types.js";
import { renderHistoryHtml } from "./historyHtml.js";
import type { DeviceHost, MessageSink, RuntimeEvent, RuntimeListener } from "./host.js";
import type { BaseBands } from "./learn/bands.js";
import { PHASE_NOTIFY_MIN_MS, PHASES_CONTINUOUS_MS, PHASES_MAX, systemPhaseNames } from "./phases/model.js";
import { PhaseTracker, phaseHolds } from "./phases/tracker.js";
import type { PhaseEdge } from "./phases/tracker.js";
import type { CaptureEvent, RunRecorder } from "./runRecorder.js";
import { detectionOf, typeHash } from "./runStore.js";
import { errorMessage, formatDuration, formatTimestamp, parseNumber } from "./utils.js";

export type { DeviceHost, MessageSink, RuntimeEvent, RuntimeListener } from "./host.js";
export { renderHistoryHtml } from "./historyHtml.js";

/** Maximum number of entries in `lastOperations`. */
const MAX_OPERATIONS = 14;

interface Operation {
	start: string;
	end: string;
	runtime: string;
}

function isTrue(val: unknown): boolean {
	return val === true || val === 1 || val === "true" || val === "1";
}

/** Exits of the lock phase, in the order of the counters. */
const EXITS: readonly FinalExit[] = ["a", "b", "c", "d", "e", "f", "g"];

/** Auto-off after an activity exit of the lock phase that no start followed yet (Spec A.3 "AutoOff"). */
interface AutoOffWait {
	/** End of the check window after the exit: without a start the auto-off starts then. */
	until: number;
	/** Since when the power is below the rest level (rest proof), or null. */
	restSince: number | null;
}

/**
 * Runtime of one configured device: feeds power values into the detector and turns its events
 * into states, messages, auto-off and lifecycle events.
 */
export class DeviceRuntime {
	private cfg: DeviceConfig;
	private detector: Detector;
	/** Detection mode the detector was built with (time-based modes are also fed with every new value). */
	private detectorMode: DetectionSettings["mode"] = "count";
	/** Final phase values the detector was built with (0 replaced, floors applied), or null without a final phase. */
	private detectorFinal: Required<FinalSettings> | null = null;
	/** Number of detector builds. */
	private builds = 0;
	/** Rebuild the detector as soon as no run and no lock phase is active. */
	private rebuildPending = false;
	/** Whether the detector was in the lock phase after the last step. */
	private wasSettling = false;
	/** Counters of the final phase when the lock phase began (to find the exit). */
	private exitBase: FinalStats | null = null;
	/** Last known value of the state `settlingUntil` (0 = no lock phase). */
	private settlingUntilVal = 0;
	/** `settlingUntil` read at the start, until `restore` decides whether the lock phase goes on. */
	private resumeAt: number | null = null;
	/** Between `init` and `restore` (the registry still loads the optimised values): no detection step. */
	private restoring = false;
	/** The auto-off of an early end waits for the exit of the lock phase. */
	private autoOffDeferred = false;
	/** The auto-off after an activity exit waits for a start, the end of the check window or rest. */
	private autoOffWait: AutoOffWait | null = null;
	private power: number | null = null;
	private missingPower = false;
	private switchOn: boolean | null = null;
	private dnd = false;
	private runtimeMax = 0;
	private startedAt = 0;
	private autoOffTimer: unknown = null;
	private disposed = false;
	private queue: Promise<void> = Promise.resolve();
	private override: Partial<DetectionSettings> | null = null;
	private finalSuspended = false;
	private recorder: RunRecorder | null = null;
	private antiCrease = false;
	/** Phase tracker (phases on), or null. */
	private tracker: PhaseTracker | null = null;
	/** Number of tracker builds. */
	private trackerBuilds = 0;
	/** Rebuild the tracker as soon as no run and no lock phase is active. */
	private trackerPending = false;
	/** Base bands of the learning data (hold time profile for the phase tracker). */
	private holdBands: BaseBands | null = null;
	/** Phase shown in the states last written (null = nothing written since the tracker was built). */
	private shownPhase: { id: string; name: string; since: number } | null = null;
	/** Signature of the timeline last written (null = nothing written since the tracker was built). */
	private timelineSig: string | null = null;
	/** Phase messages sent: "<phase>:<edge>" to the time of the edge. */
	private phaseNotified = new Map<string, number>();

	/**
	 * @param host - Adapter access
	 * @param deviceId - Stable device id (object id below the namespace)
	 * @param cfg - Device configuration (with the detection values)
	 * @param inst - Instance configuration
	 * @param sink - Receives start and end messages
	 * @param listener - Receives lifecycle events
	 */
	public constructor(
		private readonly host: DeviceHost,
		private readonly deviceId: string,
		cfg: DeviceConfig,
		private readonly inst: InstanceConfig,
		private readonly sink: MessageSink,
		private readonly listener: RuntimeListener,
	) {
		this.cfg = cfg;
		this.detector = this.buildDetector();
		this.tracker = this.buildTracker();
	}

	/** Current device configuration. */
	public get config(): DeviceConfig {
		return this.cfg;
	}

	/**
	 * Detection values in use: the values of the device with the optimised values (if any). Base of the
	 * optimisation, of "adopt as base values" and of the display; never masked.
	 */
	public get effective(): DetectionSettings {
		return { ...this.baseDetection, ...(this.override ?? {}) };
	}

	/**
	 * Values the detector is built with: `effective`, with the final phase off (`finalMinVal = 0`) while it is
	 * suspended. The mask never reaches the optimisation, the override or the values of the device.
	 */
	public get active(): DetectionSettings {
		const eff = this.effective;
		return this.finalSuspended ? { ...eff, finalMinVal: 0 } : eff;
	}

	/** Detection values of the device (without optimised values), all fields filled in. */
	public get baseDetection(): DetectionSettings {
		return detectionOf(this.cfg.detection);
	}

	/** Optimised values in use, or null. */
	public get currentOverride(): Partial<DetectionSettings> | null {
		return this.override;
	}

	/**
	 * Use optimised values (null = the values of the device). The detector is rebuilt at once
	 * when no run and no lock phase is in progress, otherwise as soon as both are over.
	 *
	 * @param o - Optimised values or null
	 */
	public setOverride(o: Partial<DetectionSettings> | null): void {
		if (JSON.stringify(o) === JSON.stringify(this.override)) {
			return;
		}
		this.override = o;
		this.rebuildDetector();
	}

	/**
	 * Suspend the final phase (only a mask of the values the detector is built with) or use it again. The detector
	 * is rebuilt like with `setOverride`.
	 *
	 * @param on - Suspended
	 */
	public setFinalSuspended(on: boolean): void {
		if (on === this.finalSuspended) {
			return;
		}
		this.finalSuspended = on;
		this.rebuildDetector();
	}

	/**
	 * Rebuild the detector at once between two runs, otherwise at the first step without a run and without a lock
	 * phase (a rebuild in the lock phase would start the detection afresh: phantom start, second end).
	 */
	private rebuildDetector(): void {
		if (this.detector.started || this.detector.settling === true) {
			this.rebuildPending = true;
		} else {
			this.detector = this.buildDetector();
			this.rebuildPending = false;
		}
	}

	/**
	 * Rebuild the phase tracker between two runs (and lock phases), otherwise afterwards: a rebuild in a run would
	 * lose the phases of the run.
	 */
	private rebuildTracker(): void {
		if (this.detector.started || this.detector.settling === true) {
			this.trackerPending = true;
		} else {
			this.tracker = this.buildTracker();
			this.trackerPending = false;
		}
	}

	/** Pending rebuild, as soon as no run and no lock phase is in progress. */
	private rebuildIfDue(): void {
		if (this.rebuildPending && !this.detector.started && this.detector.settling !== true) {
			this.detector = this.buildDetector();
			this.rebuildPending = false;
		}
		if (this.trackerPending && !this.detector.started && this.detector.settling !== true) {
			this.tracker = this.buildTracker();
			this.trackerPending = false;
		}
	}

	/** Whether the lock phase after an early end of the final phase is active. */
	public get settling(): boolean {
		return this.detector.settling === true;
	}

	/** Number of phase tracker builds (tests: a changed phase model is applied between two runs only). */
	public get phaseRev(): number {
		return this.trackerBuilds;
	}

	/**
	 * Base bands of the learning data: their hold time profile gives the phase tracker the suspect limits.
	 *
	 * @param bands - Base bands or null
	 */
	public setHoldBands(bands: BaseBands | null): void {
		if (bands === this.holdBands) {
			return;
		}
		this.holdBands = bands;
		if (this.tracker && this.cfg.phases) {
			this.tracker.setHolds(phaseHolds(this.cfg.phases, bands));
		}
	}

	/** Number of detector builds (tests: a change of the values rebuilds only between runs and lock phases). */
	public get detectorRev(): number {
		return this.builds;
	}

	/**
	 * Record the power for the automatic optimisation (null = stop).
	 *
	 * @param r - Recorder or null
	 */
	public attachRecorder(r: RunRecorder | null): void {
		this.recorder = r;
	}

	/** Recorder of the automatic optimisation, or null. */
	public get runRecorder(): RunRecorder | null {
		return this.recorder;
	}

	/** Whether voice output is suppressed. */
	public get doNotDisturb(): boolean {
		return this.dnd;
	}

	/** Whether a run is in progress. */
	public get isRunning(): boolean {
		return this.detector.started;
	}

	/** Last valid power value in W, or null if none is known. */
	public get lastPower(): number | null {
		return this.power;
	}

	/** Whether the configured power state does not exist (as found in `init()`). */
	public get powerMissing(): boolean {
		return this.missingPower;
	}

	/**
	 * Load the persisted values and reset the volatile states. A lock phase that was active before the restart
	 * (`settlingUntil`) goes on (`restore`); with `restoreLater` the caller calls `restore` itself once the
	 * optimised values are loaded, and no detection step runs until then.
	 *
	 * @param o - Options
	 * @param o.restoreLater - `restore` follows (registry: the optimised values are loaded after `init`)
	 */
	public async init(o: { restoreLater?: boolean } = {}): Promise<void> {
		this.detector.reset();
		this.wasSettling = false;
		this.exitBase = null;
		this.autoOffDeferred = false;
		this.autoOffWait = null;
		await this.setState("status", this.inst.statusTexts.off);
		await this.setState("runtime", formatDuration(0));
		await this.setState("runtimeMs", 0);
		await this.setState("running", false);
		await this.setState("alertRuntime", false);

		const max = parseNumber(await this.host.getOwnState(this.own("config.runtimeMax")));
		this.runtimeMax = max !== null && max > 0 ? max : 0;
		this.dnd = isTrue(await this.host.getOwnState(this.own("config.doNotDisturb")));
		await this.refreshSwitch();
		const until = parseNumber(await this.host.getOwnState(this.own("settlingUntil")));
		this.settlingUntilVal = until ?? 0;
		this.resumeAt = until !== null && until > 0 ? until : null;
		this.restoring = o.restoreLater === true;

		const common = await this.host.getForeignObjectCommonType(this.cfg.powerId);
		if (common === null) {
			this.missingPower = true;
			this.host.log.warn(`Power state ${this.cfg.powerId} of device ${this.cfg.name} not found`);
		} else {
			this.missingPower = false;
			const initial = parseNumber(await this.host.getForeignValue(this.cfg.powerId));
			if (initial !== null) {
				this.power = initial;
				await this.setState("consumption", initial);
			}
		}
		if (!this.restoring) {
			await this.restore();
		}
	}

	/**
	 * After the start: set the optimised values and the suspension of the final phase, then continue a lock phase
	 * that was active before the restart (Spec A.3 "Neustart"): only while `settlingUntil` lies in the future and the
	 * final phase is on with the values in use (not suspended), at most `finalLockSec` from now. The detector is
	 * built once before the first step. Otherwise `settlingUntil` goes to 0.
	 *
	 * @param o - Optimised values and suspension (missing: unchanged)
	 * @param o.override - Optimised values (null = none)
	 * @param o.suspended - Final phase suspended
	 */
	public async restore(o: { override?: Partial<DetectionSettings> | null; suspended?: boolean } = {}): Promise<void> {
		if (o.override !== undefined) {
			this.override = o.override;
		}
		if (o.suspended !== undefined) {
			this.finalSuspended = o.suspended;
		}
		const until = this.resumeAt;
		this.resumeAt = null;
		this.restoring = false;
		const act = this.active;
		const now = this.host.now();
		if (until !== null && until > now && finalOn(act) && !this.detector.started && !this.disposed) {
			const lockMs = finalValuesOf(act, this.inst.pollIntervalSec).finalLockSec * 1000;
			const lockAt = Math.min(until, now + lockMs) - lockMs;
			this.detector = this.buildDetector(lockAt);
			this.rebuildPending = false;
			this.enterSettling();
			// a restart counts like the early end: the auto-off waits for the exit
			this.autoOffDeferred = true;
			await this.writeSettling(lockAt + lockMs);
			return;
		}
		if (o.override !== undefined || o.suspended !== undefined) {
			this.rebuildDetector();
		}
		if (until !== null) {
			await this.writeSettling(0);
		}
	}

	/**
	 * End a lock phase for good (power state changed, device disabled or not run any more): the detection starts
	 * afresh and `settlingUntil` goes to 0, so that a restart does not continue it.
	 */
	public async dropSettling(): Promise<void> {
		await this.enqueue(async () => {
			this.resumeAt = null;
			if (this.detector.settling === true) {
				this.detector = this.buildDetector();
				this.rebuildPending = false;
			}
			this.wasSettling = false;
			this.exitBase = null;
			this.autoOffDeferred = false;
			this.autoOffWait = null;
			await this.writeSettling(0);
		});
	}

	/**
	 * Remember a new power value; in time-based mode it is also fed into the detector.
	 *
	 * @param val - Raw state value; anything that is not a number or a numeric string is ignored
	 */
	public async onPower(val: ioBroker.StateValue): Promise<void> {
		const parsed = parseNumber(val);
		if (parsed === null) {
			this.host.log.debug(`Ignoring non-numeric power value of device ${this.cfg.name}`);
			return;
		}
		this.power = parsed;
		this.missingPower = false;
		this.recorder?.event(parsed, this.host.now());
		this.tracker?.observe(parsed, this.host.now());
		if (this.detectorMode !== "timed" || !this.detector.feed) {
			return;
		}
		await this.enqueue(async () => {
			if (this.restoring) {
				return;
			}
			const res = this.detector.feed?.(parsed, this.host.now());
			if (res) {
				await this.apply(res, parsed);
			}
		});
	}

	/**
	 * Remember the last value of the switch (needed for the auto-off).
	 *
	 * @param val - Raw state value
	 */
	public onSwitch(val: ioBroker.StateValue): void {
		this.switchOn = isTrue(val);
	}

	/**
	 * Handle a change of an own state of this device.
	 *
	 * @param relId - State id relative to the device (e.g. `config.doNotDisturb`)
	 * @param val - New value
	 * @param ack - Acknowledge flag
	 */
	public async onOwnStateChange(relId: string, val: ioBroker.StateValue, ack: boolean): Promise<void> {
		switch (relId) {
			case "config.doNotDisturb":
				this.dnd = isTrue(val);
				if (!ack) {
					await this.setState(relId, this.dnd);
				}
				break;
			case "config.runtimeMax": {
				const max = parseNumber(val);
				if (max === null) {
					this.host.log.warn(`Invalid runtime limit for device ${this.cfg.name}`);
					return;
				}
				this.runtimeMax = max > 0 ? max : 0;
				if (!ack) {
					await this.setState(relId, max);
				}
				break;
			}
			case "acknowledge":
				if (!ack && isTrue(val)) {
					await this.setState("finished", false);
				}
				break;
			default:
				break;
		}
	}

	/** One poll step with the last known power value. */
	public async tick(): Promise<void> {
		await this.enqueue(async () => {
			const power = this.power;
			if (power === null || this.restoring) {
				return;
			}
			this.recorder?.sample(power, this.host.now());
			await this.apply(this.detector.tick(power, this.host.now(), { switchOff: this.switchOn === false }), power);
			await this.checkAutoOffWait(power);
			await this.publishPhases();
		});
	}

	/**
	 * Resolve a message text: if it is the id of an existing object, the state value is used.
	 *
	 * @param text - Configured text or state id
	 */
	public async resolveText(text: string): Promise<string> {
		if (!text.includes(".") || text.endsWith(".")) {
			return text;
		}
		try {
			if ((await this.host.getForeignObjectCommonType(text)) === null) {
				return text;
			}
			const val = await this.host.getForeignValue(text);
			return val === null || val === undefined ? text : String(val);
		} catch (err) {
			this.host.log.debug(`Cannot resolve text "${text}": ${errorMessage(err)}`);
			return text;
		}
	}

	/**
	 * Whether the running state survives a configuration change (same power state).
	 *
	 * @param next - New device configuration
	 */
	public canKeepStateFor(next: DeviceConfig): boolean {
		return next.powerId === this.cfg.powerId;
	}

	/**
	 * Apply a changed configuration without resetting the cycle. Changed detection values or abort options
	 * rebuild the detector at once between two runs, otherwise after the run and after the lock phase.
	 *
	 * @param next - New device configuration (must pass `canKeepStateFor`)
	 */
	public updateConfig(next: DeviceConfig): void {
		if (!this.canKeepStateFor(next)) {
			this.host.log.warn(`Configuration of device ${next.name} cannot be applied without a reset`);
			return;
		}
		const detectorChanged =
			next.abort !== this.cfg.abort ||
			next.abortFixed !== this.cfg.abortFixed ||
			typeHash(next.detection) !== typeHash(this.cfg.detection);
		const switchChanged = next.switchId !== this.cfg.switchId;
		const phasesChanged = JSON.stringify(next.phases) !== JSON.stringify(this.cfg.phases);
		this.cfg = next;
		if (detectorChanged) {
			this.rebuildDetector();
		}
		if (phasesChanged) {
			this.rebuildTracker();
		}
		if (switchChanged) {
			this.switchOn = null;
			this.refreshSwitch().catch(err => this.host.log.debug(errorMessage(err)));
		}
		if (!next.autoOff || !next.switchId) {
			this.cancelAutoOff();
		}
	}

	/** Stop all timers; no state is written afterwards. */
	public dispose(): void {
		this.disposed = true;
		this.cancelAutoOff();
	}

	private own(rel: string): string {
		return `${this.deviceId}.${rel}`;
	}

	private async setState(rel: string, val: ioBroker.StateValue): Promise<void> {
		if (this.disposed) {
			return;
		}
		await this.host.setOwnState(this.own(rel), val);
	}

	/** Build the phase tracker (null without enabled phases). */
	private buildTracker(): PhaseTracker | null {
		this.shownPhase = null;
		this.timelineSig = null;
		const model = this.cfg.phases;
		if (!model?.enabled) {
			return null;
		}
		this.trackerBuilds++;
		const names = systemPhaseNames(key => {
			try {
				return I18n.translate(key);
			} catch {
				return key; // texts not loaded: the English names
			}
		});
		return new PhaseTracker(model, phaseHolds(model, this.holdBands), this.inst.pollIntervalSec, names);
	}

	/**
	 * Let the phase tracker run to now and write what changed: the phase shown (`phase`, `phaseId`, `phaseSince`) and
	 * the timeline (`phases`) only when a segment changes, never per poll; then the phase events and messages.
	 */
	private async publishPhases(): Promise<void> {
		const tr = this.tracker;
		const model = this.cfg.phases;
		if (!tr || !model || this.disposed) {
			return;
		}
		const now = this.host.now();
		tr.setContext({ inTrailer: this.antiCrease, settling: this.detector.settling === true });
		const edges = tr.advance(now);
		const cur = tr.current;
		const id = cur.id ?? "";
		const shown = this.shownPhase;
		if (!shown || shown.id !== id || shown.name !== cur.name || shown.since !== cur.since) {
			this.shownPhase = { id, name: cur.name, since: cur.since };
			await this.setState("phase", cur.name);
			await this.setState("phaseId", id);
			await this.setState("phaseSince", cur.since);
		}
		let segs = tr.timeline();
		if (model.scope === "continuous") {
			segs = segs.filter(x => x.to >= now - PHASES_CONTINUOUS_MS);
		}
		segs = segs.slice(-PHASES_MAX);
		// the open segment grows every poll: it counts without its end
		const sig = segs.map(x => `${x.id}|${x.name}|${x.from}|${x.final ? x.to : ""}`).join(";");
		if (sig !== (this.timelineSig ?? "")) {
			const list = segs.map(x => ({ id: x.id, name: x.name, from: x.from, to: x.to }));
			await this.setState("phases", JSON.stringify(list));
		}
		this.timelineSig = sig;
		for (const edge of edges) {
			this.emit({ kind: "phase", id: edge.id, edge: edge.edge });
			await this.notifyPhase(edge);
		}
	}

	/**
	 * Message of a phase with `notify`: once per run and phase (scope run), at most every 10 min per phase (scope
	 * continuous); do not disturb works like with the start and end messages.
	 *
	 * @param edge - Start or end of a phase
	 */
	private async notifyPhase(edge: PhaseEdge): Promise<void> {
		const model = this.cfg.phases;
		const def = model?.phases.find(p => p.id === edge.id);
		if (!model || !def?.notify || !def.notify[edge.edge]) {
			return;
		}
		const key = `${edge.id}:${edge.edge}`;
		const last = this.phaseNotified.get(key);
		if (last !== undefined && (model.scope === "run" || edge.at - last < PHASE_NOTIFY_MIN_MS)) {
			return;
		}
		this.phaseNotified.set(key, edge.at);
		await this.notify(def.notify.text?.trim() || def.name);
	}

	/**
	 * Build the detector with the active values.
	 *
	 * @param resumeLockAt - Start in the lock phase that began at this time (restart during the lock phase)
	 */
	private buildDetector(resumeLockAt?: number): Detector {
		const settings = this.active;
		this.detectorMode = settings.mode;
		this.detectorFinal = finalOn(settings) ? finalValuesOf(settings, this.inst.pollIntervalSec) : null;
		this.builds++;
		return createDetector(settings, {
			abort: this.cfg.abort,
			abortFixed: this.cfg.abortFixed,
			pollSec: this.inst.pollIntervalSec,
			...(resumeLockAt !== undefined ? { resumeLockAt } : {}),
		});
	}

	/**
	 * Run steps one after the other so that polls and power events never interleave.
	 *
	 * @param step - Work to do
	 */
	private enqueue(step: () => Promise<void>): Promise<void> {
		const next = this.queue.then(async () => {
			if (this.disposed) {
				return;
			}
			try {
				await step();
			} catch (err) {
				this.host.log.error(`Device ${this.cfg.name}: ${errorMessage(err)}`);
			}
		});
		this.queue = next;
		return next;
	}

	private async refreshSwitch(): Promise<void> {
		if (!this.cfg.switchId) {
			this.switchOn = null;
			return;
		}
		const val = await this.host.getForeignValue(this.cfg.switchId);
		this.switchOn = val === null ? null : isTrue(val);
	}

	/**
	 * Turn the result of a detector step into states, messages and events.
	 *
	 * @param res - Detector result
	 * @param power - Power value of this step
	 */
	private async apply(res: TickResult, power: number): Promise<void> {
		if (res.status !== null) {
			await this.setState("status", this.inst.statusTexts[res.status]);
		}
		if (res.average !== null && Number.isFinite(res.average)) {
			await this.setState("averageConsumption", res.average);
		}
		await this.setState("consumption", power);

		let started = false;
		for (let k = 0; k < res.events.length; k++) {
			if (this.disposed) {
				return;
			}
			const at = res.times?.[k] ?? this.host.now();
			switch (res.events[k]) {
				case "started":
					started = true;
					await this.onStarted(at);
					break;
				case "running":
					await this.onRunning();
					break;
				case "finished":
					await this.onFinished(at);
					break;
				case "aborted":
					await this.onAborted(at);
					break;
			}
		}
		await this.followSettling(started);
		const inTrailer = this.detector instanceof TrailerFilter && this.detector.inTrailer;
		if (inTrailer !== this.antiCrease) {
			this.antiCrease = inTrailer;
			await this.setState("antiCrease", inTrailer);
		}
		this.rebuildIfDue();
	}

	/** Remember the start of a lock phase (counters to find its exit later). */
	private enterSettling(): void {
		this.wasSettling = true;
		this.exitBase = this.detector.stats ?? null;
	}

	/**
	 * Follow the lock phase of the final phase after a step: its begin writes `settlingUntil` (early end +
	 * `finalLockSec`), every exit writes 0. The deferred auto-off starts at an exit showing rest or an end (a, b, e);
	 * after an activity exit (c, d, f, g) it follows the end of the new run, or starts once no start came within
	 * `finalCheckSec` (or at rest before).
	 *
	 * @param started - The step reported a start
	 */
	private async followSettling(started: boolean): Promise<void> {
		const settling = this.detector.settling === true;
		if (settling && !this.wasSettling) {
			this.enterSettling();
			const lockMs = (this.detectorFinal?.finalLockSec ?? 0) * 1000;
			await this.writeSettling((this.detector.lockAt ?? this.host.now()) + lockMs);
			return;
		}
		if (settling || !this.wasSettling) {
			return;
		}
		this.wasSettling = false;
		const exit = this.exitTaken();
		this.exitBase = null;
		await this.writeSettling(0);
		const deferred = this.autoOffDeferred;
		this.autoOffDeferred = false;
		if (!deferred || started || this.detector.started) {
			return;
		}
		if (exit === "c" || exit === "d" || exit === "f" || exit === "g") {
			const checkMs = (this.detectorFinal?.finalCheckSec ?? 0) * 1000;
			this.autoOffWait = { until: this.host.now() + checkMs, restSince: null };
			return;
		}
		await this.startAutoOff();
	}

	/** Exit of the lock phase that just ended (from the counters of the final phase), or null if unknown. */
	private exitTaken(): FinalExit | null {
		const now = this.detector.stats;
		if (!now) {
			return null;
		}
		return EXITS.find(k => now[k] > (this.exitBase?.[k] ?? 0)) ?? null;
	}

	/**
	 * Auto-off after an activity exit without a start: once the check window is over, or at once with a rest proof
	 * (below `finalRestVal` for `finalRestSec`).
	 *
	 * @param power - Power of this step
	 */
	private async checkAutoOffWait(power: number): Promise<void> {
		const wait = this.autoOffWait;
		if (!wait || this.detector.started) {
			return;
		}
		const now = this.host.now();
		const restVal = this.detectorFinal?.finalRestVal ?? this.active.standby;
		const restMs = (this.detectorFinal?.finalRestSec ?? 0) * 1000;
		wait.restSince = power < restVal ? (wait.restSince ?? now) : null;
		if (now >= wait.until || (wait.restSince !== null && now - wait.restSince >= restMs)) {
			this.autoOffWait = null;
			await this.startAutoOff();
		}
	}

	/**
	 * Write `settlingUntil` when it changes; only while the state exists (final phase on with the values in use).
	 *
	 * @param val - End of the lock phase in ms, or 0
	 */
	private async writeSettling(val: number): Promise<void> {
		if (val === this.settlingUntilVal) {
			return;
		}
		this.settlingUntilVal = val;
		if (finalOn(this.effective)) {
			await this.setState("settlingUntil", val);
		}
	}

	private record(ev: CaptureEvent, at: number, afterFinal?: FinalExit | null): void {
		this.recorder?.onEvent(ev, at, afterFinal);
	}

	private async onStarted(at: number): Promise<void> {
		this.startedAt = at;
		this.tracker?.onRun("start", at);
		if (this.cfg.phases?.scope === "run") {
			this.phaseNotified.clear();
		}
		this.record("s", at, this.detector.finalExit ?? null);
		this.cancelAutoOff();
		this.autoOffDeferred = false;
		this.autoOffWait = null;
		await this.setState("running", true);
		await this.setState("finished", false);
		await this.setState("runtime", formatDuration(0));
		await this.setState("runtimeMs", 0);
		if (this.cfg.startText) {
			await this.notify(this.cfg.startText);
		}
		this.emit("start");
	}

	private async onRunning(): Promise<void> {
		this.cancelAutoOff();
		const elapsed = Math.max(0, this.host.now() - this.startedAt);
		await this.setState("runtime", formatDuration(elapsed));
		await this.setState("runtimeMs", elapsed);
		if (this.runtimeMax > 0) {
			await this.setState("alertRuntime", elapsed >= this.runtimeMax * 60_000 + 1000);
		}
	}

	private async onFinished(at: number): Promise<void> {
		const now = at;
		this.record("f", at);
		this.tracker?.onRun("end", at);
		const runtime = formatDuration(Math.max(0, now - this.startedAt));
		if (this.cfg.endText) {
			await this.notify(this.cfg.endText);
		}
		await this.appendOperation({
			start: formatTimestamp(new Date(this.startedAt)),
			end: formatTimestamp(new Date(now)),
			runtime,
		});
		await this.setState("lastRuntime", runtime);
		await this.setState("alertRuntime", false);
		await this.setState("running", false);
		await this.setState("finished", true);
		await this.setState("lastFinished", now);
		if (this.detector.settling === true) {
			// early end of the final phase: the auto-off waits for the exit of the lock phase
			this.cancelAutoOff();
			this.autoOffDeferred = true;
		} else {
			await this.startAutoOff();
		}
		this.emit("end");
	}

	private async onAborted(at: number): Promise<void> {
		this.record("a", at);
		this.tracker?.onRun("abort", at);
		await this.setState("running", false);
		await this.setState("alertRuntime", false);
		await this.startAutoOff();
		this.emit("abort");
	}

	private emit(ev: RuntimeEvent): void {
		if (this.disposed) {
			return;
		}
		try {
			this.listener.onRuntimeEvent(this.deviceId, ev);
		} catch (err) {
			this.host.log.error(`Device ${this.cfg.name}: ${errorMessage(err)}`);
		}
	}

	/**
	 * Resolve a text, store it in `message` and hand it to the sink.
	 *
	 * @param configured - Configured start or end text
	 */
	private async notify(configured: string): Promise<void> {
		const text = await this.resolveText(configured);
		await this.setState("message", text);
		try {
			await this.sink.send(this.deviceId, text);
		} catch (err) {
			this.host.log.warn(`Message of device ${this.cfg.name} failed: ${errorMessage(err)}`);
		}
	}

	/**
	 * Append a finished run to `lastOperations` (and the HTML table if enabled).
	 *
	 * @param op - The finished run
	 */
	private async appendOperation(op: Operation): Promise<void> {
		let ops: Operation[] = [];
		const raw = await this.host.getOwnState(this.own("lastOperations"));
		if (typeof raw === "string" && raw !== "") {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					ops = parsed as Operation[];
				}
			} catch {
				ops = [];
			}
		}
		ops.push(op);
		ops = ops.slice(-MAX_OPERATIONS);
		await this.setState("lastOperations", JSON.stringify(ops));
		if (this.inst.historyHtml) {
			await this.setState("lastOperationsHtml", renderHistoryHtml(ops));
		}
	}

	private cancelAutoOff(): void {
		if (this.autoOffTimer !== null) {
			this.host.clearTimeout(this.autoOffTimer);
			this.autoOffTimer = null;
		}
	}

	private async startAutoOff(): Promise<void> {
		const switchId = this.cfg.switchId;
		this.cancelAutoOff();
		if (!this.cfg.autoOff || !switchId || this.disposed) {
			return;
		}
		if (this.cfg.autoOffMinutes <= 0) {
			await this.switchOff(switchId);
			return;
		}
		this.autoOffTimer = this.host.setTimeout(() => {
			this.autoOffTimer = null;
			this.switchOff(switchId).catch(err => this.host.log.warn(errorMessage(err)));
		}, this.cfg.autoOffMinutes * 60_000);
	}

	/**
	 * Switch the plug off if its last known state is "on".
	 *
	 * @param switchId - Switch state id
	 */
	private async switchOff(switchId: string): Promise<void> {
		if (this.disposed || this.switchOn !== true) {
			return;
		}
		await this.host.setForeignValue(switchId, false);
	}
}
