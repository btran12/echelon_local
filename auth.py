"""PIN gate and signed sessions for LAN access to the local dashboard.

This is intentionally small: one shared PIN protects the dashboard and API,
sessions are HMAC-signed cookies with an expiry, and failed logins are rate
limited per client address. It is meant for a trusted home network, not for
exposing the app to the internet.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from pathlib import Path
from typing import Callable

DEFAULT_SESSION_TTL = 30 * 24 * 60 * 60
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_WINDOW_SECONDS = 5 * 60


def generate_pin() -> str:
    """A six digit PIN that is easy to type on a phone."""
    return f"{secrets.randbelow(900_000) + 100_000}"


def load_or_create_pin(path: str | Path) -> tuple[str, bool]:
    """Read the PIN from disk, creating and saving one on first use.

    Returns ``(pin, created)``.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        pin = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        pin = ""
    if pin:
        return pin, False
    pin = generate_pin()
    path.write_text(pin + "\n", encoding="utf-8")
    return pin, True


def safe_next(value: str | None, default: str = "/") -> str:
    """Only allow same-site relative paths as post-login destinations."""
    if not value:
        return default
    value = value.strip()
    if not value.startswith("/") or value.startswith("//"):
        return default
    if any(char in value for char in ("\\", "\r", "\n")):
        return default
    if value.startswith("/login") or value.startswith("/logout"):
        return default
    return value


class AuthManager:
    """Validates the shared PIN, signs sessions, and throttles failures."""

    def __init__(
        self,
        pin: str,
        *,
        session_ttl: int = DEFAULT_SESSION_TTL,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        window_seconds: int = DEFAULT_WINDOW_SECONDS,
        secret: bytes | str | None = None,
        now: Callable[[], float] | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.pin = pin
        if isinstance(secret, str):
            secret = secret.encode("utf-8")
        self._secret = secret or secrets.token_bytes(32)
        self.session_ttl = session_ttl
        self.max_attempts = max(1, max_attempts)
        self.window_seconds = max(1, window_seconds)
        self._now = now or time.time
        self._clock = clock or time.monotonic
        self._failures: dict[str, list[float]] = {}

    # ---------------------------------------------------------------- password
    def verify_pin(self, candidate: str | None) -> bool:
        if not candidate:
            return False
        return hmac.compare_digest(
            self.pin.encode("utf-8"), candidate.strip().encode("utf-8")
        )

    # ---------------------------------------------------------------- sessions
    def issue_session(self) -> str:
        issued = int(self._now())
        nonce = secrets.token_urlsafe(12)
        payload = f"{issued}.{nonce}"
        signature = hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{payload}.{signature}"

    def verify_session(self, token: str | None) -> bool:
        if not token:
            return False
        try:
            issued_raw, nonce, signature = token.split(".")
            issued = int(issued_raw)
        except (AttributeError, ValueError):
            return False
        if not nonce or not signature:
            return False
        payload = f"{issued}.{nonce}"
        expected = hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return False
        age = self._now() - issued
        return 0 <= age <= self.session_ttl

    # ------------------------------------------------------------ rate limiting
    def retry_after(self, client: str) -> int:
        """Seconds until another attempt is allowed (0 means it is allowed)."""
        now = self._clock()
        history = [stamp for stamp in self._failures.get(client, []) if now - stamp < self.window_seconds]
        if history:
            self._failures[client] = history
        else:
            self._failures.pop(client, None)
        if len(history) < self.max_attempts:
            return 0
        return max(1, int(round(self.window_seconds - (now - history[0]))))

    def record_failure(self, client: str) -> None:
        self._failures.setdefault(client, []).append(self._clock())

    def clear_failures(self, client: str) -> None:
        self._failures.pop(client, None)
