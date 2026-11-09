import os

from morphix_vision.detector import Detector, DetectorConfig
from morphix_vision.worker import EvidenceStore
from synth import black, blank, jpeg, scene

PRINTING = {"type": "printer_state", "machine": "BUILDING_FROM_SD"}


def make(tmp_path=None, **overrides):
    store = EvidenceStore(str(tmp_path)) if tmp_path else None
    det = Detector(DetectorConfig(**overrides), store.save if store else None)
    return det


class Run:
    """Feeds frames with a fake clock and collects all events."""

    def __init__(self, det, step=10.0):
        self.det, self.t, self.step, self.events = det, 1000.0, step, []

    def feed(self, data, error=None):
        out = self.det.process(data, self.t, error)
        self.t += self.step
        self.events.extend(out)
        return out

    def types(self, kind=None):
        return [e["type"] for e in self.events if kind is None or e.get("kind") == kind]

    def of(self, type_):
        return [e for e in self.events if e["type"] == type_]


def normal_print(run, frames, start_seed=0):
    """Head moving, part slowly growing: what a healthy print looks like."""
    for i in range(frames):
        run.feed(jpeg(scene(start_seed + i, part_h=40 + i, head_x=100 + (i * 37) % 380)))


def test_healthy_print_raises_nothing():
    run = Run(make())
    run.det.update_printer(PRINTING)
    normal_print(run, 30)
    assert run.types()[0] == "camera_ok"
    assert len(run.of("observation")) == 30
    assert not run.of("possible_failure") and not run.of("confirmed_failure")
    obs = run.of("observation")[-1]
    assert obs["detection_active"] and obs["warmed_up"] and obs["printer_state"] == "BUILDING_FROM_SD"
    assert set(obs["metrics"]) >= {"motion", "edge_density", "spaghetti_score", "roi_change", "still_seconds"}


def test_spaghetti_needs_n_of_m_frames_and_saves_evidence(tmp_path):
    run = Run(make(tmp_path))
    normal_print(run, 6)
    run.feed(jpeg(scene(100, spaghetti=40, head_x=200)))
    assert run.types("spaghetti") == ["possible_failure"]
    possible = run.of("possible_failure")[0]
    assert possible["window"] == {"hits": 1, "of": 5, "need": 3, "size": 5}
    assert possible["evidence"] and os.path.exists(possible["evidence"])
    run.feed(jpeg(scene(101, spaghetti=40, head_x=250)))
    assert not run.of("confirmed_failure")
    run.feed(jpeg(scene(102, spaghetti=45, head_x=300)))
    confirmed = run.of("confirmed_failure")
    assert len(confirmed) == 1 and confirmed[0]["kind"] == "spaghetti"
    assert "confirmed_spaghetti" in confirmed[0]["evidence"] and os.path.exists(confirmed[0]["evidence"])
    assert len(confirmed[0]["evidence_frames"]) == 3
    # stays latched: no duplicate confirmations while it persists
    run.feed(jpeg(scene(103, spaghetti=45)))
    assert len(run.of("confirmed_failure")) == 1


def test_single_glitch_is_only_possible_then_clears():
    run = Run(make())
    normal_print(run, 6)
    run.feed(jpeg(scene(200, spaghetti=40)))
    normal_print(run, 6, start_seed=300)
    assert run.types("spaghetti") == ["possible_failure", "suspicion_cleared"]
    cleared = [e for e in run.of("suspicion_cleared")][0]
    assert cleared["was_confirmed"] is False


def test_detachment_big_local_change():
    run = Run(make())
    normal_print(run, 6)
    for i in range(3):
        run.feed(jpeg(scene(400 + i, blob=True)))
    assert run.types("detachment") == ["possible_failure", "confirmed_failure"]


def test_lighting_change_is_not_detachment():
    run = Run(make())
    normal_print(run, 6)
    for i in range(5):
        run.feed(jpeg(scene(500 + i, brightness=60)))
    assert not run.of("possible_failure")


def test_stalled_only_while_printing():
    run = Run(make(stall_seconds=300), step=60.0)
    for i in range(10):  # printer state unknown: no stall check
        run.feed(jpeg(scene(600 + i)))
    assert not run.of("possible_failure")
    run.det.update_printer(PRINTING)
    for i in range(10):
        run.feed(jpeg(scene(700 + i)))
    assert run.types("stalled") == ["possible_failure", "confirmed_failure"]
    assert run.of("confirmed_failure")[0]["score"] >= 300
    # printer reports PAUSED: checks stop and the alert clears
    cleared = run.det.update_printer({"machine": "PAUSED"})
    assert [e["type"] for e in cleared] == ["suspicion_cleared"] * 1
    assert cleared[0]["reason"] == "printer_not_printing"


def test_no_failure_checks_when_printer_idle():
    run = Run(make())
    run.det.update_printer({"machine": "READY"})
    normal_print(run, 6)
    for i in range(5):
        run.feed(jpeg(scene(800 + i, spaghetti=40)))
    assert not run.of("possible_failure")
    assert run.of("observation")[-1]["detection_active"] is False


def test_printing_flag_overrides_machine():
    det = make()
    det.update_printer({"printing": True})
    assert det.printing and det.detection_active
    det.update_printer({"machine": "building_from_sd"})
    assert det.printing


def test_camera_lost_and_recovered():
    run = Run(make())
    normal_print(run, 3)
    for _ in range(4):
        run.feed(None, "URLError: timed out")
    lost = run.of("camera_lost")
    assert len(lost) == 1 and lost[0]["reason"] == "fetch_error" and lost[0]["consecutive_failures"] == 3
    assert len(run.of("frame_error")) == 3
    run.feed(jpeg(scene(900)))
    assert run.of("camera_ok")[-1]["recovered_from"] == "lost"


def test_black_blank_and_garbage_frames():
    for data, reason in [(black(), "black_frame"), (blank(), "blank_frame"), (b"<html>error</html>", "decode_error")]:
        run = Run(make())
        for _ in range(3):
            run.feed(data)
        assert run.of("camera_lost")[0]["reason"] == reason
        assert not run.of("observation")


def test_frozen_camera_detected_once_and_suppresses_checks():
    run = Run(make())
    normal_print(run, 4)
    stuck = jpeg(scene(1000, spaghetti=40))
    for _ in range(10):
        run.feed(stuck)
    frozen = run.of("frozen_frame")
    assert len(frozen) == 1 and frozen[0]["identical_frames"] == 7
    run.feed(jpeg(scene(1001)))
    assert run.of("camera_ok")[-1]["recovered_from"] == "frozen"
    # the stuck frame looked like spaghetti, but repeats do not confirm and freezing clears it
    assert not run.of("confirmed_failure")
    assert run.types("spaghetti") == ["possible_failure", "suspicion_cleared"]
    assert run.of("suspicion_cleared")[0]["reason"] == "camera_frozen"
    assert any(e.get("duplicate_frame") for e in run.of("observation"))


def test_reset_baseline_clears_latched_alerts():
    run = Run(make())
    normal_print(run, 6)
    for i in range(3):
        run.feed(jpeg(scene(1100 + i, spaghetti=40)))
    assert run.of("confirmed_failure")
    out = run.det.reset_baseline()
    assert out[0]["type"] == "suspicion_cleared" and out[0]["reason"] == "baseline_reset"


# ----- reliability on the real printer -------------------------------------------

def test_movemode_paused_counts_as_paused():
    run = Run(make())
    run.det.update_printer(PRINTING)
    normal_print(run, 6)
    for i in range(3):
        run.feed(jpeg(scene(1200 + i, spaghetti=40)))
    assert run.of("confirmed_failure")
    # QD330: MachineStatus stays BUILDING_FROM_SD, MoveMode says PAUSED
    out = run.det.update_printer({"machine": "BUILDING_FROM_SD", "moveMode": "PAUSED"})
    assert run.det.paused and not run.det.printing and not run.det.detection_active
    assert [e["reason"] for e in out] == ["printer_not_printing"]


def test_printer_offline_switches_checks_off():
    det = make()
    det.update_printer(PRINTING)
    assert det.detection_active
    det.update_printer({"online": False, "machine": "OFFLINE"})
    assert not det.detection_active


def test_camera_stall_is_off_by_default_heating_is_not_a_stall():
    # heating up: nothing moves for 20 minutes while the printer says BUILDING_FROM_SD
    run = Run(make(), step=60.0)
    run.det.update_printer(PRINTING)
    for i in range(20):
        run.feed(jpeg(scene(1300 + i)))
    assert not run.of("possible_failure")


def test_new_print_relearns_the_bed():
    run = Run(make())
    run.det.update_printer(PRINTING)
    normal_print(run, 8)
    run.det.update_printer({"machine": "READY"})  # print finished
    run.det.update_printer(PRINTING)  # next print starts on a bed that looks different
    for i in range(8):
        run.feed(jpeg(scene(1400 + i, blob=True)))
    assert not run.of("possible_failure")
    assert run.of("observation")[-1]["warmed_up"] is True


def test_resume_after_pause_keeps_the_baseline():
    run = Run(make())
    run.det.update_printer(PRINTING)
    normal_print(run, 8)
    run.det.update_printer({"machine": "BUILDING_FROM_SD", "moveMode": "PAUSED"})
    run.det.update_printer(PRINTING)  # resumed, not a new job: a ripped-off part is still caught
    for i in range(3):
        run.feed(jpeg(scene(1500 + i, blob=True)))
    assert run.types("detachment") == ["possible_failure", "confirmed_failure"]


def test_camera_outage_is_camera_down_not_a_failure():
    run = Run(make())
    run.det.update_printer(PRINTING)
    normal_print(run, 8)
    for _ in range(5):
        run.feed(None, "URLError: [Errno 113] No route to host")
    # the camera comes back looking different (bumped / new exposure)
    for i in range(8):
        run.feed(jpeg(scene(1600 + i, blob=True)))
    assert len(run.of("camera_lost")) == 1
    assert run.of("camera_ok")[-1]["recovered_from"] == "lost"
    assert not run.of("possible_failure") and not run.of("confirmed_failure")


def test_lights_switched_on_is_not_spaghetti():
    run = Run(make())
    run.det.update_printer(PRINTING)
    normal_print(run, 8)
    for i in range(8):
        run.feed(jpeg(scene(1700 + i, brightness=70, head_x=120 + i * 30)))
    assert not run.of("possible_failure")
    assert any(o.get("scene_change") for o in run.of("observation"))


def test_slowly_growing_spaghetti_is_still_confirmed():
    run = Run(make())
    run.det.update_printer(PRINTING)
    normal_print(run, 8)
    # one more strand every 3 frames (30 s): without the learning cap the baseline
    # follows it up and this is never flagged
    for i in range(120):
        run.feed(jpeg(scene(1800 + i, spaghetti=min(40, 1 + i // 3), head_x=100 + (i * 37) % 380)))
    assert "confirmed_failure" in run.types("spaghetti")


def test_confirmation_needs_several_frames():
    run = Run(make())
    run.det.update_printer(PRINTING)
    normal_print(run, 8)
    # two bad frames, separated by good ones, never confirm
    for seed in (1900, 1910):
        run.feed(jpeg(scene(seed, spaghetti=40)))
        normal_print(run, 3, start_seed=seed + 1)
    assert not run.of("confirmed_failure")
