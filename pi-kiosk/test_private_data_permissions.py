"""Private kiosk storage and sync logging; no camera or live server required."""
import argparse
import ast
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

import config
import database
import sync


class PrivateDataPermissionsTests(unittest.TestCase):
    def setUp(self):
        self.original_umask = os.umask(0o022)
        self.addCleanup(os.umask, self.original_umask)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "data"
        self.db = self.data / "attendance.db"
        for name, value in {
            "DATA_DIR": str(self.data), "DB_PATH": str(self.db),
            "FACES_DIR": str(self.data / "faces"),
            "PHOTO_DIR": str(self.data / "faces"),
            "MODEL_DIR": str(self.data / "models"),
            "KIOSK_API_KEY": "synthetic-key",
        }.items():
            patcher = mock.patch.object(config, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.close_db()
        self.addCleanup(self.close_db)

    @staticmethod
    def close_db():
        conn = getattr(database._local, "conn", None)
        if conn is not None:
            conn.close()
        database._local.conn = None

    def assert_mode(self, path, mode):
        self.assertEqual(stat.S_IMODE(Path(path).stat().st_mode), mode, str(path))

    def assert_database_modes(self):
        self.assert_mode(self.data, 0o700)
        for suffix in ("", "-wal", "-shm"):
            self.assert_mode(str(self.db) + suffix, 0o600)

    def test_new_database_and_recreated_wal_and_shm_are_private(self):
        database.init_db()
        self.assert_database_modes()
        # Closing the last connection deletes sidecars; reopening creates them
        # again with the DB's private mode and the process's restrictive umask.
        self.close_db()
        self.assertFalse(Path(str(self.db) + "-wal").exists())
        database.init_db()
        self.assert_database_modes()
        self.assertEqual(os.umask(0o077), 0o077)

    def test_existing_database_wal_shm_and_parent_are_tightened(self):
        database.init_db()
        database.set_sync_state("synthetic", "preserved")
        # Retain real WAL/SHM files while reopening the kiosk connection.
        keeper = sqlite3.connect(self.db)
        self.addCleanup(keeper.close)
        keeper.execute("SELECT * FROM sync_state").fetchall()
        self.close_db()
        os.umask(0o022)
        self.data.chmod(0o755)
        for suffix in ("", "-wal", "-shm"):
            Path(str(self.db) + suffix).chmod(0o644)
        database.init_db()
        self.assert_database_modes()
        self.assertEqual(database.get_sync_state("synthetic"), "preserved")

    def test_startup_creates_and_tightens_data_directories(self):
        # Execute the real startup through DB initialization, without importing
        # camera/model hardware. Existing tests also isolate main.py via AST.
        source = ast.parse(Path(__file__).with_name("main.py").read_text())
        run = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                   and node.name == "run")
        namespace = {
            "config": config, "os": os, "database": database,
            "require_kiosk_api_key": mock.Mock(),
            "require_kiosk_ui_key": mock.Mock(),
        }
        exec(compile(ast.Module(body=[run], type_ignores=[]), "main.py", "exec"), namespace)
        for existing in (False, True):
            with self.subTest(existing=existing):
                os.umask(0o022)
                if existing:
                    for directory in (config.DATA_DIR, config.FACES_DIR, config.MODEL_DIR):
                        Path(directory).chmod(0o755)
                with mock.patch.object(database, "init_db", side_effect=RuntimeError("startup reached DB")):
                    with self.assertRaisesRegex(RuntimeError, "startup reached DB"):
                        namespace["run"](argparse.Namespace(server=None, kiosk_id=None))
                for directory in (config.DATA_DIR, config.FACES_DIR, config.MODEL_DIR):
                    self.assert_mode(directory, 0o700)

    def test_synced_photo_is_private_while_staged_and_after_publication(self):
        database.init_db()
        Path(config.PHOTO_DIR).mkdir(mode=0o755)
        Path(config.PHOTO_DIR).chmod(0o755)
        os.umask(0o022)  # Explicit file mode must also work outside systemd.
        row = {"id": "synthetic-id", "name": "Synthetic worker", "active": True,
               "face_encoding": [0.5] * 512, "photo_url": "https://photo.invalid/private"}
        roster = mock.Mock(status_code=200, json=lambda: {"workers": [row]})
        photo = mock.Mock(status_code=200, content=b"synthetic-photo")
        real_fsync = os.fsync

        def check_staged_file(fd):
            self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode), 0o600)
            real_fsync(fd)

        with mock.patch.object(sync.requests, "get", side_effect=[roster, photo]), \
             mock.patch.object(sync.os, "fsync", side_effect=check_staged_file) as fsync:
            self.assertTrue(sync.sync_workers())
        fsync.assert_called_once()
        self.assert_mode(config.PHOTO_DIR, 0o700)
        files = list(Path(config.PHOTO_DIR).iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].suffix, ".jpg")
        self.assert_mode(files[0], 0o600)
        self.assertEqual(files[0].read_bytes(), photo.content)

    def test_failed_photo_fsync_removes_staged_file(self):
        database.init_db()
        with mock.patch.object(sync.requests, "get", return_value=mock.Mock(status_code=200, content=b"photo")), \
             mock.patch.object(sync.os, "fsync", side_effect=OSError("interrupted")):
            self.assertIsNone(sync._download_photo("synthetic-id", "https://photo.invalid"))
        self.assertEqual(list(Path(config.PHOTO_DIR).iterdir()), [])

    def test_skipped_sync_row_logs_only_its_position(self):
        database.init_db()
        row = {"id": "synthetic-id", "active": True,
               "face_encoding": [0.123456789] * 512,
               "photo_url": "https://photo.invalid/private-token"}
        response = mock.Mock(status_code=200, json=lambda: {"workers": [row]})
        with mock.patch.object(sync.requests, "get", return_value=response), self.assertLogs("sync") as logs:
            self.assertTrue(sync.sync_workers())
        output = "\n".join(logs.output)
        self.assertIn("row=0", output)
        for sensitive in ("0.123456789", "face_encoding", row["photo_url"], "photo_url"):
            self.assertNotIn(sensitive, output)

    def test_invalid_encoding_and_download_errors_do_not_log_sensitive_values(self):
        database.init_db()
        row = {"id": "synthetic-id", "name": "Synthetic worker", "active": True,
               "face_encoding": ["private-encoding-sentinel"]}
        response = mock.Mock(status_code=200, json=lambda: {"workers": [row]})
        with mock.patch.object(sync.requests, "get", return_value=response), self.assertLogs("sync") as logs:
            self.assertFalse(sync.sync_workers())
        self.assertNotIn("private-encoding-sentinel", "\n".join(logs.output))
        url = "https://photo.invalid/private-token"
        with mock.patch.object(sync.requests, "get", side_effect=sync.requests.RequestException(url)), \
             self.assertLogs("sync") as logs:
            self.assertIsNone(sync._download_photo("synthetic-id", url))
        self.assertIn("error=RequestException", "\n".join(logs.output))
        self.assertNotIn(url, "\n".join(logs.output))

    def test_malformed_worker_identifier_cannot_log_nested_sensitive_fields(self):
        database.init_db()
        # Legacy responses also need type validation before an identifier can
        # be interpolated into a log or converted to a stored server id.
        private = {"face_encoding": ["private-encoding-sentinel"],
                   "photo_url": "https://photo.invalid/private-token",
                   "token": "private-auth-sentinel"}
        for identifier, name in ((identifier, name)
                                 for identifier in (private, [private], 42, 1.5, True)
                                 for name in (None, "Synthetic worker")):
            with self.subTest(identifier=identifier, name=name):
                row = {"id": identifier, "name": name, "active": True,
                       "face_encoding": [0.5] * 512}
                response = mock.Mock(status_code=200, json=lambda: {"workers": [row]})
                with mock.patch.object(sync.requests, "get", return_value=response), \
                     self.assertLogs("sync") as logs:
                    self.assertFalse(sync.sync_workers())
                output = "\n".join(logs.output)
                self.assertIn("error=ValueError", output)
                for sensitive in ("face_encoding", "photo_url", "private-encoding-sentinel",
                                  private["photo_url"], private["token"]):
                    self.assertNotIn(sensitive, output)
                self.assertEqual(database.get_all_workers(), [])
                self.assertIsNone(database.get_sync_state("last_worker_sync"))

    def test_setup_unit_and_existing_install_permissions(self):
        source = Path(__file__).with_name("setup.sh").read_text()
        unit = source.split("cat > /etc/systemd/system/fw-gatekeeper-kiosk.service << EOF\n", 1)[1].split("\nEOF", 1)[0]
        service = unit.split("[Service]\n", 1)[1].split("[Install]", 1)[0]
        self.assertIn("\nUMask=0077\n", "\n" + service)
        self.assertIn("User=$KIOSK_USER", service)
        command = source.split('# Tighten pre-upgrade databases, sidecars, photos and directories too.\n', 1)[1].split('\n# Disable console', 1)[0]
        self.assertIn(command, source)
        self.assertLess(source.index('chown -R "$KIOSK_USER:$KIOSK_USER" "$INSTALL_DIR"'), source.index(command))
        directory = self.root / "pi-kiosk/data/faces"
        directory.mkdir(parents=True)
        photo = directory / "existing.jpg"
        photo.write_bytes(b"synthetic-photo")
        for path in (directory.parent, directory):
            path.chmod(0o755)
        photo.chmod(0o644)
        # Run only the actual permission command against a synthetic install.
        subprocess.run(["bash", "-c", command], env=os.environ | {"INSTALL_DIR": str(self.root)}, check=True)
        self.assert_mode(directory.parent, 0o700)
        self.assert_mode(directory, 0o700)
        self.assert_mode(photo, 0o600)
        subprocess.run(["bash", "-c", command], env=os.environ | {"INSTALL_DIR": str(self.root)}, check=True)
        self.assert_mode(photo, 0o600)

    def test_setup_refuses_symlinked_data_root_and_skips_nested_symlinks(self):
        source = Path(__file__).with_name('setup.sh').read_text()
        command = source.split('# Tighten pre-upgrade databases, sidecars, photos and directories too.\n', 1)[1].split('\n# Disable console', 1)[0]
        outside = self.root / 'outside'
        outside.mkdir(mode=0o755)
        photo = outside / 'photo.jpg'
        photo.write_bytes(b'outside-photo')
        photo.chmod(0o644)
        install = self.root / 'install'
        (install / 'pi-kiosk').mkdir(parents=True)
        data = install / 'pi-kiosk/data'
        data.symlink_to(outside, target_is_directory=True)
        result = subprocess.run(['bash', '-c', command], env=os.environ | {'INSTALL_DIR': str(install)},
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('symlinked data directory', result.stdout)
        self.assert_mode(outside, 0o755)
        self.assert_mode(photo, 0o644)
        data.unlink()
        data.mkdir(mode=0o755)
        (data / 'linked-directory').symlink_to(outside, target_is_directory=True)
        (data / 'linked-file').symlink_to(photo)
        subprocess.run(['bash', '-c', command], env=os.environ | {'INSTALL_DIR': str(install)}, check=True)
        self.assert_mode(data, 0o700)
        self.assert_mode(outside, 0o755)
        self.assert_mode(photo, 0o644)

    def test_legacy_string_id_formats_keep_their_identity(self):
        database.init_db()
        for identifier in ('k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r',
                           '104fa9e8-4a1e-4f1d-9cbc-3d933cb47422',
                           '104FA9E8-4A1E-4F1D-9CBC-3D933CB47422', '42', 'legacy-id'):
            with self.subTest(identifier=identifier):
                row = {'id': identifier, 'name': 'Synthetic worker', 'active': True,
                       'face_encoding': [0.5] * 128, 'photo_url': None}
                response = mock.Mock(status_code=200, json=lambda: {'workers': [row]})
                with mock.patch.object(sync.requests, 'get', return_value=response):
                    self.assertTrue(sync.sync_workers())
                self.assertIn(identifier, database.get_synced_server_ids())
                # Legacy explicit deactivations must use the exact same ID.
                row['active'] = False
                with mock.patch.object(sync.requests, 'get', return_value=response):
                    self.assertTrue(sync.sync_workers())
                self.assertNotIn(identifier, database.get_synced_server_ids())

    def test_string_identifiers_cannot_expose_private_data_in_logs(self):
        database.init_db()
        private = 'https://photo.invalid/private-token?face_encoding=private-encoding'
        for identifier, name in ((private, None), (private, 'Synthetic worker'),
                                 ('synthetic-id', private), ('../' + private, 'Synthetic worker')):
            with self.subTest(identifier=identifier, name=name):
                row = {'id': identifier, 'name': name, 'active': True,
                       'face_encoding': [0.5] * 512, 'photo_url': None}
                response = mock.Mock(status_code=200, json=lambda: {'workers': [row]})
                with mock.patch.object(sync.requests, 'get', return_value=response), \
                     self.assertLogs(level='INFO') as logs:
                    sync.sync_workers()
                output = '\n'.join(logs.output)
                for sensitive in ('photo.invalid', 'private-token', 'private-encoding', 'face_encoding'):
                    self.assertNotIn(sensitive, output)


if __name__ == "__main__":
    unittest.main()
