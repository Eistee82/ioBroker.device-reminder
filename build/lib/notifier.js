import { buildDelivery } from "./messenger/payloads.js";
import { VoiceOutput } from "./messenger/voice.js";
import { errorMessage, isInWindow, nextWindowStart } from "./utils.js";
export class Notifier {
    host;
    getRecipients;
    voice;
    constructor(host, getRecipients) {
        this.host = host;
        this.getRecipients = getRecipients;
        this.voice = new VoiceOutput(host);
    }
    async notify(recipientIds, text, ctx) {
        const result = { sent: [], skippedWindow: [] };
        const all = this.getRecipients();
        const now = new Date(this.host.now());
        for (const id of recipientIds) {
            const r = all.find(x => x.id === id);
            if (!r) {
                this.host.log.debug(`Recipient ${id} not found, skipped`);
                continue;
            }
            if (r.enabled === false) {
                this.host.log.debug(`Recipient ${r.name} is disabled, skipped`);
                continue;
            }
            const isVoice = r.kind === "alexa" || r.kind === "sayit";
            if (!ctx.test) {
                if (!isInWindow(now, r.activeFrom, r.activeUntil)) {
                    result.skippedWindow.push(r.id);
                    continue;
                }
                if (isVoice && ctx.doNotDisturb) {
                    this.host.log.debug(`Do not disturb: voice output to ${r.name} suppressed`);
                    continue;
                }
            }
            try {
                if (isVoice) {
                    if (!r.stateId) {
                        this.host.log.warn(`Recipient ${r.name} has no target configured (state, user/chat, channel or topic), message skipped`);
                        continue;
                    }
                    await this.voice.speak(r, text);
                    result.sent.push(r.id);
                    continue;
                }
                const call = buildDelivery(r, text);
                if (!call) {
                    this.host.log.warn(`Recipient ${r.name} has no target configured (state, user/chat, channel or topic), message skipped`);
                    continue;
                }
                if (call.kind === "sendTo") {
                    this.host.sendTo(call.instance, call.command, call.message);
                }
                else {
                    await this.host.setForeignValue(call.id, call.val);
                }
                result.sent.push(r.id);
            }
            catch (err) {
                this.host.log.warn(`Sending to ${r.name} failed: ${errorMessage(err)}`);
            }
        }
        return result;
    }
    nextWindowStartFor(recipientIds, now) {
        const all = this.getRecipients();
        let best = null;
        for (const id of recipientIds) {
            const r = all.find(x => x.id === id);
            if (!r || r.enabled === false) {
                continue;
            }
            const start = nextWindowStart(now, r.activeFrom, r.activeUntil);
            if (!best || start.getTime() < best.getTime()) {
                best = start;
            }
        }
        return best;
    }
    async sendTest(recipientId) {
        const r = this.getRecipients().find(x => x.id === recipientId);
        if (!r) {
            return { ok: false, error: `Recipient ${recipientId} not found` };
        }
        if (r.enabled === false) {
            return { ok: false, error: `Recipient ${r.name} is disabled` };
        }
        try {
            const res = await this.notify([recipientId], "Test message from device-reminder", {
                doNotDisturb: false,
                test: true,
            });
            return res.sent.length > 0 ? { ok: true } : { ok: false, error: `Sending to ${r.name} failed` };
        }
        catch (err) {
            return { ok: false, error: errorMessage(err) };
        }
    }
    dispose() {
        this.voice.dispose();
    }
}
//# sourceMappingURL=notifier.js.map