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
| Final phase (13 values, expert values) | [early finish after the last programme phase](#final-phase) (lower edge or time in band 0 = off) |

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
| Auto-off | Switches the plug off the given number of minutes after the end (with a [final phase](#final-phase) only after the lock phase) |
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
| Event | `start`, `end`, `reminder`, `acknowledged`, `phaseStart` or `phaseEnd` (begin or end of a [phase](#phases)) |
| Phase | Only with `phaseStart`/`phaseEnd`: id of the phase (e.g. `p4`); empty = every phase. The ids are in the state `phaseId` and in the timeline `phases` |
| State | The foreign state to write |
| Value | Value; converted to the type of the target state (boolean, number or string) |

An action on a missing state is skipped with a warning and never stops the other actions. Example: switch a lamp on when the washing machine has finished (`end`) and off again on `acknowledged`.

## 8. Learning mode

Learning derives thresholds from real runs: from the history of the power state or from a recorded run.

### From the history

If the power state is logged by a history adapter (history, SQL, InfluxDB or any other adapter that answers `getHistory`), **Learn** on the device card first analyses the history. Only if it holds at least 2 complete runs, a dialog (showing the number of runs found) asks whether to learn from the history or to record a new run; otherwise the dialog says why and a new run is recorded. The default history of the system settings is preferred. You never choose a programme: the adapter does not tell programmes apart, the detection values of the device have to detect **every** run.

### The learning dialog

Learning from the history goes through three steps; nothing is written before you confirm at the end, and "Cancel" changes nothing.

1. **Runs:** Every run and short activity of the last 30 days with date, duration, energy, programme group, phase sequence (once phases are learned), **check** (a tick or the findings of the [run check](#run-check)), boundary run and **use**: *Auto* uses a run when the check allows it (the check holds runs back on its own only from 8 runs), *Use* counts a run despite a finding (never an unusable recording), *Do not use* leaves it out; it then is no comparison for the other runs either. You choose the use in two multiple selects below the list (the variant with a select column in the table is built but is only switched on once it has been tried in the Device Manager of a real system). Tick **Recalculate with the chosen runs** to check the list again for the chosen set; without it OK goes on to the suggestion. A run marked "formerly dropped" was not kept by the learning data of a test build of version 4; a hint at the top says so.
2. **Detection:** The start and end values come only from the chosen runs (with the cross-check and the rating of the current values, as described [above](#from-the-history)). Below is the suggestion for the [final phase](#final-phase) with key figures, e.g. "Finished 28 min earlier (median), 11 of 12 runs, 0 too early, 1 fallback". The checkbox **Use the final phase** is off by default and can only be ticked when every release check passed (at least 5 runs with a clear end); otherwise the reason is shown.
3. **Phases:** **Show phases** (off by default) switches on the [phases](#phases) of the device. Every learned phase has a neutral name you can change and shows band, duration, predecessor and agreement; you also choose whether it is shown, whether it is reported at its start or end and, only when the final phase is released and the phase lies in the final band, "finished afterwards". Phases that are only recognised afterwards carry a hint.

**Apply** writes the detection values (with "Use the final phase" the `final*` values too) and the phases into the device and your decisions about the runs into the learning data; the device keeps running without a restart. With "Use the final phase" the chosen runs and the base bands are also stored as comparison data in the learning data (also without the automatic optimisation), so that the judgement afterwards knows them. **Recording** (one run) gives start and end values and only the checks that need no comparison (invalid values, a proven gap; an energy meter is not recorded at all); there are no phases there and never a final phase.

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
- **End not too early** means: the finished message comes after the end of the run, or after the **programme end** and at most 5 minutes before the end of the run. The programme end is the last value above the tail limit (1.1 × the highest power of the drum movements in the anti-crease phase), but only if the anti-crease phase is clearly separated from the programme: at least 2 runs have an anti-crease phase, and in each of them a block of at least 2 minutes above 1.25 × that power (e.g. the final spin of a washing machine) ends at most one minute before the core end. Otherwise (a device without anti-crease phase, or a dryer whose cool-down is hardly above the drum movements) the programme end is the end of the run, as before.
- If [pause protection](#pause-protection) saves at least 3 minutes on average, it is suggested. Example: a run with 22 minutes of soaking at 0 W and 0.5 W after the end. Without pause protection every run would wait more than 27 minutes for the finished message. With "Pause if power below 0.25 W" and a hold of 1670 s it comes after about one minute for all runs. If pause and idle level are both 0 W, the time decides ("Pause if it starts before 880 s"): then the end comes after about 4 minutes; only a very short programme that ends as early as a pause begins is delayed up to the hold time, but it is detected.
- Every suggestion is replayed with the real detection code and the abort options of the device, in the unit of the state with the values that are saved. In kW the count mode rounds averages to 0.01 kW (10 W); if it misses runs because of that, the dialog shows it and suggests another mode.

**Dialog**

- Per mode: runs detected correctly / runs found · mean (maximum) time until the end is reported. The mode that detects the most runs with the fewest false starts is preselected; if several are equally reliable and their end is reported within one minute of each other, count (the 3.1.2 behaviour) wins.
- **Cross-check** x/y: this many runs would also have been detected if that run had been missing from the history. If it is lower than the number of runs, a programme (e.g. one with a long pause) occurred only once; learn again after more runs.
- Comparison with the current detection values of the device over the same runs, and the longest pause in a run.
- You can change every value, the pause protection and the mode before saving. The confirmation lists every change as old → new. The values are written into the device (no restart, the instance settings stay untouched); a final phase of the device is kept.

### Run check

Every run (from the history, from a recording or from the stored runs of the optimisation) is checked before anything is learned from it. A disturbed recording therefore cannot spoil the values, and a rare real programme is still used. The check compares every run with the others and is therefore computed again at every evaluation. It is based on the **power bands** of the device (for example washing, spinning and heating of a washing machine) and on how long a stored value usually stays in each band.

| Stage | Effect |
| --- | --- |
| ok | used for everything, rare programmes too |
| limited | used for some purposes only (for example not for the length of the trailer) |
| quarantine | not used, but shown |
| unusable | never used |

You can include a run in quarantine and exclude any other run; an unusable run cannot be included. With several findings the most severe one counts: unusable before data errors (gap, stuck value, sparse recording) before form findings (foreign load, test) before limited.

- **Incomplete** (unusable): run at the end of the data, adapter restart during the run, or unknown time in the run (failed query, jump in time).
- **Gap**, proven (unusable): the history adapter stores the value again regularly (`changesRelogInterval`), but nothing came for longer than two intervals; the report log of a recording has no report at all, not even with the same value, for at least 2 minutes and three times as long as nearly all report intervals; the adapter was down.
- **Gap**, suspected (quarantine): a value stays much longer than values in its band usually do (limit 5 × the longest usual hold times, at least 10 minutes). This is only checked from 3 runs on. For devices that run continuously only this section drops out; the day stays usable.
- **Stuck** (quarantine): at least 20 reports with exactly the same value, longer than this limit, in a band whose values otherwise vary. A value that just stays the same for a long time without reports is never stuck.
- **Sparse** (quarantine): the intervals between the stored values in the run are more than 4 times those of the other runs.
- **Unit** (unusable): the peak of a run is below 1/50 or above 50 times the usual peak, or the usual peak is below 1/100 of the peak of the template (for example kW values without a unit). **Counter** (unusable): the state has the unit Wh or kWh.
- **Foreign load** (quarantine): the power in the 30 minutes before or after the run is at least 20 W (or 3 times the usual spread) above the usual one, or more than 5 % of the run lie far above anything the device draws otherwise. Long heating in a known band is never a foreign load.
- **Spike** (limited): a single value above 3 times the highest values of the runs.
- **Test** (quarantine): a short activity more than twice as long as any other; a run shorter than 10 minutes; a run that touches only one band or none of the bands found in at least half of the runs (not for devices whose runs themselves touch only one band). Duration and energy alone never make a test.
- **Aborted** (limited, for the start only): reported as aborted in the recording; in the history an abrupt end without end block and trailer, shorter than nearly all runs of its programme group.
- **Trailer cut** (limited, not for the length of trailer and rest): the anti-crease phase is shorter than half the usual one, or the device switches off at least 5 minutes earlier than usual (for example door opened during the anti-crease phase). Only for devices with an anti-crease phase in at least 2 runs.
- **Grown together** (limited): a run more than 1.8 times as long as the longest one of its programme group and with two end blocks (for example two final spins): two programmes right after each other, recorded as one run. This is **no detection error**, the device was running all the time. What matters is only that the end of the whole run is detected; the run is used for that, not for pauses, durations, limits, phases, final phase and trailer (the rest between the two programmes does not make any end wait longer). There is no hint and no repair.
- **History setting** (limited): `ignoreZero` (not for the rest length), debounce (`debounceTime`, `blockTime`) longer than the poll interval (not for phases and trailer), rounding coarser than 10 % of the rest level (hint only).
- **Invalid values** and **jump in time** (limited): more than 1 % missing, invalid or negative values in the run, or time that jumps back by more than a minute. The values are cleaned; after a jump in time the time up to the last value before it is unknown.
- **Rare** (ok, fully used): a rare real programme, for example a quick programme or long heating: the only run of its programme group, far off within its group, or duration, energy or longest block below half or above twice those of all other runs. Rare programmes are used, not sorted out.
- **Formerly discarded?** (use unchanged): a history run in the time range of an old learning store of a version 4 test build that is missing there.

Programme groups are formed from runs without quarantine only; a run in quarantine never confirms another one. A run from a recording and one from the history are the same run when they start at most 5 minutes apart.

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

Learning finds anti-crease phases (at least 2 short bursts, also 1 minute apart, after a sustained block; one longer gap for a door opened in between is allowed) and also a dense anti-crease phase where drum and electronics alternate with every report (e.g. 6 W and 20–110 W alternating for 30 minutes after the last spin; at least 6 bursts over 5 minutes, drum at most 70 % of the time and the electronics in between at most a quarter of the burst power), measures the end delay from the end of the programme and sets the fields when at least 2 runs have such a phase and the filter reports the end at least a minute earlier. If the electronics between the drum movements is above the run level now and then (dryer: drum about 100 W, in between 4 W and 8–13 W alternating), learning measures the anti-crease phase above a quarter of the high values at the end of the run, as long as the electronics in between stays at most a quarter of the burst power; so it is found in every run and the end of the cool-down counts as the end of the programme. End values near the burst power are never suggested. Inside a programme a phase can look exactly like the anti-crease phase (soaking with drum movements). The filter variants with `trailerBlockVal` and `trailerAfterSec` tell them apart; if no variant detects every run, the dialog shows "not separable" and the end stays after the anti-crease phase (it is never reported too early).

### Final phase

Many devices end their programme with a last typical phase, after which only rest or a trailer follows (washing machine: final spin, then anti-crease). After this phase the end detection still waits for the end count or end duration; for a washing machine with the 3.1.2 values that is 11–31 minutes. The optional **final phase** reports the end shortly after this last phase instead (on the data of a washing machine 1.5–2.2 minutes after the end of the programme). It is off by default (all 13 values 0 = behaviour of 3.1.2) and on as soon as the lower edge and the time in the band are set. The values are under **Expert values** in the device form.

How it works:

- **Early finish:** If the power stays in the **final band** (lower edge P up to below the upper edge; a value above the upper edge discards the block) for at least "time in band" (Y) in total during the run, the block begins at the earliest "block after start" (X) after the start, and the power then stays below P for "quiet time" (Z), **finished** is reported – with everything a normal end has (end text, end actions, reminders, `lastOperations`). Interruptions up to "interruption" (G) still belong to the block. Each poll counts the last reported value, so a plug that reports nothing for minutes does not lengthen the time in the band.
- **Lock phase:** After the early finish a lock phase follows. The detection keeps running in the background but reports nothing; the status is "standby" or "switched off". An abort via the switch is not reported in the lock phase. Drum movements of a trailer start no new run this way. The first matching condition ends the lock phase:

| Exit | Condition |
| --- | --- |
| a) End | the normal end detection reports the end (or an abort) |
| b) Rest | the power stays below the "rest level" (0 = standby value) for the "rest duration" |
| c) High load | the power stays at or above the "high-load level" for G (0 = off) |
| d) Final band late | a value in the final band later than the "check window" after the early finish |
| e) Maximum duration | the "maximum duration of the lock phase" has passed (0 = 4 hours) |
| f) Activity | in the last 5 minutes the power is above the "activity level" for at least the "activity share" of the time (both 0 = off) |
| g) Final band early | within the check window the power is in the final band for at least Y/2 in total |

- **Everything after it is a new run:** After b–g the detection starts again and detects a new run with the normal start rules. The start is dated back to the first activity above the rest level after the last rest, at the earliest to the early finish, so that the runtime and `lastOperations` are right. There is no correction message and no resume: if a programme was started again right after the end, it is a new run with its own start and finished messages; if the early finish was wrong (the final phase does not fit this programme), the rest of the programme reports start and finished.
- **Judging afterwards:** When a run that began after an early finish via the exits b–g ends, the adapter checks the early part and the new run together. The new run counts as the rest of the split programme if it does not begin like the stored clean runs (in its first 10 minutes a power band is missing that at least 80 % of them begin with) or if between the early finish and the new start there was no rest below the rest level longer than the longest rest inside a programme (at least 60 seconds). Without comparison data (fewer than 3 clean runs or no power bands) only the rest counts, compared with the longest rest in the early part. A pause inside the programme that is longer than every rest of the early part (for example a long soaking pause) is then not found as a split; that only works once there are comparison data. A real unloading with a new start (rest in between) is therefore not judged as a split. If a rest of more than 30 minutes (for example soaking) has already closed the recording of the early part, the early part is taken from the stored run before (at most 3 hours before the new start). The check runs right at the end of this run, so that a programme started after it is already detected without the wrong final phase.
- **Suspending:** If the programme was split, the final phase is **suspended**, also without the automatic optimisation. From the next run on the detection works as without the final phase (the values in the device stay unchanged; `learning.optimizeInfo` shows `finalState: "suspended"`). There is a warning in the log, an entry "Final phase suspended" in the last changes and a warning on the device card; it is sent to the recipients as a message only with the option "Report changes as a message". With the automatic optimisation it is repaired right after the run (see [Automatic optimisation](#automatic-optimisation)). Otherwise the final phase stays suspended until it is switched on again (optimisation dialog, learning again) or the learning data are cleared; switching the final phase off and on again in the device settings keeps the suspension (the warning stays on the card).
- **Learning data for the final phase:** If a device has a final phase, its runs are recorded and stored in the file storage also without the automatic optimisation (as with the automatic optimisation, the first time with the runs of the history if there is one); they are only comparison data. Without the automatic optimisation no optimised values are applied or computed, and nothing is repaired or tightened; the only possible change is the suspension.
- **Auto-off:** With a final phase the auto-off time does not start at the early finish but only when the lock phase ends via end, rest or maximum duration (a, b, e), so a programme that is still running is not switched off. If it ends via high load, final band or activity (c, d, f, g), a new run is probably under way and the auto-off follows its end. If no new run starts within the check window, the auto-off starts after the check window, or at once at rest (below the rest level for the rest duration). After a restart of the adapter during the lock phase the same applies: the auto-off time starts only when the continued lock phase ends.
- **Restart of the adapter:** The state `settlingUntil` holds the end of the running lock phase (early finish + maximum duration), otherwise 0. If the adapter restarts during the lock phase, it continues it as long as `settlingUntil` lies in the future and the final phase is on and not suspended – also when the device was already acknowledged. The lock phase ends at the latest the maximum duration after the restart, even if `settlingUntil` lies further in the future (for example after the clock was changed). Changing the power state or disabling the device ends the lock phase and sets `settlingUntil` to 0. The state exists only with the final phase on (also when only the automatic optimisation switched it on).
- **Changes during the lock phase:** Changed detection values or options apply only after the lock phase (or after the run), so that the detection does not start again in the middle of the lock phase.
- **Limits:** Independent of the poll interval, times are at least long enough that a single value is never enough (Y and G at least 2 polls, Z at least G, rest duration at least 3 polls); this only works in the safe direction (later finish, later exit). With an active [anti-crease filter](#anti-crease-phase) the filter sits outside: the early finish starts the anti-crease phase (the state `antiCrease` is true in the lock phase as long as the anti-crease phase lasts), and in the lock phase the filter holds nothing back.

You enter the values by hand, or the [automatic optimisation](#automatic-optimisation) switches the final phase on by itself as soon as enough runs prove it; learning it in the dialog follows. Without fitting values (a final band that is also reached in the middle of the programme, or a too small Y) finished comes too early and the rest of the programme is reported as a new run; then the judgement afterwards suspends the final phase.

| Field | Meaning |
| --- | --- |
| `finalMinVal` (P) | lower edge of the final band (0 = final phase off) |
| `finalMaxVal` | upper edge; a value from here on discards the block (0 = open) |
| `finalHotVal` | high-load level for exit c (0 = off) |
| `finalAfterSec` (X) | the block begins at the earliest this long after the start (s) |
| `finalMinSec` (Y) | time in the final band (s; 0 = final phase off) |
| `finalQuietSec` (Z) | this long below P after the block → finished (s; 0 = 120 s) |
| `finalDipSec` (G) | interruption in the block (s; 0 = 60 s or 2 polls) |
| `finalRestVal` / `finalRestSec` | rest level and rest duration for exit b (0 = standby value or 60 s) |
| `finalActVal` / `finalActShare` | activity level and share for exit f (0 = off) |
| `finalCheckSec` | check window for the exits d and g (s; 0 = 30 min) |
| `finalLockSec` | maximum duration of the lock phase (s; 0 = 4 h) |

### Phases

Phases show what a device is doing right now ("washing", "final spin", "burner with pump"). They are only active when a phase model is switched on for the device; otherwise the states `phase`, `phaseId`, `phaseSince` and `phases` do not exist (they are deleted) and everything else behaves as without phases. Phases never change the `status` and never cause a start or end event.

- **Display:** `phase` (name), `phaseId` (id) and `phaseSince` (begin) are written only when the phase changes, never at every poll. `phases` is the timeline of the running or last run as JSON (`id`, `name`, `from`, `to`), at most the 200 newest segments; for a device without runs (for example a boiler) the last 24 hours. The running segment has the time of the last poll as `to`. The state `phases` is only written when a segment changes (a new phase, the end of a segment or a later classification).
- **What only appears afterwards:** A phase that can only be told by its maximum duration (for example "intermediate spin") is decided at the end of its segment. Live the state shows the umbrella term of the band ("spin"); the timeline then holds the exact name. The same holds for an ignition (event phase) that is not confirmed. Nothing is ever guessed; if no phase fits, the umbrella term shows.
- **System phases:** "Anti-crease" (`antiCrease`) while the anti-crease filter recognises the run-on, "After the run" (`afterRun`) in the lock phase of the final phase, "Rest" (`rest`) and "Unknown" (`unknown`, when the power state reports nothing for an unusually long time). Their names are in the language of the installation.
- **Event:** Begin and end of every phase are events for [actions](#7-actions) (`phaseStart`, `phaseEnd`, filtered on a phase id if you like).
- **Messages:** Only phases with a message switched on (begin and/or end, own text) send a message, to the recipients of the device with do not disturb like with start and end. A phase is reported at most once per run; for a device without runs at most every 10 minutes per phase. A phase that is only known at its end is reported "at end" only.
- **Changing the phase model:** A changed model applies between two runs (and after the lock phase), never in the middle of a run.

### Automatic optimisation

The device option **Automatic optimisation** (off by default, device dialog → **Advanced**) checks the detection after every run and improves it without restarting the instance and without changing the detection values of the device:

- The power around every run (30 minutes before to 30 minutes of quiet after the end, at most 3 hours after it) is stored compactly in the file storage of the adapter (`<namespace>.learn/<device>.a.json` / `.b.json`, at most 1 MB). No history adapter is needed.
- **Which runs stay:** the runs of the last 30 days (above 1 MB or 400 runs history runs go first, then the oldest run of the largest programme group) and 10 false starts. Older runs go, except **boundary runs** (a run that alone sets a safety limit, e.g. the longest pause or the lowest run power) and at least 2 runs per programme group. Boundary runs are never evicted; of two equally extreme runs one always stays. The limits (`envelope`) are computed from the usable runs (the run check counts, an excluded run does not); learning data of an earlier version keeps its limits as a lower bound until you clear the learning data. At the first start with this version stored runs are segmented again from their values (log `learning data brought to the current version`).
- If the power state is logged by a history adapter, the runs and false starts of its last 30 days are taken over once when the option is switched on for the first time (replayed with the current values, as the runtime would have seen them); then the optimisation runs right away. Without a history adapter it starts with the first run. After **Clear learning data** the history is read again (your decisions about runs still apply), after an **outage** of the adapter of more than an hour only the time of the outage (at most 30 days). A run that is already stored or being recorded (start within 5 minutes) is never taken twice. Otherwise the history is never read again.
- **Two runs shortly one after the other:** A recording stays open for up to 30 quiet minutes after the end. If a new programme starts in this time, the recording is split when it is stored if there were at least 3 minutes of rest at the level after an end between the reported end and the new start (and the pauses in the programme are clearly below or above it); likewise at every start after a lock phase of the final phase. Each part is a run of its own. Two correctly reported runs therefore trigger no repair; a long pause in the middle of a programme with a finished in between stays a split run and is repaired.
- **Which runs count:** the **target set** is the runs of the last 30 days admitted by the run check (for the gain and the minimum counts), the **check set** adds every boundary run of any age. Every candidate is replayed with the real detection over the admitted runs of the check set and the admitted false starts (at most 60 runs: every boundary run and the newest of each programme group); a change is applied only if every run is detected exactly once, no false start starts a run and the end is never reported too early (criterion "end not too early" with the programme end from the run store). Runs in quarantine do not count there; for them only "no regression" applies: a candidate must not detect any of them worse than the current values. Programmes that occurred before can therefore not be broken.
- **Two runs as one are no error:** if the detection reports two real runs as one (the device ran all the time), that is fine as long as the real end of the whole run is detected. A run grown together is checked only for this end, and so are two runs right after each other that new values would report together; there is no repair, no shorter wait and no hint for it. If the end of the whole run is not detected or too early, it is repaired.
- **Repair comes first** (looser values): right after an admitted run that the current values do not detect, or not correctly (start missed, end too early, run split, end not detected, a start after the end), even if it is missed by just one poll. It applies without a minimum count, without spacing, also during a lock or a drift and without step limits (only the hard value limits), until this run and every other admitted run is detected; the run that triggered it becomes a boundary run. Runs in quarantine and unusable runs trigger no repair. A repair never shortens a wait of the current values and keeps the start longer than the longest burst ever seen and the end longer than the longest pause ever seen, as long as such values detect every run. Afterwards no tightening for 5 runs and 14 days. A single short activity counts as a manual test (quarantine); false starts count from the second one.
- **Tightening** (end reported earlier, e.g. the anti-crease filter on) only with at least **8 admitted runs of the last 30 days** (learning needs 2), 2 new runs and 24 hours since the last change, only over the runs of the target set (no run grown together), with values changing by at most 25 % (thresholds 30 %) per step, a cross-check without each programme group, slightly changed input (±10 % power, one poll later, missing values) and limits from the longest pause and burst ever seen. It needs a gain of at least one minute (or fewer false starts). A tightening switches the anti-crease filter on only behind a terminal block like the ones seen (`trailerBlockVal`), so that a programme with soaking that was not seen yet keeps its drum movements. If a candidate fails on one single run only, that run becomes a boundary run (veto) and is not evicted until a candidate taken over later passes it.
- **Final phase switched on automatically:** The optimisation switches the [final phase](#final-phase) on by itself without asking, but only with **10 admitted runs of the last 30 days** and **2 runs per programme group**, outside a lock and without a drift. Its values are learned from the runs of the check set and taken over only if they are released there (every run reported earlier and never too early, a cross-check without each run or programme group, ±10 % power, a coarser poll, missing values, one poll later, a gain of at least one minute) and every admitted run is detected correctly; no run may end later, no run in quarantine get worse. Entry "Final phase switched on", a message only with "Report changes as a message"; **undo** switches it off again. The state `settlingUntil` is created or removed with it. The other candidates of the optimisation keep the final phase as it is; it is never switched off silently.
- **Final phase adjusted:** Like a tightening (8 admitted runs, 2 new runs, 24 hours apart, no lock, no drift) and with the same minimum counts as for switching it on, it is learned again and adjusted in small steps: the lower limit by at most ±10 %, the time in the final band rises freely and drops by at most 10 % (only with at least 5 covered runs), the earliest start of the final block drops by at most 25 %; the other values come from the runs (entry "Final phase adjusted").
- **Final phase suspended and repaired:** If the final phase reports an admitted run too early in the replay, or the [judgement afterwards](#final-phase) found a split programme, it is suspended at once and repaired right after the run, without a minimum count, also during a lock or a drift and without step limits. A split programme is replayed together with its early part as **one** run (the final phase must not report an end earlier than the values without it). If this shows that the early end was right, it is used again at once. Otherwise the closest safe setting is searched (longer time in the final band, a later final block, a narrower final band); if it detects every admitted run, the final phase is used again with these values (entries "Final phase repaired" and "Final phase used again", then 5 runs and 14 days without tightening), otherwise it stays suspended (log `final phase stays suspended`). Runs in quarantine trigger nothing.
- **Phases fine-tuned:** If the device has [phases](#phases) switched on, the limits of the existing phases follow the admitted runs: band limits at most ±15 % per step, the duration ranges of the phases (e.g. "intermediate spin" up to 2 min) and, for an event phase (ignition), its confirmation time and tail. A proposal is taken over only when two checks in a row give the same proposal and the cross-check (each run replayed with the limits learned without it) agrees no worse than before. Phases are never added, removed or renamed; ids, names and messages stay. The limits are kept in the learning data, apply only to the phase model they were computed for (a model learned again starts without them), take effect between two runs and never change the start or end detection; **Reset** drops them. If a stretch that fits no phase shows up in at least 3 runs, there is one hint "new phase found" (log, a message only with "Report changes as a message").
- **Computing time (budget):** Each job after a run may use at most 30 seconds of **active computing time** (the time in which the adapter lets other work go first does not count). The cheap part – run check, check over all admitted runs, repair and suspending – always runs completely. The expensive steps (switching the final phase on or adjusting it, tightening, fine-tuning the phases) run in turn: if the time is not enough, the step stops without a change, its progress is saved and the next job goes on where it stopped (also after a restart). The release of the final phase and the cross-check of the phases run at most once a day and only when new admitted runs came since; the same runs are never searched twice. `learning.optimizeInfo` shows `jobMs` (computing time of the last job) and `budget` (jobs in a row stopped by the time budget, status `budget`). From the 3rd time in a row there is the warning `optimisation too slow on this system (3 jobs in a row)` in the log and on the device card (a message only with "Report changes as a message"). A device with many runs a day (e.g. a boiler) thus loads the system only with the cheap part per run.
- The optimised values are stored per device and apply only while the option is on; switching it off means the detection values of the device again (3.1.2 behaviour). There are three levels: the **base values** (the detection values in the device, only you change them), the **effective values** (base values with the optimised values; the optimisation and the display use them) and the **active values** the detection actually runs with (like the effective values; only a suspended final phase is switched off in them, without changing the base or the optimised values).
- Changing the base values (device dialog, learning) applies at once without restart: the optimised values are discarded (entry "Detection values changed"); during a run the new values apply from the next run. If the base values change while an optimisation is computing, its result is discarded (log `base values changed during the optimisation, result discarded`). **Adopt as base values** (action in the optimisation dialog) writes the effective values into the device as base values; afterwards there are no optimised values any more and the detection stays exactly the same (entry "Adopted as base values"). If saving the device fails, everything stays as it was; if the instance stops between saving and the comparison, the next start catches it up. Deleting the device (also in the object browser) deletes its learning data together with your decisions about runs; a new device with the same ID starts empty. If the learning data cannot be read at the start, the optimisation stays off until the next start (warning in the log), so that the stored data is not overwritten.
- If no setting detects all admitted runs, the current values stay as the safest known setting (status `cannotCover`, warning `no values detect every admitted run, keeping the current values`). After 3 such runs in a row it is a **drift** (status `drift`, hint "the device behaves differently – learn again?"): then there is no tightening, no switching on or adjusting of the final phase and no fine-tuning of the phases any more until the learning data is cleared or the values are reset; repairs go on.
- **Hint about a run in quarantine:** if the current values do not detect a run in quarantine correctly, there is exactly one hint: for a reason that can be a real programme (foreign load, manual test) "run of … was not detected correctly and is unusual – choose 'use' in the optimisation dialog" (log, `learning.optimizeInfo.review`, warning on the device card, status `review`); for a data error (gap, stuck value, sparse recording) "recording disturbed, run not used" (log only). As a message to the recipients only with the option "Report changes as a message".
- States: `learning.optimized`, `learning.parameters`, `learning.lastChange`, `learning.optimizeInfo`, `learning.lastEndDelay`; `learning.undo` undoes the last change (not beyond a change of the base values of the device), `learning.reset` goes back to the base values of the device (both lock the tightening for 14 days). With the option "Report changes as a message" every change is also sent to the recipients of the device, in the language of the installation (the log is in English).
- The action **Optimisation** on the device card (shown while the option is on or learning data exists) shows the status, the anti-crease handling, every detection value of the device next to the value in use (changed values are marked with `*`), the stored runs (date, duration, programme group, end delay, classification and whether the current values detect it) and the last changes. Under **Action** you can undo the last change, reset to the detection values of the device, discard one stored run (e.g. a run that was no normal use: it is no longer replayed and sets no limit any more; the decision is kept by the start time of the run, also for a later import from the history), clear the learning data (after a confirmation; your decisions about runs are kept) or **adopt the values in use as base values** (after a confirmation listing the changes, no restart). While the option is off, only clearing is offered.

Limits: a restart of the adapter during a run loses that run (a restart after the end is resumed); a programme never seen before is only protected by the limits and margins and is repaired after one faulty run; changing the poll interval or the unit of the power state converts the stored runs (coarser grid: the value at the grid point; finer grid: repeated, such runs no longer count for the anti-crease phase), the limits stay.

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
| `settlingUntil` | number | date | r | - | Lock phase until | End of the running lock phase of the final phase (early finish + maximum duration), otherwise 0; a restart continues the lock phase until then. Only with the final phase on (values of the device or optimised values) |
| `phase` | string | text | r | - | Current phase | Name of the phase the device is in (empty outside a run); only with phases on, written only when it changes |
| `phaseId` | string | text | r | - | Current phase (ID) | Id of the phase (system phases `antiCrease`, `afterRun`, `rest`, `unknown`); only with phases on |
| `phaseSince` | number | date | r | - | Current phase since | Begin of the current phase; only with phases on |
| `phases` | string | json | r | - | Phase timeline | JSON array `{id, name, from, to}` of the running or last run (the last 24 hours for a device without runs), at most 200 entries; only with phases on |
| `learning.optimized` | boolean | indicator | r | - | Optimised values active | True when the automatic optimisation uses values that differ from the detection values of the device |
| `learning.parameters` | string | json | r | - | Detection parameters | JSON: base (base values of the device), override (optimised values), effective (effective values: base values with the optimised values), active (values of the detection: like effective, with `finalMinVal` 0 while the final phase is suspended) |
| `learning.lastChange` | string | json | r | - | Last optimisation change | JSON of the last change of the automatic optimisation (kind, from, to, reason, runs, gainSec) |
| `learning.optimizeInfo` | string | json | r | - | Optimisation status | JSON: status, runs, spikes, families, trailer, lastCheckTs, nextPossibleTs, lastEndDelaySec, unclear, excluded, finalState, review, budget (jobs in a row stopped by the time budget; 0 after a complete job), jobMs (active computing time of the last job in ms) |
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
