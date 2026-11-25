# AWS service

AWS compute has no Bluetooth radio, so the machine next to the bike owns the
BLE link and everything else lives in AWS:

```text
     GitHub Pages ──HTTPS──> API Gateway ──> Lambda ──> DynamoDB
       dashboard                 ▲
                                 │ HTTPS (agent polls commands,
                                 │        pushes telemetry + workouts)
                    aws_agent.py on the BLE-capable machine
                                 │
                             Bluetooth
                                 │
                               Bike
```

The web dashboard is a static site, so it can be hosted on GitHub Pages. The
agent keeps a local SQLite copy of your rides, so a network outage never loses
a workout, and it keeps live telemetry flowing to AWS so any device can watch
the ride.

## What the stack creates

- API Gateway HTTP API (CORS for the dashboard origin)
- One Lambda function for every route
- DynamoDB table for live state, events, commands, and workout history
- IAM role and CloudWatch log group

Everything is pay-per-request; normal personal use stays inside the AWS free
tier.

## Deploy

Prerequisites: AWS CLI v2 configured with credentials, and permission to create
IAM roles, Lambda functions, API Gateway APIs, DynamoDB tables, and log groups.

```bash
TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"

aws cloudformation deploy \
  --template-file cloudformation/echelon-aws.yaml \
  --stack-name echelon-ride \
  --parameter-overrides ApiToken="$TOKEN" TableName=echelon-state \
  --capabilities CAPABILITY_IAM \
  --region us-east-1
```

PowerShell:

```powershell
$token = python -c "import secrets; print(secrets.token_urlsafe(32))"
aws cloudformation deploy --template-file cloudformation/echelon-aws.yaml `
  --stack-name echelon-ride `
  --parameter-overrides "ApiToken=$token" "TableName=echelon-state" `
  --capabilities CAPABILITY_IAM --region us-east-1
```

Get the API URL:

```bash
aws cloudformation describe-stacks --stack-name echelon-ride \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text
```

Keep the token somewhere safe: it is a `NoEcho` parameter and is not returned by
the stack.

### Lock down CORS (recommended after the first deploy)

The template allows any origin by default so the dashboard works from any host.
Once you know your Pages URL, redeploy with your origin:

```bash
aws cloudformation deploy \
  --template-file cloudformation/echelon-aws.yaml \
  --stack-name echelon-ride \
  --parameter-overrides ApiToken="$TOKEN" AllowedOrigins="https://YOUR_USER.github.io" \
  --capabilities CAPABILITY_IAM --region us-east-1
```

`AllowedOrigins` is a comma-delimited list; it accepts several origins.

## Run the agent

On the machine that can see the bike:

```bash
pip install -r requirements.txt
export ECHELON_API_URL="https://YOUR_API_ID.execute-api.REGION.amazonaws.com"
export ECHELON_API_TOKEN="the-token-from-the-deploy-step"
python aws_agent.py
```

PowerShell:

```powershell
$env:ECHELON_API_URL = "https://YOUR_API_ID.execute-api.REGION.amazonaws.com"
$env:ECHELON_API_TOKEN = "the-token-from-the-deploy-step"
python aws_agent.py
```

What the agent does:

- Drives the same BLE handshake as the local dashboard (`bike.py`).
- Records every ride into `data/echelon.db` (override with `ECHELON_DB`).
- Pushes status, telemetry, and the active workout once per second (throttled to
  one heartbeat per 30 seconds while idle).
- Uploads completed workouts to DynamoDB as soon as they finish, and backfills
  up to `ECHELON_SYNC_LIMIT` (default 200) recent local workouts on startup.
  Uploads are idempotent, so a retry never duplicates a ride.
- Executes `scan`, `connect`, `disconnect`, `workout_start`, and `workout_stop`
  commands queued by the dashboard, about one second after they are created.

Do not run `app.py` and `aws_agent.py` at the same time on the same machine:
both try to own the BLE adapter. Use the local dashboard or the AWS agent,
whichever fits the session.

To keep the agent running in the background on Windows, use Task Scheduler with
`python aws_agent.py` and the two environment variables set as machine or user
variables. On Linux/macOS, a systemd unit or `launchd` job works the same way.

## Host the dashboard on GitHub Pages

The repository ships a workflow that builds the dashboard from the shared
`static/` assets plus the browser transport (`web/cloud.js`) and pushes the
result to a `production` branch:

1. Push the repository to GitHub (the workflow runs on pushes to `main` or
   `master`, or start it manually under **Actions → Publish dashboard to
   production branch → Run workflow**).
2. In **Settings → Pages**, set **Source** to **Deploy from a branch**, choose
   the **`production`** branch and the **`/ (root)`** folder, then save.
3. Open `https://YOUR_USER.github.io/YOUR_REPO/` and paste the API token into
   the settings dialog.

The workflow force-pushes a single commit containing only the built site, so the
`production` branch always mirrors `web/dist` and never accumulates history.
Rebuilds happen automatically; there is no Pages API or artifact step involved.

The API URL is baked into the build (default
`https://z9ngz05zw0.execute-api.us-east-1.amazonaws.com`; override with
`--api-url` or the `ECHELON_API_URL` repository variable). The token and display
preferences are stored in the browser's `localStorage` under `echelon.apiToken`,
`echelon.apiUrl`, `echelon.units` (`mi` or `km`, default `mi`), and
`echelon.theme` (`light` or `dark`, default `light`). The **Settings** dialog
opened from the gear in the header holds the bike connection controls (status,
Scan, Connect/Disconnect), the connection log, the display preferences, and the
API credentials.

### Local preview

```bash
python web/build.py
python -m http.server 8080 --directory web/dist
```

`web/build.py` copies `static/index.html`, `static/app.js`, and
`static/styles.css`, adds `cloud.js`, rewrites the asset paths with a content
hash, and injects `config.js`. Pass `--api-url https://...` to change the API
URL baked into the site.

## API

All routes except `/health` require the header:

```text
x-api-token: <ApiToken>
```

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Health check, no token required |
| GET | `/status` | Flat live status (state, device, latest telemetry, active workout) |
| GET | `/events` | Last 100 connection-log events |
| POST | `/scan` | Queue a BLE scan; returns a `command_id` |
| GET | `/scan-result` | Latest scan result produced by the agent |
| POST | `/scan-result` | Agent-only scan result upload |
| POST | `/connect` | Queue a connection; body `{"address":"...","name":"..."}` |
| POST | `/disconnect` | Queue a disconnect |
| POST | `/telemetry` | Agent-only status/telemetry/event upload |
| GET | `/commands` | Agent-only command poll/claim |
| POST | `/commands/{id}/ack` | Agent-only command acknowledgement |
| GET | `/workouts` | Saved workouts, newest first (`limit`, `offset`) |
| POST | `/workouts` | Agent-only workout upload (idempotent on `id`) |
| GET | `/workouts/active` | Active workout with in-progress samples |
| POST | `/workouts/start` | Queue a manual workout start |
| POST | `/workouts/stop` | Queue a manual workout stop |
| GET | `/workouts/{id}` | One workout with its samples |
| DELETE | `/workouts/{id}` | Delete a saved workout |
| GET | `/stats` | Daily aggregates, totals, streak, and bests (`days`, `today`) |
| GET | `/export.csv` | All workout summaries as CSV |

`/stats` accepts `today=YYYY-MM-DD` so day boundaries and the streak follow the
viewer's local date instead of UTC. The dashboard sends it automatically.

`POST /scan`, `POST /connect`, `POST /disconnect`, and the workout start/stop
routes are asynchronous. The agent claims the command on its next poll (about
one second), executes it, and acknowledges it. The hosted dashboard hides this
by polling `/status`, `/scan-result`, and `/workouts` for the outcome.

Example:

```bash
API="https://YOUR_API_ID.execute-api.REGION.amazonaws.com"
TOKEN="the-token-from-the-deploy-step"

curl -s -H "x-api-token: $TOKEN" "$API/health"
curl -s -X POST -H "x-api-token: $TOKEN" "$API/scan"
curl -s -H "x-api-token: $TOKEN" "$API/scan-result"
curl -s -X POST -H "x-api-token: $TOKEN" \
  -H "content-type: application/json" \
  -d '{"address":"C8:04:1C:16:B0:11","name":"ECH-SPORT-030107"}' \
  "$API/connect"
curl -s -H "x-api-token: $TOKEN" "$API/status"
curl -s -H "x-api-token: $TOKEN" "$API/workouts?limit=10"
curl -s -H "x-api-token: $TOKEN" "$API/stats?days=30"
```

## Data layout

| Partition key | Sort key | Contents |
| --- | --- | --- |
| `STATE` | `LATEST` | Live status, telemetry, active workout snapshot |
| `EVENT` | `<timestamp>#<rand>` | Connection log, expires after 7 days |
| `COMMAND` | `<uuid>` | Command queue, moved through `StatusIndex` |
| `RESULT` | `SCAN` | Latest BLE scan |
| `WORKOUT` | `<id>` | Workout summary |
| `WORKOUT#SAMPLES` | `<id>#<chunk>` | Workout samples in chunks of 400 |

Workout ids are `<epoch-ms>-<local-id>`, which keeps them sortable and lets the
agent re-upload a workout idempotently.

## Security notes

- The shared token is a simple gate, not a full auth system. Anyone with the
  token can read your ride history and queue commands. Rotate it by updating the
  stack with a new `ApiToken` value and restarting the agent.
- The dashboard stores the token in `localStorage`, so treat the hosted site as
  a personal tool. Do not publish the token in the repository.
- Prefer narrowing `AllowedOrigins` to your Pages origin.
- Events expire after 7 days via DynamoDB TTL.
- DynamoDB point-in-time recovery and encryption at rest are enabled.

## Regenerating the template

The Lambda handler is developed in `aws/lambda/index.py`. The self-contained
template embeds that file so `aws cloudformation deploy` does not need an S3
packaging step. After editing the handler, regenerate and test:

```bash
python cloudformation/build.py
python -m unittest discover -s tests
```
