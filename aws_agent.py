"""BLE bridge between the bike and the AWS-hosted Echelon service.

Run this on the machine that can see the bike over Bluetooth. It drives the
same :class:`bike.BikeService` as the local dashboard, records workouts into a
local SQLite file, pushes live state to API Gateway, uploads completed
workouts, and executes commands queued by the web dashboard.

Environment:
    ECHELON_API_URL    e.g. https://abc123.execute-api.us-east-1.amazonaws.com
    ECHELON_API_TOKEN  the same ApiToken supplied to CloudFormation
    ECHELON_DB         optional SQLite path (default data/echelon.db)
    ECHELON_SYNC_LIMIT optional number of local workouts to backfill (default 200)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import aiohttp

from bike import BikeService
from storage import WorkoutStore

log = logging.getLogger("echelon-aws-agent")

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("ECHELON_DB", str(BASE_DIR / "data" / "echelon.db"))).expanduser()
SYNC_INTERVAL_SECONDS = 30.0
ACTIVE_SNAPSHOT_SECONDS = 10.0
ACTIVE_SAMPLE_LIMIT = 600


def aws_workout_id(workout: dict[str, Any]) -> str:
    """Stable, sortable id shared with the AWS copy of a local workout."""
    try:
        started = datetime.fromisoformat(str(workout["started_at"]))
        millis = int(started.timestamp() * 1000)
    except (KeyError, TypeError, ValueError):
        millis = 0
    return f"{millis:013d}-{int(workout.get('id') or 0):05d}"


class AwsAgent:
    def __init__(self, base_url: str, token: str, store: WorkoutStore) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.store = store
        self.bike = BikeService(store)
        self.session: aiohttp.ClientSession | None = None
        self.seen_events: list[str] = []
        self.seen_commands: set[str] = set()
        self.synced: set[str] = set()
        self.last_core: str | None = None
        self.last_post = 0.0
        self.last_sync = 0.0
        self.last_active_post = 0.0
        self.last_active_marker: str | None = None
        self.running = True

    def _headers(self) -> dict[str, str]:
        return {"x-api-token": self.token, "content-type": "application/json"}

    async def _request(self, method: str, path: str, payload: Any = None) -> Any:
        if self.session is None:
            raise RuntimeError("HTTP session is not open")
        async with self.session.request(
            method,
            self.base_url + path,
            json=payload,
            headers=self._headers(),
        ) as response:
            text = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"{method} {path} -> {response.status}: {text}")
            return json.loads(text) if text else None

    def _active_snapshot(self) -> dict[str, Any] | None:
        recorder = self.bike.recorder
        if recorder is None:
            return None
        snapshot = recorder.live_snapshot()
        if snapshot is None:
            return None
        snapshot["id"] = aws_workout_id(snapshot)
        samples = snapshot.get("samples") or []
        if len(samples) > ACTIVE_SAMPLE_LIMIT:
            snapshot["samples"] = samples[-ACTIVE_SAMPLE_LIMIT:]
        return snapshot

    async def _post_telemetry(self) -> None:
        new_events: list[dict[str, Any]] = []
        for event in self.bike.events:
            key = f"{event.get('timestamp')}|{event.get('message')}"
            if key not in self.seen_events:
                new_events.append(event)

        status = self.bike.status()
        telemetry = self.bike.latest
        core = {"status": status, "telemetry": telemetry}
        encoded = json.dumps(core, sort_keys=True, default=str)
        now = time.monotonic()

        snapshot = self._active_snapshot()
        marker = None
        if snapshot is not None:
            marker = f"{snapshot['id']}:{snapshot.get('sample_count')}"

        send_active = snapshot is not None and (
            marker != self.last_active_marker or now - self.last_active_post >= ACTIVE_SNAPSHOT_SECONDS
        )

        if encoded == self.last_core and not new_events and not send_active and now - self.last_post < 30:
            return

        payload: dict[str, Any] = {**core, "events": new_events}
        if send_active:
            payload["workout"] = snapshot
        await self._request("POST", "/telemetry", payload)
        for event in new_events:
            self.seen_events.append(f"{event.get('timestamp')}|{event.get('message')}")
        if len(self.seen_events) > 1000:
            self.seen_events = self.seen_events[-500:]
        self.last_core = encoded
        self.last_post = now
        if send_active:
            self.last_active_post = now
            self.last_active_marker = marker

    async def _sync_workouts(self, force: bool = False) -> None:
        now = time.monotonic()
        limit = int(os.environ.get("ECHELON_SYNC_LIMIT", "200") or 200)
        if not force and now - self.last_sync < SYNC_INTERVAL_SECONDS:
            return
        self.last_sync = now

        rows = [row for row in self.store.export_rows() if row.get("ended_at")][-limit:]
        uploaded = 0
        for row in rows:
            workout_id = aws_workout_id(row)
            if workout_id in self.synced:
                continue
            full = self.store.get_workout(int(row["id"])) or {}
            payload = {**row, "id": workout_id, "samples": full.get("samples") or []}
            await self._request("POST", "/workouts", payload)
            self.synced.add(workout_id)
            uploaded += 1
            if uploaded >= 5:
                break
        if uploaded:
            log.info("Uploaded %s workout(s) to AWS", uploaded)

    async def _poll_commands(self) -> None:
        data = await self._request("GET", "/commands")
        for command in (data or {}).get("commands", []):
            command_id = command.get("command_id")
            if not command_id or command_id in self.seen_commands:
                continue
            self.seen_commands.add(command_id)
            asyncio.create_task(self._execute(command))

    async def _execute(self, command: dict[str, Any]) -> None:
        command_id = command["command_id"]
        action = command.get("action")
        payload = command.get("payload") or {}
        result: dict[str, Any] = {"ok": True}

        try:
            if action == "scan":
                devices = await self.bike.scan()
                await self._request("POST", "/scan-result", {"devices": devices})
            elif action == "connect":
                await self.bike.connect(
                    str(payload["address"]),
                    str(payload.get("name") or "Echelon"),
                )
            elif action == "disconnect":
                await self.bike.disconnect()
            elif action == "workout_start":
                result["workout"] = await self.bike.start_workout()
            elif action == "workout_stop":
                result["workout"] = await self.bike.stop_workout()
                await self._sync_workouts(force=True)
            else:
                raise ValueError(f"unknown command action: {action}")
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
            self.bike.event(f"AWS command {action} failed: {exc}", "error")
        finally:
            try:
                await self._request("POST", f"/commands/{command_id}/ack", result)
            except Exception as exc:
                # Let the API's stale-command requeue give it another chance.
                self.seen_commands.discard(command_id)
                log.warning("Could not acknowledge command %s: %s", command_id, exc)

    async def run(self) -> None:
        timeout = aiohttp.ClientTimeout(total=20)
        self.session = aiohttp.ClientSession(timeout=timeout)
        try:
            while self.running:
                try:
                    await self._post_telemetry()
                    await self._sync_workouts()
                    await self._poll_commands()
                except Exception as exc:
                    log.warning("AWS sync failed: %s", exc)
                await asyncio.sleep(1.0)
        finally:
            await self.bike.disconnect(quiet=True)
            try:
                await self._sync_workouts(force=True)
            except Exception as exc:
                log.warning("Final workout upload failed: %s", exc)
            await self.session.close()


async def main() -> None:
    base_url = os.environ.get("ECHELON_API_URL", "").strip()
    token = os.environ.get("ECHELON_API_TOKEN", "").strip()
    if not base_url or not token:
        raise SystemExit("ECHELON_API_URL and ECHELON_API_TOKEN must be set")

    store = WorkoutStore(DB_PATH)
    agent = AwsAgent(base_url, token, store)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: setattr(agent, "running", False))
        except NotImplementedError:
            # Windows does not support add_signal_handler; Ctrl+C still works.
            pass

    try:
        await agent.run()
    finally:
        store.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
