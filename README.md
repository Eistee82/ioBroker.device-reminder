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

- (Eistee82) BREAKING: complete rewrite with new state IDs, requires Node.js 22, js-controller 6 and admin 7.8 - settings from 3.1.2 are migrated automatically: every device gets its own copy of the values of its type, found exactly like 3.1.2; a device whose type is not found is taken over disabled with a hint, and every changed value is reported in the log
- (Eistee82) Device manager to add, edit and operate devices, with automatic detection of sockets and power meters
- (Eistee82) New detection modes (time-based, combined), corrected abort detection, pause protection for long soaking pauses and an anti-crease filter that reports the end when the anti-crease phase starts (laundry done) and starts no run on drum movements (all default off)
- (Eistee82) Detection values live in each device (when adding you take them from a template, an old template or another device; the form edits them, expert values are collapsed, and the card shows template, learned or own values); reminders until acknowledged, actions, learning from the history (history, SQL, InfluxDB) or a recorded run that writes the values into the device, checks every run first (gaps, sparse recordings, foreign load and manual tests are kept out, rare real programmes are used, two runs grown together are no error), judges an end against the programme end and finds the anti-crease phase of a dryer in every run, and an optional automatic optimisation after every run, without a history adapter and without restart, that never breaks a programme seen before and drops its values as soon as you change the values of the device; a dialog in the device manager shows the stored runs and can undo, reset, discard a run or adopt the values in use as base values of the device
- (Eistee82) New messengers ntfy, Pushsafer and Gotify, fixed messenger payloads and time windows for every recipient
- (Eistee82) Blockly block and sendTo command to send messages to the configured recipients, vis-2 widgets (device card and overview)

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
