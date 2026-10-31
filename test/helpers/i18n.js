// Root hook: the forms take their texts from the admin translations like the running adapter.
import * as I18n from "@iobroker/adapter-core/i18n";
import { fileURLToPath } from "node:url";

export const mochaHooks = {
	async beforeAll() {
		await I18n.init(fileURLToPath(new URL("../../admin", import.meta.url)), "en");
	},
};
