# AI features and keys

Morphix works without any AI keys. You can still import models, prepare them, and print them. Each key you add turns on one or more AI features. Keys stay on the Morphix server: the browser never sees them, and they are sent to the provider only in request headers.

Set each key on the setup page or as an environment variable. The tuning variables below are environment variables. Their defaults are the values in the code.

## Overview

| Feature | Provider | Key | Without the key |
|---|---|---|---|
| [Voice and text assistant](#voice-assistant-gemini-live) | Google Gemini Live | `GEMINI_API_KEY` | No assistant. Recording and typed requests return "Gemini is not configured". |
| [Text to model](#text-to-model-meshy) | Meshy | `MESHY_API_KEY` | No generation from a description. You can still import models, and use model search, functional parts or photo to model if their keys are set. |
| [Functional parts](#functional-parts-claude--openscad) | Anthropic Claude + local OpenSCAD | `ANTHROPIC_API_KEY` | The Claude option is off. The assistant says so and offers Meshy or an open-source design instead. |
| [Photo to model](#photo-to-model) | Gemini (analysis), Meshy and/or Claude | `GEMINI_API_KEY`, plus `MESHY_API_KEY` or `ANTHROPIC_API_KEY` | Without Gemini there is no analysis (`MX-P3D-010`). Uploading a 3D scan file needs no key. |
| [Model search](#model-search) | Thingiverse, Gemini | `THINGIVERSE_TOKEN` and/or `GEMINI_API_KEY` | Without either, search is off. |
| [Slicer advisor](#slicer-advisor) | Gemini | `GEMINI_API_KEY` | Built-in heuristic rules pick the settings. |
| [Guardian verification](#guardian-verification-gemini-vision) | Gemini | `GEMINI_API_KEY` | The local camera detector and a local review still run. |
| [Error diagnosis](#error-diagnosis-claude) | Anthropic Claude | `ANTHROPIC_API_KEY` | Self-healing still runs its fixed rules, with no AI diagnosis. |

Whenever something would spend Meshy credits, Morphix first shows the cost and waits for the user. AI models can only *propose* such actions. They never start them.

Error codes use the form `MX-<AREA>-<nnn>`. The families used here are `MX-VOICE`, `MX-GEN`, `MX-CAD`, `MX-P3D` and `MX-SLICE`. See [ERRORS.md](ERRORS.md) for the full list.

## Voice assistant (Gemini Live)

**What it does.** Push-to-talk speech and typed requests go to Gemini Live through the server. Gemini answers with speech and a transcript, and it can call Morphix tools. For example, it can offer engines, search for models, generate or revise a model, set its height, prepare a print, and propose a print. It also speaks the Guardian's print warnings. When Gemini can't speak, Morphix uses local `espeak-ng` if it is installed. Code: [packages/gemini/src/live.ts](../packages/gemini/src/live.ts), [apps/desktop/electron/voice.ts](../apps/desktop/electron/voice.ts).

**Key:** `GEMINI_API_KEY`.

| Variable | Default | Meaning |
|---|---|---|
| `MORPHIX_GEMINI_MODEL` | `gemini-3.8-live` | Live model |

Audio is sent as 16 kHz PCM, and Gemini answers at 24 kHz. The voice is the prebuilt "Puck" voice, in en-US.

**Safety.** Gemini can only propose actions that spend credits or start a print. The action runs only after the user taps Confirm, or after the user's own words are checked locally and clearly mean "yes" (`isAffirmative`). A pending action expires after 10 minutes.

**Privacy.** Google receives the recorded utterances, typed text, and the app state that tools return. That state includes the current project, model size, preparation and printer status, and the credit balance.

**Without the key:** there is no assistant. The record and send-text actions return "Gemini is not configured" (`MX-VOICE-004`).

**Not verified.** The live proposal flow has been checked against Gemini. The close reason Gemini gives for an inactive session is matched loosely (`inactiv|idle|expired|deadline|time limit`). Check the real reason in the logs in the data dir.

## Text to model (Meshy)

**What it does.** Meshy turns a description into a 3D model. The "preview" step returns a GLB and an STL, which are downloaded into the data dir straight away. "Add colour" runs a "refine" step on a preview. Running tasks resume after a restart. Code: [packages/meshy/src/index.ts](../packages/meshy/src/index.ts), [apps/desktop/electron/generation.ts](../apps/desktop/electron/generation.ts), [apps/desktop/electron/actions.ts](../apps/desktop/electron/actions.ts).

**Key:** `MESHY_API_KEY`.

| Variable | Default | Meaning |
|---|---|---|
| `MORPHIX_MESHY_MODEL` | `meshy-6` | `ai_model` for text to 3D |
| `MORPHIX_MESHY_DAILY_LIMIT` | `15` | Most Meshy tasks per day, counted from local midnight |

**Cost.** A preview costs 20 credits on `meshy-6`, `meshy-7.1` and `latest`, and 5 credits on `meshy-6-lite`. Refine costs 10 credits. The cost is shown before anything starts, and the job starts only after the user confirms. A new request is refused when the daily limit is reached or another generation is running. Prompts are cut to 800 characters. Meshy is polled every 3 s, with a 20-minute limit.

**Privacy.** Meshy receives the prompt text only.

**Without the key:** creating from a description returns "Meshy is not configured" (`MX-GEN-001`).

## Functional parts (Claude + OpenSCAD)

**What it does.** This feature is for parts that must fit or work: mounts, brackets, gears, hinges, enclosures, cases and replacement parts. Decorative models go to Meshy instead. The pipeline runs like this:

1. Claude writes parametric OpenSCAD, with every key dimension as a named variable.
2. The code passes static safety checks. It cannot read other files, and its `$fn` and loops are bounded.
3. `openscad` renders the code locally in a private temp dir, with no shell.
4. The STL is checked. It must be manifold, not inside out, fit the build volume, and be within max(2 mm, 10 %) of the size Claude stated.
5. Failures go back to Claude for another attempt.

Code: [packages/cad/src/generate.ts](../packages/cad/src/generate.ts), [packages/cad/src/claude.ts](../packages/cad/src/claude.ts), [apps/desktop/electron/cad.ts](../apps/desktop/electron/cad.ts).

**Key:** `ANTHROPIC_API_KEY`. The `openscad` program must also be installed.

| Variable | Default | Meaning |
|---|---|---|
| `MORPHIX_CLAUDE_MODEL` | `claude-opus-5-5` | Model (shared with error diagnosis) |
| `MORPHIX_CLAUDE_EFFORT` | `high` | `low`, `medium`, `high`, `xhigh` or `max` |
| `MORPHIX_CLAUDE_FALLBACKS` | on | `0` stops sending the server-side refusal fallback (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta) |
| `MORPHIX_OPENSCAD_BIN` | `openscad` | Path to the OpenSCAD CLI |
| `MORPHIX_OPENSCAD_TIMEOUT_S` | `300` here (`120` for photo to model) | Render timeout |

The request is streamed, uses adaptive thinking and a JSON schema, and sets `max_tokens` to 32000. Claude gets 2 attempts by default (`DEFAULT_MAX_ATTEMPTS`). Each attempt is a full design and render. A size mismatch on the last attempt is still returned, with a warning. Every other final failure is `MX-CAD-021`. Rate limits, overloads and network errors are retried twice with back-off. No Meshy credits are used.

**Measurements.** The built-in device table ([packages/cad/src/devices.ts](../packages/cad/src/devices.ts)) holds published body sizes of recent phones. The values come from the manufacturers' spec pages and have not been re-measured. Camera, button and port positions are never in the table. Claude must list every dimension it assumed, and the app then shows "Based on these measurements — check before printing". A fit is never presented as exact unless the user gave the measurements.

**Privacy.** Anthropic receives the user's description and measurements. When the request came from photos, it also receives the photo analysis (object name, estimated size, spec).

**Without the key:** the Claude option is off (`MX-CAD-002` if it is called directly). `MX-CAD-020` means `openscad` is not installed.

**Not verified.** No real Claude API call has been made from this package. The request shape follows the API reference. The real OpenSCAD render test only runs where `openscad` is on PATH.

## Photo to model

**What it does.** The user uploads photos (up to 8; JPEG, PNG, WebP or HEIC; at most 20 MB each and 14 MB in total) and a sentence about what to make. Measurements, a reference object such as a credit card or coin, or a 3D scan file are optional. Gemini works out what the object is and how big it is, then recommends an engine. Nothing is generated until the user picks a route. Code: [packages/photo3d/src/](../packages/photo3d/src/), [apps/desktop/electron/photo.ts](../apps/desktop/electron/photo.ts).

| Engine | Needs | Cost |
|---|---|---|
| Gemini writes OpenSCAD (up to 3 attempts, each axis within ±3 %) | `GEMINI_API_KEY`, `openscad` | Gemini calls only |
| Claude CAD (see above) | `ANTHROPIC_API_KEY`, `openscad` | No Meshy credits |
| Meshy Image / Multi-Image to 3D (2–4 photos) | `MESHY_API_KEY` | 20 credits on `meshy-7.1` or `meshy-6` (mesh only), 30 textured; `meshy-6-lite` 5 / 15; +5 for 2k/4k geometry |
| Scan import (OBJ, PLY, STL, GLB) | nothing | Free |

Before a Meshy run, Gemini's image model can crop the photo to the one subject and put it on a plain white background. The user can choose the original photo instead. If the OpenSCAD engine fails, Morphix falls back to Meshy, unless fallback is off or the cost is over the budget. Meshy tasks show their credit cost and wait for the user's OK.

| Variable | Default | Meaning |
|---|---|---|
| `MORPHIX_GEMINI_VISION_MODEL` | `gemini-3.8-flash` | Photo analysis and OpenSCAD writing (shared with the Guardian) |
| `MORPHIX_GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image` | Photo cleanup before Meshy |
| `MORPHIX_MESHY_IMAGE_MODEL` | `meshy-7.1` | `latest`, `meshy-6` or `meshy-6-lite` |
| `MORPHIX_PHOTO3D_MAX_CREDITS` | none | Meshy runs above this cost are refused (`MX-P3D-092`) |
| `MORPHIX_OPENSCAD_BIN`, `MORPHIX_OPENSCAD_TIMEOUT_S` | `openscad`, `120` | As above |

**Privacy.** Google receives the photos, the description and the measurements. Meshy receives the (optionally cleaned) photos; HEIC photos are not sent to Meshy. When the photos go through the photo-plan flow ([plan.ts](../packages/photo3d/src/plan.ts)), JPEG metadata (EXIF/XMP, IPTC, comments) is removed first. The direct `photoToModel` pipeline does not remove it itself.

**Limits.** One photo cannot give true scale. Reference objects give about ±5–10 % at best. Use calipers for anything that must fit. The ±3 % check covers the overall box, not each hole or wall. Meshy matches one dimension exactly, and the other two follow its proportions, so it is not suitable for mating parts. Scan units are a guess when the file doesn't record them.

**Not verified.** No real Gemini or Meshy call has been made from this package. The tests use mocks. API details were checked against the Meshy and Gemini docs.

Errors are `MX-P3D-nnn` (see [ERRORS.md](ERRORS.md)).

## Model search

**What it does.** It finds real, free, printable designs on Thingiverse before you spend anything on generation. Searching spends no Meshy credits, and importing never slices or prints. Code: [packages/model-search/src/index.ts](../packages/model-search/src/index.ts), [apps/desktop/electron/library-import.ts](../apps/desktop/electron/library-import.ts).

- **With `THINGIVERSE_TOKEN`** (a Thingiverse app token): Morphix uses Thingiverse's search API, then reads the licence, file list and picture of the top hits. Only designs with model files (STL, 3MF, OBJ, PLY or GLB) that Morphix can download are offered. "Choose this one" downloads every part, keeps each part's exact size, and lays the parts out on build plates.
- **With only `GEMINI_API_KEY`:** Gemini names Thingiverse designs it knows. Morphix opens each page to confirm the design is real, and takes the title and picture from the page. If fewer than two are found, Gemini searches the web, which takes about a minute. Thingiverse gives files only to apps with a token, so each card shows a link and QR code to download the design yourself and import it.
- **With neither:** search is off.

`MORPHIX_GEMINI_TEXT_MODEL` (default `gemini-3.8-flash`) picks the Gemini model. Licences come from Thingiverse's API. A licence found only on the page is marked as not confirmed. Downloads are capped at 200 files, 60 MB per file and 300 MB in total.

**Privacy.** Google and Thingiverse receive the search text.

## Slicer advisor

**What it does.** It picks the slicer, layer height, infill, walls, supports, brim and orientation for a prepared model. A deterministic heuristic always answers, using the measured overhangs, size, bed contact and intended use. Gemini can then refine that answer. Code: [packages/slicing/src/advisor.ts](../packages/slicing/src/advisor.ts).

**Key:** `GEMINI_API_KEY`. `MORPHIX_GEMINI_TEXT_MODEL` (default `gemini-3.8-flash`) picks the model. The timeout is 20 s.

**Safeguards.** Every answer from Gemini is type-checked and clamped to safe ranges: layer height 0.10–0.30 mm, infill 5–80 %, 2–5 walls, brim 0–10 mm. Confidence is capped at 0.95. The slicer is always the heuristic's choice. Gemini can add supports but cannot remove them when the overhang is real, and it cannot drop the brim on tall, thin parts. Any settings you set explicitly win over the advice.

**Privacy.** Gemini receives only measured facts (size, volume, watertightness, overhang numbers), the description and the heuristic's suggestion. The mesh is never sent.

**Without the key, or on any error:** the heuristic advice is used. When Gemini fails, the advice carries a fallback `MX-SLICE-012` and a closing line saying the built-in rules were used.

## Guardian verification (Gemini vision)

**What it does.** The local camera detector watches the print. When it confirms a failure over several frames, Morphix sends that one evidence JPEG to Gemini once for that alert. Gemini classifies it as `spaghetti`, `detachment`, `stalled`, `camera_issue`, `other_failure`, `no_problem` or `uncertain`, with a confidence and an explanation. A local review then combines both into a recommendation: `pause_recommended`, `keep_watching` or `likely_false_alarm`. The Guardian never sends commands to the printer, and auto-pause is off. Code: [packages/guardian/src/gemini.ts](../packages/guardian/src/gemini.ts), [packages/guardian/src/review.ts](../packages/guardian/src/review.ts).

**Key:** `GEMINI_API_KEY`.

| Variable | Default | Meaning |
|---|---|---|
| `MORPHIX_GEMINI_VISION_MODEL` | `gemini-3.8-flash` | Vision model |
| `MORPHIX_GEMINI_VISION_MIN_INTERVAL_S` | `120` | Minimum gap between calls |
| `MORPHIX_GEMINI_VISION_DAILY_CAP` | `40` | Most calls per day |

Images over 4 MB are not sent. The timeout is 30 s.

**Privacy.** Gemini receives only the confirmed evidence frame, the suspected failure, the printer state, progress and the detector's metrics. It never receives the regular observation frames.

**Without the key, or when the limit is reached:** the verification shows as unavailable (`no_api_key`, `rate_limited`, `daily_cap`, and so on). The local review still recommends pausing for a confirmed failure, marked "no AI check available".

**Not verified.** The detector heuristics have been tested only on synthetic images, and they need retuning on a real camera and a real print.

## Error diagnosis (Claude)

**What it does.** Self-healing classifies errors and runs fixed, whitelisted remediations. When an incident has no known code, Claude can diagnose it. Claude returns a plain-language summary and a hint, which are shown as a notice, along with a likely cause, a suggested remediation and a confidence. Code: [packages/healer/src/diagnose.ts](../packages/healer/src/diagnose.ts), [packages/healer/src/redact.ts](../packages/healer/src/redact.ts).

**Key:** `ANTHROPIC_API_KEY`.

| Variable | Default | Meaning |
|---|---|---|
| `MORPHIX_CLAUDE_MODEL` | `claude-opus-5-5` | Model (shared with functional parts) |
| `MORPHIX_SELF_HEAL_AI` | on | `0` turns off AI diagnosis only |
| `MORPHIX_CLAUDE_FALLBACKS` | on | `0` drops the server-side refusal fallback |
| `MORPHIX_SELF_HEAL` | on | `0` turns off self-healing completely |

Requests use effort `low` and JSON output. Diagnosis runs at most once every 5 minutes, at most 20 times a day, and at most once every 6 hours for the same incident.

**Safety.** A suggestion runs only when all of these hold:

- It is one of four argument-free, idempotent actions: `reconnect-gemini`, `reset-voice-session`, `release-printer-control` or `restart-guardian-worker`.
- Its confidence is not `low`.
- It is within that remediation's normal limits.

Claude can never run anything else.

**Privacy.** Claude receives the incident and up to the last 80 log lines, with secrets removed first. The removed secrets are:

- API keys, Bearer and Basic auth, and JWTs.
- Fields named key, token, secret, password, cookie and similar.
- Email addresses, and long hex or base64 blobs.
- The exact values of every environment variable whose name contains KEY, TOKEN, SECRET or PASSWORD.

**Without the key:** there is no AI diagnosis. Incidents are noted as "no AI diagnosis configured", and the fixed remediations still run.

**Not verified.** No real Claude call has been made. The request shape is tested against a fake `fetch`.
