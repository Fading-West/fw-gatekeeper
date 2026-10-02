"""Synthetic policy domains and fail-closed workflow regressions; no models."""
import ast
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

import config
from kiosk_policy import require_kiosk_action_type, validate_kiosk_policy


class KioskPolicyTests(unittest.TestCase):
    def settings(self, **overrides):
        values = {name: getattr(config, name) for name in (
            "KIOSK_TYPE", "LIVENESS_REQUIRED", "RECOGNITION_MATCH_THRESHOLD",
            "RECOGNITION_NEAR_MISS_MARGIN", "RECOGNITION_EMBEDDING_WINDOW",
            "RECOGNITION_UNKNOWN_STREAK", "LIVENESS_EAR_THRESHOLD", "LIVENESS_BLINK_FRAMES",
            "LIVENESS_TIMEOUT_SEC", "LIVENESS_WAIT_SEC", "CLOCK_DEBOUNCE_MINUTES",
            "DISPLAY_TIME_SEC", "DISPLAY_TIME_SUCCESS_SEC")}
        values.update(overrides)
        return types.SimpleNamespace(**values)

    def test_explicit_action_modes_and_invalid_types(self):
        for mode in ("entry", "exit", "auto"):
            self.assertEqual(require_kiosk_action_type(self.settings(KIOSK_TYPE=mode)), mode)
        for mode in ("ENTRY", "entyr", "", None, True, []):
            with self.assertRaises(ValueError):
                require_kiosk_action_type(self.settings(KIOSK_TYPE=mode))

    def test_finite_typed_scan_domains_without_coercion(self):
        for name, values in {
            "RECOGNITION_MATCH_THRESHOLD": [float("nan"), float("inf"), -1, 0, 1.1, "0.45", True, 10**1000],
            "RECOGNITION_NEAR_MISS_MARGIN": [-0.1, 1.1, float("nan")],
            "RECOGNITION_EMBEDDING_WINDOW": [0, -1, 1.5, "3", True, sys.maxsize + 1, 10**1000],
            "RECOGNITION_UNKNOWN_STREAK": [0, False],
            "LIVENESS_REQUIRED": ["false", 0, None],
            "LIVENESS_EAR_THRESHOLD": [0, -1, float("inf")],
            "LIVENESS_BLINK_FRAMES": [0, True, 2.5],
            "LIVENESS_TIMEOUT_SEC": [0, float("nan")],
            "LIVENESS_WAIT_SEC": [-1, "8"],
            "CLOCK_DEBOUNCE_MINUTES": [-1, float("inf"), 1e20],
            "DISPLAY_TIME_SEC": [-1, "5"],
            "DISPLAY_TIME_SUCCESS_SEC": [float("nan")],
        }.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    policy = validate_kiosk_policy(self.settings(**{name: value}))
                    self.assertIn(name, policy.recognition_errors)
                    self.assertEqual(policy.action_errors, ())

    def test_consumer_bounds_do_not_invent_smaller_operational_limits(self):
        self.assertTrue(validate_kiosk_policy(self.settings(RECOGNITION_EMBEDDING_WINDOW=sys.maxsize)).valid)
        self.assertTrue(validate_kiosk_policy(self.settings(CLOCK_DEBOUNCE_MINUTES=1e9)).valid)

    def test_invalid_startup_keeps_ui_and_sync_before_native_model_work(self):
        source = ast.parse(Path(__file__).with_name("main.py").read_text())
        run = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "run")
        calls = []
        web = types.SimpleNamespace(start_server=lambda: calls.append("ui"),
                                    update_health=lambda **fields: calls.append(fields),
                                    update_status=lambda **fields: None, get_health_snapshot=lambda: {})
        class Sync:
            def __init__(self, **fields): calls.append("sync" if fields["recognizer"] is None else "unexpected-recognizer")
            def start(self): calls.append("sync-start")
            def stop(self): calls.append("sync-stop")
        def stop_loop(_): raise KeyboardInterrupt
        def forbidden(): raise AssertionError("Invalid policy initialized native recognition")
        namespace = {"config": config, "validate_kiosk_policy": validate_kiosk_policy,
                     "require_kiosk_ui_key": lambda: None, "require_kiosk_api_key": lambda: None,
                     "os": types.SimpleNamespace(makedirs=lambda *args, **kwargs: None),
                     "database": types.SimpleNamespace(init_db=lambda: calls.append("database")),
                     "web_app": web, "SyncWorker": Sync, "time": types.SimpleNamespace(sleep=stop_loop),
                     "logger": mock.Mock(), "recognition_model_ready": forbidden, "FaceRecognizer": forbidden}
        exec(compile(ast.Module(body=[run], type_ignores=[]), "actual-policy-startup", "exec"), namespace)
        namespace["FreshFaceMatcher"] = forbidden
        namespace["threading"] = types.SimpleNamespace(Thread=forbidden, Lock=forbidden)
        for setting, value in (("RECOGNITION_MATCH_THRESHOLD", float("nan")),
                               ("RECOGNITION_EMBEDDING_WINDOW", 10**1000),
                               ("CLOCK_DEBOUNCE_MINUTES", 1e20)):
            calls.clear()
            with self.subTest(setting=setting), mock.patch.object(config, setting, value):
                namespace["run"](types.SimpleNamespace(server=None, kiosk_id=None))
            self.assertEqual(calls[:2], ["database", "ui"])
            self.assertIn({"model_ok": False, "camera_ok": False, "degraded_reason": "kiosk_policy_error"}, calls)
            self.assertEqual(calls[-3:], ["sync", "sync-start", "sync-stop"])

    def test_recognition_fault_allows_supervised_manual_but_invalid_mode_does_not_infer(self):
        with mock.patch.dict(sys.modules, {"cv2": types.ModuleType("cv2")}):
            import app
        client = app.app.test_client()
        headers = {"X-Kiosk-UI-Key": "synthetic-ui"}
        worker = {"id": 1, "name": "Synthetic Worker", "employee_id": "S1", "server_id": None}
        with mock.patch.object(config, "KIOSK_UI_KEY", "synthetic-ui", create=True), \
             mock.patch.object(config, "KIOSK_SUPERVISOR_PIN", "synthetic-pin", create=True), \
             mock.patch.object(config, "KIOSK_TYPE", "entry"), \
             mock.patch.object(config, "RECOGNITION_MATCH_THRESHOLD", float("nan")), \
             mock.patch.object(config, "RECOGNITION_EMBEDDING_WINDOW", 10**1000), \
             mock.patch.object(config, "CLOCK_DEBOUNCE_MINUTES", 1e20), \
             mock.patch.object(app.database, "get_worker_by_id", return_value=worker), \
             mock.patch.object(app.database, "log_attendance", return_value=42) as record:
            client.post("/supervisor/unlock", json={"pin": "synthetic-pin"}, headers=headers)
            self.assertEqual(client.post("/manual-clock", json={"worker_id": 1}, headers=headers).status_code, 200)
            with mock.patch.object(config, "KIOSK_TYPE", "entyr"):
                self.assertEqual(client.post("/manual-clock", json={"worker_id": 1}, headers=headers).status_code, 503)
                self.assertEqual(client.post("/manual-clock", json={"worker_id": 1, "action": "clock_out"}, headers=headers).status_code, 200)
            self.assertEqual(client.post("/manual-clock", json={"worker_id": 1, "action": "toggle"}, headers=headers).status_code, 400)
            self.assertEqual(record.call_count, 2)
            health = client.get("/health").get_json()
            self.assertFalse(health["policy_ok"])
            self.assertIn("RECOGNITION_MATCH_THRESHOLD", health["policy_errors"])
            self.assertIn("RECOGNITION_EMBEDDING_WINDOW", health["policy_errors"])
            self.assertIn("CLOCK_DEBOUNCE_MINUTES", health["policy_errors"])
            self.assertEqual(health["degraded_reason"], "kiosk_policy_error")


if __name__ == "__main__":
    unittest.main()
