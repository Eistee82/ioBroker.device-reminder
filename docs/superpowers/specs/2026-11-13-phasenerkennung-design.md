# Design: Phasen, Schlussphase, Erkennungswerte im Gerät, Auto-Optimierung über 30 Tage – robust gegen unverwertbare Aufzeichnungen

Stand: `feature/v4` @ 53fccd0, 13.11.2026; Code-Verweise am 14.11.2026 auf 5684124 geprüft und korrigiert. Umsetzungsplan: `docs/superpowers/plans/2026-11-14-phasenerkennung.md`. Dieses Dokument ist die überarbeitete Endfassung des Konzepts. Alle 30 Prüfbefunde (P1–P30, Anhang B) sind eingearbeitet; was nur teilweise übernommen wurde, steht mit Begründung unter „Geprüfte Einwände“ (Anhang C). Die Prüfbefunde zum Plan vom 14.11.2026 (Abschnitt „Planprüfung“ im Plan) sind eingearbeitet, soweit sie das Konzept betreffen (A.3, B.2, B.3, B.4, C.2, C.6, D.2–D.4, 7.1, 7.3, 8.6, Abschnitt 10). Bei Widerspruch zu `2026-10-25-device-reminder-v4-design.md` wird jene Spec **vor** dem Code an dieses Dokument angepasst (7.5).

**Entscheidungen des Users in dieser Fassung** (dazu die Entscheidungen zu den vormals offenen Fragen 1–4, Abschnitt 10)
1. **Keine Wiederaufnahme.** Nach einem frühen Ende ist alles, was danach als Aktivität erkannt wird, ein **neuer Lauf** mit normaler Start- und Fertig-Meldung. Begründung: Ein direkt nach dem Ende neu gestartetes Programm (WM „Nur Schleudern“ hinterher, Trockner sofort noch einmal, weil die Wäsche nicht trocken ist) ist zur Laufzeit nicht sicher von „Programm war doch nicht fertig“ zu unterscheiden. Ob ein frühes Ende falsch war, wird nur **im Nachhinein** beurteilt (A.3 „Beurteilung im Nachhinein“, B.2 `finalSplit`). Damit entfallen Wiederaufnahme, `resume` und die Korrektur-Nachricht (P15 entfällt).
2. **Jede Art Gerät.** Der Adapter ist für jedes Gerät gedacht (Waschmaschine, Trockner, Spülmaschine, Kessel, Kaffeemaschine, Wärmepumpe, 3D-Drucker, Ladegerät …). Keine Laufzeit- oder Lernregel beruht auf einer Eigenschaft einer bestimmten Geräteart; was bei einem Gerät aus Erfahrung gilt, wird je Gerät aus seinen Läufen gelernt und nur verwendet, wenn es in **allen** gelernten Läufen gilt.

**Lesehilfe**
- **Vorschlag:** markiert eine Entscheidung dieses Dokuments; die Begründung folgt direkt.
- (P7) usw. verweist auf den Prüfbefund, der die Stelle verändert hat (Anhang B).
- „WM“ = Waschmaschine. Alle Zahlen stammen aus den Echtdaten 31.10.–13.11.2026 (WM, Trockner, Kessel). Sie sind **Beispiele und Belege, keine Regeln**; Spalten „Beispiel WM“ zeigen, was die allgemeine Regel bei der WM ergibt. Beispiele für andere Geräte ohne eigene Daten sind als „Beispiel, nicht nachgerechnet“ gekennzeichnet.
- **Nachlauf** = Aktivität nach dem eigentlichen Programmende bis zur Ruhe (WM: Knitterschutz; Spülmaschine: Trocknen/Lüfter; Kessel: Pumpennachlauf; manche Geräte haben keinen). **„Knitterschutz“** steht nur dort, wo der bestehende Knitterschutz-Filter (`TrailerFilter`, State `antiCrease`) gemeint ist.
- „Geprüft“ heißt: mit dem echten Code aus `build/` auf den Echtdaten nachgerechnet. „Abnahme“ heißt: Kriterium für die Umsetzung, vorab nicht nachgerechnet.

**Prüfskripte** (nur im Scratchpad, Start mit `node <Datei>` im Ordner `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad`):

| Kürzel | Datei | Inhalt |
|---|---|---|
| S1 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\f_stats.mjs` | Kennzahlen WM (Knitterschutz-Obergrenze, Schleuder-Maximum, Heiz-Minimum, Ruhe im Programm) |
| S2 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\f_gaps.mjs` | Abstände der Schleuderblöcke, Heizen nach dem ersten Schleudern |
| S3 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\f_crit.mjs` | Kriterium „Ende zu früh“ in drei Fassungen |
| S4 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\f_lock.mjs` | Prototyp `FinalPhaseFilter` um den echten `createDetector` |
| S5 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\f_lock2.mjs` | Neustart nach kurzer Pause, Ruhe-Beweis auf `standby` |
| S6 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\f_lock3.mjs` | Sperrphase mit Ruhe-, Hochlast-Beweis und Prüffenster, 72 Neustart-Szenarien |
| S7 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\f_viol.mjs` | absichtlich zu frühe Schlussphase: Rest des Programms im Prüffenster (heute Ausgang g „neuer Lauf“; im Skript noch als `viol` gezählt) |
| S8 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\z_poll2.mjs` | Zeit über gehaltenem Wert, Poll-Intervall, fehlende Werte |
| S9 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\a_loo.mjs` | Gegenprobe Schlussphase, je ein Lauf ausgelassen |
| S10 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\v_g.mjs` | Einfluss von G |
| S11 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\q_quality.mjs` | Laufprüfung mit z-Werten |
| S12 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\y_actexit.mjs` | **neu (P4):** Sperrphasen-Ausgang über Aktivitätsanteil, ganze Aufzeichnung + 72 Szenarien |
| S13 | `C:\Users\Eistee\AppData\Local\Temp\claude\76a49c15faa97d7f\20aedea5-acc7-47c0-b284-a72daa939b11\scratchpad\y_peakctx.mjs` | **neu (P3):** Kessel-Spitzen > 294 W mit Kontext davor und danach |
| R* | `x_*.mjs`, `r_*.mjs` im selben Ordner | Belege der Prüfbefunde (Anhang B) |

---

## 1. Absicht und Warum

**Absicht.** Heute kennt der Adapter je Gerät nur „läuft“ oder „läuft nicht“. Der User wünscht – für jede Art Gerät:

1. **Phasen**: aus der Leistung erkennen, was das Gerät gerade tut (Beispiele: WM Heizen, Waschen, Zwischenschleudern, Endschleudern, Knitterschutz; Spülmaschine Vorspülen, Heizen, Klarspülen, Trocknen; Kessel Anlauf, Zündung, Brenner, Nachlauf – ohne Laufbezug; 3D-Drucker Aufheizen, Drucken), vor allem aus der History gelernt.
2. **Schlussphase**: „fertig“ melden, sobald die letzte Programmphase vorbei ist, statt erst nach dem Nachlauf (Beispiele: WM nach dem Endschleudern statt im Knitterschutz; Spülmaschine nach dem letzten Heiz-Spülgang statt nach dem Trocknen). Wo die Daten nicht trennen (Trockner) oder kein Nachlauf existiert (kein Gewinn), wird sie nicht angeboten.
3. **Keine Gerätetypen**: Erkennungswerte stehen direkt im Gerät.
4. **Auto-Optimierung nach jedem Lauf** über die letzten 30 Tage, separat einschaltbar.
5. **Zuverlässigkeit** von Start, Ende und Phasen.
6. **Unverwertbare Aufzeichnungen** (abgebrochene Läufe, Handtests, Logger-Lücken, Aussetzer, Fremdlast, Störspitzen, Einzelläufe, früh beendeter Nachlauf, falsche Einheit) erkennen, aussortieren bzw. robust dagegen sein; der User sieht und steuert, welche Läufe verwendet werden.

Nicht gewünscht: Zerlegung der Summenleistung (NILM).

**Warum dieser Zuschnitt.**
- **Meldungen sind das Produkt.** Was Start/Ende verändert (Schlussphase), sitzt in der Erkennungskette `createDetector`; Lernen, Nachspielen und Live-Betrieb laufen damit durch denselben Code. Was nur anzeigt (Phasen), läuft als Beobachter daneben und kann keine Meldung verändern.
- **Geräteunabhängig.** Jede Regel ist allgemein formuliert und wird aus den Läufen des jeweiligen Geräts gelernt; Eigenschaften, die nur bei einer Geräteart gelten (WM: nach dem Schleudern wird nie geheizt), werden als **gelernte Bedingung** geprüft und schalten die zugehörige Regel sonst ab.
- **Aufzeichnungen sind nie sauber.** Schon 14 Tage Echtdaten enthalten einen lückenhaft aufgezeichneten Lauf, einen Logger-Ausfall über zwei Geräte, früh beendete Nachläufe (WM: Tür früh geöffnet, Knitterschutz ausgeräumt) und einen Lauf am Datenende. Deshalb ist die **Laufprüfung der Kern des Lernens**. Grundsatz: **Ein erkannter Datenfehler ändert keinen Wert. Ein auffälliger, aber sauberer Lauf ändert Werte nur in die sichere Richtung, ist sichtbar und mit einem Klick zurücknehmbar. Ein echtes, nur ungewöhnliches Programm (kurz, lang, selten) wird verwendet, nicht aussortiert.** Der letzte Satz ist neu (P1, P7, P21): Die Vorfassung hat echte Kurzprogramme und Langheizläufe als Ausreißer behandelt.
- **V4 ist unveröffentlicht.** Die Typen lassen sich jetzt abschaffen. Mitzunehmen sind 3.1.2-Installationen und V4-Teststände, beide verlustfrei – einschließlich ihrer Laufspeicher (P10, P12, P16).

---

## 2. Ziele, Nicht-Ziele, Anti-Ziele

### Ziele

| # | Ziel | Abnahme |
|---|---|---|
| Z1 | Phasen live und als Zeitleiste, gelernt aus History oder Aufzeichnung | Gegenprobe: jede Klasse außerhalb der Übergangszonen ≥ 99 % der Zeit richtig, sonst nur Oberbegriff; Kessel lernt aus `kessel.json` ohne Eingriff ≥ 3 verwendbare Tage und Bänder (P2) |
| Z2 | Schlussphase meldet früher und nie zu früh | Beispiel WM: „Fertig“ 1,5–2,2 min nach Kernende statt 11,3–30,7 min [S4]; 0 Frühmeldungen auf allen zugelassenen Läufen, in der Gegenprobe und **mit aktivem Knitterschutz-Filter** (P13); ein dennoch falsches frühes Ende wird im Nachhinein erkannt und setzt die Schlussphase aus (A.3) |
| Z3 | Erkennungswerte im Gerät, keine Typen | Migration 3.1.2 und V4: kein Konfigurationsverlust, gleiche Meldezeitpunkte, kein Instanz-Neustart bei Wertänderung; heute funktionierende V4-Geräte bleiben aktiv (P11) |
| Z4 | Auto-Optimierung nach jedem Lauf über 30 Tage, separat | Standard aus; rechnet nach jedem Lauf; ändert Werte automatisch ohne Bestätigungsklick (auch die Schlussphase), aber nur mit Beleg durch Nachspielen über alle zugelassenen Läufe des Fensters und die Grenzläufe und erst ab den Mindestzahlen aus D.3; Budget auf einem Raspberry Pi 4 gemessen (P24) |
| Z5 | Zuverlässige Start-, Ende-, Phasenerkennung | Golden-Hashes unverändert; Live = Nachspielen; nach frühem Ende kein Phantomstart, auch nicht nach Adapter-Neustart (P5); jede Aktivität nach dem frühen Ende wird als neuer Lauf erkannt; kein verlorener Lauf |
| Z6 | Unverwertbares erkennen, anzeigen, steuern | Jeder Befund mit Grund im Dialog; eingeschleuste Fehler (8.4) ändern keinen Wert; echte Kurz-/Langprogramme werden verwendet (P1, P7); Ausschließen und wieder Verwenden stellt den Zustand exakt her; Entscheidungen überstehen Import und „Lerndaten löschen“ (P26) |

### Nicht-Ziele
- Keine Zerlegung der Summenleistung (NILM).
- Keine Erkennungswerte je Programm. Programmgruppen dienen nur Verdrängung, Gegenprobe und Laufprüfung.
- Keine automatische Bedeutungs-Benennung der Phasen; das System schlägt neutrale Namen vor, der User benennt.
- Keine Schlussphase, wo die Daten nicht trennen (Trockner: nicht angeboten) oder kein Gewinn entsteht (Gerät ohne Nachlauf, z. B. ein Wasserkocher, dessen Ende ohnehin direkt nach der letzten Phase kommt; Freigabebedingung „Gewinn“, B.6). Geräte mit scope `continuous` (Kessel) haben keine Läufe und damit keine Schlussphase.
- Keine Korrektur einer Fertig-Meldung zur Laufzeit (keine Wiederaufnahme, kein „läuft noch“); falsche frühe Enden werden im Nachhinein erkannt (Entscheidung des Users).
- Keine Änderung der vis-2-Widgets. **Vorschlag:** Phase nur als State. *Begründung:* nicht verlangt; Standard-Widgets zeigen Text-States.
- Keine Betriebsart „nur Phasen“. **Vorschlag:** Start-/Ende-Texte leer lassen. *Begründung:* geht heute schon; Phasen mit `scope continuous` laufen ohne Laufbezug.
- Das Fehlverhalten von 3.1.2 bei unbekanntem Typ wird nicht nachgebaut (C.5).

### Anti-Ziele (dürfen nie eintreten)
- Die Phasenanzeige verändert Start, Ende, Abbruch oder `status`.
- Eine Laufzeit- oder Lernregel setzt eine Eigenschaft einer bestimmten Geräteart voraus, statt sie aus den Läufen des Geräts zu lernen.
- Ein Lauf mit erkanntem Datenfehler verändert Erkennungswerte oder senkt eine Grenze.
- Ein echtes Programm wird dauerhaft aussortiert, nur weil es kürzer, länger oder seltener ist als die anderen (P1, P7).
- Konfiguration geht still verloren, auch nicht bei ungenutzten, umbenannten oder angelernten Typen (P17).
- Sicherheitsgrenzen gehen still verloren: durch Update, Verdrängung, Poll-/Einheitenwechsel (P10, P23, P27).
- Wertänderung durch den User startet die Instanz neu oder lässt andere Geräte ihren Zyklus verlieren.
- Der Detector wird mitten im Lauf oder in der Sperrphase ausgetauscht.
- Ein ausgeschlossener Lauf kommt über History-Import oder nach „Lerndaten löschen“ zurück (P26).
- Neue Felder verändern bestehende Hashes.
- Neue Nachrichten an Empfänger ohne Zustimmung (P14).

---

## 3. Randbedingungen

**Projektregeln (nicht verhandelbar)**
- Standardverhalten = 3.1.2; jede neue Funktion opt-in und standardmäßig aus.
- Automatische Migration ohne Konfigurationsverlust; migrierte Geräte melden zu denselben Zeitpunkten wie 3.1.2.
- Alle Texte in 11 Sprachen (`npm run translate`).
- Admin-UI nur jsonConfig und Device Manager (dm-utils).
- Pläne umfassen den finalen Gesamtumfang.
- Code: kein `console.log`, kein globales `setTimeout`/`setInterval`, ESM-Imports mit `.js`, Fehler über `errorMessage(err)`; Version/News in `package.json`/`io-package.json` unberührt; Changelog `- (Eistee82) …` unter `### **WORK IN PROGRESS**`.

**Technik**
- **Eine Fabrik**: `createDetector` (`detector/index.ts:54`) für Live, Nachspielen (`replay.ts:64`), Gate und History-Übernahme.
- **Laufspeicher**: ioBroker-Dateispeicher, Slots A/B, Format `v: 1`; `isStore` prüft nur Pflichtfelder (`runStore.ts:308-322`), zusätzliche Felder gehen ohne Formatwechsel. Heute: höchstens 20 Läufe/400 KB (`runStore.ts:15/19`), `envelope` wächst nur (`runStore.ts:74-75`, `mergeEnvelope` `:712`), Verdrängung behält je Gruppe 2 Läufe und bevorzugt nicht-bindende Läufe (`pickVictim`, `runStore.ts:807-838`).
- **Optimierung heute**: Verschärfung ab `TIGHTEN_MIN_RUNS = 4` vertrauenswürdigen Läufen (`autoOptimize.ts:16`, wird 8, D.3), `TIGHTEN_NEW_RUNS = 2`, `TIGHTEN_SPACING_MS = 24 h`, Sperre nach Reparatur/Undo/Reset `LOCK_RUNS = 5` und `LOCK_MS = 14 Tage` (`autoOptimize.ts:18-24`); Budget 30 s Wanduhr je Job (`deviceRegistry.ts:52`).
- **Einheiten**: Erkennungswerte in der Einheit des States; Lernen rechnet intern in W über `unitFactor`. Beim Bearbeiten eines Geräts werden gespeicherte Werte bei einem Einheitenwechsel (W/kW) nicht umgerechnet; der User passt sie dann von Hand an (nur beim Anlegen werden unberührte Werte umgerechnet).
- **Upgrade**: js-controller ergänzt fehlende Default-Keys in der Instanz-native; `main.ts:108-118` filtert sie.

**Wie die Daten aussehen**
- Steckdosen melden nur bei Änderung; der letzte Wert gilt bis zum nächsten. Messabstände: WM Median 5 s, Trockner bis 247 s, Kessel 2 s bei Sprüngen und bis 1 h in Ruhe. Echte Haltezeiten bis 52 min (Kessel, 254 W, identischer Wert). **Folge:** Zeiten werden immer über den gehaltenen Wert gemessen; eine lange Haltezeit allein beweist keine Lücke (P2, P28).
- Kennzahlen WM (Beispiel und Beleg, keine Regel) [S1, S2]: Laufschwelle 5,5 W; Display 5 W; im Programm < 5,5 W höchstens 10 s am Stück; Nachlauf (Knitterschutz) mit Bursts ≤ 70–113 W und Ruhepegel 6 W (77 % der Zeit); Schleudern ≤ 290–839 W je Lauf; Heizen ab 2047 W (1593–1858 W nur als Rampe); Abstand zweier Schleuderblöcke ≤ 26,8 min; nach dem ersten Schleudern wird nie geheizt (bei der WM aus den Daten; B.6 prüft das je Gerät als Bedingung für Ausgang c).
- Kennzahlen Kessel [S13, R x_kessel*]: 86 Spitzen > 294 W in 4 Tagen (Zeitanteil 0,31 %, 36 davon nur 2–4 s); 79 davon gehen in den Brenner über (nach 60 s im Bereich 120–294 W), 7 fallen in den Bereich 35–120 W. Brenner mit Speicherpumpe hält morgens 30–52 min konstant ohne Meldung.
- Bekannte unverwertbare oder eingeschränkt verwertbare Stellen:

| Stelle | Problem |
|---|---|
| WM 06.11. 13:37 | lückenhaft aufgezeichnet (p90 der Messabstände 111 s statt 7–12 s); 3.1.2-Werte melden 8,5 min vor Kernende [S3]; außerdem nur 41 min lang |
| WM 03.11. 09:57 | Nachlauf früh beendet: nach 2,4 min Knitterschutz ausgeräumt |
| WM 06.11. 14:49 | Nachlauf früh beendet: Selbstabschaltung 45 min nach Kernende statt 56–57 min (Tür früh geöffnet) |
| WM 12.11. | Abschaltung nach 52 min, Knitterschutz 26,3 min – **innerhalb der normalen Streuung**, kein Befund (P8; Vorfassung führte ihn fälschlich als „Tür früh“) |
| 08.11. 16:11 – 09.11. 17:19 | Logger-Ausfall, WM und Trockner gleichzeitig |
| 13.11. | Lauf am Datenende |
| Trockner | Knitterschutz heute in 3 von 7 Läufen nicht erkannt; Abkühlen (116–141 W) und Knitterschutz-Spitzen (103–116 W) überlappen (P6) |
| Kessel | „Lauf“ ist keine natürliche Einheit; lange konstante Brennerphasen ohne Meldung sind echt (P2) |

---

## 4. Betrachtete Ansätze und Wahl

| Frage | Betrachtet | Gewählt und warum |
|---|---|---|
| Ort der Schlussphase | PauseGuard / Phasen-Tracker / eigene Hülle in `createDetector` | Hülle: wirkt live, im Nachspielen, im Gate und bei der History-Übernahme; Reihenfolge Modus → Schlussphase → TrailerFilter |
| Ort der Phasen | in der Kette / Beobachter | Beobachter: kann kein Ereignis ändern |
| Nach dem frühen Ende | Schatten bis inneres Ende / Sperrphase mit Ausgängen | Sperrphase mit Ruhe-, Hochlast-, Spät-, Früh- und **Aktivitäts-Ausgang** (P4) und **persistiertem Zustand** (P5); 72/72 Szenarien, Startverzögerung ≤ 3,7 min [S12] |
| Rest eines Programms nach falschem frühem Ende | Wiederaufnahme (`resume`, Nachricht „läuft noch“, zweites Ende) / gewöhnlicher neuer Lauf, Beurteilung im Nachhinein | **neuer Lauf** (Entscheidung des Users): zur Laufzeit nicht von einem direkt nachgestarteten Programm unterscheidbar; die Laufprüfung erkennt die Zerteilung im Nachhinein und setzt die Schlussphase aus |
| Gerätespezifisches Wissen (z. B. „nach dem Schleudern wird nie geheizt“) | fest in der Regel / gelernte Bedingung je Gerät | gelernte Bedingung: gilt sie nicht in allen gelernten Läufen, ist die zugehörige Regel aus (Wert 0) |
| Knitterschutz-Filter nach dem frühen Ende | unverändert / Durchreichen während `settling` | Durchreichen (P13): Sperrphase sieht die echten Werte, die Belege S4–S7 gelten dann auch mit Filter |
| Kriterium „Ende zu früh“ | `runEnd` / `coreEnd` / feste Toleranz / `progEnd` + Nachlauf | `progEnd` + 5 min, `tailCeil` nur bei echter Trennung (P6) |
| Obergrenze Pmax | Tal / runde Zwischenwerte / geometrisches Mittel der Bandgrenzen (Beispiel WM: 844 W / 1000 / 1300 W / 1311 W) | geometrisches Mittel (WM: 1311 W) |
| Gerätetypen | Typ + Override / Werte im Gerät | Werte im Gerät, eingebaute Vorlagen, Archiv |
| Typauflösung bei V4-Migration | Rohzeilen `native.types` / dieselbe Auflösung wie heute | wie heute über `normalizeInstanceConfig` + `findType` (P11) |
| Hash | Nullen überspringen / nur ≠ 0 anhängen als `name=wert` | `name=wert` nur bei ≠ 0: alte Hashes bleiben bitgleich |
| Speicherformat | v2 / v1 + Felder + Neuzerlegung alter Läufe | v1 + Felder; alte Läufe werden beim Laden aus ihren Rohdaten neu zerlegt (P12) |
| Datenquelle Optimierung | History periodisch / eigener Speicher | eigener Speicher; History nur beim Einschalten, nach Ausfallzeit, im Dialog |
| Ausreißer | Quarantäne für alles Auffällige / Dauer-z / absolute Merkmale | **Datenfehler → Quarantäne; Form-Auffälligkeit → Quarantäne; bloße Dauer/Energie → `rare`, verwendet** (P1, P7, P21) |
| Lücken ohne Beweis | feste Ersatzgrenze vor dem Lernen / nur beweisbare Lücken + gelerntes Haltezeit-Profil | Haltezeit-Profil je Grundband, immer gelernt; vorher nur Beweisbares (P2, P28) |
| Kurze hohe Phasen (Zündung) | Entprellung / Spitzenhaltung + Ereignisphase | Spitzenhaltung, Band-Zulassung über Ereigniszahl, Ereignisphase mit Bestätigung (P3) |
| Phasen in der Optimierung | neu lernen / Feinjustierung | Feinjustierung mit Hysterese, stabile ids |
| Budget | Wanduhr, feste Reihenfolge / aktive Rechenzeit, reihum mit gespeichertem Fortschritt | reihum (P24) |

---

## 5. Design im Detail

### 5.A Phasenerkennung und Schlussphase

#### A.1 Zwei Komponenten unter einem Begriff

Fachlich ist die Schlussphase eine Phase mit dem Haken „danach fertig“. Technisch:

| | `FinalPhaseFilter` (Schlussphase) | `PhaseTracker` (Phasen) |
|---|---|---|
| Ort | Hülle in `createDetector`: Modus-Detector (mit PauseGuard) → **FinalPhaseFilter** → TrailerFilter (außen) | Beobachter in `DeviceRuntime` |
| Wirkung | zieht je Lauf genau ein `finished` vor | schreibt nur Phasen-States, Phasen-Ereignisse, Phasen-Nachrichten |
| Eingang | `tick`, im Modus timed zusätzlich `feed` | jeder Rohwert (`onPower`), Poll-Takt, Lauf-Ereignisse, `inTrailer`, `settling` |
| Werte | flache Felder `final*` in `DetectionSettings` | `phases` im Gerät |

Setzt der User bei einer Phase „danach fertig“, werden die `final*`-Werte daraus abgeleitet und geprüft (B.6). Danach sind sie vom Phasenmodell unabhängig; Umbenennen oder Neulernen der Phasen ändert das Ende nicht.

#### A.2 Felder der Schlussphase (`DetectionSettings`, `detector/types.ts`)

| Feld | Bedeutung | 0 bedeutet | Beispiel WM | Bereich (Begründung) |
|---|---|---|---|---|
| `finalMinVal` (P) | Untergrenze Schlussband | aus (Hauptschalter) | 150 W | > 0, endlich, keine absolute Obergrenze; muss über dem wirksamen Ruhepegel liegen (`finalRestVal`, sonst `standby`), sonst Schlussphase aus + Warnung. *Leistungen reichen von < 1 W (Ladegerät) bis > 20 kW (Wallbox) und stehen in der Einheit des States (W oder kW), daher nur relative Regeln.* |
| `finalMaxVal` (Pmax) | Obergrenze; Wert ≥ Pmax verwirft den Block | offen | 1311 W = √(839·2047) | 0 oder > P; ≤ P wäre ein leeres Band → Schlussphase aus + Warnung |
| `finalHotVal` (neu) | Hochlast-Pegel für Ausgang c; nur gelernt gesetzt (= Pmax), wenn in allen gelernten Läufen nach dem Schlussblock bis zur Ruhe nie ein Wert ≥ Pmax vorkommt (B.6) | Ausgang c aus | 1311 W | 0 oder ≥ Pmax (nur mit Pmax > 0); sonst 0 + Warnung (Ausgang c aus = sichere Richtung) |
| `finalAfterSec` (X) | Block beginnt frühestens X nach Start | keine Bedingung | ≈ 67 min | [0; 604 800 s]. *Live-Läufe höchstens 12 h (`CAPTURE_MAX_MS`), History-Läufe länger (3D-Druck über 2 Tage); X ≤ 0,5 × Endblock-Beginn, 7 Tage verfälscht keinen gelernten Wert.* |
| `finalMinSec` (Y) | Zeit im Band [P, Pmax), summiert | aus (Hauptschalter) | ≈ 2,6–2,8 min | [10 s; 86 400 s]; zur Laufzeit mindestens 2 · Poll. *10 s für Kurzgeräte (Wasserkocher, Kaffeemaschine: Schlussphase unter 1 min); zwei Abfragen, damit ein einzelner gehaltener Wert nie reicht.* |
| `finalQuietSec` (Z) | so lange unter P nach qualifiziertem Block → fertig | 120 s | 120 s | [30 s; 7200 s]; zur Laufzeit mindestens max(2 · Poll, G). *Z < G ließe eine Unterbrechung, die ein unqualifizierter Block überstehen darf, einen qualifizierten beenden → Z := G + Warnung (späteres Ende = sicher).* |
| `finalDipSec` (G) | Unterbrechung im Block | max(60 s, 2·Poll) | 60 s | [10 s; 3600 s]; zur Laufzeit mindestens 2 · Poll |
| `finalRestVal` | Ruhepegel für den Ruhe-Beweis | `standby` | 5,5 W | 0 oder ≥ 0 und < P; ≥ P → Schlussphase aus + Warnung |
| `finalRestSec` | Dauer des Ruhe-Beweises | max(60 s, 3·Poll) | 60 s | [10 s; 14 400 s]; zur Laufzeit mindestens 3 · Poll. *Lange Programmpausen (Einweichen 45 min) ergeben gelernt bis 2 × Pause; ≥ `finalLockSec` heißt Ausgang b nie (zulässig).* |
| `finalActVal` | Aktivitätspegel für den Aktivitäts-Ausgang (P4) | Ausgang aus | 9 W (1,5 × Nachlauf-Ruhepegel 6 W) | 0 oder wirksamer Ruhepegel ≤ Wert < P; sonst 0 + Warnung (Ausgang f aus = sichere Richtung) |
| `finalActShare` | Anteil über `finalActVal` im 5-min-Fenster, ab dem ein neuer Lauf gilt (P4) | Ausgang aus | 0,7 | 0 oder [0,5; 0,9]; 0 genau dann, wenn `finalActVal` 0 (sonst beide 0 + Warnung). *Unter 0,5 hieße „überwiegend Ruhe ist ein neuer Lauf“.* |
| `finalCheckSec` | Prüffenster nach dem frühen Ende: Schlussband darin summiert ≥ Y/2 → Ausgang g; danach genügt ein Wert im Schlussband → Ausgang d | 30 min | 40 min | [300 s; 14 400 s] und ≤ `finalLockSec`; größer → := `finalLockSec` (verhaltensneutral, die Sperrphase endet ohnehin) |
| `finalLockSec` | Höchstdauer der Sperrphase | 4 h | ≈ 45 min | [600 s; 14 400 s] (4 h wie `TRAILER_BOUNDS.trailerMaxSec`) |

- **Hauptschalter:** `finalMinVal > 0 && finalMinSec > 0`, sonst wird die Hülle nicht gebaut (Muster `trailerBurstSec`, `index.ts:56-58`).
- **Hash:** Die dreizehn Felder kommen in `DETECTION_KEYS`; `typeHash` hängt sie **nur bei ≠ 0 als `name=wert`** an. Bestehende Hashes bleiben bitgleich, Kollisionen zwischen Feldern sind ausgeschlossen.
- **Grenzen (`FINAL_BOUNDS`, `normalizeFinal`):** Zeiten in s, unabhängig von der Einheit; Leistungen in der Einheit des States ohne absolute Grenzen, nur über die relativen Regeln der Tabelle (so bleiben W- und kW-States gleich behandelt, anders als das absolute `TRAILER_BOUNDS.trailerBlockVal` ≤ 10 000). Von Hand eingegebene Werte werden geklemmt bzw. nach den Regeln korrigiert, jeweils mit Warnung. **Gelernte Werte werden nie geklemmt:** `finalLearn` (B.6) prüft seine Werte gegen dieselben Grenzen und Regeln einschließlich der Laufzeit-Untergrenzen beim Poll des Geräts und verwirft einen Kandidaten mit Grund `outOfRange`, statt ihn zu verändern. Die WM-Werte (X ≈ 4020 s, Y ≈ 156–168 s, Z 120 s, G 60 s, Ruhe 60 s, Prüffenster 2400 s, Sperre ≈ 2700 s) liegen alle innerhalb, ebenso die Extremfälle Wasserkocher (Y ≈ 30 s), Wärmepumpe (X mehrere Stunden) und 3D-Drucker (X bis 1 Tag).
- **Laufzeit-Untergrenzen je Poll** (in `FinalPhaseFilter`, Poll 1–600 s): Y ≥ 2 · Poll, G ≥ 2 · Poll, Z ≥ max(2 · Poll, G), `finalRestSec` ≥ 3 · Poll, `finalLockSec` ≥ 2 · Poll. Sie wirken nur in die sichere Richtung (späteres frühes Ende, späterer Ausgang). Messabstände der Steckdose (Trockner bis 247 s, Kessel bis 1 h) brauchen keine eigene Grenze: Gezählt wird je Abfrage der gehaltene Wert (A.3), `dt` je Aufruf ist auf max(2 · Poll, 60 s) gedeckelt.

#### A.3 Laufzeit der Schlussphase (`src/lib/detector/finalPhase.ts`)

**Zeitmessung.** Gezählt wird die Zeit, in der der *gehaltene* Wert in einem Bereich liegt (Ankunftsabstände verpassten 6 von 12 Läufen, weil die Steckdose im Endschleudern bis 145 s schweigt [S8]). Ausgewertet wird bei jedem `tick` (je Poll, damit läuft Z auch ohne neue Werte ab). Band-, Ruhe-, Hochlast- und Aktivitätszeiten zählen nur über den in `tick` gehaltenen Wert; `feed` (Modus timed) liefert dem inneren Detector nur Werte und Ereigniszeiten. *Grund:* Das Nachspielen speist je Tick Maximum und Minimum zu künstlichen Zeiten ein (`replay.ts:88-96`); Zeiten je `feed`-Aufruf wichen sonst zwischen Nachspielen und Live ab (G10). Je Aufruf zählen höchstens `max(2·Poll, 60 s)`; ein Zeitrücksprung setzt Block und Sperrzähler zurück.

**Zustand `pass`**
1. `r = inner.tick(…)` bzw. `feed`; der innere Detector sieht immer die echten Werte.
2. Inneres `started` setzt den Laufbeginn auf `times[k] ?? now` und leert den Block; `finished`/`aborted` leeren ihn.
3. Gehaltener Wert in [P, Pmax): Zeit zum Block; ≥ Pmax: Block und Qualifikation verwerfen; < P: Unterbrechung merken, ein nicht qualifizierter Block verfällt nach G.
4. Qualifiziert: Blockbeginn ≥ Laufbeginn + X, ≥ Y im Band, innerer Detector läuft.
5. **Frühes Ende:** qualifiziert und seit Z unter P → Ereignisse von `r` ohne `running`/`finished` plus eigenes `finished`; Status `off` unter `standby`, sonst `standby`; `started = false`; Wechsel nach `lock`; Zeitpunkt in den State `settlingUntil` schreiben lassen (siehe „Neustart“).
6. Sonst `r` unverändert.

**Zustand `lock` (Sperrphase).** Der innere Detector bekommt weiter echte Werte; seine Ereignisse werden verschluckt, Status folgt dem Wert, `settling = true`. Erster zutreffender Ausgang beendet die Sperrphase. Jeder Ausgang ist eine allgemeine Bedingung; ob er bei einem Gerät überhaupt aktiv ist, entscheiden die gelernten Werte (B.6), nicht die Geräteart:

| Ausgang | Bedingung | Danach |
|---|---|---|
| a) inneres Ende | inneres `finished`/`aborted` (verschluckt) | `pass` |
| b) Ruhe-Beweis | gehaltener Wert ≥ `finalRestSec` am Stück < `finalRestVal` | `inner.reset()`, `pass` |
| c) Hochlast (`finalHotVal` > 0) | gehaltener Wert ≥ G am Stück ≥ `finalHotVal` | `inner.reset()`, `pass` (neuer Lauf). Nur aktiv, wenn in allen gelernten Läufen nach dem Schlussblock bis zur Ruhe nie ein Wert ≥ Pmax vorkommt (B.6); Beispiel WM: nach dem ersten Schleudern wird nie geheizt [S2] |
| d) Schlussband spät | Wert in [P, Pmax) später als `finalCheckSec` nach dem frühen Ende | `inner.reset()`, `pass` (neuer Lauf) |
| e) Höchstdauer | `finalLockSec` abgelaufen | `inner.reset()`, `pass` |
| f) Aktivität (P4; `finalActVal` > 0) | im gleitenden 5-min-Fenster liegt der gehaltene Wert zu ≥ `finalActShare` der Zeit über `finalActVal` | `inner.reset()`, `pass` (neuer Lauf, z. B. direkt nach dem Ausräumen neu gestartetes Programm; WM: Kaltwäsche) |
| g) Schlussband früh (ersetzt die frühere „Verletzung“) | innerhalb `finalCheckSec`, ohne vorherigen Ausgang: im Schlussband summiert ≥ Y/2 | `inner.reset()`, `pass` (neuer Lauf) |

Nach `inner.reset()` erkennt der innere Detector einen neuen Lauf mit seinen **normalen Startregeln**; es gibt keinen Sonderweg für Starts nach einem frühen Ende. **Bei b–g wird der Laufbeginn des neuen Laufs auf die erste Aktivität über `finalRestVal` nach der letzten Ruhe zurückdatiert, frühestens auf das frühe Ende** (`times`), damit Laufzeit und `lastOperations` stimmen (P4); die Rückdatierung bleibt durch den TrailerFilter hindurch erhalten (er übernimmt die Zeiten des inneren Detectors). Der erste Start aus einer Sperrphase trägt in der Aufnahme die Marke `afterFinal` mit dem Buchstaben des Ausgangs (`"a"`…`"g"`, P20); `finalExit` gilt nur für den Aufruf, der dieses erste `started` liefert, danach nie wieder – spätere Starts ohne Sperrphase tragen keine Marke. Die Marke ist die einzige Spur; sie dient nur der Beurteilung im Nachhinein, die nur Marken b–g prüft.

*Warum Ausgang f (P4):* Die Vorfassung verließ sich bei einem direkt nach dem Ausräumen neu gestarteten Programm (WM: Kaltwäsche) auf den Ruhe-Beweis oder die Höchstdauer; der Start kam dann 35–141 min zu spät (R `x_lock3rest.mjs`, `x_lock3b.mjs`). Ein Nachlauf liegt überwiegend auf seinem Ruhepegel, ein neues Programm fast immer darüber (Beispiel WM: Knitterschutz 77 % der Zeit bei 6 W). Ist ein Nachlauf dafür zu aktiv, schaltet B.6 den Ausgang ab. **Geprüft [S12]** (WM, 3.1.2-Werte, Poll 10 s, `finalLockSec` 45 min, `finalRestSec` 60 s): Auf der ganzen Aufzeichnung erreicht der Anteil über 9 W in der Sperrphase höchstens **0,53**; Ausgang f feuert dort nie, 14 Starts und 14 Enden bleiben identisch. In den 72 Neustart-Szenarien aus [S6] ergeben sich mit 0,7 (auch 0,6) **72/72** mit 2 Starts, 2 Enden, 0 Ausgängen g (im Skript `viol`); der zweite Lauf wird **0,8–3,7 min** (Median 0,8) nach dem Einschalten erkannt statt bis zu 141 min.

**Warum keine Wiederaufnahme (Entscheidung des Users).** Die Vorfassung behandelte Ausgang g als „Verletzung“: Korrektur-Nachricht „läuft noch“, Wiederaufnahme mit dem ursprünglichen Laufbeginn, zweites Ende. Ein Programm, das der User direkt nach dem Ende neu startet (WM „Nur Schleudern“, Trockner noch einmal, Spülmaschine Kurzprogramm hinterher), erzeugt dieselben Werte. Zur Laufzeit ist das nicht sicher zu trennen; eine falsche Korrektur wäre schlimmer als eine zweite Fertig-Meldung. Deshalb: zur Laufzeit immer neuer Lauf, Beurteilung im Nachhinein.

**Beurteilung im Nachhinein** (ersetzt die Korrektur nach einer Verletzung)
1. **Zur Laufzeit wird nichts korrigiert.** Die Fertig-Meldung bleibt; ein danach erkannter Lauf ist ein gewöhnlicher Lauf (A.3 „Kopplung an die Runtime“).
2. **Prüfung nach dem Ende des neuen Laufs.** Trägt ein abgeschlossener Lauf die Marke `afterFinal` b–g, prüft die Laufprüfung frühes Teilstück und neuen Lauf zusammen (B.2 `finalSplit`): Passt der neue Lauf zum zerteilten Programm statt zu einem eigenständigen Programm, war das frühe Ende falsch. Im Zweifel gilt `finalSplit`.
3. **Folge:** Die Schlussphase wird für folgende Läufe **ausgesetzt** – als reine Laufzeit-Maske (P19, C.3), mit Log-Warnung, Hinweis in `learning.optimizeInfo`, Protokolleintrag und Warnung auf der Gerätekarte; als Nachricht an Empfänger nur bei `optimizeNotify` (B.3). Mit aktiver Auto-Optimierung wird sie repariert bzw. neu gelernt (D.5); ohne bleibt sie ausgesetzt, bis der User sie im Dialog wieder einschaltet oder neu anlernt.
4. **Auch ohne Auto-Optimierung.** **Vorschlag:** Bei aktiver Schlussphase (`finalMinVal > 0`) werden Laufaufnahme und Laufspeicher immer geführt; ohne Auto-Optimierung laufen nach jedem Lauf nur Verdict und `finalSplit`-Prüfung, und die einzige mögliche Wertänderung ist das Aussetzen; ein Override im Speicher wird in dieser Betriebsart nie angewendet oder berechnet („Auto-Optimierung aus“ heißt: Werte des Geräts). Damit die Prüfung Vergleichsdaten hat, legt „Übernehmen“ im Anlern-Dialog die zugelassenen Läufe und Grundbänder im Laufspeicher ab; ein neu angelegter leerer Speicher liest einmal die History. Die Prüfung läuft beim Ende des Laufs mit Marke, nicht erst beim Schließen der Aufnahme. *Begründung:* Sonst würde eine falsche Schlussphase ohne Auto-Optimierung bei jedem Lauf dieses Programms erneut Start und zweites Fertig für den Rest melden.
5. **Beim Lernen** ist dieselbe Prüfung Teil der Freigabe: Im Nachspielen der History zählt ein Start nach einem frühen Ende innerhalb eines zugelassenen Laufs als Frühmeldung (B.6). Der Hauptschutz gegen Frühmeldungen liegt damit beim Anlernen: vorgeschlagen wird nur, was alle Läufe einschließlich Gegenprobe eindeutig trennt.
6. **Wieder eingeschaltet** wird die Schlussphase vom User im Dialog, durch die Auto-Optimierung, wenn das Nachspielen zeigt, dass das frühe Ende nach `endOk` richtig war, oder nach erfolgreicher Reparatur der `final*`-Werte (D.5).

**Zusammenspiel mit dem TrailerFilter (P13).** Der TrailerFilter liegt außen. Das frühe `finished` startet über `TrailerFilter.note` (`trailer.ts:216-225`) den Knitterschutz, der State `antiCrease` stimmt. **Neu: Solange der innere Detector `settling` meldet, hält der TrailerFilter nichts zurück** (kein `armed()`, kein Ersetzen durch `base()`, `trailer.ts:175-183, 235-262`), sondern reicht jeden Aufruf unverändert durch; `inTrailer` gilt dabei, solange die Knitterschutz-Frist läuft (heute erst ab dem ersten zurückgehaltenen Burst, `trailer.ts:115` – beim Durchreichen wäre es sonst immer falsch). Er reicht `settling`, `finalExit`, `lockAt` und die Zähler der Schlussphase nach außen. Begründung: Sonst sähe die Sperrphase nach einem falschen frühen Ende kurze Blöcke im Schlussband unter 120 s (WM: Zwischenschleudern; `afterEndMs`, `trailer.ts:104`) nur als Ruhepegel – Ausgang g bliebe aus, der innere Detector endete (Ausgang a), und der Rest des Programms erschiene als Lauf **ohne** Marke `afterFinal`, den die Beurteilung im Nachhinein nicht erfasst. Die Sperrphase beruhigt die Ausgabe selbst; nach ihrem Ende filtert der TrailerFilter wieder wie heute, solange `trailerUntil` läuft. Vor dem frühen Ende ist alles wie heute (Beispiel WM: Endschleudern ≥ 4 min > `burstMs`, kommt durch; ein ersetzter kurzer Block verringert nur die Bandzeit, also sichere Richtung). **Abnahme:** S4–S7 und I1–I5 werden zusätzlich mit aktivem TrailerFilter und den gelernten WM-Werten wiederholt (8.2).

**PauseGuard** bleibt unberührt und verzögert nur das innere Ende (`pauseGuard.test.js:62-121`).

**Abbruch per Schalter:** vor dem frühen Ende unverändert; in der Sperrphase verschluckt.

**Neustart des Adapters (P5).**
- *Mitten im Lauf:* wie 3.1.2 – der Start wird neu erkannt, X zählt ab dem neuen Start, die Regel greift im angebrochenen Lauf nicht.
- *In der Sperrphase:* Beim frühen Ende schreibt die Runtime den State `settlingUntil` (Zeitpunkt frühes Ende + `finalLockSec`); bei jedem Ausgang wird er auf 0 gesetzt. Beim Start gilt: `settlingUntil > now` und Schlussphase aktiv (`finalOn(active)`, also mit Override und ohne Aussetzen) → die Hülle startet direkt in `lock` mit `lockAt = min(settlingUntil, now + finalLockSec) − finalLockSec` (Prüffenster und Höchstdauer laufen weiter). `finished = true` ist **keine** Bedingung (Quittieren setzt `finished` zurück, die Sperrphase läuft trotzdem). Weil Override und Aussetzen erst mit dem Laufspeicher geladen werden (`deviceRegistry.ts:145-147`: `init()` vor `syncOptimize`), baut die Registry den Detector nach dem Laden einmal mit `resumeLockAt` neu (`runtime.restore`), bevor der erste Tick kommt. Ist die Schlussphase ausgesetzt, wird nicht fortgesetzt und `settlingUntil` = 0. Der State wird nur angelegt, wenn die Schlussphase aktiv ist (`when: "final"`, 7.1). *Beleg für die Notwendigkeit:* ohne Persistenz Phantomstart und zweites „Fertig“ in 12/14 Läufen bei Neustart 1–2 min nach dem frühen Ende (R `x_restart.mjs`). **Abnahme:** Neustart 0–10 min nach jedem frühen Ende auf `washer30d` → 0 Phantomstarts, 0 zweite Fertig-Meldungen.

**Kopplung an die Runtime (`deviceRuntime.ts`)**
- Neue optionale Getter am `Detector`: `settling`, `finalExit` (zuletzt genommener Ausgang, Quelle der Marke `afterFinal`); der TrailerFilter reicht sie durch. `TickResult` bleibt unverändert.
- **Frühes Ende** = gewöhnliches Ende: `endText`, `finished = true`, `running = false`, `lastFinished`, `lastRuntime`, `lastOperations`-Eintrag, Runtime-Ereignis `end` (Ende-Aktionen), Erinnerungen starten, `alertRuntime` zurückgesetzt. Einzige Abweichung: AutoOff (unten).
- **Lauf nach einem frühen Ende** = gewöhnlicher Lauf über `onStarted`/`onFinished`: `startText`, Start-Aktionen, Erinnerungen abgebrochen, `runtime` ab dem (zurückdatierten) Beginn, eigener `lastOperations`-Eintrag, eigenes `end` mit `endText` und Ende-Aktionen. Kein eigenes Ereignis, keine eigene Nachricht, keine Sonderregel für Laufzeit, Erinnerungen oder `alertRuntime`.
- **AutoOff:** Mit aktiver Schlussphase startet der Zähler nicht beim frühen Ende, sondern erst, wenn die Sperrphase über einen Ausgang endet, der Ruhe oder Ende zeigt (a, b, e). Endet sie über einen Aktivitäts-Ausgang (c, d, f, g), startet er nicht – ein neuer Lauf ist im Gange und AutoOff folgt dessen Ende wie üblich. Erfüllt die Aktivität die Startregeln nicht und folgt binnen `finalCheckSec` nach dem Ausgang kein `started`, startet der Zähler nach Ablauf dieser Frist (bzw. sofort mit einem Ruhe-Beweis davor); sonst schaltete AutoOff nie ab, obwohl es ohne Schlussphase beim normalen Ende abgeschaltet hätte. *Begründung:* Mit `autoOffMinutes = 0` würde sonst ein gerade weiterlaufendes oder neu gestartetes Programm sofort abgeschaltet. Ohne Schlussphase wie heute ab `finished`.
- **Detector-Neubau** nach dem Lauf (`afterRun`, `deviceRuntime.ts:484-489`) nur bei `!started && !settling`, sonst beim nächsten passenden Tick.

**Invarianten (Eigenschaftstests)**
- I1: Feuert die Regel nie, ist die Ausgabe identisch mit der des inneren Detectors.
- I2: Je innerem Lauf höchstens ein frühes Ende.
- I3: Nach einem frühen Ende bis zum nächsten `started` kein `finished`, `running`, `aborted`.
- I4: Ein `started` nach einem frühen Ende entsteht nur nach einem der Ausgänge a–g und nur über die normalen Startregeln des inneren Detectors.
- I5: In der Sperrphase ist der Status `off`/`standby`, `times` steigen monoton.

**Geprüft auf den Echtdaten** (WM, 3.1.2-Werte 30/15/1/2/50, Poll 10 s, P 150, Pmax 1311, X 60 min, Y 2,8 min, Z 2 min, G 60 s, Ruhe 5,5 W/60 s, Prüffenster 40 min):
- Ganze Aufzeichnung [S4, S6, S12]: 14 Starts und 14 Enden mit und ohne Hülle identisch; 11 normale Läufe „Fertig“ 1,5–2,2 min nach Kernende statt 11,3–30,7 min; Kurzprogramm unverändert; Sperrphase 11× Ausgang a, 1× Ausgang b; 0 Ausgänge g.
- Ausräumen und Neustart, 72 Szenarien [S6, S12]: 72/72 mit 2 Starts und 2 Enden, kein Fehlalarm; mit Ausgang f Start 0,8–3,7 min nach Einschalten. Ohne Hülle (3.1.2) verschmelzen 12 von 36 Fällen mit kurzer Pause zu einem Lauf [S4].
- Absichtlich zu kleines Y (0,5/1,0 min) [S7, Prototyp ohne Ausgang f]: frühes Ende 24–44 min vor Kernende; die Sperrphase endet in 11/11 Läufen über das Schlussband im Prüffenster (heute Ausgang g); der Rest wird als neuer Lauf erkannt, Start 3–36 min nach der falschen Meldung; dessen Fertig liegt 11/11 nach dem Kernende und zur selben Zeit wie das Ende ohne Schlussphase. Für den User heißt das: eine falsche Fertig-Meldung, danach Start- und Fertig-Meldung für den Rest. **Abnahme** (nicht nachgerechnet): Mit allen Ausgängen a–g ergibt sich ebenfalls in 11/11 Läufen ein neuer Lauf mit Marke `afterFinal` (f kann hier vor g greifen), und die Beurteilung im Nachhinein wertet alle 11 als `finalSplit` und setzt die Schlussphase aus.

#### A.4 Phasenmodell (`src/lib/phases/model.ts`)

```ts
interface PhaseModel {               // DeviceConfig.phases – fehlt = Phasen aus
  v: 1;
  enabled: boolean;                  // opt-in, Standard false
  scope: "run" | "continuous";       // continuous: ohne Laufbezug (Kessel)
  bands: BandDef[];                  // aufsteigend, Einheit des States
  phases: PhaseDef[];
  learnedAt: number;
  quality: { agreement: number; runsUsed: number };
}
interface BandDef {
  id: string; name: string;          // Oberbegriff, z. B. „Schleudern“
  min: number; max: number;          // [min, max)
  smoothing: "block" | "level" | "debounce" | "peak";   // peak neu (P3)
  dipSec: number;                    // block: Dip-Toleranz; level: Haltezeit; debounce: Entprellung; peak: Anzeige-Haltezeit
  windowSec: number;                 // level: Fenster für Median/Maximum
}
interface PhaseDef {
  id: string;                        // stabil („p3“)
  name: string;
  band: string;                      // BandDef.id
  minSec: number; maxSec: number;    // Dauerklasse, 0 = offen
  after?: string[];                  // erlaubte Vorgänger (Phasen-ids | "idle" | "start")
  notBeforeSec?: number;             // nur scope run, nur wenn es trennt
  trigger?: {                        // Ereignisphase (P3)
    confirm: string[];               // Band-ids, in die der Wert binnen confirmSec nach Eintritt in `band` gehen muss
    confirmSec: number;              // gelernt, z. B. 10 s
    tailSec: number;                 // Dauer ab Eintritt (p95 der gelernten Länge), danach normale Bandphase
  };
  decided: "live" | "end";
  final?: boolean;                   // „danach fertig“ (Bedienung; Wirkung über detection.final*)
  show: boolean;
  notify?: { start?: boolean; end?: boolean; text?: string };
  stats: { runs: number; agreement: number; lastSeen: number };
}
```

Haltezeit-Grenzen stehen nicht mehr im Phasenmodell, sondern im immer gelernten Haltezeit-Profil der Grundbänder (B.1a, P28).

- **Zwei Ebenen.** Das Band ist der Oberbegriff („Schleudern“) und gilt, sobald es belegt ist; die Klasse („Endschleudern“) erscheint erst, wenn Dauer, Vorgänger und ggf. Zeit seit Start sie belegen.
- **`decided: "end"`.** Klassen, die nur über eine Höchstdauer erkennbar sind (Beispiel WM: Zwischenschleudern ≤ 1,9 min), stehen erst am Segmentende fest: rückwirkend in der Zeitleiste, live bleibt der Oberbegriff; Meldungen nur „bei Ende“.
- **Ereignisphasen (P3).** Für kurze Ereignisse, deren Wert danach in ein anderes Band übergeht (Kessel-Zündung: Spitze > 294 W, dann 265–290 W, dann Brenner). Live: Eintritt in das Spitzenband zeigt dessen Oberbegriff; geht der Wert binnen `confirmSec` in eines der `confirm`-Bänder, heißt die Phase ab dem Eintritt „Zündung“ (Zeitleiste rückwirkend ab Eintritt) und bleibt es bis `tailSec`, danach gilt die normale Bandphase („Brenner mit Pumpe“). Geht der Wert stattdessen in ein anderes Band (7 von 86 Spitzen fallen auf 35–120 W [S13]), bleibt es beim Oberbegriff bzw. der dafür gelernten Klasse (z. B. „Anlauf“). Damit ist die Zündung binnen weniger Sekunden live benennbar und hat eine Meldung „bei Beginn“.
- **Systemphasen** (fest, 11 Sprachen): „Knitterschutz“ solange `inTrailer`; „Nachlauf“ solange `settling` ohne Knitterschutz; außerhalb eines Laufs (scope run) leer.

#### A.5 Phasen-Tracker (`src/lib/phases/tracker.ts`)

Rein funktional, ohne eigene Timer; derselbe Code live und offline beim Lernen.

- **Eingänge:** `observe(wert, t)` aus `onPower` vor der Modusprüfung (der Tracker sieht in allen Modi jeden Rohwert); `advance(t)` aus `tick`; `onRun(start | end | abort, at)`; `inTrailer`, `settling`.
- **Glättung je Band:**

| Glättung | Arbeitsweise | Einsatz (Beispiele; gewählt wird nach B.5 Schritt 3) |
|---|---|---|
| `block` | Rohwert-Blöcke, Dip-Toleranz 30 s, Mindestlänge 20 s | WM Heizen, Schleudern |
| `level` | Median 60 s (Pegel), Maximum 60 s (Aktivität), Haltezeit 45 s | WM Waschen, Knitterschutz |
| `debounce` | Entprellung 5 s | Kessel (Zigbee) |
| `peak` (P3) | jeder Rohwert im Band zählt sofort als Eintritt, Anzeige wird `dipSec` (5 s) gehalten | kurze hohe Bänder (Kessel > 294 W) |

  Zeiten folgen dem gehaltenen Wert, `dt` gedeckelt wie in A.3.
- **Zuordnung:** Kandidaten = Phasen des Bands mit passendem Vorgänger/`notBeforeSec`; genau ein `live`-Kandidat mit erreichtem `minSec` → sein Name, sonst Bandname; Ereignisphasen nach ihrer Bestätigungsregel; am Segmentende endgültige Klassifikation über die Dauer in die Zeitleiste; passt keine Klasse, steht der Bandname. Geraten wird nie.
- **Fehlende Werte:** Überschreitet der gehaltene Wert die Verdachtsgrenze des Haltezeit-Profils (B.1a), wird die Phase „unbekannt“ (nur Anzeige).
- **Neustart:** Tracker beginnt leer; Phasen mit Vorgänger zeigen den Oberbegriff, bis der Kontext da ist.
- **scope run:** Kontext wird beim Start zurückgesetzt. **scope continuous:** unabhängig von Läufen, `notBeforeSec` verboten (Validator).

#### A.6 Ausgaben
- States `phase`, `phaseId`, `phaseSince`, `phases` nur bei `phases.enabled` (7.1).
- Runtime-Ereignis `phase` (`{id, edge: "start" | "end"}`); Aktions-Ereignisse `phaseStart`/`phaseEnd`, optional gefiltert auf `phaseId`.
- Nachrichten nur für Phasen mit `notify`: je Lauf und Phase höchstens einmal; bei scope continuous höchstens alle 10 min je Phase.
- `status` wird nie von Phasen überschrieben.

---

### 5.B Lernen aus der History – mit Laufprüfung

#### B.1 Datenquellen und Rohdaten
- **History (`historySource.ts`)** liefert zusätzlich die Rohpunkte mit Zeitstempel und die History-Einstellungen des Datenpunkts (`changesRelogInterval`, `ignoreZero`/`ignoreBelowZero`, Entprellung `debounceTime`/`blockTime`, `round`; heute nur `changesMinDelta`, `retention`, `historySource.ts:117-127`). Feldnamen je Adapter (history, influxdb, sql) werden bei der Umsetzung geprüft; fehlen sie, fehlen nur die zugehörigen Befunde.
- **Live-Aufnahme (`runRecorder.ts`)** speichert zusätzlich die Meldezeitpunkte, auch bei gleichem Wert, und die Marke `afterFinal` bei Starts aus der Sperrphase.
- **Bereinigung** vor jeder Auswertung: `null`/`NaN` verwerfen, negative Werte → 0, Zeitstempel sortieren, Duplikate verwerfen (Befunde `invalid`/`timeJump`).

#### B.1a Grundbänder und Haltezeit-Profil (neu, P2, P3, P28)

Unabhängig davon, ob Phasen eingeschaltet sind, lernt das Lernen je Gerät **Grundbänder** (Algorithmus wie B.5 Schritt 2, ohne Namen und Klassen) und daraus das **Haltezeit-Profil**:
- je Grundband die Haltezeiten aller sauberen Läufe (bzw. Tage) mit mindestens 3 Läufen und 30 Haltezeiten;
- **Verdachtsgrenze** = max(10 min, 5 × p99 der Haltezeiten des Bands).

WM: Band 150–1311 W hat p99 ≈ 100 s (R `r_hold.mjs`: n = 427, Maximum 145 s) → Grenze 10 min; eine 20-min-Logger-Lücke bei 250 W fällt auf. Kessel: Band 245–280 W enthält regelmäßig 30–52 min lange Haltezeiten → Grenze weit darüber; die echten morgendlichen Brennerphasen fallen nicht auf.

Grundbänder speisen das Haltezeit-Profil, die Befunde `test`, `foreign`, `rare` und die Gruppenmerkmale (B.5 Schritt 9). Sie werden im Laufspeicher (`bands`) bzw. im Dialog aus den importierten Läufen berechnet. Die Phasen-Bänder sind eine Verfeinerung der Grundbänder.

#### B.2 Laufprüfung je Lauf (`src/lib/learn/quality.ts`)

Eine gemeinsame Prüfung für Anlernen, Aufzeichnen, Laufspeicher, Phasen und Schlussphase:

```ts
interface Verdict {
  key: string;                    // Startminute (UTC) + Gerät; Abgleich live ↔ History ±5 min
  stage: "ok" | "limited" | "quarantine" | "unusable";
  reasons: { code: QualityCode; detail: string }[];
  uses: { start: boolean; end: boolean; phases: boolean; final: boolean; trailer: boolean; rest: boolean };
  boundary?: { quantity: string; value: number; without: number }[];
  veto?: number;                  // Zeitpunkt, an dem der Lauf zuletzt einen Kandidaten der Optimierung verhindert hat (D.2)
  user?: "include" | "exclude";
}
```

Automatische Stufen werden **bei jeder Auswertung neu berechnet** (die Vergleichsstatistik ändert sich); `user` bleibt immer erhalten. Schwellen in W werden mit `unitFactor` umgerechnet.

| Befund | Typischer Fall | Erkennung | Folge | Stufe |
|---|---|---|---|---|
| `incomplete` | Lauf am Datenende, Adapter-Neustart im Lauf, fehlgeschlagene Abfrage | berührt Datenende, unbekannte Strecke oder `markInvalid`; live ohne Ende oder mit Neustart-Marke | für nichts | unbrauchbar |
| `gap` beweisbar | Logger-Ausfall, Steckdose aus, History-Adapter gestoppt | (1) `changesRelogInterval` gesetzt und Stille > 2 × Relog + Poll; (2) live: keine Meldung, auch nicht mit gleichem Wert, länger als 3 × p99,9 der Meldeabstände und ≥ 2 min – nur wenn das Meldeprotokoll beweist, dass die Quelle auch unveränderte Werte meldet (≥ 10 und ≥ 1 % der Meldungen mit dem zuvor gehaltenen Wert), sonst ist die Stille eine Haltezeit (Abschnitt 3); (3) Ausfallzeit des Adapters; (4) andere Geräte derselben History-Instanz in dieser Strecke ebenfalls still | Strecke unbekannt, nicht gehalten; im Kern → `incomplete` | unbrauchbar |
| `gap` unbeweisbar (P2, P28) | Wert hängt, Lücke bei konstanter Leistung | Haltezeit über der Verdachtsgrenze des Haltezeit-Profils (B.1a). **Ohne Profil (< 3 Läufe) gibt es diesen Befund nicht**; nur beweisbare Lücken zählen | scope run: liegt die Strecke im Kern → Quarantäne; scope continuous: **nur dieses Segment** fällt aus Dauerstatistik und Phasenlernen, der Tag bleibt verwendbar | Quarantäne (run) / – (continuous) |
| `stuck` (P2) | Steckdose sendet eingefroren | mindestens 20 **Meldungen** mit bitgleichem Wert über der Laufschwelle, länger als die Verdachtsgrenze, in einem Band mit sonst Variationskoeffizient > 5 %. Nur wo Meldungen auch ohne Änderung sichtbar sind (Live-Meldelog, Relog); eine bloß lange Haltezeit ist nie `stuck` | wie `gap` unbeweisbar | Quarantäne |
| `sparse` | gestörte Aufzeichnung (06.11. 13:37) | p90 der Messabstände im Lauf > 4 × Median der p90 der übrigen Läufe | für alle Zwecke | Quarantäne |
| `unit` | kW ohne Einheitentext | Laufspitze < 1/50 oder > 50 × Median der Laufspitzen; bei Vorlage: typische Spitze < 1/100 der Erwartung | für nichts, Hinweis „Einheit prüfen“ | unbrauchbar |
| `counter` | Energiezähler statt Leistung | Einheit Wh bzw. Rolle | Dialog bricht mit Grund ab | unbrauchbar |
| `foreign` (P7) | Fremdlast an der Steckdose | (1) Ruhepegel 30 min davor oder danach > Ruhe + max(20 W, 3 × Streuung der Ruhe); oder (2) > 5 % der Laufzeit bei Werten **außerhalb aller Grundbänder** (± Bandtoleranz). **Längere Dauer innerhalb eines bekannten Bands ist nie `foreign`** | Quarantäne | Quarantäne |
| `spike` | Störspitze | Einzelwert > 3 × p99,9 der Läufe, kürzer als 2 Werte | für Statistik durch Nachbarmedian ersetzt; Nachspielen mit Rohwert; einzelner Fehlstart zählt erst ab 2 in 30 Tagen | eingeschränkt |
| `test` (P1, P21) | Hand-Ein/Aus, Kurztest | **nur absolute Merkmale:** (1) Spitze < 5 min, die allein `startCount` erhöhen würde (länger als 2 × zweitlängste Spitze); oder (2) Lauf < 10 min, solange die übrigen sauberen Läufe im Median mindestens 3-mal so lang sind (ohne 3 Vergleichsläufe immer; Gesamtprüfung 15.11.: sonst lägen alle Läufe von Kurzgeräten wie Wasserkocher in Quarantäne, entgegen „geräteunabhängig“); oder (3) **keine gerätetypische Bandfolge**: der Lauf berührt nur ein Grundband oder keines der Grundbänder, die in ≥ 50 % der sauberen Läufe vorkommen (Beispiel WM: weder Heiz- noch Schleuder- noch Waschband im typischen Wechsel). Bei Geräten, deren saubere Läufe selbst nur ein Grundband berühren (z. B. Ladegerät, Wasserkocher), entfällt Merkmal (3). Dauer und Energie allein lösen `test` **nie** aus | nicht für Startwerte, Ende, Phasen, Schlussphase; als möglicher Fehlstart sichtbar | Quarantäne |
| `aborted` | abgebrochener Lauf | live: `aborted`; History: Abfall direkt unter `standby` ohne Endblock und Nachphase, Dauer < p10 der Gruppe | nur Start | eingeschränkt |
| `trailerCut` (P8) | Nachlauf früh beendet (Beispiel WM: Ausräumen im Knitterschutz, Tür früh geöffnet) | Nachlauf < 0,5 × Median, oder Ende des Nachlaufs (Selbstabschaltung, Ruhe) früher als Median − max(5 min, 4 × MADn) der übrigen Läufe; nur bei Geräten mit Nachlauf in ≥ 2 sauberen Läufen | nicht für Nachlauf- und Ruhedauer | eingeschränkt |
| `merged` | zwei Läufe direkt hintereinander, in der Aufzeichnung zusammengewachsen | **nur über Layout-Merkmale:** Dauer > 1,8 × Maximum der eigenen Gruppe **und** zwei Endblöcke, **oder** zwei Endblöcke mit einer Ruhe auf dem Pegel nach dem Ende (≤ 1,25 × Pegel + 0,1 W) von ≥ 3 min (`SPLIT_GAP_MIN_MS`) dazwischen, die länger ist als jede solche Ruhe im Programm der Vergleichsläufe (gilt auch ohne Vergleichsläufe, Gesamtprüfung 15.11.) (nie über gemeldete Starts) | **kein Erkennungsfehler (Entscheidung des Users, Abschnitt 10):** keine Reparatur, kein Hinweis, höchstens Info im Optimierungs-Verlauf; im Gate gilt nur die Ende-Prüfung für den Gesamtlauf (`endOk` des letzten Fertig gegen das Ende des Gesamtlaufs; ein Fertig/Start an der inneren Ruhe ist weder Zerteilung noch Frühmeldung); nicht für Pausen-, Dauer- und Grenzwert-Statistik, Phasen, Schlussphase, Nachlauf | eingeschränkt |
| `finalSplit` (neu, P20) | frühes Ende war falsch: der Lauf danach ist der Rest des zerteilten Programms (Beurteilung im Nachhinein, A.3) | nach dem Ende eines Laufs mit Marke `afterFinal` b–g: der Lauf passt zum zerteilten Programm statt zu einem eigenständigen, d. h. er beginnt nicht mit der gerätetypischen Anfangsfolge (erste 10 min ohne die Grundbänder, mit denen ≥ 80 % der sauberen Läufe beginnen) **oder** zwischen frühem Ende und neuem Start lag keine Ruhe < `finalRestVal` länger als die längste Ruhe im Programm aller sauberen Läufe. Ein direkt nachgestartetes Programm, das sich so verhält (WM „Nur Schleudern“), wird ebenfalls als `finalSplit` gewertet (Risiko 4) | **kein** Quarantäne-Fall: Schlussphase wird ausgesetzt (auch ohne Auto-Optimierung, A.3), Reparatur nach D.5 nur mit Auto-Optimierung; beide Teile werden für das Gate als **ein** Lauf (früher Start bis Ende des Rests) gewertet; im Zweifel gilt `finalSplit`, aber nur mit Vergleichsdaten (≥ 3 saubere Läufe und Grundbänder). Ohne sie entfällt die Anfangsfolge, und die Ruhe zwischen den Teilen wird mit der längsten Ruhe im frühen Teilstück selbst verglichen | ok (Sonderweg) |
| `historyCfg` | History-Einstellungen verfälschen | `ignoreZero`; Entprellung > Poll; Rundung > 10 % des Ruhepegels | Hinweis; Entprellung: nicht für Phasen/Nachlauf; `ignoreZero`: nicht für Abbruch/Ruhedauer | eingeschränkt |
| `invalid` / `timeJump` | Nullwerte, `NaN`, negative Werte, Zeit rückwärts/doppelt | Anteil > 1 % bzw. nicht monoton | bereinigt; Rücksprünge > 1 min = unbekannte Strecke | eingeschränkt |
| `rare` (P1, P7) | seltenes echtes Programm (Beispiel WM: Kurzprogramm, Langheizen, sanftes Schleudern; 3D-Drucker: ungewöhnlich langer Druck) | sonst sauber und (log-z von Dauer/Energie **innerhalb der eigenen Programmgruppe** |z| > 3,5, oder einziger Lauf seiner Gruppe, oder Dauer/Energie/Blocklänge weit außerhalb, aber in bekannten Bändern) | **voll verwendet**, Hinweis | ok |
| `formerlyDropped` (P16) | Lauf, den der User in V4 verworfen haben könnte | History-Lauf im Zeitraum eines alten V4-Speichers (vor V5), der dort fehlt | Hinweis „früher verworfen?“, Verwendung unverändert | (unverändert) |

**Live-Aufnahme und gespeicherte Läufe.** Eine Aufnahme (Capture) kann mehrere echte Läufe enthalten (sie bleibt bis 30 min Ruhe bzw. 3 h nach dem Ende offen, ein neuer Start verlängert sie). Vor der Prüfung wird sie mit derselben Segmentierung wie die History zerlegt (Ruhe ≥ 3 min zwischen einem gemeldeten Ende und dem nächsten Start trennt) und zusätzlich an jedem Start mit `afterFinal`; jedes Teilstück ist ein eigener Lauf mit den Ereignissen seiner Zeit. „Zerteilt“ (Reparaturauslöser, D.3) heißt nur: ein Lauf der Zerlegung mit ≥ 2 gemeldeten Starts, der nicht `merged` ist. Ein Lauf ohne gemeldeten Start (Aktivität über `max(endVal, Laufschwelle)` ≥ 5 min ohne `started`) wird ebenfalls aufgenommen (Befund „Start nicht erkannt“). Tagesabschnitte bei scope `continuous`, die nur am Datenende kürzer sind, sind nicht `incomplete`.

**Rangfolge (P7):** `unusable` > Datenfehler-Quarantäne (`gap`, `stuck`, `sparse`) > Form-Quarantäne (`foreign`, `test`) > `limited` (darunter `merged`) > `rare`. Kriterien, die nur auf Dauer oder Energie beruhen, ergeben **immer** `rare`, nie einen Ausschluss. **Abnahmen:** 06.11. 13:37 → `sparse` (nicht `test`); ein synthetisch dicht abgetastetes 41-min-Programm aus derselben Kurve → `rare`, verwendet; drei gleiche saubere Kurzläufe bilden eine Gruppe; 03.11. 09:57 und 08.11. 12:28 (Heizblöcke 23,0 bzw. 29,8 min, R `x_heat.mjs`) → nur `rare` (03.11. zusätzlich `trailerCut`); 12.11. → kein Befund; 06.11. 14:49 → `trailerCut`; Kessel 10.–13.11. → 4 verwendbare Tage.

#### B.3 Politik: wie Befunde wirken

| Stufe | Wirkung | User kann |
|---|---|---|
| `ok` (auch `rare`) | für alles | ausschließen |
| `limited` | nur für die Zwecke in `uses` | ausschließen |
| `quarantine` | sichtbar; nicht für Verschärfung, Phasen, Schlussphase, Statistik, Gate; nur „kein Rückschritt“ (D.3) | aufnehmen |
| `unusable` | nie | Begründung ansehen |

- **Grenzlauf.** Ein Lauf, der allein eine Sicherheitsgrenze bestimmt (längste Pause, kleinste Laufleistung, längster Burst, kürzester Endblock, spätester Endblock-Beginn) oder der zuletzt einen Kandidaten der Optimierung verhindert hat (`veto`, D.2). Ist er sauber, **wirkt er sofort** (Sicherheit vor Tempo). Der Dialog zeigt die Grenze mit dem Wert ohne ihn („Wartezeit 12 min wegen Lauf 07.11. 14:26, ohne ihn 5 min“); Ausschließen nur nach Warnung „Wenn dieser Lauf echt war, kann ein solcher Lauf künftig zu früh als fertig gemeldet werden“.
- **Programmgruppen nur aus Läufen ohne Quarantäne** (`rare` zählt als sauber). Ein Lauf mit Quarantäne-Befund bestätigt nie einen anderen.
- **Robuste Statistik:** Komfortwerte aus Quantilen über zugelassene Läufe, Sicherheitswerte aus allen zugelassenen Läufen.
- **Hinweis bei nicht erkanntem Lauf in Quarantäne (P14, P22).** Hat die Live-Erkennung einen Lauf falsch erkannt (Nachspielen zeigt Frühmeldung, fehlenden Start oder Phantomstart) und liegt er in Quarantäne mit einem Grund, der ein echtes Programm sein kann (`test`, `foreign`), entsteht genau ein Hinweis „Lauf vom … nicht richtig erkannt und ungewöhnlich – im Dialog ‚verwenden‘ wählen, damit die Werte angepasst werden“. Bei Datenfehlern (`sparse`, `gap`, `stuck`) lautet er stattdessen „Aufzeichnung gestört – Lauf wird nicht verwendet“, ohne Aufforderung. **Zustellung:** immer Log (Warnung), `learning.optimizeInfo.review`, Warnung auf der Gerätekarte; **als Nachricht an Empfänger nur bei `optimizeNotify`**. Es gibt keine neuen Nachrichten ohne Zustimmung.
- **Entscheidungen bleiben erhalten (P26).** Sie liegen über ihren Schlüssel im Laufspeicher (`verdicts`), unabhängig von den Läufen. Import, Neu-Anlernen und Bootstrap wenden sie an. „Lerndaten löschen“ schreibt einen leeren Speicher **mit** den Entscheidungen; nur die zusätzliche Option „auch Entscheidungen verwerfen“ entfernt sie. **Löschen eines Geräts** entfernt die Speicherdatei samt Entscheidungen; ein neues Gerät mit derselben id beginnt leer. Systemvermerke eines Laufs (z. B. Umrechnung auf ein feineres Raster) liegen am Lauf, nicht bei den Entscheidungen.

#### B.4 Laufzerlegung und Prüfkriterium (`runs.ts`, `replay.ts`)

1. **Kriterium „Ende nicht zu früh“** (ersetzt `runOk`, `replay.ts:112-115`, gilt in Analyse, Gate, Freigabe):

   `endOk(f) := f ≥ runEnd ∨ (f > progEnd ∧ runEnd − f ≤ 5 min)`

   - `progEnd` = letzter Tick in [from, runEnd] mit gehaltenem Wert > `tailCeil`.
   - `tailCeil` (P6): Kandidat = 1,1 × höchstes Burst-Maximum der Läufe mit erkanntem Nachlauf (≥ 2 Läufe; erkannt heute über `trailerOf`). **Endblock** (allein aus der Zerlegung, ohne gelernte Bänder): letzte Strecke vor `coreEnd` mit gehaltenem Wert > 1,25 × höchstes Burst-Maximum, Unterbrechungen ≤ 60 s überbrückt, mindestens 2 min (`SUSTAINED_MS`). *Blöcke über der Laufschwelle taugen dafür nicht: bei der WM liegt der gehaltene Wert im ganzen Lauf über 5,5 W (Minimum 6 W in 12/12 Läufen), ein solcher Block wäre der ganze Lauf.* **Verwendet nur bei echter Trennung:** in jedem Lauf mit Nachlauf reicht dieser Endblock bis `coreEnd` (± G). Beispiel WM: Endschleudern 177–715 W > 1,25 × 113 W = 141 W → getrennt, `tailCeil` = 124 W. Trockner: Abkühlen 121–135 W < 1,25 × 116 W = 145 W → keine Trennung → `tailCeil = runLimit`, d. h. `progEnd = runEnd`, Kriterium = heutiges, Endblock = letzter Block ≥ 2 min über der Laufschwelle. Gerät ohne Nachlauf (weniger als 2 Läufe mit erkanntem Nachlauf): ebenso `tailCeil = runLimit`. Der Schlussblock der Schlussphase (B.6) ist davon getrennt und wird aus den Grundbändern bestimmt. Im Laufspeicher stehen `tailCeil` und Trennung als Wert über alle zugelassenen Läufe (eine einzelne Live-Aufnahme enthält nur einen Lauf) sowie je Lauf `progEnd`, Burst-Maximum und Endblock-Minimum.
   - 5 min = `DENSE_MIN_MS`: kürzeren Nachlauf erkennt `buildLayout` nicht als dichten Nachlauf.
   - Geprüft [S3]: 03.11. richtig als in Ordnung; provozierte Frühmeldungen (Y = 0,5 min) 12 von 12 erkannt. **Abnahme (P6):** auf `tr.json` ist `endOk` nach der `trailerOf`-Korrektur identisch mit dem heutigen `runOk`.
2. **Knitterschutz beim Trockner 7/7** (`trailerOf`, `runs.ts:324-350`); WM unverändert 10/10; `washerAntiCrease.json` unverändert.
3. **Auswahl statt `MAX_WINDOWS = 20`:** Statistik und Laufprüfung über alle Läufe der 30 Tage (Metadaten, höchstens 400); Nachspielen über eine ausgewogene Auswahl von höchstens 60 Läufen (je Gruppe die neuesten plus alle Grenzläufe); scope continuous lernt aus Tagesabschnitten.
4. **Bausteine:** `blocksOf`, `mergeBlocks`, `gapsBetween` exportiert; `RunInfo` + `progEnd`, `endBlockFrom`, `endBlockTo`; `Layout` + `tailCeil`, `tailSeparated`.
5. **Revision der Zerlegung (P12):** `buildLayout` bekommt eine Konstante `LAYOUT_REV`; jeder gespeicherte Lauf trägt `rev`. Fehlt `rev` oder ist sie älter, wird der Lauf beim Laden aus seinen Rohzellen (`data`/`q`) neu zerlegt, `seg`/`feat` werden neu berechnet und die Familien-ids über die bisherige id-Stabilität erhalten. Läufe ohne Rohdaten (nur Schlüssel) bleiben unberührt. Als Rückfall gilt `progEnd = runEnd`, und neue Gruppenmerkmale werden nur genutzt, wenn alle Läufe sie haben (kein `NaN`-Abstand; Mittelwert/Streuung `families.ts:59-63`, Abstand `:74`).

#### B.5 Phasen lernen (`src/lib/phases/learn.ts`)

Eingabe: Läufe mit `uses.phases`; bei scope continuous Tage, wobei unbeweisbare Lücken nur ihr Segment ausschließen (P2) und Tage mit beweisbarer Lücke, `sparse` oder Entprellung in `historyCfg` entfallen.

1. **Scope:** `continuous` bei > 6 Läufen/Tag oder Median-Ruhe zwischen Läufen < 30 min (Kessel; ebenso z. B. eine taktende Wärmepumpe, nicht nachgerechnet), sonst `run`; im Dialog änderbar.
2. **Bänder:** zeitgewichtetes Histogramm auf log-Skala (~7 %-Klassen), bei rhythmischen Geräten über den 60-s-Median, bei Zigbee über Rohwerte; Gipfel ab Verhältnis 1,2. Zusammenlegen: unter der Laufschwelle → „Ruhe“; **ein Band bleibt, wenn es in ≥ 3 Läufen bzw. Tagen mindestens 3-mal je Lauf/Tag als eigenes Segment vorkommt oder ≥ 0,5 % der *aktiven* Zeit (über der Laufschwelle) ausmacht** (P3; Kessel: Spitzenband > 294 W kommt ~20-mal pro Tag vor und bleibt); Nachbarbänder, die innerhalb eines Blocks hin und her wechseln, werden vereint. **Grenze:** überlappen p99,9 des unteren und p0,1 des oberen Bands nicht (nur Blöcke ≥ G), geometrisches Mittel, sonst Tal; jede Grenze muss in jeder Gegenprobe in einem Tal liegen, sonst vereinen. Beispiel WM Schleudern/Heizen: 1311 W.
3. **Glättung:** `block` bei hohen gleichmäßigen Bändern; `level` bei Wechselrhythmus (Tiefphasen p99 < 30 s; `windowSec` = 3 × p99, auf 15 s gerundet); `debounce` bei Zigbee; **`peak` bei Bändern, deren Segmente im Median kürzer als 2 × Entprellung sind** (P3).
4. **Segmente** mit dem Tracker-Code aus A.5, offline mit Rückschau.
5. **Dauerklassen:** Brüche bei Verhältnis ≥ 2; eine Klasse braucht ≥ 3 Läufe bzw. Tage; Grenze √(längster der kürzeren · kürzester der längeren Klasse); `decided = "end"` bei Höchstdauer-Klassen.
6. **Kontext:** `after` nur, wenn der Vorgänger zwei sonst gleiche Klassen mit je ≥ 3 Belegen trennt (Kessel: Anlauf/Nachlauf im Band 35–120 W). **Ereignisphase** (P3), wenn ein Band mit `peak`-Glättung zu ≥ 80 % in eine feste Menge von Folgebändern übergeht: `confirm` = diese Bänder, `confirmSec` = p95 der Zeit bis zum Übergang, `tailSec` = p95 der Länge vom Eintritt bis zum stabilen Folgepegel. Kessel [S13]: 79 von 86 Spitzen gehen binnen 60 s in den Brenner (120–294 W) → Ereignisphase „Zündung“; die übrigen 7 bleiben Oberbegriff bzw. „Anlauf“. `notBeforeSec` nur, wenn es trennt.
7. **Gegenprobe:** je Lauf/Tag aus den übrigen lernen, den ausgelassenen online mit dem Tracker nachspielen, Referenz ist die Offline-Zerlegung. Eine Klasse bleibt nur bei ≥ 99 % außerhalb der Übergangszonen und ohne falsch benanntes Segment, sonst Oberbegriff, sonst „unbekannt“. Flacker-Grenze: ≤ 1,2 × so viele Wechsel wie Offline-Segmente. **Abnahme Kessel (P3):** ≥ 90 % der in den Brenner übergehenden Spitzen live als „Zündung“ ≤ 10 s nach Spitzenbeginn; besteht die Zündung die Gegenprobe nicht, erscheint sie nur rückwirkend in der Zeitleiste, und der Dialog sagt das ausdrücklich.
8. **Benennung:** neutrale Vorschläge („Stufe 3 · ≈ 2150 W · 5–30 min“), Wortschatz der Vorlage als Auswahl (bei „Benutzerdefiniert“ nur neutrale Vorschläge und freie Eingabe); Neulernen ordnet alte Phasen über Bandüberlappung und Dauer zu und behält id, Name, `notify`, Text; Phasen ohne Partner als „entfällt“ mit Verweis auf betroffene Aktionen.
9. **Programmgruppen:** **Vorschlag:** Gruppenmerkmale (`families.ts:27-37`) bekommen zusätzlich die Dauer im höchsten Grundband und die Zahl der Blöcke im Schlussband (immer, da Grundbänder immer gelernt werden). *Begründung:* Programme unterscheiden sich oft in der Dauer ihrer stärksten Phase (Beispiel WM: Heizdauer 7/14/40 min). Alte Läufe bekommen die Merkmale über die Neuzerlegung (B.4 Punkt 5).

#### B.6 Schlussphase lernen (`src/lib/learn/finalLearn.ts`)

Kandidat je Lauf: letzter Block im Kern in einem Grundband (Schlussblock). Welches Band das ist, folgt aus den Läufen, nicht aus der Geräteart (Beispiel WM: Schleuderband unterhalb des Heizbands; Spülmaschine: Heizband des letzten Spülgangs vor dem Trocknen, Beispiel, nicht nachgerechnet). Alle Werte sind allgemeine Regeln über die Läufe des Geräts:

| Wert | Regel | Beispiel WM |
|---|---|---|
| P | Mitte des breitesten P-Bereichs mit maximaler Abdeckung bei Trennverhältnis Endblock/anderer Block ≥ 2 | 150 W |
| Pmax | Grenzregel B.5 zum nächsthöheren Band; liegt der Schlussblock im höchsten Band, 0 (offen) | 1311 W |
| `finalHotVal` (Ausgang c) | = Pmax, wenn Pmax > 0 und in **allen** gelernten Läufen nach dem Schlussblock bis zur Ruhe nie ein gehaltener Wert ≥ Pmax vorkommt (gelernte Form von „danach keine Hochlast mehr“); sonst 0 = Ausgang c aus | 1311 W (nach dem ersten Schleudern nie Heizen [S2]) |
| Y | √(kürzester Endblock · längster anderer Block), summiert im Band mit G; **Blöcke mit Haltezeit über der Verdachtsgrenze zählen nicht** (P28) | ≈ 2,6–2,8 min |
| X | 0,5 × p10 des Endblock-Beginns | ≈ 67 min |
| G | max(60 s, 2·Poll) | 60 s |
| Z | max(120 s, 2 × längste Unterbrechung im Endblock, 2·Poll) | 120 s |
| `finalRestVal` | Laufschwelle der Zerlegung, sonst `standby` | 5,5 W |
| `finalRestSec` (P4) | max(60 s, 3·Poll, 2 × längste Strecke **unter `finalRestVal`** im Programm, 1,5 × längste Strecke **unter `finalRestVal`** im Nachlauf) | 60 s (im Programm ≤ 10 s, im Nachlauf 0 s, R `x_rest.mjs`) |
| `finalActVal` (P4) | 1,5 × gelernter Nachlauf-Ruhepegel (Median der gehaltenen Werte im Nachlauf außerhalb seiner Aktivitätsspitzen); ohne Nachlauf 1,5 × `finalRestVal` | 9 W (Ruhepegel 6 W) |
| `finalActShare` (P4) | max(0,6; höchster Anteil über `finalActVal` in einem 5-min-Fenster der Sperrphase im Nachspielen + 0,15), höchstens 0,8; liegt der höchste Anteil über 0,65, ist Ausgang f aus (`finalActVal = 0`) | 0,7 (gemessen 0,53 [S12]) |
| `finalCheckSec` | max(30 min, 1,5 × längster Abstand zweier Schlussband-Blöcke nach X) | 40 min |
| `finalLockSec` | max(30 min, 1,5 × längste Zeit vom frühen Ende bis zum Ende des inneren Detectors im Nachspielen), höchstens 4 h | ≈ 45 min |

**Freigabe nur, wenn alle gelten:**
- ≥ 5 abgedeckte Läufe mit `uses.final`.
- Nachspielen über alle zugelassenen Läufe mit `uses.end` mit der **vollständigen Kette einschließlich TrailerFilter**: `endOk`, 0 Frühmeldungen, 0 Phantomstarts; jeder zugelassene Lauf ergibt genau einen Start und ein Fertig (kein Start nach dem frühen Ende innerhalb des Laufs oder seines Nachlaufs, also kein Ausgang c, d, f oder g in einer echten Sperrphase).
- Nachlauf trennt: in allen Läufen liegt nach dem Schlussblock bis zur Ruhe kein gehaltener Wert im Schlussband [P, Pmax) (sonst könnten Ausgang d oder g im eigenen Nachlauf einen Scheinlauf auslösen). Beispiel WM: Nachlauf ≤ 113 W < P = 150 W.
- Gegenprobe: ohne je einen Lauf (ab 3 Gruppen ohne je eine Gruppe) gelernt, 0 Frühmeldungen beim ausgelassenen; Rückfall erlaubt. WM: 10/10 richtig, 0 zu früh, 2 Rückfälle [S9].
- Robustheit: Leistung ±10 %, Poll × 1/× 3/× 6 (≥ 60 s), 30 % fehlende Werte, eine Abfrage später: je 0 Frühmeldungen [S8].
- Spielraum: P ±10 % ändert die Zahl der Frühmeldungen nicht.
- Gewinn: mittlere Ende-Verzögerung um ≥ max(60 s, 10 %) besser. Ein Gerät ohne Nachlauf erfüllt das nie; die Schlussphase wird dann nicht angeboten.
- Läufe mit Befund: nicht schlechter als ohne Schlussphase.

Ohne Kandidat zeigt der Dialog den Grund. Beispiele: Trockner „Abkühlen und Nachlauf (Knitterschutz) liegen nur 3 W auseinander; die Heizpausen sind so lang wie das Abkühlen“ (aus den Daten); Gerät ohne Nachlauf „Das Ende wird schon direkt nach der letzten Phase erkannt; die Schlussphase bringt keinen Gewinn“.

#### B.7 Dialog „Anlernen“ (Device Manager; ersetzt `learnFromHistory`, `deviceManagement.ts:865-952`)

1. **Läufe:** Tabelle mit Datum, Dauer, Energie, Gruppe, Phasenfolge (sobald gelernt), Prüfung (✓ oder Gründe), Grenzlauf (Grenze, Wert ohne ihn), Verwendung (Auto/Verwenden/Nicht verwenden). „Neu berechnen“ wertet nur die gewählte Menge aus. Hinweis oben, wenn Läufe `formerlyDropped` tragen (P16).
2. **Erkennung:** Start-/Ende-Vorschlag (`analyzeTicks`) nur aus zugelassenen Läufen, mit Gegenprobe und Bewertung der aktuellen Werte; Vorschlag Schlussphase mit Kennzahlen („Fertig im Median 28 min früher, 11 von 12 Läufen, 0 zu früh, 1 Rückfall“), Haken „übernehmen“ standardmäßig aus.
3. **Phasen** (nur bei „Phasen anzeigen“): Name (bearbeitbar), Band, Dauer, Vorgänger, Übereinstimmung, „anzeigen“, „melden bei Beginn/Ende“, „danach fertig“ (nur aktiv, wenn B.6 für dieses Band freigibt); Hinweis bei Klassen, die nur rückwirkend erscheinen.

„Übernehmen“ schreibt `detection`, `phases` und die Entscheidungen ins Gerät bzw. in den Laufspeicher (C.4, C.7); kein Instanz-Neustart.

**Aufzeichnen** (`learning.start/stop`, ein Lauf) liefert Start-/Ende-Werte und die Prüfungen ohne Vergleich (`incomplete`, beweisbare `gap`, `unit`, `counter`, `invalid`); Phasen nur bei scope continuous und ≥ 3 Belegen je Klasse; Schlussphase nie.

---

### 5.C Werte im Gerät statt Gerätetypen

#### C.1 Datenmodell (`config.ts:205-240`)

```ts
interface DeviceConfig {
  // … wie heute: enabled, name, powerId, switchId, startText, endText, abort, abortFixed,
  //    autoOff, autoOffMinutes, recipients, reminder, actions, autoOptimize, optimizeNotify
  detection: DetectionSettings;   // 16 bisherige + 13 final*-Felder, Einheit des States
  template?: string;              // id der eingebauten Vorlage; entfällt bei übernommenem Lernergebnis
  needsReview?: boolean;          // Migration: Typ nicht eindeutig gefunden
  phases?: PhaseModel;            // fehlt = Phasen aus
  typeId?: string;                // nur Altbestand; die Migration entfernt es
}
```

`normalizeDeviceConfig` (`config.ts:622`) übernimmt `normalizeType` und `normalizeTrailer`, dazu `normalizeFinal`; fehlende/ungültige Werte → „Benutzerdefiniert“ mit Warnung. Es entfallen `InstanceConfig.types` als aktive Konfiguration, `IdPatch.types`, der Typ-Block in `normalizeInstanceConfig` als Laufzeitpfad (er bleibt als reine Auflösungsfunktion für die Migration erhalten, C.6), `findType` im Laufzeitpfad und der `types`-Zweig in `persistGeneratedIds` (`main.ts:186-187`).

#### C.2 Vorlagen und Archiv
- **Eingebaute Vorlagen** (`src/lib/templates.ts`): Waschmaschine, Trockner, Geschirrspüler mit 3.1.2-Werten (`config.ts:260-312`), „Benutzerdefiniert“ (30/5/1/1/20) für jedes andere Gerät (Kessel, Kaffeemaschine, Wärmepumpe, 3D-Drucker, Ladegerät …); in W, beim Übernehmen durch `unitFactor` geteilt. Vorlagen enthalten nur Start-/Ende-Werte (und ggf. einen Phasen-Wortschatz für Namensvorschläge), **nie** Schlussphase, Phasenbänder oder andere gerätespezifische Regeln; diese entstehen nur durch Lernen am eigenen Gerät.
- **Archiv-Vorlagen:** `native.types` bleibt als Archiv, nur lesbar. Auswählbar sind alle Typen, deren Werte **oder Name** von der gleichnamigen eingebauten Vorlage bzw. von „Benutzerdefiniert“/`customN` abweichen (P17), auch angelernte V4-Typen ohne Gerät. Entfernen über die Instanz-Aktion „Alte Vorlagen entfernen“.
- **„Werte eines anderen Geräts übernehmen“** beim Anlegen: nur die 16 Grundwerte (Start/Ende, Pausenschutz, Knitterschutz); Schlussphase (`final*` = 0) und Phasen werden **nicht** kopiert, sondern am neuen Gerät angelernt (Freigabe nur mit Nachweis am eigenen Gerät, Risiko 10), Hinweis im Formular. Leistungswerte werden zwischen W- und kW-States umgerechnet (Verhältnis der `unitFactor`; Archiv-Vorlagen gelten als W).
- **Bearbeiten** übernimmt alle Gerätefelder, die das Formular nicht zeigt (`phases`, `learned`, `template`), aus der bisherigen Konfiguration; `template` entfällt nur, wenn die Erkennungswerte von der Vorlage abweichen. Ein Gerät ohne gültige Werte (kein `detection`, kein Typ-Treffer) bekommt „Benutzerdefiniert“ und wird mit `needsReview` deaktiviert (es lief vorher nicht und darf nicht plötzlich Nachrichten senden).
- **`keepCurrentLevel`:** im Anlern-Dialog `= template ist eingebaute Vorlage` (entspricht `deviceManagement.ts:913-914`); Aufzeichnen (`deviceRegistry.ts:323-328`) und Optimierung (`autoOptimize.ts:386`) unverändert Standard `true`.

#### C.3 Laufzeit
- `DeviceRuntime`: Konstruktorparameter `type` entfällt; Getter `deviceType` → `baseDetection`.
- **Drei Ebenen (P19):**
  - `base` = `cfg.detection`;
  - `effective` = `base ⊕ override` – Grundlage für Optimierung (`p0`), `diffOf`, „Als Grundwerte übernehmen“, Anzeige;
  - `active` = `effective` mit Maske `finalMinVal = 0`, solange `final.state = "suspended"` – **nur** für den Bau des Detectors.
  
  Die Maske geht nie in `p0`, `diffOf`, Override oder Grundwerte ein. „Als Grundwerte übernehmen“ während des Aussetzens übernimmt die unmaskierten Werte; `final.state` bleibt `suspended`. Undo und Zurücksetzen ändern `final.state` nicht; nur „Schlussphase wieder einschalten“, „war ein neuer Lauf“ (D.7), eine erfolgreiche Reparatur (D.5) oder „Lerndaten löschen“ (→ `off` bzw. `on` je nach Grundwert) tun das.
- `canKeepStateFor` vergleicht nur `powerId`.
- **`updateConfig` / `upsert` bei geänderten Grundwerten (P9):** Weicht `hash(base)` vom gespeicherten Hash ab, wird **zur Laufzeit** abgeglichen (`reconcileBase`): Override verwerfen, Hash nachführen, Änderungseintrag `baseChanged`, `runtime.setOverride(null)`, Speicher sichern. Ausnahme: Ist `hash(neue base) = hash(effective)` (Folge von „Als Grundwerte übernehmen“, C.7), wird das Override verlustfrei auf `null` gesetzt und der Eintrag heißt `adopted`. `syncOptimize` (`deviceRegistry.ts:606-608`) bricht heute bei vorhandenem `entry.opt` ab; der Abgleich läuft daher in einem eigenen Pfad, auch wenn der Speicher schon geladen ist. Danach Detector-Neubau bei `!started && !settling`, sonst später; Tracker-Neubau zwischen zwei Läufen.
- `deviceRegistry.upsert`: Typsuche und Ignorieren bei unbekanntem Typ (`:114-119`) entfallen; Geräte mit `needsReview` und `enabled = false` laufen nicht.

#### C.4 Bedienung
- **Admin:** Tab „Gerätetypen“ (`admin/jsonConfig.json:88-275`) entfällt; an seiner Stelle ein Hinweistext, dass die Werte im Gerät stehen.
- **Geräteformular (`deviceForm.ts`):** beim Anlegen zuerst die Quelle (eingebaute Vorlage, Archiv-Vorlage, anderes Gerät); dann „Erkennung“ (Modus, 5 Schwellen, 2 Dauern); Pausenschutz, Knitterschutz, Schlussphase hinter „Expertenwerte“, ausgeblendet bei ausgeschaltetem Hauptschalter; i18n `typeStartVal`…`typeTrailerMaxTooltip` weiterverwendet; Pflichtfeld „Typ“ entfällt.
- **Device Manager:** Details „Erkennung“ statt „Typ“; Gerätekarte `model` = Vorlagenname / „angelernt“ / „eigene Werte“; Warnungen `needsReview`, „Schlussphase ausgesetzt“, „Läufe zur Prüfung“, „Optimierung zu langsam“; `saveLearnedType` → `applyLearned` (alt/neu, `writeDevice`, `template` gelöscht, kein Namensfeld, kein Neustart); Optimierungsdialog „Als Grundwerte übernehmen“ (C.7), Spalte „Grundwert“.

#### C.5 Migration aus 3.1.2 (`migration.ts`)
- **Typzuordnung wie 3.1.2** (`.tmp/legacy/package/main.js:456-503`): erst `default.ids` mit exakt gleichem, ungetrimmtem Namen (bei mehreren gewinnt der letzte), nur ohne Treffer `custom.ids` (bei mehreren gewinnt der letzte); 5 Werte + Basis (count, 60/300 s, Pausenschutz 0, Knitterschutz und Schlussphase aus) nach `detection`; ein Treffer aus `default.ids` setzt `template` nur, solange die Werte denen der Vorlage gleichen (gleicher `typeHash`, dieselbe Regel wie im Formular); geänderte Werte sind eigene Werte des Geräts. Golden-Vergleich „alt über Typ“ gegen „neu im Gerät“.
- **Ohne exakten Treffer:** 3.1.2 meldete solche Geräte einmal als gestartet und nie als fertig (`main.js:709, 739, 861-895`). **Entschieden (Abschnitt 10, Frage 1):** vollständig übernehmen, `enabled = false`, `needsReview`; Werte in dieser Reihenfolge: Typ, der nur ohne Groß-/Kleinschreibung bzw. Leerzeichen am Rand passt; sonst die `custom.ids`-Zeile, deren ursprünglicher Platzname `customN` (Zeilen-id N−1) dem Gerätetyp gleicht (Typ nach der Zuordnung umbenannt); sonst „Benutzerdefiniert“; Warnung mit dem gewählten Weg in Log und auf der Gerätekarte. Speichern im Geräteformular löscht `needsReview`.
- **Archiv:** 3.1.2-Typen ohne Gerät, deren Werte **oder Name** von der Vorlage abweichen (P17), landen in `native.types`.
- **Geteilte Typen:** jedes Gerät bekommt eine eigene Kopie (Doku §9).
- **Nichts geht still verloren:** Ein Typ-Kommentar (`comment`) ungleich leer, ein leerer oder nicht numerischer Typwert (Ersatz: Wert der Vorlage, wie heute) und ein SayIt-/WhatsApp-Ziel (`path`), das von dem aus der Instanz abgeleiteten Ziel (`<instanz>.tts.text` bzw. `<instanz>.sendMessage`) abweicht, ergeben je eine Migrationswarnung mit altem und neuem Wert.

**Zuordnung alt → neu (jede 3.1.2-Einstellung; Test je Zeile, Plan Task 5)**

| 3.1.2 (Instanz-native bzw. Zeile) | V4 (Stelle) | Regel |
|---|---|---|
| `status.ids[0].stateAction` / `stateStandby` / `stateOff` | `native.statusTexts.running` / `.standby` / `.off` | leer → Standardtext („in action“, „standby“, „switched off“) |
| feste Abfrage alle 10 s (kein Feld) | `native.pollIntervalSec` = 10 | – |
| (kein Feld) | `native.historyHtml` = false | neue Option aus |
| `alexa.ids[]`: `id`, `name`, `path`, `volume`, `activeFrom`, `activeUntil` | `native.recipients[]`: `id` = `alexa-<id>`, `kind` alexa, `name` (leer → id), `stateId` = `path`, `instance` aus `path` (`alexa2.N`, sonst `alexa2.0`), `volume` (außerhalb 0–100 oder leer → 50), `activeFrom`, `activeUntil` | Zeile ohne `id` → Warnung, entfällt |
| `sayit.ids[]`: wie Alexa | `kind` sayit, `instance` aus `path`, `stateId` = `<instance>.tts.text`, `volume`, Zeitfenster | abweichender `path` → Warnung (alt/neu) |
| `whatsapp.ids[]`: `id`, `name`, `path` | `kind` whatsapp, `instance` aus `path` (`whatsapp-cmb.N`, sonst `.0`), `stateId` = `<instance>.sendMessage` | abweichender `path` → Warnung (alt/neu) |
| `telegram.ids[]`: `id`, `name`, `inst` („.N“), `key` (username/firstname/chatID), `username` | `instance` = `telegram.N`, `telegramTarget` = `chatId` bei `chatID`, sonst `user`; `target` = `username` | – |
| `pushover.ids[]`: `id`, `name`, `inst`, `title`, `deviceID`, `prio`, `sound`, `ttl` | `instance` = `pushover.N`, `title`, `device`, `priority` (normal 0, high 1, quiet −1, confirmation 2), `sound`, `ttl` | – |
| `signal.ids[]`: `id`, `name`, `inst` | `instance` = `signal-cmb.N` | – |
| `email.ids[]`: `id`, `name`, `emailFrom`, `emailTo` | `instance` = `email.0`, `emailFrom`, `emailTo` | – |
| `matrix.ids[]`: `id`, `name`, `inst` | `instance` = `matrix-org.N` | – |
| `discord.ids[]`: `id`, `name`, `inst`, `userId`, `userTag`, `userName`, `serverId`, `channelId` | `instance` = `discord.N` und die fünf Felder | leere Felder entfallen |
| `default.ids[]`: `name`, `startVal`, `endVal`, `standby`, `startCount`, `endCount`, `comment` | `detection` jedes Geräts mit diesem Typ (Kopie), `template` = Typ-id nur bei unveränderten Werten der Vorlage; ohne Gerät und abweichend → `native.types` (Archiv) | Zahlen auch als Text („30“); `comment` ≠ leer → Warnung |
| `custom.ids[]`: dieselben Felder, Zeilen-id 0–9 = `custom1`…`custom10` | `detection` jedes Geräts (Kopie), kein `template`; ohne Gerät und abweichend (Werte oder Name) → `native.types` mit id `customN` | wie oben |
| `linkedDevice.finalIds.<n>.name` | Geräteobjekt `<allocateDeviceId(name)>`, `common.name`, `native.name` | 3.1.2-Name (ungetrimmt) bleibt Präfix der alten States |
| `.enabled` | `native.enabled` | ohne exakten Typ-Treffer `false` |
| `.type` | `native.detection`, `native.template`, ggf. `native.needsReview` | siehe oben |
| `.pathConsumption` / `.pathSwitch` | `native.powerId` / `native.switchId` | leerer Schalter → Feld fehlt; fehlender Leistungs-State → Warnung |
| `.startText` / `.endText` | `native.startText` / `native.endText` | – |
| `.abort` | `native.abort`; `native.abortFixed` = false | – |
| `.autoOff` / `.timer` | `native.autoOff` / `native.autoOffMinutes` = ⌊timer⌋ | leer → 0 |
| `.alexa[]` … `.discord[]` | `native.recipients` = `<messenger>-<id>` in 3.1.2-Reihenfolge | unbekannte id → Warnung, entfällt |
| `.runtimeMax` (Feld, in 3.1.2 ungenutzt), `.id` | entfällt | – |
| (keine) | `reminder` = aus, `actions` = [], `autoOptimize`/`optimizeNotify`/`phases` fehlen | neue Optionen aus |
| States `<name>.last operations`, `.lastRuntime`, `.config.do not disturb`, `.config.runtime max` | `<id>.lastOperations`, `.lastRuntime`, `.config.doNotDisturb`, `.config.runtimeMax` | übrige 3.1.2-States werden gelöscht |

**V4-Teststände (C.6):** `native.recipients`, `statusTexts`, `pollIntervalSec`, `historyHtml` bleiben unverändert; `native.types` bleibt als Archiv; je Gerät alle Felder unverändert außer `typeId` (entfernt) → `detection` (= `detectionOf(normalizeType(Treffer))`), `template` (eingebauter Typ mit unveränderten Werten der Vorlage), `needsReview` (kein Treffer); die Typ-id wird wie bisher getrimmt, eine Zahl gilt als Text; Laufspeicher: `override` bleibt bei `hash(detection) = typeHash(Typ)`.

**Verhaltensänderungen durch die vollständige Übernahme (Doku §9, keine Fehlzuordnung):** 3.1.2 sendete Pushover-Priorität und -Gerät nie (Feld `deviceId` statt `deviceID`, Priorität als Text gegen 2 verglichen), V4 sendet die eingetragenen Werte; Telegram-Ziel als Feld `user`/`chatId` statt `username`/`firstname`/`chatID`; Matrix an `matrix-org.N`; Zeitfenster über Mitternacht gelten, gleiche Anfangs- und Endzeit heißt „immer“.

#### C.6 Migration von V4-Testständen
- **Erkennung über die Struktur:** Geräteobjekt mit `typeId`, ohne `detection`. (`configVersion` taugt nicht, js-controller trägt den Default ein.)
- **Typauflösung genau wie heute (P11):** `resolveLegacyTypes(native)` = der bisherige Typ-Block aus `normalizeInstanceConfig` (Ergänzung fehlender eingebauter Typen aus `DEFAULT_TYPES`, alle 13 Standardtypen bei leerer/fehlender Tabelle, deterministische id-Vergabe für Zeilen ohne id wie `allocateDeviceId`) plus `findType`. Diese Funktion bleibt im Code, nur noch für die Migration. `detection = detectionOf(normalizeType(treffer))`, `template` bei eingebautem Typ, solange seine Werte denen der Vorlage gleichen (gleicher `typeHash`), `typeId` (getrimmt, Zahl als Text, wie `normalizeDeviceConfig`) entfernt. `needsReview` nur, wenn auch diese Auflösung nichts findet; dann zusätzlich `enabled = false` (das Gerät wird heute ignoriert und darf nach der Migration nicht mit „Benutzerdefiniert“ Nachrichten senden).
- **Keine Schreibzugriffe auf die Instanz-native**, kein Neustart; `native.types` bleibt als Archiv.
- **Idempotent:** Geräte mit `detection` werden übersprungen; ein abgebrochener Lauf wird beim nächsten Start fortgesetzt.
- Die 3.1.2-Migration schreibt direkt `detection`. `"types"` bleibt in `v4Keys` (`main.ts:110-117`); Default `configVersion` in `io-package.json` → 5 (nur Kennzeichen); `native.types` fällt aus den Defaults. Version und News unberührt.
- **Testfälle:** eingebaute Zeile gelöscht, `native.types` leer, `native.types` fehlt, Zeile ohne id, `custom1..10` nur aus Defaults, `persistGeneratedIds` gescheitert.

#### C.7 Laufspeicher und Hash
- **Format bleibt `v: 1`**, neue optionale Felder: `verdicts`, `bands` (Grundbänder + Haltezeit-Profil), `final` (`state: "off" | "on" | "suspended"`, `splits` = Schlüssel der als `finalSplit` gewerteten Läufe, `suspendedAt`), `phaseCheck`, `legacyEnvelope`, `job` (Fortschritt, D.3), `layoutRev`; je Lauf `rev`, `afterFinal`.
- `typeId` wird nicht mehr verglichen; `typeHash` bedeutet „Hash der Grundwerte“ (Regel A.2). Nach der Migration gilt `hash(detection) = typeHash(typ)`, ein passendes Override bleibt, ein veraltetes wird wie heute verworfen.
- **`reconcileStore`** (`runStore.ts:467-509`) beim Laden und **`reconcileBase`** zur Laufzeit (C.3, P9); Änderungstyp `baseChanged` (alte `typeChanged` mit gleichem Text angezeigt).
- **Poll- oder Einheitenwechsel (P27):** Läufe werden **umgerechnet statt verworfen**. Einheit: alle Werte mit dem Faktorverhältnis skalieren. Poll: Zellen auf das neue Raster abbilden (gröber: gehaltener Wert am Rasterpunkt; feiner: Wiederholung). Läufe, die auf ein feineres Raster gebracht wurden, bekommen `uses.phases = false` und `uses.trailer = false` (kurze Bursts fehlen). `envelope`, `legacyEnvelope` und die Grenzwerte der Grenzläufe werden intern in W geführt und bleiben erhalten.
- **Gleichzeitiges Schreiben:** Die Optimierung merkt sich zu Beginn `hash(base)` und vergleicht vor dem Schreiben; bei Abweichung wird das Ergebnis verworfen.
- **„Als Grundwerte übernehmen“ (P29):** **zuerst das Gerät schreiben** (`detection := effective`). Der Abgleich in `updateConfig` erkennt `hash(neue base) = hash(effective)` und setzt das Override verlustfrei auf `null` (Eintrag `adopted`). Scheitert das Schreiben des Geräts, bleibt alles wie vorher. Wird die Instanz zwischen beiden Schritten beendet, holt `reconcileStore` den Abgleich beim Laden nach.
- **Alter Speicher und `envelope` (P10):** Beim ersten Laden eines Speichers ohne `legacyEnvelope` wird die vorhandene `envelope` als `legacyEnvelope` eingefroren. Sie wirkt wie ein Grenzlauf ohne Rohdaten: Die neu berechnete `envelope` ist mindestens so weit wie sie. Zurückgesetzt wird sie nur durch „Lerndaten löschen“ oder ausdrücklich im Dialog („Altgrenzen verwerfen“, mit Warnung). Grenzläufe unter den vorhandenen Läufen werden vor jeder Verdrängung bestimmt.

---

### 5.D Auto-Optimierung nach jedem Lauf über 30 Tage

#### D.1 Verhältnis zum Bestand
Keine zweite Optimierung; die vorhandene `autoOptimize` wird erweitert, je Gerät eingeschaltet, Standard aus (`config.ts:237`). Erhalten: Gate, Reparatur, Verschärfung, `stepLimit`, `applyFloors`, Gegenprobe je Gruppe, Robustheit, Sperren, Drift-Pause, Benachrichtigung. Neu: 30-Tage-Fenster, Laufprüfung, Grenzläufe mit Veto, neu berechnete `envelope` mit `legacyEnvelope`, `final*` als optimierbare Felder über einen eigenen Pfad, Phasen-Feinjustierung, Budget reihum. **Die Optimierung schreibt nur das Override im Speicher**; die Grundwerte ändert nur der User.

#### D.2 Datenfenster und Speicher
- **Zielmenge:** zugelassene Läufe der letzten 30 Tage (Gewinn, Idealwerte).
- **Prüfmenge:** Zielmenge + alle Grenzläufe unabhängig vom Alter + `legacyEnvelope` (Gate, Untergrenzen; kein Verschärfungsziel).
- **Grenzlauf (P23):** (1) bindet die `envelope` (wie heute `binding` in `pickVictim`), oder (2) hat bei einer der letzten Auswertungen einen Kandidaten verhindert (`veto`: der Kandidat bestand alle übrigen Läufe, scheiterte an diesem). Das Veto entsteht ohne Zusatzaufwand, weil die Verschärfung ihre Kandidaten ohnehin über die Prüfmenge spielt. Ein Veto verfällt, wenn ein später übernommener Kandidat den Lauf besteht.
- **Speicher:** **Vorschlag:** höchstens 1 MB je Gerät (heute 400 KB/20 Läufe). *Begründung:* 30 Tage WM ≈ 30 Läufe.
- **Verdrängung (P23), schrittweise – nach jedem verdrängten Lauf werden `binding` und Grenzläufe neu bestimmt:**
  1. Läufe älter als 30 Tage, kein Grenzlauf, **je Programmgruppe bleiben mindestens 2**, History vor live;
  2. Läufe aus der History (je Gruppe mindestens 2);
  3. ältester nicht-bindender Lauf der größten Gruppe (je Gruppe mindestens 2).
  
  Grenzläufe werden nie verdrängt. Bei Gleichstand zweier gleich extremer Läufe bleibt durch die schrittweise Neubewertung immer einer. Ausgeschlossene Läufe bleiben als Schlüssel mit Grund, ihre Daten nur, solange Platz ist.
- **Quellen:** live; History nur einmalig beim Einschalten (`bootstrapFromHistory`, gemerkt über einen Lese-Zeitpunkt, auch wenn keine Läufe gefunden wurden), nach einer Ausfallzeit > 1 h (nur diese Zeit, höchstens 30 Tage; alte Speicher ohne letzten Abfragezeitpunkt nehmen das Ende des letzten Laufs bzw. den Speicherzeitpunkt) und im Anlern-Dialog. Importierte Läufe werden über den Schlüssel (±5 min) gegen vorhandene abgeglichen, nie gedoppelt. Keine periodischen History-Durchgänge. Rohpunkte werden nie über 30 Tage am Stück gehalten; die Meldestatistik entsteht beim Einsortieren je Tick.
- **`envelope`** wird bei jeder Änderung aus Prüfmenge und `legacyEnvelope` neu berechnet; `applyFloors` (`autoOptimize.ts:605-631`) folgt ihr. Ausschließen und wieder Verwenden stellt sie exakt her.

#### D.3 Ablauf nach jedem Lauf (`storeCapture`, `deviceRegistry.ts:820-848`)
1. Aufnahme schließen, prüfen, Verdict; User-Entscheidungen über den Schlüssel anwenden.
2. **Gate nur über zugelassene Läufe** (P22) mit `endOk` und den Prüfungen der Schlussphase.
3. Danach:
   - **Saubere Erkennung hat immer Vorrang (Vorgabe des Users):** Erkennen die aktuellen Werte einen zugelassenen Lauf (ok/eingeschränkt mit `uses.end`) nicht oder nicht richtig – Start nicht erkannt, Ende zu früh (`endOk` verletzt; `progEnd` und `tailCeil` aus dem Laufspeicher, nicht aus der einzelnen Aufnahme), Lauf zerteilt, Ende nicht erkannt, Phantomstart, Schlussphase zerteilt (`finalSplit`) –, auch wenn er nur knapp verfehlt wird (z. B. eine Abfrage), wird **sofort nach diesem Lauf** in die sichere Richtung repariert (wie heute, `autoOptimize.ts:758-793`), so dass dieser Lauf **und alle anderen zugelassenen Läufe der Prüfmenge** wieder richtig erkannt werden; der Lauf wird Grenzlauf. **Verschmolzene Läufe sind kein Erkennungsfehler** (Entscheidung des Users, Abschnitt 10): Erkennt der Detector zwei echte Läufe als einen, folgt keine Reparatur, keine Verkürzung der Ende-Wartezeit deswegen und kein Hinweis (höchstens ein Info-Eintrag im Optimierungs-Verlauf); Pflicht ist nur, dass das echte Ende des Gesamtlaufs erkannt wird – scheitert diese Ende-Prüfung, ist das „Ende nicht erkannt“ bzw. „Ende zu früh“ und wird repariert. Kürzere Wartezeiten entstehen nur über die Verschärfung (Punkt 4). Die Reparatur gilt unabhängig von Mindestlaufzahl (`TIGHTEN_MIN_RUNS`, `FINAL_ENABLE_MIN_*`), Abstandsregel (`TIGHTEN_NEW_RUNS`, `TIGHTEN_SPACING_MS`), Sperre nach Reparatur/Undo/Reset (`LOCK_RUNS`, `LOCK_MS`), Drift (D.4) und Schrittweitenbegrenzung (`MAX_DROP`, `MAX_THRESHOLD_CHANGE`, Schrittgrenzen D.5) – diese gelten nur fürs Verschärfen; begrenzt ist sie nur durch die harten Wertgrenzen (`boundsOf`). Läufe in Quarantäne oder unbrauchbare Läufe (Datenfehler) lösen keine Reparatur aus. Findet sich keine Einstellung, die alle zugelassenen Läufe erkennt, bleiben die bisherigen Werte als sicherste bekannte Einstellung, Status `cannotCover`, Warnung in Log, `optimizeInfo` und auf der Karte (Nachricht nur bei `optimizeNotify`), wie heute. **Abnahme:** Ein Lauf, dessen Pause eine Abfrage länger ist als die aktuelle Ende-Wartezeit, führt nach diesem Lauf sofort zu längerer Wartezeit, auch während einer Sperre und mit weniger als `TIGHTEN_MIN_RUNS` Läufen; alle gespeicherten zugelassenen Läufe bleiben richtig erkannt.
   - **`finalSplit` (Beurteilung im Nachhinein, A.3/B.2) oder Frühmeldung im Nachspielen eines zugelassenen Laufs:** Schlussphase aussetzen (`final.state = "suspended"`, Meldung nach B.3-Zustellregel, Protokoll) und Reparatur nach D.5. Das Aussetzen geschieht auch ohne Auto-Optimierung (A.3 „Beurteilung im Nachhinein“ Punkt 4); nur die Reparatur braucht sie.
   - **Läufe in Quarantäne:** gehen nicht ins Gate. Für sie gilt nur „kein Rückschritt“ (ein Kandidat darf dort nicht schlechter abschneiden als die aktuellen Werte); sie blockieren die Verschärfung nicht. Hat die Live-Erkennung einen solchen Lauf falsch erkannt, entsteht der Hinweis aus B.3 und der Status `review`.
4. **Verschärfung (entschieden, Abschnitt 10, Frage 4):** nach jedem Lauf geprüft; übernommen erst ab **`TIGHTEN_MIN_RUNS = 8` zugelassenen Läufen** im 30-Tage-Fenster (heute 4; deutlich mehr als die 2 Läufe beim manuellen Anlernen), bei ≥ 2 neuen sauberen Läufen seit der letzten Änderung und ≥ 24 h Abstand (`TIGHTEN_NEW_RUNS`, `TIGHTEN_SPACING_MS`, unverändert); nach Reparatur, Undo oder Reset Sperre von 5 Läufen bzw. 14 Tagen (`LOCK_RUNS`, `LOCK_MS`, unverändert). Annäherung ans Optimum nur in kleinen Schritten: höchstens 25 % je Schritt (`MAX_DROP`), Schwellwerte höchstens 30 % (`MAX_THRESHOLD_CHANGE`), Schlussphase mit den eigenen Schrittgrenzen aus D.5. Außerdem Gewinn ≥ max(60 s, 10 %) oder weniger Fehlstarts, Gegenprobe je Gruppe, Robustheit (erweitert um Poll × 3 und 30 % fehlende Werte), kein Rückschritt auf Läufen mit Befund. **Reparaturen** (sichere Richtung) bleiben sofort und ohne Mindestzahl. Alle Mindestzahlen sind dokumentierte Konstanten (`autoOptimize.ts`, Doku §8).
5. Schlussphase nachführen (D.5), Phasen nachführen (D.6), Drift prüfen.
6. `learning.optimizeInfo`, `lastChange`, `parameters` schreiben.

**Budget (P24).**
- Gemessen wird **aktive Rechenzeit** (Summe der Abschnitte zwischen Yields), nicht Wanduhr; Grenze 30 s je Job.
- **Jeder Lauf:** Verdict, Gate über die Prüfmenge (≈ 8 ms je 12 Läufe), ggf. Reparatur bzw. Aussetzen. Das ist immer billig und wird nie aufgeschoben.
- **Teure Schritte reihum** mit gespeichertem Fortschritt (`job` im Speicher): Verschärfung (nur wenn die Dämpfung sie zulässt), Schlussphase nachführen, Phasen-Feinjustierung. Jeder Job setzt dort fort, wo der letzte aufhörte; Gegenproben (Freigabe der Schlussphase, Phasen-Gegenprobe) höchstens einmal pro Tag und nur, wenn seit der letzten neue zugelassene Läufe in der betroffenen Gruppe dazukamen.
- Läuft das Budget ab: keine Änderung aus dem unterbrochenen Schritt, Fortschritt gespeichert, Status `budget` dauerhaft in `optimizeInfo`; ab dem 3. Mal in Folge Warnung auf der Gerätekarte und im Log (Nachricht nur bei `optimizeNotify`).
- Geräte mit vielen Läufen (Kessel, gemessen bis 19/Tag) belasten so nur mit dem billigen Teil je Lauf.
- **Abnahme:** Messung auf einem Raspberry Pi 4 mit 30 WM-Läufen und 3 Gruppen; jeder teure Schritt kommt binnen höchstens 3 Jobs zum Abschluss.

**Idealwerte** (Rangfolge): alle zugelassenen Läufe richtig; nicht mehr Fehlstarts; Robustheit bestanden; kleinster p90 der Ende-Verzögerung; kleinster Mittelwert.

#### D.4 Ausreißer in der Optimierung
- Ein Lauf mit Datenfehler (unbrauchbar, Datenfehler-Quarantäne) ändert keinen Wert und senkt keine Grenze.
- Ein Lauf mit Form-Quarantäne wird erst nach Aufnahme durch den User verwendet; vorher Hinweis, falls er falsch erkannt wurde.
- Ein echtes ungewöhnliches Programm (`rare`) wird normal verwendet.
- Ein sauberer Grenzlauf wirkt sofort in die sichere Richtung, sichtbar, ausschließbar mit Warnung.
- Unerkannte Ausreißer sind von echten neuen Programmen nicht unterscheidbar: Sicherheit vor Tempo, Transparenz über „Wert ohne diesen Lauf“.
- **Drift:** 3 Läufe in Folge durchgefallen → keine automatische **Verschärfung**, kein automatisches Einschalten der Schlussphase, keine Phasen-Feinjustierung; Hinweis „Gerät verhält sich anders – neu anlernen?“. Reparatur und Aussetzen (D.3 Punkt 3) laufen trotzdem sofort (sichere Richtung). 3 Läufe in Folge > 10 % der Laufzeit „unbekannt“ (Phasen, reine Anzeige) ergeben nur diesen Hinweis.

#### D.5 Schlussphase in der Optimierung (P18)
- **Eigener Pfad:** Kandidaten aus der Analyse (`fromSuggestion`, `saferOf`) **übernehmen alle `final*`-Felder unverändert aus `p0`**. `final*` werden ausschließlich über `finalLearn` neu berechnet.
- **Eigene Schrittgrenzen in `stepLimit`** statt der allgemeinen 25 %-Regel: P ±10 %; Y steigt frei, sinkt höchstens 10 % und nur mit ≥ 5 abgedeckten Läufen; X sinkt höchstens 25 %; Pmax, Hochlast-Pegel, G, Z, Ruhe, Aktivität, Prüffenster und Sperrdauer aus den Daten neu (mit denselben gelernten Bedingungen wie B.6, z. B. Hochlast-Pegel 0, sobald ein Lauf nach dem Schlussblock ≥ Pmax zeigt). Ein Kandidat mit `finalMinVal` 0, während `p0` > 0 hat, ist im Verschärfungs- und Reparaturpfad unzulässig.
- **Ausschalten** nur über den ausdrücklichen Weg „aussetzen“ (`final.state = "suspended"`, Meldung nach B.3-Zustellregel, Protokolleintrag, Kartenwarnung). Ein stilles `finalMinVal 150 → 0` gibt es nicht.
- **Einschalten automatisch (entschieden, Abschnitt 10, Frage 3):** Die Optimierung schaltet die Schlussphase ohne Bestätigungsklick selbst ein, wenn `finalLearn` (B.6) auf der Prüfmenge (alle zugelassenen Läufe des 30-Tage-Fensters plus die dauerhaft gespeicherten Grenzläufe) freigibt – einschließlich Gegenprobe ohne je einen Lauf bzw. je eine Programmgruppe und Robustheit gegen gestörte Eingangsdaten – und erst ab **`FINAL_ENABLE_MIN_RUNS = 10` zugelassenen Läufen** im Fenster und **`FINAL_ENABLE_MIN_PER_GROUP = 2` Läufen je Programmgruppe**, deren Schlussblock im Schlussband liegt. Das Einschalten ist eine gewöhnliche Änderung des Overrides (Änderungseintrag `finalOn`, Meldung nur bei `optimizeNotify`, sichtbar im Dialog, rückgängig machbar; Undo schaltet sie wieder aus). Nachjustieren und Aussetzen ebenso automatisch. Nachjustieren hat eine eigene Änderungsart `finalTune` (rückgängig machbar wie `finalOn`); Verschärfung (`tighten`) und Reparatur (`repair`) der übrigen Werte ändern `final*` nie. Einschalten und Nachjustieren laufen nie während einer Sperre oder einer Drift und nie, solange eine Reparatur ansteht; Nachjustieren zusätzlich nur unter den Bedingungen der Verschärfung (2 neue Läufe seit der letzten Änderung, 24 h Abstand; Mindestzahl wie beim Einschalten `FINAL_ENABLE_MIN_RUNS`) und mit den Schrittgrenzen oben. Ohne Auto-Optimierung bleibt der Haken im Anlern-Dialog (B.7) der einzige Weg, standardmäßig aus.
- **Nach dem Aussetzen:** War das frühe Ende nach `endOk` richtig → wieder an. Sonst Reparatur (Y höher, X höher, P enger); besteht sie das Gate über alle zugelassenen Läufe, ist die Schlussphase mit Meldung wieder an; sonst bleibt sie mit Begründung aus. Bei `finalSplit` werden frühes Teilstück und Rest dabei als **ein** Lauf nachgespielt (Synthese-Test mit Einweich-Programm, 8.2). Hat der User im Dialog „war ein neuer Lauf“ bestätigt (Risiko 4), gilt das frühe Ende als richtig.

#### D.6 Phasen in der Optimierung
Nur Feinjustierung bestehender Phasen (Bandgrenzen ±15 %, `minSec`/`maxSec`, `confirmSec`/`tailSec`), nur wenn die Übereinstimmung der Gegenprobe nicht sinkt, übernommen erst nach zwei gleichen Vorschlägen hintereinander (Hysterese). Nie automatisch anlegen, entfernen, umbenennen; ids stabil. Stabiles neues Muster in ≥ 3 Läufen → Hinweis „Neue Phase gefunden“.

#### D.7 Sichtbarkeit und Steuerung (Optimierungsdialog, `deviceManagement.ts:1240-1340`)
- **Tabelle der Läufe:** Datum, Dauer, Gruppe, Quelle, Prüfung mit Gründen, Verwendung, Grenzlauf (Grenze, Wert ohne ihn, Veto), ✓/✗.
- **Aktionen und ihre Kopplung (P25):**
  - **Lauf ausschließen / wieder verwenden.** Wird ein Grenzlauf ausgeschlossen, der eine Reparatur ausgelöst hat, wird geprüft, ob die Werte vor dieser Reparatur das Gate über die verbleibenden zugelassenen Läufe bestehen; wenn ja, wird die Reparatur zurückgenommen (Eintrag `revert`) und die zugehörige Sperre aufgehoben.
  - **Rückgängig** einer Reparatur, die ein Grenzlauf ausgelöst hat, bietet im selben Schritt „diesen Lauf ausschließen“ an; sonst würde der nächste Lauf sofort wieder reparieren (die Reparatur ignoriert die Sperre, `autoOptimize.ts`, `optimize`).
  - **Rückgängig ist nur bis zur letzten Änderung der Grundwerte** (`adopted`/`baseChanged`) möglich und wird vor dem Setzen mit dem Gate geprüft. Besteht es nicht, zeigt der Dialog die scheiternden Läufe mit „ausschließen“.
  - Zurücksetzen; Lerndaten löschen (Entscheidungen bleiben, Option „auch Entscheidungen verwerfen“); Als Grundwerte übernehmen; Schlussphase wieder einschalten; bei `finalSplit` „war ein neuer Lauf“ (wertet das frühe Ende als richtig und schaltet die Schlussphase wieder ein, sofern kein anderer Lauf `finalSplit` trägt; auch ohne Auto-Optimierung); Altgrenzen verwerfen.
- **`learning.optimizeInfo`** zusätzlich: `review`, `excluded`, `finalState`, `budget` (Anzahl in Folge).

---

## 6. Zuverlässigkeitsgarantien

| # | Garantie | Erzwungen durch | Test |
|---|---|---|---|
| G1 | Alle neuen Felder 0/fehlend → Tick für Tick wie 3.1.2 | Hülle/Tracker nicht gebaut; Hash bitgleich | Golden je neuem Feld |
| G2 | Phasen ändern nie Ereignisse, `status`, Start-/Ende-Nachrichten | Beobachter ohne Rückkanal, kein Import aus `detector/` | Runtime-Verlauf mit/ohne Phasen identisch |
| G3 | Schlussphase nur mit 0 Frühmeldungen im Nachspielen inkl. TrailerFilter, Gegenprobe, Robustheit | B.6, D.3 | Echtdaten-Fixture; Trockner ohne Kandidat |
| G4 | Nach einem richtigen frühen Ende kein zweites „Fertig“, kein Phantomstart, auch nach Adapter-Neustart; ein neuer Lauf wird erkannt (Beispiel WM: ≤ 5 min nach dem Einschalten) | Sperrphase a–g, gelernte Ausgangsbedingungen (B.6), `settlingUntil` | I1–I5; 72 Szenarien [S6, S12]; Neustart 0–10 min |
| G5 | Nach einem falschen frühen Ende wird der Rest als neuer Lauf gemeldet (Start, Fertig zur Zeit des echten Endes), auch mit TrailerFilter; die Zerteilung wird im Nachhinein erkannt und die Schlussphase ausgesetzt, auch ohne Auto-Optimierung | Ausgänge d/f/g, Marke `afterFinal`, `finalSplit`, Aussetzen, TrailerFilter-Durchreichen | Y = 0,5/1,0 min: Rest 11/11 als neuer Lauf, Fertig zur Zeit ohne Schlussphase [S7]; `finalSplit` 11/11 (Abnahme); wiederholt mit Filter |
| G6 | Datenfehler ändern keine Werte; Grenzläufe nur in sichere Richtung; alles umkehrbar; Entscheidungen überstehen Import und Löschen | Stufen, Rangfolge, Verdict-Schlüssel, neu berechnete `envelope` | 8.4 |
| G7 | Seltene Programme werden nicht vergessen – weder durch Alter, Update noch Poll-/Einheitenwechsel | Grenzläufe mit Veto, ≥ 2 je Gruppe, `legacyEnvelope`, Umrechnen statt Verwerfen | 8.6 |
| G8 | Klasse erst bei Beleg, sonst Oberbegriff; Fehlbenennung nur wo die Daten nicht trennen, gemessen und angezeigt | zwei Ebenen, `decided`, Ereignisphasen, Gegenprobe ≥ 99 % | Phasentests WM, Kessel |
| G9 | Migration verlustfrei, gleiche Zeitpunkte, idempotent, ohne Instanz-Neustart, Override bei gleichem Hash erhalten, heute funktionierende Geräte bleiben aktiv | exakte 3.1.2-Zuordnung, heutige V4-Auflösung, Archiv inkl. Namen | 8.5 |
| G10 | Live = Nachspielen | dieselbe Fabrik, derselbe Tracker | `simulate` gegen Live-Pfad |
| G11 | Einheiten stimmen | `unitFactor`, Umrechnen bei Wechsel | kW-Fixture |
| G12 | Kein Detector-Wechsel im Lauf/in der Sperrphase | Neubau nur bei `!started && !settling` | Wertänderung während Lauf/Sperrphase |
| G13 | Keine verlorenen Änderungen | Compare-and-Set; Gerät vor Speicher; Laufzeit-Abgleich der Grundwerte | Optimierung bei gleichzeitiger User-Änderung; Grundwert ändern bei aktivem Override |
| G14 | Keine neuen Nachrichten ohne Zustimmung | Hinweise nur bei `optimizeNotify`, sonst Log/Info/Karte | Gerät mit `optimizeNotify = false`: 0 neue Nachrichten |
| G15 | Echte ungewöhnliche Programme werden verwendet | `test`/`foreign` nur mit absoluten bzw. Form-Merkmalen; Rangfolge | 41-min-Synthese → `rare`; Langheizen → `rare` |

---

## 7. States, UI, APIs, Doku

### 7.1 States (`stateDefinitions.ts`)
- **Neu mit `when: "phases"`** (nur bei `phases.enabled`, sonst gelöscht): `phase` (string, `text`), `phaseId` (string, `text`; Systemphasen `antiCrease`/`afterRun`), `phaseSince` (number, `date`), `phases` (string, `json`; Zeitleiste des laufenden/letzten Laufs, bei continuous 24 h, ≤ 200 Einträge).
- **Neu mit `when: "final"`** (P5; nur bei aktiver Schlussphase in Grundwerten **oder** Override): `settlingUntil` (number, `date`, nur lesbar): Ende der laufenden Sperrphase, sonst 0.
- **`when` verallgemeinert** (`deviceObjects.ts:41-47`): `learning` → immer; `historyHtml` → `inst.historyHtml`; `phases` → `cfg.phases?.enabled === true`; `final` → `finalOn(cfg.detection ⊕ override)` (auch eine nur von der Auto-Optimierung eingeschaltete Schlussphase). `ensureDeviceObjects` legt an oder löscht bei jeder Änderung der Gerätekonfiguration **und** wenn die Optimierung die Schlussphase ein- oder ausschaltet; Test schaltet ein und aus.
- **Schreibhäufigkeit der Phasen-States:** nur bei Segmentwechsel bzw. Lauf-Start/-Ende, nie je Tick.
- **Geändert:** Name `learning.reset` = „Auf die Grundwerte des Geräts zurücksetzen“; `learning.parameters` = `{base, override, effective, active}`; `learning.optimizeInfo` + Felder aus D.7.
- **Unverändert:** `status`, `running`, `finished`, `antiCrease`, `lastOperations` (Format bleibt) und alle übrigen.
- Jeder neue State: 11 Sprachen, Doku-Tabellen de/en (`docsStates.test.js:30`).

### 7.2 APIs, Ereignisse, Aktionen
- `DetectionSettings`: dreizehn `final*`-Felder.
- `Detector`: optionale Getter `settling`, `finalExit`.
- Runtime-Ereignisse: `start`, `end`, `abort`, neu nur `phase`. Ein Lauf nach einem frühen Ende erzeugt gewöhnliche `start`/`end`-Ereignisse; ein Ereignis `resume` gibt es nicht (Entscheidung des Users).
- `ActionEvent` (`config.ts:256`): neu `phaseStart`, `phaseEnd`; `DeviceAction.phaseId?` (leer = jede Phase).
- Laufaufnahme (`runRecorder.ts`): Marke `afterFinal` am ersten Start nach einer Sperrphase (aus `finalExit`).
- Nachrichten: keine neue Nachricht für Start oder Ende; Hinweise aus B.3/D.5 und „Schlussphase ausgesetzt/wieder aktiv“ nur bei `optimizeNotify`; Phasen-Meldungen mit User-Text und Nicht-Stören.
- sendTo und Blockly unverändert.

### 7.3 UI
- jsonConfig: Tab „Gerätetypen“ entfällt, Hinweistext.
- Device Manager: Geräteformular (C.4), Anlern-Dialog (B.7), Optimierungsdialog (D.7), Instanz-Aktion „Alte Vorlagen entfernen“, Karte/Details mit Erkennung, Phase und Warnungen.
- **Tabelle der Läufe:** `table` mit `noDelete: true` und Auswahlspalte (dm-utils `ConfigItemTable`, `common.d.ts:849-861`). Ob die Zellen in DM-Formularen bearbeitbar sind, prüft der User auf seinem System mit einem Testpaket (8.6; das Echtsystem wird vom Agent nur gelesen); bis dahin ist die Ausweichlösung Standard: `staticText`-Tabelle plus `select` mit `multiple: true` (`common.d.ts:556-557`). Beide Varianten werden gebaut.

### 7.4 i18n (11 Sprachen)
- Entfallen: `tabTypes`, `typesHelp`, `dev_typeId`, `dm_detailsType*`, `dm_learnName`, `dm_learnCurrentType`, `dm_optSaveType`, `dm_optTypeValue`, `typeNeedsName`, `unknownType`.
- Neu: Vorlage/Quelle, Erkennung, Expertenwerte, Felder der Schlussphase, Phasen und Systemphasen, alle Befunde mit Text, Verwendung, Grenzlauf, Warnung vor dem Ausschließen, „früher verworfen?“, neue Hinweise und Änderungstypen (`baseChanged`, `adopted`, `revert`, `finalOn`, Schlussphase ausgesetzt mit Grund „falsches frühes Ende erkannt“), Befund `finalSplit` und Aktion „war ein neuer Lauf“, Kartenwarnungen, „Altgrenzen verwerfen“, „auch Entscheidungen verwerfen“. **Nicht** mehr: Text „{Gerät} läuft noch – die Fertig-Meldung war zu früh“ und Aktions-Ereignis `resume` (entfallen, Entscheidung des Users).
- Umformuliert: neun Texte in `dmTexts.ts` mit „Gerätetyp“.

### 7.5 Doku
- **Zuerst die Spec:** §4.4, §6, §6.1, §6.2, Entscheidungen „Custom-Typen unbegrenzt“ und „Modus pro Typ, Gerät erbt“ (`:236-243`); neue Abschnitte Schlussphase, Phasen, Laufprüfung.
- `docs/de/README.md`, `docs/en/README.md`: §2/§3 Vorlagen und Werte im Gerät; neues Kapitel „Phasen“ (inkl. was nur rückwirkend erscheint); §8 Laufprüfung, Verwendung, Grenzläufe, Schlussphase, 30 Tage, `keepCurrentLevel`, Restrisiko „erstes Auftreten eines unbekannten Programms“ (eine zu frühe Fertig-Meldung, danach Start- und Fertig-Meldung für den Rest, anschließend Schlussphase ausgesetzt), Verhalten nach dem frühen Ende (alles danach ist ein neuer Lauf), Startverzögerung nach Ausräumen (Beispiel WM ≤ ~4 min); Hinweis, dass die Schlussphase nur angeboten wird, wo die Daten trennen und ein Nachlauf existiert; §9 Migration (exakte Namen, unbekannter Typ, V4-Teststände, Kopien bei geteilten Typen, Archiv inkl. Namen, **vor V5 verworfene Läufe können erneut zur Prüfung erscheinen**); §13 States, `settlingUntil`, `learning.parameters`, nach einem frühen Ende erkannter Lauf = eigener Eintrag in `lastOperations` mit eigenem `start`/`end`; §7 Aktionen `phaseStart`, `phaseEnd`.
- `docs/release-notes-4.0.0.md:69-79`, Changelog-Zeile `README.md:35`, neue Zeilen `- (Eistee82) …` unter `### **WORK IN PROGRESS**`.

---

## 8. Teststrategie

### 8.1 Fixtures aus Echtdaten
Format `[[relSec, wert]]`, je Lauf 30 min davor und 3 h danach, ggf. lauflängenkodiert (`ticks.ts:247`).
- `washer30d.json`: alle 12 WM-Läufe.
- `dryer.json`: 7 Läufe.
- `boiler3d.json` (besser 4 Tage 10.–13.11.): Kessel-Rohwerte.
- `v4store.json` (P10, P12): alter V4-Speicher mit `envelope` aus verdrängten Läufen und Läufen ohne `rev`.
- Defekte entstehen im Test-Helper.

### 8.2 Erkennungskette
- **Golden:** je `final*`-Feld „unchanged with all fields 0“ und „notices active“; ohne `phases.enabled` unverändert.
- **`finalPhase.test.js`:** Eigenschaftstest (200 Zufallskurven × Modi × Abbruch-Optionen, mit und ohne TrailerFilter) auf I1–I5; ganze WM-Aufzeichnung [S4]; 72 Szenarien mit Ausgang f: 72/72, Start ≤ 5 min [S12]; Ausgang f feuert auf der ganzen Aufzeichnung nie; zu kleines Y = 0,5/1,0 min: Rest 11/11 als neuer Lauf mit Marke `afterFinal`, Fertig zur Zeit des Endes ohne Schlussphase [S7]; **alle vier zusätzlich mit aktivem TrailerFilter und gelernten WM-Werten (P13)**; Regression 145 s ohne Wert [S8]; Z ohne neue Werte; jeder Ausgang a–g einzeln; Ausgang c aus bei `finalHotVal = 0`; Rückdatierung des Laufbeginns, nie vor das frühe Ende; Abbruch vor/nach frühem Ende; timed mit `feed`.
- **Gelernte Ausgangsbedingungen (geräteunabhängig):** synthetisches Gerät mit Hochlast im Nachlauf → `finalHotVal = 0`; Nachlauf mit Werten im Schlussband → kein Kandidat; zu aktiver Nachlauf → Ausgang f aus; Gerät ohne Nachlauf → Schlussphase nicht angeboten (Gewinn); Gerät, dessen Läufe nur ein Grundband berühren → kein `test` über Merkmal (3).
- **Synthetisches Einweich-Programm (P20):** Zwischenschleudern > Y nach X, dann 3 min 0 W bzw. 45 min Pause, dann Schleudern → Start mit `afterFinal`, Verdict `finalSplit`, Schlussphase ausgesetzt, Reparatur angestoßen; ein echter Neustart nach Ausräumen (aus [S6]) → **kein** `finalSplit`. **Beurteilung im Nachhinein auf [S7]:** 11/11 `finalSplit` (Abnahme); mit und ohne Auto-Optimierung ausgesetzt, Reparatur nur mit.
- **Runtime:** AutoOff nach Ausgang a/b/e, nicht nach c/d/f/g (dann erst nach dem Ende des neuen Laufs; Test mit `autoOffMinutes = 0`); Neubau wartet auf `!settling`; Lauf nach frühem Ende = gewöhnlicher Lauf (`startText`, Start-Aktionen, `runtime` ab neuem Beginn, eigener `lastOperations`-Eintrag, eigenes `end`; kein `resume`); Aussetzen als Maske (`p0`, Override und Übernehmen unberührt, P19); Neustart 0–10 min nach frühem Ende → 0 Phantomstarts (P5).
- **Prüfkriterium (`replay.test.js`):** 03.11. ok, 12/12 Frühmeldungen erkannt [S3]; ohne Nachlauf-Daten identisch mit heute; Trockner nach `trailerOf`-Korrektur identisch mit heutigem `runOk` (P6).

### 8.3 Phasen
- `phaseTracker.test.js`: Detector-Ausgaben bitgleich mit/ohne Tracker; Oberbegriff, ab 2,8 min „Endschleudern“, „Zwischenschleudern“ nur in der Zeitleiste; Kessel: Zündung live ≤ 10 s nach Spitze in ≥ 90 % der in den Brenner übergehenden Spitzen, die 7 anderen nicht als Zündung (P3); Anlauf/Nachlauf über Vorgänger; gehaltene Werte, Lückenregel, Neustart, Kontext-Reset; Live über Rohwert = Nachspielen.
- `phaseLearn.test.js`: Bänder stabil in der Gegenprobe; WM-Grenze ≈ 1311 W; Kessel-Spitzenband bleibt erhalten (P3); Kessel lernt aus 4 Tagen ohne Eingriff (P2); Klasse < 3 Läufe vereint; Neulernen behält ids und Namen; Gegenprobe ≥ 99 %.

### 8.4 Laufprüfung und Unverwertbares
- **`quality.test.js`:** je Befund positiver und negativer Fall, insbesondere `sparse` für 06.11. 13:37; `trailerCut` für 03.11. und 06.11. 14:49, **nicht** für 12.11. (P8); `rare` für #1, #5, #6, 03.11. 09:57, 08.11. 12:28 (verwendet, kein `foreign`, P7); synthetisches dichtes 41-min-Programm → `rare` (P1); drei gleiche saubere Kurzläufe → eigene Gruppe; `historyCfg`; beweisbare Lücke über Relog; hängender Wert mit wiederholten Meldungen → `stuck`, lange Haltezeit ohne Meldungen → kein `stuck` (P2); Kessel 52 min bei 254 W → kein Befund; Zeitsprung; `formerlyDropped`.
- **`learnRobustness.test.js`, `optimizeOutliers.test.js`:** Eingeschleust: Fremdlast +150 W über 20 min; Logger-Lücke 20 min bei 250 W (→ `gap` unbeweisbar über das Haltezeit-Profil, Y unverändert, P28); Abbruch nach 112 min; 50 Störspitzen 3000/400 W; Einheit kW; Handtest 3 min 2000 W bzw. 5 min 300 W; Nachlauf nach 2 min beendet (WM: Ausräumen im Knitterschutz); zwei Geräte gleichzeitig still; drei gleichartige Handtests (keine Gruppe, da Form-Quarantäne); zwei Läufe zusammengewachsen.
  
  Erwartung: richtiger Befund; Vorschläge, Schlussphase, optimierte Werte unverändert (±5 %); 0 Frühmeldungen auf echten Läufen; Ausschließen/wieder Verwenden stellt `envelope` und Werte exakt her; sauberer Grenzlauf repariert sofort, Form-Quarantäne erst nach Aufnahme; `sparse` blockiert die Verschärfung nicht und erzeugt keinen „verwenden“-Hinweis (P22); Hinweis genau einmal und als Nachricht nur bei `optimizeNotify` (P14).
- **Entscheidungen (P26):** löschen → neu starten → Bootstrap aus History → ausgeschlossener Lauf bleibt draußen.

### 8.5 Migration und Konfiguration
- **3.1.2:** `default.ids`/`custom.ids`, gleicher Name in beiden (default gewinnt), doppelter Name (letzter gewinnt), nur ohne Groß-/Kleinschreibung, unbekannter Typ, Archiv inkl. umbenanntem ungenutztem Typ mit Standardwerten (P17); Golden alt gegen neu.
- **V4 → V5:** Struktur-Erkennung auch bei `configVersion` 5; Typauflösung wie heute in allen Fällen aus C.6 (P11); Override bei gleichem Hash erhalten, bei veraltetem verworfen; keine Schreibzugriffe auf die Instanz-native; doppelt = einmal; Abbruch mittendrin.
- **Alter Speicher (P10, P12):** `v4store.json` → `legacyEnvelope` gesetzt, keine Verschärfung unter die alte Untergrenze; alte Läufe neu zerlegt, Familien-ids stabil, kein `NaN`-Abstand.
- **Laufzeit-Abgleich (P9):** Grundwert ändern bei aktivem Override → Override verworfen, Eintrag `baseChanged`, neue Werte wirken sofort; „Als Grundwerte übernehmen“ → Eintrag `adopted`, Verhalten unverändert; Schreiben des Geräts scheitert → Override bleibt (P29).
- Vorlage mit kW-State: Werte / 1000.
- Bestehende Tests mit Typ-Bezug werden angepasst: `config`, `migration`, `autoOptimize`, `deviceManagement`, `optimizationIntegration`, `deviceForm`, `deviceSync`, `deviceRegistry`, `deviceRuntime`, `actions`, `legacyDetector`, `commands`, `deviceObjects`, `docsStates`, `stateDefinitions`.

### 8.6 Optimierung und Bedienung
- **`optimizationIntegration`:** 30-Tage-Fenster; Grenzlauf älter als 30 Tage bleibt und verhindert Verschärfung über seine Grenze; Veto-Lauf bleibt; je Gruppe ≥ 2 trotz Alter; zwei gleich extreme Läufe → einer bleibt (P23); Dämpfung wie heute inkl. Sperre; Budget mit Fortschritt reihum, `budget`-Status, Warnung ab 3 (P24); Compare-and-Set; `final*` werden von Analyse-Kandidaten nie verändert, `stepLimit` mit eigenen Grenzen, kein stilles Abschalten (P18); Aussetzen und Wiedereinschalten; Mindestzahlen (Frage 4): 7 zugelassene Läufe → keine Verschärfung, 8 → Verschärfung möglich, Reparatur schon beim 1. Lauf; Reparatur-Vorrang: Pause eine Abfrage länger als die Ende-Wartezeit → sofort längere Wartezeit trotz Sperre, Mindestzahl und Schrittgrenze, alle gespeicherten Läufe weiter richtig; Quarantäne-Lauf mit demselben Fehler → keine Reparatur; keine Abdeckung möglich → bisherige Werte, `cannotCover`, Warnung; Schlussphase automatisch an bei 10 zugelassenen Läufen mit ≥ 2 je betroffener Gruppe, nicht bei 9 oder mit nur 1 Lauf in einer Gruppe; Eintrag `finalOn` mit Undo (Frage 3); Ausschließen eines Grenzlaufs nimmt seine Reparatur zurück, Undo bietet Ausschließen an, Undo nur bis zur letzten Basisänderung und mit Gate (P25); Poll- und Einheitenwechsel rechnen um, Grenzen bleiben (P27); Phasen-Hysterese.
- **Raspberry Pi 4:** Messung der Jobdauern (Abnahme D.3); Installation durch den User, der Agent liest `optimizeInfo.jobMs` nur.
- **Echtsystem** (Schritt für den User, Agent nur lesend über `mcp__iobroker__*`): Auswahlspalte einer Tabelle im DM-Formular bearbeitbar? Bis zur Rückmeldung Ausweichlösung als Standard.
- **Verschmolzene Läufe (Entscheidung 9):** zwei echte Läufe, die der Detector zu einem verschmilzt → keine Reparatur, kein Hinweis, Ende des Gesamtlaufs erkannt; zwei Läufe kurz hintereinander in einer Aufnahme → zwei gespeicherte Läufe, keine Änderung.

---

## 9. Risiken

1. **Erstes Auftreten eines unbekannten Programms**, dessen Zwischenblock im Schlussband länger als Y dauert (Beispiel WM: langes Zwischenschleudern), kann einmal zu früh gemeldet werden. Begrenzt durch Opt-in, ≥ 5 Läufe, Trennverhältnis, Pmax, X, Gegenprobe, Robustheit; danach durch `finalSplit` und Aussetzen. Steht in der Doku.
2. **Echte Frühmeldung führt zu Start und zweitem „Fertig“ (neu, Folge der Entscheidung gegen die Wiederaufnahme):** Tritt Risiko 1 ein, bekommt der User eine zu frühe Fertig-Meldung, danach eine Start-Meldung und zur Zeit des echten Endes eine zweite Fertig-Meldung für den Rest; Ende-Aktionen und Erinnerungen laufen für beide Teile, `lastOperations` enthält zwei Einträge, ein AutoOff nach dem frühen Ende schaltet nicht ab (A.3). Es gibt keine Korrektur-Nachricht. Selten (nur ungelerntes Programm bei aktiver Schlussphase); danach ist die Schlussphase ausgesetzt, auch ohne Auto-Optimierung. Kommt im Rest noch einmal ein frühes Ende vor, bevor das Aussetzen greift (Maske erst beim nächsten Detector-Neubau, G12), kann es einmalig eine weitere Meldung geben. Steht in der Doku.
3. **Neustart direkt nach dem Ausräumen** (Beispiel WM: Kaltwäsche): Start 0,8–3,7 min nach dem Einschalten statt sofort [S12]; das Ende stimmt. 3.1.2 verschmilzt hier in 12 von 36 Fällen beide Läufe zu einem. Ist Ausgang f mangels Trennung aus (B.6), gilt die alte Verzögerung bis zum nächsten Schlussband- oder Hochlast-Block bzw. bis `finalLockSec`; der Dialog nennt das.
4. **`finalSplit` gegen echten Schnell-Neustart:** Ein direkt nachgestartetes Programm, das nicht mit der gerätetypischen Anfangsfolge beginnt (WM „Nur Schleudern“, Trockner noch einmal starten, weil die Wäsche nicht trocken ist), wird im Nachhinein als Zerteilung gewertet. Die Meldungen sind dabei richtig (zwei Läufe); Folge ist nur ein unnötiges Aussetzen mit Hinweis. Der User kann im Dialog „war ein neuer Lauf“ bestätigen (D.7).
5. **Unbeweisbare Lücken in den ersten 3 Läufen** werden nicht erkannt (kein Haltezeit-Profil). Die Verdicts werden neu berechnet, sobald das Profil existiert; die Schlussphase braucht ohnehin ≥ 5 Läufe.
6. **Rechenbudget auf schwacher Hardware:** reihum mit gespeichertem Fortschritt, Gegenproben höchstens täglich; sichtbar über `budget`. Abnahme auf dem Pi.
7. **dm-utils-Tabellen** in Formularen ungeprüft (Echtsystem-Test, Ausweichlösung).
8. **Änderung an `buildLayout`** verschiebt Kernenden; abgesichert durch Fixtures und `LAYOUT_REV`-Neuzerlegung.
9. **Umfang:** ~100 Testbezüge, 11 Sprachen, Spec und Doku de/en; Spec zuerst.
10. **Datenbasis der Schlussphase:** belegt nur an einem Gerät (WM, 11 nutzbare Läufe); für andere Gerätearten gibt es keine Echtdaten-Belege, nur die allgemeinen Lernregeln, gelernten Ausgangsbedingungen und Freigabebedingungen (B.6). Deshalb Opt-in, Freigabe nur mit Nachweis am eigenen Gerät, Beurteilung im Nachhinein.
11. **Feldnamen der History-Einstellungen** je Adapter verschieden; fehlen sie, fehlen nur `historyCfg` und der Relog-Beweis.
12. **Kessel-Zündung:** Die Ereignisphase ist aus [S13] abgeleitet, aber nicht als Tracker nachgerechnet; besteht sie die Gegenprobe nicht, erscheint die Zündung nur rückwirkend (B.5 Schritt 7).
13. **Laufspeicher ohne Auto-Optimierung:** Bei aktiver Schlussphase wird er immer geführt (A.3), also auch bei Geräten ohne Auto-Optimierung eine Datei je Gerät; Größe wie D.2.

---

## 10. Offene Fragen an den User

Keine. Alle Fragen sind vom User entschieden (14.11.2026, mit Freigabe des Konzepts); der Plan setzt die Entscheidungen um.

**Entschieden (nicht mehr offen)**
- *Vormals Frage 1 „Gerät, dessen Typ bei der Migration aus 3.1.2 nicht exakt gefunden wird“* (3.1.2 meldete es einmal als gestartet und nie als fertig) – entschieden wie vorgeschlagen: vollständig übernehmen, aber deaktiviert (`enabled = false`, `needsReview`), mit Hinweis in Log und auf der Gerätekarte; Werte eines Typs, der nur ohne Groß-/Kleinschreibung passt, sonst der umbenannten `customN`-Zeile, sonst „Benutzerdefiniert“ (C.5).
- *Vormals Frage 2 „AutoOff bei früher Fertig-Meldung“* – entschieden wie vorgeschlagen: Der Zähler startet erst, wenn die Sperrphase über einen Ruhe- oder Ende-Ausgang endet (a, b, e); endet sie über einen Aktivitäts-Ausgang (c, d, f, g), folgt AutoOff dem Ende des neuen Laufs (A.3). Ohne Schlussphase wie heute ab `finished`.
- *Vormals Frage 3 „Darf die Auto-Optimierung die Schlussphase selbst einschalten?“* – **entschieden vom User abweichend vom Vorschlag:** Die Auto-Optimierung optimiert automatisch, ohne Bestätigungsklick; auch die Schlussphase darf sie selbst einschalten, nachjustieren und aussetzen. Voraussetzung: Sie betrachtet nicht nur den letzten Lauf, sondern viele Läufe über einen langen Zeitraum (30-Tage-Fenster plus die dauerhaft gespeicherten Grenzläufe) und wählt nur Einstellungen, die auf **allen** zugelassenen Läufen sicher funktionieren, einschließlich Gegenprobe ohne jeden Lauf bzw. jede Programmgruppe und gestörter Eingangsdaten. Jede Änderung wird wie bisher gemeldet (`optimizeNotify`), ist sichtbar und rückgängig machbar (D.5).
- *Vormals Frage 4 „Tempo der Verschärfung“* – **entschieden vom User:** Mindestzahl an Läufen, bevor die Auto-Optimierung einen Wert verschärfen darf, deutlich über den 2 Läufen beim manuellen Anlernen. Umsetzung als dokumentierte Konstanten: Verschärfung erst ab 8 zugelassenen Läufen im Fenster (`TIGHTEN_MIN_RUNS` 4 → 8); Schlussphase einschalten erst ab 10 zugelassenen Läufen und mindestens 2 Läufen je betroffener Programmgruppe (`FINAL_ENABLE_MIN_RUNS = 10`, `FINAL_ENABLE_MIN_PER_GROUP = 2`); Annäherung ans Optimum nur in kleinen Schritten (höchstens 25 % je Schritt, Schwellwerte 30 %, wie heute); Abstand zwischen Verschärfungen weiter 2 neue Läufe und 24 h; Sperre nach Reparatur, Undo oder Reset weiter 5 Läufe bzw. 14 Tage. Reparaturen (sichere Richtung) bleiben sofort und ohne Mindestzahl (D.3).
- *Vormals „Was passiert bei einer erkannten Frühmeldung?“* – entschieden vom User: keine Wiederaufnahme, keine Nachricht „läuft noch“, kein Ereignis `resume`, keine doppelten Ende-Aktionen für denselben Lauf. Alles nach einem frühen Ende ist ein neuer Lauf; Beurteilung nur im Nachhinein (A.3, B.2 `finalSplit`).
- *Geräteunabhängigkeit* – entschieden vom User: keine Regel mit gerätespezifischer Annahme; gerätespezifisches Wissen nur als gelernte Bedingung (B.6).
- *Einstellungen aus 3.1.2* – Vorgabe des Users: jede globale und jede Geräteeinstellung von 3.1.2 landet an der richtigen Stelle in V4, auch nach dem Wegfall der Gerätetypen; Zuordnung und Befunde in C.5, abgesichert je Zeile durch Tests.
- *Verschmolzene Läufe / Reparatur nur über kürzere Ende-Wartezeit* (Entscheidung 9 des Plans) – entschieden vom User, wörtlich: „zwei läufe als einen erkennen ist nicht schlimm denn dann läuft das gerät ja durchgehend. wichtig ist nur das dann auch das ende erkannt wird wenn es ein richtiges ende gibt“. Umsetzung: Zwei echte Läufe, die der Detector zu **einem** Lauf verschmilzt, sind **kein** Erkennungsfehler – keine Sofort-Reparatur, keine Verkürzung der Ende-Wartezeit deswegen, kein Warnhinweis (höchstens ein Info-Eintrag im Optimierungs-Verlauf). Pflicht ist nur, dass das echte Ende des verschmolzenen Laufs erkannt wird: Die Ende-Prüfung des Gates gilt für den Gesamtlauf; wird sie verfehlt, ist das „Ende nicht erkannt“ bzw. „Ende zu früh“ und wird wie beschlossen sofort repariert. Kürzere Wartezeiten entstehen ausschließlich über die normale vorsichtige Verschärfung (ab 8 Läufen, Schrittgrenzen). Alle anderen Sofort-Reparaturen (Ende zu früh, Start verpasst, Lauf zerteilt, Ende nicht erkannt, Phantomstart, Schlussphase zerteilt) bleiben (D.3 Punkt 3). Befund `merged` (B.2) ist deshalb eingeschränkt statt Quarantäne und nur für das Gesamtende verwendet.

---

## 11. Was dem Umsetzer überlassen bleibt

Namen, Dateiaufteilung, interne Datenstrukturen (Ringpuffer, Histogramm, Talsuche); wie `settling`/`finalExit` durch den TrailerFilter gereicht werden (solange I1–I5 und G10 gelten); Algorithmus von `trailerOf` beim Trockner (Abnahme B.4 Punkt 2); Tabelle oder Ausweichlösung nach dem Echtsystem-Test; Kodierung der Fixtures; wie `typeId` bei der Migration entfernt wird; JSON-Feldnamen im Speicher (z. B. `baseHash` mit Rückfall auf `typeHash`); Feinheiten der Budget-Staffelung; genaue Texte (de/en vorgegeben, Rest per `npm run translate`); Reihenfolge der Arbeitsschritte nach Abhängigkeiten (Spec → Werte im Gerät und Migration → Grundbänder, Laufprüfung, Kriterium, `buildLayout` → Schlussphase → Phasen → Optimierung). Der Plan umfasst den vollständigen Umfang.

---

## Anhang A: Aus der Vorfassung übernommene Korrekturen der Konzeptbewertungen

| Befund | Behoben in |
|---|---|
| Prüfkriterium wertet 03.11. als zu früh | B.4 `endOk` [S3] |
| Schatten verliert beim Ausräumen + Neustart den zweiten Lauf | A.3 Sperrphase |
| Neustart-Beweis „≥ startVal am Stück“ meldet bei Kaltwäsche Verletzung | A.3 Ruhe-, Hochlast-, Spät-, Aktivitäts-Ausgang (die „Verletzung“ selbst ist inzwischen Ausgang g, Entscheidung des Users) |
| AutoOff im Nachlauf (Knitterschutz) | A.3 Kopplung an `settling` und den Ausgang |
| Pmax 844 W zu nah am Schleudern | 1311 W |
| „nie falsch benannt“ unhaltbar | `decided: "end"`, G8 |
| Quarantäne blockiert echte neue Programme | B.3 Grenzläufe wirken sofort |
| Phasen nach jedem Lauf neu lernen | D.6 Feinjustierung + Hysterese |
| `native.types` leeren verliert Typen | Archiv |
| Hash-Regel ändert bestehende Hashes | `name=wert` nur bei ≠ 0 |
| Speicher v2 braucht Dateimigration | v1 + Felder |
| `keepCurrentLevel` für eigene Typen | C.2 |
| `when` fest verdrahtet | 7.1 |
| `configVersion` taugt nicht zur Erkennung | C.6 Struktur |
| `afterRun` zerstört Sperrphase | Neubau nur bei `!started && !settling` |
| `sparse` erzwingt Reparatur | B.2 Quarantäne + P22 |

## Anhang B: Prüfbefunde dieser Runde und ihre Behebung

| # | Schwere | Befund (kurz) | Behoben in |
|---|---|---|---|
| P1 | hoch | log-z < −3,5 macht jedes echte WM-Kurzprogramm zu `test` | B.2 `test` nur absolute/Form-Merkmale, log-z nur innerhalb der Gruppe, Rangfolge; G15 |
| P2 | hoch | Lückenregel vor dem Lernen schließt 3 von 4 Kessel-Tagen aus | B.1a, B.2 `gap`/`stuck`: vor dem Profil nur Beweisbares; continuous nur Segment; Z1-Abnahme |
| P3 | hoch | Zündung weder lern- noch live erkennbar | B.5 Band-Zulassung über Ereignisse/aktive Zeit, Glättung `peak`, Ereignisphase mit Bestätigung [S13]; ehrlicher Rückfall |
| P4 | mittel | Kaltwäsche nach Ausräumen startet 35–141 min zu spät; `finalRestSec`-Formel ergibt 135 s | A.3 Ausgang f + Rückdatierung [S12: 72/72, 0,8–3,7 min]; B.6 Formel unter `finalRestVal`; Risiko 3 |
| P5 | mittel | Neustart in der Sperrphase → Phantomstart + zweites Fertig | A.3 `settlingUntil`, Start in `lock`; 7.1; G4 |
| P6 | mittel | `tailCeil` beim Trockner akzeptiert Fertig im Abkühlen | B.4 Trennbedingung 0,8 ×; Abnahme `tr.json` |
| P7 | mittel | `foreign` (Blocklänge) stuft Langheizen ein, Widerspruch zu `rare` | B.2 `foreign` nur Pegel/außerhalb der Bänder; Rangfolge |
| P8 | niedrig | `trailerCut` erkennt 12.11. nicht | Abschnitt 3 korrigiert (12.11. normal); Regel über Median − max(5 min, 4·MADn) |
| P9 | hoch | Grundwertänderung zur Laufzeit ohne Speicherabgleich | C.3 `reconcileBase` |
| P10 | hoch | neu berechnete `envelope` verliert Extreme verdrängter V4-Läufe | C.7 `legacyEnvelope` |
| P11 | mittel | V4-Migration löst Typ anders auf als heute | C.6 `resolveLegacyTypes` + `findType` |
| P12 | mittel | alte Läufe ohne neue Merkmale → `NaN`, Einzelgruppen, kein `progEnd` | B.4 Punkt 5 `LAYOUT_REV`, Neuzerlegung, Rückfälle |
| P13 | mittel | TrailerFilter hält nach frühem Ende Schleuderblöcke zurück | A.3 Durchreichen während `settling`; Tests mit Filter |
| P14 | mittel | Hinweis/Vorschlag als Nachricht ohne `optimizeNotify` | B.3 Zustellregel, D.5, 7.2, G14 |
| P15 | niedrig | Semantik von `resume` unklar | **entfallen durch Entscheidung des Users:** keine Wiederaufnahme; der Rest ist ein neuer Lauf, Beurteilung im Nachhinein (A.3); vormalige Frage „Frühmeldung“ entschieden (Abschnitt 10) |
| P16 | niedrig | in V4 verworfene Läufe kommen zurück | B.2 `formerlyDropped`, Doku §9 |
| P17 | niedrig | umbenannter ungenutzter Typ mit Standardwerten geht verloren | C.2, C.5 Archiv auch bei Namensabweichung |
| P18 | hoch | Analyse-Kandidaten ohne `final*` → `stepLimit` senkt 25 %, stilles Abschalten | D.5 eigener Pfad, eigene Schrittgrenzen, nur ausdrückliches Aussetzen |
| P19 | hoch | Aussetzen als Teil von `effective` landet im Gerät/Override | C.3 drei Ebenen, Maske nur in `active` |
| P20 | hoch | unbekanntes Programm wird zerteilt, `merged` → Quarantäne, kein Aussetzen | A.3 Marke `afterFinal`, B.2 `finalSplit`, D.3/D.5 |
| P21 | hoch | wie P1 (Kurzprogramme dauerhaft Quarantäne) | wie P1 |
| P22 | hoch | `sparse` blockiert Verschärfung bzw. Hinweis erzwingt Reparatur | D.3 Gate nur über zugelassene Läufe; B.3 Hinweis nach Grundart |
| P23 | hoch | Verdrängung nach Alter vergisst seltene Programme | D.2 ≥ 2 je Gruppe, Veto-Grenzläufe, schrittweise |
| P24 | hoch | Budget auf dem Pi, hintere Schritte kommen nie dran | D.3 aktive Rechenzeit, reihum mit Fortschritt, Status/Warnung, Pi-Abnahme |
| P25 | mittel | Ausschließen und Rückgängig unverbunden | D.7 Kopplung, Undo nur bis Basisänderung mit Gate |
| P26 | mittel | „Lerndaten löschen“ verliert Entscheidungen | B.3, D.7 |
| P27 | mittel | Poll-/Einheitenwechsel verwirft Läufe samt Grenzen | C.7 Umrechnen |
| P28 | mittel | `holdMaxSec` nur mit Phasen, p99,9 instabil | B.1a Haltezeit-Profil immer, max(10 min, 5 × p99) |
| P29 | niedrig | Schreibreihenfolge bei „Als Grundwerte übernehmen“ | C.7 Gerät zuerst |
| P30 | niedrig | Frage 5 schon umgesetzt, Sperre nicht erwähnt | Frage umformuliert (später Frage 4, inzwischen entschieden, Abschnitt 10) |

## Anhang C: Geprüfte Einwände (nur teilweise übernommen)

- **P23, „Grenzlauf über eine volle Gate-Prüfung je Lauf bestimmen“:** nicht als eigener Rechenschritt übernommen. Für jeden Lauf alle Kandidaten ohne ihn zu prüfen, vervielfacht die Rechenzeit (P24). Stattdessen entsteht das Veto als Nebenprodukt der ohnehin laufenden Kandidatenprüfung; zusammen mit „≥ 2 je Gruppe“ und schrittweiser Verdrängung deckt das die genannten Fälle ab.
- **P14, „eigene Option für Hinweise trotz ausgeschalteter `optimizeNotify`“:** nicht übernommen. Wer Hinweise als Nachricht will, schaltet `optimizeNotify` ein; eine zweite Option mit fast gleicher Bedeutung macht das Formular unübersichtlicher. Sichtbarkeit ist über Log, `optimizeInfo` und Gerätekarte immer gegeben.
- **P8:** Von den beiden vorgeschlagenen Wegen wurde die Korrektur der Aussage gewählt (12.11. ist normal), ergänzt um eine streuungsbezogene Regel. Eine Grenze „Median − 3 min“ würde normale Streuung (52 gegen 56 min) als Befund werten; der Schaden eines nicht erkannten leicht verkürzten Nachlaufs ist gering, weil Nachlaufdauern über Maxima in die sichere Richtung wirken.
- **P16, „History-Läufe im Zeitraum des alten Speichers markieren“:** nur als Hinweis übernommen, nicht als Quarantäne. Ein V4-Speicher unterscheidet nicht zwischen verworfenen und wegen Platz verdrängten Läufen; eine Quarantäne träfe auch normale Läufe.
- **P3, Alternative „Zündung nur rückwirkend“:** nicht als Ziel, nur als Rückfall übernommen. Die Daten zeigen, dass 79 von 86 Spitzen binnen Sekunden in den Brenner übergehen [S13]; das reicht für eine live benennbare Ereignisphase.

Kein Befund wurde vollständig verworfen. P15 ist nicht verworfen, sondern durch die spätere Entscheidung des Users gegen die Wiederaufnahme gegenstandslos.
