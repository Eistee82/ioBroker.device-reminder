import { runActions } from "./actions.js";
import { finalOn, finalValuesOf } from "./detector/index.js";
import { DeviceRuntime } from "./deviceRuntime.js";
import { fill, TEXT } from "./dmTexts.js";
import { findHistoryInstance, loadHistorySeries } from "./historySource.js";
import { admitted, sameRun, verdictKey } from "./learn/quality.js";
import { applyVetoes, effectiveOf, gate, LOCK_MS, LOCK_RUNS, optimize } from "./learn/autoOptimize.js";
import { checkFinalSplit } from "./learn/finalLearn.js";
import { simulate } from "./learn/replay.js";
import { buildLayout } from "./learn/runs.js";
import { scaled } from "./learn/ticks.js";
import { LearningRecorder, suggestType } from "./learning.js";
import { ReminderScheduler } from "./reminder.js";
import { RunRecorder } from "./runRecorder.js";
import { addRun, clearLearningData, convertRuns, decisionOf, detectionOf, emptyStore, finalSplitPairs, fitSize, labelCapture, loadStore, pushChange, recompute, reconcileBase, reconcileStore, refreshInfo, removeStore, saveStore, setDecision, splitCapture, storeSamples, typeHash, upgradeStore, WINDOW_MS, } from "./runStore.js";
import { errorMessage } from "./utils.js";
const OPTIMIZE_BUDGET_MS = 30_000;
const OUTAGE_MS = 60 * 60_000;
const CHECKED_MAX = 20;
function isTrue(val) {
    return val === true || val === 1 || val === "true" || val === "1";
}
export class DeviceRegistry {
    host;
    notifier;
    getConfig;
    files;
    opts;
    devices = new Map();
    optQueue = Promise.resolve();
    driftReported = new WeakSet();
    constructor(host, notifier, getConfig, files, opts = {}) {
        this.host = host;
        this.notifier = notifier;
        this.getConfig = getConfig;
        this.files = files;
        this.opts = opts;
    }
    lang() {
        return this.opts.language?.() || "en";
    }
    async upsert(deviceId, cfg) {
        const existing = this.devices.get(deviceId);
        if (cfg.needsReview && !cfg.enabled) {
            if (existing) {
                await existing.runtime.dropSettling();
                this.disposeEntry(existing);
                this.devices.delete(deviceId);
            }
            this.host.log.warn(`Device ${cfg.name} not started: ${cfg.reviewHint ?? "values need a check"}. Check and save it in the device settings.`);
            return;
        }
        if (existing) {
            if (existing.runtime.canKeepStateFor(cfg)) {
                if (!cfg.enabled) {
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
            await existing.runtime.dropSettling();
            this.disposeEntry(existing);
            this.devices.delete(deviceId);
        }
        const inst = this.getConfig();
        const sink = {
            send: async (id, text) => {
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
        const entry = {
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
        await runtime.init({ restoreLater: true });
        try {
            await this.host.setOwnState(`${deviceId}.learning.active`, false);
            await this.syncOptimize(deviceId, entry);
        }
        finally {
            await runtime.restore({ suspended: this.suspendedOf(entry) });
        }
    }
    suspendedOf(entry) {
        const final = entry.opt?.store.final;
        return final ? final.state === "suspended" : undefined;
    }
    applyStoredState(entry) {
        const store = entry.opt?.store;
        if (!store) {
            return;
        }
        if (this.modeOf(entry.runtime.config) !== "full") {
            entry.runtime.setOverride(null);
        }
        else if (!entry.holdOverride) {
            entry.runtime.setOverride(store.override);
        }
        const suspended = this.suspendedOf(entry);
        if (suspended !== undefined) {
            entry.runtime.setFinalSuspended(suspended);
        }
    }
    async storedOverride(deviceId, cfg) {
        const entry = this.devices.get(deviceId);
        if (entry) {
            return entry.runtime.currentOverride;
        }
        if (cfg.autoOptimize !== true || !this.files) {
            return null;
        }
        try {
            const quiet = { warn: (m) => this.host.log.debug(m), debug: (m) => this.host.log.debug(m) };
            return (await loadStore(this.files, deviceId, quiet))?.override ?? null;
        }
        catch {
            return null;
        }
    }
    async clearSettling(deviceId) {
        await this.devices.get(deviceId)?.runtime.dropSettling();
    }
    remove(deviceId) {
        const entry = this.devices.get(deviceId);
        if (entry) {
            this.disposeEntry(entry);
            this.devices.delete(deviceId);
        }
    }
    get(deviceId) {
        return this.devices.get(deviceId)?.runtime;
    }
    ids() {
        return [...this.devices.keys()];
    }
    foreignIdsToSubscribe() {
        const ids = new Set();
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
    async routeForeignState(id, val) {
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
            }
            catch (err) {
                this.host.log.error(`Device ${cfg.name}: ${errorMessage(err)}`);
            }
        }
    }
    async routeOwnState(relId, val, ack) {
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
        }
        catch (err) {
            this.host.log.error(`Device ${entry.runtime.config.name}: ${errorMessage(err)}`);
        }
    }
    async tickAll() {
        for (const [deviceId, entry] of this.devices) {
            if (!entry.runtime.config.enabled) {
                continue;
            }
            try {
                if (entry.opt) {
                    const store = entry.opt.store;
                    const runLevel = (store.tail?.runLimit ?? 0) / (store.unitFactor > 0 ? store.unitFactor : 1);
                    entry.opt.recorder.setActivityLimit(Math.max(entry.runtime.effective.endVal, runLevel));
                    store.lastSeenTs = this.host.now();
                }
                entry.runtime.setHoldBands(entry.opt?.store.bands ?? null);
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
            }
            catch (err) {
                this.host.log.error(`Device ${entry.runtime.config.name}: ${errorMessage(err)}`);
            }
        }
    }
    async startLearning(deviceId) {
        const entry = this.devices.get(deviceId);
        if (!entry) {
            return;
        }
        entry.recorder.start(this.host.now());
        await this.host.setOwnState(`${deviceId}.learning.active`, true);
        this.host.log.info(`Learning started for device ${entry.runtime.config.name}`);
    }
    async stopLearning(deviceId) {
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
            currentType: entry.runtime.baseDetection,
            unitFactor: await this.unitFactorOf(cfg.powerId),
        });
        await this.host.setOwnState(`${deviceId}.learning.active`, false);
        await this.host.setOwnState(`${deviceId}.learning.result`, JSON.stringify(result));
        this.host.log.info(`Learning stopped for device ${entry.runtime.config.name}`);
        return result;
    }
    async acknowledge(deviceId) {
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
    onRuntimeEvent(deviceId, ev) {
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
    whenOptimized() {
        return this.optQueue;
    }
    learningData(deviceId) {
        return this.devices.get(deviceId)?.opt?.store ?? null;
    }
    async readLearningData(deviceId) {
        const inMemory = this.learningData(deviceId);
        if (inMemory || !this.files) {
            return inMemory;
        }
        try {
            const read = await loadStore(this.files, deviceId, this.host.log);
            if (read) {
                upgradeStore(read);
            }
            return read;
        }
        catch (err) {
            this.host.log.debug(`Cannot read the learning data of ${deviceId}: ${errorMessage(err)}`);
            return null;
        }
    }
    async checkStoredRuns(deviceId) {
        const entry = this.devices.get(deviceId);
        const store = entry?.opt?.store;
        if (!entry || !store) {
            return null;
        }
        return gate(store, entry.runtime.effective, this.optimizeContext(entry));
    }
    discardRun(deviceId, runId) {
        return this.serialized(() => this.discardRunNow(deviceId, runId));
    }
    async discardRunNow(deviceId, runId) {
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
        entry.opt.verdicts = recompute(store, this.qualityContext(store));
        refreshInfo(store);
        await this.saveOpt(entry);
        await this.writeOptStates(deviceId, entry);
        this.host.log.info(`${entry.runtime.config.name}: stored run ${runId} discarded`);
        return true;
    }
    deleteLearningData(deviceId, keepDecisions = true) {
        return this.serialized(() => this.clearLearningDataNow(deviceId, keepDecisions));
    }
    removeLearningData(deviceId) {
        return this.serialized(() => this.clearLearningDataNow(deviceId, false));
    }
    async clearLearningDataNow(deviceId, keepDecisions) {
        const entry = this.devices.get(deviceId);
        let kept = null;
        if (entry?.opt) {
            const cfg = entry.runtime.config;
            entry.runtime.setOverride(null);
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
                this.enqueue(deviceId, () => this.bootstrapFromHistory(deviceId));
            }
        }
        else if (keepDecisions && this.files) {
            const read = await this.readLearningData(deviceId);
            kept = read ? clearLearningData(read, true) : null;
        }
        if (!this.files) {
            return;
        }
        try {
            await removeStore(this.files, deviceId);
            if (kept && Object.keys(kept.verdicts).length > 0) {
                await saveStore(this.files, kept);
            }
        }
        catch (err) {
            this.host.log.warn(`Cannot delete the learning data of ${deviceId}: ${errorMessage(err)}`);
        }
    }
    undoOptimization(deviceId) {
        return this.serialized(() => this.undoOptimizationNow(deviceId));
    }
    async undoOptimizationNow(deviceId) {
        const entry = this.devices.get(deviceId);
        const store = entry?.opt?.store;
        if (!entry || !store) {
            return false;
        }
        const last = [...store.changes].reverse().find(c => c.kind !== "undo" && c.kind !== "reset");
        if (!last || (last.kind !== "repair" && last.kind !== "tighten")) {
            return false;
        }
        this.setOverrideByUser(entry, store, last.from, "undo", "undo of the last change");
        await this.saveOpt(entry);
        await this.writeOptStates(deviceId, entry);
        this.host.log.info(`${entry.runtime.config.name}: last optimisation undone`);
        return true;
    }
    resetOptimization(deviceId) {
        return this.serialized(() => this.resetOptimizationNow(deviceId));
    }
    async resetOptimizationNow(deviceId) {
        const entry = this.devices.get(deviceId);
        const store = entry?.opt?.store;
        if (!entry || !store) {
            return false;
        }
        this.setOverrideByUser(entry, store, null, "reset", "reset to the detection values of the device");
        await this.saveOpt(entry);
        await this.writeOptStates(deviceId, entry);
        this.host.log.info(`${entry.runtime.config.name}: optimised values reset to the detection values of the device`);
        return true;
    }
    setOverrideByUser(entry, store, override, kind, reason) {
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
    async unitFactorOf(powerId) {
        try {
            const unit = (await this.host.getForeignObjectUnit?.(powerId)) ?? null;
            return unit !== null && unit.trim().toLowerCase() === "kw" ? 1000 : 1;
        }
        catch {
            return 1;
        }
    }
    async reconcileRuntime(entry, oldBase) {
        const store = entry.opt?.store;
        if (!store || entry.runtime.config.autoOptimize !== true) {
            return;
        }
        const hadOverride = store.override !== null;
        const kind = reconcileBase(store, typeHash(entry.runtime.baseDetection), typeHash(effectiveOf(oldBase, store.override)), this.host.now());
        if (kind === "none") {
            return;
        }
        refreshInfo(store);
        entry.runtime.setOverride(store.override);
        await this.saveOpt(entry);
        if (kind === "adopted") {
            this.host.log.info(`${entry.runtime.config.name}: values in use adopted as base values`);
        }
        else if (hadOverride) {
            await this.notifyOptimization(entry, TEXT.optBaseChanged, {});
        }
    }
    modeOf(cfg) {
        if (!this.files) {
            return "off";
        }
        if (cfg.autoOptimize === true) {
            return "full";
        }
        return finalOn(detectionOf(cfg.detection)) ? "final" : "off";
    }
    async syncOptimize(deviceId, entry) {
        const cfg = entry.runtime.config;
        const mode = this.modeOf(cfg);
        if (mode === "off") {
            if (entry.opt) {
                entry.runtime.attachRecorder(null);
                entry.runtime.setOverride(null);
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
        let loaded;
        try {
            loaded = await loadStore(this.files, deviceId, this.host.log);
        }
        catch (err) {
            this.host.log.warn(`${cfg.name}: learning data not readable, automatic optimisation off until the next start: ${errorMessage(err)}`);
            return;
        }
        const store = loaded ?? emptyStore(deviceId, cfg.template ?? "", typeHash(type), step, unitFactor);
        const upgraded = upgradeStore(store, effectiveOf(type, store.override).endVal * unitFactor);
        for (const msg of upgraded) {
            this.host.log.info(`${cfg.name}: ${msg}`);
        }
        const hadOverride = store.override !== null;
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
        const verdicts = upgraded.length > 0 || converted || store.runs.length + store.spikes.length > 0
            ? recompute(store, this.qualityContext(store))
            : new Map();
        const wantHistory = store.historyReadTs === undefined && store.runs.length + store.spikes.length === 0;
        const lastSeen = store.lastSeenTs ?? lastSeenOf(store);
        const outageFrom = !wantHistory && lastSeen > 0 && now - lastSeen > OUTAGE_MS ? Math.max(lastSeen, now - WINDOW_MS) : null;
        if (base === "baseChanged" && hadOverride) {
            await this.notifyOptimization(entry, TEXT.optBaseChanged, {});
        }
        const recorder = new RunRecorder(step, unitFactor);
        entry.opt = { store, recorder, verdicts };
        entry.holdOverride = false;
        entry.runtime.attachRecorder(recorder);
        if (!full) {
            entry.runtime.setOverride(null);
        }
        else if (store.override) {
            const g = await gate(store, effectiveOf(type, store.override), this.optimizeContext(entry));
            if (g.ok) {
                entry.runtime.setOverride(store.override);
            }
            else {
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
        }
        else if (outageFrom !== null && this.opts.history) {
            this.enqueue(deviceId, () => this.bootstrapFromHistory(deviceId, outageFrom));
        }
    }
    async bootstrapFromHistory(deviceId, from) {
        const entry = this.devices.get(deviceId);
        const opt = entry?.opt;
        const env = this.opts.history;
        if (!entry || !opt || !env) {
            return;
        }
        const cfg = entry.runtime.config;
        let instance;
        try {
            instance = await findHistoryInstance(env, cfg.powerId);
        }
        catch (err) {
            this.host.log.debug(`${cfg.name}: no history for the automatic optimisation: ${errorMessage(err)}`);
        }
        if (!instance) {
            return;
        }
        const poll = this.getConfig().pollIntervalSec;
        let loadedHistory;
        try {
            loadedHistory = await loadHistorySeries(env, instance, cfg.powerId, this.host.now(), poll, undefined, from);
        }
        catch (err) {
            this.host.log.warn(`${cfg.name}: reading the history from ${instance} failed: ${errorMessage(err)}`);
            return;
        }
        const { series, meta } = loadedHistory;
        const store = opt.store;
        if (entry.opt !== opt ||
            this.devices.get(deviceId) !== entry ||
            meta.energyCounter ||
            meta.unitFactor !== store.unitFactor ||
            series.stepMs !== store.step) {
            return;
        }
        const eff = entry.runtime.effective;
        const factor = store.unitFactor;
        const now = this.host.now();
        const layout = buildLayout(series, { keepAbove: eff.endVal * factor });
        const sim = factor === 1 ? series : scaled(series, 1 / factor);
        let runs = 0;
        let spikes = 0;
        const known = [...store.runs, ...store.spikes].map(r => r.key);
        const open = opt.recorder.snapshot();
        const recording = open ? { from: open.t0, to: open.t0 + open.cells.length * open.stepMs } : null;
        for (const w of [...layout.windows].sort((a, b) => a.fromIdx - b.fromIdx)) {
            const startMs = series.t0 + w.runStartIdx * series.stepMs;
            const key = verdictKey(store.deviceId, startMs);
            if (known.some(k => k === key || sameRun(k, key)) ||
                (recording !== null && startMs >= recording.from && startMs <= recording.to)) {
                continue;
            }
            const cells = [];
            const rep = [];
            for (let i = w.fromIdx; i <= w.toIdx; i++) {
                cells.push({ min: sim.min[i], max: sim.max[i], last: sim.last[i], valid: sim.valid[i] === 1 });
                if (series.has[i] === 1) {
                    rep.push((i - w.fromIdx) * series.stepMs);
                }
            }
            const r = simulate(sim, w, eff, { abort: cfg.abort, abortFixed: cfg.abortFixed, pollSec: poll });
            const ev = [
                ...r.startedAt.map((t) => [t, "s"]),
                ...r.finished.map((t) => [t, "f"]),
            ];
            ev.sort((a, b) => a[0] - b[0]);
            const cap = {
                t0: series.t0 + w.fromIdx * series.stepMs,
                stepMs: series.stepMs,
                unitFactor: factor,
                cells,
                ev,
                postTruncated: false,
                rep,
            };
            const res = labelCapture(cap, eff.endVal * factor, "history");
            if (res.run) {
                addRun(store, res.run, { now, deferred: true });
                if (res.label === "spike") {
                    spikes++;
                }
                else {
                    runs++;
                }
            }
            await this.yieldNow();
        }
        if (entry.opt !== opt || this.devices.get(deviceId) !== entry) {
            return;
        }
        store.historyReadTs ??= now;
        store.lastSeenTs = Math.max(store.lastSeenTs ?? 0, now);
        if (runs + spikes === 0) {
            await this.saveOpt(entry);
            return;
        }
        opt.verdicts = recompute(store, this.qualityContext(store));
        fitSize(store, now, opt.verdicts);
        refreshInfo(store);
        this.host.log.info(`${cfg.name}: ${runs} runs and ${spikes} false starts taken over from the history (${instance})`);
        await this.saveOpt(entry);
        await this.runOptimize(deviceId);
    }
    yieldNow() {
        return new Promise(resolve => {
            this.host.setTimeout(resolve, 0);
        });
    }
    qualityContext(store) {
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
    optimizeContext(entry) {
        const cfg = entry.runtime.config;
        return {
            type: entry.runtime.baseDetection,
            pollSec: this.getConfig().pollIntervalSec,
            abort: cfg.abort,
            abortFixed: cfg.abortFixed,
            yieldFn: () => new Promise(resolve => {
                this.host.setTimeout(resolve, 0);
            }),
            now: this.host.now(),
            budgetMs: this.opts.budgetMs ?? OPTIMIZE_BUDGET_MS,
            clock: () => this.host.now(),
            ...(entry.opt?.verdicts ? { verdicts: entry.opt.verdicts } : {}),
            finalSuspended: entry.opt?.store.final?.state === "suspended",
        };
    }
    persistPending(entry) {
        const opt = entry.opt;
        if (!opt) {
            return;
        }
        opt.store.pending = opt.recorder.snapshot();
        fitSize(opt.store);
        this.saveOpt(entry).catch(err => this.host.log.warn(errorMessage(err)));
    }
    async saveOpt(entry) {
        if (!entry.opt || !this.files) {
            return;
        }
        try {
            await saveStore(this.files, entry.opt.store);
        }
        catch (err) {
            this.host.log.warn(`Cannot save the learning data of ${entry.runtime.config.name}: ${errorMessage(err)}`);
        }
    }
    async storeCapture(deviceId, entry, cap) {
        const opt = entry.opt;
        if (!opt) {
            return;
        }
        const store = opt.store;
        const keepAboveW = entry.runtime.effective.endVal * cap.unitFactor;
        store.pending = null;
        let stored = false;
        let endDelaySec = null;
        for (const part of splitCapture(cap)) {
            const res = labelCapture(part.capture, keepAboveW, "live", { followed: part.followed });
            if (res.label === "unclear" || !res.run) {
                store.info.unclear++;
            }
            else {
                const run = res.run;
                addRun(store, run, {
                    ctx: this.qualityContext(store),
                    now: this.host.now(),
                    onVerdicts: v => {
                        opt.verdicts = v;
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
        if (this.unjudged(store, finalSplitPairs(cap, store.deviceId)).length > 0) {
            this.enqueue(deviceId, () => this.judgeSplits(deviceId, cap));
        }
        if (stored) {
            this.enqueueOptimize(deviceId);
        }
        else {
            await this.writeOptStates(deviceId, entry);
        }
    }
    judgeAtEnd(deviceId, entry) {
        const opt = entry.opt;
        const snap = opt?.recorder.snapshot();
        if (!opt || !snap || this.unjudged(opt.store, finalSplitPairs(snap, opt.store.deviceId)).length === 0) {
            return;
        }
        this.enqueue(deviceId, () => this.judgeSplits(deviceId, snap));
    }
    unjudged(store, pairs) {
        const known = [...(store.final?.checked ?? []), ...(store.final?.splits ?? [])];
        return pairs.filter(p => !known.some(k => k === p.key || sameRun(k, p.key)));
    }
    async judgeSplits(deviceId, cap) {
        const entry = this.devices.get(deviceId);
        const store = entry?.opt?.store;
        if (!entry || !store) {
            return;
        }
        const pairs = this.unjudged(store, finalSplitPairs(cap, store.deviceId));
        if (pairs.length === 0) {
            return;
        }
        const ctx = this.qualityContext(store);
        const clean = storeSamples(store, ctx)
            .filter(x => x.sample.kind === "run" && !x.sample.afterFinal && admitted(x.verdict, "final"))
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
    finalOf(entry, store) {
        store.final ??= { state: finalOn(entry.runtime.effective) ? "on" : "off", splits: [], suspendedAt: 0 };
        return store.final;
    }
    suspendFinal(deviceId, reason, key) {
        return this.serialized(async () => {
            await this.suspendFinalNow(deviceId, reason, key);
        });
    }
    async suspendFinalNow(deviceId, reason, key) {
        const entry = this.devices.get(deviceId);
        const store = entry?.opt?.store;
        if (!entry || !store) {
            return false;
        }
        const final = this.finalOf(entry, store);
        const was = final.state === "suspended";
        const now = this.host.now();
        store.final = {
            ...final,
            state: "suspended",
            splits: final.splits.includes(key) ? final.splits : [...final.splits, key],
            suspendedAt: was ? final.suspendedAt : now,
            reason,
        };
        entry.runtime.setFinalSuspended(true);
        pushChange(store, {
            ts: now,
            kind: "finalSuspend",
            from: store.override,
            to: store.override,
            reason: `final phase suspended (${reason})`,
            runs: store.runs.length + store.spikes.length,
            gainSec: 0,
            trigger: key,
        });
        await this.saveOpt(entry);
        await this.writeOptStates(deviceId, entry);
        if (!was) {
            this.host.log.warn(`${entry.runtime.config.name}: final phase suspended (${reason})`);
            await this.sendOptimization(entry, TEXT.finalSuspended, {});
        }
        return true;
    }
    resumeFinal(deviceId, why, key) {
        return this.serialized(() => this.resumeFinalNow(deviceId, why, key));
    }
    async resumeFinalNow(deviceId, why, key) {
        const entry = this.devices.get(deviceId);
        const store = entry?.opt?.store;
        const final = store?.final;
        if (!entry || !store || !final || (why === "newRun" && !key)) {
            return false;
        }
        const left = why === "newRun" ? final.splits.filter(k => k !== key && !sameRun(k, key ?? "")) : [];
        final.splits = left;
        if (left.length > 0 || final.state !== "suspended") {
            await this.saveOpt(entry);
            await this.writeOptStates(deviceId, entry);
            return false;
        }
        final.state = finalOn(entry.runtime.effective) ? "on" : "off";
        final.suspendedAt = 0;
        delete final.reason;
        entry.runtime.setFinalSuspended(false);
        pushChange(store, {
            ts: this.host.now(),
            kind: "finalResume",
            from: store.override,
            to: store.override,
            reason: `final phase used again (${why})`,
            runs: store.runs.length + store.spikes.length,
            gainSec: 0,
            ...(key ? { trigger: key } : {}),
        });
        await this.saveOpt(entry);
        await this.writeOptStates(deviceId, entry);
        this.host.log.info(`${entry.runtime.config.name}: final phase used again (${why})`);
        if (why === "repair" || why === "endOk") {
            await this.sendOptimization(entry, TEXT.finalResumed, {});
        }
        return true;
    }
    enqueueOptimize(deviceId) {
        this.enqueue(deviceId, () => this.runOptimize(deviceId));
    }
    serialized(fn) {
        const res = this.optQueue.then(fn);
        this.optQueue = res.then(() => undefined, () => undefined);
        return res;
    }
    enqueue(deviceId, job) {
        this.optQueue = this.optQueue
            .then(job)
            .catch(err => this.host.log.error(`Optimisation of ${deviceId} failed: ${errorMessage(err)}`));
    }
    async runOptimize(deviceId) {
        const entry = this.devices.get(deviceId);
        const opt = entry?.opt;
        if (!entry || !opt) {
            return;
        }
        const store = opt.store;
        if (this.modeOf(entry.runtime.config) !== "full") {
            await this.saveOpt(entry);
            await this.writeOptStates(deviceId, entry);
            return;
        }
        const trailerBefore = store.info.trailer;
        opt.verdicts ??= recompute(store, this.qualityContext(store));
        const ctx = this.optimizeContext(entry);
        const baseHash = typeHash(ctx.type);
        const fork = forkStore(store);
        const outcome = await optimize(fork.work, ctx);
        await this.opts.beforeOptimizeWrite?.(deviceId);
        if (entry.opt !== opt || opt.store !== store || this.devices.get(deviceId) !== entry) {
            return;
        }
        if (typeHash(entry.runtime.baseDetection) !== baseHash || store.typeHash !== baseHash) {
            this.host.log.info(`${entry.runtime.config.name}: base values changed during the optimisation, result discarded`);
            return;
        }
        mergeFork(store, fork);
        applyVetoes(store, outcome, ctx.now);
        entry.holdOverride = false;
        entry.runtime.setOverride(store.override);
        await this.saveOpt(entry);
        await this.writeOptStates(deviceId, entry);
        await this.reportHints(entry, outcome.hints);
        await this.reportOutcome(entry, outcome);
        if (store.info.trailer === "notSeparable" && trailerBefore !== "notSeparable") {
            await this.notifyOptimization(entry, TEXT.antiCreaseNotSeparable, {});
        }
    }
    async reportOutcome(entry, outcome) {
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
                this.host.log.warn(`${entry.runtime.config.name}: no values detect every admitted run, keeping the current values`);
                await this.sendOptimization(entry, TEXT.optCannotCover, {});
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
    async reportHints(entry, hints) {
        for (const h of hints) {
            await this.notifyOptimization(entry, h.kind === "use" ? TEXT.reviewUse : TEXT.reviewBroken, { date: formatDate(h.ts) }, "warn");
        }
    }
    async notifyOptimization(entry, text, vars, level = "info") {
        this.host.log[level](fill(text, "en", { device: entry.runtime.config.name, ...vars }));
        await this.sendOptimization(entry, text, vars);
    }
    async sendOptimization(entry, text, vars) {
        const cfg = entry.runtime.config;
        const all = { device: cfg.name, ...vars };
        if (!cfg.optimizeNotify) {
            return;
        }
        try {
            await this.notifier.notify(cfg.recipients, fill(text, this.lang(), all), {
                doNotDisturb: entry.runtime.doNotDisturb,
            });
        }
        catch (err) {
            this.host.log.warn(`Message of device ${cfg.name} failed: ${errorMessage(err)}`);
        }
    }
    async writeOptStates(deviceId, entry) {
        const store = entry.opt?.store;
        if (!store) {
            return;
        }
        const runtime = entry.runtime;
        const on = finalOn(runtime.effective);
        if (store.final && store.final.state !== "suspended") {
            store.final.state = on ? "on" : "off";
        }
        store.info.finalState = store.final?.state === "suspended" ? "suspended" : on ? "on" : "off";
        await this.host.setOwnState(`${deviceId}.learning.optimized`, runtime.currentOverride !== null);
        await this.host.setOwnState(`${deviceId}.learning.parameters`, JSON.stringify({
            base: effectiveOf(runtime.baseDetection, null),
            override: store.override,
            effective: runtime.effective,
            active: runtime.active,
        }));
        await this.host.setOwnState(`${deviceId}.learning.lastChange`, JSON.stringify(store.changes.at(-1) ?? null));
        await this.host.setOwnState(`${deviceId}.learning.optimizeInfo`, JSON.stringify(store.info));
    }
    disposeAll() {
        for (const entry of this.devices.values()) {
            this.disposeEntry(entry);
        }
        this.devices.clear();
    }
    disposeEntry(entry) {
        entry.opt = null;
        entry.runtime.dispose();
        entry.reminder.dispose();
        entry.recorder.stop(this.host.now());
    }
}
function forkStore(store) {
    return {
        work: { ...store, info: { ...store.info }, changes: [...store.changes] },
        start: { ...store, info: { ...store.info } },
    };
}
function mergeFork(store, fork) {
    const { work, start } = fork;
    const changed = (dst, src, was) => {
        const d = dst;
        const s = src;
        const w = was;
        for (const key of Object.keys(s)) {
            if (key !== "info" && key !== "changes" && s[key] !== w[key]) {
                d[key] = s[key];
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
function lastSeenOf(store) {
    const endOf = (r) => r.ts + ((r.seg.trailerTo ?? r.seg.runEndIdx) + 1) * r.step;
    const pending = store.pending ? store.pending.t0 + store.pending.cells.length * store.pending.stepMs : 0;
    return Math.max(0, ...[...store.runs, ...store.spikes].map(endOf), pending, store.info.lastCheckTs ?? 0, store.changes.at(-1)?.ts ?? 0);
}
function formatMinutes(sec) {
    return `${Math.round(sec / 6) / 10} min`;
}
export function formatDate(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
//# sourceMappingURL=deviceRegistry.js.map