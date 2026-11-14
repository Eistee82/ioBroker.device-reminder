![Logo](../../admin/device-reminder.png)

# device-reminder

Documentation of the device-reminder adapter (version 4). [Deutsche Version](../de/README.md)

## Contents

1. [Overview](#1-overview)
2. [Setup](#2-setup)
3. [Detection values and templates](#3-detection-values-and-templates)
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

The adapter watches the power consumption of a smart plug or power meter and detects when a household device (washing machine, dryer, dishwasher or any custom device) starts and finishes. It then sends a message to one or more recipients (12 messenger kinds, including voice output), optionally repeats the finished message until you acknowledge it, sets other states and can switch the plug off automatically.

Requirements: Node.js 22 or newer, js-controller 6.0.11 or newer, admin 7.8.20 or newer.

Everything is configured in the instance settings. Devices are managed in the Device Manager, which is embedded in the **Devices** tab. Each device is stored as an ioBroker device object with its own states (see [States reference](#13-states-reference)). Devices run independently of each other: an error in one device does not stop the others.

## 2. Setup

1. Install the adapter and create an instance.
2. Open the instance settings. The tabs are:
   - **Devices**: the Device Manager (see [Adding devices](#4-adding-devices)).
   - **Detection values**: only a note. The values live in each device (see [Detection values and templates](#3-detection-values-and-templates)); there is no table of device types any more.
   - **Recipients**: who receives messages (see [Recipients](#5-recipients)).
   - **General**: status texts, polling interval and the optional HTML history.
3. Create at least one recipient, then add a device in the Device Manager and select the recipient in the device form.

General settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| Status texts | in action / standby / switched off | Text written to the `status` state of each device |
| Polling interval | 10 s | How often the detection evaluates the last power value |
| History as HTML | off | Additionally writes `lastOperationsHtml` (HTML table of the last operations) |

## 3. Detection values and templates

Every device has detection values of its own: thresholds, detection mode, pause protection and anti-crease filter. They live in the device, no longer in a device type shared by several devices. Changing the values of a device changes only this device.

When you add a device you choose where its first values come from (first step of **Add device**, field **Values of the new device**):

- a **template**: **Washing machine**, **Dryer** and **Dishwasher** with the values of 3.1.2, and **Custom** (30 / 5 / 1 / 1 / 20) for every other device,
- an **old template**: a device type of an earlier version whose values or name differ from the template (also learned types of test builds without a device),
- **another device**: only the start and end values and the pause and anti-crease protection are copied. The final phase and the phases are **not** copied; they are learned at the new device, because they only apply with proof from its own runs (a hint in the form says so).

If the power state measures kW, the power values are converted (a template is divided by 1000; between a W and a kW state the values are converted as well). Then you adapt the values to your device in the device form or by [learning](#8-learning-mode); both write the values directly into the device, without restarting the instance.

In the device form the values are in the panel **Detection** (mode, start, end and standby value, counts and durations) and, collapsed, in **Expert values** (pause protection, anti-crease filter and the 13 values of the final phase; the final phase fields only appear once its lower edge and time in band are set). Values that are out of range or contradict each other are corrected and reported when you save.

The device card shows where the values come from as its model: the name of the template, **learned** (values written by learning or saved from the automatic optimisation, or an optimisation changes them at the moment) or **own values**.

The instance action **Remove old templates** in the Device Manager deletes the archive of old device types after a confirmation (the instance restarts); the devices stay unchanged.

A device without valid detection values (for example because its device type no longer exists) gets the values of **Custom** and is **disabled**: it did not run before and must not start sending messages. The device card and the log give the reason. Check the device, save it in the device form and enable it again.

| Threshold | Meaning |
| --- | --- |
| Start value (W) | Power at or above this value counts as "running" |
| End value (W) | Power below this value counts as "run is ending" |
| Standby value (W) | Power below this value counts as "off", above it as "standby" |
| Start count / End count | Number of consecutive polls (count mode) |
| Start duration / End duration (s) | Minimum time above the start or below the end value (time and combined mode) |
| Pause hold (s) | Pause protection: how long a pause below the end value has to last before it counts as the end (0 = off) |
| Pause if it starts before (s) | Pause protection: a phase below the end value that begins this early after the start is a pause (0 = unused) |
| Pause if power below (W) | Pause protection: a phase below the end value whose power stays below this value is a pause (0 = unused) |
| Anti-crease: max. burst / min. gap / only after / min. block power / max. duration | [Anti-crease filter](#anti-crease-phase) (max. burst 0 = off) |

### Detection modes

- **Count** (default, identical to 3.1.2): the start is detected after the configured number of polls with an average above the start value, the end after the configured number of polls below the end value. This mode needs a plug that reports regularly.
- **Time**: the device starts when the power stays at or above the start value for the start duration, and finishes when it stays below the end value for the end duration. The mode is driven by value changes plus the polling interval, so it works with plugs that only report on change.
- **Combined**: the count-based detection of 3.1.2 plus a minimum duration above the start value and below the end value. Both conditions must be met.

### Abort detection

An abort is a device that is switched off by hand while running. The option **Abort detection** is set per device and is off by default. If it fires, the status changes to "switched off" and no finished message is sent.

- In 3.1.2 the abort detection could not fire with most detection values, because its standby buffer never reached the required length. This behaviour is kept when only **Abort detection** is on, so devices behave exactly like in 3.1.2. This is a peculiarity of the values of the built-in templates as well.
- The option **Corrected abort detection** (`abortFixed`, default off) fixes the buffer length (`max(ceil(end count / 2), 2)`) so that the abort can actually fire. Use it together with **Abort detection**. By power alone a switch-off by hand cannot be told apart from a normal end below the standby value (for example a washing machine that falls to 0.5 W), so the corrected abort fires only when the **switch** of the device is off. Without a configured switch it never fires, and a normal end is always reported as finished.
- In time mode the abort fires when the power stays below the standby value for half of the end duration.

### Pause protection

Some programmes pause for a long time, for example while soaking or during a pre-wash. Without pause protection the end detection has to wait longer than the longest pause, and then the finished message comes that late for **every** run. Pause protection tells such pauses apart from the real end:

- A phase below the end value counts as a **pause** if it begins early in the run (before "Pause if it starts before" seconds after the start) or if its power stays below "Pause if power below". If both values are set, both have to apply.
- A pause only counts as the end after the **pause hold** time. Every other phase below the end value is reported as the end after the end count or end duration as usual.
- Guarantee: pause protection can only delay an end, never prevent or advance it. This applies to the abort detection as well. Once the detection would report the end, it is reported after the hold time at the latest, even if short blips (display, electronics) keep interrupting the phase below the end value.
- An abort by the switch (corrected abort detection) is not delayed, because the switched-off switch is a reliable proof.
- All three values 0 (default) = off = the 3.1.2 behaviour. A hold time without one of the two conditions has no effect.

The values are usually set by [learning](#8-learning-mode); you can change them in the types table.

### Other behaviour

- A power value that is not a number (for example `null`, `true` or an empty string) is ignored and the last valid value is kept. Numeric strings such as `"12,5"` are parsed.
- If the power state does not exist (for example a deleted plug), one warning is logged per device, the device stays "switched off" and the Device Manager card shows a warning.
- Editing a running device keeps the current run as long as the power state stays the same. Changed detection values apply from the next run. A new power state resets the device and an info message is logged.

## 4. Adding devices

Open the **Devices** tab and press **Add device**. In the first step you also choose the **values of the new device** (template, old template or another device, see [Detection values and templates](#3-detection-values-and-templates)) and one of three ways to find the states:

1. **Socket / power meter**: the Device Manager uses the ioBroker type-detector to find sockets and power meters (switch state and power state). Pick one; both states are filled in.
2. **Alias or device**: select an alias or device object; the type-detector looks for a suitable power state in it.
3. **Manual entry**: enter the power state (and optionally a switch state) yourself.

If nothing suitable is found, a hint is shown and you can use manual entry.

The device form contains:

| Field | Meaning |
| --- | --- |
| Name | Used for the object ID. IDs are unique and valid: umlauts are transliterated, spaces and dots become `_`, duplicates get `_2`, `_3` ... |
| Detection / Expert values | The detection values of the device (see [Detection values and templates](#3-detection-values-and-templates)). When adding, the first step chooses where they come from; the form shows them in the unit of the power state |
| Power state | State with the power in W or kW (required) |
| Switch state | Optional, needed for auto-off |
| Start text / End text | Message texts |
| Abort detection | See [Abort detection](#abort-detection) |
| Auto-off | Switches the plug off the given number of minutes after the end |
| Recipients | Recipients that receive the messages of this device |
| Rooms / Functions | Assigns the device object to ioBroker categories (rooms and functions). Needed, for example, for the Devices tab. Deleting the device removes it from the categories again |
| Reminder | See [Reminders and acknowledgement](#6-reminders-and-acknowledgement) |
| Actions | See [Actions](#7-actions) |
| Automatic optimisation | Off by default (section **Advanced**). See [Automatic optimisation](#automatic-optimisation) |
| Report changes as a message | Off by default, shown when the automatic optimisation is on (section **Advanced**). Every change of the automatic optimisation is also sent to the recipients of the device |

Required fields are checked before saving.

Each device card shows status, power, runtime, a running and a finished indicator and a warning if the power state is missing. On the card you can edit, delete, enable or disable the device, switch do-not-disturb, acknowledge, send a test message and start learning. The card shows the template, **learned** or **own values** as its model. The details list the last runs, the detection values of the device and the reminder status. A device that needs a check shows a warning with the reason.

### Run behaviour

- When a run starts, the start text is sent, `running` becomes true and the status shows "in action".
- When it finishes, the end text is sent, `finished` becomes true, the runtime is stored in `lastRuntime` and the run is added to `lastOperations` (at most 14 entries).
- If the runtime exceeds `config.runtimeMax` (minutes), `alertRuntime` becomes true.
- Starting the device again counts as acknowledgement.

## 5. Recipients

A recipient is a target for messages. Create recipients on the **Recipients** tab and select them per device. Every recipient can be enabled or disabled, has an optional **time window** and a **Test** button (save the settings first).

First choose the **Messenger**: the list shows all installed instances of the supported messenger adapters (for example "Alexa (alexa2.0)" or "Telegram (telegram.0)"). Only the fields of this messenger are shown afterwards, and everything that can be chosen is a select or an object browser - nothing has to be typed as an ID. The recipient ID is managed internally; the Blockly test block lists the recipients by name.

### Time window

With **active from** and **active until** (`HH:MM`) a recipient only receives messages inside the window. A window may cross midnight (for example 22:00 to 06:00). Equal times (like the default 00:00 - 00:00) mean no restriction. Time windows apply to every messenger. Reminders that fall outside the window are postponed to the next window start.

**Do not disturb** (state `config.doNotDisturb` per device) only suppresses voice outputs (Alexa, SayIt). Test messages ignore time windows and do-not-disturb.

### Messengers

| Messenger | Settings |
| --- | --- |
| Alexa | Echo device or group (select from the alexa2 instance), volume, optional volume state |
| SayIt | volume, optional volume state (the text is written to `tts.text` of the instance) |
| WhatsApp | nothing else (the text is written to `sendMessage` of the whatsapp-cmb instance) |
| Telegram | target type (all users, user name or chat ID) and target, selectable from the users known to the telegram instance. Group chats have negative chat IDs |
| Pushover | title, device, priority, sound, TTL |
| Signal | nothing else (signal-cmb) |
| Email | from, to (the subject is derived from the text) |
| Matrix | nothing else (matrix-org) |
| Discord | user ID, user tag, user name, server ID, channel ID |
| ntfy | topic (required), title, priority |
| Pushsafer | title, device, sound, priority |
| Gotify | title, priority |

Empty optional fields (for example TTL or Discord IDs) are omitted from the message. A recipient without a usable target is skipped with a warning instead of broadcasting.

### Voice output

For Alexa and SayIt the volume is set before speaking and restored afterwards. The volume state is derived from the speech state; if it does not exist, the text is still spoken. For Alexa groups or special setups choose the **volume state** in the object browser (see [FAQ](#14-faq)). Pending volume resets are cancelled when the adapter stops.

## 6. Reminders and acknowledgement

Per device you can repeat the finished message until it is acknowledged.

| Setting | Default | Meaning |
| --- | --- | --- |
| Reminder | off | Enables the reminders |
| Interval | 30 min | Time between reminders |
| Maximum count | 10 | Stops after this many reminders |
| Reminder text | empty | Empty = the end text |
| Acknowledge state | empty | Optional foreign state; a change to `true` acknowledges |

A reminder only counts as sent when at least one recipient received it. Recipients outside their time window are skipped and the reminder is moved to the next window start.

A device is acknowledged by:

- writing the `acknowledge` button state of the device,
- the configured foreign acknowledge state turning `true`,
- the sendTo command `acknowledge` (and the Blockly block),
- the acknowledge button on the device card or widget,
- starting the device again.

Acknowledging stops the reminders and runs the actions of the event "acknowledged".

## 7. Actions

Actions set foreign states automatically. Add as many actions per device as you need:

| Field | Meaning |
| --- | --- |
| Event | `start`, `end`, `reminder` or `acknowledged` |
| State | The foreign state to write |
| Value | Value; converted to the type of the target state (boolean, number or string) |

An action on a missing state is skipped with a warning and never stops the other actions. Example: switch a lamp on when the washing machine has finished (`end`) and off again on `acknowledged`.

## 8. Learning mode

Learning derives thresholds from real runs: from the history of the power state or from a recorded run.

### From the history

If the power state is logged by a history adapter (history, SQL, InfluxDB or any other adapter that answers `getHistory`), **Learn** on the device card first analyses the history. Only if it holds at least 2 complete runs, a dialog (showing the number of runs found) asks whether to learn from the history or to record a new run; otherwise the dialog says why and a new run is recorded. The default history of the system settings is preferred. You never choose a programme: the adapter does not tell programmes apart, the detection values of the device have to detect **every** run.

**Loading**

- The history is read day by day, so the full 30 days arrive even from plugs that report a value every second. A shorter retention (`retention`) of the history adapter limits the period.
- Gaps of the logger are ignored: a run during which the logger stored nothing for more than 2 hours does not count. A value that does not change (plug reports only on change) is no gap.
- The units W and kW are supported. An energy meter (Wh/kWh) is recognised and rejected; choose the state with the current power instead.
- If the history adapter stores changes only, there is often no value in the period before the first run. The run still counts if the first value is at idle level or comes more than 2 hours after the begin of the period.
- If the history cannot be read, the reason is in the log (warning) and the dialog says so; then a new run is recorded.

**Runs**

- A run may pause for up to 30 minutes; activity of less than 5 minutes in total (e.g. a display switching on) is not a run. At least 2 runs are needed, otherwise a new run is recorded.
- A run only counts once it has been finished for about 30 minutes (otherwise it might only be pausing). If you learn right after a run, that run is still missing.
- Two runs shortly after each other are split if the power between them matches the idle level after an end and clearly differs from the pauses inside runs, whether the pauses are below it (pump off, 0 W) or above it (electronics on, e.g. 2–5 W, 0.3 W after the end). Otherwise they stay one run.
- If the power stays on a fixed low level for at least 5 minutes at the end of most runs before the device switches itself off (e.g. a display at 5 W, then 0 W), that level is a rest level and no activity: the run ends before it, not when the device switches off. A programme started while the device rests on that level is a separate run once the rest level lasted at least half as long as the shortest rest phase.
- Anti-crease bursts of a dryer after the end belong to the run. The start duration or start count is chosen so that they do not start a new run.
- A phase with slightly raised power after the run is either the drying of a dishwasher (belongs to the run) or a display or door lock (does not). The power alone cannot tell them apart, so the current detection values of the device decide: the phase belongs to the run if it lasts at least 20 minutes and its power is not below the current end value (the current values still report "running" there, like the dishwasher template with 0.25 W). Otherwise the finished message comes shortly after the actual run. This applies only while the device has the values of a built-in template; learned or custom values do not decide it, so that an end value learned too low does not confirm itself when you learn again.
- Anti-crease bursts with electronics in between are never drying; the end is reported after the cool-down.
- `changesMinDelta` of the history adapter is taken into account for the end value.

**Optimisation**

- End value and end waiting time are chosen so that every run is detected exactly once and the end is reported as early as possible. Instead of fixed factors, the shortest safe end count is searched with the real detection code.
- If [pause protection](#pause-protection) saves at least 3 minutes on average, it is suggested. Example: a run with 22 minutes of soaking at 0 W and 0.5 W after the end. Without pause protection every run would wait more than 27 minutes for the finished message. With "Pause if power below 0.25 W" and a hold of 1670 s it comes after about one minute for all runs. If pause and idle level are both 0 W, the time decides ("Pause if it starts before 880 s"): then the end comes after about 4 minutes; only a very short programme that ends as early as a pause begins is delayed up to the hold time, but it is detected.
- Every suggestion is replayed with the real detection code and the abort options of the device, in the unit of the state with the values that are saved. In kW the count mode rounds averages to 0.01 kW (10 W); if it misses runs because of that, the dialog shows it and suggests another mode.

**Dialog**

- Per mode: runs detected correctly / runs found · mean (maximum) time until the end is reported. The mode that detects the most runs with the fewest false starts is preselected; if several are equally reliable and their end is reported within one minute of each other, count (the 3.1.2 behaviour) wins.
- **Cross-check** x/y: this many runs would also have been detected if that run had been missing from the history. If it is lower than the number of runs, a programme (e.g. one with a long pause) occurred only once; learn again after more runs.
- Comparison with the current detection values of the device over the same runs, and the longest pause in a run.
- You can change every value, the pause protection and the mode before saving. The confirmation lists every change as old → new. The values are written into the device (no restart, the instance settings stay untouched); a final phase of the device is kept.

### Recording a run

1. Start learning from the device card (**Learn**) or write `learning.start` of the device.
2. Run a complete cycle of the machine. The recording stops automatically after 12 hours or 10,000 samples.
3. Stop learning in the Device Manager or write `learning.stop`.
4. The recording is analysed with the same logic as the history, with one run. After the last sample that value is taken to stay (as at runtime), so the recording can also be stopped shortly after the end. If no mode detects the run (e.g. the recording was stopped while the device was still running), there is no suggestion. The suggested settings are written as JSON to `learning.result` (thresholds, start and end duration, run duration, number of samples, mode, result per mode and pause protection). The Device Manager shows them and writes them into the device after a confirmation.

If fewer than 20 samples were recorded or no run is recognised, `learning.result` contains an error (`tooFewSamples` or `noRun`). `learning.active` is true while recording.

### Anti-crease phase

Many washing machines and dryers move the drum now and then after the programme (anti-crease, e.g. 100–600 W for 10–30 s every 1–5 minutes, for up to 2 hours). Without special handling the end is reported only after this phase, or every drum movement starts a new run (the 3.1.2 dryer values with 2 samples at 120 W).

The optional **anti-crease filter** of a device (off by default) holds back a phase above the end value that starts after a quiet time. If it ends within the longest burst time it was a drum movement and the detection sees the quiet level instead; otherwise it was real activity and the detection gets the original values, at most one burst time later. So the end is reported when the programme finishes, i.e. when the anti-crease phase starts and the laundry is done. Drum movements in the anti-crease phase start no run: after the end only a phase of at least 2 minutes above the end value is a new run. A new programme started in that phase is detected at most 2 minutes later.

| Field | Meaning |
| --- | --- |
| `trailerBurstSec` | Longest drum movement in s (15–180; 0 = filter off) |
| `trailerGapSec` | Minimum quiet time before a drum movement in s (0 = 3 polls, at least 30 s); shorter stops (tumbling while washing) are never held |
| `trailerAfterSec` | Drum movements are held only this long after the start (0 = unused) |
| `trailerBlockVal` | Drum movements are held only after a block of at least 2 minutes whose power in its last 2 minutes is at least this value (0 = unused), e.g. the spinning at the end of a programme |
| `trailerMaxSec` | Length of the anti-crease phase after the end in s (900–14400); it also ends after 20 minutes without a drum movement |

The fields belong to the detection values of the device. They are part of the learn dialog when learning suggests the filter, and are shown in the device details. While the filter holds drum movements, the state `antiCrease` of the device is true.

Learning finds anti-crease phases (at least 2 short bursts, also 1 minute apart, after a sustained block; one longer gap for a door opened in between is allowed) and also a dense anti-crease phase where drum and electronics alternate with every report (e.g. 6 W and 20–110 W alternating for 30 minutes after the last spin; at least 6 bursts over 5 minutes, drum at most 70 % of the time and the electronics in between at most a quarter of the burst power), measures the end delay from the end of the programme and sets the fields when at least 2 runs have such a phase and the filter reports the end at least a minute earlier. End values near the burst power are never suggested. Inside a programme a phase can look exactly like the anti-crease phase (soaking with drum movements). The filter variants with `trailerBlockVal` and `trailerAfterSec` tell them apart; if no variant detects every run, the dialog shows "not separable" and the end stays after the anti-crease phase (it is never reported too early).

### Automatic optimisation

The device option **Automatic optimisation** (off by default, device dialog → **Advanced**) checks the detection after every run and improves it without restarting the instance and without changing the detection values of the device:

- The power around every run (30 minutes before to 30 minutes of quiet after the end, at most 3 hours after it) is stored compactly in the file storage of the adapter (`<namespace>.learn/<device>.a.json` / `.b.json`, at most 20 runs of all programmes and 10 false starts, at most 400 KB). No history adapter is needed.
- If the power state is logged by a history adapter, the runs and false starts of its last 30 days are taken over once when the option is switched on for the first time (replayed with the current values, as the runtime would have seen them); then the optimisation runs right away. Without a history adapter it starts with the first run.
- Every candidate is replayed with the real detection over **all** stored runs and false starts; a change is applied only if every run is detected exactly once, no false start starts a run and the end is never reported before the programme end. Programmes that occurred before can therefore not be broken.
- **Repair** (looser values) right after one run that was not detected correctly (end reported too early, false start, e.g. by anti-crease bursts). A repair never shortens a wait of the current values and keeps the start longer than the longest burst ever seen and the end longer than the longest pause ever seen, as long as such values detect every stored run. Afterwards no tightening for 5 runs and 14 days.
- **Tightening** (end reported earlier, e.g. the anti-crease filter on) only with at least 4 runs, 2 new runs and 24 hours since the last change, with values changing by at most 25 % (thresholds 30 %) per step, a cross-check without each programme group, slightly changed input (±10 % power, one poll later, missing values) and limits from the longest pause and burst ever seen. It needs a gain of at least one minute (or fewer false starts). A tightening switches the anti-crease filter on only behind a terminal block like the ones seen (`trailerBlockVal`), so that a programme with soaking that was not seen yet keeps its drum movements.
- The optimised values are stored per device and apply only while the option is on; switching it off means the detection values of the device again (3.1.2 behaviour). There are three levels: the **base values** (the detection values in the device, only you change them), the **effective values** (base values with the optimised values; the optimisation and the display use them) and the **active values** the detection actually runs with (like the effective values; only a suspended final phase is switched off in them, without changing the base or the optimised values).
- Changing the base values (device dialog, learning) applies at once without restart: the optimised values are discarded (entry "Detection values changed"); during a run the new values apply from the next run. If the base values change while an optimisation is computing, its result is discarded (log `base values changed during the optimisation, result discarded`). **Adopt as base values** (action in the optimisation dialog) writes the effective values into the device as base values; afterwards there are no optimised values any more and the detection stays exactly the same (entry "Adopted as base values"). If saving the device fails, everything stays as it was; if the instance stops between saving and the comparison, the next start catches it up. Deleting the device (also in the object browser) deletes its learning data. If the learning data cannot be read at the start, the optimisation stays off until the next start (warning in the log), so that the stored data is not overwritten.
- If no setting detects all stored runs, nothing changes (warning in the log); after 3 such runs in a row the optimisation pauses until the learning data is cleared.
- States: `learning.optimized`, `learning.parameters`, `learning.lastChange`, `learning.optimizeInfo`, `learning.lastEndDelay`; `learning.undo` undoes the last change (not beyond a change of the base values of the device), `learning.reset` goes back to the base values of the device (both lock the tightening for 14 days). With the option "Report changes as a message" every change is also sent to the recipients of the device, in the language of the installation (the log is in English).
- The action **Optimisation** on the device card (shown while the option is on or learning data exists) shows the status, the anti-crease handling, every detection value of the device next to the value in use (changed values are marked with `*`), the stored runs (date, duration, programme group, end delay, classification and whether the current values detect it) and the last changes. Under **Action** you can undo the last change, reset to the detection values of the device, discard one stored run (e.g. a run that was no normal use; the limits of all runs ever seen stay), clear the learning data (after a confirmation) or **adopt the values in use as base values** (after a confirmation listing the changes, no restart). While the option is off, only clearing is offered.

Limits: a restart of the adapter during a run loses that run (a restart after the end is resumed); a programme never seen before is only protected by the limits and margins and is repaired after one faulty run; changing the poll interval or the unit of the power state discards the stored runs.

## 9. Migration from 3.1.2

The first start of version 4 converts a 3.1.2 configuration automatically. All new options stay off, so every migrated device behaves like in 3.1.2.

What is taken over:

- devices (name, power and switch state, texts, abort, auto-off, recipients) with the detection values of their device type,
- recipients of all nine messengers of 3.1.2 (IDs are kept),
- status texts,
- the values of the old states: last operations, last runtime, do not disturb and maximum runtime.

Devices with the same name, or with umlauts, spaces or dots in the name, get unique and valid object IDs.

### Device types become values in the device

Version 4 has no device types any more; the detection values live in the device (see [Detection values and templates](#3-detection-values-and-templates)). The migration looks up the type of every device exactly like 3.1.2: first among the default types with exactly the same name (upper/lower case and spaces count; if several rows have this name, the last one wins), and only without a match among the custom types. The five values of the type (start value, end value, standby value, start and end count) are copied into the device, together with the mode **count**; pause protection, anti-crease and all other new options stay off. If the type comes from the default types, the device remembers the matching template (washing machine, dryer, dishwasher).

- **Shared types:** if several devices use the same type, every device gets its own copy of the values. If you change one device later, only that device changes.
- **Type not found exactly:** 3.1.2 reported such a device once as started and never as finished. Version 4 takes it over completely, but **disabled**, with a hint in the log and on the device card that says where the values come from: from a type whose name matches only when upper/lower case or leading and trailing spaces are ignored; otherwise from the custom type that was originally called `customN` and renamed later (device type `custom3` → third row of the custom types); otherwise from the template **Custom** (30 / 5 / 1 / 1 / 20). Check the values, save the device in the device form and enable it.
- **Archive:** custom or edited types that no device uses and whose values or name differ from the template are kept with name and values as archive templates. Unchanged types are dropped; the built-in templates provide their values.
- **Nothing is lost silently:** a type comment is not taken over. An empty or non-numeric type value is replaced by the value of the template, a negative one by 0; a value with a decimal comma (`12,5`) is read as a number (3.1.2 never started with such a value). A SayIt or WhatsApp target that differs from the target derived from the instance (`<instance>.tts.text` or `<instance>.sendMessage`) is replaced. Each of these cases is logged as a warning with the old and the new value.

Only the states created by 3.1.2 are removed. Migration warnings (unknown fields, device types not found exactly, replaced values and targets, recipients that no longer exist, power states that do not exist) are written to the log; they do not abort the migration. If the migration itself fails, the configuration stays unchanged and the adapter keeps running.

### Changes in behaviour because everything is taken over

3.1.2 stored these settings but did not use them, or used them differently. Version 4 uses them as they were entered:

- **Pushover:** 3.1.2 never sent the priority and the device; version 4 sends the values entered (the TTL too; an empty TTL stays empty).
- **Telegram:** user name, first name and chat ID go to the fields of the telegram adapter (`user` or `chatId`) instead of `username`, `firstname` or `chatID`.
- **Matrix:** messages go to the instance `matrix-org.N` of the Matrix adapter instead of `matrix.N`.
- **Time windows:** a time window across midnight (for example 22:00 to 06:00) now applies; the same start and end time means "always".

### Test builds of version 4

If you used a test build of version 4 with device types, their values move into the devices at the first start, without restarting the instance. Every device gets its own copy of the values of its type, found exactly as in the test build (missing default types and an empty type table give the default values). If the type is one of the built-in types, the device remembers the matching template. All other settings of the device stay unchanged, and so do the values of the automatic optimisation. The type table of the instance is only read and is kept as archive.

- **Type not found:** the test build ignored such a device. Version 4 gives it the values of the template **Custom**, **disables** it and shows a hint in the log and on the device card. Check the values, save the device in the device form and enable it.
- **Device could not be written:** a warning is logged, the device keeps running with the values of its type, and the next start tries again. Devices that were already moved are skipped.

### What changes for you when you update

**What stays the same**

- Detection: every migrated device uses the detection mode **count** with the thresholds of 3.1.2 and detects start and end exactly as before. All new features (other detection modes, pause protection, anti-crease, reminders, actions, automatic optimisation) are off.
- Messages: start and end texts, recipients and status texts are taken over.
- Value formats: `runtime` and `lastRuntime` as `hh:mm:ss`, `lastOperations` as a JSON array with `start`, `end` (`DD.MM.YYYY hh:mm:ss`) and `runtime`, at most 14 entries.
- The values of `last operations`, `lastRuntime`, `do not disturb` and `runtime max` are copied to the new states.

**What changes**

| Area | 3.1.2 | Version 4 |
| --- | --- | --- |
| Configuring devices | table in the instance settings | Device Manager (tab **Devices**), one form per device; changes apply without restarting the instance |
| Device types | tables "default" and "custom", shared by several devices | no types any more: every device has its own detection values; when adding a device a template provides the starting values, learning adapts them |
| Recipients | one table per messenger, ticked in the device | tab **Recipients** with one list of all recipients, selected in the device; ntfy, Pushsafer and Gotify are new |
| Object structure | states directly below `<name>` (folder) | a device object `<deviceId>` with states, like other ioBroker adapters |
| Object ID | device name unchanged (with spaces and umlauts) | built from the name: lower case, umlauts rewritten (`ä` → `ae`), spaces and dots → `_`, duplicate names get `_2`, `_3` … |
| State names | with spaces (`live consumption`) | camelCase without spaces (`consumption`) |
| Roles | all `indicator` | matching roles (`value.power`, `text`, `json`, `indicator.alarm`, `switch.enable`, `level` …), so visualisations and the type detector recognise the states |
| Names of the states | `live consumption Washer` | `Current consumption` in 11 languages; the device is the device object |

Example: a device "Wäsche Keller" had the state `device-reminder.0.Wäsche Keller.live consumption` in 3.1.2; in version 4 it is `device-reminder.0.waesche_keller.consumption`.

**What you have to do after the update**

1. Check the log for migration warnings (for example missing power states or recipients). Devices whose type was not found exactly are disabled: check the values, save and enable the device.
2. Change scripts, Blockly, scenes and visualisations to the new IDs (table below). The old states are deleted.
3. If a history adapter was enabled on an old state (for example `live consumption`), enable it on the new state. The old records stay in the database but do not belong to the new state.
4. Optional: switch on the new features per device.

### Old and new state IDs

| 3.1.2 | Version 4 | Type, role (V4) | Value taken over | Note |
| --- | --- | --- | --- | --- |
| `<name>.Status` | `<deviceId>.status` | string, text | – | status texts of 3.1.2 |
| `<name>.live consumption` | `<deviceId>.consumption` | number, value.power (W) | – | live value |
| `<name>.average consumption` | `<deviceId>.averageConsumption` | number, value.power (W) | – | live value |
| `<name>.runtime in ms` | `<deviceId>.runtimeMs` | number, value (ms) | – | |
| `<name>.messageDP` | `<deviceId>.message` | string, text | – | last text sent |
| `<name>.alert runtime` | `<deviceId>.alertRuntime` | boolean, indicator.alarm | – | |
| `<name>.last operations` | `<deviceId>.lastOperations` | string, json | yes | same JSON format |
| `<name>.config.do not disturb` | `<deviceId>.config.doNotDisturb` | boolean, switch.enable | yes | writable |
| `<name>.config.runtime max` | `<deviceId>.config.runtimeMax` | number, level (min) | yes | writable |

`runtime` and `lastRuntime` keep their names (the value of `lastRuntime` is taken over). They only move below the new device object.

New in version 4 (see [States reference](#13-states-reference)):

- `running`, `finished`, `lastFinished`: running, finished (until acknowledged), time of the last end. 3.1.2 only had the status text for this.
- `acknowledge`: acknowledges the finished message and stops reminders.
- `lastOperationsHtml`: HTML table of the last operations (only when switched on).
- `antiCrease`: anti-crease is running.
- `learning.*`: learning and automatic optimisation.
- `info.connection` at the instance.

## 10. Blockly

The standard blocks of the JavaScript adapter are enough for the states of a device, so there are no own blocks for them:

| Task | Standard block | State |
| --- | --- | --- |
| react when finished | trigger "if object" | `<deviceId>.finished` (true) |
| read the status | "get value of object ID" | `<deviceId>.status` |
| acknowledge | "control" with true | `<deviceId>.acknowledge` |
| do not disturb | "control" with true/false | `<deviceId>.config.doNotDisturb` |

The adapter adds one block of its own (11 languages):

- **send message via device-reminder to … text …**: sends any text to a recipient set up here or to **all recipients**. The settings of the recipients apply (messenger, time window, volume of the voice output). The block offers the recipients of the instance as a list.

Script example: react when a device has finished (JavaScript adapter):

```js
on({ id: "device-reminder.0.washing-machine.finished", change: "ne" }, obj => {
	if (obj.state.val === true) {
		sendTo("device-reminder.0", "send", { recipients: "*", text: "Washing machine is finished" });
		setState("device-reminder.0.washing-machine.acknowledge", true);
	}
});
```

## 11. sendTo API

```js
sendTo("device-reminder.0", "send", { recipients: ["telegram-abc1"], text: "Hello" }, result => log(JSON.stringify(result)));
```

| Command | Message | Answer |
| --- | --- | --- |
| `list` | none | `[{ id, name }]` of all devices |
| `send` | `{ recipients, text, doNotDisturb? }`: `recipients` is one recipient ID, a list of IDs or `"*"` for all enabled recipients; `doNotDisturb: true` suppresses voice outputs | `{ ok, sent, skippedWindow, unknown }` (sent, skipped because of the time window, unknown IDs) or `{ ok: false, error: "missingText" \| "missingRecipient" }` |
| `testRecipient` | `{ id }` (recipient ID) | result of the test message or `{ ok: false, error: "missingRecipient" }` |

Status, acknowledging and do not disturb use the states of the device (see [States reference](#13-states-reference)).

## 12. vis-2 widgets

The adapter ships two widgets for vis-2 (widget set `deviceReminder`):

- **Device card**: status, live power, runtime, estimated progress and remaining time (based on previous runs), acknowledge and do-not-disturb buttons and a collapsible run history. Select the device object with `oid`; optional compact mode and colours for running, finished and alert.
- **Device overview**: compact list of all devices of an instance with status, power, runtime and a finished indicator. A click acknowledges the device.

## 13. States reference

<!-- BEGIN STATES -->
Device states are relative to the device object `<deviceId>`. Info states are on the adapter instance.

| ID | Type | Role | rw | Unit | Name | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `status` | string | text | r | - | Status | Status text (statusTexts: in action / standby / switched off) |
| `consumption` | number | value.power | r | W | Current consumption | Last power value in W |
| `averageConsumption` | number | value.power | r | W | Average consumption | Average of the polls used by the detection |
| `runtime` | string | text | r | - | Runtime | Runtime of the current run as hh:mm:ss |
| `runtimeMs` | number | value | r | ms | Runtime in ms | Runtime of the current run in ms |
| `lastRuntime` | string | text | r | - | Last runtime | Runtime of the last finished run |
| `message` | string | text | r | - | Last message | Last message text delivered for the device |
| `alertRuntime` | boolean | indicator.alarm | r | - | Runtime alert | True when the runtime exceeds config.runtimeMax |
| `lastOperations` | string | json | r | - | Last operations | JSON array of the last runs (start, end, runtime), at most 14 |
| `running` | boolean | indicator.working | r | - | Running | True while a run is in progress |
| `finished` | boolean | indicator | r | - | Finished | True after a run finished until it is acknowledged |
| `lastFinished` | number | date | r | - | Last finished | Timestamp of the last finish |
| `acknowledge` | boolean | button | w | - | Acknowledge | Write true to acknowledge; stops reminders and runs the acknowledged actions |
| `config.doNotDisturb` | boolean | switch.enable | rw | - | Do not disturb | Suppresses voice outputs of this device |
| `config.runtimeMax` | number | level | rw | min | Maximum runtime | Maximum runtime in minutes; above it alertRuntime becomes true |
| `learning.start` | boolean | button.start | w | - | Start learning | Write true to start recording a run |
| `learning.stop` | boolean | button.stop | w | - | Stop learning | Write true to stop recording and compute the suggestion |
| `learning.active` | boolean | indicator | r | - | Learning active | True while a run is recorded |
| `learning.result` | string | json | r | - | Learning result | JSON: thresholds, startDurationSec, endDurationSec, durationSec, samples, pauseHoldSec, pauseUntilSec, pauseBelowVal, mode, runs, evaluation (from the history also looDetected, longestPauseSec, current, gapsDropped), with an anti-crease phase also trailerBurstSec, trailerGapSec, trailerAfterSec, trailerBlockVal, trailerMaxSec, trailer (none, used, notSeparable), trailerRuns, delays (end delay per run from the programme end, s) and falseStarts, or an error (tooFewSamples, noRun) |
| `antiCrease` | boolean | indicator | r | - | Anti-crease active | True while the anti-crease phase after a run is recognised (anti-crease filter of the device) |
| `learning.optimized` | boolean | indicator | r | - | Optimised values active | True when the automatic optimisation uses values that differ from the detection values of the device |
| `learning.parameters` | string | json | r | - | Detection parameters | JSON: base (base values of the device), override (optimised values), effective (effective values: base values with the optimised values), active (values of the detection: like effective, with `finalMinVal` 0 while the final phase is suspended) |
| `learning.lastChange` | string | json | r | - | Last optimisation change | JSON of the last change of the automatic optimisation (kind, from, to, reason, runs, gainSec) |
| `learning.optimizeInfo` | string | json | r | - | Optimisation status | JSON: status, runs, spikes, families, trailer, lastCheckTs, nextPossibleTs, lastEndDelaySec, unclear |
| `learning.lastEndDelay` | number | value.interval | r | s | End delay of the last run | Time from the end of the programme to the reported end of the last recorded run |
| `learning.undo` | boolean | button | w | - | Undo last optimisation | Write true to undo the last change of the automatic optimisation (no tightening for 14 days) |
| `learning.reset` | boolean | button | w | - | Reset to the base values of the device | Write true to use the base values of the device again without optimised values (no tightening for 14 days) |
| `lastOperationsHtml` | string | html | r | - | Last operations (HTML) | HTML table of the last runs (only if enabled in the general settings) |
| `info.connection` | boolean | indicator.connected | r | - | Adapter connected | True when the adapter is running |
<!-- END STATES -->

## 14. FAQ

**Why is the device not listed under "Native devices" in the Devices tab?**
The devices adapter only lists objects that are assigned to a room or a function. Choose a room or function in the device form (or assign the device object, for example `device-reminder.0.waschmaschine`, in **Categories**); it is then shown as a power meter with a "running" indicator.

**My plug only reports when the value changes. The device is never detected.**
Use the detection mode **Time** (or **Combined**) for the device. Count mode needs regular values.

**Alexa speaks on a group or the volume is not set.**
Enter the **volume state** of the target device manually in the recipient. The automatic derivation works for single devices only. Without a usable volume state the text is still spoken.

**Telegram does not reach my group.**
Select the target type "chat ID" and enter the chat ID of the group. Group chat IDs are negative (for example `-1001234567890`).

**The finished message was not delivered at night.**
Check the time window of the recipient. Reminders outside the window are postponed to the next window start. Voice outputs are also muted by do-not-disturb.

**The status stays "switched off" and the log shows a warning.**
The power state of the device does not exist (for example a deleted plug). Edit the device and select an existing state.

**Where is my old 3.1.2 configuration?**
It is converted on the first start and not kept, because every migrated device behaves exactly like in 3.1.2. Create a backup (for example with BackItUp) before the update if you want to be able to go back to 3.1.2.
