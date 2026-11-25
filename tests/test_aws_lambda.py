import importlib.util
import json
import os
import unittest
from pathlib import Path

import boto3
from moto import mock_aws

HANDLER_PATH = Path(__file__).resolve().parents[1] / "aws" / "lambda" / "index.py"
TABLE_NAME = "echelon-test"
TOKEN = "test-token-0123456789"


def load_handler():
    os.environ["TABLE_NAME"] = TABLE_NAME
    os.environ["API_TOKEN"] = TOKEN
    spec = importlib.util.spec_from_file_location("echelon_lambda_under_test", HANDLER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def api_event(method, path, body=None, token=TOKEN, query=None, path_params=None):
    return {
        "requestContext": {"http": {"method": method}},
        "rawPath": path,
        "queryStringParameters": query,
        "pathParameters": path_params,
        "headers": {"x-api-token": token} if token is not None else {},
        "body": json.dumps(body) if body is not None else None,
    }


def decode(response):
    return json.loads(response["body"])


def workout_payload(workout_id, started_at, *, duration=1800, distance=12.5, samples=None):
    return {
        "id": workout_id,
        "started_at": started_at,
        "ended_at": started_at,
        "date": started_at[:10],
        "duration_seconds": duration,
        "distance_km": distance,
        "avg_cadence": 78.5,
        "max_cadence": 96,
        "avg_speed": 24.9,
        "max_speed": 31.2,
        "avg_resistance": 12.5,
        "max_resistance": 18,
        "sample_count": 3,
        "source": "auto",
        "samples": samples if samples is not None else [
            {"t": 0, "cadence": 70, "speed": 20.0, "resistance": 10, "distance": 1.0},
            {"t": 5, "cadence": 80, "speed": 25.0, "resistance": 12, "distance": 1.5},
            {"t": 10, "cadence": 90, "speed": 28.0, "resistance": 14, "distance": 2.0},
        ],
    }


@mock_aws
class AwsHandlerTests(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
        os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
        os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
        self.client = boto3.client("dynamodb", region_name="us-east-1")
        self.client.create_table(
            TableName=TABLE_NAME,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[
                {"AttributeName": "pk", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
                {"AttributeName": "gsi1pk", "AttributeType": "S"},
                {"AttributeName": "gsi1sk", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "pk", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            GlobalSecondaryIndexes=[{
                "IndexName": "StatusIndex",
                "KeySchema": [
                    {"AttributeName": "gsi1pk", "KeyType": "HASH"},
                    {"AttributeName": "gsi1sk", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }],
        )
        self.handler = load_handler().handler

    def call(self, method, path, body=None, **kwargs):
        return self.handler(api_event(method, path, body, **kwargs), None)

    def test_health_is_public_and_other_routes_require_token(self):
        health = self.handler(api_event("GET", "/health", token=None), None)
        self.assertEqual(health["statusCode"], 200)

        unauthorized = self.handler(api_event("GET", "/status", token=None), None)
        self.assertEqual(unauthorized["statusCode"], 401)

        wrong = self.handler(api_event("GET", "/status", token="nope"), None)
        self.assertEqual(wrong["statusCode"], 401)

    def test_command_lifecycle(self):
        created = self.call("POST", "/scan")
        self.assertEqual(created["statusCode"], 202)
        command_id = decode(created)["command_id"]

        claimed = decode(self.call("GET", "/commands"))["commands"]
        self.assertEqual([c["command_id"] for c in claimed], [command_id])
        self.assertEqual(claimed[0]["action"], "scan")

        ack = self.call("POST", f"/commands/{command_id}/ack", {"ok": True},
                        path_params={"id": command_id})
        self.assertEqual(ack["statusCode"], 200)
        self.assertEqual(decode(self.call("GET", "/commands"))["commands"], [])

    def test_connect_requires_address(self):
        self.assertEqual(self.call("POST", "/connect", {})["statusCode"], 400)
        created = self.call("POST", "/connect", {"address": "C8:04:1C:16:B0:11", "name": "ECH"})
        self.assertEqual(created["statusCode"], 202)

    def test_telemetry_round_trip_shapes_status_for_dashboard(self):
        payload = {
            "status": {"state": "streaming", "connected": True, "device_name": "ECH"},
            "telemetry": {"cadence_rpm": 82, "timestamp": "2026-11-24T12:00:00+00:00"},
            "events": [{"timestamp": "2026-11-24T12:00:00+00:00", "message": "hello"}],
            "workout": {"id": "1", "sample_count": 2, "samples": []},
        }
        self.assertEqual(self.call("POST", "/telemetry", payload)["statusCode"], 200)

        status = decode(self.call("GET", "/status"))
        self.assertEqual(status["state"], "streaming")
        self.assertTrue(status["connected"])
        self.assertEqual(status["latest"]["cadence_rpm"], 82)
        self.assertEqual(status["workout"]["id"], "1")

        events = decode(self.call("GET", "/events"))
        self.assertEqual(events[0]["message"], "hello")

        active = decode(self.call("GET", "/workouts/active"))
        self.assertTrue(active["active"])

    def test_workout_upload_list_read_delete(self):
        first = workout_payload("0000000000001-00001", "2026-11-20T07:00:00+00:00")
        second = workout_payload("0000000000002-00002", "2026-11-21T07:00:00+00:00")

        for payload in (first, second):
            response = self.call("POST", "/workouts", payload)
            self.assertEqual(response["statusCode"], 200, response["body"])

        listing = decode(self.call("GET", "/workouts"))
        self.assertEqual(listing["total"], 2)
        self.assertEqual(listing["workouts"][0]["id"], second["id"])

        detail = decode(self.call("GET", f"/workouts/{first['id']}"))
        self.assertEqual(len(detail["samples"]), 3)
        self.assertEqual(detail["samples"][1]["t"], 5)

        deleted = self.call("DELETE", f"/workouts/{first['id']}")
        self.assertEqual(deleted["statusCode"], 200)
        self.assertEqual(self.call("GET", f"/workouts/{first['id']}")["statusCode"], 404)
        self.assertEqual(decode(self.call("GET", "/workouts"))["total"], 1)

    def test_upload_replaces_samples_on_repeat(self):
        payload = workout_payload("0000000000009-00009", "2026-11-22T07:00:00+00:00")
        self.call("POST", "/workouts", payload)

        payload["samples"] = [{"t": 0, "cadence": 60, "speed": 10, "resistance": 5, "distance": 0.1}]
        payload["sample_count"] = 1
        self.call("POST", "/workouts", payload)

        detail = decode(self.call("GET", f"/workouts/{payload['id']}"))
        self.assertEqual(len(detail["samples"]), 1)

    def test_workout_validation(self):
        bad = workout_payload("bad id!", "2026-11-22T07:00:00+00:00")
        self.assertEqual(self.call("POST", "/workouts", bad)["statusCode"], 400)

        missing = workout_payload("0000000000010-00010", "")
        missing.pop("started_at")
        self.assertEqual(self.call("POST", "/workouts", missing)["statusCode"], 400)

    def test_stats_and_export(self):
        self.call("POST", "/workouts", workout_payload(
            "0000000000003-00003", "2026-11-23T07:00:00+00:00", duration=600, distance=4.0))
        self.call("POST", "/workouts", workout_payload(
            "0000000000004-00004", "2026-11-24T07:00:00+00:00", duration=1200, distance=8.0))

        stats = decode(self.call("GET", "/stats", query={"days": "30", "today": "2026-11-24"}))
        self.assertEqual(stats["range_days"], 30)
        self.assertEqual(len(stats["daily"]), 30)
        self.assertEqual(stats["daily"][-1]["workouts"], 1)
        self.assertEqual(stats["totals"]["lifetime"]["workouts"], 2)
        self.assertEqual(stats["totals"]["lifetime"]["minutes"], 30.0)
        self.assertEqual(stats["totals"]["week"]["distance_km"], 12.0)
        self.assertEqual(stats["streak_days"], 2)
        self.assertEqual(stats["bests"]["longest"]["id"], "0000000000004-00004")

        exported = self.call("GET", "/export.csv")
        self.assertEqual(exported["statusCode"], 200)
        self.assertIn("text/csv", exported["headers"]["content-type"])
        lines = exported["body"].strip().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[0].startswith("id,started_at,ended_at,date"))

    def test_unknown_route_returns_404(self):
        self.assertEqual(self.call("GET", "/nope")["statusCode"], 404)


if __name__ == "__main__":
    unittest.main()
