# Safety

A 3D printer has hot parts and moving parts, and Morphix can be driven by voice and AI. This page
explains what Morphix will and will not do on its own, how printer control is unlocked, and the
checks an operator runs at the printer before turning anything on. It applies to users and to
anyone writing a printer driver, slicer adapter or AI feature.

Morphix does not replace a person watching the printer. Keep the printer's own screen and power
switch within reach.

## The rules

1. **Nothing moves, heats or starts unless the user asked and the printer state allows it.** Every
   control command is checked against the printer's current status before it is sent (for example:
   start only from READY, pause only while printing, no temperature changes during a print).
2. **Temperatures stay within the printer model's limits.** Set temperatures are limited to the
   catalog model's `maxNozzleC` / `maxBedC` ([catalog types](../packages/catalog/src/types.ts)).
   The QD330 controller has hard caps of 250 °C nozzle and 100 °C bed; they can be lowered, never
   raised, and an out-of-range value is refused with `ControlLimitError` rather than sent
   ([machine.ts](../packages/printer/src/machine.ts)).
3. **No raw G-code.** The controller has no method that sends arbitrary commands. Commands are
   built only from a fixed list of verbs. Read-only status polling uses a separate allowlist.
4. **"Done" means the printer says so.** A reply alone is never reported as success (see
   [Confirmed, not assumed](#confirmed-not-assumed)).
5. **Never claim hardware support that was not tried.** A driver written from a protocol document
   but not run on a real printer says `verified: "protocol"`, and its doc says so plainly.
6. **Secrets stay secret** (see [Secrets](#secrets)).

## Print controls are locked by default

Out of the box Morphix only *observes* the printer. Control is unlocked in layers, by the
operator, through environment variables read at start-up (see
[config/morphix.env.example](../config/morphix.env.example)). Neither the app nor the assistant
can change them; changing one means editing the environment and restarting Morphix.

| Setting | Default | What it unlocks |
|---|---|---|
| `MORPHIX_PRINT_CONTROLS=1` | off | Constructs the printer controller with `enabled: true`. While off, every control method throws `ControllerDisabledError` before a socket is opened, the attempt is logged as `rejected`, and the workflow refuses the `uploading` / `ready` / `printing` states. Status reading still works. |
| `MORPHIX_GX_VERIFIED=1` | off | Allows sending Morphix-generated `.gx` files. Set it only after comparing Morphix output with an official Afinia `.gx` ([QD330.md](QD330.md#validating-against-a-real-afinia-gx)). |
| `MORPHIX_PAUSED_STATUSES` | `PAUSED` | The status string(s) that mean "paused" (from checklist step 5). |
| `MORPHIX_ALLOW_UNVERIFIED=light,fan,temperatures,motors` | none | Per-command `allowUnverified` flags for machine commands not verified on the printer. Add one flag at a time, only after its machine checklist step passed. A command whose flag is off throws `CommandDisabledError` naming the flag. |

The controller also has an `allowUnverified.emergencyStopM112` flag (checklist M8). It is a
constructor option only; the app does not read it from the environment.

Two independent guards apply: the workflow guard in [packages/domain](../packages/domain/src)
protects the job state (`printControlsEnabled` and `userApproved`), and the controller guard in
[control.ts](../packages/printer/src/control.ts) protects the printer. Keep both.

## Approval before every print

Anything that starts or resumes a print needs a `PrintAuthorization`
([auth.ts](../packages/printer/src/auth.ts)), minted only after an explicit user action:

- Only tokens issued by this process are accepted; a copied or edited token is `unknown` or `tampered`.
- Bound to one job **and** one file name; any mismatch is rejected.
- Short-lived: 2 minutes by default, capped at 10 minutes.
- `startPrint` and `resume` consume the token (single use), right before the command is sent, so a
  busy printer or missing file does not burn the approval. `uploadFile` checks it without
  consuming it, so one approval covers "upload, then start".
- `approvedBy` is `"touch"` or `"voice"`. Voice: the AI's tool call may only *request* a print; the
  app asks the user, and mints the token only after hearing a clear yes. The model can never mint
  a token or pass `approvedBy` itself.
- Resume needs a fresh approval for the same job and file.

Heating outside a print also needs explicit approval: a target above 0 °C needs
`approvedBy: "touch" | "voice" | "portal"` (`HeaterApprovalError` otherwise). Setting 0 °C needs
none. Each heating command arms an idle timer (default 15 min) that turns the heaters off unless a
print is running. The timer lives in the Morphix process: if Morphix exits, the printer keeps
whatever target it had.

Repeated taps on machine controls are debounced (default 1 s). Cancel, cool-down and emergency
stop are never debounced.

## Confirmed, not assumed

Every control result is `{ sent, acknowledged, confirmed, status, error }`. Only `confirmed` means
done, and it is set only when the printer's own status shows the expected change (polled until a
timeout). A reply without the status change is `acknowledged: true, confirmed: false` with an error.

- **Pause and cancel need no token** (stopping must always be possible) but always record
  `requestedBy` (`touch`, `voice`, `guardian`, `system`) and an optional reason.
- The UI shows "pausing…" / "cancelling…" until the result is `confirmed`, and "printing" only
  after `startPrint(...).confirmed`. If a stop is not confirmed, it tells the user to use the
  printer's own screen.
- Commands with no read-back (fan, motors off on the QD330) can never be `confirmed`; they return
  `acknowledged: true` and a `note`. Show "sent", not "failed".
- Operations are queued one at a time, so a cancel issued during a start waits for that start's
  confirmation window (default 20 s).

## Emergency stop is not M112

`emergencyStop()` is **cancel + heaters off**: the verified cancel command (M26), then nozzle and
bed to 0 °C. Setting 0 °C can only remove heat, so it is sent even when the `temperatures` flag is
off. M112 is not used by default: on Marlin-like firmware it halts everything until a power cycle,
and on the QD330's FlashForge-family firmware its effect is unknown (it might do nothing, or leave
a hot printer needing a power cycle). It is sent first only with `emergencyStopM112`, after M8.

Each step is sent even if an earlier one fails, a dropped link gets one retry, queued operations
are dropped, and duplicate taps share one run. `confirmed` means READY with both heater targets 0.
**It does not replace the power switch**: if it is not confirmed, the UI must say "use the
printer's own screen or power switch".

## Operator validation checklists

Run these at the printer, **with the user present and watching**, one command at a time, a hand
near the power switch. Write down the exact replies from the control log. Stop at the first
surprise. Use a throw-away script or REPL controller; this is the only place `enabled: true` is
used before sign-off, and the app's setting stays off. QD330 example:
`new QD330Controller({ enabled: true, host: "<printer-ip>", log: console.log })`.
The step IDs below are referenced from the code; keep them stable.

### Print-control checklist

- **Step 0. Preconditions:** [ ] bed clear, filament loaded, nozzle clean, printer READY on its own
  screen; [ ] the vendor software's own print of the same file works; [ ] a status read shows READY
  and sensible temperatures.
- **Step 1. List files:** [ ] the stored-file list matches the printer's screen; note the name of
  an official vendor file already on it. *(QD330: `listFiles()`, M661; an official Afinia `.gx`.)*
- **Step 2. Approval gate dry run** (no printer traffic): [ ] start with no token, an expired token
  and a token for another file all throw `PrintAuthorizationError`, are logged `rejected`, and the
  printer does nothing.
- **Step 3. Start the official file:** [ ] the start result is `confirmed: true`; the printer heats
  and prints; [ ] record the status and current-file fields during heating and printing.
  *(QD330: M23; record `MachineStatus`, `CurrentFile`, M27.)*
- **Step 4. Watch tracking:** [ ] progress and layer advance; [ ] let one print finish and record
  the final status: this sets the completion heuristic (`completeAtProgress`).
- **Step 5. Pause (unverified):** [ ] pause stops/parks the head; [ ] record the exact paused
  status; if the result is unconfirmed (QD330: neither `MachineStatus` nor `MoveMode` reads
  `PAUSED`), that is expected: add the observed value to `MORPHIX_PAUSED_STATUSES` and repeat;
  [ ] note what the heaters do while paused.
- **Step 6. Resume (unverified):** [ ] resume with a fresh token continues where it stopped, `confirmed: true`.
- **Step 7. Cancel:** [ ] cancel stops the printer, `confirmed: true` (READY); record whether the
  heaters turn off; [ ] remove the partial print.
- **Step 8. Upload a known-good vendor file** (several packets, e.g. > 50 KB): [ ] upload is
  `confirmed` and the file shows on the printer; [ ] note any replies during the upload and how long
  the finish took; [ ] start it with the same token: it prints correctly from the first layer
  (proves the upload was byte-exact); cancel after a few layers.
- **Step 9. Upload a Morphix-sliced file:** [ ] same as step 8; watch the first layer closely and
  cancel at the first sign of trouble.
- **Step 10. Failure behaviour:** [ ] unplug the network mid-print: tracking reports offline, the
  print continues, online again on reconnect, no false failure; [ ] restart Morphix mid-print: the
  print shows as recovered and nothing is re-sent; [ ] cancel from the printer's screen: reported as
  failed, not completed.

**Before `MORPHIX_PRINT_CONTROLS` may be turned on:** [ ] steps 0–10 passed with the user present
and the replies are written down; [ ] paused status set from step 5 (or pause disabled in the UI if
it did not work); [ ] completion detection checked against a real finished print (step 4);
[ ] multi-packet upload proven byte-exact (step 8); [ ] approval screens (touch and voice) mint
tokens only in the Morphix server process (never the browser) after an explicit user action and show "printing" only on `confirmed`;
[ ] cancel is reachable from every screen and from voice. Until then, Morphix only observes.

### Machine-controls checklist

Same rules. Enable **only the flag under test**, e.g.
`allowUnverified: { light: true }`. After a step passes, add that flag to the app's settings;
never enable a flag whose step has not passed.

- **M0. Info and capabilities (no flags):** [ ] info read is `confirmed` (QD330: M115, record the
  firmware); [ ] `capabilities()` shows every unverified command `enabled: false`, and home,
  cancel and emergency stop `allowedNow: true` at READY; [ ] an unflagged command throws
  `CommandDisabledError` and nothing happens.
- **M1. Home:** [ ] bed clear, home is `confirmed` at the home position (QD330: 110/110/220);
  [ ] record how long the reply took; [ ] during a print, home is refused (`sent: false`).
- **M2. Light** (flag `light`)**:** [ ] off/on/colour visibly change; record whether the status read-back follows. If nothing happens, leave the flag off.
- **M3. Fan** (flag `fan`)**:** [ ] 100 %, 50 %, off are audible; [ ] record whether any status field follows; [ ] the hotend fan stays automatic.
- **M4. Temperatures** (flag `temperatures`)**:** [ ] nozzle 150 °C and bed 40 °C with `approvedBy`
  are `confirmed` and rise; [ ] cool-down sets both to 0; [ ] values above the limits, and heating
  without `approvedBy`, throw and change nothing; [ ] with a 1-minute idle timeout, the heaters go to
  0 by themselves (logged as `coolDown` by `system`); [ ] during a print, heating and cool-down are
  refused; after a cancel, cool-down is accepted within 2 min. Record whether cancel alone cleared the targets.
- **M5. Motors off** (flag `motors`)**:** [ ] at READY after homing, the carriage can be pushed by
  hand; result acknowledged, not confirmed (expected); [ ] home afterwards works; [ ] refused during a print.
- **M6. Emergency stop (no M112):** [ ] during a real print it stops, both targets 0, `confirmed`;
  record the time to READY; [ ] repeat by voice ("stop"); [ ] remove the partial print.
- **M7. Debounce:** [ ] tapping a machine button 5× sends at most one command per second.
- **M8. M112 (optional, QD330-specific, flag `emergencyStopM112`):** [ ] only with the owner's
  explicit agreement and cold heaters: record exactly what the printer does and whether cancel and
  heater commands still work afterwards; [ ] if it needs a power cycle or leaves anything unclear,
  **leave the flag off**.

**Before machine flags may be turned on:** [ ] each flag's step (M2–M5, M8) passed with the user
present; [ ] the heater idle timeout is agreed with the owner and M4's timer check passed;
[ ] emergency stop is reachable from every screen and by voice, and points to the power switch when
not confirmed; [ ] voice heating needs a spoken confirmation and the web UI a confirm dialog.

### Bed-leveling checklist (QD330)

Morphix writes an **unverified** leveling command (`G29` by default) into every print; see
[QD330.md](QD330.md#bed-leveling) for the settings.

- **L1. Every print levels (do this first):** [ ] with the bed clear, prepare and print a small
  file and watch the first minutes; [ ] pass: after homing, with the bed hot, the nozzle probes
  several points, then heats and prints a good first layer (note how long probing took);
  [ ] fail: an error, "unknown command", or no probing: go to L2.
- **L2. The right command (only if L1 failed):** [ ] read the start of an official `.gx`, put its
  leveling command in `MORPHIX_LEVEL_GCODE`, restart and repeat L1; [ ] if none works, set
  `MORPHIX_LEVELING=printer`, switch on "automatic leveling before printing" on the QD330
  touchscreen, and write down what happened.

## Print Guardian

The camera-based guardian ([packages/guardian](../packages/guardian/src)) is **experimental and
does not replace supervision**. It never sends printer commands itself. Auto-pause is off by
default, and even when switched on nothing happens unless a pause hook that sends the validated
pause command is supplied; leave it off until pause (step 5) is validated. Without a hook the UI
asks the operator to press pause on the printer. An alert reads "Paused" only after the printer
reports paused; otherwise it becomes `pause_unconfirmed` after 90 s. AI review results never change
the alert state. The guardian may use emergency stop only if the operator wants that, and can never heat.

## Self-healing never does

The self-healer ([SELF-HEAL.md](SELF-HEAL.md)) has no way to start a print, heat anything, move
the printer, cancel a real print, or spend Meshy credits; those actions are not in its whitelist or
its `HealActions` interface. Interrupted generation and print jobs are only noted, never re-run.
Fixing a stale "printing" record closes Morphix's own job record without a printer command. Disk
cleanup never deletes models, `.gx` files, the database, backups or voice recordings. Its optional
AI diagnosis can only trigger four argument-free whitelisted fixes.

## AI and CAD

- **AI only proposes.** Model generation (`generate_model`, `revise_model`) and printing
  (`request_print`) tool calls only create a pending action. Spending Meshy credits needs the user
  to see the cost and say yes or tap Confirm; credits are never spent automatically.
- **Slicer advice** from AI is type-checked and clamped to safe ranges, cannot remove supports for
  a real overhang, and falls back to the built-in rules on any error.
- **OpenSCAD sandbox** ([openscad.ts](../packages/photo3d/src/openscad.ts)). AI-written SCAD
  passes static checks before it runs, on code with comments and strings stripped. Rejected:
  `import`, `include`, `use`, `surface()`, `dxf_*()` and `file=` (anything that reads other files);
  code over 64 KB; `$fn` above 256, `$fs` below 0.05, `$fa` below 0.5; literal loop ranges over
  2000 steps or 20000 in total; zero-step ranges; code with no 3D geometry. Rendering uses
  `execFile` (no shell) in a fresh private temp dir that is deleted afterwards, with a timeout.
  `runOpenscad` does **not** run the checks itself: always call `checkScadSafety` first.
- **Leveling commands** set by the operator are checked too: one to four plain commands; anything
  that moves, heats, extrudes, controls jobs or changes the firmware is refused.

## Secrets

API keys, printer access codes and passwords:

- are stored in the data dir (`$MORPHIX_DATA_DIR`) with file mode 0600;
- never go into logs, URLs, git, error messages or the browser; the UI only sees "set / not set"
  (`secretStatus()` in [packages/config](../packages/config/src/types.ts) never returns values);
- are stripped (`redactSecrets`) from log text before it is sent for AI diagnosis.

Drivers must never log access codes, API keys or passwords.

## Network exposure

Morphix is meant for your home or workshop network. Don't forward its port on your router or
expose it to the internet. Many printer cameras (for example mjpg-streamer) and printer LAN
protocols have no authentication of their own: anyone who can reach them on the network can
watch or control the printer, with or without Morphix. Keep printers on a network only people
you trust can join.
