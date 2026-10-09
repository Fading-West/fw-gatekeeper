"""Synthetic isolated kiosk regression; no camera, service or live database."""
import sys, tempfile, unittest
from pathlib import Path
from unittest import mock
import numpy as np
import config, database

class Fixture(unittest.TestCase):
 def setUp(self):
  temp = tempfile.TemporaryDirectory(prefix='gatekeeper-regression-')
  self.addCleanup(temp.cleanup)
  for name, value in {'DB_PATH': str(Path(temp.name)/'synthetic.db'), 'PHOTO_DIR': str(Path(temp.name)/'photos')}.items():
   p=mock.patch.object(config,name,value,create=True); p.start(); self.addCleanup(p.stop)
  database._local.conn=None
  self.addCleanup(self.close)
  database.init_db()
  self.worker=database.add_worker('Synthetic worker', np.ones(512), server_id='synthetic-server-id')
 def close(self):
  if database._local.conn is not None: database._local.conn.close()
  database._local.conn=None
class GuardTests(Fixture):
 def record(self):
  return database.log_recognized_attendance(worker_id=self.worker, server_worker_id='synthetic-server-id', expected_encoding=np.ones(512), worker_name='Synthetic worker', action='clock_in')
 def test_removed_worker_cannot_record_from_in_flight_result(self):
  database.log_attendance(self.worker,'Synthetic worker','clock_in')
  database.remove_worker_by_server_id("synthetic-server-id")
  with self.assertRaisesRegex(ValueError,'enrollment changed'): self.record()
  self.assertEqual(len(database.get_unsynced_logs()),1)
 def test_replaced_template_and_server_identity_cannot_record(self):
  conn=database._get_conn()
  conn.execute('UPDATE workers SET encoding_blob=? WHERE id=?',(np.zeros(512,dtype=np.float64).tobytes(),self.worker)); conn.commit()
  with self.assertRaisesRegex(ValueError,'enrollment changed'): self.record()
  self.assertEqual(database.count_unsynced_logs(),0)
 def test_current_template_records_once(self):
  self.record()
  self.assertEqual(database.count_unsynced_logs(),1)
if __name__=='__main__': unittest.main()
