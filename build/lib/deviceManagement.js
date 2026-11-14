import * as I18n from "@iobroker/adapter-core/i18n";
import { ACTIONS, DeviceManagement } from "@iobroker/dm-utils";
import { DEFAULT_REMINDER, normalizeDetection, normalizeDeviceConfig } from "./config.js";
import { buildDeviceSchema, buildSourceSchema, DEFAULT_SOURCE, deviceConfigToForm, formToDeviceConfig, parseSourceChoice, } from "./deviceForm.js";
import { ensureDeviceObjects } from "./deviceObjects.js";
import { enumLabel, membershipOf, planEnumUpdate } from "./enums.js";
import { formatDate } from "./deviceRegistry.js";
import { fill, plain, TEMPLATE_NAMES, TEXT } from "./dmTexts.js";
import { allocateDeviceId } from "./ids.js";
import { FINAL_KEYS } from "./detector/types.js";
import { analyzeHistory } from "./historyLearning.js";
import { findHistoryInstance, loadHistorySeries } from "./historySource.js";
import { describeChange } from "./learn/autoOptimize.js";
import { BASE_KEYS, decisionOf, detectionOf } from "./runStore.js";
import { archiveTemplates, CUSTOM_TEMPLATE, findTemplate, scalePowers } from "./templates.js";
import { detectFromHost } from "./typeDetection.js";
import { errorMessage, parseNumber } from "./utils.js";
const RESERVED_IDS = ["info"];
const LEARN_ERRORS = {
    tooFewSamples: TEXT.learnTooFewSamples,
    noRun: TEXT.learnNoRun,
};
const GENERIC_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#607d8b" d="M16 3h-2v4h-4V3H8v4H7a2 2 0 0 0-2 2v3a6 6 0 0 0 5 5.9V21h4v-3.1a6 6 0 0 0 5-5.9V9a2 2 0 0 0-2-2h-1V3z"/></svg>';
const GENERIC_ICON = `data:image/svg+xml;base64,${Buffer.from(GENERIC_ICON_SVG).toString("base64")}`;
export function deviceModel(cfg, hasOverride) {
    if (cfg.learned === true || hasOverride) {
        return TEXT.modelLearned;
    }
    const template = findTemplate(cfg.template);
    return template ? TEMPLATE_NAMES[template.id] : TEXT.modelOwn;
}
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
                {
                    id: "removeArchive",
                    icon: "delete",
                    description: I18n.getTranslatedObject("dm_removeArchive"),
                    handler: ctx => this.removeArchive(ctx),
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
        const d = detectionOf(cfg.detection);
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
            text: I18n.getTranslatedObject("dm_detailsDetection"),
            size: 4,
            newLine: true,
            xs: 12,
        };
        if (cfg.needsReview) {
            items.needsReview = {
                type: "infoBox",
                boxType: "warning",
                text: TEXT.needsReview(cfg.reviewHint ?? ""),
                newLine: true,
                xs: 12,
            };
        }
        const rows = [];
        const template = findTemplate(cfg.template);
        if (template) {
            rows.push([I18n.getTranslatedObject("dev_template"), TEMPLATE_NAMES[template.id].en]);
        }
        rows.push([I18n.getTranslatedObject("dm_detailsStartVal"), d.startVal, "W"], [I18n.getTranslatedObject("dm_detailsEndVal"), d.endVal, "W"], [I18n.getTranslatedObject("dm_detailsStandby"), d.standby, "W"], [I18n.getTranslatedObject("dm_detailsStartCount"), d.startCount], [I18n.getTranslatedObject("dm_detailsEndCount"), d.endCount], [I18n.getTranslatedObject("dm_detailsMode"), d.mode]);
        if (d.mode !== "count") {
            rows.push([I18n.getTranslatedObject("dm_detailsStartDuration"), d.startDurationSec, "s"], [I18n.getTranslatedObject("dm_detailsEndDuration"), d.endDurationSec, "s"]);
        }
        if ((d.pauseHoldSec ?? 0) > 0) {
            rows.push([I18n.getTranslatedObject("dm_detailsPauseHold"), d.pauseHoldSec ?? 0, "s"], [I18n.getTranslatedObject("dm_detailsPauseUntil"), d.pauseUntilSec ?? 0, "s"], [I18n.getTranslatedObject("dm_detailsPauseBelow"), d.pauseBelowVal ?? 0, "W"]);
        }
        if ((d.trailerBurstSec ?? 0) > 0) {
            rows.push([I18n.getTranslatedObject("dm_learnTrailerBurst"), d.trailerBurstSec ?? 0, "s"], [I18n.getTranslatedObject("dm_learnTrailerGap"), d.trailerGapSec ?? 0, "s"], [I18n.getTranslatedObject("dm_learnTrailerAfter"), d.trailerAfterSec ?? 0, "s"], [I18n.getTranslatedObject("dm_learnTrailerBlock"), d.trailerBlockVal ?? 0, "W"], [I18n.getTranslatedObject("dm_learnTrailerMax"), d.trailerMaxSec ?? 0, "s"]);
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
        items.autoOptimize = {
            type: "staticInfo",
            label: I18n.getTranslatedObject("dm_autoOptimize"),
            data: cfg.autoOptimize ? TEXT.on : TEXT.off,
            newLine: true,
            xs: 12,
            sm: 6,
        };
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
        const legacy = this.adapter.legacyTypes;
        const direct = normalizeDeviceConfig(native, legacy).config;
        if (direct) {
            return direct;
        }
        const repaired = normalizeDeviceConfig({ ...native, powerId: "-" }, legacy).config;
        return repaired ? { ...repaired, powerId: "" } : null;
    }
    storedConfigOf(obj) {
        const cfg = this.configOf(obj);
        return cfg ? { ...(obj.native ?? {}), ...cfg } : null;
    }
    async unitFactorOf(powerId) {
        if (powerId === "") {
            return 1;
        }
        const unit = (await this.adapter.getForeignObjectAsync(powerId))?.common?.unit;
        return typeof unit === "string" && unit.trim().toLowerCase() === "kw" ? 1000 : 1;
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
                actions: this.deviceActions(id, false, false, false, false),
            };
        }
        const runtime = this.adapter.registry.get(id);
        const powerMissing = cfg.powerId === "" ||
            runtime?.powerMissing === true ||
            !(await this.adapter.getForeignObjectAsync(cfg.powerId));
        let warning = sid("alertRuntime");
        if (powerMissing) {
            warning = TEXT.powerMissing(cfg.powerId);
        }
        else if (cfg.needsReview) {
            warning = TEXT.needsReview(cfg.reviewHint ?? "");
        }
        const learning = (await this.adapter.getStateAsync(`${id}.learning.active`))?.val === true;
        const dnd = runtime?.doNotDisturb ?? false;
        const optimize = cfg.autoOptimize === true || (await this.adapter.registry.readLearningData(id)) !== null;
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
            model: deviceModel(cfg, (runtime?.currentOverride ?? null) !== null),
            icon: GENERIC_ICON,
            enabled: cfg.enabled,
            status: { warning },
            indicators,
            hasDetails: true,
            actions: this.deviceActions(id, cfg.enabled, dnd, learning, optimize),
        };
    }
    deviceActions(id, enabled, dnd, learning, optimize) {
        const actions = [
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
        if (optimize) {
            actions.push({
                id: "optimization",
                icon: "lines",
                description: I18n.getTranslatedObject("dm_optimization"),
                handler: (_id, ctx) => this.optimization(id, ctx),
            });
        }
        return actions;
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
    async askDevice(ctx, title, data, enums, detection, previous = null, source, copyHint = false) {
        let current = { ...data };
        const isNew = previous === null;
        for (;;) {
            const shownFactor = await this.unitFactorOf(textOf(current.powerId).trim());
            const result = await ctx.showForm(buildDeviceSchema(this.adapter.instanceConfig, detection, enums, shownFactor === 1000 ? "kW" : "W", copyHint), { data: current, title });
            if (!result) {
                return null;
            }
            const form = toFormData(result);
            const { config, errors, warnings } = formToDeviceConfig(form, {
                isNew,
                unitFactor: await this.unitFactorOf(textOf(form.powerId).trim()),
                ...(previous ? { previous } : {}),
                ...(source ? { source } : {}),
            });
            if (config) {
                if (warnings.length > 0) {
                    for (const warning of warnings) {
                        this.adapter.log.warn(warning);
                    }
                    await ctx.showMessage(warnings.join("\n"));
                }
                return { config, rooms: idList(result.rooms), functions: idList(result.functions) };
            }
            await ctx.showMessage(errors.join("\n"));
            current = result;
        }
    }
    async sourceValues(value, archive, devices) {
        const choice = parseSourceChoice(value);
        if (choice?.kind === "archive") {
            const found = archive.find(a => a.id === choice.id);
            if (found) {
                return { detection: found.detection, copyHint: false };
            }
        }
        else if (choice?.kind === "device") {
            const obj = devices.get(choice.id);
            const cfg = obj ? this.configOf(obj) : null;
            if (obj && cfg) {
                const base = detectionOf(cfg.detection);
                for (const key of FINAL_KEYS) {
                    base[key] = 0;
                }
                const unitFactor = await this.unitFactorOf(cfg.powerId);
                const used = FINAL_KEYS.some(key => (cfg.detection[key] ?? 0) !== 0) || isRecord(obj.native?.phases);
                return { detection: scalePowers(base, unitFactor, 1), copyHint: used };
            }
        }
        else if (choice?.kind === "template") {
            const template = findTemplate(choice.id);
            if (template) {
                return { detection: template.detection, template: template.id, copyHint: false };
            }
        }
        return { detection: CUSTOM_TEMPLATE.detection, template: CUSTOM_TEMPLATE.id, copyHint: false };
    }
    async addDevice(ctx) {
        let manual = false;
        let sourceId = "";
        let sourceChoice = DEFAULT_SOURCE;
        const instanceObj = await this.adapter.getForeignObjectAsync(`system.adapter.${this.adapter.namespace}`);
        const archive = archiveTemplates((instanceObj?.native ?? {}));
        const existing = await this.deviceObjects();
        const known = [...existing.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, obj]) => ({ id, name: this.configOf(obj)?.name ?? id }));
        for (;;) {
            const first = await ctx.showForm(buildSourceSchema(archive, known), {
                title: TEXT.addTitle,
                data: { manual, sourceId, source: sourceChoice },
                ignoreApplyDisabled: true,
            });
            if (!first) {
                return { refresh: false };
            }
            manual = first.manual === true;
            sourceId = textOf(first.sourceId).trim();
            sourceChoice = textOf(first.source) || DEFAULT_SOURCE;
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
        const values = await this.sourceValues(sourceChoice, archive, existing);
        const prefillFactor = await this.unitFactorOf(detection?.powerId ?? "");
        const prefill = {
            ...scalePowers(values.detection, 1, prefillFactor),
            enabled: true,
            name,
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
        const answer = await this.askDevice(ctx, TEXT.addTitle, prefill, enums.options, detection, null, {
            detection: values.detection,
            ...(values.template ? { template: values.template } : {}),
            unitFactor: prefillFactor,
        }, values.copyHint);
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
    async removeArchive(ctx) {
        const objId = `system.adapter.${this.adapter.namespace}`;
        const obj = await this.adapter.getForeignObjectAsync(objId);
        const types = obj?.native?.types;
        if (!obj || !Array.isArray(types) || types.length === 0) {
            await ctx.showMessage(TEXT.archiveEmpty);
            return { refresh: false };
        }
        if (!(await ctx.showConfirmation(I18n.getTranslatedObject("dm_removeArchiveConfirm")))) {
            return { refresh: false };
        }
        await this.adapter.setForeignObjectAsync(objId, {
            ...obj,
            native: { ...obj.native, types: [] },
        });
        this.log.info(`Old templates removed (${types.length})`);
        return { refresh: false };
    }
    async editDevice(id, ctx) {
        const obj = await this.adapter.getObjectAsync(id);
        const cfg = obj ? this.storedConfigOf(obj) : null;
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
        const edited = await this.askDevice(ctx, TEXT.editTitle, form, enums.options, undefined, cfg);
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
        await this.adapter.registry.removeLearningData(id);
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
    async optimization(id, ctx) {
        const registry = this.adapter.registry;
        const runtime = registry.get(id);
        if (!runtime) {
            await ctx.showMessage(TEXT.notFound);
            return { refresh: "none" };
        }
        const store = await registry.readLearningData(id);
        const active = registry.learningData(id) !== null;
        if (!store) {
            await ctx.showMessage(TEXT.optOff);
            return this.updateOf(id);
        }
        const check = active ? await registry.checkStoredRuns(id) : null;
        const view = buildOptimizationView(store, check, runtime.baseDetection, runtime.effective, active);
        const result = await ctx.showForm(view.schema, {
            data: view.data,
            title: I18n.getTranslatedObject("dm_optimization"),
            maxWidth: "lg",
        });
        const op = textOf(result?.operation);
        switch (op) {
            case "undo":
                await ctx.showMessage((await registry.undoOptimization(id)) ? TEXT.optUndone : TEXT.optNothingToUndo);
                break;
            case "reset":
                await registry.resetOptimization(id);
                await ctx.showMessage(TEXT.optResetDone);
                break;
            case "discard": {
                const runId = textOf(result?.discardRun);
                if (runId === "" || !(await registry.discardRun(id, runId))) {
                    await ctx.showMessage(TEXT.optNoRunSelected);
                    break;
                }
                await ctx.showMessage(TEXT.optDiscarded);
                break;
            }
            case "clear":
                if (await ctx.showConfirmation(I18n.getTranslatedObject("dm_optClearConfirm"))) {
                    await registry.deleteLearningData(id);
                    await ctx.showMessage(TEXT.optCleared);
                }
                break;
            case "adopt": {
                const current = registry.get(id);
                if (!current || current.currentOverride === null) {
                    await ctx.showMessage(TEXT.optNothingToAdopt);
                    break;
                }
                const changes = describeChange(current.baseDetection, current.effective) || "-";
                if (await ctx.showConfirmation(filled(TEXT.optAdoptConfirm, { changes }))) {
                    await ctx.showMessage((await this.adoptAsBase(id)) ? TEXT.optAdopted : TEXT.optAdoptFailed);
                }
                break;
            }
            default:
                break;
        }
        return this.updateOf(id);
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
        await this.applyLearned(id, result, ctx);
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
                    currentType: cfg ? detectionOf(cfg.detection) : undefined,
                    keepCurrentLevel: findTemplate(cfg?.template) !== undefined,
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
            ignoreApplyDisabled: true,
        });
        if (!choice) {
            return true;
        }
        if (choice.source !== "history") {
            return false;
        }
        await this.adapter.setStateAsync(`${id}.learning.result`, JSON.stringify(result), true);
        await this.applyLearned(id, result, ctx, unit);
        return true;
    }
    historyEnv() {
        return {
            object: id => this.adapter.getForeignObjectAsync(id),
            alive: async (instance) => (await this.adapter.getForeignStateAsync(`system.adapter.${instance}.alive`))?.val === true,
            getHistory: (id, options) => this.adapter.getHistoryAsync(id, options),
        };
    }
    async adoptAsBase(id) {
        const runtime = this.adapter.registry.get(id);
        const obj = await this.adapter.getObjectAsync(id);
        const cfg = obj ? this.storedConfigOf(obj) : null;
        if (!runtime || runtime.currentOverride === null || !cfg) {
            return false;
        }
        const detection = runtime.effective;
        const changes = describeChange(runtime.baseDetection, detection) || "-";
        const { template: _template, typeId: _typeId, ...rest } = cfg;
        try {
            await this.writeDevice(id, { ...rest, detection, learned: true });
        }
        catch (err) {
            this.adapter.log.warn(`${cfg.name}: values in use not adopted, the device was not saved: ${errorMessage(err)}`);
            return false;
        }
        this.adapter.log.info(`${cfg.name}: values in use saved as base values of the device (${changes})`);
        return true;
    }
    async applyLearned(id, suggestion, ctx, unit = "W", confirm = TEXT.learnConfirm) {
        const obj = await this.adapter.getObjectAsync(id);
        const cfg = obj ? this.storedConfigOf(obj) : null;
        if (!cfg) {
            await ctx.showMessage(TEXT.notFound);
            return;
        }
        const withTrailer = (suggestion.trailerBurstSec ?? 0) > 0;
        let data = {
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
            ...(withTrailer
                ? {
                    trailerBurstSec: suggestion.trailerBurstSec,
                    trailerGapSec: suggestion.trailerGapSec ?? 0,
                    trailerAfterSec: suggestion.trailerAfterSec ?? 0,
                    trailerBlockVal: suggestion.trailerBlockVal ?? 0,
                    trailerMaxSec: suggestion.trailerMaxSec ?? 0,
                }
                : {}),
        };
        const fromHistory = suggestion.looDetected !== undefined;
        const schema = buildLearnSchema(fromHistory, unit, suggestion.current !== undefined, suggestion.evaluation !== undefined, withTrailer, suggestion.trailer === "notSeparable", suggestion.samples > 0);
        const before = detectionOf(cfg.detection);
        let next = null;
        while (!next) {
            const result = await ctx.showForm(schema, { data, title: TEXT.learnTitle, ignoreApplyDisabled: true });
            if (!result) {
                return;
            }
            const parsed = parseLearnForm(result);
            if (!parsed.values) {
                await ctx.showMessage(parsed.error);
                data = result;
                continue;
            }
            const final = {};
            for (const key of FINAL_KEYS) {
                final[key] = before[key] ?? 0;
            }
            next = normalizeDetection({ ...final, ...parsed.values }, [], cfg.name);
        }
        const changes = describeChange(before, next) || "-";
        if (!(await ctx.showConfirmation(filled(confirm, { changes })))) {
            return;
        }
        const { template: _template, typeId: _typeId, ...rest } = cfg;
        await this.writeDevice(id, { ...rest, detection: next, learned: true });
        this.adapter.log.info(`${cfg.name}: learned detection values saved (${changes})`);
        await ctx.showMessage(TEXT.learnSaved);
    }
}
function filled(text, vars) {
    const out = {};
    for (const lang of Object.keys(text)) {
        out[lang] = fill(text, lang, vars);
    }
    return out;
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
export function suggestionOf(p) {
    return {
        thresholds: {
            startVal: p.startVal,
            endVal: p.endVal,
            standby: p.standby,
            startCount: p.startCount,
            endCount: p.endCount,
        },
        mode: p.mode,
        startDurationSec: p.startDurationSec,
        endDurationSec: p.endDurationSec,
        durationSec: 0,
        samples: 0,
        pauseHoldSec: p.pauseHoldSec ?? 0,
        pauseUntilSec: p.pauseUntilSec ?? 0,
        pauseBelowVal: p.pauseBelowVal ?? 0,
        ...((p.trailerBurstSec ?? 0) > 0
            ? {
                trailerBurstSec: p.trailerBurstSec,
                trailerGapSec: p.trailerGapSec ?? 0,
                trailerAfterSec: p.trailerAfterSec ?? 0,
                trailerBlockVal: p.trailerBlockVal ?? 0,
                trailerMaxSec: p.trailerMaxSec ?? 0,
            }
            : {}),
    };
}
const OPT_KINDS = ["repair", "tighten", "undo", "reset", "adopted", "baseChanged"];
function kindText(kind, tr) {
    const k = kind === "typeChanged" ? "baseChanged" : kind;
    return OPT_KINDS.includes(k) ? tr(`dm_optKind_${k}`) : kind;
}
function fieldText(p, key) {
    const v = p[key];
    return v === undefined ? "0" : String(v);
}
function changeText(c) {
    return (c.reason ||
        Object.entries(c.to ?? {})
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(", "));
}
export function buildOptimizationView(store, check, type, effective, active) {
    const items = {};
    const data = {};
    const tr = (key) => I18n.translate(key);
    items.info = { type: "staticText", text: I18n.getTranslatedObject("dm_optInfo"), xs: 12 };
    items.status = {
        type: "staticInfo",
        label: I18n.getTranslatedObject("dm_optStatus"),
        data: I18n.getTranslatedObject(`dm_optStatus_${active ? store.info.status : "off"}`),
        newLine: true,
        xs: 12,
        sm: 6,
    };
    items.trailer = {
        type: "staticInfo",
        label: I18n.getTranslatedObject("dm_optTrailer"),
        data: I18n.getTranslatedObject(`dm_optTrailer_${store.info.trailer}`),
        xs: 12,
        sm: 6,
    };
    items.paramsHeader = {
        type: "header",
        text: I18n.getTranslatedObject("dm_optParameter"),
        size: 4,
        newLine: true,
        xs: 12,
    };
    items.params = {
        type: "table",
        label: I18n.getTranslatedObject("dm_optParameter"),
        disabled: true,
        noDelete: true,
        xs: 12,
        items: [
            { type: "text", attr: "name", title: tr("dm_optParameter"), width: "40%" },
            { type: "text", attr: "type", title: tr("dm_optBaseValue"), width: "30%" },
            { type: "text", attr: "effective", title: tr("dm_optEffective"), width: "30%" },
        ],
    };
    const finalUsed = FINAL_KEYS.filter(k => (type[k] ?? 0) !== 0 || (effective[k] ?? 0) !== 0);
    data.params = [...BASE_KEYS, ...finalUsed].map(key => {
        const a = fieldText(type, key);
        const b = fieldText(effective, key);
        return { name: key, type: a, effective: a === b ? b : `${b} *` };
    });
    items.runsHeader = { type: "header", text: I18n.getTranslatedObject("dm_optRuns"), size: 4, newLine: true, xs: 12 };
    const all = [...store.runs, ...store.spikes]
        .filter(r => decisionOf(store, r.key)?.user !== "exclude")
        .sort((x, y) => x.ts - y.ts);
    if (all.length === 0) {
        items.none = { type: "staticText", text: I18n.getTranslatedObject("dm_optNone"), newLine: true, xs: 12 };
    }
    else {
        items.runs = {
            type: "table",
            label: I18n.getTranslatedObject("dm_optRuns"),
            disabled: true,
            noDelete: true,
            xs: 12,
            items: [
                { type: "text", attr: "date", title: tr("dm_optRunDate"), width: "22%" },
                { type: "text", attr: "duration", title: tr("dm_optRunDuration"), width: "13%" },
                { type: "text", attr: "family", title: tr("dm_optRunFamily"), width: "13%" },
                { type: "text", attr: "delay", title: tr("dm_optRunDelay"), width: "13%" },
                { type: "text", attr: "label", title: tr("dm_optRunLabel"), width: "27%" },
                { type: "text", attr: "gate", title: tr("dm_optRunGate"), width: "12%" },
            ],
        };
        data.runs = all.map(r => {
            const res = check?.perRun.find(x => x.id === r.id);
            const spike = r.label === "spike";
            const minutes = ((r.seg.runEndIdx - r.seg.startIdx + 1) * r.step) / 60_000;
            let gateText = "";
            if (check) {
                const ok = spike ? check.spikesOk : res?.ok === true;
                gateText = ok ? "\u2713" : "\u2717";
            }
            return {
                date: formatDate(r.ts + r.seg.startIdx * r.step),
                duration: spike ? "" : `${Math.round(minutes)} min`,
                family: spike || r.family < 0 ? "" : String(r.family + 1),
                delay: res && Number.isFinite(res.delaySec) ? `${Math.round(res.delaySec / 6) / 10} min` : "",
                label: tr(`dm_optLabel_${r.label}`),
                gate: gateText,
            };
        });
    }
    if (store.changes.length > 0) {
        items.changesHeader = {
            type: "header",
            text: I18n.getTranslatedObject("dm_optChanges"),
            size: 4,
            newLine: true,
            xs: 12,
        };
        items.changes = {
            type: "table",
            label: I18n.getTranslatedObject("dm_optChanges"),
            disabled: true,
            noDelete: true,
            xs: 12,
            items: [
                { type: "text", attr: "date", title: tr("dm_optRunDate"), width: "22%" },
                { type: "text", attr: "kind", title: tr("dm_optChangeKind"), width: "20%" },
                { type: "text", attr: "reason", title: tr("dm_optChangeReason"), width: "58%" },
            ],
        };
        data.changes = [...store.changes].reverse().map(c => ({
            date: formatDate(c.ts),
            kind: kindText(c.kind, tr),
            reason: changeText(c),
        }));
    }
    const ops = [
        { label: I18n.getTranslatedObject("dm_optOpNone"), value: "" },
    ];
    if (active) {
        ops.push({ label: I18n.getTranslatedObject("dm_optUndo"), value: "undo" }, { label: I18n.getTranslatedObject("dm_optReset"), value: "reset" });
        if (all.length > 0) {
            ops.push({ label: I18n.getTranslatedObject("dm_optDiscard"), value: "discard" });
        }
    }
    ops.push({ label: I18n.getTranslatedObject("dm_optClear"), value: "clear" });
    if (active) {
        ops.push({ label: I18n.getTranslatedObject("dm_optAdopt"), value: "adopt" });
    }
    items.operation = {
        type: "select",
        label: I18n.getTranslatedObject("dm_optOperation"),
        options: ops,
        newLine: true,
        xs: 12,
        sm: 6,
    };
    data.operation = "";
    if (active && all.length > 0) {
        items.discardRun = {
            type: "select",
            label: I18n.getTranslatedObject("dm_optDiscardRun"),
            options: all.map(r => ({
                label: `${formatDate(r.ts + r.seg.startIdx * r.step)} \u00b7 ${tr(`dm_optLabel_${r.label}`)}`,
                value: r.id,
            })),
            hidden: "data.operation !== 'discard'",
            xs: 12,
            sm: 6,
        };
        data.discardRun = "";
    }
    return { schema: { type: "panel", items }, data };
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
export function buildLearnSchema(fromHistory = false, unit = "W", withCurrent = false, withEval = fromHistory, withTrailer = false, notSeparable = false, withSamples = true) {
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
            ...(withTrailer ? trailerItems(unit, num) : {}),
            ...(notSeparable
                ? {
                    trailerNotSeparable: {
                        type: "infoBox",
                        boxType: "warning",
                        text: I18n.getTranslatedObject("dm_learnTrailerNotSeparable"),
                        newLine: true,
                        xs: 12,
                    },
                }
                : {}),
            ...(withSamples
                ? {
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
                }
                : {}),
            ...(withEval ? historyItems(fromHistory, withCurrent) : {}),
        },
    };
}
function trailerItems(unit, num) {
    return {
        trailerInfo: {
            type: "staticText",
            text: I18n.getTranslatedObject("dm_learnTrailerInfo"),
            newLine: true,
            xs: 12,
        },
        trailerBurstSec: { ...num(I18n.getTranslatedObject("dm_learnTrailerBurst"), 1, 0, "s"), newLine: true },
        trailerGapSec: num(I18n.getTranslatedObject("dm_learnTrailerGap"), 1, 0, "s"),
        trailerMaxSec: num(I18n.getTranslatedObject("dm_learnTrailerMax"), 1, 0, "s"),
        trailerAfterSec: { ...num(I18n.getTranslatedObject("dm_learnTrailerAfter"), 1, 0, "s"), newLine: true },
        trailerBlockVal: num(I18n.getTranslatedObject("dm_learnTrailerBlock"), 0.05, 0, unit),
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
            label: I18n.getTranslatedObject("dm_learnCurrent"),
            disabled: true,
            xs: 12,
            sm: 4,
        };
    }
    return items;
}
const TRAILER_FIELDS = [
    "trailerBurstSec",
    "trailerGapSec",
    "trailerAfterSec",
    "trailerBlockVal",
    "trailerMaxSec",
];
export function parseLearnForm(data) {
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
    if (Object.values(parsed).some(v => !Number.isFinite(v) || v < 0) || parsed.startCount < 1 || parsed.endCount < 2) {
        return {
            error: TEXT.typeValuesInvalid,
        };
    }
    const mode = DETECTION_MODES.find(m => m === data.mode) ?? "count";
    const values = { mode, ...parsed };
    if (optional("trailerBurstSec") > 0) {
        for (const key of TRAILER_FIELDS) {
            const v = optional(key);
            if (!Number.isFinite(v) || v < 0) {
                return { error: TEXT.typeValuesInvalid };
            }
            values[key] = v;
        }
    }
    else if (!Number.isFinite(optional("trailerBurstSec")) || optional("trailerBurstSec") < 0) {
        return { error: TEXT.typeValuesInvalid };
    }
    return { values };
}
//# sourceMappingURL=deviceManagement.js.map