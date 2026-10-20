#!/usr/bin/env python3
"""A portal-managed worker cannot be removed locally behind the roster receipt."""
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import test_roster_receipts as receipts
from test_sync_mapping import ENCODING, SERVER_ID
import config
import database

fake_embeddings = types.ModuleType("embeddings")
fake_embeddings.embed_face = fake_embeddings.model_ready = fake_embeddings.normalize_embedding = mock.Mock()
fake_liveness = types.ModuleType("liveness")
fake_liveness.LivenessChecker = mock.Mock
with mock.patch.dict(sys.modules, {
    "cv2": types.ModuleType("cv2"), "face_recognition": types.ModuleType("face_recognition"),
    "embeddings": fake_embeddings, "liveness": fake_liveness,
}):
    import enroll  # noqa: E402


class LocalRemovalOfSyncedWorkerTests(unittest.TestCase):
    _close_db = staticmethod(receipts.RosterReceiptTests._close_db)
    cycle = receipts.RosterReceiptTests.cycle

    def setUp(self):
        receipts.RosterReceiptTests.setUp(self)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.faces = Path(tmp.name) / "faces"
        self.faces.mkdir()
        for name in ("FACES_DIR", "PHOTO_DIR"):
            patcher = mock.patch.object(config, name, str(self.faces))
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_cli_refuses_to_remove_a_synced_worker_so_the_roster_stays_certified(self):
        photo = self.faces / f"{SERVER_ID}.jpg"
        photo.write_bytes(b"server thumbnail")
        database.add_worker("Alex", ENCODING, server_id=SERVER_ID, employee_id="E1", photo_paths=[str(photo)])
        database.set_sync_state("last_roster_applied_at", "2026-09-25T12:00:00Z")

        with mock.patch("builtins.print") as printed:
            self.assertEqual(enroll.remove_worker("Alex"), 1)
        self.assertIn("deactivate", " ".join(str(call) for call in printed.call_args_list).lower())
        self.assertIsNotNone(database.get_worker_by_name("Alex"))
        self.assertTrue(photo.exists())

        # The next incremental receipt does not resend Alex; the kiosk must
        # still hold Alex when it certifies the roster as applied.
        posted, _ = self.cycle(receipts.roster([], full=False), post=lambda *a, **kw: receipts.ack())
        self.assertEqual(posted.call_count, 1)
        self.assertEqual(database.get_worker_by_name("Alex")["server_id"], SERVER_ID)

    def test_database_refuses_name_removal_of_a_synced_worker(self):
        database.add_worker("Alex", ENCODING, server_id=SERVER_ID)
        with self.assertRaisesRegex(ValueError, "managed by the Gatekeeper portal"):
            database.remove_worker("Alex")
        self.assertIsNotNone(database.get_worker_by_name("Alex"))

        database.add_worker("Local Only", ENCODING)
        self.assertTrue(database.remove_worker("Local Only"))
        self.assertIsNone(database.get_worker_by_name("Local Only"))


if __name__ == "__main__":
    unittest.main()
