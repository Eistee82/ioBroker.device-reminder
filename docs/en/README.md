![Logo](../../admin/device-reminder.png)

# device-reminder

Documentation of the device-reminder adapter. The chapters below are filled step by step; "To be documented" marks parts that are not written yet.

## Contents

1. [Overview](#1-overview)
2. [Setup](#2-setup)
3. [Device types and detection](#3-device-types-and-detection)
4. [Adding devices](#4-adding-devices)
5. [Recipients](#5-recipients)
6. [Reminders and acknowledgement](#6-reminders-and-acknowledgement)
7. [Actions](#7-actions)
8. [Learning mode](#8-learning-mode)
9. [Migration from 3.1.2](#9-migration-from-312)
10. [Blockly](#10-blockly)
11. [sendTo API](#11-sendto-api)
12. [vis-2 widgets](#12-vis-2-widgets)
13. [States reference](#13-states-reference)
14. [FAQ](#14-faq)

## 1. Overview

The adapter detects when a household device starts and finishes by watching the power consumption of a smart plug and sends notifications through messengers and voice output.

## 2. Setup

Install the adapter in ioBroker and open its settings. The instance settings are split into tabs for device types, recipients and general options. Details are to be documented.

## 3. Device types and detection

Each device uses a device type. Detection is based on the measured power: count-based, time-based or a combination of both. Aborted runs are detected as well. To be documented in detail.

## 4. Adding devices

Devices are added in the Device Manager of the instance settings, either from a smart plug, from an alias or manually. To be documented.

## 5. Recipients

Messages can be sent to all twelve supported messengers. Each recipient has its own fields and optional time windows. To be documented.

## 6. Reminders and acknowledgement

Reminders repeat until the finished state is acknowledged. To be documented.

## 7. Actions

Actions run when a device starts or finishes. To be documented.

## 8. Learning mode

Learning mode records a run and proposes thresholds for the device type. To be documented.

## 9. Migration from 3.1.2

Configurations from 3.1.2 are migrated automatically on the first start. The old configuration is kept in the state `info.legacyConfig`. To be documented, including the table of old and new state IDs.

## 10. Blockly

The adapter provides Blockly blocks for status, acknowledgement, do-not-disturb and test messages. To be documented.

## 11. sendTo API

The adapter answers sendTo commands such as `status`, `acknowledge`, `setDnd`, `list` and `testRecipient`. To be documented.

## 12. vis-2 widgets

The adapter ships vis-2 widgets for device cards and an overview. To be documented.

## 13. States reference

<!-- BEGIN STATES -->
Device states are relative to the device object `<deviceId>`. Info states are on the adapter instance.

| ID | Type | Role | rw | Unit | Name |
| --- | --- | --- | --- | --- | --- |
| `status` | string | text | r | - | Status |
| `consumption` | number | value.power | r | W | Current consumption |
| `averageConsumption` | number | value.power | r | W | Average consumption |
| `runtime` | string | text | r | - | Runtime |
| `runtimeMs` | number | value | r | ms | Runtime in ms |
| `lastRuntime` | string | text | r | - | Last runtime |
| `message` | string | text | r | - | Last message |
| `alertRuntime` | boolean | indicator.alarm | r | - | Runtime alert |
| `lastOperations` | string | json | r | - | Last operations |
| `running` | boolean | indicator.working | r | - | Running |
| `finished` | boolean | indicator | r | - | Finished |
| `lastFinished` | number | date | r | - | Last finished |
| `acknowledge` | boolean | button | w | - | Acknowledge |
| `config.doNotDisturb` | boolean | switch | rw | - | Do not disturb |
| `config.runtimeMax` | number | level | rw | min | Maximum runtime |
| `learning.start` | boolean | button | w | - | Start learning |
| `learning.stop` | boolean | button | w | - | Stop learning |
| `learning.active` | boolean | indicator | r | - | Learning active |
| `learning.result` | string | json | r | - | Learning result |
| `lastOperationsHtml` | string | html | r | - | Last operations (HTML) |
| `info.connection` | boolean | indicator.connected | r | - | Adapter connected |
| `info.legacyConfig` | string | json | r | - | Backup of the 3.1.2 configuration (written before migration) |
<!-- END STATES -->

## 14. FAQ

To be documented.
