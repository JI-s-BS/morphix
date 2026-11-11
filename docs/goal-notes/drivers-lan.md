# drivers-lan: notes for integration

Session: drivers-lan (GOAL.md item 3, family "lan"). Branch `claude/op-drivers-lan-540afe`.

## What's here

`packages/printer/src/drivers/lan/`, all registered in `LAN_DRIVERS` (`lan/index.ts`):

| Driver | Printers | Transport | Verified |
|---|---|---|---|
| `flashforge-tcp` | Afinia QD330, FlashForge Adventurer 3/4, Finder, Guider | M-code over TCP 8899, `.gx` upload (M28/M29) | **hardware** on the QD330 (status, info, upload, start, cancel). Pause/resume are not verified on hardware. FlashForge models: protocol only |
| `flashforge-http` | Adventurer 5M, 5M Pro, AD5X | HTTP 8898 (`/detail`, `/uploadGcode`, `/printGcode`, `/control`), TCP 8899 status fallback | protocol |
| `bambu-lan` | X1C, X1E, P1S, P1P, A1, A1 mini, H2D | MQTT 3.1.1 over TLS 8883, FTPS (implicit) 990 | protocol |
| `elegoo-sdcp` | Centauri Carbon | SDCP v3: WebSocket 3030, UDP 3000 `M99999`, HTTP chunked upload | protocol |
| `creality-k1` | K1, K1C, K1 Max, K2 Plus, Ender-3 V3 (stock firmware) | WebSocket 9999 + HTTP upload on port 80 | protocol |

"protocol" means written from protocol documentation and tested only against local fakes. Each
file's header comment says the same. The catalog should set `verified: "hardware"` only for the
QD330 on `flashforge-tcp`.

Shared helpers are in `lan/common.ts` (timeouts, error mapping, log scrubbing, `WsSession`, polling,
`invalidConnection`). `lan/bambu-ca.ts` holds Bambu's public CA certificates.

### What every driver does
- `fields` with a `help` sentence each: where to find the value on that printer (a test checks every field has help).
- `connect()` never throws. Bad settings (no IP, no access code) return a connection whose `test()` gives `ok:false` and whose `status()` gives `offline`.
- `test()` and `status()` never throw (tested: unreachable, timeout, silent printer, bad credentials).
- Every network call has a timeout. Failures are `DriverError` with codes `unreachable`, `timeout`, `auth`, `busy`, `rejected`, `unsupported` or `protocol`, and a plain `hint`.
- `upload` and `start` are refused with `busy` unless the printer is idle. `pause` needs a running print and `resume` a paused one, otherwise `rejected`. `cancel` when idle sends nothing.
- Commands are confirmed from the printer's reported state. A printer that acknowledges a command but doesn't change state gives `protocol` ("check the printer's screen"), never a silent success.
- Secrets (access code, check code, serial numbers) are scrubbed from log lines and error messages, and never go into URLs. Tests check this for Bambu and FlashForge HTTP.
- No driver offers `setTemperature` or `sendGcode`, so capabilities say `false`. See gaps below.

### Per driver

**flashforge-tcp** wraps `QD330Controller`, so all of its safety rules still apply: one session at a time, a status re-check before every command, confirmation from M119/M27, and unverified machine commands (M104/M140/M106/M146/M18/M112) gated behind `allowUnverified`. The driver never sets those flags. The contract puts the approval gate in the server (the user pressed Start), so the driver issues its own single-use, file-bound `PrintAuthorization` (private `PrintAuthorizer`, `approvedBy: "touch"`) and the controller's token checks run unchanged. State mapping: READY→idle, READY+MOVING→busy, BUILDING_FROM_SD→printing (heating while progress is 0 and the nozzle is below target), PAUSED or MoveMode PAUSED→paused, BUILDING_COMPLETED→busy ("confirm on the printer screen"). Plain `.g` files only when the field `allowPlainGcode` is on: they stalled at 0% on the QD330.

**flashforge-http** sends the serial number and check code in the JSON body, or as headers for `/uploadGcode`. Code 1 maps to `auth`, 2 to `busy`, 3 to file not found. It maps all 15 documented `status` strings and treats unknown ones as busy. The camera URL comes from `cameraStreamUrl`. If HTTP 8898 is refused or returns 404, `status()` falls back to a read-only `QD330Controller` (`enabled:false`) on TCP 8899.

**bambu-lan** opens the TLS socket and checks trust *before* mqtt.js or basic-ftp send the access code:
1. The certificate chains to Bambu's CA (`bambu-ca.ts`) and its CN equals the serial: trusted (`via "ca"`).
2. Otherwise its SHA-256 must match `certFingerprint` (comma-separated; MQTT and FTPS may differ): `via "pinned"`.
3. With no stored fingerprint, the first certificate is accepted (`via "first-use"`) and returned. A different certificate later is refused with `auth`.

   Verification is never just switched off. `rejectUnauthorized:false` is set only so the driver can make this decision itself.

The CA certs are public certificates copied from ha-bambulab (MIT, attribution in the file). `test()` checks MQTT login, a pushall report and an FTPS login. A wrong serial shows up as a timeout with a serial hint, and a wrong code as `auth`. A command echo with `result: failed` and a "verify/auth" reason (or err 84033543) becomes `auth` with the Developer Mode steps. The print uses `project_file` with the plate found inside the 3mf (`Metadata/plate_N.gcode`). The URL is `file:///sdcard/cache/<f>` for X1/P1/A1 and `ftp:///cache/<f>` for H2D and newer, following ha-bambulab. Uploads go to `/cache`. `discover()` listens for SSDP NOTIFY on UDP 2021.

**elegoo-sdcp** learns the MainboardID from the settings, a UDP `M99999` unicast, or the first pushed message. It maps CurrentStatus first, then the Centauri Carbon PrintInfo.Status table (Elegoo elegoo-link codes via elegoo-homeassistant). Print `Ack` codes become plain errors. Upload is 1 MB chunks with `S-File-MD5`, `Check`, `Offset`, `Uuid` and `TotalSize`. Start sends `Filename: /local/<f>` with Calibration, PlatformType and Tlp switches off. `discover()` broadcasts `M99999`.

**creality-k1** uses the `wsslicer` subprotocol, answers `heart_beat` with `ok`, and merges delta frames. States: 0 idle, 1 printing (or heating), 2 finished, 4 stopped, 5 paused, 7 stopping, 9 starting. It reads `withSelfTest` too. A non-zero `err.errcode` is shown in the message but doesn't block an idle printer (the printer keeps stale codes). Pause, resume and stop come from ha_creality_ws with real K1C traces. Upload (`POST :80/upload/<f>`, field `file`) and start (`opGcodeFile: "printprt:<folder>/<f>"`) come from K2Dash on a K2 Plus and are the least certain parts of this whole family. The folder is `/usr/data/printer_data/gcodes` on K1 and `/mnt/UDISK/printer_data/gcodes` on K2 (overridable in the settings). The help text points rooted printers to the Moonraker driver.

## Changes to existing files
- `packages/printer/src/control.ts`: adds `PrinterStateError` (thrown where the printer's state refuses an operation, previously a plain `Error`; same messages) and `ControlResult.failure` (`unreachable | timeout | refused | state | rejected | unconfirmed`), so the driver maps results to error codes without parsing message strings. Behaviour is unchanged and all existing phase5/printer tests pass.
- Dead code: I checked every export in `packages/printer/src/*.ts` against `apps/`, `packages/` and `tests/`. Everything not used elsewhere is a public type or a constant used inside the package, so nothing was removed.

## Needed from other sessions (not edited here)
- **Contract (types.ts), proposed:** add `certFingerprint?: string` (and maybe `trust?: string`) to `TestResult` `info`. Bambu returns them now as extra properties on `info`, and the server/setup should store `info.certFingerprint` into the printer's `certFingerprint` config value after a successful Test. Without that, every new connection is trust-on-first-use again.
- **Contract, nice to have:** `ConnectionField.kind: "select"` with `options`, for the Bambu `model` field (currently free text, used only to pick the `project_file` URL style).
- **server / apps:** `apps/desktop/electron/printing.ts` and `main.ts` still build `QD330Controller` and `PrinterObserver` directly. When the server moves to drivers, the QD330 path can use `getDriver("flashforge-tcp").connect({ host, port })`. The desktop-specific features (approval tokens bound to jobs, the heater idle timer, machine controls) stay on `QD330Controller`, which is still exported.
- **setup:** keep `serialNumber`, `serial`, `checkCode`, `accessCode` (kind `secret`, plus the serials) as secrets in the data dir, and show them only as set / not set.
- **catalog:** use the driver ids above. Bambu `model` values are X1C, X1E, P1S, P1P, A1, A1 mini, H2D.

## Sources
- FlashForge 5M HTTP API: Parallel-7 `flashforge-api-docs` wiki (HTTP REST API page, firmware 3.2.7).
- QD330 / FlashForge TCP: Morphix's own hardware-tested code (docs/PHASE5.md).
- Bambu: OpenBambuAPI (MQTT/FTPS), ha-bambulab `pybambu` (command templates, `ftp:///` vs `file:///sdcard/` per model, CA certs, MIT).
- Elegoo: Elegoo/cbd-tech "SDCP v3.0.0" specification (GitHub cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0); elegoo-homeassistant (Centauri Carbon status table from Elegoo's elegoo-link).
- Creality: ha_creality_ws (3dg1luk43; state codes, pause/stop with K1C traces, heartbeat); K2Dash (pdromnt; upload on port 80, `opGcodeFile`, K2 gcode folder).

## Known gaps
- Nothing except flashforge-tcp on the QD330 has run on real hardware. Expect field-name or state surprises on first contact.
- Bambu: the H2D's second nozzle and the AMS state are not reported. AMS printing is a single on/off switch (`ams_mapping [0]`). The camera isn't offered: the RTSP URL would carry the access code. MQTT and FTPS are assumed to use the same CN=serial certificate scheme, and without a CA match each is pinned separately. P1-series pushall is sent only on connect or when reports are older than 60 s.
- FlashForge HTTP: AD5X material-station headers (`useMatlStation`, `materialMappings`) aren't sent, so prints use the default material. "completed" and "cancel" are treated as idle; if the 5M wants the job cleared on screen first, `/printGcode` answers code 2 (busy).
- Elegoo: only the Centauri Carbon (FDM table); resin SDCP printers are out of scope. No password exists on the LAN API.
- Creality: upload/start on the K1 series are unconfirmed. Status, pause, resume and stop are the reliable parts.
- No driver implements `setTemperature` or `sendGcode`. Temperature commands exist in the docs for Bambu, 5M and Creality, but were left out until the server's clamping and approval path for them is defined and they can be tried on hardware.
- `tests/portal-api.test.ts` fails in this worktree before and after my changes (404 for the front-end/three.js files). Cause: `packages/portal/src/server.ts` looks for `<repo>/node_modules/three`, and this worktree has no `node_modules` of its own (dependencies resolve from a parent folder). It isn't related to the drivers.
