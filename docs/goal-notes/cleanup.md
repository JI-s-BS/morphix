# Cleanup (GOAL.md item 7): what was removed, and what the integrator still has to drop

Branch `claude/op-cleanup-900b7e`, based on `56bfe18`. `npm run typecheck` and `npm test` pass
on every commit (720 passed, 3 skipped; baseline was 737 passed, the 17 fewer are tests of removed code).

## Line counts (before → after)

| Area | Before | After |
|---|---|---|
| packages/guardian/src | 1827 | 1634 |
| packages/healer/src | 1272 | 1211 |
| packages/jobs/src | 788 | 644 |
| packages/meshy/src | 348 | 192 |
| packages/gemini/src | 461 | 414 |
| services/ | 2074 | 1347 |
| docs/ (all *.md) | 2703 | 1569 |
| tests/ | 10811 | 10612 |

## Removed

**Sponsor integrations** (local fallbacks kept, so behaviour without keys is unchanged):
- Swarms AI review (`SwarmsReviewClient`, `swarmsFromEnv`): guardian now always uses the local review
  (`packages/guardian/src/review.ts`, unchanged logic). `AlertVerification.source` is `"gemini" | "local"`.
- Tiger Data telemetry (`TelemetrySync`, `TIGER_TELEMETRY_SQL`, the `swarms`/`telemetry` fields of `GuardianSnapshot`).
- Vultr backup diagnoser (`createVultrDiagnoser`, `pickVultrModel`, `VULTR_INFERENCE_URL`). Claude diagnosis stays; `firstDiagnoser` stays (generic).
- `docs/SPONSORS.md`; tests `tests/sponsor-integrations.test.ts`, `tests/phase4-cloud.test.ts` (its local-review test moved to `tests/guardian-review.test.ts`).

**Dead code** (found with a TypeScript language-service scan for exports without references, then grep across apps/ packages/ tests/; knip could not run here):
- `packages/gemini`: `DemoAssistant`, `GeminiNotConfigured`, `Assistant`, `AssistantReply` (the app has had no demo mode: `main.ts` throws "Gemini is not configured").
- `packages/meshy`: `DemoGenerator`, `pickShape`, `buildShape`, `toBinaryStl`, `Tri`, unused `MeshyNotConfigured`. Tests now use `writeBinaryStl(box(...))` from slicing.
- `packages/jobs`: `createJobFileStore` (duplicate of `storage.writeAtomic`, which the app uses) and `trackPrepare` (duplicated by the stage map in `apps/desktop/electron/printing.ts:36`).
- `packages/guardian`: `levelForState`, `OPEN_ALERT_STATES` (unused); `MemoryGuardianStore` was test-only → `tests/guardian-helpers.ts`.
- `packages/errors`: `isErrorCode` (unused; `isKnownErrorCode` is the one in use). `packages/photo3d`: `PHOTO_ROUTES`.
- Stale "Phase N", "integrator", `/home/jd`, "on the Pi" wording in comments and user-facing hints of the owned packages; healer's Claude prompt no longer assumes a Pi + QD330. Error-code texts made generic (codes unchanged), `docs/ERRORS.md` regenerated.

**services/**
- `services/qd330-dashboard` (Python dashboard + `qd330ctl` CLI) removed: nothing in the app uses it; it was a second, separately-authenticated printer control surface on port 8000.
- `services/vision` kept: the Print Guardian spawns it (`printing.ts:117`, `packages/guardian/src/worker.ts`). README rewritten for any distro; default snapshot URL is `localhost` instead of the owner's LAN IP.

**docs/** — deleted `PHASE3.md`, `PHASE4.md`, `PHASE5.md`, `PHASES.md`, `SPONSORS.md`, `RELEASE-NOTES.md`, `CAD.md`, `PHOTO3D.md`, `PORTAL.md`, `REMOTE.md`. Folded into:
- `ARCHITECTURE.md` (rewritten: package map, data folder, design rules)
- `SAFETY.md` (new: rules, how print controls are unlocked, approval, emergency stop, the operator checklists with their step IDs incl. L1/L2 and M0–M8, guardian, self-heal, AI/CAD, secrets, network exposure)
- `QD330.md` (new: QD330 TCP protocol facts, `.gx` layout, verified vs unverified, validating against a real `.gx`, fake printer)
- `AI.md` (new: Gemini Live, Meshy, Claude CAD, photo→3D, model search, slicer advisor, guardian vision, error diagnosis; keys, limits, no-key behaviour)
- `GUARDIAN.md` (new, from PHASE4 minus cloud extras); `SELF-HEAL.md`, `JOBS.md` trimmed.
- The old portal's web-hardening checklist (CSRF, upload limits, rate limits, camera proxy) is in the shared notes folder as `cleanup-web-hardening.md` for the server session.

**package.json**: nothing removed yet; see below (`pg`, `qrcode` are still imported by Electron files I don't own).

## For the integrator / other owners: exact lines to drop

Compile-only shims exist so the tree stays green. Delete them once these lines are gone:
`packages/guardian/src/compat.ts` (+ its line in `packages/guardian/src/index.ts`, and the deprecated
`swarms?` / `telemetry?` options in `packages/guardian/src/guardian.ts` `PrintGuardianOptions`),
and `vultrDiagnoserFromEnv` at the end of `packages/healer/src/diagnose.ts`.

server (`apps/desktop/electron/**`, `packages/shared`, `apps/desktop/src/{mock.ts}`):
- `apps/desktop/electron/tiger.ts`: delete the file.
- `apps/desktop/electron/printing.ts:17`: drop `swarmsFromEnv, telemetryFromEnv` from the import; `:18` drop `import { createTigerSink } from "./tiger";`; `:130-136` drop the `swarms:` and `telemetry:` options (comments included).
- `apps/desktop/electron/self-heal.ts:9`: drop `firstDiagnoser` and `vultrDiagnoserFromEnv` from the import; `:97-98` → `const diagnose = deps.diagnose !== undefined ? deps.diagnose : claudeDiagnoserFromEnv(env);`
- `apps/desktop/electron/main.ts:259-261`: drop the `vultr`, `tiger`, `swarms` key flags.
- `packages/shared/src/index.ts:185`: drop `"vultr" | "tiger" | "swarms"` from `keys` (and `"auth0"` with the Auth0 removal).
- `apps/desktop/src/mock.ts:45`: drop `vultr`, `tiger`, `swarms`.
- Then `package.json`: remove `pg` and `@types/pg` (only `tiger.ts` imports pg). If phone pairing goes (`main.ts:35,162,537` use `qrcode`), also remove `qrcode` and `@types/qrcode`.
- Error messages in `apps/desktop/electron/main.ts:117,426` and `voice.ts:195,413` still say "Add … to ~/Morphix/config/morphix.env"; point them at the setup page.
- `main.ts:54` `MORPHIX_PRINTER_HOST` default is the owner's LAN IP (192.168.x); should come from config.
- `packages/portal/web/app.js:106`, `packages/portal/src/pages.ts:36`, `apps/remote/src/auth0.ts:1`, `packages/remote/src/auth0.ts:1`, `main.ts:874`, `tests/remote-auth0.test.ts:1` cite the deleted `docs/PORTAL.md` / `docs/REMOTE.md` (gone with the Auth0/phone removal).
- Error codes `MX-AUTH-*` / `MX-PORTAL-*` and the `"auth0"` / `"portal"` `ErrorService` values are kept (codes are stable and portal/remote still use them). Retire them, if wanted, after the Auth0 removal lands.

setup (`apps/desktop/src/pages/Settings.tsx`):
- `Settings.tsx:9`: drop `vultr: "Vultr", tiger: "Tiger Data", swarms: "Swarms"` (and `auth0`).

install (`deploy.sh`, `scripts/pi/**`):
- `deploy.sh:8-9`: drop the "QD330 dashboard" py_compile step (the folder is gone; this line now fails).
- `scripts/pi/install-user-services.sh:2` (comment), `:14-18` (`qd330ctl` wrapper), `:30-31` (enable/restart `qd330-web.service`).
- `scripts/pi/systemd/qd330-web.service`: delete.

slicers (`packages/slicing/**`, `config/slicer-profiles/**`) and drivers-lan (`packages/printer/src/*.ts`) — doc links to update:
- `docs/PHASE3.md` → `docs/QD330.md` (".gx", "Validating against a real Afinia .gx"): `packages/slicing/src/gx.ts:11`, `index.ts:7`, `leveling.ts:7`, `prepare.ts:302`, `config/slicer-profiles/README.md:7`, `config/slicer-profiles/qd330-pla-0.2mm.ini:8`.
- `docs/PHASE5.md` → `docs/SAFETY.md` (checklists keep their IDs, e.g. L1, L2, M0–M8): `packages/slicing/src/prepare.ts:286` (user-facing warning), `leveling.ts:15`, `packages/printer/src/control.ts:3`, `control.ts:1078` (user-facing message), `machine.ts:9`.

integration (`README.md`, `config/morphix.env.example`):
- `README.md:91` → link `docs/SAFETY.md`; `README.md:113-114,121` drop `services/qd330-dashboard` and the CAD/PHOTO3D/PORTAL/REMOTE links → `docs/AI.md`, `docs/GUARDIAN.md`, `docs/QD330.md`.
- `config/morphix.env.example:25,30,32` cite `docs/PHASE5.md` → `docs/SAFETY.md`; `:36,55` cite PORTAL/REMOTE (Auth0 lines go with the Auth0 removal); drop the Vultr/Tiger/Swarms block (`:13-21`, `VULTR_INFERENCE_API_KEY`, `VULTR_API_KEY`, `TIGER_DATABASE_URL`, `SWARMS_API_KEY` and their comments).
- `docs/ARCHITECTURE.md` links `docs/printers/` (created by the catalog session).

## Kept on purpose (when in doubt, kept)

- `openscadVersion` (photo3d), `withErrorCode`, `userMessage`, `errorCodeOwner`, `unregisterErrorCodes` (errors): only tests call them today, but they are small documented public API.
- `VISION_PROTOCOL_VERSION` (guardian): unused constant, but it documents the worker protocol version.
- `scaleForHeight` (domain): test-only, tiny.
- `packages/storage` still reads `MORPHIX_ROOT` (default `~/Morphix`); mapping it to `MORPHIX_DATA_DIR` is a behaviour change for the server/config wiring, not cleanup.
- Guardian test files keep their `tests/phase4-*.test.ts` names (renaming is churn only).
- Guardian: the columns added by `GUARDIAN_COLUMN_MIGRATIONS` exist but `printing.ts` never fills them; the app writes the alert state into `level`. Worth tidying when the server owns the guardian wiring.
- Self-heal give-up hint now says "look at the Morphix logs"; no screen shows the heal history yet.
