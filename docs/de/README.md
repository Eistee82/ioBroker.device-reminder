![Logo](../../admin/device-reminder.png)

# device-reminder

Dokumentation des device-reminder-Adapters (Version 4). [English version](../en/README.md)

## Inhalt

1. [Überblick](#1-überblick)
2. [Einrichtung](#2-einrichtung)
3. [Gerätetypen und Erkennung](#3-gerätetypen-und-erkennung)
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
   - **Gerätetypen**: Schwellwerte und Erkennungsmodus je Typ (siehe [Gerätetypen und Erkennung](#3-gerätetypen-und-erkennung)).
   - **Empfänger**: wer Nachrichten erhält (siehe [Empfänger](#5-empfänger)).
   - **Allgemein**: Statustexte, Abfrageintervall und die optionale HTML-Historie.
3. Mindestens einen Empfänger anlegen, dann im Device Manager ein Gerät hinzufügen und den Empfänger im Formular auswählen.

Allgemeine Einstellungen:

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Statustexte | in action / standby / switched off | Text, der in den State `status` jedes Geräts geschrieben wird |
| Abfrageintervall | 10 s | Wie oft die Erkennung den letzten Leistungswert auswertet |
| Historie als HTML | aus | Schreibt zusätzlich `lastOperationsHtml` (HTML-Tabelle der letzten Läufe) |

## 3. Gerätetypen und Erkennung

Jedes Gerät nutzt einen Gerätetyp. Ein Typ enthält die Schwellwerte und den Erkennungsmodus. Mitgeliefert sind **Waschmaschine**, **Trockner** und **Geschirrspüler** sowie zehn bearbeitbare eigene Typen. Einen eigenen Typ füllst du von Hand oder durch [Anlernen](#8-anlernen).

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

### Erkennungsmodi

- **Anzahl** (Standard, identisch zu 3.1.2): Der Start wird erkannt, wenn der Mittelwert über die eingestellte Anzahl von Abfragen über dem Startwert liegt, das Ende nach der eingestellten Anzahl von Abfragen unter dem Endwert. Dieser Modus braucht eine Steckdose, die regelmäßig sendet.
- **Zeit**: Das Gerät startet, wenn die Leistung die Startdauer lang auf oder über dem Startwert bleibt, und ist fertig, wenn sie die Enddauer lang unter dem Endwert bleibt. Der Modus wird durch Wertänderungen und das Abfrageintervall getrieben und funktioniert daher auch mit Steckdosen, die nur bei Änderung senden.
- **Kombiniert**: Die anzahlbasierte Erkennung von 3.1.2 plus eine Mindestdauer über dem Startwert und unter dem Endwert. Beide Bedingungen müssen erfüllt sein.

### Abbrucherkennung

Ein Abbruch ist ein Gerät, das während des Laufs von Hand ausgeschaltet wird. Die Option **Abbrucherkennung** gilt je Gerät und ist standardmäßig aus. Löst sie aus, wechselt der Status auf „switched off“, und es wird keine Fertig-Nachricht gesendet.

- In 3.1.2 konnte die Abbrucherkennung bei den meisten Gerätetypen nie auslösen, weil ihr Standby-Puffer die nötige Länge nie erreichte. Dieses Verhalten bleibt erhalten, wenn nur **Abbrucherkennung** aktiv ist, die Geräte verhalten sich also genau wie in 3.1.2. Das gilt auch für die mitgelieferten Standardtypen.
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
- Bearbeitest du ein laufendes Gerät, läuft der aktuelle Zyklus weiter, solange Gerätetyp und Leistungs-State gleich bleiben. Sonst wird das Gerät zurückgesetzt und eine Info-Meldung geloggt.

## 4. Geräte anlegen

Öffne den Reiter **Geräte** und drücke **Gerät hinzufügen**. Es gibt drei Wege:

1. **Steckdose / Leistungsmesser**: Der Device Manager nutzt den ioBroker Type-Detector, um Steckdosen und Leistungsmesser (Schalt- und Leistungs-State) zu finden. Wähle eines aus, beide States werden eingetragen.
2. **Alias oder Gerät**: Wähle ein Alias- oder Geräteobjekt, der Type-Detector sucht darin einen passenden Leistungs-State.
3. **Manuelle Eingabe**: Trage den Leistungs-State (und optional einen Schalt-State) selbst ein.

Wird nichts Passendes gefunden, erscheint ein Hinweis und du kannst manuell eingeben.

Das Gerätformular enthält:

| Feld | Bedeutung |
| --- | --- |
| Name | Grundlage der Objekt-ID. IDs sind eindeutig und gültig: Umlaute werden umgeschrieben, Leerzeichen und Punkte werden zu `_`, Duplikate erhalten `_2`, `_3` ... |
| Gerätetyp | Einer der Typen aus dem Reiter **Gerätetypen** |
| Leistungs-State | State mit der Leistung in W (Pflicht) |
| Schalt-State | Optional, für Auto-Aus nötig |
| Starttext / Endtext | Nachrichtentexte |
| Abbrucherkennung | Siehe [Abbrucherkennung](#abbrucherkennung) |
| Auto-Aus | Schaltet die Steckdose die angegebene Zahl Minuten nach dem Ende aus |
| Empfänger | Empfänger, die die Nachrichten dieses Geräts erhalten |
| Räume / Funktionen | Ordnet das Geräte-Objekt ioBroker-Kategorien zu (Räume und Funktionen). Nötig zum Beispiel für den Reiter „Geräte“. Beim Löschen des Geräts wird die Zuordnung wieder entfernt |
| Erinnerung | Siehe [Erinnerungen und Quittierung](#6-erinnerungen-und-quittierung) |
| Aktionen | Siehe [Aktionen](#7-aktionen) |

Pflichtfelder werden vor dem Speichern geprüft.

Jede Gerätekarte zeigt Status, Leistung, Laufzeit, Anzeigen für „läuft“ und „fertig“ und eine Warnung bei fehlendem Leistungs-State. Auf der Karte kannst du das Gerät bearbeiten, löschen, aktivieren oder deaktivieren, Nicht stören schalten, quittieren, eine Testnachricht senden und das Anlernen starten. Die Details zeigen die letzten Läufe, die Schwellwerte des Typs und den Erinnerungsstatus.

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
| Ereignis | `start`, `end`, `reminder` oder `acknowledged` |
| State | Der fremde State, der geschrieben wird |
| Wert | Wert; wird in den Typ des Ziel-States umgewandelt (boolean, number oder string) |

Eine Aktion auf einen fehlenden State wird mit Warnung übersprungen und stoppt die anderen Aktionen nicht. Beispiel: Lampe einschalten, wenn die Waschmaschine fertig ist (`end`), und bei `acknowledged` wieder ausschalten.

## 8. Anlernen

Beim Anlernen werden Schwellwerte aus echten Läufen abgeleitet: aus der History des Leistungs-States oder aus einem aufgezeichneten Lauf.

### Aus der History

Wird der Leistungs-State von einem History-Adapter gespeichert (history, SQL, InfluxDB oder jeder andere Adapter, der `getHistory` beantwortet), wertet **Anlernen** auf der Gerätekarte zuerst die History aus. Nur wenn sie mindestens 2 vollständige Läufe enthält, fragt ein Dialog (mit der Zahl der gefundenen Läufe), ob aus der History angelernt oder ein neuer Lauf aufgezeichnet werden soll; sonst sagt der Dialog, warum, und zeichnet einen neuen Lauf auf. Die Standard-History aus den Systemeinstellungen wird bevorzugt. Du musst kein Programm wählen: Der Adapter unterscheidet keine Programme, der Gerätetyp muss **jeden** Lauf erkennen.

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
- Knitterschutz-Stöße eines Trockners nach dem Ende zählen zum Nachlauf. Die Startdauer bzw. Startanzahl wird so gewählt, dass sie keinen neuen Start auslösen.
- Eine Phase mit leicht erhöhter Leistung nach dem Lauf ist entweder die Trocknung einer Spülmaschine (gehört zum Lauf) oder ein Display bzw. die Türverriegelung (gehört nicht dazu). An der Leistung allein ist das nicht zu unterscheiden. Darum entscheidet der aktuelle Gerätetyp: Die Phase gehört zum Lauf, wenn sie mindestens 20 Minuten dauert und ihre Leistung nicht unter dem Endwert des aktuellen Typs liegt (der aktuelle Typ meldet dort also noch „läuft“, wie der Typ Spülmaschine mit 0,25 W). Sonst kommt die Fertig-Meldung kurz nach dem eigentlichen Lauf. Ein angelernter Typ behält diese Entscheidung beim nächsten Anlernen.
- Knitterschutz-Stöße mit Elektronik dazwischen sind nie eine Trocknung; das Ende wird nach dem Abkühlen gemeldet.
- `changesMinDelta` des History-Adapters wird beim Endwert berücksichtigt.

**Optimierung**

- Endwert und Ende-Wartezeit werden so gewählt, dass jeder Lauf genau einmal erkannt wird und das Ende so früh wie möglich kommt. Statt fester Faktoren wird die kürzeste sichere Endanzahl mit dem echten Erkennungscode gesucht.
- Bringt der [Pausenschutz](#pausenschutz) im Mittel mindestens 3 Minuten, wird er vorgeschlagen. Beispiel: Ein Lauf mit 22 Minuten Einweichen bei 0 W, Nachlauf bei 0,5 W. Ohne Pausenschutz müsste jeder Lauf über 27 Minuten auf die Fertig-Meldung warten. Mit „Pause, wenn Leistung unter 0,25 W“ und 1670 s Haltezeit kommt sie bei allen Läufen nach etwa einer Minute. Liegen Pause und Nachlauf beide bei 0 W, trennt der Zeitpunkt („Pause, wenn sie beginnt vor 880 s“): Dann kommt das Ende nach etwa 4 Minuten, nur ein sehr kurzes Programm, das so früh endet, wie eine Pause beginnt, wird bis zur Haltezeit verzögert, aber erkannt.
- Jeder Vorschlag wird mit dem echten Erkennungscode und den Abbruch-Optionen des Geräts nachgespielt, und zwar in der Einheit des States mit den Werten, die gespeichert werden. Bei kW rundet der Modus Anzahl Mittelwerte auf 0,01 kW (10 W); erkennt er deshalb nicht jeden Lauf, zeigt der Dialog das und schlägt einen anderen Modus vor.

**Dialog**

- Je Modus: richtig erkannte / gefundene Läufe · mittlere (maximale) Zeit, bis das Ende gemeldet wird. Vorausgewählt ist der Modus, der die meisten Läufe mit den wenigsten Fehlstarts erkennt; sind mehrere gleich zuverlässig und melden das Ende innerhalb einer Minute, gewinnt Anzahl (Verhalten von 3.1.2).
- **Gegenprobe** x/y: so viele Läufe wären auch erkannt worden, wenn der jeweilige Lauf in der History gefehlt hätte. Ist der Wert kleiner als die Zahl der Läufe, kommt ein Programm (z. B. mit langer Pause) nur einmal vor; lerne nach weiteren Läufen erneut an.
- Vergleich mit dem aktuellen Gerätetyp über dieselben Läufe und die längste Pause in einem Lauf.
- Vor dem Speichern als neuer eigener Gerätetyp kannst du jeden Wert, den Pausenschutz und den Modus ändern.

### Einen Lauf aufzeichnen

1. Anlernen auf der Gerätekarte starten (**Anlernen**) oder `learning.start` des Geräts schreiben.
2. Einen kompletten Zyklus der Maschine laufen lassen. Die Aufnahme endet automatisch nach 12 Stunden oder 10 000 Messwerten.
3. Anlernen im Device Manager beenden oder `learning.stop` schreiben.
4. Die Aufnahme wird mit derselben Logik ausgewertet wie die History, mit einem Lauf. Nach dem letzten Messwert gilt dieser Wert als weiter bestehend (wie im Betrieb); so kann die Aufnahme auch kurz nach dem Ende gestoppt werden. Erkennt kein Modus den Lauf (z. B. Aufnahme gestoppt, während das Gerät noch lief), gibt es keinen Vorschlag. Die vorgeschlagenen Einstellungen stehen als JSON in `learning.result` (Schwellwerte, Start- und Enddauer, Laufdauer, Anzahl der Messwerte, Modus, Auswertung je Modus und Pausenschutz). Der Device Manager zeigt sie an und kann sie als neuen eigenen Gerätetyp speichern.

Wurden weniger als 20 Messwerte aufgenommen oder wird kein Lauf erkannt, enthält `learning.result` einen Fehler (`tooFewSamples` oder `noRun`). `learning.active` ist true, solange aufgenommen wird.

### Knitterschutz

Viele Waschmaschinen und Trockner bewegen nach dem Programm ab und zu die Trommel (Knitterschutz, z. B. 100–600 W für 10–30 s alle 1–5 Minuten, bis zu 2 Stunden lang). Ohne Sonderbehandlung kommt das Ende erst nach dieser Phase, oder jede Trommelbewegung startet einen neuen Lauf (Trocknertyp von 3.1.2 mit 2 Messwerten über 120 W).

Der optionale **Knitterschutz-Filter** eines Gerätetyps (standardmäßig aus) hält eine Phase über dem Endwert zurück, die nach einer Ruhezeit beginnt. Endet sie innerhalb der längsten Burst-Dauer, war es eine Trommelbewegung und die Erkennung sieht stattdessen den Ruhepegel; sonst war es echte Aktivität und die Erkennung erhält die Originalwerte, höchstens eine Burst-Dauer später. So wird das Ende gemeldet, wenn das Programm fertig ist, und Trommelbewegungen im Knitterschutz starten keinen Lauf. Ein in dieser Phase neu gestartetes Programm wird trotzdem erkannt.

| Feld | Bedeutung |
| --- | --- |
| `trailerBurstSec` | Längste Trommelbewegung in s (15–180; 0 = Filter aus) |
| `trailerGapSec` | Mindest-Ruhezeit vor einer Trommelbewegung in s (0 = 3 Abfragen, mindestens 30 s); kürzere Stopps (Waschrhythmus) werden nie zurückgehalten |
| `trailerAfterSec` | Trommelbewegungen werden erst so lange nach dem Start zurückgehalten (0 = ungenutzt) |
| `trailerBlockVal` | Trommelbewegungen werden erst nach einem Block von mindestens 2 Minuten zurückgehalten, dessen Leistung in den letzten 2 Minuten mindestens diesen Wert hat (0 = ungenutzt), z. B. das Schleudern am Programmende |
| `trailerMaxSec` | Dauer des Knitterschutzes nach dem Ende in s (900–14400); er endet auch nach 20 Minuten ohne Trommelbewegung |

Das Anlernen findet Knitterschutzphasen (mindestens 2 kurze Bursts, auch im Abstand von 1 Minute, nach einem längeren Block; eine längere Lücke für eine zwischendurch geöffnete Tür ist erlaubt), misst die Ende-Verzögerung ab dem Programmende und setzt die Felder, wenn mindestens 2 Läufe eine solche Phase haben und der Filter das Ende mindestens eine Minute früher meldet. Endwerte in der Nähe der Burst-Leistung werden nie vorgeschlagen. Innerhalb eines Programms kann eine Phase genauso aussehen wie der Knitterschutz (Einweichen mit Trommelbewegungen). Die Filtervarianten mit `trailerBlockVal` und `trailerAfterSec` unterscheiden sie; erkennt keine Variante jeden Lauf, zeigt der Dialog „nicht trennbar“ und das Ende bleibt nach dem Knitterschutz (es wird nie zu früh gemeldet).

### Automatische Optimierung

Die Geräte-Option **Automatische Optimierung** (standardmäßig aus) prüft die Erkennung nach jedem Lauf und verbessert sie, ohne die Instanz neu zu starten und ohne den Gerätetyp zu ändern:

- Die Leistung rund um jeden Lauf (30 Minuten davor bis 30 ruhige Minuten nach dem Ende, höchstens 3 Stunden danach) wird kompakt im Dateispeicher des Adapters abgelegt (`<namespace>.learn/<gerät>.a.json` / `.b.json`, höchstens 20 Läufe aller Programme und 10 Fehlstarts, höchstens 400 KB). Ein History-Adapter ist nicht nötig.
- Jeder Kandidat wird mit der echten Erkennung über **alle** gespeicherten Läufe und Fehlstarts nachgespielt; eine Änderung wird nur übernommen, wenn jeder Lauf genau einmal erkannt wird, kein Fehlstart einen Lauf startet und das Ende nie vor dem Programmende gemeldet wird. Bereits gesehene Programme können dadurch nicht kaputtgehen.
- **Reparatur** (vorsichtigere Werte) sofort nach einem Lauf, der nicht richtig erkannt wurde (Ende zu früh, Fehlstart, z. B. durch Knitterschutz-Bursts). Danach 5 Läufe und 14 Tage keine Verschärfung.
- **Verschärfung** (Ende früher, z. B. Knitterschutz-Filter an) erst ab 4 Läufen, 2 neuen Läufen und 24 Stunden seit der letzten Änderung, mit höchstens 25 % Änderung je Schritt (Schwellwerte 30 %), Gegenprobe ohne jede Programmgruppe, leicht veränderten Eingangsdaten (±10 % Leistung, eine Abfrage später, fehlende Werte) und Grenzen aus der längsten je gesehenen Pause und dem längsten Burst. Sie braucht mindestens eine Minute Gewinn (oder weniger Fehlstarts).
- Die optimierten Werte werden je Gerät gespeichert und gelten nur, solange die Option an ist; aus bedeutet wieder die Werte des Gerätetyps (Verhalten von 3.1.2). Wird der Gerätetyp geändert, werden die optimierten Werte verworfen.
- Erkennt keine Einstellung alle gespeicherten Läufe, ändert sich nichts (Warnung im Log); nach 3 solchen Läufen in Folge pausiert die Optimierung, bis die Anlerndaten gelöscht werden.
- States: `learning.optimized`, `learning.parameters`, `learning.lastChange`, `learning.optimizeInfo`, `learning.lastEndDelay`; `learning.undo` macht die letzte Änderung rückgängig, `learning.reset` kehrt zu den Werten des Gerätetyps zurück (beide sperren die Verschärfung für 14 Tage). Mit der Option „Änderungen als Nachricht melden“ wird jede Änderung auch an die Empfänger des Geräts geschickt.

Grenzen: Ein Neustart des Adapters während eines Laufs verliert diesen Lauf (ein Neustart nach dem Ende wird fortgesetzt); ein nie gesehenes Programm ist nur durch die Grenzen und Sicherheitsabstände geschützt und wird nach einem fehlerhaften Lauf repariert; eine Änderung des Abfrageintervalls oder der Einheit des Leistungs-States verwirft die gespeicherten Läufe.

## 9. Migration von 3.1.2

Beim ersten Start von Version 4 wird eine 3.1.2-Konfiguration automatisch umgewandelt. Alle neuen Optionen bleiben aus, jedes migrierte Gerät verhält sich also wie in 3.1.2.

Übernommen werden:

- Geräte (Name, Typ, Leistungs- und Schalt-State, Texte, Abbruch, Auto-Aus, Empfänger),
- Empfänger aller neun Messenger von 3.1.2 (IDs bleiben erhalten),
- Gerätetypen, auch umbenannte eigene Typen,
- Statustexte,
- die Werte der alten States: letzte Läufe, letzte Laufzeit, Nicht stören und maximale Laufzeit.

Bei der Migration korrigiert: Telegram-Benutzername, Vorname und Chat-ID werden auf die Felder des telegram-Adapters abgebildet; Pushover-Priorität, Geräte-ID und eine leere TTL werden korrekt umgewandelt. Geräte mit gleichem Namen oder mit Umlauten, Leerzeichen oder Punkten im Namen erhalten eindeutige, gültige Objekt-IDs.

Entfernt werden nur die States, die 3.1.2 angelegt hat. Migrationswarnungen (unbekannte Felder, fehlende Gerätetypen, nicht mehr vorhandene Empfänger, nicht vorhandene Leistungs-States) stehen im Log und brechen die Migration nicht ab. Schlägt die Migration selbst fehl, bleibt die Konfiguration unverändert und der Adapter läuft weiter.

### Alte und neue State-IDs

3.1.2 legte die States direkt unter `<Gerätename>` an. In Version 4 liegen sie unter dem Geräteobjekt `<deviceId>`. **Skripte, Blockly und Visualisierungen mit den alten IDs müssen angepasst werden.**

| 3.1.2 | Version 4 |
| --- | --- |
| `<Name>.Status` | `<deviceId>.status` |
| `<Name>.live consumption` | `<deviceId>.consumption` |
| `<Name>.average consumption` | `<deviceId>.averageConsumption` |
| `<Name>.runtime` | `<deviceId>.runtime` |
| `<Name>.runtime in ms` | `<deviceId>.runtimeMs` |
| `<Name>.lastRuntime` | `<deviceId>.lastRuntime` |
| `<Name>.messageDP` | `<deviceId>.message` |
| `<Name>.alert runtime` | `<deviceId>.alertRuntime` |
| `<Name>.last operations` | `<deviceId>.lastOperations` |
| `<Name>.config.do not disturb` | `<deviceId>.config.doNotDisturb` |
| `<Name>.config.runtime max` | `<deviceId>.config.runtimeMax` |

Neu in Version 4: `running`, `finished`, `lastFinished`, `acknowledge`, `learning.*`, `lastOperationsHtml`.

## 10. Blockly

Der Adapter bringt Blockly-Blöcke mit (11 Sprachen):

- **Status von Gerät**: liefert den Statustext des Geräts.
- **Gerät quittieren**: quittiert die Fertig-Meldung.
- **Nicht stören für Gerät**: schaltet Nicht stören ein oder aus.
- **Testnachricht senden**: sendet eine Testnachricht an einen Empfänger. Der Block bietet die Empfänger der Instanz als Liste an (Name und Empfänger-ID).

Die Geräte-Blöcke nutzen den ID-Dialog: Wähle einen beliebigen State des Geräts (z. B. `status`); die Geräte-ID wird aus der Objekt-ID übernommen. Du kannst auch direkt die Geräte-ID eintragen.

Skript-Beispiel: reagieren, wenn ein Gerät fertig ist (JavaScript-Adapter):

```js
on({ id: "device-reminder.0.waschmaschine.finished", change: "ne" }, obj => {
	if (obj.state.val === true) {
		log("Waschmaschine ist fertig");
		setState("device-reminder.0.waschmaschine.acknowledge", true);
	}
});
```

## 11. sendTo-API

```js
sendTo("device-reminder.0", "status", { deviceId: "waschmaschine" }, result => log(JSON.stringify(result)));
```

| Kommando | Nachricht | Antwort |
| --- | --- | --- |
| `list` | keine | `[{ id, name }]` aller Geräte |
| `status` | `{ deviceId }` | `{ status, running, finished, consumption, runtime }` oder `{ error: "unknownDevice" }` |
| `acknowledge` | `{ deviceId }` | `{ ok: true }` oder `{ error: "unknownDevice" }` |
| `setDnd` | `{ deviceId, value }` | `{ ok: true }` oder `{ error: "unknownDevice" }` |
| `testRecipient` | `{ id }` (Empfänger-ID) | Ergebnis der Testnachricht oder `{ ok: false, error: "missingRecipient" }` |

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
| `learning.result` | string | json | r | - | Anlern-Ergebnis | JSON: Schwellwerte, startDurationSec, endDurationSec, durationSec, samples, pauseHoldSec, pauseUntilSec, pauseBelowVal, mode, runs, evaluation (aus der History zusätzlich looDetected, longestPauseSec, current, gapsDropped) oder ein Fehler (tooFewSamples, noRun) |
| `antiCrease` | boolean | indicator | r | - | Knitterschutz aktiv | True, solange der Knitterschutz nach einem Lauf erkannt wird (Knitterschutz-Filter des Gerätetyps) |
| `learning.optimized` | boolean | indicator | r | - | Optimierte Werte aktiv | True, wenn die automatische Optimierung andere Werte als der Gerätetyp verwendet |
| `learning.parameters` | string | json | r | - | Erkennungsparameter | JSON: type (Werte des Gerätetyps), override (optimierte Werte), effective (verwendete Werte) |
| `learning.lastChange` | string | json | r | - | Letzte Änderung der Optimierung | JSON der letzten Änderung der automatischen Optimierung (kind, from, to, reason, runs, gainSec) |
| `learning.optimizeInfo` | string | json | r | - | Status der Optimierung | JSON: status, runs, spikes, families, trailer, lastCheckTs, nextPossibleTs, lastEndDelaySec, unclear |
| `learning.lastEndDelay` | number | value.interval | r | s | Ende-Verzögerung des letzten Laufs | Zeit vom Programmende bis zur Ende-Meldung des letzten aufgezeichneten Laufs |
| `learning.undo` | boolean | button | w | - | Letzte Optimierung rückgängig machen | true schreiben macht die letzte Änderung der automatischen Optimierung rückgängig (14 Tage keine Verschärfung) |
| `learning.reset` | boolean | button | w | - | Auf Werte des Gerätetyps zurücksetzen | true schreiben verwendet wieder die Werte des Gerätetyps (14 Tage keine Verschärfung) |
| `lastOperationsHtml` | string | html | r | - | Letzte Vorgänge (HTML) | HTML-Tabelle der letzten Läufe (nur wenn in den allgemeinen Einstellungen aktiviert) |
| `info.connection` | boolean | indicator.connected | r | - | Adapter verbunden | True, wenn der Adapter läuft |
<!-- END STATES -->

## 14. FAQ

**Warum erscheint das Gerät im Reiter „Geräte“ nicht unter „Native Geräte“?**
Der Geräte-Adapter listet nur Objekte, die einem Raum oder einer Funktion zugeordnet sind. Wähle im Geräte-Formular einen Raum oder eine Funktion (oder ordne das Geräte-Objekt, zum Beispiel `device-reminder.0.waschmaschine`, unter **Kategorien** zu); es erscheint dann als Leistungsmesser mit „läuft“-Anzeige.

**Meine Steckdose sendet nur bei Änderung. Das Gerät wird nie erkannt.**
Nutze für den Gerätetyp den Erkennungsmodus **Zeit** (oder **Kombiniert**). Der Modus Anzahl braucht regelmäßige Werte.

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
