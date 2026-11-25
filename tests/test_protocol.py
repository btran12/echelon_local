import unittest
from protocol import response_for_challenge, activation_command, poll_command, decode_telemetry

class ProtocolTests(unittest.TestCase):
    def test_invalid_length(self):
        with self.assertRaises(ValueError):
            response_for_challenge(bytes.fromhex("F0 E0"))

    def test_invalid_prefix(self):
        with self.assertRaises(ValueError):
            response_for_challenge(bytes.fromhex("00 00 00 00 00 00 00 00"))

    def test_activation(self):
        self.assertEqual(activation_command(), bytes.fromhex("F0 B0 01 01 A2"))

    def test_poll_command(self):
        self.assertEqual(poll_command(1), bytes.fromhex("F0 A0 01 01 92"))
        self.assertEqual(poll_command(0xFF), bytes.fromhex("F0 A0 01 FF 90"))

    def test_resistance_packet(self):
        result = decode_telemetry(bytes.fromhex("F0 D2 00 0A 00"))
        self.assertEqual(result["resistance"], 10)

if __name__ == "__main__":
    unittest.main()
