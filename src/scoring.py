"""Original project's transparent scoring hypothesis, using restored sensor fields."""

from __future__ import annotations

from typing import Final

import numpy as np
from numpy.typing import NDArray

FEATURES: Final = (
    "lux_max", "lux_avg", "lux_min", "noise_max", "noise_avg", "noise_min",
    "noise_range_proxy", "cctv", "light", "security",
)


def components(x: NDArray[np.float64]) -> NDArray[np.float64]:
    """Return signed point contributions in the documented six-component order."""
    lux, noise = x[:, 1], x[:, 4]
    illumination = np.clip(100 - lux / 3, 0, 100)
    noise_risk = np.where(
        noise < 40, np.clip(100 - 2.5 * noise, 0, 100),
        np.where(noise <= 70, (noise - 40) * 20 / 30,
                 np.minimum(100, 20 + (noise - 70) * 80 / 40)),
    )
    variation = np.where(
        noise == 0, 50, np.clip(50 - 100 * x[:, 6] / (noise + 1e-5), 0, 100),
    )
    return np.column_stack((
        -0.30 * illumination, -0.15 * noise_risk, -0.10 * variation,
        0.25 * np.minimum(100, x[:, 7] * 25),
        0.15 * np.minimum(100, x[:, 8] * 20),
        0.05 * np.minimum(100, x[:, 9] * 30),
    ))


def safety_index(x: NDArray[np.float64]) -> NDArray[np.float64]:
    """Compute the project index; this target is generated from the same inputs."""
    return np.clip(100 + components(x).sum(axis=1), 0, 100)
