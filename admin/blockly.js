/* Blockly blocks of the device-reminder adapter (loaded by the javascript adapter's block editor). */
"use strict";

(function () {
	var ADAPTER = "device-reminder";
	var HUE = 160;

	Blockly.Words = Blockly.Words || {};

	Blockly.Words["device_reminder_status"] = {
		en: "status of device",
		de: "Status von Gerät",
		ru: "статус устройства",
		pt: "estado do dispositivo",
		nl: "status van apparaat",
		fr: "état de l'appareil",
		it: "stato del dispositivo",
		es: "estado del dispositivo",
		pl: "status urządzenia",
		uk: "стан пристрою",
		"zh-cn": "设备状态",
	};
	Blockly.Words["device_reminder_status_tooltip"] = {
		en: "Reads the status text of a device (e.g. Off, Running, Finished)",
		de: "Liest den Status-Text eines Geräts (z. B. Aus, Läuft, Fertig)",
		ru: "Читает текст статуса устройства (например, выкл., работает, завершено)",
		pt: "Lê o texto de estado de um dispositivo (p. ex. desligado, em execução, concluído)",
		nl: "Leest de statustekst van een apparaat (bijv. uit, actief, klaar)",
		fr: "Lit le texte d'état d'un appareil (p. ex. arrêté, en marche, terminé)",
		it: "Legge il testo di stato di un dispositivo (ad es. spento, in funzione, terminato)",
		es: "Lee el texto de estado de un dispositivo (p. ej. apagado, en marcha, terminado)",
		pl: "Odczytuje tekst statusu urządzenia (np. wyłączone, działa, zakończone)",
		uk: "Зчитує текст стану пристрою (наприклад, вимкнено, працює, завершено)",
		"zh-cn": "读取设备的状态文本（例如 关闭、运行中、已完成）",
	};
	Blockly.Words["device_reminder_acknowledge"] = {
		en: "acknowledge reminder of device",
		de: "Erinnerung quittieren von Gerät",
		ru: "подтвердить напоминание устройства",
		pt: "confirmar lembrete do dispositivo",
		nl: "herinnering bevestigen van apparaat",
		fr: "acquitter le rappel de l'appareil",
		it: "conferma promemoria del dispositivo",
		es: "confirmar recordatorio del dispositivo",
		pl: "potwierdź przypomnienie urządzenia",
		uk: "підтвердити нагадування пристрою",
		"zh-cn": "确认设备提醒",
	};
	Blockly.Words["device_reminder_acknowledge_tooltip"] = {
		en: "Acknowledges the finished device and stops its reminders",
		de: "Quittiert das fertige Gerät und beendet die Erinnerungen",
		ru: "Подтверждает завершение работы устройства и останавливает напоминания",
		pt: "Confirma o dispositivo concluído e interrompe os lembretes",
		nl: "Bevestigt het klare apparaat en stopt de herinneringen",
		fr: "Acquitte l'appareil terminé et arrête les rappels",
		it: "Conferma il dispositivo terminato e interrompe i promemoria",
		es: "Confirma el dispositivo terminado y detiene los recordatorios",
		pl: "Potwierdza zakończone urządzenie i zatrzymuje przypomnienia",
		uk: "Підтверджує завершений пристрій і зупиняє нагадування",
		"zh-cn": "确认设备已完成并停止提醒",
	};
	Blockly.Words["device_reminder_dnd"] = {
		en: "set do not disturb for device",
		de: "Nicht stören setzen für Gerät",
		ru: "установить «не беспокоить» для устройства",
		pt: "definir não perturbar para o dispositivo",
		nl: "niet storen instellen voor apparaat",
		fr: "régler ne pas déranger pour l'appareil",
		it: "imposta non disturbare per il dispositivo",
		es: "establecer no molestar para el dispositivo",
		pl: "ustaw nie przeszkadzać dla urządzenia",
		uk: "встановити «не турбувати» для пристрою",
		"zh-cn": "设置设备勿扰",
	};
	Blockly.Words["device_reminder_dnd_tooltip"] = {
		en: "Switches do not disturb on or off for a device",
		de: "Schaltet Nicht stören für ein Gerät ein oder aus",
		ru: "Включает или выключает режим «не беспокоить» для устройства",
		pt: "Ativa ou desativa o modo não perturbar para um dispositivo",
		nl: "Schakelt niet storen in of uit voor een apparaat",
		fr: "Active ou désactive ne pas déranger pour un appareil",
		it: "Attiva o disattiva non disturbare per un dispositivo",
		es: "Activa o desactiva no molestar para un dispositivo",
		pl: "Włącza lub wyłącza tryb nie przeszkadzać dla urządzenia",
		uk: "Вмикає або вимикає режим «не турбувати» для пристрою",
		"zh-cn": "为设备开启或关闭勿扰",
	};
	Blockly.Words["device_reminder_test"] = {
		en: "send test message to recipient",
		de: "Testnachricht senden an Empfänger",
		ru: "отправить тестовое сообщение получателю",
		pt: "enviar mensagem de teste ao destinatário",
		nl: "testbericht sturen naar ontvanger",
		fr: "envoyer un message de test au destinataire",
		it: "invia messaggio di prova al destinatario",
		es: "enviar mensaje de prueba al destinatario",
		pl: "wyślij wiadomość testową do odbiorcy",
		uk: "надіслати тестове повідомлення одержувачу",
		"zh-cn": "向收件人发送测试消息",
	};
	Blockly.Words["device_reminder_test_tooltip"] = {
		en: "Sends a test message to a configured recipient (recipient ID)",
		de: "Sendet eine Testnachricht an einen konfigurierten Empfänger (Empfänger-ID)",
		ru: "Отправляет тестовое сообщение настроенному получателю (ID получателя)",
		pt: "Envia uma mensagem de teste a um destinatário configurado (ID do destinatário)",
		nl: "Stuurt een testbericht naar een ingestelde ontvanger (ontvanger-ID)",
		fr: "Envoie un message de test à un destinataire configuré (ID du destinataire)",
		it: "Invia un messaggio di prova a un destinatario configurato (ID destinatario)",
		es: "Envía un mensaje de prueba a un destinatario configurado (ID del destinatario)",
		pl: "Wysyła wiadomość testową do skonfigurowanego odbiorcy (ID odbiorcy)",
		uk: "Надсилає тестове повідомлення налаштованому одержувачу (ID одержувача)",
		"zh-cn": "向已配置的收件人发送测试消息（收件人 ID）",
	};
	Blockly.Words["device_reminder_recipient_id"] = {
		en: "recipient ID",
		de: "Empfänger-ID",
		ru: "ID получателя",
		pt: "ID do destinatário",
		nl: "ontvanger-ID",
		fr: "ID du destinataire",
		it: "ID destinatario",
		es: "ID del destinatario",
		pl: "ID odbiorcy",
		uk: "ID одержувача",
		"zh-cn": "收件人 ID",
	};

	function tr(key) {
		if (typeof Blockly.Translate === "function") {
			return Blockly.Translate(key);
		}
		var words = Blockly.Words[key] || {};
		var lang = typeof systemLang !== "undefined" ? systemLang : "en";
		return words[lang] || words.en || key;
	}

	function instanceOptions() {
		var options = [];
		var list = typeof main !== "undefined" && main && main.instances ? main.instances : [];
		var re = new RegExp("^(?:system\\.adapter\\.)?" + ADAPTER + "\\.(\\d+)$");
		for (var i = 0; i < list.length; i++) {
			var m = re.exec(list[i]);
			if (m) {
				options.push([ADAPTER + "." + m[1], m[1]]);
			}
		}
		return options.length ? options : [[ADAPTER + ".0", "0"]];
	}

	function deviceOptions(block) {
		var options = [];
		var objects = typeof main !== "undefined" && main && main.objects ? main.objects : {};
		var inst = block && block.getFieldValue ? block.getFieldValue("INSTANCE") : null;
		var re = new RegExp("^" + ADAPTER + "\\.(\\d+)\\.([^.]+)$");
		for (var id in objects) {
			var m = re.exec(id);
			if (m && objects[id] && objects[id].type === "device" && (!inst || inst === m[1])) {
				var name = objects[id].common && objects[id].common.name;
				if (name && typeof name === "object") {
					name = name[typeof systemLang !== "undefined" ? systemLang : "en"] || name.en;
				}
				options.push([name ? name + " (" + m[2] + ")" : m[2], m[2]]);
			}
		}
		return options.length ? options : [["-", ""]];
	}

	function appendHead(block, labelKey) {
		var input = block.appendDummyInput().appendField(tr(labelKey));
		input.appendField(new Blockly.FieldDropdown(instanceOptions), "INSTANCE");
		return input;
	}

	function appendDevice(block, labelKey) {
		var input = appendHead(block, labelKey);
		input.appendField(
			new Blockly.FieldDropdown(function () {
				return deviceOptions(block);
			}),
			"DEVICE",
		);
	}

	function getGenerator() {
		if (Blockly.JavaScript) {
			return Blockly.JavaScript;
		}
		if (typeof javascript !== "undefined" && javascript.javascriptGenerator) {
			return javascript.javascriptGenerator;
		}
		return null;
	}

	function register(name, fn) {
		var gen = getGenerator();
		if (!gen) {
			return;
		}
		if (gen.forBlock) {
			gen.forBlock[name] = fn;
		}
		gen[name] = fn;
	}

	function target(block) {
		return ADAPTER + "." + block.getFieldValue("INSTANCE");
	}

	function sendToCode(block, command, payload) {
		return "sendTo(" + JSON.stringify(target(block)) + ", " + JSON.stringify(command) + ", " + payload + ");\n";
	}

	function jsonString(value) {
		return JSON.stringify(String(value));
	}

	Blockly.Blocks["device_reminder_status"] = {
		init: function () {
			appendDevice(this, "device_reminder_status");
			this.setOutput(true, "String");
			this.setColour(HUE);
			this.setTooltip(tr("device_reminder_status_tooltip"));
		},
	};
	register("device_reminder_status", function (block, generator) {
		var gen = generator || getGenerator();
		var id = target(block) + "." + block.getFieldValue("DEVICE") + ".status";
		var order = gen && gen.ORDER_MEMBER !== undefined ? gen.ORDER_MEMBER : 0;
		return ["getState(" + JSON.stringify(id) + ").val", order];
	});

	Blockly.Blocks["device_reminder_acknowledge"] = {
		init: function () {
			appendDevice(this, "device_reminder_acknowledge");
			this.setPreviousStatement(true, null);
			this.setNextStatement(true, null);
			this.setColour(HUE);
			this.setTooltip(tr("device_reminder_acknowledge_tooltip"));
		},
	};
	register("device_reminder_acknowledge", function (block) {
		return sendToCode(block, "acknowledge", '{"deviceId": ' + jsonString(block.getFieldValue("DEVICE")) + "}");
	});

	Blockly.Blocks["device_reminder_dnd"] = {
		init: function () {
			appendDevice(this, "device_reminder_dnd");
			this.appendValueInput("VALUE").setCheck("Boolean");
			this.setPreviousStatement(true, null);
			this.setNextStatement(true, null);
			this.setColour(HUE);
			this.setTooltip(tr("device_reminder_dnd_tooltip"));
		},
	};
	register("device_reminder_dnd", function (block, generator) {
		var gen = generator || getGenerator();
		var order = gen && gen.ORDER_ATOMIC !== undefined ? gen.ORDER_ATOMIC : 0;
		var value = (gen && gen.valueToCode(block, "VALUE", order)) || "false";
		return sendToCode(
			block,
			"setDnd",
			'{"deviceId": ' + jsonString(block.getFieldValue("DEVICE")) + ', "value": ' + value + "}",
		);
	});

	Blockly.Blocks["device_reminder_test"] = {
		init: function () {
			var input = appendHead(this, "device_reminder_test");
			input.appendField(tr("device_reminder_recipient_id"));
			input.appendField(new Blockly.FieldTextInput(""), "RECIPIENT");
			this.setPreviousStatement(true, null);
			this.setNextStatement(true, null);
			this.setColour(HUE);
			this.setTooltip(tr("device_reminder_test_tooltip"));
		},
	};
	register("device_reminder_test", function (block) {
		return sendToCode(block, "testRecipient", '{"id": ' + jsonString(block.getFieldValue("RECIPIENT")) + "}");
	});

	if (Blockly.Sendto && Blockly.Sendto.blocks) {
		Blockly.Sendto.blocks["device_reminder_status"] = '<block type="device_reminder_status"></block>';
		Blockly.Sendto.blocks["device_reminder_acknowledge"] = '<block type="device_reminder_acknowledge"></block>';
		Blockly.Sendto.blocks["device_reminder_dnd"] =
			'<block type="device_reminder_dnd"><value name="VALUE"><shadow type="logic_boolean"><field name="BOOL">TRUE</field></shadow></value></block>';
		Blockly.Sendto.blocks["device_reminder_test"] = '<block type="device_reminder_test"></block>';
	}
})();
