import { MESSENGER_ADAPTERS, kindFromInstance } from "./adapters.js";

/** Option of a select in the admin UI. */
export interface Choice {
	/** Shown text. */
	label: string;
	/** Stored value. */
	value: string;
	/** Hint shown below the label in the drop-down. */
	description?: string;
}

/** Access to the ioBroker installation used to build the choices. */
export interface ChoiceEnv {
	/** Ids of all adapter instances, e.g. `alexa2.0`. */
	instances(): Promise<string[]>;
	/**
	 * Ids of all states below a prefix.
	 *
	 * @param prefix - Id prefix including the trailing dot
	 */
	stateIds(prefix: string): Promise<string[]>;
	/**
	 * Display name of an object (common.name in the admin language or English).
	 *
	 * @param id - Object id
	 */
	objectName(id: string): Promise<string | undefined>;
	/**
	 * Value of a foreign state.
	 *
	 * @param id - State id
	 */
	stateValue(id: string): Promise<unknown>;
}

/**
 * Installed instances of all supported messengers, e.g. "Alexa (alexa2.0)". The instance of the edited
 * recipient is kept, so an existing entry stays readable after its adapter was removed.
 *
 * @param env - Installation access
 * @param current - Instance of the edited recipient
 */
export async function messengerInstanceChoices(env: ChoiceEnv, current?: string): Promise<Choice[]> {
	const instances = (await env.instances()).filter(id => kindFromInstance(id) !== undefined);
	const choices = instances.sort().map(id => ({ label: `${label(id)} (${id})`, value: id }));
	if (current && kindFromInstance(current) && !instances.includes(current)) {
		choices.push({ label: `${label(current)} (${current}, not installed)`, value: current });
	}
	return choices;
}

/**
 * Echo devices (and groups) of an alexa2 instance; the value is their `Commands.speak` state.
 *
 * @param env - Installation access
 * @param instance - alexa2 instance, e.g. `alexa2.0`
 */
export async function alexaDeviceChoices(env: ChoiceEnv, instance: string): Promise<Choice[]> {
	if (kindFromInstance(instance) !== "alexa") {
		return [];
	}
	const speak = (await env.stateIds(`${instance}.Echo-Devices.`)).filter(id => id.endsWith(".Commands.speak"));
	const choices: Choice[] = [];
	for (const id of speak) {
		const deviceId = id.slice(0, -".Commands.speak".length);
		const serial = deviceId.split(".").pop() ?? deviceId;
		const name = await env.objectName(deviceId);
		choices.push({ label: name && name !== serial ? `${name} (${serial})` : serial, value: id });
	}
	return choices.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Users and chats known to a telegram instance (state `communicate.users`, an object chatId → user).
 *
 * @param env - Installation access
 * @param instance - telegram instance, e.g. `telegram.0`
 * @param target - `user` lists user names, `chatId` lists chat ids
 */
export async function telegramTargetChoices(env: ChoiceEnv, instance: string, target: string): Promise<Choice[]> {
	if (kindFromInstance(instance) !== "telegram") {
		return [];
	}
	let users: Record<string, { firstName?: string; userName?: string }> = {};
	try {
		const raw = await env.stateValue(`${instance}.communicate.users`);
		const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (parsed && typeof parsed === "object") {
			users = parsed as typeof users;
		}
	} catch {
		return [];
	}
	return Object.entries(users).map(([chatId, u]) => {
		const name = u.firstName || u.userName || chatId;
		if (target === "chatId") {
			return { label: `${name} (${chatId})`, value: chatId };
		}
		// the telegram adapter matches `user` against the user name or the first name
		const value = u.userName || u.firstName || chatId;
		return { label: u.userName ? `${name} (@${u.userName})` : name, value };
	});
}

function label(instance: string): string {
	const kind = kindFromInstance(instance);
	return kind ? MESSENGER_ADAPTERS[kind].label : instance;
}
