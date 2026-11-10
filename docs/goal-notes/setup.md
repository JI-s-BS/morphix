# Setup session: config store, sign-in, setup page (GOAL items 5 and 10)

Branch `claude/op-setup-716238`. Contracts in `packages/config/src/types.ts` are unchanged.

## What's here

| File | What it does |
|---|---|
| `packages/config/src/store.ts` | `createConfigStore(dataDir, opts?)`: a file-backed `ConfigStore` plus `issues()` |
| `packages/config/src/auth.ts` | `createAuth(store, opts?)`: `AuthProvider`, accounts, sessions, `/api/auth/*` routes (`auth.routes`). Also `resetAdmin(store)`, `allowed()`, `guarded()` |
| `packages/config/src/routes.ts` | `setupRoutes(deps)`: the `/api/setup/*` RouteModule |
| `packages/config/src/keys.ts` | The 4 API keys (label, what each unlocks, where to get one) and `testApiKey()` |
| `packages/config/src/validate.ts` | Input checks (host/IP, port, serial path, key, user name, password, text) |
| `packages/config/src/fsutil.ts` | Atomic write (temp file, fsync, rename), private dirs, move-aside |
| `apps/desktop/src/pages/setup/` | `SetupGate` (wizard / sign-in / app), `SystemSetup` (Settings tab), shared panels, `setup.css` |
| `apps/desktop/src/pages/Settings.tsx` | New "System setup" tab |
| `tests/setup-{store,auth,routes}.test.ts` | 51 tests; `tests/setup-helpers.ts` has a small in-test Router |

## Files in the data dir

```
$MORPHIX_DATA_DIR/                 created 0700 if missing (existing dirs are left alone)
  config.json                      0600, schema version 1, no secrets
  config.json.corrupt-<time>       a file that couldn't be parsed, kept (never deleted)
  config.json.invalid-<time>       original copy when some fields had to be reset
  secrets/                         always 0700
    secrets.json                   0600: API keys + printer:<id>:<key> secrets
    users.json                     0600: accounts (scrypt hashes, no clear-text passwords)
```

- **Load:** a config that isn't valid JSON or has the wrong schema version is renamed to `.corrupt-<time>` and defaults are used. Single invalid fields (bad port, broken printer entry) are reset, and the original is kept as `.invalid-<time>`. Both cases are reported through `store.issues()`, which the setup page shows. A corrupt `secrets.json` is moved aside the same way, still 0600. The message never quotes the file, because JSON parse errors include the file's contents. If `secrets.json` is readable by other users, it is set back to 0600 and reported.
- **Save:** `save()` validates strictly and throws on invalid input. Writes go through a queue, so concurrent saves can't interleave.
- **Legacy import (once):** on the very first start (no `config.json` and no `secrets.json` yet), the first `morphix.env` found among `<dataDir>/morphix.env`, `<dataDir>/config/morphix.env`, `$MORPHIX_ROOT/config/morphix.env` and `~/Morphix/config/morphix.env` is imported:
  - the 4 keys;
  - an Afinia QD330 printer at `MORPHIX_PRINTER_HOST` (default 192.168.10.51, as the Pi build used);
  - features turned on for the keys found.

  The old file is not changed. Deleting an imported key later sticks, because the import never runs again.

## Accounts and sessions

- **First run:** `POST /api/auth/setup` creates the admin and signs them in. It works only while there is no admin (`setupOpen()`). Requests are serialized, so two people racing on first run can't both become admin.
- **Passwords:** scrypt (N=16384, r=8, p=1, 64-byte key) with a 16-byte salt per user, stored as `scrypt$N$r$p$salt$hash`, compared with `timingSafeEqual`. An unknown user name also runs scrypt (against a dummy hash), so the response time doesn't reveal whether the name exists. Passwords are 8 to 256 characters. User names are case-insensitive.
- **Lockout:** 5 wrong passwords for one user name within 15 minutes lock that name for 15 minutes; this also blocks the right password. 20 failures from one client address within 15 minutes block that address. A locked request gets 429 with `Retry-After`. The address is `req.socket.remoteAddress`; `X-Forwarded-For` is not trusted. Behind a reverse proxy every client shares the proxy's address, so the server session should decide whether to pass a real client IP.
- **Sessions:** 256-bit random token in cookie `morphix_session` (`HttpOnly; SameSite=Strict; Path=/`, plus `Secure` when the socket is TLS or `secureCookies: true`). Only the token's SHA-256 is kept, in memory: restarting the server signs everyone out. Sessions end after 24 h without use or 7 days in total. Each user can have up to 20 sessions.
- **Password change:** signs that user out everywhere, then signs the current browser back in. Every password change bumps the user's `pwVersion`, which invalidates older sessions.
- **Roles:** `admin` can do everything. `user` can sign in, print and change their own password, but every `/api/setup/*` write is admin-only.
- **Corrupt accounts file:** if `users.json` can't be read, it is left in place and setup stays **closed** (it does not reopen to the network). Requests then get 503 with a message pointing to reset-admin.

### Recovery: `server.cjs reset-admin`

`resetAdminAccount(store, { name?, password? })` returns `{ name, password, created, generated }`. `resetAdmin(store)` wraps it and returns the text the CLI prints (including the new password).

- It sets a new password for the first admin, or for `name`, which is then made admin. If there is no admin at all, it creates one named "admin".
- With no `password`, it generates a 16-character password and flags the account `mustChangePassword`. After signing in, the UI asks for a new password before anything else.
- It bumps `pwVersion`. The running server notices that `users.json` changed (by inode, mtime and size), so the old sessions stop working without a restart.
- If `users.json` is corrupt, it moves it to `users.json.corrupt-<time>` and starts a fresh file.

The server session wires the CLI:

```
node apps/server/dist/server.cjs reset-admin            # prints a one-time password
```

The server prints the string `resetAdmin` returns once to the terminal (stdout) and never logs it.

## Routes (all JSON; the server enforces CSRF on non-GET)

Each handler also re-checks its `Access` itself (`guarded()`), so a server routing mistake can't expose an admin route. `InputError` → 400 `{ error, field }`, bad JSON → 400, anything else → 500 with a plain message.

| Method | Path | Access | Body / result |
|---|---|---|---|
| GET | `/api/auth/me` | public | `{ user, setupOpen, mustChangePassword }` |
| POST | `/api/auth/setup` | setup | `{ name, password }`, creates the admin and sets the cookie; 409 once an admin exists |
| POST | `/api/auth/login` | public | `{ name, password }` → `{ user, mustChangePassword }` + cookie; 401 / 429 |
| POST | `/api/auth/logout` | public | clears the cookie |
| POST | `/api/auth/password` | user | `{ current, next }` |
| GET/POST | `/api/auth/users` | admin | list / `{ name, password, role? }` |
| DELETE | `/api/auth/users/:name` | admin | not yourself, not the last admin |
| GET | `/api/setup/status` | public | `{ setupOpen, setupComplete }`; the admin also gets steps, key status, features, store issues |
| GET | `/api/setup/catalog` | admin | brands → models (driver, verified, `docUrl` to `docs/printers/*.md` on GitHub, `driverAvailable`) + drivers with `fields` |
| GET/POST | `/api/setup/printers` | admin | list (with `secretFields: {key: set?}`) / add `{ name, modelId, driver?, connection }` |
| PUT/DELETE | `/api/setup/printers/:id` | admin | edit (a missing or empty secret keeps the saved one; `null` clears it) / remove (also removes its secrets) |
| POST | `/api/setup/printers/:id/test` | admin | `connection.test()` with the saved secrets (the body can carry edited, unsaved values) |
| POST | `/api/setup/test-printer` | admin | test unsaved values (the wizard's "Test" before "Save") |
| PUT | `/api/setup/active-printer` | admin | `{ id }` |
| POST | `/api/setup/discover` | admin | `{ driver?, timeoutMs? }` runs `driver.discover` (1 to 10 s) → `{ found: [... , models: [catalog ids]] }` |
| GET/PUT | `/api/setup/slicers`, `/api/setup/slicer` | admin | detection via `slicerAdapters` if passed, else the plain SlicerId list / `{ preferred, paths? }` |
| GET | `/api/setup/keys` | admin | `[{ key, label, unlocks, getUrl, set }]` |
| PUT/DELETE | `/api/setup/keys/:key` | admin | `{ value }` / clear. During first setup, a new key turns on the features it unlocks; clearing a key turns off features left with no key |
| POST | `/api/setup/keys/:key/test` | admin | `{ value? }` (no body tests the saved key) |
| PUT | `/api/setup/features` | admin | `{ voice?, aiGeneration?, modelSearch?, guardian? }`; turning a feature on needs one of its keys |
| POST | `/api/setup/finish` | admin | `setupComplete = true` |

**Secrets never leave the server:**

- Responses carry only set / not set.
- Key tests put the key in a request header (never a URL), use an 8 s timeout and `redirect: "error"`, and return plain text.
- Printer test results and driver error messages are scrubbed of the printer's secret values before they are sent.
- Validation errors never repeat the rejected value.
- The tests check every response transcript for the secret values.

**Key test calls (read-only):**

| Key | Request |
|---|---|
| Gemini | `GET generativelanguage.googleapis.com/v1beta/models?pageSize=1` (`x-goog-api-key`) |
| Meshy | `GET api.meshy.ai/openapi/v1/balance` (Bearer) |
| Anthropic | `GET api.anthropic.com/v1/models?limit=1` (`x-api-key`) |
| Thingiverse | `GET api.thingiverse.com/users/me` (Bearer) |

## What the server session needs to do (integration)

The server looks these names up (agreed with the server session):

```ts
import * as config from "@morphix/config";
const store = config.createConfigStore(dataDir);                 // MORPHIX_DATA_DIR
const auth = config.createAuthProvider(store);                   // = createAuth(store); also carries .routes
for (const m of config.createSetupRoutes({ store, auth, csrfToken })) m(router);   // [/api/auth/*, /api/setup/*]
// node server.cjs reset-admin: console.log(await config.resetAdmin(store))
```

`createSetupRoutes` also takes the optional `SetupDeps` (`slicerAdapters`, `catalog`, `drivers`, timeouts). `csrfToken` is accepted and not used: CSRF is checked by the server. The lower-level `createAuth` / `setupRoutes` / `allowed()` stay exported.

1. Implement CSRF: a readable cookie `morphix_csrf` plus `GET /api/session` → `{ csrf }`, and check `X-Morphix-CSRF` on non-GET requests. The UI reads the cookie first, then falls back to `/api/session`. This module does not implement `/api/session`, so there is no route clash.
2. Wrap the app in `<SetupGate>` in `main.tsx` / `App.tsx` (server-owned files): `createRoot(...).render(<SetupGate><App/></SetupGate>)`.
3. Pass `slicerAdapters` (from packages/slicing once the slicers session exports a list) so the slicer step shows what's installed. Without them it shows the three slicers as "Not checked".
4. The `catalog` and `drivers` defaults come from `@morphix/catalog` `PRINTERS` and the `@morphix/printer` `DRIVERS` registry. Today the registry is empty, so saving a printer answers "can't talk to this printer yet" until the driver branches are merged. Tests inject fakes.
5. Size-limit request bodies. `ctx.json()` errors named `SyntaxError` become a 400.
6. `reset-admin` CLI, as above.

## Gate behaviour (UI)

| Situation | What shows |
|---|---|
| No admin yet | the wizard: 1 admin, 2 printer (network search, brand, model, connection fields with help, setup guide link, a warning for `verified: "protocol"`, Test, Save), 3 slicer, 4 API keys (each optional, with a sentence on what it unlocks), 5 done |
| Admin exists, not signed in | sign-in screen |
| Admin signed in, setup not finished | the wizard from step 2 |
| `mustChangePassword` | the change-password screen |
| A `user` while setup isn't finished | "an admin needs to finish setup" |
| Setup finished, signed in | the app |
| Electron (`window.morphix`), setup finished | the app with no sign-in, so the touchscreen keeps working. The Electron app talks to its main process over IPC, not these routes. |
| No Morphix API answers (HTML back, a 404, or Electron with no server) | the app (design preview / IPC kiosk) |
| A browser that can't reach the server | an error screen with "Try again" |

The gate only decides what to show. The protection is the server-side access checks.

Settings → **System setup** (a new tab):

- An admin can change everything: printers (test, edit, remove, choose the active one), slicer and custom paths, keys, feature toggles, accounts (add a user or admin, remove), and their own password.
- A `user` sees only their own password change and sign-out.
- Someone not signed in gets a sign-in form.

I checked the flow in a browser against these routes, using a throwaway harness with fake drivers and the real CSRF cookie and header: first run, network search filling in the printer, test, save, slicer, a key, finish, the app, System setup, sign-out, and the sign-in screen.

## Not done / for later

- **Sessions are in memory.** That is simpler and nothing persistent can leak, but an update or restart signs everyone out. Persisting hashed tokens in `secrets/` would be a small change if wanted.
- **Kiosk over HTTP.** A local kiosk that is a plain browser (`chromium --kiosk`, no `window.morphix`) has to sign in like any other browser. Trusting loopback was deliberately left out, because a Cloudflare tunnel or proxy also arrives on loopback.
- **Printer setup guides** link to GitHub (`DOCS_BASE` in routes.ts). If the server later serves `docs/` itself, change `DOCS_BASE`.
- **Electron still reads `morphix.env`.** The "API keys" card in Settings → General says keys live in `morphix.env` when no server answers, and points to System setup when one does.
- **A failing test I didn't cause.** `tests/portal-api.test.ts` "serves the front-end and three.js" fails in this worktree because the worktree has no `node_modules` of its own (it can't resolve `three/build`). It is not caused by this branch.
