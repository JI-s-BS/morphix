# AI Print Guardian

The guardian watches the printer's camera while a print runs. Cheap local image checks look
for likely failures, a failure counts only after it shows up in several frames, Gemini takes
one look at the confirmed snapshot, and the operator is helped to pause or stop the print.

The guardian itself never sends a command to the printer. Auto-pause is off. A pause is
reported as done only once the printer's own status says it is paused. The general safety
rules are in [SAFETY.md](SAFETY.md). Error codes (`MX-GUARD-*`) are in [ERRORS.md](ERRORS.md).

```
 printer camera ──HTTP snapshot──▶ services/vision (Python, OpenCV)
                                     │ JSON lines (stdout)        ▲ printer state (stdin)
                                     ▼                            │
 app main process ── VisionWorker ─▶ AlertStateMachine ─▶ GuardianStore (SQLite)
        ▲                │                  │
        │ printer polls  │ confirmed only   └─▶ snapshots to the UI and the spoken warning
        │ (StallMonitor) ▼
        │         GeminiVisionClient (rate-limited) ─▶ localReview
```

## Components

| Path | What |
|---|---|
| `services/vision/morphix_vision/` | Python worker: `analysis.py` (image metrics), `detector.py` (checks and N-of-M confirmation), `worker.py` (poll loop, stdin, evidence), `__main__.py` (CLI). Install, run by hand and tests: [services/vision/README.md](../services/vision/README.md) |
| [`packages/guardian/src/`](../packages/guardian/src/) | `events.ts` (event types, `parseVisionLine`), `worker.ts` (`VisionWorker`: spawns the worker, restarts it with backoff, forwards printer state), `stall.ts` (`StallMonitor`), `alerts.ts` (`AlertStateMachine`, `STATE_LABELS`, `PauseHook`), `gemini.ts` (`GeminiVisionClient`), `review.ts` (`localReview`), `schema.ts` (SQLite), `guardian.ts` (`PrintGuardian`, which ties it together) |
| [`apps/desktop/electron/printing.ts`](../apps/desktop/electron/printing.ts) | Creates the guardian, starts and stops it with prints, stores its records |

The Python worker is optional. Without Python and OpenCV the guardian reports the worker as
down and the rest of Morphix keeps working.

## Running it

The app starts the guardian on its own when a print starts, or when a printer poll shows a
print running (filament-change jobs excluded). It stops when the print ends. If the operator
presses Stop on the guardian, it stays off until that print is over.

The app runs the worker from `services/vision` with the printer's snapshot URL,
`http://<printer-ip>:8080/?action=snapshot`, every 10 seconds. Evidence JPEGs go to
`<data dir>/snapshots/<session>/`, where the session id looks like `guardian-20261107T062900`.

Tests: `npm test` runs the guardian's TypeScript suites in `tests/`; the end-to-end one needs `MORPHIX_TEST_PYTHON` (see the [vision README](../services/vision/README.md#tests)).

### Environment

| Variable | Default | Used for |
|---|---|---|
| `MORPHIX_PYTHON` | `~/.local/share/morphix-vision/bin/python` if it exists (made by `scripts/pi/ensure-vision.sh`), else `python3` | Interpreter for the vision worker |
| `MORPHIX_PRINTER_HOST` | set it to `<printer-ip>` | Printer address; the snapshot URL is built from it |
| `MORPHIX_CAMERA_SNAPSHOT_URL` | `http://localhost:8080/?action=snapshot` | Only when you run the Python CLI by hand without `--snapshot-url` |
| `GEMINI_API_KEY` | none: verification is "unavailable" | Gemini check of confirmed snapshots |
| `MORPHIX_GEMINI_VISION_MODEL` | `gemini-3.8-flash` | Gemini model id |
| `MORPHIX_GEMINI_VISION_MIN_INTERVAL_S` | `120` | Minimum gap between Gemini calls, in seconds |
| `MORPHIX_GEMINI_VISION_DAILY_CAP` | `40` | Gemini calls per UTC day |
| `MORPHIX_PRINT_CONTROLS` | off | `1` lets "Pause print" send the validated pause command (see the state machine) |
| `MORPHIX_PAUSED_STATUSES` | `PAUSED` | Printer machine states that count as paused (MoveMode `PAUSED` always does) |

## Event format (worker → guardian)

Each stdout line is one JSON object. Diagnostics go to stderr, never stdout. Every event has
this envelope:

```json
{"v":1,"seq":17,"ts":"2026-11-07T06:29:21.288+00:00","session":"guardian-20261107T062900","type":"…", …}
```

`v` is the protocol version (1). `seq` goes up by one per line within a worker run. `ts` is
UTC ISO-8601. `session` is the `--session` value. Lines that are not valid JSON, have an
unknown `type` or miss required fields are ignored (logged, not parsed).

| `type` | Extra fields | Meaning |
|---|---|---|
| `started` | `pid, snapshot_url, interval, evidence_dir, roi[4], confirm{n,m}` | Worker is up |
| `camera_ok` | `width, height, recovered_from: null\|"lost"\|"frozen"` | First good frame, or recovery |
| `frame_error` | `reason, detail, consecutive_failures` | One bad fetch or frame. `reason`: `fetch_error`, `decode_error`, `black_frame`, `blank_frame` |
| `camera_lost` | same as `frame_error` | 3 bad frames in a row; sent once until recovery |
| `frozen_frame` | `identical_frames` | The stream is stuck on the same picture. Checks pause until it changes |
| `observation` | `frame, printer_state, detection_active, warmed_up, suspicions[], metrics{…}`, optional `duplicate_frame` | One analysed frame. Metrics: `brightness, contrast, motion, moving_fraction, roi_change, outside_change, edge_density, edge_baseline, thin_density, thin_baseline, spaghetti_score, still_seconds` |
| `possible_failure` | `kind, score, window{hits,of,need,size}, evidence` | First suspicious frame for `kind` |
| `confirmed_failure` | `kind, score, window, evidence, evidence_frames[]` | N of the last M frames were suspicious (default 3 of 5) |
| `suspicion_cleared` | `kind, reason, was_confirmed` | The window emptied (`no_longer_detected`) or the checks stopped (`printer_not_printing`, `camera_lost`, `camera_frozen`, `baseline_reset`) |
| `heartbeat` | `frames, camera, printer_state, detection_active, uptime_s, evidence_saved` | Every `--heartbeat` seconds (60) |
| `warning` | `detail` | Bad stdin line, etc. |
| `stopped` | `frames` | Clean exit |

`kind` is `spaghetti`, `detachment` or `stalled`. For spaghetti, `score` is the texture ratio
against the baseline. For detachment it is the changed fraction of the bed region. For stalled
it is the number of seconds without change. `evidence` is an absolute JPEG path, or null when
no evidence dir is set or the cap was reached.

The worker's own camera stall check is off by default (`--stall-seconds 0`), because a still
picture is normal while the printer heats up. In the app, "stalled" comes from `StallMonitor`
instead. It uses progress, layer and head position from printer polls, only while the machine
state is `BUILDING_FROM_SD` and not paused, never while a heater is more than 5 °C below its
target, and not while progress and layer are still 0 in the first 20 minutes. No change for 15
minutes is a possible stall; 2 more minutes over at least 2 more polls confirms it. It emits the
same `possible_failure` / `confirmed_failure` / `suspicion_cleared` events as the worker.

**stdin (guardian → worker):** one JSON object per line.

```json
{"type":"printer_state","online":true,"machine":"BUILDING_FROM_SD","progress":42}
{"type":"reset_baseline"}
{"type":"shutdown"}
```

The guardian forwards every printer poll and replays the last one to a restarted worker. When
the printer is unreachable for 60 seconds it sends `online: false`, which switches the camera
checks off. The worker also accepts a bare printer status (any object with a `machine` key).
`BUILDING`, `BUILDING_FROM_SD`, `PRINTING` and `BUSY_PRINTING` count as printing. When the
printer state is known and it isn't printing, failure checks are off.

## Alert state machine

```
idle ─start─▶ monitoring ─possible_failure─▶ possible_failure ─confirmed_failure─▶ confirmed_failure
                  ▲                               │ suspicion_cleared                   │ requestPause()
                  │                               ▼                                     ▼
                  ├──────── (alert closed) ◀── false_alarm                     pause_requested
                  │                                                              │         │ timeout (90 s)
                  └──────── (alert closed) ◀── resolved                          │         ▼
                                                                                 │   pause_unconfirmed
                                       printer reports paused                    ▼         │
                                       ─────────────────────────────────▶  pause_confirmed ◀┘
```

- One alert is open at a time. Other kinds raised while it is open are added to `alert.kinds`
  and `alert.evidence`.
- A `possible_failure` that clears becomes **`false_alarm`**. A confirmed alert is never
  dismissed by vision alone: if the problem is no longer seen, `alert.visionCleared = true` and
  the operator decides. Two exceptions close alerts on their own: a confirmed stall-only alert
  is resolved when the printer makes progress again, and any open alert is resolved when the
  printer reports `READY` (the print is over).
- `requestPause()` works from `possible_failure`, `confirmed_failure` or `pause_unconfirmed` (a
  retry) and moves the alert to **`pause_requested`**:
  - **With a `PauseHook`** (`delivery: "hook"`), the hook is called. The app supplies one only
    when `MORPHIX_PRINT_CONTROLS=1`; it sends the printer controller's validated pause command.
    If the hook rejects or throws, the alert goes straight to `pause_unconfirmed`. If it accepts,
    the alert still waits for the printer's status.
  - **Without a hook** (`delivery: "operator_manual"`), the UI asks the operator to press pause
    on the printer.
- Only a printer status from an online printer that reports paused leads to
  **`pause_confirmed`**: after our request (`pauseConfirmedBy: "request"`), or after someone
  paused at the printer during an alert (`"external"`).
- If the printer doesn't report paused within 90 seconds, the alert goes to
  **`pause_unconfirmed`**. A late paused status still confirms it.
- `resolve(note)` closes the alert as `resolved`, `dismiss(note)` as `false_alarm`.
  `stopMonitoring()` resolves any open alert. Closed alerts go to `history` (the last 50) and
  the state returns to `monitoring`.
- **Auto-pause:** `autoPause` defaults to `false`, and the app sets it to `false`. Even when
  `true`, nothing happens without a `pauseHook`.
- Gemini and review results go into `alert.verifications`. They never change the state.

`STATE_LABELS` holds operator wording that never says "paused" before the printer confirms
it. For example, `pause_requested` reads "Pause requested — waiting for the printer to confirm
(NOT paused yet)". Only `pause_confirmed` reads as paused.

## Gemini verification and local review

`GeminiVisionClient.verify({jpeg, suspectedKind, printerState, progress, metrics})` sends one
REST call to `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.
The key goes only in the `x-goog-api-key` header and is never logged. The body has a text part
with the prompt, an `inlineData` JPEG part (at most 4 MB), and a JSON response schema requiring
`{problem_type, confidence, explanation}`.

- `problem_type` is one of `spaghetti`, `detachment`, `stalled`, `camera_issue`,
  `other_failure`, `no_problem`, `uncertain`. On success the client returns
  `{status:"ok", problem, confidence (0..1), explanation, model, failureLikely}`, where
  `failureLikely` is false for `no_problem`, `uncertain` and `camera_issue`.
- Otherwise it returns `{status:"unavailable", reason}`, with `reason` one of `no_api_key`,
  `rate_limited` (with `retryAfterMs`), `daily_cap`, `image_too_large`, `http_error`,
  `network_error`, `bad_response`.
- `PrintGuardian` calls it **once per alert**, when the alert first becomes confirmed, with the
  confirmed evidence JPEG. Observation frames are never sent. Printer-status stalls have no
  image, so they skip Gemini.

Then `localReview()` turns the detector result and the Gemini answer into one recommendation,
stored as a `local` verification:

- Gemini says `no_problem` with confidence ≥ 0.7: `likely_false_alarm`.
- Gemini sees a failure with confidence ≥ 0.6: `pause_recommended`.
- Otherwise (Gemini unavailable, unsure or below those thresholds), the local detector's
  confirmation stands: `pause_recommended`.

## SQLite schema

`applyGuardianSchema(db)` runs when the app database opens. `GUARDIAN_SCHEMA_SQL` creates, if
missing:

- `monitoring_sessions (id, print_job_id, started_at, ended_at)`
- `failure_alerts (id, session_id, at, level, kind, confidence, snapshot_rel_path, detail)`
- `guardian_evidence (id, session_id, alert_id, at, label, kind, rel_path, bytes, sent_to_ai)`.
  `label` is `suspect` or `confirmed`; `rel_path` is relative to the data dir.
- `alert_transitions (id, alert_id, at, from_state, to_state, reason)`, plus three indexes.

`GUARDIAN_COLUMN_MIGRATIONS` then adds columns that are missing:
`monitoring_sessions.snapshot_url, evidence_rel_dir, end_reason, worker_restarts` and
`failure_alerts.state, score, updated_at, confirmed_at, pause_source, pause_delivery,
pause_requested_at, pause_confirmed_at, pause_confirmed_by, closed_at, resolution, ai_problem,
ai_confidence, ai_explanation, ai_model, review_json`.

What the app writes today (`printing.ts`): one `monitoring_sessions` row per session (id, print
job, start and end time); one `failure_alerts` row per alert, rewritten on every change, with
the alert state in `level`, the score in `confidence`, the last evidence path in
`snapshot_rel_path` and `{state, verifications}` as JSON in `detail`; one `alert_transitions`
row per state change; one `guardian_evidence` row per saved JPEG. The migrated columns exist
but are not filled yet.

## Spoken warnings

[`guardian-voice.ts`](../apps/desktop/electron/guardian-voice.ts) speaks a warning when an
alert reaches `confirmed_failure`. Morphix interrupts any speech, plays a chime, names the
problem and asks: "Do you want me to stop the print? Say yes, stop it, or no, keep printing."

- Gemini Live says it word for word (`VoiceController.speakExact`). If no Gemini audio starts
  within 7 seconds, the local espeak-ng voice (`tts.ts`) says it instead, and late Gemini audio
  for that turn is dropped.
- One incident per alert id. It is repeated at most twice more, 60 seconds apart, only while
  unanswered and not while the user is talking. After "keep printing", alerts of the same kind
  stay quiet (still on screen) for 10 minutes.
- Answers come from the `answer_print_warning` Gemini tool (checked against the user's own
  transcribed words by `classifyWarningAnswer`), from a word match when Gemini didn't call the
  tool, or from the touchscreen "Yes, stop it" / "No, keep printing" buttons. Unclear or
  mixed answers are not acted on.
- "Stop" uses the normal print cancel. "Stopped" is said only after the printer confirms it;
  otherwise Morphix asks the user to press stop on the printer. "Keep printing" dismisses the
  alert as a false alarm.
- Grown-ups → "Test the print warning" runs a pretend incident that never sends a printer command.

## Not tuned / not verified yet

The image checks have only been tested on synthetic images. Expect to retune them on a real
camera and a real print:

1. Save a snapshot and set `--roi` so it covers the bed and the part, but not the rails or the
   top of the chamber.
2. Run a healthy print with `--evidence-dir` set and watch `observation.metrics`.
   `spaghetti_score` should stay below 1.8 and `roi_change` below 0.3. If the moving head or
   the chamber light cause false positives, adjust `--spaghetti-ratio` or `--detach-fraction`.
3. If you turn on the camera stall check (`--stall-seconds`), check that `moving_fraction`
   rises above 0.003 while the head moves; otherwise it fires on healthy prints.
4. Check that a real camera's static frames are *not* reported as frozen. The check looks for
   byte-identical frames, or a mean pixel difference below 0.05.
5. Test the failure paths: unplug the camera (expect `camera_lost`), and drop loose filament on
   the bed in view (expect a confirmed spaghetti alert).

The app runs the worker with the default thresholds and bed region; it has no setting for
these flags yet.

Also not verified: the printer-status stall timings on long real prints, and the Gemini prompt,
which describes the Afinia QD330 chamber (blue build plate) and may need changes for other
printers. Google now calls `generateContent` "legacy"; it still works, and moving off it would
touch only `gemini.ts`.
