import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from storage import WorkoutRecorder, WorkoutStore


class FakeTime:
    def __init__(self) -> None:
        self.clock_value = 1000.0
        self.now_value = datetime(2026, 11, 24, 8, 0, tzinfo=timezone.utc)

    def clock(self) -> float:
        return self.clock_value

    def now(self) -> datetime:
        return self.now_value

    def advance(self, seconds: float) -> None:
        self.clock_value += seconds
        self.now_value += timedelta(seconds=seconds)


class StorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = WorkoutStore(Path(self.tmp.name) / "history.db")

    def tearDown(self) -> None:
        self.store.close()
        self.tmp.cleanup()

    def test_create_list_and_delete(self) -> None:
        started = datetime(2026, 11, 24, 7, 30, tzinfo=timezone.utc)
        workout_id = self.store.create_workout(started, source="manual")
        self.store.finish_workout(workout_id, {
            "ended_at": "2026-11-24T08:00:00+00:00",
            "duration_seconds": 1800,
            "distance_km": 12.34,
            "avg_cadence": 72.4,
            "max_cadence": 94,
            "avg_resistance": 8.5,
            "sample_count": 120,
        })

        listing = self.store.list_workouts()
        self.assertEqual(listing["total"], 1)
        workout = listing["workouts"][0]
        self.assertEqual(workout["id"], workout_id)
        self.assertEqual(workout["duration_seconds"], 1800)
        self.assertEqual(workout["distance_km"], 12.34)
        self.assertEqual(workout["source"], "manual")

        detail = self.store.get_workout(workout_id)
        self.assertIsNotNone(detail)
        self.assertEqual(detail["samples"], [])

        self.assertTrue(self.store.delete_workout(workout_id))
        self.assertEqual(self.store.list_workouts()["total"], 0)

    def test_stats_fill_missing_days_and_totals(self) -> None:
        today = datetime.now().astimezone().replace(hour=9, minute=0, second=0, microsecond=0)
        yesterday = today - timedelta(days=1)
        for started, minutes, distance in ((today, 40, 15.0), (yesterday, 20, 8.0)):
            workout_id = self.store.create_workout(started)
            self.store.finish_workout(workout_id, {
                "ended_at": started.isoformat(),
                "duration_seconds": minutes * 60,
                "distance_km": distance,
                "avg_cadence": 70,
                "max_cadence": 90,
                "avg_resistance": 10,
                "sample_count": 50,
            })

        stats = self.store.stats(days=7)
        self.assertEqual(len(stats["daily"]), 7)
        self.assertEqual(stats["totals"]["today"]["minutes"], 40)
        self.assertEqual(stats["totals"]["today"]["distance_km"], 15)
        self.assertEqual(stats["totals"]["week"]["workouts"], 2)
        self.assertEqual(stats["totals"]["week"]["distance_km"], 23)
        self.assertEqual(stats["streak_days"], 2)
        self.assertEqual(stats["bests"]["farthest"]["distance_km"], 15)

    def test_recorder_auto_start_and_save(self) -> None:
        fake = FakeTime()
        recorder = WorkoutRecorder(self.store, now=fake.now, clock=fake.clock)

        self.assertIsNone(recorder.handle({"cadence_rpm": 0, "distance_km": 0}))
        self.assertFalse(recorder.active)

        event = recorder.handle({
            "cadence_rpm": 65, "speed_kph_estimate": 24.4, "resistance": 7,
            "distance_km": 0.1, "elapsed_seconds": 1,
        })
        self.assertEqual(event, "started")
        self.assertTrue(recorder.active)

        for step in range(1, 8):
            fake.advance(5)
            recorder.handle({
                "cadence_rpm": 60 + step, "speed_kph_estimate": 23.0,
                "resistance": 8, "distance_km": 0.1 + step * 0.05,
                "elapsed_seconds": 1 + step * 5,
            })

        summary = recorder.stop()
        self.assertFalse(recorder.active)
        self.assertIsNotNone(summary)
        self.assertEqual(summary["duration_seconds"], 35)
        self.assertAlmostEqual(summary["distance_km"], 0.35)
        self.assertGreaterEqual(summary["sample_count"], 2)
        self.assertIsNotNone(summary["avg_cadence"])

        stored = self.store.get_workout(summary["id"])
        self.assertIsNotNone(stored)
        self.assertGreaterEqual(len(stored["samples"]), 2)
        self.assertEqual(stored["ended_at"] is None, False)

    def test_recorder_discards_noise(self) -> None:
        fake = FakeTime()
        recorder = WorkoutRecorder(self.store, now=fake.now, clock=fake.clock)
        recorder.start(source="manual")
        fake.advance(2)
        summary = recorder.stop()
        self.assertIsNone(summary)
        self.assertEqual(self.store.list_workouts()["total"], 0)

    def test_recorder_pauses_auto_start(self) -> None:
        fake = FakeTime()
        recorder = WorkoutRecorder(self.store, now=fake.now, clock=fake.clock)
        recorder.auto_paused = True
        metric = {"cadence_rpm": 70, "distance_km": 1.0}
        self.assertIsNone(recorder.handle(metric))
        self.assertFalse(recorder.active)
        recorder.auto_paused = False
        self.assertEqual(recorder.handle(metric), "started")
        recorder.stop()


if __name__ == "__main__":
    unittest.main()
