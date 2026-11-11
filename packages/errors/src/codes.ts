// The Morphix error-code registry. Every user-visible failure has one code
// `MX-<AREA>-<nnn>` with a kid-friendly title, a simple "what to try" hint and a
// technical description for logs and docs/ERRORS.md (generated from this file).
// Codes are never renumbered or reused: retire a code by leaving it in place.

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export const ERROR_AREAS = {
  VOICE: { name: "Voice assistant", owner: "apps/desktop (voice), packages/gemini" },
  GEN: { name: "Model generation (Gemini understanding, Meshy, OpenSCAD)", owner: "packages/meshy, packages/gemini" },
  P3D: { name: "Photo to 3D (reserved)", owner: "packages/photo3d registers its own codes with registerErrorCodes()" },
  SLICE: { name: "Print preparation and slicing", owner: "packages/slicing" },
  PRINT: { name: "Printer connection and control", owner: "packages/printer" },
  GUARD: { name: "AI Print Guardian (camera and failure detection)", owner: "packages/guardian" },
  NET: { name: "Network and internet", owner: "packages/network" },
  STORE: { name: "Storage, files and database", owner: "packages/storage, packages/database" },
  AUTH: { name: "Sign-in", owner: "packages/portal" },
  PORTAL: { name: "Web portal", owner: "packages/portal" },
  SYS: { name: "System and app", owner: "apps/desktop" },
} as const;

export type ErrorArea = keyof typeof ERROR_AREAS;

export interface ErrorCodeEntry {
  /** `MX-<AREA>-<nnn>`. */
  code: string;
  area: ErrorArea;
  /** Short, kid-friendly headline: "The printer isn't answering". */
  title: string;
  /** One simple thing to try, written for a child or a non-technical adult. */
  hint: string;
  /** Technical description for logs, support and docs. */
  description: string;
  severity: ErrorSeverity;
  /** True when trying the same thing again later can succeed without changing anything. */
  retryable: boolean;
}

type Def = [title: string, hint: string, description: string, severity: ErrorSeverity, retryable: boolean];

function area(a: ErrorArea, defs: Record<number, Def>): ErrorCodeEntry[] {
  return Object.entries(defs).map(([n, [title, hint, description, severity, retryable]]) => ({
    code: `MX-${a}-${String(n).padStart(3, "0")}`,
    area: a,
    title,
    hint,
    description,
    severity,
    retryable,
  }));
}

export const CORE_ERROR_CODES: readonly ErrorCodeEntry[] = Object.freeze([
  ...area("VOICE", {
    1: ["I can't hear you", "Check that the microphone is plugged in, then try again.", "No audio input device was found or it could not be opened (ALSA/PipeWire error, device busy or unplugged).", "error", true],
    2: ["I lost my connection to my brain", "Wait a moment and try again. If it keeps happening, check the Wi-Fi.", "The Gemini Live WebSocket failed to connect or closed unexpectedly (network error, server close, or abnormal close code).", "error", true],
    3: ["I didn't understand that", "Try saying it again in a different way, like \"make a small dinosaur\".", "Gemini returned no usable intent or transcript for the request.", "info", true],
    4: ["My voice helper isn't set up", "Ask a grown-up to add the Gemini key in Settings.", "GEMINI_API_KEY is missing, or Gemini rejected it (HTTP 401/403, API_KEY_INVALID).", "error", false],
    5: ["I'm talking too much right now", "Take a short break and try again in a minute.", "Gemini rate limit or quota exceeded (HTTP 429 / RESOURCE_EXHAUSTED).", "warning", true],
    6: ["That recording was too long", "Try a shorter request, under two minutes.", "The recorded audio exceeded the maximum request length.", "warning", false],
  }),
  ...area("GEN", {
    1: ["The model maker isn't set up", "Ask a grown-up to add the Meshy key in Settings.", "MESHY_API_KEY is not configured (MeshyNotConfigured).", "error", false],
    2: ["The model maker didn't accept our key", "Ask a grown-up to check the Meshy key in Settings.", "Meshy answered HTTP 401 Unauthorized: the API key is wrong, revoked or expired.", "error", false],
    3: ["The model maker ran out of credits", "Ask a grown-up to add more Meshy credits.", "Meshy answered HTTP 402 Payment Required: the account has no credits left.", "error", false],
    4: ["The model maker is very busy", "Wait a minute and try again.", "Meshy answered HTTP 429 Too Many Requests (rate limit or too many concurrent tasks).", "warning", true],
    5: ["The model maker couldn't build that", "Try describing it a little differently.", "The Meshy task finished with status FAILED or CANCELED (task_error is in context).", "error", true],
    6: ["Making the model took too long", "Try again, maybe with a simpler idea.", "The generation task did not finish within the polling deadline (20 minutes for Meshy).", "warning", true],
    7: ["The model didn't download", "Check the Wi-Fi and try again.", "Downloading the generated model file failed (HTTP error, connection reset or file too large).", "error", true],
    8: ["The model file is broken", "Try making the model again.", "The model file could not be parsed (MeshFormatError: bad STL/GLB, no triangles, unsupported encoding).", "error", true],
    9: ["I can't make that one", "Try a different idea.", "The request was refused by a content filter (Gemini safety block or Meshy moderation).", "warning", false],
    10: ["I couldn't figure out what to make", "Say it again with a little more detail.", "Gemini text understanding failed (generateContent error, empty or unparseable JSON answer).", "error", true],
    11: ["The shape builder had a problem", "Try again or describe a simpler shape.", "OpenSCAD is not installed, timed out, or failed to render the generated script.", "error", true],
  }),
  ...area("SLICE", {
    1: ["The printer helper program is missing", "Ask a grown-up to install PrusaSlicer.", "No slicer found: PrusaSlicer/OrcaSlicer are not on PATH and MORPHIX_PRUSA_SLICER/MORPHIX_ORCA_SLICER are unset. Install with `sudo apt install prusa-slicer`.", "error", false],
    2: ["The printer settings are missing", "Ask a grown-up to reinstall Morphix.", "config/slicer-profiles was not found (pass profilesDir or set MORPHIX_SLICER_PROFILES).", "error", false],
    3: ["Getting the model ready didn't work", "Try again. If it fails again, try a simpler model.", "The slicer exited with a non-zero code and produced no G-code (log tail in context).", "error", true],
    4: ["Getting ready took too long", "Try a smaller model or try again.", "The slicer was killed after the slicing timeout (default 15 minutes).", "warning", true],
    5: ["The printer file wasn't made", "Try again.", "The slicer exited without writing any G-code to the output directory.", "error", true],
    6: ["That's too big for the printer", "Make it smaller and try again.", "The model exceeds the build volume (220 x 220 x 220 mm, UNVERIFIED) after scaling and orientation.", "warning", false],
    7: ["This model can't be printed", "Try making the model again.", "The mesh has no triangles, non-finite coordinates or zero volume (validation report not printable).", "error", false],
    8: ["The model has small holes", "It will probably still print. If it fails, try making it again.", "The mesh is not watertight after repair; the slicer will attempt its own repair.", "warning", false],
    9: ["The printer file hasn't been checked yet", "A grown-up needs to compare it with the official Afinia file first.", "The .gx layout is UNVERIFIED against official Afinia output (GX_LAYOUT_VERIFIED = false).", "warning", false],
    10: ["The printer file looks wrong", "Try getting it ready again.", "validateGx() reported errors for the generated .gx (header, thumbnail or G-code section).", "error", true],
    11: ["Some tiny parts may not print", "Try making it bigger.", "Features are smaller than the nozzle can reproduce (model or details under ~1 mm at the chosen scale).", "warning", false],
    12: ["I used my usual settings", "Nothing to do. The settings are still safe.", "The AI slicer advisor could not reach Gemini or got an invalid answer; the heuristic advice was used.", "info", true],
  }),
  ...area("PRINT", {
    1: ["The printer isn't answering", "Check the printer is switched on and its cable is plugged in.", "TCP connection to the printer was refused or the host is unreachable (ECONNREFUSED/EHOSTUNREACH/ENETUNREACH on port 8899).", "error", true],
    2: ["The printer is taking too long to answer", "Wait a moment and try again.", "The printer did not reply within the command timeout (PrinterReplyTimeout / ETIMEDOUT).", "warning", true],
    3: ["The printer hung up", "Try again. If it keeps happening, restart the printer.", "The printer closed the TCP connection mid-command (PrinterConnectionClosed / ECONNRESET / EPIPE).", "error", true],
    4: ["Printing is locked", "A grown-up has to switch on print controls in Settings first.", "Printer control is disabled (ControllerDisabledError). It is enabled only after the operator checklist (MORPHIX_PRINT_CONTROLS=1).", "info", false],
    5: ["The printer said no", "Check the printer screen, then try again.", "The controller refused the command (ControlRefusedError: unsafe state, bad file name or missing authorization).", "warning", false],
    6: ["I'm not sure the print started", "Look at the printer. If it isn't printing, try starting again.", "The start command was sent but the printer never reported a printing state (start not confirmed).", "error", true],
    7: ["I'm not sure the printer paused", "Look at the printer and press pause on it if it's still moving.", "The pause command was sent but the printer never reported a paused state (pause not confirmed).", "critical", true],
    8: ["The file didn't reach the printer", "Try sending it again.", "Uploading the .gx to the printer failed or was not confirmed (M28/M29 transfer error).", "error", true],
    9: ["The printer is busy", "Wait until the current print finishes.", "The printer is already printing or is in a state that does not accept new jobs.", "warning", true],
    10: ["The printer has a problem", "Look at the printer screen for a message.", "The printer reported an error state (M119/M27 status) or an unknown status string.", "error", false],
    11: ["The printer file hasn't been checked yet", "A grown-up needs to verify the printer file first.", "Sending is blocked: the .gx layout is unverified (set MORPHIX_GX_VERIFIED=1 only after comparing with official output).", "warning", false],
    12: ["I need your OK first", "Tap \"Print\" or say \"yes\" to start.", "No valid print authorization: the user has not confirmed, or the authorization expired or was for a different file.", "info", false],
    13: ["This print isn't ready yet", "Get the model ready for printing first.", "The model has not been prepared, or its preparation result has no valid .gx.", "warning", false],
  }),
  ...area("GUARD", {
    1: ["I lost the camera", "Check the camera cable, then try again.", "The camera stream stopped (device unplugged, read error, or the vision worker reported camera_lost).", "error", true],
    2: ["I can't find the camera", "Check the camera is plugged in.", "No camera device could be opened at start-up.", "warning", true],
    3: ["My print watcher stopped", "Morphix will try to restart it. If it doesn't, restart Morphix.", "The Python vision worker exited or stopped sending heartbeats.", "error", true],
    4: ["The print might be going wrong", "Look at the printer. If it's a mess of strings, stop the print.", "Local detector reported probable spaghetti / stringing (confirmed over several frames).", "warning", false],
    5: ["The print might have come loose", "Look at the printer. If the model moved, stop the print.", "Local detector reported probable detachment from the bed.", "warning", false],
    6: ["I couldn't double-check with my AI eyes", "Nothing to do. I'm still watching.", "Gemini visual verification was unavailable (no key, rate limit, daily cap or HTTP error).", "info", true],
    7: ["I couldn't pause the printer", "Press pause on the printer right now.", "The guardian asked for a pause but it was refused or not confirmed by the printer.", "critical", true],
  }),
  ...area("NET", {
    1: ["I can't reach the internet", "Check the Wi-Fi in Settings.", "Outbound connection failed (ENETUNREACH/ECONNREFUSED/ECONNRESET or fetch failed) to a cloud service.", "error", true],
    2: ["I can't find that website", "Check the Wi-Fi, then try again.", "DNS lookup failed (ENOTFOUND/EAI_AGAIN).", "error", true],
    3: ["The internet is too slow right now", "Try again in a moment.", "A network request timed out (ETIMEDOUT/UND_ERR_CONNECT_TIMEOUT/AbortSignal.timeout).", "warning", true],
    4: ["Wi-Fi isn't connected", "Pick a Wi-Fi network in Settings.", "NetworkManager reports no active Wi-Fi connection.", "error", true],
    5: ["A helper website is having trouble", "Try again in a few minutes.", "A cloud service answered with HTTP 5xx.", "warning", true],
    6: ["The connection isn't safe", "Check the date and time on the Morphix machine, then try again.", "TLS failure (certificate expired/invalid, often caused by a wrong system clock).", "error", true],
  }),
  ...area("STORE", {
    1: ["I'm out of space", "Ask a grown-up to delete some old models.", "The disk is full (ENOSPC).", "critical", false],
    2: ["I can't find that file", "Try making or downloading it again.", "File or directory not found (ENOENT).", "error", false],
    3: ["I'm not allowed to open that file", "Ask a grown-up to check the Morphix folder permissions.", "Permission denied (EACCES/EPERM).", "error", false],
    4: ["My memory book has a problem", "Restart Morphix. If it keeps happening, ask a grown-up.", "The SQLite database failed to open, read or write (corrupt file or SQL error).", "critical", false],
    5: ["I can't save anything right now", "Restart the Morphix machine. If it keeps happening, its disk or SD card may be failing.", "The file system is read-only (EROFS).", "critical", false],
  }),
  ...area("AUTH", {
    1: ["Signing in didn't work", "Try signing in again.", "The sign-in flow failed (callback error, invalid_grant, or token exchange failed).", "error", true],
    2: ["You've been signed out", "Sign in again.", "The session or access token expired or is invalid (login_required, jwt expired).", "info", false],
    3: ["You're not allowed to do that", "Ask the owner of this Morphix to give you access.", "The sign-in provider or Morphix denied access (access_denied, HTTP 403, missing role or not on the allow list).", "warning", false],
    4: ["Sign-in isn't set up", "Ask a grown-up to set up sign-in in Settings.", "Sign-in is not configured (no admin password or identity provider settings).", "error", false],
    5: ["The sign-in service isn't answering", "Check the internet and try again.", "The sign-in provider could not be reached (network error or HTTP 5xx).", "error", true],
    6: ["Sign-in got mixed up", "Close this page and sign in again.", "OAuth state or nonce mismatch, or a reused callback (possible CSRF or stale tab).", "warning", false],
    7: ["Please check your email first", "Open the email we sent you and tap the link.", "The account email is not verified by the identity provider.", "info", false],
  }),
  ...area("PORTAL", {
    1: ["The web page couldn't start", "Restart Morphix.", "The portal HTTP server failed to start (EADDRINUSE or bind error).", "error", true],
    2: ["Morphix isn't online", "Check that Morphix is switched on and connected to Wi-Fi.", "The portal cannot reach the Morphix device (not linked, offline, or relay unavailable).", "warning", true],
    3: ["That request didn't make sense", "Refresh the page and try again.", "The portal rejected a malformed or invalid request (HTTP 400).", "warning", false],
  }),
  ...area("SYS", {
    1: ["Something went wrong", "Try again. If it keeps happening, restart Morphix.", "Unexpected error with no more specific code (see cause and context).", "error", true],
    2: ["A setting is missing", "Ask a grown-up to check Settings.", "Required configuration is missing or invalid.", "error", false],
    3: ["I'm out of breath", "Close other things and try again, or restart Morphix.", "Out of memory (ENOMEM, heap limit or worker killed).", "critical", true],
    4: ["Stopped", "Nothing to do. You can start again any time.", "The operation was cancelled by the user or the app (AbortError).", "info", true],
    5: ["I can't do that yet", "Try something else.", "The feature is not available on this device or not implemented yet.", "info", false],
    6: ["Morphix restarted while this was running", "Start it again.", "The app restarted while a job stage was running; the stage was marked interrupted on restore.", "warning", true],
    7: ["That took too long", "Try again.", "A generic operation timed out (no more specific code applies).", "warning", true],
  }),
]);
