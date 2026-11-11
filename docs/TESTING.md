# Testing

```bash
npm ci                 # ELECTRON_SKIP_BINARY_DOWNLOAD=1 if you don't need the kiosk
npm run typecheck
npm test               # about 1,000 tests, ~10 s on a desktop, ~1 min on 2 cores
```

Every test runs without hardware, network or API keys: printers are fakes (the FakeQD330 TCP printer in
`packages/printer/src/fake-server.ts`, fake Bambu MQTT/FTPS, SDCP, Creality, Marlin-over-serial …), and AI services are stubbed.

## Tests that need extra tools (skipped when missing)

| Tool | Unlocks | Install |
|---|---|---|
| `shellcheck` | lint of `install.sh`, `morphix`, `morphix-kiosk` | `sudo apt install shellcheck` (or `pip install shellcheck-py`) |
| `openscad` | real Claude-CAD and photo-to-3D renders | `sudo apt install openscad` |
| Python 3 with numpy + OpenCV | the real Print Guardian camera worker | `sudo apt install python3-numpy python3-opencv`, then `MORPHIX_TEST_PYTHON=/usr/bin/python3 npm test` |
| `systemd-analyze` | syntax check of the rendered systemd units | part of systemd |

CI (`.github/workflows/ci.yml`) installs all of them and runs the suite on x86_64 and arm64, builds the server, web UI and kiosk,
starts the server headless and checks `/api/health`, and builds and runs the Docker image.

## Useful test files

| File | What it covers |
|---|---|
| `tests/server-security.test.ts` | CSRF, same-origin, access levels, body limits, rate limit, security headers |
| `tests/server-static.test.ts` | path traversal in every spelling, the model library, the UI |
| `tests/server-rpc.test.ts` | every API call over HTTP, binary data, live events (SSE), the browser client |
| `tests/server-e2e-qd330.test.ts` | import → prepare → Confirm → upload + start → progress → completed, through the real driver and a fake printer |
| `tests/server-driver-print.test.ts` | the print rules for setup-page printers (idle checks, re-check at Confirm, cancel) |
| `tests/install-*.test.ts` | the installer and `morphix` command, end to end against a faked system |

## Trying it by hand without a printer

```bash
npm run build:server && npm run build:renderer
MORPHIX_DATA_DIR=/tmp/morphix-try MORPHIX_BIND=127.0.0.1 npm run start:server
```

Open `http://127.0.0.1:8080`, create the admin, skip the printer, then **My Things → Import a file**. To try a printer connection,
run the fake QD330 (`new FakeQD330().listen(8899)` from `@morphix/printer`) and add an *Afinia QD330* at `127.0.0.1`.
