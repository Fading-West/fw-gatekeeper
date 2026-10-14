"""Claim isolation and operator recovery against durable SQLite queues."""
import json
import unittest
from unittest import mock

import test_sync_mapping as mapping
from test_sync_mapping import ENCODING, SERVER_ID
import config
import database
import sync


def denial(status=403, code='KIOSK_CLAIM_MISMATCH'):
    return mock.Mock(status_code=status, text='denied', json=lambda: {'code': code})


class KioskClaimQueueTests(unittest.TestCase):
    setUp = mapping.AttendanceServerIdMappingTests.setUp
    _close_db = staticmethod(mapping.AttendanceServerIdMappingTests._close_db)

    def enqueue(self, claims):
        worker = database.add_worker('Alex', ENCODING, server_id=SERVER_ID)
        for claim in claims:
            with mock.patch.object(config, 'KIOSK_ID', claim):
                database.log_attendance(worker, 'Alex', 'clock_in')
            database.log_recognition_attempt(decision='unknown', kiosk_id=claim)

    def server(self, *args, **kwargs):
        body = kwargs['json']
        rows = body.get('logs', body.get('attempts'))
        claims = {row.get('kiosk_id', row.get('kioskId')) for row in rows}
        self.assertEqual(len(claims), 1, 'every request must have exactly one captured kiosk claim')
        claim = claims.pop()
        self.seen.append((claim, len(rows)))
        if claim not in (config.KIOSK_ID, 'authorized-alias'):
            return denial()
        return mock.Mock(status_code=200, json=lambda: {'acknowledged': len(rows)})

    def streams(self):
        return [
            (sync.sync_attendance, database.count_unsynced_logs, database.count_rejected_logs,
             database.list_attendance_rejections, database.retry_attendance_rejection, 'attendance_log', 'original_log_json'),
            (sync.sync_recognition_attempts, database.count_unsynced_recognition_attempts, database.count_rejected_attempts,
             database.list_recognition_rejections, database.retry_recognition_rejection, 'recognition_attempts', 'original_attempt_json'),
        ]

    def test_new_rows_upload_first_even_beyond_a_cycle_of_historical_rows(self):
        self.enqueue(['old-kiosk'] * 1005 + [config.KIOSK_ID] * 3)
        for upload, count, rejected, listing, retry, table, snapshot in self.streams():
            self.seen = []
            with mock.patch.object(sync.requests, 'post', side_effect=self.server), self.assertLogs(sync.logger, 'ERROR') as logs:
                self.assertFalse(upload())  # quarantined evidence remains counted
            self.assertEqual(self.seen[0], (config.KIOSK_ID, 3))
            self.assertEqual(count(), 1005)
            self.assertEqual(rejected(), 1000)
            self.assertIn('Quarantined', '\n'.join(logs.output))
            conn = database._get_conn()
            self.assertEqual(conn.execute(f'SELECT COUNT(*) FROM {table} WHERE synced = 1').fetchone()[0], 3)
            original = json.loads(listing()[0][snapshot])
            self.assertEqual(original['kiosk_id'], 'old-kiosk')
            self.assertEqual(original['synced'], 0)
            self.seen = []
            with mock.patch.object(sync.requests, 'post', side_effect=self.server):
                self.assertFalse(upload())
            self.assertEqual(self.seen, [('old-kiosk', 5)])
            self.assertEqual(rejected(), 1005)

    def test_multiple_claims_are_grouped_aliases_are_preserved_and_restart_keeps_quarantine(self):
        self.enqueue(['old-a', config.KIOSK_ID, 'authorized-alias', 'old-b', 'old-a'])
        for upload, count, rejected, listing, retry, table, snapshot in self.streams():
            self.seen = []
            with mock.patch.object(sync.requests, 'post', side_effect=self.server):
                self.assertFalse(upload())
            self.assertEqual(self.seen, [(config.KIOSK_ID, 1), ('old-a', 2), ('authorized-alias', 1), ('old-b', 1)])
            self.assertEqual(count(), 3)
            self.assertEqual(rejected(), 3)
            self._close_db()
            database.init_db()
            with mock.patch.object(sync.requests, 'post') as post:
                self.assertFalse(upload())
                post.assert_not_called()
            self.assertEqual(len(listing()), 3)
            if table == 'attendance_log':
                database.log_attendance(1, 'Alex', 'clock_in')
            else:
                database.log_recognition_attempt(decision='unknown')
            self.seen = []
            with mock.patch.object(sync.requests, 'post', side_effect=self.server):
                self.assertFalse(upload())
            self.assertEqual(self.seen, [(config.KIOSK_ID, 1)])
            self.assertEqual(count(), 3)
            self.assertEqual(database._get_conn().execute(f"SELECT kiosk_id FROM {table} WHERE id = 3").fetchone()[0], 'authorized-alias')

    def test_credential_denial_stops_without_quarantining_or_attempting_historical_rows(self):
        self.enqueue(['old-a', config.KIOSK_ID, 'old-b'])
        for upload, count, rejected, *_ in self.streams():
            with mock.patch.object(sync.requests, 'post', return_value=denial(401)) as post:
                self.assertFalse(upload())
            post.assert_called_once()
            self.assertEqual(count(), 3)
            self.assertEqual(rejected(), 0)

    def test_unrecognized_denials_and_old_server_401_retain_history_but_do_not_block_new_rows(self):
        self.enqueue(['old-a'])
        failures = [denial(401), denial(403, 'FORBIDDEN'), denial(400), denial(500),
                    mock.Mock(status_code=403, text='bad JSON', json=mock.Mock(side_effect=ValueError()))]
        for upload, count, rejected, listing, retry, table, snapshot in self.streams():
            for failure in failures:
                if table == 'attendance_log':
                    database.log_attendance(1, 'Alex', 'clock_in')
                else:
                    database.log_recognition_attempt(decision='unknown')
                def server(*args, **kwargs):
                    rows = kwargs['json'].get('logs', kwargs['json'].get('attempts'))
                    if rows[0].get('kiosk_id', rows[0].get('kioskId')) == config.KIOSK_ID:
                        return mock.Mock(status_code=200, json=lambda: {'acknowledged': len(rows)})
                    return failure
                with mock.patch.object(sync.requests, 'post', side_effect=server) as post:
                    self.assertFalse(upload())
                self.assertEqual(post.call_count, 2)
                self.assertEqual(count(), 1)
                self.assertEqual(rejected(), 0)

    def test_operator_retry_keeps_original_claim_and_audit_snapshot(self):
        self.enqueue(['old-kiosk'])
        for upload, count, rejected, listing, retry, table, snapshot in self.streams():
            with mock.patch.object(sync.requests, 'post', return_value=denial()):
                self.assertFalse(upload())
            rejection = listing()[0]
            original = rejection[snapshot]
            self.assertEqual(json.loads(original)['kiosk_id'], 'old-kiosk')
            with self.assertRaises(ValueError):
                retry(rejection['id'], '  ')
            # An authorized operator restores the original kiosk's configuration
            # and credential, rather than changing the captured claim.
            prefix = 'attendance' if table == 'attendance_log' else 'recognition'
            database.set_sync_state(prefix + '_scan_after', '100')
            database.set_sync_state(prefix + '_current_scan_after', '100')
            retry(rejection['id'], 'Verified original kiosk ownership and restored its credential')
            with mock.patch.object(config, 'KIOSK_ID', 'old-kiosk'), mock.patch.object(sync.requests, 'post', return_value=mock.Mock(status_code=200, json=lambda: {'acknowledged': 1})) as post:
                self.assertTrue(upload())
            row = post.call_args.kwargs['json'].get('logs', post.call_args.kwargs['json'].get('attempts'))[0]
            self.assertEqual(row.get('kiosk_id', row.get('kioskId')), 'old-kiosk')
            audit_table = 'attendance_rejections' if table == 'attendance_log' else 'recognition_rejections'
            audit = database._get_conn().execute(f'SELECT * FROM {audit_table} WHERE id = ?', (rejection['id'],)).fetchone()
            self.assertEqual(audit[snapshot], original)
            self.assertTrue(audit['released_at'])
            self.assertIn('Verified original kiosk', audit['release_note'])
            self.assertEqual(count(), 0)
            self.assertEqual(rejected(), 0)

    def test_deleted_recognition_row_keeps_evidence_visible_and_cannot_be_released(self):
        database.log_recognition_attempt(decision='unknown', kiosk_id='old')
        database.reject_recognition_attempt(1, 'KIOSK_CLAIM_MISMATCH')
        conn = database._get_conn()
        conn.execute('DELETE FROM recognition_attempts')
        conn.commit()
        self.assertEqual(database.count_unsynced_recognition_attempts(), 1)
        self.assertEqual(database.count_rejected_attempts(), 1)
        self.assertIn('"kiosk_id": "old"', database.list_recognition_rejections()[0]['original_attempt_json'])
        with self.assertRaisesRegex(ValueError, 'restore the original evidence'):
            database.retry_recognition_rejection(1, 'reviewed')

    def test_roster_and_receipt_credential_denials_stop_before_evidence_uploads(self):
        self.enqueue([config.KIOSK_ID])
        for phase in ('roster', 'receipt'):
            worker = sync.SyncWorker(recognizer=mock.Mock())
            worker._running = True
            database.set_sync_state('roster_pending_receipt', json.dumps({'receipt': 'receipt'}))
            def stop(_):
                worker._running = False
            with mock.patch.object(sync, 'check_server', return_value=True), \
                 mock.patch.object(sync.requests, 'get', return_value=mock.Mock(status_code=401)), \
                 mock.patch.object(sync.requests, 'post', return_value=denial(401)) as post, \
                 mock.patch.object(sync.time, 'sleep', side_effect=stop):
                if phase == 'receipt':
                    with mock.patch.object(sync, 'sync_workers', return_value=True):
                        worker._run()
                    post.assert_called_once()
                    self.assertTrue(post.call_args.args[0].endswith('/api/sync/ack'))
                else:
                    worker._run()
                    post.assert_not_called()
            self.assertEqual(database.count_unsynced_logs(), 1)
            self.assertEqual(database.count_unsynced_recognition_attempts(), 1)

    def test_health_reports_quarantine_without_masking_existing_scanner_fault(self):
        params = sync._health_params({'queued_logs': 3, 'queued_attempts': 4,
                                      'rejected_logs': 1, 'rejected_attempts': 2,
                                      'degraded_reason': 'camera_error'})
        self.assertEqual(params['degraded_reason'], 'camera_error; upload_quarantine: 1 attendance, 2 recognition')
        self.assertEqual(params['queued_logs'], '3')
        self.assertEqual(params['queued_attempts'], '4')
        self.assertNotIn('degraded_reason', sync._health_params({'rejected_logs': 0, 'rejected_attempts': 0}))

    def test_local_health_is_degraded_while_quarantined_evidence_needs_recovery(self):
        import app as web_app
        with mock.patch.dict(web_app._health, {'camera_ok': True, 'model_ok': True,
                                              'degraded_reason': None, 'rejected_logs': 0,
                                              'rejected_attempts': 0}):
            client = web_app.app.test_client()
            self.assertEqual(client.get('/health').get_json()['status'], 'ok')
            for field in ('rejected_logs', 'rejected_attempts'):
                with mock.patch.dict(web_app._health, {field: 1}):
                    health = client.get('/health').get_json()
                    self.assertEqual(health['status'], 'degraded')
                    self.assertEqual(health[field], 1)

    def test_background_cycle_reports_quarantine_and_halts_both_streams_on_401(self):
        self.enqueue(['old', config.KIOSK_ID])
        reporter = mock.Mock()
        worker = sync.SyncWorker(health_reporter=reporter)
        worker._running = True
        def stop(_):
            worker._running = False
        with mock.patch.object(sync, 'check_server', return_value=True), \
             mock.patch.object(sync, 'sync_workers', return_value=True), \
             mock.patch.object(sync.requests, 'post', return_value=denial(401)) as post, \
             mock.patch.object(sync.time, 'sleep', side_effect=stop):
            worker._run()
        post.assert_called_once()
        self.assertEqual(database.count_rejected_logs(), 0)
        self.assertEqual(database.count_rejected_attempts(), 0)
        database.reject_attendance(1, 'KIOSK_CLAIM_MISMATCH')
        database.reject_recognition_attempt(1, 'KIOSK_CLAIM_MISMATCH')
        worker._running = True
        with mock.patch.object(sync, 'check_server', return_value=False), mock.patch.object(sync.time, 'sleep', side_effect=stop):
            worker._run()
        self.assertEqual(reporter.call_args_list[-2].kwargs['rejected_logs'], 1)
        self.assertEqual(reporter.call_args_list[-2].kwargs['rejected_attempts'], 1)


if __name__ == '__main__':
    unittest.main()
