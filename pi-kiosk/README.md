# FW Gatekeeper — Pi Kiosk Face Scanner

Raspberry Pi face recognition kiosk for factory clock-in/clock-out.

## How It Works

- `main.py` is the entry point (run by the `fw-gatekeeper-kiosk` systemd service).
- The camera runs continuously; dlib HOG finds faces, MobileFaceNet ONNX
  encodes them as 512-dim embeddings (the same model family the server uses),
  and matching is cosine similarity against locally cached worker encodings.
- A Flask web UI on port `5555` (loopback by default) shows the live camera
  feed, status messages, and today's log; Firefox ESR in kiosk mode displays it
  fullscreen on the attached monitor via XDG autostart.
- Everything is logged to SQLite at `data/attendance.db` and works **offline**;
  a background worker syncs with the server every 30 seconds
  (`config.SYNC_INTERVAL`): it downloads worker encodings, uploads queued
  attendance and recognition-telemetry records, and reports kiosk health
  (camera/model/liveness state, queue depths) to the dashboard. The on-screen
  sync chip shows online/offline state and how many records are queued.
- Blink liveness is **optional and off by default** (`LIVENESS_REQUIRED = False`).
  When enabled, a matched worker must blink before the clock event is recorded;
  if the landmark model is missing, the kiosk keeps working, records events as
  unverified, and reports itself degraded.
- Supervisor controls (manual clock-in/out) are behind a separate PIN
  (`KIOSK_SUPERVISOR_PIN`) with a five-minute session and attempt lockout.

## What You Need

- Raspberry Pi 4 recommended (3B works, slower); Pi Camera Module or USB webcam
- HDMI display at the door
- microSD (16GB+) with **Raspberry Pi OS with Desktop (64-bit)** — not Lite.
  The kiosk shows a fullscreen browser on the monitor, which needs the desktop
  session that Desktop images ship preconfigured.

## Setup

1. Flash **Raspberry Pi OS with Desktop (64-bit)** with Raspberry Pi Imager
   (enable SSH, set WiFi, hostname e.g. `fw-kiosk`).
2. SSH in (`ssh pi@fw-kiosk.local`) or open a terminal on the desktop.
3. Run the setup script:

```bash
curl -sSL https://raw.githubusercontent.com/nztinversive/fw-gatekeeper/master/pi-kiosk/setup.sh -o setup.sh
sudo KIOSK_API_KEY="replace-with-the-server-key" \
  KIOSK_UI_KEY="$(openssl rand -hex 24)" \
  KIOSK_SUPERVISOR_PIN="<set-a-separate-supervisor-passcode>" \
  SERVER_URL=https://fw-gatekeeper.onrender.com \
  KIOSK_ID=kiosk-entry-1 \
  bash setup.sh
```

Setup fails immediately if `KIOSK_API_KEY`, `KIOSK_UI_KEY`, or
`KIOSK_SUPERVISOR_PIN` is missing. It writes them to `config_local.py`
(imported by `config.py`, never committed), installs the systemd service and
watchdog timer, and configures the Firefox kiosk display autostart.

By default setup **skips** the 97MB dlib shape predictor used for blink
liveness. To install it, rerun setup with `ENABLE_LIVENESS=1`, then set
`LIVENESS_REQUIRED = True` in `config_local.py`.

4. Enroll workers on the web dashboard (**Enroll Face**). The kiosk pulls new
   encodings on the next sync cycle (≤30 seconds).
5. `sudo reboot` — the scanner service and fullscreen display start
   automatically.

## Configuration

All settings live in `config.py` with per-kiosk overrides in
`config_local.py` (written by `setup.sh`). Key values:

| Setting / env | Default | Description |
|---------------|---------|-------------|
| `SERVER_URL` | `https://fw-gatekeeper.onrender.com` | Gatekeeper server |
| `SYNC_INTERVAL` | `30` | Seconds between sync cycles |
| `KIOSK_ID` / `KIOSK_NAME` | `kiosk-entry-1` / `Main Entry` | Kiosk identity |
| `KIOSK_TYPE` | `entry` | `entry`, `exit`, or `auto` (toggles by last action) |
| `KIOSK_API_KEY` (env or local) | none | **Required** shared secret for server sync; without it sync is disabled and records stay queued |
| `KIOSK_UI_KEY` (env or local) | none | **Required** Pi-local secret for camera feed, roster/status, and log routes |
| `KIOSK_SUPERVISOR_PIN` (env or local) | none | **Required** separate passcode for manual attendance (5-minute session) |
| `KIOSK_UI_HOST` (env or local) | `127.0.0.1` | Web UI bind address; keep loopback-only |
| `KIOSK_PORT` | `5555` | Web UI port |
| `RECOGNITION_MATCH_THRESHOLD` | `0.45` | Cosine similarity accept threshold, **higher = stricter** (tune 0.40–0.55 in `config_local.py`) |
| `LIVENESS_REQUIRED` | `False` | Require a blink before recording a clock event |
| `CLOCK_DEBOUNCE_MINUTES` | `5` | Ignore repeat scans of the same worker |
| `CAMERA_INDEX` / `CAMERA_WIDTH` / `CAMERA_HEIGHT` | `0` / `640` / `480` | Camera settings |

### Command Line

```bash
python3 main.py --server URL --kiosk-id ID --camera [auto|pi|usb]
```

The match threshold is not a flag: set `RECOGNITION_MATCH_THRESHOLD` in
`config_local.py`.

## Tools

- `enroll.py` — local enrollment CLI (add/list/remove workers) with a
  loopback-only browser preview on `:5556`.
- `tools/liveness_check.py` — field diagnostic for blink detection; serves a
  loopback-only preview on `:5599` (stop the kiosk service first to free the
  camera).

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "No camera available" | Check `ls /dev/video*` (USB) or `libcamera-hello` (Pi camera) |
| "No enrolled workers found" | Enroll on the dashboard first; check WiFi for the initial sync |
| "KIOSK_API_KEY is required" | Configure the server-matching key and restart `fw-gatekeeper-kiosk.service` |
| "KIOSK_UI_KEY is required" | Rerun setup with a generated Pi-local UI key and restart the service |
| False rejections | Lower `RECOGNITION_MATCH_THRESHOLD` slightly (e.g. `0.40`) in `config_local.py` |
| False matches | Raise `RECOGNITION_MATCH_THRESHOLD` (e.g. `0.50`–`0.55`) in `config_local.py` |
| Scanner degraded on dashboard | Check `journalctl -u fw-gatekeeper-kiosk -f` for camera/model/liveness errors |
| "queued logs have no server worker mapping" | Queued rows whose worker row was removed before this release; see *Stranded attendance rows* below |

### Stranded attendance rows

Each attendance row stores the worker's Convex id (`server_worker_id`) when it is
written. Recognition carries the id from the same roster snapshot as the match,
including through a blink wait. Sync always preserves a captured server identity. A schema trigger fills missing
identities before deletion. Startup migrates older schemas without changing local
worker IDs; workers with the same name remain separate and supervisor selection
shows employee IDs. Rows written by older releases
whose worker was already removed have no id to recover and stay queued until an
operator resolves them. They still count in `queued_logs` on the health endpoint.

```bash
cd /opt/fw-gatekeeper/pi-kiosk
sqlite3 data/attendance.db ".backup data/attendance.db.bak-$(date +%Y%m%d)"
sqlite3 -header data/attendance.db \
  "SELECT id, worker_id, worker_name, action, timestamp FROM attendance_log WHERE synced = 0;"
```

Then either delete the rows if they are test data, or attach the worker's Convex
id and the next sync cycle sends them. The Convex id is the 32-character
lowercase id in the worker's dashboard URL, not the employee ID; the kiosk
refuses to send anything that does not look like one, since the server stores
whatever worker id it is given:

```sql
UPDATE attendance_log SET server_worker_id = '<convex worker id>'
WHERE synced = 0 AND worker_id = <local worker id>;
```

## Architecture

```
Pi (Kiosk)                              Render (Server)
┌────────────────────────┐              ┌──────────────────────┐
│ Camera                 │              │ FW Gatekeeper App    │
│  ↓ dlib HOG detect     │  WiFi sync   │  /api/sync           │
│  ↓ MobileFaceNet ONNX  │ ←──────────→ │  /api/attendance     │
│  ↓ cosine match        │  every 30s   │  /api/recognition-   │
│  ↓ (optional blink)    │  + health    │      attempts/bulk   │
│ SQLite attendance.db   │              │                      │
│ Flask UI :5555         │              │ face-service         │
│  └ Firefox fullscreen  │              │  (encode only)       │
└────────────────────────┘              └──────────────────────┘
```
