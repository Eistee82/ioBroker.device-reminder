import { ACTIONS, DeviceManagement } from "@iobroker/dm-utils";
import { DEFAULT_REMINDER, findType, normalizeDeviceConfig } from "./config.js";
import { buildDeviceSchema, buildSourceSchema, deviceConfigToForm, formToDeviceConfig } from "./deviceForm.js";
import { ensureDeviceObjects } from "./deviceObjects.js";
import { plain, TEXT } from "./dmTexts.js";
import { allocateDeviceId } from "./ids.js";
import { detectFromHost } from "./typeDetection.js";
import { errorMessage, parseNumber } from "./utils.js";
const RESERVED_IDS = ["info"];
const LEARN_ERRORS = {
    tooFewSamples: TEXT.learnTooFewSamples,
    noRun: TEXT.learnNoRun,
};
const GENERIC_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#607d8b" d="M16 3h-2v4h-4V3H8v4H7a2 2 0 0 0-2 2v3a6 6 0 0 0 5 5.9V21h4v-3.1a6 6 0 0 0 5-5.9V9a2 2 0 0 0-2-2h-1V3z"/></svg>';
const GENERIC_ICON = `data:image/svg+xml;base64,${Buffer.from(GENERIC_ICON_SVG).toString("base64")}`;
function isRecord(val) {
    return typeof val === "object" && val !== null && !Array.isArray(val);
}
function textOf(val) {
    return typeof val === "string" ? val : "";
}
function nameOf(name, fallback) {
    if (typeof name === "string") {
        return name;
    }
    if (isRecord(name)) {
        const value = name.en ?? Object.values(name).find(v => typeof v === "string" && v !== "");
        return typeof value === "string" ? value : fallback;
    }
    return fallback;
}
function toFormData(data) {
    const reminder = { ...DEFAULT_REMINDER };
    if (isRecord(data.reminder)) {
        Object.assign(reminder, data.reminder);
    }
    for (const [key, val] of Object.entries(data)) {
        if (key.startsWith("reminder.")) {
            reminder[key.slice("reminder.".length)] = val;
        }
    }
    return { ...data, reminder };
}
export class ReminderDeviceManagement extends DeviceManagement {
    getInstanceInfo() {
        return {
            apiVersion: "v3",
            identifierLabel: TEXT.identifier,
            actions: [
                {
                    id: "add",
                    icon: "add",
                    description: TEXT.addDevice,
                    handler: ctx => this.addDevice(ctx),
                },
            ],
        };
    }
    async loadDevices(context) {
        const devices = await this.deviceObjects();
        const ids = [...devices.keys()].sort();
        context.setTotalDevices(ids.length);
        for (const id of ids) {
            try {
                context.addDevice(await this.buildDeviceInfo(id, devices.get(id)));
            }
            catch (err) {
                this.log.error(`Cannot load device ${id}: ${errorMessage(err)}`);
            }
        }
    }
    async getDeviceDetails(id) {
        const obj = await this.adapter.getObjectAsync(id);
        const cfg = obj ? this.configOf(obj) : null;
        if (!cfg) {
            return { error: "unknownDevice" };
        }
        const inst = this.adapter.instanceConfig;
        const type = findType(inst, cfg.typeId);
        const items = {};
        const data = {};
        items.opsHeader = { type: "header", text: "dm_detailsOperations", size: 4, newLine: true, xs: 12 };
        items.lastOperations = {
            type: "table",
            label: "dm_detailsOperations",
            disabled: true,
            noDelete: true,
            xs: 12,
            items: [
                { type: "text", attr: "start", title: "dm_detailsStart", width: "35%" },
                { type: "text", attr: "end", title: "dm_detailsEnd", width: "35%" },
                { type: "text", attr: "runtime", title: "dm_detailsRuntime", width: "30%" },
            ],
        };
        data.lastOperations = await this.readOperations(id);
        items.typeHeader = { type: "header", text: "dm_detailsType", size: 4, newLine: true, xs: 12 };
        if (type) {
            const rows = [
                ["dm_detailsTypeName", type.name],
                ["dm_detailsStartVal", type.startVal, "W"],
                ["dm_detailsEndVal", type.endVal, "W"],
                ["dm_detailsStandby", type.standby, "W"],
                ["dm_detailsStartCount", type.startCount],
                ["dm_detailsEndCount", type.endCount],
                ["dm_detailsMode", type.mode],
            ];
            if (type.mode !== "count") {
                rows.push(["dm_detailsStartDuration", type.startDurationSec, "s"], ["dm_detailsEndDuration", type.endDurationSec, "s"]);
            }
            rows.forEach(([label, value, unit], i) => {
                items[`type${i}`] = {
                    type: "staticInfo",
                    label,
                    data: value,
                    ...(unit ? { unit } : {}),
                    newLine: true,
                    xs: 12,
                    sm: 6,
                };
            });
        }
        else {
            items.typeUnknown = {
                type: "infoBox",
                boxType: "warning",
                text: "dm_detailsTypeUnknown",
                newLine: true,
                xs: 12,
            };
        }
        items.reminderHeader = { type: "header", text: "dm_detailsReminder", size: 4, newLine: true, xs: 12 };
        const finished = await this.adapter.getStateAsync(`${id}.finished`);
        items.reminderState = {
            type: "staticInfo",
            label: "dm_detailsReminderState",
            data: cfg.reminder.enabled ? TEXT.on : TEXT.off,
            newLine: true,
            xs: 12,
            sm: 6,
        };
        if (cfg.reminder.enabled) {
            items.reminderInterval = {
                type: "staticInfo",
                label: "dm_detailsReminderInterval",
                data: cfg.reminder.intervalMin,
                unit: "min",
                xs: 12,
                sm: 6,
            };
            items.reminderMax = {
                type: "staticInfo",
                label: "dm_detailsReminderMax",
                data: cfg.reminder.maxCount,
                xs: 12,
                sm: 6,
            };
        }
        items.reminderPending = {
            type: "staticInfo",
            label: "dm_detailsReminderPending",
            data: finished?.val === true ? TEXT.yes : TEXT.no,
            xs: 12,
            sm: 6,
        };
        return { id, schema: { type: "panel", i18n: true, items }, data };
    }
    async deviceObjects() {
        const prefix = `${this.adapter.namespace}.`;
        const res = await this.adapter.getObjectViewAsync("system", "device", {
            startkey: prefix,
            endkey: `${prefix}香`,
        });
        const result = new Map();
        for (const row of res?.rows ?? []) {
            const id = row.id.slice(prefix.length);
            if (row.value && id !== "" && !id.includes(".")) {
                result.set(id, row.value);
            }
        }
        return result;
    }
    configOf(obj) {
        const native = (obj.native ?? {});
        const direct = normalizeDeviceConfig(native).config;
        if (direct) {
            return direct;
        }
        const repaired = normalizeDeviceConfig({ ...native, powerId: "-" }).config;
        return repaired ? { ...repaired, powerId: "" } : null;
    }
    objectWriter() {
        return {
            extendObject: (id, obj) => this.adapter.extendObjectAsync(id, obj),
            setObjectNotExists: (id, obj) => this.adapter.setObjectNotExistsAsync(id, obj),
            delObject: async (id) => {
                if (await this.adapter.getObjectAsync(id)) {
                    await this.adapter.delObjectAsync(id);
                }
            },
        };
    }
    async getObjectsUnder(id) {
        const result = {};
        const own = await this.adapter.getForeignObjectAsync(id);
        if (own) {
            result[id] = own;
        }
        const children = await this.adapter.getForeignObjectsAsync(`${id}.*`);
        for (const [key, obj] of Object.entries(children ?? {})) {
            result[key] = obj;
        }
        return result;
    }
    async writeDevice(id, cfg) {
        const old = await this.adapter.getObjectAsync(id);
        if (old) {
            await this.adapter.setObjectAsync(id, {
                ...old,
                common: { ...old.common, name: cfg.name },
                native: { ...cfg },
            });
        }
        await ensureDeviceObjects(this.objectWriter(), id, cfg, this.adapter.instanceConfig);
    }
    async readOperations(id) {
        const raw = (await this.adapter.getStateAsync(`${id}.lastOperations`))?.val;
        if (typeof raw !== "string" || raw === "") {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter(isRecord).reverse() : [];
        }
        catch {
            return [];
        }
    }
    async buildDeviceInfo(id, known) {
        const obj = known ?? (await this.adapter.getObjectAsync(id));
        const cfg = obj ? this.configOf(obj) : null;
        const ns = this.adapter.namespace;
        const sid = (rel) => ({ stateId: `${ns}.${id}.${rel}` });
        if (!obj || !cfg) {
            return {
                id,
                name: nameOf(obj?.common?.name, id),
                icon: GENERIC_ICON,
                actions: this.deviceActions(id, false, false, false),
            };
        }
        const inst = this.adapter.instanceConfig;
        const type = findType(inst, cfg.typeId);
        const runtime = this.adapter.registry.get(id);
        const powerMissing = cfg.powerId === "" ||
            runtime?.powerMissing === true ||
            !(await this.adapter.getForeignObjectAsync(cfg.powerId));
        let warning = sid("alertRuntime");
        if (powerMissing) {
            warning = TEXT.powerMissing(cfg.powerId);
        }
        else if (!type) {
            warning = TEXT.unknownType(cfg.typeId);
        }
        const learning = (await this.adapter.getStateAsync(`${id}.learning.active`))?.val === true;
        const dnd = runtime?.doNotDisturb ?? false;
        const indicators = [
            {
                id: "running",
                label: TEXT.running,
                value: sid("running"),
                icon: "play",
                color: "inactive",
                colorOn: "ok",
                defaultVisible: true,
                order: 1,
            },
            {
                id: "finished",
                label: TEXT.finished,
                value: sid("finished"),
                icon: "info",
                color: "inactive",
                colorOn: "warning",
                defaultVisible: true,
                order: 2,
            },
            {
                id: "statusText",
                label: TEXT.status,
                value: sid("status"),
                showValue: true,
                defaultVisible: true,
                order: 3,
            },
            {
                id: "consumption",
                label: TEXT.consumption,
                value: sid("consumption"),
                showValue: true,
                unit: "W",
                defaultVisible: true,
                order: 4,
            },
            {
                id: "runtime",
                label: TEXT.runtime,
                value: sid("runtime"),
                showValue: true,
                defaultVisible: true,
                order: 5,
            },
        ];
        return {
            id,
            name: cfg.name,
            identifier: cfg.powerId,
            model: type?.name ?? cfg.typeId,
            icon: GENERIC_ICON,
            enabled: cfg.enabled,
            status: { warning },
            indicators,
            hasDetails: true,
            actions: this.deviceActions(id, cfg.enabled, dnd, learning),
        };
    }
    deviceActions(id, enabled, dnd, learning) {
        return [
            { id: "edit", icon: "edit", description: TEXT.edit, handler: (_id, ctx) => this.editDevice(id, ctx) },
            {
                id: "delete",
                icon: "delete",
                description: TEXT.delete,
                handler: (_id, ctx) => this.deleteDevice(id, ctx),
            },
            {
                id: ACTIONS.ENABLE_DISABLE,
                description: TEXT.toggleEnabled,
                handler: () => this.setEnabled(id, !enabled),
            },
            {
                id: "dnd",
                icon: "pause",
                description: dnd ? TEXT.dndOff : TEXT.dndOn,
                handler: () => this.toggleDnd(id, !dnd),
            },
            {
                id: "acknowledge",
                icon: "identify",
                description: TEXT.acknowledge,
                handler: () => this.acknowledge(id),
            },
            {
                id: "learn",
                icon: learning ? "stop" : "play",
                description: learning ? TEXT.learnStop : TEXT.learnStart,
                handler: (_id, ctx) => this.learn(id, ctx),
            },
            { id: "test", icon: "send", description: TEXT.test, handler: (_id, ctx) => this.sendTest(id, ctx) },
        ];
    }
    async updateOf(id) {
        return { update: await this.buildDeviceInfo(id) };
    }
    async askDevice(ctx, title, data, detection) {
        let current = { ...data };
        for (;;) {
            const result = await ctx.showForm(buildDeviceSchema(this.adapter.instanceConfig, detection), {
                data: current,
                title,
            });
            if (!result) {
                return null;
            }
            const { config, errors } = formToDeviceConfig(toFormData(result));
            if (config) {
                return config;
            }
            await ctx.showMessage(errors.join("\n"));
            current = result;
        }
    }
    async addDevice(ctx) {
        let manual = false;
        let sourceId = "";
        for (;;) {
            const first = await ctx.showForm(buildSourceSchema(), {
                title: TEXT.addTitle,
                data: { manual, sourceId },
            });
            if (!first) {
                return { refresh: false };
            }
            manual = first.manual === true;
            sourceId = textOf(first.sourceId).trim();
            if (manual || sourceId !== "") {
                break;
            }
            await ctx.showMessage(TEXT.sourceMissing);
        }
        const inst = this.adapter.instanceConfig;
        let detection;
        let name = "";
        if (!manual) {
            detection = await detectFromHost(id => this.getObjectsUnder(id), sourceId);
            const source = await this.adapter.getForeignObjectAsync(sourceId);
            name = nameOf(source?.common?.name, sourceId.split(".").pop() ?? "");
        }
        const prefill = {
            enabled: true,
            name,
            typeId: inst.types[0]?.id ?? "",
            sourceId: manual ? "" : sourceId,
            powerId: detection?.powerId ?? "",
            switchId: detection?.switchId ?? "",
            startText: "",
            endText: "",
            abort: false,
            abortFixed: false,
            autoOff: false,
            autoOffMinutes: 0,
            recipients: [],
            reminder: { ...DEFAULT_REMINDER },
            actions: [],
        };
        const config = await this.askDevice(ctx, TEXT.addTitle, prefill, detection);
        if (!config) {
            return { refresh: false };
        }
        const taken = new Set([...RESERVED_IDS, ...(await this.deviceObjects()).keys()]);
        const id = allocateDeviceId(config.name, taken);
        await ensureDeviceObjects(this.objectWriter(), id, config, inst);
        this.log.info(`Device ${config.name} added as ${id}`);
        return { refresh: true };
    }
    async editDevice(id, ctx) {
        const obj = await this.adapter.getObjectAsync(id);
        const cfg = obj ? this.configOf(obj) : null;
        if (!cfg) {
            await ctx.showMessage(TEXT.notFound);
            return { delete: id };
        }
        const edited = await this.askDevice(ctx, TEXT.editTitle, deviceConfigToForm(cfg));
        if (edited) {
            await this.writeDevice(id, edited);
        }
        return this.updateOf(id);
    }
    async deleteDevice(id, ctx) {
        if (!(await ctx.showConfirmation(TEXT.deleteConfirm))) {
            return { refresh: "none" };
        }
        this.adapter.registry.remove(id);
        await this.adapter.delObjectAsync(id, { recursive: true });
        this.log.info(`Device ${id} deleted`);
        return { delete: id };
    }
    async setEnabled(id, enabled) {
        const obj = await this.adapter.getObjectAsync(id);
        const cfg = obj ? this.configOf(obj) : null;
        if (!cfg) {
            return { delete: id };
        }
        await this.writeDevice(id, { ...cfg, enabled });
        return this.updateOf(id);
    }
    async toggleDnd(id, value) {
        await this.adapter.registry.routeOwnState(`${id}.config.doNotDisturb`, value, false);
        return this.updateOf(id);
    }
    async acknowledge(id) {
        await this.adapter.registry.acknowledge(id);
        return this.updateOf(id);
    }
    async sendTest(id, ctx) {
        const cfg = this.adapter.registry.get(id)?.config;
        if (!cfg) {
            await ctx.showMessage(TEXT.notFound);
            return { refresh: "none" };
        }
        const res = await this.adapter.notifier.notify(cfg.recipients, `Test message from device-reminder (${cfg.name})`, {
            doNotDisturb: false,
            test: true,
        });
        await ctx.showMessage(res.sent.length > 0 ? TEXT.testSent : TEXT.testNobody);
        return { refresh: "none" };
    }
    async learn(id, ctx) {
        const registry = this.adapter.registry;
        if (!registry.get(id)) {
            await ctx.showMessage(TEXT.notFound);
            return { refresh: "none" };
        }
        const active = (await this.adapter.getStateAsync(`${id}.learning.active`))?.val === true;
        if (!active) {
            await registry.startLearning(id);
            await ctx.showMessage(TEXT.learnStarted);
            return this.updateOf(id);
        }
        const result = await registry.stopLearning(id);
        if ("error" in result) {
            await ctx.showMessage(LEARN_ERRORS[result.error] ?? plain(result.error));
            return this.updateOf(id);
        }
        await this.saveLearnedType(id, result, ctx);
        return this.updateOf(id);
    }
    async saveLearnedType(id, suggestion, ctx) {
        const deviceName = this.adapter.registry.get(id)?.config.name ?? id;
        let data = {
            name: `${deviceName} (learned)`,
            startVal: suggestion.thresholds.startVal,
            endVal: suggestion.thresholds.endVal,
            standby: suggestion.thresholds.standby,
            startCount: suggestion.thresholds.startCount,
            endCount: suggestion.thresholds.endCount,
            startDurationSec: suggestion.startDurationSec,
            endDurationSec: suggestion.endDurationSec,
            durationSec: suggestion.durationSec,
            samples: suggestion.samples,
        };
        let type = null;
        const inst = this.adapter.instanceConfig;
        while (!type) {
            const result = await ctx.showForm(buildLearnSchema(), { data, title: TEXT.learnTitle });
            if (!result) {
                return;
            }
            const parsed = parseLearnForm(result);
            if (!parsed.type) {
                await ctx.showMessage(parsed.error);
                data = result;
                continue;
            }
            const typeId = allocateDeviceId(parsed.type.name, new Set(inst.types.map(t => t.id)));
            type = { ...parsed.type, id: typeId, builtin: false, mode: "count" };
        }
        if (!(await ctx.showConfirmation(TEXT.learnConfirm))) {
            return;
        }
        const instanceId = `system.adapter.${this.adapter.namespace}`;
        const stored = await this.adapter.getForeignObjectAsync(instanceId);
        const rawTypes = stored?.native?.types;
        const types = Array.isArray(rawTypes) && rawTypes.length > 0 ? rawTypes : inst.types;
        await ctx.showMessage(TEXT.learnSaved);
        await this.adapter.extendForeignObjectAsync(instanceId, { native: { types: [...types, type] } });
    }
}
export function buildLearnSchema() {
    const num = (label, step, min, unit) => ({
        type: "number",
        label,
        min,
        step,
        ...(unit ? { unit } : {}),
        xs: 12,
        sm: 4,
    });
    return {
        type: "panel",
        i18n: true,
        items: {
            info: { type: "infoBox", boxType: "info", text: "dm_learnInfo", xs: 12 },
            name: {
                type: "text",
                label: "dm_learnName",
                validator: "data.name && String(data.name).trim() !== ''",
                validatorErrorText: "dev_required",
                newLine: true,
                xs: 12,
            },
            startVal: { ...num("dm_learnStartVal", 0.05, 0, "W"), newLine: true },
            endVal: num("dm_learnEndVal", 0.05, 0, "W"),
            standby: num("dm_learnStandby", 0.05, 0, "W"),
            startCount: { ...num("dm_learnStartCount", 0.5, 1), newLine: true },
            endCount: num("dm_learnEndCount", 1, 2),
            startDurationSec: { ...num("dm_learnStartDuration", 1, 0, "s"), newLine: true },
            endDurationSec: num("dm_learnEndDuration", 1, 0, "s"),
            durationSec: {
                type: "number",
                label: "dm_learnDuration",
                unit: "s",
                disabled: true,
                newLine: true,
                xs: 12,
                sm: 4,
            },
            samples: { type: "number", label: "dm_learnSamples", disabled: true, xs: 12, sm: 4 },
        },
    };
}
function parseLearnForm(data) {
    const name = textOf(data.name).trim();
    const n = (key) => parseNumber(data[key]) ?? Number.NaN;
    const parsed = {
        startVal: n("startVal"),
        endVal: n("endVal"),
        standby: n("standby"),
        startCount: n("startCount"),
        endCount: n("endCount"),
        startDurationSec: n("startDurationSec"),
        endDurationSec: n("endDurationSec"),
    };
    if (name === "") {
        return { error: TEXT.typeNeedsName };
    }
    if (Object.values(parsed).some(v => !Number.isFinite(v) || v < 0) || parsed.startCount < 1 || parsed.endCount < 2) {
        return {
            error: TEXT.typeValuesInvalid,
        };
    }
    return { type: { name, ...parsed } };
}
//# sourceMappingURL=deviceManagement.js.map