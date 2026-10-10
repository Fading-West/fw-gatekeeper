# FW Gatekeeper — Pi Kiosk Face Scanner

Raspberry Pi face recognition kiosk for factory clock-in/clock-out.

## How It Works

- `main.py` is the entry point (run by the `fw-gatekeeper-kiosk` systemd service).
- The camera runs continuously; dlib HOG finds faces, MobileFaceNet ONNX
  encodes them as 512-dim embeddings (the same model family the server uses),
  and matching is cosine similarity against locally cached worker encodings.
  Each accepted scan must match the current camera frame. Temporal smoothing
  only combines consecutive frames of the same worker and clears when the
  face, roster encoding, or frame sequence changes; an unknown face cannot
  inherit a previous worker's strong match.
- A Flask web UI on port `5555` (loopback by default) shows the live camera
  feed, status messages, and today's log; Firefox ESR in kiosk mode displays it
  fullscreen on the attached monitor via XDG autostart.
- Everything is logged to SQLite at `data/attendance.db` and works **offline**;
  a background worker syncs with the server every 30 seconds
  (`config.SYNC_INTERVAL`): it downloads worker encodings, uploads queued
  attendance and recognition-telemetry records, and reports kiosk health
  (camera/model/liveness state, queue depths) to the dashboard. The on-screen
  sync chip shows online/offline state and how many records are queued.
  Attendance uploads use at most 100 records per request and 10 pages per
  cycle. A saved cursor keeps unmapped rows from blocking newer attendance;
  failed requests and incomplete acknowledgements leave records queued for
  retry. Larger offline backlogs drain over subsequent sync cycles.
- Blink liveness is **optional and off by default** (`LIVENESS_REQUIRED = False`).
  When enabled, a matched worker must blink before the clock event is recorded;
  if the landmark model is missing or corrupt, automatic attendance is blocked
  and the display asks the worker to contact a supervisor. The camera, UI, and
  offline queue sync keep running. Model loading is retried every 30 seconds;
  installing the predictor restores scanning without restarting the kiosk.
- Supervisor controls (manual clock-in/out) are behind a separate PIN
  (`KIOSK_SUPERVISOR_PIN`) with a five-minute session and attempt lockout.

## What You Need

- Raspberry Pi 4 recommended (3B works, slower); Pi Camera Module or USB webcam
- HDMI display at the door
- microSD (16GB+) with **Raspberry Pi OS Bookworm with Desktop (64-bit)** — not Lite.
  The kiosk shows a fullscreen browser on the monitor, which needs the desktop
  session that Desktop images ship preconfigured.

## Setup

1. Flash **Raspberry Pi OS Bookworm with Desktop (64-bit)** with Raspberry Pi Imager
   (enable SSH, set WiFi, hostname e.g. `fw-kiosk`).
2. SSH in (`ssh pi@fw-kiosk.local`) or open a terminal on the desktop.
3. Run the setup script:

```bash
curl -sSL https://raw.githubusercontent.com/Fading-West/fw-gatekeeper/master/pi-kiosk/setup.sh -o setup.sh
sudo KIOSK_API_KEY="<credential issued for this kiosk>" \
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

## Locked Python dependencies

Setup targets CPython 3.11 on aarch64 and rejects other Python/architecture
combinations before changing the machine. `requirements.lock` pins all 24 pip
runtime packages and their distribution hashes. `requirements-build.lock` pins
the four tools used to build dlib and face_recognition_models from source;
setup disables build isolation so it cannot silently fetch newer build tools.
`setuptools==80.9.0` supplies the legacy `pkg_resources` API used by the model
package.

Picamera2, libcamera, and their OS dependencies stay under apt management and
are visible through the virtual environment's `--system-site-packages`. They
are intentionally absent from pip inputs and locks. OS libraries, compilers,
and firmware remain outside the Python lock; validate a provisioned Pi before
rolling changes out to the fleet.

To regenerate, edit the direct inputs (`requirements.txt` or
`requirements-build.txt`), then run `bash scripts/lock-python-dependencies.sh`
from the repository root using uv 0.12.13. Existing lock versions are retained
when compatible; remove the corresponding lock first for an intentional full
transitive refresh. Review all version/hash changes, validate a fresh server
install, and provision one Bookworm kiosk before rollout.

## Configuration

All settings live in `config.py` with per-kiosk overrides in
`config_local.py` (written by `setup.sh`). Key values:

| Setting / env | Default | Description |
|---------------|---------|-------------|
| `SERVER_URL` | `https://fw-gatekeeper.onrender.com` | Gatekeeper server |
| `SYNC_INTERVAL` | `30` | Seconds between sync cycles |
| `KIOSK_ID` / `KIOSK_NAME` | `kiosk-entry-1` / `Main Entry` | Kiosk identity |
| `KIOSK_TYPE` | `entry` | `entry`, `exit`, or `auto` (toggles by last action) |
| `KIOSK_API_KEY` (env or local) | none | **Required** device credential issued on the portal's Kiosk readiness page; registered kiosks may use the shared key until migrated |
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

## Upgrade notes: local history

The first upgrade adds numeric timestamp columns and saved migration cursors
during startup. Historical backfill and index creation run in a background
thread after the UI and detection have started. Manual attendance, scanning,
and sync remain available. New events receive their numeric timestamps at
insert; today's log, debounce, and last-action selection still include legacy
rows while the backfill is incomplete. The temporary log fallback parses only
NULL epochs in the remaining migration ID range, so the supervisor log can be
slower until attendance backfill finishes.

The worker creates indexes before populating epochs, excludes NULLs from new
indexes, commits at most 100 rows per batch, and yields between transactions.
SQLite holds its writer lock during index creation, including on a restart
with partially populated epochs or a device with a missing index. Every
manual attendance, recognized attendance, and recognition telemetry write
signals the index worker before opening its connection or transaction. The
worker checks that signal every 1,000 SQLite instructions, atomically rolls
back the current index build, and retries after 30 seconds. Completed indexes
remain; no backfill begins until all four indexes exist. Busy door traffic can
therefore defer migration and retention until a quieter period. This also
protects the camera/UI loop, which records recognized attendance synchronously.
Foreground connections wait up to 10 seconds for other writers; lock timeouts
show a "please try again" message for both manual and recognized attendance.
Failed event writes roll back their transaction. The background connection
waits only five seconds for other writers. Shutdown interrupts index creation,
finishes or rolls back the current batch, wakes retry delays, and joins the
worker so its own connection is closed. Progress survives restart, and failures
(including opening the connection) are logged and retried every 30 seconds.
Look for
`Local history epoch migration complete` in the service journal. Retention
waits until both tables are migrated and the required indexes exist; sync
continues during that wait.

Afterward, only synced history older than `LOCAL_HISTORY_RETENTION_DAYS`
(default **30**, positive integer override in `config_local.py`) is eligible
for bounded cleanup. Unsynced events, active rejection evidence, debounce
history, and each worker's latest action remain. SQLite reuses freed pages;
the database file does not immediately shrink because no full vacuum runs.

For scale, a synthetic 185 MiB WAL database with 200,000 attendance rows and
600,000 recognition attempts took 3.65 seconds to migrate synchronously on an
x86 host, with 8,003 commits (an earlier run during dependency installation
took 13.07 seconds). A conservative sizing assumption of 20 times these host
durations plus 10–50 ms per SD-card commit flush gives roughly **2.5–11 minutes**;
this is an estimate, not a measured Pi 3B duration. This historical work no
longer gates startup.

Round 4 measured individual index builds on an x86 host with a synthetic
181 MiB database containing 200,000 attendance rows and 600,000 recognition
attempts. First-upgrade indexes with NULL historical epochs took **72–429 ms**;
rebuilding indexes with populated epochs took **201–1,813 ms**. Concurrent
attendance inserts queued and committed without errors. The same 20x sizing
assumption gives up to **8.6 seconds** and **36.3 seconds**, respectively,
before extra SD-card I/O costs. Round 5 replaces waiting through these builds
with interruption when an event write arrives.

Round 5 used a separate **199 MiB** WAL/FULL database with the same row counts,
mixed naive/offset timestamps, 200 worker identities and 95% synced history.
Across three builds per index, before the fix, the recognition retention
index took **71–76 ms** at 0% populated epochs, **141–167 ms** at 25%,
**207–208 ms** at 50%, and **282–340 ms** at 100%. Across all attendance
indexes, corresponding ranges were **15–20**, **31–40**, **51–63**, and
**79–118 ms**. These vary from round 4 with host load and data distribution.
Attendance inserts issued 1, 50 or 200 ms into recognition index creation
took up to **79, 180, 230 and 330 ms**, respectively, before the fix, and up to
**0.54, 1.31, 1.59 and 1.63 ms** after it. Active builds were interrupted;
builds that had already finished needed no interruption. Pi hardware and SD
flush latency remain unmeasured. Regression coverage also verifies interruption
of a populated attendance index, concurrent manual/recognized/telemetry writes,
unchanged backfill cursors and retention gating, shutdown, restart, and real
lock-timeout messages.

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
| "KIOSK_API_KEY is required" | Configure this kiosk's issued device credential, or the shared migration key on a registered kiosk that has not migrated, and restart `fw-gatekeeper-kiosk.service` |
| "KIOSK_UI_KEY is required" | Rerun setup with a generated Pi-local UI key and restart the service |
| False rejections | Lower `RECOGNITION_MATCH_THRESHOLD` slightly (e.g. `0.40`) in `config_local.py` |
| False matches | Raise `RECOGNITION_MATCH_THRESHOLD` (e.g. `0.50`–`0.55`) in `config_local.py` |
| Scanner degraded on dashboard | Check `journalctl -u fw-gatekeeper-kiosk -f` for camera/model/liveness errors |
| "queued logs have no server worker mapping" | Queued rows whose worker row was removed before this release; see *Stranded attendance rows* below |

### Rejected attendance uploads

The server may reject one invalid event in an otherwise valid batch. The kiosk
isolates that event and keeps its original SQLite row, validation reason, and
original row snapshot in `attendance_rejections`. Other events continue syncing.
Rejected events remain in the `queued_logs` health count, while `rejected_logs`
and `retryable_logs` distinguish paused evidence from uploads that can drain.
The kiosk displays Needs attention for rejected records. They do not retry until
an operator reviews them. Authentication, network, and server failures remain
in the normal retry queue.

On the kiosk, make a SQLite backup, then inspect active rejections:

```bash
cd /opt/fw-gatekeeper/pi-kiosk
sqlite3 data/attendance.db ".backup data/attendance.db.bak-$(date +%Y%m%d)"
python3 attendance_rejections.py list
```

Check the recorded reason and `original_log_json` before changing the row. For
example, after verifying the correct worker identity or timestamp against an
independent record, repair the `attendance_log` row in SQLite. Then release
the specific rejection with a reason; the next sync cycle retries it:

```bash
sqlite3 data/attendance.db \
  "UPDATE attendance_log SET timestamp = '2026-09-25T08:00:00' WHERE id = 37 AND synced = 0;"
python3 attendance_rejections.py retry 1 --note "Verified timestamp against supervisor shift record"
```

Use the rejection id from `list` for `retry`, and the log id for the SQL edit.
The original snapshot, rejection reason, release time, and operator note stay
in `attendance_rejections` after retry. If the event still fails validation,
the kiosk records a new rejection; do not delete the evidence to clear an alert.
If an attendance row was deleted, `list` still shows its rejection and original
snapshot. `retry` refuses to release it until the row is restored from a backup
or the snapshot under supervisor review.

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
