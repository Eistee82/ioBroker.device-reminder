import * as utils from "@iobroker/adapter-core";
import { fileURLToPath } from "node:url";
import { handleCommand } from "./lib/commands.js";
import { normalizeDeviceConfig, normalizeInstanceConfig } from "./lib/config.js";
import { ReminderDeviceManagement } from "./lib/deviceManagement.js";
import { DeviceRegistry } from "./lib/deviceRegistry.js";
import { DeviceSync } from "./lib/deviceSync.js";
import { ensureDeviceObjects } from "./lib/deviceObjects.js";
import { isLegacyConfig, migrateLegacyConfig, migrateLegacyStates } from "./lib/migration.js";
import { Notifier } from "./lib/notifier.js";
import { errorMessage } from "./lib/utils.js";
const OWN_SUBSCRIPTIONS = ["*.config.*", "*.acknowledge", "*.learning.*"];
class DeviceReminder extends utils.Adapter {
    instanceConfig = normalizeInstanceConfig({}).config;
    notifier = null;
    registry = null;
    sync = null;
    pollTimer = undefined;
    subscribed = new Set();
    objectQueue = Promise.resolve();
    unloading = false;
    constructor(options = {}) {
        super({ ...options, name: "device-reminder" });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    async onReady() {
        try {
            await this.initMigration();
            const { config, warnings, generatedIds, idPatch } = normalizeInstanceConfig(this.config);
            for (const w of warnings) {
                this.log.warn(w);
            }
            this.instanceConfig = config;
            if (generatedIds) {
                await this.persistGeneratedIds(idPatch);
            }
            const host = this.createHost();
            this.notifier = new Notifier(host, () => this.instanceConfig.recipients);
            const registry = new DeviceRegistry(host, this.notifier, () => this.instanceConfig);
            this.registry = registry;
            const sync = new DeviceSync(registry, this.objectWriter(), () => this.instanceConfig, this.log);
            this.sync = sync;
            for (const [deviceId, obj] of await this.loadDeviceObjects()) {
                const cfg = this.deviceConfigOf(deviceId, obj);
                if (!cfg) {
                    continue;
                }
                await sync.apply(deviceId, cfg);
            }
            for (const pattern of OWN_SUBSCRIPTIONS) {
                await this.subscribeStatesAsync(pattern);
            }
            await this.syncForeignSubscriptions();
            await this.subscribeObjectsAsync("*");
            await this.initDeviceManagement();
            this.pollTimer = this.setInterval(() => {
                registry.tickAll().catch(err => this.log.error(`Poll failed: ${errorMessage(err)}`));
            }, this.instanceConfig.pollIntervalSec * 1000);
            await this.setState("info.connection", true, true);
            this.log.info(`device-reminder started with ${registry.ids().length} device(s)`);
        }
        catch (err) {
            this.log.error(`Start failed: ${errorMessage(err)}`);
        }
    }
    async initMigration() {
        const native = this.config;
        const v4Keys = new Set([
            "configVersion",
            "types",
            "recipients",
            "statusTexts",
            "pollIntervalSec",
            "historyHtml",
        ]);
        const legacy = Object.fromEntries(Object.entries(native).filter(([key]) => !v4Keys.has(key)));
        if (await this.getObjectAsync("info.legacyConfig")) {
            await this.delObjectAsync("info.legacyConfig");
        }
        if (!isLegacyConfig(legacy)) {
            return;
        }
        try {
            this.log.info("3.1.2 configuration found, starting migration");
            const result = migrateLegacyConfig(legacy);
            const prefix = `${this.namespace}.`;
            const io = {
                getOwnState: async (id) => (await this.getStateAsync(id))?.val ?? null,
                setOwnState: async (id, v) => {
                    await this.setState(id, v, true);
                },
                getObjectIds: async (oldName) => {
                    const res = await this.getObjectViewAsync("system", "state", {
                        startkey: `${prefix}${oldName}.`,
                        endkey: `${prefix}${oldName}.香`,
                    });
                    return (res?.rows ?? []).map(row => row.id.slice(prefix.length));
                },
                delObject: id => this.delObjectAsync(id),
                ensureDevice: (id, cfg) => ensureDeviceObjects(this.objectWriter(), id, cfg, result.instance),
                foreignObjectExists: async (id) => !!(await this.getForeignObjectAsync(id)),
            };
            const warnings = [...result.warnings, ...(await migrateLegacyStates(io, result.devices))];
            const objId = `system.adapter.${this.namespace}`;
            const obj = await this.getForeignObjectAsync(objId);
            if (!obj) {
                throw new Error(`${objId} not found`);
            }
            this.log.info(`Migrated ${result.devices.length} devices, ${result.instance.recipients.length} recipients from 3.1.2`);
            for (const w of warnings) {
                this.log.warn(`Migration: ${w}`);
            }
            this.config = { ...result.instance };
            obj.native = { ...result.instance };
            await this.setForeignObjectAsync(objId, obj);
        }
        catch (err) {
            this.log.error(`Migration from 3.1.2 failed, configuration left unchanged: ${errorMessage(err)}`);
        }
    }
    async persistGeneratedIds(patch) {
        try {
            const objId = `system.adapter.${this.namespace}`;
            const obj = await this.getForeignObjectAsync(objId);
            if (!obj) {
                throw new Error(`${objId} not found`);
            }
            const native = obj.native;
            if (patch.recipients) {
                native.recipients = patch.recipients;
            }
            if (patch.types) {
                native.types = patch.types;
            }
            await this.setForeignObjectAsync(objId, obj);
            this.log.info("Ids generated for new recipients or device types and saved, the adapter restarts once");
        }
        catch (err) {
            this.log.warn(`Generated ids could not be saved: ${errorMessage(err)}`);
        }
    }
    async initDeviceManagement() {
        if (!this.registry || !this.notifier) {
            return;
        }
        new ReminderDeviceManagement(this);
        this.log.debug("Device manager ready");
        const own = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        const supported = own?.common
            ?.supportedMessages?.deviceManager;
        if (supported !== true) {
            this.log.warn(`The instance object does not announce the device manager (common.supportedMessages.deviceManager), so admin does not show the devices. Run "iobroker upload device-reminder" and restart the instance.`);
        }
    }
    onStateChange(id, state) {
        const registry = this.registry;
        if (!state || !registry || this.unloading) {
            return;
        }
        const prefix = `${this.namespace}.`;
        const work = id.startsWith(prefix)
            ? registry.routeOwnState(id.slice(prefix.length), state.val, state.ack)
            : registry.routeForeignState(id, state.val);
        work.catch(err => this.log.error(`State change of ${id} failed: ${errorMessage(err)}`));
    }
    onObjectChange(id, obj) {
        const prefix = `${this.namespace}.`;
        if (!this.registry || this.unloading || !id.startsWith(prefix)) {
            return;
        }
        const deviceId = id.slice(prefix.length);
        if (deviceId === "" || deviceId.includes(".")) {
            return;
        }
        if (obj && obj.type !== "device") {
            return;
        }
        this.objectQueue = this.objectQueue
            .then(() => this.applyDeviceObject(deviceId, obj ?? null))
            .catch(err => this.log.error(`Change of device ${deviceId} failed: ${errorMessage(err)}`));
    }
    onMessage(obj) {
        if (typeof obj?.command !== "string" || obj.command.startsWith("dm:")) {
            return;
        }
        const registry = this.registry;
        const notifier = this.notifier;
        const reply = (result) => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
        };
        if (!registry || !notifier) {
            reply({ error: "notReady" });
            return;
        }
        handleCommand(registry, notifier, obj.command, obj.message, this.choiceEnv())
            .then(reply)
            .catch(err => reply({ error: errorMessage(err) }));
    }
    choiceEnv() {
        return {
            instances: async () => {
                const res = await this.getObjectViewAsync("system", "instance", {
                    startkey: "system.adapter.",
                    endkey: "system.adapter.香",
                });
                return (res?.rows ?? []).map(row => row.id.slice("system.adapter.".length));
            },
            stateIds: async (prefix) => {
                const res = await this.getObjectViewAsync("system", "state", {
                    startkey: prefix,
                    endkey: `${prefix}香`,
                });
                return (res?.rows ?? []).map(row => row.id);
            },
            objectName: async (id) => {
                const name = (await this.getForeignObjectAsync(id))?.common?.name;
                if (typeof name === "string") {
                    return name;
                }
                return name ? (name[this.language ?? "en"] ?? name.en) : undefined;
            },
            stateValue: async (id) => (await this.getForeignStateAsync(id))?.val,
        };
    }
    onUnload(callback) {
        this.unloading = true;
        try {
            if (this.pollTimer !== undefined) {
                this.clearInterval(this.pollTimer);
                this.pollTimer = undefined;
            }
            this.registry?.disposeAll();
            this.notifier?.dispose();
            this.setState("info.connection", false, true).catch(err => this.log.debug(`Shutdown state update skipped: ${errorMessage(err)}`));
        }
        catch (err) {
            this.log.debug(`Shutdown failed: ${errorMessage(err)}`);
        }
        finally {
            callback();
        }
    }
    async applyDeviceObject(deviceId, obj) {
        if (!this.registry || !this.sync || this.unloading) {
            return;
        }
        const cfg = obj ? this.deviceConfigOf(deviceId, obj) : null;
        await this.sync.apply(deviceId, cfg);
        await this.syncForeignSubscriptions();
    }
    deviceConfigOf(deviceId, obj) {
        const { config, warnings } = normalizeDeviceConfig(obj.native ?? {});
        for (const w of warnings) {
            this.log.warn(`${deviceId}: ${w}`);
        }
        return config;
    }
    async loadDeviceObjects() {
        const prefix = `${this.namespace}.`;
        const res = await this.getObjectViewAsync("system", "device", {
            startkey: prefix,
            endkey: `${prefix}香`,
        });
        const result = [];
        for (const row of res?.rows ?? []) {
            const deviceId = row.id.slice(prefix.length);
            if (row.value && deviceId !== "" && !deviceId.includes(".")) {
                result.push([deviceId, row.value]);
            }
        }
        return result;
    }
    async syncForeignSubscriptions() {
        if (!this.registry) {
            return;
        }
        const wanted = new Set(this.registry.foreignIdsToSubscribe());
        for (const id of this.subscribed) {
            if (!wanted.has(id)) {
                await this.unsubscribeForeignStatesAsync(id);
                this.subscribed.delete(id);
            }
        }
        for (const id of wanted) {
            if (!this.subscribed.has(id)) {
                await this.subscribeForeignStatesAsync(id);
                this.subscribed.add(id);
            }
        }
    }
    objectWriter() {
        return {
            extendObject: (id, obj) => this.extendObjectAsync(id, obj),
            setObjectNotExists: (id, obj) => this.setObjectNotExistsAsync(id, obj),
            delObject: async (id) => {
                try {
                    if (await this.getObjectAsync(id)) {
                        await this.delObjectAsync(id);
                    }
                }
                catch (err) {
                    this.log.debug(`Cannot delete ${id}: ${errorMessage(err)}`);
                }
            },
        };
    }
    createHost() {
        return {
            setOwnState: async (id, val) => {
                if (this.unloading) {
                    return;
                }
                await this.setState(id, val, true);
            },
            getOwnState: async (id) => (await this.getStateAsync(id))?.val ?? null,
            getForeignValue: async (id) => (await this.getForeignStateAsync(id))?.val ?? null,
            setForeignValue: async (id, val) => {
                if (this.unloading) {
                    return;
                }
                await this.setForeignStateAsync(id, val, false);
            },
            getForeignObjectCommonType: async (id) => {
                const obj = await this.getForeignObjectAsync(id);
                if (!obj) {
                    return null;
                }
                return obj.common.type ?? "mixed";
            },
            setTimeout: (cb, ms) => this.setTimeout(cb, ms),
            clearTimeout: handle => this.clearTimeout(handle),
            now: () => Date.now(),
            log: this.log,
            sendTo: (instance, command, message) => {
                if (this.unloading) {
                    return;
                }
                this.sendTo(instance, command, message);
            },
        };
    }
}
export default function startAdapter(options = {}) {
    return new DeviceReminder(options);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    new DeviceReminder();
}
//# sourceMappingURL=main.js.map