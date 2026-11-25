# Echelon Local BLE + Telemetry (Python)

A local-first reference implementation for connecting to an Echelon bike over BLE,
observing notifications, attempting the publicly documented QZ direct challenge-response
flow, and publishing normalized telemetry to a browser dashboard.

The dashboard also keeps a local workout journal: rides are recorded automatically,
saved to SQLite, and charted across days with daily goals and trends.

## Important compatibility notes

- This is a best-effort reference client, not a guarantee for every Echelon model/firmware.
- It uses the QZ GATT UUIDs and the direct challenge-response routine currently present in
  QZ's public source. Newer firmware has also been reported to use an app/server-mediated
  startup authorization flow. If the direct handshake fails, this project will not emulate
  Echelon's servers or extract rotating credentials; use the official app/QZ's supported
  bridge workflow instead.
- QZ source references:
  - https://github.com/cagnulein/qdomyos-zwift/blob/master/src/devices/echelonconnectsport/echelonconnectsport.cpp
  - https://raw.githubusercontent.com/cagnulein/qdomyos-zwift/master/src/devices/echelonconnectsport/echelonunlock.cpp
- QZ's unlock source attributes discovery/documentation of the challenge-response algorithm
  to Christian Emerson (@christianbemerson). Preserve that attribution if reusing/redistributing
  the protocol codec. Review the upstream license and any applicable legal restrictions.
- Only use on a bike you own or are authorized to operate. This app only listens for telemetry
  and sends the QZ-documented initialization/unlock frames; it does not send resistance changes.

## Requirements

- Python 3.11+
- Bluetooth Low Energy adapter and OS Bluetooth enabled
- Windows 10/11, Linux, or macOS. BLE permissions/driver setup vary by OS.
- Keep the official Echelon app disconnected while testing to avoid BLE connection conflicts.

## Install / run (Windows PowerShell)

```powershell
cd echelon_local
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:8000 in your browser.

## Install / run (Linux/macOS)

```bash
cd echelon_local
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python app.py
```

Open http://127.0.0.1:8000.

## Use

1. Power the bike on.
2. Open the dashboard and click **Scan**.
3. Select the device whose name matches your bike, normally beginning with `ECH`.
4. Click **Connect**.
5. Review the event log. If the 0xF0 0xE0 challenge is seen, the client attempts the
   QZ direct response and sends the activation command 500 ms later.
6. A connection is not considered successful merely because BLE connects. Wait for valid
   post-unlock packets and compare displayed cadence/resistance/distance with the bike.

The client also sends QZ's `F0 A0` poll every 2 seconds, which keeps the bike from dropping
an otherwise idle BLE connection.

## Access from another device on your LAN

By default the server binds to `127.0.0.1`, which only this computer can reach. To view the
dashboard from a phone, tablet, or another PC on the same Wi-Fi/LAN, bind to all interfaces:

```powershell
$env:ECHELON_HOST = "0.0.0.0"
python app.py
```

Linux/macOS:

```bash
ECHELON_HOST=0.0.0.0 python app.py
```

Find this machine's LAN IPv4 address:

```powershell
ipconfig
```

Look for the **IPv4 Address** of your active adapter (for example `192.168.1.42`), then open
this on the other device:

```text
http://192.168.1.42:8000
```

Notes:

- Both devices must be on the same network. Guest Wi-Fi or router "AP isolation" can block
  device-to-device traffic.
- Windows may prompt to allow Python through the firewall. Allow it on **Private networks**
  only. If needed:
  ```powershell
  New-NetFirewallRule -DisplayName "Echelon Local" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
  ```
- Change the port with `ECHELON_PORT=8080`.
- The BLE connection still runs on the machine with the Bluetooth adapter. Other devices are
  only viewing/controlling that dashboard.

### PIN protection

When you bind to a non-loopback address, the dashboard automatically enables a PIN gate. On
the first LAN start it generates a six-digit PIN, prints it in the terminal, and saves it to
`data/access_pin.txt`:

```text
Generated access PIN: 482913
PIN saved to ...\data\access_pin.txt
```

Open the dashboard, enter that PIN, and you are signed in for 30 days on that browser. The
**Lock** button in the dashboard header clears the session immediately.

Choose your own PIN instead (letters and digits are fine):

```powershell
$env:ECHELON_HOST = "0.0.0.0"
$env:ECHELON_PIN = "my-ride-pin"
python app.py
```

Other details:

- `ECHELON_PIN` enables the gate even on `127.0.0.1`. Use `ECHELON_AUTH=1` to force it on
  without setting a PIN; the PIN is then generated in `data/access_pin.txt`.
- The automatic LAN detection reads `ECHELON_HOST`. If you launch with
  `uvicorn app:app --host 0.0.0.0` instead of `python app.py`, set `ECHELON_AUTH=1` (or
  `ECHELON_PIN`) so the gate is enabled.
- Sessions use an HMAC-signed, `HttpOnly`, `SameSite=Lax` cookie. The signing secret lives in
  memory, so restarting the server signs everyone out. The PIN itself is unchanged.
- Five failed attempts from one address are rate-limited for five minutes.
- `/health`, `/login`, `/logout`, and `/static/*` stay public; the dashboard, API, and
  WebSocket require the session cookie.
- This is a convenience gate for a trusted home network, not internet-grade authentication.
  Do not port-forward the server. Delete `data/access_pin.txt` to generate a new PIN.
- The PIN and session cookie travel over plain HTTP on your LAN, so use this only on a
  trusted network. Put the app behind HTTPS in front of a reverse proxy if you need encryption.

## Dashboard and workout history

The browser dashboard has three views:

- **Live** — cadence, resistance, estimated speed, distance, elapsed time, estimated power,
  and a live session chart you can switch between cadence, speed, and resistance.
- **Trends** — minutes, distance, or average cadence per day over 7/14/30/90 days, plus
  weekly totals, current streak, all-time distance, and best ride.
- **Workouts** — every saved session with duration, distance, cadence, resistance, and a
  per-workout chart. Rows can be deleted, and all summaries export to CSV.

A daily minutes goal (stored in the browser) drives the progress ring. The goal is a
display preference only; it is not written to the database.

### Display settings

Two controls in the header are stored in the browser:

- **mi / km** — distance and speed units. Miles and mph are the default.
- **Theme** — white (default) or dark. Both are flat, gradient-free themes.

On phones the three views become separate pages navigated from a floating,
glass-style bar at the bottom. Live, Trends, and Workouts each deep-link by hash
(`#live`, `#trends`, `#history`), and on wider screens the dashboard keeps the
single scrolling layout with the top navigation.

History is stored in kilometres, so switching units never rewrites data; only the display
changes. CSV export keeps `distance_km` and `avg_speed` (km/h) columns.

### How recording works

- Recording starts automatically on the first telemetry showing movement (cadence above
  zero), or immediately when you press **Start workout**.
- One sample is stored every 5 seconds. The workout row is checkpointed every 30 seconds
  so a crash loses at most half a minute of samples.
- A workout is saved when you press **Stop workout**, disconnect, or shut the server down.
  Sessions with under 10 seconds and fewer than 2 samples are discarded as noise.
- Bike elapsed time is used for duration when available, with wall-clock time as fallback.
  Distance is the delta of the bike's session distance, so a stale value from a previous
  ride does not inflate a new workout.
- After a manual stop, auto-tracking stays paused until you start again or reconnect.

History lives in `data/echelon.db` (SQLite, created on first run). Override the location
with the `ECHELON_DB` environment variable, for example:

```powershell
$env:ECHELON_DB = "D:\ride-data\echelon.db"
python app.py
```

Back up or move the dashboard by copying that one file. The `data/` directory is ignored
by Git. Dates are grouped by the local date of the server machine, so run the server in
your own timezone.

### History API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/stats?days=30` | Daily aggregates, totals, streak, and personal bests |
| GET | `/api/workouts?limit=100` | Saved workouts, newest first |
| GET | `/api/workouts/{id}` | One workout with its 5-second samples |
| DELETE | `/api/workouts/{id}` | Delete a saved workout (active workout is protected) |
| GET | `/api/workout/active` | Active workout with in-memory samples |
| POST | `/api/workout/start` | Start a manual workout |
| POST | `/api/workout/stop` | Stop and save the active workout |
| GET | `/api/export.csv` | All workout summaries as CSV |

The dashboard can deep-link directly to a session, e.g.
`http://127.0.0.1:8000/?workout=12`.

## Metrics / parser limitations

The parser only exposes fields directly supported by the public QZ packet parsing:
- 13-byte frame: elapsed minutes/seconds from bytes 3-4, distance from bytes 7-8 / 100,
  cadence from byte 10.
- 5-byte F0 D2 frame: resistance from byte 3.

Speed is an estimate from cadence using the relationship QZ uses for its non-power-based
speed mode (0.375 km/h per rpm).

Power is an estimate, not a measurement. The bike never reports watts, so the dashboard
derives them from the cadence and resistance it does stream, using the empirical model in
`power.py`:

```python
magnetic   = 0.0022 * e^(0.115 * resistance) * cadence^1.85
drivetrain = 0.25 * cadence
watts      = (magnetic + drivetrain) * gain          # gain defaults to 1.0
```

`calculate_echelon_watts(cadence, resistance, gain=1.0, match_official_app=False)` clamps
resistance to 1-32, returns 0 W at zero cadence, and can scale by `gain` for a bike that
feels stiffer or looser than average. `match_official_app=True` applies another 1.2x to
line up with the more generous official Echelon Fit app readings. The browser build uses
its own port of the same formula, and the test suite asserts both produce identical values.
Treat the number as comparative effort, not as a calibrated power meter.

## Run on AWS (hosted dashboard, phone or agent for Bluetooth)

AWS compute does not provide a Bluetooth radio, so something near the bike must hold the
BLE link. The hosted dashboard supports both possibilities:

- **This device (Bluetooth)** — the browser connects straight to the bike with Web
  Bluetooth. Use Chrome on Android or desktop Chrome/Edge; iPhone, iPad and Firefox have no
  Web Bluetooth, so they cannot use this mode. No agent process is needed.
- **Remote agent (AWS)** — `aws_agent.py` runs on a computer near the bike and bridges BLE
  to the API. Use this on iPhone or when the PC stays next to the bike.

In both modes AWS stores workout history, so the dashboard shows the same journal from any
device:

- **AWS** — API Gateway + Lambda + DynamoDB keep workout history, live state, and commands.
- **GitHub Pages** — the dashboard, served statically, talks to that API.
- **Phone or agent** — owns the BLE adapter and uploads finished workouts.

Deploy the service:

```powershell
$token = python -c "import secrets; print(secrets.token_urlsafe(32))"
aws cloudformation deploy --template-file cloudformation/echelon-aws.yaml `
  --stack-name echelon-ride `
  --parameter-overrides "ApiToken=$token" "TableName=echelon-state" `
  --capabilities CAPABILITY_IAM --region us-east-1
```

Host the dashboard by pushing this repository to GitHub, setting **Settings → Pages →
Source** to **GitHub Actions**, and opening `https://YOUR_USER.github.io/YOUR_REPO/`. Paste
the API URL and token into the connection dialog once; they stay in that browser. Open
**Settings** at any time to switch between the two Bluetooth modes.

For remote-agent mode, run the agent on the machine with Bluetooth:

```powershell
$env:ECHELON_API_URL = "https://YOUR_API_ID.execute-api.REGION.amazonaws.com"
$env:ECHELON_API_TOKEN = "the-token-from-the-deploy-step"
python aws_agent.py
```

Notes for phone mode:

- The bike connects to the phone directly; the phone must be within Bluetooth range.
- Workouts are recorded in the browser and uploaded when finished. If the upload fails,
  the ride is kept in the browser and retried on the next visit.
- A tab closed mid-ride keeps the partial session and uploads it next time.
- Live data is not streamed to AWS in this mode, so another device cannot watch the ride
  in real time. Use the remote agent if you want that.
- Keep the dashboard open while riding; backgrounded mobile tabs can be suspended.

See `cloudformation/README.md` for the full deploy steps, API reference, CORS lockdown,
and data model.

## Security

The local API binds to `127.0.0.1` by default. When bound to `0.0.0.0` it requires the PIN
session described above, but that is still a simple shared-secret gate: use it only on a
trusted network, restrict the firewall to the private profile, and never port-forward it to
the internet. BLE logs can contain device identifiers; redact them before sharing.
`data/echelon.db` contains your ride history and timestamps, and `data/access_pin.txt` holds
the current PIN — treat both as personal data when backing up or sharing the project folder.

The AWS stack uses a shared `x-api-token` header. It is a simple gate, not a full auth
system: anyone holding the token can read ride history and queue commands, and the hosted
dashboard keeps it in browser storage. Narrow `AllowedOrigins` to your Pages origin, and
rotate the token by updating the stack. Add Cognito or an IAM authorizer for production use.

## Troubleshooting

- No devices found: confirm Bluetooth is enabled, power-cycle the bike, check OS BLE
  permissions, and close other apps connected to the bike.
- Service/characteristic UUIDs missing: your model may use a different protocol; do not
  guess UUIDs. Capture a service listing and adapt the protocol configuration.
- Challenge response seen but no telemetry: updated firmware may require a different startup
  path. Stop repeated attempts; try the official Echelon app and a current supported QZ release.
- Windows BLE issues: run the terminal normally first; ensure Windows Bluetooth is enabled
  and the adapter supports BLE. Do not run multiple BLE clients simultaneously.
