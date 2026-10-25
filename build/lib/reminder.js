import { runActions } from "./actions.js";
import { errorMessage } from "./utils.js";
const MIN_DELAY_MS = 1000;
export class ReminderScheduler {
    host;
    notifier;
    getDevice;
    handle = null;
    running = false;
    sent = 0;
    failedTries = 0;
    generation = 0;
    constructor(host, notifier, getDevice) {
        this.host = host;
        this.notifier = notifier;
        this.getDevice = getDevice;
    }
    get active() {
        return this.running;
    }
    get sentCount() {
        return this.sent;
    }
    onFinished() {
        this.stop();
        const { cfg } = this.getDevice();
        if (!cfg.reminder.enabled || cfg.recipients.length === 0) {
            return;
        }
        this.running = true;
        this.schedule(this.intervalMs());
    }
    acknowledge() {
        this.stop();
    }
    onStarted() {
        this.stop();
    }
    dispose() {
        this.stop();
    }
    intervalMs() {
        const min = this.getDevice().cfg.reminder.intervalMin;
        return Math.max(1, Number.isFinite(min) ? min : 30) * 60_000;
    }
    maxCount() {
        const max = this.getDevice().cfg.reminder.maxCount;
        return Math.max(1, Number.isFinite(max) && max > 0 ? Math.floor(max) : 10);
    }
    stop() {
        this.generation++;
        this.running = false;
        this.sent = 0;
        this.failedTries = 0;
        if (this.handle !== null) {
            this.host.clearTimeout(this.handle);
            this.handle = null;
        }
    }
    schedule(ms) {
        if (this.handle !== null) {
            this.host.clearTimeout(this.handle);
        }
        const gen = this.generation;
        this.handle = this.host.setTimeout(() => {
            this.handle = null;
            void this.fire(gen);
        }, Math.max(MIN_DELAY_MS, ms));
    }
    async fire(gen) {
        if (gen !== this.generation) {
            return;
        }
        const { cfg, text, doNotDisturb } = this.getDevice();
        try {
            const res = await this.notifier.notify(cfg.recipients, cfg.reminder.text || text, { doNotDisturb });
            if (gen !== this.generation) {
                return;
            }
            if (res.sent.length > 0) {
                this.sent++;
                await runActions(this.host, cfg.actions, "reminder");
                if (gen !== this.generation) {
                    return;
                }
                if (this.sent >= this.maxCount()) {
                    this.stop();
                    return;
                }
                this.schedule(this.intervalMs());
                return;
            }
            if (res.skippedWindow.length > 0) {
                const next = this.notifier.nextWindowStartFor(res.skippedWindow, new Date(this.host.now()));
                if (next && next.getTime() > this.host.now()) {
                    this.schedule(next.getTime() - this.host.now());
                    return;
                }
            }
            this.failedTries++;
        }
        catch (err) {
            this.host.log.warn(`Reminder failed: ${errorMessage(err)}`);
            this.failedTries++;
        }
        if (gen !== this.generation) {
            return;
        }
        if (this.failedTries >= this.maxCount()) {
            this.stop();
            return;
        }
        this.schedule(this.intervalMs());
    }
}
//# sourceMappingURL=reminder.js.map