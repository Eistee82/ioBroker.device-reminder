import type { DeviceConfig, DeviceTypeConfig, InstanceConfig } from "./config.js";
import { createDetector, TrailerFilter } from "./detector/index.js";
import type { DetectionSettings, Detector, TickResult } from "./detector/types.js";
import { renderHistoryHtml } from "./historyHtml.js";
import type { DeviceHost, MessageSink, RuntimeEvent, RuntimeListener } from "./host.js";
import type { CaptureEvent, RunRecorder } from "./runRecorder.js";
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

/**
 * Runtime of one configured device: feeds power values into the detector and turns its events
 * into states, messages, auto-off and lifecycle events.
 */
export class DeviceRuntime {
	private cfg: DeviceConfig;
	private detector: Detector;
	private rebuildDetectorAfterRun = false;
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
	private recorder: RunRecorder | null = null;
	private antiCrease = false;

	/**
	 * @param host - Adapter access
	 * @param deviceId - Stable device id (object id below the namespace)
	 * @param cfg - Device configuration
	 * @param type - Device type with thresholds
	 * @param inst - Instance configuration
	 * @param sink - Receives start and end messages
	 * @param listener - Receives lifecycle events
	 */
	public constructor(
		private readonly host: DeviceHost,
		private readonly deviceId: string,
		cfg: DeviceConfig,
		private readonly type: DeviceTypeConfig,
		private readonly inst: InstanceConfig,
		private readonly sink: MessageSink,
		private readonly listener: RuntimeListener,
	) {
		this.cfg = cfg;
		this.detector = this.buildDetector();
	}

	/** Current device configuration. */
	public get config(): DeviceConfig {
		return this.cfg;
	}

	/** Detection values in use: the device type with the optimised values (if any). */
	public get effective(): DetectionSettings {
		const t = this.type;
		return {
			startVal: t.startVal,
			endVal: t.endVal,
			standby: t.standby,
			startCount: t.startCount,
			endCount: t.endCount,
			mode: t.mode,
			startDurationSec: t.startDurationSec,
			endDurationSec: t.endDurationSec,
			pauseHoldSec: t.pauseHoldSec,
			pauseUntilSec: t.pauseUntilSec,
			pauseBelowVal: t.pauseBelowVal,
			trailerBurstSec: t.trailerBurstSec ?? 0,
			trailerGapSec: t.trailerGapSec ?? 0,
			trailerAfterSec: t.trailerAfterSec ?? 0,
			trailerBlockVal: t.trailerBlockVal ?? 0,
			trailerMaxSec: t.trailerMaxSec ?? 0,
			...(this.override ?? {}),
		};
	}

	/** Device type (without optimised values). */
	public get deviceType(): DeviceTypeConfig {
		return this.type;
	}

	/** Optimised values in use, or null. */
	public get currentOverride(): Partial<DetectionSettings> | null {
		return this.override;
	}

	/**
	 * Use optimised values (null = the values of the device type). The detector is rebuilt at once
	 * when no run is in progress, otherwise after the run.
	 *
	 * @param o - Optimised values or null
	 */
	public setOverride(o: Partial<DetectionSettings> | null): void {
		if (JSON.stringify(o) === JSON.stringify(this.override)) {
			return;
		}
		this.override = o;
		if (this.detector.started) {
			this.rebuildDetectorAfterRun = true;
		} else {
			this.detector = this.buildDetector();
		}
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

	/** Load the persisted values and reset the volatile states. */
	public async init(): Promise<void> {
		this.detector.reset();
		await this.setState("status", this.inst.statusTexts.off);
		await this.setState("runtime", formatDuration(0));
		await this.setState("runtimeMs", 0);
		await this.setState("running", false);
		await this.setState("alertRuntime", false);

		const max = parseNumber(await this.host.getOwnState(this.own("config.runtimeMax")));
		this.runtimeMax = max !== null && max > 0 ? max : 0;
		this.dnd = isTrue(await this.host.getOwnState(this.own("config.doNotDisturb")));
		await this.refreshSwitch();

		const common = await this.host.getForeignObjectCommonType(this.cfg.powerId);
		if (common === null) {
			this.missingPower = true;
			this.host.log.warn(`Power state ${this.cfg.powerId} of device ${this.cfg.name} not found`);
			return;
		}
		this.missingPower = false;
		const initial = parseNumber(await this.host.getForeignValue(this.cfg.powerId));
		if (initial !== null) {
			this.power = initial;
			await this.setState("consumption", initial);
		}
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
		this.recorder?.event(parsed);
		if (this.effective.mode !== "timed" || !this.detector.feed) {
			return;
		}
		await this.enqueue(async () => {
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
			if (power === null) {
				return;
			}
			this.recorder?.sample(power, this.host.now());
			await this.apply(this.detector.tick(power, this.host.now(), { switchOff: this.switchOn === false }), power);
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
	 * Whether the running state survives a configuration change (same type and power state).
	 *
	 * @param next - New device configuration
	 */
	public canKeepStateFor(next: DeviceConfig): boolean {
		return next.typeId === this.cfg.typeId && next.powerId === this.cfg.powerId;
	}

	/**
	 * Apply a changed configuration without resetting the cycle.
	 *
	 * @param next - New device configuration (must pass `canKeepStateFor`)
	 */
	public updateConfig(next: DeviceConfig): void {
		if (!this.canKeepStateFor(next)) {
			this.host.log.warn(`Configuration of device ${next.name} cannot be applied without a reset`);
			return;
		}
		const detectorChanged = next.abort !== this.cfg.abort || next.abortFixed !== this.cfg.abortFixed;
		const switchChanged = next.switchId !== this.cfg.switchId;
		this.cfg = next;
		if (detectorChanged) {
			if (this.detector.started) {
				this.rebuildDetectorAfterRun = true;
			} else {
				this.detector = this.buildDetector();
			}
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

	private buildDetector(): Detector {
		return createDetector(this.effective, {
			abort: this.cfg.abort,
			abortFixed: this.cfg.abortFixed,
			pollSec: this.inst.pollIntervalSec,
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

		for (let k = 0; k < res.events.length; k++) {
			if (this.disposed) {
				return;
			}
			const at = res.times?.[k] ?? this.host.now();
			switch (res.events[k]) {
				case "started":
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
		const inTrailer = this.detector instanceof TrailerFilter && this.detector.inTrailer;
		if (inTrailer !== this.antiCrease) {
			this.antiCrease = inTrailer;
			await this.setState("antiCrease", inTrailer);
		}
	}

	private record(ev: CaptureEvent, at: number): void {
		this.recorder?.onEvent(ev, at);
	}

	private async onStarted(at: number): Promise<void> {
		this.startedAt = at;
		this.record("s", at);
		this.cancelAutoOff();
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
		this.afterRun();
		await this.startAutoOff();
		this.emit("end");
	}

	private async onAborted(at: number): Promise<void> {
		this.record("a", at);
		await this.setState("running", false);
		await this.setState("alertRuntime", false);
		this.afterRun();
		await this.startAutoOff();
		this.emit("abort");
	}

	private afterRun(): void {
		if (this.rebuildDetectorAfterRun) {
			this.rebuildDetectorAfterRun = false;
			this.detector = this.buildDetector();
		}
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
