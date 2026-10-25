import { errorMessage, parseNumber } from "../utils.js";
const DEFAULT_VOLUME = 30;
const SPEAK_DELAY_MS = 1000;
const RESTORE_DELAY_MS = 2000;
export class VoiceOutput {
    host;
    pending = new Map();
    disposed = false;
    constructor(host) {
        this.host = host;
    }
    async speak(r, text) {
        if (this.disposed || !r.stateId) {
            return;
        }
        const stateId = r.stateId;
        const carried = this.pending.get(r.id)?.restore;
        this.cancel(r.id);
        const volId = r.volumeStateId || this.volumeId(r);
        let volumeExists = false;
        if (volId) {
            try {
                volumeExists = (await this.host.getForeignObjectCommonType(volId)) !== null;
            }
            catch (err) {
                this.host.log.debug(`Volume state ${volId} not checked: ${errorMessage(err)}`);
            }
        }
        if (this.disposed) {
            this.restoreNow(carried);
            return;
        }
        if (!volumeExists) {
            this.restoreNow(carried);
            this.host.log.debug(`Volume state of ${r.name} does not exist, speaking without volume change`);
            await this.host.setForeignValue(stateId, text);
            return;
        }
        let restore = carried;
        if (!restore) {
            let old = DEFAULT_VOLUME;
            try {
                const num = parseNumber(await this.host.getForeignValue(volId));
                if (num !== null) {
                    old = num;
                }
            }
            catch (err) {
                this.host.log.debug(`Volume of ${volId} not readable: ${errorMessage(err)}`);
            }
            restore = { id: volId, val: old };
        }
        if (this.disposed) {
            this.restoreNow(carried);
            return;
        }
        const concurrent = this.pending.get(r.id)?.restore;
        this.cancel(r.id);
        const entry = { handles: [], restore: concurrent ?? restore };
        this.pending.set(r.id, entry);
        await this.host.setForeignValue(volId, r.volume ?? DEFAULT_VOLUME);
        if (this.disposed) {
            this.restoreNow(entry.restore);
            return;
        }
        if (this.pending.get(r.id) !== entry) {
            return;
        }
        entry.handles.push(this.host.setTimeout(() => {
            this.host.setForeignValue(stateId, text).catch((err) => {
                this.host.log.warn(`Voice output failed: ${errorMessage(err)}`);
            });
        }, SPEAK_DELAY_MS), this.host.setTimeout(() => {
            if (this.pending.get(r.id) === entry) {
                this.pending.delete(r.id);
            }
            this.host.setForeignValue(entry.restore.id, entry.restore.val).catch((err) => {
                this.host.log.warn(`Volume reset failed: ${errorMessage(err)}`);
            });
        }, RESTORE_DELAY_MS));
    }
    dispose() {
        this.disposed = true;
        for (const [id, p] of [...this.pending.entries()]) {
            this.cancel(id);
            this.restoreNow(p.restore);
        }
    }
    restoreNow(restore) {
        if (!restore) {
            return;
        }
        this.host.setForeignValue(restore.id, restore.val).catch((err) => {
            this.host.log.warn(`Volume reset failed: ${errorMessage(err)}`);
        });
    }
    volumeId(r) {
        const path = r.stateId ?? "";
        const dot = path.lastIndexOf(".");
        if (dot < 0) {
            return "";
        }
        return path.slice(0, dot) + (r.kind === "alexa" ? ".speak-volume" : ".volume");
    }
    cancel(id) {
        const p = this.pending.get(id);
        if (!p) {
            return;
        }
        for (const h of p.handles) {
            this.host.clearTimeout(h);
        }
        this.pending.delete(id);
    }
}
//# sourceMappingURL=voice.js.map