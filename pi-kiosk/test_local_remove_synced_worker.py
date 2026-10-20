#!/usr/bin/env python3
"""A portal-managed worker cannot be removed locally behind the roster receipt."""
import sys
import tempfile
import threading
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


    def _race_adoption_on_lookup(self, call_number, photo_paths=()):
        """Adopt local Alex as portal-Alex from another connection at one name lookup.

        Lookup 1 is the CLI preflight; lookup 2 is the removal's ownership
        check. The adopter uses its own thread-local SQLite connection, like
        the background roster sync, and is given a bounded head start."""
        lookup = database.get_worker_by_name
        calls, errors = [], []

        def adopt():
            try:
                database.add_worker("Alex", ENCODING, server_id="portal-Alex", employee_id="E1",
                                    photo_paths=list(photo_paths))
            except Exception as exc:  # pragma: no cover - surfaced by the assertions
                errors.append(exc)
            finally:
                database._get_conn().close()
                database._local.conn = None

        adopter = threading.Thread(target=adopt)

        def lookup_then_adopt(name):
            worker = lookup(name)
            calls.append(name)
            if len(calls) == call_number:
                adopter.start()
                adopter.join(timeout=1.0)
            return worker

        return mock.patch.object(database, "get_worker_by_name", side_effect=lookup_then_adopt), adopter, errors

    def test_roster_adoption_during_removal_never_deletes_the_portal_worker(self):
        database.add_worker("Alex", ENCODING)
        patch, adopter, errors = self._race_adoption_on_lookup(2)
        with patch, mock.patch("builtins.print"):
            enroll.remove_worker("Alex")
        adopter.join(timeout=10)
        self.assertFalse(adopter.is_alive())
        self.assertEqual(errors, [])
        # Whichever side wins, the portal-managed worker must survive.
        rows = database._get_conn().execute("SELECT server_id FROM workers").fetchall()
        self.assertEqual([row["server_id"] for row in rows], ["portal-Alex"])

    def test_roster_adoption_after_cli_preflight_keeps_the_worker_and_photos(self):
        photo = self.faces / "alex-local.jpg"
        photo.write_bytes(b"local thumbnail")
        database.add_worker("Alex", ENCODING, photo_paths=[str(photo)])
        patch, adopter, errors = self._race_adoption_on_lookup(1, photo_paths=[str(photo)])
        with patch, mock.patch("builtins.print") as printed:
            self.assertEqual(enroll.remove_worker("Alex"), 1)
        adopter.join(timeout=10)
        self.assertEqual(errors, [])
        self.assertIn("deactivate", " ".join(str(call) for call in printed.call_args_list).lower())
        self.assertEqual(database.get_worker_by_name("Alex")["server_id"], "portal-Alex")
        self.assertTrue(photo.exists())


if __name__ == "__main__":
    unittest.main()
