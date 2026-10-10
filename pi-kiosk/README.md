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
an operator reviews them. Invalid credentials, network, and server failures
remain in the normal retry queue. Explicit kiosk claim mismatches are handled
as described below.

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

### Queued events after changing KIOSK_ID

Each row keeps the kiosk identity captured when it was recorded. Changing
`KIOSK_ID` does not change old evidence. Attendance and recognition uploads scan
rows matching the current `KIOSK_ID` first, then upload historical rows in
separate batches grouped by their captured claim. Authorized aliases remain
accepted and keep their original spelling and retry identities.

The portal validates the credential and current batch claim before checking
all event claims. An invalid/revoked credential or unauthorized current
`KIOSK_ID` returns 401 and halts the sync cycle without quarantining evidence.
An authenticated batch containing unauthorized event claims returns **403 with
`code: KIOSK_CLAIM_MISMATCH`**, before any events are written. This explicit
server denial quarantines that claim's rows immediately; repeated retries
cannot authorize that identity. Other 403 responses remain retryable. A newer
kiosk talking to an older portal still uploads current rows first, but retains
historical 401s in the retry queue until the portal is upgraded. Older kiosks
keep retrying the new 403 as they did the previous 401.

Quarantined rows are never marked synced or automatically re-attributed.
Attendance uses `attendance_rejections`; recognition uses local SQLite
`recognition_rejections`, with the original row snapshot, reason, timestamp,
and eventual release note. They survive restart. Kiosk `/health` exposes
`rejected_logs` and `rejected_attempts`, and queued totals still include this
unsent evidence. The kiosk shows Needs attention, logs name the captured
claim, and the next roster health report includes `upload_quarantine` in the
portal's existing degraded reason field. A queue with quarantined rows is not
fully synced, even while newer rows continue uploading.

Operator recovery:

1. Stop scanning/syncing and back up SQLite before reviewing evidence:

   ```bash
   sudo systemctl stop fw-gatekeeper-kiosk
   cd /opt/fw-gatekeeper/pi-kiosk
   sqlite3 data/attendance.db ".backup data/attendance.db.claim-review.bak"
   python3 attendance_rejections.py list
   python3 recognition_rejections.py list
   ```

2. Inspect the reason and `original_log_json` / `original_attempt_json`.
   Independently verify which real kiosk recorded each event. A default
   `kiosk-1` claim is not proof of ownership. Do not bulk replace `kiosk_id`,
   mark rejected rows synced, or delete them to clear the alert. If ownership
   cannot be established, retain the quarantine and escalate to the portal
   administrator for evidence review.

3. For evidence belonging to the original real kiosk, use an authorized
   maintenance environment (or temporarily configure this stopped kiosk)
   with that kiosk's existing valid credential and `KIOSK_ID`. Keep scanning
   disabled during recovery. Release only reviewed rejection IDs, with an
   operator note, and run uploads manually using the configured environment:

   ```bash
   python3 attendance_rejections.py retry 1 --note "Verified original kiosk ownership; restored its authorized credential"
   python3 recognition_rejections.py retry 2 --note "Verified original kiosk ownership; restored its authorized credential"
   python3 -c 'import database, sync; database.init_db(); print("Attendance drained:", sync.sync_attendance(halt_on_unauthorized=True)); print("Recognition drained:", sync.sync_recognition_attempts(halt_on_unauthorized=True))'
   ```

   Use rejection IDs from the corresponding `list`, not row IDs. If a portal
   administrator can safely restore an original alias for the **same** real
   kiosk, that also allows retry under its credential. Never assign another
   real kiosk's alias to this kiosk just to make old events upload. If a default
   claim was erroneous, keep the evidence quarantined pending an explicit,
   audited administrative correction; this upload path does not rename it.

4. Inspect the lists and logs again. A denial creates a new quarantine rather
   than losing evidence. Release history and original snapshots remain in
   SQLite after success; recognition source IDs and captured claims stay
   unchanged. Restore the normal current kiosk configuration before restarting
   `sudo systemctl start fw-gatekeeper-kiosk`. A missing original row cannot
   be released until its evidence is restored from backup under operator review.

No Convex schema changes are required. The new rejection table is local only.

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
