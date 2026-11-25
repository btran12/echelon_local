"""Persistent workout history for the local Echelon dashboard.

A workout is recorded automatically while the bike is streaming telemetry and
is finalized on disconnect (or when the rider presses Stop). Samples are kept
at a 5 second resolution, which is enough for a useful session chart without
letting the database grow quickly.

Storage is a single SQLite file (``data/echelon.db`` by default), so history
survives server restarts and can be copied/backed up as one file.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

SAMPLE_INTERVAL_SECONDS = 5.0
FLUSH_INTERVAL_SECONDS = 30.0
# Sessions shorter than this are treated as noise (e.g. a single test packet).
MIN_TRACKED_SECONDS = 10
MIN_TRACKED_SAMPLES = 2

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS workouts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    date              TEXT NOT NULL,
    duration_seconds  INTEGER NOT NULL DEFAULT 0,
    distance_km       REAL NOT NULL DEFAULT 0,
    avg_cadence       REAL,
    max_cadence       REAL,
    avg_speed         REAL,
    max_speed         REAL,
    avg_resistance    REAL,
    max_resistance    REAL,
    sample_count      INTEGER NOT NULL DEFAULT 0,
    source            TEXT NOT NULL DEFAULT 'auto'
);
CREATE TABLE IF NOT EXISTS workout_samples (
    workout_id  INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    t           INTEGER NOT NULL,
    cadence     REAL,
    speed       REAL,
    resistance  REAL,
    distance    REAL
);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);
CREATE INDEX IF NOT EXISTS idx_samples_workout ON workout_samples(workout_id, t);
"""

SUMMARY_COLUMNS = (
    "id", "started_at", "ended_at", "date", "duration_seconds", "distance_km",
    "avg_cadence", "max_cadence", "avg_speed", "max_speed", "avg_resistance",
    "max_resistance", "sample_count", "source",
)


def _row_to_workout(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    workout = {key: row[key] for key in SUMMARY_COLUMNS}
    workout["duration_seconds"] = int(workout["duration_seconds"] or 0)
    workout["distance_km"] = round(float(workout["distance_km"] or 0.0), 2)
    for key in ("avg_cadence", "max_cadence", "avg_speed", "max_speed",
                "avg_resistance", "max_resistance"):
        if workout[key] is not None:
            workout[key] = round(float(workout[key]), 1)
    return workout


class WorkoutStore:
    """Small thread-safe wrapper around the SQLite history database."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()
        self._repair_stale_workouts()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def _cursor(self):
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            finally:
                cur.close()

    def _repair_stale_workouts(self) -> None:
        """Close rows left unfinished by a crash, keeping their checkpoints."""
        with self._cursor() as cur:
            cur.execute(
                "SELECT id, started_at, duration_seconds FROM workouts WHERE ended_at IS NULL"
            )
            for row in cur.fetchall():
                started = datetime.fromisoformat(row["started_at"])
                ended = started + timedelta(seconds=int(row["duration_seconds"] or 0))
                cur.execute(
                    "UPDATE workouts SET ended_at = ? WHERE id = ?",
                    (ended.isoformat(timespec="seconds"), row["id"]),
                )

    # ------------------------------------------------------------------ writes
    def create_workout(self, started_at: datetime, source: str = "auto") -> int:
        with self._cursor() as cur:
            cur.execute(
                "INSERT INTO workouts (started_at, date, source) VALUES (?, ?, ?)",
                (started_at.isoformat(timespec="seconds"),
                 started_at.date().isoformat(), source),
            )
            return int(cur.lastrowid)

    def update_workout(self, workout_id: int, fields: dict[str, Any]) -> None:
        allowed = {
            "ended_at", "duration_seconds", "distance_km", "avg_cadence",
            "max_cadence", "avg_speed", "max_speed", "avg_resistance",
            "max_resistance", "sample_count",
        }
        values = {k: v for k, v in fields.items() if k in allowed}
        if not values:
            return
        assignments = ", ".join(f"{key} = ?" for key in values)
        with self._cursor() as cur:
            cur.execute(
                f"UPDATE workouts SET {assignments} WHERE id = ?",
                (*values.values(), workout_id),
            )

    def append_samples(self, workout_id: int, samples: list[dict[str, Any]]) -> None:
        if not samples:
            return
        rows = [
            (workout_id, sample["t"], sample.get("cadence"), sample.get("speed"),
             sample.get("resistance"), sample.get("distance"))
            for sample in samples
        ]
        with self._cursor() as cur:
            cur.executemany(
                "INSERT INTO workout_samples (workout_id, t, cadence, speed, resistance, distance) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )

    def finish_workout(self, workout_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
        self.update_workout(workout_id, fields)
        return self.get_workout(workout_id, include_samples=False)

    def delete_workout(self, workout_id: int) -> bool:
        with self._cursor() as cur:
            cur.execute("DELETE FROM workout_samples WHERE workout_id = ?", (workout_id,))
            cur.execute("DELETE FROM workouts WHERE id = ?", (workout_id,))
            return cur.rowcount > 0

    # ------------------------------------------------------------------- reads
    def get_workout(self, workout_id: int, include_samples: bool = True) -> dict[str, Any] | None:
        with self._cursor() as cur:
            cur.execute("SELECT * FROM workouts WHERE id = ?", (workout_id,))
            workout = _row_to_workout(cur.fetchone())
            if workout is None:
                return None
            if include_samples:
                cur.execute(
                    "SELECT t, cadence, speed, resistance, distance "
                    "FROM workout_samples WHERE workout_id = ? ORDER BY t",
                    (workout_id,),
                )
                workout["samples"] = [dict(row) for row in cur.fetchall()]
            return workout

    def list_workouts(self, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        with self._cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM workouts")
            total = int(cur.fetchone()["n"])
            cur.execute(
                "SELECT * FROM workouts ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
            workouts = [_row_to_workout(row) for row in cur.fetchall()]
        return {"workouts": workouts, "total": total, "limit": limit, "offset": offset}

    def active_workout(self) -> dict[str, Any] | None:
        with self._cursor() as cur:
            cur.execute(
                "SELECT * FROM workouts WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1"
            )
            workout = _row_to_workout(cur.fetchone())
            if workout is None:
                return None
            cur.execute(
                "SELECT t, cadence, speed, resistance, distance "
                "FROM workout_samples WHERE workout_id = ? ORDER BY t",
                (workout["id"],),
            )
            workout["samples"] = [dict(row) for row in cur.fetchall()]
            return workout

    def all_dates(self) -> list[date]:
        with self._cursor() as cur:
            cur.execute("SELECT date FROM workouts ORDER BY date")
            return [date.fromisoformat(row["date"]) for row in cur.fetchall()]

    def stats(self, days: int = 30) -> dict[str, Any]:
        days = max(1, min(int(days), 365))
        today = date.today()
        start = today - timedelta(days=days - 1)
        start_iso = start.isoformat()

        with self._cursor() as cur:
            cur.execute(
                "SELECT date, COUNT(*) AS workouts, SUM(duration_seconds) AS seconds, "
                "SUM(distance_km) AS distance, AVG(avg_cadence) AS cadence, "
                "MAX(max_cadence) AS max_cadence, AVG(avg_speed) AS speed, "
                "AVG(avg_resistance) AS resistance "
                "FROM workouts WHERE date >= ? GROUP BY date ORDER BY date",
                (start_iso,),
            )
            rows = cur.fetchall()

            cur.execute(
                "SELECT COUNT(*) AS workouts, COALESCE(SUM(duration_seconds), 0) AS seconds, "
                "COALESCE(SUM(distance_km), 0) AS distance FROM workouts"
            )
            lifetime = cur.fetchone()

            cur.execute(
                "SELECT COUNT(*) AS workouts, COALESCE(SUM(duration_seconds), 0) AS seconds, "
                "COALESCE(SUM(distance_km), 0) AS distance FROM workouts WHERE date >= ?",
                ((today - timedelta(days=6)).isoformat(),),
            )
            week = cur.fetchone()

            bests = {}
            for key, column in (
                ("longest", "duration_seconds"),
                ("farthest", "distance_km"),
                ("fastest_cadence", "max_cadence"),
            ):
                cur.execute(
                    f"SELECT * FROM workouts WHERE {column} IS NOT NULL "
                    f"ORDER BY {column} DESC LIMIT 1"
                )
                bests[key] = _row_to_workout(cur.fetchone())

        by_date = {row["date"]: row for row in rows}
        daily = []
        for offset in range(days):
            day = start + timedelta(days=offset)
            key = day.isoformat()
            row = by_date.get(key)
            daily.append({
                "date": key,
                "workouts": int(row["workouts"]) if row else 0,
                "minutes": round((row["seconds"] or 0) / 60.0, 1) if row else 0.0,
                "seconds": int(row["seconds"] or 0) if row else 0,
                "distance_km": round(row["distance"] or 0.0, 2) if row else 0.0,
                "avg_cadence": round(row["cadence"], 1) if row and row["cadence"] is not None else None,
                "max_cadence": round(row["max_cadence"], 1) if row and row["max_cadence"] is not None else None,
                "avg_speed": round(row["speed"], 1) if row and row["speed"] is not None else None,
                "avg_resistance": round(row["resistance"], 1) if row and row["resistance"] is not None else None,
            })

        today_row = daily[-1] if daily else None
        return {
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "range_days": days,
            "daily": daily,
            "totals": {
                "today": today_row,
                "week": {
                    "workouts": int(week["workouts"]),
                    "seconds": int(week["seconds"]),
                    "minutes": round(week["seconds"] / 60.0, 1),
                    "distance_km": round(week["distance"], 2),
                },
                "lifetime": {
                    "workouts": int(lifetime["workouts"]),
                    "seconds": int(lifetime["seconds"]),
                    "minutes": round(lifetime["seconds"] / 60.0, 1),
                    "distance_km": round(lifetime["distance"], 2),
                },
            },
            "streak_days": self._streak(today),
            "bests": bests,
        }

    def _streak(self, today: date) -> int:
        dates = {day.isoformat() for day in self.all_dates()}
        if not dates:
            return 0
        cursor = today
        if cursor.isoformat() not in dates:
            cursor -= timedelta(days=1)
            if cursor.isoformat() not in dates:
                return 0
        streak = 0
        while cursor.isoformat() in dates:
            streak += 1
            cursor -= timedelta(days=1)
        return streak

    def export_rows(self) -> list[dict[str, Any]]:
        with self._cursor() as cur:
            cur.execute("SELECT * FROM workouts ORDER BY date, started_at")
            return [_row_to_workout(row) for row in cur.fetchall()]


class WorkoutRecorder:
    """Turns a telemetry stream into a persisted workout."""

    def __init__(
        self,
        store: WorkoutStore,
        now: Callable[[], datetime] | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.store = store
        self._now = now or (lambda: datetime.now().astimezone())
        self._clock = clock or time.monotonic
        self.workout_id: int | None = None
        self.auto_paused = False
        self._source = "auto"
        self._started_at: datetime | None = None
        self._started_clock = 0.0
        self._last_sample_clock = 0.0
        self._last_flush_clock = 0.0
        self._pending: list[dict[str, Any]] = []
        self._sample_count = 0
        self._start_distance: float | None = None
        self._last_distance: float | None = None
        self._start_elapsed: int | None = None
        self._last_elapsed: int | None = None
        self._cadence_sum = 0.0
        self._cadence_n = 0
        self._cadence_max: float | None = None
        self._speed_sum = 0.0
        self._speed_n = 0
        self._speed_max: float | None = None
        self._resistance_sum = 0.0
        self._resistance_n = 0
        self._resistance_max: float | None = None

    @property
    def active(self) -> bool:
        return self.workout_id is not None

    def reset_for_connection(self) -> None:
        """A new bike connection is a new tracking opportunity."""
        self.auto_paused = False

    def start(self, source: str = "auto") -> dict[str, Any] | None:
        if self.active:
            return self.summary()
        started = self._now()
        self._started_at = started
        self._source = source
        self._started_clock = self._clock()
        self._last_sample_clock = 0.0
        self._last_flush_clock = self._started_clock
        self._pending = []
        self._sample_count = 0
        self._start_distance = None
        self._last_distance = None
        self._start_elapsed = None
        self._last_elapsed = None
        self._cadence_sum = self._cadence_n = 0
        self._speed_sum = self._speed_n = 0
        self._resistance_sum = self._resistance_n = 0
        self._cadence_max = self._speed_max = self._resistance_max = None
        self.workout_id = self.store.create_workout(started, source=source)
        return self.summary()

    def handle(self, metrics: dict[str, Any]) -> str | None:
        """Feed one telemetry snapshot. Returns ``"started"`` on auto-start."""
        event = None
        if not self.active:
            moving = (metrics.get("cadence_rpm") or 0) > 0
            if self.auto_paused or not moving:
                return None
            self.start(source="auto")
            event = "started"

        assert self.workout_id is not None
        cadence = metrics.get("cadence_rpm")
        speed = metrics.get("speed_kph_estimate")
        resistance = metrics.get("resistance")
        distance = metrics.get("distance_km")
        elapsed = metrics.get("elapsed_seconds")

        if cadence is not None and cadence > 0:
            self._cadence_sum += cadence
            self._cadence_n += 1
            self._cadence_max = max(self._cadence_max or 0, cadence)
        if speed is not None:
            self._speed_sum += speed
            self._speed_n += 1
            self._speed_max = max(self._speed_max or 0, speed)
        if resistance is not None:
            self._resistance_sum += resistance
            self._resistance_n += 1
            self._resistance_max = max(self._resistance_max or 0, resistance)
        if distance is not None:
            if self._start_distance is None:
                self._start_distance = distance
            self._last_distance = distance
        if elapsed is not None:
            if self._start_elapsed is None:
                self._start_elapsed = elapsed
            self._last_elapsed = elapsed

        now = self._clock()
        if now - self._last_sample_clock >= SAMPLE_INTERVAL_SECONDS:
            self._last_sample_clock = now
            self._pending.append({
                "t": max(0, int(now - self._started_clock)),
                "cadence": cadence,
                "speed": speed,
                "resistance": resistance,
                "distance": distance,
            })
            self._sample_count += 1

        if now - self._last_flush_clock >= FLUSH_INTERVAL_SECONDS and self._pending:
            self.checkpoint()
        return event

    def checkpoint(self) -> None:
        if not self.active:
            return
        self.store.append_samples(self.workout_id, self._pending)
        self._pending = []
        self.store.update_workout(self.workout_id, self._fields())
        self._last_flush_clock = self._clock()

    def stop(self) -> dict[str, Any] | None:
        if not self.active:
            return None
        assert self.workout_id is not None
        workout_id = self.workout_id
        fields = self._fields()
        fields["ended_at"] = self._now().isoformat(timespec="seconds")
        self.store.append_samples(workout_id, self._pending)
        self._pending = []
        duration = int(fields["duration_seconds"])
        samples = int(fields["sample_count"])

        self.workout_id = None
        self._started_at = None
        if duration < MIN_TRACKED_SECONDS and samples < MIN_TRACKED_SAMPLES:
            self.store.delete_workout(workout_id)
            return None
        return self.store.finish_workout(workout_id, fields)

    def summary(self) -> dict[str, Any] | None:
        if not self.active or self._started_at is None:
            return None
        fields = self._fields()
        return {
            "id": self.workout_id,
            "started_at": self._started_at.isoformat(timespec="seconds"),
            "ended_at": None,
            "date": self._started_at.date().isoformat(),
            **fields,
            "source": self._source,
        }

    def live_snapshot(self) -> dict[str, Any] | None:
        """Active workout including samples not yet flushed to disk."""
        summary = self.summary()
        if summary is None or self.workout_id is None:
            return None
        stored = self.store.get_workout(self.workout_id, include_samples=True) or {}
        samples = list(stored.get("samples") or []) + self._pending
        summary["samples"] = samples
        return summary

    def _fields(self) -> dict[str, Any]:
        duration = int(round(self._clock() - self._started_clock))
        if (self._last_elapsed is not None and self._start_elapsed is not None
                and self._last_elapsed >= self._start_elapsed):
            duration = int(self._last_elapsed - self._start_elapsed)
        duration = max(0, duration)

        distance = 0.0
        if self._last_distance is not None and self._start_distance is not None:
            distance = self._last_distance - self._start_distance
            if distance < 0:
                distance = self._last_distance

        return {
            "duration_seconds": duration,
            "distance_km": round(max(0.0, distance), 2),
            "avg_cadence": round(self._cadence_sum / self._cadence_n, 1) if self._cadence_n else None,
            "max_cadence": self._cadence_max,
            "avg_speed": round(self._speed_sum / self._speed_n, 1) if self._speed_n else None,
            "max_speed": self._speed_max,
            "avg_resistance": round(self._resistance_sum / self._resistance_n, 1) if self._resistance_n else None,
            "max_resistance": self._resistance_max,
            "sample_count": self._sample_count,
        }
