"""Disposable SQLite/filesystem acceptance for owned enrollment publications."""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import config
import database


class LocalPhotoOwnershipTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.photos = self.root / "photos"
        for setting, value in (("DB_PATH", str(self.root / "kiosk.db")),
                               ("PHOTO_DIR", str(self.photos))):
            patch = mock.patch.object(config, setting, value)
            patch.start()
            self.addCleanup(patch.stop)
        database._local.conn = None
        self.addCleanup(self.close_connection)
        database.init_db()
        self.encoding = np.ones(512)

    @staticmethod
    def close_connection():
        connection = getattr(database._local, "conn", None)
        if connection:
            connection.close()
            database._local.conn = None

    def test_namesakes_and_shared_photos_survive_local_replacement_and_removal(self):
        synced = database.publish_synced_worker("Alex", self.encoding, [b"server"],
            enrolled_at=None, server_id="server-alex", employee_id="A1")
        local = database.publish_local_enrollment("Alex", self.encoding, [b"local"])
        old = Path(database.get_worker_by_id(local)["photo_paths"][0])
        shared = database.add_worker("Shared", self.encoding, photo_paths=[str(old)])
        replacement = database.publish_local_enrollment("Alex", self.encoding, [b"replacement"])
        self.assertEqual(replacement, local)
        self.assertTrue(old.exists())
        self.assertEqual(Path(database.get_worker_by_id(synced)["photo_paths"][0]).read_bytes(), b"server")
        with self.assertRaises(ValueError):
            database.remove_local_worker_owned("Alex")
        self.assertIsNotNone(database.get_worker_by_id(shared))

    def test_failed_worker_commit_removes_only_new_files_and_keeps_old_reference(self):
        worker = database.publish_local_enrollment("Alex", self.encoding, [b"original"])
        original = Path(database.get_worker_by_id(worker)["photo_paths"][0])
        unknown = self.photos / "legacy.jpg"
        unknown.write_bytes(b"unknown")
        with mock.patch.object(database, "add_worker", side_effect=RuntimeError("commit failed")):
            with self.assertRaises(RuntimeError):
                database.publish_local_enrollment("Alex", self.encoding, [b"new"])
        self.assertEqual(set(self.photos.iterdir()), {original, unknown})
        self.assertEqual(original.read_bytes(), b"original")

    def test_directory_write_failure_never_publishes_worker_reference(self):
        self.photos.mkdir()
        with mock.patch.object(database, "_fsync_directory", side_effect=OSError("directory fsync")):
            with self.assertRaises(OSError):
                database.publish_local_enrollment("Alex", self.encoding, [b"photo"])
        self.assertEqual(database.get_all_workers(), [])
        database.recover_photo_cleanup()
        self.assertEqual(list(self.photos.iterdir()), [])

    def test_cleanup_waits_until_synced_publication_commits(self):
        publishing = threading.Event()
        release = threading.Event()
        cleaned = threading.Event()
        failures = []
        original_add = database.add_worker

        def delayed_add(*args, **kwargs):
            publishing.set()
            if not release.wait(5):
                raise RuntimeError("publication barrier timeout")
            return original_add(*args, **kwargs)

        def publish():
            try:
                database.publish_synced_worker("Alex", self.encoding, [b"synced"],
                    enrolled_at=None, server_id="server-alex", employee_id=None)
            except BaseException as exc:
                failures.append(exc)
            finally:
                self.close_connection()

        def cleanup():
            try:
                database.recover_photo_cleanup()
                cleaned.set()
            except BaseException as exc:
                failures.append(exc)
            finally:
                self.close_connection()

        with mock.patch.object(database, "add_worker", side_effect=delayed_add):
            author = threading.Thread(target=publish)
            cleaner = threading.Thread(target=cleanup)
            author.start()
            try:
                self.assertTrue(publishing.wait(5))
                cleaner.start()
                self.assertFalse(cleaned.wait(0.1))
            finally:
                release.set()
                author.join(5)
                if cleaner.ident:
                    cleaner.join(5)
        self.assertFalse(author.is_alive())
        self.assertFalse(cleaner.is_alive())
        self.assertEqual(failures, [])
        worker = database.get_worker_by_name("Alex")
        self.assertEqual(Path(worker["photo_paths"][0]).read_bytes(), b"synced")

    def test_journaled_symlink_cannot_delete_another_photo(self):
        self.photos.mkdir()
        target = self.photos / "unknown.jpg"
        target.write_bytes(b"preserve")
        link = self.photos / "interrupted.jpg"
        link.symlink_to(target)
        database.record_photo_cleanup([link], "published")
        with self.assertRaisesRegex(ValueError, "symlink"):
            database.recover_photo_cleanup()
        self.assertEqual(target.read_bytes(), b"preserve")
        self.assertTrue(link.is_symlink())


if __name__ == "__main__":
    unittest.main()
