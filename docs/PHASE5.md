# Phase 5 — QD330 printer control

**Status:** built and tested against a fake printer only. **Not validated on the real QD330.**
Control stays **disabled** until every step of the [operator checklist](#operator-validation-checklist) has passed with the user present.

Everything lives in `packages/printer/src` and is exported from `@morphix/printer`:

| File | What it holds |
|---|---|
| `index.ts` | Phase 1 observer (`TcpTransport`, `PrinterObserver`, …), unchanged behaviour; re-exports everything below |
| `protocol.ts` | Wire format: command framing, reply parsing, raw-byte upload chunks, CRC-32, M661 list parser. Pure functions |
| `names.ts` | `sanitizeFileName` (uploads), `assertStoredFileName` (files already on the printer) |
| `auth.ts` | `authorizePrint`, `PrintAuthorizer`, `PrintAuthorization` tokens |
| `control.ts` | `QD330Controller`: job control (listFiles, uploadFile, startPrint, pause, resume, cancel) and machine control (readInfo, home, setLight, setFan, setNozzleTemp, setBedTemp, coolDown, motorsOff, emergencyStop, capabilities) |
| `machine.ts` | Machine-control helpers: command builders, hard limits, `allowUnverified` flags, the command table behind `capabilities()` |
| `tracker.ts` | `JobTracker` (progress, completion/failure events), `detectActivePrint` (restart recovery) |
| `fake-server.ts` | `FakeQD330`, a fake printer on 127.0.0.1 for tests and demos |

Tests: `tests/phase5-*.test.ts` and `tests/printer-control-*.test.ts`. They only ever connect to 127.0.0.1; `tests/phase5-helpers.ts` patches `Socket.connect` so any other host fails the test.

---

## Safety model

1. **Disabled by default.** `new QD330Controller({ enabled, host })` requires an explicit boolean. With `enabled: false`, every control method (`listFiles`, `uploadFile`, `startPrint`, `pause`, `resume`, `cancel`) throws `ControllerDisabledError` before opening a socket, and a `rejected` log entry is written. There is no setter: turning control on means constructing a new controller.
2. **Separate from observation.** The Phase 1 observer and its read-only allowlist are unchanged. `controller.transport` is a read-only transport (same allowlist) that shares the controller's queue, so status polls and control sessions never overlap. It works while control is disabled.
3. **Approval tokens.** Anything that starts or changes a print needs a `PrintAuthorization` from `authorizePrint({ jobId, fileName, approvedBy: "touch" | "voice", expiresInMs })`:
   - only tokens issued by this process are accepted (looked up by a random id; a copied or edited token is `unknown`/`tampered`);
   - bound to one `jobId` **and** one `fileName`; mismatches are rejected;
   - short-lived: default 2 min, hard cap 10 min;
   - `startPrint` and `resume` **consume** the token (single use). The token is consumed right before the command is sent, so a busy printer or a missing file does not burn the approval;
   - `uploadFile` checks the token but does not consume it, so one approval covers "upload this file, then start it".
   - Rejections throw `PrintAuthorizationError` with `code`: `missing | unknown | tampered | expired | reused | job-mismatch | file-mismatch`. Nothing is sent.
4. **Pause and cancel need no token** (stopping must always be possible) but take `{ requestedBy: "touch" | "voice" | "guardian" | "system", reason? }` and are always logged.
5. **Confirmed, not assumed.** Every result is `{ sent, acknowledged, confirmed, status, error }`. Only `confirmed` means done, and it is set only when the printer's own status (M119/M27, polled until a timeout) shows the expected change. A `Received … ok` reply without the status change is reported as `acknowledged: true, confirmed: false` with an error.
6. **Preconditions before sending.** Upload only when `READY` and (unless `overwrite`) the name is not already stored. Start only when `READY` and the file is in the M661 list. Pause only when `BUILDING_FROM_SD`. Resume only from a paused status, and only for the paused file. Cancel is always sent.
7. **File names.** Uploads are sanitised to `[A-Za-z0-9._-]`, ≤ 64 chars, `.gx` only (`.g` only with `allowPlainGcode: true`; plain `.g` was only ever tried with the old framed upload, which corrupted the file). Files already on the printer (e.g. official Afinia files with spaces) are passed through `assertStoredFileName`, which rejects `/ \ ~`, control characters and leading dots, so nothing can inject a second command.
8. **No direct G-code.** The controller has no method that sends arbitrary commands; commands are built only from the verbs listed below.
9. **One thing at a time.** All control and status traffic goes through one queue; every session is `M601 S1 … M602`.
10. **Machine controls** ([below](#machine-controls)) are behind the same `enabled` switch. Commands not verified on this printer also need their own `allowUnverified` flag, set by the operator one at a time after the [machine checklist](#machine-controls-validation-checklist). Heating needs an explicit `approvedBy` and arms an idle safety timer. Repeated taps are debounced. Cancel, cool-down and emergency stop are never debounced.

---

## API

### `QD330Controller`

```ts
const controller = new QD330Controller({
  enabled: false,              // required, explicit
  host: "192.168.10.51",
  port: 8899,
  // optional (defaults):
  connectTimeoutMs: 4000,
  replyTimeoutMs: 5000,
  startReplyTimeoutMs: 10_000, // M23 reply
  uploadFinishTimeoutMs: 15_000, // M29 reply
  startConfirmTimeoutMs: 20_000, // wait for BUILDING_FROM_SD after M23
  confirmTimeoutMs: 10_000,    // wait for the expected status after M25/M24/M26
  pollIntervalMs: 1000,
  packetDelayMs: 0,            // between 4 KB upload chunks
  uploadFlushDelayMs: 3000,    // pause before M29
  maxUploadBytes: 64 MiB,
  allowPlainGcode: false,
  pausedStatuses: ["PAUSED"],  // UNVERIFIED — set from checklist step 6
  authorizer: defaultPrintAuthorizer,
  log: (entry: ControlLogEntry) => void,
});
```

| Method | Command(s) | Token | Confirmed when | Hardware-verified |
|---|---|---|---|---|
| `readStatus()` | M119 M105 M114 M27 | — | (read-only, allowed while disabled) | yes |
| `listFiles()` | M661 | — | binary list parsed | yes |
| `uploadFile(name, data, { jobId, authorization, onProgress?, overwrite? })` | M28, raw bytes, 3 s pause, M29 | checked, not consumed | file appears in M661 | single packet only |
| `startPrint({ jobId, fileName, authorization })` | M23 `0:/user/<name>` | consumed | `MachineStatus: BUILDING_FROM_SD` and `CurrentFile` matches | yes (status change); a real `.gx` print: **no** |
| `pause({ requestedBy, reason? })` | M25 | none, logged | `MachineStatus` ∈ `pausedStatuses` | **no** |
| `resume({ jobId, fileName, authorization })` | M24 | consumed | `MachineStatus: BUILDING_FROM_SD` | **no** |
| `cancel({ requestedBy, reason? })` | M26 | none, logged | `MachineStatus: READY` | yes |

`ControlResult<T>`:

```ts
{
  op: "listFiles" | "upload" | "start" | "pause" | "resume" | "cancel";
  sent: boolean;          // the control command reached the socket
  acknowledged: boolean;  // "CMD <X> Received." … "ok", no error text
  confirmed: boolean;     // printer status shows the change — the only "done"
  protocolVerified: boolean; // false for M24/M25
  status?: PrinterStatus; // last status read during the operation
  reply?: string; error?: string; data?: T;
}
```

Throws (nothing sent): `ControllerDisabledError`, `PrintAuthorizationError`, `InvalidFileNameError`, `RangeError` (empty/oversized upload). Every other problem (timeout, dropped connection, printer refusing control, wrong status) comes back as a result with `error` set and `confirmed: false`.

`UploadProgress` passed to `onProgress` after each 4 KB chunk: `{ bytesSent, totalBytes, packetsSent, totalPackets, percent }`.

`ControlLogEntry`: `{ at, op, outcome: "rejected" | "failed" | "unconfirmed" | "confirmed", jobId?, fileName?, approvedBy?, requestedBy?, reason?, sent, acknowledged, confirmed, error?, status? }`.

### Approval

```ts
const token = authorizePrint({ jobId, fileName: "Robot_Arm.gx", approvedBy: "touch", expiresInMs: 60_000 });
```

`PrintAuthorizer` (class) exists for tests and custom clocks; `defaultPrintAuthorizer` is the process-wide instance used by `authorizePrint` and by every controller unless one is passed in. `revoke(token)` cancels an approval.

### Job tracking

```ts
const tracker = new JobTracker({ pausedStatuses, completeAtProgress: 99 });
tracker.on("progress", (job) => …);  // also: started, recovered, paused, resumed,
                                      // completed, cancelled, failed, offline, online,
                                      // unknownStatus(job, machineStatus), change
tracker.update(status);               // feed every PrinterObserver status
tracker.track({ jobId, fileName, status }); // after startPrint() is confirmed
tracker.noteCancelRequested();        // before/when cancel() is sent
tracker.attachJob(jobId);             // link a recovered print to a DB job
tracker.job;                          // { jobId, fileName, phase, progress, layer, recovered, offline, … }
detectActivePrint(status, pausedStatuses) // { fileName, paused, progress, layer } | null
```

Rules: `BUILDING_FROM_SD` or a paused status with no tracked job → `recovered` (app restart, or a print started at the printer). Return to `READY` → `cancelled` if a cancel was noted, else `completed` if progress ≥ `completeAtProgress` or the last layer was reached (looking at both the last building status and the READY status), else `failed`. Any other MachineStatus → `unknownStatus`, no outcome guessed. Offline polls keep the job (the SD print carries on) and emit `offline`/`online`. Completion detection is a heuristic until checklist step 4 confirms what M27 shows at the end of a real print.

### Fake printer

```ts
const fake = new FakeQD330({ files: { "cube.gx": buf }, pausedStatus: "PAUSED", stateChangeDelayMs: 0, m661Ok: true,
  failures: { refuseControl, silent: ["M23"], dropOn: ["M26"], corruptPacket: 1, dropOnPacket: 2, rejectUpload,
              loseUploadedFile, ignoreStart, ignorePause, ignoreResume, ignoreCancel } });
const port = await fake.listen();   // always 127.0.0.1
fake.setProgress(45, [45, 100]); fake.finishPrint(); fake.abortPrint();
fake.received;      // every command, in order
fake.uploads;       // upload outcomes
fake.controlConflicts; // M601 attempts refused because another connection held control
await fake.close();
```

Reply formats copied from the real printer: `CMD X Received.` … `ok`, `Control Success V2.1.`, `Control Release.`, M115/M119/M105/M114/M27 bodies, the binary M661 list, `Writing to file: /data/<name>`, `File opened: <name> Size: <n>` / `File selected`. Error wordings (M28/M29/M23 failures, per-packet CRC errors, `Control failed.`) and the paused status string are guesses and are marked `UNVERIFIED` in the source.

---

## Machine controls

Same controller, same `ControlResult` shape, same log. `protocolVerified` is `true` only for commands checked on the real QD330.

```ts
const controller = new QD330Controller({
  enabled: settings.printControlsEnabled === true,
  host: "192.168.10.51",
  allowUnverified: {           // all default false; set one by one after the checklist below
    light: false,              // setLight (M146)
    fan: false,                // setFan (M106/M107)
    temperatures: false,       // setNozzleTemp, setBedTemp, coolDown (M104/M140)
    motors: false,             // motorsOff (M18)
    emergencyStopM112: false,  // emergencyStop also sends M112 first
  },
  heaterIdleTimeoutMs: 15 * 60_000, // heaters off after this long without a heating command, unless printing
  heaterRetryMs: 30_000,            // retry interval if that cool-down could not be sent
  minCommandIntervalMs: 1000,       // debounce for repeated machine commands
  cancelCoolDownWindowMs: 120_000,  // after a cancel, cooling is allowed even if the status still shows the print
  homeConfirmTimeoutMs: 60_000,     // G28 reply + confirmation
  homePosition: { x: 110, y: 110, z: 220 }, // verified
  maxNozzleC: 250, maxBedC: 100,    // may be lowered, never raised (constructor throws)
});
```

| Method | Command(s) | Flag | State rule | Confirmed when | Verified |
|---|---|---|---|---|---|
| `readInfo({ requestedBy? })` | M115 | — (read-only, works while disabled) | any | machine type/firmware parsed | yes |
| `home({ requestedBy, reason? })` | G28 | — | READY and not MOVING | M114 at `homePosition` (±0.5 mm) and MoveMode ≠ MOVING | yes |
| `setLight(true \| false \| {r,g,b}, { requestedBy })` | `M146 r<r> g<g> b<b> F0` | `light` | any (also while printing) | M119 `LED:` matches on/off (the colour cannot be read back) | **no** |
| `setFan(true \| false \| 0-100, { requestedBy })` | `M106 S<0-255>` / `M107` | `fan` | any | never: no fan read-back. `acknowledged` + `note` | **no** |
| `setNozzleTemp(c, { requestedBy, approvedBy? })` | `M104 S<c> T0` | `temperatures` | heating: READY; 0 °C: not printing (or cancel window) | M105 `T0` target = c (±0.5) | **no** |
| `setBedTemp(c, { requestedBy, approvedBy? })` | `M140 S<c>` | `temperatures` | as above | M105 `B` target = c | **no** |
| `coolDown({ requestedBy })` | `M104 S0 T0`, `M140 S0` | `temperatures` | not printing (or cancel window) | both targets 0 | **no** |
| `motorsOff({ requestedBy })` | M18 | `motors` | READY and not MOVING | never: no read-back. `acknowledged` + `note` | **no** |
| `emergencyStop({ requestedBy })` | [M112], M26, `M104 S0 T0`, `M140 S0` | M112 only with `emergencyStopM112` | any | READY and both targets 0 | M26 yes; M104/M140/M112 no → `protocolVerified: false` |
| `capabilities(status?)` | — | — | — | — | — |
| `heaterSafety()` | — | — | — | `{ armed, expiresAt, remainingMs, targets }` | — |
| `dispose()` | — | — | — | stops the heater timer (call on shutdown) | — |

`requestedBy` is required on every machine command: `"touch" | "voice" | "portal" | "guardian" | "system"`. It is written to every log entry together with `command` (the exact G-code, e.g. `M104 S200 T0`).

**Throws (nothing sent, `rejected` log entry):**
- `ControllerDisabledError`: controller disabled.
- `CommandDisabledError` (a subclass of `ControllerDisabledError`, with `.command` and `.flag`): the command's `allowUnverified` flag is off. The message names the flag to set.
- `ControlLimitError` (a `RangeError`): temperature outside 0–250 °C nozzle / 0–100 °C bed (or the lowered limits), fan outside 0–100 %, colour channel not an integer 0–255.
- `HeaterApprovalError`: heating (target > 0) without `approvedBy: "touch" | "voice" | "portal"`. Setting 0 °C needs no approval.
- `RateLimitedError` (with `.retryAfterMs`): the same command was accepted less than `minCommandIntervalMs` ago, or a *different* request for it is still running. An *identical* request while one is running gets the same result object (duplicate taps send once).
- `TypeError`: missing or unknown `requestedBy`.

State problems (printing, moving, unreachable) come back as a result with `sent: false` and `error`, like `pause`/`startPrint`.

### Rules

- **Temperatures during a print:** refused (heating and cooling). Exception: within `cancelCoolDownWindowMs` after `cancel()`/`emergencyStop()` sent M26, cooling is allowed even if the printer still reports the print. Heating is never allowed then.
- **Heater idle timer:** every heating command (re)arms it, *before* the command is sent (if the reply is lost the heater may still be on). When it fires: if a print is running (BUILDING or paused) it re-arms for another period; otherwise it runs a cool-down logged as `{ op: "coolDown", requestedBy: "system", reason: "heater idle timeout" }`; if that cannot be sent it retries every `heaterRetryMs`. Setting both heaters to 0, `coolDown()` and `emergencyStop()` disarm it. The timer lives in the app process: if Morphix exits, the printer keeps whatever target it had.
- **Debounce:** per command, measured from the last accepted request. Not applied to job control (`startPrint`, `pause`, `cancel`, …), `coolDown` or `emergencyStop`.
- **Confirmation without read-back:** `setFan` and `motorsOff` can never be `confirmed` (the QD330 reports neither); they return `acknowledged: true`, `confirmed: false` and a `note`. UIs should show "sent" for these, not "failed". `home` adds a `note` when the head was already at the home position (nothing observable changed).

### Emergency stop: why not M112

`emergencyStop()` is **cancel + heaters off**, not M112:

1. M26 (cancel) is verified on this printer and stops the job. M104/M140 S0 can only remove heat, so they are sent even when `allowUnverified.temperatures` is off.
2. M112 is unverified here. On Marlin-like firmware it halts everything until a power cycle; on FlashForge firmware its effect is unknown (it might do nothing, or leave the printer needing a power cycle while hot). It is therefore only sent, *first*, when the operator sets `allowUnverified.emergencyStopM112` after checklist step M8.
3. Each step is sent even if an earlier one fails, and a dropped link gets one retry on a fresh session. The result lists every step (`data.steps`), `confirmed` means READY with both targets 0.
4. It bumps an interrupt counter: operations queued before it are dropped (`error: "not sent: an emergency stop was requested before …"`), and a confirmation wait in progress (e.g. homing, start) ends at its next poll. An upload already sending packets finishes its packets first (aborting mid-packet would leave the printer in data mode).
5. Never debounced; duplicate taps share one run. **It does not replace the printer's power switch**: if `confirmed` is false the UI must say "use the printer's own screen or power switch".

Call `tracker.noteCancelRequested()` before `emergencyStop()`, as for `cancel()`.

### `capabilities()`

Returns one entry per command (job and machine control) for building buttons, voice tools and portal menus:

```ts
{
  command: "setNozzleTemp", label: "Nozzle temperature", gcode: ["M104"],
  protocolVerified: false, flag: "temperatures", readOnly: false,
  state: "notPrinting", approval: "heater", rateLimited: true,
  enabled: true,        // controller enabled and flag on (read-only commands: always)
  allowedNow: false,    // enabled and the last known state allows it
  reason: "printer is BUILDING_FROM_SD; temperatures are not changed during a print",
}
```

It uses the last status the controller saw (its own reads and every observer poll through `controller.transport`), or a status you pass. With no status yet, state-dependent commands report `"printer status not known yet"`. It is advisory: every method re-reads the printer before sending.

### Fake printer additions

`FakeQD330` now emulates G28 (`homeDurationMs` with MoveMode MOVING, then M114 at 110/110/220, `homeCount`), M146 (`led`, `ledColor`, M119 `LED:`), M106/M107 (`fanPwm`, `fanPercent`), M104/M140 targets with heating/cooling over time (`nozzle`, `bed`, `heatRatePerSec`, `coolRatePerSec`, `setTemp()`), M23 setting print targets (`printTargets`, default 210/50), M26 optionally clearing them (`cancelClearsTargets`, default false), M18 (`motorsEnabled`), M112 (`emergencyHalted`). Extra failures: `ignoreHome`, `ignoreLight`, `ignoreFan`, `ignoreTemps`, `ignoreMotors`, `rejectVerbs: ["M146"]`, `noLedInM119`, `dropAfterM112`. Untouched, it still reports the recorded M105/M114 lines exactly.

---

## What is verified and what is not

| Fact | Status |
|---|---|
| `~CMD\r\n` framing, `CMD X Received.` … `ok` replies | verified |
| M601 S1 / M602 session | verified |
| M115, M119, M105, M114, M27 formats | verified |
| M661 binary list | verified |
| M28 `<size> 0:/user/<name>` → `Writing to file: /data/<name>` | verified |
| Upload data | **raw bytes, no framing** (as in the open FlashForge Adventurer 4 / legacy-TCP clients). The old 16-byte-header + 4096-padding framing was wrong: the printer stored the header as the start of the file, so jobs opened at 0% and never heated, and the extra bytes swallowed M29 |
| Per-packet replies / error reporting during upload | unknown (controller scans any unsolicited text for error words) |
| M29 reply | expected to end in `ok` once the data is raw; a missing reply now fails the upload |
| M23 → `BUILDING_FROM_SD`, `CurrentFile` | verified (the earlier 0% stalls were the corrupted framed uploads) |
| A real `.gx` printing to completion; M27 values at the end | **unverified** |
| M26 cancel → `READY` | verified |
| M25 pause / M24 resume, and the paused MachineStatus string | **unverified** |
| Whether the printer accepts a second control connection | unknown (controller never opens two) |
| G28 homes X/Y to 110, Z to 220 | verified (when the reply arrives — before or after the move — unknown; 60 s timeout) |
| G1 moves over the network | accepted but ignored (no jog controls offered) |
| M146 light, and M119 `LED:` following it | **unverified** |
| M106/M107 fan; whether M119 `Status: … F:` reflects the fan | **unverified** |
| M104 `S<c> T0` / M140 `S<c>`, and M105 targets following them | **unverified** |
| Whether M26 clears heater targets | **unknown** (emergency stop sends M104/M140 S0 anyway) |
| M18 motors off | **unverified** |
| M112 emergency stop | **unverified** (off unless `emergencyStopM112`) |

---

## Integration steps (apps/desktop — for the coordinator)

1. **Construct once in the main process**, disabled unless the operator turned it on after the checklist:
   ```ts
   const controller = new QD330Controller({
     enabled: settings.printControlsEnabled === true,   // stays false until sign-off
     host: settings.printerHost,
     pausedStatuses: settings.printerPausedStatuses ?? ["PAUSED"],
     log: (e) => logger.info("printer-control", e),     // persist to the logs table
   });
   ```
2. **Route observation through the controller's queue:** replace `new PrinterObserver(new TcpTransport(host), onStatus)` with `new PrinterObserver(controller.transport, onStatus)`. Behaviour is the same (read-only allowlist), but polls can no longer collide with a control session.
3. **Track jobs:** `const tracker = new JobTracker({ pausedStatuses })`; call `tracker.update(status)` in the observer callback; forward tracker events to the renderer over IPC.
4. **On start-up:** after the first poll, `detectActivePrint(observer.status)`. If it returns a print, look up the matching job by file name, `tracker.attachJob(id)`, move the workflow to `printing` (domain `transition` with `printControlsEnabled`), and show "print in progress" instead of the idle screen. Do not start anything.
5. **Approval flow (touch):** the confirm screen shows file, model, estimated time and filament. Only the confirm button handler in the **main process** calls `authorizePrint({ jobId, fileName, approvedBy: "touch", expiresInMs: 60_000 })`. Then `uploadFile` → if `confirmed`, `startPrint` with the same token → if `confirmed`, `tracker.track(...)` and the domain transition to `printing` (`userApproved: true`). Show `error` to the user on any unconfirmed step; never show "printing" unless `startPrint(...).confirmed`.
6. **Approval flow (voice):** Gemini's tool call may only *request* a print. The main process asks the user to confirm ("Say 'yes, print' to start Robot_Arm.gx") and mints the token with `approvedBy: "voice"` only after it hears the confirmation. The model must never be able to call `authorizePrint` directly.
7. **Pause / cancel:** buttons, voice and the Phase 4 guardian call `controller.pause({ requestedBy, reason })` / `controller.cancel(...)`. Call `tracker.noteCancelRequested()` before cancel. Show "pausing…/cancelling…" until the result is `confirmed`; if not confirmed, tell the user to use the printer's own screen.
8. **Resume:** needs a fresh confirmation → new token for the same job and file.
9. **Settings:** keep `printControlsEnabled: false` in shipped config. Turning it on is an operator action after sign-off (below), never something the app or the assistant does.

### Machine controls (touchscreen, voice, portal)

10. **Construct** the controller with `allowUnverified` read from settings (e.g. `settings.printerAllowUnverified`, default all false), and call `controller.dispose()` on app quit (after `coolDown()` if `heaterSafety().armed`).
11. **Touchscreen:** build the machine panel from `controller.capabilities()`; refresh it on each observer status. Hide entries with `enabled: false`; grey out `allowedNow: false` and show `reason`. Suggested buttons: Home, Light on/off (+ colour), Fan 0/50/100 %, Nozzle and Bed presets (e.g. PLA 200/60) with a confirm tap → `approvedBy: "touch"`, Cool down, Motors off, and a red **Emergency stop** reachable from every screen. Show a heater countdown from `heaterSafety()`. Label results: `confirmed` → done; `acknowledged && !confirmed && note` → "sent"; otherwise show `error`. Show an "unverified" badge where `protocolVerified` is false. Catch `RateLimitedError` silently (a repeated tap).
12. **Voice (Gemini tools):** expose `printer_home`, `printer_light(on|color)`, `printer_fan(percent)`, `printer_cool_down`, `printer_motors_off`, `printer_emergency_stop`, `printer_info` and a `printer_set_temperature(heater, celsius)` tool, all with `requestedBy: "voice"`. Heating follows the print-approval pattern: the tool only *requests* it; the main process asks "Heat the nozzle to 200 °C? Say yes to confirm" and calls `setNozzleTemp(200, { requestedBy: "voice", approvedBy: "voice" })` only after hearing yes. The model must never pass `approvedBy` itself. "Stop"/"emergency stop" maps to `emergencyStop` with no confirmation. Speak `error`/`note` back.
13. **Portal (admin):** expose the same commands as admin-only endpoints with `requestedBy: "portal"`; heating needs a confirm dialog in the portal and then `approvedBy: "portal"`. Serve `capabilities()` and `heaterSafety()` read-only to the portal so it can render state; return the `ControlResult` as-is. Never let the portal change `enabled` or `allowUnverified` (they are constructor-only; changing them means an operator edits settings and the app restarts the controller).
14. **Guardian:** keep using `pause`. It may use `emergencyStop({ requestedBy: "guardian" })` only if the operator wants that; it can never heat (no `approvedBy`).
15. **Logs:** every entry has `op`, `requestedBy`, `approvedBy` (heating), `command`, `outcome`. Persist them like the job-control entries.

The domain package already blocks `uploading`/`ready`/`printing` without `printControlsEnabled` and `userApproved`; keep both checks: the domain guard protects the workflow state, the controller guard protects the printer.

---

## Operator validation checklist

Run on the Pi, at the printer, **with the user present and watching the printer**, one command at a time. For each step write down the exact replies (copy from the control log) in `docs/PHASE5-validation.md`. Stop at the first surprise. Keep a hand near the printer's power switch.

Use a throw-away script or the Node REPL with `new QD330Controller({ enabled: true, host: "192.168.10.51", log: console.log })`. This is the only place `enabled: true` is allowed before sign-off; the app's setting stays off.

**0. Preconditions**
- [ ] Bed clear, filament loaded, nozzle clean; printer shows READY on its own screen.
- [ ] The Afinia software's own print of the same file works (known-good printer).
- [ ] `controller.readStatus()` → `machine: "READY"`, sensible temperatures.

**1. List files (M661)**
- [ ] `listFiles()` returns the files the printer's own screen shows. Note the exact name of an **official Afinia `.gx`** already on the printer (e.g. a calibration cube).

**2. Approval gate dry run (no printer traffic expected)**
- [ ] `startPrint` with no token, an expired token, and a token for a different file all throw `PrintAuthorizationError`; the log shows `rejected`; the printer does nothing.

**3. Start the official `.gx` (M23)**
- [ ] `startPrint({ jobId: "val-1", fileName: "<official>.gx", authorization: authorizePrint({ jobId: "val-1", fileName: "<official>.gx", approvedBy: "touch" }) })`.
- [ ] Result `confirmed: true`; the printer heats and starts printing.
- [ ] Record `MachineStatus`, `CurrentFile` (with or without path/extension?), and M27 during heating and printing.

**4. Let it run, watch tracking**
- [ ] Progress and layer advance in the observer/tracker.
- [ ] Either let it finish and record M119/M27 at the end (sets the completion heuristic), or go on to step 5.

**5. Pause (M25) — unverified command**
- [ ] `pause({ requestedBy: "touch", reason: "validation" })`. The head should park/stop.
- [ ] Record the exact `MachineStatus` while paused. If it is not `PAUSED`, the result is `confirmed: false`: this is expected — add the observed value to `pausedStatuses` and repeat.
- [ ] Check what happens to nozzle/bed temperatures during pause.

**6. Resume (M24) — unverified command**
- [ ] `resume({ jobId: "val-1", fileName, authorization: <fresh token> })` → printing continues where it stopped, `confirmed: true`.

**7. Cancel (M26)**
- [ ] `cancel({ requestedBy: "touch", reason: "validation" })` → printer stops, `confirmed: true` (READY). Record what M27 shows afterwards and whether heaters turn off.
- [ ] Remove the partial print.

**8. Upload a known-good `.gx` (M28/M29)**
- [ ] Take a `.gx` produced by the official Afinia/FlashPrint software for this printer (several packets in size, e.g. > 50 KB).
- [ ] `uploadFile("validation_cube.gx", data, { jobId: "val-2", authorization, onProgress: console.log })` → `confirmed: true`; the file shows on the printer's screen.
- [ ] Note any per-packet replies the printer sent (they appear in errors/logs) and how long M29 took. Adjust `packetDelayMs` if needed.
- [ ] Start it with the same token (`startPrint`) → prints correctly from the first layer (proves the upload was byte-exact). Cancel after a few layers.

**9. Upload a Morphix/Phase 3 `.gx`**
- [ ] Same as step 8 with a file from `packages/slicing`; watch the first layer closely. Cancel at the first sign of trouble.

**10. Failure behaviour**
- [ ] Unplug Ethernet during a print: tracker emits `offline`, print continues, `online` on reconnect, no false `failed`.
- [ ] Restart the app mid-print: start-up shows the print as recovered; nothing is re-sent.
- [ ] Cancel from the printer's own screen: tracker reports `failed` (unexplained stop) — not `completed`.

### Before `enabled` may be turned on in the app

All of the following must be true and written down:

- [ ] Steps 0–10 passed with the user present; replies recorded in `docs/PHASE5-validation.md`.
- [ ] `pausedStatuses` set to the value observed in step 5 (or pause disabled in the UI if M25 did not work).
- [ ] Completion detection checked against a real finished print (step 4); `completeAtProgress` adjusted if needed.
- [ ] Multi-packet upload proven byte-exact (step 8 printed correctly).
- [ ] The app's approval screens (touch and voice) mint tokens only in the main process after an explicit user action, and show "printing" only on `confirmed`.
- [ ] Cancel is reachable from every screen and from voice. Note: operations are queued, so a cancel issued during a start waits for that start's confirmation window (`startConfirmTimeoutMs`, default 20 s); the UI must say "cancelling…" meanwhile and point to the printer's own screen if it does not confirm.
- [ ] The user signs off on Phase 5 in `docs/PHASES.md`.

Until then: `printControlsEnabled: false`, and Morphix only observes.

### Machine controls validation checklist

Same rules as above: on the Pi, at the printer, **user present**, one command at a time, replies recorded in `docs/PHASE5-validation.md`, hand near the power switch. Use a REPL controller with `enabled: true` and **only the one flag under test** in `allowUnverified`, e.g. `new QD330Controller({ enabled: true, host: "192.168.10.51", allowUnverified: { light: true }, log: console.log })`. After each passing step, add that flag to the app's settings; never enable a flag whose step has not passed.

**M0. Info and capabilities (no flags)**
- [ ] `readInfo({ requestedBy: "touch" })` → `confirmed: true`, firmware v2.1.3; record the raw reply.
- [ ] `capabilities()` after `readStatus()`: every unverified command shows `enabled: false`; `home`, `cancel`, `emergencyStop` show `allowedNow: true` at READY.
- [ ] `setLight(true, …)` with no flag throws `CommandDisabledError` naming `allowUnverified.light`; nothing happens at the printer.

**M1. Home (G28, verified — re-check)**
- [ ] Bed clear. `home({ requestedBy: "touch" })` → head homes, `confirmed: true`, position 110/110/220.
- [ ] Record how long the G28 reply took (before or after the move). If after, keep `homeConfirmTimeoutMs` ≥ that.
- [ ] Start a print (or use one in progress), call `home` → `sent: false`, "refused while printing".

**M2. Light (M146) — flag `light`**
- [ ] `setLight(false, …)` → light turns off. Record M119 `LED:` → result `confirmed: true` only if it reads 0.
- [ ] `setLight(true, …)` → white again. `setLight({ r: 255, g: 0, b: 0 }, …)` → does the colour change, or only on/off? Record.
- [ ] If the light changes but `LED:` does not follow: record it; results stay unconfirmed (leave the flag off or accept "sent" in the UI). If nothing happens: leave `light` off.

**M3. Fan (M106/M107) — flag `fan`**
- [ ] `setFan(100, …)` → the part-cooling fan spins up audibly. `setFan(50, …)` → slower. `setFan(false, …)` → stops.
- [ ] Record M119 (`Status: S:… F:…`) before/after: if `F` follows the fan, note it so confirmation can be added later.
- [ ] Check the hotend fan is not affected (it must stay automatic).

**M4. Temperatures (M104/M140) — flag `temperatures`**
- [ ] `setNozzleTemp(150, { requestedBy: "touch", approvedBy: "touch" })` → M105 target `T0:…/150`, `confirmed: true`, the printer's screen shows heating; temperature rises.
- [ ] `setBedTemp(40, { requestedBy: "touch", approvedBy: "touch" })` → bed target 40, `confirmed: true`.
- [ ] `coolDown({ requestedBy: "touch" })` → both targets 0, `confirmed: true`, temperatures fall.
- [ ] Limits: `setNozzleTemp(251, …)` and `setBedTemp(101, …)` throw, and heating without `approvedBy` throws; nothing changes at the printer.
- [ ] Safety timer: with `heaterIdleTimeoutMs: 60_000`, heat the nozzle to 150 and wait 1 min → targets go to 0 by themselves; log shows `coolDown` by `system`.
- [ ] During a print: `setNozzleTemp(…)` and `coolDown()` → `sent: false`. Then `cancel()`; within 2 min `coolDown()` is accepted. Record whether M26 alone already cleared the targets (step 7 of the job checklist).

**M5. Motors off (M18) — flag `motors`**
- [ ] At READY, after homing: `motorsOff({ requestedBy: "touch" })` → the X/Y carriage can be pushed by hand (gently). Result `acknowledged: true`, `confirmed: false` with a note — expected.
- [ ] `home()` afterwards works and re-energises the motors.
- [ ] During a print: `motorsOff` → `sent: false`.

**M6. Emergency stop (no M112)**
- [ ] Start a print (official `.gx`), let it heat and begin. `emergencyStop({ requestedBy: "touch", reason: "validation" })` → printing stops, both targets 0, `confirmed: true`. Record how long until READY.
- [ ] Repeat by voice ("stop") through the app once the app wiring exists.
- [ ] Remove the partial print.

**M7. Debounce**
- [ ] Tap the Light button rapidly 5× in the app: one M146 per second at most in the log; the rest are `rejected` (`RateLimitedError`) or share the running result.

**M8. M112 (optional — only if the owner wants it) — flag `emergencyStopM112`**
- [ ] Only with the user's explicit agreement, at READY with heaters cold first: send `emergencyStop` with `emergencyStopM112: true`. Record exactly what the printer does (halt? needs power cycle? screen message?) and whether M26/M104/M140 still work afterwards.
- [ ] If it requires a power cycle or leaves anything in an unclear state, **leave the flag off**: cancel + cool-down is the emergency stop.

### Before machine flags may be turned on in the app

- [ ] Each flag's step (M2–M5, M8) passed with the user present and replies are recorded.
- [ ] `heaterIdleTimeoutMs` agreed with the owner (default 15 min) and M4's timer check passed.
- [ ] Emergency stop (M6) is reachable from every screen and by voice, and the UI tells the user to use the printer's screen/power switch when it is not `confirmed`.
- [ ] Voice heating goes through a spoken confirmation in the main process; the portal requires a confirm dialog.

## Bed leveling before every print

The Afinia QD330 User Guide (01-12-2024, §5.1 and Q&A Q3/Q5) says the printer's own firmware
does "one-click auto leveling", that it "defaults to the leveling operation before each
print", and that it can be switched on in the printer's settings ("enable automatic leveling
before printing"). It names no G-code, and no official Afinia `.gx` has been read yet, so
**Morphix has no verified leveling command**.

- **Default (`gcode` mode, command UNVERIFIED):** every print levels the bed. Morphix writes
  `G29` (the usual bed-leveling G-code) at the leveling step of the start G-code
  (`;MORPHIX_LEVEL_BED`, after homing with the bed at temperature, before the nozzle heats and
  primes), then lifts to Z10. `MORPHIX_LEVEL_GCODE` replaces `G29` with the command an official
  Afinia `.gx` really uses (up to 4 commands separated by `;`; motion, heating, job, file and
  firmware commands are refused). Code: `packages/slicing/src/leveling.ts`.
- **Off (`printer` mode):** `MORPHIX_LEVELING=printer` adds nothing and leaves leveling to the
  QD330's own "automatic leveling before printing" setting (L1).

**L1. Check that every print levels (default, do this first)**
- [ ] With the user at the printer and the bed clear, prepare a small print (leveling is written
  in at Prepare) and print it. Watch the first minutes.
- [ ] Pass: after homing and once the bed is hot, the nozzle probes several points, then it
  heats the nozzle and prints with a good first layer. Write down how long probing took.
- [ ] Fail: it stops with an error or "unknown command", or does not probe. Go to L2.

**L2. The right command for this firmware (only if L1 failed)**
- [ ] Read the start of an official `.gx` (docs/PHASE3.md, "Validating against a real .gx")
  and look for its leveling command. Put it in `MORPHIX_LEVEL_GCODE`, restart Morphix and
  repeat L1.
- [ ] If none works: set `MORPHIX_LEVELING=printer`, switch on automatic leveling before
  printing on the QD330 touchscreen (Afinia guide Q5) and record what happened here.
