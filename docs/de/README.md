![Logo](../../admin/device-reminder.png)

# device-reminder

Dokumentation des device-reminder-Adapters (Version 4). [English version](../en/README.md)

## Inhalt

1. [Überblick](#1-überblick)
2. [Einrichtung](#2-einrichtung)
3. [Erkennungswerte und Vorlagen](#3-erkennungswerte-und-vorlagen)
4. [Geräte anlegen](#4-geräte-anlegen)
5. [Empfänger](#5-empfänger)
6. [Erinnerungen und Quittierung](#6-erinnerungen-und-quittierung)
7. [Aktionen](#7-aktionen)
8. [Anlernen](#8-anlernen)
9. [Migration von 3.1.2](#9-migration-von-312)
10. [Blockly](#10-blockly)
11. [sendTo-API](#11-sendto-api)
12. [vis-2-Widgets](#12-vis-2-widgets)
13. [State-Referenz](#13-state-referenz)
14. [FAQ](#14-faq)

## 1. Überblick

Der Adapter beobachtet den Stromverbrauch einer Steckdose oder eines Leistungsmessers und erkennt, wann ein Haushaltsgerät (Waschmaschine, Trockner, Geschirrspüler oder ein eigenes Gerät) startet und fertig ist. Danach sendet er eine Nachricht an einen oder mehrere Empfänger (12 Messenger-Arten inklusive Sprachausgabe), wiederholt die Fertig-Meldung auf Wunsch bis zur Quittierung, setzt weitere States und kann die Steckdose automatisch ausschalten.

Voraussetzungen: Node.js 22 oder neuer, js-controller 6.0.11 oder neuer, Admin 7.8.20 oder neuer.

Alles wird in den Instanz-Einstellungen konfiguriert. Geräte verwaltest du im Device Manager, der im Reiter **Geräte** eingebettet ist. Jedes Gerät ist ein ioBroker-Geräteobjekt mit eigenen States (siehe [State-Referenz](#13-state-referenz)). Die Geräte laufen unabhängig voneinander: Ein Fehler in einem Gerät stoppt die anderen nicht.

## 2. Einrichtung

1. Adapter installieren und eine Instanz anlegen.
2. Instanz-Einstellungen öffnen. Die Reiter sind:
   - **Geräte**: der Device Manager (siehe [Geräte anlegen](#4-geräte-anlegen)).
   - Im Reiter **Geräte** steht außerdem ein Hinweis: Die Erkennungswerte stehen in jedem Gerät (siehe [Erkennungswerte und Vorlagen](#3-erkennungswerte-und-vorlagen)); einen Reiter mit Gerätetypen gibt es nicht mehr.
   - **Empfänger**: wer Nachrichten erhält (siehe [Empfänger](#5-empfänger)).
   - **Allgemein**: Statustexte, Abfrageintervall und die optionale HTML-Historie.
3. Mindestens einen Empfänger anlegen, dann im Device Manager ein Gerät hinzufügen und den Empfänger im Formular auswählen.

Allgemeine Einstellungen:

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Statustexte | in action / standby / switched off | Text, der in den State `status` jedes Geräts geschrieben wird |
| Abfrageintervall | 10 s | Wie oft die Erkennung den letzten Leistungswert auswertet |
| Historie als HTML | aus | Schreibt zusätzlich `lastOperationsHtml` (HTML-Tabelle der letzten Läufe) |

## 3. Erkennungswerte und Vorlagen

Jedes Gerät hat seine eigenen Erkennungswerte: Schwellwerte, Erkennungsmodus, Pausenschutz und Nachlauf-Filter. Sie stehen im Gerät, nicht mehr in einem Gerätetyp, den sich mehrere Geräte teilen. Ändern sich die Werte eines Geräts, gilt das nur für dieses Gerät.

Beim Anlegen wählst du, woher die ersten Werte kommen (erster Schritt von **Gerät hinzufügen**, Feld **Werte des neuen Geräts**):

- eine **Vorlage**: **Waschmaschine**, **Trockner** und **Geschirrspüler** mit den Werten von 3.1.2 und **Benutzerdefiniert** (30 / 5 / 1 / 1 / 20) für jedes andere Gerät,
- eine **alte Vorlage**: ein Gerätetyp einer früheren Version, dessen Werte oder Name von der Vorlage abweichen (auch angelernte Typen von Testversionen ohne Gerät),
- **ein anderes Gerät**: Übernommen werden nur die Start- und Ende-Werte sowie Pausenschutz und Nachlauf-Filter. Schlussphase und Phasen werden **nicht** kopiert, sondern am neuen Gerät angelernt, denn sie gelten nur mit Nachweis aus den eigenen Läufen (ein Hinweis im Formular sagt das).

Misst der Leistungs-State in kW, werden die Leistungswerte umgerechnet (eine Vorlage wird durch 1000 geteilt; zwischen einem W- und einem kW-State wird ebenfalls umgerechnet). Danach passt du die Werte im Geräteformular oder durch [Anlernen](#8-anlernen) an das eigene Gerät an; beides schreibt die Werte direkt ins Gerät, ohne Neustart der Instanz.

Im Geräteformular stehen die Werte im Bereich **Erkennung** (Modus, Start-, Ende- und Standby-Wert, Anzahlen und Dauern) und eingeklappt unter **Expertenwerte** (Pausenschutz, Nachlauf-Filter unter **Nachlauf** und die 13 Werte der Schlussphase; die Felder der Schlussphase erscheinen erst, wenn Untergrenze und Zeit im Band gesetzt sind). Werte außerhalb des Bereichs oder mit Widerspruch werden beim Speichern korrigiert und gemeldet.

Die Gerätekarte zeigt als Modell, woher die Werte kommen: den Namen der Vorlage, **angelernt** (durch Anlernen oder aus der automatischen Optimierung gespeicherte Werte, oder eine Optimierung ändert sie gerade) oder **eigene Werte**.

Die Instanz-Aktion **Alte Vorlagen entfernen** im Device Manager löscht nach einer Bestätigung das Archiv der alten Gerätetypen (die Instanz startet neu); die Geräte bleiben unverändert.

Ein Gerät ohne gültige Erkennungswerte (zum Beispiel, weil sein Gerätetyp nicht mehr existiert) bekommt die Werte von **Benutzerdefiniert** und wird **deaktiviert**: Es lief vorher nicht und soll nicht plötzlich Nachrichten senden. Die Gerätekarte und das Log nennen den Grund. Prüfe das Gerät, speichere es im Geräteformular und aktiviere es wieder.

| Schwellwert | Bedeutung |
| --- | --- |
| Startwert (W) | Leistung ab diesem Wert gilt als „läuft“ |
| Endwert (W) | Leistung unter diesem Wert gilt als „Lauf endet“ |
| Standby-Wert (W) | Leistung unter diesem Wert gilt als „aus“, darüber als „Standby“ |
| Start-/Endanzahl | Anzahl aufeinanderfolgender Abfragen (Modus Anzahl) |
| Start-/Enddauer (s) | Mindestdauer über dem Start- bzw. unter dem Endwert (Modus Zeit und Kombiniert) |
| Pause-Haltezeit (s) | Pausenschutz: so lange muss eine Pause unter dem Endwert dauern, bevor sie als Ende zählt (0 = aus) |
| Pause, wenn sie beginnt vor (s) | Pausenschutz: eine Phase unter dem Endwert, die so früh nach dem Start beginnt, ist eine Pause (0 = nicht verwendet) |
| Pause, wenn Leistung unter (W) | Pausenschutz: eine Phase unter dem Endwert, deren Leistung unter diesem Wert bleibt, ist eine Pause (0 = nicht verwendet) |
| Nachlauf: max. Stoß / min. Pause / erst nach / min. Blockleistung / max. Dauer | [Nachlauf-Filter](#nachlauf) (max. Stoß 0 = aus) |
| Schlussphase (13 Werte, Expertenwerte) | [frühes Fertig nach der letzten Programmphase](#schlussphase) (Untergrenze oder Zeit im Band 0 = aus) |

### Erkennungsmodi

- **Anzahl** (Standard, identisch zu 3.1.2): Der Start wird erkannt, wenn der Mittelwert über die eingestellte Anzahl von Abfragen über dem Startwert liegt, das Ende nach der eingestellten Anzahl von Abfragen unter dem Endwert. Dieser Modus braucht eine Steckdose, die regelmäßig sendet.
- **Zeit**: Das Gerät startet, wenn die Leistung die Startdauer lang auf oder über dem Startwert bleibt, und ist fertig, wenn sie die Enddauer lang unter dem Endwert bleibt. Der Modus wird durch Wertänderungen und das Abfrageintervall getrieben und funktioniert daher auch mit Steckdosen, die nur bei Änderung senden.
- **Kombiniert**: Die anzahlbasierte Erkennung von 3.1.2 plus eine Mindestdauer über dem Startwert und unter dem Endwert. Beide Bedingungen müssen erfüllt sein.

### Abbrucherkennung

Ein Abbruch ist ein Gerät, das während des Laufs von Hand ausgeschaltet wird. Die Option **Abbrucherkennung** gilt je Gerät und ist standardmäßig aus. Löst sie aus, wechselt der Status auf „switched off“, und es wird keine Fertig-Nachricht gesendet.

- In 3.1.2 konnte die Abbrucherkennung mit den meisten Erkennungswerten nie auslösen, weil ihr Standby-Puffer die nötige Länge nie erreichte. Dieses Verhalten bleibt erhalten, wenn nur **Abbrucherkennung** aktiv ist, die Geräte verhalten sich also genau wie in 3.1.2. Das gilt auch für die Werte der eingebauten Vorlagen.
- Die Option **Korrigierte Abbrucherkennung** (`abortFixed`, Standard aus) korrigiert die Pufferlänge (`max(ceil(Endanzahl / 2), 2)`), sodass der Abbruch wirklich auslösen kann. Nutze sie zusammen mit **Abbrucherkennung**. Allein anhand der Leistung lässt sich ein Ausschalten von Hand nicht von einem normalen Ende unter dem Standby-Wert unterscheiden (z. B. eine Waschmaschine, die auf 0,5 W fällt). Deshalb löst der korrigierte Abbruch nur aus, wenn der **Schalter** des Geräts aus ist. Ohne konfigurierten Schalter löst er nie aus, und ein normales Ende wird immer als fertig gemeldet.
- Im Modus Zeit löst der Abbruch aus, wenn die Leistung die halbe Enddauer lang unter dem Standby-Wert bleibt.

### Pausenschutz

Manche Programme pausieren lange, zum Beispiel beim Einweichen oder bei der Vorwäsche. Ohne Pausenschutz muss die Ende-Erkennung länger warten als die längste Pause, und dann kommt die Fertig-Meldung bei **jedem** Lauf so spät. Der Pausenschutz trennt solche Pausen vom echten Ende:

- Eine Phase unter dem Endwert gilt als **Pause**, wenn sie früh im Lauf beginnt (vor „Pause, wenn sie beginnt vor“ Sekunden nach dem Start) bzw. wenn ihre Leistung unter „Pause, wenn Leistung unter“ bleibt. Sind beide Werte gesetzt, müssen beide zutreffen.
- Eine Pause zählt erst nach der **Pause-Haltezeit** als Ende. Jede andere Phase unter dem Endwert wird wie gewohnt nach Endanzahl bzw. Enddauer als Ende gemeldet.
- Garantie: Der Pausenschutz kann ein Ende nur verzögern, nie verhindern oder vorziehen. Das gilt auch für die Abbrucherkennung. Sobald die Erkennung das Ende melden würde, kommt es spätestens nach der Haltezeit, auch wenn kurze Zacken (Display, Elektronik) die Phase unter dem Endwert immer wieder unterbrechen.
- Ein Abbruch über den Schalter (korrigierte Abbrucherkennung) wird nicht verzögert, denn der ausgeschaltete Schalter ist ein sicherer Beleg.
- Alle drei Werte 0 (Standard) = aus = Verhalten von 3.1.2. Eine Haltezeit ohne eine der beiden Bedingungen hat keine Wirkung.

Die Werte setzt normalerweise das [Anlernen](#8-anlernen); du kannst sie in der Typen-Tabelle ändern.

### Weiteres Verhalten

- Ein Leistungswert, der keine Zahl ist (zum Beispiel `null`, `true` oder ein leerer String), wird ignoriert, der letzte gültige Wert bleibt. Numerische Strings wie `"12,5"` werden gelesen.
- Existiert der Leistungs-State nicht (zum Beispiel eine gelöschte Steckdose), erscheint pro Gerät genau eine Warnung im Log, das Gerät bleibt „switched off“ und die Karte im Device Manager zeigt eine Warnung.
- Bearbeitest du ein laufendes Gerät, läuft der aktuelle Zyklus weiter, solange der Leistungs-State gleich bleibt. Geänderte Erkennungswerte gelten ab dem nächsten Lauf. Ein neuer Leistungs-State setzt das Gerät zurück, dazu wird eine Info-Meldung geloggt.

## 4. Geräte anlegen

Öffne den Reiter **Geräte** und drücke **Gerät hinzufügen**. Im ersten Schritt wählst du außerdem die **Werte des neuen Geräts** (Vorlage, alte Vorlage oder anderes Gerät, siehe [Erkennungswerte und Vorlagen](#3-erkennungswerte-und-vorlagen)) und einen von drei Wegen, die States zu finden:

1. **Steckdose / Leistungsmesser**: Der Device Manager nutzt den ioBroker Type-Detector, um Steckdosen und Leistungsmesser (Schalt- und Leistungs-State) zu finden. Wähle eines aus, beide States werden eingetragen.
2. **Alias oder Gerät**: Wähle ein Alias- oder Geräteobjekt, der Type-Detector sucht darin einen passenden Leistungs-State.
3. **Manuelle Eingabe**: Trage den Leistungs-State (und optional einen Schalt-State) selbst ein.

Wird nichts Passendes gefunden, erscheint ein Hinweis und du kannst manuell eingeben.

Das Gerätformular enthält:

| Feld | Bedeutung |
| --- | --- |
| Name | Grundlage der Objekt-ID. IDs sind eindeutig und gültig: Umlaute werden umgeschrieben, Leerzeichen und Punkte werden zu `_`, Duplikate erhalten `_2`, `_3` ... |
| Erkennung / Expertenwerte | Die Erkennungswerte des Geräts (siehe [Erkennungswerte und Vorlagen](#3-erkennungswerte-und-vorlagen)). Beim Anlegen wählt der erste Schritt, woher sie kommen; das Formular zeigt sie in der Einheit des Leistungs-States |
| Leistungs-State | State mit der Leistung in W oder kW (Pflicht) |
| Schalt-State | Optional, für Auto-Aus nötig |
| Starttext / Endtext | Nachrichtentexte |
| Abbrucherkennung | Siehe [Abbrucherkennung](#abbrucherkennung) |
| Auto-Aus | Schaltet die Steckdose die angegebene Zahl Minuten nach dem Ende aus (mit [Schlussphase](#schlussphase) erst nach der Sperrphase) |
| Empfänger | Empfänger, die die Nachrichten dieses Geräts erhalten |
| Räume / Funktionen | Ordnet das Geräte-Objekt ioBroker-Kategorien zu (Räume und Funktionen). Nötig zum Beispiel für den Reiter „Geräte“. Beim Löschen des Geräts wird die Zuordnung wieder entfernt |
| Erinnerung | Siehe [Erinnerungen und Quittierung](#6-erinnerungen-und-quittierung) |
| Aktionen | Siehe [Aktionen](#7-aktionen) |
| Automatische Optimierung | Standardmäßig aus (Bereich **Erweitert**). Siehe [Automatische Optimierung](#automatische-optimierung) |
| Änderungen als Nachricht melden | Standardmäßig aus, sichtbar bei eingeschalteter automatischer Optimierung (Bereich **Erweitert**). Jede Änderung der automatischen Optimierung wird auch an die Empfänger des Geräts geschickt |

Pflichtfelder werden vor dem Speichern geprüft.

Jede Gerätekarte zeigt Status, Leistung, Laufzeit, Anzeigen für „läuft“ und „fertig“ und eine Warnung bei fehlendem Leistungs-State. Auf der Karte kannst du das Gerät bearbeiten, löschen, aktivieren oder deaktivieren, Nicht stören schalten, quittieren, eine Testnachricht senden und das Anlernen starten. Die Karte zeigt die Vorlage, **angelernt** oder **eigene Werte** als Modell. Die Details zeigen die letzten Läufe, die Erkennungswerte des Geräts sowie den Erinnerungsstatus. Ein Gerät, das geprüft werden muss, trägt eine Warnung mit dem Grund.

### Ablauf

- Beim Start eines Laufs wird der Starttext gesendet, `running` wird true und der Status zeigt „in action“.
- Beim Ende wird der Endtext gesendet, `finished` wird true, die Laufzeit landet in `lastRuntime` und der Lauf in `lastOperations` (höchstens 14 Einträge).
- Überschreitet die Laufzeit `config.runtimeMax` (Minuten), wird `alertRuntime` true.
- Ein erneuter Start des Geräts gilt als Quittierung.

## 5. Empfänger

Ein Empfänger ist ein Ziel für Nachrichten. Lege Empfänger im Reiter **Empfänger** an und wähle sie je Gerät aus. Jeder Empfänger kann aktiviert oder deaktiviert werden, hat ein optionales **Zeitfenster** und eine **Test**-Schaltfläche (vorher speichern).

Zuerst wählst du den **Messenger**: Die Liste zeigt alle installierten Instanzen der unterstützten Messenger-Adapter (zum Beispiel „Alexa (alexa2.0)“ oder „Telegram (telegram.0)“). Danach erscheinen nur die Felder dieses Messengers, und alles Auswählbare ist eine Auswahlliste oder ein Objekt-Browser – keine ID muss eingetippt werden. Die Empfänger-ID wird intern verwaltet; der Blockly-Testblock listet die Empfänger mit Namen.

### Zeitfenster

Mit **Aktiv ab** und **Aktiv bis** (`HH:MM`) erhält ein Empfänger Nachrichten nur innerhalb des Fensters. Ein Fenster darf über Mitternacht gehen (zum Beispiel 22:00 bis 06:00). Gleiche Zeiten (wie die Voreinstellung 00:00 – 00:00) bedeuten keine Einschränkung. Zeitfenster gelten für jeden Messenger. Erinnerungen außerhalb des Fensters werden auf den nächsten Fensterbeginn verschoben.

**Nicht stören** (State `config.doNotDisturb` je Gerät) unterdrückt nur Sprachausgaben (Alexa, SayIt). Testnachrichten ignorieren Zeitfenster und Nicht stören.

### Messenger

| Messenger | Einstellungen |
| --- | --- |
| Alexa | Echo-Gerät oder -Gruppe (Auswahl aus der alexa2-Instanz), Lautstärke, optionaler Lautstärke-State |
| SayIt | Lautstärke, optionaler Lautstärke-State (der Text geht an `tts.text` der Instanz) |
| WhatsApp | nichts weiter (der Text geht an `sendMessage` der whatsapp-cmb-Instanz) |
| Telegram | Zieltyp (alle Nutzer, Benutzername oder Chat-ID) und Ziel, auswählbar aus den Nutzern der Telegram-Instanz. Gruppenchats haben negative Chat-IDs |
| Pushover | Titel, Gerät, Priorität, Ton, TTL |
| Signal | nichts weiter (signal-cmb) |
| E-Mail | Absender, Empfänger (der Betreff entsteht aus dem Text) |
| Matrix | nichts weiter (matrix-org) |
| Discord | Benutzer-ID, Benutzer-Tag, Benutzername, Server-ID, Kanal-ID |
| ntfy | Topic (Pflicht), Titel, Priorität |
| Pushsafer | Titel, Gerät, Ton, Priorität |
| Gotify | Titel, Priorität |

Leere optionale Felder (zum Beispiel TTL oder Discord-IDs) werden nicht mitgesendet. Ein Empfänger ohne verwendbares Ziel wird mit einer Warnung übersprungen, statt an alle zu senden.

### Sprachausgabe

Bei Alexa und SayIt wird die Lautstärke vor der Ansage gesetzt und danach zurückgestellt. Der Lautstärke-State wird aus dem Sprach-State abgeleitet; fehlt er, wird der Text trotzdem gesprochen. Für Alexa-Gruppen oder besondere Setups wählst du den **Lautstärke-State** im Objekt-Browser (siehe [FAQ](#14-faq)). Ausstehende Lautstärke-Rücksetzungen werden beim Beenden des Adapters abgebrochen.

## 6. Erinnerungen und Quittierung

Je Gerät kannst du die Fertig-Meldung bis zur Quittierung wiederholen.

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Erinnerung | aus | Aktiviert die Erinnerungen |
| Intervall | 30 min | Zeit zwischen den Erinnerungen |
| Maximale Anzahl | 10 | Stoppt nach so vielen Erinnerungen |
| Erinnerungstext | leer | Leer = der Endtext |
| Quittier-State | leer | Optionaler fremder State; ein Wechsel auf `true` quittiert |

Eine Erinnerung zählt nur als gesendet, wenn mindestens ein Empfänger sie erhalten hat. Empfänger außerhalb ihres Zeitfensters werden übersprungen, die Erinnerung wird auf den nächsten Fensterbeginn verschoben.

Quittiert wird durch:

- Schreiben des Button-States `acknowledge` des Geräts,
- den konfigurierten fremden Quittier-State mit Wert `true`,
- das sendTo-Kommando `acknowledge` (und den Blockly-Block),
- die Quittieren-Schaltfläche auf der Gerätekarte oder im Widget,
- einen erneuten Start des Geräts.

Das Quittieren stoppt die Erinnerungen und führt die Aktionen des Ereignisses „acknowledged“ aus.

## 7. Aktionen

Aktionen setzen fremde States automatisch. Je Gerät kannst du beliebig viele anlegen:

| Feld | Bedeutung |
| --- | --- |
| Ereignis | `start`, `end`, `reminder`, `acknowledged`, `phaseStart` oder `phaseEnd` (Beginn bzw. Ende einer [Phase](#phasen)) |
| Phase | Nur bei `phaseStart`/`phaseEnd`: ID der Phase (z. B. `p4`); leer = jede Phase. Die IDs stehen im State `phaseId` und in der Zeitleiste `phases` |
| State | Der fremde State, der geschrieben wird |
| Wert | Wert; wird in den Typ des Ziel-States umgewandelt (boolean, number oder string) |

Eine Aktion auf einen fehlenden State wird mit Warnung übersprungen und stoppt die anderen Aktionen nicht. Beispiel: Lampe einschalten, wenn die Waschmaschine fertig ist (`end`), und bei `acknowledged` wieder ausschalten.

## 8. Anlernen

Beim Anlernen werden Schwellwerte aus echten Läufen abgeleitet: aus der History des Leistungs-States oder aus einem aufgezeichneten Lauf.

### Aus der History

Wird der Leistungs-State von einem History-Adapter gespeichert (history, SQL, InfluxDB oder jeder andere Adapter, der `getHistory` beantwortet), wertet **Anlernen** auf der Gerätekarte zuerst die History aus. Nur wenn sie mindestens 2 vollständige Läufe enthält, fragt ein Dialog (mit der Zahl der gefundenen Läufe), ob aus der History angelernt oder ein neuer Lauf aufgezeichnet werden soll; sonst sagt der Dialog, warum, und zeichnet einen neuen Lauf auf. Die Standard-History aus den Systemeinstellungen wird bevorzugt. Du musst kein Programm wählen: Der Adapter unterscheidet keine Programme, die Erkennungswerte des Geräts müssen **jeden** Lauf erkennen.

### Der Anlern-Dialog

Du musst nichts auswählen: Die [Laufprüfung](#laufprüfung) entscheidet selbst, welche Läufe zählen, und der Dialog zeigt gleich den Vorschlag. Darüber steht, woher er kommt, z. B. „Angelernt aus 12 von 13 gefundenen Läufen der letzten 30 Tage. Automatisch weggelassen: 08.11. 15:10 (Aufzeichnung gestört (zu dünn))“. Nichts wird geschrieben, bevor du bestätigst, und „Abbrechen“ ändert nichts.

1. **Läufe (nur auf Wunsch):** Nur mit dem Haken **Läufe vorher einzeln prüfen** im ersten Fenster (standardmäßig aus) kommt vor dem Vorschlag die Liste: jeder Lauf und jede kurze Aktivität der letzten 30 Tage mit Datum, Dauer, Energie, **Prüfung** (✓ oder die Befunde der [Laufprüfung](#laufprüfung)), Grenzlauf und **Verwendung**: *Auto* verwendet einen Lauf, wenn die Prüfung es erlaubt (die Prüfung hält erst ab 8 Läufen selbst etwas zurück), *Verwenden* zählt einen Lauf trotz Befund (nur eine unbrauchbare Aufzeichnung nie), *Nicht verwenden* lässt ihn weg; er dient dann auch nicht als Vergleich für die anderen. Die Verwendung wählst du in einer Auswahl je Lauf, deren Beschriftung Nummer, Datum, Dauer, Energie und Prüfung nennt (die Variante mit einer Auswahlspalte in der Tabelle ist gebaut, wird aber erst eingeschaltet, wenn sie im Device Manager eines echten Systems geprüft ist). Mit dem Haken **Mit den gewählten Läufen neu berechnen** wird die Liste für die gewählte Menge noch einmal geprüft; ohne ihn geht es mit OK zum Vorschlag. Trägt ein Lauf „Früher verworfen“, hat ihn der Anlernspeicher einer Testversion von Version 4 nicht behalten; ein Hinweis oben sagt das.
2. **Angelernte Werte, immer neben den bisherigen:** Jeder Erkennungswert steht in einer Zeile „Bezeichnung | Bisher | Neu“: in der Mitte der aktuelle Wert des Geräts, rechts der Vorschlag, den du ändern kannst. Weicht der Vorschlag ab, beginnt die Bezeichnung mit „≠“; so siehst du auf einen Blick, was das Anlernen ändert. Zeilen: Modus, Start-, Ende- und Standby-Wert, Start- und Endanzahl, Start- und Enddauer und der Pausenschutz. Die Bewertung der Modi, die Gegenprobe und die Bewertung der aktuellen Werte (wie [oben](#aus-der-history) beschrieben) stehen eingeklappt unter **Details**. Die Werte des [Nachlauf-Filters](#nachlauf) werden ohne eigene Felder mit übernommen; **Details** zeigt sie nur lesend als „Bezeichnung | Bisher | Neu“ (mit „≠“, wenn sie sich ändern), im Geräteformular stehen sie unter **Expertenwerte**.
3. **Phasen:** Die [Phasen](#phasen) des Geräts stehen in der Reihenfolge des Laufs je in einer Zeile: Nummer, Name (änderbar), Leistung (z. B. „≈ 2165 W“, beim Nachlauf „kurze Stöße ≈ 110 W“), Dauer je Lauf und **Bisher** (Name, Leistung und Dauer der Phase vor dem Anlernen, „neu“ für eine neue Phase). Ein Hinweis nennt Phasen, die wegfallen (mit den Aktionen, die sie nutzen), und Phasen, die erst im Nachhinein erkannt werden. Meldungen zu einer Phase richtest du über die [Aktionen](#7-aktionen) des Geräts ein (Ereignis „Phase beginnt“ oder „Phase endet“); vorhandene Meldungseinstellungen einer Phase bleiben beim Neulernen erhalten.
4. **Fertig ab:** Standard ist **Standby (wie bisher)**: Das Ende wird wie in 3.1.2 nach der Ende-Wartezeit gemeldet. Sind alle Freigabeprüfungen der [Schlussphase](#schlussphase) bestanden (mindestens 5 Läufe mit klarem Ende), kannst du die Phase wählen, die auf die letzte Phase im Schlussband folgt (z. B. bei einer Waschmaschine der Nachlauf nach dem Endschleudern): „Fertig“ kommt dann, sobald diese Phase beginnt, also wenn die Phase davor vorbei ist. Angeboten wird nur diese eine Phase, weil es genau ein gelerntes Ende des Schlussbands gibt. Darunter stehen die Kennzahlen, z. B. „Fertig im Median 28 min früher, geprüft an 11 von 12 Läufen, 0 zu früh, 1 Rückfall“, oder der Grund, warum keine Phase angeboten wird. Hat das Gerät schon eine Schlussphase, ist sie vorausgewählt (oder **Schlussphase des Geräts behalten**), und **Bisher** zeigt die alte Wahl.

**Übernehmen** schreibt die Erkennungswerte (mit einer Phase bei „Fertig ab“ auch die `final*`-Werte, mit „Standby“ ohne Schlussphase) und die Phasen ins Gerät und deine Entscheidungen über die Läufe in die Anlerndaten; gelernte Phasen werden immer gespeichert und im State `phase` angezeigt. Das Gerät läuft ohne Neustart weiter. Mit einer Phase bei „Fertig ab“ werden außerdem die gewählten Läufe und die Grundbänder als Vergleichsdaten in den Anlerndaten abgelegt (auch ohne automatische Optimierung), damit die Beurteilung im Nachhinein sie kennt. Bei **Aufzeichnen** (ein Lauf) gibt es Start- und Ende-Werte (ebenfalls neben den bisherigen) und nur die Prüfungen ohne Vergleich (ungültige Werte, eine beweisbare Lücke; ein Energiezähler wird gar nicht erst aufgezeichnet); Phasen gibt es dort nicht, eine Schlussphase des Geräts bleibt unverändert.

**Laden**

- Die History wird tageweise gelesen, so kommen die vollen 30 Tage auch bei Steckdosen an, die jede Sekunde einen Wert senden. Eine kürzere Aufbewahrung (`retention`) des History-Adapters begrenzt den Zeitraum.
- Lücken des Loggers werden ignoriert: Ein Lauf, in dem der Logger länger als 2 Stunden nichts gespeichert hat, zählt nicht. Ein Wert, der sich nicht ändert (Steckdose sendet nur bei Änderung), ist keine Lücke.
- Einheiten W und kW werden unterstützt. Ein Energiezähler (Wh/kWh) wird erkannt und abgelehnt; wähle dann den State mit der aktuellen Leistung.
- Speichert der History-Adapter nur Änderungen, liegt vor dem ersten Lauf oft kein Wert im Zeitraum. Der Lauf zählt trotzdem, wenn der erste Wert im Ruhepegel liegt oder mehr als 2 Stunden nach dem Beginn des Zeitraums kommt.
- Kann die History nicht gelesen werden, steht der Grund im Log (Warnung) und der Dialog sagt es; dann wird ein neuer Lauf aufgezeichnet.

**Läufe**

- Ein Lauf darf bis zu 30 Minuten pausieren; Aktivität von insgesamt unter 5 Minuten (z. B. ein Display, das angeht) ist kein Lauf. Es braucht mindestens 2 Läufe, sonst wird ein neuer Lauf aufgezeichnet.
- Ein Lauf zählt erst, wenn er seit etwa 30 Minuten beendet ist (er könnte sonst nur pausieren). Lernst du direkt nach einem Lauf an, fehlt dieser Lauf noch.
- Zwei Läufe kurz hintereinander werden getrennt, wenn die Leistung dazwischen dem Ruhepegel nach einem Ende entspricht und sich deutlich von den Pausen im Lauf unterscheidet, egal ob die Pausen darunter (Pumpe aus, 0 W) oder darüber liegen (Elektronik an, z. B. 2–5 W, nach dem Ende 0,3 W). Sonst bleibt es ein Lauf.
- Bleibt die Leistung am Ende der meisten Läufe mindestens 5 Minuten auf einer festen niedrigen Stufe, bevor sich das Gerät abschaltet (z. B. Display mit 5 W, danach 0 W), ist diese Stufe ein Ruhepegel und keine Aktivität: Der Lauf endet vor ihr, nicht erst beim Abschalten. Ein Programm, das gestartet wird, während das Gerät auf diesem Ruhepegel steht, ist ein eigener Lauf, sobald der Ruhepegel mindestens halb so lange anlag wie die kürzeste Ruhephase.
- Kurze Stöße nach dem Ende (z. B. der Knitterschutz eines Trockners) zählen zum Nachlauf. Die Startdauer bzw. Startanzahl wird so gewählt, dass sie keinen neuen Start auslösen.
- Eine Phase mit leicht erhöhter Leistung nach dem Lauf ist entweder die Trocknung einer Spülmaschine (gehört zum Lauf) oder ein Display bzw. die Türverriegelung (gehört nicht dazu). An der Leistung allein ist das nicht zu unterscheiden. Darum entscheiden die aktuellen Erkennungswerte des Geräts: Die Phase gehört zum Lauf, wenn sie mindestens 20 Minuten dauert und ihre Leistung nicht unter dem aktuellen Endwert liegt (die aktuellen Werte melden dort also noch „läuft“, wie die Vorlage Spülmaschine mit 0,25 W). Sonst kommt die Fertig-Meldung kurz nach dem eigentlichen Lauf. Das gilt nur, solange das Gerät die Werte einer eingebauten Vorlage hat (intern `keepCurrentLevel`); angelernte oder eigene Werte entscheiden das nicht, damit ein zu niedriger angelernter Endwert sich beim nächsten Anlernen nicht selbst bestätigt.
- Kurze Stöße im Nachlauf mit Elektronik dazwischen (z. B. der Knitterschutz eines Trockners) sind nie eine Trocknung; das Ende wird nach dem Abkühlen gemeldet.
- `changesMinDelta` des History-Adapters wird beim Endwert berücksichtigt.

**Optimierung**

- Endwert und Ende-Wartezeit werden so gewählt, dass jeder Lauf genau einmal erkannt wird und das Ende so früh wie möglich kommt. Statt fester Faktoren wird die kürzeste sichere Endanzahl mit dem echten Erkennungscode gesucht.
- **Ende nicht zu früh** heißt: Die Fertig-Meldung kommt nach dem Ende des Laufs oder nach dem **Programmende** und höchstens 5 Minuten vor dem Ende des Laufs. Das Programmende ist der letzte Wert über der Nachlauf-Grenze (1,1 × höchste Leistung der kurzen Stöße im Nachlauf), aber nur, wenn der Nachlauf klar vom Programm getrennt ist: Mindestens 2 Läufe haben einen solchen Nachlauf (z. B. den Knitterschutz einer Waschmaschine), und in jedem endet ein Block von mindestens 2 Minuten über 1,25 × dieser Leistung (z. B. das Endschleudern einer Waschmaschine) höchstens eine Minute vor dem Kern-Ende. Sonst (Gerät ohne solchen Nachlauf oder ein Trockner, dessen Abkühlen kaum über den Stößen liegt) ist das Programmende das Ende des Laufs, wie bisher.
- Bringt der [Pausenschutz](#pausenschutz) im Mittel mindestens 3 Minuten, wird er vorgeschlagen. Beispiel: Ein Lauf mit 22 Minuten Einweichen bei 0 W, Nachlauf bei 0,5 W. Ohne Pausenschutz müsste jeder Lauf über 27 Minuten auf die Fertig-Meldung warten. Mit „Pause, wenn Leistung unter 0,25 W“ und 1670 s Haltezeit kommt sie bei allen Läufen nach etwa einer Minute. Liegen Pause und Nachlauf beide bei 0 W, trennt der Zeitpunkt („Pause, wenn sie beginnt vor 880 s“): Dann kommt das Ende nach etwa 4 Minuten, nur ein sehr kurzes Programm, das so früh endet, wie eine Pause beginnt, wird bis zur Haltezeit verzögert, aber erkannt.
- Jeder Vorschlag wird mit dem echten Erkennungscode und den Abbruch-Optionen des Geräts nachgespielt, und zwar in der Einheit des States mit den Werten, die gespeichert werden. Bei kW rundet der Modus Anzahl Mittelwerte auf 0,01 kW (10 W); erkennt er deshalb nicht jeden Lauf, zeigt der Dialog das und schlägt einen anderen Modus vor.

**Dialog**

- Je Modus: richtig erkannte / gefundene Läufe · mittlere (maximale) Zeit, bis das Ende gemeldet wird. Vorausgewählt ist der Modus, der die meisten Läufe mit den wenigsten Fehlstarts erkennt; sind mehrere gleich zuverlässig und melden das Ende innerhalb einer Minute, gewinnt Anzahl (Verhalten von 3.1.2).
- **Gegenprobe** x/y: so viele Läufe wären auch erkannt worden, wenn der jeweilige Lauf in der History gefehlt hätte. Ist der Wert kleiner als die Zahl der Läufe, kommt ein Programm (z. B. mit langer Pause) nur einmal vor; lerne nach weiteren Läufen erneut an.
- Vergleich mit den aktuellen Erkennungswerten des Geräts über dieselben Läufe und die längste Pause in einem Lauf.
- Vor dem Speichern kannst du jeden Wert, den Pausenschutz und den Modus ändern. Die Rückfrage nennt jede Änderung als alt → neu. Die Werte werden ins Gerät geschrieben (ohne Neustart, die Instanz-Einstellungen bleiben unberührt); die Schlussphase richtet sich nach „Fertig ab“.

### Laufprüfung

Jeder Lauf (aus der History, aus einer Aufzeichnung oder aus den gespeicherten Läufen der Optimierung) wird geprüft, bevor aus ihm gelernt wird. So verdirbt eine gestörte Aufzeichnung keine Werte, und ein seltenes echtes Programm wird trotzdem verwendet. Die Prüfung vergleicht jeden Lauf mit den anderen und wird darum bei jeder Auswertung neu gerechnet. Grundlage sind die **Leistungsbänder** des Geräts (z. B. Waschen, Schleudern und Heizen einer Waschmaschine) und wie lange ein gespeicherter Wert in jedem Band üblicherweise steht.

| Stufe | Wirkung |
| --- | --- |
| ok | für alles verwendet, auch seltene Programme |
| eingeschränkt | nur für einen Teil verwendet (z. B. nicht für die Dauer des Nachlaufs) |
| Quarantäne | nicht verwendet, aber sichtbar |
| unbrauchbar | nie verwendet |

Einen Lauf in Quarantäne kannst du aufnehmen, jeden anderen Lauf ausschließen; einen unbrauchbaren Lauf kannst du nicht aufnehmen. Gibt es mehrere Befunde, gilt der schwerste: unbrauchbar vor Datenfehlern (Lücke, hängender Wert, dünn aufgezeichnet) vor Form-Befunden (Fremdlast, Test) vor eingeschränkt.

- **Unvollständig** (unbrauchbar): Lauf am Ende der Daten, Neustart des Adapters im Lauf oder unbekannte Zeit im Lauf (fehlgeschlagene Abfrage, Zeitsprung).
- **Lücke**, beweisbar (unbrauchbar): Der History-Adapter speichert den Wert regelmäßig neu (`changesRelogInterval`), es kam aber länger als zwei Intervalle nichts; im Meldelog einer Aufzeichnung fehlt jede Meldung, auch mit gleichem Wert, mindestens 2 Minuten und dreimal so lange wie fast alle Meldeabstände (nur, wenn der Leistungs-State auch unveränderte Werte meldet; eine Steckdose, die nur Änderungen meldet, hält einen gleichbleibenden Wert ohne Meldung, dort zeigt nur die Haltezeit eine Lücke); der Adapter war aus.
- **Lücke**, Verdacht (Quarantäne): Ein Wert steht viel länger, als Werte in seinem Band sonst stehen (Grenze 5 × die längsten üblichen Haltezeiten, mindestens 10 Minuten). Das wird erst ab 3 Läufen geprüft. Bei Geräten, die durchgehend laufen, fällt nur dieser Abschnitt aus; der Tag bleibt verwendbar.
- **Hängt** (Quarantäne): mindestens 20 Meldungen mit genau demselben Wert, länger als diese Grenze, in einem Band, dessen Werte sonst schwanken. Ein Wert, der nur lange gleich bleibt, ohne dass Meldungen kommen, hängt nie.
- **Dünn aufgezeichnet** (Quarantäne): Die Abstände zwischen den gespeicherten Werten sind im Lauf mehr als 4-mal so groß wie in den anderen Läufen.
- **Einheit** (unbrauchbar): Die Spitze eines Laufs liegt unter 1/50 oder über dem 50-Fachen der üblichen Spitze, oder die übliche Spitze unter 1/100 der Spitze der Vorlage (z. B. kW-Werte ohne Einheit). **Zähler** (unbrauchbar): Der State hat die Einheit Wh oder kWh.
- **Fremdlast** (Quarantäne): Die Leistung in den 30 Minuten vor oder nach dem Lauf liegt mindestens 20 W (bzw. 3-mal die übliche Streuung) über der üblichen, oder mehr als 5 % des Laufs liegen weit über allem, was das Gerät sonst zieht. Langes Heizen in einem bekannten Band ist nie Fremdlast.
- **Störspitze** (eingeschränkt): ein einzelner Wert über dem 3-Fachen der höchsten Werte der Läufe. Eine einzelne Meldung (bei einer Abfrage bis 10 s) kurz vor dem Start oder nach dem Ende verlängert einen Lauf nicht, wenn sie mindestens 30 s von ihm entfernt ist; regelmäßige Stöße eines Nachlaufs bleiben Teil des Laufs.
- **Test** (Quarantäne): eine kurze Aktivität, die mehr als doppelt so lang ist wie jede andere; ein Lauf unter 10 Minuten, wenn die anderen Läufe des Geräts mindestens dreimal so lange dauern (ein Gerät, dessen Programme alle so kurz sind, etwa ein Wasserkocher, behält seine Läufe; ohne 3 andere Läufe jeder kurze Lauf); ein Lauf, der nur ein Band oder keines der Bänder berührt, die in mindestens der Hälfte der Läufe vorkommen (entfällt bei Geräten, deren Läufe selbst nur ein Band berühren). Dauer und Energie allein machen nie einen Test.
- **Abgebrochen** (eingeschränkt, nur für den Start): in der Aufzeichnung als Abbruch gemeldet; in der History ein abruptes Ende ohne Endblock und Nachlauf, kürzer als fast alle Läufe seiner Programmgruppe.
- **Nachlauf abgeschnitten** (eingeschränkt, nicht für Nachlauf- und Ruhedauer): Der Nachlauf ist kürzer als die Hälfte des üblichen, oder das Gerät schaltet sich mindestens 5 Minuten früher ab als sonst (z. B. Tür im Knitterschutz einer Waschmaschine geöffnet). Nur bei Geräten, die in mindestens 2 Läufen einen Nachlauf mit kurzen Stößen haben.
- **Zusammengewachsen** (eingeschränkt): Ein Lauf ist mehr als 1,8-mal so lang wie der längste seiner Programmgruppe und hat zwei Endblöcke (z. B. zweimal Endschleudern), oder ein Lauf hat zwei Endblöcke und dazwischen eine Ruhe von mindestens 3 Minuten auf dem Pegel nach dem Ende, die kein anderer Lauf in seinem Programm hat (das geht auch ohne Vergleichsläufe): zwei Programme direkt hintereinander, die als ein Lauf aufgezeichnet sind. Das ist **kein Erkennungsfehler**, das Gerät lief ja durchgehend. Wichtig ist nur, dass das Ende des Gesamtlaufs erkannt wird; dafür wird der Lauf verwendet, nicht für Pausen, Dauer, Grenzwerte, Phasen, Schlussphase und Nachlauf (die Ruhe zwischen den beiden Programmen verlängert keine Ende-Wartezeit). Es gibt keinen Hinweis und keine Reparatur.
- **History-Einstellung** (eingeschränkt): `ignoreZero` (nicht für die Ruhedauer), Entprellung (`debounceTime`, `blockTime`) länger als das Abfrageintervall (nicht für Phasen und Nachlauf), Rundung gröber als 10 % des Ruhepegels (nur Hinweis).
- **Ungültige Werte** und **Zeitsprung** (eingeschränkt): mehr als 1 % fehlende, ungültige oder negative Werte im Lauf bzw. Zeit, die um mehr als eine Minute zurückspringt. Die Werte werden bereinigt; nach einem Zeitsprung ist die Zeit bis zum letzten Wert davor unbekannt.
- **Selten** (ok, voll verwendet): ein seltenes echtes Programm, z. B. ein Kurzprogramm oder langes Heizen: der einzige Lauf seiner Programmgruppe, weit außerhalb seiner Gruppe, oder Dauer, Energie oder längster Block unter der Hälfte bzw. über dem Doppelten aller anderen Läufe. Seltene Programme werden verwendet, nicht aussortiert.
- **Früher verworfen?** (Verwendung unverändert): ein History-Lauf im Zeitraum eines alten Anlernspeichers einer Testversion von Version 4, der dort fehlt.

Programmgruppen werden nur aus Läufen ohne Quarantäne gebildet; ein Lauf in Quarantäne bestätigt nie einen anderen. Ein Lauf aus der Aufzeichnung und einer aus der History sind derselbe Lauf, wenn sie höchstens 5 Minuten auseinander beginnen.

### Einen Lauf aufzeichnen

1. Anlernen auf der Gerätekarte starten (**Anlernen**) oder `learning.start` des Geräts schreiben.
2. Einen kompletten Zyklus der Maschine laufen lassen. Die Aufnahme endet automatisch nach 12 Stunden oder 10 000 Messwerten.
3. Anlernen im Device Manager beenden oder `learning.stop` schreiben.
4. Die Aufnahme wird mit derselben Logik ausgewertet wie die History, mit einem Lauf. Nach dem letzten Messwert gilt dieser Wert als weiter bestehend (wie im Betrieb); so kann die Aufnahme auch kurz nach dem Ende gestoppt werden. Erkennt kein Modus den Lauf (z. B. Aufnahme gestoppt, während das Gerät noch lief), gibt es keinen Vorschlag. Die vorgeschlagenen Einstellungen stehen als JSON in `learning.result` (Schwellwerte, Start- und Enddauer, Laufdauer, Anzahl der Messwerte, Modus, Auswertung je Modus und Pausenschutz). Die Aufnahme selbst wird ebenfalls geprüft: ungültige Werte (`invalid`) oder eine beweisbare Lücke (`gap`) stehen im Feld `checks`; der Vorschlag ist dann womöglich unzuverlässig, nimm den Lauf besser erneut auf. Der Device Manager zeigt sie an und schreibt sie nach einer Rückfrage ins Gerät.

Wurden weniger als 20 Messwerte aufgenommen oder wird kein Lauf erkannt, enthält `learning.result` einen Fehler (`tooFewSamples` oder `noRun`). `learning.active` ist true, solange aufgenommen wird.

### Nachlauf

Viele Geräte zeigen nach dem eigentlichen Programm noch kurze Stöße, den Nachlauf (z. B. der Knitterschutz einer Waschmaschine oder eines Trockners: 100–600 W für 10–30 s alle 1–5 Minuten, bis zu 2 Stunden lang). Ohne Sonderbehandlung kommt das Ende erst nach diesem Nachlauf, oder jeder Stoß startet einen neuen Lauf (Trocknerwerte von 3.1.2 mit 2 Messwerten über 120 W).

Der optionale **Nachlauf-Filter** eines Geräts (standardmäßig aus) hält einen Abschnitt über dem Endwert zurück, der nach einer Ruhezeit beginnt. Endet er innerhalb der längsten Stoßdauer, war es ein Stoß des Nachlaufs und die Erkennung sieht stattdessen den Ruhepegel; sonst war es echte Aktivität und die Erkennung erhält die Originalwerte, höchstens eine Stoßdauer später. So wird das Ende gemeldet, wenn das Programm fertig ist, also wenn der Nachlauf beginnt. Stöße im Nachlauf starten keinen Lauf: Nach dem Ende ist erst ein Abschnitt von mindestens 2 Minuten über dem Endwert ein neuer Lauf. Ein im Nachlauf neu gestartetes Programm wird so höchstens 2 Minuten später erkannt.

| Feld | Bedeutung |
| --- | --- |
| `trailerBurstSec` | Längster Stoß in s (15–180; 0 = Filter aus) |
| `trailerGapSec` | Mindest-Ruhezeit vor einem Stoß in s (0 = 3 Abfragen, mindestens 30 s); kürzere Stopps im Programm (z. B. der Waschrhythmus einer Waschmaschine) werden nie zurückgehalten |
| `trailerAfterSec` | Stöße werden erst so lange nach dem Start zurückgehalten (0 = ungenutzt) |
| `trailerBlockVal` | Stöße werden erst nach einem Block von mindestens 2 Minuten zurückgehalten, dessen Leistung in den letzten 2 Minuten mindestens diesen Wert hat (0 = ungenutzt), z. B. das Schleudern am Programmende einer Waschmaschine |
| `trailerMaxSec` | Dauer des Nachlaufs nach dem Ende in s (900–14400); er endet auch nach 20 Minuten ohne Stoß |

Die Felder gehören zu den Erkennungswerten des Geräts und stehen im Geräteformular unter **Expertenwerte** (Bezeichnungen „Nachlauf: …“). Schlägt das Anlernen den Filter vor, werden seine Werte ohne eigene Felder übernommen; die Gerätedetails zeigen sie. Solange der Filter Stöße zurückhält, ist der State `antiCrease` des Geräts true. Mit angelernten [Phasen](#phasen) ist der Nachlauf die letzte Phase.

Das Anlernen findet einen Nachlauf (mindestens 2 kurze Stöße, auch im Abstand von 1 Minute, nach einem längeren Block; eine längere Lücke, z. B. für eine zwischendurch geöffnete Tür, ist erlaubt) und auch einen dichten Nachlauf, bei dem Stoß und Elektronik bei jeder Meldung wechseln (z. B. 6 W und 20–110 W abwechselnd für 30 Minuten nach dem letzten Schleudern einer Waschmaschine; mindestens 6 Stöße über 5 Minuten, höchstens 70 % der Zeit Stoß und die Elektronik dazwischen höchstens ein Viertel der Stoßleistung), misst die Ende-Verzögerung ab dem Programmende und setzt die Felder, wenn mindestens 2 Läufe einen solchen Nachlauf haben und der Filter das Ende mindestens eine Minute früher meldet. Liegt die Elektronik zwischen den Stößen zeitweise über dem Laufpegel (Trockner: Stöße etwa 100 W, dazwischen 4 W und 8–13 W im Wechsel), misst das Anlernen den Nachlauf über einem Viertel der hohen Werte am Laufende, solange die Elektronik dazwischen höchstens ein Viertel der Stoßleistung hat; so wird er in jedem Lauf gefunden und das Ende des Abkühlens gilt als Programmende. Endwerte in der Nähe der Stoßleistung werden nie vorgeschlagen. Innerhalb eines Programms kann ein Abschnitt genauso aussehen wie der Nachlauf (z. B. Einweichen mit Trommelbewegungen). Die Filtervarianten mit `trailerBlockVal` und `trailerAfterSec` unterscheiden sie; erkennt keine Variante jeden Lauf, zeigt der Dialog „nicht trennbar“ und das Ende bleibt nach dem Nachlauf (es wird nie zu früh gemeldet).

### Schlussphase

Viele Geräte haben am Programmende eine letzte typische Phase, nach der nur noch Ruhe oder ein Nachlauf kommt (z. B. Waschmaschine: Endschleudern, danach Knitterschutz). Die Ende-Erkennung wartet nach dieser Phase noch die Endanzahl bzw. Enddauer ab; bei einer Waschmaschine mit den Werten von 3.1.2 sind das 11–31 Minuten. Die optionale **Schlussphase** meldet das Ende stattdessen kurz nach dieser letzten Phase (auf den Daten einer Waschmaschine 1,5–2,2 Minuten nach dem Programmende). Sie ist standardmäßig aus (alle 13 Werte 0 = Verhalten von 3.1.2) und eingeschaltet, sobald Untergrenze und Zeit im Band gesetzt sind. Die Werte stehen unter **Expertenwerte** im Geräteformular.

So funktioniert sie:

- **Frühes Fertig:** Liegt die Leistung im Lauf zusammen mindestens „Zeit im Band“ (Y) im **Schlussband** (Untergrenze P bis unter die Obergrenze; ein Wert über der Obergrenze verwirft den Block), beginnt dieser Block frühestens „Block nach Start“ (X) nach dem Start und liegt die Leistung danach „Ruhezeit“ (Z) lang unter P, wird **Fertig** gemeldet – mit allem, was zu einem normalen Ende gehört (Ende-Text, Ende-Aktionen, Erinnerungen, `lastOperations`). Unterbrechungen bis „Unterbrechung“ (G) gehören noch zum Block. Gezählt wird bei jeder Abfrage der zuletzt gemeldete Wert; eine Steckdose, die minutenlang nichts meldet, verlängert die Zeit im Band also nicht.
- **Sperrphase:** Nach dem frühen Fertig folgt eine Sperrphase. Die Erkennung läuft im Hintergrund weiter, meldet aber nichts; der Status ist „standby“ bzw. „switched off“. Ein Abbruch über den Schalter wird in der Sperrphase nicht gemeldet. Stöße im Nachlauf lösen so keinen neuen Lauf aus. Die erste zutreffende Bedingung beendet die Sperrphase:

| Ausgang | Bedingung |
| --- | --- |
| a) Ende | die normale Ende-Erkennung meldet das Ende (bzw. einen Abbruch) |
| b) Ruhe | die Leistung bleibt „Ruhedauer“ lang unter dem „Ruhepegel“ (0 = Standby-Wert) |
| c) Hochlast | die Leistung bleibt G lang auf oder über dem „Hochlast-Pegel“ (0 = aus) |
| d) Schlussband spät | ein Wert im Schlussband später als das „Prüffenster“ nach dem frühen Fertig |
| e) Höchstdauer | die „Höchstdauer der Sperrphase“ ist abgelaufen (0 = 4 Stunden) |
| f) Aktivität | in den letzten 5 Minuten liegt die Leistung mindestens zum „Aktivitätsanteil“ der Zeit über dem „Aktivitätspegel“ (beide 0 = aus) |
| g) Schlussband früh | innerhalb des Prüffensters liegt die Leistung zusammen mindestens Y/2 im Schlussband |

- **Alles danach ist ein neuer Lauf:** Nach b–g beginnt die Erkennung von vorn und erkennt einen neuen Lauf mit den normalen Startregeln. Der Start wird auf die erste Aktivität über dem Ruhepegel nach der letzten Ruhe zurückdatiert, frühestens auf das frühe Fertig, damit Laufzeit und `lastOperations` stimmen. Es gibt keine Korrektur-Nachricht und keine Wiederaufnahme: Wurde ein Programm direkt nach dem Ende neu gestartet, ist das ein neuer Lauf mit eigener Start- und Fertig-Meldung; war das frühe Fertig falsch (die Schlussphase passt nicht zu diesem Programm), meldet der Rest des Programms Start und Fertig.
- **Startverzögerung nach dem Ausräumen:** Wird das Gerät direkt nach dem frühen Fertig ausgeräumt und sofort mit einem neuen Programm gestartet, erkennt der Adapter den Start erst, wenn ein Ausgang der Sperrphase greift. Bei Ausgang f (Aktivitätsanteil) ist das kurz: Beispiel Waschmaschine (Kaltwäsche nach dem Ausräumen), Start etwa 0,8 bis 3,7 Minuten nach dem Einschalten (höchstens etwa 4 Minuten), das Ende stimmt. Der Start wird auf die erste Aktivität zurückdatiert. Ist Ausgang f mangels Trennung der Daten aus, gilt die längere Wartezeit bis zum nächsten Schlussband- oder Hochlast-Block bzw. bis zur Höchstdauer; der Dialog nennt das.
- **Beurteilung im Nachhinein:** Endet ein Lauf, der nach einem frühen Fertig über die Ausgänge b–g begonnen hat, prüft der Adapter frühes Teilstück und neuen Lauf zusammen. Der neue Lauf gilt als Rest des zerteilten Programms, wenn er nicht so beginnt wie die gespeicherten sauberen Läufe (in den ersten 10 Minuten fehlt ein Leistungsband, mit dem mindestens 80 % von ihnen beginnen) oder wenn zwischen frühem Fertig und neuem Start keine Ruhe unter dem Ruhepegel lag, die länger ist als die längste Ruhe in einem Programm (mindestens 60 Sekunden). Ohne Vergleichsdaten (weniger als 3 saubere Läufe oder keine Leistungsbänder) zählt nur die Ruhe, verglichen mit der längsten Ruhe im frühen Teilstück. Eine Pause im Programm, die länger ist als jede Ruhe im frühen Teilstück (z. B. eine lange Einweichpause), wird dann nicht als Zerteilung erkannt; das gelingt erst mit Vergleichsdaten. Ein echtes Ausräumen mit Neustart (Ruhe dazwischen) wird so nicht als Zerteilung gewertet. Hat eine Ruhe von mehr als 30 Minuten (z. B. Einweichen) die Aufzeichnung des frühen Teilstücks schon geschlossen, wird das frühe Teilstück aus dem gespeicherten Lauf davor genommen (höchstens 3 Stunden vor dem neuen Start). Die Prüfung läuft sofort beim Ende dieses Laufs, damit ein danach gestartetes Programm schon ohne die falsche Schlussphase erkannt wird.
- **Aussetzen:** Ist das Programm zerteilt worden, wird die Schlussphase **ausgesetzt** – auch ohne automatische Optimierung. Die Erkennung läuft dann ab dem nächsten Lauf wie ohne Schlussphase (die Werte im Gerät bleiben unverändert; `learning.optimizeInfo` zeigt `finalState: "suspended"`). Es gibt eine Warnung im Log, einen Eintrag „Schlussphase ausgesetzt“ in den letzten Änderungen und eine Warnung auf der Gerätekarte; als Nachricht an die Empfänger geht der Hinweis nur mit der Option „Änderungen als Nachricht melden“. Mit automatischer Optimierung wird sie direkt nach dem Lauf repariert (siehe [Automatische Optimierung](#automatische-optimierung)). Sonst bleibt die Schlussphase ausgesetzt, bis sie wieder eingeschaltet wird (Optimierungsdialog, neu anlernen) oder die Anlerndaten gelöscht werden; die Schlussphase in den Geräteeinstellungen aus- und wieder einzuschalten, hebt das Aussetzen nicht auf (die Warnung bleibt auf der Karte).
- **Anlerndaten für die Schlussphase:** Hat ein Gerät eine Schlussphase, werden seine Läufe auch ohne automatische Optimierung aufgezeichnet und im Dateispeicher abgelegt (wie bei der automatischen Optimierung, beim ersten Mal mit den Läufen der History, falls vorhanden); sie dienen nur als Vergleichsdaten. Ohne automatische Optimierung werden keine optimierten Werte angewendet oder berechnet, und es wird nichts repariert oder verschärft; die einzige mögliche Änderung ist das Aussetzen.
- **Auto-Aus:** Mit Schlussphase beginnt die Auto-Aus-Zeit nicht beim frühen Fertig, sondern erst, wenn die Sperrphase über Ende, Ruhe oder Höchstdauer endet (a, b, e) – ein noch laufendes Programm wird so nicht abgeschaltet. Endet sie über Hochlast, Schlussband oder Aktivität (c, d, f, g), läuft wahrscheinlich ein neuer Lauf; Auto-Aus folgt dann dessen Ende. Beginnt binnen des Prüffensters kein neuer Lauf, startet Auto-Aus nach dem Prüffenster, bei Ruhe (Ruhedauer lang unter dem Ruhepegel) sofort. Nach einem Neustart des Adapters in der Sperrphase gilt das ebenso: Die Auto-Aus-Zeit beginnt erst mit dem Ausgang der fortgesetzten Sperrphase.
- **Neustart des Adapters:** Der State `settlingUntil` hält das Ende der laufenden Sperrphase (frühes Fertig + Höchstdauer), sonst 0. Startet der Adapter in der Sperrphase neu, setzt er sie fort, solange `settlingUntil` in der Zukunft liegt und die Schlussphase eingeschaltet und nicht ausgesetzt ist – auch wenn das Gerät schon quittiert wurde. Die Sperrphase endet spätestens die Höchstdauer nach dem Neustart, auch wenn `settlingUntil` (z. B. nach einem Verstellen der Uhr) weiter in der Zukunft liegt. Ein Wechsel des Leistungs-States oder das Deaktivieren des Geräts beendet die Sperrphase und setzt `settlingUntil` auf 0. Den State gibt es nur bei eingeschalteter Schlussphase (auch wenn nur die automatische Optimierung sie eingeschaltet hat).
- **Änderungen in der Sperrphase:** Geänderte Erkennungswerte oder Optionen gelten erst nach der Sperrphase (bzw. nach dem Lauf), damit die Erkennung nicht mitten in der Sperrphase von vorn beginnt.
- **Grenzen:** Zeiten gelten unabhängig vom Abfrageintervall mindestens so, dass ein einzelner Wert nie reicht (Y und G mindestens 2 Abfragen, Z mindestens G, Ruhedauer mindestens 3 Abfragen); das wirkt nur in die sichere Richtung (späteres Fertig, späterer Ausgang). Mit aktivem [Nachlauf-Filter](#nachlauf) liegt dieser außen: Das frühe Fertig startet den Nachlauf (State `antiCrease` ist in der Sperrphase true, solange der Nachlauf läuft), in der Sperrphase hält der Filter nichts zurück.

- **Bereiche:** Zeiten in Sekunden: X 0 bis 604 800, Y 10 bis 86 400, Z 30 bis 7 200, G 10 bis 3 600, Ruhedauer 10 bis 14 400, Prüffenster 300 bis 14 400 (höchstens die Sperrphase), Sperrphase 600 bis 14 400; Aktivitätsanteil 0 oder 0,5 bis 0,9. Leistungen haben keine absolute Grenze, weil sie in der Einheit des States (W oder kW) stehen; es gelten nur relative Regeln: P über dem Ruhepegel (bzw. Standby-Wert), Obergrenze 0 oder über P, Hochlast-Pegel 0 oder ab der Obergrenze, Aktivitätspegel 0 oder zwischen Ruhepegel und P, Aktivitätspegel und -anteil beide 0 oder beide gesetzt. Ein von Hand eingegebener Wert, der einen Bereich oder eine Regel verletzt, wird korrigiert oder die Schlussphase wird ausgeschaltet, jeweils mit Warnung im Log. Vom Adapter gelernte Werte werden nie korrigiert; passt einer nicht, wird er nicht angeboten.
- **Nur angeboten, wo sie hilft:** Die Schlussphase wird nur angeboten, wo die Daten sie trennen: Die Läufe haben ein Schlussband, das sich klar vom Rest des Programms unterscheidet, danach folgt ein Nachlauf oder eine lange Wartezeit, und das frühe Ende gewinnt mindestens eine Minute. Ein Gerät ohne Nachlauf (zum Beispiel ein Wasserkocher) bekommt keine, ein Gerät, dessen Nachlauf sich nicht vom Programm trennt (z. B. der Knitterschutz mancher Trockner), ebenfalls nicht.
- **Restrisiko:** Beim ersten Auftreten eines unbekannten Programms (zum Beispiel Einweichen mit langer Pause nach einem Schleudern, das wie die Schlussphase aussieht) kann die Schlussphase ein Fertig zu früh melden. Der Adapter meldet dann Start und Fertig für den Rest des Programms und setzt die Schlussphase aus; mit der automatischen Optimierung wird sie direkt nach diesem Lauf repariert. Es geht nichts verloren, aber diese eine frühe Meldung lässt sich nicht vermeiden, weil der Adapter erst im Nachhinein urteilt.

Die Werte trägst du von Hand ein, lernst sie im [Anlern-Dialog](#der-anlern-dialog) an oder lässt die [automatische Optimierung](#automatische-optimierung) die Schlussphase selbst einschalten, sobald genug Läufe sie belegen. Ohne passende Werte (Schlussband, das auch mitten im Programm erreicht wird, oder zu kleines Y) kommt das Fertig zu früh, und der Rest des Programms wird als neuer Lauf gemeldet; danach setzt die Beurteilung im Nachhinein die Schlussphase aus.

| Feld | Bedeutung |
| --- | --- |
| `finalMinVal` (P) | Untergrenze des Schlussbands (0 = Schlussphase aus) |
| `finalMaxVal` | Obergrenze; ein Wert ab hier verwirft den Block (0 = offen) |
| `finalHotVal` | Hochlast-Pegel für Ausgang c (0 = aus) |
| `finalAfterSec` (X) | der Block beginnt frühestens so lange nach dem Start (s) |
| `finalMinSec` (Y) | Zeit im Schlussband (s; 0 = Schlussphase aus) |
| `finalQuietSec` (Z) | so lange unter P nach dem Block → Fertig (s; 0 = 120 s) |
| `finalDipSec` (G) | Unterbrechung im Block (s; 0 = 60 s bzw. 2 Abfragen) |
| `finalRestVal` / `finalRestSec` | Ruhepegel und Ruhedauer für Ausgang b (0 = Standby-Wert bzw. 60 s) |
| `finalActVal` / `finalActShare` | Aktivitätspegel und -anteil für Ausgang f (0 = aus) |
| `finalCheckSec` | Prüffenster für die Ausgänge d und g (s; 0 = 30 min) |
| `finalLockSec` | Höchstdauer der Sperrphase (s; 0 = 4 h) |

### Phasen

Phasen zeigen, in welchem Abschnitt seines Laufs ein Gerät gerade ist („Phase 1“, „Phase 2“ …; die Namen kannst du ändern, z. B. in „Heizen“ bei einer Waschmaschine). Sie sind nur aktiv, wenn für das Gerät ein Phasenmodell eingeschaltet ist (der [Anlern-Dialog](#der-anlern-dialog) schaltet es beim Übernehmen ein, sobald Phasen gelernt wurden); sonst gibt es die States `phase`, `phaseId`, `phaseSince` und `phases` nicht (sie werden gelöscht), und alles andere verhält sich wie ohne Phasen. Die Phasen verändern nie den `status` und lösen nie ein Start- oder Ende-Ereignis aus.

- **Anzeige:** `phase` (Name), `phaseId` (ID) und `phaseSince` (Beginn) werden nur beim Wechsel der Phase geschrieben, nie bei jeder Abfrage. `phases` ist die Zeitleiste des laufenden bzw. letzten Laufs als JSON (`id`, `name`, `from`, `to`), höchstens die 200 neuesten Abschnitte; bei Geräten ohne Lauf (z. B. Kessel) die letzten 24 Stunden. Der laufende Abschnitt hat als `to` den Zeitpunkt der letzten Abfrage. Der State `phases` wird nur geschrieben, wenn sich ein Abschnitt ändert (neue Phase, Ende eines Abschnitts oder nachträgliche Einordnung).
- **Angelernte Phasen:** Das Anlernen fasst alle Abschnitte eines Leistungsbands zu **einer** Phase zusammen, gleich wie lang sie sind (kurzes und langes Schleudern sind dieselbe Phase). Ein Band wird nur geteilt, wenn es an einer anderen Stelle im Lauf vorkommt: am Beginn des Laufs (bzw. nach Ruhe) gegenüber nach einem anderen Band, und bei Geräten mit Lauf nur, wenn mindestens die Hälfte der Läufe in diesem Band beginnt. Jede Phase braucht Belege aus mindestens 3 Läufen bzw. Tagen. Die Phasen stehen in der Reihenfolge des Laufs und heißen neutral „Phase 1“, „Phase 2“ usw. Kommt nach dem Programmende in mindestens 3 Läufen ein Nachlauf vor (z. B. der Knitterschutz einer Waschmaschine), ist er die letzte Phase; er wird angezeigt, solange der [Nachlauf-Filter](#nachlauf) das Ende hält, und hat Beginn und Ende wie jede andere Phase. Er wird nicht aus den Leistungsbändern gelesen, nimmt nicht an der Gegenprobe teil und ist nie die Phase im Schlussband, nach der „Fertig ab“ meldet. Beim Neulernen behalten wiedergefundene Phasen ihre ID, deine Namen und Meldungen; nur die erzeugten Namen (die Vorlage „Phase n“ in jeder der 11 Sprachen, also auch nach einem Sprachwechsel) werden nach der neuen Reihenfolge neu vergeben.
- **Was erst nachträglich erscheint:** Angelernte Phasen erscheinen sofort. Eine Phase, die nur an ihrer Höchstdauer erkennbar ist (z. B. „Zwischenschleudern“ in einem älteren oder selbst geschriebenen Modell), steht erst am Ende ihres Abschnitts fest. Live zeigt der State den Oberbegriff des Bandes (angelernt z. B. „≈ 293 W“), die Zeitleiste enthält danach den genauen Namen. Dasselbe gilt für eine Zündung (Ereignisphase), die nicht bestätigt wird. Geraten wird nie; passt keine Phase, steht der Oberbegriff.
- **Systemphasen:** „Nachlauf“ (`antiCrease`), solange der Nachlauf-Filter den Nachlauf erkennt (ohne angelernte Nachlauf-Phase), „Fertig, klingt aus“ (`afterRun`) in der Sperrphase der Schlussphase (das Ende ist schon gemeldet, das Gerät ist noch aktiv; nicht der Nachlauf), „Ruhe“ (`rest`) und „Unbekannt“ (`unknown`, wenn der Leistungs-State ungewöhnlich lange nichts meldet). Ihre Namen sind in der Sprache der Installation. Ist in 3 Läufen in Folge mehr als 10 % der Laufzeit „Unbekannt“, gibt es eine Warnung im Log, dass sich das Gerät anders verhält (Phasen neu anlernen?); als Nachricht nur mit der Option „Änderungen als Nachricht melden“. Die Werte ändern sich dadurch nicht.
- **Ereignis:** Beginn und Ende jeder Phase sind Ereignisse für [Aktionen](#7-aktionen) (`phaseStart`, `phaseEnd`, auf Wunsch gefiltert auf eine Phasen-ID).
- **Nachrichten:** Meldungen zu einer Phase richtest du über eine [Aktion](#7-aktionen) mit dem Ereignis `phaseStart` oder `phaseEnd` ein. Daneben kann ein Phasenmodell Meldungen je Phase tragen (Beginn und/oder Ende, eigener Text; der Anlern-Dialog zeigt sie nicht, behält sie aber beim Neulernen). Nur solche Phasen schicken eine eigene Nachricht, an die Empfänger des Geräts mit Nicht-Stören wie bei Start und Ende. Je Lauf und Phase wird höchstens einmal gemeldet; bei Geräten ohne Lauf höchstens alle 10 Minuten je Phase. Eine nur am Ende erkennbare Phase wird nur „bei Ende“ gemeldet.
- **Änderung des Phasenmodells:** Ein geändertes Modell gilt zwischen zwei Läufen (und nach der Sperrphase), nie mitten im Lauf.

### Automatische Optimierung

Die Geräte-Option **Automatische Optimierung** (standardmäßig aus, Gerätedialog → **Erweitert**) prüft die Erkennung nach jedem Lauf und verbessert sie, ohne die Instanz neu zu starten und ohne die Erkennungswerte des Geräts zu ändern:

- Die Leistung rund um jeden Lauf (30 Minuten davor bis 30 ruhige Minuten nach dem Ende, höchstens 3 Stunden danach) wird kompakt im Dateispeicher des Adapters abgelegt (`<namespace>.learn/<gerät>.a.json` / `.b.json`, höchstens 1 MB). Ein History-Adapter ist nicht nötig.
- **Welche Läufe bleiben:** die Läufe der letzten 30 Tage (bei mehr als 1 MB bzw. 400 Läufen fallen zuerst History-Läufe, dann der älteste Lauf der größten Programmgruppe weg) und 10 Fehlstarts. Ältere Läufe fallen weg, außer **Grenzläufen** (ein Lauf, der allein eine Sicherheitsgrenze bestimmt, z. B. die längste Pause oder die kleinste Laufleistung) und mindestens 2 Läufen je Programmgruppe. Grenzläufe werden nie verdrängt; von zwei gleich extremen Läufen bleibt immer einer. Die Grenzen (`envelope`) werden aus den verwendbaren Läufen berechnet (die Laufprüfung zählt mit, ein ausgeschlossener Lauf nicht); Anlerndaten einer früheren Version behalten ihre bisherigen Grenzen als Untergrenze, bis du die Anlerndaten löschst. Beim ersten Start mit dieser Version werden gespeicherte Läufe aus ihren Werten neu zerlegt (Log `learning data brought to the current version`).
- Wird der Leistungs-State von einem History-Adapter aufgezeichnet, werden beim ersten Einschalten der Option einmalig die Läufe und Fehlstarts seiner letzten 30 Tage übernommen (mit den aktuellen Werten nachgespielt, wie sie die Laufzeit gesehen hätte); danach läuft die Optimierung sofort. Ohne History-Adapter beginnt sie mit dem ersten Lauf. Nach **Anlerndaten löschen** wird die History erneut gelesen (deine Entscheidungen über Läufe gelten dabei weiter), nach einer **Ausfallzeit** des Adapters von mehr als einer Stunde nur die Zeit des Ausfalls (höchstens 30 Tage). Ein Lauf, der schon gespeichert ist oder gerade aufgezeichnet wird (Start innerhalb von 5 Minuten), wird nie doppelt übernommen. Sonst wird die History nie wieder gelesen.
- **Zwei Läufe kurz hintereinander:** Eine Aufzeichnung bleibt nach dem Ende bis zu 30 ruhige Minuten offen. Startet in dieser Zeit ein neues Programm, wird sie beim Speichern geteilt, wenn zwischen dem gemeldeten Ende und dem neuen Start mindestens 3 Minuten Ruhe auf dem Pegel nach einem Ende lagen (und die Pausen im Programm deutlich darunter oder darüber liegen); ebenso an jedem Start nach einer Sperrphase der Schlussphase. Jeder Teil ist ein eigener Lauf. Zwei richtig gemeldete Läufe lösen so keine Reparatur aus; eine lange Pause mitten im Programm mit einem Fertig dazwischen bleibt ein zerteilter Lauf und wird repariert.
- **Welche Läufe zählen:** Die **Zielmenge** sind die von der Laufprüfung zugelassenen Läufe der letzten 30 Tage (für Gewinn und Mindestzahlen), die **Prüfmenge** zusätzlich alle Grenzläufe jeden Alters. Jeder Kandidat wird mit der echten Erkennung über die zugelassenen Läufe der Prüfmenge und die zugelassenen Fehlstarts nachgespielt (höchstens 60 Läufe: alle Grenzläufe und je Programmgruppe die neuesten); eine Änderung wird nur übernommen, wenn jeder Lauf genau einmal erkannt wird, kein Fehlstart einen Lauf startet und das Ende nie zu früh gemeldet wird (Kriterium „Ende nicht zu früh“ mit dem Programmende aus dem Laufspeicher). Läufe in Quarantäne zählen dabei nicht; für sie gilt nur „kein Rückschritt“: ein Kandidat darf keinen davon schlechter erkennen als die aktuellen Werte. Bereits gesehene Programme können dadurch nicht kaputtgehen.
- **Zwei Läufe als einer sind kein Fehler:** Meldet die Erkennung zwei echte Läufe als einen (das Gerät lief ja durchgehend), ist das in Ordnung, solange das echte Ende des Gesamtlaufs erkannt wird. Ein zusammengewachsener Lauf wird nur auf dieses Ende geprüft, ebenso zwei direkt aufeinander folgende Läufe, die neue Werte zusammen melden würden; es gibt dafür keine Reparatur, keine kürzere Wartezeit und keinen Hinweis. Wird das Ende des Gesamtlaufs nicht oder zu früh erkannt, wird repariert.
- **Reparatur hat Vorrang** (vorsichtigere Werte): sofort nach einem zugelassenen Lauf, den die aktuellen Werte nicht oder nicht richtig erkennen (Start fehlt, Ende zu früh, Lauf zerteilt, Ende nicht erkannt, Start nach dem Ende), auch wenn er nur um eine Abfrage verfehlt wird. Sie gilt ohne Mindestzahl, ohne Abstand, auch während einer Sperre oder einer Drift und ohne Schrittgrenzen (nur die harten Wertgrenzen), bis dieser und alle anderen zugelassenen Läufe stimmen; der auslösende Lauf wird Grenzlauf. Läufe in Quarantäne und unbrauchbare Läufe lösen keine Reparatur aus. Eine Reparatur verkürzt nie eine Wartezeit der aktuellen Werte und hält den Start länger als den längsten je gesehenen Stoß und das Ende länger als die längste je gesehene Pause, solange solche Werte jeden Lauf erkennen. Danach 5 Läufe und 14 Tage keine Verschärfung. Haben die bisherigen Werte das Ende eines Laufs nie gemeldet (das Gerät steht noch auf „läuft“, wenn die Aufzeichnung des Laufs schließt, spätestens nach 12 Stunden), wird der Lauf direkt nach der Reparatur mit der üblichen Fertig-Meldung beendet, und der nächste Lauf wird mit den neuen Werten erkannt. Ein einzelner kurzer Ausschlag gilt als Handtest (Quarantäne); ein Fehlstart zählt ab dem zweiten.
- **Verschärfung** (Ende früher, z. B. Nachlauf-Filter an) erst ab **8 zugelassenen Läufen der letzten 30 Tage** (beim Anlernen reichen 2), 2 neuen Läufen und 24 Stunden seit der letzten Änderung, nur über die Läufe der Zielmenge (kein zusammengewachsener Lauf), mit höchstens 25 % Änderung je Schritt (Schwellwerte 30 %), Gegenprobe ohne jede Programmgruppe, leicht veränderten Eingangsdaten (±10 % Leistung, eine Abfrage später, fehlende Werte) und Grenzen aus der längsten je gesehenen Pause und dem längsten Stoß. Sie braucht mindestens eine Minute Gewinn (oder weniger Fehlstarts). Eine Verschärfung schaltet den Nachlauf-Filter nur hinter einem Endblock wie den gesehenen ein (`trailerBlockVal`), damit ein noch nicht gesehenes Programm mit Einweichen seine Stöße behält. Scheitert ein Kandidat nur an einem einzigen Lauf, wird dieser Lauf Grenzlauf (Veto) und nicht verdrängt, bis ein später übernommener Kandidat ihn besteht.
- **Schlussphase automatisch:** Die Optimierung schaltet die [Schlussphase](#schlussphase) ohne Rückfrage selbst ein, aber erst ab **10 zugelassenen Läufen der letzten 30 Tage** und **2 Läufen je Programmgruppe**, außerhalb einer Sperre und ohne Drift. Ihre Werte werden aus den Läufen der Prüfmenge gelernt und nur übernommen, wenn sie dort freigegeben werden (jeder Lauf früher und nie zu früh gemeldet, Gegenprobe ohne jeden Lauf bzw. jede Programmgruppe, ±10 % Leistung, gröbere Abfrage, fehlende Werte, eine Abfrage später, mindestens eine Minute Gewinn) und jeder zugelassene Lauf richtig erkannt wird; kein Lauf darf später enden, kein Lauf in Quarantäne schlechter. Eintrag „Schlussphase eingeschaltet“, Nachricht nur mit „Änderungen als Nachricht melden“; **Rückgängig** schaltet sie wieder aus. Der State `settlingUntil` wird dabei angelegt bzw. entfernt. Die übrigen Kandidaten der Optimierung übernehmen die Schlussphase unverändert; sie wird nie still ausgeschaltet.
- **Schlussphase nachführen:** Wie eine Verschärfung (8 zugelassene Läufe, 2 neue Läufe, 24 Stunden Abstand, keine Sperre, keine Drift) und mit denselben Mindestzahlen wie beim Einschalten wird sie neu gelernt und in kleinen Schritten angepasst: Untergrenze höchstens ±10 %, die Zeit im Schlussband steigt frei und sinkt höchstens 10 % (nur mit mindestens 5 abgedeckten Läufen), der früheste Beginn des Schlussblocks sinkt höchstens 25 %; die übrigen Werte kommen aus den Läufen (Eintrag „Schlussphase nachgeführt“).
- **Schlussphase aussetzen und reparieren:** Meldet die Schlussphase einen zugelassenen Lauf im Nachspielen zu früh oder hat die [Beurteilung im Nachhinein](#schlussphase) ein Programm als zerteilt gewertet, wird sie sofort ausgesetzt und direkt nach dem Lauf repariert, ohne Mindestzahl, auch während einer Sperre oder Drift und ohne Schrittgrenzen. Ein zerteiltes Programm wird dabei mit seinem frühen Teilstück als **ein** Lauf nachgespielt (die Schlussphase darf kein Ende früher melden als die Werte ohne sie). Zeigt das, dass das frühe Ende richtig war, gilt sie sofort wieder. Sonst wird die nächstliegende sichere Einstellung gesucht (längere Zeit im Schlussband, späterer Schlussblock, engeres Schlussband); erkennt sie jeden zugelassenen Lauf, gilt die Schlussphase mit diesen Werten wieder (Einträge „Schlussphase repariert“ und „Schlussphase wieder verwendet“, danach 5 Läufe und 14 Tage keine Verschärfung), sonst bleibt sie ausgesetzt (Log `final phase stays suspended`). Läufe in Quarantäne lösen nichts aus.
- **Phasen feinjustieren:** Hat das Gerät eingeschaltete [Phasen](#phasen), werden die Grenzen der vorhandenen Phasen aus den zugelassenen Läufen nachgeführt: Bandgrenzen höchstens ±15 % je Schritt, die Dauerbereiche der Phasen (z. B. „Zwischenschleudern“ bis 2 min) und bei einer Ereignisphase (Zündung) Bestätigungszeit und Nachlauf. Übernommen wird ein Vorschlag erst, wenn zwei Prüfungen hintereinander denselben Vorschlag ergeben und die Gegenprobe (jeder Lauf mit den ohne ihn gelernten Grenzen nachgespielt) nicht schlechter übereinstimmt als bisher. Phasen werden nie angelegt, entfernt oder umbenannt; IDs, Namen und Meldungen bleiben. Die Grenzen stehen in den Anlerndaten, gelten nur für das Phasenmodell, für das sie berechnet wurden (ein neu angelerntes Modell beginnt ohne sie), wirken zwischen zwei Läufen und ändern nie die Start- oder Ende-Erkennung; **Zurücksetzen** verwirft sie. Taucht in mindestens 3 Läufen ein Abschnitt auf, zu dem keine Phase passt, kommt einmal der Hinweis „Neue Phase gefunden“ (Log, Nachricht nur mit „Änderungen als Nachricht melden“).
- **Rechenzeit (Budget):** Jeder Auftrag nach einem Lauf darf höchstens 30 Sekunden **aktive Rechenzeit** verbrauchen (die Zeit, in der der Adapter anderen Aufgaben Vorrang gibt, zählt nicht). Der günstige Teil – Laufprüfung, Prüfung über alle zugelassenen Läufe, Reparatur und Aussetzen – läuft immer vollständig. Die aufwendigen Schritte (Schlussphase einschalten bzw. nachführen, Verschärfung, Phasen feinjustieren) laufen reihum: Reicht die Zeit nicht, wird der Schritt ohne Änderung abgebrochen, sein Fortschritt gespeichert, und der nächste Auftrag macht dort weiter (auch nach einem Neustart). Die Freigabe der Schlussphase und die Gegenprobe der Phasen laufen höchstens einmal am Tag und nur, wenn seitdem neue zugelassene Läufe dazukamen; dieselben Läufe werden nie zweimal durchsucht. `learning.optimizeInfo` zeigt `jobMs` (Rechenzeit des letzten Auftrags) und `budget` (Aufträge in Folge, die das Zeitbudget abgebrochen hat, Status `budget`). Ab dem 3. Mal in Folge gibt es die Warnung `optimisation too slow on this system (3 jobs in a row)` im Log und auf der Gerätekarte (Nachricht nur mit „Änderungen als Nachricht melden“). Ein Gerät mit vielen Läufen am Tag (z. B. ein Kessel) belastet das System so nur mit dem günstigen Teil je Lauf.
- Die optimierten Werte werden je Gerät gespeichert und gelten nur, solange die Option an ist; aus bedeutet wieder die Erkennungswerte des Geräts (Verhalten von 3.1.2). Es gibt drei Ebenen: die **Grundwerte** (die Erkennungswerte im Gerät, nur du änderst sie), die **wirksamen Werte** (Grundwerte mit den optimierten Werten; mit ihnen wird optimiert und angezeigt) und die **aktiven Werte**, mit denen die Erkennung tatsächlich läuft (wie die wirksamen Werte; nur eine ausgesetzte Schlussphase ist darin ausgeschaltet, ohne die Grundwerte oder die optimierten Werte zu ändern).
- Änderst du die Grundwerte (Gerätedialog, Anlernen), gilt das sofort ohne Neustart: Die optimierten Werte werden verworfen (Eintrag „Erkennungswerte geändert“), läuft gerade ein Lauf, gelten die neuen Werte ab dem nächsten Lauf. Ändern sich die Grundwerte, während eine Optimierung rechnet, wird ihr Ergebnis verworfen (Log `base values changed during the optimisation, result discarded`). **Als Grundwerte übernehmen** (Aktion im Optimierungsdialog) schreibt die wirksamen Werte als Grundwerte ins Gerät; danach gibt es keine optimierten Werte mehr, die Erkennung bleibt genau gleich (Eintrag „Als Grundwerte übernommen“). Scheitert das Speichern des Geräts, bleibt alles wie vorher; wird die Instanz zwischen Speichern und Abgleich beendet, holt der nächste Start den Abgleich nach. Wird das Gerät gelöscht (auch in der Objektansicht), werden seine Anlerndaten samt deiner Entscheidungen über Läufe gelöscht; ein neues Gerät mit derselben ID beginnt leer. Können die Anlerndaten beim Start nicht gelesen werden, bleibt die Optimierung bis zum nächsten Start aus (Warnung im Log), damit die gespeicherten Daten nicht überschrieben werden.
- Erkennt keine Einstellung alle zugelassenen Läufe, bleiben die bisherigen Werte als sicherste bekannte Einstellung (Status `cannotCover`, Warnung `no values detect every admitted run, keeping the current values` und eine Warnung auf der Gerätekarte). Nach 3 solchen Läufen in Folge gilt **Drift** (Status `drift`, Hinweis „Das Gerät verhält sich anders als bisher; keine automatische Verschärfung mehr, Reparaturen laufen weiter. Neu anlernen oder Anlerndaten löschen.“, auch auf der Gerätekarte): dann gibt es keine Verschärfung, kein Einschalten oder Nachführen der Schlussphase und kein Feinjustieren der Phasen mehr, bis die Anlerndaten gelöscht oder die Werte zurückgesetzt werden; Reparaturen laufen weiter.
- **Hinweis zu einem Lauf in Quarantäne:** Erkennen die aktuellen Werte einen Lauf in Quarantäne nicht richtig, kommt genau einmal ein Hinweis: bei einem Grund, der ein echtes Programm sein kann (Fremdlast, Handtest), „Lauf vom … nicht richtig erkannt und ungewöhnlich – im Optimierungsdialog ‚verwenden‘ wählen“ (Log, `learning.optimizeInfo.review`, Warnung auf der Gerätekarte, Status `review`); bei einem Datenfehler (Lücke, hängender Wert, dünne Aufzeichnung) „Aufzeichnung gestört – Lauf wird nicht verwendet“ (nur Log). Als Nachricht an die Empfänger nur mit der Option „Änderungen als Nachricht melden“.
- States: `learning.optimized`, `learning.parameters`, `learning.lastChange`, `learning.optimizeInfo`, `learning.lastEndDelay`; `learning.undo` macht die letzte Änderung rückgängig (nicht über eine Änderung der Grundwerte des Geräts hinweg und nur, wenn die Werte davor alle zugelassenen Läufe erkennen; sonst Warnung im Log), `learning.reset` kehrt zu den Grundwerten des Geräts zurück (beide sperren die Verschärfung für 14 Tage). Mit der Option „Änderungen als Nachricht melden“ wird jede Änderung auch an die Empfänger des Geräts geschickt, in der Sprache der Installation (das Log ist englisch).
- Die Aktion **Optimierung** auf der Gerätekarte (sichtbar, solange die Option an ist oder Anlerndaten vorhanden sind) zeigt den Status, die Behandlung des Nachlaufs, jeden Erkennungswert des Geräts neben dem verwendeten Wert (geänderte Werte sind mit `*` markiert), die gespeicherten Läufe der letzten 30 Tage und die letzten Änderungen. Die Tabelle der Läufe hat je Lauf Datum, Dauer, Programmgruppe, Quelle (live oder History), Einordnung mit den Befunden der Laufprüfung, **Verwendung** (Auto, Verwenden, Nicht verwenden), **Grenzlauf** und ob die aktuellen Werte ihn erkennen (✓/✗). Ein Grenzlauf ist ein Lauf, der allein eine Sicherheitsgrenze setzt oder eine Änderung gestoppt hat; die Spalte nennt die Grenze, ihren Wert und den Wert ohne ihn. Unter **Aktion** kannst du:
  - **Verwendung eines Laufs festlegen:** einen Lauf ausschließen (er wird nicht mehr nachgespielt und setzt keine Grenze mehr), verwenden (obwohl ihn die Laufprüfung zurückhält, z. B. ein Handtest, der ein echtes Programm war) oder wieder der Laufprüfung überlassen. Die Entscheidung bleibt über den Startzeitpunkt des Laufs gespeichert, auch für einen späteren Import aus der History. Vor dem Ausschließen eines Grenzlaufs warnt der Dialog: „Wenn dieser Lauf echt war, kann ein solcher Lauf künftig zu früh als fertig gemeldet werden.“ Schließt du einen Grenzlauf aus, der die letzte Reparatur ausgelöst hat, und erkennen die Werte vor der Reparatur alle übrigen zugelassenen Läufe, wird die Reparatur zurückgenommen (Eintrag „Reparatur zurückgenommen“) und die Sperre aufgehoben. Verwendest du einen Lauf (wieder), den die aktuellen Werte nicht richtig erkennen, wird sofort repariert, so dass Grenzen und Werte wieder so sind wie vorher.
  - die **letzte Änderung rückgängig machen:** nur bis zur letzten Änderung der Grundwerte und nur, wenn die Werte davor jeden zugelassenen Lauf richtig erkennen. Sonst nennt der Dialog die Läufe, die scheitern würden, und bietet bei einer Reparatur, die ein Grenzlauf ausgelöst hat, an, genau diesen Lauf auszuschließen und danach rückgängig zu machen (sonst würde der nächste Lauf sofort wieder reparieren).
  - auf die Erkennungswerte des Geräts **zurücksetzen**;
  - die **Anlerndaten löschen** (nach einer Rückfrage; deine Entscheidungen über Läufe bleiben erhalten, außer du setzt den Haken „Auch meine Entscheidungen zu Läufen verwerfen“);
  - die verwendeten Werte **als Grundwerte übernehmen** (nach einer Rückfrage mit den Änderungen, ohne Neustart);
  - die **Schlussphase wieder einschalten**, wenn sie ausgesetzt ist, und bei einer Zerteilung „**Der Lauf nach dem frühen Ende war ein neuer Lauf**“ wählen: Das frühe Ende gilt dann als richtig, und die Schlussphase wird wieder verwendet, sofern kein anderer Lauf als zerteilt gilt (auch ohne automatische Optimierung);
  - **Altgrenzen verwerfen** (nach einer Rückfrage; nur wenn die Anlerndaten aus einer früheren Version Grenzen mitbringen): Die Grenzen kommen danach nur noch aus den gespeicherten Läufen.
  Solange die Option aus ist, werden nur das Festlegen der Verwendung und das Löschen angeboten.

Grenzen: Ein Neustart des Adapters während eines Laufs verliert diesen Lauf (ein Neustart nach dem Ende wird fortgesetzt); ein nie gesehenes Programm ist nur durch die Grenzen und Sicherheitsabstände geschützt und wird nach einem fehlerhaften Lauf repariert; eine Änderung des Abfrageintervalls oder der Einheit des Leistungs-States rechnet die gespeicherten Läufe um (gröberes Raster: Wert am Rasterpunkt; feineres Raster: Wiederholung, solche Läufe zählen nicht mehr für den Nachlauf), die Grenzen bleiben erhalten.

## 9. Migration von 3.1.2

Beim ersten Start von Version 4 wird eine 3.1.2-Konfiguration automatisch umgewandelt. Alle neuen Optionen bleiben aus, jedes migrierte Gerät verhält sich also wie in 3.1.2.

Übernommen werden:

- Geräte (Name, Leistungs- und Schalt-State, Texte, Abbruch, Auto-Aus, Empfänger) mit den Erkennungswerten ihres Gerätetyps,
- Empfänger aller neun Messenger von 3.1.2 (IDs bleiben erhalten),
- Statustexte,
- die Werte der alten States: letzte Läufe, letzte Laufzeit, Nicht stören und maximale Laufzeit.

Geräte mit gleichem Namen oder mit Umlauten, Leerzeichen oder Punkten im Namen erhalten eindeutige, gültige Objekt-IDs.

### Gerätetypen werden zu Werten im Gerät

Version 4 kennt keine Gerätetypen mehr, die Erkennungswerte stehen im Gerät (siehe [Erkennungswerte und Vorlagen](#3-erkennungswerte-und-vorlagen)). Die Migration sucht den Typ jedes Geräts genau wie 3.1.2: zuerst unter den Standardtypen mit exakt gleichem Namen (Groß-/Kleinschreibung und Leerzeichen zählen mit; gibt es mehrere Zeilen mit diesem Namen, gilt die letzte), nur ohne Treffer unter den eigenen Typen. Die fünf Werte des Typs (Startwert, Endwert, Standby-Wert, Start- und Endanzahl) werden in das Gerät kopiert, dazu der Modus **Anzahl**; Pausenschutz, Nachlauf-Filter und alle anderen neuen Optionen bleiben aus. Kommt der Typ aus den Standardtypen, merkt sich das Gerät die passende Vorlage (Waschmaschine, Trockner, Geschirrspüler).

- **Geteilte Typen:** Nutzen mehrere Geräte denselben Typ, bekommt jedes Gerät eine eigene Kopie der Werte. Änderst du später ein Gerät, gilt das nur für dieses Gerät.
- **Vorlage oder eigene Werte:** Hat der Typ eines Geräts noch die Werte einer eingebauten Vorlage, behält das Gerät diese Vorlage (die Karte zeigt sie); wurden die Werte des Typs in 3.1.2 geändert, hat das Gerät eigene Werte.
- **Typ nicht exakt gefunden:** 3.1.2 meldete ein solches Gerät einmal als gestartet und nie als fertig. Version 4 übernimmt es vollständig, aber **deaktiviert** und mit einem Hinweis im Log und auf der Gerätekarte, woher die Werte stammen: von einem Typ, dessen Name nur ohne Groß-/Kleinschreibung oder Leerzeichen am Rand passt; sonst von dem eigenen Typ, der ursprünglich `customN` hieß und später umbenannt wurde (Gerätetyp `custom3` → dritte Zeile der eigenen Typen); sonst von der Vorlage **Benutzerdefiniert** (30 / 5 / 1 / 1 / 20). Prüfe die Werte, speichere das Gerät im Geräteformular und aktiviere es.
- **Archiv:** Eigene oder geänderte Typen, die kein Gerät nutzt und deren Werte oder Name von der Vorlage abweichen, bleiben mit Name und Werten als Archiv-Vorlagen erhalten. Unveränderte Typen entfallen, ihre Werte liefern die eingebauten Vorlagen.
- **Nichts geht still verloren:** Ein Typ-Kommentar wird nicht übernommen. Ein leerer oder nicht numerischer Typwert wird durch den Wert der Vorlage ersetzt, ein negativer durch 0; ein Wert mit Komma (`12,5`) wird als Zahl gelesen (3.1.2 startete mit so einem Wert nie). Ein SayIt- oder WhatsApp-Ziel, das von dem aus der Instanz abgeleiteten Ziel (`<Instanz>.tts.text` bzw. `<Instanz>.sendMessage`) abweicht, wird ersetzt. Jeder dieser Fälle steht mit altem und neuem Wert als Warnung im Log.

Entfernt werden nur die States, die 3.1.2 angelegt hat. Migrationswarnungen (unbekannte Felder, nicht exakt gefundene Gerätetypen, ersetzte Werte und Ziele, nicht mehr vorhandene Empfänger, nicht vorhandene Leistungs-States) stehen im Log und brechen die Migration nicht ab. Schlägt die Migration selbst fehl, bleibt die Konfiguration unverändert und der Adapter läuft weiter.

### Verhaltensänderungen durch die vollständige Übernahme

Diese Einstellungen hat 3.1.2 gespeichert, aber nicht oder anders verwendet. Version 4 nutzt sie so, wie sie eingetragen sind:

- **Pushover:** 3.1.2 sendete Priorität und Gerät nie mit; Version 4 sendet die eingetragenen Werte (auch die TTL, eine leere TTL bleibt leer).
- **Telegram:** Benutzername, Vorname und Chat-ID gehen an die Felder des telegram-Adapters (`user` bzw. `chatId`) statt an `username`, `firstname` oder `chatID`.
- **Matrix:** Nachrichten gehen an die Instanz `matrix-org.N` des Matrix-Adapters statt an `matrix.N`.
- **Zeitfenster:** Ein Zeitfenster über Mitternacht (zum Beispiel 22:00 bis 06:00) gilt jetzt; gleiche Anfangs- und Endzeit heißt „immer“.

### Testversionen von Version 4

Hast du eine Testversion von Version 4 mit Gerätetypen genutzt, wandern deren Werte beim ersten Start in die Geräte, ohne Neustart der Instanz. Jedes Gerät bekommt eine eigene Kopie der Werte seines Typs, gefunden genau wie in der Testversion (fehlende Standardtypen und eine leere Typtabelle liefern die Standardwerte). Kommt der Typ aus den eingebauten Typen, merkt sich das Gerät die passende Vorlage. Alle anderen Einstellungen des Geräts bleiben unverändert, ebenso die Werte der automatischen Optimierung. Die Typtabelle der Instanz wird nur gelesen und bleibt als Archiv erhalten.

- **Typ nicht gefunden:** Die Testversion hat ein solches Gerät ignoriert. Version 4 gibt ihm die Werte der Vorlage **Benutzerdefiniert**, **deaktiviert** es und zeigt einen Hinweis im Log und auf der Gerätekarte. Prüfe die Werte, speichere das Gerät im Geräteformular und aktiviere es.
- **Gerät konnte nicht geschrieben werden:** Es steht eine Warnung im Log, das Gerät läuft mit den Werten seines Typs weiter, und beim nächsten Start wird es erneut versucht. Bereits umgestellte Geräte werden übersprungen.

### Was sich beim Update für dich ändert

**Bleibt gleich**

- Erkennung: Jedes migrierte Gerät nutzt den Erkennungsmodus **Anzahl** mit den Schwellwerten aus 3.1.2 und erkennt Start und Ende genau wie vorher. Alle neuen Funktionen (andere Erkennungsmodi, Pausenschutz, Nachlauf-Filter, Erinnerungen, Aktionen, automatische Optimierung) sind aus.
- Nachrichten: Start- und Endtexte, Empfänger und Statustexte werden übernommen.
- Wertformate: `runtime` und `lastRuntime` als `hh:mm:ss`, `lastOperations` als JSON-Array mit `start`, `end` (`DD.MM.YYYY hh:mm:ss`) und `runtime`, höchstens 14 Einträge.
- Die Werte von `last operations`, `lastRuntime`, `do not disturb` und `runtime max` werden in die neuen States kopiert.

**Ändert sich**

| Bereich | 3.1.2 | Version 4 |
| --- | --- | --- |
| Geräte konfigurieren | Tabelle in den Instanz-Einstellungen | Device Manager (Reiter **Geräte**), ein Formular je Gerät; Änderungen wirken ohne Neustart der Instanz |
| Gerätetypen | Tabellen „Standard“ und „Eigene“, von mehreren Geräten geteilt | keine Typen mehr: jedes Gerät hat eigene Erkennungswerte; beim Anlegen liefert eine Vorlage die Startwerte, Anlernen passt sie an |
| Empfänger | eine Tabelle je Messenger, im Gerät angehakt | Reiter **Empfänger** mit einer Liste aller Empfänger, im Gerät ausgewählt; neu sind ntfy, Pushsafer und Gotify |
| Objektstruktur | States direkt unter `<Name>` (Ordner) | ein Geräteobjekt `<deviceId>` mit States, wie bei anderen ioBroker-Adaptern |
| Objekt-ID | Gerätename unverändert (mit Leerzeichen und Umlauten) | aus dem Namen gebildet: klein, Umlaute umgeschrieben (`ä` → `ae`), Leerzeichen und Punkte → `_`, doppelte Namen erhalten `_2`, `_3` … |
| State-Namen | mit Leerzeichen (`live consumption`) | camelCase ohne Leerzeichen (`consumption`) |
| Rollen | alle `indicator` | passende Rollen (`value.power`, `text`, `json`, `indicator.alarm`, `switch.enable`, `level` …), damit Visualisierungen und der Type-Detector die States erkennen |
| Name der States | `live consumption Waschmaschine` | `Aktueller Verbrauch` in 11 Sprachen; das Gerät ist das Geräteobjekt |

Beispiel: Ein Gerät „Wäsche Keller“ hatte in 3.1.2 den State `device-reminder.0.Wäsche Keller.live consumption`, in Version 4 heißt er `device-reminder.0.waesche_keller.consumption`.

**Was du nach dem Update tun musst**

1. Im Log nach Migrationswarnungen sehen (zum Beispiel fehlende Leistungs-States oder Empfänger). Geräte, deren Typ nicht exakt gefunden wurde, sind deaktiviert: Werte prüfen, speichern und das Gerät aktivieren.
2. Skripte, Blockly, Szenen und Visualisierungen auf die neuen IDs umstellen (Tabelle unten). Die alten States werden gelöscht.
3. War ein History-Adapter auf einem alten State aktiv (zum Beispiel `live consumption`), ihn auf dem neuen State aktivieren. Die alten Aufzeichnungen bleiben in der Datenbank, gehören aber nicht zum neuen State.
4. Optional: die neuen Funktionen je Gerät einschalten.

### Alte und neue State-IDs

| 3.1.2 | Version 4 | Typ, Rolle (V4) | Wert übernommen | Hinweis |
| --- | --- | --- | --- | --- |
| `<Name>.Status` | `<deviceId>.status` | string, text | – | Statustexte aus 3.1.2 |
| `<Name>.live consumption` | `<deviceId>.consumption` | number, value.power (W) | – | Livewert |
| `<Name>.average consumption` | `<deviceId>.averageConsumption` | number, value.power (W) | – | Livewert |
| `<Name>.runtime in ms` | `<deviceId>.runtimeMs` | number, value (ms) | – | |
| `<Name>.messageDP` | `<deviceId>.message` | string, text | – | letzter gesendeter Text |
| `<Name>.alert runtime` | `<deviceId>.alertRuntime` | boolean, indicator.alarm | – | |
| `<Name>.last operations` | `<deviceId>.lastOperations` | string, json | ja | gleiches JSON-Format |
| `<Name>.config.do not disturb` | `<deviceId>.config.doNotDisturb` | boolean, switch.enable | ja | beschreibbar |
| `<Name>.config.runtime max` | `<deviceId>.config.runtimeMax` | number, level (min) | ja | beschreibbar |

Unverändert heißen `runtime` und `lastRuntime` (Wert von `lastRuntime` wird übernommen). Sie liegen nur unter dem neuen Geräteobjekt.

Neu in Version 4 (siehe [State-Referenz](#13-state-referenz)):

- `running`, `finished`, `lastFinished`: läuft, fertig (bis zur Quittierung), Zeitpunkt des letzten Endes. 3.1.2 kannte dafür nur den Statustext.
- `acknowledge`: quittiert die Fertig-Meldung und stoppt Erinnerungen.
- `lastOperationsHtml`: HTML-Tabelle der letzten Läufe (nur wenn eingeschaltet).
- `antiCrease`: Nachlauf läuft.
- `learning.*`: Anlernen und automatische Optimierung.
- `info.connection` an der Instanz.

## 10. Blockly

Für die States des Geräts reichen die Standard-Blöcke des JavaScript-Adapters, eigene Blöcke dafür gibt es nicht:

| Aufgabe | Standard-Block | State |
| --- | --- | --- |
| auf Fertig reagieren | Trigger „falls Objekt“ | `<deviceId>.finished` (true) |
| Status lesen | „Wert von Objekt-ID“ | `<deviceId>.status` |
| quittieren | „steuere“ mit true | `<deviceId>.acknowledge` |
| Nicht stören | „steuere“ mit true/false | `<deviceId>.config.doNotDisturb` |

Der Adapter bringt einen eigenen Block mit (11 Sprachen):

- **Nachricht senden über device-reminder an … Text …**: sendet einen beliebigen Text an einen hier eingerichteten Empfänger oder an **alle Empfänger**. Es gelten die Einstellungen der Empfänger (Messenger, Zeitfenster, Lautstärke der Sprachausgabe). Der Block bietet die Empfänger der Instanz als Liste an.

Skript-Beispiel: reagieren, wenn ein Gerät fertig ist (JavaScript-Adapter):

```js
on({ id: "device-reminder.0.waschmaschine.finished", change: "ne" }, obj => {
	if (obj.state.val === true) {
		sendTo("device-reminder.0", "send", { recipients: "*", text: "Waschmaschine ist fertig" });
		setState("device-reminder.0.waschmaschine.acknowledge", true);
	}
});
```

## 11. sendTo-API

```js
sendTo("device-reminder.0", "send", { recipients: ["telegram-abc1"], text: "Hallo" }, result => log(JSON.stringify(result)));
```

| Kommando | Nachricht | Antwort |
| --- | --- | --- |
| `list` | keine | `[{ id, name }]` aller Geräte |
| `send` | `{ recipients, text, doNotDisturb? }`: `recipients` ist eine Empfänger-ID, eine Liste von IDs oder `"*"` für alle aktiven Empfänger; `doNotDisturb: true` unterdrückt Sprachausgaben | `{ ok, sent, skippedWindow, unknown }` (gesendet, wegen Zeitfenster übersprungen, unbekannte IDs) oder `{ ok: false, error: "missingText" \| "missingRecipient" }` |
| `testRecipient` | `{ id }` (Empfänger-ID) | Ergebnis der Testnachricht oder `{ ok: false, error: "missingRecipient" }` |

Status, Quittieren und Nicht stören laufen über die States des Geräts (siehe [State-Referenz](#13-state-referenz)).

## 12. vis-2-Widgets

Der Adapter bringt zwei Widgets für vis-2 mit (Widget-Set `deviceReminder`):

- **Gerätekarte**: Status, aktuelle Leistung, Laufzeit, geschätzter Fortschritt und Restzeit (aus früheren Läufen), Schaltflächen für Quittieren und Nicht stören und eine einklappbare Laufhistorie. Das Geräteobjekt wählst du über `oid`; optional kompakte Darstellung und Farben für läuft, fertig und Alarm.
- **Geräteübersicht**: kompakte Liste aller Geräte einer Instanz mit Status, Leistung, Laufzeit und Fertig-Anzeige. Ein Klick quittiert das Gerät.

## 13. State-Referenz

<!-- BEGIN STATES -->
Gerätezustände sind relativ zum Geräteobjekt `<deviceId>` angegeben. Info-Zustände liegen an der Adapterinstanz.

| ID | Typ | Rolle | rw | Einheit | Name | Beschreibung |
| --- | --- | --- | --- | --- | --- | --- |
| `status` | string | text | r | - | Status | Statustext (Statustexte: in action / standby / switched off) |
| `consumption` | number | value.power | r | W | Aktueller Verbrauch | Letzter Leistungswert in W |
| `averageConsumption` | number | value.power | r | W | Durchschnittlicher Verbrauch | Mittelwert der von der Erkennung genutzten Abfragen |
| `runtime` | string | text | r | - | Laufzeit | Laufzeit des aktuellen Laufs als hh:mm:ss |
| `runtimeMs` | number | value | r | ms | Laufzeit in ms | Laufzeit des aktuellen Laufs in ms |
| `lastRuntime` | string | text | r | - | Letzte Laufzeit | Laufzeit des letzten beendeten Laufs |
| `message` | string | text | r | - | Letzte Nachricht | Letzter an das Gerät gelieferter Nachrichtentext |
| `alertRuntime` | boolean | indicator.alarm | r | - | Laufzeitalarm | True, wenn die Laufzeit config.runtimeMax überschreitet |
| `lastOperations` | string | json | r | - | Letzte Vorgänge | JSON-Array der letzten Läufe (Start, Ende, Laufzeit), höchstens 14 |
| `running` | boolean | indicator.working | r | - | Läuft | True, solange ein Lauf aktiv ist |
| `finished` | boolean | indicator | r | - | Fertig | True nach einem beendeten Lauf bis zur Quittierung |
| `lastFinished` | number | date | r | - | Zuletzt fertig | Zeitstempel des letzten Endes |
| `acknowledge` | boolean | button | w | - | Quittieren | true schreiben zum Quittieren; stoppt Erinnerungen und führt die Aktionen für acknowledged aus |
| `config.doNotDisturb` | boolean | switch.enable | rw | - | Nicht stören | Unterdrückt Sprachausgaben dieses Geräts |
| `config.runtimeMax` | number | level | rw | min | Maximale Laufzeit | Maximale Laufzeit in Minuten; darüber wird alertRuntime true |
| `learning.start` | boolean | button.start | w | - | Anlernen starten | true schreiben startet die Aufnahme eines Laufs |
| `learning.stop` | boolean | button.stop | w | - | Anlernen beenden | true schreiben beendet die Aufnahme und berechnet den Vorschlag |
| `learning.active` | boolean | indicator | r | - | Anlernen aktiv | True, solange ein Lauf aufgenommen wird |
| `learning.result` | string | json | r | - | Anlern-Ergebnis | JSON: Schwellwerte, startDurationSec, endDurationSec, durationSec, samples, pauseHoldSec, pauseUntilSec, pauseBelowVal, mode, runs, evaluation (aus der History zusätzlich looDetected, longestPauseSec, current, gapsDropped), bei einem Nachlauf zusätzlich trailerBurstSec, trailerGapSec, trailerAfterSec, trailerBlockVal, trailerMaxSec, trailer (none, used, notSeparable), trailerRuns, delays (Ende-Verzögerung je Lauf ab Programmende, s) und falseStarts, nach einer Aufnahme zusätzlich checks (Befunde der Laufprüfung: invalid, gap), oder ein Fehler (tooFewSamples, noRun) |
| `antiCrease` | boolean | indicator | r | - | Nachlauf aktiv | True, solange der Nachlauf nach einem Lauf erkannt wird (Nachlauf-Filter des Geräts) |
| `settlingUntil` | number | date | r | - | Sperrphase bis | Ende der laufenden Sperrphase der Schlussphase (frühes Fertig + Höchstdauer), sonst 0; ein Neustart setzt die Sperrphase bis dahin fort. Nur bei eingeschalteter Schlussphase (Werte des Geräts oder optimierte Werte) |
| `phase` | string | text | r | - | Aktuelle Phase | Name der Phase, in der das Gerät gerade ist (leer außerhalb eines Laufs); nur bei eingeschalteten Phasen, nur beim Wechsel geschrieben |
| `phaseId` | string | text | r | - | Aktuelle Phase (ID) | ID der Phase (Systemphasen `antiCrease`, `afterRun`, `rest`, `unknown`); nur bei eingeschalteten Phasen |
| `phaseSince` | number | date | r | - | Aktuelle Phase seit | Beginn der aktuellen Phase; nur bei eingeschalteten Phasen |
| `phases` | string | json | r | - | Zeitleiste der Phasen | JSON-Array `{id, name, from, to}` des laufenden bzw. letzten Laufs (bei Geräten ohne Lauf der letzten 24 Stunden), höchstens 200 Einträge; nur bei eingeschalteten Phasen |
| `learning.optimized` | boolean | indicator | r | - | Optimierte Werte aktiv | True, wenn die automatische Optimierung andere Werte als die Erkennungswerte des Geräts verwendet |
| `learning.parameters` | string | json | r | - | Erkennungsparameter | JSON: base (Grundwerte des Geräts), override (optimierte Werte), effective (wirksame Werte: Grundwerte mit den optimierten Werten), active (Werte der Erkennung: wie effective, bei ausgesetzter Schlussphase mit `finalMinVal` 0) |
| `learning.lastChange` | string | json | r | - | Letzte Änderung der Optimierung | JSON der letzten Änderung der automatischen Optimierung (kind, from, to, reason, runs, gainSec) |
| `learning.optimizeInfo` | string | json | r | - | Status der Optimierung | JSON: status, runs, spikes, families, trailer, lastCheckTs, nextPossibleTs, lastEndDelaySec, unclear, excluded, finalState, review, budget (Aufträge in Folge, die das Zeitbudget abgebrochen hat; 0 nach einem vollständigen Auftrag), jobMs (aktive Rechenzeit des letzten Auftrags in ms) |
| `learning.lastEndDelay` | number | value.interval | r | s | Ende-Verzögerung des letzten Laufs | Zeit vom Programmende bis zur Ende-Meldung des letzten aufgezeichneten Laufs |
| `learning.undo` | boolean | button | w | - | Letzte Optimierung rückgängig machen | true schreiben macht die letzte Änderung der automatischen Optimierung rückgängig (14 Tage keine Verschärfung) |
| `learning.reset` | boolean | button | w | - | Auf die Grundwerte des Geräts zurücksetzen | true schreiben verwendet wieder die Grundwerte des Geräts ohne optimierte Werte (14 Tage keine Verschärfung) |
| `lastOperationsHtml` | string | html | r | - | Letzte Vorgänge (HTML) | HTML-Tabelle der letzten Läufe (nur wenn in den allgemeinen Einstellungen aktiviert) |
| `info.connection` | boolean | indicator.connected | r | - | Adapter verbunden | True, wenn der Adapter läuft |
<!-- END STATES -->

## 14. FAQ

**Warum erscheint das Gerät im Reiter „Geräte“ nicht unter „Native Geräte“?**
Der Geräte-Adapter listet nur Objekte, die einem Raum oder einer Funktion zugeordnet sind. Wähle im Geräte-Formular einen Raum oder eine Funktion (oder ordne das Geräte-Objekt, zum Beispiel `device-reminder.0.waschmaschine`, unter **Kategorien** zu); es erscheint dann als Leistungsmesser mit „läuft“-Anzeige.

**Meine Steckdose sendet nur bei Änderung. Das Gerät wird nie erkannt.**
Nutze für das Gerät den Erkennungsmodus **Zeit** (oder **Kombiniert**). Der Modus Anzahl braucht regelmäßige Werte.

**Alexa spricht auf einer Gruppe oder die Lautstärke wird nicht gesetzt.**
Trage im Empfänger den **Lautstärke-State** des Zielgeräts manuell ein. Die automatische Ableitung funktioniert nur für Einzelgeräte. Ohne brauchbaren Lautstärke-State wird der Text trotzdem gesprochen.

**Telegram erreicht meine Gruppe nicht.**
Wähle den Zieltyp „Chat-ID“ und trage die Chat-ID der Gruppe ein. Chat-IDs von Gruppen sind negativ (zum Beispiel `-1001234567890`).

**Die Fertig-Meldung kam nachts nicht an.**
Prüfe das Zeitfenster des Empfängers. Erinnerungen außerhalb des Fensters werden auf den nächsten Fensterbeginn verschoben. Sprachausgaben werden zusätzlich durch Nicht stören unterdrückt.

**Der Status bleibt „switched off“ und das Log zeigt eine Warnung.**
Der Leistungs-State des Geräts existiert nicht (zum Beispiel eine gelöschte Steckdose). Bearbeite das Gerät und wähle einen vorhandenen State.

**Wo ist meine alte 3.1.2-Konfiguration?**
Sie wird beim ersten Start umgewandelt und nicht aufbewahrt, weil sich jedes migrierte Gerät genau wie in 3.1.2 verhält. Wer zu 3.1.2 zurück möchte, legt vor dem Update ein Backup an (zum Beispiel mit BackItUp).
