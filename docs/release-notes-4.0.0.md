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
		"en": "Version 4 stores every device as its own device object, so the state IDs changed. Your configuration and the values of the old states are migrated automatically on the first start and a backup is kept in info.legacyConfig. Please adapt scripts, Blockly and visualisations that use the old state IDs.",
		"de": "Version 4 legt jedes Gerät als eigenes Geräteobjekt an, daher haben sich die State-IDs geändert. Konfiguration und Werte der alten States werden beim ersten Start automatisch übernommen, eine Sicherung liegt in info.legacyConfig. Bitte Skripte, Blockly und Visualisierungen mit den alten State-IDs anpassen.",
		"ru": "В версии 4 каждое устройство хранится как отдельный объект, поэтому идентификаторы состояний изменились. Конфигурация и значения старых состояний переносятся автоматически при первом запуске, резервная копия хранится в info.legacyConfig. Скрипты, Blockly и визуализации со старыми идентификаторами нужно изменить.",
		"pt": "A versão 4 guarda cada dispositivo como objeto próprio, por isso os IDs dos estados mudaram. A configuração e os valores dos estados antigos são migrados automaticamente no primeiro arranque e uma cópia de segurança fica em info.legacyConfig. Adapte scripts, Blockly e visualizações que usam os IDs antigos.",
		"nl": "Versie 4 slaat elk apparaat op als eigen apparaatobject, daarom zijn de state-ID's gewijzigd. Configuratie en waarden van de oude states worden bij de eerste start automatisch overgenomen en een back-up staat in info.legacyConfig. Pas scripts, Blockly en visualisaties met de oude state-ID's aan.",
		"fr": "La version 4 enregistre chaque appareil comme un objet propre, les ID d'états ont donc changé. La configuration et les valeurs des anciens états sont migrées automatiquement au premier démarrage et une sauvegarde est conservée dans info.legacyConfig. Veuillez adapter les scripts, Blockly et visualisations qui utilisent les anciens ID.",
		"it": "La versione 4 salva ogni dispositivo come oggetto proprio, quindi gli ID degli stati sono cambiati. La configurazione e i valori dei vecchi stati vengono migrati automaticamente al primo avvio e un backup resta in info.legacyConfig. Adattare script, Blockly e visualizzazioni che usano i vecchi ID.",
		"es": "La versión 4 guarda cada dispositivo como objeto propio, por lo que los ID de estados han cambiado. La configuración y los valores de los estados antiguos se migran automáticamente en el primer inicio y se guarda una copia en info.legacyConfig. Adapte los scripts, Blockly y visualizaciones que usen los ID antiguos.",
		"pl": "Wersja 4 zapisuje każde urządzenie jako osobny obiekt, dlatego identyfikatory stanów się zmieniły. Konfiguracja i wartości starych stanów są migrowane automatycznie przy pierwszym uruchomieniu, a kopia zapasowa znajduje się w info.legacyConfig. Dostosuj skrypty, Blockly i wizualizacje używające starych identyfikatorów.",
		"uk": "Версія 4 зберігає кожен пристрій як окремий об'єкт, тому ідентифікатори станів змінилися. Конфігурація та значення старих станів автоматично переносяться під час першого запуску, резервна копія зберігається в info.legacyConfig. Змініть скрипти, Blockly і візуалізації зі старими ідентифікаторами.",
		"zh-cn": "第 4 版将每个设备保存为独立的设备对象，因此状态 ID 已更改。首次启动时会自动迁移配置和旧状态的值，备份保存在 info.legacyConfig 中。请调整使用旧状态 ID 的脚本、Blockly 和可视化。"
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
