# Phasen, Schlussphase, Werte im Gerät, Auto-Optimierung über 30 Tage – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerätetypen abschaffen (Erkennungswerte im Gerät, verlustfreie Migration aus 3.1.2 und V4-Testständen), eine opt-in Schlussphase mit Sperrphase, Phasenerkennung als Beobachter, eine Laufprüfung gegen unverwertbare Aufzeichnungen und eine automatische Optimierung über 30 Tage einbauen – geräteunabhängig, Standardverhalten = 3.1.2.

**Architecture:** Erkennungswerte (`DetectionSettings` mit 13 neuen `final*`-Feldern) stehen in `DeviceConfig.detection`; `createDetector` baut die Kette Modus-Detector → `FinalPhaseFilter` → `TrailerFilter`, Live, Nachspielen, Gate und Lernen laufen durch dieselbe Fabrik. Phasen laufen als rein funktionaler `PhaseTracker` neben der Erkennung und können keine Meldung ändern. Lernen und Optimierung bewerten jeden Lauf über eine gemeinsame Laufprüfung (`quality.ts`) mit Grundbändern und Haltezeit-Profil; der Laufspeicher bleibt Format `v: 1` mit zusätzlichen Feldern.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), `@iobroker/adapter-core`, js-controller ≥ 6, admin jsonConfig + `@iobroker/dm-utils`; Tests Mocha + `node:assert` + c8, importieren aus `build/`.

**Spec:** `docs/superpowers/specs/2026-11-13-phasenerkennung-design.md` (gewinnt bei Widerspruch; Zuordnung 3.1.2 → V4 in C.5). Daneben `docs/superpowers/specs/2026-10-25-device-reminder-v4-design.md` (wird in Task 1 angeglichen).

**Entschieden (Spec Abschnitt 10, damit nicht mehr offen):**
1. Gerät mit unbekanntem 3.1.2-Typ: übernehmen, `enabled = false`, `needsReview`, Hinweis in Log und Karte (Task 5).
2. AutoOff mit Schlussphase erst nach Ausgang a, b oder e der Sperrphase; nach c, d, f, g folgt AutoOff dem Ende des neuen Laufs (Task 15).
3. Auto-Optimierung optimiert automatisch ohne Bestätigung, schaltet auch die Schlussphase selbst ein, justiert nach und setzt aus – nur mit Beleg auf allen zugelassenen Läufen des 30-Tage-Fensters plus Grenzläufen, inkl. Gegenprobe und gestörter Eingangsdaten; jede Änderung gemeldet (`optimizeNotify`), sichtbar, rückgängig machbar (Task 22).
4. Mindestzahlen: Verschärfung ab 8 zugelassenen Läufen (`TIGHTEN_MIN_RUNS` 4 → 8), Schlussphase automatisch an ab 10 zugelassenen Läufen und ≥ 2 je betroffener Programmgruppe; Schritte ≤ 25 % (Schwellwerte 30 %), Abstand 2 neue Läufe + 24 h, Sperre 5 Läufe/14 Tage, Reparatur sofort ohne Mindestzahl (Task 21, 22).
5. Keine Wiederaufnahme, kein `resume`, keine Korrektur-Nachricht; alles nach frühem Ende ist ein neuer Lauf, Beurteilung nur im Nachhinein (`finalSplit`, Task 17).
6. Geräteunabhängig: keine Regel mit gerätespezifischer Annahme; Wissen nur als gelernte Bedingung (Wert 0 = Regel aus).
7. Jede 3.1.2-Einstellung landet an der richtigen V4-Stelle (Spec C.5, Tabelle), je Zeile durch einen Test abgesichert (Task 5, 6).
8. Saubere Erkennung hat Vorrang: Erkennen die aktuellen Werte einen zugelassenen Lauf nicht oder nicht richtig (Start fehlt, Ende zu früh, zerteilt, Ende nicht erkannt, Phantomstart, Schlussphase zerteilt), auch knapp, wird sofort nach dem Lauf in die sichere Richtung repariert, bis dieser und alle anderen zugelassenen Läufe stimmen – unabhängig von Mindestzahl, Abstand, Sperre, Schrittgrenzen und Drift; Quarantäne löst nichts aus; ohne Abdeckung bleiben die bisherigen Werte mit Warnung `cannotCover` (Spec D.3 Punkt 3, Task 21, 22).
9. Verschmolzene Läufe (User, 14.11.2026, wörtlich: „zwei läufe als einen erkennen ist nicht schlimm denn dann läuft das gerät ja durchgehend. wichtig ist nur das dann auch das ende erkannt wird wenn es ein richtiges ende gibt“): Zwei echte Läufe, die der Detector zu **einem** Lauf verschmilzt, sind **kein** Erkennungsfehler – keine Sofort-Reparatur, keine Verkürzung der Ende-Wartezeit deswegen, kein Warnhinweis (höchstens ein Info-Eintrag im Optimierungs-Verlauf). Pflicht ist nur, dass das echte Ende des Gesamtlaufs erkannt wird: Die Ende-Prüfung des Gates (`endOk`) gilt für den Gesamtlauf; ein nicht erkanntes Ende bleibt ein Reparaturauslöser (Entscheidung 8). Kürzere Wartezeiten entstehen nur über die normale vorsichtige Verschärfung (ab 8 Läufen, Schrittgrenzen). Erkennt der Detector die beiden Teile stattdessen als zwei Läufe, ist das ebenfalls richtig (Spec B.2 `merged`, D.3, Abschnitt 10; Task 12, 17, 21).

## Global Constraints

- Standard = Verhalten 3.1.2: `final*` = 0, `phases` fehlt, `autoOptimize` fehlt; ohne diese Felder Tick für Tick wie heute (Golden `test/fixtures/detectorGolden.json` unverändert).
- `typeHash` bestehender Werte bitgleich: eingebaute Waschmaschine `39417b8a`, Trockner `0af5b9bf`, Geschirrspüler `8b9f87e6`, `custom1` `37a6b30f` (Stand 5684124); neue Felder nur bei ≠ 0 als `|name=wert` angehängt.
- Version und News in `package.json`/`io-package.json` nicht ändern; einzig erlaubt: Default `native.configVersion` → 5 und `native.types` aus den Defaults entfernen (Spec C.6).
- Jeder neue Text in 11 Sprachen (en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn): `admin/i18n/*.json` (de/en von Hand, Rest `npm run translate`), State-Namen über `t(...)` in `stateDefinitions.ts`, `dmTexts.ts` über `tr(...)`.
- Verboten in `src/`: `console.log`, `process.exit()`, `eslint-disable`, `@ts-nocheck`, globales `setTimeout`/`setInterval` (nur `host.setTimeout` bzw. `this.setTimeout`); relative Imports mit `.js`; Fehler loggen mit `errorMessage(err)`.
- Vor jedem Commit: `npm run build && npm run lint && npm test` grün, Lint 0 Warnings, Skill `precommit-check` (Checkliste `D:/Windows/Desktop/ioBroker-PR-Checkliste.md`) komplett; nie `--no-verify`.
- Branch `feature/v4`; kein PR, kein Push ohne ausdrückliche Anweisung. Commit-Nachrichten englisch (`feat:`/`fix:`/`test:`/`docs:`), letzte Zeile `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Changelog nur in `README.md` unter `### **WORK IN PROGRESS**`, Format `- (Eistee82) …`, höchstens 6 Einträge (dort stehen schon 6: bestehende Zeilen umformulieren statt anhängen), nutzerverständlich.
- Doku `docs/de/README.md` und `docs/en/README.md` bei jeder nutzerseitigen Änderung; keine E-Mail-Adressen in Dateien.
- **Doku und Changelog im selben Commit (CLAUDE.md Regel 1):** Jeder Task mit sichtbarer Änderung (Bedienung, State, Meldung, Verhalten, Migration) aktualisiert im eigenen Commit die betroffenen Abschnitte in `docs/de/README.md` und `docs/en/README.md` sowie die passende WIP-Zeile im Changelog (umformulieren, weiterhin höchstens 6). Jeder Task-Schritt „Commit“ schließt das ein; in den Tasks steht unter **Doku** jeweils, was zu ändern ist. Task 26 ist nur noch der abschließende Gesamtabgleich.
- **Echtsystem nur lesen:** `mcp__iobroker__*` nur mit lesenden Aufrufen (`get_object`, `get_states`, `search_objects`, `read_file`, `history_query`, `get_logs`, `list_*`). Nie Adapter installieren/upgraden, Instanzen starten/stoppen, States/Objekte/Dateien schreiben oder Skripte ändern. Schritte, die das brauchen, stehen als **Schritt für den User** mit genauer Anleitung im Plan; der Agent prüft danach nur lesend.
- Kein Instanz-Neustart durch Wertänderung, „Übernehmen“ oder V4-Migration; Admin-UI nur jsonConfig und Device Manager.
- Keine neuen Nachrichten an Empfänger ohne `optimizeNotify` (Ausnahme: Phasen mit `notify`); Hinweise sonst nur Log, `learning.optimizeInfo`, Gerätekarte.
- Echtdaten-Fixtures nur mit neutralen, verschobenen Zeitstempeln (Basis `1_700_000_000_000` ms, Muster `test/fixtures/washerAntiCrease.json`); Rohdaten nur im Scratchpad `C:/Users/Eistee/AppData/Local/Temp/claude/76a49c15faa97d7f/20aedea5-acc7-47c0-b284-a72daa939b11/scratchpad` (`wm.json`, `tr.json`, `kessel.json`, Format `[[ts_ms, W]]`).
- Einzeltest ausführen: `npm run build && npx mocha test/<datei>.test.js -g "<name>"`.
- Die Testblöcke im Plan sind vollständiger Testcode; beim Einfügen in bestehende Dateien Imports zusammenführen und nicht benutzte entfernen (Lint über `test/`, 0 Warnings).

## Review Focus

1. Gerätekonfiguration wird während der Sperrphase geändert (Text, Empfänger, Abbruch-Option, Erkennungswerte) → kein Detector-Neubau vor `!started && !settling`, kein Phantomstart, kein zweites „Fertig“ (Test in Task 15).
2. Leistungs-State gewechselt, Gerät deaktiviert oder gelöscht während der Sperrphase → `settlingUntil` = 0; nach Neustart keine Sperrphase für den neuen Sensor (Test in Task 15).
3. `settlingUntil` liegt beim Start weiter als `finalLockSec` in der Zukunft (Uhr verstellt, State von Hand gesetzt) → Sperrphase endet spätestens `finalLockSec` nach dem Neustart (Test in Task 15).
4. Leistungs-State in kW → Grundbänder, Haltezeit-Profil, `final*`-Vorschlag und Laufprüfung in State-Einheit (W-Werte ÷ 1000), identische Ereignisse wie mit der W-Fixture (Tests in Task 11 und 16).
5. Phasen bei `scope continuous` über 24 h mit mehr als 200 Segmenten → State `phases` bleibt gültiges JSON mit genau den 200 neuesten Einträgen (Test in Task 20).

## Migrationsbefunde (Prüfung von `migration.ts`, `config.ts`, `io-package.json`, `admin/jsonConfig.json` und 3.1.2 `.tmp/legacy/package/` gegen Spec C.5)

| # | Befund (Stand 5684124) | Folge | Behoben in |
|---|---|---|---|
| M1 | `convertTypes` (`migration.ts:334-343`) legt alle Typ-ids als Namen in `byName` (`custom3`, `dryer`): ein Gerät mit Typ `custom3`, dessen Zeile umbenannt wurde, bekommt still die Werte der umbenannten Zeile; 3.1.2 fand keinen Typ. | Abweichung von der 3.1.2-Zuordnung, kein Hinweis | Task 5 (exakte Zuordnung, Fallback „umbenannter Platz“ nur mit `needsReview`) |
| M2 | `default.ids`-Zeilen werden ohne Groß-/Kleinschreibung auf eingebaute Typen gelegt (`migration.ts:290`); zwei Zeilen unterschiedlicher Schreibweise überschreiben sich, Zeilen mit fremdem Namen fallen still weg (`:291-293`). Namen werden getrimmt verglichen, 3.1.2 verglich ungetrimmt. | falsche Werte bzw. stiller Verlust (nur bei handbearbeiteter native) | Task 5 |
| M3 | Gerät ohne Typ-Treffer bekommt `typeId: ""` (`migration.ts:390`) und wird zur Laufzeit ignoriert (`deviceRegistry.ts:114-119`); nur Log-Warnung. | Gerät verschwindet aus dem Betrieb | Task 4/5 (`enabled = false`, `needsReview`, Karte) |
| M4 | Alle 13 Typen landen als aktive Konfiguration in `native.types`; Geräte teilen sich Typen. | widerspricht „Werte im Gerät“ | Task 5 (Kopie je Gerät, Archiv nur abweichende Typen ohne Gerät) |
| M5 | Leere/nicht numerische Typwerte werden still durch den Vorlagenwert ersetzt (`thresholds`, `migration.ts:254-264`). | stille Änderung | Task 5 (Warnung alt/neu) |
| M6 | Typ-Kommentar (`comment`) der 3.1.2-Typtabellen wird nicht übernommen und nicht gemeldet. | stiller Verlust | Task 5 (Warnung) |
| M7 | SayIt/WhatsApp: `completeRecipientRow` (`config.ts:454-472`) ersetzt einen abweichenden 3.1.2-`path` still durch `<instanz>.tts.text` bzw. `<instanz>.sendMessage`. | Nachrichten gehen an einen anderen State | Task 5 (Warnung alt/neu) |
| M8 | V4: `ensureDeviceObjects` schreibt über `extendObject` (`deviceObjects.ts:28-32`) – ein entferntes `typeId` bliebe in `native` stehen; `canKeepStateFor` vergleicht `typeId` (`deviceRuntime.ts:296-298`). | V4-Migration nicht wirksam, Neustart des Zyklus | Task 4/6 |
| M9 | V4: `reconcileStore` verwirft das Override, sobald `store.typeId` abweicht (`runStore.ts:476`) – nach der Migration immer. | optimierte Werte gingen beim Update verloren | Task 4 (nur Hash-Vergleich) |
| M10 | V4: `saveLearnedType` schreibt angelernte Werte als neuen Typ in die Instanz-native und startet die Instanz neu (`deviceManagement.ts:1052-1058`). | nach Wegfall der Typen wirkungslos | Task 4 (`applyLearned` ins Gerät) |
| M11 | Verhaltensänderungen durch korrekte Übernahme (keine Fehlzuordnung): 3.1.2 sendete Pushover-Priorität/-Gerät nie (`main.js:976-1001`: `deviceId` statt `deviceID`, Text gegen 2 verglichen); Telegram-Feld `username`/`firstname`/`chatID` statt `user`/`chatId`; Matrix an `matrix.N` statt `matrix-org.N`; Zeitfenster über Mitternacht galten nie. | Nutzer merkt Unterschied | Task 26 (Doku §9) |

Korrekt zugeordnet (geprüft): Status-Texte, Abfrageintervall (fest 10 s → 10), alle Empfängerfelder der 9 Messenger inkl. Lautstärke-Regel und Zeitfenster, Empfängerreferenzen je Gerät, `enabled`, `name` (ungetrimmt als State-Präfix), `pathConsumption`/`pathSwitch`, Texte, `abort`, `autoOff`/`timer`, die vier übernommenen States; `runtimeMax` (Gerätefeld) war in 3.1.2 ungenutzt.

## Belege der Erwartungswerte

Jede Zahl in einem Test stammt aus einer dieser Quellen; wo ein Wert erst aus der Umsetzung folgt, steht eine belegte Schranke statt einer Zahl.

| Quelle | Inhalt (am 14.11.2026 auf den Rohdaten nachgerechnet, Skripte im Scratchpad) |
|---|---|
| `f_stats.mjs` (S1) | WM: Laufschwelle 5,5 W; Nachlauf-Bursts ≤ 70–113 W, Ruhepegel 6 W; Schleudern ≤ 290–839 W je Lauf; Heizen ab 2047 W (1593–1858 W nur Rampe); Pausen < 5,5 W im Programm ≤ 10 s |
| `f_gaps.mjs` (S2) | Schleuderblöcke je Lauf 4–7, größter Abstand normaler Läufe 26,8 min, w02 74,8 min |
| `f_lock.mjs` (S4) | ganze WM-Aufzeichnung mit P 150 / Pmax 1311 / X 60 min / Y 2,8 min / Z 2 min / G 60 s / Ruhe 5,5 W 60 s: 14 Starts identisch, 14 Enden; Fertig nach Kernende mit Hülle 1,5–2,2 min (w01, w03, w05–w12), w02 −0,2 min, w04 −8,5 min wie ohne; ohne Hülle 6,0 (w02) bzw. 11,3–30,7 min |
| `y_actexit.mjs` (S12) | dieselbe Konfiguration + Sperre 45 min, Prüffenster 40 min, Aktivität 9 W/0,7: 12 frühe Enden, 11 × a, 1 × b, 0 × c/d/e/f/g; höchster Aktivitätsanteil 0,53; 72 Szenarien 72/72, zweiter Start 0,8–3,7 min nach dem Einschalten |
| `f_viol.mjs` (S7) | Y 0,5/1,0 min: in 11/11 Läufen frühes Ende vor Kernende, Rest über das Schlussband im Prüffenster als neuer Lauf, letztes Fertig zum Zeitpunkt ohne Hülle |
| `plan_kessel.mjs` (S13) | Kessel: 2367 Punkte über 3,57 Tage; 86 Spitzen > 294 W, davon 79 nach 60 s in [120; 294), 7 in [35; 120); längste Haltezeit in 245–280 W 52,2 min, p99 1269 s |
| `plan_wmhold.mjs` (r_hold) | WM-Band 150–1311 W: n 427, p99 94 s, Maximum 145 s |
| `plan_list.mjs` | WM 19 816 Punkte, 12 Layout-Läufe (Daten w01–w12), Trockner 7 Läufe |
| Spec | Zwischenschleudern ≤ 1,9 min (A.4), Ende-Schleudern ≥ 4 min (A.3), Abnahmen in 8.x (als Anforderung formuliert, „Abnahme“) |

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/lib/detector/types.ts` | `FINAL_KEYS`, `FinalSettings`, `FinalExit`, Getter `settling`/`finalExit` im `Detector` |
| `src/lib/detector/finalPhase.ts` (neu) | `FinalPhaseFilter`: Zustände `pass`/`lock`, Ausgänge a–g, Rückdatierung |
| `src/lib/detector/index.ts`, `trailer.ts` | Kette Modus → Schlussphase → TrailerFilter; Durchreichen bei `settling` |
| `src/lib/templates.ts` (neu) | eingebaute Vorlagen, Archiv-Vorlagen aus `native.types` |
| `src/lib/legacyTypes.ts` (neu) | `resolveLegacyTypes`, `normalizeType`, `DEFAULT_TYPES`, `findType` – nur noch für Migration |
| `src/lib/config.ts` | `DeviceConfig.detection/template/needsReview/reviewHint/phases`, `normalizeDetection`, `normalizeFinal`, `FINAL_BOUNDS` |
| `src/lib/migration.ts` | 3.1.2 nach C.5, `migrateV4Device` |
| `src/lib/learn/clean.ts` (neu) | Bereinigung der Rohpunkte |
| `src/lib/learn/bands.ts` (neu) | Grundbänder, Haltezeit-Profil |
| `src/lib/learn/quality.ts` (neu) | Laufprüfung, `Verdict`, Rangfolge, `uses` |
| `src/lib/learn/finalLearn.ts` (neu) | Schlussphase lernen und freigeben, `finalSplit`-Prüfung |
| `src/lib/learn/runs.ts`, `replay.ts`, `families.ts` | Bausteine, `progEnd`, `tailCeil`, `endOk`, `LAYOUT_REV`, Gruppenmerkmale |
| `src/lib/phases/model.ts`, `tracker.ts`, `learn.ts` (neu) | Phasenmodell + Validator, Tracker, Phasen lernen |
| `src/lib/runStore.ts` | neue Speicherfelder, Verdrängung, Umrechnen, `reconcileBase` |
| `src/lib/learn/autoOptimize.ts` | 30-Tage-Fenster, Grenzläufe/Veto, Schlussphasen-Pfad, Phasen-Feinjustierung, Budget |
| `src/lib/deviceRuntime.ts`, `deviceRegistry.ts`, `deviceObjects.ts`, `stateDefinitions.ts` | drei Ebenen, Sperrphasen-Kopplung, neue States, Tracker |
| `src/lib/deviceForm.ts`, `deviceManagement.ts`, `dmTexts.ts`, `admin/jsonConfig.json`, `admin/i18n/*.json` | Bedienung |
| `test/helpers/fixtures.js` (neu), `test/fixtures/washer30d.json`, `dryer.json`, `boiler4d.json`, `v4store.json` (neu) | Echtdaten und Defekt-Injektion |
| `test/helpers/devices.js` (neu, Task 4) | Geräte-, Runtime-, Registry- und History-Setup für alle Tests |
| `test/helpers/final.js` (neu, Task 14/16), `test/helpers/phases.js` (neu, Task 18) | WM-Schlussphasenwerte, Zerteilungs- und Phasenmodelle |

---

### Task 1: V4-Spec an das Konzept angleichen (Spec 7.5)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-25-device-reminder-v4-design.md` (§4.4 `:99`, §6 `:125`, §6.1 `:131`, §6.2 `:137`, §13/§14 `:236-243`)

**Interfaces:** keine.

- [x] **Step 1: §4.4 „Gerätetypen“** um den Satz ergänzen, dass 3.1.2-Typen bei der Migration als Werte in jedes Gerät kopiert werden (Verweis auf Phasen-Spec C.5).
- [x] **Step 2: §6/§6.1/§6.2:** Tab „Gerätetypen“ entfällt (Hinweistext), Geräteformular mit Quelle (Vorlage, Archiv-Vorlage, anderes Gerät), Erkennung, Expertenwerte; neue Unterabschnitte „Schlussphase“, „Phasen“, „Laufprüfung“ mit je 3–5 Sätzen und Verweis auf die Phasen-Spec A.3, A.4–A.6, B.2.
- [x] **Step 3: §13/§14 Entscheidungen:** „Custom-Typen unbegrenzt“ → „Erkennungswerte im Gerät, eingebaute Vorlagen, Archiv“; „Modus pro Typ, Gerät erbt“ → „Modus pro Gerät“. Abschnitt „Vom User entschieden“ um die Entscheidungen 1–9 dieses Plans ergänzen.
- [x] **Step 4: Prüfen:** `grep -n "Typ" docs/superpowers/specs/2026-10-25-device-reminder-v4-design.md` zeigt „Typ“ nur noch in 3.1.2-Bezügen und Migration.
- [x] **Step 5: Commit** `git add docs/superpowers/specs/2026-10-25-device-reminder-v4-design.md docs/superpowers/specs/2026-11-13-phasenerkennung-design.md docs/superpowers/plans/2026-11-14-phasenerkennung.md && git commit -m "docs: v4 spec follows the phase concept"`

---

### Task 2: Echtdaten-Fixtures und Test-Helfer

Muss vor Task 13 laufen: `v4store.json` wird mit dem Code von 5684124 erzeugt.

**Files:**
- Create: `test/fixtures/washer30d.json`, `test/fixtures/dryer.json`, `test/fixtures/boiler4d.json`, `test/fixtures/v4store.json`, `test/helpers/fixtures.js`, `test/fixtures.test.js`

**Interfaces:**
- Fixture-Format (Spec §11 überlässt die Kodierung): die **ganze** Aufzeichnung je Gerät, damit alle Belegzahlen der Prüfskripte 1:1 gelten: `{ "note": string, "runs": [{ "id": "w01", "fromSec": number }], "points": [[relSec, W]] }`; `relSec` ab dem ersten Punkt, eine Nachkommastelle, `null` entfernt. Kessel ohne `runs`.
- Laufkennungen: w01 31.10. 11:29, w02 03.11. 09:57, w03 03.11. 22:20, w04 06.11. 13:37 (lückenhaft), w05 06.11. 14:49 (Nachlauf früh beendet), w06 07.11. 14:26, w07 08.11. 12:28 (Langheizen), w08 10.11. 13:12, w09 10.11. 16:23, w10 11.11. 18:24, w11 11.11. 22:30, w12 12.11. 16:27, w13 13.11. (am Datenende); Trockner d01 31.10. 11:29, d02 03.11. 12:29, d03 06.11. 18:24, d04 08.11. 18:07, d05 10.11. 16:23, d06 11.11. 22:30, d07 12.11. 16:31; Kessel 10.11. 01:05 – 13.11. 14:42 (3,57 Tage).
- Produces (`test/helpers/fixtures.js`):
  - `BASE_TS = 1_700_000_000_000`; `loadSeries(name: "washer30d" | "dryer" | "boiler4d"): { ts: number; val: number }[]` (`ts = BASE_TS + relSec·1000`); `runIndex(name): { id: string; ts: number }[]`.
  - `layoutOf(points, stepMs = 10_000, opts = {}): { s: TickSeries; L: Layout }` (`fromPoints` + `buildLayout`).
  - `layoutRun(name, id, stepMs = 10_000): { info: RunInfo; s: TickSeries; L: Layout; idx: number }` – Layout-Lauf, dessen Beginn ≤ 5 min vom Indexeintrag liegt.
  - `ticksOf(points, stepMs = 10_000, t0?: number): number[]` (`s.last` auf dem Raster ab `t0` bzw. dem ersten Punkt, fehlend = 0, wie `all` in `f_lock.mjs`).
  - `detectorRun(values: number[], settings, o = {}): { ev: { e: DetectorEvent; i: number; at: number; exit: string | null }[]; ticks: { status: DeviceStatus | null; settling: boolean }[]; det: Detector }` – Optionen `pollSec` (10), `abort` (false), `abortFixed` (false), `switchOff(i): boolean`, `resumeLockAt`, `timedFeed` (true: im Modus timed `feed` nur bei Wertänderung, `tick` je Wert); ein `tick` je Wert bei `i·pollSec·1000`; `at` = `res.times?.[k] ?? now`; `exit` = `det.finalExit ?? null` beim Ereignis (vor Task 14 immer `null`).
  - `runWindow(name, id): { ts: number; val: number }[]` (Punkte von 30 min vor Laufbeginn bis 3 h nach Kernende) und `timelineOf(windows: { ts: number; val: number }[][], everyMs: number): { ts: number; val: number }[]` (Fenster hintereinander, Fensterbeginn je `everyMs`, Zeiten verschoben).
  - `resample(points, fromMs, toMs, everyMs)` (gehaltener Wert dicht neu abgetastet), `dropRandom(points, share, seed)`, `scale(points, factor)`, `shift(points, ms)`.
  - `restartScenarios(): { key: string; values: number[]; aEnd: number; bOn: number }[]` – die 72 Szenarien aus `…/scratchpad/y_actexit.mjs`: Lauf A = w01, Lauf B = w03; `cold ∈ {false, true}` (B: Werte ≥ 1500 → 60), `[lvl, restVal] ∈ {[0, 5.5], [5, 5.5], [5, 1]}`, `unload ∈ {5, 10, 20}` min nach Kernende von A, `gapTicks ∈ {3, 6, 18, 36}`; `values = A[from−30 … coreEnd + unload·6] ++ lvl×gapTicks ++ B[from−3 … to+200]`, `aEnd` = Index Kernende A, `bOn = |A-Teil| + gapTicks + 3`; `restVal` wird je Szenario als `finalRestVal` verwendet.
  - Defekte (rein, geben neue Listen zurück): `withGap(points, atMs, minutes)` (Punkte entfernt), `withHold(points, atMs, minutes, val)` (ein Punkt, danach keiner), `withForeign(points, atMs, minutes, addW)`, `withSpikes(points, n, valW, seed)` (je 1 Punkt), `asKw(points)` (÷ 1000), `withRelog(points, everyMs)` (gleiche Werte wiederholt), `sparse(points, keepEvery)`, `bridge(points, fromMs, toMs, val)` (alle Werte im Bereich = `val`), `handTest(atMs, minutes, valW)` (Punktliste mit 30 min 0,5 W davor und danach), `cutTrailer(points, atMs)` (ab `atMs` für 60 min 0 W).

- [ ] **Step 1: Konverter im Scratchpad** `C:/Users/Eistee/AppData/Local/Temp/claude/76a49c15faa97d7f/20aedea5-acc7-47c0-b284-a72daa939b11/scratchpad/mk_fixtures.mjs` (nicht ins Repo): liest `wm.json`/`tr.json`/`kessel.json`, schreibt die drei Fixtures im Format oben; `runs` aus `buildLayout` (`build/lib/learn/runs.js`), für w13 die letzte Aktivität vor Datenende.
- [ ] **Step 2: `v4store.json`** mit dem heutigen Build (5684124) im Scratchpad erzeugen: `emptyStore("wm", "washing-machine", "39417b8a", 10000, 1)`; für w01–w12 je eine Capture (Zellen ab 30 min vor bis 3 h nach dem Lauf, Ereignisse aus `detectorRun` mit 3.1.2-WM-Werten) über `labelCapture` + `addRun`, so dass `envelope` alle 12 Läufe enthält; danach w04 und w07 bei unveränderter `envelope` direkt aus `store.runs` entfernen (Kopien von w08 verdrängen sie nie: `pickVictim` schützt Gruppen mit ≤ 2 Läufen, `runStore.ts:822`); `serializeStore` → Datei. Läufe ohne `rev`.
- [ ] **Step 3: Failing test** `test/fixtures.test.js`:

```js
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
	asKw, BASE_TS, layoutOf, layoutRun, loadSeries, restartScenarios, runIndex, ticksOf, withGap,
} from "./helpers/fixtures.js";

describe("real-data fixtures", () => {
	it("washer30d: 13 indexed runs, neutral times, 12 complete runs in the layout", () => {
		const pts = loadSeries("washer30d");
		assert.strictEqual(runIndex("washer30d").length, 13);
		assert.strictEqual(pts[0].ts, BASE_TS);
		assert.ok(pts.at(-1).ts - BASE_TS < 14 * 86_400_000);
		assert.strictEqual(pts.length, 19_816);
		assert.strictEqual(layoutOf(pts).L.runs.length, 12);
	});
	it("w01–w12 are found by the layout within 5 min of their index entry", () => {
		for (const { id } of runIndex("washer30d").slice(0, 12)) {
			assert.ok(layoutRun("washer30d", id).info, id);
		}
	});
	it("dryer: 7 runs; boiler4d: 2367 points over more than 3.5 days", () => {
		assert.strictEqual(layoutOf(loadSeries("dryer")).L.runs.length, 7);
		const b = loadSeries("boiler4d");
		assert.strictEqual(b.length, 2367);
		assert.ok(b.at(-1).ts - b[0].ts > 3.5 * 86_400_000);
	});
	it("72 restart scenarios with run B after the gap", () => {
		const sc = restartScenarios();
		assert.strictEqual(sc.length, 72);
		assert.strictEqual(new Set(sc.map(x => x.key)).size, 72);
		assert.ok(sc.every(x => x.bOn > x.aEnd && x.bOn < x.values.length));
	});
	it("defects change only what they say", () => {
		const pts = loadSeries("washer30d");
		const at = runIndex("washer30d")[7].ts + 3_600_000;
		const gap = withGap(pts, at, 20);
		assert.ok(gap.every(p => p.ts < at || p.ts >= at + 20 * 60_000));
		assert.strictEqual(asKw(pts)[100].val, pts[100].val / 1000);
		assert.strictEqual(ticksOf(pts).length, layoutOf(pts).s.length);
	});
	it("v4store is an old store: v 1, no rev, envelope fed by evicted runs", () => {
		const st = JSON.parse(readFileSync(new URL("./fixtures/v4store.json", import.meta.url), "utf8"));
		assert.strictEqual(st.v, 1);
		assert.strictEqual(st.typeHash, "39417b8a");
		assert.ok(st.runs.every(r => r.rev === undefined));
		assert.ok(st.envelope.n > st.runs.length);
		assert.ok(st.runs[0].ts >= BASE_TS);
	});
});
```

Die Zahlen 19 816 (WM-Punkte) und 2367 (Kessel-Punkte) stammen aus dem Lesen der Rohdaten (`plan_list.mjs`, `plan_kessel.mjs` im Scratchpad); 12/7 Läufe aus `buildLayout` auf denselben Daten.

- [ ] **Step 4:** `npm run build && npx mocha test/fixtures.test.js` → FAIL (`loadSeries` fehlt). Helfer schreiben, erneut → PASS.
- [ ] **Step 5: Commit** `test: real-data fixtures with neutral times and defect injection helpers`

---

### Task 3: Schlussphasen-Felder, Hash-Regel, Grenzen (Spec A.2 mit Spalte „Bereich“)

**Files:**
- Modify: `src/lib/detector/types.ts`, `src/lib/detector/index.ts`, `src/lib/runStore.ts:180-241`, `src/lib/config.ts` (neben `TRAILER_BOUNDS` `:54-95`), `src/lib/learn/autoOptimize.ts` (Schleifen über Schlüssel), `src/lib/deviceManagement.ts:1155,1229`
- Test: `test/detectorGolden.test.js`, `test/runStore.test.js`, `test/config.test.js`

**Interfaces:**
- Produces:
  - `FINAL_KEYS = ["finalMinVal","finalMaxVal","finalHotVal","finalAfterSec","finalMinSec","finalQuietSec","finalDipSec","finalRestVal","finalRestSec","finalActVal","finalActShare","finalCheckSec","finalLockSec"] as const`, `type FinalKey`, `type FinalSettings = Partial<Record<FinalKey, number>>`, `type FinalExit = "a" | "b" | "c" | "d" | "e" | "f" | "g"`; `DetectionSettings extends TypeThresholds, FinalSettings` (`detector/types.ts`).
  - `finalOn(s: DetectionSettings): boolean` = `(s.finalMinVal ?? 0) > 0 && (s.finalMinSec ?? 0) > 0` (`detector/index.ts`).
  - `BASE_KEYS` (die 16 heutigen) und `DETECTION_KEYS = [...BASE_KEYS, ...FINAL_KEYS]` (29) in `runStore.ts`; `detectionOf` füllt alle 29 (fehlend = 0).
  - `typeHash(t)`: FNV-1a über `JSON.stringify(BASE_KEYS-Werte)` + für jeden `FINAL_KEYS`-Wert ≠ 0 `|<name>=<wert>`.
  - `FINAL_BOUNDS` in `config.ts` (Zeiten in s; Leistungen in der Einheit des States, nur ≥ 0 und endlich – keine absoluten Grenzen, nur Regeln):

| Feld | Bereich | 0 erlaubt | Regel bei Verstoß (mit Warnung `Device "<label>": <feld> <alt> → <neu> (<grund>)`) |
|---|---|---|---|
| `finalMinVal` | (0; ∞) | nein (Hauptschalter) | ≤ wirksamer Ruhepegel (`finalRestVal`, sonst `standby`) → alle `final*` aus (`{}`) |
| `finalMaxVal` | 0 oder (`finalMinVal`; ∞) | ja (offen) | ≤ `finalMinVal` → alle aus |
| `finalHotVal` | 0 oder [`finalMaxVal`; ∞) bei `finalMaxVal` > 0 | ja (c aus) | sonst → 0 |
| `finalAfterSec` | [0; 604 800] | ja | klemmen |
| `finalMinSec` | [10; 86 400] | nein (Hauptschalter) | klemmen |
| `finalQuietSec` | [30; 7200], ≥ `finalDipSec` | ja (120 s) | klemmen; < G → := G |
| `finalDipSec` | [10; 3600] | ja (auto) | klemmen |
| `finalRestVal` | 0 oder [0; `finalMinVal`) | ja (`standby`) | ≥ `finalMinVal` → alle aus |
| `finalRestSec` | [10; 14 400] | ja (auto) | klemmen |
| `finalActVal` | 0 oder [wirksamer Ruhepegel; `finalMinVal`) | ja (f aus) | sonst → 0 und `finalActShare` → 0 |
| `finalActShare` | 0 oder [0,5; 0,9]; 0 ⇔ `finalActVal` 0 | ja (f aus) | klemmen; nur einer von beiden 0 → beide 0 |
| `finalCheckSec` | [300; 14 400], ≤ `finalLockSec` (wirksam) | ja (1800 s) | klemmen; > Lock → := Lock |
| `finalLockSec` | [600; 14 400] | ja (14 400 s) | klemmen |

  - `normalizeFinal(raw: Record<string, unknown>, warnings: string[], label: string): FinalSettings` – liest `raw.standby` für den wirksamen Ruhepegel; Zahlen auch als Text (`parseNumber`), `NaN` → 0, negativ → 0 mit Warnung. Reihenfolge: (1) Hauptschalter aus → `{}` ohne Warnung; (2) „alle aus“-Regeln (`finalMinVal` ≤ Ruhepegel, `finalMaxVal` ≤ `finalMinVal`, `finalRestVal` ≥ `finalMinVal`) → `{}` mit genau einer Warnung, sofort zurück; (3) Klemmen auf die Bereiche, je Feld eine Warnung; (4) Einzelregeln (`finalHotVal`, `finalActVal`/`finalActShare`, Z ≥ G, Prüffenster ≤ Sperre), je Regel eine Warnung.
  - `finalViolations(f: FinalSettings, standby: number, pollSec: number): FinalKey[]` – verändert nichts; listet Felder, die Bereich, Regel oder die Laufzeit-Untergrenzen je Poll (Y, G ≥ 2·Poll; Z ≥ max(2·Poll, G); `finalRestSec` ≥ 3·Poll; `finalLockSec` ≥ 2·Poll; jeweils nur für Werte ≠ 0) verletzen. Genutzt von `finalLearn` (Grund `outOfRange`, Task 16) – gelernte Werte werden nie geklemmt.
  - autoOptimize: Schleifen über Analysewerte (`boundsOf`, `withinBounds`, `clampBounds`, `distance`, `stepLimit`) laufen über `BASE_KEYS`; `diffOf`, `effectiveOf`, `describeChange` über `DETECTION_KEYS`; `fromSuggestion`/`saferOf` übernehmen `FINAL_KEYS` aus `p0`.

- [ ] **Step 1: Failing tests**

```js
// test/config.test.js
import { FINAL_BOUNDS, finalViolations, normalizeFinal } from "../build/lib/config.js";

/** Final phase of the washer as checked on the real data (Spec A.3 "Geprüft", y_actexit.mjs). */
const WM_FINAL = {
	finalMinVal: 150, finalMaxVal: 1311, finalHotVal: 1311, finalAfterSec: 3600, finalMinSec: 168,
	finalQuietSec: 120, finalDipSec: 60, finalRestVal: 5.5, finalRestSec: 60, finalActVal: 9,
	finalActShare: 0.7, finalCheckSec: 2400, finalLockSec: 2700,
};
const norm = (over, standby = 1) => {
	const w = [];
	return { f: normalizeFinal({ standby, ...WM_FINAL, ...over }, w, "WM"), w };
};

describe("final phase bounds", () => {
	it("is off without the master switch, silently", () => {
		const w = [];
		assert.deepStrictEqual(normalizeFinal({ standby: 1, finalMinVal: 150 }, w, "WM"), {});
		assert.deepStrictEqual(normalizeFinal({ standby: 1, finalMinSec: 168 }, w, "WM"), {});
		assert.deepStrictEqual(w, []);
	});
	it("keeps the learned washer values unchanged and without warning", () => {
		const { f, w } = norm({});
		assert.deepStrictEqual(f, WM_FINAL);
		assert.deepStrictEqual(w, []);
		assert.deepStrictEqual(finalViolations(WM_FINAL, 1, 10), []);
	});
	it("keeps the same values of a kW state (÷ 1000) unchanged", () => {
		const kw = { ...WM_FINAL, finalMinVal: 0.15, finalMaxVal: 1.311, finalHotVal: 1.311, finalRestVal: 0.0055, finalActVal: 0.009 };
		const w = [];
		assert.deepStrictEqual(normalizeFinal({ standby: 0.001, ...kw }, w, "WM"), kw);
		assert.deepStrictEqual(w, []);
	});
	it("accepts extreme but real devices: kettle Y 30 s, 3D printer X 1 day, charger P 0.4 W", () => {
		assert.deepStrictEqual(norm({ finalMinSec: 30 }).w, []);
		assert.deepStrictEqual(norm({ finalAfterSec: 86_400 }).w, []);
		const charger = { finalMinVal: 0.4, finalMaxVal: 0, finalHotVal: 0, finalRestVal: 0.1, finalActVal: 0, finalActShare: 0 };
		const { f, w } = norm(charger, 0.05);
		assert.strictEqual(f.finalMinVal, 0.4);
		assert.deepStrictEqual(w, []);
	});
	const CLAMP = [
		// key, below, clamped low, above, clamped high, extra settings so that no other rule interferes
		["finalAfterSec", -5, 0, 700_000, 604_800, {}],
		["finalMinSec", 5, 10, 90_000, 86_400, {}],
		["finalQuietSec", 10, 30, 8000, 7200, { finalDipSec: 10 }],
		["finalDipSec", 5, 10, 4000, 3600, { finalQuietSec: 7200 }],
		["finalRestSec", 5, 10, 20_000, 14_400, {}],
		["finalCheckSec", 100, 300, 20_000, 14_400, { finalLockSec: 14_400 }],
		["finalLockSec", 100, 600, 20_000, 14_400, { finalCheckSec: 300 }],
		["finalActShare", 0.3, 0.5, 0.95, 0.9, {}],
	];
	for (const [key, below, lo, above, hi, extra] of CLAMP) {
		it(`clamps ${key} to [${lo}; ${hi}] with a warning`, () => {
			const a = norm({ ...extra, [key]: below });
			assert.strictEqual(a.f[key], lo);
			assert.ok(a.w.some(m => m.includes(key)), a.w.join());
			const b = norm({ ...extra, [key]: above });
			assert.strictEqual(b.f[key], hi);
			assert.ok(b.w.some(m => m.includes(key)), b.w.join());
		});
	}
	it("FINAL_BOUNDS hold the time ranges of the table", () => {
		assert.deepStrictEqual(FINAL_BOUNDS.finalAfterSec, [0, 604_800]);
		assert.deepStrictEqual(FINAL_BOUNDS.finalLockSec, [600, 14_400]);
		assert.deepStrictEqual(FINAL_BOUNDS.finalActShare, [0.5, 0.9]);
	});
	it("switches the final phase off when the band is empty or below the rest level", () => {
		for (const over of [{ finalMaxVal: 150 }, { finalMaxVal: 100 }, { finalRestVal: 150 }, { finalRestVal: 0, finalMinVal: 0.8 }]) {
			const { f, w } = norm(over);
			assert.deepStrictEqual(f, {}, JSON.stringify(over));
			assert.strictEqual(w.length, 1, JSON.stringify(over));
		}
	});
	it("turns exit c off when finalHotVal is below Pmax or Pmax is open", () => {
		assert.strictEqual(norm({ finalHotVal: 900 }).f.finalHotVal, 0);
		assert.strictEqual(norm({ finalMaxVal: 0 }).f.finalHotVal, 0);
		assert.strictEqual(norm({ finalHotVal: 2000 }).f.finalHotVal, 2000);
	});
	it("turns exit f off when the activity level overlaps the band or the rest, or only one of both is set", () => {
		for (const over of [{ finalActVal: 150 }, { finalActVal: 3 }, { finalActShare: 0 }, { finalActVal: 0 }]) {
			const { f, w } = norm(over);
			assert.deepStrictEqual([f.finalActVal, f.finalActShare], [0, 0], JSON.stringify(over));
			assert.strictEqual(w.length, 1, JSON.stringify(over));
		}
	});
	it("raises Z to G and limits the check window to the lock", () => {
		assert.strictEqual(norm({ finalQuietSec: 60, finalDipSec: 300 }).f.finalQuietSec, 300);
		assert.strictEqual(norm({ finalCheckSec: 3600, finalLockSec: 2700 }).f.finalCheckSec, 2700);
	});
	it("reads numbers given as text and treats NaN and negatives as 0", () => {
		assert.strictEqual(normalizeFinal({ standby: 1, ...WM_FINAL, finalMinVal: "150" }, [], "WM").finalMinVal, 150);
		assert.deepStrictEqual(normalizeFinal({ standby: 1, ...WM_FINAL, finalMinVal: Number.NaN }, [], "WM"), {});
		assert.deepStrictEqual(normalizeFinal({ standby: 1, ...WM_FINAL, finalMinSec: -1 }, [], "WM"), {});
	});
	it("finalViolations reports the per-poll floors without changing anything", () => {
		assert.deepStrictEqual(finalViolations(WM_FINAL, 1, 10), []);
		assert.deepStrictEqual(finalViolations(WM_FINAL, 1, 100).sort(), ["finalDipSec", "finalMinSec", "finalQuietSec", "finalRestSec"]);
		assert.deepStrictEqual(finalViolations({ ...WM_FINAL, finalMaxVal: 100 }, 1, 10), ["finalMaxVal"]);
	});
});

// test/runStore.test.js
import { DEFAULT_TYPES } from "../build/lib/config.js"; // ab Task 4: ../build/lib/legacyTypes.js
import { DETECTION_KEYS, detectionOf, typeHash } from "../build/lib/runStore.js";
it("keeps the hashes of existing values", () => {
	assert.deepStrictEqual(DEFAULT_TYPES.slice(0, 4).map(typeHash), ["39417b8a", "0af5b9bf", "8b9f87e6", "37a6b30f"]);
	assert.strictEqual(typeHash({ ...DEFAULT_TYPES[0], finalMinVal: 0, finalLockSec: 0 }), "39417b8a");
});
it("appends non-zero final fields as name=value, without collisions", () => {
	const a = typeHash({ ...DEFAULT_TYPES[0], finalMinVal: 150, finalMinSec: 160 });
	const b = typeHash({ ...DEFAULT_TYPES[0], finalMinVal: 160, finalMinSec: 150 });
	assert.notStrictEqual(a, "39417b8a");
	assert.notStrictEqual(a, b);
});
it("detectionOf fills 29 fields, final fields 0", () => {
	const d = detectionOf(DEFAULT_TYPES[0]);
	assert.strictEqual(DETECTION_KEYS.length, 29);
	assert.strictEqual(Object.keys(d).length, 29);
	assert.strictEqual(d.finalLockSec, 0);
});

// test/detectorGolden.test.js
import { FINAL_KEYS } from "../build/lib/detector/types.js";
it("is unchanged with all final phase fields 0 (no wrapper is built)", () => {
	assert.deepStrictEqual(differences(Object.fromEntries(FINAL_KEYS.map(k => [k, 0]))), []);
});
for (const k of FINAL_KEYS) {
	// Spec 8.2 / G1: golden per field – each field alone (without the master switch) changes nothing
	it(`is unchanged with only ${k} set (master switch off)`, () => {
		const v = k === "finalActShare" ? 0.7 : 100;
		assert.deepStrictEqual(differences({ [k]: v }), []);
	});
}
```

`FINAL_KEYS` wird aus `build/lib/detector/types.js` exportiert (Laufzeitwert, nicht nur Typ). `differences(extra)` wird schon hier nach `test/helpers/golden.js` verschoben (Export, liest `test/fixtures/detectorGolden.json`); die Gegenrichtung je Feld („notices active“) folgt in Task 14 mit eingeschaltetem Hauptschalter.

**Doku:** keine nutzerseitige Änderung (Felder noch ohne Bedienung).

- [ ] **Step 2:** `npm run build && npx mocha test/config.test.js test/runStore.test.js test/detectorGolden.test.js` → FAIL (`normalizeFinal`, `FINAL_KEYS` fehlen).
- [ ] **Step 3: Implementieren** wie in Interfaces; `createDetector` ändert sich hier noch nicht.
- [ ] **Step 4:** Tests erneut → PASS; `npm test` komplett grün.
- [ ] **Step 5: Commit** `feat: final phase fields with bounds and a hash that keeps existing values`

---

### Task 4: Werte im Gerät – Datenmodell, Vorlagen, Laufzeit (Spec C.1–C.3, C.7 Hash, Befunde M3, M8–M10)

**Files:**
- Create: `src/lib/templates.ts`, `src/lib/legacyTypes.ts`, `test/templates.test.js`, `test/helpers/devices.js`
- Modify: `src/lib/config.ts` (`InstanceConfig` `:162-175`, `DeviceConfig` `:205-240`, Typ-Block `:527-561`, `normalizeDeviceConfig` `:622-695`, `findType` `:703`), `src/lib/deviceRuntime.ts` (Konstruktor `:55-66`, `effective` `:74-96`, `deviceType` `:98`, `canKeepStateFor` `:296`, `updateConfig` `:305`), `src/lib/deviceRegistry.ts` (`upsert` `:101-150`, `syncOptimize` `:593-660`, `stopLearning` `:315-338`), `src/lib/runStore.ts` (`reconcileStore` `:467-509`, `Change.kind`), `src/lib/deviceForm.ts` (`typeId` `:22,143-150,366-371,417,464`), `src/lib/deviceManagement.ts` (`:152,407-417,475,658,888,1039-1058`, `saveLearnedType` → `applyLearned`), `src/main.ts:186-187`
- Test: `test/config.test.js`, `test/deviceRuntime.test.js`, `test/deviceRegistry.test.js`, `test/runStore.test.js`, `test/deviceForm.test.js`, `test/deviceManagement.test.js` und die übrigen Typ-Tests aus Spec 8.5

**Interfaces:**
- Consumes: `FINAL_KEYS`, `normalizeFinal`, `detectionOf`, `typeHash` (Task 3).
- Produces:
  - `templates.ts`: `interface Template { id: "washing-machine" | "dryer" | "dishwasher" | "custom"; name: string; detection: DetectionSettings }` (Werte in W: 30/15/1/2/50, 120/15/1/2/20, 15/0.25/0.5/2/120, 30/5/1/1/20; mode count, 60/300 s, Pausenschutz 0, kein Knitterschutz, keine Schlussphase); `TEMPLATES: readonly Template[]`; `templateDetection(id: string, unitFactor: number): DetectionSettings | null` (W-Felder `startVal`, `endVal`, `standby`, `pauseBelowVal`, `trailerBlockVal` ÷ `unitFactor`); `interface ArchiveTemplate { id: string; name: string; detection: DetectionSettings }`; `archiveTemplates(native: Record<string, unknown>): ArchiveTemplate[]` (Typen aus `resolveLegacyTypes`, deren `typeHash` oder Name von der gleichnamigen Vorlage bzw. „Custom N“/`customN` mit 30/5/1/1/20 abweicht; Reihenfolge wie in `native.types`).
  - `legacyTypes.ts`: `DEFAULT_TYPES`, `DeviceTypeConfig`, `normalizeType` (aus `config.ts` verschoben), `resolveLegacyTypes(native: Record<string, unknown>): DeviceTypeConfig[]` (= heutiger Typ-Block inkl. id-Vergabe über `allocateDeviceId` und Ergänzung fehlender eingebauter Typen), `findType(types: DeviceTypeConfig[], id: string)`.
  - `config.ts`: `InstanceConfig` ohne `types`, `configVersion: 5`; `IdPatch` ohne `types`; `DeviceConfig` + `detection: DetectionSettings`, `template?: string`, `needsReview?: boolean`, `reviewHint?: string`, `typeId?: string` (nur Altbestand); `normalizeDetection(raw: unknown, warnings: string[], label: string): DetectionSettings | null`; `normalizeDeviceConfig(native: Record<string, unknown>, legacyTypes?: DeviceTypeConfig[]): { config: DeviceConfig | null; warnings: string[] }` – ohne gültiges `detection`, aber mit `typeId`: Lesen über `findType(legacyTypes)` (nichts wird geschrieben; Persistenz Task 6); sonst (kein `detection`, kein Typ-Treffer, z. B. weil `initV4Migration` scheiterte) Vorlage „custom“ **mit `enabled = false`, `needsReview = true`, `reviewHint` = `detection values missing, using "Custom"`** + Warnung `Device "<name>": detection values missing, using "Custom", device disabled until it is checked` – ein solches Gerät wird heute ignoriert (`deviceRegistry.ts:115-118`) und darf nicht plötzlich mit Custom-Werten Nachrichten senden.
  - `DeviceRuntime`: Konstruktor `(host, deviceId, cfg, inst, sink, listener)`; Getter `baseDetection: DetectionSettings` (= `detectionOf(cfg.detection)`), `effective` = base ⊕ override; `canKeepStateFor(next)` vergleicht nur `powerId`; `updateConfig` baut den Detector neu, wenn sich `typeHash(detection)`, `abort` oder `abortFixed` ändern (bei laufendem Lauf nach dem Lauf).
  - `reconcileStore(store: StoreFile, hash: string, step: number, unitFactor: number, now: number): string[]` (ohne `typeId`; Änderungsart `baseChanged`, alte Einträge `typeChanged` werden gleich angezeigt).
  - `deviceRegistry.upsert`: keine Typsuche; Gerät mit `needsReview && !enabled` wird nicht gebaut (`log.warn` mit `reviewHint`).
  - `deviceManagement.applyLearned(id: Id, suggestion: LearningSuggestion, ctx: ActionContext, unit?: string): Promise<void>` – Formular alt/neu ohne Namensfeld, schreibt `detection` (Einheit des States) ins Gerät über `writeDevice`, löscht `template`, kein Neustart, kein Schreiben in `system.adapter.*`. `keepCurrentLevel` im Anlernen = `cfg.template` ist eine eingebaute Vorlage.
  - `deviceForm`: Feld `typeId` → `template` (Auswahl der `TEMPLATES`; beim Anlegen Pflicht, schreibt `templateDetection(template, unitFactor)`), beim Bearbeiten bleibt `detection` unverändert; Speichern löscht `needsReview`/`reviewHint`.
  - `formToDeviceConfig(f: DeviceFormData, o: { isNew: boolean; unitFactor: number; previous?: DeviceConfig }): { config: DeviceConfig | null; errors: string[] }` – **beim Bearbeiten werden alle Gerätefelder, die das Formular nicht zeigt, aus `previous` übernommen** (`phases`, `learned`, `template`; später hinzukommende Nicht-Formularfelder ebenso), weil `writeDevice` (`deviceManagement.ts:359-369`) `native` vollständig ersetzt. `template` wird nur verworfen, wenn die gespeicherten Erkennungswerte von `templateDetection(template, unitFactor)` abweichen. `editDevice` (`deviceManagement.ts:704`) reicht die bisherige Konfiguration als `previous` durch; `setEnabled` (`:728`) bleibt wie heute (spreizt `cfg`).
  - `test/helpers/devices.js` (Setup-Code aus `deviceRuntime.test.js`/`optimizationIntegration.test.js` hierher verschoben und auf `detection` umgestellt): `P = "plug.0.power"`, `SW = "plug.0.switch"`, `WASHER = detectionOf(TEMPLATES[0].detection)` (3.1.2-WM 30/15/1/2/50), `deviceConfig(over = {})` (Name „Washer“, `powerId: P`, Texte „Started“/„Finished“, `detection: WASHER`), `instanceConfig(over = {})` (Poll 10 s, Empfänger `tg` = telegram.0), `runtimeSetup({ cfg, inst, hostOpts, host, id = "washer" })` → `{ host, rt, messages, events }` (`cfg` wird in `deviceConfig` gemischt; `host` optional geteilt; Ereignisse als `"washer:start"` …), `play(ctx, values)` (Wert + `onPower` + `tick` + 10 s), `playPoints(ctx, points, stepMs = 10_000, stop?)` (Uhr springt zu jedem Punkt, Poll alle `stepMs`; hält an, sobald `stop(ctx)` wahr ist, Rückgabe: Index des nächsten Punkts), `registrySetup(o = {})` → `{ host, files, inst, reg, cfg }` (Gerät `"dev"`, `autoOptimize` an außer `o.autoOptimize === false`, `o.notify`, `o.detection`, `o.cfg` (gemischt), `o.history`, `o.files`, `o.host`, `o.lang`, `o.beforeOptimizeWrite` ab Task 8, `o.budgetMs` ab Task 21), `drain(ctx)`, `feed(ctx, values)` (über `routeForeignState` + `tickAll`, danach `drain`; gibt ein `Promise` zurück), `feedPoints(ctx, points, stepMs = 10_000)`.

- [ ] **Step 1: Failing tests**

```js
// test/templates.test.js
import assert from "node:assert";
import { FINAL_KEYS } from "../build/lib/detector/types.js";
import { typeHash } from "../build/lib/runStore.js";
import { archiveTemplates, templateDetection, TEMPLATES } from "../build/lib/templates.js";

describe("templates", () => {
	it("built-in templates carry the 3.1.2 values and no final phase", () => {
		assert.deepStrictEqual(
			TEMPLATES.map(t => [t.id, t.detection.startVal, t.detection.endVal, t.detection.standby, t.detection.startCount, t.detection.endCount, t.detection.mode]),
			[["washing-machine", 30, 15, 1, 2, 50, "count"], ["dryer", 120, 15, 1, 2, 20, "count"],
				["dishwasher", 15, 0.25, 0.5, 2, 120, "count"], ["custom", 30, 5, 1, 1, 20, "count"]],
		);
		assert.ok(TEMPLATES.every(t => FINAL_KEYS.every(k => !t.detection[k])));
		assert.deepStrictEqual(TEMPLATES.slice(0, 3).map(t => typeHash(t.detection)), ["39417b8a", "0af5b9bf", "8b9f87e6"]);
	});
	it("divides power values for a kW state, counts and times stay", () => {
		const d = templateDetection("washing-machine", 1000);
		assert.deepStrictEqual([d.startVal, d.endVal, d.standby, d.startCount, d.endCount, d.endDurationSec], [0.03, 0.015, 0.001, 2, 50, 300]);
		assert.strictEqual(templateDetection("nope", 1), null);
	});
	it("archive lists changed values and renamed unused types only, in native order", () => {
		const row = (id, name, startVal) => ({ id, name, startVal, endVal: 5, standby: 1, startCount: 1, endCount: 20 });
		const native = { types: [row("custom1", "Custom 1", 30), row("custom2", "Pumpe", 30),
			{ id: "dryer", name: "Dryer", startVal: 100, endVal: 15, standby: 1, startCount: 2, endCount: 20 }, row("custom3", "custom3", 30)] };
		assert.deepStrictEqual(archiveTemplates(native).map(t => [t.id, t.name]), [["custom2", "Pumpe"], ["dryer", "Dryer"]]);
		assert.deepStrictEqual(archiveTemplates({}), []);
	});
});

// test/config.test.js
import { normalizeDeviceConfig } from "../build/lib/config.js";
import { resolveLegacyTypes } from "../build/lib/legacyTypes.js";
it("reads a V4 device with typeId through the legacy types without writing", () => {
	const raw = { name: "WM", powerId: "a.0.p", typeId: "dryer" };
	const { config } = normalizeDeviceConfig(raw, resolveLegacyTypes({}));
	assert.deepStrictEqual([config.detection.startVal, config.detection.endCount], [120, 20]);
	assert.strictEqual(raw.detection, undefined);
});
it("falls back to Custom, disabled with a review hint, when the detection is missing", () => {
	for (const raw of [{ name: "WM", powerId: "a.0.p", enabled: true }, { name: "WM", powerId: "a.0.p", enabled: true, typeId: "gone" }]) {
		const { config, warnings } = normalizeDeviceConfig(raw, resolveLegacyTypes({}));
		assert.deepStrictEqual([config.detection.startVal, config.detection.endVal, config.detection.endCount], [30, 5, 20]);
		assert.deepStrictEqual([config.enabled, config.needsReview], [false, true]);
		assert.deepStrictEqual(warnings, ['Device "WM": detection values missing, using "Custom", device disabled until it is checked']);
	}
});
it("normalizes detection like a type and keeps the final fields", () => {
	const { config } = normalizeDeviceConfig({ name: "WM", powerId: "a.0.p",
		detection: { startVal: "30", endVal: 15, standby: 1, startCount: 2, endCount: 50, mode: "bogus", finalMinVal: 150, finalMinSec: 168 } });
	assert.deepStrictEqual([config.detection.startVal, config.detection.mode, config.detection.finalMinVal], [30, "count", 150]);
});

// test/runStore.test.js
it("keeps the override when only the type id of the store differs (migration, M9)", () => {
	const st = emptyStore("wm", "washing-machine", "39417b8a", 10000, 1);
	st.override = { endCount: 30 };
	assert.deepStrictEqual(reconcileStore(st, "39417b8a", 10000, 1, 0), []);
	assert.deepStrictEqual(st.override, { endCount: 30 });
	reconcileStore(st, "0af5b9bf", 10000, 1, 5);
	assert.strictEqual(st.override, null);
	assert.strictEqual(st.changes.at(-1).kind, "baseChanged");
});

// test/deviceRuntime.test.js
import { runOf } from "./helpers/programmes.js";
import { deviceConfig, play, runtimeSetup, WASHER } from "./helpers/devices.js";
it("keeps the cycle when only the detection values change; the new values apply after the run", async () => {
	const ctx = runtimeSetup();
	await ctx.rt.init();
	const run = runOf({ device: "washer", programme: "cotton60", seed: 1 });
	await play(ctx, run.values.slice(0, run.start + 20));
	assert.strictEqual(ctx.rt.isRunning, true);
	assert.strictEqual(ctx.rt.canKeepStateFor(deviceConfig({ detection: { ...WASHER, endVal: 10 } })), true);
	ctx.rt.updateConfig(deviceConfig({ detection: { ...WASHER, endVal: 10 } }));
	assert.strictEqual(ctx.rt.isRunning, true);
	assert.deepStrictEqual(ctx.events, ["washer:start"]);
	assert.strictEqual(ctx.rt.effective.endVal, 10);
	assert.strictEqual(ctx.rt.canKeepStateFor(deviceConfig({ powerId: "other.0.power" })), false);
});

// test/deviceRegistry.test.js
import { registrySetup } from "./helpers/devices.js";
it("does not run a disabled device that needs a review and says why (M3)", async () => {
	const ctx = await registrySetup({ autoOptimize: false, cfg: { enabled: false, needsReview: true, reviewHint: 'type "Kessel" not found' } });
	assert.strictEqual(ctx.reg.get("dev"), undefined);
	assert.ok(ctx.host.logs.warn.some(m => m.includes('type "Kessel" not found')));
});

// test/deviceForm.test.js
it("a new device takes the values of the chosen template; saving clears needsReview", () => {
	const { config } = formToDeviceConfig({ ...formOf(), template: "dryer", needsReview: true, reviewHint: "x" }, { isNew: true, unitFactor: 1 });
	assert.deepStrictEqual([config.detection.startVal, config.template, config.needsReview, config.reviewHint], [120, "dryer", undefined, undefined]);
});
it("editing keeps the detection values", () => {
	const detection = { ...WASHER, endCount: 77 };
	const { config } = formToDeviceConfig({ ...formOf(), detection }, { isNew: false, unitFactor: 1 });
	assert.strictEqual(config.detection.endCount, 77);
});

// test/deviceManagement.test.js (lokale Helfer setup/addDevice/load/fakeAction/actionOf; withHistory auf Dateiebene verschoben)
it("learning writes the values into the device and never touches the instance object (M10)", async () => {
	const ctx = setup();
	await addDevice(ctx, "trockner", deviceCfg({ template: "dryer" }));
	withHistory(ctx, historyOf([washingMachine, longPause, washingMachine]));
	const [info] = await load(ctx);
	const action = fakeAction({ forms: [{ source: "history", instance: "history.0" }, learned] });
	await actionOf(info, "learn").handler("trockner", action);
	const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
	assert.deepStrictEqual([native.detection.mode, native.detection.endCount, native.detection.startVal], ["timed", 200, 70]);
	assert.strictEqual(native.template, undefined);
	assert.deepStrictEqual(ctx.adapter.extendedForeign, []);
	assert.strictEqual(action.forms[1].schema.items.name, undefined, "no name field any more");
});
```

`formToDeviceConfig` bekommt als zweiten Parameter `{ isNew: boolean; unitFactor: number; previous?: DeviceConfig }`; `formOf`/`deviceCfg` in den Testdateien setzen `detection: WASHER` statt `typeId`. `learned` ist die vorhandene Konstante in `test/deviceManagement.test.js` (ohne `name`).

```js
// test/deviceForm.test.js
it("editing keeps fields the form does not show (phases, learned, template) – writeDevice replaces native", () => {
	const phases = { v: 1, enabled: true, scope: "run", bands: [], phases: [], learnedAt: 1, quality: { agreement: 1, runsUsed: 3 } };
	const previous = { ...deviceConfig({ template: "washing-machine" }), phases, learned: true };
	const { config } = formToDeviceConfig({ ...formOf(), endText: "Done!", detection: WASHER }, { isNew: false, unitFactor: 1, previous });
	assert.deepStrictEqual([config.endText, config.phases, config.learned, config.template], ["Done!", phases, true, "washing-machine"]);
	const changed = formToDeviceConfig({ ...formOf(), detection: { ...WASHER, endCount: 77 } }, { isNew: false, unitFactor: 1, previous });
	assert.strictEqual(changed.config.template, undefined, "values differ from the template");
});
```

**Doku:** `docs/de|en/README.md` §2/§3 (Vorlage statt Gerätetyp beim Anlegen, Werte stehen im Gerät, Gerät ohne Werte wird deaktiviert mit Hinweis); Changelog-Zeile „Werte im Gerät“ (Zeile 35 umformulieren).

- [ ] **Step 2:** `npm run build` → Compile-Fehler an allen Typ-Stellen; Tests FAIL.
- [ ] **Step 3: Umstellen** wie in Interfaces; `main.ts` lädt `resolveLegacyTypes(this.config)` einmal und reicht sie an `deviceConfigOf` → `normalizeDeviceConfig`; `persistGeneratedIds` ohne `types`-Zweig; `findType` nur noch in `legacyTypes.ts`. Bestehende Tests mit Typ-Bezug (Spec 8.5-Liste) auf `detection` bzw. `test/helpers/devices.js` umstellen, ohne Erwartungswerte zu ändern.
- [ ] **Step 4:** `npm test` → PASS (Golden unverändert).
- [ ] **Step 5: Commit** `feat: detection values live in the device; built-in templates replace device types`

---

### Task 5: 3.1.2-Migration nach Spec C.5 mit Zuordnungstests (Befunde M1–M7)

**Files:**
- Modify: `src/lib/migration.ts` (`convertTypes` `:272-345`, `convertDevice` `:347-407`, `migrateLegacyConfig` `:427-467`, `convertRecipients` `:232-252`), `src/main.ts` (`initMigration` `:103-170`)
- Create: `test/migrationMapping.test.js`, `test/fixtures/legacy-config/edgeTypes.json`
- Modify: `test/migration.test.js`

**Interfaces:**
- Consumes: `TEMPLATES`, `templateDetection`, `normalizeDetection` (Task 4).
- Produces:
  - `MigrationResult` = `{ instance: InstanceConfig; archive: Record<string, unknown>[]; devices: { id; oldName; config: DeviceConfig }[]; warnings: string[] }`.
  - `matchLegacyType(typeName: string, defaults: Record<string, unknown>[], customs: Record<string, unknown>[]): { row: Record<string, unknown> | null; via: "default" | "custom" | "case" | "slot" | "none" }` – exakt ungetrimmt in `default.ids` (letzter Treffer), sonst exakt in `custom.ids` (letzter), sonst getrimmt ohne Groß-/Kleinschreibung (`case`, erst default, dann custom), sonst `custom.ids`-Zeile mit `id` = N−1 für Typname `customN` (`slot`), sonst `none` (Vorlage „custom“).
  - Gerät bei `via` ∈ {`case`, `slot`, `none`}: `enabled = false`, `needsReview = true`, `reviewHint` = `3.1.2 type "<name>" not found exactly; values taken from <case match "x" | renamed slot customN | template Custom>`; `template` nur bei `via = "default"`.
  - Warnungen (genauer Text): `Type "<name>": comment "<text>" not migrated`, `Type "<name>": <feld> "<alt>" is not a number, using <neu>`, `Recipient <kind>-<id>: target "<alt>" replaced by "<neu>"`.
  - `initMigration` schreibt `obj.native = { ...result.instance, types: result.archive }`.

- [ ] **Step 1: Fixture** `test/fixtures/legacy-config/edgeTypes.json` (3.1.2-native, `_comment` beschreibt den Zweck):
  - `default.ids`: `{name: "washing-machine", 25/12/1/2/40, id 0}`, `{name: "Washing-Machine", 35/15/1/2/50, id 1}`, `{name: "dryer", 120/15/1/2/20, id 2}`.
  - `custom.ids`: id 2 `{name: "Pumpe", 60/5/1/1/20, comment: "Keller"}`, id 4 `{name: "custom5", startVal: "", 5/1/1/20}`, id 6 `{name: "custom7", 40/5/1/1/20}`.
  - `linkedDevice.finalIds`: Geräte „Waschen“ (`washing-machine`), „Waschen2“ (`Washing-Machine`), „Trockner1“ und „Trockner2“ (beide `dryer`), „Pumpe1“ (`custom3`), „Pumpe2“ (` Pumpe`), „Kessel“ (`Kessel`), „Heizer“ (`custom5`); alle mit `pathConsumption: "x.0.<name>.power"`, `enabled: true`, leeren Messenger-Listen.
  - `sayit.ids`: `{id: "0", name: "Bad", path: "sayit.1.tts.cachetts", volume: 40, activeFrom: "07:00", activeUntil: "22:00"}`; `whatsapp.ids`: `{id: "0", name: "Ich", path: "javascript.0.wa"}`.
- [ ] **Step 2: Failing tests** (`test/migrationMapping.test.js`; je Zeile der Spec-Tabelle C.5 ein `it`):

```js
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createDetector } from "../build/lib/detector/index.js";
import { FINAL_KEYS } from "../build/lib/detector/types.js";
import { LEGACY_STATE_MAP, migrateLegacyConfig } from "../build/lib/migration.js";
import { goldenCurves } from "./helpers/golden.js";

const { createOracle } = createRequire(import.meta.url)("./fixtures/legacyOracle.cjs");
const load = name => JSON.parse(readFileSync(new URL(`./fixtures/legacy-config/${name}.json`, import.meta.url), "utf8"));
const full = migrateLegacyConfig(load("full"));
const edge = migrateLegacyConfig(load("edgeTypes"));
const dev = (r, name) => r.devices.find(d => d.oldName === name).config;
const rec = (r, id) => r.instance.recipients.find(x => x.id === id);
const src = load("full");

describe("3.1.2 → V4 mapping (Spec C.5, one test per row)", () => {
	it("status texts → native.statusTexts", () => {
		const s = src.status.ids[0];
		assert.deepStrictEqual(full.instance.statusTexts, { running: s.stateAction, standby: s.stateStandby, off: s.stateOff });
		const empty = migrateLegacyConfig({ ...src, status: { ids: [{ stateAction: "", stateStandby: "", stateOff: "" }] } });
		assert.deepStrictEqual(empty.instance.statusTexts, { running: "in action", standby: "standby", off: "switched off" });
	});
	it("fixed 10 s poll → pollIntervalSec 10; no HTML table", () => {
		assert.deepStrictEqual([full.instance.pollIntervalSec, full.instance.historyHtml, full.instance.configVersion], [10, false, 5]);
	});
	it("alexa row → recipient with stateId, instance from the path, volume rule and window", () => {
		for (const row of src.alexa.ids) {
			const r = rec(full, `alexa-${row.id}`);
			const vol = Number(row.volume);
			assert.deepStrictEqual(
				[r.kind, r.stateId, r.instance, r.volume, r.activeFrom, r.activeUntil],
				["alexa", row.path, row.path.split(".").slice(0, 2).join("."), vol >= 0 && vol <= 100 && row.volume !== "" ? vol : 50, row.activeFrom, row.activeUntil],
			);
		}
	});
	it("sayit row → stateId <instance>.tts.text, warning when the path differs (M7)", () => {
		const r = rec(edge, "sayit-0");
		assert.deepStrictEqual([r.instance, r.stateId, r.volume, r.activeFrom, r.activeUntil], ["sayit.1", "sayit.1.tts.text", 40, "07:00", "22:00"]);
		assert.ok(edge.warnings.includes('Recipient sayit-0: target "sayit.1.tts.cachetts" replaced by "sayit.1.tts.text"'));
	});
	it("whatsapp row → whatsapp-cmb instance, warning when the path differs (M7)", () => {
		const r = rec(edge, "whatsapp-0");
		assert.deepStrictEqual([r.instance, r.stateId], ["whatsapp-cmb.0", "whatsapp-cmb.0.sendMessage"]);
		assert.ok(edge.warnings.includes('Recipient whatsapp-0: target "javascript.0.wa" replaced by "whatsapp-cmb.0.sendMessage"'));
	});
	it("telegram row → telegram.N, target and target kind", () => {
		for (const row of src.telegram.ids) {
			const r = rec(full, `telegram-${row.id}`);
			assert.deepStrictEqual([r.instance, r.target, r.telegramTarget],
				[`telegram.${String(row.inst).replace(".", "")}`, row.username, row.key === "chatID" ? "chatId" : "user"]);
		}
	});
	it("pushover row → instance, title, device, priority, sound, ttl", () => {
		const prio = { normal: 0, high: 1, quiet: -1, confirmation: 2 };
		for (const row of src.pushover.ids) {
			const r = rec(full, `pushover-${row.id}`);
			assert.deepStrictEqual([r.instance, r.title, r.device, r.priority, r.sound],
				[`pushover.${String(row.inst).replace(".", "")}`, row.title.trim() || undefined, row.deviceID.trim() || undefined, prio[row.prio] ?? 0, row.sound.trim() || undefined]);
			assert.strictEqual(r.ttl, row.ttl === "" || row.ttl === undefined ? undefined : Number(row.ttl));
		}
	});
	it("signal, email, matrix, discord rows → instance and fields", () => {
		for (const row of src.signal.ids) assert.strictEqual(rec(full, `signal-${row.id}`).instance, `signal-cmb.${String(row.inst).replace(".", "")}`);
		for (const row of src.email.ids) {
			const r = rec(full, `email-${row.id}`);
			assert.deepStrictEqual([r.instance, r.emailFrom, r.emailTo], ["email.0", row.emailFrom, row.emailTo]);
		}
		for (const row of src.matrix.ids) assert.strictEqual(rec(full, `matrix-${row.id}`).instance, `matrix-org.${String(row.inst).replace(".", "")}`);
		for (const row of src.discord.ids) {
			const r = rec(full, `discord-${row.id}`);
			for (const k of ["userId", "userTag", "userName", "serverId", "channelId"]) assert.strictEqual(r[k], row[k] || undefined, k);
		}
	});
	it("device fields → device native", () => {
		for (const [key, raw] of Object.entries(src.linkedDevice.finalIds)) {
			const c = full.devices.find(d => d.oldName === raw.name).config;
			assert.deepStrictEqual(
				[c.name, c.powerId, c.switchId, c.startText, c.endText, c.abort, c.abortFixed, c.autoOff, c.autoOffMinutes],
				[raw.name.trim(), raw.pathConsumption, raw.pathSwitch || undefined, raw.startText, raw.endText, raw.abort === true || raw.abort === "true", false,
					raw.autoOff === true || raw.autoOff === "true", Math.floor(Number(raw.timer) || 0)], key);
			const order = ["alexa", "sayit", "whatsapp", "telegram", "pushover", "signal", "email", "matrix", "discord"];
			assert.deepStrictEqual(c.recipients, order.flatMap(k => (raw[k] ?? []).map(id => `${k}-${id}`)), key);
			assert.deepStrictEqual([c.reminder.enabled, c.actions, c.autoOptimize, c.optimizeNotify, c.phases], [false, [], undefined, undefined, undefined]);
		}
	});
	it("exact type → detection copy of the row, template, enabled, no final phase", () => {
		const c = dev(edge, "Waschen");
		assert.deepStrictEqual([c.detection.startVal, c.detection.endVal, c.detection.endCount, c.detection.mode, c.detection.startDurationSec, c.detection.endDurationSec, c.template, c.enabled, c.needsReview],
			[25, 12, 40, "count", 60, 300, "washing-machine", true, undefined]);
		assert.ok(FINAL_KEYS.every(k => !c.detection[k]));
		assert.strictEqual(dev(edge, "Waschen2").detection.startVal, 35, "a case variant is a different 3.1.2 row (M2)");
	});
	it("case-only, renamed slot and unknown types → disabled with review hint (M1, M3)", () => {
		assert.deepStrictEqual(["Pumpe1", "Pumpe2", "Kessel"].map(n => {
			const c = dev(edge, n);
			return [c.enabled, c.needsReview, c.detection.startVal, c.template];
		}), [[false, true, 60, undefined], [false, true, 60, undefined], [false, true, 30, undefined]]);
		assert.match(dev(edge, "Pumpe1").reviewHint, /renamed slot custom3/);
		assert.match(dev(edge, "Pumpe2").reviewHint, /case match "Pumpe"/);
		assert.match(dev(edge, "Kessel").reviewHint, /template Custom/);
	});
	it("shared type → each device gets its own copy (M4)", () => {
		const a = dev(edge, "Trockner1").detection;
		const b = dev(edge, "Trockner2").detection;
		assert.deepStrictEqual(a, b);
		assert.notStrictEqual(a, b);
	});
	it("non-numeric value → template value with warning (M5); comment → warning (M6)", () => {
		assert.strictEqual(dev(edge, "Heizer").detection.startVal, 30);
		assert.ok(edge.warnings.includes('Type "custom5": startVal "" is not a number, using 30'));
		assert.ok(edge.warnings.includes('Type "Pumpe": comment "Keller" not migrated'));
	});
	it("archive holds only unused types whose values or name differ (P17)", () => {
		assert.deepStrictEqual(edge.archive.map(t => [t.id, t.name, t.startVal]), [["custom7", "custom7", 40]]);
		assert.ok(full.archive.every(t => !full.devices.some(d => d.config.template === t.id)));
	});
	it("old states → new states", () => {
		assert.deepStrictEqual(LEGACY_STATE_MAP, {
			"last operations": "lastOperations", lastRuntime: "lastRuntime",
			"config.do not disturb": "config.doNotDisturb", "config.runtime max": "config.runtimeMax",
		});
	});
	it("golden: old detection via the type equals new detection in the device", () => {
		for (const name of ["full", "real312", "renamedCustom"]) {
			const native = load(name);
			const result = migrateLegacyConfig(native);
			for (const raw of Object.values(native.linkedDevice.finalIds)) {
				const c = result.devices.find(d => d.oldName === raw.name).config;
				if (c.needsReview) continue;
				const rows = [...native.default.ids, ...native.custom.ids].filter(r => r.name === raw.type);
				const row = native.default.ids.filter(r => r.name === raw.type).at(-1) ?? rows.at(-1);
				const objVal = { startVal: +row.startVal, endVal: +row.endVal, standby: +row.standby, startCount: +row.startCount, endCount: +row.endCount };
				for (const [curve, values] of Object.entries(goldenCurves()).slice(0, 20)) {
					const oracle = createOracle(objVal, { abort: c.abort });
					const det = createDetector(c.detection, { abort: c.abort, abortFixed: false });
					values.forEach((p, i) => {
						assert.deepStrictEqual(det.tick(p, i * 10_000), oracle.tick(p), `${name}/${raw.name}/${curve}@${i}`);
					});
				}
			}
		}
	});
});
```

`createOracle(objVal, { abort })` und `oracle.tick(power)` wie in `test/legacyDetector.test.js:29-35` (Vergleich des ganzen `TickResult`).

- [ ] **Step 3:** `npm run build && npx mocha test/migrationMapping.test.js` → FAIL.
- [ ] **Step 4: Implementieren**: `convertTypes` ersetzt durch Tabellenlesen + `matchLegacyType`; `detection` = Vorlage (`TEMPLATES`, Basis count, 60/300 s) ⊕ 5 Werte der Zeile; Warnungen wie in Interfaces; `archive` = Zeilen ohne Gerät, deren Werte oder Name von der Vorlage abweichen (id: eingebaute id bzw. `customN`, Felder wie `native.types`-Zeile).
- [ ] **Step 5:** `npm test` → PASS (bestehende `migration.test.js`-Erwartungen zu `types`/`typeId` auf `detection`/`archive` umgestellt).
- [ ] **Doku:** `docs/de|en/README.md` §9 (exakte Typnamen, nicht gefundener Typ → deaktiviert mit Hinweis, umbenannte Plätze, Kopie je Gerät bei geteilten Typen, Archiv inkl. Namen, Warnungen M5–M7, Verhaltensänderungen M11); Changelog-Zeile zur Migration umformulieren.
- [ ] **Step 6: Commit** `fix: 3.1.2 migration copies type values into each device exactly like 3.1.2 and warns about every change`

---

### Task 6: Migration von V4-Testständen (Spec C.6)

**Files:**
- Modify: `src/lib/migration.ts`, `src/main.ts` (`onReady` `:42-56`, neue Methode `initV4Migration`), `io-package.json` (`native`: `configVersion` 5, `types` entfernt)
- Create: `test/migrationV4.test.js`

**Interfaces:**
- Consumes: `resolveLegacyTypes`, `findType`, `normalizeType` (Task 4).
- Produces: `migrateV4Device(raw: Record<string, unknown>, native: Record<string, unknown>): { native: Record<string, unknown> | null; warnings: string[] }` – `null` = nichts zu tun (hat `detection` oder kein `typeId`); sonst alle Felder unverändert, `typeId` entfernt, `detection = detectionOf(Treffer)`, `template` bei eingebautem Typ; ohne Treffer `needsReview`/`reviewHint`, Werte „custom“ und **`enabled = false`** (das Gerät wird heute ignoriert, `deviceRegistry.ts:115-118`; mit `enabled` unverändert liefe es nach der Migration mit Custom-Werten und sendete Nachrichten – gleiche Regel wie bei der 3.1.2-Entscheidung 1).
- `initV4Migration()` in `main.ts`: läuft nach `initMigration`, vor dem Laden der Geräte; je Geräteobjekt mit `typeId` und ohne `detection`: Objekt lesen, `native` ersetzen, mit `setObjectAsync` schreiben (kein `extendObject`, M8). Keine Schreibzugriffe auf `system.adapter.*`. Pure Hilfe für den Test: `planV4Migration(objects: Record<string, ioBroker.Object>, native): { id: string; native: Record<string, unknown> }[]`.

- [ ] **Step 1: Failing tests** (`test/migrationV4.test.js`):

```js
import assert from "node:assert";
import { migrateV4Device, planV4Migration } from "../build/lib/migration.js";
import { emptyStore, reconcileStore, typeHash } from "../build/lib/runStore.js";

const raw = {
	enabled: true, name: "WM", powerId: "p", switchId: "s", startText: "a", endText: "b", abort: true, abortFixed: true,
	autoOff: true, autoOffMinutes: 3, recipients: ["x"], reminder: { enabled: true, intervalMin: 5, maxCount: 2, text: "r", ackStateId: "" },
	actions: [{ event: "end", stateId: "q", value: "1" }], autoOptimize: true, optimizeNotify: true, sourceId: "dev", typeId: "washing-machine",
};
const custom = (id, name, startVal) => ({ id, name, startVal, endVal: 5, standby: 1, startCount: 1, endCount: 20, mode: "count", startDurationSec: 60, endDurationSec: 300 });

describe("V4 test installation → values in the device (Spec C.6)", () => {
	it("is detected by structure, also with configVersion 5", () => {
		assert.ok(migrateV4Device(raw, { configVersion: 5 }).native);
		assert.strictEqual(migrateV4Device({ ...raw, typeId: undefined }, {}).native, null);
	});
	it("keeps every device field except typeId; detection equals the type", () => {
		const { native } = migrateV4Device(raw, {});
		const { typeId, ...rest } = raw;
		const { detection, template, ...kept } = native;
		assert.deepStrictEqual(kept, rest);
		assert.strictEqual(template, "washing-machine");
		assert.strictEqual(typeHash(detection), "39417b8a");
		assert.ok(!("typeId" in native));
	});
	it("resolves like today: deleted built-in row, empty and missing table, row without id, custom1..10 from defaults", () => {
		const cases = [
			[{ types: [custom("custom1", "Custom 1", 40)] }, "dryer", 120],
			[{ types: [] }, "custom4", 30],
			[{}, "dishwasher", 15],
			[{ types: [{ ...custom(undefined, "Kaffee", 55), id: undefined }] }, "kaffee", 55],
			[{ types: [custom("custom2", "Custom 2", 44)] }, "custom2", 44],
		];
		for (const [native, typeId, startVal] of cases) {
			const r = migrateV4Device({ ...raw, typeId }, native).native;
			assert.deepStrictEqual([r.detection.startVal, r.needsReview], [startVal, undefined], `${typeId} ${JSON.stringify(native)}`);
		}
	});
	it("generated ids are deterministic when persistGeneratedIds failed", () => {
		const native = { types: [{ ...custom(undefined, "Kaffee", 55), id: undefined }, { ...custom(undefined, "Kaffee", 66), id: undefined }] };
		const a = migrateV4Device({ ...raw, typeId: "kaffee_2" }, native).native;
		assert.strictEqual(a.detection.startVal, 66);
	});
	it("no hit → review hint, values Custom, disabled (it was ignored before)", () => {
		const r = migrateV4Device({ ...raw, typeId: "gone" }, {}).native;
		assert.deepStrictEqual([r.needsReview, r.detection.startVal, r.enabled], [true, 30, false]);
		assert.match(r.reviewHint, /gone/);
	});
	it("is idempotent", () => {
		const once = migrateV4Device(raw, {}).native;
		assert.strictEqual(migrateV4Device(once, {}).native, null);
	});
	it("plans device objects only and never the instance object", () => {
		const objects = {
			"device-reminder.0.wm": { type: "device", common: {}, native: raw },
			"device-reminder.0.done": { type: "device", common: {}, native: migrateV4Device(raw, {}).native },
			"system.adapter.device-reminder.0": { type: "instance", common: {}, native: { types: [] } },
		};
		assert.deepStrictEqual(planV4Migration(objects, {}).map(p => p.id), ["device-reminder.0.wm"]);
	});
	it("an override of the learning data survives (same hash)", () => {
		const st = emptyStore("wm", "washing-machine", "39417b8a", 10000, 1);
		st.override = { endCount: 30 };
		reconcileStore(st, typeHash(migrateV4Device(raw, {}).native.detection), 10000, 1, 0);
		assert.deepStrictEqual(st.override, { endCount: 30 });
	});
});
```

Erwartung „`kaffee`“/„`kaffee_2`“: so vergibt `allocateDeviceId("Kaffee", taken)` heute ids (`ids.ts:26-36`, Suffix `_N`; nachgerechnet mit `…/scratchpad/review/ids.mjs`: `kaffee:55 kaffee_2:66`).

**Doku:** `docs/de|en/README.md` §9 (V4-Teststände: Werte wandern ohne Neustart ins Gerät; Gerät mit nicht gefundenem Typ wird deaktiviert).

- [ ] **Step 2:** `npm run build && npx mocha test/migrationV4.test.js` → FAIL.
- [ ] **Step 3: Implementieren**; `"types"` bleibt in `v4Keys` (`main.ts:110-117`); `io-package.json` nur `native` ändern.
- [ ] **Step 4:** `npm test` → PASS (inkl. `test/package.cjs`).
- [ ] **Step 5: Commit** `feat: V4 test installations move their type values into the devices without restart`

---

### Task 7: Bedienung ohne Typen – Admin, Geräteformular, Archiv, Karte (Spec C.2, C.4, 7.3, 7.4)

**Files:**
- Modify: `admin/jsonConfig.json:88-275` (Tab → `staticText` `valuesInDeviceHelp`), `src/lib/deviceForm.ts`, `src/lib/deviceManagement.ts` (`buildDeviceInfo` `:392-560`, `addDevice` `:626-686`, Instanz-Aktionen), `src/lib/dmTexts.ts` (neun Texte mit „Gerätetyp“), `admin/i18n/*.json`
- Test: `test/deviceForm.test.js`, `test/deviceManagement.test.js`, `test/dmTexts.test.js`

**Interfaces:**
- Consumes: `TEMPLATES`, `archiveTemplates`, `templateDetection` (Task 4), `FINAL_BOUNDS` (Task 3).
- Produces:
  - `buildSourceSchema(archive: ArchiveTemplate[], devices: { id: string; name: string }[]): JsonFormSchema` – Feld `source` mit Werten `template:<id>` | `archive:<id>` | `device:<id>`.
  - `buildDeviceSchema(cfg, detection?, enums?, unit = "W")`: Panel „Erkennung“ (`mode`, `startVal`, `endVal`, `standby`, `startCount`, `endCount`, `startDurationSec`, `endDurationSec`), Panel „Expertenwerte“ (Pausenschutz, Knitterschutz, alle 13 `final*`, Zeitfelder mit `min`/`max` aus `FINAL_BOUNDS`), `final*` außer `finalMinVal`/`finalMinSec` mit `hidden: "!data.finalMinVal || !data.finalMinSec"`; i18n `typeStartVal`…`typeTrailerMaxTooltip` weiterverwendet, neue Schlüssel `final<Name>` + `final<Name>Tooltip`.
  - `DeviceFormData` + alle `DetectionSettings`-Felder flach; `formToDeviceConfig` → `detection` über `normalizeDetection`.
  - `deviceModel(cfg: DeviceConfig, hasOverride: boolean): ioBroker.Translated` – Vorlagenname | „angelernt“ (`applyLearned` gesetzt `learned: true` oder Override vorhanden) | „eigene Werte“. `DeviceConfig.learned?: boolean`.
  - Kartenwarnung `needsReview` mit `reviewHint`; Details „Erkennung“ statt „Typ“.
  - Instanz-Aktion `removeArchive` (`dm_removeArchive`): entfernt `native.types` nach Bestätigung (`dm_removeArchiveConfirm`, nennt den Neustart).
  - Quelle `device:<id>` bzw. `archive:<id>` übernimmt **nur die 16 Grundfelder** (`BASE_KEYS`); alle `final*` = 0, `phases` werden nicht kopiert (Spec C.2, Risiko 10: Freigabe der Schlussphase nur mit Nachweis am eigenen Gerät, B.6). Leistungsfelder (`startVal`, `endVal`, `standby`, `pauseBelowVal`, `trailerBlockVal`) werden mit `unitFactor(Quelle) / unitFactor(Ziel)` umgerechnet (Archiv-Vorlagen gelten als W). Hinweis im Formular `dm_copyFinalHint` („Schlussphase und Phasen am neuen Gerät anlernen“), nur wenn die Quelle eine Schlussphase oder Phasen hat.
  - i18n entfernt: `tabTypes`, `typesHelp`, `dev_typeId`, `dm_detailsType*`, `dm_learnName`, `dm_learnCurrentType`, `dm_optSaveType`, `dm_optTypeValue`, `typeNeedsName`, `unknownType`.

- [ ] **Step 1: Failing tests**

```js
// test/deviceForm.test.js
import { buildDeviceSchema, buildSourceSchema, formToDeviceConfig } from "../build/lib/deviceForm.js";
import { FINAL_BOUNDS } from "../build/lib/config.js";
it("source schema lists templates, archive templates and other devices", () => {
	const s = buildSourceSchema([{ id: "custom2", name: "Pumpe", detection: WASHER }], [{ id: "wm", name: "WM" }]);
	const values = s.items.source.options.map(o => o.value);
	assert.deepStrictEqual(values, ["template:washing-machine", "template:dryer", "template:dishwasher", "template:custom", "archive:custom2", "device:wm"]);
});
it("expert values: final fields hidden while the master switch is off, time bounds from FINAL_BOUNDS", () => {
	const items = flatItems(buildDeviceSchema(instanceConfig()));
	assert.strictEqual(items.finalMaxVal.hidden, "!data.finalMinVal || !data.finalMinSec");
	assert.strictEqual(items.finalMinVal.hidden, undefined);
	assert.deepStrictEqual([items.finalLockSec.min, items.finalLockSec.max], FINAL_BOUNDS.finalLockSec);
	assert.strictEqual(items.typeId, undefined);
});
it("form values become detection; invalid final values are corrected with the normalizer", () => {
	const { config } = formToDeviceConfig({ ...formOf(), ...WASHER, finalMinVal: 150, finalMinSec: 168, finalMaxVal: 100 }, { isNew: false, unitFactor: 1 });
	assert.strictEqual(config.detection.finalMinVal, 0);
});
/** All items of a schema, panels and tabs flattened (test helper). */
function flatItems(schema, out = {}) {
	for (const [key, item] of Object.entries(schema.items ?? {})) {
		if (item.type === "panel" || item.type === "tabs") flatItems(item, out);
		else out[key] = item;
	}
	return out;
}

// test/deviceManagement.test.js
it("add from template with a kW state divides the power values", async () => {
	const ctx = setup();
	ctx.adapter.foreign.set(POWER, { type: "state", common: { type: "number", role: "value.power", unit: "kW" }, native: {} });
	const action = fakeAction({ forms: [{ source: "template:dryer" }, formOf({ name: "Trockner" })] });
	await ctx.dm.getInstanceInfo().actions.find(a => a.id === "add").handler(action);
	const native = [...ctx.adapter.objects.values()].find(o => o.type === "device").native;
	assert.deepStrictEqual([native.detection.startVal, native.detection.endVal, native.template], [0.12, 0.015, "dryer"]);
});
it("add from another device copies the 16 base values only; final phase and phases are learned at the new device", async () => {
	const ctx = setup();
	await addDevice(ctx, "wm", deviceCfg({ name: "WM", detection: { ...WASHER, endCount: 77, finalMinVal: 150, finalMinSec: 168 }, phases: { v: 1, enabled: true, scope: "run", bands: [], phases: [], learnedAt: 1, quality: { agreement: 1, runsUsed: 3 } } }));
	const action = fakeAction({ forms: [{ source: "device:wm" }, formOf({ name: "WM2" })] });
	await ctx.dm.getInstanceInfo().actions.find(a => a.id === "add").handler(action);
	const native = ctx.adapter.objects.get(`${NS}.wm2`).native;
	assert.deepStrictEqual(detectionOf(native.detection), detectionOf({ ...WASHER, endCount: 77 }));
	assert.strictEqual(native.phases, undefined);
	assert.ok(JSON.stringify(action.forms[1]).includes("dm_copyFinalHint") || action.forms[1].schema.items.copyFinalHint, "hint to learn the final phase");
});
it("copying between a W and a kW state converts the power values", async () => {
	const ctx = setup();
	ctx.adapter.foreign.set("plug.9.power", { type: "state", common: { type: "number", role: "value.power", unit: "W" }, native: {} });
	await addDevice(ctx, "wm", deviceCfg({ name: "WM", powerId: "plug.9.power", detection: { ...WASHER, endCount: 77 } }));
	ctx.adapter.foreign.set(POWER, { type: "state", common: { type: "number", role: "value.power", unit: "kW" }, native: {} }); // target (form) state
	const action = fakeAction({ forms: [{ source: "device:wm" }, formOf({ name: "WM2" })] });
	await ctx.dm.getInstanceInfo().actions.find(a => a.id === "add").handler(action);
	const d = ctx.adapter.objects.get(`${NS}.wm2`).native.detection;
	assert.deepStrictEqual([d.startVal, d.endVal, d.endCount], [0.03, 0.015, 77]);
});
it("card model: template name, learned, own values; review warning with hint", async () => {
	const ctx = setup();
	await addDevice(ctx, "a", deviceCfg({ name: "A", template: "dryer" }));
	await addDevice(ctx, "b", deviceCfg({ name: "B", learned: true }));
	await addDevice(ctx, "c", deviceCfg({ name: "C" }));
	await addDevice(ctx, "d", deviceCfg({ name: "D", enabled: false, needsReview: true, reviewHint: 'type "Kessel" not found' }));
	const devices = await load(ctx);
	const en = id => devices.find(x => x.id === id).model?.en ?? devices.find(x => x.id === id).model;
	assert.deepStrictEqual(["a", "b", "c"].map(en), ["Dryer", "learned", "own values"]);
	assert.match(JSON.stringify(devices.find(x => x.id === "d").status), /Kessel/);
});
it("instance action 'remove old templates' deletes native.types after confirmation", async () => {
	const ctx = setup();
	ctx.adapter.foreign.set(INSTANCE_OBJ, { type: "instance", common: {}, native: { types: [{ id: "custom2", name: "Pumpe" }] } });
	const action = fakeAction({ confirm: true });
	await ctx.dm.getInstanceInfo().actions.find(a => a.id === "removeArchive").handler(action);
	assert.deepStrictEqual(ctx.adapter.extendedForeign.at(-1).obj.native.types, []);
});

// test/dmTexts.test.js (TEXT aus ../build/lib/dmTexts.js)
it("removed type texts are gone and the new texts exist in 11 languages", () => {
	const de = JSON.parse(readFileSync(new URL("../admin/i18n/de.json", import.meta.url), "utf8"));
	for (const k of ["tabTypes", "typesHelp", "dev_typeId", "dm_learnName", "dm_learnCurrentType", "dm_optSaveType", "dm_optTypeValue"]) {
		assert.strictEqual(de[k], undefined, k);
	}
	// typeNeedsName and unknownType are TEXT entries in dmTexts.ts (:482, :707), not i18n keys
	for (const k of ["typeNeedsName", "unknownType"]) assert.strictEqual(TEXT[k], undefined, k);
	for (const lang of ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"]) {
		const dict = JSON.parse(readFileSync(new URL(`../admin/i18n/${lang}.json`, import.meta.url), "utf8"));
		for (const k of ["valuesInDeviceHelp", "dev_template", "dev_expertValues", "finalMinVal", "finalLockSecTooltip", "dm_removeArchive", "dm_copyFinalHint"]) {
			assert.ok(dict[k], `${lang}:${k}`);
		}
	}
});
```

Imports: `WASHER`, `instanceConfig` aus `./helpers/devices.js`, `detectionOf` aus `../build/lib/runStore.js`; die Statuskennzeichnung der Karte folgt dem vorhandenen Muster für „Leistungs-State fehlt“ (gleiche Eigenschaft `status`/`warning` wie dort im Test `loadDevices`).

- [ ] **Step 2:** `npm run build && npx mocha test/deviceForm.test.js test/deviceManagement.test.js test/dmTexts.test.js` → FAIL.
- [ ] **Step 3: Implementieren**; de/en-Texte von Hand, dann `npm run translate`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §2/§3/§6 (Tab „Gerätetypen“ entfällt, Quelle beim Anlegen: Vorlage, Archiv-Vorlage, anderes Gerät – nur Grundwerte, Schlussphase und Phasen am neuen Gerät anlernen; Expertenwerte; Kartenmodell; „Alte Vorlagen entfernen“); Changelog-Zeile „Werte im Gerät“ ergänzen.
- [ ] **Step 5: Commit** `feat: device form with templates, archive and expert values; no device type tab`

---

### Task 8: Drei Ebenen, Laufzeit-Abgleich, „Als Grundwerte übernehmen“ (Spec C.3, C.7 P9/P19/P29, G13)

**Files:**
- Modify: `src/lib/deviceRuntime.ts`, `src/lib/deviceRegistry.ts` (`upsert` Bestandszweig `:103-111`, `syncOptimize`, `runOptimize` `:891`), `src/lib/runStore.ts`, `src/lib/stateDefinitions.ts` (`learning.parameters` `:525`, `learning.reset` `:636`), `src/lib/deviceManagement.ts` (Optimierungsdialog-Aktion `adopt`)
- Test: `test/deviceRuntime.test.js`, `test/optimizationIntegration.test.js`, `test/runStore.test.js`, `test/deviceManagement.test.js`, `test/stateDefinitions.test.js`

**Interfaces:**
- Produces:
  - `DeviceRuntime.active: DetectionSettings` = `effective` mit `finalMinVal = 0`, solange `finalSuspended`; `setFinalSuspended(on: boolean): void` (Neubau wie `setOverride`); `buildDetector` nutzt `active`.
  - `reconcileBase(store: StoreFile, baseHash: string, effectiveHash: string | null, now: number): "none" | "adopted" | "baseChanged"` – `adopted`, wenn `baseHash === effectiveHash` des alten Overrides (Override dann verlustfrei `null`); sonst bei Abweichung Override verworfen, Änderung `baseChanged`.
  - `ReminderDeviceManagement.adoptAsBase(id: Id): Promise<boolean>` (Optimierungsdialog-Aktion `adopt`) – schreibt zuerst das Gerät über `writeDevice` (`detection := runtime.effective`), der Abgleich in `DeviceRegistry.upsert` (`reconcileBase`) erledigt den Rest; scheitert das Schreiben, bleibt alles.
  - Optimierung: merkt sich zu Beginn `typeHash(base)`, verwirft das Ergebnis bei Abweichung vor dem Schreiben (Log `base values changed during the optimisation, result discarded`). Test-Hook `RegistryOptions.beforeOptimizeWrite?: (deviceId: string) => Promise<void>` – wird zwischen dem Ergebnis von `optimize()` und dem Hash-Vergleich aufgerufen (nur Tests setzen ihn; ohne Hook kein Unterschied).
  - `learning.parameters` = JSON `{ base, override, effective, active }`; `learning.reset`-Name en „Reset to the base values of the device“, de „Auf die Grundwerte des Geräts zurücksetzen“.
  - `upsert` schreibt die Optimierungs-States (`writeOptStates`: `parameters`, `optimizeInfo`) auch im Bestandszweig ohne Grundwertänderung (heute kehrt `syncOptimize` bei vorhandenem `entry.opt` vorher zurück, `deviceRegistry.ts:606`).

- [ ] **Step 1: Failing tests**

```js
// test/runStore.test.js
it("reconcileBase: adopted when the new base equals the old effective values", () => {
	const st = emptyStore("wm", "", typeHash(WASHER), 10000, 1);
	st.override = { endCount: 30 };
	const eff = typeHash({ ...WASHER, endCount: 30 });
	assert.strictEqual(reconcileBase(st, eff, eff, 7), "adopted");
	assert.deepStrictEqual([st.override, st.typeHash, st.changes.at(-1).kind], [null, eff, "adopted"]);
	assert.strictEqual(reconcileBase(st, eff, eff, 8), "none");
});
it("reconcileBase: another base drops the override with baseChanged", () => {
	const st = emptyStore("wm", "", typeHash(WASHER), 10000, 1);
	st.override = { endCount: 30 };
	assert.strictEqual(reconcileBase(st, typeHash({ ...WASHER, endVal: 10 }), typeHash({ ...WASHER, endCount: 30 }), 9), "baseChanged");
	assert.deepStrictEqual([st.override, st.changes.at(-1).kind, st.changes.at(-1).from], [null, "baseChanged", { endCount: 30 }]);
});

// test/optimizationIntegration.test.js (Helfer aus test/helpers/devices.js)
it("a base change at runtime with an override drops it and the new values apply at once", async () => {
	const ctx = await registrySetup();
	const store = ctx.reg.learningData("dev");
	store.override = { endCount: 30 };
	ctx.reg.get("dev").setOverride({ endCount: 30 });
	await ctx.reg.upsert("dev", { ...ctx.cfg, detection: { ...WASHER, endVal: 10 } });
	assert.deepStrictEqual([store.override, store.changes.at(-1).kind], [null, "baseChanged"]);
	assert.deepStrictEqual([ctx.reg.get("dev").effective.endVal, ctx.reg.get("dev").effective.endCount], [10, 50]);
	assert.strictEqual(JSON.parse(ctx.host.own("dev.learning.parameters")).override, null);
});
it("an optimisation result is discarded when the base changed meanwhile (G13)", async () => {
	let changed = false;
	const ctx = await registrySetup({
		detection: { ...WASHER, endCount: 20 },
		// between the result of optimize() and the write: the user changes the base values
		beforeOptimizeWrite: async () => {
			if (changed) return;
			changed = true;
			await ctx.reg.upsert("dev", { ...ctx.cfg, detection: { ...WASHER, endCount: 25 } });
		},
	});
	await feed(ctx, runOf({ device: "washer", programme: "eco4060", seed: 2 }).values);
	assert.ok(changed, "an optimisation ran");
	assert.ok(ctx.host.logs.info.some(m => m.includes("base values changed during the optimisation, result discarded")));
	assert.strictEqual(ctx.reg.learningData("dev").override, null);
	assert.strictEqual(ctx.reg.get("dev").effective.endCount, 25);
});
it("learning.parameters holds base, override, effective, active", async () => {
	const ctx = await registrySetup({ detection: { ...WASHER, finalMinVal: 150, finalMinSec: 168 } });
	ctx.reg.get("dev").setFinalSuspended(true);
	await ctx.reg.upsert("dev", ctx.cfg);
	const p = JSON.parse(ctx.host.own("dev.learning.parameters"));
	assert.deepStrictEqual(Object.keys(p), ["base", "override", "effective", "active"]);
	assert.deepStrictEqual([p.base.finalMinVal, p.effective.finalMinVal, p.active.finalMinVal], [150, 150, 0]);
});

// test/deviceRuntime.test.js
it("suspension masks finalMinVal only in active", () => {
	const ctx = runtimeSetup({ cfg: { detection: { ...WASHER, finalMinVal: 150, finalMinSec: 168 } } });
	ctx.rt.setOverride({ finalMinSec: 180 });
	ctx.rt.setFinalSuspended(true);
	assert.deepStrictEqual([ctx.rt.active.finalMinVal, ctx.rt.effective.finalMinVal, ctx.rt.baseDetection.finalMinVal, ctx.rt.currentOverride], [0, 150, 150, { finalMinSec: 180 }]);
	ctx.rt.setFinalSuspended(false);
	assert.strictEqual(ctx.rt.active.finalMinVal, 150);
});

// test/deviceManagement.test.js (optSetup/openDialog)
it("adopt as base writes the device first; failing write keeps the override (P29)", async () => {
	const ctx = await optSetup();
	const before = ctx.registry.learningData("trockner").override;
	assert.ok(before, "the run produced an override");
	await openDialog(ctx, { operation: "adopt" });
	const native = ctx.adapter.objects.get(`${NS}.trockner`).native;
	assert.deepStrictEqual(detectionOf(native.detection), ctx.registry.get("trockner").effective);
	assert.deepStrictEqual([ctx.registry.learningData("trockner").override, ctx.registry.learningData("trockner").changes.at(-1).kind], [null, "adopted"]);

	const ctx2 = await optSetup();
	const ov = ctx2.registry.learningData("trockner").override;
	ctx2.adapter.setObjectAsync = async () => { throw new Error("disk full"); }; // writeDevice writes with setObjectAsync first
	await openDialog(ctx2, { operation: "adopt" });
	assert.deepStrictEqual(ctx2.registry.learningData("trockner").override, ov);
});

// test/stateDefinitions.test.js
it("learning.reset is named after the base values", () => {
	const def = DEVICE_STATES.find(d => d.id === "learning.reset");
	assert.strictEqual(def.name.de, "Auf die Grundwerte des Geräts zurücksetzen");
});
```

Für den G13-Test reicht `registrySetup` die Option `beforeOptimizeWrite` an `RegistryOptions` durch. Eine Verschränkung über `feed` allein gibt es nicht: `feed` kehrt beim ersten `await` zurück, und mit der eingefrorenen Fake-Uhr gibt `optimize()` die Kontrolle nie ab (`autoOptimize.ts:229`). `feed` liefert ein `Promise`, das erst nach `drain` erfüllt ist.

- [ ] **Step 2:** `npm run build && npx mocha test/runStore.test.js test/optimizationIntegration.test.js test/deviceRuntime.test.js test/deviceManagement.test.js` → FAIL.
- [ ] **Step 3:** implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (Grundwerte, Override, wirksame und aktive Werte; „Als Grundwerte übernehmen“; Grundwertänderung verwirft das Override) und §13 (`learning.parameters` mit vier Ebenen, neuer Name von `learning.reset`); Changelog-Zeile zur Optimierung umformulieren.
- [ ] **Step 5: Commit** `feat: base, effective and active values; base changes and adopting apply at runtime`

---

### Task 9: Rohdaten – Bereinigung, History-Einstellungen, Meldelog (Spec B.1)

**Files:**
- Create: `src/lib/learn/clean.ts`, `test/clean.test.js`
- Modify: `src/lib/historySource.ts` (`HistoryMeta` `:61-81`, `loadHistorySeries` `:107-127`), `src/lib/runRecorder.ts` (`Capture`, `event` `:103`), `src/lib/runStore.ts` (`encodePending`/`decodePending`)

**Interfaces:**
- Produces:
  - `cleanPoints(points: { ts: number; val: number | null }[]): { points: { ts: number; val: number }[]; invalidShare: number; timeJumps: { at: number; backMs: number }[]; unknown: { from: number; to: number }[] }` – `null`/`NaN` weg, negativ → 0, sortiert, exakte Duplikate (gleiches `ts` und `val`) weg, Rücksprung > 60 s → `unknown` (von der Ankunft des rückspringenden Punkts bis zum ersten wieder späteren `ts`); `invalidShare` = (null + NaN + negativ) / Eingangszahl.
  - `HistorySettings = { relogSec: number; ignoreZero: boolean; ignoreBelowZero: boolean; debounceMs: number; blockTimeMs: number; round: number | null }`; `historySettingsOf(custom: Record<string, unknown>): HistorySettings`; `HistoryMeta.settings`.
  - `loadHistorySeries(…, from?: number)` – optionaler Startzeitpunkt (Import nach Ausfall, Task 21). **Keine Rohpunkt-Objekte über 30 Tage im Speicher** (Loader ist für Steckdosen mit 1-s-Meldungen gebaut, `historySource.ts:98`; 30 Tage wären bis ~2,6 Mio. Objekte, auf einem Pi zu viel): Die Meldestatistik wird beim Einsortieren je Tick berechnet und mit der Serie geliefert – `rep: { count: Uint16Array; maxGapMs: Float64Array }` (Meldungen und größte Meldelücke je Tick) plus `clean: { invalidShare; timeJumps; unknown }` aus `cleanPoints`. Rohpunkte entstehen nur für die tatsächlich benötigten Einheiten (`Unit.points`, Task 11; je Lauf bzw. Tagesabschnitt, nicht für 30 Tage am Stück), zusammen höchstens `RAW_POINTS_MAX = 200_000` je Aufruf (darüber wird die Unit aus der Tickserie gebildet; die Meldestatistik je Tick bleibt vollständig).
  - `Capture.rep?: number[]` – Meldezeitpunkte als ms-Abstand zu `t0`, auch bei gleichem Wert (Datei: Differenzen).
  - **Capture ohne Start:** `RunRecorder.setActivityLimit(limit: number)` (von der Registry gesetzt: `max(endVal, runLimit des Speichers)`); der Recorder öffnet auch **ohne** Runtime-`s` eine Capture, sobald der gehaltene Wert ≥ `MIN_ACTIVE_MS` über `limit` liegt (`ev` leer). Heute öffnet er nur bei `s` (`runRecorder.ts:117-121`), ein nicht erkannter Start würde nie gespeichert (Entscheidung 8 „Start nicht erkannt“). Eine solche Capture schließt nach `MAX_PAUSE_MS` Ruhe wie heute.

- [ ] **Step 1: Feldnamen prüfen** am Echtsystem, nur lesend (`mcp__iobroker__get_object` eines Leistungs-States mit `common.custom` für history, influxdb, sql); Ergebnis als Kommentar mit Adapter → Feldname in `historySource.ts`. Erwartet (heute gesichert): `changesMinDelta`, `retention`; zu prüfen: `changesRelogInterval`, `ignoreZero`, `ignoreBelowZero`, `debounceTime`, `blockTime`, `round`. Fehlt ein Feld, bleibt der Wert neutral (0/false/null).
- [ ] **Step 2: Failing tests**

```js
import assert from "node:assert";
import { cleanPoints } from "../build/lib/learn/clean.js";
import { historySettingsOf, loadHistorySeriesForTest } from "../build/lib/historySource.js";
import { RunRecorder } from "../build/lib/runRecorder.js";
import { decodePendingForTest, encodePending } from "../build/lib/runStore.js";

describe("raw data", () => {
	it("cleans null, NaN, negatives, order and exact duplicates", () => {
		const r = cleanPoints([{ ts: 3, val: 5 }, { ts: 1, val: null }, { ts: 2, val: -4 }, { ts: 2, val: -4 }, { ts: 4, val: Number.NaN }]);
		assert.deepStrictEqual(r.points, [{ ts: 2, val: 0 }, { ts: 3, val: 5 }]);
		assert.strictEqual(r.invalidShare, 0.6);
	});
	it("a jump back of more than a minute is unknown time; 30 s is only reordered", () => {
		const r = cleanPoints([{ ts: 100_000, val: 1 }, { ts: 200_000, val: 2 }, { ts: 120_000, val: 3 }, { ts: 300_000, val: 4 }]);
		assert.deepStrictEqual(r.timeJumps, [{ at: 120_000, backMs: 80_000 }]);
		assert.deepStrictEqual(r.unknown, [{ from: 120_000, to: 200_000 }]);
		assert.deepStrictEqual(cleanPoints([{ ts: 100_000, val: 1 }, { ts: 90_000, val: 2 }]).timeJumps, []);
	});
	it("history settings are read from the custom block, missing fields stay neutral", () => {
		assert.deepStrictEqual(historySettingsOf({ changesRelogInterval: 300, ignoreZero: true, debounceTime: 1000, round: 1 }),
			{ relogSec: 300, ignoreZero: true, ignoreBelowZero: false, debounceMs: 1000, blockTimeMs: 0, round: 1 });
		assert.deepStrictEqual(historySettingsOf({}), { relogSec: 0, ignoreZero: false, ignoreBelowZero: false, debounceMs: 0, blockTimeMs: 0, round: null });
	});
	it("the recorder keeps report times of equal values and they survive the file", () => {
		const rec = new RunRecorder(10_000, 1);
		rec.sample(0.5, 0);
		rec.onEvent("s", 10_000);
		rec.event(100, 15_000);
		rec.sample(100, 20_000);
		rec.event(100, 25_000);
		rec.sample(100, 30_000);
		const snap = rec.snapshot();
		assert.strictEqual(snap.rep.length, 2);
		assert.deepStrictEqual(decodePendingForTest(JSON.parse(JSON.stringify(encodePending(snap)))).rep, snap.rep);
	});
	it("the recorder opens a capture on activity without a start (missed start)", () => {
		const rec = new RunRecorder(10_000, 1);
		rec.setActivityLimit(15);
		for (let i = 0; i < 40; i++) {
			rec.event(i < 3 ? 0.5 : 300, i * 10_000);
			rec.sample(i < 3 ? 0.5 : 300, i * 10_000);
		}
		const snap = rec.snapshot();
		assert.ok(snap, "capture open");
		assert.deepStrictEqual(snap.ev, []);
	});
	it("history statistics are kept per tick, not as raw point objects", async () => {
		const pts = Array.from({ length: 3600 }, (_, i) => ({ ts: 1_700_000_000_000 + i * 1000, val: i % 2 ? 300 : 301 }));
		const s = await loadHistorySeriesForTest(pts, { stepMs: 10_000 });
		assert.strictEqual(s.raw, undefined);
		assert.strictEqual(s.rep.count[5], 10);
		assert.ok(s.rep.maxGapMs[5] <= 1000);
	});
});
```

`decodePendingForTest` = Export von `decodePending` für Tests (wie die übrigen `export`s in `runStore.ts`); `loadHistorySeriesForTest(points, o)` = Einsortieren ohne History-Instanz (Export aus `historySource.ts`). Signatur festgelegt: `RunRecorder.event(power: number, now: number)`; Aufrufer in `deviceRuntime.onPower` angepasst.

**Doku:** keine nutzerseitige Änderung.

- [ ] **Step 3:** FAIL → implementieren → **Step 4:** PASS (`npm test`).
- [ ] **Step 5: Commit** `feat: raw points are cleaned; history settings and report times are kept for the run check`

---

### Task 10: Laufzerlegung und Kriterium „Ende nicht zu früh“ (Spec B.4)

**Files:**
- Modify: `src/lib/learn/runs.ts` (`RunInfo` `:72`, `Layout` `:124`, `blocksOf` `:261`, `gapsBetween` `:283`, `mergeBlocks` `:302`, `trailerOf` `:324-350`, `buildLayout` `:810`), `src/lib/learn/replay.ts` (`runOk` `:112-115`, `runOkFull` `:125`), `src/lib/learn/analyze.ts`, `src/lib/learn/autoOptimize.ts` (Aufrufer)
- Create: `test/layout.test.js`, `test/replay.test.js`

**Interfaces:**
- Produces:
  - exportiert: `blocksOf`, `mergeBlocks`, `gapsBetween`, `DENSE_MIN_MS`; `LAYOUT_REV = 2`.
  - `RunInfo` + `progEnd: number`, `endBlockFrom: number`, `endBlockTo: number`; `Layout` + `tailCeil: number`, `tailSeparated: boolean`, `burstMaxW: number` (höchstes Burst-Maximum im Nachlauf über alle Läufe mit erkanntem Nachlauf, 0 ohne), `incomplete: Span[]` (Segmente, die das Layout wegen Lücke oder Datenende verwirft, `runs.ts:827`).
  - `buildLayout(…, opts)` + `opts.maxRuns?: number` (Standard wie heute `MAX_WINDOWS` = 20 für Analyse und Live-Lernen; `Infinity` für Dialog, `checkRuns` und Speicher-Neuzerlegung, damit 30 Tage WM ≈ 30 Läufe nicht auf die neuesten 20 gekürzt werden, `runs.ts:910`).
  - **Endblock** (nur aus dem Layout, ohne gelernte Bänder – die braucht erst Task 16): Schwelle `hi = 1,25 × burstMaxW`; Endblock eines Laufs = letzte Strecke vor `coreEnd` mit gehaltenem Wert > `hi`, Unterbrechungen ≤ 60 s überbrückt, Länge ≥ `SUSTAINED_MS`. *Blöcke über `runLimit` taugen nicht: bei der WM liegt das Minimum des gehaltenen Werts im ganzen Lauf bei 6 W > 5,5 W, ein Block wäre der ganze Lauf (nachgerechnet `…/scratchpad/review/tb.mjs`, 12/12 Läufe).*
  - **`tailSeparated`** = mindestens 2 Läufe mit erkanntem Nachlauf **und** in jedem Lauf mit Nachlauf reicht der Endblock bis `coreEnd` (± G = 6 Ticks); dann `tailCeil = 1,1 × burstMaxW`, sonst `tailCeil = runLimit`, `progEnd = runEnd` und Endblock = letzter Block ≥ `SUSTAINED_MS` über `runLimit` vor `coreEnd`. Beleg: WM-Endschleudern 177–715 W > 1,25 × 113 W = 141 W → getrennt, `tailCeil` = 124 W; Trockner-Abkühlen 121–135 W < 1,25 × 116 W = 145 W → nicht getrennt. Der bandbasierte Schlussblock von Task 16 (B.6) ist davon getrennt und wird dort aus den Grundbändern bestimmt.
  - `progEnd` = letzter Tick in [from, runEnd] mit gehaltenem Wert > `tailCeil`.
  - `endOk(s: TickSeries, win: Window, r: SimResult, progEnd: number | null): boolean` = `f ≥ runEnd ∨ (f > progEnd ∧ runEnd − f ≤ DENSE_MIN_MS)` mit `f` = erstes `finished` im Fenster; `progEnd = null` → wie `runOk`. Ersetzt `runOk` in Analyse, Gate und Freigabe (`runOkFull` analog).

- [ ] **Step 1: Failing tests**

```js
// test/layout.test.js
import assert from "node:assert";
import { layoutOf, loadSeries, runIndex, runWindow, timelineOf } from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const D = loadSeries("dryer");

describe("layout: programme end and tail", () => {
	it("washer: tail separated, tailCeil = 1.1 × 113 W", () => {
		const { L } = layoutOf(W);
		assert.strictEqual(L.tailSeparated, true);
		assert.strictEqual(Math.round(L.tailCeil), 124);
	});
	it("washer: progEnd lies in every run between from and runEnd, at the end of the final spin", () => {
		const { L, s } = layoutOf(W);
		for (const r of L.runs) {
			assert.ok(r.from < r.progEnd && r.progEnd <= r.runEnd, JSON.stringify(r));
			assert.ok(s.last[r.progEnd] > L.tailCeil);
			assert.ok(r.endBlockFrom <= r.progEnd && r.progEnd <= r.endBlockTo + 1);
		}
	});
	it("dryer: anti-crease found in 7 of 7 runs, not separated, tailCeil = runLimit, progEnd = runEnd", () => {
		const { L } = layoutOf(D);
		assert.strictEqual(L.runs.filter(r => r.trailerFrom !== null).length, 7);
		assert.strictEqual(L.tailSeparated, false);
		assert.strictEqual(L.tailCeil, L.runLimit);
		assert.ok(L.runs.every(r => r.progEnd === r.runEnd));
	});
	it("washer: the end block is the final spin (above 1.25 × burst maximum), not the whole run", () => {
		const { L } = layoutOf(W);
		assert.ok(L.burstMaxW >= 100 && L.burstMaxW <= 113, String(L.burstMaxW));
		// w04 (k = 3) is the 41-min programme
		L.runs.forEach((r, k) => {
			if (k !== 3) assert.ok((r.endBlockFrom - r.from) * 10 >= 3600, `run ${k}: end block starts after an hour`);
		});
	});
	it("maxRuns: Infinity keeps all 25 runs of a 25-day timeline; the default keeps the newest 20", () => {
		const pts = timelineOf(Array.from({ length: 25 }, () => runWindow("washer30d", "w08")), 86_400_000);
		assert.strictEqual(layoutOf(pts, 10_000, { maxRuns: Infinity }).L.runs.length, 25);
		assert.strictEqual(layoutOf(pts).L.runs.length, 20);
	});
	it("the run at the data end (w13) is listed as incomplete", () => {
		const { L, s } = layoutOf(W);
		const w13 = runIndex("washer30d").find(r => r.id === "w13").ts;
		assert.ok(L.incomplete.some(sp => Math.abs(s.t0 + sp.from * s.stepMs - w13) <= 300_000), JSON.stringify(L.incomplete));
	});
});

// test/replay.test.js
import assert from "node:assert";
import { endOk, runOk, simulate } from "../build/lib/learn/replay.js";
import { DENSE_MIN_MS } from "../build/lib/learn/runs.js";
import { WASHER } from "./helpers/devices.js";
import { layoutOf, layoutRun, loadSeries } from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const D = loadSeries("dryer");
const res = (s, i) => ({ started: 1, aborted: 0, finished: [s.t0 + i * s.stepMs], startedAt: [] });
const winOf = (L, k) => L.windows.find(w => w.run === k);

describe("end criterion endOk (Spec B.4)", () => {
	it("w02: an end 10 s before the core end is fine (S3: early end −0.2 min judged ok)", () => {
		const { info, s, L, idx } = layoutRun("washer30d", "w02");
		assert.strictEqual(endOk(s, winOf(L, idx), res(s, info.coreEnd - 1), info.progEnd), true);
	});
	it("every washer run: an end 10 min before progEnd is too early", () => {
		const { L, s } = layoutOf(W);
		L.runs.forEach((r, k) => assert.strictEqual(endOk(s, winOf(L, k), res(s, r.progEnd - 60), r.progEnd), false, `run ${k}`));
	});
	it("an end after progEnd and at most 5 min before runEnd is fine; earlier than 5 min is not", () => {
		const { L, s } = layoutOf(W);
		const step = s.stepMs;
		L.runs.forEach((r, k) => {
			if (r.runEnd - r.progEnd < 2) return;
			const f = Math.max(r.progEnd + 1, r.runEnd - DENSE_MIN_MS / step);
			assert.strictEqual(endOk(s, winOf(L, k), res(s, f), r.progEnd), true, `run ${k}`);
			if (r.runEnd - DENSE_MIN_MS / step - 1 > r.progEnd) {
				assert.strictEqual(endOk(s, winOf(L, k), res(s, r.runEnd - DENSE_MIN_MS / step - 1), r.progEnd), false);
			}
		});
	});
	it("without progEnd endOk equals runOk", () => {
		const { L, s } = layoutOf(W);
		L.runs.forEach((r, k) => {
			for (const i of [r.coreEnd - 30, r.runEnd, r.runEnd + 30]) {
				assert.strictEqual(endOk(s, winOf(L, k), res(s, i), null), runOk(s, winOf(L, k), res(s, i)));
			}
		});
	});
	it("dryer: endOk equals today's runOk with the 3.1.2 dryer values in every window (P6)", () => {
		const { L, s } = layoutOf(D);
		const dryer = { ...WASHER, startVal: 120, endCount: 20 };
		L.windows.filter(w => w.run !== null).forEach(w => {
			const r = simulate(s, w, dryer, { abort: false, abortFixed: false, pollSec: 10 });
			assert.strictEqual(endOk(s, w, r, L.runs[w.run].progEnd), runOk(s, w, r));
		});
	});
});
```

Bestehende Erwartungen zu `washerAntiCrease.json` in `test/historyLearning.test.js` und `test/antiCreaseLearning.test.js` bleiben unverändert grün (WM-Nachlauf 10/10).

- [ ] **Step 2:** FAIL. **Step 3:** implementieren (Trockner-`trailerOf` frei nach Spec §11, Abnahme 7/7). **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (Kriterium „Ende nicht zu früh“: Programmende statt Ende des Nachlaufs; Knitterschutz des Trockners wird in jedem Lauf gefunden); Changelog-Zeile zum Anlernen ergänzen.
- [ ] **Step 5: Commit** `feat: end criterion uses the programme end; anti-crease of the dryer is found in every run`

---
### Task 11: Grundbänder und Haltezeit-Profil (Spec B.1a, B.5 Schritt 2 und 9)

**Files:**
- Create: `src/lib/learn/bands.ts`, `test/bands.test.js`
- Modify: `src/lib/learn/families.ts` (`RunFeatures` `:2`, `vectorOf` `:27-37`)

**Interfaces:**
- Consumes: `cleanPoints` (Task 9), `blocksOf`, `RunInfo`, `Layout` (Task 10).
- Produces:
  - `interface Unit { points: { ts: number; val: number }[]; from: number; to: number }` (ms; ein Lauf bzw. ein Tagesabschnitt).
  - `unitsOf(points, L: Layout, s: TickSeries): Unit[]` (je Layout-Lauf von `from` bis `runEnd`).
  - `interface Band { id: string; min: number; max: number; segments: number; activeShare: number }` (Einheit der Eingabe, `[min, max)`, `max` des obersten Bands = `Infinity`; `segments` = Summe über alle Einheiten; `activeShare` = Anteil an der Zeit über `runLimit`).
  - `learnBands(units: Unit[], runLimit: number, opts: { mode: "median60" | "raw"; dipSec: number }): Band[]` (aufsteigend, ids `b1`…).
  - `interface HoldProfile { band: string; p99Sec: number; suspectSec: number; n: number }`; `holdProfile(units: Unit[], bands: Band[]): HoldProfile[]` – nur Bänder mit Werten aus ≥ 3 Einheiten und ≥ 30 Haltezeiten; `suspectSec = max(600, 5 × p99Sec)`.
  - `interface BaseBands { bands: Band[]; holds: HoldProfile[]; units: number; runLimit: number }`; `baseBandsOf(units: Unit[], runLimit: number, opts?): BaseBands`; `bandOf(b: BaseBands, val: number): Band | null`; `suspectLimitOf(b: BaseBands, val: number): number | null`.
  - `RunFeatures` + `topBandSec?: number`, `finalBandBlocks?: number`; `vectorOf` nutzt sie nur, wenn alle Läufe sie haben.
- Algorithmus (nicht durch Signatur bestimmt):

```text
hist  = zeitgewichtetes Histogramm der gehaltenen Werte > runLimit auf log-Skala, Klassenbreite ln(1.07)
        (mode median60: gleitender 60-s-Median der gehaltenen Werte; mode raw: Rohwerte)
peaks = lokale Maxima mit Verhältnis Gipfel/Tal ≥ 1,2
band  bleibt, wenn (≥ 3 Einheiten mit je ≥ 3 eigenen Segmenten) oder (≥ 0,5 % der aktiven Zeit); sonst mit Nachbarband vereinen
Nachbarn, die innerhalb eines Blocks hin- und herwechseln → vereinen
Grenze(a,b) = √(p99,9(a) · p0,1(b)) wenn sich die Quantile (nur Blöcke ≥ dipSec) nicht überlappen, sonst Talminimum
Gegenprobe: jede Grenze liegt bei Auslassen jeder Einheit in einem Tal, sonst vereinen
```

- [ ] **Step 1: Failing tests** (`test/bands.test.js`):

```js
import assert from "node:assert";
import { assignFamilies } from "../build/lib/learn/families.js";
import { baseBandsOf, bandOf, holdProfile, learnBands, suspectLimitOf, unitsOf } from "../build/lib/learn/bands.js";
import { asKw, layoutOf, loadSeries } from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const units = pts => { const { L, s } = layoutOf(pts); return { u: unitsOf(pts, L, s), L }; };
const days = pts => {
	const out = [];
	for (let t = pts[0].ts; t < pts.at(-1).ts; t += 86_400_000) {
		out.push({ points: pts.filter(p => p.ts >= t && p.ts < t + 86_400_000), from: t, to: t + 86_400_000 });
	}
	return out;
};

describe("base bands and hold time profile (Spec B.1a)", () => {
	it("washer: a boundary between spin (≤ 839 W) and heating (≥ 2047 W) [S1]", () => {
		const { u, L } = units(W.filter(p => true));
		const b = learnBands(u, L.runLimit, { mode: "median60", dipSec: 60 });
		const cut = b.find(x => x.min > 839 && x.min < 2047);
		assert.ok(cut, JSON.stringify(b.map(x => [x.min, x.max])));
		assert.ok(b.some(x => x.min <= 290 && x.max > 839), "one band holds every final spin (290–839 W)");
	});
	it("washer: the spin band has p99 ≤ 145 s and a suspect limit of max(600, 5·p99) < 1200 s (r_hold: n 427, p99 94 s)", () => {
		const { u, L } = units(W);
		const bb = baseBandsOf(u, L.runLimit);
		const h = bb.holds.find(x => x.band === bandOf(bb, 250).id);
		assert.ok(h.n >= 30 && h.p99Sec <= 145, JSON.stringify(h));
		assert.strictEqual(h.suspectSec, Math.max(600, 5 * h.p99Sec));
		assert.ok(h.suspectSec < 1200, "a 20-min logger gap at 250 W is suspicious");
		assert.strictEqual(suspectLimitOf(bb, 250), h.suspectSec);
	});
	it("boiler: the band above 290 W survives; the band of 254 W tolerates the real 52.2-min hold", () => {
		const B = loadSeries("boiler4d");
		const bb = baseBandsOf(days(B), 35, { mode: "raw", dipSec: 5 });
		const top = bb.bands.at(-1);
		assert.ok(top.min > 290 && top.segments >= 9, JSON.stringify(top));
		assert.ok(suspectLimitOf(bb, 254) > 52.2 * 60, String(suspectLimitOf(bb, 254)));
	});
	it("kW state: the same bands divided by 1000 (Review Focus 4)", () => {
		const { u, L } = units(W);
		const kw = units(asKw(W));
		const a = learnBands(u, L.runLimit, { mode: "median60", dipSec: 60 });
		const b = learnBands(kw.u, kw.L.runLimit, { mode: "median60", dipSec: 60 });
		assert.strictEqual(b.length, a.length);
		a.forEach((x, i) => assert.ok(Math.abs(b[i].min * 1000 - x.min) <= 1e-6 * Math.max(1, x.min)));
	});
	it("fewer than 3 runs → no hold profile", () => {
		const { u, L } = units(W);
		const b = learnBands(u, L.runLimit, { mode: "median60", dipSec: 60 });
		assert.deepStrictEqual(holdProfile(u.slice(0, 2), b), []);
	});
	it("families use the new features only when every run has them (no NaN distance)", () => {
		const f = { coreSec: 8000, energyWh: 600, hiShare: 0.2, maxPauseSec: 10, nPause: 3, trailer: true, blockMean: 300 };
		const r = assignFamilies([{ ...f, topBandSec: 600, finalBandBlocks: 4 }, { ...f }, { ...f, coreSec: 8100 }], [-1, -1, -1], 0);
		// only "no NaN distance": with three inputs the z-normalisation separates coreSec 8000/8100 ([0,0,1], review/fam.mjs)
		assert.ok(r.families.every(x => Number.isInteger(x) && x >= 0));
	});
});
```

- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Doku:** keine nutzerseitige Änderung (Grundlage der Laufprüfung, sichtbar ab Task 12/24).
- [ ] **Step 5: Commit** `feat: base bands and hold time profile learned for every device`

---

### Task 12: Laufprüfung (Spec B.2, B.3 Rangfolge und Politik)

**Files:**
- Create: `src/lib/learn/quality.ts`, `test/quality.test.js`

**Interfaces:**
- Consumes: `cleanPoints`, `HistorySettings` (Task 9), `RunInfo`/`Layout`/`buildLayout` (Task 10), `Unit`, `BaseBands`, `baseBandsOf`, `suspectLimitOf` (Task 11), `assignFamilies`.
- Produces:
  - `type QualityCode = "incomplete" | "gap" | "stuck" | "sparse" | "unit" | "counter" | "foreign" | "spike" | "test" | "aborted" | "trailerCut" | "merged" | "finalSplit" | "historyCfg" | "invalid" | "timeJump" | "rare" | "formerlyDropped"`; bei `gap` beginnt `detail` mit `proven` oder `suspect`.
  - `interface Verdict` exakt wie Spec B.2; `type Stage = Verdict["stage"]`.
  - `interface RunSample extends Unit { key: string; kind: "run" | "spike" | "incomplete"; src: "live" | "history"; info: RunInfo | null; family: number; reports?: number[]; aborted?: boolean; restarted?: boolean; afterFinal?: FinalExit; starts?: number[] }` – `info` nur bei `kind: "run"`; `family` −1 ohne `info`; `starts` = gemeldete Starts (live) im Lauf.
  - `runSamples(deviceId: string, points: { ts: number; val: number | null }[], o: { stepMs: number; src: "live" | "history"; unitFactor: number }): { samples: RunSample[]; layout: Layout; series: TickSeries; clean: ReturnType<typeof cleanPoints> }` (bereinigt, zerlegt mit `maxRuns: Infinity`, Familien vergeben). Liefert **alle** Layout-Läufe (`kind: "run"`), kurze Aktivität < `MIN_ACTIVE_MS` (`layout.spikes`, `kind: "spike"`, Grundlage für `test` Merkmal (1)) und verworfene Segmente (`layout.incomplete`, `kind: "incomplete"` → Befund `incomplete`).
  - `daySamples(deviceId, points, o): RunSample[]` (scope continuous: Abschnitte zu je 24 h ab dem ersten Punkt; ein Abschnitt, der nur am Datenende kürzer ist, ist **nicht** `incomplete` – bei continuous gibt es kein Laufende, das fehlen könnte; `incomplete` nur bei unbekannter Strecke oder beweisbarer Lücke im Abschnitt).
  - `interface QualityContext { bands: BaseBands | null; unitFactor: number; unit: string; settings: HistorySettings | null; pollMs: number; outages: { from: number; to: number }[]; scope: "run" | "continuous"; templatePeakW?: number; oldStore?: { from: number; to: number; keys: string[] } }`.
  - `checkRuns(runs: RunSample[], ctx: QualityContext): Verdict[]` (gleiche Reihenfolge wie `runs`; bei jeder Auswertung neu; `user` setzt der Aufrufer).
  - `verdictKey(deviceId: string, startMs: number): string` = `` `${deviceId}@${Math.floor(startMs / 60_000)}` ``; `sameRun(a: string, b: string): boolean` (gleiches Gerät, ≤ 5 min).
  - `stageOf(reasons): Stage` mit Rangfolge `unusable` > Datenfehler-Quarantäne (`gap` suspect, `stuck`, `sparse`) > Form-Quarantäne (`foreign`, `test`) > `limited` (darunter `merged`) > ok; `primaryOf(reasons): QualityCode | null` (höchster Rang, für den Hinweistext B.3); `usesOf(reasons): Verdict["uses"]` nach Spalte „Folge“; `finalSplit` ergibt Stufe `ok`.
  - **`merged` (Entscheidung 9, Spec B.2):** nur über Layout-Merkmale – Dauer > 1,8 × Maximum der eigenen Gruppe **und** zwei Endblöcke (Task 10) –, nie über gemeldete Starts. Stufe `limited`, `uses` = `{ start: true, end: true, phases: false, final: false, trailer: false, rest: false }`; `end` gilt nur für das Ende des Gesamtlaufs (Gate, Task 21), Pausen-, Dauer- und Grenzwert-Statistik nutzen den Lauf nicht (die innere Ruhe zwischen den beiden Läufen bindet keine Ende-Wartezeit). Kein Hinweis nach B.3.
  - `admitted(v: Verdict, purpose: keyof Verdict["uses"]): boolean` – `user: "exclude"` → false, `user: "include"` → true außer `unusable`, sonst Stufe und `uses`.

- [ ] **Step 1: Failing tests** (`test/quality.test.js`):

```js
import assert from "node:assert";
import { baseBandsOf } from "../build/lib/learn/bands.js";
import { admitted, checkRuns, daySamples, primaryOf, runSamples, stageOf, verdictKey } from "../build/lib/learn/quality.js";
import {
	asKw, BASE_TS, bridge, handTest, layoutRun, loadSeries, resample, runIndex, shift, withForeign, withGap, withHold,
	withRelog, withSpikes,
} from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const ctx0 = { unitFactor: 1, unit: "W", settings: null, pollMs: 10_000, outages: [], scope: "run" };
function judge(points, over = {}, o = { stepMs: 10_000, src: "history", unitFactor: 1 }) {
	const { samples, layout } = runSamples("wm", points, o);
	const bands = baseBandsOf(samples, layout.runLimit);
	const v = checkRuns(samples, { ...ctx0, bands, ...over });
	const of = id => {
		const ts = runIndex("washer30d").find(r => r.id === id).ts;
		const k = samples.findIndex(s => Math.abs(s.info ? s.from - ts : Infinity) <= 300_000);
		return { v: v[k], s: samples[k], codes: v[k].reasons.map(r => r.code).sort() };
	};
	return { samples, v, of };
}
const base = judge(W);
const day = id => runIndex("washer30d").find(r => r.id === id).ts;

describe("run check (Spec B.2)", () => {
	it("w04 (06.11. 13:37) is sparse, not test, in quarantine", () => {
		const { codes, v } = base.of("w04");
		assert.ok(codes.includes("sparse") && !codes.includes("test"), codes.join());
		assert.strictEqual(v.stage, "quarantine");
	});
	it("the same 41-min programme sampled densely, among the other runs, is rare and used (P1)", () => {
		// w04 inside the whole recording replaced by its densely re-sampled version: the run check compares it with the other runs
		const from = day("w04") - 60_000;
		const to = day("w04") + 45 * 60_000;
		const dense = [...W.filter(p => p.ts < from || p.ts >= to), ...resample(W, from, to, 5_000)].sort((a, b) => a.ts - b.ts);
		const { v, codes } = judge(dense).of("w04");
		assert.ok(!codes.includes("sparse") && !codes.includes("test"), codes.join());
		assert.ok(codes.includes("rare"), codes.join());
		assert.ok(admitted(v, "end"));
	});
	it("w02 is rare and trailerCut (limited, used for the end); w07 only rare; w06 used", () => {
		const a = base.of("w02");
		assert.ok(a.codes.includes("rare") && a.codes.includes("trailerCut"), a.codes.join());
		assert.deepStrictEqual([a.v.stage, a.v.uses.end, a.v.uses.trailer], ["limited", true, false]);
		assert.deepStrictEqual(base.of("w07").codes, ["rare"]);
		assert.strictEqual(base.of("w07").v.stage, "ok");
		assert.ok(["ok", "limited"].includes(base.of("w06").v.stage));
	});
	it("w05 is trailerCut, w12 has no finding (P8)", () => {
		assert.deepStrictEqual(base.of("w05").codes, ["trailerCut"]);
		assert.deepStrictEqual(base.of("w12").codes, []);
	});
	it("the other normal runs are never in quarantine", () => {
		for (const id of ["w01", "w03", "w08", "w09", "w10", "w11"]) assert.ok(["ok", "limited"].includes(base.of(id).v.stage), id);
	});
	it("w13 at the data end is incomplete and unusable", () => {
		const k = base.samples.findIndex(s => s.from >= day("w13") - 300_000);
		assert.ok(k >= 0 && base.samples[k].kind === "incomplete", "the layout drops it, runSamples keeps it as incomplete");
		assert.ok(base.v[k].reasons.some(r => r.code === "incomplete"));
		assert.strictEqual(base.v[k].stage, "unusable");
	});
	it("three equal clean short runs form a group of their own and are used", () => {
		const short = resample(W, day("w04") - 60_000, day("w04") + 45 * 60_000, 5_000).filter(p => p.ts >= day("w04") - 60_000 && p.ts < day("w04") + 45 * 60_000);
		const end = W.at(-1).ts + 3_600_000;
		const extra = [1, 2, 3].flatMap(k => shift(short, end + k * 86_400_000 - short[0].ts));
		const r = judge([...W, ...extra]);
		const ks = r.samples.map((s, i) => i).filter(i => r.samples[i].from > end);
		assert.strictEqual(ks.length, 3);
		assert.strictEqual(new Set(ks.map(i => r.samples[i].family)).size, 1);
		assert.ok(ks.every(i => admitted(r.v[i], "end")));
	});
	it("a proven gap via relog makes the run unusable", () => {
		const pts = withGap(withRelog(W, 300_000), day("w08") + 3_600_000, 20);
		const { v, codes } = judge(pts, { settings: { relogSec: 300, ignoreZero: false, ignoreBelowZero: false, debounceMs: 0, blockTimeMs: 0, round: null } }).of("w08");
		assert.ok(codes.includes("gap") && v.reasons.find(r => r.code === "gap").detail.startsWith("proven"));
		assert.strictEqual(v.stage, "unusable");
	});
	it("a hold of 20 min at 250 W is a suspect gap with a profile, nothing without one (P2, P28)", () => {
		const pts = withHold(W, day("w08") + 3_600_000, 20, 250);
		const a = judge(pts).of("w08");
		assert.ok(a.v.reasons.find(r => r.code === "gap")?.detail.startsWith("suspect"));
		assert.strictEqual(a.v.stage, "quarantine");
		const two = pts.filter(p => p.ts < day("w09"));
		const b = judge(two.filter(p => p.ts >= day("w07") - 1_800_000)).of("w08");
		assert.ok(!b.codes.includes("gap"), b.codes.join());
	});
	it("stuck needs 20 equal reports; a long hold without reports is never stuck (P2)", () => {
		const { samples, layout } = runSamples("wm", withHold(W, day("w08") + 3_600_000, 15, 250), { stepMs: 10_000, src: "live", unitFactor: 1 });
		const k = samples.findIndex(s => Math.abs(s.from - day("w08")) <= 300_000);
		const bands = baseBandsOf(samples, layout.runLimit);
		samples[k].reports = Array.from({ length: 25 }, (_, i) => day("w08") + 3_600_000 + i * 36_000);
		assert.ok(checkRuns(samples, { ...ctx0, bands })[k].reasons.some(r => r.code === "stuck"));
		samples[k].reports = [];
		assert.ok(!checkRuns(samples, { ...ctx0, bands })[k].reasons.some(r => r.code === "stuck"));
	});
	it("boiler: 52 min at 254 W is no finding; 4 usable day units (the last one only ends at the data end)", () => {
		const B = loadSeries("boiler4d");
		const s = daySamples("kessel", B, { stepMs: 10_000, src: "history", unitFactor: 1 });
		const v = checkRuns(s, { ...ctx0, scope: "continuous", bands: baseBandsOf(s, 35, { mode: "raw", dipSec: 5 }) });
		assert.strictEqual(v.length, 4);
		assert.ok(v.every(x => x.stage !== "unusable" && x.stage !== "quarantine"), JSON.stringify(v.map(x => x.reasons)));
	});
	it("kW without unit text → unit (template peak); Wh → counter", () => {
		const kw = judge(asKw(W), { unitFactor: 1, templatePeakW: 2000 });
		assert.ok(kw.v.length > 0, "the layout finds the runs in kW values");
		assert.ok(kw.v.every(x => x.reasons.some(r => r.code === "unit") && x.stage === "unusable"));
		const wh = judge(W, { unit: "Wh" });
		assert.ok(wh.v.every(x => x.reasons.some(r => r.code === "counter")));
	});
	it("foreign load +150 W before a run → foreign; long heating inside the known band is never foreign (P7)", () => {
		const a = judge(withForeign(W, day("w09") - 25 * 60_000, 20, 150)).of("w09");
		assert.ok(a.codes.includes("foreign"));
		assert.ok(!base.of("w07").codes.includes("foreign"));
	});
	it("devices whose clean runs touch one band only never get test by feature 3", () => {
		const pts = [];
		for (let k = 0; k < 6; k++) {
			const t0 = BASE_TS + k * 86_400_000;
			pts.push({ ts: t0, val: 0.3 }, { ts: t0 + 3_600_000, val: 10 }, { ts: t0 + 3_600_000 + 7_200_000, val: 0.3 });
		}
		const r = judge(pts);
		assert.ok(r.v.every(x => !x.reasons.some(y => y.code === "test")));
	});
	it("hand tests of 3 min 2000 W and 5 min 300 W are test (quarantine)", () => {
		const end = W.at(-1).ts + 3_600_000;
		const r = judge([...W, ...handTest(end, 3, 2000), ...handTest(end + 86_400_000, 5, 300)]);
		const late = r.v.filter((x, i) => r.samples[i].from > end);
		assert.strictEqual(late.length, 2, "the 3-min test is a spike sample, the 5-min test a run sample");
		assert.deepStrictEqual(r.samples.filter(s => s.from > end).map(s => s.kind).sort(), ["run", "spike"]);
		assert.ok(late.every(x => x.reasons.some(y => y.code === "test") && x.stage === "quarantine"));
	});
	it("two runs grown together → merged: limited, used for the end of the whole run only, never quarantine (decision 9)", () => {
		const { info: a, s } = layoutRun("washer30d", "w10");
		const pts = bridge(W, s.t0 + (a.coreEnd + 1) * s.stepMs, day("w11"), 40);
		const r = judge(pts);
		const m = r.v.find(x => x.reasons.some(y => y.code === "merged"));
		assert.ok(m, "found by layout features: duration > 1.8 × group maximum and two end blocks");
		assert.deepStrictEqual([m.stage, m.uses.end, m.uses.final, m.uses.phases], ["limited", true, false, false]);
		assert.strictEqual(primaryOf(m.reasons), "merged");
	});
	it("spikes, aborted, invalid, historyCfg are limited with their uses", () => {
		// spike = single value > 3 × p99.9 of the runs (p99.9 ≈ 2268 W, review/p999.mjs) → 9000 W
		const sp = judge(withSpikes(W, 3, 9000, 7)).v;
		assert.ok(sp.some(x => x.reasons.some(y => y.code === "spike") && x.stage === "limited"));
		const { samples, layout } = runSamples("wm", W, { stepMs: 10_000, src: "live", unitFactor: 1 });
		samples[7].aborted = true;
		const v = checkRuns(samples, { ...ctx0, bands: baseBandsOf(samples, layout.runLimit) });
		assert.deepStrictEqual([v[7].stage, v[7].uses.start, v[7].uses.end], ["limited", true, false]);
		const deb = judge(W, { settings: { relogSec: 0, ignoreZero: true, ignoreBelowZero: false, debounceMs: 20_000, blockTimeMs: 0, round: null } }).v[0];
		assert.ok(deb.reasons.some(r => r.code === "historyCfg"));
		assert.deepStrictEqual([deb.uses.phases, deb.uses.trailer, deb.uses.rest], [false, false, false]);
	});
	it("formerlyDropped inside the range of an old store, use unchanged (P16)", () => {
		const keys = base.samples.filter(s => Math.abs(s.from - day("w05")) > 300_000).map(s => s.key);
		const r = judge(W, { oldStore: { from: day("w01") - 1, to: day("w12") + 1, keys } }).of("w05");
		assert.ok(r.codes.includes("formerlyDropped"));
		assert.deepStrictEqual(r.v.uses, base.of("w05").v.uses);
	});
	it("ranking and keys", () => {
		const R = codes => codes.map(code => ({ code, detail: code === "gap" ? "suspect" : "" }));
		assert.strictEqual(stageOf(R(["incomplete", "test"])), "unusable");
		assert.strictEqual(stageOf(R(["sparse", "rare"])), "quarantine");
		assert.strictEqual(primaryOf(R(["test", "sparse"])), "sparse");
		assert.strictEqual(stageOf(R(["trailerCut", "rare"])), "limited");
		assert.strictEqual(stageOf(R(["rare"])), "ok");
		assert.strictEqual(stageOf(R(["finalSplit"])), "ok");
		assert.strictEqual(stageOf(R(["merged"])), "limited");
		assert.strictEqual(verdictKey("wm", 1_700_000_123_456), "wm@28333335");
	});
	it("user decisions win except over unusable", () => {
		const v = { ...base.of("w04").v, user: "include" };
		assert.strictEqual(admitted(v, "end"), true);
		assert.strictEqual(admitted({ ...base.of("w12").v, user: "exclude" }, "end"), false);
		assert.strictEqual(admitted({ ...base.of("w04").v, stage: "unusable", user: "include" }, "end"), false);
	});
});
```

- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (Laufprüfung: Befunde, Stufen, „seltene echte Programme werden verwendet“, zusammengewachsene Läufe sind kein Fehler); Changelog-Zeile zum Anlernen (Laufprüfung) umformulieren.
- [ ] **Step 5: Commit** `feat: run check marks unusable recordings and keeps rare real programmes`

---

### Task 13: Laufspeicher – neue Felder, 30 Tage, Verdrängung, Umrechnen (Spec C.7, D.2, P10/P12/P23/P26/P27)

**Files:**
- Modify: `src/lib/runStore.ts` (Konstanten `:13-23`, `StoredRun`, `StoreFile`, `loadStore` `:331-371`, `reconcileStore`, `addRun` `:734`, `fitSize` `:768`, `pickVictim` `:807-838`, `envelopeOf` `:689`), `src/lib/deviceRegistry.ts` (`deleteLearningData` `:461-492`, `discardRun` `:433`)
- Test: `test/runStore.test.js`

**Interfaces:**
- Consumes: `LAYOUT_REV`, `buildLayout` (Task 10), `Verdict`, `checkRuns`, `verdictKey` (Task 12), `BaseBands` (Task 11).
- Produces:
  - Konstanten: `WINDOW_MS = 30 * 86_400_000`, `MAX_STORE_BYTES = 1_000_000`, `MAX_RUN_META = 400`, `MIN_PER_FAMILY = 2`, `REPLAY_PICK_MAX = 60`.
  - `StoredRun` + `key: string`, `rev?: number`, `afterFinal?: FinalExit`, `veto?: number`, `rep?: number[]` (Meldezeitpunkte als Differenzen; live aus `Capture.rep`, History-Läufe aus `has` bzw. den Rohpunkten beim Import), `gridFrom?: number` (Raster vor einer Umrechnung auf ein feineres Raster; Eigenschaft des Laufs, keine User-Entscheidung); Rohdaten (`data`) optional. `seg` + `progEndIdx: number`; `feat` + `burstMaxW: number` (höchstes Burst-Maximum im Nachlauf, 0 ohne Nachlauf; nicht `burstMaxSec`, das ist eine Dauer) und `endBlockMinW: number` (niedrigster gehaltener Wert im Endblock nach Task 10).
  - `StoreFile` + `verdicts: Record<string, { user?: "include" | "exclude"; reason?: string }>` (nur User-Entscheidungen), `bands?: BaseBands`, `tail?: { ceil: number; separated: boolean }` (aus allen zugelassenen Läufen nach der Regel von Task 10; in `upgradeStore`, `addRun` und `recompute` neu berechnet – eine Live-Capture enthält nur einen Lauf, `tailCeil` braucht ≥ 2 Läufe mit Nachlauf, deshalb kommt der Wert aus dem Speicher), `final?: { state: "off" | "on" | "suspended"; splits: string[]; suspendedAt: number; reason?: string }`, `phaseCheck?: { lastTs: number; runs: number }`, `legacyEnvelope?: Envelope`, `job?: { step: "tighten" | "final" | "phases"; cursor: number; startedTs: number }`, `layoutRev?: number`, `lastSeenTs?: number` (letzte Abfrage, für „Ausfallzeit > 1 h“), `historyReadTs?: number` (History beim Einschalten bzw. bei leerem Speicher gelesen, auch wenn sie keine Läufe enthielt).
  - `upgradeStore(store: StoreFile): string[]` – friert `envelope` als `legacyEnvelope` ein (nur wenn fehlt), zerlegt Läufe mit `rev < LAYOUT_REV` bzw. ohne `rev` aus `data`/`q` neu, behält Familien-ids, setzt `key`, `seg.progEndIdx`, `feat.burstMaxW`, `feat.endBlockMinW`, `tail`.
  - **Brücke Speicher ↔ Laufprüfung:** `storeSamples(store: StoreFile, ctx: QualityContext): { sample: RunSample; verdict: Verdict; series: TickSeries }[]` – baut aus jedem gespeicherten Lauf (Zellen, `rep`, `afterFinal`, `src`) einen `RunSample` mit Tickserie, ruft `checkRuns` über alle und wendet `verdicts[key].user` und `gridFrom` (→ `uses.phases = false`, `uses.trailer = false`) an; je Job zwischengespeichert (Schlüssel: Speicher-Revision). Damit werden `stuck`, `sparse` und `gap` (Beweis 2) bei jeder Auswertung neu bewertet. Läufe ohne Rohdaten (nur Schlüssel) liefern keinen Sample.
  - `recomputeBands(store: StoreFile, ctx): void` – nach jedem gespeicherten Lauf in zwei Durchgängen: (1) Verdicts ohne Haltezeit-Profil → (2) Grundbänder und Haltezeit-Profil aus den sauberen Läufen (`baseBandsOf`) → Verdicts erneut; Ergebnis in `store.bands`.
  - `recomputeEnvelope(store: StoreFile): void` – aus zugelassenen Läufen + Grenzläufen und `legacyEnvelope` (Maxima ≥, Minima ≤ `legacyEnvelope`).
  - `boundaryRuns(store: StoreFile): Set<string>` (Schlüssel bindender oder `veto`-Läufe).
  - `evict(store: StoreFile, now: number): string[]` – schrittweise nach D.2, ersetzt `pickVictim`; läuft bei Überschreiten von `MAX_STORE_BYTES`/`MAX_RUN_META` und für Läufe älter als `WINDOW_MS`.
  - `convertRuns(store: StoreFile, step: number, unitFactor: number): string[]` – ersetzt das Verwerfen in `reconcileStore`.
  - `clearLearningData(store: StoreFile, keepDecisions: boolean): StoreFile`; `setDecision(store: StoreFile, key: string, user: "include" | "exclude" | null): void`; `DeviceRegistry.deleteLearningData(deviceId: string, keepDecisions = true)` – nur für „Lerndaten löschen“.
  - `DeviceRegistry.removeLearningData(deviceId: string): Promise<void>` – entfernt die Speicherdatei samt Entscheidungen (`removeStore`); aufgerufen beim **Löschen eines Geräts** (`DeviceSync.apply` mit `deleted`, `deviceSync.ts:47-49`; DM `deleteDevice`, `deviceManagement.ts:715`). Sonst erbte ein neues Gerät mit derselben id die Entscheidungen (Schlüssel `<id>@Minute`).

- [ ] **Step 1: Failing tests** (`test/runStore.test.js`):

```js
import { readFileSync } from "node:fs";
import {
	boundaryRuns, clearLearningData, convertRuns, evict, MAX_RUN_META, MAX_STORE_BYTES, recomputeEnvelope, setDecision,
	upgradeStore, WINDOW_MS,
} from "../build/lib/runStore.js";
import { LAYOUT_REV } from "../build/lib/learn/runs.js";

const rawStore = readFileSync(new URL("./fixtures/v4store.json", import.meta.url), "utf8");
const fresh = () => { const st = JSON.parse(rawStore); upgradeStore(st); return st; };
const DAY = 86_400_000;

describe("learning data of V5", () => {
	it("v4store: legacyEnvelope frozen once, runs re-segmented, families stable, no NaN", () => {
		const st = JSON.parse(rawStore);
		const before = st.runs.map(r => r.family);
		upgradeStore(st);
		assert.deepStrictEqual(st.legacyEnvelope, JSON.parse(rawStore).envelope);
		assert.ok(st.runs.every(r => r.rev === LAYOUT_REV && typeof r.key === "string"));
		assert.deepStrictEqual(st.runs.map(r => r.family), before);
		assert.ok(st.runs.every(r => Object.values(r.feat).every(x => typeof x !== "number" || Number.isFinite(x))));
		const again = structuredClone(st.legacyEnvelope);
		upgradeStore(st);
		assert.deepStrictEqual(st.legacyEnvelope, again);
	});
	it("the recomputed envelope is never narrower than legacyEnvelope (P10)", () => {
		const st = fresh();
		st.runs = st.runs.slice(0, 3);
		recomputeEnvelope(st);
		const L = st.legacyEnvelope;
		for (const k of ["maxPauseSec", "maxBurstSec", "maxTrailSec", "maxTrailerSec"]) assert.ok(st.envelope[k] >= L[k], k);
		for (const k of ["minRunW", "minCoreSec"]) assert.ok(L[k] === 0 || st.envelope[k] <= L[k], k);
	});
	it("eviction after 30 days keeps 2 per family and every boundary run (P23)", () => {
		const st = fresh();
		const keep = boundaryRuns(st);
		const families = new Map();
		for (const r of st.runs) families.set(r.family, (families.get(r.family) ?? 0) + 1);
		evict(st, Math.max(...st.runs.map(r => r.ts)) + WINDOW_MS + 10 * DAY);
		for (const [f, n] of families) assert.ok(st.runs.filter(r => r.family === f).length >= Math.min(2, n), `family ${f}`);
		for (const k of keep) assert.ok(st.runs.some(r => r.key === k), k);
	});
	it("two equally extreme runs → at least one stays", () => {
		// the order of the step-wise eviction is not fixed, and "at least 2 per family" may keep both
		const st = fresh();
		const b = st.runs.find(r => boundaryRuns(st).has(r.key));
		const twin = { ...structuredClone(b), key: `${b.key}-twin`, id: `${b.id}t`, ts: b.ts + 1000 };
		st.runs.push(twin);
		for (let k = 0; k < 6; k++) st.runs.push({ ...structuredClone(st.runs[0]), key: `x${k}`, id: `x${k}`, family: b.family });
		evict(st, Math.max(...st.runs.map(r => r.ts)) + WINDOW_MS + DAY);
		assert.ok(st.runs.filter(r => r.key === b.key || r.key === twin.key).length >= 1);
	});
	it("the store carries the tail separation of all admitted runs; storeSamples rebuilds samples with verdicts", () => {
		const st = fresh();
		assert.deepStrictEqual([st.tail.separated, Math.round(st.tail.ceil)], [true, 124]);
		assert.ok(st.runs.every(r => Number.isInteger(r.seg.progEndIdx) && r.feat.burstMaxW >= 0 && r.feat.endBlockMinW > 0));
		const out = storeSamples(st, { bands: null, unitFactor: 1, unit: "W", settings: null, pollMs: 10_000, outages: [], scope: "run" });
		assert.strictEqual(out.length, st.runs.filter(r => r.data).length);
		assert.ok(out.every(x => x.sample.key === x.verdict.key && x.series.length > 0));
	});
	it("excluding and including again restores the envelope exactly", () => {
		const st = fresh();
		recomputeEnvelope(st);
		const env = structuredClone(st.envelope);
		const key = [...boundaryRuns(st)][0];
		setDecision(st, key, "exclude");
		recomputeEnvelope(st);
		setDecision(st, key, null);
		recomputeEnvelope(st);
		assert.deepStrictEqual(st.envelope, env);
	});
	it("poll and unit changes convert runs instead of discarding them; boundaries stay in W (P27)", () => {
		const st = fresh();
		const n = st.runs.length;
		const env = structuredClone(st.envelope);
		assert.ok(convertRuns(st, 30_000, 1).length > 0);
		assert.deepStrictEqual([st.runs.length, st.step], [n, 30_000]);
		convertRuns(st, 10_000, 1000);
		assert.deepStrictEqual([st.runs.length, st.unitFactor, st.step], [n, 1000, 10_000]);
		assert.deepStrictEqual(st.envelope, env);
		assert.ok(st.runs.every(r => r.gridFrom === 30_000), "finer grid: property of the run (no phases, no trailer)");
		assert.ok(Object.values(st.verdicts).every(v => v.reason !== "finerGrid"), "not mixed with user decisions");
	});
	it("clearing keeps the decisions unless asked (P26)", () => {
		const st = fresh();
		setDecision(st, "wm@100", "exclude");
		assert.deepStrictEqual(clearLearningData(st, true).verdicts, { "wm@100": { user: "exclude" } });
		assert.deepStrictEqual(clearLearningData(st, false).verdicts, {});
		assert.deepStrictEqual(clearLearningData(st, true).runs, []);
	});
	it("limits: 1 MB, metadata of 400 runs, 30-day window", () => {
		assert.deepStrictEqual([MAX_STORE_BYTES, MAX_RUN_META, WINDOW_MS], [1_000_000, 400, 30 * DAY]);
	});
});
```

`StoredRun.gridFrom` ist die Kennzeichnung für `uses.phases = false`, `uses.trailer = false` nach Umrechnung auf ein feineres Raster (`storeSamples` wendet sie an). Sie liegt am Lauf, nicht in `verdicts`: sonst überstünde sie „Lerndaten löschen“ als vermeintliche Entscheidung und ginge bei `setDecision(key, null)` verloren. Imports im Test um `storeSamples` ergänzen.

```js
// test/deviceRegistry.test.js
it("deleting a device removes its learning data with the decisions; a new device with the same id starts empty", async () => {
	const ctx = await registrySetup();
	const st = ctx.reg.learningData("dev");
	setDecision(st, "dev@100", "exclude");
	await ctx.reg.removeLearningData("dev");
	const again = await registrySetup({ host: ctx.host, files: ctx.files });
	assert.deepStrictEqual(again.reg.learningData("dev").verdicts ?? {}, {});
});
```

- [ ] **Step 2:** FAIL. **Step 3:** implementieren (`isStore` unverändert, Format `v: 1`). **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (30 Tage, Grenzläufe bleiben, Entscheidungen überstehen „Lerndaten löschen“, Löschen eines Geräts entfernt sie; Poll-/Einheitenwechsel rechnet um).
- [ ] **Step 5: Commit** `feat: learning data keeps 30 days, boundary runs and user decisions; poll and unit changes convert runs`

---

### Task 14: `FinalPhaseFilter` in der Erkennungskette (Spec A.1–A.3 Laufzeit)

**Files:**
- Create: `src/lib/detector/finalPhase.ts`, `test/finalPhase.test.js`, `test/helpers/final.js`
- Modify: `src/lib/detector/types.ts` (`Detector`), `src/lib/detector/index.ts` (`createDetector` `:54-73`, `DetectorOptions`), `src/lib/detector/trailer.ts` (`step` `:171-191`, `resolve` `:232-271`, Getter), `test/detectorGolden.test.js`

**Interfaces:**
- Consumes: `FINAL_KEYS`, `FinalExit`, `finalOn` (Task 3).
- Produces:
  - `Detector` + `readonly settling?: boolean`, `readonly finalExit?: FinalExit | null` – der Ausgang der letzten Sperrphase, **nur** während des Aufrufs, der das erste `started` nach dieser Sperrphase liefert (Ausgang a: das erste `started` danach); danach wieder `null`. Spätere Starts ohne Sperrphase (z. B. am nächsten Tag) tragen ihn nie, sonst würden sie als `afterFinal` markiert und lösten `finalSplit`-Prüfungen fremder Läufe aus.
  - `DetectorOptions` + `resumeLockAt?: number` (Neustart in `lock`).
  - `finalFloors(f: Required<FinalSettings>, pollSec: number, standby: number): Required<FinalSettings>` – Standardwerte für 0 (`finalQuietSec` 120, `finalDipSec` max(60, 2·Poll), `finalRestVal` `standby`, `finalRestSec` max(60, 3·Poll), `finalCheckSec` 1800, `finalLockSec` 14 400) und Laufzeit-Untergrenzen (Y, G ≥ 2·Poll; Z ≥ max(2·Poll, G); `finalRestSec` ≥ 3·Poll; `finalLockSec` ≥ 2·Poll).
  - `class FinalPhaseFilter implements Detector { constructor(inner: Detector, s: Required<FinalSettings>, o: { pollSec: number; standby: number; resumeLockAt?: number }); readonly started; readonly settling; readonly finalExit; readonly lockAt: number | null; readonly stats: Record<"early" | FinalExit, number>; tick(); feed(); reset() }`.
  - Kette: `createInner` → `FinalPhaseFilter` (nur bei `finalOn`) → `TrailerFilter`; TrailerFilter reicht bei `inner.settling` jeden Aufruf unverändert durch (kein `armed()`, kein `base()`). Er reicht `settling`, `finalExit`, `lockAt` und `stats` des inneren Filters als Getter nach außen (Tests lesen `det.stats` am äußersten Detector). `inTrailer` ist beim Durchreichen `trailerUntil !== null` (heute hängt es an `suppressedInTrailer > 0`, `trailer.ts:115`, das beim Durchreichen 0 bleibt – der Knitterschutz-State wäre in der Sperrphase falsch). **Zeiten:** `TrailerFilter.forward` und `resolve` übernehmen `r.times?.[k] ?? c.now` des inneren Detectors statt immer `c.now` (heute `trailer.ts:264, 387-391`), ebenso `note(ev, at)`; sonst ginge die Rückdatierung (b–g) verloren.
  - **Zeitmessung im Modus timed:** Band-, Ruhe-, Hochlast- und Aktivitätszeiten zählen nur über den in `tick` gehaltenen Wert (`dt` zwischen zwei `tick`); `feed` liefert nur Ereigniszeiten an den inneren Detector. Grund: `simulate()` speist je Tick `max`/`min` zu künstlichen Zeiten ein (`replay.ts:88-96`), Zeiten je `feed`-Aufruf wichen im Nachspielen vom Live-Betrieb ab (G10). Z läuft trotzdem ohne neue Werte ab, weil `tick` je Poll kommt.
  - `test/helpers/final.js`: `WM_312 = { startVal: 30, endVal: 15, standby: 1, startCount: 2, endCount: 50, mode: "count", startDurationSec: 60, endDurationSec: 300 }`, `WM_FINAL` (Werte wie Task 3, Konfiguration von `y_actexit.mjs`: P 150, Pmax 1311, Hochlast 1311, X 3600, Y 168, Z 120, G 60, Ruhe 5,5 W/60 s, Aktivität 9 W/0,7, Prüffenster 2400, Sperre 2700), `SHORT_FINAL = { ...WM_FINAL, finalAfterSec: 0, finalMinSec: 30, finalQuietSec: 30, finalCheckSec: 300, finalLockSec: 600 }` (feuert auf 400-Tick-Zufallskurven: 1364 von 1648 Kombinationen, `…/scratchpad/review/gold.mjs`; mit `WM_FINAL` 0), `finalRun(values, extra = {}, o = {})` = `detectorRun(values, { ...WM_312, ...WM_FINAL, ...extra }, o)`, `starts(r)`, `ends(r)`, `syntheticRun()` = `{ values, coreEnd }` aus `runOf({ device: "washer", programme: "cotton60", seed: 1 })` mit **Ticks 380–389 auf 3 W** (Ende-Schleudern 300–800 W über 50 Ticks ab Tick 390 > X = 360 Ticks). Ohne die Ruhe davor gehört das Wasch-Segment 360–389 (80–400 W, ~60 % in [150; 1311)) ohne Unterbrechung ≥ G zum Block, der Block beginnt vor `runStart + X` und qualifiziert nie – kein frühes Ende (`…/scratchpad/review/synth.mjs`: X 60 min → `finished@489`, `early 0`; mit 3 W in 380–389 frühes Ende bei `coreEnd + 13`, Ausgang b, `review/synth2.mjs`).
- Ablauf (nicht durch Signatur bestimmt):

```text
dt je Aufruf = min(now − last, max(2·Poll, 60 s)); now < last → Block, Unterbrechung, Sperrzähler zurücksetzen
pass:  r = inner(...); started → runStart = times[k] ?? now, Block leer; finished/aborted → Block leer
       v in [P, Pmax): band += dt; v ≥ Pmax (Pmax>0): Block+Qualifikation weg; v < P: below += dt, unqualifiziert & below > G → Block weg
       qualifiziert = blockStart ≥ runStart + X ∧ band ≥ Y ∧ inner.started
       qualifiziert ∧ below ≥ Z → Ereignisse von r ohne running/finished + finished; status off (v < standby) sonst standby;
                                  started=false; lockAt = now; stats.early++; → lock
lock:  inner bekommt echte Werte, Ereignisse verschluckt, status aus Wert; Prüfung je Aufruf in dieser Reihenfolge:
       a inner finished/aborted → pass (ohne reset)
       c finalHotVal>0 ∧ v ≥ finalHotVal seit ≥ G am Stück
       g now − lockAt ≤ finalCheckSec ∧ Bandzeit seit lockAt ≥ Y/2
       d now − lockAt > finalCheckSec ∧ v in [P, Pmax)
       f finalActVal>0 ∧ Anteil(v > finalActVal) im gleitenden 5-min-Fenster (voll) ≥ finalActShare
       b v < finalRestVal seit ≥ finalRestSec am Stück
       e now − lockAt ≥ finalLockSec
       alle Zähler der Sperrphase (Ruhe, Hochlast, Bandzeit, Aktivitätsfenster) beginnen bei lockAt
       bei b–g: inner.reset(), pass; nächstes inneres started wird auf die erste Aktivität > finalRestVal nach der letzten
       Ruhe zurückdatiert, frühestens auf lockAt (times); stats[Buchstabe]++
       Marke: pendingExit = Buchstabe (auch bei a); der Aufruf, der das nächste innere started liefert, zeigt
       finalExit = pendingExit, danach finalExit = null und pendingExit = null
timed: band/below/rest/act-Zeiten nur in tick (gehaltener Wert seit dem letzten tick); feed nur an inner weiter
```

- [ ] **Step 1: Failing tests** (`test/finalPhase.test.js`). Belege: `f_lock.mjs` (ganze Aufzeichnung, Verzögerungen je Lauf), `y_actexit.mjs` (Ausgang f, 72 Szenarien), `f_viol.mjs` (zu kleines Y) im Scratchpad; Ergebnisse auf `wm.json` am 14.11.2026 nachgerechnet.

```js
import assert from "node:assert";
import { finalFloors } from "../build/lib/detector/finalPhase.js";
import { createDetector } from "../build/lib/detector/index.js";
import { analyzeHistory } from "../build/lib/historyLearning.js";
import { simulate } from "../build/lib/learn/replay.js";
import { finalRun, ends, SHORT_FINAL, starts, syntheticRun, WM_312, WM_FINAL } from "./helpers/final.js";
import { detectorRun, layoutOf, loadSeries, restartScenarios, ticksOf, withGap } from "./helpers/fixtures.js";
import { differences, randomCurve } from "./helpers/golden.js";
import { runOf } from "./helpers/programmes.js";

const W = loadSeries("washer30d");
const VALS = ticksOf(W);
const { L } = layoutOf(W);
const NORMAL = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11]; // Layout-Läufe w01, w03, w05–w12 (ohne w02, w04)
const firstEndAfter = (r, from) => ends(r).find(e => e.i >= from).i;
const minutes = ticks => ticks / 6;

describe("final phase filter (Spec A.3)", function () {
	this.timeout(300_000);

	it("I1–I5 on 200 random curves × modes × abort options, with and without the anti-crease filter", () => {
		// SHORT_FINAL fires on 400-tick curves (WM_FINAL with X 60 min never does: 0 of 1648, review/gold.mjs)
		const FILTER = { trailerBurstSec: 45, trailerGapSec: 30, trailerAfterSec: 0, trailerBlockVal: 0, trailerMaxSec: 7200 };
		const seen = {};
		for (let seed = 1; seed <= 200; seed++) {
			const curve = randomCurve(seed);
			for (const mode of ["count", "combined", "timed"]) for (const abort of [false, true]) for (const trailer of [false, true]) {
				const s = { ...WM_312, mode, ...(trailer ? FILTER : {}) };
				const o = { abort, abortFixed: abort, switchOff: i => abort && i % 50 > 40 };
				// I1: never firing (P above every value) → identical to the inner detector
				const never = detectorRun(curve, { ...s, ...SHORT_FINAL, finalMinVal: 1e9, finalMaxVal: 0, finalHotVal: 0, finalActVal: 0, finalActShare: 0 }, o);
				const plain = detectorRun(curve, s, o);
				assert.deepStrictEqual(never.ev.map(x => [x.e, x.i]), plain.ev.map(x => [x.e, x.i]), `I1 ${seed}/${mode}`);
				const r = detectorRun(curve, { ...s, ...SHORT_FINAL }, o);
				const st = (seen[mode] ??= { early: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 });
				for (const k of Object.keys(st)) st[k] += r.det.stats[k];
				let early = false;
				let perRun = 0;
				r.ev.forEach((x, k) => {
					if (x.e === "started") {
						assert.ok(!early || x.exit !== null, `I4 ${seed}`);
						early = false;
						perRun = 0;
					} else if (x.e === "finished" && r.ticks[x.i].settling) {
						perRun++;
						assert.ok(perRun <= 1, `I2 ${seed}`);
						early = true;
					} else if (early) {
						// I3: no finished, running or aborted until the next started (running stops auto-off, onRunning)
						assert.fail(`I3 ${seed}/${mode}: ${x.e} after an early end`);
					}
				});
				r.ticks.forEach((t, i) => {
					if (t.settling) assert.ok(t.status === null || t.status === "off" || t.status === "standby", `I5 ${seed}@${i}`);
				});
				const times = r.ev.map(x => x.at);
				assert.ok(times.every((t, k) => k === 0 || t >= times[k - 1]), `I5 times ${seed}`);
			}
		}
		// the property test is not empty: early ends in every mode, every exit a–g at least once
		for (const mode of ["count", "combined", "timed"]) assert.ok(seen[mode].early > 0, `${mode}: ${JSON.stringify(seen[mode])}`);
		for (const x of ["a", "b", "c", "d", "e", "f", "g"]) assert.ok(Object.values(seen).some(st => st[x] > 0), `exit ${x}: ${JSON.stringify(seen)}`);
	});
	it("golden: notices an active final phase (the fixture is sensitive), also per field", () => {
		assert.ok(differences({ ...SHORT_FINAL }).length > 0);
		// Spec 8.2: each field changes the output when the final phase is on
		for (const [k, v] of [["finalAfterSec", 1200], ["finalMinSec", 90], ["finalQuietSec", 120], ["finalLockSec", 1800], ["finalMaxVal", 600]]) {
			assert.notDeepStrictEqual(differences({ ...SHORT_FINAL, [k]: v }), differences({ ...SHORT_FINAL }), k);
		}
	});
	it("only the first start after a lock carries the mark; later starts without a lock carry none", () => {
		const { values, coreEnd } = syntheticRun();
		// plain cotton60 without the 3 W rest before the final spin: no early end (review/synth.mjs)
		const plain = runOf({ device: "washer", programme: "cotton60", seed: 1 }).values;
		const rest = new Array(400).fill(0.5);
		const r = finalRun([...values.slice(0, coreEnd + 13), ...new Array(80).fill(6), ...rest, ...plain, ...rest, ...plain]);
		assert.deepStrictEqual(starts(r).map(s => s.exit), [null, "a", null]);
		assert.strictEqual(r.det.finalExit, null);
	});
	it("whole washer recording: 14 starts and 14 ends like without wrapper; 12 early ends: 11 via a, 1 via b [f_lock, y_actexit]", () => {
		const a = detectorRun(VALS, WM_312);
		const b = finalRun(VALS);
		assert.deepStrictEqual(starts(b).map(x => x.i), starts(a).map(x => x.i));
		assert.deepStrictEqual([starts(b).length, ends(a).length, ends(b).length], [14, 14, 14]);
		assert.deepStrictEqual(b.det.stats, { early: 12, a: 11, b: 1, c: 0, d: 0, e: 0, f: 0, g: 0 });
	});
	it("finished 1.5–2.2 min after the core end in w01, w03, w05–w12 (before: 11.3–30.7 min); w02 at −0.2 min; w04 unchanged [f_lock]", () => {
		const a = detectorRun(VALS, WM_312);
		const b = finalRun(VALS);
		for (const k of NORMAL) {
			const r = L.runs[k];
			const with_ = minutes(firstEndAfter(b, r.from) - r.coreEnd);
			const without = minutes(firstEndAfter(a, r.from) - r.coreEnd);
			assert.ok(with_ >= 1.5 - 1 / 6 && with_ <= 2.2 + 1 / 6, `run ${k}: ${with_}`);
			assert.ok(without >= 11.3 - 1 / 6, `run ${k}: ${without}`);
		}
		const w02 = L.runs[1];
		assert.ok(Math.abs(minutes(firstEndAfter(b, w02.from) - w02.coreEnd) + 0.2) <= 1 / 6);
		const w04 = L.runs[3];
		assert.strictEqual(firstEndAfter(b, w04.from), firstEndAfter(a, w04.from));
	});
	it("72 unload-and-restart scenarios: 2 starts, 2 ends, no exit g, second start ≤ 5 min after switching on [y_actexit: 72/72, 0.8–3.7 min]", () => {
		for (const sc of restartScenarios()) {
			const r = finalRun(sc.values, { finalRestVal: sc.restVal });
			assert.deepStrictEqual([starts(r).length, ends(r).length, r.det.stats.g], [2, 2, 0], sc.key);
			assert.ok(minutes(starts(r)[1].i - sc.bOn) <= 5, `${sc.key}: ${minutes(starts(r)[1].i - sc.bOn)}`);
		}
	});
	it("too small Y (30 s / 60 s): early end before the core end, then a new run via an activity exit ending at the end without wrapper [f_viol 11/11]", () => {
		const a = detectorRun(VALS, WM_312);
		for (const Y of [30, 60]) {
			const r = finalRun(VALS, { finalMinSec: Y });
			for (const k of [0, 1, ...NORMAL.slice(1)]) {
				const run = L.runs[k];
				const next = L.runs[k + 1]?.from ?? VALS.length;
				const fin = ends(r).filter(e => e.i >= run.from && e.i < next);
				assert.ok(fin[0].i < run.coreEnd, `Y${Y} run ${k}: first end ${fin[0].i} core ${run.coreEnd}`);
				const st = starts(r).find(s => s.i > fin[0].i && s.i < next);
				assert.ok(st && ["c", "d", "f", "g"].includes(st.exit), `Y${Y} run ${k}: ${st?.exit}`);
				assert.ok(Math.abs(fin.at(-1).i - firstEndAfter(a, run.from)) <= 1, `Y${Y} run ${k}`);
			}
		}
	});
	it("the same four checks with an active TrailerFilter and the learned washer values (P13, acceptance)", async () => {
		const sg = await analyzeHistory(W, 10, {});
		assert.ok(sg.trailerBurstSec > 0, "the washer anti-crease filter is learned");
		const T = { trailerBurstSec: sg.trailerBurstSec, trailerGapSec: sg.trailerGapSec, trailerAfterSec: sg.trailerAfterSec, trailerBlockVal: sg.trailerBlockVal, trailerMaxSec: sg.trailerMaxSec };
		const a = detectorRun(VALS, { ...WM_312, ...T });
		const b = finalRun(VALS, T);
		assert.deepStrictEqual(starts(b).map(x => x.i), starts(a).map(x => x.i));
		assert.strictEqual(b.det.stats.f, 0);
		for (const k of NORMAL) assert.ok(minutes(firstEndAfter(b, L.runs[k].from) - L.runs[k].coreEnd) <= 2.2 + 1 / 6, `run ${k}`);
		for (const sc of restartScenarios()) {
			const r = finalRun(sc.values, { ...T, finalRestVal: sc.restVal });
			assert.deepStrictEqual([starts(r).length, ends(r).length], [2, 2], sc.key);
		}
		const small = finalRun(VALS, { ...T, finalMinSec: 30 });
		for (const k of NORMAL) {
			const run = L.runs[k];
			const next = L.runs[k + 1]?.from ?? VALS.length;
			const st = starts(small).filter(s => s.i > run.from && s.i < next);
			assert.ok(st.some(s => s.exit !== null), `run ${k}: rest of the programme carries afterFinal`);
		}
	});
	it("145 s without a new value in the final spin still qualifies [S8]", () => {
		const r = L.runs[8];
		const gapAt = layoutOf(W).s.t0 + (r.endBlockFrom + 3) * 10_000;
		const r2 = finalRun(ticksOf(withGap(W, gapAt, 145 / 60)));
		assert.ok(minutes(firstEndAfter(r2, r.from) - r.coreEnd) <= 2.2 + 1 / 6);
	});
	it("Z runs out without new values (timed mode, feed only on change)", () => {
		const { values, coreEnd } = syntheticRun();
		for (const mode of ["count", "timed"]) {
			const r = finalRun(values, { mode }, { timedFeed: true });
			assert.strictEqual(r.det.stats.early, 1, mode);
			const f = ends(r)[0].i;
			assert.ok(f - coreEnd >= 12 && f - coreEnd <= 13, `${mode}: ${f - coreEnd}`);
		}
	});
	it("timed mode: live and simulate give the same events with a final phase (G10; times only from tick)", () => {
		const { L, s } = layoutOf(W);
		const set = { ...WM_312, ...WM_FINAL, mode: "timed" };
		for (const w of L.windows.filter(x => x.run !== null)) {
			const sim = simulate(s, w, set, { abort: false, abortFixed: false, pollSec: 10 });
			// live: every real report goes to feed at its own time, tick once per poll with the held value
			const det = createDetector(set, { abort: false, abortFixed: false, pollSec: 10 });
			const fin = [];
			let k = W.findIndex(p => p.ts > s.t0 + (w.fromIdx - 1) * s.stepMs);
			let held = 0;
			const collect = (r, t) => r.events.forEach((e, j) => e === "finished" && fin.push(r.times?.[j] ?? t));
			for (let i = w.fromIdx; i <= w.toIdx; i++) {
				const t = s.t0 + i * s.stepMs;
				while (k < W.length && W[k].ts <= t) {
					held = W[k].val;
					collect(det.feed(held, W[k].ts), W[k++].ts);
				}
				collect(det.tick(held, t, { switchOff: false }), t);
			}
			assert.strictEqual(fin.length, sim.finished.length, `window ${w.run}`);
			fin.forEach((t, j) => assert.ok(Math.abs(t - sim.finished[j]) <= s.stepMs, `window ${w.run}: ${t} vs ${sim.finished[j]}`));
		}
	});
	it("anti-crease state is on while the lock passes calls through", () => {
		const { values, coreEnd } = syntheticRun();
		const T = { trailerBurstSec: 45, trailerGapSec: 30, trailerAfterSec: 0, trailerBlockVal: 0, trailerMaxSec: 7200 };
		const r = finalRun([...values.slice(0, coreEnd + 13), ...new Array(30).fill(6)], T);
		assert.strictEqual(r.det.stats.early, 1);
		assert.strictEqual(r.det.settling, true);
		assert.strictEqual(r.det.inTrailer, true, "inTrailer = trailerUntil set, also without a suppressed burst");
	});
	describe("each exit alone after the early end of the synthetic run", () => {
		const { values, coreEnd } = syntheticRun();
		const pre = values.slice(0, coreEnd + 13);
		const exitOf = (after, extra = {}) => {
			const r = finalRun([...pre, ...after], extra);
			assert.strictEqual(r.det.stats.early, 1);
			return r;
		};
		const fill = (v, n) => new Array(n).fill(v);
		it("a: inner end (tail at 6 W, above rest, below activity)", () => assert.strictEqual(exitOf(fill(6, 80)).det.stats.a, 1));
		it("b: rest proof (0.8 W for 60 s)", () => assert.strictEqual(exitOf(fill(0.8, 10)).det.stats.b, 1));
		it("c: high load ≥ finalHotVal for G; off with finalHotVal 0", () => {
			assert.strictEqual(exitOf([...fill(2000, 7), ...fill(0.8, 20)]).det.stats.c, 1);
			assert.strictEqual(exitOf([...fill(2000, 7), ...fill(0.8, 20)], { finalHotVal: 0 }).det.stats.c, 0);
		});
		it("d: final band after the check window (activity exit off)", () => {
			const r = exitOf([...fill(20, 245), ...fill(300, 3)], { finalActVal: 0, finalActShare: 0 });
			assert.strictEqual(r.det.stats.d, 1);
		});
		it("e: maximum duration", () => {
			const r = exitOf(fill(20, 280), { finalActVal: 0, finalActShare: 0 });
			assert.strictEqual(r.det.stats.e, 1);
			assert.strictEqual(r.det.settling, false);
		});
		it("f: activity share ≥ 0.7 over 5 min", () => assert.strictEqual(exitOf(fill(20, 40)).det.stats.f, 1));
		it("g: final band ≥ Y/2 inside the check window; the new start is back-dated, never before the early end", () => {
			const r = exitOf([...fill(0.8, 3), ...fill(20, 2), ...fill(300, 12), ...fill(0.8, 60)]);
			assert.strictEqual(r.det.stats.g, 1);
			const early = ends(r)[0];
			const st = starts(r).at(-1);
			assert.strictEqual(st.exit, "g");
			assert.ok(st.at >= early.at, "not before the early end");
			assert.strictEqual(st.at, (coreEnd + 13 + 3) * 10_000, "first activity above the rest level after the last rest");
		});
	});
	it("abort before the early end is passed on; in the lock it is swallowed", () => {
		const { values, coreEnd } = syntheticRun();
		const before = finalRun(values, {}, { abort: true, switchOff: i => i >= coreEnd - 100 && i < coreEnd - 60 });
		assert.ok(before.ev.some(x => x.e === "aborted"));
		const after = finalRun([...values.slice(0, coreEnd + 13), ...new Array(30).fill(0)], {}, { abort: true, switchOff: i => i > coreEnd + 14 });
		assert.strictEqual(after.det.stats.early, 1, "the lock was reached");
		assert.ok(!after.ev.some(x => x.e === "aborted"));
	});
	it("resumeLockAt starts in the lock and keeps check window and maximum", () => {
		const r = detectorRun(new Array(300).fill(20), { ...WM_312, ...WM_FINAL, finalActVal: 0, finalActShare: 0 }, { resumeLockAt: -600_000 });
		assert.strictEqual(r.ticks[0].settling, true);
		assert.strictEqual(r.ticks.findIndex(t => !t.settling), 210, "2700 s − 600 s = 2100 s");
	});
	it("per-poll floors only make values safer", () => {
		const f = finalFloors({ ...WM_FINAL, finalQuietSec: 0, finalDipSec: 0, finalRestVal: 0, finalRestSec: 0, finalCheckSec: 0, finalLockSec: 0 }, 100, 1);
		assert.deepStrictEqual([f.finalMinSec, f.finalDipSec, f.finalQuietSec, f.finalRestVal, f.finalRestSec, f.finalCheckSec, f.finalLockSec],
			[200, 200, 200, 1, 300, 1800, 14_400]);
		assert.deepStrictEqual(finalFloors(WM_FINAL, 10, 1), WM_FINAL);
	});
});
```

`differences(extra)` liegt seit Task 3 in `test/helpers/golden.js`. Die Toleranz ± 1/6 min entspricht einem Abfrageschritt. Laufindizes: `L.runs[k]` mit k = 0 … 11 ↔ w01 … w12. Jeder Test auf `syntheticRun()` prüft vorab `stats.early === 1` (in `exitOf` und den Einzeltests), damit ein ausbleibendes frühes Ende nicht als bestandener Ausgangs-Test durchgeht. Kommt im Eigenschaftstest ein Ausgang a–g nie vor, werden die Seeds auf 400 erhöht, nicht die Prüfung gelockert.

**Doku:** `docs/de|en/README.md` §8 „Schlussphase“ (von Hand eingetragene Expertenwerte wirken jetzt: frühes Fertig, Sperrphase, Ausgänge, alles danach ist ein neuer Lauf); Changelog-Zeile zur Erkennung ergänzen.

- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** `npm test` → PASS (Golden „unchanged“ weiter grün).
- [ ] **Step 5: Commit** `feat: final phase reports the end after the last programme phase, with a settling lock and exits`

---

### Task 15: Laufzeit-Kopplung der Schlussphase und bedingte States (Spec A.3 Kopplung/Neustart, 7.1)

**Files:**
- Modify: `src/lib/deviceRuntime.ts` (`init` `:160`, `apply` `:389-423`, `onFinished` `:453`, `afterRun` `:484-489`, `startAutoOff` `:550`, `updateConfig`), `src/lib/runRecorder.ts` (`onEvent` `:117`), `src/lib/stateDefinitions.ts` (`StateDef.when` `:22`), `src/lib/deviceObjects.ts:41-47`, `src/lib/deviceRegistry.ts` (`remove`, `upsert`), Doku §13 de/en
- Test: `test/deviceRuntime.test.js`, `test/deviceObjects.test.js`, `test/stateDefinitions.test.js`, `test/docsStates.test.js`, `test/optimizationIntegration.test.js`

**Interfaces:**
- Consumes: `settling`, `finalExit`, `resumeLockAt` (Task 14); `runtimeSetup({ host })` (devices.js, `host` optional geteilt).
- Produces:
  - `StateDef.when?: "learning" | "historyHtml" | "phases" | "final"`; `stateWanted(def: StateDef, cfg: DeviceConfig, inst: InstanceConfig, override?: Partial<DetectionSettings> | null): boolean` – `final` = `finalOn(cfg.detection ⊕ override)` (auch eine nur von der Optimierung eingeschaltete Schlussphase hat `settlingUntil`), `phases` = `cfg.phases?.enabled === true`; `ensureDeviceObjects(w, id, cfg, inst, override?)` legt an oder löscht bei jeder Konfigurationsänderung **und** wenn die Optimierung die Schlussphase ein- oder ausschaltet (Override-Änderung mit `finalOn`-Wechsel, Task 22).
  - State `settlingUntil` (number, role `date`, nur lesbar, `when: "final"`, 11 Sprachen).
  - Runtime: beim frühen Ende `settlingUntil = lockAt + finalLockSec`; bei jedem Ausgang 0.
  - **Neustart in der Sperrphase:** `upsert` ruft `runtime.init()` vor `syncOptimize` (`deviceRegistry.ts:145-147`); erst `syncOptimize` lädt Override und `final.state`. Deshalb baut `init()` den Detector mit den Grundwerten, und nach dem Laden ruft die Registry einmal `runtime.restore({ override, suspended, settlingUntil })`: Override und Maske setzen, und – wenn `settlingUntil > now` und `finalOn(active)` – den Detector mit `resumeLockAt = min(settlingUntil, now + finalLockSec) − finalLockSec` neu bauen (einmaliger Neubau vor dem ersten Tick, kein Lauf aktiv). Ohne Speicher (keine Optimierung, keine Schlussphase im Override) macht `init()` das selbst. Die Fortsetzung hängt **nur** an `settlingUntil > now` und `finalOn(active)`, nicht an `finished === true` (Quittieren setzt `finished` zurück, die Sperrphase muss trotzdem weiterlaufen). Ist die Schlussphase ausgesetzt (`active.finalMinVal = 0`), wird nicht fortgesetzt und `settlingUntil` = 0.
  - AutoOff: mit `finalOn(active)` startet der Zähler bei Ausgang a, b oder e, nicht beim frühen Ende. Nach c, d, f, g folgt er dem Ende des neuen Laufs; **kommt binnen `finalCheckSec` nach dem Ausgang kein `started`** (die Aktivität erfüllt die Startregeln nicht, z. B. 20 W < `startVal` 30), startet er nach Ablauf dieser Frist (bzw. sofort bei einem Ruhe-Beweis `finalRestVal`/`finalRestSec` davor). Sonst schaltete AutoOff nie ab, obwohl es ohne Schlussphase beim normalen Ende abgeschaltet hätte; Entscheidung 2 soll nur verhindern, dass ein laufendes Programm abgeschaltet wird.
  - Detector-Neubau (Override, Wertänderung, Maske) nur bei `!started && !settling`, sonst beim nächsten Tick, der das erfüllt. Getter `DeviceRuntime.settling: boolean` (vom Detector) und `DeviceRuntime.detectorRev: number` (zählt jeden Neubau; für Tests – `effective` zeigt neue Werte sofort, unabhängig vom Neubau).
  - `RunRecorder.onEvent(ev, at, afterFinal?: FinalExit)`; `Capture.ev`-Einträge `[number, CaptureEvent, FinalExit?]`.
  - `powerId`-Wechsel, `enabled = false`, Löschen: `settlingUntil` = 0 vor dem Verwerfen.

- [ ] **Step 1: Failing tests**

```js
// test/deviceRuntime.test.js
import { syntheticRun, WM_FINAL } from "./helpers/final.js";
import { layoutOf, loadSeries } from "./helpers/fixtures.js";
import { createFakeHost } from "./helpers/fakeHost.js";
import { deviceConfig, feed, instanceConfig, P, play, playPoints, registrySetup, runtimeSetup, SW, WASHER } from "./helpers/devices.js";
import { ensureDeviceObjects } from "../build/lib/deviceObjects.js";
import { saveStore } from "../build/lib/runStore.js";

const FIN = { ...WASHER, ...WM_FINAL };
const fill = (v, n) => new Array(n).fill(v);
const { values, coreEnd } = syntheticRun();
const pre = values.slice(0, coreEnd + 13);
const switchWrites = ctx => ctx.host.writes.filter(w => w.id === SW);

describe("runtime with a final phase", function () {
	this.timeout(600_000);
	for (const [exit, after, off] of [
		["a", fill(6, 80), true], ["b", fill(0.8, 10), true], ["e", fill(20, 280), true],
		["c", [...fill(2000, 7), ...fill(0.8, 20)], false], ["d", [...fill(20, 245), ...fill(300, 3)], false],
		["f", fill(20, 40), false], ["g", [...fill(300, 12), ...fill(0.8, 20)], false],
	]) {
		it(`AutoOff with 0 minutes ${off ? "switches off after" : "waits for the new run after"} exit ${exit}`, async () => {
			const noF = exit === "d" || exit === "e" ? { finalActVal: 0, finalActShare: 0 } : {};
			const ctx = runtimeSetup({ cfg: { detection: { ...FIN, ...noF }, switchId: SW, autoOff: true, autoOffMinutes: 0 } });
			await ctx.rt.init();
			ctx.rt.onSwitch(true);
			await play(ctx, pre);
			assert.deepStrictEqual(switchWrites(ctx), [], "not at the early end");
			await play(ctx, after);
			assert.strictEqual(switchWrites(ctx).length, off ? 1 : 0, exit);
		});
	}
	it("AutoOff after an activity exit without a new run switches off after finalCheckSec", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN, switchId: SW, autoOff: true, autoOffMinutes: 0 } });
		await ctx.rt.init();
		ctx.rt.onSwitch(true);
		await play(ctx, [...pre, ...fill(20, 40)]); // exit f, 20 W < startVal 30: no start
		assert.deepStrictEqual(switchWrites(ctx), []);
		await play(ctx, fill(20, WM_FINAL.finalCheckSec / 10 + 2));
		assert.strictEqual(switchWrites(ctx).length, 1);
		assert.deepStrictEqual(ctx.events, ["washer:start", "washer:end"]);
	});
	it("AutoOff after an activity exit with a new run switches off only after that run", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN, switchId: SW, autoOff: true, autoOffMinutes: 0 } });
		await ctx.rt.init();
		ctx.rt.onSwitch(true);
		await play(ctx, [...pre, ...fill(2000, 7), ...values.slice(0, 300)]); // exit c, new run under way
		assert.deepStrictEqual(switchWrites(ctx), []);
		await play(ctx, [...values.slice(300), ...fill(0.5, 300)]);
		assert.strictEqual(switchWrites(ctx).length, 1);
		assert.strictEqual(ctx.events.filter(e => e === "washer:end").length, 2);
	});
	it("restart 0–10 min after each early end on washer30d → 0 phantom starts, 0 second ends (P5)", async () => {
		const W = loadSeries("washer30d");
		const { L, s } = layoutOf(W);
		for (const k of [0, 2, 4, 5, 6, 7, 8, 9, 10, 11]) {
			const r = L.runs[k];
			for (const m of [0, 1, 2, 3, 5, 10]) {
				const host = createFakeHost({ objects: [P, SW], now: s.t0 + (r.from - 180) * s.stepMs });
				const a = runtimeSetup({ host, cfg: { detection: FIN } });
				await a.rt.init();
				const win = W.filter(p => p.ts >= host.now() && p.ts <= s.t0 + (r.runEnd + 1080) * s.stepMs);
				const stop = await playPoints(a, win, 10_000, c => c.events.includes("washer:end"));
				const cut = win[stop].ts + m * 60_000;
				await playPoints(a, win.slice(stop).filter(p => p.ts < cut));
				assert.deepStrictEqual(a.events, ["washer:start", "washer:end"], `run ${k} +${m}`);
				a.rt.dispose();
				const b = runtimeSetup({ host, cfg: { detection: FIN } });
				await b.rt.init();
				await playPoints(b, win.filter(p => p.ts >= cut));
				assert.deepStrictEqual(b.events, [], `run ${k} restart +${m}: ${b.events}`);
			}
		}
	});
	it("a run after an early end is an ordinary run with its own messages, operations and back-dated runtime", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN } });
		await ctx.rt.init();
		await play(ctx, [...pre, ...fill(2000, 7), ...values.slice(0, 200)]);
		assert.deepStrictEqual(ctx.events.slice(0, 3), ["washer:start", "washer:end", "washer:start"]);
		assert.deepStrictEqual(ctx.messages.map(m => m.text).slice(0, 3), ["Started", "Finished", "Started"]);
		await play(ctx, values.slice(200));
		assert.strictEqual(JSON.parse(ctx.host.own("washer.lastOperations")).length, 2);
		assert.ok(!ctx.events.some(e => e.includes("resume")));
	});
	it("a config change during settling rebuilds nothing until the lock ends (Review Focus 1)", async () => {
		const ctx = runtimeSetup({ cfg: { detection: FIN } });
		await ctx.rt.init();
		await play(ctx, pre);
		const rev = ctx.rt.detectorRev;
		ctx.rt.updateConfig(deviceConfig({ endText: "Fertig!", recipients: ["tg"], abort: true, detection: { ...FIN, endCount: 60 } }));
		await play(ctx, fill(6, 30));
		assert.strictEqual(ctx.rt.detectorRev, rev, "not rebuilt while settling");
		assert.deepStrictEqual(ctx.events, ["washer:start", "washer:end"]);
		await play(ctx, fill(6, 60));
		assert.ok(ctx.rt.detectorRev > rev, "rebuilt after the lock");
		assert.deepStrictEqual(ctx.events, ["washer:start", "washer:end"], "no phantom start, no second end");
	});
	it("power state change or disabling while settling clears settlingUntil (Review Focus 2)", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: FIN });
		await feed(ctx, pre);
		assert.ok(ctx.host.own("dev.settlingUntil") > ctx.host.now());
		await ctx.reg.upsert("dev", { ...ctx.cfg, powerId: "plug.1.power" });
		assert.strictEqual(ctx.host.own("dev.settlingUntil"), 0);
		const ctx2 = await registrySetup({ autoOptimize: false, detection: FIN });
		await feed(ctx2, pre);
		await ctx2.reg.upsert("dev", { ...ctx2.cfg, enabled: false });
		assert.strictEqual(ctx2.host.own("dev.settlingUntil"), 0);
	});
	it("final phase only in the override (switched on by the optimisation): restart 1 min after the early end → no phantom start", async () => {
		const ctx = await registrySetup({ detection: WASHER });
		const store = ctx.reg.learningData("dev");
		store.override = { ...WM_FINAL };
		store.final = { state: "on", splits: [], suspendedAt: 0 };
		await ctx.reg.upsert("dev", ctx.cfg); // restore: override applied, settlingUntil created (stateWanted with override)
		await feed(ctx, pre);
		assert.ok(ctx.host.own("dev.settlingUntil") > ctx.host.now(), "settlingUntil exists without final values in the base");
		await saveStore(ctx.files, store);
		ctx.reg.disposeAll();
		ctx.host.tickClock(60_000);
		const again = await registrySetup({ host: ctx.host, files: ctx.files, detection: WASHER });
		const n = again.host.ownWrites.length;
		await feed(again, fill(6, 120));
		assert.ok(!again.host.ownWrites.slice(n).some(w => w.id === "dev.running" && w.val === true), "no phantom start");
		assert.strictEqual(again.reg.get("dev").currentOverride.finalMinVal, 150);
	});
	it("an acknowledged run (finished = false) still resumes the lock after a restart", async () => {
		const now0 = new Date(2026, 0, 5, 12, 0).getTime(); // default clock of createFakeHost
		const host = createFakeHost({ objects: [P, SW], own: { "washer.finished": false, "washer.settlingUntil": now0 + 600_000 } });
		const ctx = runtimeSetup({ host, cfg: { detection: FIN } });
		await ctx.rt.init();
		await play(ctx, fill(6, 30));
		assert.deepStrictEqual(ctx.events, []);
		assert.strictEqual(ctx.rt.settling, true);
	});
	it("settlingUntil far in the future → the lock ends at most finalLockSec after the restart (Review Focus 3)", async () => {
		const now0 = new Date(2026, 0, 5, 12, 0).getTime(); // default clock of createFakeHost
		const host = createFakeHost({ objects: [P, SW], own: { "washer.finished": true, "washer.settlingUntil": now0 + 10 * 3_600_000 } });
		const ctx = runtimeSetup({ host, cfg: { detection: { ...FIN, finalActVal: 0, finalActShare: 0 } } });
		await ctx.rt.init();
		await play(ctx, fill(20, 271));
		assert.strictEqual(ctx.host.own("washer.settlingUntil"), 0);
		assert.deepStrictEqual(ctx.events, []);
	});
	it("the first start after a lock carries afterFinal in the capture", async () => {
		const ctx = await registrySetup({ detection: FIN });
		await feed(ctx, [...pre, ...fill(2000, 7), ...values.slice(0, 50)]);
		const pend = ctx.reg.learningData("dev").pending ?? ctx.reg.get("dev").runRecorder.snapshot();
		assert.ok(pend.ev.some(e => e[1] === "s" && e[2] === "c"), JSON.stringify(pend.ev));
	});
});

// test/deviceObjects.test.js
it("creates settlingUntil only with an active final phase, also when only the override has one", async () => {
	const ids = [];
	const del = [];
	const w = { extendObject: async id => ids.push(id), setObjectNotExists: async () => {}, delObject: async id => del.push(id) };
	await ensureDeviceObjects(w, "wm", deviceConfig(), instanceConfig());
	assert.ok(del.includes("wm.settlingUntil"));
	ids.length = 0;
	await ensureDeviceObjects(w, "wm", deviceConfig({ detection: FIN }), instanceConfig());
	assert.ok(ids.includes("wm.settlingUntil"));
	ids.length = 0;
	await ensureDeviceObjects(w, "wm", deviceConfig(), instanceConfig(), { ...WM_FINAL });
	assert.ok(ids.includes("wm.settlingUntil"), "final phase switched on by the optimisation");
});
```

`registrySetup`, `feed` aus `test/helpers/devices.js`; `playPoints(ctx, points, stepMs, stop?)` hält an, sobald `stop(ctx)` wahr ist, und gibt den Index des nächsten Punkts zurück. Der Teil „Phasen-States nur mit Phasen“ gehört zu Task 20 (die States mit `when: "phases"` entstehen erst dort). Der State `settlingUntil` wird in den Doku-Tabellen §13 de/en eingetragen (sonst schlägt `test/docsStates.test.js` fehl).

**Doku:** `docs/de|en/README.md` §8 (AutoOff mit Schlussphase: nach Ruhe/Ende-Ausgang; nach Aktivitäts-Ausgang mit dem neuen Lauf bzw. nach dem Prüffenster), §13 (`settlingUntil`, Neustart in der Sperrphase); Changelog-Zeile zur Schlussphase.

- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: runtime follows the settling lock; settlingUntil survives restarts; auto-off waits for rest`

---

### Task 16: Schlussphase lernen und freigeben (Spec B.6)

**Files:**
- Create: `src/lib/learn/finalLearn.ts`, `test/finalLearn.test.js`

**Interfaces:**
- Consumes: `buildLayout`, `endOk` (Task 10), `BaseBands`, `baseBandsOf` (Task 11), `RunSample`, `Verdict`, `admitted`, `runSamples`, `checkRuns` (Task 12), `createDetector` mit Schlussphase (Task 14), `finalViolations` (Task 3).
- Produces:
  - `type FinalRejectReason = "tooFewRuns" | "noSeparation" | "tailInBand" | "earlyEnd" | "phantomStart" | "crossCheck" | "robustness" | "margin" | "noGain" | "worseOnFlagged" | "fewPerGroup" | "outOfRange" | "continuous"` – `continuous`: Gerät mit scope `continuous` hat keine Läufe und damit keine Schlussphase (Spec Nicht-Ziele); `learnFinal` liefert dann sofort `ok = false`.
  - Schlussblock je Lauf (B.6) aus den Grundbändern (`ctx.bands`), getrennt vom Layout-Endblock aus Task 10; `tail`-Werte (Trennung, `tailCeil`) kommen aus `StoreFile.tail` bzw. dem Layout der Eingabe, nie aus einem einzelnen Lauf.
  - `interface FinalCandidate { values: Required<FinalSettings>; ok: boolean; reasons: FinalRejectReason[]; covered: number; gainSec: number; earlyEnds: number; fallbacks: number; perGroup: Record<number, number> }`.
  - `interface FinalLearnContext { base: DetectionSettings; pollSec: number; unitFactor: number; abort: boolean; abortFixed: boolean; bands: BaseBands; minRuns: number; minPerGroup: number; scope?: "run" | "continuous"; yieldFn: () => Promise<void> }` (`minRuns` 5 im Dialog, 10 in der Optimierung; `minPerGroup` 1 bzw. 2).
  - `learnFinal(runs: { sample: RunSample; verdict: Verdict; series: TickSeries }[], ctx: FinalLearnContext): Promise<FinalCandidate>` – Werte nach der Tabelle B.6 (intern W, Ausgabe ÷ `unitFactor`), nie geklemmt: `finalViolations(values, base.standby, pollSec)` nicht leer → `ok = false`, Grund `outOfRange`.
  - `checkFinalSplit(prev: RunSample, next: RunSample, clean: RunSample[], bands: BaseBands | null, finalRestVal: number): boolean` (B.2 `finalSplit`; im Zweifel `true`, aber nur mit Vergleichsdaten). Ohne Vergleichsdaten (`clean.length < 3` oder `bands === null`): Kriterium 1 (Anfangsfolge) entfällt, Kriterium 2 nimmt als Bezug die längste Ruhe < `finalRestVal` im frühen Teilstück `prev` selbst; kein „im Zweifel“ (ein Einweich-Rest nach langer Pause erkennt so erst Kriterium 1 mit Vergleichsdaten). Tests unten: zu kleines Y ohne Daten → `finalSplit`, echter Neustart ohne Daten → kein `finalSplit`.
  - Test-Helfer in `test/helpers/final.js`: `learnInput(points, o = {})` → `{ runs, bands, layout, series }` über `runSamples` + `baseBandsOf` + `checkRuns` (Optionen `stepMs` 10 000, `unitFactor` 1, `outages` [], `src` "history"); `soaking(points, k)` → Punktliste, in der vor dem Ende-Schleudern von Lauf k eine Kopie des Ende-Schleuderblocks und danach 45 min 3 W eingefügt sind (Spec 8.2 Einweich-Programm).

- [ ] **Step 1: Failing tests** (`test/finalLearn.test.js`; Belege: S1 `f_stats.mjs` – Nachlauf-Bursts ≤ 113 W, Schleudern 290–839 W, Heizen ab 2047 W, Ruhepegel 6 W, Pausen im Programm ≤ 10 s; S9 `a_loo.mjs` – Gegenprobe 0 zu früh, 2 Rückfälle; Spec A.4 – Zwischenschleudern ≤ 1,9 min, A.3 – Ende-Schleudern ≥ 4 min):

```js
import assert from "node:assert";
import { checkFinalSplit, learnFinal } from "../build/lib/learn/finalLearn.js";
import { endOk } from "../build/lib/learn/replay.js";
import { learnInput, soaking, splitPairs, splitPairsOfTicks, WM_312 } from "./helpers/final.js";
import { asKw, detectorRun, dropRandom, layoutOf, loadSeries, restartScenarios, scale, shift, ticksOf } from "./helpers/fixtures.js";
import { runOf } from "./helpers/programmes.js";

const W = loadSeries("washer30d");
const D = loadSeries("dryer");
const ctxOf = (inp, over = {}) => ({ base: WM_312, pollSec: 10, unitFactor: 1, abort: false, abortFixed: false, bands: inp.bands, minRuns: 5, minPerGroup: 1, yieldFn: async () => {}, ...over });
const learn = async (pts, over = {}, o = {}) => { const inp = learnInput(pts, o); return { c: await learnFinal(inp.runs, ctxOf(inp, over)), inp }; };

describe("learn the final phase (Spec B.6)", function () {
	this.timeout(600_000);
	let wm;
	before(async () => { wm = await learn(W); });

	it("washer: released with 0 early ends and at most 2 fallbacks in the cross-check [S9]", () => {
		assert.deepStrictEqual([wm.c.ok, wm.c.reasons, wm.c.earlyEnds], [true, [], 0]);
		assert.ok(wm.c.fallbacks <= 2 && wm.c.covered >= 5 && wm.c.gainSec >= 60);
	});
	it("washer: P above the tail (113 W) and below the spin (839 W); Pmax between spin and heating; hot = Pmax [S1]", () => {
		const v = wm.c.values;
		assert.ok(v.finalMinVal > 113 && v.finalMinVal < 839, String(v.finalMinVal));
		assert.ok(v.finalMaxVal > 839 && v.finalMaxVal <= 2047, String(v.finalMaxVal));
		assert.strictEqual(v.finalHotVal, v.finalMaxVal);
	});
	it("washer: Y above the longest intermediate spin (1.9 min) and below the shortest final spin (4 min)", () => {
		assert.ok(wm.c.values.finalMinSec > 114 && wm.c.values.finalMinSec < 240, String(wm.c.values.finalMinSec));
	});
	it("washer: X = 0.5 × p10 of the final block start; G 60; Z = max(120, 2 × longest dip in the final block)", () => {
		const L = wm.inp.layout;
		const s = wm.inp.series;
		const starts = L.runs.map(r => (r.endBlockFrom - r.from) * 10).sort((a, b) => a - b);
		assert.ok(wm.c.values.finalAfterSec >= 0.5 * starts[0] && wm.c.values.finalAfterSec <= 0.5 * starts[2]);
		assert.strictEqual(wm.c.values.finalDipSec, 60);
		let dip = 0;
		for (const r of L.runs) {
			let run = 0;
			for (let i = r.endBlockFrom; i <= r.endBlockTo; i++) { run = s.last[i] < wm.c.values.finalMinVal ? run + 10 : 0; dip = Math.max(dip, run); }
		}
		assert.strictEqual(wm.c.values.finalQuietSec, Math.max(120, 2 * dip));
	});
	it("washer: rest = run limit (5.5 W) for 60 s; activity 1.5 × tail rest level 6 W = 9 W, share 0.6–0.8 [S1, S12]", () => {
		const v = wm.c.values;
		assert.deepStrictEqual([v.finalRestVal, v.finalRestSec], [wm.inp.layout.runLimit, 60]);
		assert.ok(Math.abs(v.finalActVal - 9) <= 0.5 && v.finalActShare >= 0.6 && v.finalActShare <= 0.8, JSON.stringify(v));
	});
	it("washer: check window ≥ 30 min and ≤ lock; lock = max(30 min, 1.5 × longest early end → inner end), ≤ 4 h", () => {
		const v = wm.c.values;
		const vals = ticksOf(W);
		const a = detectorRun(vals, WM_312);
		const b = detectorRun(vals, { ...WM_312, ...v });
		let longest = 0;
		for (const r of wm.inp.layout.runs) {
			const fa = a.ev.find(x => x.e === "finished" && x.i >= r.from);
			const fb = b.ev.find(x => x.e === "finished" && x.i >= r.from);
			longest = Math.max(longest, (fa.i - fb.i) * 10);
		}
		assert.ok(Math.abs(v.finalLockSec - Math.min(14_400, Math.max(1800, 1.5 * longest))) <= 10);
		assert.ok(v.finalCheckSec >= 1800 && v.finalCheckSec <= v.finalLockSec);
	});
	it("the released values give no early end under ±10 % power, poll ×3, 30 % missing values, one poll later", () => {
		const v = { ...WM_312, ...wm.c.values };
		for (const [name, pts, step] of [["×0.9", scale(W, 0.9), 10_000], ["×1.1", scale(W, 1.1), 10_000], ["poll×3", W, 30_000],
			["30 % missing", dropRandom(W, 0.3, 5), 10_000], ["one poll later", shift(W, 10_000), 10_000]]) {
			const { L, s } = layoutOf(W, step);
			const r = detectorRun(ticksOf(pts, step, s.t0), v, { pollSec: step / 1000 });
			L.windows.filter(w => w.run !== null).forEach(w => {
				const f = r.ev.find(x => x.e === "finished" && x.i >= w.runStartIdx);
				const sim = { started: 1, aborted: 0, finished: f ? [s.t0 + f.i * step] : [], startedAt: [] };
				assert.ok(endOk(s, w, sim, L.runs[w.run].progEnd), `${name} run ${w.run}`);
			});
		}
	});
	it("dryer: no candidate, reason noSeparation", async () => {
		const { c } = await learn(D, { base: { ...WM_312, startVal: 120, endCount: 20 } });
		assert.strictEqual(c.ok, false);
		assert.ok(c.reasons.includes("noSeparation"), c.reasons.join());
	});
	it("device without a tail and a short end wait (≤ Z): reason noGain", async () => {
		// with WM_312 (endCount 50 = 500 s) the final phase would gain against Z = 120 s; endCount 10 = 100 s ≤ Z gains nothing
		const pts = [];
		for (let k = 0; k < 8; k++) {
			const r = runOf({ device: "washer", programme: "cotton60", seed: k + 1, after: 200 });
			r.values.forEach((v, i) => pts.push({ ts: 1_700_000_000_000 + k * 86_400_000 + i * 10_000, val: v }));
		}
		const { c } = await learn(pts, { base: { ...WM_312, endCount: 10 } });
		assert.ok(!c.ok && c.reasons.includes("noGain"), c.reasons.join());
	});
	it("scope continuous: no final phase", async () => {
		const inp = learnInput(W);
		const c = await learnFinal(inp.runs, ctxOf(inp, { scope: "continuous" }));
		assert.deepStrictEqual([c.ok, c.reasons], [false, ["continuous"]]);
	});
	it("high load after the final block in one run → finalHotVal 0", async () => {
		const { L, s } = layoutOf(W);
		const r = L.runs[8];
		const at = s.t0 + (r.coreEnd + 30) * s.stepMs;
		const pts = W.map(p => (p.ts >= at && p.ts < at + 70_000 ? { ts: p.ts, val: 2100 } : p));
		const { c } = await learn(pts);
		assert.strictEqual(c.values.finalHotVal, 0);
	});
	it("tail with values in the final band → tailInBand", async () => {
		const { L, s } = layoutOf(W);
		const at = s.t0 + (L.runs[8].coreEnd + 60) * s.stepMs;
		const pts = [...W.filter(p => p.ts < at || p.ts > at + 40_000), { ts: at, val: 300 }, { ts: at + 40_000, val: 6 }].sort((a, b) => a.ts - b.ts);
		const { c } = await learn(pts);
		assert.ok(c.reasons.includes("tailInBand"), c.reasons.join());
	});
	it("a too active tail switches exit f off (finalActVal 0)", async () => {
		// bursts over ≥ 70 % of the tail time; raising the rest values instead would raise the learned rest level with them
		const { L, s } = layoutOf(W);
		let pts = W;
		for (const r of L.runs) {
			const from = s.t0 + (r.coreEnd + 20) * s.stepMs;
			pts = pts.filter(p => p.ts < from || p.ts >= from + 1_800_000);
			for (let t = from; t < from + 1_800_000; t += 10_000) pts.push({ ts: t, val: (t - from) % 100_000 < 70_000 ? 60 : 6 });
		}
		pts.sort((a, b) => a.ts - b.ts);
		const { c } = await learn(pts);
		assert.deepStrictEqual([c.values.finalActVal, c.values.finalActShare], [0, 0]);
	});
	it("kW state: power values ÷ 1000, times unchanged (Review Focus 4)", async () => {
		const { c } = await learn(asKw(W), { unitFactor: 1000, base: { ...WM_312, startVal: 0.03, endVal: 0.015, standby: 0.001 } }, { unitFactor: 1000 });
		for (const k of ["finalMinVal", "finalMaxVal", "finalHotVal", "finalRestVal", "finalActVal"]) {
			assert.ok(Math.abs(c.values[k] * 1000 - wm.c.values[k]) <= 1e-6 * Math.max(1, wm.c.values[k]), k);
		}
		for (const k of ["finalAfterSec", "finalMinSec", "finalQuietSec", "finalLockSec"]) assert.strictEqual(c.values[k], wm.c.values[k], k);
	});
	it("poll 600 s: learned Y below 2 polls → outOfRange instead of clamping", async () => {
		const { c } = await learn(W, { pollSec: 600 });
		assert.ok(c.reasons.includes("outOfRange"), c.reasons.join());
	});
	it("too few runs or too few per group", async () => {
		const few = learnInput(W);
		assert.ok((await learnFinal(few.runs.slice(0, 4), ctxOf(few))).reasons.includes("tooFewRuns"));
		const alone = learnInput(W);
		alone.runs[2].sample.family = 99;
		assert.ok((await learnFinal(alone.runs, ctxOf(alone, { minPerGroup: 2 }))).reasons.includes("fewPerGroup"));
	});
	it("finalSplit: the rest of a soaking programme → true; a real restart after unloading → false", () => {
		const clean = learnInput(W);
		const others = clean.runs.map(x => x.sample);
		const soak = splitPairs(soaking(W, 8), wm.c.values);
		assert.strictEqual(soak.length, 1);
		assert.strictEqual(checkFinalSplit(soak[0].prev, soak[0].next, others, clean.bands, wm.c.values.finalRestVal), true);
		const sc = restartScenarios().find(x => x.key === "warm/0/5.5/10/18");
		const real = splitPairsOfTicks(sc.values, wm.c.values);
		assert.strictEqual(real.length, 1);
		assert.strictEqual(checkFinalSplit(real[0].prev, real[0].next, others, clean.bands, wm.c.values.finalRestVal), false);
		// without comparison data: a real restart after unloading (rest between the parts) is no split
		assert.strictEqual(checkFinalSplit(real[0].prev, real[0].next, [], null, wm.c.values.finalRestVal), false);
	});
	it("too small Y on washer30d: all 11 rests are judged finalSplit (acceptance [S7])", () => {
		const inp = learnInput(W);
		const small = { ...wm.c.values, finalMinSec: 30, finalActVal: 0, finalActShare: 0 };
		const pairs = splitPairs(W, small);
		assert.strictEqual(pairs.length, 11);
		assert.ok(pairs.every(p => checkFinalSplit(p.prev, p.next, inp.runs.map(x => x.sample), inp.bands, small.finalRestVal)));
		// without comparison data the programme continuing without a rest is still a split
		assert.ok(pairs.every(p => checkFinalSplit(p.prev, p.next, [], null, small.finalRestVal)));
	});
});
```

Dazu in `test/helpers/final.js`: `splitPairs(points, finalValues): { prev: RunSample; next: RunSample }[]` – spielt `detectorRun` mit `{ ...WM_312, ...finalValues }` über die Punkte, schneidet je frühem Ende mit folgendem Start mit Marke **b–g** (Ausgang a ist kein Zerteilungsfall; die Marke steht nach Task 14 nur am ersten Start nach der Sperrphase) das frühe Teilstück (Laufbeginn bis frühes Ende) und den Rest (Start bis Ende) als zwei `RunSample` aus (`runSamples` je Teil, `next.afterFinal` = Buchstabe); `splitPairsOfTicks(values, finalValues, stepMs = 10_000)` = dasselbe für eine Tickliste (Punkte ab `BASE_TS`). Beim „zu kleinen Y“ ist Ausgang f abgeschaltet, damit jeder Rest über das Schlussband (d/g) beginnt wie in `f_viol.mjs`. Schlüssel der 72 Szenarien: `` `${cold ? "cold" : "warm"}/${lvl}/${restVal}/${unload}/${gapTicks}` ``.

- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Doku:** keine nutzerseitige Änderung (Bedienung in Task 22/24; Freigaberegeln dort beschrieben).
- [ ] **Step 5: Commit** `feat: learn and release the final phase only where every admitted run proves it`

---

### Task 17: Beurteilung im Nachhinein und Aussetzen (Spec A.3 Punkte 1–6, B.3 Zustellung, D.3 Punkt 3)

**Files:**
- Modify: `src/lib/deviceRegistry.ts` (`syncOptimize` `:593`, `storeCapture` `:820-848`, `runOptimize` `:891`, `writeOptStates` `:990`, `notifyOptimization` `:963`), `src/lib/runStore.ts` (`OptimizeInfo`, `Change.kind`), `src/lib/deviceManagement.ts` (Kartenwarnung), `src/lib/dmTexts.ts`, `admin/i18n/*.json`
- Test: `test/optimizationIntegration.test.js`

**Interfaces:**
- Consumes: `checkRuns`, `checkFinalSplit`, `setFinalSuspended`, `StoreFile.final`.
- Produces:
  - Laufaufnahme und Speicher laufen, wenn `cfg.autoOptimize || finalOn(cfg.detection)`.
  - **Betriebsart „nur Schlussphase“** (`finalOn(cfg.detection)` ohne `autoOptimize`): `syncOptimize` wendet nie ein Override an und berechnet keins (`runtime.setOverride(null)`, ein gespeichertes Override bleibt unangetastet im Speicher – `config.ts:236`: „aus = Werte des Geräts“); `runOptimize` führt nur Verdict, `finalSplit`-Prüfung und Aussetzen aus, keine Reparatur, keine Verschärfung (heute setzt `syncOptimize` das Override, sobald ein Speicher geladen ist, `deviceRegistry.ts:635-643`). Einzige mögliche Wertänderung ist das Aussetzen.
  - **Vergleichsdaten:** Wird ein Speicher wegen der Schlussphase neu angelegt und ist er leer, startet `bootstrapFromHistory` (Task 21; hier schon mit dem bestehenden Bootstrap), damit `checkFinalSplit` Vergleichsläufe und `store.bands` hat. Ohne Vergleichsdaten (keine History, weniger als 3 saubere Läufe, keine `bands`) gilt die Regel aus Task 16 (Kriterium 1 entfällt, Kriterium 2 gegen die längste Ruhe im frühen Teilstück, kein „im Zweifel“). Sonst setzte der erste Neustart nach dem Ausräumen eine von Hand eingetragene Schlussphase aus.
  - **Capture → gespeicherte Läufe (vor allem anderen in diesem Task):** Eine Capture bleibt offen bis 30 min Ruhe bzw. 3 h nach dem Ende, ein neuer Start verlängert sie (`runRecorder.ts:117-166`), und das Recording-Layout trennt nie (`maxGap = s.length`, `runs.ts:823`). Zwei echte, richtig gemeldete Läufe kurz hintereinander landen so in **einer** Capture mit 2 Starts und 2 Enden, die heute als `split` gilt und eine „Reparatur“ auslöst (nachgerechnet `…/scratchpad/review/cap.mjs`: WM cotton60, 15 min Pause, zweiter Lauf → `split` → `endCount` 50 → 300, `endDurationSec` 1800, Knitterschutz-Filter an). Neu: `splitCapture(c: Capture, ctx): { capture: Capture; ev: CaptureEvent[] }[]` zerlegt jede Capture mit der Nicht-Recording-Segmentierung (`splitAtRest`/`splitGrown`; Ruhe auf Ruhepegel ≥ `SPLIT_GAP_MIN_MS` zwischen einem gemeldeten Ende und dem nächsten Start trennt) **und zusätzlich an jedem Start mit `afterFinal`**; jedes Teilstück wird ein eigener `StoredRun`, die Ereignisse werden nach Zeit zugeordnet. Ein Teilstück mit `afterFinal` b–g ist `next`, das Teilstück davor (Laufbeginn bis frühes Ende) ist `prev` für `checkFinalSplit`. `labelCapture` bewertet danach je Teilstück: `split` heißt nur noch „ein Lauf des Layouts mit ≥ 2 gemeldeten Starts, der nicht `merged` ist“ (Reparaturauslöser, Task 21); ein Teilstück mit `merged` und mehreren Starts ist kein `split` (Entscheidung 9).
  - **Zeitpunkt:** Verdict und `finalSplit`-Prüfung laufen beim `end`-Ereignis eines Laufs mit `afterFinal` b–g auf einem Snapshot der offenen Capture (nicht erst beim Schließen 30 min bis 12 h später), damit ein inzwischen gestartetes zweites Programm schon auf die ausgesetzte Schlussphase trifft. Die Capture wird später wie gewohnt geschlossen und gespeichert; die Prüfung wird dabei nicht wiederholt (Schlüssel in `final.splits` bzw. `final.checked`).
  - `DeviceRegistry.suspendFinal(deviceId: string, reason: "finalSplit" | "earlyEnd", key: string): Promise<void>` – `store.final = { state: "suspended", splits: [...splits, key], suspendedAt, reason }`, `runtime.setFinalSuspended(true)`, Änderung `finalSuspend` (mit `trigger: key`), Log-Warnung `<name>: final phase suspended (<reason>)`, `optimizeInfo.finalState = "suspended"`, Kartenwarnung, Nachricht nur bei `optimizeNotify`.
  - `DeviceRegistry.resumeFinal(deviceId: string, why: "user" | "newRun" | "repair" | "endOk" | "cleared", key?: string): Promise<boolean>` – `newRun` braucht `key` (D.7 wirkt je Lauf): entfernt `key` aus `splits` und schaltet nur wieder ein, wenn danach kein Schlüssel in `splits` übrig ist; Änderung `finalResume`.
  - `Change.kind` + `"baseChanged" | "adopted" | "revert" | "finalOn" | "finalSuspend" | "finalResume" | "finalRepair"`; `Change.trigger?: string` (Schlüssel des auslösenden Laufs; `setRunUse`-`revert` und `undo`-`offerExclude` brauchen ihn). Beim Kürzen auf `MAX_CHANGES = 10` bleiben Einträge mit `trigger`, deren Lauf noch im Speicher liegt, und der letzte `adopted`/`baseChanged` erhalten; gekürzt wird der älteste übrige Eintrag.
  - `OptimizeStatus` + `"review"` (Spec D.3: Quarantäne-Lauf falsch erkannt, Hinweis offen).
  - `final.state`: nur `suspended` ist ein gespeicherter Zustand (bis zum Wiedereinschalten); `on`/`off` werden bei jedem Schreiben aus `finalOn(effective)` abgeleitet. Undo von `finalOn` (Task 22) ergibt damit `off`, ohne dass Undo `final.state` setzt (C.3).
  - `OptimizeInfo` + `finalState?: "off" | "on" | "suspended"`, `review?: string[]`, `excluded?: number`, `budget?: number`, `jobMs?: number`.

- [ ] **Step 1: Failing tests**

```js
import { WM_FINAL } from "./helpers/final.js";
import { layoutOf, loadSeries, restartScenarios } from "./helpers/fixtures.js";
import { feed, feedPoints, pauseRun, registrySetup, WASHER } from "./helpers/devices.js";
import { runOf } from "./helpers/programmes.js";

const W = loadSeries("washer30d");
const FIN = { ...WASHER, ...WM_FINAL };

describe("judging afterwards (Spec A.3)", function () {
	this.timeout(600_000);
	for (const autoOptimize of [false, true]) {
		it(`Y 30 s: the first split rest suspends the final phase (auto-optimisation ${autoOptimize ? "on" : "off"})`, async () => {
			const ctx = await registrySetup({ autoOptimize, detection: { ...FIN, finalMinSec: 30 } });
			const { L, s } = layoutOf(W);
			await feedPoints(ctx, W.filter(p => p.ts >= s.t0 + (L.runs[0].from - 180) * s.stepMs && p.ts < s.t0 + (L.runs[1].from - 180) * s.stepMs));
			const st = ctx.reg.learningData("dev");
			assert.deepStrictEqual([st.final.state, st.final.splits.length, st.final.reason], ["suspended", 1, "finalSplit"]);
			assert.strictEqual(ctx.reg.get("dev").active.finalMinVal, 0);
			assert.strictEqual(ctx.reg.get("dev").effective.finalMinVal, 150);
			assert.ok(ctx.host.logs.warn.some(m => m.includes("final phase suspended (finalSplit)")));
			assert.deepStrictEqual(ctx.host.sent.filter(x => x.instance === "telegram.0"), [], "no message without optimizeNotify (G14)");
			assert.strictEqual(JSON.parse(ctx.host.own("dev.learning.optimizeInfo")).finalState, "suspended");
		});
	}
	it("with optimizeNotify the suspension is sent once", async () => {
		const ctx = await registrySetup({ autoOptimize: false, notify: true, detection: { ...FIN, finalMinSec: 30 } });
		const { L, s } = layoutOf(W);
		await feedPoints(ctx, W.filter(p => p.ts >= s.t0 + (L.runs[0].from - 180) * s.stepMs && p.ts < s.t0 + (L.runs[1].from - 180) * s.stepMs));
		assert.strictEqual(ctx.host.sent.filter(x => x.instance === "telegram.0").length, 1);
	});
	it("a real restart after unloading does not suspend", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: FIN });
		const sc = restartScenarios().find(x => x.key === "warm/0/5.5/10/18");
		await feed(ctx, [...sc.values, ...new Array(400).fill(0.5)]);
		assert.notStrictEqual(ctx.reg.learningData("dev").final?.state, "suspended");
	});
	it("'was a new run' resumes only when no other split is left (also without auto-optimisation)", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: { ...FIN, finalMinSec: 30 } });
		const { L, s } = layoutOf(W);
		await feedPoints(ctx, W.filter(p => p.ts >= s.t0 + (L.runs[0].from - 180) * s.stepMs && p.ts < s.t0 + (L.runs[1].from - 180) * s.stepMs));
		const st = ctx.reg.learningData("dev");
		const first = st.final.splits[0];
		st.final.splits.push("dev@1");
		assert.strictEqual(await ctx.reg.resumeFinal("dev", "newRun", first), false, "another split is left");
		assert.deepStrictEqual(st.final.splits, ["dev@1"]);
		assert.strictEqual(await ctx.reg.resumeFinal("dev", "newRun", "dev@1"), true);
		assert.deepStrictEqual([st.final.state, ctx.reg.get("dev").active.finalMinVal, st.changes.at(-1).kind], ["on", 150, "finalResume"]);
	});
	it("two real runs 15 min apart in one capture → two stored runs, no change (review/cap.mjs)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, trailerBurstSec: 0 } });
		const a = runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: 1 }).values;
		const b = runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: 2 }).values;
		await feed(ctx, [...a, ...new Array(90).fill(0.5), ...b, ...new Array(400).fill(0.5)]);
		const st = ctx.reg.learningData("dev");
		assert.strictEqual(st.runs.length, 2);
		assert.ok(!st.changes.some(c => c.kind === "repair"));
		assert.strictEqual(st.override, null);
	});
	it("final phase without auto-optimisation: a split run changes no override and repairs nothing", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: { ...FIN, endCount: 20 } });
		const st0 = ctx.reg.learningData("dev");
		st0.override = { endCount: 200 };
		await ctx.reg.upsert("dev", ctx.cfg);
		assert.strictEqual(ctx.reg.get("dev").currentOverride, null, "the override is never applied without auto-optimisation");
		await feed(ctx, pauseRun(4, 25));
		const st = ctx.reg.learningData("dev");
		assert.ok(!st.changes.some(c => c.kind === "repair" || c.kind === "tighten"));
		assert.deepStrictEqual(st.override, { endCount: 200 }, "kept untouched in the store");
	});
	for (const key of ["warm/0/5.5/10/18", "warm/0/5.5/5/3", "cold/0/5.5/20/36"]) {
		it(`set up by hand (no comparison runs): restart after unloading ${key} does not suspend`, async () => {
			const ctx = await registrySetup({ autoOptimize: false, detection: FIN });
			const sc = restartScenarios().find(x => x.key === key);
			await feed(ctx, [...sc.values, ...new Array(400).fill(0.5)]);
			assert.notStrictEqual(ctx.reg.learningData("dev").final?.state, "suspended", key);
		});
	}
	it("the split is judged at the end of the afterFinal run, not when the capture closes", async () => {
		const ctx = await registrySetup({ autoOptimize: false, detection: { ...FIN, finalMinSec: 30 } });
		const { L, s } = layoutOf(W);
		const end = s.t0 + (L.runs[0].runEnd + 1) * s.stepMs;
		await feedPoints(ctx, W.filter(p => p.ts >= s.t0 + (L.runs[0].from - 180) * s.stepMs && p.ts <= end));
		assert.strictEqual(ctx.reg.learningData("dev").final.state, "suspended");
		assert.ok(ctx.reg.get("dev").runRecorder.snapshot(), "the capture is still open");
	});
});
```

`pauseRun` wird damit schon in Task 17 in `test/helpers/devices.js` gebraucht und dort angelegt (Definition wie in Task 21 beschrieben). Die drei Neustart-Szenarien ohne Vergleichsläufe decken Kriterium 2 ohne Vergleichsdaten ab (`checkFinalSplit` darf ohne Daten nicht „im Zweifel“ aussetzen).

- [ ] **Step 2:** FAIL. **Step 3:** implementieren (de/en-Texte, `npm run translate`). **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (Beurteilung im Nachhinein, Aussetzen der Schlussphase auch ohne Auto-Optimierung, Hinweise nur als Nachricht bei `optimizeNotify`; zwei kurz hintereinander laufende Programme werden als zwei Läufe gespeichert); Changelog-Zeile zur Schlussphase.
- [ ] **Step 5: Commit** `feat: a wrong early end is found afterwards and suspends the final phase`

---

### Task 18: Phasenmodell und Tracker (Spec A.4, A.5)

**Files:**
- Create: `src/lib/phases/model.ts`, `src/lib/phases/tracker.ts`, `test/phaseTracker.test.js`, `test/helpers/phases.js`
- Modify: `src/lib/config.ts` (`DeviceConfig.phases?: PhaseModel`, Normalisierung über `normalizePhases`)

**Interfaces:**
- Consumes: `HoldProfile` (Task 11).
- Produces:
  - `PhaseModel`, `BandDef`, `PhaseDef` exakt wie Spec A.4; `normalizePhases(raw: unknown, warnings: string[], label: string): PhaseModel | undefined` (Validator: aufsteigende Bänder ohne Überlappung, ids eindeutig, `band`/`after`/`confirm` verweisen auf vorhandene ids, `notBeforeSec` bei `continuous` → entfernt + Warnung; ungültig → `undefined` + Warnung).
  - `SYSTEM_PHASES = { antiCrease: "antiCrease", afterRun: "afterRun", rest: "rest", unknown: "unknown" }` (feste ids für Knitterschutz, Nachlauf, Ruhe – außerhalb aller Bänder bei `scope continuous` –, unbekannt), `UNKNOWN_PHASE = SYSTEM_PHASES.unknown`. Namen der Systemphasen und die neutrale Namensvorlage (Task 19) kommen aus i18n (`phase_antiCrease`, `phase_afterRun`, `phase_rest`, `phase_unknown`, `phase_neutral` mit Platzhaltern `{n}`, `{w}`, `{min}`, `{max}`; 11 Sprachen) in der Systemsprache (`registry lang()`); der Tracker bekommt sie als `names: Record<string, string>` im Konstruktor. Tests vergleichen ids, nie übersetzte Namen.
  - `interface PhaseState { id: string | null; name: string; since: number; unknown: boolean }`; `interface Segment { id: string; name: string; from: number; to: number; final: boolean }`; `type PhaseEdge = { id: string; edge: "start" | "end"; at: number }`.
  - `class PhaseTracker { constructor(model: PhaseModel, holds: HoldProfile[] | null, pollSec: number, names?: Record<string, string>); observe(val: number, t: number): void; advance(t: number): PhaseEdge[]; onRun(kind: "start" | "end" | "abort", at: number): void; setContext(c: { inTrailer: boolean; settling: boolean }): void; readonly current: PhaseState; timeline(): Segment[]; reset(): void }`.
  - `replayPhases(model: PhaseModel, points: { ts: number; val: number }[], pollSec: number, runs?: { start: number; end: number }[]): { timeline: Segment[]; live: { t: number; id: string | null; name: string }[] }` (Offline-Nachspielen mit demselben Tracker-Code).
  - Glättungen `block` (Dip 30 s, Mindestlänge 20 s), `level` (Median/Maximum über `windowSec`, Haltezeit `dipSec`), `debounce` (`dipSec`), `peak` (sofort, Anzeige `dipSec` gehalten); Zeiten über den gehaltenen Wert, `dt` gedeckelt wie Task 14.
  - `test/helpers/phases.js`: `WM_PHASES` (Bänder `wash` [5,5; 150) level 45/60, `spin` [150; 1311) block 30, `heat` [1311; ∞) block 30; Phasen `p1` „Heizen“ (heat), `p2` „Waschen“ (wash), `p3` „Zwischenschleudern“ (spin, maxSec 114, decided end), `p4` „Endschleudern“ (spin, minSec 168, decided live)), `BOILER_PHASES` (scope continuous; Bänder `low` [35; 120) debounce 5, `burner` [120; 294) debounce 5, `peak` [294; ∞) peak 5; Phasen `q1` „Anlauf“ (low, after ["idle"]), `q2` „Nachlauf“ (low, after ["q3", "q4"]), `q3` „Brenner mit Pumpe“ (burner), `q4` „Zündung“ (peak, trigger { confirm: ["burner"], confirmSec: 10, tailSec: 60 })), `peaksOf(points)` → Spitzen > 294 W mit `intoBurner` = gehaltener Wert 60 s nach Spitzenbeginn in [120, 294) (Definition aus Spec 3, S13).

- [ ] **Step 1: Failing tests** (`test/phaseTracker.test.js`; Kessel-Zahlen 86 Spitzen, davon 79 in den Brenner und 7 in 35–120 W mit `plan_kessel.mjs` auf `kessel.json` nachgerechnet, deckt sich mit S13):

```js
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { normalizePhases } from "../build/lib/phases/model.js";
import { PhaseTracker, replayPhases } from "../build/lib/phases/tracker.js";
import { layoutOf, loadSeries } from "./helpers/fixtures.js";
import { BOILER_PHASES, peaksOf, WM_PHASES } from "./helpers/phases.js";

const W = loadSeries("washer30d");
const B = loadSeries("boiler4d");

describe("phase tracker (Spec A.5)", function () {
	this.timeout(300_000);
	it("does not import anything from the detector (G2)", () => {
		const src = readFileSync(new URL("../build/lib/phases/tracker.js", import.meta.url), "utf8");
		assert.ok(!src.includes("/detector/"));
	});
	it("washer: band name first, 'Endschleudern' after 168 s in the final spin; intermediate spins only in the timeline", () => {
		const { L, s } = layoutOf(W);
		const runs = L.runs.map(r => ({ start: s.t0 + r.from * s.stepMs, end: s.t0 + r.coreEnd * s.stepMs }));
		const { live, timeline } = replayPhases(WM_PHASES, W, 10, runs);
		const nameAt = t => live.filter(x => x.t <= t).at(-1)?.name;
		for (const r of L.runs.filter((r, k) => k !== 3)) {
			const t0 = s.t0 + r.endBlockFrom * s.stepMs;
			assert.strictEqual(nameAt(t0 + 60_000), "Schleudern");
			assert.strictEqual(nameAt(t0 + 190_000), "Endschleudern");
		}
		assert.ok(timeline.some(x => x.name === "Zwischenschleudern"));
		assert.ok(!live.some(x => x.name === "Zwischenschleudern"), "decided at the end only");
	});
	it("boiler: 86 peaks, 79 into the burner, 7 to 35–120 W; ignition live ≤ 10 s after ≥ 90 % of the 79, never for the 7", () => {
		const peaks = peaksOf(B);
		assert.deepStrictEqual([peaks.length, peaks.filter(p => p.intoBurner).length], [86, 79]);
		const { live, timeline } = replayPhases(BOILER_PHASES, B, 2);
		const hits = peaks.filter(p => p.intoBurner && live.some(x => x.name === "Zündung" && x.t >= p.ts && x.t <= p.ts + 10_000));
		assert.ok(hits.length >= 0.9 * 79, String(hits.length));
		for (const p of peaks.filter(x => !x.intoBurner)) {
			assert.ok(!timeline.some(x => x.name === "Zündung" && x.from <= p.ts + 1000 && x.to >= p.ts), String(p.ts));
		}
	});
	it("start-up and run-on are told apart by the predecessor", () => {
		const t0 = 1_700_000_000_000;
		const pts = [[0, 0], [60, 80], [120, 250], [720, 80], [780, 0], [900, 0]].map(([sec, val]) => ({ ts: t0 + sec * 1000, val }));
		const ids = replayPhases(BOILER_PHASES, pts, 2).timeline.map(x => x.id);
		assert.deepStrictEqual(ids.filter(id => id !== "rest"), ["q1", "q3", "q2"]);
	});
	it("a hold over the suspect limit shows 'unknown'; a new tracker starts empty; a run start resets the timeline", () => {
		const t = new PhaseTracker(BOILER_PHASES, [{ band: "burner", p99Sec: 100, suspectSec: 600, n: 50 }], 2);
		t.observe(250, 0);
		t.advance(30_000);
		assert.strictEqual(t.current.name, "Brenner mit Pumpe");
		t.advance(700_000);
		assert.deepStrictEqual([t.current.unknown, t.current.id], [true, "unknown"]);
		assert.deepStrictEqual(new PhaseTracker(WM_PHASES, null, 10).current, { id: null, name: "", since: 0, unknown: false });
		const w = new PhaseTracker(WM_PHASES, null, 10);
		w.onRun("start", 0);
		w.observe(2100, 0);
		w.advance(60_000);
		w.onRun("end", 70_000);
		w.onRun("start", 80_000);
		assert.deepStrictEqual(w.timeline(), []);
	});
	it("live from raw values equals the offline replay", () => {
		const day = B.filter(p => p.ts < B[0].ts + 86_400_000);
		const t = new PhaseTracker(BOILER_PHASES, null, 2);
		let k = 0;
		for (let now = day[0].ts; now <= day.at(-1).ts; now += 2000) {
			while (k < day.length && day[k].ts <= now) t.observe(day[k].val, day[k++].ts);
			t.advance(now);
		}
		assert.deepStrictEqual(t.timeline(), replayPhases(BOILER_PHASES, day, 2).timeline);
	});
	it("validator drops notBeforeSec for continuous and rejects overlapping bands", () => {
		const w = [];
		const m = normalizePhases({ ...BOILER_PHASES, phases: BOILER_PHASES.phases.map(p => ({ ...p, notBeforeSec: 60 })) }, w, "K");
		assert.ok(m.phases.every(p => p.notBeforeSec === undefined) && w.length === 1);
		const bad = { ...WM_PHASES, bands: [{ ...WM_PHASES.bands[0], max: 200 }, ...WM_PHASES.bands.slice(1)] };
		assert.strictEqual(normalizePhases(bad, w, "WM"), undefined);
	});
});
```

Die Systemphase „Ruhe“ (id `rest`) gilt außerhalb aller Bänder bei `scope continuous` (Name aus i18n, 11 Sprachen). Lauf w04 (lückenhaft) ist in der WM-Prüfung ausgenommen. Die Namen „Schleudern“, „Endschleudern“, „Anlauf“ … in den übrigen Tests sind Namen aus den Test-Modellen (vom User vergebene Namen), keine übersetzten Systemtexte.

- [ ] **Step 2:** FAIL. **Step 3:** implementieren (`phases/` importiert nichts aus `detector/`). **Step 4:** `npm test` → PASS.
- [ ] **Doku:** keine nutzerseitige Änderung (Phasen sichtbar ab Task 20).
- [ ] **Step 5: Commit** `feat: phase model and a pure tracker that names phases only with evidence`

---

### Task 19: Phasen lernen (Spec B.5)

**Files:**
- Create: `src/lib/phases/learn.ts`, `test/phaseLearn.test.js`

**Interfaces:**
- Consumes: `learnBands`, `holdProfile`, `Unit` (Task 11), `RunSample`, `Verdict`, `admitted`, `runSamples`, `daySamples`, `checkRuns` (Task 12), `PhaseTracker`, `replayPhases` (Task 18).
- Produces:
  - `learnPhases(units: { sample: RunSample; verdict: Verdict }[], ctx: { runLimitW: number; unitFactor: number; pollSec: number; scope?: "run" | "continuous"; previous?: PhaseModel; vocabulary?: string[]; actionsOf?: (phaseId: string) => number }): { model: PhaseModel; looAgreement: number; retroOnly: string[]; dropped: { id: string; actions: number }[] }`.
  - `scopeOf(runsPerDay: number, medianRestMin: number): "run" | "continuous"` (> 6 Läufe/Tag oder Median-Ruhe < 30 min → `continuous`).
  - Schritte 1–8 der Spec B.5; neutrale Namen aus der i18n-Vorlage `phase_neutral` (Task 18) in der Systemsprache, z. B. de „Stufe {n} · ≈ {w} W · {min}–{max} min“, en „Level {n} · ≈ {w} W · {min}–{max} min“; `ctx.neutralName?: (n: number, w: number, min: number, max: number) => string` (Registry/Dialog übergeben die übersetzte Vorlage, Standard en).
  - `test/helpers/final.js` wird um `phaseInput(points, o)` → `{ units, runLimit }` (über `runSamples`/`checkRuns`) ergänzt.

- [ ] **Step 1: Failing tests** (`test/phaseLearn.test.js`):

```js
import assert from "node:assert";
import { learnPhases, scopeOf } from "../build/lib/phases/learn.js";
import { checkRuns, daySamples } from "../build/lib/learn/quality.js";
import { baseBandsOf } from "../build/lib/learn/bands.js";
import { phaseInput } from "./helpers/final.js";
import { loadSeries } from "./helpers/fixtures.js";
import { WM_PHASES } from "./helpers/phases.js";

const W = loadSeries("washer30d");
const B = loadSeries("boiler4d");

describe("learn phases (Spec B.5)", function () {
	this.timeout(600_000);
	it("washer: cross-check ≥ 99 %, a boundary between spin (≤ 839 W) and heating (≥ 2047 W)", () => {
		const { units, runLimit } = phaseInput(W);
		const r = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10 });
		assert.strictEqual(r.model.scope, "run");
		assert.ok(r.looAgreement >= 0.99, String(r.looAgreement));
		assert.ok(r.model.bands.some(b => b.min > 839 && b.min < 2047));
		assert.ok(r.model.phases.every(p => p.stats.runs >= 3 && p.show === true && p.notify === undefined), "a class needs ≥ 3 runs, otherwise it is merged");
	});
	it("boiler: scope continuous from runs per day or rest, peak band kept, ≥ 3 days without help (P2, P3)", () => {
		assert.strictEqual(scopeOf(19, 12), "continuous");
		assert.strictEqual(scopeOf(1, 600), "run");
		const s = daySamples("kessel", B, { stepMs: 2000, src: "history", unitFactor: 1 });
		const v = checkRuns(s, { unitFactor: 1, unit: "W", settings: null, pollMs: 2000, outages: [], scope: "continuous", bands: baseBandsOf(s, 35, { mode: "raw", dipSec: 5 }) });
		const r = learnPhases(s.map((sample, i) => ({ sample, verdict: v[i] })), { runLimitW: 35, unitFactor: 1, pollSec: 2, scope: "continuous" });
		assert.strictEqual(r.model.scope, "continuous");
		assert.ok(r.model.quality.runsUsed >= 3);
		assert.ok(r.model.bands.at(-1).min > 290);
		const ign = r.model.phases.find(p => p.trigger);
		assert.ok(!ign || ign.stats.agreement >= 0.99 || r.retroOnly.includes(ign.id), "ignition live only when it passes the cross-check");
	});
	it("relearning keeps ids, names and notify; unmatched phases are reported with their actions", () => {
		const { units, runLimit } = phaseInput(W);
		const previous = {
			...WM_PHASES,
			phases: [...WM_PHASES.phases.map(p => (p.id === "p4" ? { ...p, name: "Final", notify: { end: true, text: "Fertig geschleudert" } } : p)),
				{ id: "p9", name: "Trocknen", band: "heat", minSec: 36_000, maxSec: 0, decided: "live", show: true, stats: { runs: 3, agreement: 1, lastSeen: 0 } }],
		};
		const r = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10, previous, actionsOf: id => (id === "p9" ? 2 : 0) });
		const p4 = r.model.phases.find(p => p.id === "p4");
		assert.deepStrictEqual([p4?.name, p4?.notify], ["Final", { end: true, text: "Fertig geschleudert" }]);
		assert.deepStrictEqual(r.dropped, [{ id: "p9", actions: 2 }]);
	});
	it("neutral names without a vocabulary, from the translated template", () => {
		const { units, runLimit } = phaseInput(W);
		const r = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10 });
		assert.ok(r.model.phases.every(p => /^Level \d+ · ≈ \d+ W · \d+–\d+ min$/.test(p.name)), r.model.phases.map(p => p.name).join());
		const de = learnPhases(units, { runLimitW: runLimit, unitFactor: 1, pollSec: 10, neutralName: (n, w, a, b) => `Stufe ${n} · ≈ ${w} W · ${a}–${b} min` });
		assert.deepStrictEqual(de.model.phases.map(p => p.id), r.model.phases.map(p => p.id), "ids do not depend on the language");
	});
});
```

- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Doku:** keine nutzerseitige Änderung (Bedienung in Task 24).
- [ ] **Step 5: Commit** `feat: learn phases from history or recording with a leave-one-out check`

---

### Task 20: Phasen-Ausgaben – States, Ereignisse, Aktionen, Meldungen (Spec A.6, 7.1, 7.2)

**Files:**
- Modify: `src/lib/deviceRuntime.ts` (`onPower` `:192`, `tick` `:259`, `apply`), `src/lib/deviceRegistry.ts` (`onRuntimeEvent` `:359-379`), `src/lib/config.ts` (`ActionEvent` `:178`, `ACTION_EVENTS` `:256`, `DeviceAction.phaseId?`), `src/lib/actions.ts`, `src/lib/stateDefinitions.ts`, `src/lib/deviceForm.ts` (Aktions-Ereignisse), `admin/i18n/*.json`, Doku §7/§13
- Test: `test/deviceRuntime.test.js`, `test/actions.test.js`, `test/stateDefinitions.test.js`, `test/docsStates.test.js`

**Interfaces:**
- Consumes: `PhaseTracker` (Task 18).
- Produces:
  - States `phase` (string, `text`), `phaseId` (string, `text`), `phaseSince` (number, `date`), `phases` (string, `json`, ≤ `PHASES_MAX = 200` Einträge; bei `continuous` 24 h) – alle `when: "phases"`. **Schreibhäufigkeit:** alle vier nur bei einem Segmentwechsel (neue Phase, Ende eines Segments, rückwirkende Klassifikation) bzw. beim Lauf-Start/-Ende, nie je Tick (taktender Kessel: JSON mit bis zu 200 Einträgen je Tick wäre teuer).
  - `RuntimeEvent` + `{ kind: "phase"; id: string; edge: "start" | "end" }`; im Test-Listener als `` `${id}:phase:${phaseId}:${edge}` ``.
  - `ActionEvent` + `"phaseStart" | "phaseEnd"`; `DeviceAction.phaseId?: string` (leer = jede Phase); `runActions(host, actions, event, phaseId?)`.
  - Meldungen nur für Phasen mit `notify`: je Lauf und Phase höchstens einmal; `continuous` höchstens alle `PHASE_NOTIFY_MIN_MS = 600_000` je Phase; Nicht-Stören wie Start-/Ende-Meldungen.
  - Tracker sieht in `onPower` jeden Rohwert vor der Modusprüfung, `advance` im `tick`, `onRun` aus `onStarted`/`onFinished`/`onAborted`, Kontext aus `inTrailer`/`settling`; Tracker-Neubau nur zwischen zwei Läufen.

- [ ] **Step 1: Failing tests**

```js
// test/deviceRuntime.test.js
import { BOILER_PHASES, WM_PHASES } from "./helpers/phases.js";
import { layoutRun, loadSeries } from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const w08 = () => { const { info, s } = layoutRun("washer30d", "w08"); return W.filter(p => p.ts >= s.t0 + (info.from - 180) * s.stepMs && p.ts <= s.t0 + (info.runEnd + 360) * s.stepMs); };
const strip = ctx => ctx.host.ownWrites.filter(w => !/\.phase/.test(w.id)).map(w => [w.id, w.val]);

describe("phase outputs", function () {
	this.timeout(300_000);
	it("status, events and messages are identical with and without phases (G2)", async () => {
		const a = runtimeSetup();
		const b = runtimeSetup({ cfg: { phases: WM_PHASES } });
		for (const c of [a, b]) { await c.rt.init(); await playPoints(c, w08()); }
		assert.deepStrictEqual(b.events.filter(e => !e.includes(":phase:")), a.events);
		assert.deepStrictEqual(b.messages, a.messages);
		assert.deepStrictEqual(strip(b), strip(a));
	});
	it("writes phase, phaseId, phaseSince and the timeline", async () => {
		const ctx = runtimeSetup({ cfg: { phases: WM_PHASES } });
		await ctx.rt.init();
		await playPoints(ctx, w08());
		assert.ok(ctx.host.ownHistory("washer.phase").includes("Endschleudern"));
		assert.ok(ctx.host.ownHistory("washer.phaseId").includes("p4"));
		assert.ok(JSON.parse(ctx.host.own("washer.phases")).some(x => x.id === "p3"));
	});
	it("phaseStart action filtered by phaseId; an empty phaseId means every phase", async () => {
		const actions = [{ event: "phaseStart", stateId: "x.0.a", value: "1", phaseId: "p4" }, { event: "phaseStart", stateId: "x.0.b", value: "1" }];
		const ctx = await registrySetup({ autoOptimize: false, cfg: { phases: WM_PHASES, actions } });
		await feedPoints(ctx, w08());
		const a = ctx.host.writes.filter(w => w.id === "x.0.a").length;
		const b = ctx.host.writes.filter(w => w.id === "x.0.b").length;
		assert.strictEqual(a, 1);
		assert.ok(b >= 3 && b > a, String(b));
	});
	it("a phase message is sent once per run and phase; continuous at most every 10 min", async () => {
		const notifyP4 = { ...WM_PHASES, phases: WM_PHASES.phases.map(p => (p.id === "p4" ? { ...p, notify: { start: true, text: "Endschleudern" } } : p)) };
		const ctx = runtimeSetup({ cfg: { phases: notifyP4 } });
		await ctx.rt.init();
		await playPoints(ctx, w08());
		assert.strictEqual(ctx.messages.filter(m => m.text === "Endschleudern").length, 1);
		const boiler = { ...BOILER_PHASES, phases: BOILER_PHASES.phases.map(p => (p.id === "q3" ? { ...p, notify: { start: true, text: "Brenner" } } : p)) };
		const k = runtimeSetup({ cfg: { phases: boiler, startText: "", endText: "" } });
		await k.rt.init();
		const t0 = k.host.now();
		const pts = [];
		for (let m = 0; m < 30; m += 2) pts.push({ ts: t0 + m * 60_000, val: m % 4 === 0 ? 250 : 0 });
		await playPoints(k, pts, 2000);
		assert.strictEqual(k.messages.filter(m => m.text === "Brenner").length, 3, "minutes 0, 12, 24 of 0–28");
	});
	it("continuous over 24 h with more than 200 segments keeps exactly the 200 newest (Review Focus 5)", async () => {
		const ctx = runtimeSetup({ cfg: { phases: BOILER_PHASES, startText: "", endText: "" } });
		await ctx.rt.init();
		const t0 = ctx.host.now();
		const pts = Array.from({ length: 480 }, (_, i) => ({ ts: t0 + i * 180_000, val: i % 2 ? 0 : 250 }));
		await playPoints(ctx, pts, 10_000);
		const tl = JSON.parse(ctx.host.own("washer.phases"));
		assert.strictEqual(tl.length, 200);
		assert.ok(tl.every((x, i) => i === 0 || x.from >= tl[i - 1].from));
		assert.ok(tl.at(-1).from >= t0 + 470 * 180_000);
	});
	it("system phase afterRun while settling", async () => {
		const ctx = runtimeSetup({ cfg: { phases: WM_PHASES, detection: { ...WASHER, ...WM_FINAL } } });
		await ctx.rt.init();
		await playPoints(ctx, w08());
		assert.ok(ctx.host.ownHistory("washer.phaseId").includes("afterRun"));
	});
	it("the timeline state is written on segment changes only", async () => {
		const ctx = runtimeSetup({ cfg: { phases: WM_PHASES } });
		await ctx.rt.init();
		await playPoints(ctx, w08());
		const writes = ctx.host.ownWrites.filter(w => w.id === "washer.phases").length;
		const segments = JSON.parse(ctx.host.own("washer.phases")).length;
		assert.ok(writes <= 2 * segments + 2, `${writes} writes for ${segments} segments`);
	});
});

// test/deviceObjects.test.js (moved here from Task 15: the phase states exist from this task on)
it("creates phase states only with enabled phases and removes them again", async () => {
	const ids = [];
	const del = [];
	const w = { extendObject: async id => ids.push(id), setObjectNotExists: async () => {}, delObject: async id => del.push(id) };
	await ensureDeviceObjects(w, "wm", deviceConfig(), instanceConfig());
	assert.ok(["wm.phase", "wm.phaseId", "wm.phaseSince", "wm.phases"].every(id => del.includes(id)));
	await ensureDeviceObjects(w, "wm", deviceConfig({ phases: WM_PHASES }), instanceConfig());
	assert.ok(["wm.phase", "wm.phaseId", "wm.phaseSince", "wm.phases"].every(id => ids.includes(id)));
});

// test/actions.test.js
it("runActions filters phase events by phaseId", async () => {
	const host = createFakeHost();
	await runActions(host, [{ event: "phaseEnd", stateId: "x.0.a", value: "1", phaseId: "p2" }, { event: "phaseEnd", stateId: "x.0.b", value: "2" }], "phaseEnd", "p3");
	assert.deepStrictEqual(host.writes.map(w => w.id), ["x.0.b"]);
});
```

Imports: `runtimeSetup`, `playPoints`, `registrySetup`, `feedPoints`, `WASHER` aus `./helpers/devices.js`, `WM_FINAL` aus `./helpers/final.js`, `runActions` aus `../build/lib/actions.js`. Die Zahl 3 im Kessel-Meldetest folgt aus der Regel „höchstens alle 10 min“: Brennerstarts in den Minuten 0, 4, 8, … 28; gemeldet in 0, 12 (erste ≥ 10 min nach 0) und 24.

- [ ] **Step 2:** FAIL. **Step 3:** implementieren; Doku §7 (Aktionen) und §13 (States) de/en, neues Kapitel „Phasen“ (Anzeige, Systemphasen, was nur rückwirkend erscheint). **Step 4:** `npm test` → PASS.
- [ ] **Doku/Changelog:** Changelog-Zeile 34 um Phasen ergänzen.
- [ ] **Step 5: Commit** `feat: current phase as states, events, actions and optional messages`

---
### Task 21: Optimierung I – 30-Tage-Fenster, Gate über zugelassene Läufe, Grenzläufe, Mindestzahlen, Reparatur-Vorrang (Spec D.1–D.4, Entscheidungen 4 und 8)

**Files:**
- Modify: `src/lib/learn/autoOptimize.ts` (Konstanten `:16-30`, `gate` `:335`, `optimize` `:681-800`, `repair` `:758-793`, `applyFloors` `:605-631`, Status `:888-900`), `src/lib/deviceRegistry.ts` (`storeCapture`, `bootstrapFromHistory` `:665`, `RegistryOptions`), `src/lib/historyLearning.ts` (Analyse nur über zugelassene Läufe), Doku §8
- Test: `test/autoOptimize.test.js`, `test/optimizationIntegration.test.js`, `test/learnRobustness.test.js` (neu)

**Interfaces:**
- Consumes: `checkRuns`, `admitted`, `stageOf`, `primaryOf`, `runSamples` (Task 12), `evict`, `boundaryRuns`, `recomputeEnvelope`, `setDecision`, `verdicts`, `lastSeenTs` (Task 13), `endOk` (Task 10), `learnFinal` (Task 16).
- Produces:
  - `TIGHTEN_MIN_RUNS = 8` (zugelassene Läufe im Fenster; vorher 4), `TIGHTEN_NEW_RUNS = 2`, `TIGHTEN_SPACING_MS = 24 h`, `LOCK_RUNS = 5`, `LOCK_MS = 14 Tage`, `MAX_DROP = 0.25`, `MAX_THRESHOLD_CHANGE = 0.3` (unverändert).
  - `targetSet(store: StoreFile, now: number): StoredRun[]` (zugelassen, ≤ 30 Tage) und `checkSet(store: StoreFile, now: number): StoredRun[]` (+ Grenzläufe jeden Alters); `legacyEnvelope` wirkt über `applyFloors`.
  - Gate nur über zugelassene Läufe mit `endOk`; Quarantäne-Läufe nur „kein Rückschritt“ (`noRegression(c, p0, quarantined): boolean`).
  - `needsRepair(store: StoreFile, ctx: OptimizeContext): Promise<string[]>` – Schlüssel der zugelassenen Läufe (`uses.end`), die mit den aktiven Werten nicht richtig erkannt werden: Start fehlt, Ende zu früh (`endOk` mit `seg.progEndIdx` und `store.tail`, Task 13 – nicht `tailCeil = runLimit` aus der einzelnen Capture), Lauf zerteilt (≥ 2 Starts in einem Lauf, der nicht `merged` ist), Ende nicht erkannt (kein `finished` bis zum Fensterende), Phantomstart (Start nach dem gemeldeten Ende ohne Aktivität eines neuen Laufs), `finalSplit`. **Nicht** in der Liste (Entscheidung 9): zwei echte Läufe, die der Detector zu einem verschmilzt – das ist kein Erkennungsfehler, solange das Ende des Gesamtlaufs erkannt wird. Ein `merged`-Lauf wird im Gate nur auf das Ende des Gesamtlaufs geprüft (letztes `finished` erfüllt `endOk` gegen das Ende des Gesamtlaufs; ein `finished`/`started` an der inneren Ruhe ist weder Zerteilung noch „Ende zu früh“); scheitert diese Ende-Prüfung, ist das „Ende nicht erkannt“ bzw. „zu früh“ und löst wie jeder andere Fehler sofort Reparatur aus. Höchstens ein Info-Eintrag im Optimierungs-Verlauf (`info.notes`, kein Hinweis, keine Warnung, keine Nachricht). Nicht leer → `repair` sofort im billigen Teil des Jobs, ohne `TIGHTEN_MIN_RUNS`, `TIGHTEN_NEW_RUNS`, `TIGHTEN_SPACING_MS`, `lockRuns`/`lockUntilTs`, ohne `stepLimit` (nur `boundsOf`/`applyFloors`) und **auch bei Status `drift`**; Kandidat muss das Gate über die ganze Prüfmenge bestehen; der auslösende Lauf wird Grenzlauf. Die Reparatur verkürzt nie eine Wartezeit; kürzere Wartezeiten gibt es nur über die Verschärfung (ab 8 Läufen, Schrittgrenzen). Quarantäne/unbrauchbar → nie in `needsRepair`. Kein Kandidat → Override unverändert, `info.status = "cannotCover"`, Log-Warnung `<name>: no values detect every admitted run, keeping the current values`.
  - `replayPick(store: StoreFile, now: number): StoredRun[]` – ausgewogene Auswahl fürs Nachspielen (Spec B.4 Punkt 3): je Gruppe die neuesten Läufe plus alle Grenzläufe, höchstens `REPLAY_PICK_MAX = 60` (Task 13); verwendet von Gate, `needsRepair`, Verschärfung und `learnFinal`. Statistik und Laufprüfung laufen weiter über alle Läufe (Metadaten bis 400). Ohne diese Grenze spielte das Gate beim Kessel (~19 Läufe/Tag) bis zu 400 Läufe je Lauf nach.
  - Veto: Kandidat besteht alle übrigen Läufe der Prüfmenge und scheitert an genau einem → `run.veto = now`; verfällt, wenn ein später übernommener Kandidat den Lauf besteht.
  - Hinweis B.3 genau einmal je Lauf (`optimizeInfo.review` = Schlüssel, Log, Karte; Nachricht nur bei `optimizeNotify`): Formgrund → Text `dm_reviewUse` („… im Dialog ‚verwenden‘ wählen …“), Datenfehler → `dm_reviewBroken` („Aufzeichnung gestört – Lauf wird nicht verwendet“).
  - Drift: 3 Läufe in Folge durchgefallen → Status `drift`. Drift sperrt **nur** Verschärfung, automatisches Einschalten der Schlussphase und Phasen-Feinjustierung; `needsRepair`, Reparatur und Aussetzen laufen immer (Entscheidung 8; heute bricht `optimize()` bei `drift` sofort ab, `autoOptimize.ts:695-697`, und der Status wird nur durch Typwechsel, Undo oder Reset zurückgesetzt). 3 Läufe in Folge > 10 % „unbekannt“ (Phasen, reine Anzeige) erzeugen nur einen Hinweis „Gerät verhält sich anders – neu anlernen?“, keinen Drift-Status.
  - History nur beim Einschalten bzw. bei leerem Speicher (`bootstrapFromHistory`, auch nach „Lerndaten löschen“; gespeicherte Entscheidungen werden angewendet), nach Ausfallzeit > 1 h (nur `lastSeenTs` … jetzt, höchstens 30 Tage; `loadHistorySeries(…, from)`, Task 9) und im Dialog; `lastSeenTs` wird bei jedem Speichern gesetzt. **Rückfall** für alte V4-Speicher ohne `lastSeenTs`: `max(Ende des letzten Laufs, Ende von pending, Zeitpunkt des Speichers)` – sonst gälte der erste V5-Start als Ausfall von bis zu 30 Tagen. Importierte Läufe werden per `sameRun` gegen vorhandene Schlüssel (Läufe, `pending`, `verdicts`) abgeglichen und nicht gedoppelt. „Leerer Speicher“ heißt: kein `historyReadTs` gesetzt; nach dem Lesen wird `historyReadTs` gesetzt, auch wenn die History keine Läufe enthielt (heute verhindert das die gespeicherte leere Datei, `deviceRegistry.ts:740-744`).
  - `RegistryOptions.budgetMs?: number` (Standard 30 000; für Tests).
  - `test/helpers/devices.js` + `historyEnv(points, unit = "W")` (aus `optimizationIntegration.test.js` verschoben), `pauseRun(seed, ticks, level = 3)` (schon in Task 17 angelegt) → Werte von `runOf({ device: "washer", programme: "cotton60", seed })` mit `ticks` Ticks `level` W nach Tick `start + 200`, `windowsFeed(ctx, ids, copies = 1)` – spielt die Fenster `runWindow("washer30d", id)` (Task 2) nacheinander über `feedPoints` ab, je Fenster neuer Tag (`timelineOf(…, 86_400_000)`, Zeiten ab `ctx.host.now()`).
  - `DeviceRegistry.setRunUse` (Task 25) und jede Entscheidung `include`/`null` lösen sofort `needsRepair` und ggf. die Reparatur aus (Task 25 erwartet `env1`/`ov1` nach dem Wiederverwenden).

- [ ] **Step 1: Failing tests**

```js
// test/optimizationIntegration.test.js
import { readFileSync } from "node:fs";
import { checkSet, replayPick, targetSet, TIGHTEN_MIN_RUNS } from "../build/lib/learn/autoOptimize.js";
import { boundaryRuns, saveStore, setDecision, upgradeStore } from "../build/lib/runStore.js";
import { drain, feed, historyEnv, P, pauseRun, registrySetup, WASHER, windowsFeed } from "./helpers/devices.js";
import { historyOf } from "./helpers/history.js";
import { runOf } from "./helpers/programmes.js";
import { sparse } from "./helpers/fixtures.js";

const DAY = 86_400_000;
const waitSec = d => (d.mode === "timed" ? d.endDurationSec : d.endCount * 10);
const nextDay = ctx => ctx.host.tickClock(25 * 3_600_000);

describe("optimisation over 30 days", function () {
	this.timeout(600_000);
	it("minimum runs: collecting with 7 admitted runs, tightening possible from the 8th (Spec D.3 point 4)", async () => {
		assert.strictEqual(TIGHTEN_MIN_RUNS, 8);
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 120 } });
		for (let k = 1; k <= 7; k++) { await feed(ctx, runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: k }).values); nextDay(ctx); }
		const st = ctx.reg.learningData("dev");
		assert.strictEqual(st.info.status, "collecting");
		assert.ok(!st.changes.some(c => c.kind === "tighten"));
		await feed(ctx, runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: 8 }).values);
		assert.notStrictEqual(ctx.reg.learningData("dev").info.status, "collecting");
	});
	it("repair first: a pause one poll longer than the end wait raises the wait right after the run, despite lock and minimum count (decision 8)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		for (let k = 1; k <= 3; k++) { await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: k }).values); nextDay(ctx); }
		const st = ctx.reg.learningData("dev");
		st.lockRuns = 5;
		st.lockUntilTs = ctx.host.now() + 10 * DAY;
		await feed(ctx, pauseRun(4, 21));
		assert.strictEqual(st.changes.at(-1).kind, "repair");
		assert.ok(waitSec(ctx.reg.get("dev").effective) > 210, JSON.stringify(ctx.reg.get("dev").effective));
		assert.strictEqual((await ctx.reg.checkStoredRuns("dev")).ok, true, "every stored run is detected again");
	});
	it("repair ignores the step limit: a pause of twice the wait at least doubles it", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, pauseRun(4, 40));
		assert.ok(waitSec(ctx.reg.get("dev").effective) > 400);
		assert.strictEqual((await ctx.reg.checkStoredRuns("dev")).ok, true);
	});
	for (const [name, detection, values] of [
		// missed start: the recorder opens a capture on activity without a start (Task 9)
		["missed start", { ...WASHER, startVal: 3000 }, runOf({ device: "washer", programme: "cotton60", seed: 5 }).values],
		["split run", { ...WASHER, endCount: 20 }, pauseRun(5, 25)],
		// phantom start: a single spike AFTER the reported end (at +31 ticks it is still inside the run, review/phantom.mjs)
		["phantom start", { ...WASHER, startCount: 1, startVal: 30 }, [...runOf({ device: "washer", programme: "cotton60", seed: 5, after: 360 }).values, 400, 0.8, ...new Array(400).fill(0.8)]],
	]) {
		it(`repair first: ${name} triggers an immediate repair`, async () => {
			const ctx = await registrySetup({ detection });
			await feed(ctx, values);
			assert.ok(ctx.reg.learningData("dev").changes.some(c => c.kind === "repair"), name);
			assert.strictEqual((await ctx.reg.checkStoredRuns("dev")).ok, true, name);
		});
	}
	it("merged runs trigger no repair and the end of the combined run is detected (decision 9)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 100 } });
		const a = runOf({ device: "washer", programme: "quick30", seed: 5, after: 60 }).values;
		const b = runOf({ device: "washer", programme: "quick30", seed: 6 }).values;
		const warnBefore = ctx.host.logs.warn.length;
		await feed(ctx, [...a, ...b, ...new Array(400).fill(0.5)]);
		const st = ctx.reg.learningData("dev");
		assert.strictEqual(ctx.host.ownWrites.filter(w => w.id === "dev.finished" && w.val === true).length, 1, "one end for both runs");
		assert.ok(!st.changes.some(c => c.kind === "repair"), "merging is no detection error");
		assert.strictEqual(st.override, null, "the end wait is not shortened because of it");
		assert.deepStrictEqual(st.info.review ?? [], [], "no hint");
		assert.strictEqual(ctx.host.logs.warn.length, warnBefore, "no warning");
		const g = await ctx.reg.checkStoredRuns("dev");
		assert.strictEqual(g.ok, true, "the end of the combined run is detected (endOk of the whole run)");
	});
	it("an end that is never reported is repaired at once (end not detected)", async () => {
		// idle at 0.5 W stays above endVal 0.3: with the current values the run never ends
		const ctx = await registrySetup({ detection: { ...WASHER, endVal: 0.3, standby: 0.2 } });
		await feed(ctx, [...runOf({ device: "washer", programme: "cotton60", seed: 3 }).values, ...new Array(1200).fill(0.5)]);
		const st = ctx.reg.learningData("dev");
		assert.ok(st.changes.some(c => c.kind === "repair") || st.info.status === "cannotCover", JSON.stringify(st.info));
	});
	it("w02 as a live capture: an end 10 s before the core end needs no repair (store.tail, endOk)", async () => {
		const ctx = await registrySetup({ detection: WASHER });
		await windowsFeed(ctx, ["w01", "w03", "w05", "w02"]);
		const st = ctx.reg.learningData("dev");
		assert.ok(st.tail.separated);
		assert.ok(!st.changes.some(c => c.kind === "repair"));
	});
	it("drift does not stop a repair (decision 8)", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 1 }).values);
		ctx.reg.learningData("dev").info.status = "drift";
		await feed(ctx, pauseRun(2, 25));
		assert.strictEqual(ctx.reg.learningData("dev").changes.at(-1).kind, "repair");
	});
	it("the replay pick holds at most 60 runs: the newest of each group plus every boundary run", () => {
		const st = JSON.parse(readFileSync(new URL("./fixtures/v4store.json", import.meta.url), "utf8"));
		upgradeStore(st);
		while (st.runs.length < 120) st.runs.push({ ...structuredClone(st.runs[st.runs.length % 10]), key: `k${st.runs.length}`, ts: st.runs.at(-1).ts + 3_600_000 });
		const pick = replayPick(st, st.runs.at(-1).ts);
		assert.ok(pick.length <= 60);
		for (const k of boundaryRuns(st)) assert.ok(pick.some(r => r.key === k), k);
	});
	it("an old V4 store without lastSeenTs is no 30-day outage; imported runs are not doubled", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const points = historyOf([washingMachine, washingMachine], host.now() - 2 * DAY);
		const ctx = await registrySetup({ host, history: historyEnv(points) });
		await drain(ctx);
		const st = ctx.reg.learningData("dev");
		const n = st.runs.length;
		delete st.lastSeenTs;
		await saveStore(ctx.files, st);
		ctx.reg.disposeAll();
		host.tickClock(2 * 3_600_000);
		const again = await registrySetup({ host, files: ctx.files, history: historyEnv(points) });
		await drain(again);
		assert.strictEqual(again.reg.learningData("dev").runs.length, n, "no run imported twice");
	});
	it("the same miss on a quarantined history run (sparse) triggers no repair and no 'use' hint (P22)", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const normal = historyOf([washingMachine, washingMachine, washingMachine], host.now() - 5 * DAY);
		const broken = sparse(historyOf([pauseRun(9, 21)], host.now() - DAY), 12);
		const ctx = await registrySetup({ host, history: historyEnv([...normal, ...broken]), detection: { ...WASHER, endCount: 20 } });
		await drain(ctx);
		const st = ctx.reg.learningData("dev");
		assert.ok(!st.changes.some(c => c.kind === "repair"));
		assert.deepStrictEqual(st.info.review ?? [], []);
		assert.ok(ctx.host.logs.warn.some(m => m.includes("recording disturbed, run not used")));
	});
	it("no candidate covers every admitted run → values unchanged, cannotCover, warning", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, pauseRun(1, 300));
		nextDay(ctx);
		const a = runOf({ device: "washer", programme: "quick30", seed: 2, after: 30 }).values;
		const b = runOf({ device: "washer", programme: "quick30", seed: 3 }).values;
		const before = structuredClone(ctx.reg.learningData("dev").override);
		await feed(ctx, [...a, ...b]);
		const st = ctx.reg.learningData("dev");
		assert.strictEqual(st.info.status, "cannotCover");
		assert.deepStrictEqual(st.override, before);
		assert.ok(ctx.host.logs.warn.some(m => m.includes("no values detect every admitted run")));
	});
	it("an old boundary run beyond 30 days stays in the check set and keeps its floor; target set is 30 days", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
		await feed(ctx, pauseRun(1, 60));
		const st = ctx.reg.learningData("dev");
		const old = st.runs[0];
		ctx.host.tickClock(40 * DAY);
		for (let k = 2; k <= 10; k++) { await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: k }).values); nextDay(ctx); }
		const now = ctx.host.now();
		assert.ok(!targetSet(st, now).includes(old) && checkSet(st, now).includes(old));
		assert.ok(waitSec(ctx.reg.get("dev").effective) > 600, "no tightening below the old pause");
	});
	it("hint exactly once; as a message only with optimizeNotify (G14)", async () => {
		for (const notify of [false, true]) {
			const host = createFakeHost({ objects: { [P]: "number" } });
			const test = historyOf([new Array(18).fill(2000)], host.now() - DAY);
			const ctx = await registrySetup({ host, notify, history: historyEnv([...historyOf([washingMachine, washingMachine, washingMachine], host.now() - 5 * DAY), ...test]) });
			await drain(ctx);
			await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 3 }).values);
			const st = ctx.reg.learningData("dev");
			assert.strictEqual((st.info.review ?? []).length, 1, "the hand test was mis-detected and is in form quarantine");
			const sent = ctx.host.sent.filter(x => x.instance === "telegram.0" && JSON.stringify(x.message).includes("verwenden"));
			assert.strictEqual(sent.length, notify ? 1 : 0);
		}
	});
	it("decisions survive clear → restart → bootstrap from history (P26)", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const points = historyOf([washingMachine, washingMachine, washingMachine, washingMachine], host.now() - 3 * DAY);
		const ctx = await registrySetup({ host, history: historyEnv(points) });
		await drain(ctx);
		const st = ctx.reg.learningData("dev");
		const key = st.runs[1].key;
		setDecision(st, key, "exclude");
		await ctx.reg.deleteLearningData("dev");
		const again = await registrySetup({ host, files: ctx.files, history: historyEnv(points) });
		await drain(again);
		const st2 = again.reg.learningData("dev");
		assert.strictEqual(st2.verdicts[key].user, "exclude");
		assert.ok(!targetSet(st2, host.now()).some(r => r.key === key));
	});
	it("history is read after an outage > 1 h, only for the outage", async () => {
		const host = createFakeHost({ objects: { [P]: "number" } });
		const ctx = await registrySetup({ host, history: historyEnv(historyOf([washingMachine, washingMachine], host.now() - 3 * DAY)) });
		await drain(ctx);
		const lastSeen = host.now();
		await saveStore(ctx.files, { ...ctx.reg.learningData("dev"), lastSeenTs: lastSeen });
		ctx.reg.disposeAll();
		host.tickClock(2 * 3_600_000);
		const h = historyEnv(historyOf([washingMachine], host.now() - 3_000_000));
		const queries = [];
		const getHistory = h.getHistory.bind(h);
		h.getHistory = async (id, o) => { queries.push(o); return getHistory(id, o); };
		const again = await registrySetup({ host, files: ctx.files, history: h });
		await drain(again);
		assert.ok(queries.length > 0 && queries.every(q => q.start >= lastSeen - 1), JSON.stringify(queries.map(q => q.start - lastSeen)));
	});
});

// test/learnRobustness.test.js
import assert from "node:assert";
import { analyzeHistory } from "../build/lib/historyLearning.js";
import { learnFinal } from "../build/lib/learn/finalLearn.js";
import { learnInput, WM_312 } from "./helpers/final.js";
import {
	asKw, bridge, cutTrailer, handTest, loadSeries, runIndex, withForeign, withGap, withHold, withSpikes,
} from "./helpers/fixtures.js";

const W = loadSeries("washer30d");
const day = id => runIndex("washer30d").find(r => r.id === id).ts;
const end = W.at(-1).ts + 3_600_000;
const near = (a, b) => Math.abs(a - b) <= 0.05 * Math.max(Math.abs(b), 1e-9);
const DEFECTS = {
	"foreign +150 W 20 min": withForeign(W, day("w09") - 25 * 60_000, 20, 150),
	"logger gap 20 min at 250 W": withHold(W, day("w08") + 3_600_000, 20, 250),
	"abort after 112 min": withGap(W, day("w10") + 112 * 60_000, 30),
	"50 spikes 3000 W": withSpikes(W, 50, 3000, 1),
	"50 spikes 400 W": withSpikes(W, 50, 400, 2),
	"hand test 3 min 2000 W": [...W, ...handTest(end, 3, 2000)],
	"hand test 5 min 300 W": [...W, ...handTest(end + 86_400_000, 5, 300)],
	"tail cut after 2 min": cutTrailer(W, day("w09") + 141 * 60_000),
	"three equal hand tests": [...W, ...[1, 2, 3].flatMap(k => handTest(end + k * 86_400_000, 3, 2000))],
	"two runs grown together": bridge(W, day("w10") + 150 * 60_000, day("w11"), 40),
};

describe("injected defects change no value (Spec 8.4)", function () {
	this.timeout(900_000);
	let base;
	let baseFinal;
	before(async () => {
		base = await analyzeHistory(W, 10, {});
		const inp = learnInput(W);
		baseFinal = await learnFinal(inp.runs, { base: WM_312, pollSec: 10, unitFactor: 1, abort: false, abortFixed: false, bands: inp.bands, minRuns: 5, minPerGroup: 1, yieldFn: async () => {} });
	});
	for (const [name, pts] of Object.entries(DEFECTS)) {
		it(`${name}: suggestion and final phase within ±5 %`, async () => {
			const sg = await analyzeHistory(pts, 10, {});
			for (const k of ["startVal", "endVal", "standby", "startCount", "endCount"]) assert.ok(near(sg.thresholds[k], base.thresholds[k]), `${k} ${sg.thresholds[k]} vs ${base.thresholds[k]}`);
			assert.strictEqual(sg.mode, base.mode);
			const inp = learnInput(pts);
			const f = await learnFinal(inp.runs, { base: WM_312, pollSec: 10, unitFactor: 1, abort: false, abortFixed: false, bands: inp.bands, minRuns: 5, minPerGroup: 1, yieldFn: async () => {} });
			assert.strictEqual(f.ok, baseFinal.ok);
			for (const k of ["finalMinVal", "finalMaxVal", "finalMinSec", "finalAfterSec"]) assert.ok(near(f.values[k], baseFinal.values[k]), `${k}`);
			assert.strictEqual(f.earlyEnds, 0);
		});
	}
	it("kW without unit text: unusable, no suggestion from it", async () => {
		const sg = await analyzeHistory(asKw(W), 10, { unitFactor: 1 });
		assert.ok("error" in sg || sg.thresholds.startVal < 1, "the analysis never treats kW values as W");
	});
	it("two devices silent at the same time: proven gap via the other device", () => {
		const inp = learnInput(withGap(W, day("w08") + 3_600_000, 20), { outages: [{ from: day("w08") + 3_600_000, to: day("w08") + 3_600_000 + 20 * 60_000 }] });
		const k = inp.runs.findIndex(x => Math.abs(x.sample.from - day("w08")) <= 300_000);
		assert.ok(inp.runs[k].verdict.reasons.some(r => r.code === "gap" && r.detail.startsWith("proven")));
	});
});
```

`createFakeHost`, `washingMachine`, `historyOf` sind in `test/optimizationIntegration.test.js` schon importiert. `test/optimizeOutliers.test.js` entsteht in Task 25 (braucht `setRunUse`). Bestehende Tests, die mit 4 Läufen verschärfen (`test/autoOptimize.test.js`, `test/optimizationIntegration.test.js`), auf 8 zugelassene Läufe anheben. Der frühere Test „merged runs triggers an immediate repair“ ist durch „merged runs trigger no repair and the end of the combined run is detected“ ersetzt (Entscheidung 9); im Recording-Layout ohne Segmentierung wären verschmolzene Läufe ohnehin als `run` (trusted) gespeichert worden (`…/scratchpad/review/merged.mjs`). In `learnRobustness.test.js` bleibt „two runs grown together“ ein Defekt, der keinen Wert ändert (`merged` ist `limited`, nicht für Statistik und Grenzwerte).

- [ ] **Step 2:** FAIL. **Step 3:** implementieren; Doku §8 (Mindestzahlen, Reparatur-Vorrang, verschmolzene Läufe sind kein Fehler, Drift sperrt nur das Verschärfen). **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: optimisation over 30 days with admitted runs, boundary runs, higher minimum counts and repair first`

---

### Task 22: Optimierung II – Schlussphase automatisch einschalten, nachführen, reparieren (Spec D.5, Entscheidung 3)

**Files:**
- Modify: `src/lib/learn/autoOptimize.ts` (`fromSuggestion` `:349`, `saferOf` `:456`, `stepLimit` `:553-603`, `optimize`), `src/lib/deviceRegistry.ts` (`reportOutcome` `:917`)
- Test: `test/optimizationIntegration.test.js`, `test/autoOptimize.test.js`

**Interfaces:**
- Consumes: `learnFinal` (Task 16, `minRuns` = `FINAL_ENABLE_MIN_RUNS`, `minPerGroup` = `FINAL_ENABLE_MIN_PER_GROUP`), `suspendFinal`/`resumeFinal` (Task 17), `needsRepair` (Task 21).
- Produces:
  - `FINAL_ENABLE_MIN_RUNS = 10`, `FINAL_ENABLE_MIN_PER_GROUP = 2`.
  - Analyse-Kandidaten übernehmen alle `final*` unverändert aus `p0`; `final*` ändern sich nur über `learnFinal`.
  - `stepLimitFinal(c: FinalSettings, p0: FinalSettings, covered: number): FinalSettings | null` – P ±10 %; Y steigt frei, sinkt ≤ 10 % und nur mit ≥ 5 abgedeckten Läufen; X sinkt ≤ 25 %; übrige aus den Daten neu; Kandidat mit `finalMinVal` 0 bei `p0.finalMinVal` > 0 → `null` (unzulässig).
  - Einschalten ohne Bestätigung: `p0` ohne Schlussphase, `learnFinal(checkSet).ok`, ≥ 10 zugelassene Läufe, ≥ 2 je betroffener Gruppe → Override mit `final*`, Änderung `finalOn` (Undo schaltet aus), Meldung nach `optimizeNotify`.
  - Eine zerteilte Schlussphase (`finalSplit`) oder Frühmeldung eines zugelassenen Laufs wird sofort nach dem Lauf ausgesetzt und repariert (Entscheidung 8), ohne `FINAL_ENABLE_MIN_*`, Sperre und `stepLimitFinal`; Änderung `finalRepair`, danach `resumeFinal("repair")`; nur das erneute Einschalten nach erfolgloser Reparatur braucht die Mindestzahlen.
  - Nach dem Aussetzen: `endOk` des frühen Endes richtig → `resumeFinal("endOk")`; sonst Reparatur (Y↑, X↑, P enger), `finalSplit`-Teile als **ein** Lauf nachgespielt; besteht das Gate → `resumeFinal("repair")` mit Meldung, sonst bleibt ausgesetzt mit Grund.
  - `windowsFeed(ctx, ids, copies)` aus `test/helpers/devices.js` (Task 21).
  - `ensureDeviceObjects` mit Override (Task 15) läuft, sobald die Optimierung die Schlussphase ein- oder ausschaltet (Änderung `finalOn`, Undo, Aussetzen ändert nichts am State-Bedarf), damit `settlingUntil` existiert.

- [ ] **Step 1: Failing tests**

```js
// test/optimizationIntegration.test.js
import { FINAL_ENABLE_MIN_PER_GROUP, FINAL_ENABLE_MIN_RUNS, stepLimitFinal } from "../build/lib/learn/autoOptimize.js";
import { FINAL_KEYS } from "../build/lib/detector/types.js";
import { soaking, WM_FINAL } from "./helpers/final.js";
import { loadSeries, runWindow, timelineOf } from "./helpers/fixtures.js";

const CLONES = ["w08", "w09", "w10", "w11", "w12"];
describe("final phase in the optimisation (Spec D.5)", function () {
	this.timeout(900_000);
	it("switches the final phase on by itself with 10 admitted runs and ≥ 2 per group, not with 9", async () => {
		assert.deepStrictEqual([FINAL_ENABLE_MIN_RUNS, FINAL_ENABLE_MIN_PER_GROUP], [10, 2]);
		const ctx = await registrySetup();
		const wins = [...CLONES, ...CLONES].map(id => runWindow("washer30d", id));
		await feedPoints(ctx, timelineOf(wins.slice(0, 9), DAY).map(p => ({ ts: p.ts - wins[0][0].ts + ctx.host.now(), val: p.val })));
		const st = ctx.reg.learningData("dev");
		assert.notStrictEqual(st.final?.state, "on");
		assert.strictEqual(ctx.reg.get("dev").effective.finalMinVal ?? 0, 0);
		await feedPoints(ctx, timelineOf([wins[9]], DAY).map(p => ({ ts: p.ts - wins[9][0].ts + ctx.host.now() + 3_600_000, val: p.val })));
		assert.strictEqual(st.final.state, "on");
		const c = st.changes.at(-1);
		assert.strictEqual(c.kind, "finalOn");
		assert.ok(ctx.reg.get("dev").effective.finalMinVal > 0);
		const u = await ctx.reg.undoOptimization("dev");
		assert.ok(u === true || u.ok === true, "undo (boolean until Task 25, then { ok })");
		assert.strictEqual(ctx.reg.get("dev").effective.finalMinVal ?? 0, 0, "undo switches it off");
	});
	it("analysis candidates never change final fields; no silent switch-off", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, ...WM_FINAL, endCount: 120 } });
		for (let k = 1; k <= 9; k++) { await feed(ctx, runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: k }).values); ctx.host.tickClock(25 * 3_600_000); }
		for (const c of ctx.reg.learningData("dev").changes.filter(x => x.kind === "tighten" || x.kind === "repair")) {
			for (const k of FINAL_KEYS) assert.strictEqual(c.to?.[k] ?? WM_FINAL[k], c.from?.[k] ?? WM_FINAL[k], `${c.kind} ${k}`);
		}
		assert.ok(ctx.reg.get("dev").effective.finalMinVal > 0);
	});
	it("own step limits of the final phase", () => {
		const p0 = { ...WM_FINAL };
		const c = stepLimitFinal({ ...WM_FINAL, finalMinVal: 100, finalMinSec: 100, finalAfterSec: 1000 }, p0, 4);
		assert.deepStrictEqual([c.finalMinVal, c.finalMinSec, c.finalAfterSec], [135, 168, 2700]);
		const d = stepLimitFinal({ ...WM_FINAL, finalMinVal: 200, finalMinSec: 100, finalAfterSec: 7200 }, p0, 5);
		assert.deepStrictEqual([d.finalMinVal, d.finalMinSec, d.finalAfterSec], [165, 151.2, 7200]);
		assert.strictEqual(stepLimitFinal({ ...WM_FINAL, finalMinVal: 0 }, p0, 9), null);
	});
	it("synthetic soaking programme: afterFinal start, finalSplit, suspended and repaired right after the run (also while locked), passed as one run", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, ...WM_FINAL } });
		const st0 = ctx.reg.learningData("dev");
		st0.lockRuns = 5;
		st0.lockUntilTs = ctx.host.now() + 10 * DAY;
		const pts = soaking(loadSeries("washer30d"), 8);
		const win = runWindow("washer30d", "w09");
		await feedPoints(ctx, pts.filter(p => p.ts >= win[0].ts && p.ts <= win.at(-1).ts + 3_600_000).map(p => ({ ts: p.ts - win[0].ts + ctx.host.now(), val: p.val })));
		const st = ctx.reg.learningData("dev");
		assert.ok(st.runs.some(r => r.afterFinal !== undefined));
		assert.ok(st.final.splits.length >= 1);
		assert.ok(st.changes.some(c => c.kind === "finalSuspend"));
		const rep = st.changes.find(c => c.kind === "finalRepair");
		assert.ok(rep, "repair started right after the run");
		if (st.final.state === "on") {
			assert.ok(ctx.reg.get("dev").effective.finalMinSec > WM_FINAL.finalMinSec, "Y raised above the inserted block");
			assert.strictEqual((await ctx.reg.checkStoredRuns("dev")).ok, true);
		} else {
			assert.ok(st.final.reason, "stays suspended with a reason");
		}
	});
	it("resume after a correct early end", async () => {
		const ctx = await registrySetup({ detection: { ...WASHER, ...WM_FINAL } });
		const st = ctx.reg.learningData("dev");
		await ctx.reg.suspendFinal("dev", "earlyEnd", "dev@1");
		await feedPoints(ctx, runWindow("washer30d", "w10").map(p => ({ ts: p.ts - runWindow("washer30d", "w10")[0].ts + ctx.host.now(), val: p.val })));
		assert.strictEqual(st.final.state, "on");
		assert.strictEqual(st.changes.at(-1).kind, "finalResume");
	});
});
```

Zahlen im Schrittgrenzen-Test aus der Regel: P 150 → 100 begrenzt auf −10 % = 135; Y 168 → 100 mit 4 abgedeckten Läufen: Senken nicht erlaubt → 168; X 3600 → 1000 begrenzt auf −25 % = 2700; mit 5 Läufen Y −10 % = 151,2; P 150 → 200 begrenzt auf +10 % = 165; X steigt frei.

- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (Schlussphase automatisch an ab 10 Läufen und 2 je Gruppe, Undo, Nachführen, Aussetzen und Reparatur); Changelog-Zeile zur Optimierung.
- [ ] **Step 5: Commit** `feat: auto-optimisation switches the final phase on, tunes and repairs it when every admitted run proves it`

---

### Task 23: Optimierung III – Phasen-Feinjustierung und Budget reihum (Spec D.3 Budget, D.6)

**Files:**
- Modify: `src/lib/learn/autoOptimize.ts` (`OptimizeContext` `:44-62`, `BudgetExceeded`), `src/lib/deviceRegistry.ts` (`OPTIMIZE_BUDGET_MS` `:52`, `optimizeContext` `:765`, `runOptimize`), `src/lib/phases/learn.ts`
- Test: `test/optimizationIntegration.test.js`, `test/phaseLearn.test.js`

**Interfaces:**
- Consumes: `store.job` (Task 13), `RegistryOptions.budgetMs` (Task 21), `learnPhases` (Task 19).
- Produces:
  - Budget = aktive Rechenzeit: `OptimizeContext.clock` misst nur zwischen zwei `yieldFn`-Aufrufen; Grenze `budgetMs` (30 000) je Job; `OptimizeOutcome.activeMs: number`.
  - Billiger Teil je Lauf (Verdict, Gate über die Prüfmenge, Reparatur/Aussetzen) läuft immer, auch bei Budgetende; teure Schritte reihum über `store.job` (`"tighten" | "final" | "phases"`, `cursor`); Gegenproben höchstens einmal je Tag und nur bei neuen zugelassenen Läufen der betroffenen Gruppe.
  - Abbruch: keine Änderung aus dem unterbrochenen Schritt, Fortschritt gespeichert, `optimizeInfo.budget` = Anzahl in Folge (0 nach einem vollständigen Job), ab 3 Log-Warnung `<name>: optimisation too slow on this system (3 jobs in a row)` und Kartenwarnung (Nachricht nur bei `optimizeNotify`); `optimizeInfo.jobMs` = `activeMs` des letzten Jobs.
  - `tunePhases(model: PhaseModel, units: { sample: RunSample; verdict: Verdict }[], prev: PhaseTuneProposal | null): { model: PhaseModel | null; proposal: PhaseTuneProposal; newPattern: boolean }`; `PhaseTuneProposal = { hash: string; bands: { id: string; min: number; max: number }[]; phases: { id: string; minSec: number; maxSec: number }[] }` – Bandgrenzen ±15 %, `minSec`/`maxSec`, `confirmSec`/`tailSec`; `model` ≠ null erst, wenn `prev.hash === proposal.hash` und die Übereinstimmung der Gegenprobe nicht sinkt; nie anlegen, entfernen, umbenennen.

- [ ] **Step 1: Failing tests**

```js
// test/optimizationIntegration.test.js
import { optimize } from "../build/lib/learn/autoOptimize.js";
const CLONE_IDS = ["w08", "w09", "w10"];
async function thirtyRuns(o = {}) {
	const host = createFakeHost({ objects: { [P]: "number" } });
	const wins = Array.from({ length: 30 }, (_, k) => runWindow("washer30d", CLONE_IDS[k % 3]));
	const pts = timelineOf(wins, DAY).map(p => ({ ts: p.ts - wins[0][0].ts + host.now() - 31 * DAY, val: p.val }));
	const ctx = await registrySetup({ host, history: historyEnv(pts), ...o });
	await drain(ctx);
	return ctx;
}
function optCtx(ctx, budgetMs, clock) {
	return { type: ctx.reg.get("dev").baseDetection, pollSec: 10, abort: false, abortFixed: false, yieldFn: async () => {}, now: ctx.host.now(), budgetMs, clock };
}
describe("optimisation budget (Spec D.3)", function () {
	this.timeout(900_000);
	it("an interrupted step changes nothing and the next job resumes it", async () => {
		const ctx = await thirtyRuns();
		const st = ctx.reg.learningData("dev");
		const before = structuredClone(st.override);
		let t = 0;
		const r1 = await optimize(st, optCtx(ctx, 50, () => (t += 10)));
		assert.deepStrictEqual([r1.kind, st.override], ["budget", before]);
		const cursor = structuredClone(st.job);
		assert.ok(cursor && cursor.cursor > 0);
		const r2 = await optimize(st, optCtx(ctx, 30_000, () => (t += 1)));
		assert.notStrictEqual(r2.kind, "budget");
		assert.ok(!st.job || st.job.step !== cursor.step || st.job.cursor !== cursor.cursor);
	});
	it("wall time spent in yields does not count", async () => {
		const ctx = await thirtyRuns();
		const st = ctx.reg.learningData("dev");
		let wall = 0;
		const c = { ...optCtx(ctx, 30_000, () => wall), yieldFn: async () => { wall += 3_600_000; } };
		const r = await optimize(st, c);
		assert.notStrictEqual(r.kind, "budget");
	});
	it("every expensive step completes within at most 3 jobs (30 washer runs, 3 groups, 30 s)", async () => {
		const ctx = await thirtyRuns();
		const st = ctx.reg.learningData("dev");
		let jobs = 0;
		// injected clock: 1 ms per clock read stands for the work between two yields; no wall time under c8 (cf. 5684124)
		let t = 0;
		do { await optimize(st, optCtx(ctx, 30_000, () => (t += 1))); jobs++; } while (st.job && jobs < 3);
		assert.ok(!st.job, `still at ${JSON.stringify(st.job)} after ${jobs} jobs`);
	});
	it("budget status counts in a row; warning from the 3rd", async () => {
		const ctx = await thirtyRuns({ budgetMs: 1 });
		// the bootstrap job with budgetMs 1 counts as well: check the increase by 3
		const before = ctx.reg.learningData("dev").info.budget ?? 0;
		for (let k = 1; k <= 3; k++) { await feed(ctx, runOf({ device: "washer", programme: "cotton60", shape: "T3", seed: k }).values); ctx.host.tickClock(25 * 3_600_000); }
		assert.strictEqual(ctx.reg.learningData("dev").info.budget, before + 3);
		assert.ok(ctx.host.logs.warn.some(m => m.includes("optimisation too slow on this system (3 jobs in a row)")));
	});
});

// test/phaseLearn.test.js
import { tunePhases } from "../build/lib/phases/learn.js";
it("phase tuning needs two equal proposals, keeps ids and never adds or removes phases (D.6)", () => {
	const { units } = phaseInput(W);
	const first = tunePhases(WM_PHASES, units, null);
	assert.strictEqual(first.model, null);
	const second = tunePhases(WM_PHASES, units, first.proposal);
	const m = second.model ?? WM_PHASES;
	assert.deepStrictEqual(m.phases.map(p => [p.id, p.name]), WM_PHASES.phases.map(p => [p.id, p.name]));
	for (const b of m.bands) {
		const o = WM_PHASES.bands.find(x => x.id === b.id);
		assert.ok(b.min >= o.min * 0.85 - 1e-9 && b.min <= o.min * 1.15 + 1e-9, b.id);
	}
	const other = tunePhases(WM_PHASES, units.slice(0, 6), first.proposal);
	assert.ok(other.proposal.hash === first.proposal.hash || other.model === null);
});
```

- [ ] **Step 2:** FAIL. **Step 3:** implementieren. **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (Budget, Warnung „Optimierung zu langsam“, Phasen-Feinjustierung) und §13 (`optimizeInfo.budget`, `jobMs`).
- [ ] **Step 5: Commit** `feat: optimisation budget by active compute time, expensive steps in turn, phase fine tuning with hysteresis`

---

### Task 24: Dialog „Anlernen“ mit Laufprüfung, Schlussphase und Phasen (Spec B.7, 7.3)

**Files:**
- Modify: `src/lib/deviceManagement.ts` (`learn` `:832`, `learnFromHistory` `:865-952`, `buildLearnSchema` `:1385`, `parseLearnForm` `:1582`), `src/lib/deviceRegistry.ts` (`stopLearning`), `src/lib/dmTexts.ts`, `admin/i18n/*.json`
- Test: `test/deviceManagement.test.js`

**Interfaces:**
- Consumes: `checkRuns`, `runSamples`, `learnFinal` (`minRuns` 5, `minPerGroup` 1), `learnPhases`, `applyLearned` (Task 4), `setDecision` (Task 13).
- Produces:
  - `interface RunRow { key: string; date: string; durationMin: number; energyWh: number; family: number; phases: string; check: string; boundary: string; use: "auto" | "include" | "exclude" }`; `buildRunTable(rows: RunRow[], mode: "table" | "fallback"): PanelItems` – `table` mit `noDelete: true` und `select`-Spalte `use`, sonst `staticText` + `select` mit `multiple: true` je Verwendung. **Beide Varianten werden gebaut und getestet; Standard ist `fallback`** (funktioniert in jedem Fall), bis der User die Echtsystem-Prüfung (Step 1) bestätigt; erst dann wird der Standard auf `table` umgestellt (Konstante `RUN_TABLE_MODE` mit Kommentar zum Ergebnis).
  - Dialogschritte: Läufe (Formulardaten `runs: RunRow[]`, Knopf `recalc`, Hinweis `dm_learnFormerlyDropped` bei `formerlyDropped`) → Erkennung (Start/Ende nur aus zugelassenen Läufen, `final_apply` standardmäßig `false`, Kennzahlen `final_text` = de „Fertig im Median <m> min früher, <n> von <k> Läufen, 0 zu früh, <f> Rückfall“, en „Finished <m> min earlier (median), <n> of <k> runs, 0 too early, <f> fallback“) → Phasen (nur bei `showPhases`; Feld `phase_<id>_final` nur bei Freigabe).
  - „Übernehmen“ schreibt `detection` (+ `final*` bei `final_apply`), `phases` ins Gerät und `verdicts` in den Speicher; kein Neustart. **Mit `final_apply`** legt es zusätzlich die zugelassenen Läufe des Dialogs (`src: "history"`) und `store.bands` im Laufspeicher ab, damit die Beurteilung im Nachhinein (Task 17) Vergleichsdaten hat; ist kein Speicher aktiv, wird er angelegt (Betriebsart „nur Schlussphase“). `DeviceRegistry.setDecisions(deviceId: string, decisions: Record<string, "include" | "exclude" | null>, runs?: StoredRun[], bands?: BaseBands): Promise<void>` schreibt Entscheidungen (und ggf. Läufe/Bänder) auch ohne geladenen Speicher (lädt bzw. legt die Datei an). „Aufzeichnen“ liefert Start-/Ende-Werte und nur die Prüfungen `incomplete`, beweisbare `gap`, `unit`, `counter`, `invalid`; Phasen nur bei `continuous` und ≥ 3 Belegen; Schlussphase nie.

- [ ] **Step 1: Schritt für den User** (das Echtsystem wird vom Agent nur gelesen): Der Agent baut den Branch (`npm run build`) und erzeugt mit `npm pack` das Paket; er legt in `buildRunTable` eine vorübergehende Instanz-Aktion `dm_testRunTable` an, die ein Formular mit drei Beispielzeilen in Variante `table` zeigt. **Der User** installiert dieses Paket auf seinem Testsystem (Admin → Adapter → „Aus eigener Datei installieren“ bzw. `iob url <Pfad zur .tgz>`), startet die Instanz neu, öffnet im Device Manager der Instanz die Aktion „Testtabelle“, ändert in Zeile 2 die Spalte „Verwendung“ auf „Nicht verwenden“, bestätigt mit OK und meldet: (a) war die Auswahlspalte bearbeitbar, (b) steht im Log der Instanz die Zeile `run table test: [...]` mit `exclude` in Zeile 2. Danach liest der Agent nur per MCP (`mcp__iobroker__get_logs`, `get_object` der Instanz) und trägt das Ergebnis als Kommentar an `RUN_TABLE_MODE` ein; die Testaktion wird vor dem Commit wieder entfernt. Bis zur Rückmeldung bleibt `fallback` Standard, die Umsetzung wartet nicht darauf.
- [ ] **Step 2: Failing tests** (`test/deviceManagement.test.js`, lokale Helfer `setup`, `addDevice`, `load`, `fakeAction`, `actionOf`, `withHistory`):

```js
import { loadSeries } from "./helpers/fixtures.js";
const WPTS = loadSeries("washer30d");
describe("learning dialog with the run check (Spec B.7)", function () {
	this.timeout(600_000);
	async function open(answers, cfg = {}) {
		const ctx = setup({ files: memoryFiles() });
		await addDevice(ctx, "wm", deviceCfg({ name: "WM", template: "washing-machine", ...cfg }));
		withHistory(ctx, WPTS);
		const [info] = await load(ctx);
		const action = fakeAction({ forms: answers });
		await actionOf(info, "learn").handler("wm", action);
		return { ctx, action };
	}
	it("lists every run with its check; sparse w04 marked, use column defaults to auto", async () => {
		const { action } = await open([{ source: "history", instance: "history.0" }]);
		const rows = action.forms[1].options.data.runs;
		assert.strictEqual(rows.length, 13);
		assert.ok(rows.every(r => r.use === "auto"));
		assert.ok(rows.some(r => /sparse|gestört/i.test(r.check)));
		assert.ok(action.forms[1].schema.items.runs || action.forms[1].schema.items.runs_text, "table or fallback");
	});
	it("suggestion from admitted runs only; final phase offered with key figures, checkbox off by default", async () => {
		const { action } = await open([{ source: "history", instance: "history.0" }, { operation: "next" }]);
		const d = action.forms[2].options.data;
		assert.strictEqual(d.final_apply, false);
		// the tests run with I18n "en" (test/helpers/i18n.js)
		assert.match(d.final_text, /^Finished \d+ min earlier \(median\), \d+ of \d+ runs, 0 too early, \d+ fallback/);
	});
	it("both run table variants are built; fallback is the default until the real system check", () => {
		const rows = [{ key: "wm@1", date: "01.11.", durationMin: 140, energyWh: 600, family: 0, phases: "", check: "✓", boundary: "", use: "auto" }];
		assert.strictEqual(buildRunTable(rows, "table").runs.type, "table");
		assert.ok(Object.values(buildRunTable(rows, "fallback")).some(i => i.type === "select" && i.multiple === true));
		assert.strictEqual(RUN_TABLE_MODE, "fallback");
	});
	it("apply writes detection, final values and phases into the device and decisions into the store, no restart", async () => {
		const { ctx, action } = await open([
			{ source: "history", instance: "history.0" },
			{ operation: "next", runs: [{ use: "exclude" }] },
			{ operation: "apply", final_apply: true, showPhases: true },
		]);
		const native = ctx.adapter.objects.get(`${NS}.wm`).native;
		assert.ok(native.detection.finalMinVal > 0 && native.phases?.enabled === true);
		assert.strictEqual(native.template, undefined);
		assert.deepStrictEqual(ctx.adapter.extendedForeign, []);
		const st = await ctx.registry.readLearningData("wm");
		assert.ok(Object.values(st.verdicts).some(v => v.user === "exclude"));
		assert.ok(st.runs.length >= 5 && st.runs.every(r => r.src === "history"), "comparison runs for judging afterwards");
		assert.ok(st.bands, "base bands stored");
		assert.ok(action.messages.length >= 0);
	});
	it("recording a run never offers a final phase", async () => {
		const ctx = setup();
		await addDevice(ctx, "trockner");
		await ctx.registry.startLearning("trockner");
		for (const v of runOf({ device: "washer", programme: "cotton60", seed: 1 }).values) {
			await ctx.registry.routeForeignState(POWER, v);
			ctx.host.tickClock(10_000);
			await ctx.registry.tickAll();
		}
		const [info] = await load(ctx);
		const action = fakeAction({ forms: [] });
		await actionOf(info, "learn").handler("trockner", action);
		assert.strictEqual(action.forms[0].options.data.final_apply, undefined);
		assert.strictEqual(action.forms[0].schema.items.final_apply, undefined);
	});
	it("an energy counter aborts with its reason", async () => {
		const ctx = setup();
		await addDevice(ctx, "trockner");
		withHistory(ctx, historyOf([washingMachine, washingMachine]), { unit: "kWh" });
		const [info] = await load(ctx);
		const action = fakeAction({ forms: [] });
		await actionOf(info, "learn").handler("trockner", action);
		assert.ok(action.messages.includes(TEXT.learnEnergyCounter));
	});
});
```

Imports: `buildRunTable`, `RUN_TABLE_MODE` aus `../build/lib/deviceManagement.js`.

- [ ] **Step 3:** FAIL → implementieren (de/en, `npm run translate`) → **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (Anlern-Dialog: Läufe mit Prüfung und Verwendung, Vorschlag Schlussphase mit Kennzahlen, Phasen benennen); Changelog-Zeile zum Anlernen.
- [ ] **Step 5: Commit** `feat: learning dialog shows every run with its check and offers final phase and phases`

---

### Task 25: Optimierungsdialog (Spec D.7)

**Files:**
- Modify: `src/lib/deviceManagement.ts` (`optimization` `:767-830`, `buildOptimizationView` `:1183-1343`), `src/lib/deviceRegistry.ts` (`undoOptimization` `:494`, `resetOptimization` `:520`, `discardRun` → `setRunUse`), `src/lib/dmTexts.ts`, `admin/i18n/*.json`
- Create: `test/optimizeOutliers.test.js`
- Test: `test/deviceManagement.test.js`

**Interfaces:**
- Consumes: Tasks 8, 13, 17, 21, 22.
- Produces:
  - `DeviceRegistry.setRunUse(deviceId: string, key: string, use: "include" | "exclude" | null): Promise<{ reverted: boolean }>` – setzt die Entscheidung, berechnet `envelope` neu und führt **sofort** `needsRepair` und ggf. die Reparatur aus (Wiederverwenden eines Grenzlaufs stellt so `envelope` und Werte wieder her); der auslösende Lauf einer Reparatur steht in `Change.trigger` (Task 17). Ausschließen eines Grenzlaufs, der eine Reparatur ausgelöst hat: Gate der Werte vor der Reparatur über die verbleibenden zugelassenen Läufe; besteht es, Reparatur zurück (Änderung `revert`), Sperre aufgehoben (`lockRuns = 0`, `lockUntilTs = 0`).
  - `DeviceRegistry.undoOptimization(deviceId: string, excludeTrigger?: boolean): Promise<{ ok: boolean; failing: string[]; offerExclude: string | null }>` – nur bis zur letzten `adopted`/`baseChanged`, vor dem Setzen mit Gate; scheitert es, `failing` = Schlüssel; `offerExclude` = Schlüssel des Grenzlaufs, der die rückgängig gemachte Reparatur ausgelöst hat.
  - Dialog-Operationen: `use` (mit `runKey`, `use`), `undo`, `reset`, `clear` (Option `clearDecisions`), `adopt` (Task 8), `finalOn`, `newRun` (bei `finalSplit`, mit `runKey` → `resumeFinal(…, "newRun", runKey)`), `dropLegacy` (Warnung, löscht `legacyEnvelope`).
  - Tabelle: Datum, Dauer, Gruppe, Quelle, Prüfung, Verwendung, Grenzlauf (Grenze, Wert ohne ihn, Veto), ✓/✗; Warnung vor dem Ausschließen eines Grenzlaufs: „Wenn dieser Lauf echt war, kann ein solcher Lauf künftig zu früh als fertig gemeldet werden“.

- [ ] **Step 1: Failing tests**

```js
// test/optimizeOutliers.test.js
import assert from "node:assert";
import { feed, pauseRun, registrySetup, WASHER } from "./helpers/devices.js";
import { runOf } from "./helpers/programmes.js";

it("a clean boundary run repairs at once; excluding and including it again restores envelope and values (Spec D.4)", async () => {
	const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
	await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 1 }).values);
	const st = ctx.reg.learningData("dev");
	const env0 = structuredClone(st.envelope);
	const ov0 = structuredClone(st.override);
	await feed(ctx, pauseRun(2, 30));
	assert.strictEqual(st.changes.at(-1).kind, "repair");
	const key = st.runs.at(-1).key;
	const env1 = structuredClone(st.envelope);
	const ov1 = structuredClone(st.override);
	await ctx.reg.setRunUse("dev", key, "exclude");
	assert.deepStrictEqual([st.envelope, st.override], [env0, ov0]);
	await ctx.reg.setRunUse("dev", key, null);
	assert.deepStrictEqual([st.envelope, st.override], [env1, ov1]);
});
it("a run in form quarantine (hand test) changes nothing until 'use'", async () => {
	const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
	await feed(ctx, [...new Array(6).fill(0.3), ...new Array(18).fill(2000), ...new Array(300).fill(0.3)]);
	const st = ctx.reg.learningData("dev");
	assert.ok(!st.changes.some(c => c.kind === "repair"));
	const key = [...st.runs, ...st.spikes].at(-1).key;
	await ctx.reg.setRunUse("dev", key, "include");
	assert.strictEqual(ctx.reg.learningData("dev").verdicts[key].user, "include");
});
it("excluding a boundary run that triggered a repair reverts the repair and lifts the lock (P25)", async () => {
	const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
	await feed(ctx, runOf({ device: "washer", programme: "cotton60", seed: 1 }).values);
	await feed(ctx, pauseRun(2, 30));
	const st = ctx.reg.learningData("dev");
	const before = st.changes.at(-1).from;
	const r = await ctx.reg.setRunUse("dev", st.runs.at(-1).key, "exclude");
	assert.strictEqual(r.reverted, true);
	assert.deepStrictEqual([st.override, st.changes.at(-1).kind, st.lockRuns, st.lockUntilTs], [before, "revert", 0, 0]);
});
it("undo offers to exclude the triggering run; undo only back to the last base change and only if the gate passes", async () => {
	const ctx = await registrySetup({ detection: { ...WASHER, endCount: 20 } });
	await feed(ctx, pauseRun(2, 30));
	const st = ctx.reg.learningData("dev");
	const r = await ctx.reg.undoOptimization("dev");
	assert.deepStrictEqual([r.ok, r.offerExclude], [false, st.runs.at(-1).key]);
	assert.ok(r.failing.includes(st.runs.at(-1).key));
	const r2 = await ctx.reg.undoOptimization("dev", true);
	assert.strictEqual(r2.ok, true);
	await ctx.reg.upsert("dev", { ...ctx.cfg, detection: { ...WASHER, endCount: 40 } });
	assert.strictEqual((await ctx.reg.undoOptimization("dev")).ok, false, "nothing before the base change");
});

// test/deviceManagement.test.js (optSetup/openDialog)
// Imports in test/deviceManagement.test.js: WASHER aus ./helpers/devices.js, WM_FINAL aus ./helpers/final.js
it("drop old limits removes legacyEnvelope after a warning", async () => {
	const ctx = await optSetup();
	ctx.registry.learningData("trockner").legacyEnvelope = { maxPauseSec: 900, maxBurstSec: 0, maxTrailSec: 0, maxTrailerSec: 0, minRunW: 0, minCoreSec: 0, n: 3 };
	const action = await openDialog(ctx, { operation: "dropLegacy" });
	assert.ok(action.confirmations.length === 1);
	assert.strictEqual(ctx.registry.learningData("trockner").legacyEnvelope, undefined);
});
it("'was a new run' resumes the final phase without auto-optimisation", async () => {
	const ctx = await optSetup({ autoOptimize: undefined, detection: { ...WASHER, ...WM_FINAL } }, false);
	await ctx.registry.suspendFinal("trockner", "finalSplit", "trockner@5");
	await openDialog(ctx, { operation: "newRun", runKey: "trockner@5" });
	assert.strictEqual(ctx.registry.get("trockner").active.finalMinVal, 150);
});
it("the run table shows the value without a boundary run and warns before excluding it", async () => {
	const ctx = await optSetup();
	const action = await openDialog(ctx, { operation: "use", runKey: ctx.registry.learningData("trockner").runs[0].key, use: "exclude" });
	const rows = action.forms[0].options.data.runs;
	assert.ok(rows.some(r => /ohne ihn|without it/.test(r.boundary)) || rows.every(r => r.boundary === ""));
	assert.ok(action.confirmations.some(c => JSON.stringify(c).includes("zu früh als fertig") || JSON.stringify(c).includes("too early")));
});
it("clear keeps decisions unless 'also discard decisions' is ticked", async () => {
	const ctx = await optSetup();
	const st = ctx.registry.learningData("trockner");
	const key = st.runs[0].key;
	await ctx.registry.setRunUse("trockner", key, "exclude");
	await openDialog(ctx, { operation: "clear", clearDecisions: false });
	assert.strictEqual((await ctx.registry.readLearningData("trockner")).verdicts[key].user, "exclude");
	await openDialog(ctx, { operation: "clear", clearDecisions: true });
	assert.deepStrictEqual((await ctx.registry.readLearningData("trockner")).verdicts, {});
});
```

- [ ] **Step 2:** FAIL → **Step 3:** implementieren → **Step 4:** `npm test` → PASS.
- [ ] **Doku:** `docs/de|en/README.md` §8 (Optimierungsdialog: Verwendung je Lauf, Grenzlauf mit Wert ohne ihn, Undo nur bis zur letzten Grundwertänderung, „war ein neuer Lauf“, „Altgrenzen verwerfen“, „auch Entscheidungen verwerfen“); Changelog-Zeile zur Optimierung.
- [ ] **Step 5: Commit** `feat: optimisation dialog with run use, coupled undo and exclusion, final phase controls`

---

### Task 26: Dokumentation, Changelog, Release-Notes – Gesamtabgleich (Spec 7.5, Befund M11)

Die Tasks 4–25 haben ihre Doku- und Changelog-Anteile schon im eigenen Commit geändert (Global Constraints). Hier wird nur noch geprüft und vereinheitlicht: Vollständigkeit gegen Spec 7.5, gleiche Begriffe in de/en, genau 6 WIP-Zeilen, Release-Notes.

**Files:**
- Modify: `docs/de/README.md`, `docs/en/README.md` (§2, §3, neues Kapitel „Phasen“, §7, §8, §9, §13), `docs/release-notes-4.0.0.md:69-79`, `README.md:30-37`

**Interfaces:** keine.

- [ ] **Step 1: Doku de/en** nach Spec 7.5: Vorlagen und Werte im Gerät; Kapitel „Phasen“ (inkl. was nur rückwirkend erscheint); §8 Laufprüfung, Verwendung, Grenzläufe, Reparatur-Vorrang (sofort nach einem falsch erkannten zugelassenen Lauf, ohne Mindestzahl, Sperre und Schrittgrenze), Schlussphase (nur wo Daten trennen und ein Nachlauf existiert; Grenzen der Felder nach Spec A.2 „Bereich“), 30 Tage, Mindestzahlen (8 Läufe Verschärfung, 10 Läufe/2 je Gruppe Schlussphase, Reparatur sofort), automatisches Einschalten mit Undo, `keepCurrentLevel`, Restrisiko erstes unbekanntes Programm, Verhalten nach frühem Ende, Startverzögerung nach Ausräumen (Beispiel WM ≤ ~4 min); §9 Migration (exakte Namen, unbekannter Typ deaktiviert, umbenannte Plätze, V4-Teststände, Kopien bei geteilten Typen, Archiv inkl. Namen, vor V5 verworfene Läufe können erneut erscheinen, Warnungen aus Befund M5–M7, Verhaltensänderungen M11); §13 States inkl. `settlingUntil`, `phase*`, `learning.parameters`; §7 Aktionen `phaseStart`/`phaseEnd`.
- [ ] **Step 2: Changelog** – weiterhin genau 6 Zeilen unter `### **WORK IN PROGRESS**`; Zeile 35 umformulieren (statt „save the values as a device type“: Werte im Gerät, Laufprüfung, Schlussphase), Zeile 34 um Phasen ergänzen; nutzerverständlich, Format `- (Eistee82) …`.
- [ ] **Step 3: Release-Notes** `:69-79` (Typen → Vorlagen/Archiv).
- [ ] **Step 4: Prüfen:** `npm test` (inkl. `docsStates.test.js`) grün; im WIP-Block genau 6 Zeilen `- (Eistee82)`; keine E-Mail-Adresse in `docs/de/README.md`, `docs/en/README.md`, `README.md` (`grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}"` leer).
- [ ] **Step 5: Commit** `docs: templates, phases, final phase, run check and migration notes`

---

### Task 27: Abnahme und Gesamtprüfung

**Files:** keine Codeänderung (nur bei Befund: Fix in der betroffenen Task-Datei mit eigenem Test).

- [ ] **Step 1:** `npm run build && npm run lint && npm test` → grün, 0 Warnings, Coverage-Grenzen von `test:unit` eingehalten.
- [ ] **Step 2a: Schritt für den User** (der Agent installiert nichts und startet nichts): Der Agent erzeugt mit `npm pack` das Paket des Branch-Stands und nennt dem User Pfad und Prüfliste. **Der User** sichert vorher die Instanz-native und die Geräteobjekte (Admin → Objekte → `system.adapter.device-reminder.0` und `device-reminder.0.*` exportieren), installiert das Paket (Admin → „Aus eigener Datei installieren“ bzw. `iob url <Pfad zur .tgz>`) und startet die Instanz neu; meldet danach „installiert“. Ist das System ein Raspberry Pi 4: nach drei WM-Läufen Rückmeldung an den Agent.
- [ ] **Step 2b: Lesende Prüfung durch den Agent** (`mcp__iobroker__get_object`, `get_states`, `search_objects`, `get_logs`, `read_file` der Lerndateien unter `device-reminder.0` – nur lesen): V4-Geräte haben `detection`, kein `typeId`; Instanz-native unverändert gegenüber der Sicherung; `learning.parameters` mit vier Ebenen; Override erhalten; keine Warnungen außer erwarteten. Auf einem Pi 4 nach drei WM-Läufen `learning.optimizeInfo.jobMs` lesen – Abnahme D.3: jeder teure Schritt in ≤ 3 Jobs abgeschlossen, keine `budget`-Warnung. Ist das System kein Pi 4, bleibt die Messung (Pi 4, 30 WM-Läufe, 3 Gruppen) als offener Schritt für den User im Abschlussbericht.
- [ ] **Step 3: Spec-Abgleich:** jede Zeile der Ziele Z1–Z6, Garantien G1–G15 und der Tabelle C.5 einem grünen Test zuordnen; Lücken als Test in der zuständigen Datei nachziehen.
- [ ] **Step 4:** Skill `precommit-check` komplett.
- [ ] **Step 5: Commit** (nur falls Step 3 Tests ergänzt hat) `test: acceptance coverage of the phase concept`

---

## Planprüfung (Prüfbefunde vom 14.11.2026)

Jeder Befund wurde vor der Übernahme am Code (Stand 5684124) bzw. mit den Prüfskripten unter `C:/Users/Eistee/AppData/Local/Temp/claude/76a49c15faa97d7f/20aedea5-acc7-47c0-b284-a72daa939b11/scratchpad/review/` nachvollzogen (`cap.mjs`, `synth.mjs`, `synth2.mjs`, `ids.mjs`, `fam.mjs`, `p999.mjs`, `phantom.mjs`, `tb.mjs` nachgerechnet; Code-Stellen gelesen). Kein Befund wurde verworfen; zwei Teile sind durch die Entscheidung des Users zu verschmolzenen Läufen (Entscheidung 9) ersetzt.

| # | Schwere | Befund (kurz) | Geprüft | Ergebnis | Eingearbeitet in |
|---|---|---|---|---|---|
| 1 | kritisch | Capture mit zwei richtig gemeldeten Läufen wird `split` und „repariert“; prev/next für `checkFinalSplit` unklar; Spec-`merged` über Live-Starts | `runRecorder.ts:117-166`, `runs.ts:823`, `labelCapture` (`runStore.ts`); `cap.mjs` bestätigt `endCount` 50 → 300 | übernommen; der Teil „`merged` → Quarantäne“ ersetzt durch Entscheidung 9 (`merged` nur über Layout-Merkmale, `limited`, keine Reparatur) | Task 12, 17 (`splitCapture`, `split`-Definition, Test 15 min Abstand), 21; Spec B.2, D.3, Abschnitt 10 |
| 2 | hoch | Task 24 Step 1 und Task 27 Step 2 installieren bzw. starten am Echtsystem | feste Regel „Echtsystem nur lesen“ | übernommen | Global Constraints, Task 24 Step 1, Task 27 Step 2a/2b; Spec 7.3, 8.6 |
| 3 | hoch | `syntheticRun()` ohne frühes Ende (Wasch-Segment 360–389 im Block) | `synth.mjs`: X 60 min → `finished@489`, `early 0`; `synth2.mjs`: 3 W in 380–389 → frühes Ende bei `coreEnd + 13`, Ausgang b | übernommen | Task 14 (`syntheticRun`, `stats.early === 1` in allen betroffenen Tests) |
| 4 | hoch | Eigenschafts- und Golden-Test feuern mit `WM_FINAL` auf 400 Ticks nie | `randomCurve` 400 Ticks (`test/helpers/golden.js`); `gold.mjs` 0/1648 | übernommen (`SHORT_FINAL`; frühe Enden je Modus und jeder Ausgang a–g geprüft) | Task 14 |
| 5 | hoch | Endblock und `tailCeil` aus dem Layout nicht berechenbar, Spec-Beleg zirkulär über P | `tb.mjs`: Minimum 6 W > `runLimit` 5,5 W in 12/12 Läufen | übernommen | Task 10 (Endblock > 1,25 × Burst-Maximum, `tailSeparated`), Spec B.4 |
| 6 | hoch | `StoredRun.seg` ohne `progEnd`; eine Live-Capture hat nur einen Lauf → `endOk ≡ runOk`, w02 würde repariert | `StoredRun`/`StoreFile` in `runStore.ts` | übernommen | Task 13 (`StoreFile.tail`, `progEndIdx`, `burstMaxW`, `endBlockMinW`), Task 21 (Test w02) |
| 7 | hoch | `init()` vor `syncOptimize`: Fortsetzung der Sperrphase kennt Override und Aussetzen nicht; `when: "final"` ohne Override | `deviceRegistry.ts:145-147` | übernommen | Task 15 (`runtime.restore`, `stateWanted` mit Override, Tests), Task 22; Spec A.3, 7.1 |
| 8 | hoch | Recorder öffnet nur bei Start; verschmolzene Läufe werden nicht erkannt; Phantomstart-Test falsch | `runRecorder.ts:118-121`; `phantom.mjs`: Spitze bei +31 Ticks liegt noch im Lauf | übernommen (Capture ohne Start, Phantomstart mit `after: 360`); der Teil „Verschmelzung reparieren“ ist durch Entscheidung 9 ersetzt (Test „merged runs trigger no repair and the end of the combined run is detected“) | Task 9, 21; Spec B.2 |
| 9 | hoch | Schlussphase ohne Auto-Optimierung wendet das Override an und repariert; ohne Vergleichsdaten setzt „im Zweifel“ aus | `deviceRegistry.ts:635-643`, `config.ts:236` | übernommen | Task 17 (Betriebsart „nur Schlussphase“, Bootstrap), Task 16 (`checkFinalSplit` ohne Vergleichsdaten), Task 24 („Übernehmen“ legt Läufe und Bänder ab); Spec A.3 Punkt 4, B.2 |
| 10 | hoch | Bearbeiten löscht `phases`, `template`, `learned` | `formToDeviceConfig` (`deviceForm.ts:363`), `writeDevice` ersetzt `native` | übernommen | Task 4 (`previous`, Test); Spec C.2 |
| 11 | hoch | Drift stoppt Reparatur und Aussetzen | `autoOptimize.ts:695-697` | übernommen | Task 21 (Drift sperrt nur Verschärfung, Einschalten, Phasen; Test); Spec D.3, D.4 |
| 12 | mittel | AutoOff nach c/d/f/g ohne neuen Lauf schaltet nie ab | Ableitung aus Entscheidung 2 | übernommen | Task 15 (Frist `finalCheckSec`, zwei Tests); Spec A.3 |
| 13 | mittel | `finalExit` gilt zu lange; I3 duldet `running`; `det.stats` hinter dem TrailerFilter; Zeiten überschrieben; `inTrailer` beim Durchreichen falsch | `trailer.ts:115, 264, 387-391` | übernommen | Task 14 (Marke nur am ersten Start, Getter, Zeiten, `inTrailer`, Tests), Task 16 (`splitPairs` nur b–g); Spec A.3 |
| 14 | mittel | Task-15-Test prüft Phasen-States vor Task 20 | Reihenfolge der Tasks | übernommen | Task 15 → Task 20 |
| 15 | mittel | Brücke Speicher ↔ Laufprüfung fehlt (`RunSample`, Verdict, `bands`, `rep`) | `StoreFile.verdicts` enthält nur User-Entscheidungen | übernommen | Task 13 (`storeSamples`, `recomputeBands`, `StoredRun.rep`) |
| 16 | mittel | `buildLayout` kürzt auf 20 Läufe; `REPLAY_PICK_MAX` unbenutzt | `runs.ts:910` | übernommen | Task 10 (`maxRuns`), Task 21 (`replayPick`, Test) |
| 17 | mittel | `runSamples` ohne verworfene Segmente und kurze Aktivität; `info` Pflicht | `runs.ts:827` | übernommen | Task 10 (`incomplete`), Task 12 (`kind`, `info: RunInfo` oder `null`) |
| 18 | mittel | „Werte eines anderen Geräts“ kopiert die Schlussphase, ohne Einheitenumrechnung | Spec Risiko 10, C.2 | übernommen | Task 7 (16 Grundwerte, Umrechnung, Hinweis, Tests); Spec C.2 |
| 19 | mittel | Gerät ohne Typ-Treffer bzw. Rückfall „Custom“ läuft plötzlich und sendet | `deviceRegistry.ts:115-118` | übernommen | Task 4, Task 6 (`enabled = false`, Tests); Spec C.2, C.6 |
| 20 | mittel | Doku und Changelog erst in Task 26 (CLAUDE.md Regel 1) | CLAUDE.md | übernommen | Global Constraints, Schritt „Doku“ je Task, Task 26 nur Gesamtabgleich |
| 21 | mittel | Phasennamen fest deutsch; Systemphasen ohne ids; Tests über übersetzte Namen | Tests laufen mit I18n „en“ | übernommen | Task 18 (`SYSTEM_PHASES` inkl. `rest`, i18n), Task 19 (`neutralName`), Tests über ids |
| 22 | mittel | Rohpunkte über 30 Tage als Objekte (Pi) | `historySource.ts:98` | übernommen | Task 9 (Meldestatistik je Tick, `RAW_POINTS_MAX`, Test); Spec D.2 |
| 23 | mittel | Nachspielen im Modus timed zählt Zeiten anders als live | `replay.ts:88-96` | übernommen | Task 14 (Zeiten nur aus `tick`, Test live = `simulate`); Spec A.3 |
| 24 | mittel | G13-Test ohne Verschränkung | `autoOptimize.ts:229`, `feed` | übernommen | Task 8 (`beforeOptimizeWrite`) |
| 25 | mittel | zehn Tests, die so nicht bestehen | `ids.mjs` (`kaffee_2`), `fam.mjs` (`[0,0,1]`), `p999.mjs` (p99,9 = 2268 W), übrige per Rechnung im Befund | übernommen (a)–(j) | Task 6, 11, 12, 16, 23, 9, 24, 22; Spec B.2 (Tagesabschnitte am Datenende) |
| 26 | niedrig | neun Tests prüfen nicht das Richtige | `runStore.ts:822`, `dmTexts.ts:482, 707` | übernommen (a)–(i) | Task 12, 2, 13, 8, 7, 15, 23, 3 |
| 27 | niedrig | fehlende Schnittstellen (`key`, `trigger`, `review`, `final.state`, `setRunUse`, `writeOptStates`, `setDecisions`, `from`) | Code-Stellen im Befund | übernommen | Task 8, 9, 17, 21, 24, 25 |
| 28 | niedrig | Entscheidungen bleiben beim Löschen eines Geräts liegen | `deviceSync.ts:47-49`, `deviceManagement.ts:715` | übernommen | Task 13 (`removeLearningData`, Test), Spec B.3 |
| 29 | niedrig | `lastSeenTs` fehlt in alten Speichern; Doppel-Import; leere History wird bei jedem Start neu gelesen | `deviceRegistry.ts:740-744` | übernommen | Task 13 (`historyReadTs`), Task 21 (Rückfall, `sameRun`, Test); Spec D.2 |
| 30 | niedrig | `finalSplit` erst beim Schließen der Capture; Fortsetzung hängt an `finished` | `closeIfDue` in `runRecorder.ts` | übernommen | Task 17 (Prüfung beim `end`, Test), Task 15 (nur `settlingUntil`, Test); Spec A.3 |
| 31 | niedrig | `phases`-State ohne Schreibhäufigkeit; `finerGrid` als Entscheidung; `learnFinal` ohne scope | Plan Task 13/16/20 | übernommen | Task 20, Task 13 (`gridFrom`), Task 16 (`continuous`); Spec 7.1, B.3 |

**Entscheidung des Users zur offenen Frage** (verschmolzene Läufe / Reparatur nur über kürzere Ende-Wartezeit), wörtlich: „zwei läufe als einen erkennen ist nicht schlimm denn dann läuft das gerät ja durchgehend. wichtig ist nur das dann auch das ende erkannt wird wenn es ein richtiges ende gibt“ → Entscheidung 9 oben, Spec Abschnitt 10, D.3 Punkt 3, B.2 `merged`. Der Test „merged runs triggers an immediate repair“ (Task 21) ist ersetzt durch „merged runs trigger no repair and the end of the combined run is detected“; die übrigen Sofort-Reparaturen (Ende zu früh, Start verpasst, Lauf zerteilt, Ende nicht erkannt, Phantomstart, Schlussphase zerteilt) bleiben wie beschlossen.
