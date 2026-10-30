"""Boundary examples independent of the implementation's intermediate arrays."""

import numpy as np

from scoring import components, safety_index


def test_dark_quiet_location_without_facilities():
    # Given: zero light, 40 dB, no range or facilities.
    x = np.array([[0, 0, 0, 40, 40, 40, 0, 0, 0, 0]], dtype=float)
    # When: applying the project's formula.
    result = safety_index(x)
    # Then: 100 - 30 illumination - 5 range-proxy burden.
    np.testing.assert_allclose(result, [65])


def test_bright_location_with_saturated_facility_bonus():
    # Given: 300 lux, 40 dB, facilities above all saturation thresholds.
    x = np.array([[300, 300, 300, 40, 40, 40, 0, 10, 10, 10]], dtype=float)
    # When: applying the formula.
    result = safety_index(x)
    # Then: the total is clipped to 100.
    np.testing.assert_allclose(result, [100])


def test_noise_piecewise_boundaries():
    # Given: 300 lux, no facilities, no noise range, three noise boundary values.
    x = np.array([[300, 300, 300, n, n, n, 0, 0, 0, 0] for n in [40, 70, 110]], dtype=float)
    # When: applying the formula.
    result = safety_index(x)
    # Then: noise penalties 0, 3, 15 plus the constant 5-point range burden.
    np.testing.assert_allclose(result, [95, 92, 80])


def test_facility_counts_stop_increasing_after_saturation():
    # Given: count values at and beyond cctv/light/security saturation.
    x = np.array([[0, 0, 0, 40, 40, 40, 0, 4, 5, 4],
                  [0, 0, 0, 40, 40, 40, 0, 100, 100, 221]], dtype=float)
    # When: scoring both observations.
    result = components(x)[:, 3:]
    # Then: all three facility contributions saturate before final clipping.
    np.testing.assert_allclose(result, [[25, 15, 5], [25, 15, 5]])
