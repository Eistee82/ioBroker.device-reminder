# Release notes template 4.0.0

Template for the maintainer. These texts are **not** part of `io-package.json`; they are added there by the release (`npm run release-major`) and by hand for the upgrade message.

## Upgrade message (`common.messages`)

Breaking change: the state IDs of the devices changed. The configuration and the values of the old states are migrated automatically on the first start; scripts, Blockly and visualisations that use the old state IDs must be adapted.

```json
{
	"condition": {
		"operand": "and",
		"rules": ["oldVersion<4.0.0", "newVersion>=4.0.0"]
	},
	"title": {
		"en": "Important notice: new state IDs",
		"de": "Wichtiger Hinweis: neue State-IDs",
		"ru": "Важное замечание: новые идентификаторы состояний",
		"pt": "Aviso importante: novos IDs de estados",
		"nl": "Belangrijke mededeling: nieuwe state-ID's",
		"fr": "Avis important : nouveaux ID d'états",
		"it": "Avviso importante: nuovi ID degli stati",
		"es": "Aviso importante: nuevos ID de estados",
		"pl": "Ważna informacja: nowe identyfikatory stanów",
		"uk": "Важливе повідомлення: нові ідентифікатори станів",
		"zh-cn": "重要提示：新的状态 ID"
	},
	"text": {
		"en": "Version 4 stores every device as its own device object, so the state IDs changed. Your configuration and the values of the old states are migrated automatically on the first start. Please adapt scripts, Blockly and visualisations that use the old state IDs.",
		"de": "Version 4 legt jedes Gerät als eigenes Geräteobjekt an, daher haben sich die State-IDs geändert. Konfiguration und Werte der alten States werden beim ersten Start automatisch übernommen. Bitte Skripte, Blockly und Visualisierungen mit den alten State-IDs anpassen.",
		"ru": "В версии 4 каждое устройство хранится как отдельный объект, поэтому идентификаторы состояний изменились. Конфигурация и значения старых состояний переносятся автоматически при первом запуске. Скрипты, Blockly и визуализации со старыми идентификаторами нужно изменить.",
		"pt": "A versão 4 guarda cada dispositivo como objeto próprio, por isso os IDs dos estados mudaram. A configuração e os valores dos estados antigos são migrados automaticamente no primeiro arranque. Adapte scripts, Blockly e visualizações que usam os IDs antigos.",
		"nl": "Versie 4 slaat elk apparaat op als eigen apparaatobject, daarom zijn de state-ID's gewijzigd. Configuratie en waarden van de oude states worden bij de eerste start automatisch overgenomen. Pas scripts, Blockly en visualisaties met de oude state-ID's aan.",
		"fr": "La version 4 enregistre chaque appareil comme un objet propre, les ID d'états ont donc changé. La configuration et les valeurs des anciens états sont migrées automatiquement au premier démarrage. Veuillez adapter les scripts, Blockly et visualisations qui utilisent les anciens ID.",
		"it": "La versione 4 salva ogni dispositivo come oggetto proprio, quindi gli ID degli stati sono cambiati. La configurazione e i valori dei vecchi stati vengono migrati automaticamente al primo avvio. Adattare script, Blockly e visualizzazioni che usano i vecchi ID.",
		"es": "La versión 4 guarda cada dispositivo como objeto propio, por lo que los ID de estados han cambiado. La configuración y los valores de los estados antiguos se migran automáticamente en el primer inicio. Adapte los scripts, Blockly y visualizaciones que usen los ID antiguos.",
		"pl": "Wersja 4 zapisuje każde urządzenie jako osobny obiekt, dlatego identyfikatory stanów się zmieniły. Konfiguracja i wartości starych stanów są migrowane automatycznie przy pierwszym uruchomieniu. Dostosuj skrypty, Blockly i wizualizacje używające starych identyfikatorów.",
		"uk": "Версія 4 зберігає кожен пристрій як окремий об'єкт, тому ідентифікатори станів змінилися. Конфігурація та значення старих станів автоматично переносяться під час першого запуску. Змініть скрипти, Blockly і візуалізації зі старими ідентифікаторами.",
		"zh-cn": "第 4 版将每个设备保存为独立的设备对象，因此状态 ID 已更改。首次启动时会自动迁移配置和旧状态的值。请调整使用旧状态 ID 的脚本、Blockly 和可视化。"
	},
	"level": "warn",
	"buttons": ["agree", "cancel"]
}
```

## News entry (`common.news["4.0.0"]`)

```json
{
	"en": "Rewrite as TypeScript adapter with device manager, time-based detection, reminders until acknowledged, actions, learning mode, new messengers (ntfy, Pushsafer, Gotify), Blockly blocks, vis-2 widgets and automatic migration. New state IDs!",
	"de": "Neuentwicklung als TypeScript-Adapter mit Device Manager, zeitbasierter Erkennung, Erinnerungen bis zur Quittierung, Aktionen, Anlernen, neuen Messengern (ntfy, Pushsafer, Gotify), Blockly-Blöcken, vis-2-Widgets und automatischer Migration. Neue State-IDs!",
	"ru": "Переписан на TypeScript: менеджер устройств, определение по времени, напоминания до подтверждения, действия, обучение, новые мессенджеры (ntfy, Pushsafer, Gotify), блоки Blockly, виджеты vis-2 и автоматическая миграция. Новые идентификаторы состояний!",
	"pt": "Reescrito em TypeScript com gestor de dispositivos, deteção por tempo, lembretes até confirmação, ações, modo de aprendizagem, novos mensageiros (ntfy, Pushsafer, Gotify), blocos Blockly, widgets vis-2 e migração automática. Novos IDs de estados!",
	"nl": "Herschreven in TypeScript met apparaatbeheer, tijdgebaseerde detectie, herinneringen tot bevestiging, acties, leermodus, nieuwe berichtendiensten (ntfy, Pushsafer, Gotify), Blockly-blokken, vis-2-widgets en automatische migratie. Nieuwe state-ID's!",
	"fr": "Réécriture en TypeScript avec gestionnaire d'appareils, détection temporelle, rappels jusqu'à acquittement, actions, mode d'apprentissage, nouvelles messageries (ntfy, Pushsafer, Gotify), blocs Blockly, widgets vis-2 et migration automatique. Nouveaux ID d'états !",
	"it": "Riscritto in TypeScript con gestione dispositivi, rilevamento temporale, promemoria fino alla conferma, azioni, modalità di apprendimento, nuovi messenger (ntfy, Pushsafer, Gotify), blocchi Blockly, widget vis-2 e migrazione automatica. Nuovi ID degli stati!",
	"es": "Reescrito en TypeScript con gestor de dispositivos, detección por tiempo, recordatorios hasta confirmar, acciones, modo de aprendizaje, nuevos mensajeros (ntfy, Pushsafer, Gotify), bloques Blockly, widgets vis-2 y migración automática. ¡Nuevos ID de estados!",
	"pl": "Przepisany w TypeScript z menedżerem urządzeń, wykrywaniem opartym na czasie, przypomnieniami do potwierdzenia, akcjami, trybem uczenia, nowymi komunikatorami (ntfy, Pushsafer, Gotify), blokami Blockly, widżetami vis-2 i automatyczną migracją. Nowe identyfikatory stanów!",
	"uk": "Переписано на TypeScript: менеджер пристроїв, визначення за часом, нагадування до підтвердження, дії, режим навчання, нові месенджери (ntfy, Pushsafer, Gotify), блоки Blockly, віджети vis-2 і автоматична міграція. Нові ідентифікатори станів!",
	"zh-cn": "使用 TypeScript 重写，新增设备管理器、基于时间的检测、确认前持续提醒、动作、学习模式、新消息渠道（ntfy、Pushsafer、Gotify）、Blockly 块、vis-2 小部件和自动迁移。状态 ID 已更改！"
}
```

## Detailed changes (moved from the README changelog)

The README changelog stays short; the details and issue numbers of 4.0.0 are listed here.

- BREAKING: New state IDs. Devices are now ioBroker device objects (`<deviceId>.status`, `.consumption`, `.runtime`, ...); scripts and visualisations that use the 3.1.2 IDs must be adapted (table in the documentation)
- Automatic migration of the 3.1.2 configuration on first start: devices, recipients of all nine messengers, device types (including renamed custom types) and status texts are taken over, all new options stay off
- Migration moves the values of the old states (last operations, last runtime, do not disturb, maximum runtime) to the new device objects and removes only the old 3.1.2 states; devices with the same name or with umlauts, spaces or dots get unique, valid object IDs
- Migration fixes the 3.1.2 messenger settings (Telegram username/firstname/chatID, Pushover priority, device ID and empty TTL) and warns about entries it cannot take over completely (unknown fields, missing device types, recipients that no longer exist, missing power states) instead of aborting; if the migration fails, the configuration stays unchanged and the adapter keeps running
- Device manager: add devices via the type-detector (socket, alias, device or manual entry) with a hint if nothing suitable is found, edit, delete, enable/disable, do-not-disturb, acknowledge and test message directly from the device cards; the Devices tab of the instance settings embeds it
- Device manager: device cards show status, power, runtime, running/finished indicators and a warning for a missing power state; details list the last runs, the type thresholds and the reminder status
- Device form with validation of required fields (type, power/switch state, texts, abort detection, auto-off, recipients, reminder, actions)
- Admin UI: tabs for device types (thresholds, detection mode), recipients (12 messenger kinds, time window, test button) and general settings (status texts, polling interval) (#386, #113)
- New time-based detection mode per device type: start/end after a minimum duration above/below the thresholds; works with plugs that only report on change (#435)
- New combined detection mode: count-based detection (3.1.2) plus minimum durations above the start and below the end threshold
- Optional corrected abort detection (default off): the abort detection of 3.1.2 could never fire for most device types. It only fires while the switch of the device is off (a normal end below the standby value is always a finished run).
- Devices run independently of each other; an error in one device no longer stops the others, and editing a running device keeps the current run as long as device type and power state stay the same (otherwise the device is reset and an info message is logged)
- Device runtime: start/end messages, run time, last operations (max. 14, optional HTML table), run-time alert, acknowledge and auto-off per device
- Non-numeric power values are ignored instead of breaking the average; a missing power state produces a single warning per device
- Reminders: repeat the finished message at a configurable interval until acknowledged (own acknowledge state or a foreign state), limited by a maximum count and respecting recipient time windows (#504, #36)
- Acknowledging (state, external acknowledge state, sendTo or restart of the device) stops the reminders and runs the 'acknowledged' actions
- Actions: set foreign states automatically on start, end, reminder and acknowledgement of a device (#446, #442)
- Learning: thresholds, start and end duration are suggested from a recorded run (recording max. 12 h or 10,000 samples); it is started and stopped through the device manager or the `learning.start`/`learning.stop` states, the result is written to `learning.result`, and the suggestion can be stored as a new custom device type (#494); if the power state is logged by a history adapter (history, SQL, InfluxDB), the runs of the last 30 days are analysed instead, every run is replayed with all three detection modes and the most reliable mode is suggested
- Time windows now apply to every recipient; do-not-disturb only suppresses voice outputs (#495)
- Messenger payloads fixed: Telegram uses user/chatId, Pushover sends priority/retry/expire/device correctly, empty Discord and TTL fields are omitted (#409, #483, #410, #417)
- New messengers: ntfy (#457), Pushsafer (#465) and Gotify (#367)
- Voice output (Alexa/SayIt): the volume state is derived from the speech state; if it is missing, the text is still spoken (#407, #408)
- Detection of sockets and power meters (switch and power state) through the type-detector
- New sendTo commands: status, acknowledge, setDnd, list and testRecipient
- State definitions for devices (status, consumption, runtime, running, finished, acknowledge, config, learning) with roles and names in 11 languages
- Blockly: new blocks for device status, acknowledging reminders, do-not-disturb and sending a test message (11 languages)
- vis-2 widgets "Device card" (status, live power, runtime, estimated progress and remaining time, acknowledge and do-not-disturb buttons, collapsible run history) and "Device overview" (compact list of all devices, click acknowledges)
- Further reported issues taken into account: #400, #449, #397, #458, #471, #396, #581
