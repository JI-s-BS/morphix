# drivers-http: Moonraker, OctoPrint, PrusaLink, Duet (GOAL.md item 3)

**Status: implemented from the protocol docs, tested only against local fake servers, never on real
printers.** Catalog entries that use these drivers must say `verified: "protocol"` until someone runs a
print end to end on the real machine.

## Files

| Path | What |
|---|---|
| `packages/printer/src/drivers/http/index.ts` | `HTTP_DRIVERS = [moonraker, octoprint, prusalink, duet]` (already picked up by `drivers/registry.ts`) |
| `http/common.ts` | base URL from `host`/`port`, `Http` (one request helper: `AbortSignal.timeout` on every call, body read inside the timeout, logs path without query and never headers), HTTP/network error → `DriverError` + hint, state guards (`requireIdle`, `requireState`, `checkConsole`), `safeFileName`, `heatingNow` |
| `http/digest.ts` | HTTP Digest (RFC 7616 + RFC 2069 fallback; MD5, SHA-256, `-sess`) with `node:crypto` |
| `http/mdns.ts` | tiny mDNS/DNS-SD browser with `node:dgram` (one PTR query, legacy-unicast replies) |
| `http/moonraker.ts`, `octoprint.ts`, `prusalink.ts`, `duet.ts` | the drivers |
| `http/fake/*.ts` | fake HTTP printers per protocol (127.0.0.1, request log, `hang` paths for timeouts); usable for demos too |
| `tests/drivers-http-{common,moonraker,octoprint,prusalink,duet}.test.ts`, `tests/drivers-http-helpers.ts` | 53 tests |

## Behaviour common to all four

- `test()` and `status()` never throw. `status()` returns `offline` + a message (with the hint) for an unreachable printer, a timeout, a refused login or a reply it can't read.
- Control calls (`start`, `pause`, `resume`, `cancel`, `setTemperature`, `sendGcode`, upload on PrusaLink) read the state first and throw the real `DriverError` (`auth`, `timeout`, `unreachable` ...).
- `start()` only from `idle`, otherwise `DriverError("busy")`. `pause` only from printing/heating, `resume` only from paused, `cancel` from printing/heating/paused, otherwise `rejected`.
- `upload()` never starts a print (no `print=true`, `Print-After-Upload: ?0`).
- File names are cleaned up: no folders, only `[A-Za-z0-9._ -]`, `.gcode` added, max 96 chars. Only `gcode` is accepted (`unsupported` otherwise).
- `setTemperature` rounds and rejects nonsense (< 0, nozzle > 500, bed > 200). **The caller still has to clamp to the catalog model's max.** Allowed in idle/heating/printing/paused.
- `sendGcode` (console) only in idle/paused/error, one line at a time. `M112` is always allowed.
- `heating`: the printer says printing, the job is < 1 % done (Moonraker: no filament used yet) and a heater is more than 3 °C below a set target.
- Secrets: API keys go in headers and passwords are only hashed (Digest). Error messages and logs contain no URLs with query strings, no headers and no bodies we sent. Tests check that the secrets used never show up in results or logs. **Exception:** Duet's protocol puts the board password in the `rr_connect` / `machine/connect` query string. It only goes to the printer and is never logged.
- Timeouts: 8 s per call by default (`config.timeoutMs` is an advanced override, not on the form). Uploads get 60 s + 1 s per 100 kB. Moonraker `gcode/script` and Duet console calls get 120 s (they block until the command finishes).

## Per driver

### moonraker: Klipper (Voron, RatRig, Sovol SV07/SV08, Neptune 4, QIDI, Sonic Pad, rooted K1)
- Fields: host, port (7125), optional API key (`X-Api-Key`).
- `test`: `/server/info` + `/printer/info` (Klipper version, hostname). `status`: `/server/info` (klippy_state) then `/printer/objects/query?print_stats&extruder&heater_bed&display_status&virtual_sdcard`.
- States: `standby`→idle, `printing`→printing/heating, `paused`, `complete`/`cancelled`→idle (with message), `error`→error (print_stats.message). Klippy `startup`→busy, `shutdown`/`error`→error (first line of state_message), `disconnected`→offline.
- Progress: `display_status.progress` (M73) falling back to `virtual_sdcard.progress`. Layers from `print_stats.info` (needs SET_PRINT_STATS_INFO in the slicer). Remaining time is estimated from elapsed and progress.
- Upload `POST /server/files/upload` (root=gcodes). Start `/printer/print/start`, plus pause/resume/cancel. Temperatures via `SET_HEATER_TEMPERATURE`. Console via `/printer/gcode/script`.
- Camera: `/server/webcams/list`, the first enabled cam. mjpeg services use `stream_url`, others (WebRTC) use `snapshot_url`. Relative URLs are resolved against port 80 (the web UI), not 7125.
- Discovery: mDNS `_moonraker._tcp` (needs `[zeroconf]` in moonraker.conf).

### octoprint
- Fields: host, port (80; 5000 without a proxy), API key (Application Keys).
- `status`: `/api/printer?exclude=sd` + `/api/job`. A 409 on `/api/printer` means OctoPrint isn't connected to the printer: `offline` with "click Connect", or `error` if `/api/connection` says `Error...`.
- Flags: error/closedOrError→error (or offline when the text says Offline/Closed), cancelling/pausing→busy, paused, finishing, printing→printing/heating, ready/operational→idle.
- Upload multipart `/api/files/local`. OctoPrint turns spaces into `_`, and the driver does the same so `start` finds the file. Start `POST /api/files/local/<name> {select, print:true}`. Job commands go to `/api/job` (409 → rejected). Temperatures via `/api/printer/tool` and `/api/printer/bed`. Console `/api/printer/command` returns "sent" (REST gives no reply text).
- Camera: `/api/settings` → `plugins.classicwebcam.stream` (1.9+) or `webcam.streamUrl` (≤1.8). localhost URLs are rewritten to the printer host.
- Discovery: mDNS `_octoprint._tcp`.

### prusalink: MK4/MK4S/MK3.9/MINI+/XL/CORE One (Buddy firmware), MK3S+ with Prusa Link ≥ 0.7
- Fields: host, user (default `maker`), password (Digest), optional API key (older firmware: `X-Api-Key`).
- Digest: the challenge is fetched by the first GET (status runs before upload, so the big PUT body is sent once). The driver retries once on 401 with a new or stale nonce. A wrong password does not loop.
- `status`: `/api/v1/status` (+ `/api/v1/job` for the file name while a job exists). States: IDLE/READY/FINISHED/STOPPED→idle, PRINTING→printing/heating, PAUSED, BUSY→busy, ATTENTION→busy ("needs attention: check its screen"), ERROR→error. A 404 on v1 → `unsupported` "update firmware / Prusa Link ≥ 0.7".
- Upload `PUT /api/v1/files/<storage>/<name>` with `Print-After-Upload: ?0`. `Overwrite: ?1` only while idle, so a running file is never replaced (409 → rejected). Storage comes from `status.storage` (`usb` on Buddy, `local` on MK3S+ Prusa Link).
- Start `POST /api/v1/files/<storage>/<name>`. Pause/resume `PUT /api/v1/job/<id>/pause|resume`, cancel `DELETE /api/v1/job/<id>`.
- No `setTemperature`, console or camera: PrusaLink v1 has no endpoint for them.
- MK3S+ differences: the user and password come from the Prusa Link wizard (not `maker`), storage is `local`, and versions < 0.7 have no v1 API.

### duet: RepRapFirmware 3, standalone or SBC
- Fields: host, port (80), optional board password (M551; empty → `reprap`, which RRF accepts when no password is set).
- Mode detection: `rr_connect` answers JSON → standalone (`X-Session-Key` from RRF 3.5, err 1 → auth, err 2 → busy "no free sessions"). Otherwise `/machine/connect` (DSF 3.5, 401/403 → auth), otherwise `/machine/status` → SBC without password. A 401 later re-logs in once (session timeout).
- `status`: standalone `rr_model?key=state|job|heat|tools&flags=d99v`; SBC `/machine/status` (fallback `/machine/model`). Nozzle = heater of the current tool (or tool 0), bed = first `bedHeaters` ≥ 0.
- States: idle (error if any heater is in `fault`), processing/printing→printing/heating, paused, pausing/resuming/cancelling/simulating/busy/changingTool/starting/updating→busy, halted→error ("M999"), off/disconnected→offline.
- Progress = filePosition / file.size. Remaining = timesLeft.slicer → file → filament. Layers from job.layer / file.numLayers.
- Upload `rr_upload?name=0:/gcodes/<name>` (`{err:0}`) or `PUT /machine/file/0:/gcodes/<name>`. Start `M32 "0:/gcodes/<name>"`, pause `M25`, resume `M24`. Cancel = `M25`, wait until paused (≤ ~20 s), then `M0` (runs cancel.g). Temperatures `M104 S` / `M140 S`. Console: SBC returns the reply directly, standalone reads `rr_reply`.
- No camera, no discovery.

## Docs used
- Moonraker web API: https://moonraker.readthedocs.io/en/latest/web_api/ (server/info, printer/objects/query, files/upload, print/*, gcode/script, webcams/list, authorization)
- Klipper status reference: https://www.klipper3d.org/Status_Reference.html
- OctoPrint REST API: https://docs.octoprint.org/en/master/api/ (version, connection, printer, job, files, settings) and the data model page
- PrusaLink OpenAPI: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml. Buddy firmware: https://github.com/prusa3d/Prusa-Firmware-Buddy
- RepRapFirmware HTTP requests: https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests. DSF REST API: https://github.com/Duet3D/DuetSoftwareFramework/wiki/REST-API. Object model: https://github.com/Duet3D/RepRapFirmware/wiki/Object-Model-Documentation
- RFC 7616 / RFC 2617 (Digest; the tests use their example vectors), RFC 6762 / 6763 (mDNS / DNS-SD)

## Known gaps / to verify on hardware
- Nothing has been run against a real printer. The fakes follow the docs, so a doc that is wrong or out of date stays wrong here.
- HTTP polling only (no Moonraker / OctoPrint websocket push). The server polls `status()`.
- HTTPS with self-signed certificates is refused (`protocol` error, hint: use http://).
- Moonraker: when Klipper is shut down, `/printer/gcode/script` isn't available, so the console can't send FIRMWARE_RESTART (no `firmware_restart` call in the contract). The status message tells the user to do it in Mainsail/Fluidd.
- Moonraker & PrusaLink pause/resume/cancel are the printer's own macros. What they do (park, heaters off) depends on the printer's config.
- PrusaLink: the exact Digest challenge format (qop or not) and whether FINISHED/STOPPED accept a new print without touching the screen need checking on an MK4. The model name isn't read (v1 has no model field), only name/hostname/serial. The fields that hold the firmware version differ between versions.
- PrusaLink `.bgcode` (binary G-code) is not offered (the contract's `FileFormat` has no `bgcode`). Plain `.gcode` works on all of them.
- OctoPrint: anonymous / guest access is not supported (an API key is required). Only `tool0` and `bed` are read. SD-card printing isn't used (uploads go to OctoPrint's local storage).
- Duet: the multi-tool nozzle is "the current tool, else tool 0". `M104` without `T` relies on RRF's "current tool, or tool 0". No upload CRC32 is sent. Whether DSF also answers `rr_connect` (which would make it use standalone mode) isn't known: both paths work.
- mDNS: IPv4 only, one query, no multicast join (relies on responders honouring legacy unicast). PrusaLink and Duet have no discovery.
- Full `npm test` in this worktree: everything passes except `tests/portal-api.test.ts`, which looks for `./node_modules/three`. This worktree resolves packages from the parent checkout and has no `node_modules/three` of its own. With `three` linked in, that file passes 25/25. It has nothing to do with these drivers.
- `npm run typecheck` passed when this work started and passes for every file here. Just before the commit, `node_modules/pg` was removed from the shared parent checkout (another session), so `apps/desktop/electron/tiger.ts` now fails with "Cannot find module 'pg'". That isn't caused by this branch.
