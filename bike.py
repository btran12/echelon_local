"""Bluetooth bike session management.

Shared by the local dashboard (``app.py``) and the AWS bridge
(``aws_agent.py``) so both drive the same BLE handshake and recording logic.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from bleak import BleakClient, BleakScanner

from protocol import (
    SERVICE_UUID, WRITE_UUID, NOTIFY_UUIDS, init_frames,
    response_for_challenge, activation_command, poll_command, decode_telemetry,
)
from power import calculate_echelon_watts
from storage import WorkoutRecorder, WorkoutStore

POLL_INTERVAL_SECONDS = 2.0

log = logging.getLogger("echelon-bike")


class BikeService:
    def __init__(self, workout_store: WorkoutStore | None = None, *, auth_required: bool = False) -> None:
        self.client: BleakClient | None = None
        self.device_address: str | None = None
        self.device_name: str | None = None
        self.auth_required = auth_required
        self.state = "disconnected"
        self.last_error: str | None = None
        self.latest: dict[str, Any] = self.empty_metrics()
        self.events: list[dict[str, Any]] = []
        self.clients: set[Any] = set()
        self.recorder = WorkoutRecorder(workout_store) if workout_store else None
        self._lock = asyncio.Lock()
        self._activation_tasks: set[asyncio.Task] = set()
        self._poll_task: asyncio.Task | None = None
        self._poll_counter = 1
        self._unlock_attempted = False
        self._unlock_seen = False

    @staticmethod
    def empty_metrics() -> dict[str, Any]:
        return {
            "timestamp": None, "connected": False, "state": "disconnected",
            "cadence_rpm": None, "speed_kph_estimate": None, "resistance": None,
            "distance_km": None, "elapsed_seconds": None, "power_watts": None,
            "last_frame_hex": None,
        }

    def event(self, message: str, level: str = "info", data: Any = None) -> None:
        item = {"timestamp": datetime.now(timezone.utc).isoformat(), "level": level,
                "message": message, "data": data}
        self.events.append(item)
        self.events = self.events[-200:]
        log.log(logging.ERROR if level == "error" else logging.INFO, "%s", message)
        asyncio.create_task(self.broadcast({"type": "event", "event": item}))

    async def broadcast(self, payload: dict[str, Any]) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def status(self) -> dict[str, Any]:
        return {
            "state": self.state, "connected": bool(self.client and self.client.is_connected),
            "device_name": self.device_name, "device_address": self.device_address,
            "last_error": self.last_error, "unlock_challenge_seen": self._unlock_seen,
            "auth_required": self.auth_required,
            "latest": self.latest,
            "workout": self.recorder.summary() if self.recorder else None,
        }

    def estimate_power(self) -> float | None:
        """Watts implied by the most recent cadence and resistance."""
        cadence = self.latest.get("cadence_rpm")
        resistance = self.latest.get("resistance")
        if cadence is None or resistance is None:
            return None
        return calculate_echelon_watts(cadence, resistance)

    async def scan(self) -> list[dict[str, Any]]:
        self.state = "scanning"
        self.event("Scanning for BLE devices (8 seconds)…")
        try:
            devices = await BleakScanner.discover(timeout=8.0, return_adv=True)
            result = []
            for _address, pair in devices.items():
                device, adv = pair
                name = device.name or adv.local_name or ""
                uuids = [u.lower() for u in (adv.service_uuids or [])]
                if name.upper().startswith("ECH") or SERVICE_UUID in uuids:
                    result.append({
                        "name": name or "(unnamed Echelon device)",
                        "address": device.address,
                        "rssi": getattr(adv, "rssi", None),
                        "service_uuids": uuids,
                    })
            self.state = "disconnected"
            self.event(f"Scan complete: {len(result)} possible Echelon device(s).")
            return result
        except Exception as exc:
            self.state = "error"
            self.last_error = str(exc)
            self.event(f"BLE scan failed: {exc}", "error")
            raise

    async def connect(self, address: str, name: str = "Echelon") -> None:
        async with self._lock:
            self._stop_polling()
            await self.disconnect(quiet=True)
            self.state = "connecting"
            self.last_error = None
            self._unlock_attempted = False
            self._unlock_seen = False
            if self.recorder:
                self.recorder.reset_for_connection()
            self.device_address = address
            self.device_name = name
            self.latest = self.empty_metrics()
            self.event(f"Connecting to {name} ({address})…")
            client = BleakClient(address, disconnected_callback=self._disconnected)
            self.client = client
            try:
                await client.connect(timeout=20)
                if not client.is_connected:
                    raise RuntimeError("BLE client did not connect")
                services = client.services
                service = services.get_service(SERVICE_UUID)
                if service is None:
                    # Print discovered services to make model mismatch diagnosable.
                    discovered = [str(s.uuid) for s in services]
                    raise RuntimeError(
                        f"Expected QZ service {SERVICE_UUID} not found. "
                        f"Discovered services: {discovered}"
                    )
                chars = {c.uuid.lower(): c for c in service.characteristics}
                missing = [u for u in [WRITE_UUID, *NOTIFY_UUIDS] if u.lower() not in chars]
                if missing:
                    raise RuntimeError(f"Expected QZ characteristics missing: {missing}")
                self.state = "subscribing"
                for uuid in NOTIFY_UUIDS:
                    await client.start_notify(uuid, self._notification)
                self.event("Subscribed to both QZ notification characteristics.")
                self.state = "initializing"
                for frame in init_frames():
                    await client.write_gatt_char(WRITE_UUID, frame, response=False)
                    await asyncio.sleep(0.12)
                # QZ sends the ordinary activation frame only if a direct challenge
                # was not seen while the pre-activation initialization ran.
                if not self._unlock_attempted:
                    await client.write_gatt_char(WRITE_UUID, activation_command(), response=False)
                    self.event("No challenge observed during init; sent standard QZ activation frame.")
                self.state = "waiting_for_telemetry"
                self.latest.update({"connected": True, "state": self.state})
                self.event("Sent QZ initialization frames; waiting for challenge/telemetry.")
                self._start_polling()
                await self.broadcast({"type": "status", "status": self.status()})
            except Exception as exc:
                self._stop_polling()
                self.last_error = str(exc)
                self.state = "error"
                self.event(f"Connect/setup failed: {exc}", "error")
                try:
                    await client.disconnect()
                except Exception:
                    pass
                self.client = None
                raise

    def _disconnected(self, _client: BleakClient) -> None:
        self._stop_polling()
        self._finish_workout()
        self.state = "disconnected"
        self.latest["connected"] = False
        self.latest["state"] = "disconnected"
        self.event("Bike disconnected.")
        asyncio.create_task(self.broadcast({"type": "status", "status": self.status()}))

    def _notification(self, _sender: Any, raw: bytearray) -> None:
        frame = bytes(raw)
        hex_frame = frame.hex(" ").upper()
        self.event(f"BLE notification: {hex_frame}", data={"frame_hex": hex_frame})
        if len(frame) == 8 and frame[0:2] == b"\xF0\xE0":
            self._unlock_seen = True
            if not self._unlock_attempted:
                self._unlock_attempted = True
                try:
                    response = response_for_challenge(frame)
                except ValueError as exc:
                    self.last_error = str(exc)
                    self.event(f"Challenge did not match QZ codec: {exc}", "error")
                else:
                    self.event(f"QZ challenge recognized (auth value {response[4] >> 4}{response[4] & 0x0F}); sending response.")
                    task = asyncio.create_task(self._send_unlock(response))
                    self._activation_tasks.add(task)
                    task.add_done_callback(self._activation_tasks.discard)

        parsed = decode_telemetry(frame)
        if parsed:
            self.latest.update(parsed)
            self.latest.update({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "connected": bool(self.client and self.client.is_connected),
                "state": "streaming" if parsed.get("cadence_rpm") is not None or
                         parsed.get("resistance") is not None or parsed.get("distance_km") is not None
                         else self.state,
                "last_frame_hex": hex_frame,
            })
            self.latest["power_watts"] = self.estimate_power()
            if self.latest["state"] == "streaming":
                self.state = "streaming"
            if self.recorder:
                recorder_event = self.recorder.handle(parsed)
                if recorder_event == "started":
                    workout = self.recorder.summary()
                    self.event("Workout tracking started automatically.")
                    asyncio.create_task(self.broadcast(
                        {"type": "workout", "event": "started", "workout": workout}
                    ))
            asyncio.create_task(self.broadcast({"type": "telemetry", "telemetry": self.latest.copy()}))
        asyncio.create_task(self.broadcast({"type": "status", "status": self.status()}))

    def _finish_workout(self) -> dict[str, Any] | None:
        if not self.recorder:
            return None
        summary = self.recorder.stop()
        if summary is None:
            return None
        minutes, seconds = divmod(int(summary["duration_seconds"]), 60)
        self.event(
            f"Workout saved: {minutes}m {seconds:02d}s · "
            f"{summary['distance_km']:.2f} km · avg {summary['avg_cadence'] or 0:g} rpm"
        )
        asyncio.create_task(self.broadcast(
            {"type": "workout", "event": "saved", "workout": summary}
        ))
        return summary

    async def start_workout(self) -> dict[str, Any] | None:
        if not self.recorder:
            return None
        summary = self.recorder.start(source="manual")
        self.recorder.auto_paused = False
        self.event("Manual workout tracking started.")
        await self.broadcast({"type": "workout", "event": "started", "workout": summary})
        await self.broadcast({"type": "status", "status": self.status()})
        return summary

    async def stop_workout(self) -> dict[str, Any] | None:
        if not self.recorder:
            return None
        self.recorder.auto_paused = True
        summary = self.recorder.stop()
        if summary:
            minutes, seconds = divmod(int(summary["duration_seconds"]), 60)
            self.event(
                f"Workout stopped: {minutes}m {seconds:02d}s · "
                f"{summary['distance_km']:.2f} km · avg {summary['avg_cadence'] or 0:g} rpm"
            )
        else:
            self.event("Workout stopped without enough data to save.")
        await self.broadcast({"type": "workout", "event": "stopped", "workout": summary})
        await self.broadcast({"type": "status", "status": self.status()})
        return summary

    def _start_polling(self) -> None:
        self._stop_polling()
        self._poll_counter = 1
        self._poll_task = asyncio.create_task(self._poll_loop())

    def _stop_polling(self) -> None:
        task = self._poll_task
        self._poll_task = None
        if task and not task.done():
            task.cancel()

    async def _poll_loop(self) -> None:
        """Send QZ's F0 A0 keepalive every 2 seconds.

        The bike drops an otherwise idle BLE link when it stops receiving polls,
        which otherwise looks like a connection timeout after roughly a minute.
        """
        try:
            while True:
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
                client = self.client
                if not client or not client.is_connected:
                    return
                frame = poll_command(self._poll_counter)
                self._poll_counter = self._poll_counter % 255 + 1
                await client.write_gatt_char(WRITE_UUID, frame, response=False)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.last_error = str(exc)
            self.event(f"Keepalive poll failed: {exc}", "error")

    async def _send_unlock(self, response: bytes) -> None:
        try:
            if not self.client or not self.client.is_connected:
                return
            await self.client.write_gatt_char(WRITE_UUID, response, response=False)
            self.event(f"Sent QZ direct challenge response: {response.hex(' ').upper()}")
            await asyncio.sleep(0.5)
            if self.client and self.client.is_connected:
                activation = activation_command()
                await self.client.write_gatt_char(WRITE_UUID, activation, response=False)
                self.event(f"Sent QZ activation command: {activation.hex(' ').upper()}")
        except Exception as exc:
            self.last_error = str(exc)
            self.event(f"Unlock write failed: {exc}", "error")

    async def disconnect(self, quiet: bool = False) -> None:
        self._stop_polling()
        client = self.client
        self.client = None
        self._finish_workout()
        if client:
            try:
                if client.is_connected:
                    await client.disconnect()
            except Exception as exc:
                if not quiet:
                    self.event(f"Disconnect warning: {exc}", "error")
        self.state = "disconnected"
        self.latest["connected"] = False
        self.latest["state"] = "disconnected"
        if not quiet:
            self.event("Disconnected by request.")
        await self.broadcast({"type": "status", "status": self.status()})
