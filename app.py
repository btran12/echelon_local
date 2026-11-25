from __future__ import annotations

import csv
import html
import io
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlencode

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from auth import AuthManager, load_or_create_pin, safe_next
from bike import BikeService
from storage import WorkoutStore

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("ECHELON_DB", str(BASE_DIR / "data" / "echelon.db"))).expanduser()
PIN_PATH = BASE_DIR / "data" / "access_pin.txt"
SESSION_COOKIE = "echelon_session"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("echelon-local")

BIND_HOST = os.environ.get("ECHELON_HOST", "127.0.0.1").strip() or "127.0.0.1"


def is_loopback(host: str) -> bool:
    host = host.strip().lower().strip("[]")
    return host in LOOPBACK_HOSTS or host.startswith("127.")


def build_auth_manager() -> AuthManager | None:
    """Enable the PIN gate for LAN use, a configured PIN, or an explicit opt-in."""
    enabled = os.environ.get("ECHELON_AUTH", "").strip().lower() in {"1", "true", "yes", "on"}
    pin = os.environ.get("ECHELON_PIN", "").strip()
    if not (enabled or pin or not is_loopback(BIND_HOST)):
        log.info("PIN protection is off (local-only). Set ECHELON_PIN to protect remote access.")
        return None
    if pin:
        log.info("PIN protection enabled with ECHELON_PIN.")
        return AuthManager(pin)
    pin, created = load_or_create_pin(PIN_PATH)
    log.info("%s access PIN: %s", "Generated" if created else "Using saved", pin)
    if created:
        log.info("PIN saved to %s", PIN_PATH)
    return AuthManager(pin)


auth_manager = build_auth_manager()
AUTH_REQUIRED = auth_manager is not None


store = WorkoutStore(DB_PATH)
bike = BikeService(store, auth_required=AUTH_REQUIRED)

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await bike.disconnect(quiet=True)
    store.close()

app = FastAPI(title="Echelon Local Telemetry", version="0.2.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

PUBLIC_PATHS = {"/login", "/logout", "/health", "/favicon.ico"}
API_PATHS = {"/status", "/events", "/scan", "/connect", "/disconnect"}


def is_public_path(path: str) -> bool:
    return path in PUBLIC_PATHS or path.startswith("/static/")


def wants_json(request: Request) -> bool:
    if request.url.path.startswith("/api/") or request.url.path in API_PATHS:
        return True
    return "application/json" in request.headers.get("accept", "")


def render_login(error: str = "", next_url: str = "/", status_code: int = 200) -> HTMLResponse:
    template = (BASE_DIR / "static" / "login.html").read_text(encoding="utf-8")
    document = (
        template
        .replace("__ERROR__", html.escape(error))
        .replace("__NEXT__", html.escape(next_url, quote=True))
    )
    return HTMLResponse(document, status_code=status_code)


@app.middleware("http")
async def require_auth(request: Request, call_next):
    path = request.url.path
    if auth_manager is None or is_public_path(path):
        return await call_next(request)
    if auth_manager.verify_session(request.cookies.get(SESSION_COOKIE)):
        return await call_next(request)
    if wants_json(request):
        return JSONResponse(
            status_code=401,
            content={"error": "Authentication required.", "login": "/login"},
        )
    target = path
    if request.url.query:
        target = f"{path}?{request.url.query}"
    return RedirectResponse(f"/login?{urlencode({'next': target})}", status_code=303)


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    target = safe_next(request.query_params.get("next"))
    if auth_manager is None or auth_manager.verify_session(request.cookies.get(SESSION_COOKIE)):
        return RedirectResponse(target, status_code=303)
    return render_login(next_url=target)


@app.post("/login", response_class=HTMLResponse)
async def login_submit(request: Request):
    if auth_manager is None:
        return RedirectResponse("/", status_code=303)
    client = request.client.host if request.client else "unknown"
    raw = await request.body()
    form = parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
    target = safe_next((form.get("next") or ["/"])[0])

    retry = auth_manager.retry_after(client)
    if retry:
        return render_login(
            f"Too many attempts. Try again in {retry} seconds.", target, status_code=429
        )

    pin = (form.get("pin") or [""])[0]
    if not auth_manager.verify_pin(pin):
        auth_manager.record_failure(client)
        return render_login(
            "Incorrect PIN. Check the terminal or data/access_pin.txt.", target, status_code=401
        )

    auth_manager.clear_failures(client)
    response = RedirectResponse(target, status_code=303)
    response.set_cookie(
        SESSION_COOKIE,
        auth_manager.issue_session(),
        max_age=auth_manager.session_ttl,
        httponly=True,
        samesite="lax",
        path="/",
    )
    return response


@app.get("/logout")
async def logout():
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@app.get("/", response_class=HTMLResponse)
async def index():
    return (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")

@app.get("/health")
async def health():
    return {"ok": True, "service": "echelon-local"}

@app.get("/status")
async def status():
    return bike.status()

@app.get("/events")
async def events():
    return JSONResponse(bike.events[-100:])

@app.get("/api/stats")
async def api_stats(days: int = 30):
    return store.stats(days)

@app.get("/api/workouts")
async def api_workouts(limit: int = 50, offset: int = 0):
    return store.list_workouts(limit, offset)

@app.get("/api/workout/active")
async def api_active_workout():
    if bike.recorder and bike.recorder.active:
        return {"active": True, "workout": bike.recorder.live_snapshot()}
    workout = store.active_workout()
    return {"active": workout is not None, "workout": workout}

@app.post("/api/workout/start")
async def api_start_workout():
    workout = await bike.start_workout()
    return {"ok": workout is not None, "workout": workout}

@app.post("/api/workout/stop")
async def api_stop_workout():
    workout = await bike.stop_workout()
    return {"ok": True, "workout": workout}

@app.get("/api/export.csv")
async def api_export_csv():
    rows = store.export_rows()
    fields = [
        "date", "started_at", "ended_at", "duration_seconds", "distance_km",
        "avg_cadence", "max_cadence", "avg_speed", "max_speed",
        "avg_resistance", "max_resistance", "sample_count", "source",
    ]
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return PlainTextResponse(
        buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="echelon-workouts.csv"'},
    )

@app.get("/api/workouts/{workout_id}")
async def api_workout(workout_id: int):
    workout = store.get_workout(workout_id)
    if workout is None:
        return JSONResponse(status_code=404, content={"error": "workout not found"})
    return workout

@app.delete("/api/workouts/{workout_id}")
async def api_delete_workout(workout_id: int):
    if bike.recorder and bike.recorder.workout_id == workout_id:
        return JSONResponse(
            status_code=409,
            content={"error": "Cannot delete the workout that is currently being recorded."},
        )
    if not store.delete_workout(workout_id):
        return JSONResponse(status_code=404, content={"error": "workout not found"})
    await bike.broadcast({"type": "workout", "event": "deleted", "workout_id": workout_id})
    return {"ok": True, "id": workout_id}

@app.post("/scan")
async def scan():
    try:
        return {"devices": await bike.scan()}
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})

@app.post("/connect")
async def connect(body: dict[str, str]):
    address = body.get("address", "").strip()
    name = body.get("name", "Echelon")
    if not address:
        return JSONResponse(status_code=400, content={"error": "address is required"})
    try:
        await bike.connect(address, name)
        return bike.status()
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc), "status": bike.status()})

@app.post("/disconnect")
async def disconnect():
    await bike.disconnect()
    return bike.status()

@app.websocket("/ws/telemetry")
async def telemetry_ws(ws: WebSocket):
    await ws.accept()
    if auth_manager is not None and not auth_manager.verify_session(ws.cookies.get(SESSION_COOKIE)):
        await ws.close(code=1008, reason="authentication required")
        return
    bike.clients.add(ws)
    await ws.send_json({"type": "status", "status": bike.status()})
    await ws.send_json({"type": "telemetry", "telemetry": bike.latest})
    try:
        while True:
            # Keepalive; client messages are not interpreted as bike commands.
            await ws.receive_text()
    except WebSocketDisconnect:
        bike.clients.discard(ws)
    except Exception:
        bike.clients.discard(ws)

if __name__ == "__main__":
    import uvicorn

    host = BIND_HOST
    try:
        port = int(os.environ.get("ECHELON_PORT", "8000"))
    except ValueError:
        raise SystemExit("ECHELON_PORT must be a number")
    uvicorn.run(app, host=host, port=port, reload=False)
