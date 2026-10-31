import { runActions } from "./actions.js";
import { findType } from "./config.js";
import { DeviceRuntime } from "./deviceRuntime.js";
import { fill, TEXT } from "./dmTexts.js";
import { findHistoryInstance, loadHistorySeries } from "./historySource.js";
import { effectiveOf, gate, LOCK_MS, LOCK_RUNS, optimize } from "./learn/autoOptimize.js";
import { simulate } from "./learn/replay.js";
import { buildLayout } from "./learn/runs.js";
import { scaled } from "./learn/ticks.js";
import { LearningRecorder, suggestType } from "./learning.js";
import { ReminderScheduler } from "./reminder.js";
import { RunRecorder } from "./runRecorder.js";
import { addRun, emptyStore, labelCapture, loadStore, pushChange, reconcileStore, refreshInfo, removeStore, saveStore, typeHash, } from "./runStore.js";
import { errorMessage } from "./utils.js";
const OPTIMIZE_BUDGET_MS = 30_000;
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
        const runtime = new DeviceRuntime(this.host, deviceId, cfg, type, inst, sink, this);
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
        await runtime.init();
        await this.host.setOwnState(`${deviceId}.learning.active`, false);
        await this.syncOptimize(deviceId, entry);
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
            currentType: findType(inst, cfg.typeId),
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
    async status(deviceId) {
        const entry = this.devices.get(deviceId);
        if (!entry) {
            return null;
        }
        const read = (rel) => this.host.getOwnState(`${deviceId}.${rel}`);
        return {
            status: await read("status"),
            running: entry.runtime.isRunning,
            finished: isTrue(await read("finished")),
            consumption: entry.runtime.lastPower ?? (await read("consumption")),
            runtime: await read("runtime"),
        };
    }
    onRuntimeEvent(deviceId, ev) {
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
            return await loadStore(this.files, deviceId, this.host.log);
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
    async discardRun(deviceId, runId) {
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
    async deleteLearningData(deviceId) {
        const entry = this.devices.get(deviceId);
        if (entry?.opt) {
            const cfg = entry.runtime.config;
            entry.runtime.setOverride(null);
            entry.opt.store = emptyStore(deviceId, cfg.typeId, typeHash(entry.runtime.deviceType), entry.opt.store.step, entry.opt.store.unitFactor);
            this.driftReported.delete(entry);
            await this.writeOptStates(deviceId, entry);
        }
        if (this.files) {
            try {
                await removeStore(this.files, deviceId);
            }
            catch (err) {
                this.host.log.warn(`Cannot delete the learning data of ${deviceId}: ${errorMessage(err)}`);
            }
        }
    }
    async undoOptimization(deviceId) {
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
    async resetOptimization(deviceId) {
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
    async syncOptimize(deviceId, entry) {
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
        const loaded = await loadStore(this.files, deviceId, this.host.log);
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
            }
            else {
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
    async bootstrapFromHistory(deviceId) {
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
            loadedHistory = await loadHistorySeries(env, instance, cfg.powerId, this.host.now(), poll);
        }
        catch (err) {
            this.host.log.warn(`${cfg.name}: reading the history from ${instance} failed: ${errorMessage(err)}`);
            return;
        }
        const { series, meta } = loadedHistory;
        const store = opt.store;
        if (entry.opt !== opt ||
            meta.energyCounter ||
            meta.unitFactor !== store.unitFactor ||
            series.stepMs !== store.step) {
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
            };
            const res = labelCapture(cap, eff.endVal * factor, "history");
            if (res.run) {
                addRun(store, res.run);
                if (res.label === "spike") {
                    spikes++;
                }
                else {
                    runs++;
                }
            }
            await this.yieldNow();
        }
        if (entry.opt !== opt) {
            return;
        }
        if (runs + spikes === 0) {
            await this.saveOpt(entry);
            return;
        }
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
    optimizeContext(entry) {
        const cfg = entry.runtime.config;
        return {
            type: entry.runtime.deviceType,
            pollSec: this.getConfig().pollIntervalSec,
            abort: cfg.abort,
            abortFixed: cfg.abortFixed,
            yieldFn: () => new Promise(resolve => {
                this.host.setTimeout(resolve, 0);
            }),
            now: this.host.now(),
            budgetMs: OPTIMIZE_BUDGET_MS,
            clock: () => this.host.now(),
        };
    }
    persistPending(entry) {
        const opt = entry.opt;
        if (!opt) {
            return;
        }
        opt.store.pending = opt.recorder.snapshot();
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
        const res = labelCapture(cap, entry.runtime.effective.endVal * cap.unitFactor);
        store.pending = null;
        if (res.label === "unclear" || !res.run) {
            store.info.unclear++;
        }
        else {
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
        }
        else {
            await this.writeOptStates(deviceId, entry);
        }
    }
    enqueueOptimize(deviceId) {
        this.enqueue(deviceId, () => this.runOptimize(deviceId));
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
    async notifyOptimization(entry, text, vars, level = "info") {
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
        const type = entry.runtime.deviceType;
        await this.host.setOwnState(`${deviceId}.learning.optimized`, entry.runtime.currentOverride !== null);
        await this.host.setOwnState(`${deviceId}.learning.parameters`, JSON.stringify({
            type: effectiveOf(type, null),
            override: store.override,
            effective: entry.runtime.effective,
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
        entry.runtime.dispose();
        entry.reminder.dispose();
        entry.recorder.stop(this.host.now());
    }
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