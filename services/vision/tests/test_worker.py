import io
import json
import os
import subprocess
import sys

from morphix_vision.__main__ import main
from morphix_vision.detector import DetectorConfig
from morphix_vision.worker import Worker
from synth import jpeg, scene

VISION_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Clock:
    def __init__(self):
        self.t = 1_700_000_000.0

    def __call__(self):
        return self.t


def lines(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def make_worker(frames, tmp_path, **kw):
    clock = Clock()
    queue = list(frames)

    def fetch(url, timeout):
        clock.t += 10
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    out = io.StringIO()
    w = Worker("http://camera.test/?action=snapshot", DetectorConfig(), interval=0, evidence_dir=str(tmp_path),
               session="sess-1", heartbeat_seconds=30, fetcher=fetch, out=out, clock=clock, **kw)
    return w, out


def test_worker_emits_json_lines_with_envelope(tmp_path):
    frames = [jpeg(scene(i, head_x=100 + 40 * i)) for i in range(5)] + [OSError("connection refused")]
    w, out = make_worker(frames, tmp_path)
    assert w.run(max_frames=6) == 0
    events = lines(out.getvalue())
    assert events[0]["type"] == "started" and events[-1]["type"] == "stopped"
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert all(e["v"] == 1 and e["session"] == "sess-1" and e["ts"].endswith("+00:00") for e in events)
    types = [e["type"] for e in events]
    assert "camera_ok" in types and types.count("observation") == 5 and "heartbeat" in types
    err = [e for e in events if e["type"] == "frame_error"][0]
    assert "connection refused" in err["detail"]


def test_stdin_messages(tmp_path):
    w, out = make_worker([jpeg(scene(1))], tmp_path)
    w.start_stdin_reader(io.StringIO(
        '{"type":"printer_state","machine":"BUILDING_FROM_SD","progress":12}\n'
        'not json\n'
        '{"type":"mystery"}\n'
        '{"online":true,"machine":"READY"}\n'))
    import time
    deadline = time.time() + 2
    while w.inbox.qsize() < 5 and time.time() < deadline:
        time.sleep(0.01)
    w.run(exit_on_stdin_eof=True)
    events = lines(out.getvalue())
    warnings = [e["detail"] for e in events if e["type"] == "warning"]
    assert len(warnings) == 2 and "non-JSON" in warnings[0] and "mystery" in warnings[1]
    assert w.detector.printer_state == "READY"
    assert w.stdin_closed


def test_shutdown_message_stops_loop(tmp_path):
    w, out = make_worker([jpeg(scene(i)) for i in range(50)], tmp_path)
    w.handle_line('{"type":"shutdown"}')
    w.run()
    assert [e["type"] for e in lines(out.getvalue())] == ["started", "stopped"]


def test_cli_replay_dir(tmp_path, capsys):
    replay = tmp_path / "frames"
    replay.mkdir()
    for i in range(6):
        (replay / f"{i:03d}.jpg").write_bytes(jpeg(scene(i, head_x=100 + 50 * i)))
    for i in range(6, 9):
        (replay / f"{i:03d}.jpg").write_bytes(jpeg(scene(i, spaghetti=45)))
    code = main(["--replay-dir", str(replay), "--no-stdin", "--evidence-dir", str(tmp_path / "ev"), "--session", "s9"])
    assert code == 0
    events = lines(capsys.readouterr().out)
    kinds = [(e["type"], e.get("kind")) for e in events if e["type"].endswith("failure")]
    assert kinds == [("possible_failure", "spaghetti"), ("confirmed_failure", "spaghetti")]
    assert len(os.listdir(tmp_path / "ev")) == 4  # 3 suspicious + 1 confirmed


def test_cli_rejects_bad_confirm(capsys):
    assert main(["--confirm", "5/3", "--no-stdin"]) == 2


def test_module_runs_as_subprocess_with_clean_stdout(tmp_path):
    replay = tmp_path / "frames"
    replay.mkdir()
    for i in range(3):
        (replay / f"{i}.jpg").write_bytes(jpeg(scene(i)))
    proc = subprocess.run([sys.executable, "-m", "morphix_vision", "--replay-dir", str(replay), "--no-stdin"],
                          cwd=VISION_DIR, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    events = lines(proc.stdout)  # every stdout line must be JSON
    assert events[0]["type"] == "started" and events[-1]["type"] == "stopped"
