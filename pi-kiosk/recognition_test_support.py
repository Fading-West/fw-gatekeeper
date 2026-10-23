"""Portable test fixture: synthetic local SQLite and credentials only."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import numpy as np
import config
import database
import sync

class SyntheticKioskFixture(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='gatekeeper-recognition-qa-');self.addCleanup(temp.cleanup)
        for name,value in {'DB_PATH':str(Path(temp.name)/'synthetic.db'),'PHOTO_DIR':str(Path(temp.name)/'photos'),
            'KIOSK_API_KEY':'synthetic-upload-key','KIOSK_ID':'synthetic-kiosk'}.items():
            patch=mock.patch.object(config,name,value,create=True);patch.start();self.addCleanup(patch.stop)
        database._local.conn=None;self.addCleanup(self.close_db);database.init_db()
        self.worker_id=database.add_worker('Synthetic Employee',np.ones(512),server_id='a'*32)
    @staticmethod
    def close_db():
        if database._local.conn is not None:database._local.conn.close()
        database._local.conn=None
