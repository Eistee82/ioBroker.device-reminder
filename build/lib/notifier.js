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
            if (await this.deliver(r, text)) {
                result.sent.push(r.id);
            }
        }
        return result;
    }
    async deliver(r, text) {
        try {
            const isVoice = r.kind === "alexa" || r.kind === "sayit";
            const call = isVoice ? null : buildDelivery(r, text);
            if ((isVoice && !r.stateId) || (!isVoice && !call)) {
                this.host.log.warn(`Recipient ${r.name} has no target configured (state, user/chat, channel or topic), message skipped`);
                return false;
            }
            if (isVoice) {
                await this.voice.speak(r, text);
            }
            else if (call?.kind === "sendTo") {
                this.host.sendTo(call.instance, call.command, call.message);
            }
            else if (call) {
                await this.host.setForeignValue(call.id, call.val);
            }
            return true;
        }
        catch (err) {
            this.host.log.warn(`Sending to ${r.name} failed: ${errorMessage(err)}`);
            return false;
        }
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
    async sendTest(recipient) {
        const r = typeof recipient === "string" ? this.getRecipients().find(x => x.id === recipient) : recipient;
        if (!r) {
            return { ok: false, error: `Recipient ${String(recipient)} not found` };
        }
        if (r.enabled === false) {
            return { ok: false, error: `Recipient ${r.name} is disabled` };
        }
        return (await this.deliver(r, "Test message from device-reminder"))
            ? { ok: true }
            : { ok: false, error: `Sending to ${r.name} failed` };
    }
    dispose() {
        this.voice.dispose();
    }
}
//# sourceMappingURL=notifier.js.map