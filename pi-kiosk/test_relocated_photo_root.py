"""Real SQLite/filesystem coverage for a supported relocated kiosk data root."""
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np

import config
import database


class RelocatedPhotoRootTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "install" / "data"
        self.data.mkdir(parents=True)
        self.photos = self.data / "faces"
        self.relocated = self.root / "owned-external-data"
        for name, value in (("DB_PATH", str(self.data / "kiosk.db")),
                            ("PHOTO_DIR", str(self.photos))):
            patcher = mock.patch.object(config, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        database._local.conn = None
        self.addCleanup(self.close_connection)
        database.init_db()
        self.encoding = np.ones(512)

    @staticmethod
    def close_connection():
        conn = getattr(database._local, "conn", None)
        if conn is not None:
            conn.close()
            database._local.conn = None

    def publish(self, name="Alex", photo=b"original", server_id="server-alex"):
        return database.publish_synced_worker(name, self.encoding, [photo],
            enrolled_at=None, server_id=server_id, employee_id=server_id)

    def photo(self, worker_id):
        return Path(database.get_worker_by_id(worker_id)["photo_paths"][0])

    def relocate(self):
        self.close_connection()
        self.data.rename(self.relocated)
        self.data.symlink_to(self.relocated, target_is_directory=True)

    def test_reenrollment_retires_the_old_photo_after_data_root_relocation(self):
        worker = self.publish()
        original = self.photo(worker)
        self.relocate()
        self.assertEqual(self.publish("Alex renamed", b"replacement"), worker)
        self.assertEqual(database.get_worker_by_id(worker)["name"], "Alex renamed")
        self.assertEqual(self.photo(worker).read_bytes(), b"replacement")
        self.assertFalse(original.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_deactivation_removes_owned_photos_after_data_root_relocation(self):
        worker = self.publish()
        original = self.photo(worker)
        self.relocate()
        self.assertTrue(database.remove_worker_by_server_id("server-alex", strict_cleanup=True))
        self.assertIsNone(database.get_worker_by_id(worker))
        self.assertFalse(original.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_interrupted_publication_recovery_handles_pre_relocation_paths(self):
        self.photos.mkdir()
        orphan = self.photos / "interrupted.jpg"
        orphan.write_bytes(b"uncommitted")
        database.record_photo_cleanup([orphan], "published")
        self.relocate()
        database.recover_photo_cleanup()
        self.assertFalse(orphan.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_local_removal_preserves_another_workers_shared_photo(self):
        local = database.publish_local_enrollment("Local", self.encoding, [b"shared"])
        shared = self.photo(local)
        other = database.add_worker("Other", self.encoding, photo_paths=[str(shared)])
        self.relocate()
        self.assertTrue(database.remove_local_worker_owned("Local"))
        self.assertEqual(shared.read_bytes(), b"shared")
        self.assertEqual(self.photo(other).read_bytes(), b"shared")
        self.assertTrue(database.remove_local_worker_owned("Other"))
        self.assertFalse(shared.exists())
        self.assertEqual(database.count_pending_photo_cleanup(), 0)

    def test_relocated_root_does_not_authorize_nested_symlinks_or_external_paths(self):
        self.photos.mkdir()
        inside = self.photos / "keep.jpg"
        inside.write_bytes(b"inside")
        outside = self.root / "unrelated.jpg"
        outside.write_bytes(b"outside")
        self.relocate()
        for destination in (inside.resolve(), outside):
            with self.subTest(destination=destination):
                link = self.photos / "nested.jpg"
                link.symlink_to(destination)
                with self.assertRaises(ValueError):
                    database._owned_photo_path(link, self.photos.resolve())
                database.record_photo_cleanup([link], "published")
                with self.assertRaises(ValueError):
                    database.recover_photo_cleanup()
                self.assertTrue(link.is_symlink())
                link.unlink()
                conn = database._get_conn()
                conn.execute("DELETE FROM photo_cleanup_journal WHERE path = ?", (str(link),))
                conn.commit()
        with self.assertRaises(ValueError):
            database._owned_photo_path(outside, self.photos.resolve())
        nested = self.photos / "nested-directory"
        nested.symlink_to(self.photos.resolve(), target_is_directory=True)
        with self.assertRaises(ValueError):
            database._owned_photo_path(nested / inside.name, self.photos.resolve())
        unconfigured = self.root / "unconfigured-alias"
        unconfigured.symlink_to(self.photos.resolve(), target_is_directory=True)
        with self.assertRaises(ValueError):
            database._owned_photo_path(unconfigured / inside.name, self.photos.resolve())
        self.assertEqual(inside.read_bytes(), b"inside")
        self.assertEqual(outside.read_bytes(), b"outside")


if __name__ == "__main__":
    unittest.main()
