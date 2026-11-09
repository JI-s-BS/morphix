"""Polling loop: fetch a snapshot, run the detector, print JSON lines.

stdout carries ONLY newline-delimited JSON events (one object per line).
Diagnostics go to stderr. stdin accepts JSON lines:
  {"type": "printer_state", "machine": "BUILDING_FROM_SD", "progress": 42}
  {"type": "reset_baseline"}
  {"type": "shutdown"}
A bare PrinterStatus object (anything with a "machine" key) is also accepted.
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from typing import Callable, Dict, Iterator, List, Optional, TextIO

from .detector import Detector, DetectorConfig, Event

PROTOCOL_VERSION = 1
Fetcher = Callable[[str, float], bytes]


def http_fetch(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "morphix-vision/1", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed LAN camera URL
        if resp.status != 200:
            raise IOError(f"HTTP {resp.status}")
        return resp.read(8 * 1024 * 1024)


def iso_now(t: Optional[float] = None) -> str:
    return datetime.fromtimestamp(time.time() if t is None else t, tz=timezone.utc).isoformat(timespec="milliseconds")


class EvidenceStore:
    """Writes JPEG evidence into one directory with a file-count cap."""

    def __init__(self, directory: Optional[str], max_files: int = 500, clock: Callable[[], float] = time.time):
        self.dir = os.path.expanduser(directory) if directory else None
        self.max_files = max_files
        self.count = 0
        self.clock = clock
        if self.dir:
            os.makedirs(self.dir, exist_ok=True)

    def save(self, data: bytes, label: str) -> Optional[str]:
        if not self.dir or self.count >= self.max_files:
            return None
        self.count += 1
        stamp = datetime.fromtimestamp(self.clock(), tz=timezone.utc).strftime("%Y%m%dT%H%M%S")
        safe = "".join(c if c.isalnum() or c in "+_-" else "_" for c in label)
        path = os.path.join(self.dir, f"{stamp}_{self.count:04d}_{safe}.jpg")
        with open(path, "wb") as fh:
            fh.write(data)
        return path


class Worker:
    def __init__(
        self,
        snapshot_url: str,
        detector_config: DetectorConfig,
        interval: float = 10.0,
        evidence_dir: Optional[str] = None,
        session: Optional[str] = None,
        heartbeat_seconds: float = 60.0,
        fetch_timeout: float = 5.0,
        max_evidence: int = 500,
        fetcher: Fetcher = http_fetch,
        out: Optional[TextIO] = None,
        clock: Callable[[], float] = time.time,
    ):
        self.url = snapshot_url
        self.interval = interval
        self.session = session
        self.heartbeat_seconds = heartbeat_seconds
        self.fetch_timeout = fetch_timeout
        self.fetcher = fetcher
        self.out = out if out is not None else sys.stdout
        self.clock = clock
        self.evidence = EvidenceStore(evidence_dir, max_evidence, clock)
        self.detector = Detector(detector_config, self.evidence.save)
        self.inbox: "queue.Queue[Optional[str]]" = queue.Queue()
        self.stop_event = threading.Event()
        self.seq = 0
        self.started_at = clock()
        self.last_heartbeat = self.started_at
        self.stdin_closed = False

    # ----- output -------------------------------------------------------
    def emit(self, event: Event) -> None:
        self.seq += 1
        now = self.clock()
        record = {"v": PROTOCOL_VERSION, "seq": self.seq, "ts": iso_now(now), "session": self.session, **event}
        self.out.write(json.dumps(record, separators=(",", ":")) + "\n")
        self.out.flush()

    # ----- input --------------------------------------------------------
    def start_stdin_reader(self, stream: TextIO) -> None:
        def run() -> None:
            for line in stream:
                self.inbox.put(line)
            self.inbox.put(None)  # EOF marker

        threading.Thread(target=run, name="stdin-reader", daemon=True).start()

    def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            msg = json.loads(line)
        except ValueError:
            self.emit({"type": "warning", "detail": "ignored non-JSON stdin line"})
            return
        if not isinstance(msg, dict):
            return
        kind = msg.get("type")
        if kind == "shutdown":
            self.stop_event.set()
        elif kind == "reset_baseline":
            for e in self.detector.reset_baseline():
                self.emit(e)
        elif kind == "printer_state" or "machine" in msg or "printing" in msg:
            state = msg.get("status") if isinstance(msg.get("status"), dict) else msg
            for e in self.detector.update_printer(state):
                self.emit(e)
        else:
            self.emit({"type": "warning", "detail": f"unknown stdin message type: {kind!r}"})

    def drain_inbox(self) -> None:
        while True:
            try:
                line = self.inbox.get_nowait()
            except queue.Empty:
                return
            if line is None:
                self.stdin_closed = True
            else:
                self.handle_line(line)

    # ----- loop ---------------------------------------------------------
    def step(self) -> None:
        """One poll: drain stdin, fetch, analyse, emit; heartbeat when due."""
        self.drain_inbox()
        try:
            data: Optional[bytes] = self.fetcher(self.url, self.fetch_timeout)
            error = None
        except Exception as exc:  # network errors, timeouts, HTTP errors
            data, error = None, f"{type(exc).__name__}: {exc}"
        for e in self.detector.process(data, self.clock(), error):
            self.emit(e)
        now = self.clock()
        if now - self.last_heartbeat >= self.heartbeat_seconds:
            self.heartbeat()

    def heartbeat(self) -> None:
        self.last_heartbeat = self.clock()
        self.emit({
            "type": "heartbeat", "frames": self.detector.frames, "camera": self.detector.camera,
            "printer_state": self.detector.printer_state, "detection_active": self.detector.detection_active,
            "uptime_s": round(self.last_heartbeat - self.started_at, 1), "evidence_saved": self.evidence.count,
        })

    def run(self, exit_on_stdin_eof: bool = False, max_frames: Optional[int] = None) -> int:
        cfg = self.detector.cfg
        self.emit({"type": "started", "pid": os.getpid(), "snapshot_url": self.url, "interval": self.interval,
                   "evidence_dir": self.evidence.dir, "roi": list(cfg.roi),
                   "confirm": {"n": cfg.confirm_n, "m": cfg.confirm_m}})
        frames = 0
        while not self.stop_event.is_set():
            started = self.clock()
            self.step()
            frames += 1
            if exit_on_stdin_eof and self.stdin_closed:
                break
            if max_frames is not None and frames >= max_frames:
                break
            self.stop_event.wait(max(0.0, self.interval - (self.clock() - started)))
        self.drain_inbox()
        self.emit({"type": "stopped", "frames": self.detector.frames})
        return 0


def replay_fetcher(paths: List[str]) -> Fetcher:
    """Serve files in order (for testing recorded snapshots); raises at the end."""
    it: Iterator[str] = iter(paths)

    def fetch(_url: str, _timeout: float) -> bytes:
        path = next(it)
        with open(path, "rb") as fh:
            return fh.read()

    return fetch
