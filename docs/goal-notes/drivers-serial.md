# drivers-serial (GOAL.md item 3): notes for integration

**None of these drivers has been run on a real printer.** All three are protocol implementations,
written from the maker's or project's documentation and tested against in-memory fakes. Catalog
entries that use them must say `verified: "protocol"`.

## What is here

`packages/printer/src/drivers/serial/`

| File | What |
|---|---|
| `index.ts` | `SERIAL_DRIVERS = [marlin-serial, ultimaker, snapmaker]`, plus re-exports (factories, pairing types, `listSerialPorts`, `DIALOUT_HINT`) |
| `marlin-serial.ts` | `marlin-serial` driver: USB Marlin printers |
| `marlin-sender.ts` | G-code sender: `N…*cs` lines, one in flight, `ok` / `Resend:` / `busy:` / halt, a priority queue for API commands |
| `marlin-gcode.ts` | Pure parsing: checksum, temperatures, M115, M27, resend, fatal errors |
| `marlin-port.ts` | Real port: `stty` + node:fs streams (no new dependency), `/dev/serial/by-id` discovery, EACCES → `dialout` hint |
| `ultimaker.ts` | `ultimaker` driver: S3/S5/S7 local API, digest auth, pairing |
| `snapmaker.ts` | `snapmaker` driver: Snapmaker 2.0 HTTP API on :8080, token pairing, UDP discovery on :20054 |
| `http-util.ts` | fetch with a timeout, errors mapped to DriverError, HTTP Digest (MD5, qop=auth) |
| `pairing.ts` | `Pairing` / `PairingResult` / `PairableDriver` / `isPairable` (see below) |

Tests (44 total): `tests/drivers-serial-marlin.test.ts` (with `tests/drivers-serial-fake-marlin.ts`),
`tests/drivers-serial-ultimaker.test.ts`, `tests/drivers-serial-snapmaker.test.ts`.

## For the server and setup sessions

1. **Pairing is outside the fixed contract.** Ultimaker and Snapmaker only give an API key after the
   user confirms on the printer's screen. Those two drivers carry an extra `pairing` property:
   `pairing.start(config)` returns `{ state: "waiting", save: {...} }`. Merge `save` into the stored
   printer config (it holds secrets, so store it 0600 and never send it to the browser), then call
   `pairing.check(config)` about every 2 s until the state is `paired`, `denied` or `failed`. Use
   `isPairable(driver)` to decide whether to show a "Pair" button. **Proposal:** add
   `pairing?: Pairing` to `PrinterDriver` in `types.ts`, so this stops being an extra property.
   Until pairing finishes, `test()` returns `{ ok: false, code: "auth" }` with a hint that says
   to pair.
2. **Marlin needs the `dialout` group.** On EACCES the driver returns `DriverError("auth")` with
   `DIALOUT_HINT` (`sudo usermod -aG dialout $USER`, then log in again or restart the service).
   **The install session** should add the Morphix service user to `dialout`.
3. **Field kind `serial-port`**: the setup page should fill the picker from
   `getDriver("marlin-serial").discover()`. Each result is `{ host: "/dev/serial/by-id/usb-…", name }`.
   `host` holds the device path. The driver accepts only `/dev/ttyUSB*`, `/dev/ttyACM*`,
   `/dev/ttyAMA*`, `/dev/ttyS*` and `/dev/serial/by-{id,path}/*` paths.
4. **Uploads go to the data dir:** `$MORPHIX_DATA_DIR/jobs/serial/<port>/` (default
   `~/.local/share/morphix`). Files older than 7 days are removed on the next upload. Ultimaker and
   Snapmaker keep the latest upload in memory, because their APIs take the file and start it in
   one request (`start()` sends it).
5. **Marlin connections are long-lived.** Keep one `PrinterConnection` per printer and call
   `close()` on shutdown. A new connection reopens the port, and opening the port resets most
   boards. `status()` returns cached temperatures and progress: it is cheap to poll, and it checks
   M27 every 10 s while idle.
6. **The Snapmaker token goes in the query string** (`/api/v1/status?token=…`) because that API
   requires it. The driver never puts a URL in an error message or log. The server must not log
   the request URLs of driver traffic either.

## Behaviour (safety)

- **`start` runs only when the printer is idle.** For Marlin, it also refuses when M27 reports an
  SD-card print the user started on the printer itself. For Ultimaker, `wait_cleanup` means
  "finishing", so it refuses until the build plate has been cleared.
- **Pause (Marlin)** stops streaming. Nothing moves unless the user set `pauseGcode`, and
  `resumeGcode` must undo that move.
- **Cancel (Marlin)** stops streaming, then sends an unnumbered `M108`, which breaks a heating wait
  (it needs Marlin's emergency parser). Then it runs the optional `cancelGcode`, followed by
  `M104 S0` (once per extruder, from M115 `EXTRUDER_COUNT`), `M140 S0`, `M107` and `M84`. Nothing
  moves by default. The few moves already in the printer's planner buffer still finish: there is
  no `M410` quick-stop, because it loses the position.
- **Firmware halt** (`Error:Printer halted`, `kill() called`, thermal runaway, MINTEMP/MAXTEMP,
  `!!`) puts the printer in `error` and stops streaming. A lost USB connection mid-print does the
  same. The error stays until the user presses Cancel, which clears it and reopens (resets) the
  port. Resend-related `Error:` lines and `Unknown command` are not treated as fatal.
- **A lost `ok`:** if nothing but auto-report temperatures arrives for 30 s, the driver sends one
  unnumbered `M105` to provoke an `ok`. `busy:` lines and heating-wait temperature lines
  (`… W:…`) count as keep-alive. Five minutes with no byte at all is an error. Cost: if the `ok`
  was only slow, not lost, two lines may be in the printer's buffer at once. Marlin's buffer holds
  four.
- **Temperatures:** M155 S2 auto-report when M115 shows `Cap:AUTOREPORT_TEMP:1`, otherwise M105
  every 3 s. `setTemperature` checks only 0–450 °C: **the caller clamps to the catalog model's
  maximum** (types.ts).

## Known gaps / not verified

- **Nothing was run on hardware.** Real-port details that only the fakes covered: the `stty` flags,
  the boot wait after the DTR reset (4 s, or until the `start` banner), and the blocking fs read on
  a tty. That read holds one libuv worker thread per open port, and `close()` sends M105 so the
  reply releases it.
- **Ultimaker camera:** `http://<ip>:8080/?action=snapshot` (mjpg-streamer on S-series). The URL
  was not checked on a device.
- **Snapmaker 2.0 API:** reconstructed from Luban and community clients. The 204 / 401 / 200
  meaning of `/api/v1/status` during pairing comes from those clients. J1 and Artisan are listed
  as "may work": they speak a newer protocol (SACP), and whether they also serve this HTTP API was
  not checked.
- **Ultimaker progress** is assumed to be 0..1, as in the API docs. Snapmaker progress is handled
  either way (values above 1 are divided by 100).
- **No `setTemperature` / `sendGcode` for Ultimaker or Snapmaker** (capabilities say so).

## Pre-existing test failure (not from this branch)

`tests/portal-api.test.ts` ("serves … three.js") fails in this worktree with a 404 for
`/vendor/three/three.module.js`, both before and after these changes. The worktree has no
`node_modules` of its own: it resolves `three` from the parent checkout. This is a test owned by
the server session; it is not touched here.
