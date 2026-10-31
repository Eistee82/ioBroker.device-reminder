/* Blockly blocks of the device-reminder adapter (loaded by the javascript adapter's block editor). */
"use strict";

(function () {
	var ADAPTER = "device-reminder";
	var HUE = 160;

	Blockly.Words = Blockly.Words || {};

	Blockly.Words["device_reminder_send"] = {
		en: "send message via",
		de: "Nachricht senden über",
		ru: "отправить сообщение через",
		pt: "enviar mensagem via",
		nl: "bericht sturen via",
		fr: "envoyer un message via",
		it: "invia messaggio tramite",
		es: "enviar mensaje mediante",
		pl: "wyślij wiadomość przez",
		uk: "надіслати повідомлення через",
		"zh-cn": "发送消息，通过",
	};
	Blockly.Words["device_reminder_send_tooltip"] = {
		en: "Sends a text to recipients of device-reminder (all messengers, time windows of the recipients are respected)",
		de: "Sendet einen Text an Empfänger von device-reminder (alle Messenger, die Zeitfenster der Empfänger gelten)",
		ru: "Отправляет текст получателям device-reminder (все мессенджеры, временные окна получателей учитываются)",
		pt: "Envia um texto aos destinatários do device-reminder (todos os mensageiros, as janelas de tempo dos destinatários são respeitadas)",
		nl: "Stuurt een tekst naar ontvangers van device-reminder (alle messengers, de tijdvensters van de ontvangers gelden)",
		fr: "Envoie un texte aux destinataires de device-reminder (toutes les messageries, les plages horaires des destinataires sont respectées)",
		it: "Invia un testo ai destinatari di device-reminder (tutti i messenger, le fasce orarie dei destinatari sono rispettate)",
		es: "Envía un texto a los destinatarios de device-reminder (todos los mensajeros, se respetan las franjas horarias de los destinatarios)",
		pl: "Wysyła tekst do odbiorców device-reminder (wszystkie komunikatory, okna czasowe odbiorców są uwzględniane)",
		uk: "Надсилає текст одержувачам device-reminder (усі месенджери, часові вікна одержувачів враховуються)",
		"zh-cn": "向 device-reminder 的收件人发送文本（所有消息服务，遵守收件人的时间窗口）",
	};
	Blockly.Words["device_reminder_to"] = {
		en: "to",
		de: "an",
		ru: "кому",
		pt: "para",
		nl: "aan",
		fr: "à",
		it: "a",
		es: "a",
		pl: "do",
		uk: "кому",
		"zh-cn": "发送给",
	};
	Blockly.Words["device_reminder_all_recipients"] = {
		en: "all recipients",
		de: "alle Empfänger",
		ru: "все получатели",
		pt: "todos os destinatários",
		nl: "alle ontvangers",
		fr: "tous les destinataires",
		it: "tutti i destinatari",
		es: "todos los destinatarios",
		pl: "wszyscy odbiorcy",
		uk: "усі одержувачі",
		"zh-cn": "所有收件人",
	};
	Blockly.Words["device_reminder_text"] = {
		en: "text",
		de: "Text",
		ru: "текст",
		pt: "texto",
		nl: "tekst",
		fr: "texte",
		it: "testo",
		es: "texto",
		pl: "tekst",
		uk: "текст",
		"zh-cn": "文本",
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

	/**
	 * Recipients of the selected instance as [name, id] pairs, read from the instance object
	 * (the block editor only provides instance objects in `main.objects`).
	 */
	function recipientOptions(block) {
		var options = [[tr("device_reminder_all_recipients"), "*"]];
		var objects = typeof main !== "undefined" && main && main.objects ? main.objects : {};
		var inst = block && block.getFieldValue ? block.getFieldValue("INSTANCE") : "0";
		var obj = objects["system.adapter." + ADAPTER + "." + inst];
		var list = obj && obj.native && Array.isArray(obj.native.recipients) ? obj.native.recipients : [];
		for (var i = 0; i < list.length; i++) {
			var rcp = list[i];
			if (rcp && rcp.id) {
				options.push([rcp.name ? rcp.name + " (" + rcp.id + ")" : String(rcp.id), String(rcp.id)]);
			}
		}
		return options;
	}

	function appendHead(block, labelKey) {
		var input = block.appendDummyInput().appendField(tr(labelKey));
		input.appendField(new Blockly.FieldDropdown(instanceOptions), "INSTANCE");
		return input;
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

	Blockly.Blocks["device_reminder_send"] = {
		init: function () {
			var block = this;
			var input = appendHead(this, "device_reminder_send");
			input.appendField(tr("device_reminder_to"));
			input.appendField(
				new Blockly.FieldDropdown(function () {
					return recipientOptions(block);
				}),
				"RECIPIENT",
			);
			this.appendValueInput("TEXT").setCheck("String").appendField(tr("device_reminder_text"));
			this.setPreviousStatement(true, null);
			this.setNextStatement(true, null);
			this.setColour(HUE);
			this.setTooltip(tr("device_reminder_send_tooltip"));
		},
	};
	register("device_reminder_send", function (block, generator) {
		var gen = generator || getGenerator();
		var order = gen && gen.ORDER_ATOMIC !== undefined ? gen.ORDER_ATOMIC : 0;
		var text = (gen && gen.valueToCode(block, "TEXT", order)) || '""';
		return sendToCode(
			block,
			"send",
			'{"recipients": ' + jsonString(block.getFieldValue("RECIPIENT")) + ', "text": ' + text + "}",
		);
	});

	if (Blockly.Sendto && Blockly.Sendto.blocks) {
		Blockly.Sendto.blocks["device_reminder_send"] =
			'<block type="device_reminder_send"><value name="TEXT"><shadow type="text"><field name="TEXT"></field></shadow></value></block>';
	}
})();
