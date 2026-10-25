![Logo](../../admin/device-reminder.png)

# device-reminder

Dokumentation des Adapters device-reminder. Die Kapitel unten werden Schritt für Schritt gefüllt; „Wird noch dokumentiert“ markiert Teile, die noch nicht geschrieben sind.

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

Der Adapter erkennt anhand des Stromverbrauchs einer Steckdose, wann ein Haushaltsgerät startet und fertig ist, und sendet Benachrichtigungen über Messenger und Sprachausgabe.

## 2. Einrichtung

Adapter in ioBroker installieren und die Instanz-Einstellungen öffnen. Die Einstellungen sind in Tabs für Gerätetypen, Empfänger und Allgemeines aufgeteilt. Details werden noch dokumentiert.

## 3. Gerätetypen und Erkennung

Jedes Gerät nutzt einen Gerätetyp. Die Erkennung basiert auf der gemessenen Leistung: anzahlbasiert, zeitbasiert oder kombiniert. Abgebrochene Läufe werden ebenfalls erkannt. Wird noch dokumentiert.

## 4. Geräte anlegen

Geräte werden im Konfig-Manager der Instanz-Einstellungen angelegt, wahlweise über eine Steckdose, über einen Alias oder manuell. Wird noch dokumentiert.

## 5. Empfänger

Nachrichten können an alle zwölf unterstützten Messenger gesendet werden. Jeder Empfänger hat eigene Felder und optionale Zeitfenster. Wird noch dokumentiert.

## 6. Erinnerungen und Quittierung

Erinnerungen wiederholen sich, bis der Zustand „fertig“ quittiert wird. Wird noch dokumentiert.

## 7. Aktionen

Aktionen laufen beim Start oder Ende eines Geräts. Wird noch dokumentiert.

## 8. Anlernen

Der Anlernmodus zeichnet einen Lauf auf und schlägt Schwellwerte für den Gerätetyp vor. Wird noch dokumentiert.

## 9. Migration von 3.1.2

Konfigurationen aus 3.1.2 werden beim ersten Start automatisch migriert. Die alte Konfiguration bleibt im State `info.legacyConfig` erhalten. Wird noch dokumentiert, inklusive Tabelle der alten und neuen State-IDs.

## 10. Blockly

Der Adapter stellt Blockly-Blöcke für Status, Quittierung, Nicht stören und Testnachrichten bereit. Wird noch dokumentiert.

## 11. sendTo-API

Der Adapter beantwortet sendTo-Befehle wie `status`, `acknowledge`, `setDnd`, `list` und `testRecipient`. Wird noch dokumentiert.

## 12. vis-2-Widgets

Der Adapter bringt vis-2-Widgets für Gerätekarten und eine Übersicht mit. Wird noch dokumentiert.

## 13. State-Referenz

<!-- BEGIN STATES -->
Gerätezustände sind relativ zum Geräteobjekt `<deviceId>` angegeben. Info-Zustände liegen an der Adapterinstanz.

| ID | Typ | Rolle | rw | Einheit | Name |
| --- | --- | --- | --- | --- | --- |
| `status` | string | text | r | - | Status |
| `consumption` | number | value.power | r | W | Aktueller Verbrauch |
| `averageConsumption` | number | value.power | r | W | Durchschnittlicher Verbrauch |
| `runtime` | string | text | r | - | Laufzeit |
| `runtimeMs` | number | value | r | ms | Laufzeit in ms |
| `lastRuntime` | string | text | r | - | Letzte Laufzeit |
| `message` | string | text | r | - | Letzte Nachricht |
| `alertRuntime` | boolean | indicator.alarm | r | - | Laufzeitalarm |
| `lastOperations` | string | json | r | - | Letzte Vorgänge |
| `running` | boolean | indicator.working | r | - | Läuft |
| `finished` | boolean | indicator | r | - | Fertig |
| `lastFinished` | number | date | r | - | Zuletzt fertig |
| `acknowledge` | boolean | button | w | - | Quittieren |
| `config.doNotDisturb` | boolean | switch | rw | - | Nicht stören |
| `config.runtimeMax` | number | level | rw | min | Maximale Laufzeit |
| `learning.start` | boolean | button | w | - | Anlernen starten |
| `learning.stop` | boolean | button | w | - | Anlernen beenden |
| `learning.active` | boolean | indicator | r | - | Anlernen aktiv |
| `learning.result` | string | json | r | - | Anlern-Ergebnis |
| `lastOperationsHtml` | string | html | r | - | Letzte Vorgänge (HTML) |
| `info.connection` | boolean | indicator.connected | r | - | Adapter verbunden |
| `info.legacyConfig` | string | json | r | - | Sicherung der 3.1.2-Konfiguration (vor der Migration geschrieben) |
<!-- END STATES -->

## 14. FAQ

Wird noch dokumentiert.
