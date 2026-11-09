"""CLI: python3 -m morphix_vision --snapshot-url URL --interval 10 --evidence-dir DIR"""
from __future__ import annotations

import argparse
import glob
import os
import signal
import sys
from typing import List, Optional

from .analysis import parse_roi
from .detector import DetectorConfig
from .worker import Worker, http_fetch, replay_fetcher

DEFAULT_URL = "http://192.168.10.51:8080/?action=snapshot"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="morphix_vision", description="Morphix print guardian vision worker")
    p.add_argument("--snapshot-url", default=os.environ.get("MORPHIX_CAMERA_SNAPSHOT_URL", DEFAULT_URL))
    p.add_argument("--interval", type=float, default=10.0, help="seconds between snapshots")
    p.add_argument("--evidence-dir", default=None, help="where suspicious/confirmed JPEGs are saved")
    p.add_argument("--session", default=None, help="monitoring session id echoed in every event")
    p.add_argument("--roi", type=parse_roi, default=DetectorConfig.roi, help="bed region x,y,w,h as fractions")
    p.add_argument("--confirm", default="3/5", help="N/M: N suspicious of the last M frames confirms a failure")
    p.add_argument("--stall-seconds", type=float, default=DetectorConfig.stall_seconds,
                   help="camera-only stall check (0 = off; the app checks stalls from printer status)")
    p.add_argument("--spaghetti-ratio", type=float, default=DetectorConfig.spaghetti_ratio)
    p.add_argument("--detach-fraction", type=float, default=DetectorConfig.detach_fraction)
    p.add_argument("--frozen-after", type=int, default=DetectorConfig.frozen_after)
    p.add_argument("--camera-lost-after", type=int, default=DetectorConfig.camera_lost_after)
    p.add_argument("--heartbeat", type=float, default=60.0, help="seconds between heartbeat events")
    p.add_argument("--fetch-timeout", type=float, default=5.0)
    p.add_argument("--max-evidence", type=int, default=500)
    p.add_argument("--max-frames", type=int, default=None, help="stop after this many snapshots")
    p.add_argument("--replay-dir", default=None, help="analyse *.jpg files from a folder instead of the camera")
    p.add_argument("--exit-on-stdin-eof", action="store_true", help="exit when the parent closes stdin")
    p.add_argument("--no-stdin", action="store_true", help="do not read printer state from stdin")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        n, m = (int(x) for x in args.confirm.split("/"))
        if not (1 <= n <= m):
            raise ValueError
    except ValueError:
        print("--confirm must be N/M with 1 <= N <= M", file=sys.stderr)
        return 2
    cfg = DetectorConfig(
        roi=args.roi, confirm_n=n, confirm_m=m, stall_seconds=args.stall_seconds,
        spaghetti_ratio=args.spaghetti_ratio, detach_fraction=args.detach_fraction,
        frozen_after=args.frozen_after, camera_lost_after=args.camera_lost_after,
    )
    fetcher = http_fetch
    max_frames = args.max_frames
    interval = args.interval
    if args.replay_dir:
        paths = sorted(glob.glob(os.path.join(args.replay_dir, "*.jp*g")) + glob.glob(os.path.join(args.replay_dir, "*.png")))
        fetcher = replay_fetcher(paths)
        interval = 0.0
        max_frames = min(max_frames or len(paths), len(paths))
    worker = Worker(args.snapshot_url, cfg, interval=interval, evidence_dir=args.evidence_dir, session=args.session,
                    heartbeat_seconds=args.heartbeat, fetch_timeout=args.fetch_timeout,
                    max_evidence=args.max_evidence, fetcher=fetcher)
    signal.signal(signal.SIGTERM, lambda *_: worker.stop_event.set())
    signal.signal(signal.SIGINT, lambda *_: worker.stop_event.set())
    if not args.no_stdin:
        worker.start_stdin_reader(sys.stdin)
    if max_frames == 0:
        worker.emit({"type": "warning", "detail": "no frames to analyse"})
        return 0
    return worker.run(exit_on_stdin_eof=args.exit_on_stdin_eof, max_frames=max_frames)


if __name__ == "__main__":
    sys.exit(main())
