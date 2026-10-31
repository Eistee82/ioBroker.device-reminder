import { ensureDeviceObjects } from "./deviceObjects.js";
export class DeviceSync {
    registry;
    writer;
    getConfig;
    log;
    applied = new Map();
    constructor(registry, writer, getConfig, log) {
        this.registry = registry;
        this.writer = writer;
        this.getConfig = getConfig;
        this.log = log;
    }
    async apply(deviceId, cfg, deleted = false) {
        if (!cfg) {
            this.applied.delete(deviceId);
            if (deleted) {
                await this.registry.deleteLearningData(deviceId);
            }
            if (this.registry.get(deviceId)) {
                this.registry.remove(deviceId);
                this.log.info(`Device ${deviceId} removed`);
            }
            return;
        }
        const key = JSON.stringify(cfg);
        if (this.applied.get(deviceId) === key) {
            return;
        }
        this.applied.set(deviceId, key);
        const current = this.registry.get(deviceId);
        if (!current) {
            await ensureDeviceObjects(this.writer, deviceId, cfg, this.getConfig());
            await this.registry.upsert(deviceId, cfg);
            if (this.registry.get(deviceId)) {
                this.log.info(`Device ${cfg.name} added`);
            }
        }
        else if (JSON.stringify(current.config) !== key) {
            await this.registry.upsert(deviceId, cfg);
            this.log.debug(`Configuration of device ${cfg.name} updated`);
        }
    }
}
//# sourceMappingURL=deviceSync.js.map