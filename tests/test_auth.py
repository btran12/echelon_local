from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from auth import AuthManager, generate_pin, load_or_create_pin, safe_next


class PinTests(unittest.TestCase):
    def test_generate_pin_is_six_digits(self) -> None:
        for _ in range(200):
            pin = generate_pin()
            self.assertRegex(pin, r"^\d{6}$")

    def test_load_or_create_pin_creates_then_reuses(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "nested" / "access_pin.txt"
            first, created = load_or_create_pin(path)
            self.assertTrue(created)
            self.assertRegex(first, r"^\d{6}$")
            self.assertEqual(path.read_text(encoding="utf-8").strip(), first)

            second, created_again = load_or_create_pin(path)
            self.assertFalse(created_again)
            self.assertEqual(first, second)

    def test_verify_pin(self) -> None:
        manager = AuthManager("482913")
        self.assertTrue(manager.verify_pin("482913"))
        self.assertTrue(manager.verify_pin(" 482913 "))
        self.assertFalse(manager.verify_pin("482914"))
        self.assertFalse(manager.verify_pin(""))
        self.assertFalse(manager.verify_pin(None))

    def test_alphanumeric_pin_is_supported(self) -> None:
        manager = AuthManager("RidePass42")
        self.assertTrue(manager.verify_pin("RidePass42"))
        self.assertFalse(manager.verify_pin("ridepass42"))

    def test_unicode_pin_is_compared_safely(self) -> None:
        manager = AuthManager("café-42")
        self.assertTrue(manager.verify_pin("café-42"))
        self.assertFalse(manager.verify_pin("cafe-42"))


class SessionTests(unittest.TestCase):
    def test_issue_and_verify(self) -> None:
        now = [1_700_000_000.0]
        manager = AuthManager("123456", now=lambda: now[0])
        token = manager.issue_session()
        self.assertTrue(manager.verify_session(token))
        self.assertFalse(manager.verify_session(None))
        self.assertFalse(manager.verify_session(""))
        self.assertFalse(manager.verify_session("not-a-token"))

    def test_tampered_session_is_rejected(self) -> None:
        manager = AuthManager("123456")
        token = manager.issue_session()
        replacement = "0" if token[-1] != "0" else "1"
        self.assertFalse(manager.verify_session(token[:-1] + replacement))

        issued, nonce, signature = token.split(".")
        self.assertFalse(manager.verify_session(f"{issued}.{nonce}x.{signature}"))

    def test_expired_session_is_rejected(self) -> None:
        now = [1_700_000_000.0]
        manager = AuthManager("123456", session_ttl=60, now=lambda: now[0])
        token = manager.issue_session()
        self.assertTrue(manager.verify_session(token))
        now[0] += 61
        self.assertFalse(manager.verify_session(token))

    def test_future_dated_session_is_rejected(self) -> None:
        now = [1_700_000_000.0]
        manager = AuthManager("123456", now=lambda: now[0])
        token = manager.issue_session()
        now[0] -= 120
        self.assertFalse(manager.verify_session(token))

    def test_sessions_are_bound_to_the_secret(self) -> None:
        first = AuthManager("123456")
        second = AuthManager("123456")
        self.assertFalse(second.verify_session(first.issue_session()))

    def test_explicit_secret_is_shared(self) -> None:
        first = AuthManager("123456", secret="shared-secret")
        second = AuthManager("123456", secret="shared-secret")
        self.assertTrue(second.verify_session(first.issue_session()))


class RateLimitTests(unittest.TestCase):
    def test_blocks_after_max_attempts_then_recovers(self) -> None:
        now = [500.0]
        manager = AuthManager(
            "123456", max_attempts=3, window_seconds=60, clock=lambda: now[0]
        )
        self.assertEqual(manager.retry_after("10.0.0.5"), 0)
        for _ in range(3):
            manager.record_failure("10.0.0.5")
        self.assertGreater(manager.retry_after("10.0.0.5"), 0)
        # Other clients are unaffected.
        self.assertEqual(manager.retry_after("10.0.0.6"), 0)
        now[0] += 61
        self.assertEqual(manager.retry_after("10.0.0.5"), 0)

    def test_success_clears_failures(self) -> None:
        now = [500.0]
        manager = AuthManager(
            "123456", max_attempts=2, window_seconds=60, clock=lambda: now[0]
        )
        manager.record_failure("client")
        manager.record_failure("client")
        self.assertGreater(manager.retry_after("client"), 0)
        manager.clear_failures("client")
        self.assertEqual(manager.retry_after("client"), 0)


class SafeNextTests(unittest.TestCase):
    def test_accepts_relative_paths(self) -> None:
        self.assertEqual(safe_next("/"), "/")
        self.assertEqual(safe_next("/?workout=12"), "/?workout=12")
        self.assertEqual(safe_next("/#trends"), "/#trends")

    def test_rejects_offsite_and_login_loops(self) -> None:
        self.assertEqual(safe_next(None), "/")
        self.assertEqual(safe_next(""), "/")
        self.assertEqual(safe_next("https://evil.example"), "/")
        self.assertEqual(safe_next("//evil.example"), "/")
        self.assertEqual(safe_next("/\\evil.example"), "/")
        self.assertEqual(safe_next("/login"), "/")
        self.assertEqual(safe_next("/login?next=/x"), "/")
        self.assertEqual(safe_next("/logout"), "/")
        self.assertEqual(safe_next("/ok", default="/home"), "/ok")
        self.assertEqual(safe_next("bad", default="/home"), "/home")


if __name__ == "__main__":
    unittest.main()
