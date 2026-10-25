# ioBroker.device-reminder V4 — Design

Stand: 2026-10-25 · Maintainer: Eistee82

## 1. Absicht und Warum

Der Adapter `device-reminder` (ursprünglich von xenon-s) überwacht Verbraucher (Waschmaschine, Trockner, Spülmaschine, …) über deren Leistungsaufnahme, erkennt Start / Betrieb / Standby / Aus und verschickt Start- und Endnachrichten über diverse Messenger. Der Original-Maintainer hat die Entwicklung eingestellt (Issues #496, #584 im Original-Repo). Die letzte funktionierende Version ist **3.1.2** (nur auf npm, kein Git-Tag); die danach begonnene Weiterentwicklung (Branch `master`/`new_Gui`) ist nicht funktionsfähig und wird **nicht** als Basis verwendet.

Ziel ist eine **komplette Neuentwicklung (V4)** nach aktuellen ioBroker-Standards, die als Community-Adapter gepflegt wird, alle Funktionen von 3.1.2 enthält, bestehende Installationen automatisch migriert und die offenen Feature-Wünsche aus dem Original-Repo als **optionale** Erweiterungen umsetzt.

## 2. Ziele, Nicht-Ziele, Anti-Ziele

### Ziele
1. Funktionsparität mit 3.1.2 (siehe Abschnitt 4).
2. **Grundregel: Standardverhalten = Verhalten von 3.1.2.** Jede neue Funktion ist opt-in und standardmäßig aus/leer.
3. Automatische Migration der 3.1.2-Konfiguration beim ersten Start von V4.
4. Geräte-Einrichtung per Type-Detector (Steckdose wählen → Leistungs- und Schalt-State automatisch gefunden); manuelle Einrichtung bleibt gleichwertig möglich.
5. Optionale Erweiterungen aus den Original-Issues (Abschnitt 9).
6. Volle Einhaltung der PR-Checkliste `D:/Windows/Desktop/ioBroker-PR-Checkliste.md` in **jedem** Punkt sowie der dort verlinkten Seiten (Repochecker-Regeln, Review-Checkliste, Repository-Richtlinien, adapterdev.md).
7. Moderne Infrastruktur: TypeScript, ESLint/Prettier via `@iobroker/eslint-config`, Unit- + Package- + Integrationstests, GitHub Actions (check/lint, Test-Matrix, Deploy per Trusted Publishing), Dependabot + Automerge, CodeQL, Release-Script.

### Nicht-Ziele
- Weiterentwicklung des alten Codes / der alten Materialize-Admin-UI.
- Eigene React-Admin-Oberfläche (Custom-Komponenten). Die Admin-UI besteht aus jsonConfig + Device Manager (`dm-utils`).
- Anbindung an den `notification-manager` — weder als Empfänger-Typ noch für Adapter-Problemmeldungen (vom User entschieden).

### Anti-Ziele (wäre ein Fehlschlag, auch wenn es technisch läuft)
- Ein migriertes Gerät meldet Start/Ende zu anderen Zeitpunkten als unter 3.1.2.
- Nach dem Update ist die Konfiguration eines Users weg oder muss von Hand neu eingegeben werden.
- Neue Funktionen erzeugen ohne Konfiguration zusätzliche Nachrichten oder Aktionen.
- Der Adapter scheitert am Repochecker oder an der Review-Checkliste.

## 3. Rahmenbedingungen

| Thema | Festlegung |
|---|---|
| Adaptername / npm-Paket | `device-reminder` / `iobroker.device-reminder` (Name bleibt, damit bestehende Instanzen das Update bekommen) |
| Repo | zunächst `github.com/Eistee82/ioBroker.device-reminder`, später Transfer nach `iobroker-community-adapters`. **Repo-URL in package.json** zeigt bis zum Transfer auf das Eistee82-Repo; beim Transfer anpassen. npm-Rechte organisiert das ioBroker-Team. |
| Version | Major **4.0.0** (Breaking: State-IDs, Node/js-controller-Mindestversion). Version/News/Messages nur über das Release-Script. |
| Sprache | TypeScript in `src/`, Build nach `build/` (committed), **ESM** (`"type": "module"`, `.js`-Extensions in Imports, Compact-Mode-Export) |
| Node | `engines.node >= 22` (Node 20 ist seit 04/2026 EOL). CI-Matrix 22.x/24.x/26.x auf ubuntu/windows/macos |
| js-controller / admin | `js-controller >= 6.0.11`, `admin >= 7.8.20` (Device-Manager-Überarbeitung, jsonConfig-Komponente `deviceManager`; Stand 10/2026: admin stable 8.2.0, latest 8.3.4 — gegen Stable-Repo prüfen, E4033) |
| Abhängigkeiten | `@iobroker/adapter-core >= 3.2.3`, `@iobroker/type-detector` (6.x), `@iobroker/dm-utils` (3.x, API `v3`); `common.supportedMessages.deviceManager: true` + `custom: true`. Keine weiteren Laufzeit-Deps ohne Grund (das alte `jsonata` entfällt). |
| Dev-Deps | `@iobroker/testing >= 5`, `@iobroker/adapter-dev`, `@iobroker/eslint-config`, `@alcalzone/release-script` (+ Plugins iobroker, license, manual-review), `@tsconfig/node22`, `typescript`, `mocha`, `c8` |
| Timer | ausschließlich `this.setTimeout/setInterval/clearTimeout/clearInterval/delay`; alles in `onUnload` aufräumen |
| Tier | 3 (`common.tier`) · `common.type`: `household` (prüfen; 3.1.2 nutzte `energy`) |
| Sprachen | alle Texte (io-package titleLang/desc, Admin-i18n, State-Namen) in den 11 Pflichtsprachen |
| Vorlage | Projektstruktur, Workflows, Scripts, `CLAUDE.md`, `.claude/skills/precommit-check` analog zu `D:/Windows/Desktop/iobroker.hoymiles` |
| Git-Workflow | nie direkt auf `main`; Feature-Branches; PRs nur auf ausdrückliche Anweisung |

## 4. Referenz: Verhalten von 3.1.2 (muss erhalten bleiben)

Quelle: `npm pack iobroker.device-reminder@3.1.2` → `main.js`, `lib/states.js`, `io-package.json`, `admin/lib/*.js`. Der Builder muss diese Quelle lesen; die folgende Zusammenfassung ist die Spezifikation, bei Widersprüchen gilt der Code von 3.1.2.

### 4.1 Erkennungsalgorithmus (pro aktiviertem Gerät, alle 10 s)
Werte pro Typ: `startVal`, `endVal`, `standby` (Default 1, wenn leer **oder 0**), `startCount`, `endCount`. Abgeleitet (nicht konfigurierbar): `valCancel = endCount / 2`; `standbyCount = endVal <= 10 ? (endVal || 10) : 10` (main.js:387 — hängt von `endVal` ab!).

Eingang ist der letzte bekannte Leistungswert (`consumption`, per Subscription aktualisiert). Jeder Tick:

1. **Puffer füllen** (`calcStart`): Wert in Puffer pushen, Mittelwert (2 Nachkommastellen) **vor** dem Kürzen berechnen (also über bis zu `count + 1` Werte), `averageConsumption` setzen, danach Puffer auf Länge `<type>Count` kürzen (Standby-Puffer: `standbyCount`).
   - läuft (`started`): standby- und end-Puffer füllen, start-Puffer leeren.
   - läuft nicht: Wert `< startVal` → start-Puffer leeren, standby füllen; sonst start füllen, standby-Puffer leeren.
2. **Abbrucherkennung** (nur wenn `abort` aktiv und läuft): `avg(standby) < standby` und `len(standby) >= valCancel` → Status Ende, ggf. autoOff, `started=false`, alle Puffer leeren. **Keine** Endnachricht.
3. **Start**: `avg(start) > startVal` und `len(start) >= startCount` und nicht gestartet → `started=true`, Startzeit merken, Status „in Betrieb“, Startnachricht (falls Text gesetzt).
4. **Betrieb**: läuft und `avg(end) > endVal` → laufenden autoOff-Timer abbrechen, Status „in Betrieb“, Laufzeit aktualisieren; nur wenn `runtimeMax > 0`: `alertRuntime = (Laufzeit >= runtimeMax min + 1 s)`.
5. **Ende**: läuft und `avg(end) < endVal` und `len(end) >= endCount * 2/3` → Endnachricht, falls Endtext gesetzt (`startMessageSent` wird bei jedem erkannten Start true, auch ohne Starttext — die Endnachricht hängt also faktisch nur am Endtext), `started=false`, Eintrag `{start,end,runtime}` (Format `DD.MM.YYYY hh:mm:ss`) an `lastOperations` anhängen (max. 14 Einträge), `lastRuntime`, `alertRuntime=false`; Status: `avg(end) < standby` → Aus, sonst Standby; autoOff-Timer starten.
6. **Nicht laufend**: `standby <= avg(standby) < endVal` → Standby; `avg(standby) <= standby` → Aus.
7. `liveConsumption` setzen.

autoOff: Nach Ende `timer` Minuten warten (bei 0 sofort), dann Schalt-State auf `false` (nur wenn er `true` ist). Abgebrochen wird der Timer nur im Betriebszweig (Schritt 4). Das gespeicherte `autoOff` eines Geräts ist korrekt (die Admin-UI sperrt die Checkbox nur, wenn kein Schalter angegeben ist).

Bekannte Eigenheiten von 3.1.2 (wichtig für die Paritätsfrage, siehe §14):
- Abbrucherkennung greift mit Default-Typen praktisch nie: Waschmaschine `standbyCount`=10 < `valCancel`=25; Spülmaschine (`endVal` 0,25) → Standby-Puffer wird jeden Tick auf 0 gekürzt, Schritt 6 nutzt dann nur den Einzelwert.
- Beim Adapterstart werden `Status` und `messageDP` auf `initialize` gesetzt; `lastRuntime` wird mit dem aktuellen `runtime` überschrieben (nach zweitem Neustart `00:00:00`).
- Laufzeitstring via `formatDate(diff, 'hh:mm:ss')` ohne Duration-Flag → vermutlich Zeitzonenversatz (+1 h in MEZ) bzw. leerer String bei 0 — gegen js-controller prüfen.

### 4.2 Nachrichten
- Start-/Endtext: Ist der Text eine existierende Objekt-ID, wird der State-Wert als Nachricht verwendet, sonst der Text selbst.
- Nachricht wird zusätzlich in den State `messageDP` geschrieben.
- „Nicht stören“ (`config.do not disturb`) unterdrückt **nur** Sprachausgaben (Alexa, SayIt).
- Sprachausgabe: nur im Zeitfenster `activeFrom`–`activeUntil` (kein Übergang über Mitternacht); Lautstärke-State = Pfad bis zum letzten Punkt + `.speak-volume` (Alexa) bzw. `.volume` (SayIt) — existiert er nicht, wird **gar nicht** gesprochen (nur Error-Log, Ursache von #407/#408); alte Lautstärke merken (leer → 30), neue setzen, nach 1 s sprechen, nach 2 s alte Lautstärke zurück.
- Testnachricht aus der Admin-UI pro Messenger-Eintrag.

### 4.3 Messenger und ihre Parameter (3.1.2)
| Messenger | Parameter | Versand |
|---|---|---|
| Alexa | path, volume, activeFrom, activeUntil | setForeignState(path) |
| SayIt | path, volume, activeFrom, activeUntil | setForeignState(path) |
| WhatsApp (cmb) | path | setForeignState(path) |
| Telegram | inst, key (`username`/`firstname`/`chatID`), username | sendTo `telegram<inst>` `{text, [key]: username}` — Keys passen nicht zur Telegram-API (`user`/`chatId`) → #409/#483 |
| Pushover | inst, title, deviceID, prio (`normal`/`high`/`quiet`/`confirmation`), sound, ttl | sendTo `pushover<inst>`; durch Bugs werden priority/retry/expire **immer** gelöscht, `deviceID` nie gesendet (Code liest `deviceId`), leerer `ttl` mitgesendet → #410/#417 |
| Signal (cmb) | inst | sendTo `signal-cmb<inst>` `{text}` (Feld `phone` auskommentiert) |
| E-Mail | emailFrom, emailTo | sendTo `email` `{text, to, subject: text, from}` |
| Matrix | inst | sendTo `matrix<inst>` msg |
| Discord | inst, userId, userTag, userName, serverId, channelId | sendTo `discord<inst>` `{content, …}` (leere `''`-Felder werden mitgesendet) |

`inst` ist als String `.0`…`.9` gespeichert. Messenger-Einträge sind global definierte, benannte Empfänger; Geräte referenzieren pro Messenger eine Liste von Empfänger-IDs. **Datenquelle zur Laufzeit:** die Roh-Tabellenzeilen `native.<messenger>.ids` (mit Feld `id`), nicht `finalIds`; nur für Geräte gilt `native.linkedDevice.finalIds`.

### 4.4 Gerätetypen
Default (read-only Namen, Werte editierbar): washing-machine (30/15/1/2/50), dryer (120/15/1/2/20), dishwasher (15/0.25/0.5/2/120) — Reihenfolge startVal/endVal/standby/startCount/endCount. Dazu 10 Custom-Typen `custom1`…`custom10` (30/5/1/1/20), Namen frei änderbar. Status-Texte global konfigurierbar (Default `in action` / `standby` / `switched off` laut io-package; die Admin-UI schlägt für „Aus“ `device off` vor — Migration übernimmt den gespeicherten Wert).

### 4.5 States 3.1.2 (pro Gerät, `<name>` = Gerätename wie eingegeben)
`<name>.Status`, `.live consumption`, `.runtime`, `.runtime in ms`, `.lastRuntime`, `.messageDP`, `.average consumption`, `.alert runtime`, `.last operations` (JSON), `.config.do not disturb` (rw), `.config.runtime max` (rw, min).

## 5. Architektur V4

Modulschnitt (Dateinamen sind Vorschlag des Designs, Feinschnitt dem Builder überlassen):

```
src/main.ts                 Adapter-Klasse: Lifecycle, Wiring, onMessage-Router
src/lib/config.ts           Typen der neuen native-Konfiguration + Defaults + Validierung
src/lib/migration.ts        Erkennung + Umwandlung 3.1.2-Config → V4, State-Übernahme
src/lib/detector/legacy.ts  Erkennungskern 3.1.2 (rein, ohne ioBroker-Abhängigkeit, testbar)
src/lib/detector/timed.ts   optionaler zeit-/ereignisbasierter Kern (Abschnitt 9.3)
src/lib/device.ts           Laufzeit-Gerät: hält Kern, Timer, States, Messenger-Zuordnung
src/lib/stateDefinitions.ts Alle State-Definitionen (Quelle für Objekte UND docs-Tabellen)
src/lib/messenger/*.ts      ein Modul pro Messenger hinter gemeinsamem Interface
src/lib/notifier.ts         Versandlogik: DND, Zeitfenster, Erinnerungen, Aktionen
src/lib/typeDetection.ts    Kapselung von @iobroker/type-detector
src/lib/learning.ts         Anlern-Modus (Abschnitt 9.5)
```

Kernprinzip: Die Erkennungslogik ist eine **reine Zustandsmaschine** (`feed(value, now) → events[]`), völlig ohne ioBroker-API, damit sie mit Verbrauchskurven unit-getestet werden kann. Der Adapter übersetzt Events (`started`, `running`, `finished`, `aborted`, `standby`, `off`) in State-Writes, Nachrichten und Aktionen.

## 6. Konfiguration und Admin-UI (jsonConfig + Device Manager)

Aufteilung (Design-Entscheidung):
- **Geräte** werden im **Device Manager** verwaltet (Admin-Tab „Konfig-Manager“, früher „Devicemanager“, plus eingebettet in die Instanz-Einstellungen über die jsonConfig-Komponente `deviceManager`). Die Gerätekonfiguration liegt in `native` des jeweiligen `device`-Objekts `<deviceId>`, **nicht** in der Instanz-native. Änderungen wirken live ohne Adapter-Neustart (Adapter subscribed seine eigenen Geräte-Objekte), damit laufende Erkennungen nicht abgebrochen werden.
- **Gerätetypen, Empfänger, Status-Texte, Allgemeines** bleiben in der Instanz-native (`configVersion: 4`, jsonConfig).

### 6.1 Device Manager
- **Instanz-Aktion „Gerät hinzufügen“** → `showForm`-Assistent: Schritt 1 Quelle wählen (Steckdose/Gerät/Alias per `objectId` → Type-Detector, oder „manuell“); Schritt 2 vorbefülltes Formular: aktiv, Name, Typ, Leistungs-State, Schalt-State (optional), Starttext, Endtext, Abbrucherkennung, autoOff + Minuten, Empfänger (Multi-Select), eingeklappt die optionalen Erweiterungen (Erinnerung, Aktionen).
- **Gerätekarte:** Name, Typ-Icon, Status-Text, aktuelle Leistung, Laufzeit; Indikatoren „läuft“, „fertig/unquittiert“, Warnung bei `alertRuntime` oder fehlendem Leistungs-State.
- **Geräte-Aktionen:** Bearbeiten (gleiches Formular), Löschen (mit `showConfirmation`; löscht Objekte), `enable`/`disable` (reserviert), Quittieren, „Nicht stören“ umschalten, Anlernen starten/stoppen (mit Fortschritt/Ergebnisdialog, Übernahme als Custom-Typ nach Bestätigung), Testnachricht.
- **Details (aufklappbar):** letzte Läufe (`lastOperations`) als Tabelle, aktuelle Schwellen des Typs.

### 6.2 Instanz-Einstellungen (jsonConfig), Tabs
1. **Geräte** — eingebetteter Device Manager (`deviceManager`-Komponente) + Hinweis.
2. **Gerätetypen** — inkl. Erkennungsmodus pro Typ (§9.3); Default-Typen (Name gesperrt) und Custom-Typen (beliebig viele statt fix 10; migrierte custom1–10 bleiben erhalten).
3. **Empfänger** — Tabelle/Accordion: aktiv (#113), Name, Messenger-Typ, Instanz (Select der vorhandenen Instanzen), messenger-spezifische Felder (Abschnitt 4.3 + neue Messenger), optionales Zeitfenster, Test-Button (sendTo).
4. **Allgemein** — Status-Texte, Abtastintervall (Default 10 s, #386), Default-Zeitfenster.

Alle Labels/Hilfetexte in `admin/i18n/<lang>.json` (11 Sprachen), Hilfetexte klar formuliert. Eingabeprüfung über jsonConfig-Mittel (`validator`, `min`, Pflichtfelder) statt der alten `ctrlInput`-Logik; zusätzliche Plausibilitätsprüfung beim Adapterstart mit verständlicher Log-Meldung pro Gerät.

## 7. Type-Detector

- Im „Gerät hinzufügen“-Assistenten (§6.1) wählt der User per `objectId`-Picker ein Gerät/Kanal — z. B. die Steckdose oder einen im **Geräte-Manager** (`devices`-Adapter, Tab `#tab-devices`) angelegten Alias (`alias.0.*`, dort sind die Rollen meist sauber).
- `@iobroker/type-detector` 6.x: Typ `socket` → `SET` (Rolle `switch`/`state`) als Schalt-State, `ELECTRIC_POWER` (Rolle `value.power`) als Leistungs-State; Typ `electricity` → nur Leistung, kein Schalter.
- Das Ergebnis wird im Formular vorbefüllt angezeigt und ist editierbar; gespeichert werden die konkreten State-IDs plus die gewählte Quell-ID (zur Info / erneuten Erkennung).
- Manuell eingetragene States haben immer Vorrang.
- Findet der Detector nichts Passendes: Hinweis in UI/Log, keine Fehlfunktion — User trägt manuell ein.

## 8. Migration 3.1.2 → V4

1. In `onReady`: native ohne `configVersion` aber mit `linkedDevice`/`status`/`default` → Migration.
2. Komplette alte native als JSON in State `info.legacyConfig` sichern (vor jeder Änderung).
3. Umwandeln: `linkedDevice.finalIds` → Geräte-Objekte mit Config in deren `native` (inkl. `enabled`, `type`, `pathConsumption`, `pathSwitch`, `startText`, `endText`, `abort`, `autoOff`, `timer`, Empfänger-Referenzen pro Messenger), Messenger-Tabellen → Empfängerliste (IDs erhalten), `default.ids`/`custom.ids` → Typen, `status.ids[0]` → Status-Texte. Alle neuen Optionen aus.
4. Neue native per `extendForeignObject` schreiben (Adapter startet neu).
5. Nach dem Neustart: Werte aus alten States übernehmen (`last operations`, `lastRuntime`, `config.do not disturb`, `config.runtime max`, `Status`), dann alte Objekte löschen.
6. Info-Log mit Zusammenfassung (x Geräte, y Empfänger migriert, Warnungen für Einträge, die nicht übernommen werden konnten).
7. Idempotent: zweiter Lauf tut nichts. Migration ist durch Unit-Tests mit Beispiel-Configs abgedeckt.

Das exakte Speicherformat von `linkedDevice`/Messenger-Tabellen ergibt sich aus `admin/lib/adapterSettings.js` und `index_m.js` von 3.1.2 (Funktion, die beim Speichern `finalIds` erzeugt).

## 9. Optionale Erweiterungen (alle standardmäßig aus)

1. **Erinnerung bis Quittierung** (#504, #36) — pro Gerät: Intervall (min), max. Anzahl (Default 10), Quittier-Quelle (eigener Button-State `<dev>.acknowledge` und/oder beliebiger fremder State, der auf `true` geht). Nur im Zeitfenster; außerhalb pausieren und am nächsten Tag ab Fensterbeginn fortsetzen. Neustart des Geräts gilt als Quittierung.
2. **Zeitfenster für alle Empfänger** (#495) — optional pro Empfänger (Alexa/SayIt wie bisher). Nachrichten außerhalb werden verworfen (Erinnerung holt nach).
3. **Zeitbasierte Erkennung** (#435) — pro Typ wählbarer Modus „zeitbasiert“: Start, wenn Leistung ≥ `startVal` für ≥ `startDuration`; Ende, wenn Leistung < `endVal` für ≥ `endDuration` (Timer startet beim Unterschreiten, neue Werte über Schwelle setzen zurück). Ereignisbasiert, damit Steckdosen, die nur bei Änderung senden, funktionieren. Kombination mit Anzahl möglich. Abtastintervall einstellbar (#386).
4. **Aktionen** (#446, #442) — pro Gerät Liste `{Ereignis: start|end|reminder|acknowledged, State-ID, Wert}`; plus immer vorhandene, additive States `finished` (bool, bis Quittierung/Neustart true) und `lastFinished` (Zeitstempel) für Skripte.
5. **Anlernen** (#494) — Buttons `<dev>.learning.start/stop`; aufgezeichnete Kurve → Vorschlag für Typ-Parameter in State `<dev>.learning.result` (JSON) und in der Admin-UI per sendTo abrufbar; Übernahme als neuer Custom-Typ nur nach Bestätigung durch den User.
6. **Neue Messenger**: ntfy (#457), Pushsafer (#465), Gotify (#367) — jeweils als sendTo an den entsprechenden Adapter.
7. **Empfänger deaktivierbar** (#113).

### 9a. Integration und Visualisierung
1. **Erkennbar für andere Oberflächen:** saubere Rollen und Struktur (§10), damit Geräte-Manager (`devices`-Adapter mit Mini-Vis), material, jarvis und Matter die States per Type-Detector finden. Es gibt keinen Type-Detector-Typ „Haushaltsgerät“; Ziel ist, dass die States sinnvoll als `info`/`electricity` erkannt werden — Builder prüft mit `@iobroker/type-detector`, welche Rollenwahl am besten erkannt wird, ohne von §10 abzuweichen.
2. **Device Manager** als Übersicht und Bedienung (§6.1).
3. **Blockly-Blöcke** (`admin/blockly.js`, `common.blockly: true`), alle in 11 Sprachen: „Status von Gerät“, „Erinnerung quittieren“, „Nicht stören setzen“, „Testnachricht an Empfänger“ (per `sendTo`, Kommandos im `onMessage`-Router, `dm:*` ignorieren). Für „wenn Gerät fertig“ dokumentiertes Beispiel mit Trigger auf `finished`.
4. Optionaler State `lastOperationsHtml` (HTML-Tabelle) für einfache vis-Anzeige — nur erzeugt, wenn in den Allgemein-Einstellungen aktiviert.
5. **vis-2-Widgets** (Teil von V4.0, im selben Adapter): Projekt `src-widgets/` nach `ioBroker/ioBroker.vis-2-widgets-react-template` (TypeScript, Vite, `@module-federation/vite`, `bundlerType: "module"`), Build nach `widgets/device-reminder/`, `common.visWidgets` + `common.restartAdapters: ["vis-2"]`. Widgets: **Gerätekarte** (Gerät wählen; Name, Status-Text, Live-Leistung, Laufzeit, geschätzter Fortschritt/Restzeit aus dem Mittel der letzten Laufzeiten in `lastOperations`, Indikatoren läuft/fertig/Laufzeitalarm, Buttons Quittieren und „Nicht stören“, aufklappbare Historie) und **Geräteübersicht** (alle Geräte einer Instanz kompakt als Liste). Texte in 11 Sprachen; Widget-Test mit `@iobroker/vis-2-widgets-testing`.

## 10. States V4

IDs ohne Leerzeichen, korrekte Rollen, `def`, Einheiten, Namen in 11 Sprachen. Pro Gerät ein `device`-Objekt `<deviceId>` (stabile ID in der Config, aus dem Namen sanitisiert per `FORBIDDEN_CHARS`, bleibt bei Umbenennung erhalten):

| State | Typ | Rolle | rw | alt (3.1.2) |
|---|---|---|---|---|
| `status` | string | text | r | Status |
| `consumption` | number W | value.power | r | live consumption |
| `averageConsumption` | number W | value.power | r | average consumption |
| `runtime` | string | text | r | runtime |
| `runtimeMs` | number ms | value | r | runtime in ms |
| `lastRuntime` | string | text | r | lastRuntime |
| `message` | string | text | r | messageDP |
| `alertRuntime` | boolean | indicator.alarm | r | alert runtime |
| `lastOperations` | json | json | r | last operations |
| `running` | boolean | indicator.working | r | neu (additiv) |
| `finished` / `lastFinished` | boolean / number | indicator / date | r | neu (additiv) |
| `config.doNotDisturb` | boolean | switch | rw | config.do not disturb |
| `config.runtimeMax` | number min | level | rw | config.runtime max |
| `acknowledge` | boolean | button | w | neu (additiv), quittiert `finished` und Erinnerungen |
| `learning.start/stop/result` | – | button/json | – | neu, nur wenn Anlernen genutzt |

Plus `info.connection` (Repochecker) und `info.legacyConfig`. `stateDefinitions.ts` ist die einzige Quelle; die docs-Tabellen müssen damit übereinstimmen. Die Umbenennung ist der eine bewusste Breaking Change und wird in Changelog, Doku und einer Upgrade-Message (nur über Release-Prozess) kommuniziert.

## 11. Qualitätssicherung

- **Migration:** Fixtures aus dem Admin-Code von 3.1.2 abgeleitet (Speicherlogik in `admin/lib/adapterSettings.js`/`index_m.js` nachvollziehen), inkl. Varianten: leere Config, Gerät ohne `matrix`/`discord`-Arrays, alle Messenger, Custom-Typen umbenannt.
- **Parität:** Unit-Tests füttern den Legacy-Kern und eine 1:1 aus 3.1.2 extrahierte Referenzimplementierung (als Test-Fixture, nicht im Paket) mit Verbrauchskurven (Waschmaschine, Trockner, Spülmaschine, Abbruch, Standby-Übergang) und vergleichen die Event-Folgen. Kurven zunächst synthetisch; echte Logs des Users werden ergänzt, sobald vorhanden.
- Unit-Tests für Migration, Type-Detection, Messenger-Payloads, Zeitfenster, Erinnerungen.
- `@iobroker/testing` Package- und Integrationstests; Coverage-Gate wie hoymiles (c8).
- Lint 0 Warnings, keine `eslint-disable`, kein `console.log`, keine globalen Timer, `error instanceof Error ? error.message : String(error)`.
- Lokaler Repochecker (`npx @iobroker/repochecker … --local`) und adapter-check.iobroker.in grün (außer erwarteten Fork-Fehlern).
- Manueller Test mit `@iobroker/dev-server` inkl. Migration einer echten 3.1.2-Config.

## 12. Dokumentation

README kurz nach Checklisten-Struktur (Badges, Changelog unter `### **WORK IN PROGRESS**` mit `- (Eistee82) …`, alte Changelog-Einträge nach `CHANGELOG_OLD.md`, MIT, Copyright 2026 inkl. Original-Autor xenon-s). Ausführliche Doku in `docs/en/` und `docs/de/` (Setup, Geräte & Typen, Type-Detector, Empfänger je Messenger, optionale Funktionen, Migration, States-Referenz, FAQ). Kein Sentry.

## 13. Vom User entschieden

- Neuentwicklung auf Basis des Verhaltens von 3.1.2, nicht des unfertigen Folgecodes.
- Alte Config muss migriert werden.
- Type-Detector: Steckdose wählen → States automatisch; manuell bleibt möglich.
- Alle Issue-Wünsche mitnehmen, aber optional; Standard = bisheriges Verhalten.
- Repo unter Eistee82, später Transfer; npm über ioBroker-Team.
- Checkliste in jedem Punkt verbindlich.
- Kein notification-manager.
- **Parität:** Erkennungszeitpunkte (Start/Betrieb/Ende/Standby/Aus) 1:1 wie 3.1.2, inklusive der Eigenheit der Abbrucherkennung (§4.1); zusätzlich eine korrigierte Abbrucherkennung als Option (Default aus). Messenger-Payload-Bugs (Telegram-Keys, Pushover prio/deviceID/ttl, Discord-Leerfelder, Alexa ohne Volume-State) und Anzeigefehler (`lastRuntime`-Überschreiben beim Start, Laufzeitstring-Zeitzonenversatz, `initialize` beim Start) werden **behoben**. Migration setzt Telegram `username`/`firstname`/`chatID` auf die passenden Felder des Telegram-Adapters um.
- **Migrations-Testdaten:** aus dem Admin-Code von 3.1.2 abgeleitete Beispiel-Configs (keine echte Config verfügbar) — Risiko: Abweichungen realer Configs; daher defensive Migration (unbekannte/fehlende Felder → Warnung, nie Abbruch, Backup immer).
- Visualisierung/Blockly mitnehmen, wo sinnvoll; Device Manager („Konfig-Manager“) und Geräte-Manager (`devices`) berücksichtigen.

## 14. Entscheidungen des Designs (vom User noch zu prüfen)

- ESM + Node ≥ 22 + js-controller ≥ 6.0.11 + admin ≥ 7.6.20.
- jsonConfig + Device Manager, keine React-Komponenten. Geräte im Device Manager, Gerätekonfiguration in den Geräte-Objekten (live ohne Neustart).
- Blockly-Blöcke, Device-Manager-Karte und vis-2-Widgets alle in V4.0 — eine Auslieferung, keine Phasen (vom User entschieden).
- Quittieren über einen immer vorhandenen Button-State `<dev>.acknowledge` (setzt `finished` zurück und beendet Erinnerungen); zusätzlich optional ein fremder Quittier-State pro Gerät.
- Neue State-IDs (Breaking) mit Werteübernahme und Löschen der alten Objekte.
- Custom-Typen unbegrenzt statt fix 10.
- Nachrichten außerhalb eines Zeitfensters werden verworfen, nicht gepuffert.
- `common.type` wechselt evtl. von `energy` auf `household`.
- Erkennungsmodus (Anzahl / zeitbasiert) wird **pro Typ** gewählt; ein Gerät erbt ihn über seinen Typ. „Kombiniert“ heißt: Anzahl- UND Dauer-Bedingung müssen beide erfüllt sein.
- Erinnerungen: ein Zyklus und ein Zähler **pro Gerät**; jeder Versand prüft das Zeitfenster jedes Empfängers einzeln; liegt kein Empfänger im Fenster, pausiert der Zyklus bis zum nächsten Fensterbeginn eines Empfängers.
- Zeitfenster über Mitternacht (z. B. 22:00–06:00) werden in V4 unterstützt, ändert keine bestehende Config.
- Migration akzeptiert alle 3.x-Configs; fehlende Messenger-Arrays werden als leer behandelt. Configs aus den unveröffentlichten GitHub-Branches werden nicht gesondert unterstützt (Warnung + Backup in `info.legacyConfig`).

## 15. Dem Builder überlassen

Feinschnitt der Module, konkrete jsonConfig-Komponenten, Mechanik der Feldübernahme beim Type-Detector, Teststruktur, Reihenfolge der Umsetzung, Formulierung der i18n-Texte.
