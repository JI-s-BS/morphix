# Morphix web portal

A child-friendly website served by the Pi so people can use Morphix from their phone:

- take photos (or add a LiDAR scan) and ask Morphix to make something
- watch progress live
- say yes or no to costs and prints
- spin their models in 3D
- watch the printer camera

Grown-ups (admins) also get printer buttons.

Everything is behind **Auth0** sign-in and an **allow-list of e-mail addresses**.

The package lives in `packages/portal`:

| Path | What |
|---|---|
| `src/server.ts` | `createPortal()`: HTTP(S) server, routing, security headers, rate limits, SSE, camera proxy |
| `src/oidc.ts` | OpenID Connect client: Authorization Code + PKCE, RS256 ID-token checks against the JWKS |
| `src/session.ts` | HMAC-signed cookies (session and login state) |
| `src/config.ts` | Reads the Auth0 and portal environment variables |
| `src/multipart.ts`, `src/uploads.ts`, `src/sniff.ts` | Streaming multipart parser, upload form rules, magic-byte type checks |
| `src/commands.ts` | Validation of printer commands |
| `src/types.ts` | **`PortalBackend`**, the interface the app implements |
| `src/fake-backend.ts`, `src/fake-oidc.ts` | Fakes for the tests and the offline demo |
| `src/camera.ts` | `httpCameraSource(url)`: opens the printer's MJPEG stream on the server side |
| `web/` | Front-end. Plain HTML, CSS and ES modules, with no build step. three.js is served from `node_modules/three` under `/vendor/` |

No new npm dependencies. The portal uses only `node:http`, `node:https`, `node:crypto`, `fetch` and the existing `three` package.

## Try it locally (no keys, no Pi)

```bash
node packages/portal/demo.mjs 18443
```

Then open http://127.0.0.1:18443 and press **Sign in**.

- A fake Auth0 runs on your computer and signs you in as `grown-up@example.com` (an admin).
- To see the error card, put the word "fail" in a request.
- `PORTAL_DEMO_ADMIN=0` turns off the admin buttons.

## Auth0 setup, step by step

Do this once, in the Auth0 dashboard (https://manage.auth0.com).

1. **Create the application**
   - Go to **Applications → Applications → + Create Application**.
   - Name: `Morphix Portal`.
   - Type: **Regular Web Applications**. This is a server-side app that keeps a client secret. Don't pick "Single Page Application".
   - Click **Create**, then skip the quick-start technology picker.
2. On the application's **Settings** tab, note these three values:
   - **Domain** (for example `dev-abc123.us.auth0.com`)
   - **Client ID**
   - **Client Secret**
3. Under **Application URIs**, enter the following, then click **Save Changes**:

   | Field | Value |
   |---|---|
   | Allowed Callback URLs | `http://192.168.86.38:8443/callback` |
   | Allowed Logout URLs | `http://192.168.86.38:8443/` |
   | Allowed Web Origins | `http://192.168.86.38:8443` |
   | Application Login URI | leave empty |

   The trailing slash on the logout URL matters: the portal sends `returnTo=<PORTAL_BASE_URL>/`.
4. **Credentials** tab: set Authentication Method to **Client Secret (Post)**. This is the default for regular web apps, and the portal sends the secret in the token request body.
5. Check **Settings → Advanced Settings**:
   - **OAuth** tab: *JSON Web Token (JWT) Signature Algorithm* = **RS256** (the default) and *OIDC Conformant* switched on.
   - **Grant Types** tab: **Authorization Code** must be ticked.
6. **Connections** tab: choose how people sign in.
   - **Google** (`google-oauth2`) is easiest for families.
   - **Username-Password-Authentication** also works. Morphix only accepts accounts whose e-mail is **verified** (`email_verified: true`), so new password users must click Auth0's verification e-mail first.
   - Optional: switch on **Disable Sign Ups** under *Authentication → Database → Username-Password-Authentication*. The allow-list already keeps strangers out, but this stops strangers from creating accounts at all.
7. On the Pi, add the settings to `~/Morphix/config/morphix.env` (`/home/jd/Morphix/config/morphix.env`):

   ```ini
   # Web portal (docs/PORTAL.md)
   AUTH0_DOMAIN=dev-abc123.us.auth0.com
   AUTH0_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxx
   AUTH0_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   PORTAL_BASE_URL=http://192.168.86.38:8443
   # at least 32 characters; generate with: openssl rand -hex 32
   PORTAL_SESSION_SECRET=
   # who may sign in (comma-separated). Empty = nobody.
   AUTH0_ALLOWED_EMAILS=kid@example.com,parent@example.com
   # who may use printer buttons and confirm prints (they may sign in too)
   AUTH0_ADMIN_EMAILS=parent@example.com
   # optional: PORTAL_SESSION_HOURS=12
   ```

8. Restart Morphix with `systemctl --user restart morphix`.
9. On a phone that is on the same Wi-Fi, open http://192.168.86.38:8443.

If anything is missing, the portal shows a **"Morphix needs a grown-up"** page listing the variables to fix, and every `/api/*` call returns `503 not_configured`.

If someone signs in but isn't on the list, they see **"You're not on the list yet"**. That page shows the e-mail they used and explains how to add it to `AUTH0_ALLOWED_EMAILS`.

**Keep the address stable.** The callback URL contains the Pi's IP address. Give the Pi a DHCP reservation for `192.168.86.38` on the router. If the address ever changes, update `PORTAL_BASE_URL` and all three Auth0 URL fields.

**HTTPS (optional).** On plain `http://` the cookies can't be marked `Secure`, and anyone on the same Wi-Fi could read traffic.

- To use HTTPS, pass `tls: { cert, key }` to `createPortal`, for example from files named by `PORTAL_TLS_CERT` and `PORTAL_TLS_KEY`.
- Use `https://` in `PORTAL_BASE_URL` and in the Auth0 URLs.
- A self-signed certificate works, but each phone shows a warning once:

  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout portal.key -out portal.crt -subj /CN=192.168.86.38 -addext subjectAltName=IP:192.168.86.38
  ```

- If your Auth0 tenant refuses `http://` callback URLs, HTTPS is required.

## Integrating: `PortalBackend`

The portal never touches the database, Meshy, Gemini or the printer directly. Each of these calls goes to the object you pass as `backend`. Every method receives the signed-in `PortalUser`: `{ sub, email, name, picture?, isAdmin }`, where `isAdmin` is computed from `AUTH0_ADMIN_EMAILS` on the server.

```ts
interface PortalBackend {
  me(user): Promise<PortalMe>;                                   // { displayName?, generationsLeftToday?, features?: { photo, text, printer, camera } }
  listProjects(user): Promise<PortalProject[]>;
  getProject(id, user): Promise<PortalProjectDetail | null>;     // null → 404
  modelFile(versionId, user): Promise<PortalFile | null>;        // { path, format: "stl" | "glb" }, must be inside storageRoot
  thumbnailFile?(versionId, user): Promise<PortalFile | null>;   // optional { path, format: "png" | "jpg" | "webp" }
  createPhotoRequest(req: PhotoRequest): Promise<RequestAccepted>;   // { jobId, projectId? }
  createTextRequest(prompt, user): Promise<RequestAccepted>;
  pendingActions(user): Promise<PortalAction[]>;                 // cost / print confirmations waiting for a "yes"
  confirmAction(id, user): Promise<ActionResult>;                // { ok, message?, jobId? }
  cancelAction(id, user): Promise<ActionResult>;
  jobEvents(jobId, onEvent, user): (() => void) | null;          // send the current state immediately, return unsubscribe; null → 404
  printerStatus(user): Promise<PortalPrinterStatus>;
  printerCommand(command: PrinterCommand, user): Promise<ActionResult>;  // only called for admins, with validated args
  cameraStream(user): Promise<CameraStream | null>;              // { contentType, stream: Readable }; null → 503
}
```

`PhotoRequest` contains:

| Field | Contents |
|---|---|
| `images` | 1 to 6 items of `{ name, mime, bytes: Buffer }`. `mime` is detected from magic bytes: JPEG, PNG, WebP or HEIC. |
| `scan?` | `{ name, format: "obj" \| "ply" \| "stl" \| "glb", size, path }`. The file is a temporary file under `<storageRoot>/portal/uploads/`. **Copy or move it before your promise resolves**, because the portal deletes whatever is left. |
| `description` | Up to 1000 characters. |
| `measurements` | `{ label, value, unit: "mm" \| "cm" \| "in" }[]`, up to 10. |
| `referenceObject` | `"none" \| "credit-card" \| "coin" \| "ruler" \| "phone"` |
| `user` | The signed-in `PortalUser`. |

A `JobEvent` has the form `{ jobId, status, progress, stage, stages?, message?, error?, projectId?, versionId?, actionId?, at }`:

- `status`: `queued | running | waiting | succeeded | failed | cancelled`
- `progress`: 0 to 100
- `stage`: a friendly label
- `stages[]`: `{ id, label, state: pending | active | done | failed | skipped }`
- `error`: `{ code: "MX-GEN-003", message, hint }`. The UI shows the code and a "What to try" box.
- While a job waits for a cost confirmation, send `status: "waiting"` and `actionId`. The progress screen then shows the confirmation card.

A `PrinterCommand` is one of:

- `light {on}`
- `fan {speed 0..100}`
- `home`
- `pause`
- `resume`
- `cancel`
- `temperature {heater: nozzle|bed, celsius}`

Temperatures are capped at 260 °C for the nozzle and 100 °C for the bed. The portal rejects anything else with a 400 before the backend sees it.

### Wiring it into `apps/desktop/electron/main.ts`

```ts
import { createPortal, loadPortalAuthConfig, httpCameraSource } from "@morphix/portal";

const REPO_ROOT = resolve(__dirname, "../../..");          // main.cjs lives in apps/desktop/dist
const portal = createPortal({
  backend: portalBackend,                                     // see the mapping below
  auth: loadPortalAuthConfig(process.env),                    // setup page until Auth0 is configured
  port: Number(process.env.PORTAL_PORT ?? 8443),
  storageRoot: storage.root,                                  // ~/Morphix
  webRoot: join(REPO_ROOT, "packages/portal/web"),
  threeRoot: join(REPO_ROOT, "node_modules/three"),
  tls: process.env.PORTAL_TLS_CERT
    ? { cert: readFileSync(process.env.PORTAL_TLS_CERT), key: readFileSync(process.env.PORTAL_TLS_KEY!) }
    : undefined,
  log: (line) => logger.info(line),
});
if (process.env.MORPHIX_PORTAL !== "0") await portal.start();
app.on("before-quit", () => void portal.stop());
```

Suggested mapping to the existing services:

| Backend method | Use |
|---|---|
| `me` | `AiStatus.dailyLimit - usedToday` → `generationsLeftToday`. Set `features.camera` from the printer settings. |
| `listProjects` / `getProject` | `MorphixDb` projects and versions. `hasThumbnail` = a thumbnail file exists. |
| `modelFile` / `thumbnailFile` | The version's file path in storage (STL or GLB). |
| `createPhotoRequest` | `packages/photo3d` pipeline (owned by the photo-to-3D session). Return its job id. |
| `createTextRequest` | The same path as a voice "make X" request. It creates the cost `PendingAction` and returns a job id. |
| `pendingActions` / `confirmAction` / `cancelAction` | The existing `PendingAction` queue. Map `credits` to a detail line such as "Uses 20 Meshy credits". Confirm with source `"web"` so the log shows where the yes came from, and show the decision on the kiosk too. |
| `jobEvents` | `GenerationProgress` events and the `packages/jobs` progress model. Use `packages/errors` codes for `error.code` and `error.hint`. |
| `printerStatus` | `PrinterObserver` status, plus `controlsEnabled = settings.printControlsEnabled` and `cameraAvailable`. |
| `printerCommand` | `QD330Controller` (pause, resume, cancel), plus the extra controls from the printer-control session (light, fan, home, temperatures). Keep honouring `MORPHIX_PRINT_CONTROLS`: return `{ ok: false, message }` while it is off. |
| `cameraStream` | `httpCameraSource("http://192.168.10.51:8080/?action=stream")` |

Print confirmations: the portal lets only admins confirm actions of kind `"print"`. Minting `authorizePrint(...)` stays in the main process, after the confirmation comes back through `confirmAction`, exactly as it does for touch and voice.

## HTTP API

Every `/api/*` route needs a signed-in session. Without one it returns 401 `{ error: "login_required" }`.

Every state-changing request (POST) also needs the header `X-CSRF-Token: <csrfToken from /api/me>`.

Errors are returned as JSON: `{ error: "<code>", message: "<friendly text>" }`.

| Method & path | What |
|---|---|
| `GET /login` | Starts the Auth0 sign-in (302) and sets the signed `mx_login` cookie with state, nonce and PKCE verifier. |
| `GET /callback` | Auth0 returns here. The portal checks the state, exchanges the code, verifies the ID token, checks the allow-list, sets `mx_session` and redirects to `/`. |
| `POST /logout` | Needs CSRF. Revokes the session, clears the cookie and returns `{ url }` (Auth0 `/v2/logout`) for the browser to open. |
| `GET /api/me` | `{ user: { email, name, picture, isAdmin }, csrfToken, ...PortalMe }` |
| `GET /api/projects` | `{ projects: PortalProject[] }` |
| `GET /api/projects/:id` | `{ project: PortalProjectDetail }` |
| `GET /api/models/:versionId` | The STL or GLB file (`model/stl`, `model/gltf-binary`). |
| `GET /api/thumbnails/:versionId` | The thumbnail image, if the backend implements `thumbnailFile`. |
| `POST /api/requests` | `multipart/form-data` with fields `images` (×≤6), `scan` (≤1), `description`, `measurements` (JSON), `referenceObject`. Returns 202 `{ jobId }`. |
| `POST /api/text-requests` | JSON `{ prompt }` (≤1000 characters). Returns 202 `{ jobId }`. |
| `GET /api/actions` | `{ actions: PortalAction[] }` |
| `POST /api/actions/:id/confirm` · `/cancel` | `ActionResult`. Print confirmations are admin-only. |
| `GET /api/jobs/:id/events` | Server-Sent Events. Each `event: job` carries a `data: JobEvent`. A `: ping` is sent every 15 s. |
| `GET /api/printer` | `{ printer: PortalPrinterStatus }` |
| `POST /api/printer/command` | Admin only. JSON `{ cmd, args }`. Returns `ActionResult`. |
| `GET /api/camera` | MJPEG proxy (`multipart/x-mixed-replace`). At most 3 viewers at once. |
| `GET /healthz` | `{ ok: true }` |
| `GET /`, `/static/*`, `/vendor/three/*`, `/vendor/three-addons/*` | Front-end files. These contain no data, so no login is needed. |

## Security model

**Who can get in**
- Only people who complete an Auth0 sign-in, have a **verified** e-mail, and whose e-mail is in `AUTH0_ALLOWED_EMAILS` or `AUTH0_ADMIN_EMAILS`. The list is checked again on every request, so removing someone and restarting signs them out.
- An empty list means nobody gets in.
- Printer commands and print confirmations need `AUTH0_ADMIN_EMAILS`. Admin status is never taken from the browser.

**OIDC (Auth0 sign-in)**
- Authorization Code flow with **PKCE (S256)**, a random **state** and a random **nonce**. These are kept in a signed, HttpOnly, 10-minute `mx_login` cookie.
- The code is exchanged server-side with the client secret.
- The ID token must pass all of these checks:
  - signed **RS256** by a key in the tenant's JWKS (keys cached for 1 h, refetched on an unknown `kid` at most every 30 s)
  - `iss` = the discovery issuer, which must equal `https://AUTH0_DOMAIN/`
  - `aud` contains the client ID (and `azp` matches when there are several audiences)
  - `exp` and `iat` within 60 s of clock skew
  - `nonce` matches
- `alg: none`, HS256 and unknown keys are rejected.

**Sessions**
- Stateless cookie `mx_session`, HMAC-SHA256 signed with a key derived (HKDF) from `PORTAL_SESSION_SECRET`.
- `HttpOnly; SameSite=Lax`, plus `Secure` when using TLS or an `https://` base URL. Lifetime is 12 h by default.
- The login cookie and the session cookie use separate keys, so one can't be passed off as the other.
- Logout revokes the session id in memory, so even a copied cookie stops working.

**CSRF protection**
- Every POST needs the per-session `X-CSRF-Token`.
- A cross-site `Origin` or `Sec-Fetch-Site` header is refused.
- `SameSite=Lax` adds a second layer of protection.

**Uploads**
- Streaming parser with hard limits, enforced while reading:
  - 6 photos of at most 15 MB each
  - 1 scan of at most 100 MB
  - text fields of at most 8 KB
  - 14 parts and 8 KB of part headers
  - about 192 MB in total
  - `Content-Length` checked up front
- File types are detected from content, never from the browser's type or file name. File names are cleaned and used for display only.
- Scans are written to `<storageRoot>/portal/uploads` with mode 0600 and deleted afterwards.
- Unknown fields are rejected.
- At most 2 uploads run at the same time.

**Rate limits** (in memory)

| What | Limit |
|---|---|
| Sign-in | 10 per minute per IP |
| Uploads and text requests | 10 per 10 minutes per user and per IP |
| API | 300 per minute per user |
| Printer commands | 30 per minute |
| SSE streams | 40 open at once |

**Files and paths**
- URL paths containing `..`, `.`, NUL or backslashes, encoded or not, are rejected.
- Static files are resolved with `realpath` and must stay inside `web/` or the three.js folders.
- Model and thumbnail files from the backend must resolve (after symlinks) inside `storageRoot` and have the expected extension.

**Headers**
- CSP: `default-src 'self'`, no inline scripts except the import map (allowed by its SHA-256 hash), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, and HSTS when using TLS.

**Camera**
- The printer's MJPEG camera (`http://192.168.10.51:8080`) has **no authentication of its own**. The portal never sends that address to the browser.
- `/api/camera` is a server-side proxy that requires a session. It allows at most 3 viewers, and the upstream connection closes when the viewer leaves.

**Logs**
- Tokens, codes, cookies and secrets are never logged.
- Sign-in failures are logged with a reason (`bad_nonce`, `expired`, …).
- Internal errors reach the browser only as "Something went wrong".

**Network**
- Expose port 8443 on the home LAN only. Never forward it on the router.

## Tests

`tests/portal-*.test.ts` (72 tests) run against a local fake OIDC server with freshly generated RSA keys:

- **Sign-in:** valid login, bad state, missing login cookie, bad nonce, expired token, wrong audience, wrong issuer, foreign signing key, `alg: none` / HS256, e-mail not on the list, unverified e-mail, JWKS caching
- **Sessions:** logout revocation, tampered or cross-purpose cookies, rate limits
- **Uploads:** multipart edge cases (byte-by-byte chunks, split boundaries, truncation, size and part limits, RFC 5987 names), magic-byte sniffing
- **API:** CSRF, admin gating, SSE progress / errors / heartbeat / unsubscribe, camera proxy login and viewer limit, traversal attempts and symlink escapes, hidden internal errors
