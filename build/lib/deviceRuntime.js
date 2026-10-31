import { createDetector, TrailerFilter } from "./detector/index.js";
import { renderHistoryHtml } from "./historyHtml.js";
import { errorMessage, formatDuration, formatTimestamp, parseNumber } from "./utils.js";
export { renderHistoryHtml } from "./historyHtml.js";
const MAX_OPERATIONS = 14;
function isTrue(val) {
    return val === true || val === 1 || val === "true" || val === "1";
}
export class DeviceRuntime {
    host;
    deviceId;
    type;
    inst;
    sink;
    listener;
    cfg;
    detector;
    rebuildDetectorAfterRun = false;
    power = null;
    missingPower = false;
    switchOn = null;
    dnd = false;
    runtimeMax = 0;
    startedAt = 0;
    autoOffTimer = null;
    disposed = false;
    queue = Promise.resolve();
    override = null;
    recorder = null;
    antiCrease = false;
    constructor(host, deviceId, cfg, type, inst, sink, listener) {
        this.host = host;
        this.deviceId = deviceId;
        this.type = type;
        this.inst = inst;
        this.sink = sink;
        this.listener = listener;
        this.cfg = cfg;
        this.detector = this.buildDetector();
    }
    get config() {
        return this.cfg;
    }
    get effective() {
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
    get deviceType() {
        return this.type;
    }
    get currentOverride() {
        return this.override;
    }
    setOverride(o) {
        if (JSON.stringify(o) === JSON.stringify(this.override)) {
            return;
        }
        this.override = o;
        if (this.detector.started) {
            this.rebuildDetectorAfterRun = true;
        }
        else {
            this.detector = this.buildDetector();
        }
    }
    attachRecorder(r) {
        this.recorder = r;
    }
    get runRecorder() {
        return this.recorder;
    }
    get doNotDisturb() {
        return this.dnd;
    }
    get isRunning() {
        return this.detector.started;
    }
    get lastPower() {
        return this.power;
    }
    get powerMissing() {
        return this.missingPower;
    }
    async init() {
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
    async onPower(val) {
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
    onSwitch(val) {
        this.switchOn = isTrue(val);
    }
    async onOwnStateChange(relId, val, ack) {
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
    async tick() {
        await this.enqueue(async () => {
            const power = this.power;
            if (power === null) {
                return;
            }
            this.recorder?.sample(power, this.host.now());
            await this.apply(this.detector.tick(power, this.host.now(), { switchOff: this.switchOn === false }), power);
        });
    }
    async resolveText(text) {
        if (!text.includes(".") || text.endsWith(".")) {
            return text;
        }
        try {
            if ((await this.host.getForeignObjectCommonType(text)) === null) {
                return text;
            }
            const val = await this.host.getForeignValue(text);
            return val === null || val === undefined ? text : String(val);
        }
        catch (err) {
            this.host.log.debug(`Cannot resolve text "${text}": ${errorMessage(err)}`);
            return text;
        }
    }
    canKeepStateFor(next) {
        return next.typeId === this.cfg.typeId && next.powerId === this.cfg.powerId;
    }
    updateConfig(next) {
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
            }
            else {
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
    dispose() {
        this.disposed = true;
        this.cancelAutoOff();
    }
    own(rel) {
        return `${this.deviceId}.${rel}`;
    }
    async setState(rel, val) {
        if (this.disposed) {
            return;
        }
        await this.host.setOwnState(this.own(rel), val);
    }
    buildDetector() {
        return createDetector(this.effective, {
            abort: this.cfg.abort,
            abortFixed: this.cfg.abortFixed,
            pollSec: this.inst.pollIntervalSec,
        });
    }
    enqueue(step) {
        const next = this.queue.then(async () => {
            if (this.disposed) {
                return;
            }
            try {
                await step();
            }
            catch (err) {
                this.host.log.error(`Device ${this.cfg.name}: ${errorMessage(err)}`);
            }
        });
        this.queue = next;
        return next;
    }
    async refreshSwitch() {
        if (!this.cfg.switchId) {
            this.switchOn = null;
            return;
        }
        const val = await this.host.getForeignValue(this.cfg.switchId);
        this.switchOn = val === null ? null : isTrue(val);
    }
    async apply(res, power) {
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
    record(ev, at) {
        this.recorder?.onEvent(ev, at);
    }
    async onStarted(at) {
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
    async onRunning() {
        this.cancelAutoOff();
        const elapsed = Math.max(0, this.host.now() - this.startedAt);
        await this.setState("runtime", formatDuration(elapsed));
        await this.setState("runtimeMs", elapsed);
        if (this.runtimeMax > 0) {
            await this.setState("alertRuntime", elapsed >= this.runtimeMax * 60_000 + 1000);
        }
    }
    async onFinished(at) {
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
    async onAborted(at) {
        this.record("a", at);
        await this.setState("running", false);
        await this.setState("alertRuntime", false);
        this.afterRun();
        await this.startAutoOff();
        this.emit("abort");
    }
    afterRun() {
        if (this.rebuildDetectorAfterRun) {
            this.rebuildDetectorAfterRun = false;
            this.detector = this.buildDetector();
        }
    }
    emit(ev) {
        if (this.disposed) {
            return;
        }
        try {
            this.listener.onRuntimeEvent(this.deviceId, ev);
        }
        catch (err) {
            this.host.log.error(`Device ${this.cfg.name}: ${errorMessage(err)}`);
        }
    }
    async notify(configured) {
        const text = await this.resolveText(configured);
        await this.setState("message", text);
        try {
            await this.sink.send(this.deviceId, text);
        }
        catch (err) {
            this.host.log.warn(`Message of device ${this.cfg.name} failed: ${errorMessage(err)}`);
        }
    }
    async appendOperation(op) {
        let ops = [];
        const raw = await this.host.getOwnState(this.own("lastOperations"));
        if (typeof raw === "string" && raw !== "") {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    ops = parsed;
                }
            }
            catch {
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
    cancelAutoOff() {
        if (this.autoOffTimer !== null) {
            this.host.clearTimeout(this.autoOffTimer);
            this.autoOffTimer = null;
        }
    }
    async startAutoOff() {
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
    async switchOff(switchId) {
        if (this.disposed || this.switchOn !== true) {
            return;
        }
        await this.host.setForeignValue(switchId, false);
    }
}
//# sourceMappingURL=deviceRuntime.js.map