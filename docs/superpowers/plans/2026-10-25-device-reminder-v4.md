# device-reminder V4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der finale Adapter `device-reminder` 4.0.0 in einer einzigen Auslieferung: voller Funktionsumfang von 3.1.2 (Erkennung 1:1), automatische Migration, Device Manager mit Type-Detector, alle optionalen Funktionen aus den Issues (standardmäßig aus), 12 Messenger, Blockly-Blöcke, vis-2-Widgets, vollständige Doku, CI und Repochecker grün.

**Architecture:** TypeScript-ESM-Adapter nach Vorlage `D:/Windows/Desktop/iobroker.hoymiles`. Erkennung als reine Zustandsmaschinen (`LegacyDetector`, `TimedDetector`) hinter `createDetector()`, getestet gegen ein 1:1 aus 3.1.2 portiertes Orakel. Pro Gerät eine `DeviceRuntime`, die über ein schmales `DeviceHost`-Interface States, Timer, Nachrichten, Erinnerungen und Aktionen auslöst. Gerätekonfiguration liegt in `native` der Geräte-Objekte (live nachgeladen, kein Neustart); Typen/Empfänger/Allgemeines in der Instanz-native. vis-2-Widgets als eigenes Vite-/Module-Federation-Projekt `src-widgets/` im selben Repo.

**Tech Stack:** Node ≥ 22, TypeScript ~5.7, `@iobroker/adapter-core` ^3.4, `@iobroker/dm-utils` ^3.2, `@iobroker/type-detector` ^6.2, `@iobroker/testing` ^6, mocha + `node:assert` + c8, `@iobroker/eslint-config`, `@alcalzone/release-script`; Widgets: React 19, `@mui/material` 9, `@iobroker/types-vis-2` ~2.20, `@module-federation/vite`, Vite 8, `@iobroker/build-tools`, `@iobroker/vis-2-widgets-testing`.

**Spec:** `docs/superpowers/specs/2026-10-25-device-reminder-v4-design.md` (gilt zusammen mit diesem Plan; bei Widerspruch gilt die Spec). Referenzcode 3.1.2: `npm pack iobroker.device-reminder@3.1.2` → `package/main.js`, `package/lib/states.js`, `package/io-package.json`, `package/admin/lib/{data,adapterSettings,index_m}.js`. Widget-Vorlage: `github.com/ioBroker/ioBroker.vis-2-widgets-react-template` (Ordner `src-widgets-ts/`, `tasks.ts`, `test/widgets.test.js`).

## Global Constraints

- Adaptername `device-reminder`, npm `iobroker.device-reminder`; Repo `https://github.com/Eistee82/ioBroker.device-reminder` (in `package.json` `repository.url`, `homepage`, `bugs` und `io-package.json` URLs).
- `package.json`: `"type": "module"`, `"main": "build/main.js"`, `engines.node: ">=22"`, Version bleibt `3.1.2` (nur das Release-Script ändert sie), `files: ["build/", "admin/", "widgets/", "io-package.json", "LICENSE"]`.
- `io-package.json`: `common.version` 3.1.2 + bestehende News aus 3.1.2 übernehmen (keine neuen News/Messages von Hand), `adminUI.config: "json"`, `tier: 3`, `mode: "daemon"`, `compact: true`, `blockly: true`, `dependencies: [{"js-controller": ">=6.0.11"}]`, `globalDependencies: [{"admin": ">=7.8.20"}]`, `supportedMessages: {"deviceManager": true, "custom": true}`, `visWidgets` + `restartAdapters: ["vis-2"]` (Task 16), `titleLang`/`desc` in 11 Sprachen ohne „adapter“/„iobroker“, `common.type` `household` (falls Repochecker ablehnt: `energy`).
- 11 Sprachen: en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn — io-package-Texte, `admin/i18n/<lang>.json`, Blockly-Texte, Widget-Texte; State-Namen als Objekt mit allen 11 Sprachen (`npm run translate` bzw. Übersetzungshelfer von adapter-dev).
- Relative Imports mit `.js`-Endung; Compact-Export `export default function startAdapter(options)`.
- In `src/` nur `this.setTimeout/setInterval/clearTimeout/clearInterval/delay` bzw. `host.setTimeout/clearTimeout`; nie globales `setTimeout/setInterval`.
- Kein `console.log`, kein `process.exit()`, kein `eslint-disable`, kein `@ts-nocheck`, kein `--no-verify`.
- Fehler loggen als `errorMessage(err)` (`src/lib/utils.ts`: `err instanceof Error ? err.message : String(err)`).
- Lint 0 Warnings; Prettier wie hoymiles (Tabs, Doppel-Quotes); Widgets mit eigener `eslint.config.mjs` aus der Vorlage.
- **Standard = Verhalten 3.1.2:** jede neue Option ist im Default aus/leer; ein Gerät ohne neue Optionen verhält sich exakt wie unter 3.1.2 (Ausnahme: dokumentierte Bugfixes, Spec §13).
- Git: `main` erhält nur den Initial-Commit; alle Arbeit auf `feature/v4`; kein PR ohne ausdrückliche Anweisung. Vor jedem Commit Skill `precommit-check` (Checkliste `D:/Windows/Desktop/ioBroker-PR-Checkliste.md` vollständig).
- README-Changelog: `### **WORK IN PROGRESS**` mit `- (Eistee82) …`; alte Einträge von 3.1.2 nach `CHANGELOG_OLD.md`.
- Copyright: LICENSE und README „Copyright (c) 2020-2024 xenon-s“ und „Copyright (c) 2026 Eistee82“.
- Keine E-Mail-Adresse des Maintainers in Dateien. `package.json` `author: {"name": "Eistee82"}`; `io-package.json` `authors: ["xenon-s", "Eistee82"]` (verlangt der Repochecker eine Mail: User fragen).

## Review Focus

1. Leistungs-State liefert Nicht-Zahl (`"12,5"`, `null`, `true`, `""`) → numerische Strings werden geparst, alles andere ignoriert (letzter gültiger Wert bleibt), nie `NaN` im Mittelwert. → Test in Task 7.
2. Leistungs-State existiert nicht (gelöschte Steckdose, auch nach Migration) → genau eine Warnung pro Gerät, kein Absturz, Gerät bleibt „Aus“, Device-Manager-Karte zeigt Warnung. → Tests in Task 7, 13, 14.
3. Zwei Geräte mit gleichem Namen oder Namen mit Umlauten/Leerzeichen/Punkten (auch aus der Migration) → eindeutige, gültige Objekt-IDs. → Tests in Task 5 und 14.
4. Gerät wird bearbeitet, während es läuft → bei gleicher `typeId` und `powerId` läuft der Zyklus weiter, sonst Reset mit Info-Log. → Test in Task 11.
5. Adapter wird beendet, während Timer laufen (Lautstärke zurücksetzen, autoOff, Erinnerung, Zeitmodus) → alle Timer gelöscht, keine Writes nach Unload. → Tests in Task 8, 9, 11.

---

## Ausführung per Workflow (ultracode)

Ausgeführt wird der Plan durch das Workflow-Skript `.claude/workflows/implement-device-reminder-v4.js` (gitignored). Es gelten folgende Regeln; sie haben Vorrang vor einzelnen Task-Schritten.

### Wellen (echte Abhängigkeiten, nicht Nummerierung)

| Welle | Tasks (parallel) | Voraussetzung |
|---|---|---|
| 1 | T1 | — |
| 2 | T2, T6, T12, T15a, T16a | T1 |
| 3 | T3, T4 | T2 |
| 4 | T5, T8, T10 | T4 (T8: T6; T10: T2) |
| 5 | T7, T9, T13a, T14a, T16b, T17a | T3–T6, T8 |
| 6 | T11 | T7–T10 |
| 7 | T13b → T14b (seriell, beide `main.ts`), parallel T16c | T11, T12, T13a, T14a |
| 8 | T17b | alles |
| 9 | Gesamt-Review des Branches + Fix-Schleife | T17b |

Teil-Tasks: **T13a** = `deviceForm.ts` + `deviceForm.test.js` (Task 13 Step 1, 3–5 für Form) · **T13b** = `deviceManagement.ts`, Einbettung, `deviceManagement.test.js` · **T14a** = `migration.ts` + Fixtures + `migration.test.js` (Task 14 Step 1–5 ohne `main.ts`) · **T14b** = Einhängen in `main.ts` + Integrationstest (Step 4 Teil `main.ts`, Step 6) · **T15a** = Task 15 komplett außer Step 5 (dev-server) · **T16a** = Task 16 Step 1–5 (Scaffold, `progress.ts`) · **T16b** = Widgets `DeviceCard`/`DeviceOverview` + i18n · **T16c** = Task 16 Step 6 (Widget-Test, Build) · **T17a** = Task 17 Step 1–4 Gerüst (docsStates-Test, States-Tabellen per Node-Skript aus `DEVICE_STATES` generiert, Kapitelstruktur) · **T17b** = Task 17 Step 3 (Inhalt fertig), 5–10.

### Modelle und Aufwand

| Task | Implementer | Reviewer |
|---|---|---|
| T1 | sonnet / medium | haiku / low + mechanische Gates |
| T2 | opus / high | opus / medium |
| T3 | opus / medium | sonnet / high |
| T4, T5, T8, T9 | sonnet / medium | sonnet / medium (T5: low) |
| T6, T12 | haiku / medium | haiku / low |
| T7 | sonnet / high | opus / medium |
| T10, T15a, T16a, T16b, T16c | sonnet / medium | haiku / medium |
| T11 | opus / medium | opus / medium |
| T13a, T13b | sonnet / high | sonnet / medium |
| T14a | opus / high | opus / high |
| T14b | opus / medium | opus / medium |
| T17a | haiku / medium | — (mechanische Gates) |
| T17b | sonnet / medium | haiku / medium |
| Wellen-Merge + Übersetzung | sonnet / low | — |
| Gesamt-Review | opus / high (3 Linsen: Parität/Erkennung, Migration/Daten, Checkliste/Repochecker) | — |

### Kontext sparen

- Jeder Agent liest **nur** „Global Constraints“, „Review Focus“, „Ausführung per Workflow“ und seinen eigenen Task-Abschnitt (per `Read` mit offset/limit nach `grep -n "^### Task"`), nie den ganzen Plan; aus der Spec nur die im Task genannten Paragraphen.
- Fremde Schnittstellen: `grep -rn "^export" src/lib` statt Vorgänger-Dateien zu lesen.
- 3.1.2-Referenz liegt nach T1 unter `.tmp/legacy/package/` (T1: `npm pack iobroker.device-reminder@3.1.2` + entpacken; `.tmp/` gitignored). T2 liest nur `main.js` Zeilen 376–397, 638–804, 861–895; T14a nur `grep`-Treffer zu `finalIds|\.ids|pathConsumption` in `admin/lib/*.js`.
- Ausgaben kürzen: Test/Lint/Build-Logs immer `| tail -30`.
- Reviewer bekommen nur `git diff feature/v4...feature/v4-<task>` + Task-Abschnitt + Ergebnis von `verify`, bauen nicht selbst neu.

### Konfliktregeln

- **Worktrees:** Jeder Task ab Welle 2 arbeitet in `git worktree add ../dr-wt/<task> -b feature/v4-<task> feature/v4`; `node_modules` per Junction aus dem Hauptcheckout (`cmd /c mklink /J node_modules ..\..\ioBroker.device-reminder\node_modules`), nie neu installieren. `git add` nur mit expliziten Pfaden. Der Wellen-Merge führt die Branches in aufsteigender Task-Reihenfolge nach `feature/v4` zusammen, baut, testet und entfernt die Worktrees.
- **Abhängigkeiten:** Nur T1 installiert npm-Pakete (alle aus dem Tech Stack inkl. `@iobroker/dm-utils`, `@iobroker/type-detector`, `tsx`) und legt alle Scripts an (`build:widgets`, `test:widgets`, `pretest:widgets-unit` zunächst als Stub, der mit Exit 0 und Hinweis endet). Einzige Ausnahme: T16a installiert in `src-widgets/` (eigenes Lockfile). Braucht ein Task ein weiteres Paket → Ergebnis `blocked` mit Paketname; der Orchestrator installiert seriell.
- **Eigentümer gemeinsamer Dateien:** `package.json`/Lockfile, `eslint.config.mjs` (inkl. Browser-Globals-Block für `admin/blockly.js`, Ignores `widgets/`, `src-widgets/`), `.github/workflows/*` (inkl. Job `widget-tests` mit `if: hashFiles('src-widgets/package.json') != ''`) → **T1**. `io-package.json`: T1 legt die vollständige Struktur an (`blockly: true`, `visWidgets` mit leerem `components`, `restartAdapters`, `supportedMessages`); T4 füllt nur `native.types`, T16b nur `visWidgets.*.components`; Struktur-Korrekturen nur T17b; Edits nur per `Edit` am eigenen Schlüssel. `admin/jsonConfig.json`: T1 legt die vier Tabs als Platzhalter an, T4 besitzt Typen/Empfänger/Allgemein, T13b nur „Geräte“. `src/main.ts`: T11 legt die Hook-Funktionen `initMigration()` und `initDeviceManagement()` als leere Methoden an; T13b/T14b ändern nur deren Rumpf + Import. `test/helpers/curves.js` gehört T2 (T3 darf anhängen), `fakeHost.js` gehört T7 (T7 sieht `sendTo`-Stub und Timer-Zähler gleich mit vor; andere lesen nur). `src/lib/utils.ts` gehört T6; `sanitizeId` liegt deshalb in `src/lib/ids.ts` (T5).
- **Vorab festgelegte Verträge (T1 legt sie an, danach read-only):** `src/lib/detector/types.ts` (`TypeThresholds`, `DeviceStatus`, `DetectorEvent`, `TickResult`, `DetectionMode`, `DetectionSettings`, `Detector`) und `src/lib/host.ts` (`DeviceHost`, `NotifierHost`, `MessageSink`, `RuntimeEvent`, `RuntimeListener`) — genau mit den Signaturen aus Task 2, 3, 7, 8 dieses Plans. Die Tasks importieren von dort statt die Typen selbst zu definieren. Änderungswunsch → `blocked`.
- **i18n:** Tasks schreiben nur `en` und `de`, neue Keys append-only; `npm run translate` für die übrigen 9 Sprachen läuft einmal pro Wellen-Merge. Blockly- und Widget-Texte liegen in eigenen Dateien und werden ebenfalls im Merge übersetzt.
- **Changelog/README/docs:** Tasks 2–16 ändern sie nicht; sie liefern ihre Changelog-Zeilen im Ergebnis (`changelogNotes`), T17b schreibt daraus den Changelog. Ausnahme T17a (docs-Gerüst).
- **Checkliste:** Pro Task-Commit kompaktes Gate (`npm run build && npm run lint && npm test`, `grep` auf globale Timer/`console.log`/`eslint-disable`/`@ts-nocheck`, Version/News unverändert). Die **vollständige** Checkliste (Skill `precommit-check`, jeder Punkt) läuft bei jedem Wellen-Merge und in T17b.

### Menschliche Schritte (nicht unbeaufsichtigt)

- `gh repo create` / `git push`: nur wenn beim Start des Workflows `args.allowPush === true` übergeben wurde (User-Freigabe), sonst übernimmt der Orchestrator den Push nach Rückfrage.
- Alle dev-server-/Browser-Schritte (T4 Step 6, T13 Step 6, T14 Step 7, T15 Step 5, T16 Step 7) werden **nicht** im Workflow ausgeführt; die Tasks liefern stattdessen Prüfpunkte (`humanChecks`). Der Workflow sammelt sie zu einer Abnahme-Checkliste; die Abnahme und die Doku-Screenshots macht der User zusammen mit dem Orchestrator nach dem Workflow. Gefundene Fehler gehen als Fix-Aufträge zurück.

---

## Dateistruktur

```
package.json, package-lock.json, io-package.json, tsconfig.json, tsconfig.build.json, tasks.ts,
eslint.config.mjs, prettier.config.mjs, .mocharc.json, .gitignore, .npmignore, .editorconfig,
.releaseconfig.json, LICENSE, README.md, CHANGELOG_OLD.md, CLAUDE.md (gitignored),
.claude/skills/precommit-check/SKILL.md (gitignored)
.github/workflows/{test-and-release,automerge-dependabot,codeql}.yml, .github/{dependabot,auto-merge,stale}.yml, .github/ISSUE_TEMPLATE/*
admin/device-reminder.png, admin/jsonConfig.json, admin/i18n/<11>.json, admin/blockly.js
src/main.ts                     Adapter-Klasse DeviceReminder (Lifecycle, Wiring, onMessage)
src/lib/utils.ts                errorMessage, sanitizeId, parseNumber, formatDuration, formatTimestamp, parseHhmm, isInWindow, nextWindowStart, coerceToType
src/lib/config.ts               Typen, Defaults, Normalisierung
src/lib/detector/legacy.ts      LegacyDetector (3.1.2 + Optionen)
src/lib/detector/timed.ts       TimedDetector
src/lib/detector/index.ts       createDetector, Detector-Interface
src/lib/stateDefinitions.ts     DEVICE_STATES, buildStateCommon
src/lib/deviceObjects.ts        ensureDeviceObjects, allocateDeviceId
src/lib/deviceRuntime.ts        DeviceRuntime, DeviceHost, MessageSink
src/lib/reminder.ts             ReminderScheduler
src/lib/actions.ts              runActions
src/lib/learning.ts             LearningRecorder, suggestType
src/lib/historyHtml.ts          renderHistoryHtml
src/lib/messenger/payloads.ts   buildDelivery (12 Messenger)
src/lib/messenger/voice.ts      VoiceOutput
src/lib/notifier.ts             Notifier
src/lib/deviceRegistry.ts       DeviceRegistry
src/lib/typeDetection.ts        detectPowerAndSwitch, detectFromHost
src/lib/deviceForm.ts           Formular-Schemas + Mapping
src/lib/deviceManagement.ts     ReminderDeviceManagement
src/lib/migration.ts            isLegacyConfig, migrateLegacyConfig, migrateLegacyStates
src/lib/commands.ts             handleCommand (sendTo-API für Blockly/Skripte/Widgets)
src-widgets/                    vis-2-Widget-Projekt (package.json, vite.config.ts, tsconfig*, eslint.config.mjs, src/{DeviceCard,DeviceOverview,translations}.tsx, src/i18n/<11>.json)
widgets/device-reminder/        Build-Ausgabe der Widgets (committed)
test/package.cjs, test/integration.cjs, test/widgets.test.cjs, test/helpers/{fakeHost,curves}.js
test/fixtures/legacyOracle.cjs, test/fixtures/objects/*.json, test/fixtures/legacy-config/*.json
test/*.test.js                  Unit-Tests gegen build/
docs/en/README.md, docs/de/README.md (+ img/)
```

---

### Task 1: Repo, Tooling, CI und startfähiges Grundgerüst

**Files:**
- Create: Root-Konfigurationsdateien, `src/main.ts`, `src/lib/utils.ts` (nur `errorMessage`), `admin/jsonConfig.json` (Tab „Allgemein“ mit staticText), `admin/i18n/*.json`, `admin/device-reminder.png` (aus 3.1.2 `admin/icon.png`), `test/package.cjs`, `test/integration.cjs`, `test/utils.test.js`, `.github/**`, `README.md`, `CHANGELOG_OLD.md`, `LICENSE`, `CLAUDE.md`, `.claude/skills/precommit-check/SKILL.md`, `docs/en/README.md`, `docs/de/README.md` (Gerüst)

**Interfaces:**
- Produces: `class DeviceReminder extends utils.Adapter` (`onReady/onStateChange/onObjectChange/onMessage/onUnload`); `errorMessage(err: unknown): string`; npm-Scripts `build` (`tsc -p tsconfig.build.json`), `build:widgets` (`tsx tasks.ts`, ab Task 16), `watch`, `check`, `lint` (`eslint src/ test/`), `lint:fix`, `pretest` (= build), `test:package`, `test:unit` (c8 `--lines 80 --branches 70 --functions 80` über `test/*.test.js`), `test:integration`, `test:widgets`, `test` (= package + unit), `translate`, `release`, `test:repo`.

- [ ] **Step 1:** `git init -b main`; `.gitignore` (wie hoymiles, ohne hoymiles-spezifische Analyse-Ordner; mit `.claude/`, `CLAUDE.md`, `src-widgets/node_modules/`, `src-widgets/build/`) und `LICENSE` (MIT, beide Copyright-Zeilen) → `git commit -m "chore: initial commit"`; `git switch -c feature/v4`.
- [ ] **Step 2:** Konfiguration nach hoymiles: `tsconfig*.json`, `eslint.config.mjs` (ignores `build/`, `admin/blockly.js` nur falls Lint-Regeln für Browser-Globals nicht passen — dann eigener Block mit `languageOptions.globals` statt Ignore, `widgets/`, `src-widgets/`, `*.config.mjs`, `test/fixtures/`), `prettier.config.mjs`, `.mocharc.json`, `.releaseconfig.json`, `.editorconfig`, `.github/*` (Workflows wie hoymiles: check-and-lint Node 24.x, Matrix 22.x/24.x/26.x × ubuntu/windows/macos, Deploy via `ioBroker/testing-action-deploy@v1` mit `id-token: write`; zusätzlicher Job `widget-tests` (ubuntu, Node 24.x, `npm ci && npm run build:widgets && npm run test:widgets`) ab Task 16), `package.json`, `io-package.json` laut Global Constraints. `native`: `{ "configVersion": 4, "types": [], "recipients": [], "statusTexts": {"running": "in action", "standby": "standby", "off": "switched off"}, "pollIntervalSec": 10, "historyHtml": false }`; `instanceObjects`: Kanal `info`, `info.connection` (boolean, `indicator.connected`, r, def false), `info.legacyConfig` (json, `json`, r, def "").
- [ ] **Step 3:** `npm install` (Deps aus Tech Stack, Dev-Deps wie hoymiles ohne `copyfiles`, plus `tsx`); `npm ls prettier eslint typescript` → keine `invalid:`. 3.1.2-Referenz nach `.tmp/legacy/` entpacken (`.tmp/` in `.gitignore`).
- [ ] **Step 3a:** Verträge anlegen (siehe „Ausführung per Workflow“): `src/lib/detector/types.ts` und `src/lib/host.ts` mit exakt den Typen aus Task 2/3/7/8; `jsonConfig.json` mit vier Platzhalter-Tabs; `io-package.json` vollständig strukturiert; Script-Stubs; `eslint.config.mjs` mit Blockly-Globals und Widget-Ignores; Workflow-Job `widget-tests` mit `hashFiles`-Bedingung. `npm run build` → grün (Typdateien kompilieren).
- [ ] **Step 4: Failing test** `test/utils.test.js`: `errorMessage(new Error("x")) === "x"`, `errorMessage(42) === "42"`.
- [ ] **Step 5:** `npm test` → FAIL.
- [ ] **Step 6:** `utils.ts`; `main.ts` setzt `info.connection` in `onReady` true, in `onUnload` false; Compact-Export + Direktstart-Check wie hoymiles.
- [ ] **Step 7:** `npm run build && npm run lint && npm test && npm run test:integration` → grün, 0 Warnings.
- [ ] **Step 8:** README nach Checkliste §8; `CHANGELOG_OLD.md` mit dem Changelog aus 3.1.2-README; `CLAUDE.md` + Skill `precommit-check` nach hoymiles-Vorlage angepasst.
- [ ] **Step 9:** precommit-check; `git commit -m "chore: scaffold TypeScript adapter with CI"`.
- [ ] **Step 10:** User bestätigen lassen, dann `gh repo create Eistee82/ioBroker.device-reminder --public --source . --push`, `git push -u origin feature/v4`, Topics `iobroker smarthome energy notifications household`. `gh run list --branch feature/v4 --limit 1` → success.

---

### Task 2: LegacyDetector mit Paritätstests gegen 3.1.2

**Files:**
- Create: `test/fixtures/legacyOracle.cjs`, `test/helpers/curves.js`, `src/lib/detector/legacy.ts`, `test/legacyDetector.test.js`

**Interfaces:**
- Produces (`src/lib/detector/legacy.ts`):
```ts
export interface TypeThresholds { startVal: number; endVal: number; standby: number; startCount: number; endCount: number }
export type DeviceStatus = "running" | "standby" | "off";
export type DetectorEvent = "started" | "running" | "finished" | "aborted";
export interface TickResult { events: DetectorEvent[]; status: DeviceStatus | null; average: number | null; started: boolean }
export interface LegacyOptions { abort: boolean; abortFixed?: boolean; minStartMs?: number; minEndMs?: number }
export class LegacyDetector {
	constructor(thresholds: TypeThresholds, options: LegacyOptions);
	tick(power: number, now: number): TickResult;
	get started(): boolean;
	reset(): void;
}
```
`status` = letzter in diesem Tick gesetzte Status (mehrfaches `setStatus` in 3.1.2), sonst `null`. `average` = letzter in diesem Tick geschriebene `averageConsumption`-Wert. `"running"` = Betriebszweig (Spec §4.1 Schritt 4), `"finished"` = Schritt 5, `"aborted"` = Schritt 2. In diesem Task nur `abort`; `abortFixed`/`minStartMs`/`minEndMs` folgen in Task 3 (bis dahin ignoriert).

- [ ] **Step 1:** `test/fixtures/legacyOracle.cjs`: 1:1-Port von `calcStart`, `calculation`, `evaluatingInputValue`, `evaluateStatus` und der abgeleiteten Werte (`main.js` Zeilen 376–397, 638–804, 861–895) ohne ioBroker; `setStatus`/`averageConsumption`/Nachricht/autoOff/runtime als Protokoll. Export `createOracle(thresholds, {abort}) → { tick(power) → TickResult }`. Dateikopf: Herkunft + MIT-Lizenz xenon-s.
- [ ] **Step 2:** `test/helpers/curves.js` (ein Wert = ein 10-s-Tick): `washingMachine` (3× 0 W, 200 Ticks 10–2000 W mit kurzen 0-W-Einbrüchen < 20 Ticks, 80× 0.5 W), `dryer`, `dishwasher` (Ende 0.3 W), `abortedRun` (Start, dann abrupt 0 W), `standbyAfterRun` (Ende bei 3 W: > standby, < endVal; #471), `flapping` (um startVal). Zusätzlich `withTimes(curve, stepMs)` → `[{power, now}]`.
- [ ] **Step 3: Failing test:** für jede Kurve × Default-Typ (Spec §4.4) × Custom-Typ 30/5/1/1/20 × `abort ∈ {true,false}` → `deepStrictEqual` aller TickResults Detector vs. Orakel. Einzeltests: `standbyCount` Waschmaschine = 10; Spülmaschine → Standby-Puffer nach jedem Tick leer; Waschmaschine + `abort` + `abortedRun` → kein `"aborted"`; Custom 30/5/1/1/20 + `abort` + `abortedRun` → `"aborted"`; `standby: 0` verhält sich wie `1`; `"finished"` erst bei `len(end) >= endCount*2/3`.
- [ ] **Step 4:** FAIL. **Step 5:** implementieren (Mittelwert vor dem Kürzen, `Math.round(x*100)/100`). **Step 6:** PASS.
- [ ] **Step 7:** precommit-check; `git commit -m "feat: legacy detection core with parity tests against 3.1.2"`.

---

### Task 3: Zeitbasierte/kombinierte Erkennung und korrigierte Abbrucherkennung

**Files:**
- Create: `src/lib/detector/timed.ts`, `src/lib/detector/index.ts`, `test/timedDetector.test.js`
- Modify: `src/lib/detector/legacy.ts`, `test/legacyDetector.test.js`

**Interfaces:**
- Consumes: Task 2.
- Produces:
```ts
// detector/index.ts
export type DetectionMode = "count" | "timed" | "combined";
export interface DetectionSettings extends TypeThresholds { mode: DetectionMode; startDurationSec: number; endDurationSec: number }
export interface Detector { tick(power: number, now: number): TickResult; feed?(power: number, now: number): TickResult; readonly started: boolean; reset(): void }
export function createDetector(s: DetectionSettings, o: { abort: boolean; abortFixed: boolean }): Detector;
// detector/timed.ts
export class TimedDetector implements Detector { constructor(s: DetectionSettings, o: { abort: boolean }); feed(power: number, now: number): TickResult; tick(power: number, now: number): TickResult }
```
Semantik (Spec §9.3):
- `count` → `LegacyDetector` (mit `abortFixed`). **`abortFixed`**: `standbyCount = max(ceil(endCount/2), 2)` statt der 3.1.2-Formel, damit `len(standby) >= valCancel` erreichbar ist.
- `timed` → `TimedDetector`: Start, wenn Leistung ≥ `startVal` ununterbrochen ≥ `startDurationSec`; Betrieb solange nicht Ende; Ende, wenn Leistung < `endVal` ununterbrochen ≥ `endDurationSec` (Timer beginnt beim Unterschreiten, Wert ≥ `endVal` setzt zurück); nach Ende: Leistung < `standby` → `off`, sonst `standby`; nicht laufend: < `standby` → `off`, < `endVal` → `standby`; Abbruch (`abort`): laufend und < `standby` ununterbrochen ≥ `endDurationSec/2` → `"aborted"`. `feed()` bei jedem neuen Leistungswert, `tick()` beim Poll (prüft nur Zeitbedingungen mit letztem Wert). `average` = aktueller Wert.
- `combined` → `LegacyDetector` mit `minStartMs = startDurationSec*1000`, `minEndMs = endDurationSec*1000`: `"started"` nur, wenn Legacy-Startbedingung erfüllt **und** Leistung seit ≥ `minStartMs` ≥ `startVal`; `"finished"` nur, wenn Legacy-Endbedingung erfüllt **und** Leistung seit ≥ `minEndMs` < `endVal`.
- Ohne `abortFixed`/`minStartMs`/`minEndMs` bleibt `LegacyDetector` bit-identisch zu Task 2 (Paritätstests bleiben grün).

- [ ] **Step 1: Failing tests:** `timedDetector.test.js`: Steckdose sendet nur bei Änderung (#435): Werte `[{0,t0},{1500,t0+10s},{0,t0+30min}]` und danach keine Werte, Poll alle 10 s → `"finished"` genau bei `t0+30min+endDurationSec`; kurzer 0-W-Einbruch < `endDurationSec` → kein Ende; Abbruch nach `endDurationSec/2` unter `standby`. `legacyDetector.test.js` ergänzen: `abortFixed` + Waschmaschine + `abortedRun` → `"aborted"`; `combined` mit `endDurationSec: 300` auf `washingMachine` → `"finished"` frühestens 300 s nach letztem Wert ≥ `endVal`; alle Paritätstests aus Task 2 unverändert grün.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** PASS.
- [ ] **Step 5:** precommit-check; `git commit -m "feat: timed and combined detection, fixed abort detection option"`.

---

### Task 4: Konfigurationsmodell und Instanz-Einstellungen

**Files:**
- Create: `src/lib/config.ts`, `test/config.test.js`
- Modify: `io-package.json` (`native.types` mit Defaults), `admin/jsonConfig.json`, `admin/i18n/*.json`

**Interfaces:**
- Consumes: `TypeThresholds` (Task 2), `DetectionMode` (Task 3).
- Produces (`src/lib/config.ts`):
```ts
export type MessengerKind = "alexa" | "sayit" | "whatsapp" | "telegram" | "pushover" | "signal" | "email" | "matrix" | "discord" | "ntfy" | "pushsafer" | "gotify";
export interface DeviceTypeConfig extends TypeThresholds { id: string; name: string; builtin: boolean; mode: DetectionMode; startDurationSec: number; endDurationSec: number }
export interface RecipientConfig {
	id: string; name: string; enabled: boolean; kind: MessengerKind; instance?: string;
	activeFrom?: string; activeUntil?: string;                                                         // alle Messenger (Zeitfenster)
	stateId?: string; volume?: number; volumeStateId?: string;                                         // alexa/sayit/whatsapp
	telegramTarget?: "user" | "chatId" | "none"; target?: string;                                       // telegram
	title?: string; device?: string; priority?: number; sound?: string; ttl?: number;                  // pushover/pushsafer/gotify/ntfy
	topic?: string;                                                                                    // ntfy
	emailFrom?: string; emailTo?: string;                                                              // email
	userId?: string; userTag?: string; userName?: string; serverId?: string; channelId?: string;       // discord
}
export interface StatusTexts { running: string; standby: string; off: string }
export interface InstanceConfig { configVersion: 4; types: DeviceTypeConfig[]; recipients: RecipientConfig[]; statusTexts: StatusTexts; pollIntervalSec: number; historyHtml: boolean }
export type ActionEvent = "start" | "end" | "reminder" | "acknowledged";
export interface DeviceAction { event: ActionEvent; stateId: string; value: string }
export interface ReminderConfig { enabled: boolean; intervalMin: number; maxCount: number; text: string; ackStateId: string }
export interface DeviceConfig {
	enabled: boolean; name: string; typeId: string; sourceId?: string; powerId: string; switchId?: string;
	startText: string; endText: string; abort: boolean; abortFixed: boolean; autoOff: boolean; autoOffMinutes: number; recipients: string[];
	reminder: ReminderConfig; actions: DeviceAction[];
}
export const DEFAULT_TYPES: DeviceTypeConfig[];
export const DEFAULT_REMINDER: ReminderConfig;   // { enabled: false, intervalMin: 30, maxCount: 10, text: "", ackStateId: "" }
export function normalizeInstanceConfig(native: Record<string, unknown>): { config: InstanceConfig; warnings: string[] };
export function normalizeDeviceConfig(native: Record<string, unknown>): { config: DeviceConfig | null; warnings: string[] };
export function findType(config: InstanceConfig, typeId: string): DeviceTypeConfig | undefined;
```
`DEFAULT_TYPES`: `washing-machine` 30/15/1/2/50, `dryer` 120/15/1/2/20, `dishwasher` 15/0.25/0.5/2/120 (`builtin: true`), `custom1`…`custom10` 30/5/1/1/20 (`builtin: false`); alle `mode: "count"`, `startDurationSec: 60`, `endDurationSec: 300`. Beliebig viele weitere Custom-Typen erlaubt. `pollIntervalSec` 1–600, Default 10. Reminder-`text` leer → Endtext.

- [ ] **Step 1: Failing tests:** leere native → 13 Default-Typen, Status-Texte `in action`/`standby`/`switched off`, `pollIntervalSec` 10, `historyHtml` false; Typ `standby: 0` bleibt 0; Empfänger ohne `kind` → verworfen + Warnung; Gerät ohne `powerId` → `null` + Warnung; `autoOffMinutes: "5"` → 5; Gerät ohne `reminder`/`actions`/`abortFixed` → Defaults (aus/leer/false); Aktion mit leerer `stateId` → verworfen + Warnung; unbekannte Felder ignoriert.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** PASS.
- [ ] **Step 5:** `admin/jsonConfig.json` Tabs: „Geräte“ (Platzhalter, Einbettung in Task 13), „Gerätetypen“ (`table` über `types`: name — read-only bei `builtin`, startVal/endVal/standby `min 0`, startCount `min 1`, endCount `min 2`, mode-Select, startDurationSec/endDurationSec nur bei mode ≠ `count`), „Empfänger“ (`accordion` über `recipients`: enabled, name, kind-Select, Felder per `hidden` je `kind`, `instance` per `instance`-Komponente mit passendem `adapter`, `stateId`/`volumeStateId` per `objectId`, `activeFrom`/`activeUntil` per `timePicker` für alle Kinds, Button `sendTo` command `testRecipient` mit `{"id": "${data.id}"}`), „Allgemein“ (Status-Texte, `pollIntervalSec` mit Hinweis, dass Anzahl-Werte Ticks zählen, `historyHtml`). Labels/Hilfetexte als i18n-Keys, `npm run translate`.
- [ ] **Step 6:** dev-server `watch`: alle Tabs rendern ohne Konsolenfehler, Speichern ok.
- [ ] **Step 7:** precommit-check; `git commit -m "feat: configuration model and instance settings UI"`.

---

### Task 5: State-Definitionen und Geräte-Objekte

**Files:**
- Create: `src/lib/stateDefinitions.ts`, `src/lib/ids.ts` (`sanitizeId`, `allocateDeviceId`), `src/lib/deviceObjects.ts`, `test/stateDefinitions.test.js`, `test/deviceObjects.test.js`

**Interfaces:**
- Consumes: `DeviceConfig`, `InstanceConfig` (Task 4).
- Produces:
```ts
export interface StateDef { id: string; name: ioBroker.Translated; type: ioBroker.CommonType; role: string; unit?: string; read: boolean; write: boolean; def: ioBroker.StateValue; min?: number; when?: "learning" | "historyHtml" }
export const DEVICE_STATES: StateDef[];
export function buildStateCommon(def: StateDef): ioBroker.StateCommon;
export function sanitizeId(name: string): string;  // lowercase; ä→ae ö→oe ü→ue ß→ss; FORBIDDEN_CHARS, Leerzeichen, Punkte → "_"; "_" zusammenfassen/trimmen; leer → "device"
export function allocateDeviceId(name: string, existingIds: ReadonlySet<string>): string; // Kollision → "_2", "_3" …
export interface ObjectWriter { extendObject(id: string, obj: Partial<ioBroker.Object>): Promise<unknown>; setObjectNotExists(id: string, obj: ioBroker.Object): Promise<unknown>; delObject(id: string): Promise<unknown> }
export async function ensureDeviceObjects(w: ObjectWriter, deviceId: string, cfg: DeviceConfig, inst: InstanceConfig): Promise<void>;
```
States (ID · Typ · Rolle · rw · def): `status` string text r "" · `consumption` number W value.power r 0 · `averageConsumption` number W value.power r 0 · `runtime` string text r "00:00:00" · `runtimeMs` number ms value r 0 · `lastRuntime` string text r "00:00:00" · `message` string text r "" · `alertRuntime` boolean indicator.alarm r false · `lastOperations` json json r "[]" · `running` boolean indicator.working r false · `finished` boolean indicator r false · `lastFinished` number date r 0 · `acknowledge` boolean button w false · `config.doNotDisturb` boolean switch rw false · `config.runtimeMax` number min level rw 0 (min 0) · `learning.start` boolean button w · `learning.stop` boolean button w · `learning.active` boolean indicator r false · `learning.result` json json r "" (`when: "learning"` → immer anlegen, da Anlernen jederzeit startbar; Feld dokumentiert Zugehörigkeit) · `lastOperationsHtml` string html r "" (`when: "historyHtml"` → nur anlegen, wenn `inst.historyHtml`, sonst löschen). Kanäle `config`, `learning`.

- [ ] **Step 1: Failing tests:** alle States mit id/name (11 Sprachen)/type/role/def; keine ID mit Leerzeichen; keine Rolle `state`/`indicator` allein außer `finished` (bewusst `indicator`); `sanitizeId("Wasch Maschine.1")` → `"wasch_maschine_1"`; `sanitizeId("Spülmaschine")` → `"spuelmaschine"`; `allocateDeviceId("Trockner", new Set(["trockner"]))` → `"trockner_2"`; `ensureDeviceObjects` (Fake-Writer) → `device`-Objekt mit `native` = cfg, Kanäle, States; `historyHtml: false` → `lastOperationsHtml` per `delObject` entfernt; Erkennbarkeit (Spec §9a.1): `new ChannelDetector().detect()` auf den erzeugten Objekten eines Geräts liefert mindestens ein Pattern (`info` oder `electricity`) — falls nicht, Rollen innerhalb der Spec-§10-Vorgaben so wählen, dass es klappt, und die Wahl im Test kommentieren.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** PASS.
- [ ] **Step 5:** precommit-check; `git commit -m "feat: state definitions and device objects"`.

---

### Task 6: Zeit-Hilfsfunktionen

**Files:**
- Modify: `src/lib/utils.ts`; Create: `test/time.test.js`

**Interfaces:**
- Produces:
```ts
export function parseNumber(val: unknown): number | null;        // finite number → number; numerischer String (auch "12,5") → number; sonst null
export function formatDuration(ms: number): string;             // "hh:mm:ss", Stunden ≥ 24 weiterzählen, 0 → "00:00:00"
export function formatTimestamp(d: Date): string;               // "DD.MM.YYYY hh:mm:ss" Ortszeit
export function parseHhmm(s: string | undefined): number | null; // "07:30" → 450 (Minuten seit Mitternacht); ungültig → null
export function isInWindow(now: Date, from?: string, until?: string): boolean; // fehlend → 00:00/23:59; from ≤ until: from ≤ t ≤ until; from > until: t ≥ from || t ≤ until
export function nextWindowStart(now: Date, from?: string, until?: string): Date; // now, falls im Fenster; sonst nächster Zeitpunkt from (heute oder morgen)
export function coerceToType(value: string, type: ioBroker.CommonType | undefined): ioBroker.StateValue; // "true"/"false" → boolean, Zahl → number, sonst String
```
- [ ] **Step 1: Failing tests:** `formatDuration(0)` "00:00:00", `formatDuration(90061000)` "25:01:01"; `formatTimestamp(new Date(2026,0,2,3,4,5))` "02.01.2026 03:04:05"; `isInWindow(22:30, "22:00", "06:00")` true, `(12:00, "22:00", "06:00")` false, `(12:00, "08:00", "20:00")` true; `nextWindowStart(23:00 bei "07:00"-"20:00")` → morgen 07:00; `parseNumber("12,5")` 12.5, `parseNumber("")` null, `parseNumber(true)` null; `coerceToType("1", "number")` 1, `coerceToType("true","boolean")` true.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** PASS. **Step 5:** precommit-check; `git commit -m "feat: time and value helpers"`.

---

### Task 7: Geräte-Laufzeit (DeviceRuntime)

**Files:**
- Create: `src/lib/deviceRuntime.ts`, `src/lib/historyHtml.ts`, `test/helpers/fakeHost.js`, `test/deviceRuntime.test.js`

**Interfaces:**
- Consumes: `createDetector`, `Detector`, `TickResult` (Task 3), `DeviceConfig`, `DeviceTypeConfig`, `StatusTexts`, `InstanceConfig` (Task 4), State-IDs (Task 5), Helfer (Task 6).
- Produces:
```ts
export interface DeviceHost {
	setOwnState(id: string, val: ioBroker.StateValue): Promise<void>;          // ack=true, relativ zum Namespace
	getOwnState(id: string): Promise<ioBroker.StateValue | null>;
	getForeignValue(id: string): Promise<ioBroker.StateValue | null>;
	setForeignValue(id: string, val: ioBroker.StateValue): Promise<void>;      // ack=false
	getForeignObjectCommonType(id: string): Promise<ioBroker.CommonType | null>; // null = Objekt fehlt
	setTimeout(cb: () => void, ms: number): unknown; clearTimeout(handle: unknown): void;
	now(): number;
	log: Pick<ioBroker.Logger, "debug" | "info" | "warn" | "error">;
}
export type RuntimeEvent = "start" | "end" | "abort";
export interface MessageSink { send(deviceId: string, text: string): Promise<void> }
export interface RuntimeListener { onRuntimeEvent(deviceId: string, ev: RuntimeEvent): void }   // für Reminder/Aktionen/Learning (Task 9/10)
export class DeviceRuntime {
	constructor(host: DeviceHost, deviceId: string, cfg: DeviceConfig, type: DeviceTypeConfig, inst: InstanceConfig, sink: MessageSink, listener: RuntimeListener);
	init(): Promise<void>;
	onPower(val: ioBroker.StateValue): Promise<void>;   // merkt Wert; im Modus timed zusätzlich detector.feed()
	onSwitch(val: ioBroker.StateValue): void;
	onOwnStateChange(relId: string, val: ioBroker.StateValue, ack: boolean): Promise<void>; // config.* bestätigen; acknowledge → finished=false (Reminder/Aktionen stößt die Registry an, Task 11)
	tick(): Promise<void>;
	resolveText(text: string): Promise<string>;
	get config(): DeviceConfig; get doNotDisturb(): boolean; get isRunning(): boolean; get lastPower(): number | null;
	canKeepStateFor(next: DeviceConfig): boolean;      // gleiche typeId und powerId
	updateConfig(next: DeviceConfig): void;            // nur bei canKeepStateFor
	dispose(): void;
}
export function renderHistoryHtml(ops: { start: string; end: string; runtime: string }[]): string; // historyHtml.ts: <table> mit thead Start/Ende/Laufzeit (en), HTML-escaped
```
Seiteneffekte je Tick (Spec §4.1/§4.2): `status` ← `texts[status]`; `averageConsumption` ← `average`; `consumption` ← letzter Wert; `started` → Startzeit, `running=true`, `finished=false`, Laufzeit, Startnachricht (wenn `startText`), `listener("start")`; `running` → autoOff-Timer abbrechen, `runtime`/`runtimeMs`, `alertRuntime` nur bei `runtimeMax > 0` (`>=` max·60000+1000); `finished` → Endnachricht (wenn `endText`), `lastOperations` anhängen (`{start,end,runtime}`, max. 14), `lastOperationsHtml` (wenn aktiviert), `lastRuntime`, `alertRuntime=false`, `running=false`, `finished=true`, `lastFinished=now`, autoOff starten, `listener("end")`; `aborted` → `running=false`, autoOff starten, keine Endnachricht, `listener("abort")`. autoOff nur bei `autoOff && switchId`; nach `autoOffMinutes` (0 → sofort) `setForeignValue(switchId,false)`, wenn letzter Schaltwert `true`. `resolveText`: Punkt nicht am Ende und Objekt existiert → State-Wert, sonst Text; Nachricht in `message`, dann `sink.send`. `init()`: `lastRuntime`, `lastOperations`, `config.*`, `finished`, `lastFinished` bleiben; `status` ← `texts.off`; `runtime` "00:00:00", `runtimeMs` 0, `running` false; `consumption` ← Fremdwert; Leistungs-Objekt fehlt → genau eine `warn` „Power state <id> of device <name> not found“, keine Events.

- [ ] **Step 1:** `test/helpers/fakeHost.js`: In-Memory-`DeviceHost` (States, Fremd-States + Objekttypen, aufgezeichnete Writes, Uhr `advance(ms)`, Timer `runTimers()`, Zähler offener Timer).
- [ ] **Step 2: Failing tests** (Waschmaschine, Kurve `washingMachine`): Start-/Endnachricht je genau einmal; `lastOperations` 1 Eintrag im richtigen Format, nach 15 Läufen 14; `runtimeMax=1` → `alertRuntime` true, nach Ende false; autoOff 2 min + Schalter true → nach 120 s abgeschaltet, Neustart innerhalb → nicht; Endtext als State-ID → State-Wert gesendet; `finished` true + `lastFinished` gesetzt nach Ende, `acknowledge` (ack=false) → `finished` false, kein `onRuntimeEvent`; `historyHtml` an → `lastOperationsHtml` enthält `<table`; Review Focus 1 (Nicht-Zahlen); Review Focus 2 (fehlendes Objekt: 1× warn nach 5 Ticks, keine Events, `status` = off); `init()` überschreibt `lastRuntime` "01:02:03" nicht; Modus `timed`: `onPower` löst Events ohne Tick aus.
- [ ] **Step 3:** FAIL. **Step 4:** implementieren. **Step 5:** PASS.
- [ ] **Step 6:** precommit-check; `git commit -m "feat: device runtime with history, runtime alert and auto-off"`.

---

### Task 8: Messenger, Sprachausgabe und Notifier

**Files:**
- Create: `src/lib/messenger/payloads.ts`, `src/lib/messenger/voice.ts`, `src/lib/notifier.ts`, `test/payloads.test.js`, `test/notifier.test.js`

**Interfaces:**
- Consumes: `RecipientConfig` (Task 4), `DeviceHost` (Task 7), `isInWindow`, `nextWindowStart` (Task 6).
- Produces:
```ts
export type SendToCall = { kind: "sendTo"; instance: string; command: string; message: unknown };
export type SetStateCall = { kind: "setState"; id: string; val: string };
export function buildDelivery(r: RecipientConfig, text: string): SendToCall | SetStateCall | null; // null für alexa/sayit
export class VoiceOutput { constructor(host: DeviceHost); speak(r: RecipientConfig, text: string): Promise<void>; dispose(): void }
export interface NotifyContext { doNotDisturb: boolean; test?: boolean }
export interface NotifyResult { sent: string[]; skippedWindow: string[] }   // Empfänger-IDs
export interface NotifierHost extends DeviceHost { sendTo(instance: string, command: string, message: unknown): void }
export class Notifier {
	constructor(host: NotifierHost, getRecipients: () => RecipientConfig[]);
	notify(recipientIds: string[], text: string, ctx: NotifyContext): Promise<NotifyResult>;
	nextWindowStartFor(recipientIds: string[], now: Date): Date | null;       // frühester Fensterbeginn der aktiven Empfänger
	sendTest(recipientId: string): Promise<{ ok: boolean; error?: string }>;
	dispose(): void;
}
```
Payloads (command immer `"send"`, leere Strings = nicht gesetzt; der Builder prüft jeden Feldnamen gegen die README des Ziel-Adapters und nennt die Quelle im Code-Kommentar): telegram `{text, user: target}` / `{text, chatId: target}` / `{text}`; pushover `{message, sound?, title?, device?, priority?, ttl?}`, bei `priority === 2` zusätzlich `retry: 60, expire: 3600`; signal `{text}` an `signal-cmb.X`; email `{text, to, subject: text, from}`; matrix `text`; discord `{content, …}` nur nicht-leere Felder; whatsapp → `setState(stateId, text)`; **ntfy** `{message: text, title?, topic?, priority?}`; **pushsafer** `{message: text, title?, device?, sound?, priority?}`; **gotify** `{message: text, title?, priority?}`.
Voice (Spec §4.2, Bugfix #407/#408): Lautstärke-State = `volumeStateId` oder Pfad bis letzter Punkt + `.speak-volume` (alexa) / `.volume` (sayit); fehlt er → nur sprechen + debug-Log; sonst alte Lautstärke merken (leer → 30), neue setzen, nach 1000 ms Text auf `stateId`, nach 2000 ms alte zurück; neue Ausgabe an denselben Empfänger ersetzt laufende Timer.
Notifier: überspringt `enabled === false` und unbekannte IDs (debug); Zeitfenster gilt für jeden Empfänger (außerhalb → `skippedWindow`, Nachricht verworfen); `doNotDisturb` unterdrückt nur alexa/sayit; `test` ignoriert DND und Fenster.

- [ ] **Step 1: Failing tests** `payloads.test.js`: exakter Payload je Messenger (`deepStrictEqual`), u. a. pushover `priority: 0` vorhanden ohne `retry`; `priority: 2` mit `retry/expire`; leerer `ttl` fehlt; `device` gesetzt; discord leere Felder fehlen; telegram `chatId: "-100123"`; ntfy mit `topic`; gotify ohne `title` → kein `title`-Feld.
- [ ] **Step 2: Failing tests** `notifier.test.js`: DND unterdrückt alexa, nicht telegram; deaktivierter Empfänger übersprungen; Telegram mit Fenster 08–20 um 22:00 → `skippedWindow`; Voice-Sequenz 0/1000/2000 ms; fehlender Volume-State → nur Sprach-Write; `nextWindowStartFor` liefert frühesten Beginn; Review Focus 5: `dispose()` vor 2000 ms → keine Writes nach `runTimers()`, 0 offene Timer; `sendTest` unbekannte ID → `{ok:false}`.
- [ ] **Step 3:** FAIL. **Step 4:** implementieren. **Step 5:** PASS.
- [ ] **Step 6:** precommit-check; `git commit -m "feat: 12 messengers, voice output and notifier with time windows"`.

---

### Task 9: Erinnerungen, Quittierung und Aktionen

**Files:**
- Create: `src/lib/reminder.ts`, `src/lib/actions.ts`, `test/reminder.test.js`, `test/actions.test.js`

**Interfaces:**
- Consumes: `DeviceHost`, `RuntimeEvent` (Task 7), `Notifier` (Task 8), `ReminderConfig`, `DeviceAction`, `ActionEvent` (Task 4), `coerceToType` (Task 6).
- Produces:
```ts
export class ReminderScheduler {
	constructor(host: DeviceHost, notifier: Notifier, getDevice: () => { cfg: DeviceConfig; text: string; doNotDisturb: boolean });
	onFinished(): void;          // startet Zyklus, wenn cfg.reminder.enabled
	acknowledge(): void;         // stoppt Zyklus
	onStarted(): void;           // Neustart = Quittierung
	readonly active: boolean; readonly sentCount: number;
	dispose(): void;
}
export async function runActions(host: DeviceHost, actions: DeviceAction[], event: ActionEvent): Promise<void>;
```
Verhalten (Spec §9.1/§9.4, Entscheidungen §14): nach `onFinished` erste Erinnerung nach `intervalMin`; bei Fälligkeit `notifier.notify(recipients, text || endText)`; wurde an mindestens einen Empfänger gesendet → `sentCount++`, nächste nach `intervalMin`; lag kein Empfänger im Fenster → nächster Versuch zu `notifier.nextWindowStartFor(...)` ohne Zählen; Stopp bei `acknowledge`, `onStarted` oder `sentCount === maxCount` (Default 10, Minimum 1). Quittier-Quellen: eigener State `acknowledge` (Task 7 leitet weiter) und optional `ackStateId` (fremder State wird `true`). Aktionen: für jede Aktion mit passendem `event` → `setForeignValue(stateId, coerceToType(value, commonType))`; fehlendes Objekt → warn, weiter mit nächster. Ereignis-Zuordnung: `start` bei Start, `end` bei Ende (nicht bei Abbruch), `reminder` bei jeder gesendeten Erinnerung, `acknowledged` bei Quittierung.

- [ ] **Step 1: Failing tests** `reminder.test.js` (fakeHost-Uhr): `enabled:false` → nie ein Versand; Intervall 30 min, max 3 → genau 3 Versände bei 30/60/90 min; Fenster 07–20 und Ende 19:50 → Versand 20:20 entfällt, nächster 07:00 Folgetag (ohne Zählen); `acknowledge` nach 1. Versand → kein weiterer; `onStarted` stoppt; Review Focus 5: `dispose()` → 0 offene Timer. `actions.test.js`: Aktion `end` mit Licht-State `"true"` (common.type boolean) → `setForeignValue(id, true)`; Aktion bei `abort` nicht ausgeführt; fehlendes Objekt → warn + andere Aktionen laufen.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** PASS.
- [ ] **Step 5:** precommit-check; `git commit -m "feat: reminders until acknowledged and configurable actions"`.

---

### Task 10: Anlernen

**Files:**
- Create: `src/lib/learning.ts`, `test/learning.test.js`

**Interfaces:**
- Consumes: `TypeThresholds`, `DeviceTypeConfig` (Task 2/4), Kurven (Task 2).
- Produces:
```ts
export interface LearningSample { t: number; p: number }
export class LearningRecorder { start(now: number): void; add(p: number, now: number): void; stop(now: number): LearningSample[]; readonly active: boolean; readonly sampleCount: number }
export interface LearningSuggestion { thresholds: TypeThresholds; startDurationSec: number; endDurationSec: number; durationSec: number; samples: number }
export function suggestType(samples: LearningSample[], pollIntervalSec: number): LearningSuggestion | { error: "tooFewSamples" | "noRun" };
```
Algorithmus (nicht durch Tests bestimmt — so umsetzen): `idle` = Median der Leistung der letzten 10 % der Samples (mind. 3); `run` = Samples mit `p > idle*3 + 2`; < 6 run-Samples → `noRun`; < 20 Samples gesamt → `tooFewSamples`. `startVal = round2(max(idle + 5, 0.25 * median(run)))`; `endVal = round2(max(idle * 1.5, idle + 1))`; `standby = round2(idle * 1.2 + 0.1)`; `longestDip` = längste Folge aufeinanderfolgender Samples zwischen erstem und letztem run-Sample mit `p < endVal`, in Ticks (`pollIntervalSec`); `endCount = max(2, ceil((longestDip + 3) * 1.5))`; `startCount = 2`; `endDurationSec = endCount * pollIntervalSec`; `startDurationSec = 2 * pollIntervalSec`. Aufnahme maximal 12 h oder 10 000 Samples (danach automatisch stoppen).

- [ ] **Step 1: Failing tests:** Kurve `washingMachine` (Samples à 10 s) → Vorschlag, mit dem `LegacyDetector` auf derselben Kurve genau ein `"started"` und genau ein `"finished"` erkennt; `dishwasher` ebenso; nur 0-W-Werte → `noRun`; 5 Samples → `tooFewSamples`; Recorder stoppt bei 10 000 Samples.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** PASS.
- [ ] **Step 5:** precommit-check; `git commit -m "feat: learn device thresholds from a recorded run"`.

---

### Task 11: Registry und Adapter-Verdrahtung

**Files:**
- Create: `src/lib/deviceRegistry.ts`, `src/lib/commands.ts`, `test/deviceRegistry.test.js`, `test/commands.test.js`
- Modify: `src/main.ts`, `test/integration.cjs`

**Interfaces:**
- Consumes: Tasks 4–10.
- Produces:
```ts
export class DeviceRegistry implements RuntimeListener {
	constructor(host: NotifierHost, notifier: Notifier, getConfig: () => InstanceConfig);
	upsert(deviceId: string, cfg: DeviceConfig): Promise<void>;   // neu, ersetzen oder Zustand behalten (canKeepStateFor → updateConfig)
	remove(deviceId: string): void;
	get(deviceId: string): DeviceRuntime | undefined;
	ids(): string[];
	foreignIdsToSubscribe(): string[];                            // powerId, switchId, reminder.ackStateId aller Geräte
	routeForeignState(id: string, val: ioBroker.StateValue): Promise<void>;
	routeOwnState(relId: string, val: ioBroker.StateValue, ack: boolean): Promise<void>; // <dev>.config.*, <dev>.acknowledge, <dev>.learning.start/stop
	tickAll(): Promise<void>;                                     // nur enabled; Fehler je Gerät isoliert
	startLearning(deviceId: string): Promise<void>; stopLearning(deviceId: string): Promise<LearningSuggestion | { error: string }>;
	acknowledge(deviceId: string): Promise<void>;
	onRuntimeEvent(deviceId: string, ev: RuntimeEvent): void;     // → ReminderScheduler + runActions
	disposeAll(): void;
}
export type Command = "testRecipient" | "status" | "acknowledge" | "setDnd" | "list";
export async function handleCommand(reg: DeviceRegistry, notifier: Notifier, cmd: string, msg: unknown): Promise<unknown>;
```
Pro Gerät: `MessageSink.send` → `notifier.notify(cfg.recipients, text, { doNotDisturb })`; je Gerät ein `ReminderScheduler`; Learning-Recorder je Gerät (`learning.active`, `learning.result` als JSON der Suggestion). `handleCommand`: `status {deviceId}` → `{status, running, finished, consumption, runtime}`; `acknowledge {deviceId}`; `setDnd {deviceId, value}`; `list` → `[{id, name}]`; `testRecipient {id}`; unbekannt → `{error: "unknownCommand"}`.
`main.ts`: `createHost(this)` bildet `DeviceHost`/`NotifierHost` auf Adapter-Methoden ab (`this.setTimeout/clearTimeout`, `sendTo`); `onReady` → Migration (Task 14 hängt sich hier ein), `normalizeInstanceConfig` (Warnungen als warn), alle `device`-Objekte laden → `normalizeDeviceConfig` → `ensureDeviceObjects` → `upsert`; Subscriptions (`foreignIdsToSubscribe`, `*.config.*`, `*.acknowledge`, `*.learning.*`, `subscribeObjects("*")`); `onObjectChange` nur für `device`-Objekte direkt unter dem Namespace (gelöscht → `remove`, geändert → `upsert` + Subscriptions abgleichen); `this.setInterval(tickAll, pollIntervalSec*1000)`; `onMessage`: `dm:*` ignorieren, sonst `handleCommand` + Antwort per Callback; `onUnload`: Interval löschen, `disposeAll`, `notifier.dispose`, `info.connection=false`, `callback()` im `finally`.

- [ ] **Step 1: Failing tests** `deviceRegistry.test.js`: Routing an richtiges Gerät; Review Focus 4: `upsert` mit geänderten Texten während `isRunning` → gleiche Instanz, kein zweiter Start; andere `typeId` → neue Instanz + info-Log; Ende → Reminder aktiv + `end`-Aktionen ausgeführt; `acknowledge` → Reminder gestoppt + `acknowledged`-Aktion; Learning start/stop schreibt `learning.result`; werfendes Gerät stoppt andere nicht; Review Focus 5: `disposeAll` → 0 offene Timer. `commands.test.js`: jedes Kommando mit erwarteter Antwort, unbekanntes → `{error:"unknownCommand"}`.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** PASS.
- [ ] **Step 5:** `test/integration.cjs` mit `defineAdditionalTests`: Gerät per `harness.objects.setObject` (native mit `powerId` auf Test-State, `pollIntervalSec: 1`), 200 W für 3 Ticks → `running === true`; danach 0 W → `finished === true`. `npm run test:integration` → PASS.
- [ ] **Step 6:** precommit-check; `git commit -m "feat: device registry, adapter wiring and sendTo command API"`.

---

### Task 12: Type-Detection

**Files:**
- Create: `src/lib/typeDetection.ts`, `test/typeDetection.test.js`, `test/fixtures/objects/*.json`

**Interfaces:**
- Produces:
```ts
export interface DetectionResult { type: "socket" | "electricity" | null; powerId: string | null; switchId: string | null; hint?: "noPattern" | "notFound" }
export function detectPowerAndSwitch(objects: Record<string, ioBroker.Object>, id: string): DetectionResult;
export async function detectFromHost(getObjectsUnder: (id: string) => Promise<Record<string, ioBroker.Object>>, id: string): Promise<DetectionResult>;
```
`new ChannelDetector().detect({ objects, id, allowedTypes: [Types.socket, Types.electricity] })`: `states` mit `name === "SET"` → `switchId`, `"ELECTRIC_POWER"` → `powerId`. Kein Pattern, aber genau ein State mit Rolle `value.power` unter `id` → nur `powerId`, `hint: "noPattern"`. `id` selbst `value.power`-State → `powerId = id`. Sonst alles `null`, `hint: "notFound"`.

- [ ] **Step 1:** Fixtures `shellyPlug`, `aliasSocket` (`alias.0.Waschmaschine`), `meterOnly`, `badRoles`, `singleState`.
- [ ] **Step 2: Failing tests:** je Fixture erwartetes Ergebnis (`deepStrictEqual`). **Step 3:** FAIL. **Step 4:** implementieren. **Step 5:** PASS.
- [ ] **Step 6:** precommit-check; `git commit -m "feat: detect power and switch states via type-detector"`.

---

### Task 13: Device Manager (Konfig-Manager) und Einbettung

**Files:**
- Create: `src/lib/deviceForm.ts`, `src/lib/deviceManagement.ts`, `test/deviceForm.test.js`, `test/deviceManagement.test.js`
- Modify: `src/main.ts`, `admin/jsonConfig.json` (Tab „Geräte“: Komponente `deviceManager`), `admin/i18n/*.json`

**Interfaces:**
- Consumes: Tasks 4, 5, 10, 11, 12.
- Produces:
```ts
export interface DeviceFormData { enabled: boolean; name: string; typeId: string; sourceId: string; powerId: string; switchId: string; startText: string; endText: string; abort: boolean; abortFixed: boolean; autoOff: boolean; autoOffMinutes: number; recipients: string[]; reminder: ReminderConfig; actions: DeviceAction[] }
export function buildSourceSchema(): JsonFormSchema;                                   // objectId "sourceId" + Checkbox "manual"
export function buildDeviceSchema(cfg: InstanceConfig, detection?: DetectionResult): JsonFormSchema; // inkl. eingeklappter Bereiche „Erinnerung“, „Aktionen“ (Tabelle), „Erweitert“ (abortFixed); Hinweis bei detection.hint
export function formToDeviceConfig(f: DeviceFormData): { config: DeviceConfig | null; errors: string[] }; // Pflicht name/typeId/powerId; autoOffMinutes ≥ 0; reminder.maxCount ≥ 1
export function deviceConfigToForm(c: DeviceConfig): DeviceFormData;
export interface DeviceReminderLike extends AdapterInstance { readonly instanceConfig: InstanceConfig; readonly registry: DeviceRegistry; readonly notifier: Notifier }
export class ReminderDeviceManagement extends DeviceManagement<DeviceReminderLike> { /* getInstanceInfo, loadDevices, getDeviceDetails */ }
```
Instanz-Aktion `add`: `showForm(buildSourceSchema())` → (nicht manuell) `detectFromHost` → `showForm(buildDeviceSchema(cfg, detection), {data})` → `formToDeviceConfig` (Fehler → `showMessage`, erneut) → `allocateDeviceId` → `ensureDeviceObjects` → `{refresh: "devices"}`. Geräte-Aktionen: `edit`, `delete` (`showConfirmation`, `delObject(id, {recursive: true})`), `enable`/`disable` (reserviert), `dnd`, `acknowledge`, `learn` (läuft nicht → `startLearning`; läuft → `stopLearning`, Ergebnis per `showForm` mit Vorschlagswerten + Name; OK → neuer Custom-Typ via `extendForeignObject` der Instanz-native — das ist der einzige Fall mit Instanz-Neustart, vorher `showConfirmation` mit diesem Hinweis), `test`. Karte: `status.warning` bei `alertRuntime` oder fehlendem Leistungs-Objekt; Indikatoren running/finished per `stateId`; Status-Text, Leistung, Laufzeit per `stateId`. `getDeviceDetails`: `lastOperations` als Tabelle + Typ-Schwellen + Erinnerungsstatus.

- [ ] **Step 1: Failing tests** `deviceForm.test.js`: Roundtrip; fehlender `powerId` → Fehler; 13 Default-Typen im Select; `hint: "notFound"` → Hinweistext-Element; Reminder-/Aktionen-Bereiche vorhanden, Default eingeklappt.
- [ ] **Step 2: Failing tests** `deviceManagement.test.js` (Fake-Adapter): `loadDevices` je Gerät mit Aktionen `edit`, `delete`, `disable`, `dnd`, `acknowledge`, `learn`, `test`; Review Focus 2: fehlendes Leistungs-Objekt → `status.warning`; `add` mit gemockten Dialogen erzeugt `trockner_2`, wenn `trockner` existiert; `learn` → Vorschlag-Dialog → neuer Custom-Typ in Instanz-native.
- [ ] **Step 3:** FAIL. **Step 4:** implementieren. **Step 5:** PASS.
- [ ] **Step 6:** dev-server: Tab „Konfig-Manager“ und Instanz-Tab „Geräte“; Gerät per Steckdose/Alias (Fixture-Objekte im dev-server) und manuell anlegen, während laufender Kurve bearbeiten, löschen, deaktivieren, DND, Quittieren, Anlernen, Testnachricht.
- [ ] **Step 7:** precommit-check; `git commit -m "feat: device management with type-detector setup, learning and acknowledge"`.

---

### Task 14: Migration von 3.1.2

**Files:**
- Create: `src/lib/migration.ts`, `test/migration.test.js`, `test/fixtures/legacy-config/{full,minimal,empty,missingArrays,renamedCustom,duplicateNames}.json`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `DeviceConfig`, `InstanceConfig`, `RecipientConfig`, `DEFAULT_TYPES` (Task 4), `allocateDeviceId`, `ensureDeviceObjects` (Task 5).
- Produces:
```ts
export function isLegacyConfig(native: Record<string, unknown>): boolean;   // kein configVersion UND (linkedDevice | status | default) vorhanden
export interface MigrationResult { instance: InstanceConfig; devices: { id: string; oldName: string; config: DeviceConfig }[]; warnings: string[] }
export function migrateLegacyConfig(native: Record<string, unknown>): MigrationResult;  // rein, ohne I/O
export interface LegacyStateIo { getOwnState(id: string): Promise<ioBroker.StateValue | null>; setOwnState(id: string, v: ioBroker.StateValue): Promise<void>; getObjectIds(prefix: string): Promise<string[]>; delObject(id: string): Promise<void> }
export async function migrateLegacyStates(io: LegacyStateIo, devices: MigrationResult["devices"]): Promise<string[]>; // Warnungen
export const LEGACY_STATE_MAP: Record<string, string>;  // "last operations"→"lastOperations", "lastRuntime"→"lastRuntime", "config.do not disturb"→"config.doNotDisturb", "config.runtime max"→"config.runtimeMax"
export const LEGACY_LEAVES: string[]; // Status, live consumption, runtime, runtime in ms, lastRuntime, messageDP, average consumption, alert runtime, last operations, config.do not disturb, config.runtime max
```
Altformat (aus 3.1.2 `admin/lib/adapterSettings.js`/`index_m.js`/`data.js` verifizieren, bevor Fixtures geschrieben werden): Geräte in `linkedDevice.finalIds` (Objekt id → `{enabled, name, type, pathConsumption, pathSwitch, startText, endText, abort, autoOff, timer, alexa:[ids], sayit:[…], telegram, whatsapp, pushover, signal, email, matrix, discord}`); Empfänger in `native.<messenger>.ids` (Zeilen mit `id`); Typen in `default.ids`/`custom.ids`; Status-Texte `status.ids[0]` (`stateAction`/`stateStandby`/`stateOff`). Umsetzung: Typ-`name` → `typeId` (Default-Typ per Name, Custom-Typ per Name → `customN`-ID erhalten, umbenannte Custom-Typen behalten ihren Namen); Empfänger-IDs `<messenger>-<alteId>`; `inst` `".0"` → `"<adapter>.0"` (signal → `signal-cmb.0`); Telegram `key` `username`/`firstname` → `telegramTarget: "user"`, `chatID` → `"chatId"`; Pushover `prio` `normal`→0, `high`→1, `quiet`→-1, `confirmation`→2, `deviceID` → `device`, leeres `ttl` → weg; `timer` → `autoOffMinutes`; alle neuen Optionen aus. Fehlende Messenger-Arrays = leer. Unbekannte Felder → Warnung.
Ablauf in `onReady` (vor allem anderen): `isLegacyConfig` → komplette native als JSON nach `info.legacyConfig` → `migrateLegacyConfig` → `migrateLegacyStates` (alte Werte lesen, alte Objekte `<oldName>.<LEGACY_LEAVES>` löschen, neue Objekte via `ensureDeviceObjects`, Werte nach `LEGACY_STATE_MAP` schreiben) → Instanz-native per `extendForeignObject` ersetzen (Adapter startet neu) → Info-Log „Migrated N devices, M recipients from 3.1.2“ + jede Warnung. Idempotent: zweiter Lauf erkennt `configVersion: 4` und tut nichts. Bricht die Migration ab: Fehler-Log, native unverändert, Adapter läuft ohne Geräte weiter (kein Crash-Loop).

- [ ] **Step 1:** Altformat in den 3.1.2-Admin-Dateien nachvollziehen, Fixtures daraus ableiten; Herleitung als Kommentar in jeder Fixture-Datei (`"_comment"`).
- [ ] **Step 2: Failing tests:** `full` → alle Geräte/Empfänger/Typen/Status-Texte korrekt (`deepStrictEqual` auf ausgewählte Geräte); Telegram/Pushover-Umsetzung exakt; `missingArrays` → kein Throw, Empfänger leer; `empty` → Default-Instanz, 0 Geräte; Review Focus 3: `duplicateNames` (zwei „Waschmaschine“) → `waschmaschine`, `waschmaschine_2`; `migrateLegacyStates` mit Fake-IO: `last operations` und `config.runtime max` übernommen, alte Objekte gelöscht, nur Leaves aus `LEGACY_LEAVES` gelöscht; Review Focus 2: Gerät mit nicht existierender `pathConsumption` wird migriert + Warnung; `isLegacyConfig` nach Migration false.
- [ ] **Step 3:** FAIL. **Step 4:** implementieren + in `main.ts` einhängen. **Step 5:** PASS.
- [ ] **Step 6:** Integrationstest ergänzen: Instanz-native = Fixture `full`, alte States angelegt → nach Start `configVersion: 4`, neue Geräte-Objekte vorhanden, `info.legacyConfig` gefüllt.
- [ ] **Step 7:** dev-server: echte 3.1.2 installieren (`npm i iobroker.device-reminder@3.1.2` im dev-server), Geräte/Messenger in der alten UI anlegen, dann V4 einspielen → Migration prüfen (Log, Konfig-Manager, Werte).
- [ ] **Step 8:** precommit-check; `git commit -m "feat: automatic migration of 3.1.2 configuration and states"`.

---

### Task 15: Blockly-Blöcke

**Files:**
- Create: `admin/blockly.js`, `test/blockly.test.js`
- Modify: `io-package.json` (`common.blockly: true`), `eslint.config.mjs` (Browser-Globals für `admin/blockly.js`: `Blockly`, `goog`, `systemLang`, `main`)

**Interfaces:**
- Consumes: `handleCommand`-Kommandos (Task 11).
- Produces: Blöcke `device_reminder_status` (Wertblock, Gerät aus Dropdown der Geräte der Instanz → Ausgabe Status-Text), `device_reminder_acknowledge` (Anweisung), `device_reminder_dnd` (Anweisung, boolean-Eingang), `device_reminder_test` (Anweisung, Empfänger-ID). Generierter Code: `sendTo("device-reminder.<inst>", "<command>", {...})`; der Status-Block liest per `getState("device-reminder.<inst>.<dev>.status").val`. Texte in 11 Sprachen (Muster wie `admin/blockly.js` der Adapter telegram/pushover).

- [ ] **Step 1: Failing test** `blockly.test.js`: lädt `admin/blockly.js` in einer `node:vm`-Sandbox mit Stub-`Blockly` (`Blocks`, `JavaScript`/`javascriptGenerator` mit `valueToCode`, `Sendto`-Kategorie) und prüft: 4 Blöcke registriert; Generator für `device_reminder_acknowledge` mit Instanz `0`, Gerät `trockner` erzeugt `sendTo("device-reminder.0", "acknowledge", {"deviceId": "trockner"});`; für jeden Block existieren Texte in 11 Sprachen.
- [ ] **Step 2:** FAIL. **Step 3:** implementieren (Generator-API des aktuellen javascript-Adapters prüfen und beide Varianten `Blockly.JavaScript` / `javascript.javascriptGenerator` unterstützen, wie telegram). **Step 4:** PASS.
- [ ] **Step 5:** dev-server mit javascript-Adapter: Blöcke erscheinen in der Kategorie „Sendto“, generieren lauffähigen Code, Quittieren wirkt.
- [ ] **Step 6:** precommit-check; `git commit -m "feat: Blockly blocks for status, acknowledge, do-not-disturb and test"`.

---

### Task 16: vis-2-Widgets

**Files:**
- Create: `src-widgets/{package.json,vite.config.ts,tsconfig.json,tsconfig.build.json,tsconfig.node.json,eslint.config.mjs,index.html}`, `src-widgets/src/{index.tsx,DeviceCard.tsx,DeviceOverview.tsx,progress.ts,translations.ts}`, `src-widgets/src/i18n/<11>.json`, `tasks.ts`, `test/widgets.test.cjs`, `test/progress.test.js` (gegen kompilierte Hilfsfunktion, siehe Step 3), `widgets/device-reminder/**` (Build)
- Modify: `io-package.json` (`visWidgets`, `restartAdapters`), `package.json` (Scripts `build:widgets`, `test:widgets`, `lint` um `src-widgets` erweitert), `.github/workflows/test-and-release.yml` (Job `widget-tests`)

**Interfaces:**
- Consumes: State-IDs (Task 5), Kommandos `acknowledge`/`setDnd` (Task 11).
- Produces:
```ts
// src-widgets/src/progress.ts (rein, testbar)
export function estimateProgress(lastOperations: { runtime: string }[], runtimeMs: number): { percent: number | null; remainingMs: number | null }; // Mittel der letzten ≤ 5 Laufzeiten; < 1 Eintrag → null; percent max 99 solange running
```
`io-package.json`: `"visWidgets": {"deviceReminder": {"i18n": "component", "name": "deviceReminder", "url": "device-reminder/customWidgets.js", "bundlerType": "module", "components": ["DeviceCard", "DeviceOverview"]}}`, `"restartAdapters": ["vis-2"]`. Federation-Name `deviceReminder`, `exposes` `./DeviceCard`, `./DeviceOverview`, `./translations`. Widgets erben von `VisRxWidget` (`@iobroker/types-vis-2`): **DeviceCard** — Attribut `oid` = Geräte-Objekt (`device-reminder.X.<dev>`, Filter `type: device`), zeigt Name, Status-Text, `consumption`, `runtime`, Fortschrittsbalken/Restzeit aus `estimateProgress`, Chips läuft/fertig/Laufzeitalarm, Buttons „Quittieren“ (setzt `acknowledge`) und „Nicht stören“ (toggelt `config.doNotDisturb`), aufklappbare Historie (`lastOperations`); Attribute für Farben/kompakte Darstellung. **DeviceOverview** — Attribut `instance`, listet alle Geräte (per `socket.getObjectViewSystem` type `device` unter dem Namespace) mit Status-Text, Leistung, Laufzeit und Fertig-Indikator; Klick quittiert. `tasks.ts` wie Vorlage (baut `src-widgets/` nach `widgets/device-reminder/`, ohne `index.html`).

- [ ] **Step 1:** `src-widgets/` aus `src-widgets-ts/` der Vorlage übernehmen (Versionen aus der Vorlage, `npm install` in `src-widgets/`), Namen anpassen, Demo-Widget entfernen.
- [ ] **Step 2: Failing test** `test/progress.test.js` gegen `src-widgets/build-test/progress.js` (eigenes `tsc -p src-widgets/tsconfig.test.json` mit `outDir: build-test`, als Script `pretest:widgets-unit`; in `.gitignore`): `[]` → `{percent:null, remainingMs:null}`; Laufzeiten 01:00:00 ×3 und `runtimeMs` 30 min → `percent: 50`, `remainingMs: 1800000`; `runtimeMs` 2 h → `percent: 99`, `remainingMs: 0`.
- [ ] **Step 3:** FAIL. **Step 4:** `progress.ts` + Widgets implementieren. **Step 5:** PASS.
- [ ] **Step 6:** `test/widgets.test.cjs` nach Vorlage (`@iobroker/vis-2-widgets-testing`: startIoBroker, startBrowser, createProject, Widgets der Palette hinzufügen, Screenshot, löschen); `npm run build:widgets && npm run test:widgets` → PASS. CI-Job `widget-tests` ergänzen.
- [ ] **Step 7:** dev-server mit vis-2: beide Widgets in der Palette, Gerätekarte zeigt Live-Werte einer laufenden Kurve, Quittieren und DND wirken, Übersicht listet alle Geräte; Darstellung hell/dunkel.
- [ ] **Step 8:** precommit-check; `git add src-widgets widgets tasks.ts …`; `git commit -m "feat: vis-2 widgets device card and overview"`.

---

### Task 17: Dokumentation, Repochecker und Release-Bereitschaft

**Files:**
- Modify: `docs/en/README.md`, `docs/de/README.md`, `README.md`, `io-package.json` (nur falls Repochecker Strukturfehler meldet — nie Version/News/Messages)
- Create: `test/docsStates.test.js`, `docs/en/img/*`, `docs/de/img/*` (Screenshots aus dev-server)

**Interfaces:**
- Consumes: `DEVICE_STATES` (Task 5), Kommandos (Task 11).

- [ ] **Step 1: Failing test** `docsStates.test.js`: States-Tabellen in `docs/en/README.md` und `docs/de/README.md` (Backtick-ID in Spalte 1) `deepStrictEqual` zu `DEVICE_STATES.map(s => s.id)` + `info.connection` + `info.legacyConfig`.
- [ ] **Step 2:** FAIL. **Step 3:** Doku (en + de, je eine Datei mit Inhaltsverzeichnis): Setup; Gerätetypen und Erkennung (Anzahl/Zeit/Kombiniert, Abbruch inkl. Eigenheit der Default-Typen und `abortFixed`); Gerät anlegen per Steckdose/Alias/manuell im Konfig-Manager; Empfänger je Messenger (alle 12, Felder, Zeitfenster inkl. über Mitternacht); Erinnerungen und Quittierung; Aktionen; Anlernen; Migration von 3.1.2 (was übernommen wird, neue State-IDs-Tabelle alt→neu, `info.legacyConfig`); Blockly (mit Screenshot) und Skript-Beispiel auf `finished`; sendTo-API (`status`, `acknowledge`, `setDnd`, `list`, `testRecipient`); vis-2-Widgets; States-Referenz (Typ, rw, Einheit, Beschreibung, Wertebereich); FAQ (Steckdose sendet nur bei Änderung → Modus „Zeit“; Alexa-Gruppen → `volumeStateId`; Telegram-Gruppen mit negativer Chat-ID). **Step 4:** PASS.
- [ ] **Step 5:** README-Changelog unter `WORK IN PROGRESS` vollständig: Rewrite (TypeScript/ESM, Node ≥ 22, js-controller ≥ 6.0.11, admin ≥ 7.8.20) als Breaking; neue State-IDs (Breaking, automatische Migration); Konfig-Manager + Type-Detector; neue Funktionen mit Issue-Nummern (#504 #36 #495 #435 #386 #446 #442 #494 #457 #465 #367 #113); Bugfixes (#400 #449 #409 #483 #410 #417 #407 #408 #397 #458 #471 #396 #581); Blockly; vis-2-Widgets.
- [ ] **Step 6:** Repochecker: `npx @iobroker/repochecker https://github.com/Eistee82/ioBroker.device-reminder feature/v4` und adapter-check.iobroker.in → alle Fehler und Warnungen beheben, außer erwarteten Fork-/Branch-Fehlern (E0019/E4005/E4007/E3007/E8002/W2002 laut Checkliste §5) — diese im Abschlussbericht auflisten. Gegenprobe globale Timer: `grep -rnE "(^|[^.\w])(setTimeout|setInterval)\(" src/` → leer.
- [ ] **Step 7:** Vollständige Verifikation: `npm ci && (cd src-widgets && npm ci) && npm ls prettier eslint typescript && npm run lint && npm run build && npm run build:widgets && npm test && npm run test:integration && npm run test:widgets` → alles grün.
- [ ] **Step 8:** Text der Upgrade-Message (Breaking Change State-IDs, 11 Sprachen) und der News für 4.0.0 als Vorlage in `docs/release-notes-4.0.0.md` ablegen — **nicht** in `io-package.json` (das macht der Maintainer beim Release).
- [ ] **Step 9:** precommit-check (vollständige Checkliste); `git commit -m "docs: complete user documentation for V4"`; `git push`; `gh run list --branch feature/v4 --limit 1` → success auf allen Jobs; bei Failure `gh run view <id> --log-failed | tail -100`, Ursache beheben, erneut.
- [ ] **Step 10:** Abschlussbericht an den User: erledigte Checklistenpunkte, verbleibende erwartete Repochecker-Meldungen, Hinweise für den Repo-Transfer nach `iobroker-community-adapters` (URLs in `package.json`/`io-package.json`/README-Badges anpassen) und für das Release (`npm run release-major` durch den Maintainer). Kein PR ohne ausdrückliche Anweisung.
