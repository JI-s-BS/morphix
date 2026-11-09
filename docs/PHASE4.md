# Phase 4: AI Print Guardian

The guardian watches the QD330 camera while a print runs. It finds likely
failures with cheap local checks, confirms them over several frames, asks
Gemini for a second look only at a confirmed snapshot, and helps the operator
pause the print. **It never sends commands to the printer, and auto-pause is
off.** A pause is reported as done only after the printer's own status says
`PAUSED`.

```
 QD330 camera ──HTTP snapshot──▶ services/vision (Python, OpenCV)
                                    │ JSON lines (stdout)        ▲ printer state (stdin)
                                    ▼                            │
 Electron main ── @morphix/guardian: VisionWorker ─▶ AlertStateMachine ─▶ GuardianStore (SQLite, Phase 2 db)
        ▲                     │                         │      └─▶ TelemetrySync (Tiger Data, optional)
        │ PrinterObserver     │ confirmed only          └─▶ PauseHook (Phase 5, not wired)
        │ (read-only)         ▼
        │              GeminiVisionClient (rate-limited) ─▶ SwarmsReviewClient (optional) / localReview
        └──── IPC "guardian:update" snapshots ─▶ renderer (Printer page)
```

| Path | What |
|---|---|
| `services/vision/morphix_vision/` | Python worker: `analysis.py` (pure image metrics), `detector.py` (stateful checks + N-of-M confirmation), `worker.py` (poll loop, stdin, evidence), `__main__.py` (CLI) |
| `services/vision/tests/` | pytest with synthetic images (`synth.py`) |
| `packages/guardian/src/events.ts` | Event types, `parseVisionLine`, `LineSplitter` |
| `packages/guardian/src/worker.ts` | `VisionWorker`: spawn, parse, restart with backoff, stdin forwarding |
| `packages/guardian/src/alerts.ts` | `AlertStateMachine`, `STATE_LABELS`, `PauseHook` |
| `packages/guardian/src/gemini.ts` | `GeminiVisionClient` (generateContent, inline JPEG, JSON schema) |
| `packages/guardian/src/cloud.ts` | `SwarmsReviewClient`, `localReview`, `TelemetrySync`, `TIGER_TELEMETRY_SQL` |
| `packages/guardian/src/schema.ts` | Proposed SQLite schema and migrations for `packages/database` |
| `packages/guardian/src/guardian.ts` | `PrintGuardian`, the orchestrator the Electron main process uses |
| `tests/phase4-*.test.ts` | vitest suites (the worker suite spawns a real Node child process; the e2e test needs a real Python) |

## Running it

**Python worker on the Pi:** `sudo apt install -y python3-opencv python3-numpy`
(or a venv, see [services/vision/README.md](../services/vision/README.md)). To try it by hand:

```bash
cd services/vision
python3 -m morphix_vision --snapshot-url 'http://192.168.10.51:8080/?action=snapshot' \
  --interval 10 --evidence-dir ~/Morphix/snapshots/test1
```

**Tests:**

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/vitest run
cd services/vision && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest -q
# optional end-to-end (TS guardian + real Python worker on synthetic frames), from the repo root:
MORPHIX_TEST_PYTHON=$PWD/services/vision/.venv/bin/python ./node_modules/.bin/vitest run tests/phase4-guardian.test.ts
```

### Environment

| Variable | Default | Used by |
|---|---|---|
| `MORPHIX_PYTHON` | `python3` | `VisionWorker` interpreter (set it to a venv python if you use one) |
| `MORPHIX_CAMERA_SNAPSHOT_URL` | `http://192.168.10.51:8080/?action=snapshot` | Python CLI default when `--snapshot-url` isn't given |
| `GEMINI_API_KEY` | none, so verification is "unavailable" | `geminiVisionFromEnv` |
| `MORPHIX_GEMINI_VISION_MODEL` | `gemini-3.8-flash` | Gemini model id ([model list](https://aistudio.google.com/docs/models)); `gemini-3.5-flash-lite` is the cheaper option |
| `MORPHIX_GEMINI_VISION_MIN_INTERVAL_S` | `120` | Minimum gap between Gemini calls |
| `MORPHIX_GEMINI_VISION_DAILY_CAP` | `40` | Gemini calls per UTC day |
| `SWARMS_API_KEY` | none, so the review is local only | `swarmsFromEnv` (`MORPHIX_SWARMS_BASE_URL` overrides the endpoint) |
| `TIGER_DATABASE_URL` | none, so telemetry stays in local memory | `telemetryFromEnv` (also needs an injected sink) |

These are suggested additions for `config/morphix.env.example`. I didn't edit
that file, so it won't conflict with Phase 2.

## Event format (worker → guardian)

Each stdout line is one JSON object. Diagnostics go to stderr, never to
stdout. Every event has this envelope:

```json
{"v":1,"seq":17,"ts":"2026-11-07T06:29:21.288+00:00","session":"guardian-20261107T062900","type":"…", …}
```

`v` is the protocol version (1). `seq` increases by one per line within a
worker run. `ts` is UTC ISO-8601. `session` is the `--session` value.

| `type` | Extra fields | Meaning |
|---|---|---|
| `started` | `pid, snapshot_url, interval, evidence_dir, roi[4], confirm{n,m}` | Worker is up |
| `camera_ok` | `width, height, recovered_from: null\|"lost"\|"frozen"` | First good frame, or recovery |
| `frame_error` | `reason, detail, consecutive_failures` | One bad fetch or frame. `reason`: `fetch_error`, `decode_error`, `black_frame`, `blank_frame` |
| `camera_lost` | same as `frame_error` | `camera_lost_after` (3) bad frames in a row; sent once until recovery |
| `frozen_frame` | `identical_frames` | Stream stuck (identical frames). Checks pause until it changes |
| `observation` | `frame, printer_state, detection_active, warmed_up, suspicions[], metrics{…}`, optional `duplicate_frame` | One analysed frame. Metrics: `brightness, contrast, motion, moving_fraction, roi_change, outside_change, edge_density, edge_baseline, thin_density, thin_baseline, spaghetti_score, still_seconds` |
| `possible_failure` | `kind, score, window{hits,of,need,size}, evidence` | First suspicious frame for `kind` |
| `confirmed_failure` | `kind, score, window, evidence, evidence_frames[]` | N of the last M frames were suspicious |
| `suspicion_cleared` | `kind, reason, was_confirmed` | Window emptied (`no_longer_detected`), or checks stopped (`printer_not_printing`, `camera_lost`, `camera_frozen`, `baseline_reset`) |
| `heartbeat` | `frames, camera, printer_state, detection_active, uptime_s, evidence_saved` | Every `--heartbeat` seconds (60) |
| `warning` | `detail` | Bad stdin line, etc. |
| `stopped` | `frames` | Clean exit |

`kind` is one of `spaghetti`, `detachment`, `stalled`. `score` for spaghetti is
the texture ratio against the baseline. For detachment it is the changed
fraction of the ROI. For stalled it is the number of seconds without change.
`evidence` is an absolute JPEG path, or null when no evidence dir is set or
the cap was reached.

**stdin (guardian → worker):** the guardian sends one JSON object per line.

```json
{"type":"printer_state","online":true,"machine":"BUILDING_FROM_SD","progress":42}
{"type":"reset_baseline"}
{"type":"shutdown"}
```

A bare `PrinterStatus` object (any object with a `machine` key) is also
accepted. The machine states `BUILDING`, `BUILDING_FROM_SD`, `PRINTING` and
`BUSY_PRINTING` count as printing. When printer state is known and the printer
isn't printing, failure checks are off. With no printer state, the spaghetti
and detachment checks run but the stalled check doesn't.

## Alert state machine

```
idle ─start─▶ monitoring ─possible_failure─▶ possible_failure ─confirmed_failure─▶ confirmed_failure
                  ▲                               │ suspicion_cleared                   │ requestPause()
                  │                               ▼                                     ▼
                  ├──────── (alert closed) ◀── false_alarm                     pause_requested
                  │                                                              │         │ timeout (90 s)
                  └──────── (alert closed) ◀── resolved                          │         ▼
                                                                                 │   pause_unconfirmed
                                       printer status machine == PAUSED          ▼         │
                                       ─────────────────────────────────▶  pause_confirmed ◀┘
```

- One alert is open at a time. Other kinds raised while it is open are added
  to `alert.kinds` and `alert.evidence`.
- `possible_failure` that clears turns into **`false_alarm`**. A confirmed
  alert is never dismissed automatically: if vision stops seeing the problem,
  `alert.visionCleared = true` and the operator decides.
- `requestPause()` is allowed from `possible_failure`, `confirmed_failure` or
  `pause_unconfirmed` (a retry). It moves the alert to **`pause_requested`**
  and does one of two things:
  - **With a `PauseHook`** (`delivery: "hook"`), it calls the hook. If the hook
    rejects or throws, the alert goes straight to `pause_unconfirmed`. If the
    hook accepts, the alert still waits for printer status.
  - **Without a hook** (`delivery: "operator_manual"`), the UI must ask the
    operator to press pause on the printer.
- Only `handlePrinterStatus({machine: "PAUSED"})` from an online printer leads
  to **`pause_confirmed`**. This can come after our request
  (`pauseConfirmedBy: "request"`), or after someone paused at the printer
  during an alert (`"external"`).
- If the printer doesn't report PAUSED within `pauseConfirmTimeoutMs`
  (90 s), the alert goes to **`pause_unconfirmed`**. A late PAUSED still
  confirms it.
- `resolve(note)` closes the alert as `resolved` and `dismiss(note)` closes it
  as `false_alarm`. `stopMonitoring()` resolves any open alert. Closed alerts
  go to `history`, and the state returns to `monitoring`.
- **Auto-pause:** `autoPause` defaults to `false`. Even when set to `true`,
  nothing happens unless a `pauseHook` is also supplied. Leave it off until
  Phase 5 has validated the pause command on the real printer with an
  operator present.
- AI and review results are added to `alert.verifications` and never change
  the state.

`STATE_LABELS` holds operator wording that never says "paused" before the
printer confirms it. For example, `pause_requested` reads "Pause requested —
waiting for the printer to confirm (NOT paused yet)".

## Gemini verification

`GeminiVisionClient.verify({jpeg, suspectedKind, printerState, progress, metrics})`
sends a REST call to
`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.
The key goes only in the `x-goog-api-key` header. The body contains a text
part with the prompt, an `inlineData` part (`image/jpeg`, base64), and
`generationConfig.responseMimeType = "application/json"` with
`responseJsonSchema` requiring
`{problem_type, confidence, explanation}`.

- `problem_type` is one of: `spaghetti`, `detachment`, `stalled`,
  `camera_issue`, `other_failure`, `no_problem`, `uncertain`.
- On success it returns
  `{status:"ok", problem, confidence (0..1), explanation, model, failureLikely}`.
- Otherwise it returns `{status:"unavailable", reason}`. `reason` is one of
  `no_api_key`, `rate_limited` (with `retryAfterMs`), `daily_cap`,
  `image_too_large`, `http_error`, `network_error`, `bad_response`.
- `PrintGuardian` calls it **once per alert**, when the alert first becomes
  confirmed, using the confirmed evidence JPEG. It never sends observation
  frames.

The Gemini docs now call `generateContent` "legacy" in favour of the
Interactions API. It is still supported. If it has to be migrated, the
change is contained in `gemini.ts`.

## Optional cloud extras (off without env vars)

- **Swarms review** (`SWARMS_API_KEY`): sends a two-agent `ConcurrentWorkflow`
  to `{base}/v1/swarm/completions` with an `x-api-key` header. **I couldn't
  verify the request shape against current docs.** Any error or answer it
  can't parse falls back to `localReview()`, which applies conservative rules:
  - Gemini agrees there is a failure: `pause_recommended`.
  - Gemini says `no_problem` with confidence ≥ 0.7: `likely_false_alarm`.
  - The local detector confirmed the failure but there was no AI check:
    `pause_recommended`.
- **Tiger Data telemetry** (`TIGER_DATABASE_URL`): `TelemetrySync` buffers
  records (bounded at 1000) and flushes them in batches through an injected
  `TelemetrySink`. No Postgres driver is bundled, to avoid touching the shared
  lockfile. Run `TIGER_TELEMETRY_SQL` once on the Tiger database. A sink is
  about ten lines with `pg` (`INSERT … SELECT * FROM jsonb_to_recordset($1)`),
  and it adds the `device` column.

## Proposed SQLite schema (for `packages/database`)

Phase 1 already creates `monitoring_sessions` and `failure_alerts`, so the
proposal in `packages/guardian/src/schema.ts` is additive:

- `GUARDIAN_SCHEMA_SQL` creates the new tables `guardian_evidence` and
  `alert_transitions`, plus indexes. It repeats the two Phase 1 tables with
  their original columns, so on existing databases it changes nothing.
- `GUARDIAN_COLUMN_MIGRATIONS` lists `[table, column, definition]` triples in
  the same shape as `packages/database`'s `add()` helper. They add the new
  columns:
  - `monitoring_sessions`: `snapshot_url`, `evidence_rel_dir`, `end_reason`, `worker_restarts`
  - `failure_alerts`: `state`, `score`, `updated_at`, `confirmed_at`,
    `pause_source`, `pause_delivery`, `pause_requested_at`,
    `pause_confirmed_at`, `pause_confirmed_by`, `closed_at`, `resolution`,
    `ai_problem`, `ai_confidence`, `ai_explanation`, `ai_model`, `review_json`
- `applyGuardianSchema(db)` shows the intended order. It is tested on a fresh
  sql.js database and on one with the Phase 1 tables.
- `levelForState()` fills the old `failure_alerts.level` column (`warning`,
  `critical` or `info`).

To merge: append the two new `CREATE TABLE` statements to `SCHEMA`, add the
triples to `migrate()`, then implement `GuardianStore` on `MorphixDb`:

- `sessionStarted` / `sessionEnded`: upsert `monitoring_sessions`
- `alertChanged(alert, transition)`: upsert `failure_alerts`. Use the first
  evidence path as `snapshot_rel_path` (relative to the storage root), copy
  the last Gemini verification into the `ai_*` columns, and insert into
  `alert_transitions` when `transition` isn't null.
- `evidenceSaved(e)`: insert into `guardian_evidence` (`e.relPath` is
  relative to the storage root).

## Wiring it into Electron (integrator)

Everything runs in the **main process**: the guardian uses `child_process`
and reads files. The renderer gets snapshots over IPC.

```ts
// apps/desktop/electron/main.ts (sketch)
import { join } from "node:path";
import { PrintGuardian, geminiVisionFromEnv, swarmsFromEnv, telemetryFromEnv } from "@morphix/guardian";

const guardian = new PrintGuardian({
  storageRoot: storage.root,                                   // /home/jd/Morphix
  visionDir: app.isPackaged ? join(process.resourcesPath, "vision") : join(app.getAppPath(), "services/vision"),
  worker: {
    snapshotUrl: "http://192.168.10.51:8080/?action=snapshot",
    intervalSeconds: 10,
    // roi: "0.15,0.2,0.7,0.75", confirm: "3/5", stallSeconds: 600,
  },
  alerts: { autoPause: false /* Phase 5: pauseHook: async (alert) => printerControl.requestPause() */ },
  gemini: geminiVisionFromEnv(env),         // env loaded from ~/Morphix/config/morphix.env
  swarms: swarmsFromEnv(env),
  telemetry: telemetryFromEnv(env /*, tigerSink */),
  store: db,                                // MorphixDb implementing GuardianStore (see above)
  log: (l) => logger.info(l),
});

// feed every printer poll: drives the stalled check AND pause confirmation
const observer = new PrinterObserver(transport, (s) => { /* existing code */ guardian.updatePrinterStatus(s); });

// start/stop with the job (Phase 5 print start), or from a button for now
ipcMain.handle("guardian:start", (_e, printJobId?: string) => guardian.start({ printJobId }));
ipcMain.handle("guardian:stop", () => guardian.stop("stopped by operator"));
ipcMain.handle("guardian:snapshot", () => guardian.snapshot());
ipcMain.handle("guardian:requestPause", () => guardian.requestPause());
ipcMain.handle("guardian:resolve", (_e, note?: string) => guardian.resolve(note));
ipcMain.handle("guardian:dismiss", (_e, note?: string) => guardian.dismiss(note));
ipcMain.handle("guardian:resetBaseline", () => guardian.resetBaseline());
guardian.onUpdate((snap) => win?.webContents.send("guardian:update", snap));
app.on("before-quit", () => void guardian.stop("app quit"));
```

- **Preload:** expose `guardian.{start, stop, snapshot, requestPause, resolve, dismiss, resetBaseline, onUpdate}`
  over these channels. `GuardianSnapshot` is plain JSON, so it is safe to
  pass through `contextBridge`.
- **Packaging:** add `services/vision` to the build's `extraResources` (as
  `vision`). The guardian needs only Python on the Pi, not node-gyp.
- **Evidence images:** the renderer can show them through the existing
  local-file protocol, using `alert.evidence[]` (absolute paths) or the
  stored `relPath`.

What the UI should show, using the 1024×600 Printer page:

- `snapshot.label` as the banner
- the camera state (`ok`, `lost`, `frozen`)
- the latest evidence thumbnail
- the Gemini explanation from `alert.verifications`, if present
- buttons:
  - **Pause print**: `requestPause`. Without a hook, it shows "Press pause on
    the printer now".
  - **It's fine**: `dismiss`
  - **Resolved**: `resolve`
  - **Re-learn scene**: `resetBaseline`

Only show "Paused" when `state === "pause_confirmed"`.

**Phase 5 hook:** `PauseHook = (alert) => Promise<{accepted, detail?}>`. It
must send only the validated pause command and report whether the printer
*accepted* it. Confirmation still comes from `updatePrinterStatus`. Even with
a hook, keep `autoPause: false` until the operator has signed it off.

## Tuning on the device (still to do, needs the Pi and a real print)

1. Save a snapshot and set `--roi` so it covers the bed and the part, but not
   the rails or the top of the chamber.
2. Run a healthy print with `--evidence-dir` set and look at
   `observation.metrics`. `spaghetti_score` should stay below 1.8 and
   `roi_change` below 0.3. If the moving head or the chamber LED cause false
   positives, adjust `--spaghetti-ratio` or `--detach-fraction`.
3. Check that `moving_fraction` rises above 0.003 while the head moves.
   Otherwise the stalled check will fire on healthy prints.
4. Check that static frames from the real camera are *not* reported as
   frozen. The check looks for byte-identical frames, or a mean pixel
   difference below 0.05.
5. Test the failure paths: unplug the camera Ethernet (expect `camera_lost`),
   and drop loose filament on the bed in view of the camera (expect a
   confirmed spaghetti alert).

The heuristics have only been tested on synthetic images so far. Expect to
retune them on the real camera.

## Spoken warnings (apps/desktop/electron/guardian-voice.ts)

When an alert reaches `confirmed_failure`, Morphix interrupts any speech, plays a chime and says
the problem out loud, asking "Do you want me to stop the print? Say yes, stop it, or no, keep
printing." Gemini Live speaks it (`VoiceController.speakExact`); if no Gemini audio starts within
~7 s (offline, API error) the local espeak-ng voice (`tts.ts`, installed without sudo by
`scripts/pi/ensure-tts.sh`) says it instead, and late Gemini audio for that turn is dropped.

- One incident per alert id; repeated at most twice more, 60 s apart, only while unanswered and
  not while the user is talking. After "keep printing", alerts of the same kind stay quiet (still
  on screen) for 10 minutes.
- Answers: the `answer_print_warning` Gemini tool (checked against the user's own transcribed
  words by `classifyWarningAnswer`), a backup that matches the words when Gemini didn't call the
  tool, or the touchscreen "Yes, stop it" / "No, keep printing" buttons. Stop uses the normal
  `Printing.cancel()`; "stopped" is only said after the printer confirms it.
- Grown-ups → "Test the print warning" runs a simulated incident that never sends printer commands.
