import type { RecipientConfig } from "../config.js";
import type { DeviceHost } from "../host.js";
import { errorMessage, parseNumber } from "../utils.js";

const DEFAULT_VOLUME = 30;
const SPEAK_DELAY_MS = 1000;
const RESTORE_DELAY_MS = 2000;

interface Pending {
	handles: unknown[];
	/** Volume that has to be restored; kept across replaced outputs. */
	restore: { id: string; val: ioBroker.StateValue };
}

/** Voice output (Alexa, SayIt) with temporary volume change. */
export class VoiceOutput {
	private readonly pending = new Map<string, Pending>();
	private disposed = false;

	/**
	 * Create the voice output.
	 *
	 * @param host - Adapter host
	 */
	public constructor(private readonly host: DeviceHost) {}

	/**
	 * Speak a text; a running output of the same recipient is replaced.
	 *
	 * @param r - Recipient
	 * @param text - Text to speak
	 */
	public async speak(r: RecipientConfig, text: string): Promise<void> {
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
			} catch (err) {
				this.host.log.debug(`Volume state ${volId} not checked: ${errorMessage(err)}`);
			}
		}
		if (this.disposed) {
			return;
		}
		if (!volumeExists) {
			this.host.log.debug(`Volume state of ${r.name} does not exist, speaking without volume change`);
			await this.host.setForeignValue(stateId, text);
			return;
		}

		let restore = carried;
		if (!restore) {
			let old: ioBroker.StateValue = DEFAULT_VOLUME;
			try {
				const num = parseNumber(await this.host.getForeignValue(volId));
				if (num !== null) {
					old = num;
				}
			} catch (err) {
				this.host.log.debug(`Volume of ${volId} not readable: ${errorMessage(err)}`);
			}
			restore = { id: volId, val: old };
		}
		if (this.disposed) {
			return;
		}
		// an output started while we were reading replaces this one
		const concurrent = this.pending.get(r.id)?.restore;
		this.cancel(r.id);
		const entry: Pending = { handles: [], restore: concurrent ?? restore };
		this.pending.set(r.id, entry);
		await this.host.setForeignValue(volId, r.volume ?? DEFAULT_VOLUME);
		if (this.disposed || this.pending.get(r.id) !== entry) {
			return;
		}
		entry.handles.push(
			this.host.setTimeout(() => {
				this.host.setForeignValue(stateId, text).catch((err: unknown) => {
					this.host.log.warn(`Voice output failed: ${errorMessage(err)}`);
				});
			}, SPEAK_DELAY_MS),
			this.host.setTimeout(() => {
				if (this.pending.get(r.id) === entry) {
					this.pending.delete(r.id);
				}
				this.host.setForeignValue(entry.restore.id, entry.restore.val).catch((err: unknown) => {
					this.host.log.warn(`Volume reset failed: ${errorMessage(err)}`);
				});
			}, RESTORE_DELAY_MS),
		);
	}

	/** Clear all timers; nothing is written afterwards. */
	public dispose(): void {
		this.disposed = true;
		for (const id of [...this.pending.keys()]) {
			this.cancel(id);
		}
	}

	/**
	 * Derive the volume state from the speech state.
	 *
	 * @param r - Recipient
	 */
	private volumeId(r: RecipientConfig): string {
		const path = r.stateId ?? "";
		const dot = path.lastIndexOf(".");
		if (dot < 0) {
			return "";
		}
		return path.slice(0, dot) + (r.kind === "alexa" ? ".speak-volume" : ".volume");
	}

	/**
	 * Clear the timers of a recipient.
	 *
	 * @param id - Recipient id
	 */
	private cancel(id: string): void {
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
