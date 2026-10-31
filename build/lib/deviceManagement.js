import * as I18n from "@iobroker/adapter-core/i18n";
import { ACTIONS, DeviceManagement } from "@iobroker/dm-utils";
import { DEFAULT_REMINDER, findType, normalizeDeviceConfig } from "./config.js";
import { buildDeviceSchema, buildSourceSchema, deviceConfigToForm, formToDeviceConfig } from "./deviceForm.js";
import { ensureDeviceObjects } from "./deviceObjects.js";
import { enumLabel, membershipOf, planEnumUpdate } from "./enums.js";
import { plain, TEXT } from "./dmTexts.js";
import { allocateDeviceId } from "./ids.js";
import { analyzeHistory } from "./historyLearning.js";
import { findHistoryInstance, loadHistorySeries } from "./historySource.js";
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
function idList(val) {
    return Array.isArray(val) ? val.filter((v) => typeof v === "string") : [];
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
        items.opsHeader = {
            type: "header",
            text: I18n.getTranslatedObject("dm_detailsOperations"),
            size: 4,
            newLine: true,
            xs: 12,
        };
        items.lastOperations = {
            type: "table",
            label: I18n.getTranslatedObject("dm_detailsOperations"),
            disabled: true,
            noDelete: true,
            xs: 12,
            items: [
                { type: "text", attr: "start", title: I18n.translate("dm_detailsStart"), width: "35%" },
                { type: "text", attr: "end", title: I18n.translate("dm_detailsEnd"), width: "35%" },
                { type: "text", attr: "runtime", title: I18n.translate("dm_detailsRuntime"), width: "30%" },
            ],
        };
        data.lastOperations = await this.readOperations(id);
        items.typeHeader = {
            type: "header",
            text: I18n.getTranslatedObject("dm_detailsType"),
            size: 4,
            newLine: true,
            xs: 12,
        };
        if (type) {
            const rows = [
                [I18n.getTranslatedObject("dm_detailsTypeName"), type.name],
                [I18n.getTranslatedObject("dm_detailsStartVal"), type.startVal, "W"],
                [I18n.getTranslatedObject("dm_detailsEndVal"), type.endVal, "W"],
                [I18n.getTranslatedObject("dm_detailsStandby"), type.standby, "W"],
                [I18n.getTranslatedObject("dm_detailsStartCount"), type.startCount],
                [I18n.getTranslatedObject("dm_detailsEndCount"), type.endCount],
                [I18n.getTranslatedObject("dm_detailsMode"), type.mode],
            ];
            if (type.mode !== "count") {
                rows.push([I18n.getTranslatedObject("dm_detailsStartDuration"), type.startDurationSec, "s"], [I18n.getTranslatedObject("dm_detailsEndDuration"), type.endDurationSec, "s"]);
            }
            if (type.pauseHoldSec > 0) {
                rows.push([I18n.getTranslatedObject("dm_detailsPauseHold"), type.pauseHoldSec, "s"], [I18n.getTranslatedObject("dm_detailsPauseUntil"), type.pauseUntilSec, "s"], [I18n.getTranslatedObject("dm_detailsPauseBelow"), type.pauseBelowVal, "W"]);
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
                text: I18n.getTranslatedObject("dm_detailsTypeUnknown"),
                newLine: true,
                xs: 12,
            };
        }
        items.reminderHeader = {
            type: "header",
            text: I18n.getTranslatedObject("dm_detailsReminder"),
            size: 4,
            newLine: true,
            xs: 12,
        };
        const finished = await this.adapter.getStateAsync(`${id}.finished`);
        items.reminderState = {
            type: "staticInfo",
            label: I18n.getTranslatedObject("dm_detailsReminderState"),
            data: cfg.reminder.enabled ? TEXT.on : TEXT.off,
            newLine: true,
            xs: 12,
            sm: 6,
        };
        if (cfg.reminder.enabled) {
            items.reminderInterval = {
                type: "staticInfo",
                label: I18n.getTranslatedObject("dm_detailsReminderInterval"),
                data: cfg.reminder.intervalMin,
                unit: "min",
                xs: 12,
                sm: 6,
            };
            items.reminderMax = {
                type: "staticInfo",
                label: I18n.getTranslatedObject("dm_detailsReminderMax"),
                data: cfg.reminder.maxCount,
                xs: 12,
                sm: 6,
            };
        }
        items.reminderPending = {
            type: "staticInfo",
            label: I18n.getTranslatedObject("dm_detailsReminderPending"),
            data: finished?.val === true ? TEXT.yes : TEXT.no,
            xs: 12,
            sm: 6,
        };
        return { id, schema: { type: "panel", items }, data };
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
            const { custom: _custom, ...common } = old.common;
            await this.adapter.setObjectAsync(id, {
                ...old,
                common: { ...common, name: cfg.name },
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
    async loadEnums() {
        const members = {};
        const options = { rooms: [], functions: [] };
        const sysLang = (await this.adapter.getForeignObjectAsync("system.config"))?.common?.language;
        const lang = (typeof sysLang === "string" && sysLang) || this.adapter.language || "en";
        for (const kind of ["rooms", "functions"]) {
            const objs = (await this.adapter.getForeignObjectsAsync(`enum.${kind}.*`, "enum")) ?? {};
            for (const [id, obj] of Object.entries(objs)) {
                members[id] = Array.isArray(obj.common?.members) ? [...obj.common.members] : [];
                options[kind].push({ value: id, label: enumLabel(id, obj.common?.name, lang) });
            }
            options[kind].sort((a, b) => a.label.localeCompare(b.label));
        }
        return { members, options };
    }
    async assignEnums(id, members, rooms, functions) {
        const full = `${this.adapter.namespace}.${id}`;
        for (const [kind, selected] of [
            ["rooms", rooms],
            ["functions", functions],
        ]) {
            const { add, remove } = planEnumUpdate(members, kind, full, selected);
            for (const enumId of [...add, ...remove]) {
                const list = members[enumId].filter(m => m !== full);
                if (add.includes(enumId)) {
                    list.push(full);
                }
                try {
                    await this.adapter.extendForeignObjectAsync(enumId, { common: { members: list } });
                }
                catch (err) {
                    this.log.warn(`Cannot update ${enumId}: ${errorMessage(err)}`);
                }
            }
        }
    }
    async updateOf(id) {
        return { update: await this.buildDeviceInfo(id) };
    }
    async askDevice(ctx, title, data, enums, detection) {
        let current = { ...data };
        for (;;) {
            const result = await ctx.showForm(buildDeviceSchema(this.adapter.instanceConfig, detection, enums), {
                data: current,
                title,
            });
            if (!result) {
                return null;
            }
            const { config, errors } = formToDeviceConfig(toFormData(result));
            if (config) {
                return { config, rooms: idList(result.rooms), functions: idList(result.functions) };
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
        const enums = await this.loadEnums();
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
            rooms: [],
            functions: [],
        };
        const answer = await this.askDevice(ctx, TEXT.addTitle, prefill, enums.options, detection);
        if (!answer) {
            return { refresh: false };
        }
        const { config } = answer;
        const taken = new Set([...RESERVED_IDS, ...(await this.deviceObjects()).keys()]);
        const id = allocateDeviceId(config.name, taken);
        await ensureDeviceObjects(this.objectWriter(), id, config, inst);
        await this.assignEnums(id, enums.members, answer.rooms, answer.functions);
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
        const enums = await this.loadEnums();
        const full = `${this.adapter.namespace}.${id}`;
        const form = {
            ...deviceConfigToForm(cfg),
            rooms: membershipOf(enums.members, "rooms", full),
            functions: membershipOf(enums.members, "functions", full),
        };
        const edited = await this.askDevice(ctx, TEXT.editTitle, form, enums.options);
        if (edited) {
            await this.writeDevice(id, edited.config);
            await this.assignEnums(id, enums.members, edited.rooms, edited.functions);
        }
        return this.updateOf(id);
    }
    async deleteDevice(id, ctx) {
        if (!(await ctx.showConfirmation(TEXT.deleteConfirm))) {
            return { refresh: "none" };
        }
        this.adapter.registry.remove(id);
        await this.assignEnums(id, (await this.loadEnums()).members, [], []);
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
            if (await this.learnFromHistory(id, ctx)) {
                return this.updateOf(id);
            }
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
    async learnFromHistory(id, ctx) {
        const powerId = this.adapter.registry.get(id)?.config.powerId;
        const env = this.historyEnv();
        let instance;
        try {
            instance = powerId ? await findHistoryInstance(env, powerId) : undefined;
        }
        catch (err) {
            this.adapter.log.debug(`No history for ${powerId}: ${errorMessage(err)}`);
        }
        if (!powerId || !instance) {
            return false;
        }
        const progress = await ctx.openProgress(TEXT.learnAnalysing, { value: 0, label: TEXT.learnReading });
        let sent = 0;
        let updates = Promise.resolve();
        const report = (value, label) => {
            if (value < sent + 5 && !(value === 100 && sent < 100)) {
                return;
            }
            sent = value;
            updates = updates.then(() => progress.update({ value, label })).catch(() => undefined);
        };
        const cfg = this.adapter.registry.get(id)?.config;
        const type = cfg ? findType(this.adapter.instanceConfig, cfg.typeId) : undefined;
        const poll = this.adapter.instanceConfig.pollIntervalSec;
        let result;
        let unit = "W";
        let unreadable = false;
        try {
            const { series, meta } = await loadHistorySeries(env, instance, powerId, Date.now(), poll, f => report(Math.round(60 * f), TEXT.learnReading));
            unit = meta.unit || "W";
            if (meta.error) {
                this.adapter.log.warn(`History of ${powerId} from ${instance}: ${meta.failedChunks} of ${meta.queries} queries failed: ${meta.error}`);
            }
            unreadable = meta.queries > 0 && meta.failedChunks === meta.queries;
            if (meta.energyCounter) {
                result = { error: "energyCounter" };
            }
            else {
                result = await analyzeHistory(series, poll, {
                    abort: cfg?.abort,
                    abortFixed: cfg?.abortFixed,
                    unitFactor: meta.unitFactor,
                    minDelta: meta.minDelta,
                    currentType: type ? detectionSettingsOf(type) : undefined,
                    yieldFn: () => new Promise(resolve => {
                        this.adapter.setTimeout(resolve, 0);
                    }),
                    onProgress: f => report(60 + Math.round(40 * f), TEXT.learnChecking),
                });
            }
        }
        catch (err) {
            this.adapter.log.warn(`Reading the history of ${powerId} from ${instance} failed: ${errorMessage(err)}`);
            result = { error: "noHistory" };
        }
        finally {
            await updates;
            await progress.close();
        }
        if ("error" in result) {
            if (result.error === "energyCounter") {
                await ctx.showMessage(TEXT.learnEnergyCounter);
                return true;
            }
            await ctx.showMessage(unreadable ? TEXT.learnHistoryUnreadable : TEXT.learnHistoryTooFewRuns);
            return false;
        }
        const choice = await ctx.showForm(buildLearnSourceSchema(), {
            data: { source: "history", instance, runs: result.runs },
            title: TEXT.learnTitle,
        });
        if (!choice) {
            return true;
        }
        if (choice.source !== "history") {
            return false;
        }
        await this.adapter.setStateAsync(`${id}.learning.result`, JSON.stringify(result), true);
        await this.saveLearnedType(id, result, ctx, unit);
        return true;
    }
    historyEnv() {
        return {
            object: id => this.adapter.getForeignObjectAsync(id),
            alive: async (instance) => (await this.adapter.getForeignStateAsync(`system.adapter.${instance}.alive`))?.val === true,
            getHistory: (id, options) => this.adapter.getHistoryAsync(id, options),
        };
    }
    async saveLearnedType(id, suggestion, ctx, unit = "W") {
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
            mode: suggestion.mode ?? "count",
            pauseHoldSec: suggestion.pauseHoldSec,
            pauseUntilSec: suggestion.pauseUntilSec,
            pauseBelowVal: suggestion.pauseBelowVal,
            ...(suggestion.evaluation ? { runs: suggestion.runs, ...evaluationTexts(suggestion.evaluation) } : {}),
            ...(suggestion.looDetected !== undefined
                ? { looText: `${suggestion.looDetected}/${suggestion.runs}` }
                : {}),
            ...(suggestion.longestPauseSec !== undefined
                ? { longestPauseMin: Math.round(suggestion.longestPauseSec / 60) }
                : {}),
            ...(suggestion.current ? { eval_current: evaluationText(suggestion.current) } : {}),
        };
        const fromHistory = suggestion.looDetected !== undefined;
        const schema = buildLearnSchema(fromHistory, unit, suggestion.current !== undefined, suggestion.evaluation !== undefined);
        let type = null;
        const inst = this.adapter.instanceConfig;
        while (!type) {
            const result = await ctx.showForm(schema, { data, title: TEXT.learnTitle });
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
            type = { ...parsed.type, id: typeId, builtin: false };
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
const DETECTION_MODES = ["count", "timed", "combined"];
const MODE_LABELS = { count: "modeCount", timed: "modeTimed", combined: "modeCombined" };
export function evaluationTexts(evaluation) {
    const out = {};
    for (const e of evaluation) {
        out[`eval_${e.mode}`] = evaluationText(e);
    }
    return out;
}
export function evaluationText(e) {
    const delay = e.detected > 0 ? ` · ${Math.round(e.endDelaySec / 60)} min (max ${Math.round(e.endDelayMaxSec / 60)} min)` : "";
    const spikes = e.falseStarts > 0 ? ` · ${e.falseStarts}×!` : "";
    return `${e.detected}/${e.runs}${delay}${spikes}`;
}
function detectionSettingsOf(t) {
    return {
        startVal: t.startVal,
        endVal: t.endVal,
        standby: t.standby,
        startCount: t.startCount,
        endCount: t.endCount,
        mode: t.mode,
        startDurationSec: t.startDurationSec,
        endDurationSec: t.endDurationSec,
        pauseHoldSec: t.pauseHoldSec,
        pauseUntilSec: t.pauseUntilSec,
        pauseBelowVal: t.pauseBelowVal,
    };
}
export function buildLearnSourceSchema() {
    return {
        type: "panel",
        items: {
            info: { type: "infoBox", boxType: "info", text: I18n.getTranslatedObject("dm_learnSourceInfo"), xs: 12 },
            source: {
                type: "select",
                label: I18n.getTranslatedObject("dm_learnSource"),
                options: [
                    { label: I18n.getTranslatedObject("dm_learnSourceHistory"), value: "history" },
                    { label: I18n.getTranslatedObject("dm_learnSourceRecord"), value: "record" },
                ],
                newLine: true,
                xs: 12,
                sm: 6,
            },
            instance: {
                type: "text",
                label: I18n.getTranslatedObject("dm_learnHistoryInstance"),
                disabled: true,
                xs: 12,
                sm: 3,
            },
            runs: { type: "number", label: I18n.getTranslatedObject("dm_learnRuns"), disabled: true, xs: 12, sm: 3 },
        },
    };
}
export function buildLearnSchema(fromHistory = false, unit = "W", withCurrent = false, withEval = fromHistory) {
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
        items: {
            info: { type: "infoBox", boxType: "info", text: I18n.getTranslatedObject("dm_learnInfo"), xs: 12 },
            name: {
                type: "text",
                label: I18n.getTranslatedObject("dm_learnName"),
                validator: "data.name && String(data.name).trim() !== ''",
                validatorErrorText: I18n.translate("dev_required"),
                newLine: true,
                xs: 12,
            },
            startVal: { ...num(I18n.getTranslatedObject("dm_learnStartVal"), 0.05, 0, unit), newLine: true },
            endVal: num(I18n.getTranslatedObject("dm_learnEndVal"), 0.05, 0, unit),
            standby: num(I18n.getTranslatedObject("dm_learnStandby"), 0.05, 0, unit),
            startCount: { ...num(I18n.getTranslatedObject("dm_learnStartCount"), 0.5, 1), newLine: true },
            endCount: num(I18n.getTranslatedObject("dm_learnEndCount"), 1, 2),
            startDurationSec: { ...num(I18n.getTranslatedObject("dm_learnStartDuration"), 1, 0, "s"), newLine: true },
            endDurationSec: num(I18n.getTranslatedObject("dm_learnEndDuration"), 1, 0, "s"),
            pauseInfo: {
                type: "staticText",
                text: I18n.getTranslatedObject("dm_learnPauseInfo"),
                newLine: true,
                xs: 12,
            },
            pauseHoldSec: { ...num(I18n.getTranslatedObject("dm_learnPauseHold"), 1, 0, "s"), newLine: true },
            pauseUntilSec: num(I18n.getTranslatedObject("dm_learnPauseUntil"), 1, 0, "s"),
            pauseBelowVal: num(I18n.getTranslatedObject("dm_learnPauseBelow"), 0.05, 0, unit),
            durationSec: {
                type: "number",
                label: I18n.getTranslatedObject("dm_learnDuration"),
                unit: "s",
                disabled: true,
                newLine: true,
                xs: 12,
                sm: 4,
            },
            samples: {
                type: "number",
                label: fromHistory
                    ? I18n.getTranslatedObject("dm_learnHistorySamples")
                    : I18n.getTranslatedObject("dm_learnSamples"),
                disabled: true,
                xs: 12,
                sm: 4,
            },
            ...(withEval ? historyItems(fromHistory, withCurrent) : {}),
        },
    };
}
function historyItems(fromHistory, withCurrent) {
    const items = {};
    if (fromHistory) {
        items.runs = { type: "number", label: I18n.getTranslatedObject("dm_learnRuns"), disabled: true, xs: 12, sm: 4 };
        items.longestPauseMin = {
            type: "number",
            label: I18n.getTranslatedObject("dm_learnLongestPause"),
            disabled: true,
            xs: 12,
            sm: 4,
        };
    }
    items.mode = {
        type: "select",
        label: I18n.getTranslatedObject("dm_detailsMode"),
        options: DETECTION_MODES.map(m => ({ label: MODE_LABELS[m], value: m })),
        newLine: true,
        xs: 12,
        sm: 4,
    };
    items.evalInfo = { type: "staticText", text: I18n.getTranslatedObject("dm_learnEvalInfo"), newLine: true, xs: 12 };
    for (const m of DETECTION_MODES) {
        items[`eval_${m}`] = { type: "text", label: MODE_LABELS[m], disabled: true, xs: 12, sm: 4 };
    }
    if (fromHistory) {
        items.looText = {
            type: "text",
            label: I18n.getTranslatedObject("dm_learnLoo"),
            disabled: true,
            newLine: true,
            xs: 12,
            sm: 4,
        };
    }
    if (withCurrent) {
        items.eval_current = {
            type: "text",
            label: I18n.getTranslatedObject("dm_learnCurrentType"),
            disabled: true,
            xs: 12,
            sm: 4,
        };
    }
    return items;
}
export function parseLearnForm(data) {
    const name = textOf(data.name).trim();
    const n = (key) => parseNumber(data[key]) ?? Number.NaN;
    const optional = (key) => (data[key] === undefined || data[key] === "" ? 0 : n(key));
    const parsed = {
        startVal: n("startVal"),
        endVal: n("endVal"),
        standby: n("standby"),
        startCount: n("startCount"),
        endCount: n("endCount"),
        startDurationSec: n("startDurationSec"),
        endDurationSec: n("endDurationSec"),
        pauseHoldSec: optional("pauseHoldSec"),
        pauseUntilSec: optional("pauseUntilSec"),
        pauseBelowVal: optional("pauseBelowVal"),
    };
    if (name === "") {
        return { error: TEXT.typeNeedsName };
    }
    if (Object.values(parsed).some(v => !Number.isFinite(v) || v < 0) || parsed.startCount < 1 || parsed.endCount < 2) {
        return {
            error: TEXT.typeValuesInvalid,
        };
    }
    const mode = DETECTION_MODES.find(m => m === data.mode) ?? "count";
    return { type: { name, mode, ...parsed } };
}
//# sourceMappingURL=deviceManagement.js.map