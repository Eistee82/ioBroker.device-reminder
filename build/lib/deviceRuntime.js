import * as I18n from "@iobroker/adapter-core/i18n";
import { createDetector, finalOn, finalValuesOf, TrailerFilter } from "./detector/index.js";
import { renderHistoryHtml } from "./historyHtml.js";
import { PHASE_NOTIFY_MIN_MS, PHASES_CONTINUOUS_MS, PHASES_MAX, systemPhaseNames, UNKNOWN_PHASE, } from "./phases/model.js";
import { applyPhaseTune, phaseTuneBase } from "./phases/learn.js";
import { PhaseTracker, phaseHolds } from "./phases/tracker.js";
import { detectionOf, typeHash } from "./runStore.js";
import { errorMessage, formatDuration, formatTimestamp, parseNumber } from "./utils.js";
export { renderHistoryHtml } from "./historyHtml.js";
const MAX_OPERATIONS = 14;
function isTrue(val) {
    return val === true || val === 1 || val === "true" || val === "1";
}
const EXITS = ["a", "b", "c", "d", "e", "f", "g"];
export function unknownShareOf(segs, from, to) {
    if (to <= from) {
        return 0;
    }
    let unknown = 0;
    for (const s of segs) {
        if (s.id === UNKNOWN_PHASE) {
            unknown += Math.max(0, Math.min(s.to, to) - Math.max(s.from, from));
        }
    }
    return unknown / (to - from);
}
export class DeviceRuntime {
    host;
    deviceId;
    inst;
    sink;
    listener;
    cfg;
    detector;
    detectorMode = "count";
    detectorFinal = null;
    builds = 0;
    rebuildPending = false;
    wasSettling = false;
    exitBase = null;
    settlingUntilVal = 0;
    resumeAt = null;
    restoring = false;
    autoOffDeferred = false;
    autoOffWait = null;
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
    finalSuspended = false;
    recorder = null;
    antiCrease = false;
    tracker = null;
    trackerBuilds = 0;
    trackerPending = false;
    holdBands = null;
    phaseTune = null;
    phaseModel;
    shownPhase = null;
    timelineSig = null;
    phaseNotified = new Map();
    unknownShare = null;
    constructor(host, deviceId, cfg, inst, sink, listener) {
        this.host = host;
        this.deviceId = deviceId;
        this.inst = inst;
        this.sink = sink;
        this.listener = listener;
        this.cfg = cfg;
        this.phaseModel = cfg.phases;
        this.detector = this.buildDetector();
        this.tracker = this.buildTracker();
    }
    get config() {
        return this.cfg;
    }
    get effective() {
        return { ...this.baseDetection, ...(this.override ?? {}) };
    }
    get active() {
        const eff = this.effective;
        return this.finalSuspended ? { ...eff, finalMinVal: 0 } : eff;
    }
    get baseDetection() {
        return detectionOf(this.cfg.detection);
    }
    get currentOverride() {
        return this.override;
    }
    setOverride(o) {
        if (JSON.stringify(o) === JSON.stringify(this.override)) {
            return;
        }
        this.override = o;
        this.rebuildDetector();
    }
    setFinalSuspended(on) {
        if (on === this.finalSuspended) {
            return;
        }
        this.finalSuspended = on;
        this.rebuildDetector();
    }
    rebuildDetector() {
        if (this.detector.started || this.detector.settling === true) {
            this.rebuildPending = true;
        }
        else {
            this.detector = this.buildDetector();
            this.rebuildPending = false;
        }
    }
    rebuildTracker() {
        if (this.detector.started || this.detector.settling === true) {
            this.trackerPending = true;
        }
        else {
            this.tracker = this.buildTracker();
            this.trackerPending = false;
        }
    }
    rebuildIfDue() {
        if (this.rebuildPending && !this.detector.started && this.detector.settling !== true) {
            this.detector = this.buildDetector();
            this.rebuildPending = false;
        }
        if (this.trackerPending && !this.detector.started && this.detector.settling !== true) {
            this.tracker = this.buildTracker();
            this.trackerPending = false;
        }
    }
    get settling() {
        return this.detector.settling === true;
    }
    get phaseRev() {
        return this.trackerBuilds;
    }
    setHoldBands(bands) {
        if (bands === this.holdBands) {
            return;
        }
        this.holdBands = bands;
        if (this.tracker && this.phaseModel) {
            this.tracker.setHolds(phaseHolds(this.phaseModel, bands));
        }
    }
    setPhaseTune(tune) {
        if (tune === this.phaseTune) {
            return;
        }
        this.phaseTune = tune;
        this.refreshPhaseModel();
    }
    get phases() {
        return this.phaseModel;
    }
    tunedModel() {
        const model = this.cfg.phases;
        const tune = this.phaseTune;
        return model && tune?.applied && tune.base === phaseTuneBase(model)
            ? applyPhaseTune(model, tune.applied)
            : model;
    }
    refreshPhaseModel() {
        const next = this.tunedModel();
        if (JSON.stringify(next) !== JSON.stringify(this.phaseModel)) {
            this.phaseModel = next;
            this.rebuildTracker();
        }
    }
    get detectorRev() {
        return this.builds;
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
    get lastUnknownShare() {
        return this.unknownShare;
    }
    get runStart() {
        return this.detector.started ? this.startedAt : null;
    }
    async finishStuckRun(startedAt) {
        let done = false;
        await this.enqueue(async () => {
            if (!this.detector.started || this.detector.settling === true || this.startedAt !== startedAt) {
                return;
            }
            this.detector = this.buildDetector();
            this.rebuildPending = false;
            const power = this.power ?? 0;
            await this.setState("status", this.inst.statusTexts[power < (this.active.standby || 1) ? "off" : "standby"]);
            await this.onFinished(this.host.now());
            this.rebuildIfDue();
            done = true;
        });
        return done;
    }
    get lastPower() {
        return this.power;
    }
    get powerMissing() {
        return this.missingPower;
    }
    async init(o = {}) {
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
        }
        else {
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
    async restore(o = {}) {
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
    async dropSettling() {
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
    async onPower(val) {
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
            if (power === null || this.restoring) {
                return;
            }
            this.recorder?.sample(power, this.host.now());
            await this.apply(this.detector.tick(power, this.host.now(), { switchOff: this.switchOn === false }), power);
            await this.checkAutoOffWait(power);
            await this.publishPhases();
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
        return next.powerId === this.cfg.powerId;
    }
    updateConfig(next) {
        if (!this.canKeepStateFor(next)) {
            this.host.log.warn(`Configuration of device ${next.name} cannot be applied without a reset`);
            return;
        }
        const detectorChanged = next.abort !== this.cfg.abort ||
            next.abortFixed !== this.cfg.abortFixed ||
            typeHash(next.detection) !== typeHash(this.cfg.detection);
        const switchChanged = next.switchId !== this.cfg.switchId;
        const phasesChanged = JSON.stringify(next.phases) !== JSON.stringify(this.cfg.phases);
        this.cfg = next;
        if (phasesChanged) {
            this.phaseModel = this.tunedModel();
        }
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
    buildTracker() {
        this.shownPhase = null;
        this.timelineSig = null;
        const model = this.phaseModel;
        if (!model?.enabled) {
            return null;
        }
        this.trackerBuilds++;
        const names = systemPhaseNames(key => {
            try {
                return I18n.translate(key);
            }
            catch {
                return key;
            }
        });
        return new PhaseTracker(model, phaseHolds(model, this.holdBands), this.inst.pollIntervalSec, names);
    }
    async publishPhases() {
        const tr = this.tracker;
        const model = this.phaseModel;
        if (!tr || !model || this.disposed) {
            return;
        }
        const now = this.host.now();
        tr.setContext({ inTrailer: this.antiCrease, settling: this.detector.settling === true });
        const edges = tr.advance(now);
        for (const edge of edges) {
            this.emit({ kind: "phase", id: edge.id, edge: edge.edge });
            try {
                await this.notifyPhase(edge);
            }
            catch (err) {
                this.host.log.error(`Device ${this.cfg.name}: phase message failed: ${errorMessage(err)}`);
            }
        }
        const cur = tr.current;
        const id = cur.id ?? "";
        const shown = this.shownPhase;
        if (!shown || shown.id !== id || shown.name !== cur.name || shown.since !== cur.since) {
            await this.setState("phase", cur.name);
            await this.setState("phaseId", id);
            await this.setState("phaseSince", cur.since);
            this.shownPhase = { id, name: cur.name, since: cur.since };
        }
        let segs = tr.timeline();
        if (model.scope === "continuous") {
            segs = segs.filter(x => x.to >= now - PHASES_CONTINUOUS_MS);
        }
        segs = segs.slice(-PHASES_MAX);
        const sig = segs.map(x => `${x.id}|${x.name}|${x.from}|${x.final ? x.to : ""}`).join(";");
        if (sig !== (this.timelineSig ?? "")) {
            const list = segs.map(x => ({ id: x.id, name: x.name, from: x.from, to: x.to }));
            await this.setState("phases", JSON.stringify(list));
        }
        this.timelineSig = sig;
    }
    async notifyPhase(edge) {
        const model = this.phaseModel;
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
    buildDetector(resumeLockAt) {
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
    enterSettling() {
        this.wasSettling = true;
        this.exitBase = this.detector.stats ?? null;
    }
    async followSettling(started) {
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
    exitTaken() {
        const now = this.detector.stats;
        if (!now) {
            return null;
        }
        return EXITS.find(k => now[k] > (this.exitBase?.[k] ?? 0)) ?? null;
    }
    async checkAutoOffWait(power) {
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
    async writeSettling(val) {
        if (val === this.settlingUntilVal) {
            return;
        }
        this.settlingUntilVal = val;
        if (finalOn(this.effective)) {
            await this.setState("settlingUntil", val);
        }
    }
    record(ev, at, afterFinal) {
        this.recorder?.onEvent(ev, at, afterFinal);
    }
    async onStarted(at) {
        this.startedAt = at;
        this.tracker?.onRun("start", at);
        if (this.phaseModel?.scope === "run") {
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
        this.tracker?.onRun("end", at);
        this.unknownShare =
            this.tracker && this.phaseModel?.scope === "run"
                ? unknownShareOf(this.tracker.timeline(), this.startedAt, at)
                : null;
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
            this.cancelAutoOff();
            this.autoOffDeferred = true;
        }
        else {
            await this.startAutoOff();
        }
        this.emit("end");
    }
    async onAborted(at) {
        this.record("a", at);
        this.tracker?.onRun("abort", at);
        await this.setState("running", false);
        await this.setState("alertRuntime", false);
        await this.startAutoOff();
        this.emit("abort");
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