import unittest

from power import calculate_echelon_watts


class PowerModelTests(unittest.TestCase):
    def test_zero_cadence_is_zero_watts(self) -> None:
        self.assertEqual(calculate_echelon_watts(0, 12), 0.0)
        self.assertEqual(calculate_echelon_watts(-5, 12), 0.0)

    def test_known_outputs(self) -> None:
        # Values generated from the empirical model; guards accidental edits.
        self.assertEqual(calculate_echelon_watts(80, 12), 49.0)
        self.assertEqual(calculate_echelon_watts(60, 1), 19.8)
        self.assertEqual(calculate_echelon_watts(90, 32), 382.2)

    def test_more_effort_gives_more_watts(self) -> None:
        self.assertGreater(calculate_echelon_watts(90, 10), calculate_echelon_watts(80, 10))
        self.assertGreater(calculate_echelon_watts(80, 20), calculate_echelon_watts(80, 10))

    def test_resistance_is_clamped(self) -> None:
        self.assertEqual(calculate_echelon_watts(80, 0), calculate_echelon_watts(80, 1))
        self.assertEqual(calculate_echelon_watts(80, 99), calculate_echelon_watts(80, 32))

    def test_gain_and_official_app_scaling(self) -> None:
        base = calculate_echelon_watts(80, 12)
        self.assertAlmostEqual(calculate_echelon_watts(80, 12, gain=1.2), round(base * 1.2, 1))
        self.assertAlmostEqual(calculate_echelon_watts(80, 12, match_official_app=True),
                               round(base * 1.2, 1))
        self.assertAlmostEqual(
            calculate_echelon_watts(80, 12, gain=1.2, match_official_app=True),
            round(base * 1.44, 1),
        )


if __name__ == "__main__":
    unittest.main()
