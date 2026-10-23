"""Quarantined evidence must be visible separately from retryable queue depth."""
import os
import sys
from pathlib import Path
from unittest import mock
import unittest
root=Path(os.environ.get('GK_CHECKOUT',Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(root/'pi-kiosk'))
from recognition_test_support import SyntheticKioskFixture,database,sync,config

class QuarantineHealthQA(SyntheticKioskFixture):
    def seed(self):
        bad=database.log_recognition_attempt(timestamp='2026-10-01T08:00:00',kiosk_id=config.KIOSK_ID,face_detected=True,decision='near_miss',threshold=.45)
        good=database.log_recognition_attempt(timestamp='2026-10-01T08:01:00',kiosk_id=config.KIOSK_ID,face_detected=True,decision='near_miss',threshold=.45)
        database.reject_recognition_attempt(bad,'synthetic invalid timestamp')
        return bad,good

    def test_retryable_queue_depth_excludes_active_quarantine_and_release_restores_it(self):
        bad,good=self.seed()
        self.assertEqual([r['id'] for r in database.get_unsynced_recognition_attempts()],[good])
        self.assertEqual(database.count_unsynced_recognition_attempts(),1,'retryable health must agree with upload selection')
        rejection=database.list_recognition_rejections()[0]
        self.assertEqual(len(database.list_recognition_rejections()),1)
        database.retry_recognition_rejection(rejection['id'],'synthetic reviewed repair')
        self.assertEqual(database.count_unsynced_recognition_attempts(),2)
        self.assertEqual(database.list_recognition_rejections(),[])
        self.assertEqual(database._get_conn().execute('SELECT synced FROM recognition_attempts WHERE id=?',(bad,)).fetchone()[0],0)

    def test_actual_sync_loop_reports_retryable_and_quarantined_attempts_separately(self):
        self.seed();reports=[];published=[]
        worker=sync.SyncWorker(health_provider=lambda:{'camera_ok':True},health_reporter=lambda **fields:reports.append(fields));worker._running=True
        def roster(*,health):
            published.append(health);worker._running=False;return False
        with mock.patch.object(sync,'check_server',return_value=True),mock.patch.object(sync,'sync_workers',side_effect=roster),mock.patch.object(sync,'sync_attendance',return_value=True),mock.patch.object(sync,'sync_recognition_attempts',return_value=True):
            worker._run()
        self.assertEqual(published[0]['queued_attempts'],1,'manager health must not describe a quarantined row as uploading')
        queue_reports=[fields for fields in reports if 'queued_attempts' in fields]
        self.assertTrue(queue_reports)
        for fields in queue_reports:
            self.assertEqual(fields['queued_attempts'],1)
            self.assertEqual(fields.get('rejected_attempts'),1)

if __name__=='__main__':unittest.main()
