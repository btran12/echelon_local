"""Echelon protocol helpers based on public QZ source.

Attribution from upstream:
"The challenge/response algorithm was discovered and documented by Christian Emerson
(@christianbemerson)." Keep this attribution with the codec if reused.
Source: https://raw.githubusercontent.com/cagnulein/qdomyos-zwift/master/src/devices/echelonconnectsport/echelonunlock.cpp
"""
from __future__ import annotations

SERVICE_UUID = "0bf669f1-45f2-11e7-9598-0800200c9a66"
WRITE_UUID = "0bf669f2-45f2-11e7-9598-0800200c9a66"
NOTIFY_UUIDS = (
    "0bf669f3-45f2-11e7-9598-0800200c9a66",
    "0bf669f4-45f2-11e7-9598-0800200c9a66",
)

def _decimal_prefix(data: bytes) -> int:
    """Parse the leading decimal digits of the bytes' lowercase hex representation."""
    s = data.hex()
    digits = []
    for ch in s:
        if not ch.isdigit():
            break
        digits.append(ch)
    if not digits:
        raise ValueError("challenge contains a byte pair with no decimal prefix")
    return int("".join(digits), 10)

def response_for_challenge(challenge: bytes) -> bytes:
    """Port of QZ's responseForChallenge; raises ValueError for invalid challenges."""
    if len(challenge) != 8:
        raise ValueError(f"expected 8-byte challenge, got {len(challenge)}")
    if challenge[0:2] != b"\xF0\xE0":
        raise ValueError("invalid challenge prefix; expected F0 E0")
    a = _decimal_prefix(bytes([challenge[4], challenge[2]]))
    b = _decimal_prefix(bytes([challenge[3], challenge[5]]))
    c = _decimal_prefix(bytes([challenge[6]]))
    if c == 0:
        raise ValueError("challenge divisor is zero")
    value = (a * b) % c
    if not 0 <= value <= 99:
        raise ValueError(f"auth value outside 0..99: {value}")
    packed_bcd = ((value // 10) << 4) | (value % 10)
    response = bytearray.fromhex("F0 E0 00 00 00 00 00")
    response[4] = packed_bcd
    checksum = sum(response) & 0xFF
    response.append(checksum)
    return bytes(response)

def activation_command() -> bytes:
    return bytes.fromhex("F0 B0 01 01 A2")

def poll_command(counter: int) -> bytes:
    """QZ's periodic F0 A0 poll, sent every 2 seconds to keep the bike alive."""
    frame = bytearray.fromhex("F0 A0 01 00 00")
    frame[3] = counter & 0xFF
    frame[4] = sum(frame[:4]) & 0xFF
    return bytes(frame)

def init_frames() -> list[bytes]:
    """QZ's pre-activation init sequence.

    The final activation command is sent separately after the challenge response,
    or as a fallback only if no challenge was observed during initialization.
    """
    init1 = bytes.fromhex("F0 A1 00 91")
    init2 = bytes.fromhex("F0 A3 00 93")
    return [init1, init1, init1, init1, init2, init1]

def decode_telemetry(frame: bytes) -> dict | None:
    """Decode only fields grounded in QZ's public packet parser."""
    if len(frame) == 5 and frame[0:2] == b"\xF0\xD2":
        return {"resistance": int(frame[3])}
    if len(frame) == 13:
        elapsed_raw = (frame[3] << 8) | frame[4]
        distance_km = ((frame[7] << 8) | frame[8]) / 100.0
        cadence = int(frame[10])
        # QZ uses this relationship in its non-power-based speed mode.
        speed = 0.37497622 * cadence
        return {
            "elapsed_seconds": int(elapsed_raw),
            "distance_km": round(distance_km, 2),
            "cadence_rpm": cadence,
            "speed_kph_estimate": round(speed, 2),
            "power_watts": None,
        }
    return None
