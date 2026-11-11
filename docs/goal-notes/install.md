# install session: GOAL items 1 and 10

## What's here

| File | What |
|---|---|
| `scripts/install/install.sh` | One installer for any Linux. Pipe-safe (`set -euo pipefail`, functions only, `main` on the last line). Detects apt / dnf / pacman via `/etc/os-release` (ID + ID_LIKE), refuses other distros with manual steps (exit 3), refuses armv6l / unknown CPUs (exit 4), < 900 MB RAM without `--force` (exit 5), < 2 GB disk (exit 6). Node ≥ 22 from PATH, else the official `latest-v22.x` tarball for x64/arm64/armv7l verified against nodejs.org's SHASUMS256.txt. `--system` (default) / `--user`, `--channel`, `--skip-tests`, `--with-prusaslicer`, `--with-extras` (espeak-ng + Python OpenCV, replaces ensure-tts/ensure-vision), `--kiosk [--kiosk-user]`, `--auto-update`, `--port`, `--repo`, `--dry-run`, `--uninstall [--purge]`, `--yes`, `--force`. |
| `scripts/install/morphix` | The CLI: status, start/stop/restart, logs, update, rollback, doctor, backup/restore, reset-admin, auto-update on/off, version. Decision logic is in pure functions (`parse_*_args`, `busy_reason`, `decide_after_health`, `rollback_target`, `prune_list`, `node_major_ok`, `tar_is_safe`); tests source the file with `MORPHIX_CLI_SOURCE_ONLY=1`. |
| `scripts/install/morphix-kiosk` | Waits for `/api/health`, then `chromium --kiosk http://localhost:8080`. Installed with an XDG autostart entry by `--kiosk`. |
| `packaging/systemd/*.in` | Hardened system unit, user unit, nightly update service + timer (03:30, off until `morphix auto-update on`). |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | node:22-bookworm-slim, multi-stage, non-root `morphix`, `/data` volume, HEALTHCHECK on `/api/health` (node fetch, no curl), `WITH_PRUSASLICER` / `RUN_TESTS` build args. `.dockerignore` is new (not in the ownership table; nobody else needs it). |
| `docs/INSTALL.md` | Requirements, one-line install, Pi / PC / VM / Docker / other Linux, commands, update, rollback, backup, uninstall, troubleshooting, migration from the old Pi setup, file layout. |
| `tests/install-*.test.ts` | `install-scripts` (bash -n, shellcheck when installed, pipe-safety, unit hardening, `systemd-analyze verify`, Docker), `install-detect` (dry-run in a sandbox: fake uname/os-release/meminfo/sudo/apt; every distro and refusal branch; dry run writes nothing), `install-cli` (arg parsing, busy marker, rollback/prune decisions, unsafe tar), `install-e2e` (real install.sh --user from a throwaway git repo with a fake systemctl: install → update → broken update rolls back by itself → busy blocks → rollback → status/doctor/reset-admin → backup/restore → uninstall keeps data). |

Deleted: `scripts/pi/*` (all of it), `deploy.sh`. Fonts → `--kiosk` installs the distro emoji font;
TTS / vision → `--with-extras` installs distro packages (the app already falls back to
`/usr/bin/espeak-ng` and `python3`).

## Layout

`/opt/morphix/{src (git cache), releases/<sha>, current → releases/<sha>, previous, node/}`, data
`/var/lib/morphix` (0700, user `morphix`, groups dialout/uucp/video when they exist), config
`/etc/morphix/{install.conf, morphix.env}`. `--user`: `~/.local/share/morphix-app`,
`~/.local/share/morphix`, `~/.config/morphix`. Releases are `git archive` exports (no .git),
built as the `morphix` user (npm never runs as root), `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.

## What other sessions need to know (contracts I build against)

- **server**: I run `npm ci && npm test && npm run build && npm run build:server` and start
  `node <release>/apps/server/dist/server.cjs` with `MORPHIX_DATA_DIR`, `MORPHIX_PORT`,
  `MORPHIX_BIND` (from the env file), plus `MORPHIX_ROOT=<data dir>` so `packages/storage`
  keeps the old layout inside the data dir, and `HOME=<data dir>` for the system service.
  - `GET /api/health` must answer **200 with JSON containing `"ok":true`** within ~90 s of start
    (the CLI greps for `"ok":true` / `"ok": true`). Anything else = rollback.
  - `server.cjs reset-admin` is called with the data dir env and a TTY, as the service user.
  - **Busy marker**: updates wait while `<MORPHIX_DATA_DIR>/run/busy` **or** `<MORPHIX_DATA_DIR>/run/printing`
    was modified < 30 s ago. `run/busy` is what `apps/desktop/electron/busy.ts` already writes
    (`storage.path("run","busy")`, which is in the data dir thanks to MORPHIX_ROOT). Please also
    keep `run/printing` fresh while a print **depends on this process** (USB/serial streaming,
    any driver where a restart kills the print); `busyReasons()` deliberately excludes prints,
    which is right for the QD330 but wrong for serial printers.
  - The system service runs with `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`: the
    server may write only the data dir and /tmp. No `PrivateDevices` (USB serial works), no
    `MemoryDenyWriteExecute` (V8). `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`
    (UDP discovery is fine; raw sockets/AF_PACKET are not).
  - Stale comments that mention deploy.sh / scripts/pi (yours to update): `apps/desktop/electron/busy.ts:1-3,29`,
    `apps/desktop/electron/main.ts:109`, `apps/desktop/electron/tts.ts:3`.
- **setup**: `morphix backup` leaves out files matching `secrets.json`, `secrets/`, `secrets.*`,
  `*.env`, `*.key`, `*.pem`, `auth.json`, `session-secret*` unless `--include-secrets`. Please
  store API keys / password hashes / session secrets under one of those names in the data dir
  (e.g. `secrets.json` and `auth.json`), or tell the integrator the real names so the list in
  `scripts/install/morphix` (`SECRET_PATTERNS`) can be updated.
- **slicers**: the installer only installs `prusa-slicer` from the distro (`--with-prusaslicer`;
  Debian 12's is 2.5.x). `morphix doctor` looks on PATH for prusa-slicer/PrusaSlicer,
  orca-slicer/OrcaSlicer, bambu-studio/BambuStudio. Slicer binaries under /home are invisible
  to the system service (ProtectHome); INSTALL.md says to put AppImages under /opt.
- **cleanup / integration**: `tests/deploy-busy.test.ts` tests `busy.ts` (still used); only its
  first comment mentions deploy.sh. README.md lines 80, 116, 121 and docs/PHASE4.md:338 still
  mention scripts/pi / deploy.sh; README (#9) should link docs/INSTALL.md instead.
- **Docker**: `npm prune --omit=dev` runs after the build, so `server.cjs` must not `require`
  anything that is only a devDependency at runtime (electron, vite, esbuild…).

## Not verified

- No real system install was run here (it needs root on a disposable machine); the system code
  paths are covered by `--dry-run` tests only. The user-install path ran for real end to end
  (with a fake systemctl and a fake server).
- No real Raspberry Pi, Fedora or Arch run; detection is tested with fake os-release/uname.
- Docker image not built (no docker on this machine); `apps/server` doesn't exist on this
  branch yet, so a real `npm run build:server` can't run before integration.
- shellcheck isn't installed here; the shellcheck test skips. Run it in CI.
