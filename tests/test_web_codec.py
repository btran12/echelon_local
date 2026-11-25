"""Guards the browser port of protocol.py against drift.

The GitHub Pages build carries its own JavaScript copy of the QZ codec
(web/ble.js) because the page talks to the bike directly. These tests run that
copy under Node and compare it with the Python reference implementation.
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from protocol import decode_telemetry, response_for_challenge
from power import calculate_echelon_watts

BLE_JS = Path(__file__).resolve().parents[1] / "web" / "ble.js"
NODE = shutil.which("node")

CHALLENGES = [
    "F0E0123456780900",
    "F0E0010203040500",
    "F0E0998877665500",
    "F0E0000000000000",
]

FRAMES = [
    "F000000064000000C800540000",
    "F0D2000C00",
    "F0A10091",
]


def _to_bytes(hex_text):
    return bytes.fromhex(hex_text)


@unittest.skipIf(NODE is None, "node is required to test the browser codec")
class BrowserCodecTests(unittest.TestCase):
    def run_codec(self, challenges, frames):
        script = """
global.window = {};
require(process.argv[1]);
const codec = window.EchelonBle.codec;
const input = JSON.parse(process.argv[2]);
const toBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const out = { responses: [], decoded: [], watts: [] };
for (const hex of input.challenges) {
  try {
    out.responses.push(Array.from(codec.responseForChallenge(toBytes(hex))));
  } catch (error) {
    out.responses.push(`error: ${error.message}`);
  }
}
for (const hex of input.frames) {
  out.decoded.push(codec.decodeTelemetry(toBytes(hex)));
}
for (const [cadence, resistance] of input.watts) {
  out.watts.push(codec.calculateWatts(cadence, resistance));
}
process.stdout.write(JSON.stringify(out));
"""
        payload = json.dumps({
            "challenges": challenges,
            "frames": frames,
            "watts": [[80, 12], [60, 1], [90, 32], [0, 12], [80, 0]],
        })
        result = subprocess.run(
            [NODE, "-e", script, str(BLE_JS), payload],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_challenge_responses_match_python(self):
        output = self.run_codec(CHALLENGES, [])
        for hex_text, actual in zip(CHALLENGES, output["responses"]):
            try:
                expected = list(response_for_challenge(_to_bytes(hex_text)))
            except ValueError as exc:
                self.assertIsInstance(actual, str, hex_text)
                self.assertIn("error", actual, hex_text)
                self.assertTrue(actual.startswith("error:"), hex_text)
                self.assertIn(str(exc).split(":")[0], actual)
                continue
            self.assertEqual(actual, expected, hex_text)

    def test_telemetry_decoding_matches_python(self):
        output = self.run_codec([], FRAMES)
        for hex_text, actual in zip(FRAMES, output["decoded"]):
            self.assertEqual(actual, decode_telemetry(_to_bytes(hex_text)), hex_text)

    def test_power_model_matches_python(self):
        output = self.run_codec([], [])
        for (cadence, resistance), actual in zip(
            [[80, 12], [60, 1], [90, 32], [0, 12], [80, 0]], output["watts"]
        ):
            self.assertEqual(actual, calculate_echelon_watts(cadence, resistance),
                             f"{cadence} rpm @ {resistance}")


if __name__ == "__main__":
    unittest.main()
