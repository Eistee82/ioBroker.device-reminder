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
			if (await this.deliver(r, text)) {
				result.sent.push(r.id);
			}
		}
		return result;
	}

	/**
	 * Deliver a text to one recipient (no window / do-not-disturb checks).
	 *
	 * @param r - Recipient
	 * @param text - Message text
	 * @returns true if the message was handed over
	 */
	private async deliver(r: RecipientConfig, text: string): Promise<boolean> {
		try {
			const isVoice = r.kind === "alexa" || r.kind === "sayit";
			const call = isVoice ? null : buildDelivery(r, text);
			if ((isVoice && !r.stateId) || (!isVoice && !call)) {
				this.host.log.warn(
					`Recipient ${r.name} has no target configured (state, user/chat, channel or topic), message skipped`,
				);
				return false;
			}
			if (isVoice) {
				await this.voice.speak(r, text);
			} else if (call?.kind === "sendTo") {
				this.host.sendTo(call.instance, call.command, call.message);
			} else if (call) {
				await this.host.setForeignValue(call.id, call.val);
			}
			return true;
		} catch (err) {
			this.host.log.warn(`Sending to ${r.name} failed: ${errorMessage(err)}`);
			return false;
		}
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
	 * Send a test message to one recipient: a saved one by id, or the (possibly unsaved) row of the settings.
	 *
	 * @param recipient - Recipient id or recipient
	 */
	public async sendTest(recipient: string | RecipientConfig): Promise<{ ok: boolean; error?: string }> {
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

	/** Clear all timers. */
	public dispose(): void {
		this.voice.dispose();
	}
}
