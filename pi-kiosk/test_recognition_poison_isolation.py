"""Permanent recognition validation failures must not starve later evidence."""
import unittest
from unittest import mock
from recognition_test_support import SyntheticKioskFixture, database, sync, config

class RecognitionPoisonQA(SyntheticKioskFixture):
    def test_invalid_oldest_record_is_preserved_while_later_valid_rows_drain(self):
        bad = database.log_recognition_attempt(timestamp='2026-02-30T08:00:00', kiosk_id=config.KIOSK_ID,
            face_detected=True, decision='near_miss', threshold=.45)
        for index in range(120):
            database.log_recognition_attempt(timestamp=f'2026-10-01T08:{index//60:02}:{index%60:02}', kiosk_id=config.KIOSK_ID,
                face_detected=True, decision='near_miss', threshold=.45)
        original = dict(database._get_conn().execute('SELECT * FROM recognition_attempts WHERE id=?',(bad,)).fetchone())
        def upload(*args, **kwargs):
            attempts = kwargs['json']['attempts']
            if any(a['timestamp'] == original['timestamp'] for a in attempts):
                body = {'code':'INVALID_RECOGNITION_TIMESTAMP','error':'Recognition timestamp must identify a valid instant'}
                return mock.Mock(status_code=400,json=lambda:body,text='synthetic validation')
            body = {'ingested':len(attempts),'skipped':0}
            return mock.Mock(status_code=201,json=lambda:body,text='synthetic acknowledgement')
        with mock.patch.object(sync.requests,'post',side_effect=upload) as post:
            for _ in range(3): sync.sync_recognition_attempts()
        self.assertLess(post.call_count,32,'isolation must stay bounded')
        after = dict(database._get_conn().execute('SELECT * FROM recognition_attempts WHERE id=?',(bad,)).fetchone())
        self.assertEqual(after['synced'],0,'quarantine retains unaccepted evidence')
        for field in ['timestamp','decision','kiosk_id','candidate_worker_id','threshold','source_attempt_id']:
            self.assertEqual(after[field],original[field])
        good = database._get_conn().execute('SELECT COUNT(*) FROM recognition_attempts WHERE id!=? AND synced=1',(bad,)).fetchone()[0]
        self.assertEqual(good,120,'invalid oldest record cannot starve valid later rows')
        self.assertEqual(database.get_unsynced_recognition_attempts(),[],'quarantined evidence excluded from retry selection')

    def test_auth_conflict_and_server_errors_keep_all_rows_retryable(self):
        for status,code in [(401,'INVALID_RECOGNITION_TIMESTAMP'),(409,'RECOGNITION_ATTEMPT_CONFLICT'),(500,'INVALID_RECOGNITION_TIMESTAMP'),(400,'UNRELATED_ERROR')]:
            with self.subTest(status=status,code=code):
                database._get_conn().execute('DELETE FROM recognition_attempts');database._get_conn().commit()
                database.log_recognition_attempt(timestamp='2026-10-01T08:00:00', kiosk_id=config.KIOSK_ID,
                    face_detected=True,decision='near_miss',threshold=.45)
                body={'code':code,'error':'synthetic transient/conflict'}
                with mock.patch.object(sync.requests,'post',return_value=mock.Mock(status_code=status,json=lambda:body,text='synthetic')):
                    self.assertFalse(sync.sync_recognition_attempts())
                self.assertEqual(len(database.get_unsynced_recognition_attempts()),1)

    def test_partial_success_retains_original_source_identity_for_retry(self):
        row_id=database.log_recognition_attempt(timestamp='2026-10-01T08:00:00',kiosk_id=config.KIOSK_ID,
            face_detected=True,decision='near_miss',threshold=.45)
        original=database.get_unsynced_recognition_attempts()[0]
        with mock.patch.object(sync.requests,'post',return_value=mock.Mock(status_code=201,json=lambda:{'ingested':0,'skipped':0},text='synthetic partial')):
            self.assertFalse(sync.sync_recognition_attempts())
        retry=database.get_unsynced_recognition_attempts()
        self.assertEqual(len(retry),1)
        self.assertEqual(retry[0]['id'],row_id)
        self.assertEqual(retry[0]['source_attempt_id'],original['source_attempt_id'])

    def test_invalid_metric_is_quarantined_without_erasing_source_evidence(self):
        bad=database.log_recognition_attempt(timestamp='2026-10-01T08:00:00',kiosk_id=config.KIOSK_ID,
            face_detected=True,decision='near_miss',threshold=.45,best_score=2.0)
        database.log_recognition_attempt(timestamp='2026-10-01T08:01:00',kiosk_id=config.KIOSK_ID,
            face_detected=True,decision='near_miss',threshold=.45,best_score=.4)
        source=database.get_unsynced_recognition_attempts()[0]['source_attempt_id']
        def upload(*args,**kwargs):
            attempts=kwargs['json']['attempts'];invalid=any(a.get('bestScore')==2.0 for a in attempts)
            body={'code':'INVALID_RECOGNITION_METRIC','error':'Invalid bestScore'} if invalid else {'ingested':len(attempts),'skipped':0}
            return mock.Mock(status_code=400 if invalid else 201,json=lambda:body,text='synthetic')
        with mock.patch.object(sync.requests,'post',side_effect=upload):self.assertTrue(sync.sync_recognition_attempts())
        row=database._get_conn().execute('SELECT synced,best_score,source_attempt_id FROM recognition_attempts WHERE id=?',(bad,)).fetchone()
        self.assertEqual((row['synced'],row['best_score'],row['source_attempt_id']),(0,2.0,source))
        self.assertEqual(database.get_unsynced_recognition_attempts(),[])

    def test_operator_release_preserves_original_row_and_rejection_audit(self):
        import json
        row_id = database.log_recognition_attempt(timestamp='2026-10-01T08:00:00', kiosk_id=config.KIOSK_ID,
            face_detected=True, decision='near_miss', threshold=.45)
        original = dict(database._get_conn().execute('SELECT * FROM recognition_attempts WHERE id=?', (row_id,)).fetchone())
        database.reject_recognition_attempt(row_id, 'synthetic validation reason')
        database.reject_recognition_attempt(row_id, 'duplicate rejection')
        active = database.list_recognition_rejections()
        self.assertEqual(len(active), 1)
        self.assertEqual(json.loads(active[0]['original_attempt_json']), original)
        with self.assertRaises(ValueError):
            database.retry_recognition_rejection(active[0]['id'], ' ')
        self.assertEqual(database.get_unsynced_recognition_attempts(), [])
        database.retry_recognition_rejection(active[0]['id'], 'Restored compatible validator; original evidence retained')
        self.assertEqual(database.list_recognition_rejections(), [])
        retry = database.get_unsynced_recognition_attempts()[0]
        self.assertEqual(retry['source_attempt_id'], original['source_attempt_id'])
        after = dict(database._get_conn().execute('SELECT * FROM recognition_attempts WHERE id=?', (row_id,)).fetchone())
        self.assertEqual(after, original)
        audit = database._get_conn().execute('SELECT * FROM recognition_rejections WHERE id=?', (active[0]['id'],)).fetchone()
        self.assertIsNotNone(audit['released_at'])
        self.assertIn('original evidence retained', audit['release_note'])
        with self.assertRaises(ValueError):
            database.retry_recognition_rejection(active[0]['id'], 'repeat')

if __name__=='__main__': unittest.main()
