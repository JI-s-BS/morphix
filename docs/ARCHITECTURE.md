# Architecture

Morphix is one Node process that holds everything that talks to the outside world
(printer, slicer, AI providers, camera, disk) and a React UI that only talks to that
process. The UI runs in any browser on the network, or in an optional full-screen
kiosk window on the machine itself.

```
 browser (any device on the LAN)          optional kiosk (Electron or chromium --kiosk)
            │  HTTP + JSON RPC + Server-Sent Events     │ same URL
            ▼                                           ▼
 apps/server ── headless Node process (systemd service or Docker)
   ├─ RPC: every MorphixApi call (packages/shared) as POST /api/rpc/<channel>
   ├─ events: GET /api/events for printer status, job progress, guardian alerts
   ├─ static: the React UI (apps/desktop/src, built by vite)
   ├─ setup + sign-in      ◄── packages/config
   ├─ printers             ◄── packages/printer drivers + packages/catalog models
   └─ slicing              ◄── packages/slicing adapters
 data dir: $MORPHIX_DATA_DIR (default ~/.local/share/morphix)
```

The Electron app (`apps/desktop/electron`) is the original host of the same logic and
can still run it as a kiosk. See [GOAL.md](GOAL.md) for the plan and the fixed contracts.

## Packages

| Package | What it does |
|---|---|
| [`shared`](../packages/shared/src/index.ts) | Types and the IPC/RPC contract between the UI and the server |
| [`config`](../packages/config/src) | Settings, secrets, sign-in and the setup page routes |
| [`printer`](../packages/printer/src) | Printer drivers (`drivers/http`, `drivers/lan`, `drivers/serial`) and the Afinia QD330 controller ([QD330.md](QD330.md)) |
| [`catalog`](../packages/catalog/src) | Supported printer models: build volume, temperature limits, protocol ([printers/](printers/)) |
| [`slicing`](../packages/slicing/src) | Print preparation: mesh checks, repair, orientation, slicer adapters (PrusaSlicer, OrcaSlicer, Bambu Studio), the AI slicer advisor, QD330 `.gx` files |
| [`domain`](../packages/domain/src/index.ts) | Project workflow state machine; printer-facing states need validation and explicit approval |
| [`jobs`](../packages/jobs/src) | One progress model for every pipeline ([JOBS.md](JOBS.md)) |
| [`errors`](../packages/errors/src) | Stable `MX-AREA-nnn` error codes with plain-language hints ([ERRORS.md](ERRORS.md)) |
| [`guardian`](../packages/guardian/src) | AI Print Guardian: camera worker supervision and alert state machine ([GUARDIAN.md](GUARDIAN.md)) |
| [`healer`](../packages/healer/src) | Self-healing: safe automatic fixes for known failures ([SELF-HEAL.md](SELF-HEAL.md)) |
| [`gemini`](../packages/gemini/src) | Gemini Live voice assistant ([AI.md](AI.md)) |
| [`meshy`](../packages/meshy/src/index.ts) | Text-to-3D generation through Meshy ([AI.md](AI.md)) |
| [`cad`](../packages/cad/src) | Functional parts: Claude writes OpenSCAD, rendered headless ([AI.md](AI.md)) |
| [`photo3d`](../packages/photo3d/src) | Photos + a description → a printable model ([AI.md](AI.md)) |
| [`model-search`](../packages/model-search/src) | Search for existing free designs ([AI.md](AI.md)) |
| [`database`](../packages/database/src/index.ts) | SQLite through sql.js (WebAssembly, no native build), flushed atomically, daily backups |
| [`storage`](../packages/storage/src/index.ts) | The data folder layout, atomic writes, free-space checks |
| [`network`](../packages/network/src/index.ts) | Wi-Fi through NetworkManager (`nmcli`, no shell); the printer link is read-only |

Python: [`services/vision`](../services/vision/README.md) is the camera worker the guardian
starts (OpenCV). It is optional; without it the guardian reports the worker as down.

## Data folder

Everything Morphix keeps is in one folder: `models/`, `previews/`, `prints/`,
`snapshots/` (guardian evidence), `logs/`, `database/` (+ `database/backups/`),
`cache/`, `config/`. Files are written atomically (temp file, then rename) and are
never deleted automatically, except what self-healing cleans when the disk fills up:
old temp folders, cache files, logs older than 30 days and intermediate G-code next to
a prepared `.gx` ([SELF-HEAL.md](SELF-HEAL.md)).

## Design rules

- **Safety first.** Nothing moves, heats or starts a printer unless the user asked and
  the printer state allows it. Details in [SAFETY.md](SAFETY.md).
- **Secrets stay on the server.** API keys are read by the server process only, stored
  with mode 0600, shown to the UI only as "set / not set", and redacted from logs and
  AI requests.
- **Fail with a reason.** Every network call has a timeout; every error carries a code
  and a next step for the user ([ERRORS.md](ERRORS.md)).
- **Crash recovery.** Jobs and generation tasks are persisted; on restart, interrupted
  work is resumed (Meshy tasks) or marked failed with a reason.
- **Few dependencies.** The server uses `node:http`; no extra web frameworks or UI libraries.
