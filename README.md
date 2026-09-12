# FW Gatekeeper

Factory access control system for Fading West. Face recognition at entry/exit points with real-time dashboard.

**Live Dashboard:** https://fw-gatekeeper.onrender.com  
**Convex Dashboard:** https://dashboard.convex.dev/t/thiesnoah/fw-gatekeeper

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────────┐
│  Pi Kiosk (x4)          │         │  Render (Cloud)          │
│                         │         │                          │
│  Camera → Face Detect   │◄──WiFi──┤  FW Gatekeeper (Next.js) │
│  → Blink (optional)     │  sync   │  ├── Dashboard           │
│  → Local Match          │  30s    │  ├── Enrollment          │
│  → HDMI Display         │────────►│  ├── Shift workflows     │
│    (Firefox fullscreen)  │         │  └── API                 │
│                         │         │                          │
│  Flask Web UI (:5555)   │         │  Face Service (FastAPI)  │
│  SQLite (offline log)   │         │  └── ArcFace ONNX encode │
│                         │         │                          │
└─────────────────────────┘         │  Convex (Database)       │
                                    │  └── Workers, Attendance │
                                    └──────────────────────────┘
```

## Stack

| Component | Technology |
|-----------|-----------|
| Dashboard | Next.js 14 + Tailwind CSS |
| Database | Convex (cloud) |
| Face Encoding | ArcFace ONNX (512-dim embeddings) |
| Face Detection (Pi) | dlib HOG + Haar cascade |
| Liveness | dlib 68-point landmarks (blink detection) — optional, off by default |
| Pi Kiosk | Python 3.11 + OpenCV + face_recognition |
| Hosting | Render (free tier) |

---

# Pi Kiosk Setup Guide

## What You Need (Per Kiosk)

### Required

| Item | Recommended Model | Notes |
|------|-------------------|-------|
| Raspberry Pi | **Pi 4 Model B (2GB+)** | Pi 3B+ works but slower. Pi 5 also supported. |
| microSD card | **32GB Class 10 / A2** | Samsung EVO Select or SanDisk Extreme recommended |
| USB webcam | **Logitech C270 or C920** | C270 is $20 and works great. C920 for better quality. Pi Camera Module v2 also works. |
| HDMI monitor | **7" to 10" HDMI display** | Mounted at face height next to the door. Any HDMI monitor works. |
| Power supply | **Official Pi 4 USB-C 5V/3A** | Use the official one — cheap chargers cause instability |
| HDMI cable | **Micro-HDMI to HDMI** (Pi 4) | Pi 3B uses full-size HDMI |
| Ethernet or WiFi | WiFi for sync | Works fully offline after initial setup |

### Recommended Accessories

| Item | Notes |
|------|-------|
| Pi case with VESA mount | Mount Pi behind the monitor. Flirc or Argon cases work well. |
| Camera mount / clip | Position camera at face height (~5 ft / 150cm). USB webcam clip mount works. |
| USB extension cable (3ft) | If camera needs to be separate from the Pi |
| Power strip with surge protector | One per kiosk location |
| Cable management clips | Keep it clean on the wall |

### Physical Setup Diagram

```
         ┌─────────────────┐
         │                 │
         │   HDMI Monitor  │  ← Mounted on wall at face height
         │   (7-10 inch)   │
         │                 │
         │  ┌───────────┐  │
         │  │  Welcome!  │  │  ← Shows camera feed + status
         │  │  Marcus J. │  │
         │  └───────────┘  │
         └────────┬────────┘
                  │ HDMI
         ┌────────┴────────┐
         │  Raspberry Pi   │  ← Mounted behind monitor (VESA) or below
         │  (in case)      │
         └───┬─────────┬───┘
             │         │
          USB │      ⚡ Power
             │
         ┌───┴───┐
         │ 📷    │  ← USB webcam on top of monitor
         │Webcam │     or mounted at face height
         └───────┘

    Worker stands here → 🧑 (2-3 feet from camera)
```

## Kiosk Plan for Fading West (4 Kiosks)

| Kiosk ID | Name | Type | Location |
|----------|------|------|----------|
| `kiosk-entry-1` | Main Entry | entry | Building A Front Door |
| `kiosk-entry-2` | Side Entry | entry | Building A Side Door |
| `kiosk-exit-1` | Main Exit | exit | Building A Rear |
| `kiosk-exit-2` | Loading Dock | exit | Building B Loading Dock |

> Adjust these to match your actual facility layout.

---

## Step 1: Flash Raspberry Pi OS

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Choose **Raspberry Pi OS with Desktop (64-bit)** — NOT Lite (we need a desktop session + browser for the monitor display)
3. Click the ⚙️ gear icon and configure:
   - **Hostname:** `fw-kiosk-1` (increment for each Pi: `fw-kiosk-2`, etc.)
   - **Enable SSH:** Yes, use password authentication
   - **Username:** `pi`
   - **Password:** pick something secure, same for all kiosks for easy management
   - **WiFi:** enter your facility's WiFi SSID + password
   - **Locale:** set your timezone
4. Flash to microSD card
5. Insert card into Pi, connect camera + HDMI monitor, power on

> ⚠️ **Why Desktop and not Lite?** The kiosk displays a fullscreen Firefox browser on the HDMI monitor showing live camera feed + welcome messages. This requires a graphical session and GPU drivers, which come pre-installed with the Desktop version. Lite would need ~15 min of extra package installs and is more prone to driver issues.

## Step 2: Open a Terminal

You have two options — use whichever is easier for you:

### Option A: Directly on the Pi (Desktop)

1. The Pi should boot to the desktop with a monitor connected
2. If you see a keyring prompt, **leave both fields blank** and click Continue
3. Click the **Terminal** icon in the top menu bar (black rectangle icon), or right-click the desktop → "Open Terminal Here"

### Option B: SSH from Another Computer

From your PC (Pi must be on the same WiFi network):

```bash
ssh pi@fw-kiosk-1.local
```

If `.local` doesn't resolve, find the Pi's IP from your router admin page:

```bash
ssh pi@192.168.1.XXX
```

## Step 3: Set Security Secrets

Before bringing kiosks online, configure the shared secrets used for dashboard auth and kiosk sync:

1. In Render (`fw-gatekeeper` → **Environment**), set:
   - `KIOSK_API_KEY` to a long random shared secret
   - `AUTH_SECRET` to a long random signing key for admin session cookies
2. Use the **same** `KIOSK_API_KEY` value on every Pi kiosk

> The dashboard no longer auto-seeds demo data. Enroll real workers before expecting kiosks to recognize anyone.

## Step 4: Run the Setup Script

Once you have a terminal open (either on the Pi desktop or via SSH), run these commands.

For the **first kiosk** (Main Entry):

```bash
curl -sSL https://raw.githubusercontent.com/nztinversive/fw-gatekeeper/master/pi-kiosk/setup.sh -o setup.sh
sudo KIOSK_ID=kiosk-entry-1 KIOSK_NAME="Main Entry" KIOSK_TYPE=entry bash setup.sh
```

For the **second kiosk** (Side Entry):

```bash
curl -sSL https://raw.githubusercontent.com/nztinversive/fw-gatekeeper/master/pi-kiosk/setup.sh -o setup.sh
sudo KIOSK_ID=kiosk-entry-2 KIOSK_NAME="Side Entry" KIOSK_TYPE=entry bash setup.sh
```

For **exit kiosks**:

```bash
sudo KIOSK_ID=kiosk-exit-1 KIOSK_NAME="Main Exit" KIOSK_TYPE=exit bash setup.sh
sudo KIOSK_ID=kiosk-exit-2 KIOSK_NAME="Loading Dock" KIOSK_TYPE=exit bash setup.sh
```

After `setup.sh` finishes on each Pi, set the same shared kiosk key in `config_local.py`:

```bash
sudo tee -a /opt/fw-gatekeeper/pi-kiosk/config_local.py >/dev/null <<'EOF'
KIOSK_API_KEY = "replace-with-the-same-render-kiosk-api-key"
EOF
```

> ⏱ Setup takes **15-25 minutes** per Pi (mostly compiling dlib). Go set up the next Pi while this one builds.
> 
> 💡 **Tip:** If typing long commands on the Pi is annoying, you can open Firefox on the Pi desktop, go to the [README on GitHub](https://github.com/nztinversive/fw-gatekeeper), and copy-paste the commands from there.

## Step 5: Connect the Hardware

Before running setup (or after — order doesn't matter):

1. **Plug in the USB webcam** — top of monitor or mounted at face height
2. **Connect HDMI cable** — Pi micro-HDMI port → monitor HDMI input
3. **Power on the monitor** — set to correct HDMI input

Verify the camera is detected:

```bash
# USB Webcam
ls /dev/video*   # should show /dev/video0

# Pi Camera
libcamera-hello --timeout 5000
```

## Step 6: Enroll Workers on the Dashboard

Before the kiosks can recognize anyone, enroll workers:

1. Go to https://fw-gatekeeper.onrender.com
2. Enter PIN: **4729**
3. Click **Enroll Face** in the sidebar
4. Enter the worker's name and department
5. Capture 3 photos (look straight at camera, good lighting)
6. The worker is only created if the face encoding service returns a valid face vector
7. Repeat for all workers

> 💡 **Tip:** Enroll in a well-lit area. Have workers remove hats/sunglasses. 3 slightly different angles (straight, slight left, slight right) improves recognition.
>
> If face encoding is unavailable, enrollment now fails instead of creating an unusable worker record.
>
> Enrollment requires confirming the worker's biometric consent. See [RETENTION.md](RETENTION.md) for what face data is stored, how long, and how an admin purges it.

## Step 7: Start the Kiosks

```bash
# Start the face scanner + web UI
sudo systemctl start fw-gatekeeper-kiosk

# Check it's running
systemctl status fw-gatekeeper-kiosk

# Watch the logs
journalctl -u fw-gatekeeper-kiosk -f
```

On first start, the kiosk will:
1. Start Flask web UI on port 5555
2. Sync worker encodings from the server
3. Cache them locally in SQLite
4. Start the camera and begin face scanning

The display (Firefox in kiosk mode) launches automatically when the desktop session starts — no manual browser opening needed.

Then **reboot** to verify everything auto-starts on power-on:

```bash
sudo reboot
```

After reboot:
- The kiosk service starts automatically (systemd)
- Once the desktop loads, Firefox opens fullscreen showing the Gatekeeper UI
- No SSH or manual start needed

## Step 8: Repeat for All 4 Kiosks

Flash → SSH → Connect hardware → Run setup script (with unique KIOSK_ID) → Enroll workers (only once, on the web) → Start → Reboot → Verify monitor displays kiosk UI.

---

## How It Works Day-to-Day

### For Workers
1. Walk up to the kiosk (monitor shows "Step toward camera" with live camera feed)
2. Look at the camera for a few seconds while it matches your face
3. If the kiosk has blink verification enabled (`LIVENESS_REQUIRED = True` in
   `config_local.py`; off by default), the monitor shows "Blink to verify" —
   blink naturally to confirm
4. Monitor shows **✅ Welcome, [Name]!** with department and time → proceed through door
5. If not recognized: **❌ Face not recognized — Please see a manager**

### For Admins
- **Dashboard** shows who's clocked in/out/absent in real-time
- **Log** page shows all scan events with timestamps
- **Reports** page for attendance summaries
- **Workers** page to manage/deactivate employees
- **Kiosks** page to monitor kiosk health

### Monitor Display

Each kiosk runs a local web UI (Flask on port 5555) displayed fullscreen via Firefox ESR in kiosk mode. The display shows:

- **Live camera feed** — workers see themselves on screen
- **Status messages** — "Step toward camera", "✅ Welcome!", "❌ Not recognized" (plus "Blink to verify" when liveness is enabled)
- **Real-time clock** and date
- **Today's scan log** — recent clock-in/out events (6 max, compact layout)
- **Manual clock** option — type a name if camera has issues
- **Admin panel** (press 'A' key) — enrolled workers list

The display auto-starts on boot via XDG autostart:
- `fw-gatekeeper-kiosk` — systemd service (face scanner + Flask web server)
- `fw-gatekeeper-display.sh` — autostart script (waits for Flask, launches Firefox --kiosk)

**Headless mode:** If no monitor is connected, the kiosk still works — the face scanner and sync run regardless. The autostart script simply won't open Firefox.

### Offline Mode
- Kiosks work **without internet** after initial sync
- Face encodings are cached locally in SQLite
- Attendance events log to local storage
- When WiFi reconnects, pending records sync automatically (every 30 seconds)

---

## Troubleshooting

### Kiosk won't start
```bash
# Check service status
systemctl status fw-gatekeeper-kiosk

# View logs
journalctl -u fw-gatekeeper-kiosk -n 50

# Common fix: restart
sudo systemctl restart fw-gatekeeper-kiosk
```

### "No enrolled workers found"
- Enroll faces on the web dashboard first
- Check WiFi: `ping google.com`
- Force sync: restart the kiosk service

### Camera not detected
```bash
# Pi Camera
vcgencmd get_camera          # supported=1 detected=1
sudo raspi-config             # Interface Options → Camera → Enable

# USB Webcam
lsusb                        # should list your webcam
ls /dev/video*               # should show /dev/video0
```

### Face not recognized (false rejections)
- Re-enroll with better lighting
- Check camera angle (should be at face height)
- Lower the match threshold slightly: add `RECOGNITION_MATCH_THRESHOLD = 0.40` to
  `pi-kiosk/config_local.py` on the kiosk (cosine similarity — **higher = stricter**;
  default `0.45`; stay within 0.40–0.55 and use the Recognition Lab to pick a value)
- Then: `sudo systemctl restart fw-gatekeeper-kiosk`

### Face matching wrong person (false positives)
- Raise the match threshold: set `RECOGNITION_MATCH_THRESHOLD = 0.50` (or `0.55`) in
  `pi-kiosk/config_local.py`, then restart the service
- Re-enroll both workers with clearer photos

### Kiosk shows stale data
```bash
# Force re-sync from server
sudo systemctl restart fw-gatekeeper-kiosk
```

### Monitor shows nothing / black screen
```bash
# Check if the kiosk web server is up
curl http://localhost:5555/health

# If health is OK, manually launch the display
~/fw-gatekeeper-display.sh &

# Or restart the kiosk service and reboot
sudo systemctl restart fw-gatekeeper-kiosk
sudo reboot
```

If Firefox doesn't open after reboot:
- Check the autostart file exists: `ls ~/.config/autostart/fw-gatekeeper-display.desktop`
- Check the launcher script exists: `ls ~/fw-gatekeeper-display.sh`
- Run it manually to see errors: `~/fw-gatekeeper-display.sh`

If monitor doesn't wake up:
- Check HDMI cable connection
- Try a different HDMI port on the Pi (Pi 4 has two)
- Add `hdmi_force_hotplug=1` to `/boot/firmware/config.txt` (older Pi OS: `/boot/config.txt`) and reboot

### Power loss recovery
- Kiosks auto-restart on boot (systemd + watchdog timer)
- SQLite WAL mode protects against corruption
- Unsynced attendance records persist and sync when WiFi returns

---

## Maintenance

### Update kiosk software
```bash
ssh pi@fw-kiosk-1.local
cd /opt/fw-gatekeeper
sudo git pull origin master
cd pi-kiosk
./venv/bin/pip install -r requirements.txt
sudo systemctl restart fw-gatekeeper-kiosk
```

### Update all 4 kiosks at once
From any machine on the same network:

```bash
for host in fw-kiosk-1 fw-kiosk-2 fw-kiosk-3 fw-kiosk-4; do
  echo "Updating $host..."
  ssh pi@$host.local "cd /opt/fw-gatekeeper && sudo git pull && sudo systemctl restart fw-gatekeeper-kiosk"
done
```

### Add a new worker
1. Dashboard → Enroll Face → capture photos
2. Kiosks pick up new encodings on next sync cycle (≤30 seconds)
3. Or force immediate sync: restart kiosk service

### Deactivate a worker
1. Dashboard → Workers → click worker → Deactivate
2. Worker will no longer be recognized at kiosks after next sync

### Change the admin PIN
Set the `ADMIN_PIN` environment variable on Render:
1. Go to https://dashboard.render.com → fw-gatekeeper → Environment
2. Change `ADMIN_PIN` value
3. Redeploy

---

## Configuration Reference

### Environment Variables (Render - Dashboard)

| Variable | Value | Description |
|----------|-------|-------------|
| `NEXT_PUBLIC_CONVEX_URL` | `https://modest-bat-146.convex.cloud` | Convex prod URL |
| `ADMIN_PIN` | `4729` | Dashboard login PIN |
| `AUTH_SECRET` | long random secret | Signing key for admin session cookies (required for dashboard auth) |
| `KIOSK_API_KEY` | long random shared secret | Shared secret between server and Pi kiosks (required for sync) |
| `FACE_ENCODE_URL` | `https://fw-face-service.onrender.com/encode` | Face encoding service |
| `FACE_SERVICE_KEY` | long random shared secret | Shared secret between the dashboard server and face service |
| `FACE_SERVICE_ALLOWED_ORIGINS` | `https://fw-gatekeeper.onrender.com` | Browser origin allowed by the face service |

### Kiosk Setup Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KIOSK_ID` | `kiosk-1` | Unique identifier for this kiosk |
| `KIOSK_NAME` | `FW Kiosk` | Display name |
| `KIOSK_TYPE` | `entry` | `entry` or `exit` |
| `SERVER_URL` | `https://fw-gatekeeper.onrender.com` | Dashboard server URL |
| `KIOSK_API_KEY` | `""` | Shared secret between server and Pi kiosks (required for sync) |
| `KIOSK_UI_KEY` | `""` | Required Pi-local secret protecting camera, roster, attendance, and manual-clock routes |

### Kiosk CLI Options

```bash
python main.py --server URL --kiosk-id ID --camera [auto|pi|usb]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--server` | Render URL | Gatekeeper server |
| `--kiosk-id` | `kiosk-entry-1` | Kiosk identifier |
| `--camera` | `auto` | `pi` for Pi Camera, `usb` for USB webcam |

The match threshold is not a CLI flag: set `RECOGNITION_MATCH_THRESHOLD` in
`pi-kiosk/config_local.py` (cosine similarity, higher = stricter, default `0.45`).

### Performance

| Metric | Pi 3B | Pi 4 |
|--------|-------|------|
| Face detection | ~2-3s | ~0.8s |
| Face matching | <0.5s | <0.2s |
| Total scan time | ~3-4s | ~1-2s |
| Workers supported | 50+ | 200+ |

---

## Hardware Shopping List (4 Kiosks)

| Item | Qty | Est. Price | Link |
|------|-----|-----------|------|
| Raspberry Pi 4 Model B (2GB) | 4 | $45 each | raspberrypi.com or Amazon |
| 32GB microSD (Samsung EVO Select) | 4 | $8 each | Amazon |
| Official Pi 4 USB-C Power Supply | 4 | $8 each | raspberrypi.com |
| Logitech C270 HD Webcam | 4 | $20 each | Amazon |
| 7" HDMI Display (1024x600) | 4 | $40-60 each | Amazon (search "7 inch HDMI display Raspberry Pi") |
| Micro-HDMI to HDMI cable | 4 | $8 each | Amazon |
| Pi 4 case (VESA mountable) | 4 | $10 each | Amazon |
| USB 2.0 extension cable 3ft | 4 | $5 each | Amazon |
| **Total (4 kiosks)** | | **~$580-660** | |

> 💡 **Budget option:** Skip the HDMI displays ($160-240 savings) and run headless — the scanner and sync still run without a monitor, workers just get no on-screen feedback. Less polished but functional.

> 💡 **Premium option:** Use Pi 5 ($60 each) + Logitech C920 ($70 each) for faster recognition and sharper camera image.

## Services

| Service | URL | Plan |
|---------|-----|------|
| Dashboard | https://fw-gatekeeper.onrender.com | Render Free |
| Face Service | https://fw-face-service.onrender.com | Render Free |
| Database | https://dashboard.convex.dev/t/thiesnoah/fw-gatekeeper | Convex Free |
