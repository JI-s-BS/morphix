"""Synthetic print-chamber snapshots: grey walls, a blue bed, a printed block,
sensor noise (so consecutive frames are never pixel-identical), optional
spaghetti strands, a moved/detached part, or a black/blank/frozen camera."""
from __future__ import annotations

from typing import Optional

import cv2
import numpy as np

W, H = 640, 360


def scene(seed: int, part_x: int = 300, part_h: int = 60, spaghetti: int = 0, head_x: Optional[int] = None,
          brightness: int = 0, blob: bool = False) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = np.full((H, W, 3), (95, 100, 105), np.uint8)
    cv2.rectangle(img, (0, 0), (W, 40), (60, 60, 60), -1)  # top frame
    cv2.rectangle(img, (90, 90), (550, 340), (170, 90, 30), -1)  # blue build plate (BGR)
    cv2.line(img, (20, 60), (620, 60), (200, 200, 200), 3)  # rail
    cv2.rectangle(img, (part_x, 300 - part_h), (part_x + 70, 300), (40, 200, 230), -1)  # printed part
    if blob:  # the part ripped off the bed and dragged across it, or the plate shifted
        cv2.rectangle(img, (150, 150), (500, 330), (60, 120, 160), -1)
    if head_x is not None:
        cv2.rectangle(img, (head_x, 70), (head_x + 50, 120), (30, 30, 30), -1)  # print head
    for _ in range(spaghetti):
        pts = np.cumsum(rng.integers(-14, 15, size=(12, 2)), axis=0) + rng.integers([120, 120], [520, 320])
        cv2.polylines(img, [pts.astype(np.int32)], False, (230, 230, 230), 1)
    noisy = img.astype(np.int16) + rng.normal(0, 2.5, img.shape).astype(np.int16) + brightness
    return np.clip(noisy, 0, 255).astype(np.uint8)


def jpeg(img: np.ndarray, quality: int = 90) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return buf.tobytes()


def black() -> bytes:
    return jpeg(np.zeros((H, W, 3), np.uint8))


def blank() -> bytes:
    return jpeg(np.full((H, W, 3), 128, np.uint8))
