"""Empirical power estimate for Echelon Connect Sport bikes.

The bike does not report watts, so this model derives them from the two values
it does stream: cadence and resistance. It is an estimate, not a measurement.

The coefficients come from an empirical fit of magnetic drag plus drivetrain
friction:

    magnetic   = 0.0022 * e^(0.115 * resistance) * cadence^1.85
    drivetrain = 0.25 * cadence

Keep this file and its browser port in ``web/ble.js`` in sync; the codec tests
compare them.
"""

from __future__ import annotations

import math


def calculate_echelon_watts(
    cadence: float,
    resistance: int,
    gain: float = 1.0,
    match_official_app: bool = False,
) -> float:
    """Estimate cycling power (in watts) for an Echelon Connect Sport bike.

    Args:
        cadence: Pedaling speed in RPM (e.g. 80).
        resistance: Bike resistance level from 1 to 32.
        gain: Calibration multiplier for your specific bike (default 1.0).
            Use > 1.0 if your knob feels stiffer than average, < 1.0 if looser.
        match_official_app: If True, scales output by 1.20 to match the more
            generous readings of the official Echelon Fit app.

    Returns:
        Estimated power in watts, rounded to 1 decimal place.
    """
    if cadence <= 0:
        return 0.0

    # Clamp resistance to the Echelon Sport's valid 1-32 range.
    level = max(1, min(32, resistance))

    magnetic_watts = 0.0022 * math.exp(0.115 * level) * (cadence ** 1.85)
    drivetrain_watts = 0.25 * cadence

    watts = (magnetic_watts + drivetrain_watts) * gain

    if match_official_app:
        watts *= 1.20

    return round(watts, 1)
