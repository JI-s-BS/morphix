# Morphix error codes

<!-- GENERATED from packages/errors/src/codes.ts. Do not edit by hand. -->
<!-- Regenerate: MORPHIX_UPDATE_DOCS=1 ./node_modules/.bin/vitest run tests/errors-docs.test.ts -->

Every failure Morphix shows has one code, `MX-<AREA>-<nnn>`. The **title** and **what to try**
columns are shown to users (they are written for kids). The **technical description** is for logs,
support and developers. **Retry** means trying the same thing again later can work without
changing anything. See `packages/errors` for the API (`MorphixError`, `toMorphixError`).

Codes are never renumbered or reused. Add new codes at the end of their area.

## Using it

```ts
import { MorphixError, toMorphixError, userMessage, registerErrorCodes } from "@morphix/errors";

// Throw a specific code (cause and context are optional; context is sanitised).
throw new MorphixError("MX-PRINT-004", { context: { action: "start" } });

// Convert anything thrown. The fallback code's area picks the service, so ECONNREFUSED
// becomes MX-PRINT-001 for printer calls and MX-NET-001 for cloud calls.
try { await controller.startPrint({ jobId, fileName, authorization }); }
catch (e) { const err = toMorphixError(e, "MX-PRINT-006"); log.error(err.code, err.message); }

// Or name the service explicitly: "printer" | "meshy" | "gemini" | "gemini-live" | "auth0" |
// "camera" | "slicer" | "openscad" | "storage" | "network" | "portal"
toMorphixError(e, "MX-GEN-010", { service: "gemini", context: { jobId } });

// Over IPC / HTTP send err.toJSON() (JSON.stringify does it automatically);
// toMorphixError(json) or MorphixError.fromJSON(json) turns it back into an error.
// Show users userMessage(err): "<title>. <hint>".

// packages/photo3d, once at start-up:
registerErrorCodes([{ code: "MX-P3D-001", title: "…", hint: "…", description: "…",
  severity: "warning", retryable: true }], { owner: "packages/photo3d" });
```

Wire form (`SerializedMorphixError`): `{ name: "MorphixError", code, area, title, hint, message,
severity, retryable, at, context?, cause? }`. Secrets (keys named like token/apiKey/password,
bearer tokens, `?key=` query values) are redacted from context and causes.

## Areas

| Area | What | Owner |
| --- | --- | --- |
| `VOICE` | Voice assistant | apps/desktop (voice), packages/gemini |
| `GEN` | Model generation (Gemini understanding, Meshy, OpenSCAD) | packages/meshy, packages/gemini |
| `P3D` | Photo to 3D (reserved) | packages/photo3d registers its own codes with registerErrorCodes() |
| `SLICE` | Print preparation and slicing | packages/slicing |
| `PRINT` | Printer connection and control | packages/printer |
| `GUARD` | AI Print Guardian (camera and failure detection) | packages/guardian |
| `NET` | Network and internet | packages/network |
| `STORE` | Storage, files and database | packages/storage, packages/database |
| `AUTH` | Sign-in (Auth0) | packages/portal |
| `PORTAL` | Web portal | packages/portal |
| `SYS` | System and app | apps/desktop |

`MX-P3D-*` is reserved for `packages/photo3d`, which registers its own codes at start-up with
`registerErrorCodes([...], { owner: "packages/photo3d" })` and documents them in its own docs.

## VOICE: Voice assistant

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-VOICE-001` | I can't hear you | Check that the microphone is plugged in, then try again. | No audio input device was found or it could not be opened (ALSA/PipeWire error, device busy or unplugged). | error | yes |
| `MX-VOICE-002` | I lost my connection to my brain | Wait a moment and try again. If it keeps happening, check the Wi-Fi. | The Gemini Live WebSocket failed to connect or closed unexpectedly (network error, server close, or abnormal close code). | error | yes |
| `MX-VOICE-003` | I didn't understand that | Try saying it again in a different way, like "make a small dinosaur". | Gemini returned no usable intent or transcript for the request. | info | yes |
| `MX-VOICE-004` | My voice helper isn't set up | Ask a grown-up to add the Gemini key in Settings. | GEMINI_API_KEY is missing, or Gemini rejected it (HTTP 401/403, API_KEY_INVALID). | error | no |
| `MX-VOICE-005` | I'm talking too much right now | Take a short break and try again in a minute. | Gemini rate limit or quota exceeded (HTTP 429 / RESOURCE_EXHAUSTED). | warning | yes |
| `MX-VOICE-006` | That recording was too long | Try a shorter request, under two minutes. | The recorded audio exceeded the maximum request length. | warning | no |

## GEN: Model generation (Gemini understanding, Meshy, OpenSCAD)

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-GEN-001` | The model maker isn't set up | Ask a grown-up to add the Meshy key in Settings. | MESHY_API_KEY is not configured (MeshyNotConfigured). | error | no |
| `MX-GEN-002` | The model maker didn't accept our key | Ask a grown-up to check the Meshy key in Settings. | Meshy answered HTTP 401 Unauthorized: the API key is wrong, revoked or expired. | error | no |
| `MX-GEN-003` | The model maker ran out of credits | Ask a grown-up to add more Meshy credits. | Meshy answered HTTP 402 Payment Required: the account has no credits left. | error | no |
| `MX-GEN-004` | The model maker is very busy | Wait a minute and try again. | Meshy answered HTTP 429 Too Many Requests (rate limit or too many concurrent tasks). | warning | yes |
| `MX-GEN-005` | The model maker couldn't build that | Try describing it a little differently. | The Meshy task finished with status FAILED or CANCELED (task_error is in context). | error | yes |
| `MX-GEN-006` | Making the model took too long | Try again, maybe with a simpler idea. | The generation task did not finish within the polling deadline (20 minutes for Meshy). | warning | yes |
| `MX-GEN-007` | The model didn't download | Check the Wi-Fi and try again. | Downloading the generated model file failed (HTTP error, connection reset or file too large). | error | yes |
| `MX-GEN-008` | The model file is broken | Try making the model again. | The model file could not be parsed (MeshFormatError: bad STL/GLB, no triangles, unsupported encoding). | error | yes |
| `MX-GEN-009` | I can't make that one | Try a different idea. | The request was refused by a content filter (Gemini safety block or Meshy moderation). | warning | no |
| `MX-GEN-010` | I couldn't figure out what to make | Say it again with a little more detail. | Gemini text understanding failed (generateContent error, empty or unparseable JSON answer). | error | yes |
| `MX-GEN-011` | The shape builder had a problem | Try again or describe a simpler shape. | OpenSCAD is not installed, timed out, or failed to render the generated script. | error | yes |

## SLICE: Print preparation and slicing

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-SLICE-001` | The printer helper program is missing | Ask a grown-up to install PrusaSlicer. | No slicer found: PrusaSlicer/OrcaSlicer are not on PATH and MORPHIX_PRUSA_SLICER/MORPHIX_ORCA_SLICER are unset. Install with `sudo apt install prusa-slicer`. | error | no |
| `MX-SLICE-002` | The printer settings are missing | Ask a grown-up to reinstall Morphix. | config/slicer-profiles was not found (pass profilesDir or set MORPHIX_SLICER_PROFILES). | error | no |
| `MX-SLICE-003` | Getting the model ready didn't work | Try again. If it fails again, try a simpler model. | The slicer exited with a non-zero code and produced no G-code (log tail in context). | error | yes |
| `MX-SLICE-004` | Getting ready took too long | Try a smaller model or try again. | The slicer was killed after the slicing timeout (default 15 minutes on a Pi 4). | warning | yes |
| `MX-SLICE-005` | The printer file wasn't made | Try again. | The slicer exited without writing any G-code to the output directory. | error | yes |
| `MX-SLICE-006` | That's too big for the printer | Make it smaller and try again. | The model exceeds the build volume (220 x 220 x 220 mm, UNVERIFIED) after scaling and orientation. | warning | no |
| `MX-SLICE-007` | This model can't be printed | Try making the model again. | The mesh has no triangles, non-finite coordinates or zero volume (validation report not printable). | error | no |
| `MX-SLICE-008` | The model has small holes | It will probably still print. If it fails, try making it again. | The mesh is not watertight after repair; the slicer will attempt its own repair. | warning | no |
| `MX-SLICE-009` | The printer file hasn't been checked yet | A grown-up needs to compare it with the official Afinia file first. | The .gx layout is UNVERIFIED against official Afinia output (GX_LAYOUT_VERIFIED = false). | warning | no |
| `MX-SLICE-010` | The printer file looks wrong | Try getting it ready again. | validateGx() reported errors for the generated .gx (header, thumbnail or G-code section). | error | yes |
| `MX-SLICE-011` | Some tiny parts may not print | Try making it bigger. | Features are smaller than the nozzle can reproduce (model or details under ~1 mm at the chosen scale). | warning | no |
| `MX-SLICE-012` | I used my usual settings | Nothing to do. The settings are still safe. | The AI slicer advisor could not reach Gemini or got an invalid answer; the heuristic advice was used. | info | yes |

## PRINT: Printer connection and control

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-PRINT-001` | The printer isn't answering | Check the printer is switched on and its cable is plugged in. | TCP connection to the printer was refused or the host is unreachable (ECONNREFUSED/EHOSTUNREACH/ENETUNREACH on port 8899). | error | yes |
| `MX-PRINT-002` | The printer is taking too long to answer | Wait a moment and try again. | The printer did not reply within the command timeout (PrinterReplyTimeout / ETIMEDOUT). | warning | yes |
| `MX-PRINT-003` | The printer hung up | Try again. If it keeps happening, restart the printer. | The printer closed the TCP connection mid-command (PrinterConnectionClosed / ECONNRESET / EPIPE). | error | yes |
| `MX-PRINT-004` | Printing is locked | A grown-up has to switch on print controls in Settings first. | Printer control is disabled (ControllerDisabledError). It is enabled only after the operator checklist (MORPHIX_PRINT_CONTROLS=1). | info | no |
| `MX-PRINT-005` | The printer said no | Check the printer screen, then try again. | The controller refused the command (ControlRefusedError: unsafe state, bad file name or missing authorization). | warning | no |
| `MX-PRINT-006` | I'm not sure the print started | Look at the printer. If it isn't printing, try starting again. | The start command was sent but the printer never reported a printing state (start not confirmed). | error | yes |
| `MX-PRINT-007` | I'm not sure the printer paused | Look at the printer and press pause on it if it's still moving. | The pause command was sent but the printer never reported a paused state (pause not confirmed). | **critical** | yes |
| `MX-PRINT-008` | The file didn't reach the printer | Try sending it again. | Uploading the .gx to the printer failed or was not confirmed (M28/M29 transfer error). | error | yes |
| `MX-PRINT-009` | The printer is busy | Wait until the current print finishes. | The printer is already printing or is in a state that does not accept new jobs. | warning | yes |
| `MX-PRINT-010` | The printer has a problem | Look at the printer screen for a message. | The printer reported an error state (M119/M27 status) or an unknown status string. | error | no |
| `MX-PRINT-011` | The printer file hasn't been checked yet | A grown-up needs to verify the printer file first. | Sending is blocked: the .gx layout is unverified (set MORPHIX_GX_VERIFIED=1 only after comparing with official output). | warning | no |
| `MX-PRINT-012` | I need your OK first | Tap "Print" or say "yes" to start. | No valid print authorization: the user has not confirmed, or the authorization expired or was for a different file. | info | no |
| `MX-PRINT-013` | This print isn't ready yet | Get the model ready for printing first. | The model has not been prepared, or its preparation result has no valid .gx. | warning | no |

## GUARD: AI Print Guardian (camera and failure detection)

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-GUARD-001` | I lost the camera | Check the camera cable, then try again. | The camera stream stopped (device unplugged, read error, or the vision worker reported camera_lost). | error | yes |
| `MX-GUARD-002` | I can't find the camera | Check the camera is plugged in. | No camera device could be opened at start-up. | warning | yes |
| `MX-GUARD-003` | My print watcher stopped | Morphix will try to restart it. If it doesn't, restart Morphix. | The Python vision worker exited or stopped sending heartbeats. | error | yes |
| `MX-GUARD-004` | The print might be going wrong | Look at the printer. If it's a mess of strings, stop the print. | Local detector reported probable spaghetti / stringing (confirmed over several frames). | warning | no |
| `MX-GUARD-005` | The print might have come loose | Look at the printer. If the model moved, stop the print. | Local detector reported probable detachment from the bed. | warning | no |
| `MX-GUARD-006` | I couldn't double-check with my AI eyes | Nothing to do. I'm still watching. | Gemini visual verification was unavailable (no key, rate limit, daily cap or HTTP error). | info | yes |
| `MX-GUARD-007` | I couldn't pause the printer | Press pause on the printer right now. | The guardian asked for a pause but it was refused or not confirmed by the printer. | **critical** | yes |

## NET: Network and internet

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-NET-001` | I can't reach the internet | Check the Wi-Fi in Settings. | Outbound connection failed (ENETUNREACH/ECONNREFUSED/ECONNRESET or fetch failed) to a cloud service. | error | yes |
| `MX-NET-002` | I can't find that website | Check the Wi-Fi, then try again. | DNS lookup failed (ENOTFOUND/EAI_AGAIN). | error | yes |
| `MX-NET-003` | The internet is too slow right now | Try again in a moment. | A network request timed out (ETIMEDOUT/UND_ERR_CONNECT_TIMEOUT/AbortSignal.timeout). | warning | yes |
| `MX-NET-004` | Wi-Fi isn't connected | Pick a Wi-Fi network in Settings. | NetworkManager reports no active Wi-Fi connection. | error | yes |
| `MX-NET-005` | A helper website is having trouble | Try again in a few minutes. | A cloud service answered with HTTP 5xx. | warning | yes |
| `MX-NET-006` | The connection isn't safe | Check the date and time on the Pi, then try again. | TLS failure (certificate expired/invalid, often caused by a wrong system clock). | error | yes |

## STORE: Storage, files and database

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-STORE-001` | I'm out of space | Ask a grown-up to delete some old models. | The disk is full (ENOSPC). | **critical** | no |
| `MX-STORE-002` | I can't find that file | Try making or downloading it again. | File or directory not found (ENOENT). | error | no |
| `MX-STORE-003` | I'm not allowed to open that file | Ask a grown-up to check the Morphix folder permissions. | Permission denied (EACCES/EPERM). | error | no |
| `MX-STORE-004` | My memory book has a problem | Restart Morphix. If it keeps happening, ask a grown-up. | The SQLite database failed to open, read or write (corrupt file or SQL error). | **critical** | no |
| `MX-STORE-005` | I can't save anything right now | Restart the Pi. If it keeps happening, the SD card may be worn out. | The file system is read-only (EROFS). | **critical** | no |

## AUTH: Sign-in (Auth0)

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-AUTH-001` | Signing in didn't work | Try signing in again. | The Auth0 login flow failed (callback error, invalid_grant, or token exchange failed). | error | yes |
| `MX-AUTH-002` | You've been signed out | Sign in again. | The session or access token expired or is invalid (login_required, jwt expired). | info | no |
| `MX-AUTH-003` | You're not allowed to do that | Ask the owner of this Morphix to give you access. | Auth0 or Morphix denied access (access_denied, HTTP 403, missing role or not on the allow list). | warning | no |
| `MX-AUTH-004` | Sign-in isn't set up | Ask a grown-up to set up sign-in in Settings. | Auth0 domain, client ID or secret is not configured. | error | no |
| `MX-AUTH-005` | The sign-in service isn't answering | Check the internet and try again. | Auth0 could not be reached (network error or HTTP 5xx from the tenant). | error | yes |
| `MX-AUTH-006` | Sign-in got mixed up | Close this page and sign in again. | OAuth state or nonce mismatch, or a reused callback (possible CSRF or stale tab). | warning | no |
| `MX-AUTH-007` | Please check your email first | Open the email we sent you and tap the link. | The Auth0 account email is not verified. | info | no |

## PORTAL: Web portal

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-PORTAL-001` | The web page couldn't start | Restart Morphix. | The portal HTTP server failed to start (EADDRINUSE or bind error). | error | yes |
| `MX-PORTAL-002` | Morphix isn't online | Check that Morphix is switched on and connected to Wi-Fi. | The portal cannot reach the Morphix device (not linked, offline, or relay unavailable). | warning | yes |
| `MX-PORTAL-003` | That request didn't make sense | Refresh the page and try again. | The portal rejected a malformed or invalid request (HTTP 400). | warning | no |

## SYS: System and app

| Code | Title (shown to users) | What to try | Technical description | Severity | Retry |
| --- | --- | --- | --- | --- | --- |
| `MX-SYS-001` | Something went wrong | Try again. If it keeps happening, restart Morphix. | Unexpected error with no more specific code (see cause and context). | error | yes |
| `MX-SYS-002` | A setting is missing | Ask a grown-up to check Settings. | Required configuration is missing or invalid (morphix.env). | error | no |
| `MX-SYS-003` | I'm out of breath | Close other things and try again, or restart Morphix. | Out of memory (ENOMEM, heap limit or worker killed). | **critical** | yes |
| `MX-SYS-004` | Stopped | Nothing to do. You can start again any time. | The operation was cancelled by the user or the app (AbortError). | info | yes |
| `MX-SYS-005` | I can't do that yet | Try something else. | The feature is not available on this device or not implemented yet. | info | no |
| `MX-SYS-006` | Morphix restarted while this was running | Start it again. | The app restarted while a job stage was running; the stage was marked interrupted on restore. | warning | yes |
| `MX-SYS-007` | That took too long | Try again. | A generic operation timed out (no more specific code applies). | warning | yes |
