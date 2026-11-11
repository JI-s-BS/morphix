# Self-healing

When something breaks, Morphix tries a small, safe fix by itself, stops after a few tries,
and writes down what it did. Each decision is one log line:

```
self-heal: <what happened> → <action> → <result> (<detail>)
```

For example: `self-heal: Gemini socket closed (1011 internal error) → reconnect to Gemini → fixed (Connected to …)`.

Results: `fixed`, `failed` (it may try again), `applied` (a setting changed to wait out a problem,
e.g. slower printer polling), `skipped` (not wired, or not safe right now), `gave-up` (the limit
was reached and the user was told), `noted` (recorded only), `suggested` (AI diagnosis).

Error codes mentioned below are listed in [ERRORS.md](ERRORS.md). The general safety rules are
in [SAFETY.md](SAFETY.md).

## What it never does

The healer has no way to start a print, heat anything, move the printer, cancel a real print,
or spend Meshy credits. Those actions are not in its whitelist and are not in the `HealActions`
interface at all, so they stay user-approved. Every whitelist entry is marked `physical: false`
and `costly: false`. Tests check the whitelist and the wired actions
(`tests/self-heal-engine.test.ts` "safety whitelist" and `tests/self-heal-install.test.ts`).

## Remediations

| Failure | How it is noticed | Fix | Limits |
|---|---|---|---|
| Gemini Live socket closed | log `Gemini session closed`, job code MX-VOICE-002 | `reconnect-gemini` (`voice.test()`). An inactivity close is only noted, unless someone spoke in the last 5 min. Closes within 15 s of our own reset are ignored. | 3 per 10 min, backoff 2 s / 10 s / 30 s |
| Voice turn hangs | `voice turn` with no `voice reply` / error / tool call within 75 s | `reset-voice-session` (close + reconnect). The user sees "Please say that again." | 2 per 10 min |
| Printer refuses control (stale lock) | status error or `printer-control` entry with "refused control" / "Control failed" | `release-printer-control` (see below). It is skipped while Morphix is uploading or starting a print. | 2 per 30 min, 2 min apart |
| Controller cleared the lock itself | `printer-control` entry with `op: "recoverControl"` | recorded as `fixed` (no extra action) | none |
| Printer offline | status `online: false` | `printer-poll-backoff`: poll every 10 s after 30 s offline, every 30 s after 2 min, every 60 s after 10 min. Back to normal when the printer answers. | none |
| Slicer failure (MX-SLICE-003/005/010 in `prepare.slice`/`prepare.gx`) | JobManager `finished` event | `retry-slice-safer`: prepare again with supports auto, 0.2 mm, 15 % infill | once per model version per hour |
| Meshy polling error (MX-NET-001/002/003/005, MX-GEN-004/006/007, MX-SYS-007 in `generate`/`download`) | JobManager event with `meta.taskId` | `resume-meshy-polling`: poll the **same** remote task again (`resumeRemoteId`), so no new task and no credits | 2 per task per hour, backoff 30 s / 2 min |
| Guardian worker crashed | probe: print active, guardian on, worker `failed`/`stopped` for 15 s; log `[guardian] … worker … failed`; MX-GUARD-003 | `restart-guardian-worker` (guardian stop + start) | 3 per 30 min, backoff 5 s / 30 s / 2 min |
| Job bar says "printing" but printer is READY | probe: printer READY, tracker not printing/paused, Morphix not busy, an active `print` job with a running `print` stage, for 3 min | `reconcile-print-state`: closes Morphix's own job record (by default `JobManager.cancel`, record only, with no printer command) | once per job |
| Disk nearly full | probe every 10 min: < 1 GiB or < 5 % free; `ENOSPC` in the log; MX-STORE-001 | `clean-disk`: deletes `morphix-*` temp dirs older than 1 day, `prints/*/*.gcode` older than 14 days (the `.gx` stays), logs older than 30 days, and loose `cache/` files older than 14 days. It never deletes models, `.gx` files, the database, backups or voice recordings. | once per 6 h |
| Job interrupted by a restart | `restored` job with status `interrupted` (MX-SYS-006) | `prepare` jobs: `retry-job` (prepare again). Generation and print jobs are only noted, because re-running them could cost credits or move the printer. | once per job per 6 h |
| Anything else at level `error`, or a job failing with MX-SYS-001 or an unregistered code | log, JobManager | optional AI diagnosis (below) | 1 per 5 min, 20 per day, same error once per 6 h |

Limit semantics, per remediation and key (job id, version id, `gemini`, …):
- `maxAttempts` per sliding `windowMs`.
- `backoffMs[n]` is the wait before attempt n.
- `cooldownMs` is the minimum gap between attempts.

When the last attempt fails, the healer records `gave-up` and shows one notice, "I tried to fix this myself but couldn't: …".
The limits are in `packages/healer/src/remediations.ts`, and they can be overridden with `deps.limits`.

### Printer stale lock

The QD330 can keep answering `M601 S1` with "Control failed" after a print was stopped, even
with no other client connected. An `M602` from any connection clears it. Two things handle this:

- The printer controller (`packages/printer/src/control.ts`) does it by itself: when `M601`
  is refused and none of Morphix's own control sessions is open, it sends `M602` and asks once
  more. If that works, it logs a `recoverControl` entry, which the healer records as `fixed`.
- The `release-printer-control` remediation runs a fresh status poll (`printer.poll()`). The
  poll opens its own short session, which also ends with `M602`.

Limitation: if the controller believes one of its own sessions is still open (for example a
leaked session), it does not send the extra `M602`, and the remediation is only a re-poll.

## AI diagnosis (optional)

AI diagnosis is on only when `ANTHROPIC_API_KEY` is set. It sends the error and the last 60 log
lines to the Anthropic Messages API with a raw `fetch` to `POST /v1/messages`:
- Model: `MORPHIX_CLAUDE_MODEL`, default `claude-opus-5-5`.
- Effort: `low`.
- JSON output via `output_config.format`.
- Server-side refusal fallback: `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta header. Set `MORPHIX_CLAUDE_FALLBACKS=0` if that header is ever refused.

Secrets are stripped before sending (`redactSecrets`):
- API keys (Anthropic, Google, Meshy, GitHub), Bearer/Basic auth, JWTs.
- JSON and `key=value` fields named key, token, secret, password, cookie and similar.
- Emails, and long hex or base64 blobs.
- The exact values of every env var whose name contains KEY, TOKEN, SECRET, PASSWORD or COOKIE.

Claude returns:
- `summary`, a plain-language sentence. The user sees it as a notice.
- `user_hint`, also shown in the notice.
- `likely_cause`.
- `suggested_remediation`, constrained by the JSON schema enum to the whitelist ids or `none`; anything else parses as `none`.
- `confidence`.

A suggestion runs only if all of these hold:
- It is `aiTriggerable`: `reconnect-gemini`, `reset-voice-session`, `release-printer-control` or `restart-guardian-worker`. These are argument-free and idempotent.
- Confidence is not `low`.
- It is within that remediation's normal limits.

Claude can never run anything else. `MORPHIX_SELF_HEAL_AI=0` turns diagnosis off. A refusal or
an answer that doesn't parse produces no diagnosis.

## API

`packages/healer` holds the pure logic and has no Electron dependency:

| Piece | What it does |
|---|---|
| `Healer` | `observeLog`, `observeJob`, `observePrinter`, `report`, `tick`, `history`, `status`, `settle`, `dispose` |
| `classifyLog` / `classifyJobEvent` | Turn log lines and job events into incidents |
| `REMEDIATIONS` | The whitelist and its limits |
| `redactSecrets` | Strips secrets from text before it is sent |
| `createClaudeDiagnoser` / `claudeDiagnoserFromEnv` | Build the AI diagnoser |
| `firstDiagnoser` | Tries a list of diagnosers in order until one answers |
| `cleanOldFiles` / `defaultCleanTargets` | Disk cleanup |

### Where it runs

[`apps/desktop/electron/self-heal.ts`](../apps/desktop/electron/self-heal.ts) connects the
healer to the app; the app installs it once at startup.

- `installSelfHealing(deps)` taps the logger so every log line is observed, subscribes to the
  JobManager (and replays jobs already restored as interrupted), runs `tick()` every 15 s, and
  sends notices as `{ type: "notice" }` app events.
- `appSelfHealDeps(parts)` maps the real app objects (voice, printer observer, printing,
  generation, database, storage) to actions and probes.
- `selfHealing()` returns the installed instance: `history(limit)` gives recent records, newest
  first, and `status()` gives counts, the printer poll interval and whether AI diagnosis is on.
  No screen shows the history yet.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `MORPHIX_SELF_HEAL` | on | `0` turns self-healing off completely |
| `ANTHROPIC_API_KEY` | (unset) | Turns on AI diagnosis |
| `MORPHIX_CLAUDE_MODEL` | `claude-opus-5-5` | Model used for diagnosis |
| `MORPHIX_SELF_HEAL_AI` | on | `0` turns off AI diagnosis only |
| `MORPHIX_CLAUDE_FALLBACKS` | on | `0` drops the server-side refusal fallback |

## Unverified

- No real Claude call has been made. The request shape is tested against a fake `fetch`.
- The Gemini Live close reason for inactivity is matched loosely (`inactiv|idle|expired|deadline|time limit`). Check the real `reason` string in `<data dir>/logs` and adjust `INACTIVITY_CLOSE_RE` if needed.
- The disk cleaner allows the OS temp dir (`tmpdir()`, usually `/tmp`) explicitly and refuses `/`, the home directory and other top-level directories.
