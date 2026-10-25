import type { RecipientConfig } from "./config.js";
import type { NotifierHost } from "./host.js";
import { buildDelivery } from "./messenger/payloads.js";
import { VoiceOutput } from "./messenger/voice.js";
import { errorMessage, isInWindow, nextWindowStart } from "./utils.js";

export type { NotifierHost } from "./host.js";

/** Context of a notification. */
export interface NotifyContext {
	/** Suppresses voice outputs. */
	doNotDisturb: boolean;
	/** Test message: ignores do-not-disturb and time windows. */
	test?: boolean;
}

/** Result of a notification (recipient ids). */
export interface NotifyResult {
	/** Recipients that received the message. */
	sent: string[];
	/** Recipients skipped because of their time window. */
	skippedWindow: string[];
}

/** Sends messages to recipients, respecting time windows and do-not-disturb. */
export class Notifier {
	private readonly voice: VoiceOutput;

	/**
	 * Create the notifier.
	 *
	 * @param host - Adapter host
	 * @param getRecipients - Returns the current recipient list
	 */
	public constructor(
		private readonly host: NotifierHost,
		private readonly getRecipients: () => RecipientConfig[],
	) {
		this.voice = new VoiceOutput(host);
	}

	/**
	 * Send a text to the given recipients.
	 *
	 * @param recipientIds - Recipient ids
	 * @param text - Message text
	 * @param ctx - Notification context
	 */
	public async notify(recipientIds: string[], text: string, ctx: NotifyContext): Promise<NotifyResult> {
		const result: NotifyResult = { sent: [], skippedWindow: [] };
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
						this.host.log.warn(`Recipient ${r.name} has no state configured`);
						continue;
					}
					await this.voice.speak(r, text);
					result.sent.push(r.id);
					continue;
				}
				const call = buildDelivery(r, text);
				if (!call) {
					this.host.log.warn(`Recipient ${r.name} has no state configured`);
					continue;
				}
				if (call.kind === "sendTo") {
					this.host.sendTo(call.instance, call.command, call.message);
				} else {
					await this.host.setForeignValue(call.id, call.val);
				}
				result.sent.push(r.id);
			} catch (err) {
				this.host.log.warn(`Sending to ${r.name} failed: ${errorMessage(err)}`);
			}
		}
		return result;
	}

	/**
	 * Earliest start of the time windows of the active recipients.
	 *
	 * @param recipientIds - Recipient ids
	 * @param now - Reference time
	 */
	public nextWindowStartFor(recipientIds: string[], now: Date): Date | null {
		const all = this.getRecipients();
		let best: Date | null = null;
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

	/**
	 * Send a test message to one recipient.
	 *
	 * @param recipientId - Recipient id
	 */
	public async sendTest(recipientId: string): Promise<{ ok: boolean; error?: string }> {
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
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
	}

	/** Clear all timers. */
	public dispose(): void {
		this.voice.dispose();
	}
}
