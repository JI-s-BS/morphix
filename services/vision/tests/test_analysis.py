import numpy as np
import pytest

from morphix_vision import analysis
from synth import jpeg, scene


def frame(img):
    return analysis.prepare(analysis.decode_jpeg(jpeg(img)), (0.15, 0.2, 0.7, 0.75))


def test_parse_roi():
    assert analysis.parse_roi("0.1,0.2,0.5,0.6") == (0.1, 0.2, 0.5, 0.6)
    for bad in ["0.1,0.2,0.5", "0.6,0,0.6,0.5", "-0.1,0,0.5,0.5", "a,b,c,d", "0,0,0,0.5"]:
        with pytest.raises(ValueError):
            analysis.parse_roi(bad)


def test_decode_rejects_garbage():
    assert analysis.decode_jpeg(b"") is None
    assert analysis.decode_jpeg(b"not an image") is None


def test_prepare_resizes_and_crops():
    f = frame(scene(1))
    assert (f.width, f.height) == (640, 360)
    assert f.gray.shape == (180, 320)
    x0, y0, x1, y1 = analysis.roi_pixels(f.gray.shape, (0.15, 0.2, 0.7, 0.75))
    assert f.roi.shape == (y1 - y0, x1 - x0)


def test_spaghetti_raises_edge_and_thin_texture():
    clean, messy = frame(scene(1)), frame(scene(2, spaghetti=40))
    assert analysis.edge_density(messy.roi) > 2 * analysis.edge_density(clean.roi)
    assert analysis.thin_structure_density(messy.roi) > 2 * analysis.thin_structure_density(clean.roi)


def test_noise_is_not_change():
    a, b = frame(scene(1)), frame(scene(2))
    assert analysis.changed_fraction(a.roi, b.roi) < 0.003
    assert 0 < analysis.mean_abs_diff(a.gray, b.gray) < 5
    big = frame(scene(3, blob=True))
    assert analysis.changed_fraction(a.roi, big.roi) > 0.3
    assert analysis.changed_fraction(a.roi, np.zeros((2, 2), np.uint8)) == 1.0
