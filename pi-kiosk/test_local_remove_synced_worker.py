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


    def _local_alex_with_capture(self, name="Alex"):
        folder = self.faces / enroll._safe_name(name)
        folder.mkdir(exist_ok=True)
        capture = folder / "capture_1.jpg"
        capture.write_bytes(b"local capture")
        database.add_worker(name, ENCODING, photo_paths=[str(capture)])
        return capture

    @staticmethod
    def _unlink_fails_for(target):
        original = Path.unlink

        def unlink(path, *args, **kwargs):
            if Path(path).resolve() == target.resolve():
                raise PermissionError("read-only disk")
            return original(path, *args, **kwargs)
        return mock.patch.object(Path, "unlink", unlink)

    def test_failed_photo_cleanup_is_finished_by_retrying_the_removal(self):
        capture = self._local_alex_with_capture()
        with self._unlink_fails_for(capture), mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("Alex"), 1)
            self.assertIsNone(database.get_worker_by_name("Alex"))
            # Retrying while the filesystem still fails keeps the cleanup owed.
            self.assertEqual(enroll.remove_worker("Alex"), 1)
            self.assertEqual(enroll.remove_worker("Alex"), 1)
        self.assertTrue(capture.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 1)

        with mock.patch("builtins.print") as printed:
            self.assertEqual(enroll.remove_worker("Alex"), 0)
        self.assertIn("finished pending photo cleanup", " ".join(str(call) for call in printed.call_args_list).lower())
        self.assertFalse(capture.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)
        self.assertEqual(database.list_unreferenced_photo_files(), [])
        with mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("Alex"), 1)  # nothing left to finish

    def test_cleanup_interrupted_after_the_delete_commits_is_finished_by_the_next_roster_sync(self):
        capture = self._local_alex_with_capture()
        with mock.patch.object(database, "recover_photo_cleanup", side_effect=KeyboardInterrupt), \
                mock.patch("builtins.print"), self.assertRaises(KeyboardInterrupt):
            enroll.remove_worker("Alex")
        # Simulate the process dying here and the kiosk restarting.
        self._close_db()
        database.init_db()
        self.assertIsNone(database.get_worker_by_name("Alex"))
        self.assertTrue(capture.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 1)

        posted, _ = self.cycle(receipts.roster([]), post=lambda *a, **kw: receipts.ack())
        self.assertEqual(posted.call_count, 1)
        self.assertFalse(capture.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_roster_receipt_waits_for_failed_removal_cleanup_then_acknowledges(self):
        capture = self._local_alex_with_capture()
        with self._unlink_fails_for(capture):
            with mock.patch("builtins.print"):
                self.assertEqual(enroll.remove_worker("Alex"), 1)
            posted, _ = self.cycle(receipts.roster([]), post=lambda *a, **kw: receipts.ack())
        posted.assert_not_called()
        self.assertTrue(capture.exists())
        self.assertIsNone(database.get_sync_state("last_roster_applied_at"))

        posted, _ = self.cycle(receipts.roster([]), post=lambda *a, **kw: receipts.ack())
        self.assertEqual(posted.call_count, 1)
        self.assertFalse(capture.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_photos_outside_the_photo_root_are_not_journaled(self):
        with tempfile.TemporaryDirectory() as other:
            outside = Path(other) / "legacy.jpg"
            outside.write_bytes(b"legacy capture")
            database.add_worker("Alex", ENCODING, photo_paths=[str(outside)])
            with mock.patch("builtins.print"):
                self.assertEqual(enroll.remove_worker("Alex"), 0)
            self.assertFalse(outside.exists())
            # recover_photo_cleanup refuses paths outside PHOTO_DIR, so
            # journaling one would block roster receipts indefinitely.
            journal = database._get_conn().execute("SELECT COUNT(*) FROM photo_cleanup_journal").fetchone()[0]
            self.assertEqual(journal, 0)


    def test_cli_cleanup_leaves_sync_in_flight_downloads_and_unrelated_entries_alone(self):
        capture = self._local_alex_with_capture()
        # Sync journals a download as 'published' before its worker row commits.
        in_flight = self.faces / "srv-1-download.jpg"
        in_flight.write_bytes(b"sync download in progress")
        database.record_photo_cleanup([in_flight], "published")
        with tempfile.TemporaryDirectory() as other:
            stuck = Path(other) / "legacy.jpg"
            stuck.write_bytes(b"needs manual cleanup")
            database.record_photo_cleanup([stuck], "retired")
            with mock.patch("builtins.print"):
                self.assertEqual(enroll.remove_worker("Alex"), 0)
            self.assertFalse(capture.exists())
            self.assertTrue(in_flight.exists())
            self.assertTrue(stuck.exists())
            journal = {row["path"] for row in database._get_conn().execute("SELECT path FROM photo_cleanup_journal")}
            self.assertEqual(journal, {str(in_flight), str(stuck)})

    def test_unknown_name_does_not_claim_another_workers_pending_cleanup(self):
        pending = self._local_alex_with_capture("Bob")
        with self._unlink_fails_for(pending), mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("Bob"), 1)
        with mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("Nobody"), 1)
        self.assertTrue(pending.exists())
        with mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("Bob"), 0)
        self.assertFalse(pending.exists())

    def test_ownerless_journal_entries_are_left_to_roster_sync(self):
        # Entries journaled without an owner (sync's own, or a database from
        # before owners were recorded) are never claimed by name.
        folder = self.faces / "Bob"
        folder.mkdir()
        legacy = folder / "capture_1.jpg"
        legacy.write_bytes(b"retired before owners were recorded")
        database.record_photo_cleanup([legacy], "retired")
        with mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("Bob"), 1)
        self.assertTrue(legacy.exists())
        posted, _ = self.cycle(receipts.roster([]), post=lambda *a, **kw: receipts.ack())
        self.assertEqual(posted.call_count, 1)
        self.assertFalse(legacy.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_existing_journal_table_gains_owner_columns_and_keeps_rows(self):
        conn = database._get_conn()
        conn.executescript("""
            DROP TABLE photo_cleanup_journal;
            CREATE TABLE photo_cleanup_journal (
                path TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK(kind IN ('published', 'retired'))
            );
            INSERT INTO photo_cleanup_journal (path, kind) VALUES ('/old/published.jpg', 'published');
        """)
        database.init_db()
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(photo_cleanup_journal)")}
        self.assertTrue({"owner_worker_id", "owner_name", "owner_folder"} <= columns)
        rows = [tuple(row) for row in conn.execute("SELECT path, kind, owner_name FROM photo_cleanup_journal")]
        self.assertEqual(rows, [("/old/published.jpg", "published", None)])

    def test_name_without_a_capture_folder_never_removes_the_photo_root(self):
        keep = self.faces / "other-worker.jpg"
        keep.write_bytes(b"another worker's photo")
        database.add_worker("Other", ENCODING, photo_paths=[str(keep)])
        database.add_worker("!!!", ENCODING)
        with mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("!!!"), 0)
        self.assertTrue(keep.exists())
        self.assertIsNone(database.get_worker_by_name("!!!"))

    def test_retry_with_the_same_case_insensitive_name_finishes_cleanup(self):
        capture = self._local_alex_with_capture()
        with self._unlink_fails_for(capture), mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("alex"), 1)
        self.assertTrue(capture.exists())
        with mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("alex"), 0)
        self.assertFalse(capture.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_unknown_name_with_the_same_sanitized_folder_does_not_consume_cleanup(self):
        capture = self._local_alex_with_capture("Alex!")
        with self._unlink_fails_for(capture), mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("Alex!"), 1)
        # "Alex" sanitizes to the same capture folder but names no removed worker.
        with mock.patch("builtins.print") as printed:
            self.assertEqual(enroll.remove_worker("Alex"), 1)
        self.assertIn("worker not found: alex", " ".join(str(call) for call in printed.call_args_list).lower())
        self.assertTrue(capture.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 1)
        with mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("alex!"), 0)
        self.assertFalse(capture.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_removing_local_worker_preserves_another_workers_shared_capture_folder(self):
        folder = self.faces / "Alex"
        folder.mkdir()
        own_photo = folder / "local.jpg"
        own_photo.write_bytes(b"local photo")
        portal_photo = folder / "portal.jpg"
        portal_photo.write_bytes(b"portal photo")
        database.add_worker("Alex!", ENCODING, photo_paths=[str(own_photo)])
        database.add_worker("Alex", ENCODING, server_id="portal-Alex", photo_paths=[str(portal_photo)])
        with mock.patch("builtins.print"):
            self.assertEqual(enroll.remove_worker("Alex!"), 0)
        self.assertIsNone(database.get_worker_by_name("Alex!"))
        self.assertIsNotNone(database.get_worker_by_name("Alex"))
        self.assertFalse(own_photo.exists())
        self.assertEqual(portal_photo.read_bytes(), b"portal photo")

    def test_removing_local_worker_preserves_a_shared_legacy_photo_outside_photo_root(self):
        with tempfile.TemporaryDirectory() as legacy:
            photo = Path(legacy) / "shared.jpg"
            photo.write_bytes(b"shared legacy photo")
            database.add_worker("Local", ENCODING, photo_paths=[str(photo)])
            database.add_worker("Portal", ENCODING, server_id="portal-id", photo_paths=[str(photo)])
            with mock.patch("builtins.print"):
                self.assertEqual(enroll.remove_worker("Local"), 0)
            self.assertIsNone(database.get_worker_by_name("Local"))
            self.assertIsNotNone(database.get_worker_by_name("Portal"))
            self.assertEqual(photo.read_bytes(), b"shared legacy photo")


if __name__ == "__main__":
    unittest.main()
