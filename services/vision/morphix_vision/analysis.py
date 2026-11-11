"""Pure image measurements. No state, no I/O: every function takes arrays and
returns numbers, so the detector logic can be tested with synthetic frames."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

Roi = Tuple[float, float, float, float]  # x, y, w, h as fractions of the frame


@dataclass
class Frame:
    """A decoded snapshot reduced to what the checks need."""

    gray: np.ndarray  # full frame, grayscale, resized to the analysis width
    roi: np.ndarray  # bed region of interest, blurred grayscale
    width: int  # original snapshot size
    height: int


def decode_jpeg(data: bytes) -> Optional[np.ndarray]:
    """Decode JPEG/PNG bytes to a BGR image, or None if the bytes are not an image."""
    if not data:
        return None
    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    return img


def parse_roi(text: str) -> Roi:
    """Parse "x,y,w,h" fractions (0..1). Raises ValueError on bad input."""
    parts = [float(p) for p in text.split(",")]
    if len(parts) != 4:
        raise ValueError("ROI must be x,y,w,h")
    x, y, w, h = parts
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1 and x + w <= 1.0001 and y + h <= 1.0001):
        raise ValueError(f"ROI out of range: {text}")
    return (x, y, w, h)


def roi_pixels(shape: Tuple[int, int], roi: Roi) -> Tuple[int, int, int, int]:
    """Convert fractional ROI to integer x0, y0, x1, y1 for an image of (h, w)."""
    h, w = shape[:2]
    x, y, rw, rh = roi
    x0, y0 = int(round(x * w)), int(round(y * h))
    x1, y1 = min(w, max(x0 + 1, int(round((x + rw) * w)))), min(h, max(y0 + 1, int(round((y + rh) * h))))
    return x0, y0, x1, y1


def prepare(img: np.ndarray, roi: Roi, analysis_width: int = 320) -> Frame:
    """Resize to a small working size (fast on small boards) and cut out the ROI."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    if w > analysis_width:
        scale = analysis_width / float(w)
        gray = cv2.resize(gray, (analysis_width, max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)
    x0, y0, x1, y1 = roi_pixels(gray.shape, roi)
    region = cv2.GaussianBlur(gray[y0:y1, x0:x1], (3, 3), 0)
    return Frame(gray=gray, roi=region, width=w, height=h)


def brightness_stats(gray: np.ndarray) -> Tuple[float, float]:
    """Mean and standard deviation of the grayscale frame."""
    mean, std = cv2.meanStdDev(gray)
    return float(mean[0][0]), float(std[0][0])


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    """Average absolute pixel difference (0..255); inf if shapes differ."""
    if a.shape != b.shape:
        return float("inf")
    return float(np.mean(cv2.absdiff(a, b)))


def changed_fraction(a: np.ndarray, b: np.ndarray, pixel_threshold: int = 25) -> float:
    """Fraction of pixels whose value changed by more than pixel_threshold."""
    if a.shape != b.shape:
        return 1.0
    diff = cv2.absdiff(a, b)
    return float(np.count_nonzero(diff > pixel_threshold)) / float(diff.size)


def edge_density(region: np.ndarray, low: int = 50, high: int = 150) -> float:
    """Fraction of ROI pixels that are Canny edges. Loose filament ("spaghetti")
    shows up as a sudden rise of thin edges/texture in the bed region."""
    edges = cv2.Canny(region, low, high)
    return float(np.count_nonzero(edges)) / float(edges.size)


def thin_structure_density(region: np.ndarray, threshold: int = 18) -> float:
    """Fraction of pixels in thin bright-or-dark strands (morphological top-hat
    and black-hat with a small kernel). Thick objects such as the print itself
    or the nozzle carriage barely respond; 1-3 px strands do."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    tophat = cv2.morphologyEx(region, cv2.MORPH_TOPHAT, kernel)
    blackhat = cv2.morphologyEx(region, cv2.MORPH_BLACKHAT, kernel)
    strands = np.maximum(tophat, blackhat)
    return float(np.count_nonzero(strands > threshold)) / float(strands.size)
