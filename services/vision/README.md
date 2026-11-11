# Vision worker (Print Guardian camera checks)

Used by the AI Print Guardian (`packages/guardian`); optional: without Python + OpenCV
the guardian reports the worker as down and everything else keeps working.

A Python/OpenCV process that fetches a snapshot from the printer's camera (any HTTP
JPEG snapshot URL, e.g. mjpg-streamer's `/?action=snapshot`) at a fixed
interval, runs local checks, and prints **one JSON event per line on stdout**.
`@morphix/guardian` (packages/guardian) spawns it, parses the events and runs
the alert state machine. Gemini is never called from here. The worker never
talks to the printer. It only *receives* printer state on stdin.

What it checks on each frame (analysed at 320 px width; about 4 ms per 1280×720 frame on a laptop; far below the 10 s interval):

| Check | How | Event |
|---|---|---|
| Camera reachable | fetch errors, undecodable bytes | `frame_error`, then `camera_lost` after 3 in a row |
| Black / blank frame | mean brightness < 12 or std < 4 | same as above, reason `black_frame` / `blank_frame` |
| Frozen stream | byte-identical or pixel-identical frames | `frozen_frame` after 6 repeats |
| Spaghetti | sudden rise of Canny edges **and** thin-strand (top-hat) texture in the bed ROI vs a slow baseline | `possible_failure` → `confirmed_failure` (`kind: "spaghetti"`) |
| Detachment / big change | > 30 % of ROI pixels differ from the background model, while the area outside the ROI does not (so a lighting change doesn't count) | kind `detachment` |
| Stalled (camera) | **off by default** (`--stall-seconds 0`). A still picture is normal while heating, so the app decides "stalled" from printer status instead (`packages/guardian/src/stall.ts`: progress / layer / head position, only while BUILDING_FROM_SD and not paused, never while heating). `--stall-seconds N` turns the camera check on | kind `stalled` |

A failure is **confirmed** only when it is seen in N of the last M frames
(`--confirm 3/5`). Repeated identical frames don't count towards N.
Baselines learn only from frames that look normal, so a failure can't become
the new normal; the texture baseline also stops following a fast rise, so
slowly growing spaghetti is not absorbed. While the printer state is known and
not printing (READY, PAUSED, MoveMode PAUSED, `online: false`), failure checks
are off. With no printer state at all they run, but `stalled` stays off.

The baseline is learned again when a new print starts (not on resume from a
pause), when the camera comes back after an outage or a frozen stream, and when
the whole picture changes at once (lights, camera bumped). A camera outage is
reported as `camera_lost` / `frozen_frame` and clears any suspicion; it is never
a print failure.

Evidence: each suspicious frame is saved as
`<evidence-dir>/<UTC stamp>_<n>_suspect_<kinds>.jpg`, plus one
`..._confirmed_<kind>.jpg` when a failure is confirmed (at most `--max-evidence`
files per run).

## Install (Python 3.10+, numpy, OpenCV)

The simplest option uses the distro packages, with no compiler and no wheels:

```bash
sudo apt install -y python3-opencv python3-numpy      # Debian / Ubuntu / Raspberry Pi OS
sudo dnf install -y python3-opencv python3-numpy      # Fedora
sudo pacman -S --needed python-opencv python-numpy    # Arch
```

Or use a venv (`opencv-python-headless` publishes x86_64 and aarch64 wheels):

```bash
cd services/vision
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

If you use the venv, point the app at it with `MORPHIX_PYTHON=<repo>/services/vision/.venv/bin/python`.

## Run by hand

```bash
cd services/vision
python3 -m morphix_vision \
  --snapshot-url 'http://<printer-ip>:8080/?action=snapshot' \
  --interval 10 \
  --evidence-dir /tmp/morphix-snapshots \
  --roi 0.15,0.2,0.7,0.75
```

Paste printer state on stdin to enable the stalled check:

```
{"type":"printer_state","machine":"BUILDING_FROM_SD","progress":12}
```

Other stdin messages: `{"type":"reset_baseline"}` and `{"type":"shutdown"}`.

Tune the bed region with `--roi x,y,w,h`, given as fractions of the frame. Check
it against a saved snapshot: the ROI should cover the build plate and whatever
is printed on it, and leave out the rails and the top of the chamber.

Replay recorded snapshots without the camera:

```bash
python3 -m morphix_vision --replay-dir <data-dir>/snapshots/<session> --no-stdin
```

Run `python3 -m morphix_vision --help` for all thresholds.

## Tests

```bash
cd services/vision
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

The tests generate synthetic chamber images: a blue bed, a part, a moving head,
sensor noise, spaghetti strands, a dragged part, and black, blank or frozen
frames. They need no network and no camera. For the TypeScript end-to-end test
against this worker, run
`MORPHIX_TEST_PYTHON=$PWD/services/vision/.venv/bin/python ./node_modules/.bin/vitest run tests/phase4-guardian.test.ts`
from the repo root.

The full event format and state machine are in [docs/GUARDIAN.md](../../docs/GUARDIAN.md).
