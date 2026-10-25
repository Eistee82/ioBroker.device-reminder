![Logo](admin/device-reminder.png)

# ioBroker.device-reminder

[![NPM version](https://img.shields.io/npm/v/iobroker.device-reminder.svg)](https://www.npmjs.com/package/iobroker.device-reminder)
[![Downloads](https://img.shields.io/npm/dm/iobroker.device-reminder.svg)](https://www.npmjs.com/package/iobroker.device-reminder)
![Number of Installations](https://iobroker.live/badges/device-reminder-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/device-reminder-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.device-reminder.png?downloads=true)](https://nodei.co/npm/iobroker.device-reminder/)

**Tests:** [![Test and Release](https://github.com/Eistee82/ioBroker.device-reminder/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/Eistee82/ioBroker.device-reminder/actions/workflows/test-and-release.yml)

## device-reminder adapter for ioBroker

Detects when household devices such as washing machines, dryers and dishwashers start and finish (based on the power consumption of a smart plug) and notifies you via messengers, voice output and reminders.

## Documentation

- [English Documentation](./docs/en/README.md)
- [Deutsche Dokumentation](./docs/de/README.md)

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (Eistee82) BREAKING: Rewrite as a TypeScript ESM adapter (Node >= 22, js-controller >= 6.0.11, admin >= 7.8.20) with JSON configuration UI, CI (lint, tests on Node 22/24/26 on Linux/Windows/macOS) and compact mode
- (Eistee82) BREAKING: New state IDs. Devices are now ioBroker device objects (`<deviceId>.status`, `.consumption`, `.runtime`, ...); scripts and visualisations that use the 3.1.2 IDs must be adapted (table in the documentation)
- (Eistee82) Automatic migration of the 3.1.2 configuration on first start: devices, recipients of all nine messengers, device types (including renamed custom types) and status texts are taken over, all new options stay off, and the old configuration is kept as a backup in `info.legacyConfig`
- (Eistee82) Migration moves the values of the old states (last operations, last runtime, do not disturb, maximum runtime) to the new device objects and removes only the old 3.1.2 states; devices with the same name or with umlauts, spaces or dots get unique, valid object IDs
- (Eistee82) Migration fixes the 3.1.2 messenger settings (Telegram username/firstname/chatID, Pushover priority, device ID and empty TTL) and warns about entries it cannot take over completely (unknown fields, missing device types, recipients that no longer exist, missing power states) instead of aborting; if the migration fails, the configuration stays unchanged and the adapter keeps running
- (Eistee82) Device manager: add devices via the type-detector (socket, alias, device or manual entry) with a hint if nothing suitable is found, edit, delete, enable/disable, do-not-disturb, acknowledge and test message directly from the device cards; the Devices tab of the instance settings embeds it
- (Eistee82) Device manager: device cards show status, power, runtime, running/finished indicators and a warning for a missing power state; details list the last runs, the type thresholds and the reminder status
- (Eistee82) Device form with validation of required fields (type, power/switch state, texts, abort detection, auto-off, recipients, reminder, actions)
- (Eistee82) Admin UI: tabs for device types (thresholds, detection mode), recipients (12 messenger kinds, time window, test button) and general settings (status texts, polling interval) (#386, #113)
- (Eistee82) Start/end detection rewritten in TypeScript, behaviour identical to 3.1.2 (checked by parity tests against the original code)
- (Eistee82) New time-based detection mode per device type: start/end after a minimum duration above/below the thresholds; works with plugs that only report on change (#435)
- (Eistee82) New combined detection mode: count-based detection (3.1.2) plus minimum durations above the start and below the end threshold
- (Eistee82) Optional corrected abort detection (default off): the abort detection of 3.1.2 could never fire for most device types
- (Eistee82) Devices run independently of each other; an error in one device no longer stops the others, and editing a running device keeps the current run as long as device type and power state stay the same (otherwise the device is reset and an info message is logged)
- (Eistee82) Device runtime: start/end messages, run time, last operations (max. 14, optional HTML table), run-time alert, acknowledge and auto-off per device
- (Eistee82) Non-numeric power values are ignored instead of breaking the average; a missing power state produces a single warning per device
- (Eistee82) Reminders: repeat the finished message at a configurable interval until acknowledged (own acknowledge state or a foreign state), limited by a maximum count and respecting recipient time windows (#504, #36)
- (Eistee82) Acknowledging (state, external acknowledge state, sendTo or restart of the device) stops the reminders and runs the 'acknowledged' actions
- (Eistee82) Actions: set foreign states automatically on start, end, reminder and acknowledgement of a device (#446, #442)
- (Eistee82) Learning: thresholds, start and end duration are suggested from a recorded run (recording max. 12 h or 10,000 samples); it is started and stopped through the device manager or the `learning.start`/`learning.stop` states, the result is written to `learning.result`, and the suggestion can be stored as a new custom device type (#494)
- (Eistee82) Time windows now apply to every recipient; do-not-disturb only suppresses voice outputs (#495)
- (Eistee82) Messenger payloads fixed: Telegram uses user/chatId, Pushover sends priority/retry/expire/device correctly, empty Discord and TTL fields are omitted (#409, #483, #410, #417)
- (Eistee82) New messengers: ntfy (#457), Pushsafer (#465) and Gotify (#367)
- (Eistee82) Voice output (Alexa/SayIt): the volume state is derived from the speech state; if it is missing, the text is still spoken (#407, #408)
- (Eistee82) Detection of sockets and power meters (switch and power state) through the type-detector
- (Eistee82) New sendTo commands: status, acknowledge, setDnd, list and testRecipient
- (Eistee82) State definitions for devices (status, consumption, runtime, running, finished, acknowledge, config, learning) with roles and names in 11 languages
- (Eistee82) Blockly: new blocks for device status, acknowledging reminders, do-not-disturb and sending a test message (11 languages)
- (Eistee82) vis-2 widgets "Device card" (status, live power, runtime, estimated progress and remaining time, acknowledge and do-not-disturb buttons, collapsible run history) and "Device overview" (compact list of all devices, click acknowledges); build output in widgets/device-reminder, Module Federation `deviceReminder`
- (Eistee82) All timers are cleared when the adapter stops, and nothing is written afterwards
- (Eistee82) Further reported issues taken into account: #400, #449, #397, #458, #471, #396, #581

### 3.1.2 (2024-01-22)

- (xenon-s) bugfix: [issue #381](https://github.com/Xenon-s/ioBroker.device-reminder/issues/381)
- (xenon-s) bugfix: [issue #382](https://github.com/Xenon-s/ioBroker.device-reminder/issues/382)

Older changelog entries: [CHANGELOG_OLD.md](CHANGELOG_OLD.md)

## License

MIT License

Copyright (c) 2020-2024 xenon-s  
Copyright (c) 2026 Eistee82

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
