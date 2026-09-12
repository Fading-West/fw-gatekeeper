#!/usr/bin/env python3
"""
FW Gatekeeper - Pi Kiosk Main Entry Point
Camera feed on main thread. Face detection on background thread.
Uses dlib for face DETECTION, MobileFaceNet ONNX for face ENCODING (512-dim).
"""

import argparse
import logging
import os
import time
import threading
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import numpy as np
import face_recognition as fr

import config
import database
from embeddings import embed_face, model_ready as recognition_model_ready
from matching import FreshFaceMatcher
from recognition import FaceRecognizer
from sync import SyncWorker
from sync_auth import require_kiosk_api_key
from kiosk_ui_auth import require_kiosk_ui_key
import app as web_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("main")


class Camera:
    def __init__(self, mode="auto"):
        self._cam = None
        self._mode = mode
        self._is_rgb = False  # True if camera returns RGB (picamera2)

    def start(self):
        if self._mode in ("pi", "auto"):
            try:
                from picamera2 import Picamera2
                self._cam = Picamera2()
                cam_config = self._cam.create_video_configuration(
                    main={"size": (config.CAMERA_WIDTH, config.CAMERA_HEIGHT), "format": "RGB888"}
                )
                self._cam.configure(cam_config)
                self._cam.start()
                time.sleep(1)
                self._mode = "pi"
                self._is_rgb = True
                logger.info("Pi Camera initialized (RGB mode)")
                return
            except Exception as e:
                if self._mode == "pi":
                    raise RuntimeError(f"Pi Camera failed: {e}")
                logger.info(f"Pi Camera not available ({e}), trying USB...")

        self._cam = cv2.VideoCapture(config.CAMERA_INDEX)
        self._cam.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
        self._cam.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)
        if not self._cam.isOpened():
            raise RuntimeError("No camera available")
        self._mode = "usb"
        self._is_rgb = False
        logger.info("USB Camera initialized (BGR mode)")

    def capture(self):
        """Returns (bgr_frame, rgb_frame)"""
        if self._mode == "pi":
            rgb = self._cam.capture_array()
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            return bgr, rgb
        else:
            ret, bgr = self._cam.read()
            if not ret:
                raise RuntimeError("Failed to capture frame")
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            return bgr, rgb

    def stop(self):
        if self._cam is None:
            return
        if self._mode == "pi":
            self._cam.stop()
        else:
            self._cam.release()


GOLD = (11, 134, 184)
GREEN = (0, 200, 0)
RED = (0, 0, 220)


def _now_iso():
    return datetime.now().isoformat(timespec="seconds")


def draw_box(frame_bgr, face_loc, color, label=None):
    # Mirror the display copy so workers see themselves as in a mirror
    # (detection still runs on the unflipped frame). Overlays are drawn
    # after the flip so labels stay readable.
    out = cv2.flip(frame_bgr, 1)
    if face_loc is None:
        return out
    top, right, bottom, left = face_loc
    width = out.shape[1]
    left, right = width - right, width - left
    cv2.rectangle(out, (left, top), (right, bottom), color, 2)
    if label:
        cv2.putText(out, label, (left, max(20, top - 10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
    return out


def format_worker_display_id(worker, local_worker_id=None):
    """Prefer the portal employee ID; fall back to the kiosk local id if absent."""
    if worker:
        employee_id = str(worker.get("employee_id") or "").strip()
        if employee_id:
            return employee_id
    if local_worker_id is not None:
        return str(local_worker_id)
    return ""


def cosine_sim(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def largest_face(face_locations):
    return max(face_locations, key=lambda loc: (loc[2] - loc[0]) * (loc[1] - loc[3]))


def _empty_recognition_result(face_loc, decision="rejected_unknown"):
    return {
        "face_loc": face_loc,
        "name": None,
        "confidence": 0.0,
        "candidate_worker_id": None,
        "candidate_worker_name": None,
        "best_score": None,
        "second_best_score": None,
        "score_margin": None,
        "decision": decision,
        "threshold": config.RECOGNITION_MATCH_THRESHOLD,
        "liveness_confirmed": False,
        "model_version": config.RECOGNITION_MODEL_VERSION,
    }


def _log_recognition_attempt(result, decision):
    try:
        _write_recognition_attempt(result, decision)
    except Exception as e:
        # Telemetry writes must never take the scan loop down.
        logger.error("Failed to log recognition attempt (%s): %s", decision, e)


def _write_recognition_attempt(result, decision):
    database.log_recognition_attempt(
        timestamp=_now_iso(),
        kiosk_id=config.KIOSK_ID,
        face_detected=bool(result and result.get("face_loc") is not None),
        candidate_worker_id=result.get("candidate_worker_id") if result else None,
        candidate_worker_name=result.get("candidate_worker_name") if result else None,
        best_score=result.get("best_score") if result else None,
        second_best_score=result.get("second_best_score") if result else None,
        score_margin=result.get("score_margin") if result else None,
        decision=decision,
        threshold=result.get("threshold") if result else config.RECOGNITION_MATCH_THRESHOLD,
        liveness_confirmed=bool(result and result.get("liveness_confirmed")),
        model_version=result.get("model_version") if result else config.RECOGNITION_MODEL_VERSION,
    )


def run(args):
    if args.server:
        config.SERVER_URL = args.server
    if args.kiosk_id:
        config.KIOSK_ID = args.kiosk_id

    sync_enabled = True
    try:
        require_kiosk_api_key()
    except RuntimeError as exc:
        sync_enabled = False
        logger.critical(
            "%s Server synchronization is disabled; local attendance and recognition records will remain queued.",
            exc,
        )

    try:
        require_kiosk_ui_key()
    except RuntimeError as exc:
        logger.critical(
            "%s Protected kiosk web routes will remain unavailable; face scanning and local logging will continue.",
            exc,
        )

    os.makedirs(config.DATA_DIR, exist_ok=True)
    os.makedirs(config.FACES_DIR, exist_ok=True)
    os.makedirs(config.MODEL_DIR, exist_ok=True)
    database.init_db()

    # Download and load the MobileFaceNet model, but continue booting if it
    # is unavailable (offline or corrupt) - health reports it truthfully.
    model_ready = recognition_model_ready()
    if not model_ready:
        logger.warning("Recognition model unavailable at startup; kiosk will keep retrying in the background.")

    logger.info("Starting web UI on port %d...", config.KIOSK_PORT)
    web_app.start_server()

    recognizer = FaceRecognizer()
    recognizer.load_faces()
    logger.info("Loaded %d known faces", recognizer.known_count)

    # Blink verification. If the shape predictor is missing, keep the door
    # working but record events as unverified and report the kiosk degraded —
    # never claim liveness we don't have.
    liveness = recognizer.liveness_checker if config.LIVENESS_REQUIRED else None
    if config.LIVENESS_REQUIRED and liveness is None:
        logger.critical(
            "Liveness model missing: clock events will be recorded WITHOUT blink "
            "verification and this kiosk will report itself degraded."
        )

    # An empty or model-incompatible roster rejects every scan; the dashboard
    # must see that from boot, not only after the first worker walks up.
    startup_degraded = None
    if recognizer.known_count == 0:
        startup_degraded = "no_workers_synced"
    elif recognizer.usable_count == 0:
        startup_degraded = "encoding_mismatch"
    elif config.LIVENESS_REQUIRED and liveness is None:
        startup_degraded = "liveness_unavailable"

    web_app.update_health(
        model_ok=model_ready,
        liveness_available=liveness is not None,
        known_workers=recognizer.known_count,
        degraded_reason=startup_degraded,
    )

    def kiosk_health():
        snapshot = web_app.get_health_snapshot()
        snapshot["known_workers"] = recognizer.known_count
        return snapshot

    def base_degraded_reason():
        """The standing degradation, if any, once transient faults clear.

        Roster-aware so that clearing a transient fault (camera recovery,
        model recovery, a successful scan) can never erase the fact that an
        empty roster is still rejecting every worker.
        """
        if recognizer.known_count == 0:
            return "no_workers_synced"
        if recognizer.usable_count == 0:
            # Rows exist but none match the kiosk model (legacy 128-dim data):
            # every scan will be rejected until re-enrollment.
            return "encoding_mismatch"
        if config.LIVENESS_REQUIRED and liveness is None:
            return "liveness_unavailable"
        return None

    sync_worker = (
        SyncWorker(
            recognizer=recognizer,
            health_provider=kiosk_health,
            health_reporter=web_app.update_health,
        )
        if sync_enabled
        else None
    )
    if sync_worker:
        sync_worker.start()

    camera = Camera(mode=args.camera)
    camera_attempts = 0
    critical_logged = False
    while True:
        try:
            camera.start()
            web_app.update_health(camera_ok=True, degraded_reason=base_degraded_reason())
            if camera_attempts:
                logger.info("Camera initialized after %d retry attempt(s)", camera_attempts)
            break
        except RuntimeError as e:
            camera.stop()
            camera_attempts += 1
            logger.error("Camera error during startup (attempt %d): %s", camera_attempts, e)
            if camera_attempts >= 10 and not critical_logged:
                logger.critical("Camera failed to initialize after %d attempts; continuing to retry every 30 seconds", camera_attempts)
                critical_logged = True
            web_app.update_health(camera_ok=False, degraded_reason="camera_error")
            web_app.update_status(state="ERROR", message=f"Camera error: {e}. Retrying in 30s", worker_id=None, face_detected=False)
            time.sleep(30)

    # Shared state
    detect_lock = threading.Lock()
    pending_frame = [None]  # (bgr, rgb) tuple
    current_result = [None]
    detect_count = [0]

    last_clocks = {}
    display_until = [0.0]
    box_loc = None
    box_color = GOLD
    box_label = None
    unknown_streak = 0

    def detection_loop():
        logger.info("Detection thread started")
        embedding_history = FreshFaceMatcher(config.RECOGNITION_EMBEDDING_WINDOW, config.RECOGNITION_MATCH_THRESHOLD)
        while True:
            with detect_lock:
                frames = pending_frame[0]
                pending_frame[0] = None

            if frames is None:
                time.sleep(0.1)
                continue

            bgr_frame, rgb_frame, frame_ts = frames

            try:
                # Use dlib for face DETECTION (finding where the face is)
                small_rgb = cv2.resize(rgb_frame, (0, 0), fx=0.5, fy=0.5)
                locs = fr.face_locations(small_rgb, model="hog")

                detect_count[0] += 1
                if detect_count[0] % 20 == 1:
                    logger.info("Detection #%d: found %d faces", detect_count[0], len(locs))

                if not locs:
                    embedding_history.clear()
                    current_result[0] = None
                    continue

                # Scale to full resolution
                top, right, bottom, left = largest_face(locs)
                face_loc = (top * 2, right * 2, bottom * 2, left * 2)

                # Get the shared 512-dim MobileFaceNet embedding (same model
                # as server enrollment and the local enroll CLI)
                try:
                    embedding = embed_face(bgr_frame, face_loc)
                except Exception as e:
                    logger.error("ONNX encoding error: %s", e)
                    embedding_history.clear()
                    current_result[0] = _empty_recognition_result(face_loc, decision="rejected_model_error")
                    continue

                if embedding is None:
                    embedding_history.clear()
                    current_result[0] = _empty_recognition_result(face_loc, decision="rejected_no_embedding")
                    continue

                # Match against known workers
                known_encs, known_ids, known_names, known_server_ids = recognizer.snapshot_known_faces()
                matched = None
                conf = 0.0
                best_idx = None
                second_score = None

                if known_encs:
                    cand_dim = len(embedding)
                    # Validate every roster row, not just the first: legacy
                    # 128-dim entries can coexist with 512-dim ones (server and
                    # local stores both still accept them), and an unchecked
                    # np.dot on a mixed roster would crash the scan.
                    compatible = [
                        (i, known) for i, known in enumerate(known_encs) if len(known) == cand_dim
                    ]
                    skipped = len(known_encs) - len(compatible)
                    if skipped and detect_count[0] % 50 == 1:
                        logger.warning(
                            "Skipping %d roster encoding(s) with incompatible dimensions (expected %d)",
                            skipped, cand_dim,
                        )

                    if not compatible:
                        # No usable encodings at all: every worker would be
                        # silently rejected. Surface it as a kiosk fault, not a
                        # failed recognition.
                        logger.warning("Dim mismatch: no roster encodings match live dim=%d", cand_dim)
                        embedding_history.clear()
                        current_result[0] = _empty_recognition_result(face_loc, decision="rejected_dim_mismatch")
                        continue

                    scores, frame_accepted = embedding_history.match(
                        embedding, compatible, known_ids, known_server_ids, frame_ts,
                    )
                    best_sim, best_idx = scores[0]
                    if len(scores) > 1:
                        second_score = scores[1][0]
                    conf = best_sim
                    logger.info("Match: sim=%.3f name=%s window=%d", conf, known_names[best_idx], len(embedding_history))
                    if frame_accepted:
                        matched = known_names[best_idx]

                margin = conf - second_score if second_score is not None else None
                candidate_worker_id = known_ids[best_idx] if best_idx is not None else None
                candidate_worker_name = known_names[best_idx] if best_idx is not None else None
                candidate_server_worker_id = (
                    known_server_ids.get(candidate_worker_id) if candidate_worker_id is not None else None
                )
                candidate_encoding = (
                    np.array(known_encs[best_idx], copy=True) if best_idx is not None else None
                )
                decision = "accepted" if matched else "rejected_unknown"
                if (
                    matched is None
                    and best_idx is not None
                    and conf >= config.RECOGNITION_MATCH_THRESHOLD - config.RECOGNITION_NEAR_MISS_MARGIN
                ):
                    decision = "near_miss"

                current_result[0] = {
                    "face_loc": face_loc,
                    "frame_ts": frame_ts,
                    "name": matched,
                    "confidence": conf,
                    "candidate_worker_id": candidate_worker_id,
                    "candidate_worker_name": candidate_worker_name,
                    "server_worker_id": candidate_server_worker_id,
                    "candidate_encoding": candidate_encoding,
                    "best_score": conf if best_idx is not None else None,
                    "second_best_score": second_score,
                    "score_margin": margin,
                    "decision": decision,
                    "threshold": config.RECOGNITION_MATCH_THRESHOLD,
                    "liveness_confirmed": False,
                    "model_version": config.RECOGNITION_MODEL_VERSION,
                }

            except Exception as e:
                logger.error("Detection error: %s", e, exc_info=True)
                embedding_history.clear()
                current_result[0] = None

    det_thread = threading.Thread(target=detection_loop, daemon=True, name="face-detect")
    det_thread.start()

    web_app.update_status(state="IDLE", message="Step toward camera",
                          worker_id=None, known_workers=recognizer.known_count, face_detected=False)
    logger.info("Kiosk ready")

    # Liveness wait state: set when a matched worker still needs to blink.
    pending_clock = [None]

    def record_clock(result, worker_id, display_name, display_id, confidence, liveness_confirmed,
                     server_worker_id=None):
        """Log the clock event + telemetry, update the display. Returns True on success."""
        if config.KIOSK_TYPE == "entry":
            action = "clock_in"
        elif config.KIOSK_TYPE == "exit":
            action = "clock_out"
        else:
            last_action = database.get_last_action(worker_id)
            action = "clock_out" if last_action == "clock_in" else "clock_in"

        result["liveness_confirmed"] = liveness_confirmed
        try:
            database.log_attendance(
                worker_id=worker_id, worker_name=display_name,
                action=action, liveness_confirmed=liveness_confirmed, confidence=confidence,
                server_worker_id=server_worker_id,
            )
            _log_recognition_attempt(result, "accepted")
        except Exception as e:
            # A busy/locked SQLite must never take the kiosk down.
            logger.error("Failed to record attendance for %s: %s", display_name, e, exc_info=True)
            web_app.update_status(state="ERROR", message="Could not record scan - please try again",
                                  worker_name=display_name, worker_id=display_id, face_detected=True,
                                  confidence=confidence, known_workers=recognizer.known_count)
            return False

        last_clocks[worker_id] = datetime.now()
        web_app.update_health(last_scan_at=_now_iso(), degraded_reason=base_degraded_reason())

        # Worker-facing copy: name and time only. Confidence percentages are
        # operator data and live in the recognition telemetry, not on the door.
        time_str = datetime.now().strftime("%I:%M %p")
        msg = (
            f"Welcome, {display_name}! {time_str}"
            if action == "clock_in"
            else f"Goodbye, {display_name}! {time_str}"
        )
        web_app.update_status(state="CLOCKED_IN", message=msg,
                              worker_name=display_name, worker_id=display_id, action=action,
                              confidence=confidence, face_detected=True,
                              liveness_confirmed=liveness_confirmed,
                              known_workers=recognizer.known_count)
        logger.info("%s: %s id=%s (confidence: %.2f, liveness=%s)",
                    action.replace("_", " ").title(), display_name, display_id or "n/a",
                    confidence, liveness_confirmed)
        return True

    camera_healthy = True
    model_healthy = model_ready
    # roster-derived degraded_reason currently reported
    roster_fault = startup_degraded if startup_degraded in ("no_workers_synced", "encoding_mismatch") else None
    try:
        while True:
            try:
                bgr_frame, rgb_frame = camera.capture()
            except Exception as e:
                logger.error("Capture error: %s", e)
                if camera_healthy:
                    camera_healthy = False
                    web_app.update_health(camera_ok=False, degraded_reason="camera_error")
                time.sleep(1)
                continue

            if not camera_healthy:
                camera_healthy = True
                web_app.update_health(camera_ok=True, degraded_reason=base_degraded_reason())

            now = time.time()

            # 1. Push BGR frame to MJPEG stream (always, never blocks)
            web_app.set_frame(draw_box(bgr_frame, box_loc, box_color, box_label))

            # 2. Feed to detection thread (stamped so results can be ordered
            #    against events like blink confirmation)
            with detect_lock:
                if pending_frame[0] is None:
                    pending_frame[0] = (bgr_frame.copy(), rgb_frame.copy(), now)

            # 3. Skip during display hold; drop results that land mid-hold so a
            #    lingering face can't re-trigger off stale data every cycle.
            if now < display_until[0]:
                current_result[0] = None
                time.sleep(0.05)
                continue

            # 4. Blink verification window for an already-matched worker.
            #    The clock is only recorded after BOTH a blink AND a fresh
            #    recognition result matching the pending worker observed
            #    after that blink, so a bystander's blink between detection
            #    cycles can never complete someone else's attendance.
            pending = pending_clock[0]
            if pending is not None:
                fresh = current_result[0]
                identity_changed = False
                if fresh is not None:
                    current_result[0] = None
                    fresh_identity = (fresh.get("candidate_worker_id"), fresh.get("server_worker_id"))
                    pending_identity = (pending["worker_id"], pending["server_worker_id"])
                    if fresh.get("name") is None or fresh_identity != pending_identity:
                        identity_changed = True
                    else:
                        # The post-blink confirmation must come from a frame
                        # captured AFTER the blink completed - a result already
                        # in flight when the blink landed proves nothing about
                        # who blinked.
                        if (
                            pending["blink_confirmed"]
                            and fresh.get("frame_ts", 0.0) > pending["blink_confirmed_at"]
                        ):
                            pending["post_blink_confirmed"] = True
                        if fresh.get("face_loc") is not None:
                            box_loc = fresh.get("face_loc")

                if identity_changed:
                    pending_clock[0] = None
                    _log_recognition_attempt(pending["result"], "rejected_liveness_identity_change")
                    liveness.reset()
                    box_loc = None
                    box_label = None
                    box_color = GOLD
                    web_app.update_status(state="IDLE", message="Hold steady...",
                                          worker_id=None, face_detected=True,
                                          known_workers=recognizer.known_count)
                    continue

                if not pending["blink_confirmed"]:
                    def _frame_matches_pending(check_frame, check_loc):
                        # Every frame that advances blink state (closed-eye
                        # frames and the completing open-eye frame) must embed
                        # to the pending worker; otherwise LivenessChecker
                        # resets the attempt, so no frame from a different
                        # face can contribute to the blink.
                        try:
                            emb = embed_face(check_frame, check_loc)
                        except Exception as e:
                            logger.warning("Blink-frame embedding failed: %s", e)
                            return False
                        if (
                            emb is None
                            or pending["encoding"] is None
                            or len(pending["encoding"]) != len(emb)
                        ):
                            return False
                        return cosine_sim(pending["encoding"], emb) >= config.RECOGNITION_MATCH_THRESHOLD

                    blink_ok = (
                        liveness.update(bgr_frame, box_loc, frame_check=_frame_matches_pending)
                        if box_loc is not None
                        else False
                    )
                    if blink_ok:
                        # Identity-bound blink complete - now require a fresh
                        # recognition result from a frame captured after this
                        # moment to re-confirm the same worker before
                        # recording. Give the slower detection thread time to
                        # deliver it.
                        pending["blink_confirmed"] = True
                        pending["blink_confirmed_at"] = now
                        pending["deadline"] = max(pending["deadline"], now + config.LIVENESS_WAIT_SEC)

                if pending["post_blink_confirmed"]:
                    pending_clock[0] = None
                    recorded = record_clock(
                        pending["result"], pending["worker_id"], pending["display_name"],
                        pending["display_id"], pending["confidence"], liveness_confirmed=True,
                        server_worker_id=pending["server_worker_id"],
                    )
                    liveness.reset()
                    display_until[0] = now + (config.DISPLAY_TIME_SUCCESS_SEC if recorded else 2)
                elif now > pending["deadline"]:
                    pending_clock[0] = None
                    _log_recognition_attempt(pending["result"], "rejected_liveness_timeout")
                    web_app.update_status(state="NOT_RECOGNIZED",
                                          message="Blink not detected - please try again",
                                          worker_name=pending["display_name"], worker_id=pending["display_id"],
                                          face_detected=True, confidence=pending["confidence"],
                                          ear=liveness.get_ear(), known_workers=recognizer.known_count)
                    liveness.reset()
                    display_until[0] = now + 2
                else:
                    waiting_msg = (
                        f"Hold still, {pending['display_name']} - verifying..."
                        if pending["blink_confirmed"]
                        else f"Blink to verify, {pending['display_name']}"
                    )
                    web_app.update_status(state="WAITING_FOR_BLINK",
                                          message=waiting_msg,
                                          worker_name=pending["display_name"], worker_id=pending["display_id"],
                                          face_detected=True, confidence=pending["confidence"],
                                          ear=liveness.get_ear(), known_workers=recognizer.known_count)
                    time.sleep(0.03)
                continue

            # 5. Consume the detection result exactly once (a result must never
            #    be reprocessed across loop ticks).
            result = current_result[0]
            if result is not None:
                current_result[0] = None

            # Roster degradation tracks sync state alone - it must not wait
            # for someone to scan, in either direction.
            if recognizer.known_count == 0:
                expected_roster_fault = "no_workers_synced"
            elif recognizer.usable_count == 0:
                expected_roster_fault = "encoding_mismatch"
            else:
                expected_roster_fault = None
            if expected_roster_fault != roster_fault:
                roster_fault = expected_roster_fault
                web_app.update_health(degraded_reason=expected_roster_fault or base_degraded_reason())

            if result is None:
                if box_loc is not None:
                    unknown_streak = 0
                    box_loc = None
                    box_label = None
                    web_app.update_status(state="IDLE", message="Step toward camera",
                                          worker_id=None, face_detected=False, known_workers=recognizer.known_count)
                time.sleep(0.05)
                continue

            face_loc = result.get("face_loc")
            name = result.get("name")
            confidence = result.get("confidence") or 0.0
            decision = result.get("decision")
            box_loc = face_loc

            # 6. Kiosk faults are not the worker's fault: say the scanner is
            #    down instead of blaming their face.
            degraded_fault = None
            if decision == "rejected_model_error":
                degraded_fault = "model_error"
                model_healthy = False
                web_app.update_health(model_ok=False, degraded_reason=degraded_fault)
            elif not model_healthy:
                # Any non-model-error result means an embedding was computed,
                # so a transient ONNX failure has recovered - stop reporting it.
                model_healthy = True
                web_app.update_health(model_ok=True, degraded_reason=base_degraded_reason())

            if degraded_fault is None and decision == "rejected_dim_mismatch":
                degraded_fault = "encoding_mismatch"
                web_app.update_health(degraded_reason=degraded_fault)
            elif degraded_fault is None and recognizer.known_count == 0:
                degraded_fault = "no_workers_synced"
                web_app.update_health(degraded_reason=degraded_fault)

            if degraded_fault:
                roster_fault = degraded_fault if degraded_fault != "model_error" else roster_fault
            elif roster_fault:
                # This scan produced a compatible embedding against a synced
                # roster, so any earlier roster/model degradation is over.
                roster_fault = None
                web_app.update_health(degraded_reason=base_degraded_reason())

            if degraded_fault:
                box_color = RED
                box_label = None
                _log_recognition_attempt(result, decision or "rejected_unknown")
                web_app.update_status(state="SERVICE_DEGRADED",
                                      message="Scanner unavailable - please use the sign-in sheet",
                                      worker_id=None, face_detected=True,
                                      known_workers=recognizer.known_count)
                display_until[0] = now + config.DISPLAY_TIME_SEC
                continue

            if name is None:
                # unknown_streak counts consumed detection results, so this is
                # N real recognition attempts, not N camera frames.
                unknown_streak += 1
                box_color = GOLD if unknown_streak < config.RECOGNITION_UNKNOWN_STREAK else RED
                box_label = None
                if unknown_streak < config.RECOGNITION_UNKNOWN_STREAK:
                    web_app.update_status(state="IDLE", message="Hold steady...",
                                          worker_id=None, face_detected=True, confidence=confidence,
                                          known_workers=recognizer.known_count)
                else:
                    unknown_streak = 0
                    _log_recognition_attempt(result, decision or "rejected_unknown")
                    web_app.update_status(state="NOT_RECOGNIZED", message="Face not recognized",
                                          worker_id=None, face_detected=True, confidence=confidence,
                                          known_workers=recognizer.known_count)
                    display_until[0] = now + config.DISPLAY_TIME_SEC
                continue

            unknown_streak = 0
            box_color = GREEN

            worker_id = result.get("candidate_worker_id")
            server_worker_id = result.get("server_worker_id")
            worker_encoding = None
            if worker_id is not None:
                # The candidate encoding is from the same immutable detection
                # result identity; a later roster reload cannot remap by name.
                worker_encoding = result.get("candidate_encoding")

            if worker_id is None:
                continue

            worker = database.get_worker_by_id(worker_id)
            # Only use mutable worker metadata if it is still the same server
            # identity that produced the match. The recognition name and id
            # remain authoritative across a concurrent delete/reload.
            same_worker = worker and (worker["server_id"] or None) == server_worker_id
            display_id = format_worker_display_id(worker if same_worker else None, worker_id)
            display_name = name
            id_suffix = f" | ID: {display_id}" if display_id else ""
            box_label = f"{display_name}{id_suffix}"

            # Debounce against the database (not just memory) so a service
            # restart can't re-arm double-clocking, and word it by what
            # actually happened last — an exit kiosk must not say "clocked in".
            last = last_clocks.get(worker_id)
            recently_clocked = (
                (last and datetime.now() - last < timedelta(minutes=config.CLOCK_DEBOUNCE_MINUTES))
                or database.was_recently_clocked(worker_id, config.CLOCK_DEBOUNCE_MINUTES)
            )
            if recently_clocked:
                last_action = database.get_last_action(worker_id)
                verb = "clocked out" if last_action == "clock_out" else "clocked in"
                already_msg = f"Already {verb}, {display_name}!"
                web_app.update_status(state="ALREADY_CLOCKED",
                                      message=already_msg,
                                      worker_name=display_name, worker_id=display_id, face_detected=True,
                                      confidence=confidence,
                                      known_workers=recognizer.known_count)
                _log_recognition_attempt(result, "accepted_already_clocked")
                display_until[0] = now + config.DISPLAY_TIME_SEC
                continue

            if liveness is not None:
                # Matched - now require a blink before the event is recorded.
                liveness.reset()
                pending_clock[0] = {
                    "result": result,
                    "worker_id": worker_id,
                    "display_name": display_name,
                    "display_id": display_id,
                    "confidence": confidence,
                    "server_worker_id": server_worker_id,
                    "encoding": worker_encoding,
                    "deadline": now + config.LIVENESS_WAIT_SEC,
                    "blink_confirmed": False,
                    "blink_confirmed_at": 0.0,
                    "post_blink_confirmed": False,
                }
                web_app.update_status(state="WAITING_FOR_BLINK",
                                      message=f"Blink to verify, {display_name}",
                                      worker_name=display_name, worker_id=display_id,
                                      face_detected=True, confidence=confidence,
                                      ear=liveness.get_ear(), known_workers=recognizer.known_count)
                continue

            recorded = record_clock(result, worker_id, display_name, display_id, confidence,
                                    liveness_confirmed=False, server_worker_id=server_worker_id)
            display_until[0] = now + (config.DISPLAY_TIME_SUCCESS_SEC if recorded else 2)

    except KeyboardInterrupt:
        logger.info("Shutting down...")
    finally:
        camera.stop()
        if sync_worker:
            sync_worker.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FW Gatekeeper Pi Kiosk")
    parser.add_argument("--server", default=None)
    parser.add_argument("--kiosk-id", default=None)
    parser.add_argument("--camera", choices=["auto", "pi", "usb"], default="auto")
    run(parser.parse_args())
