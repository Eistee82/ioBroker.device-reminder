import { runActions } from "./actions.js";
import { findType } from "./config.js";
import { DeviceRuntime } from "./deviceRuntime.js";
import { LearningRecorder, suggestType } from "./learning.js";
import { ReminderScheduler } from "./reminder.js";
import { errorMessage } from "./utils.js";
function isTrue(val) {
    return val === true || val === 1 || val === "true" || val === "1";
}
export class DeviceRegistry {
    host;
    notifier;
    getConfig;
    devices = new Map();
    constructor(host, notifier, getConfig) {
        this.host = host;
        this.notifier = notifier;
        this.getConfig = getConfig;
    }
    async upsert(deviceId, cfg) {
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
        const result = await suggestType(samples, this.getConfig().pollIntervalSec, {
            abort: cfg.abort,
            abortFixed: cfg.abortFixed,
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
                break;
            case "abort":
                break;
        }
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
//# sourceMappingURL=deviceRegistry.js.map