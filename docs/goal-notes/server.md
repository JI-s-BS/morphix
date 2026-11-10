# Server session notes (GOAL items 4, 6, part of 7)

## What was built

`apps/server/` runs Morphix with no screen and no Electron (`node:http`, no framework).

| File | What it does |
|---|---|
| `src/core.ts` | `createCore()`: all the app wiring that used to live in `apps/desktop/electron/main.ts` (db, printing, voice, generation, search, guardian, self-heal) with no `electron` import. Every `MorphixApi` handler is registered in a `HandlerRegistry`. |
| `src/registry.ts` | Handler table and event bus shared by IPC and HTTP. Errors are coded as `MX-CODE\|title\|hint\|detail`, as before. |
| `src/router.ts` | `MorphixRouter implements Router`: `:param` and trailing `*` patterns, per-route body limit (optional 5th `add()` argument), JSON errors, `Access` enforced through the injected `AuthProvider`, CSRF, same-origin check, security headers, per-IP rate limit. Also `mountRoutes(router, modules)`. |
| `src/rpc.ts` | `POST /api/rpc/<IPC channel>` (Access `user`) with a JSON args array and reply `{ result }`. Binary values are `{ "$bytes": base64 }` (`packages/shared/src/wire.ts`). `GET /api/events` is SSE (`event: events:printer` …); the sign-in is re-checked on every heartbeat. |
| `src/http.ts` | `createHttpApp()`: `/api/health` (public: ok, name, version, uptimeS), `/api/session` (public: csrfToken, user, setupOpen), `/api/camera/{stream,snapshot}` (proxy, `user`), `/library/*` (model files, `user`), RPC/SSE, setup modules, then the built UI (single-page fallback to index.html). |
| `src/static.ts` | `cleanPath` / `safeResolve` (taken from the portal): no `..`, NUL or backslash, and the realpath must stay inside the root. `/library` serves only `models`, `previews`, `cache/recordings`, `snapshots`. |
| `src/printers.ts` | The active-printer seam (see below). |
| `src/setup-module.ts` | Optional exports from `@morphix/config` (below), plus fallbacks. |
| `src/tls.ts` | Self-signed cert in `<data>/tls/` via `openssl` (execFile, no shell) when `config.server.https` is true. |
| `src/server.ts` | Entry point. `npm run build:server` (scripts/build-server.mjs) builds `apps/server/dist/server.cjs`, and `npm run start:server` runs it. |

Env: `MORPHIX_DATA_DIR` (default `~/.local/share/morphix`), `MORPHIX_PORT`, `MORPHIX_BIND` (env wins over
`config.server`, then 8080 / 0.0.0.0), `MORPHIX_APP_ROOT` (install root, default three dirs up from dist).
SIGTERM / SIGINT close event streams, stop accepting connections, stop the core (db flush) and exit 0 (forced after 10 s).
`server.cjs reset-admin` calls `resetAdmin(store)` if the setup module exports it.

Verified on this machine: `npm run build:server && npm run build:renderer && node apps/server/dist/server.cjs` with no display
serves the UI and `/api/health`. With `MORPHIX_DEV_NO_AUTH=1` on 127.0.0.1, the UI loads in a browser and every RPC it
makes returns 200, SSE delivers printer status, and there are no CSP errors. SIGTERM shuts down cleanly.
Tests: `tests/server-{rpc,security,static,printers}.test.ts` (43 tests).

### Security model
- **CSRF:** a double-submit token. The cookie `morphix_csrf` (SameSite=Strict, readable, Secure on HTTPS) holds `random.HMAC(server-secret)`.
  Every non-GET request needs header `X-Morphix-CSRF` equal to the cookie, and the token must carry this server's signature,
  so a cookie planted by another site is refused. The secret is `<data>/server-secret` (0600). The cookie is set with index.html and `/api/session`.
- **Origin:** a non-GET request with an `Origin` that isn't the `Host`, or with `Sec-Fetch-Site: cross-site|same-site`, gets 403.
- **Headers:** CSP (`default-src 'self'`; `img-src` also allows `https:` for search-result pictures; `frame-ancestors 'none'`), X-Frame-Options DENY,
  nosniff, Referrer-Policy no-referrer, COOP/CORP same-origin, Permissions-Policy (microphone=self).
- **Rate limit:** 600 requests/min per socket IP on every `/api` route; proxy headers are not trusted.
- **Body limits:** 1 MB by default, 256 KB per RPC. Exceptions: `voice:turn`, `assistant:recording`, `models:saveThumbnail` 8 MB; `models:smart-import` 140 MB.
- **Errors:** JSON `{ error: { code, message, hint? } }`. Internal errors never echo details, and secrets are never logged.

## For the setup session (packages/config): the server looks for these exports

Each export is optional and used only when it is a function (`loadSetupModule`):
- `createConfigStore(dataDir): ConfigStore`. Without it, a read-only store reads `<data>/config.json` with no secrets.
- `createAuthProvider(store): AuthProvider`. Without it, nobody can sign in (401 on every `user` route). There is one
  developer escape hatch: `MORPHIX_DEV_NO_AUTH=1` works only when bound to a loopback address.
- `createSetupRoutes({ store, auth, csrfToken(req) }): RouteModule | RouteModule[]`, mounted with `mountRoutes`.
- `resetAdmin(store): Promise<string | void>`. Whatever string it returns is printed by `server.cjs reset-admin`.

The server already enforces CSRF, origin, rate limit, body size and `Access`, so setup routes only add their own logic.
On start-up the core copies `SECRET_KEYS` from the store into `process.env` (memory only, never logged), because the
existing modules read keys from env. Changing a key therefore needs a restart: setup can tell the user, or the
integration step can add a `restart` hook.
On 401 the browser client dispatches `window` event `morphix:unauthorized` (`detail.code`: `unauthenticated` or `setup_required`)
so `SetupGate` can show sign-in or first-run setup. `App.tsx` is now wrapped in `<SetupGate>`.

## Printers (seam for the drivers sessions and integration)
`resolveActivePrinter(config, store)`: if `config.printers` has the `activePrinterId` (or exactly one printer), it calls
`getDriver(p.driver).connect({ ...p.connection, ...secrets printer:<id>:<field> })`. Otherwise it returns `{ kind: "qd330", reason }`
and today's `Printing` / QD330 path runs unchanged.
With a driver printer:
- `DriverObserver` polls `status()` and maps it to `PrinterStatus`.
- `DriverControl` sends pause/resume/cancel only when the state allows it.
- Temperatures are clamped to the catalog model's `maxNozzleC` / `maxBedC`, and refused for an unknown model or an offline printer.
- The camera comes from `capabilities().camera`.
- QD330 control is forced off.
- **Printing on a driver printer** (`Printing` with a `DriverTarget`, apps/desktop/electron/printing.ts):
  - **Prepare:** the mesh stages run with the catalog model's `bed` as the build volume. The placed STL then goes to a slicer adapter (`apps/server/src/slicers.ts`, contract only). It tries `config.slicer.preferred` first and only installed adapters that `supports(model)`. The printable file is copied into `prints/<job>/morphix-<id>.<ext>`.
  - **Request:** the proposal needs `upload` + `startPrint` capabilities, the model's file format, and the printer `idle`.
  - **Confirm:** the printer is polled again and must still be idle. Then `upload({name, data, format})`, then `start(name)`. The print is confirmed by status (printing/heating/busy) or reported plainly if the printer stays silent.
  - **Tracking:** driver polls follow the job until it ends. Idle after finishing or ≥95 % counts as completed; a cancel from Morphix is recorded as cancelled; anything else is failed with the printer's message. Morphix uploads and starts files only after the user confirms.
  - **Not covered:** the guardian is not auto-started for driver printers, because its camera path is QD330-only.
  - **For integration:** the adapters come from `SLICERS` exported by `@morphix/slicing` (the slicers session has it in `adapters/index.ts`; `packages/slicing/src/index.ts` must re-export it). Until then, prepare says "No slicer in Morphix can make … yet".
  - **Tests:** `tests/server-driver-print.test.ts` runs the real core end to end with a fake driver and adapter.

## Removed (item 7)
- `apps/remote/`, `packages/remote/` (Auth0 phone app), `vercel.json`.
- `packages/portal/`: the rate limiter and camera proxy were folded into apps/server; path safety went into static.ts. The multipart parser was not kept because nothing uses it now (RPC carries files as base64).
- `apps/desktop/electron/tiger.ts`, `portal-backend.ts`.
- Swarms / Tiger telemetry in printing.ts, and the Vultr diagnoser in self-heal.ts.
- Tests: `portal-*`, `remote*`, `photo-app-remote`, `photo-app-prep`, and the Tiger block of `sponsor-integrations`.

The Vultr diagnoser tests stay, since `packages/healer` is cleanup's.

## Contract notes and follow-ups (not changed by me)
- `MorphixApi.portalInfo` / `remotePairing` and `AppSettings.keys.{vultr,tiger,swarms,auth0}` remain only because
  `pages/Settings.tsx` (setup's file) uses them. They now return "not running" / false. Once Settings.tsx stops using them,
  they can be deleted from `packages/shared`.
- `apps/desktop/src/index.html` has its own `<meta>` CSP with the old QD330 camera IP. It is harmless (browsers enforce both), but it can go.
- `tsconfig.json` still lists `apps/remote/src`, and `.gitignore` lists `apps/remote/dist`. `pg` in package.json was only used by Tiger.
  `packages/errors` still mentions the portal (cleanup's), and so do `docs/PORTAL.md`, `REMOTE.md` and `SPONSORS.md` (cleanup's docs).
- Electron (`apps/desktop/electron/main.ts`) is now an optional kiosk:
  - `MORPHIX_SERVER_URL=http://localhost:8080 npm start` just shows that server.
  - Unset, it runs the same core in-process over IPC plus a 127.0.0.1 server for the UI, library and camera. Its data dir is `MORPHIX_DATA_DIR` or `MORPHIX_ROOT` or `~/Morphix` (the existing Pi).
- `vite dev` now proxies `/api` and `/library` to `MORPHIX_DEV_SERVER` (default :8080). The mock is used only with `VITE_MORPHIX_MOCK=1`.

## README (asked for by the owner directly, ahead of the integration step)
README.md was rewritten for the open platform. It has the Devpost link, the YouTube demo (HJM8_yL3bGg), the SharkByte awards, the team,
screenshots and photos in `docs/images/` (from the team's Devpost gallery, resized, EXIF stripped), and a GIF plus stills from the touchscreen
replay. The replay video itself is `docs/media/morphix-touchscreen-replay.mp4`, 3 MB.
It links `docs/INSTALL.md` and `docs/printers/README.md`, which arrive with the install and catalog branches. At integration, check that the
printer table and the install commands still match those branches.

## Checked with the setup branch (trial merge, not committed)
I merged claude/op-setup-716238 (26b4dc8) into this branch (3c7573c) in a throwaway worktree. It merges cleanly, typecheck passes and
739 tests pass. On a live run:
- `/api/session` reports setup open, and RPC answers 401 `setup_required`.
- `POST /api/auth/setup` creates the admin and signs in, then RPC answers 200.
- The SetupGate sign-in page renders under the CSP with no console errors.
- `server.cjs reset-admin` prints the one-time password to the terminal only (it is not in the logs), and the open session was signed out.

Open point: the core reads config and keys at start-up, so a new printer or new keys need `morphix restart`. Integration could add a reload hook.
