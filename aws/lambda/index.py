"""AWS API handler for the Echelon control plane.

Runs in Lambda behind API Gateway HTTP API. The BLE work is done by
``aws_agent.py`` on a machine that has the bike's Bluetooth adapter; this
service stores live state, queues commands, and keeps workout history so the
dashboard can be hosted anywhere.

Layout (single table):
    STATE           / LATEST             live status, telemetry, active workout
    EVENT           / <ts>#<rand>        connection log, 7 day TTL
    COMMAND         / <id>               command queue (StatusIndex GSI)
    RESULT          / SCAN               latest BLE scan
    WORKOUT         / <id>               workout summary
    WORKOUT#SAMPLES / <id>#<chunk>       workout samples, chunked
"""

import base64
import csv
import io
import json
import os
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["TABLE_NAME"]
API_TOKEN = os.environ["API_TOKEN"]
TABLE = boto3.resource("dynamodb").Table(TABLE_NAME)

WORKOUT_PK = "WORKOUT"
SAMPLES_PK = "WORKOUT#SAMPLES"
SAMPLE_CHUNK = 400
MAX_WORKOUTS = 5000
# An active-session snapshot older than this is treated as stale (the agent
# stopped mid-ride) instead of a live workout.
ACTIVE_WORKOUT_STALE_SECONDS = 180
ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
SUMMARY_FIELDS = (
    "id", "started_at", "ended_at", "date", "duration_seconds", "distance_km",
    "avg_cadence", "max_cadence", "avg_speed", "max_speed", "avg_resistance",
    "max_resistance", "sample_count", "source",
)
NUMERIC_FIELDS = (
    "duration_seconds", "distance_km", "avg_cadence", "max_cadence", "avg_speed",
    "max_speed", "avg_resistance", "max_resistance", "sample_count",
)


def _decimal(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _decimal(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decimal(item) for item in value]
    return value


def _plain(value):
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


def _response(status, body, *, content_type="application/json", extra_headers=None):
    if not isinstance(body, str):
        body = json.dumps(_plain(body), default=str)
    headers = {"content-type": content_type}
    if extra_headers:
        headers.update(extra_headers)
    return {"statusCode": status, "headers": headers, "body": body}


def _body(event):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _header(event, name):
    headers = event.get("headers") or {}
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value
    return None


def _now():
    return int(time.time())


def _query_all(pk, *, prefix=None, ascending=False, cap=MAX_WORKOUTS):
    condition = Key("pk").eq(pk)
    if prefix:
        condition = condition & Key("sk").begins_with(prefix)
    items = []
    kwargs = {
        "KeyConditionExpression": condition,
        "ScanIndexForward": ascending,
    }
    while True:
        page = TABLE.query(**kwargs)
        items.extend(page.get("Items", []))
        last = page.get("LastEvaluatedKey")
        if not last or len(items) >= cap:
            break
        kwargs["ExclusiveStartKey"] = last
    return items


# ---------------------------------------------------------------- commands
def _create_command(action, payload):
    command_id = uuid.uuid4().hex
    now = _now()
    item = {
        "pk": "COMMAND",
        "sk": command_id,
        "command_id": command_id,
        "action": action,
        "payload": payload or {},
        "status": "pending",
        "gsi1pk": "COMMAND#pending",
        "gsi1sk": f"{now:010d}#{command_id}",
        "created_at": now,
    }
    TABLE.put_item(Item=_decimal(item))
    return command_id


def _claim_commands(limit=10):
    now = _now()

    # Requeue commands an agent claimed but never acknowledged. This keeps a
    # crashed agent from permanently swallowing a command.
    stale = TABLE.query(
        IndexName="StatusIndex",
        KeyConditionExpression=Key("gsi1pk").eq("COMMAND#in_progress"),
        Limit=25,
    ).get("Items", [])
    for item in stale:
        if int(item.get("claimed_at", 0)) >= now - 60:
            continue
        try:
            TABLE.update_item(
                Key={"pk": item["pk"], "sk": item["sk"]},
                UpdateExpression=(
                    "SET gsi1pk = :pending_gsi, #s = :pending_status REMOVE claimed_at"
                ),
                ConditionExpression="gsi1pk = :in_progress_gsi",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":pending_gsi": "COMMAND#pending",
                    ":pending_status": "pending",
                    ":in_progress_gsi": "COMMAND#in_progress",
                },
            )
        except ClientError:
            pass

    pending = TABLE.query(
        IndexName="StatusIndex",
        KeyConditionExpression=Key("gsi1pk").eq("COMMAND#pending"),
        Limit=limit,
    ).get("Items", [])

    claimed = []
    for item in pending:
        try:
            TABLE.update_item(
                Key={"pk": item["pk"], "sk": item["sk"]},
                UpdateExpression=(
                    "SET gsi1pk = :in_progress_gsi, #s = :in_progress_status, claimed_at = :now"
                ),
                ConditionExpression="gsi1pk = :pending_gsi",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":in_progress_gsi": "COMMAND#in_progress",
                    ":in_progress_status": "in_progress",
                    ":pending_gsi": "COMMAND#pending",
                    ":now": now,
                },
            )
        except ClientError:
            continue
        item["status"] = "in_progress"
        claimed.append(item)
    return claimed


# ----------------------------------------------------------------- telemetry
def _store_telemetry(body):
    now = _now()
    # Only touch the fields this post carries: the agent sends "workout" when it
    # has a new snapshot (or an explicit null when the session ends), and every
    # other post must leave the stored one alone.
    sets = ["#status = :status", "#telemetry = :telemetry", "#updated = :updated"]
    removes = []
    names = {
        "#status": "status",
        "#telemetry": "telemetry",
        "#updated": "updated_at",
    }
    values = {
        ":status": _decimal(body.get("status") or {}),
        ":telemetry": _decimal(body.get("telemetry") or {}),
        ":updated": now,
    }
    if "workout" in body:
        names["#workout"] = "workout"
        if body.get("workout") is None:
            removes.append("#workout")
        else:
            sets.append("#workout = :workout")
            values[":workout"] = _decimal(body["workout"])

    expression = "SET " + ", ".join(sets)
    if removes:
        expression += " REMOVE " + ", ".join(removes)
    TABLE.update_item(
        Key={"pk": "STATE", "sk": "LATEST"},
        UpdateExpression=expression,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )

    events = body.get("events") or []
    if events:
        with TABLE.batch_writer() as batch:
            for event in events:
                timestamp = str(event.get("timestamp") or now)
                batch.put_item(Item=_decimal({
                    "pk": "EVENT",
                    "sk": f"{timestamp}#{uuid.uuid4().hex[:8]}",
                    "timestamp": timestamp,
                    "level": event.get("level", "info"),
                    "message": event.get("message", ""),
                    "data": event.get("data"),
                    "ttl": now + 7 * 86400,
                }))


def _latest_state():
    item = TABLE.get_item(Key={"pk": "STATE", "sk": "LATEST"}).get("Item") or {}
    status = dict(_plain(item.get("status") or {}))
    # Return the flat shape the dashboard's /status client expects.
    status.setdefault("state", "disconnected")
    status.setdefault("connected", False)
    status["latest"] = _plain(item.get("telemetry") or {})
    workout = _plain(item.get("workout")) if item.get("workout") is not None else None
    updated_at = _plain(item.get("updated_at"))
    # A snapshot left behind by an agent that stopped mid-session must not read
    # as a live workout, so both /status and /workouts/active apply the same rule.
    if (
        workout is not None
        and isinstance(updated_at, (int, float))
        and _now() - float(updated_at) > ACTIVE_WORKOUT_STALE_SECONDS
    ):
        workout = None
    status["workout"] = workout
    status["updated_at"] = updated_at
    return status


# ------------------------------------------------------------------ workouts
def _coerce_summary(body):
    summary = {}
    for field in SUMMARY_FIELDS:
        value = body.get(field)
        if field in NUMERIC_FIELDS:
            if value is None or value == "":
                summary[field] = 0 if field in ("duration_seconds", "sample_count") else None
            else:
                try:
                    number = float(value)
                except (TypeError, ValueError):
                    return None
                summary[field] = (
                    int(number) if field in ("duration_seconds", "sample_count") else number
                )
        else:
            summary[field] = value
    return summary


def _clean_samples(samples):
    if not isinstance(samples, list):
        return []
    cleaned = []
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        try:
            entry = {"t": int(sample.get("t") or 0)}
        except (TypeError, ValueError):
            continue
        for key in ("cadence", "speed", "resistance", "distance"):
            value = sample.get(key)
            if value is None:
                entry[key] = None
                continue
            try:
                entry[key] = float(value)
            except (TypeError, ValueError):
                entry[key] = None
        cleaned.append(entry)
    return cleaned


def _put_workout(body):
    workout_id = str(body.get("id") or "").strip()
    if not ID_PATTERN.match(workout_id):
        return None, "id must match ^[A-Za-z0-9_.:-]{1,80}$"
    summary = _coerce_summary(body)
    if summary is None:
        return None, "numeric workout fields must be numbers"
    if not summary.get("started_at"):
        return None, "started_at is required"
    if not summary.get("date"):
        summary["date"] = str(summary["started_at"])[:10]
    summary["id"] = workout_id
    summary["updated_at"] = _now()

    TABLE.put_item(Item=_decimal({"pk": WORKOUT_PK, "sk": workout_id, **summary}))

    samples = _clean_samples(body.get("samples") or [])
    chunks = [samples[index:index + SAMPLE_CHUNK]
              for index in range(0, len(samples), SAMPLE_CHUNK)]
    keep = {f"{workout_id}#{index:04d}" for index in range(len(chunks))}
    existing = _query_all(SAMPLES_PK, prefix=f"{workout_id}#", cap=100000)
    with TABLE.batch_writer() as batch:
        # A batch cannot delete and rewrite the same key, so only drop chunks
        # that the new upload no longer covers; the rest are overwritten.
        for item in existing:
            if item["sk"] not in keep:
                batch.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
        for index, chunk in enumerate(chunks):
            batch.put_item(Item=_decimal({
                "pk": SAMPLES_PK,
                "sk": f"{workout_id}#{index:04d}",
                "samples": chunk,
            }))

    summary["sample_count"] = summary.get("sample_count") or len(samples)
    return summary, None


def _delete_workout(workout_id):
    existing = TABLE.get_item(Key={"pk": WORKOUT_PK, "sk": workout_id}).get("Item")
    if not existing:
        return False
    chunks = _query_all(SAMPLES_PK, prefix=f"{workout_id}#", cap=100000)
    with TABLE.batch_writer() as batch:
        batch.delete_item(Key={"pk": WORKOUT_PK, "sk": workout_id})
        for item in chunks:
            batch.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
    return True


def _samples_for(workout_id):
    items = _query_all(SAMPLES_PK, prefix=f"{workout_id}#", ascending=True, cap=100000)
    samples = []
    for item in items:
        samples.extend(_plain(item.get("samples") or []))
    return samples


def _workout_summaries():
    summaries = []
    for item in _query_all(WORKOUT_PK, ascending=False):
        plain = _plain(item)
        summary = {field: plain.get(field) for field in SUMMARY_FIELDS}
        summary["id"] = plain.get("sk")
        summary["updated_at"] = plain.get("updated_at")
        summaries.append(summary)
    summaries.sort(key=lambda w: (str(w.get("started_at") or ""), str(w.get("id") or "")), reverse=True)
    return summaries


def _get_workout(workout_id, include_samples=True):
    item = TABLE.get_item(Key={"pk": WORKOUT_PK, "sk": workout_id}).get("Item")
    if not item:
        return None
    plain = _plain(item)
    workout = {field: plain.get(field) for field in SUMMARY_FIELDS}
    workout["id"] = plain.get("sk")
    workout["updated_at"] = plain.get("updated_at")
    if include_samples:
        workout["samples"] = _samples_for(workout_id)
    return workout


def _iso_date(value):
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _int(value, default, minimum=None, maximum=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    if minimum is not None:
        number = max(minimum, number)
    if maximum is not None:
        number = min(maximum, number)
    return number


def _stats(days, today=None):
    days = _int(days, 30, 1, 365)
    today_date = _iso_date(today) or datetime.now(timezone.utc).date()
    start = today_date - timedelta(days=days - 1)

    summaries = _workout_summaries()
    buckets = {}
    lifetime_seconds = 0.0
    lifetime_distance = 0.0
    week_workouts = 0
    week_seconds = 0.0
    week_distance = 0.0
    week_start = today_date - timedelta(days=6)
    bests = {"longest": None, "farthest": None, "fastest_cadence": None}
    best_columns = (
        ("longest", "duration_seconds"),
        ("farthest", "distance_km"),
        ("fastest_cadence", "max_cadence"),
    )

    for workout in summaries:
        workout_date = _iso_date(workout.get("date"))
        seconds = float(workout.get("duration_seconds") or 0)
        distance = float(workout.get("distance_km") or 0)
        lifetime_seconds += seconds
        lifetime_distance += distance
        if workout_date and workout_date >= week_start:
            week_workouts += 1
            week_seconds += seconds
            week_distance += distance
        if workout_date and workout_date >= start:
            bucket = buckets.setdefault(workout_date.isoformat(), {
                "workouts": 0, "seconds": 0.0, "distance": 0.0,
                "cadence_sum": 0.0, "cadence_n": 0, "max_cadence": None,
                "speed_sum": 0.0, "speed_n": 0, "resistance_sum": 0.0, "resistance_n": 0,
            })
            bucket["workouts"] += 1
            bucket["seconds"] += seconds
            bucket["distance"] += distance
            if workout.get("avg_cadence") is not None:
                bucket["cadence_sum"] += float(workout["avg_cadence"])
                bucket["cadence_n"] += 1
            if workout.get("max_cadence") is not None:
                bucket["max_cadence"] = max(
                    bucket["max_cadence"] or 0, float(workout["max_cadence"])
                )
            if workout.get("avg_speed") is not None:
                bucket["speed_sum"] += float(workout["avg_speed"])
                bucket["speed_n"] += 1
            if workout.get("avg_resistance") is not None:
                bucket["resistance_sum"] += float(workout["avg_resistance"])
                bucket["resistance_n"] += 1

        for key, column in best_columns:
            value = workout.get(column)
            if value is None:
                continue
            current = bests[key]
            if current is None or float(value) > float(current.get(column) or 0):
                bests[key] = workout

    daily = []
    for offset in range(days):
        day = start + timedelta(days=offset)
        bucket = buckets.get(day.isoformat())
        daily.append({
            "date": day.isoformat(),
            "workouts": bucket["workouts"] if bucket else 0,
            "minutes": round(bucket["seconds"] / 60.0, 1) if bucket else 0.0,
            "seconds": int(bucket["seconds"]) if bucket else 0,
            "distance_km": round(bucket["distance"], 2) if bucket else 0.0,
            "avg_cadence": round(bucket["cadence_sum"] / bucket["cadence_n"], 1)
            if bucket and bucket["cadence_n"] else None,
            "max_cadence": round(bucket["max_cadence"], 1)
            if bucket and bucket["max_cadence"] is not None else None,
            "avg_speed": round(bucket["speed_sum"] / bucket["speed_n"], 1)
            if bucket and bucket["speed_n"] else None,
            "avg_resistance": round(bucket["resistance_sum"] / bucket["resistance_n"], 1)
            if bucket and bucket["resistance_n"] else None,
        })

    today_row = daily[-1] if daily else None

    dates = {day for day in (_iso_date(workout.get("date")) for workout in summaries) if day}
    streak = 0
    cursor = today_date
    if cursor not in dates:
        cursor -= timedelta(days=1)
    while cursor in dates:
        streak += 1
        cursor -= timedelta(days=1)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "range_days": days,
        "daily": daily,
        "totals": {
            "today": today_row,
            "week": {
                "workouts": week_workouts,
                "seconds": int(week_seconds),
                "minutes": round(week_seconds / 60.0, 1),
                "distance_km": round(week_distance, 2),
            },
            "lifetime": {
                "workouts": len(summaries),
                "seconds": int(lifetime_seconds),
                "minutes": round(lifetime_seconds / 60.0, 1),
                "distance_km": round(lifetime_distance, 2),
            },
        },
        "streak_days": streak,
        "bests": bests,
    }


def _export_csv():
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=SUMMARY_FIELDS, extrasaction="ignore")
    writer.writeheader()
    for workout in _workout_summaries():
        writer.writerow({field: workout.get(field) for field in SUMMARY_FIELDS})
    return buffer.getvalue()


# -------------------------------------------------------------------- routes
def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")
    query = event.get("queryStringParameters") or {}

    if path == "/health":
        return _response(200, {"ok": True})

    if _header(event, "x-api-token") != API_TOKEN:
        return _response(401, {"error": "unauthorized"})

    try:
        if path == "/status" and method == "GET":
            return _response(200, _latest_state())

        if path == "/events" and method == "GET":
            items = TABLE.query(
                KeyConditionExpression=Key("pk").eq("EVENT"),
                ScanIndexForward=False,
                Limit=100,
            ).get("Items", [])
            return _response(200, [
                {key: value for key, value in _plain(item).items() if key not in ("pk", "ttl")}
                for item in items
            ])

        if path == "/scan" and method == "POST":
            command_id = _create_command("scan", {})
            return _response(202, {"command_id": command_id, "status": "pending"})

        if path == "/scan-result" and method == "GET":
            item = TABLE.get_item(Key={"pk": "RESULT", "sk": "SCAN"}).get("Item") or {}
            return _response(200, {
                "devices": _plain(item.get("devices", [])),
                "updated_at": _plain(item.get("updated_at")),
            })

        if path == "/scan-result" and method == "POST":
            body = _body(event)
            TABLE.put_item(Item=_decimal({
                "pk": "RESULT",
                "sk": "SCAN",
                "devices": body.get("devices") or [],
                "updated_at": _now(),
            }))
            return _response(200, {"ok": True})

        if path == "/connect" and method == "POST":
            body = _body(event)
            address = str(body.get("address") or "").strip()
            if not address:
                return _response(400, {"error": "address is required"})
            command_id = _create_command("connect", {
                "address": address,
                "name": body.get("name") or "Echelon",
            })
            return _response(202, {"command_id": command_id, "status": "pending"})

        if path == "/disconnect" and method == "POST":
            command_id = _create_command("disconnect", {})
            return _response(202, {"command_id": command_id, "status": "pending"})

        if path == "/workouts/start" and method == "POST":
            command_id = _create_command("workout_start", {})
            return _response(202, {"command_id": command_id, "status": "pending"})

        if path == "/workouts/stop" and method == "POST":
            command_id = _create_command("workout_stop", {})
            return _response(202, {"command_id": command_id, "status": "pending"})

        if path == "/workouts/active" and method == "GET":
            workout = _latest_state().get("workout")
            return _response(200, {"active": workout is not None, "workout": workout})

        if path == "/workouts" and method == "POST":
            summary, error = _put_workout(_body(event))
            if error:
                return _response(400, {"error": error})
            return _response(200, {"ok": True, "workout": summary})

        if path == "/workouts" and method == "GET":
            limit = _int(query.get("limit"), 50, 1, 500)
            offset = _int(query.get("offset"), 0, 0)
            summaries = _workout_summaries()
            return _response(200, {
                "workouts": summaries[offset:offset + limit],
                "total": len(summaries),
                "limit": limit,
                "offset": offset,
            })

        if path == "/stats" and method == "GET":
            return _response(200, _stats(query.get("days"), query.get("today")))

        if path == "/export.csv" and method == "GET":
            return _response(
                200,
                _export_csv(),
                content_type="text/csv; charset=utf-8",
                extra_headers={"content-disposition": 'attachment; filename="echelon-workouts.csv"'},
            )

        if path.startswith("/workouts/") and len(path) > len("/workouts/"):
            workout_id = path[len("/workouts/"):]
            if method == "GET":
                workout = _get_workout(workout_id)
                if workout is None:
                    return _response(404, {"error": "workout not found"})
                return _response(200, workout)
            if method == "DELETE":
                if not _delete_workout(workout_id):
                    return _response(404, {"error": "workout not found"})
                return _response(200, {"ok": True, "id": workout_id})

        if path == "/telemetry" and method == "POST":
            _store_telemetry(_body(event))
            return _response(200, {"ok": True})

        if path == "/commands" and method == "GET":
            return _response(200, {"commands": _claim_commands()})

        if path.startswith("/commands/") and path.endswith("/ack") and method == "POST":
            command_id = (event.get("pathParameters") or {}).get("id")
            if not command_id:
                return _response(400, {"error": "command id is required"})
            result = _body(event)
            try:
                TABLE.update_item(
                    Key={"pk": "COMMAND", "sk": command_id},
                    UpdateExpression=(
                        "SET gsi1pk = :done_gsi, #s = :done_status, "
                        "completed_at = :now, #r = :result"
                    ),
                    ConditionExpression="attribute_exists(pk)",
                    ExpressionAttributeNames={"#s": "status", "#r": "result"},
                    ExpressionAttributeValues={
                        ":done_gsi": "COMMAND#done",
                        ":done_status": "done",
                        ":now": _now(),
                        ":result": _decimal(result),
                    },
                )
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                    return _response(404, {"error": "command not found"})
                raise
            return _response(200, {"ok": True})

        return _response(404, {"error": "not found", "method": method, "path": path})
    except Exception as exc:
        return _response(500, {"error": str(exc)})
