# Goal: Morphix for everyone

**Turn Morphix from a one-off Raspberry Pi + Afinia QD330 build into an open-source app that
anyone can install on any Linux machine (Raspberry Pi, old PC, mini PC, VM), point at the 3D
printer they already own, and use from any browser on their network, safely.**

Done means a stranger can: run one install command → open `http://<machine>:8080` → walk through
a setup page (admin password, API keys, pick their printer, test the connection, pick a slicer)
→ slice and print, with updates, rollback, logs and a health check built in.

## The 10 items

| # | Item | Where | Owner (session) |
|---|---|---|---|
| 1 | Builds and runs on any Linux (arm64, armv7, x86_64; Debian/Ubuntu/Raspberry Pi OS, Fedora, Arch) | `scripts/install/`, `packaging/` | install |
| 2 | Modular slicers: PrusaSlicer, OrcaSlicer, Bambu Studio | `packages/slicing/src/adapters/` | slicers |
| 3 | Works with the top 20 3D printer brands over their LAN/USB protocols | `packages/printer/src/drivers/{http,lan,serial}/` | drivers-http, drivers-lan, drivers-serial |
| 4 | Runs headless (no screen); the touchscreen kiosk becomes optional | `apps/server/` | server |
| 5 | Web setup page for API keys, printers, slicer | `packages/config/`, `apps/desktop/src/pages/setup/` | setup |
| 6 | Local website for setup and everyday use on the network | `apps/server/` serves `apps/desktop/src` | server |
| 7 | Remove fluff and dead code | everywhere (see ownership) | cleanup (+ server for the Electron wiring) |
| 8 | A setup guide for every supported printer | `packages/catalog/`, `docs/printers/` | catalog |
| 9 | README explains install, setup and use | `README.md`, `docs/` | integration (last) |
| 10 | Simple, fail-checked, secure; install / update / rollback / uninstall / doctor | all; `scripts/install/` | install + setup + all |

## Architecture

```
 browser (any device on the LAN)          optional kiosk (Electron or chromium --kiosk)
            │  HTTP(S) + JSON RPC + SSE events          │ same URL
            ▼                                           ▼
 apps/server  ── node, headless, one process (systemd service or Docker)
   ├─ RPC: every MorphixApi call (packages/shared IPC list) as POST /api/rpc/<channel>
   ├─ events: GET /api/events (Server-Sent Events) for printer status, generation progress …
   ├─ static: the React UI (apps/desktop/src, built by vite)
   ├─ auth + setup routes  ◄── packages/config (ConfigStore, AuthProvider, setup RouteModule)
   ├─ printers  ◄── packages/printer DRIVERS (PrinterDriver contract) + packages/catalog models
   └─ slicing   ◄── packages/slicing adapters (SlicerAdapter contract)
 data dir: $MORPHIX_DATA_DIR (default ~/.local/share/morphix, /var/lib/morphix for the system service)
```

Contracts (already in the repo, change only by agreement):
- `packages/printer/src/drivers/types.ts`: `PrinterDriver`, `PrinterConnection`, `DriverId`, `DriverError`
- `packages/slicing/src/adapters/types.ts`: `SlicerAdapter`, `SliceJob`, `SliceOutput`
- `packages/catalog/src/types.ts`: `PrinterModel`
- `packages/config/src/types.ts`: `MorphixConfig`, `ConfigStore`, `Router`, `RouteModule`, `AuthProvider`, `Access`
- `apps/desktop/src/pages/setup/index.tsx`: `SetupGate`
- Server entry point: `node apps/server/dist/server.cjs`; env `MORPHIX_DATA_DIR`, `MORPHIX_PORT` (default 8080), `MORPHIX_BIND` (default `0.0.0.0`)

## File ownership (parallel sessions never edit another session's files)

| Session | Owns | Must not touch |
|---|---|---|
| server | `apps/server/**`, `apps/desktop/electron/**`, `apps/desktop/src/{App.tsx,bridge.ts,mock.ts,main.tsx}`, `apps/desktop/vite.config.ts`, `packages/shared/**`, `packages/portal/**`, `packages/remote/**`, `apps/remote/**`, `vercel.json`, `scripts/build-*.mjs` | setup pages, drivers, slicing, catalog, install |
| setup | `packages/config/src/**` (except `types.ts` without agreement), `apps/desktop/src/pages/setup/**`, `apps/desktop/src/pages/Settings.tsx` | server code, App.tsx |
| slicers | `packages/slicing/**`, `config/slicer-profiles/**` | everything else |
| drivers-http | `packages/printer/src/drivers/http/**` | other driver families, existing printer files |
| drivers-lan | `packages/printer/src/drivers/lan/**`, existing `packages/printer/src/*.ts` (QD330 / FlashForge code) | other families |
| drivers-serial | `packages/printer/src/drivers/serial/**` | other families |
| catalog | `packages/catalog/**`, `docs/printers/**` | code outside catalog |
| install | `scripts/install/**`, `scripts/pi/**`, `packaging/**`, `deploy.sh`, `Dockerfile`, `docker-compose.yml`, `docs/INSTALL.md` | app code |
| cleanup | dead code in `packages/{cad,database,domain,errors,gemini,guardian,healer,jobs,meshy,model-search,network,photo3d,storage}`, `services/**`, `docs/*.md` except GOAL/INSTALL, old tests | anything owned above |

Tests: `tests/<area>-*.test.ts` (e.g. `tests/drivers-http-moonraker.test.ts`). Each session deletes or fixes
the tests of what it removes. `package.json`: add scripts if needed; no new dependencies except
`mqtt@5.16.1` and `basic-ftp@6.2.3` (already installed). Use Node 22+ built-ins: `fetch`,
`WebSocket`, `node:crypto` (scrypt), `node:tls`, `node:net`, `node:dgram`.

## Rules every session follows

1. `npm run typecheck` and `npm test` pass before every commit. Never commit failing tests.
2. **Safety first.** No command that moves, heats or starts a printer unless the user asked for it and
   the printer state allows it. Temperatures are clamped to the catalog model's limits. A driver that is
   implemented from a protocol document but not run on real hardware says `verified: "protocol"` and
   its doc says so plainly. Never claim something works on hardware that wasn't tried.
3. **Secrets** never go into logs, URLs, git, the browser, or error messages. They are stored in the
   data dir with mode 0600 and shown to the UI only as "set / not set".
4. **Fail checks.** Every network call has a timeout; every failure gives the user a plain reason and
   a next step (the `hint` on `DriverError` / `TestResult`).
5. Keep it simple: no frameworks for the server (node:http), no new UI libraries.
6. Commit on your own branch with clear messages; don't merge; the integration step merges all.

## Phases

1. **Contracts** (done): this file and the interfaces above.
2. **Parallel build:** server, setup, slicers, drivers-http, drivers-lan, drivers-serial, catalog, install, cleanup.
3. **Integration:** merge all branches, wire drivers + adapters + catalog into the server, full test run,
   README (#9), push to `github.com/JI-s-BS/morphix`.
