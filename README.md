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

- (Eistee82) BREAKING: complete rewrite with new state IDs, requires Node.js 22, js-controller 6 and admin 7.8 - settings from 3.1.2 are migrated automatically
- (Eistee82) Device manager to add, edit and operate devices, with automatic detection of sockets and power meters
- (Eistee82) New detection modes (time-based, combined) and corrected abort detection (default off)
- (Eistee82) Reminders until acknowledged, actions, and learning of thresholds and detection mode from the history (history, SQL, InfluxDB) or a recorded run
- (Eistee82) New messengers ntfy, Pushsafer and Gotify, fixed messenger payloads and time windows for every recipient
- (Eistee82) Blockly blocks and vis-2 widgets (device card and overview)

### 3.1.2 (2024-01-22)

- (xenon-s) bugfix: [issue #381](https://github.com/Xenon-s/ioBroker.device-reminder/issues/381)
- (xenon-s) bugfix: [issue #382](https://github.com/Xenon-s/ioBroker.device-reminder/issues/382)

Older changelog entries: [CHANGELOG_OLD.md](CHANGELOG_OLD.md)

## License

MIT License

Copyright (c) 2020-2024 xenon-s  
Copyright (c) 2026 Eistee82 (t.me/AMEistee)

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
