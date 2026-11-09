# Morphix Remote

Morphix Remote is the phone UI for the existing Morphix process. The Vercel deployment contains only the React UI. Gemini, Meshy, models, SQLite, slicing, QD330 control, camera access, and AI Print Guardian remain on the Raspberry Pi.

## Security design

```
phone browser -> Vercel static UI -> HTTPS hostname -> Cloudflare Tunnel (outbound) -> 127.0.0.1:8787 -> Morphix
```

- The Pi and QD330 have no inbound router port and no public IP exposure.
- `cloudflared` creates the outbound tunnel. The API itself listens on loopback only.
- The API accepts only exact origins in `MORPHIX_REMOTE_ORIGINS`; there is no wildcard CORS.
- The Pi displays a one-time QR link. Its embedded secret expires after 24 hours, rotates after every successful pairing, and is rate-limited. Nothing is typed on the phone.
- Device tokens are 256-bit random values. Only their SHA-256 hashes are stored on the Pi.
- Optional "Sign in with Auth0" (section 5) issues the same kind of device token, only for verified e-mails on the Pi's allow list. The phone uses Authorization Code + PKCE (no client secret in the browser); the Pi checks the ID token's RS256 signature against the tenant JWKS, issuer, audience, expiry and a one-time nonce it handed out itself.
- Model and camera responses require the paired-device bearer token and are never stored by Vercel.
- Starting a print still requires the existing explicit `PendingAction` approval. Print controls still respect `MORPHIX_PRINT_CONTROLS`, `MORPHIX_GX_VERIFIED`, command verification, and printer acknowledgement.

## 1. Run this branch on the Pi

The normal `main` auto-deployment is intentionally untouched. On the Pi, make a separate checkout or switch the Morphix checkout only when you are ready to run the remote branch:

```bash
cd ~/3D-AI-PRINT
git fetch origin
git switch morphix-remote
git pull --ff-only origin morphix-remote
npm ci
npm test
npm run build
```

Add this to `~/Morphix/config/morphix.env`:

```ini
MORPHIX_REMOTE=1
MORPHIX_REMOTE_HOST=127.0.0.1
MORPHIX_REMOTE_PORT=8787
MORPHIX_REMOTE_ORIGINS=https://YOUR-VERCEL-PROJECT.vercel.app
MORPHIX_REMOTE_SITE_URL=https://YOUR-VERCEL-PROJECT.vercel.app
```

Keep the existing Gemini, Meshy, printer, slicer, and Guardian variables unchanged. Restart:

```bash
systemctl --user restart morphix
journalctl --user -u morphix -n 100 --no-pager
curl http://127.0.0.1:8787/api/health
```

The health response should say `{"ok":true,"service":"Morphix Remote"}`.

## 2. Create the outbound Cloudflare Tunnel

A Cloudflare account and a domain using Cloudflare DNS are required for a public HTTPS hostname. In the Cloudflare dashboard:

1. Open **Networking -> Tunnels**, select **Create Tunnel**, choose `cloudflared`, and name it `morphix-remote`.
2. Choose the Pi's Linux architecture and run the installation command shown by Cloudflare. For a remotely managed tunnel it has the form:

   ```bash
   sudo cloudflared service install YOUR_TUNNEL_TOKEN
   ```

3. Add a **Published application** with a hostname such as `morphix-api.example.com`.
4. Set **Service type** to `HTTP` and **URL** to `127.0.0.1:8787`.
5. Save it and confirm the tunnel is Healthy. Do not add a router port-forward.

Verify from another network:

```bash
curl https://morphix-api.example.com/api/health
```

Only `/api/health` and pairing are usable without a device token. The tunnel token is a secret; do not put it in Git or the Morphix env file.

## 3. Deploy the phone UI from `morphix-remote`

1. In Vercel choose **Add New -> Project**, import `isaiahboffill2010-hue/3D-AI-PRINT`, and select the `morphix-remote` branch for the production deployment.
2. Leave **Root Directory** at the repository root. Vercel projects cannot read above a configured subdirectory; the root-level `vercel.json` already builds only `apps/remote`.
3. The detected settings should be:
   - Framework: Vite
   - Install: `npm ci`
   - Build: `npm run build:remote`
   - Output: `apps/remote/dist`
4. Add a Production environment variable:

   ```text
   VITE_MORPHIX_REMOTE_URL=https://3daimodel-morphix.taila52865.ts.net

## Smart Model Search ("open source")

Runs on the Pi (`packages/model-search`, `apps/desktop/electron/library-import.ts`) and searches **Thingiverse only** (no GitHub). Two modes:

- **No token (default):** Gemini names Thingiverse designs it knows (a few seconds), Morphix opens each page to confirm it's real and takes the title and picture from the page; only if fewer than two are found does Gemini search the web (about a minute). Thingiverse only gives files to apps with a token, so these cards show a QR code / link to download the design on your phone.
- **With `THINGIVERSE_TOKEN`:** Thingiverse's own search API (about a second), then the licence, file list and picture of the top hits in parallel; the first 4 downloadable designs show as soon as they're ready, and "Choose this one" downloads every part to the Pi.
- **Real results only.** Only designs with STL/3MF files Morphix can download are offered. The licence comes from Thingiverse's API; "printed by others" uses Thingiverse's own make/like counts; hardware to buy (bearings, screws, magnets…) is read from the description.
- **One tap.** "Choose this one" (or saying the number) downloads every part (a few at a time) and opens the model page. Every part keeps its exact size and is laid out on build plates.
- **Safety.** Searching spends no Meshy credits; importing never slices or prints.

```env
# in ~/Morphix/config/morphix.env (Thingiverse → Developers → Create an app → App Token)
THINGIVERSE_TOKEN=your_thingiverse_app_token
```

## 4. Pair the phone

On the Pi touchscreen, open **Settings -> Morphix Remote**. Scan the displayed QR with the phone camera. The Vercel app opens, exchanges the one-time link for a private device key, removes the secret from the address bar, and connects automatically. There is no account, password, or code entry.

The QR rotates immediately after a successful pairing. Refresh Settings to show the QR for another phone. To revoke the current phone, choose **Device** in the app; to revoke every phone, stop Morphix, remove only `~/Morphix/remote/devices.json`, and restart Morphix.

## 5. Sign in with Auth0 (optional)

A phone can also connect by signing in with Auth0 on the **Connect your phone** page instead of scanning the QR. QR pairing keeps working exactly as before. The button only appears when the Vercel build has the `VITE_AUTH0_*` variables, and the Pi refuses everyone until its allow list is set.

How it works: the phone asks the Pi for a one-time nonce (`POST /api/pair/auth0/start`, valid 10 minutes), signs in through Auth0 Universal Login with Authorization Code + PKCE, exchanges the code for an ID token directly with Auth0, and sends the ID token to `POST /api/pair/auth0`. The Pi verifies the RS256 signature against `https://AUTH0_DOMAIN/.well-known/jwks.json`, the issuer `https://AUTH0_DOMAIN/`, the audience (the phone's client ID), expiry, the nonce (single use), `email_verified`, and the allow list. Only then does it create a normal device key. ID tokens are never stored or logged; the Pi logs only the signed-in e-mail or the refusal code.

### Auth0 dashboard

1. **Applications -> Applications -> Create Application**, name it `Morphix Remote (phone)`, type **Single Page Web Applications**. This must be a separate application from the web portal's Regular Web Application (docs/PORTAL.md): the phone has no client secret.
2. In its **Settings** (replace the origin with your Vercel production origin, no trailing slash except where shown):
   - **Allowed Callback URLs:** `https://app-two-gray-24.vercel.app/` (add `http://localhost:5174/` if you test with `npm run dev:remote`)
   - **Allowed Logout URLs:** `https://app-two-gray-24.vercel.app/` (not used yet; harmless to set)
   - **Allowed Web Origins:** `https://app-two-gray-24.vercel.app` (needed for the code exchange from the browser)
   - **Allowed Origins (CORS):** `https://app-two-gray-24.vercel.app`
3. **Advanced Settings -> Grant Types:** keep **Authorization Code** ticked. Implicit and Client Credentials are not needed. **Credentials -> Authentication Method** stays **None**.
4. **Connections:** enable the logins you want (e.g. Google, or Username-Password with e-mail verification). Accounts whose e-mail is not verified are refused with `MX-AUTH-007`.
5. Copy the **Domain** and **Client ID**. Neither is a secret, but keep them out of Git anyway; set them only in Vercel and in `morphix.env`.

### Vercel (phone UI)

Under **Settings -> Environment Variables** (Production), then redeploy (Vite bakes them in at build time):

```text
VITE_AUTH0_DOMAIN=your-tenant.us.auth0.com
VITE_AUTH0_CLIENT_ID=<the phone SPA's Client ID>
# optional, only if you use an Auth0 API: VITE_AUTH0_AUDIENCE=https://your-api-identifier
```

### Pi (`~/Morphix/config/morphix.env`)

```ini
AUTH0_DOMAIN=your-tenant.us.auth0.com          # same tenant as the portal, if you use it
MORPHIX_REMOTE_AUTH0_CLIENT_ID=<the phone SPA's Client ID>
AUTH0_ALLOWED_EMAILS=you@example.com,parent@example.com
```

`AUTH0_CLIENT_ID` stays the web portal's own client ID; the phone uses `MORPHIX_REMOTE_AUTH0_CLIENT_ID`. Addresses in `AUTH0_ADMIN_EMAILS` may sign in too, as in the portal. An empty allow list refuses everyone. Restart Morphix after editing (`systemctl --user restart morphix`).

### What the phone shows when sign-in is refused

| Code | When |
| --- | --- |
| `MX-AUTH-001` | Token signature, issuer, audience or format is wrong |
| `MX-AUTH-002` | The ID token has expired |
| `MX-AUTH-003` | The e-mail is not on the allow list (the Pi log names it) |
| `MX-AUTH-004` | `AUTH0_DOMAIN` or `MORPHIX_REMOTE_AUTH0_CLIENT_ID` is missing on the Pi |
| `MX-AUTH-005` | The Pi could not reach Auth0 |
| `MX-AUTH-006` | The nonce is unknown, expired (over 10 minutes) or already used; sign in again |
| `MX-AUTH-007` | The account's e-mail is not verified |

After 8 refusals in 10 minutes the Pi answers `429` for a while. Revoking a phone works the same as for QR-paired phones (section 4); `devices.json` records the signed-in e-mail as `account`.

## Safe acceptance check

1. Leave `MORPHIX_PRINT_CONTROLS` unchanged while testing.
2. Pair the phone and confirm Pi/printer status loads.
3. Send a Gemini chat message that does not request generation.
4. Upload a photo and check that the Meshy credit approval appears before generation begins.
5. Approve generation, preview the GLB/STL, set a size, and prepare it.
6. Confirm that the final print action waits for a separate explicit approval.
7. Test Pause/Resume/Stop only during a supervised test print and only if those controls were already verified under `docs/PHASE5.md`.

Automated tests never confirm a print, call Meshy, or contact the QD330.
