"""Exercise UI bind failures and shutdown with real sockets and SQLite."""

import configparser
import socket
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


KIOSK_DIR = Path(__file__).resolve().parent

# Run the real entry point without camera hardware or model downloads. Each
# process owns its SQLite connections and web threads, just like a restart.
RUN_KIOSK = textwrap.dedent("""
    import socket, sys, time, types
    from pathlib import Path
    from urllib.request import urlopen
    import numpy as np

    sys.path.insert(0, sys.argv[1])
    sys.modules['face_recognition'] = types.SimpleNamespace(face_locations=lambda *a, **k: [])
    sys.modules['liveness'] = types.SimpleNamespace(LivenessChecker=None)
    import main

    root, port, mode = Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    main.config.DATA_DIR = root
    main.config.FACES_DIR = root / 'faces'
    main.config.MODEL_DIR = root / 'models'
    main.config.DB_PATH = root / 'queue.db'
    main.config.KIOSK_PORT = port
    main.config.KIOSK_API_KEY = ''
    main.config.KIOSK_UI_KEY = 'synthetic-ui-key'
    main.config.LIVENESS_REQUIRED = False
    main.recognition_model_ready = lambda: True
    main.database.init_db()
    if not main.database.count_unsynced_logs():
        main.database.log_attendance(1, 'Synthetic worker', 'clock_in')

    server = []
    if mode != 'start':
        original_serve = main.web_app._KioskServer.serve_forever
        def serve(instance):
            server.append(instance)
            original_serve(instance, poll_interval=0.01)
        main.web_app._KioskServer.serve_forever = serve

    def stop_server():
        while not server:
            time.sleep(0.01)
        server[0].shutdown()
        main.web_app._server_thread.join(timeout=2)
        assert not main.web_app._server_thread.is_alive()

    class Camera:
        def __init__(self, **kwargs):
            pass
        def start(self):
            print('CAMERA_STARTED', flush=True)
            if mode == 'start':
                with urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as response:
                    assert response.status == 200
                raise SystemExit(0)
            if mode == 'camera_retry':
                stop_server()
                raise RuntimeError('Synthetic camera unavailable')
        def capture(self):
            # Kill the UI during an automatic attendance transaction. The
            # scanner must finish its commit before detecting the failure.
            conn = main.database._get_conn()
            class Connection:
                def __getattr__(self, name):
                    return getattr(conn, name)
                def __enter__(self):
                    conn.__enter__()
                    return self
                def __exit__(self, kind, value, traceback):
                    if kind is None:
                        self.commit()
                    else:
                        conn.rollback()
                    return False
                def commit(self):
                    stop_server()
                    conn.commit()
                    print('ATTENDANCE_COMMITTED', flush=True)
            main.database._local.conn = Connection()
            main.database.log_attendance(1, 'Synthetic worker', 'clock_out')
            main.database._local.conn = conn
            return np.zeros((8, 8, 3), dtype=np.uint8), np.zeros((8, 8, 3), dtype=np.uint8)
        def stop(self):
            pass
    main.Camera = Camera
    if mode == 'initialization_failure':
        def fail_recognizer():
            while not server:
                time.sleep(0.01)
            # Keep a real MJPEG request alive when recognizer setup raises.
            # Non-daemon request workers otherwise strand the kiosk process.
            main.web_app.set_frame(np.zeros((8, 8, 3), dtype=np.uint8))
            client = socket.create_connection(server[0].server_address, timeout=2)
            client.sendall(b'GET /feed HTTP/1.1\\r\\nHost: localhost\\r\\nX-Kiosk-UI-Key: synthetic-ui-key\\r\\n\\r\\n')
            assert b'200' in client.recv(4096)
            clients.append(client)
            raise RuntimeError('Synthetic recognizer initialization failed')
        clients = []
        main.FaceRecognizer = fail_recognizer
    original_sleep = time.sleep
    main.time.sleep = lambda seconds: original_sleep(min(seconds, 0.01))
    main.run(types.SimpleNamespace(server=None, kiosk_id=None, camera='auto'))
""")


class WebServerProcessTests(unittest.TestCase):
    def run_kiosk(self, root, port, mode):
        return subprocess.run(
            [sys.executable, '-c', RUN_KIOSK, str(KIOSK_DIR), root, str(port), mode],
            capture_output=True, text=True, timeout=10,
        )

    def queued_actions(self, root):
        import sqlite3
        with sqlite3.connect(str(Path(root) / 'queue.db')) as conn:
            return conn.execute('SELECT action, synced FROM attendance_log ORDER BY id').fetchall()

    def test_occupied_port_exits_before_scanning_and_restart_recovers_queue(self):
        with tempfile.TemporaryDirectory() as root, socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            failed = self.run_kiosk(root, port, 'start')
            self.assertEqual(failed.returncode, 1, failed.stderr)
            self.assertIn('Address already in use', failed.stderr)
            self.assertNotIn('CAMERA_STARTED', failed.stdout)
            self.assertEqual(self.queued_actions(root), [('clock_in', 0)])

            occupied.close()
            restarted = self.run_kiosk(root, port, 'start')
            self.assertEqual(restarted.returncode, 0, restarted.stderr)
            self.assertIn('CAMERA_STARTED', restarted.stdout)
            self.assertEqual(self.queued_actions(root), [('clock_in', 0)])

    def test_server_death_exits_during_camera_retry_and_scanning(self):
        for mode in ('camera_retry', 'scanning'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                failed = self.run_kiosk(root, 0, mode)
                self.assertEqual(failed.returncode, 1, failed.stderr)
                self.assertIn('Kiosk web server stopped', failed.stderr)
                expected = [('clock_in', 0)]
                if mode == 'scanning':
                    self.assertIn('ATTENDANCE_COMMITTED', failed.stdout)
                    expected.append(('clock_out', 0))
                self.assertEqual(self.queued_actions(root), expected)

    def test_initialization_failure_closes_live_feed_before_process_exit(self):
        with tempfile.TemporaryDirectory() as root:
            failed = self.run_kiosk(root, 0, 'initialization_failure')
            self.assertEqual(failed.returncode, 1, failed.stderr)
            self.assertIn('Synthetic recognizer initialization failed', failed.stderr)
            self.assertEqual(self.queued_actions(root), [('clock_in', 0)])

    def test_systemd_retries_indefinitely_with_backoff(self):
        setup = (KIOSK_DIR / 'setup.sh').read_text()
        unit = setup.split('cat > /etc/systemd/system/fw-gatekeeper-kiosk.service << EOF\n', 1)[1]
        unit = unit.split('\nEOF', 1)[0]
        parser = configparser.ConfigParser(interpolation=None)
        parser.read_string(unit)
        self.assertEqual(parser['Unit']['StartLimitIntervalSec'], '0')
        self.assertIn(parser['Service']['Restart'], ('always', 'on-failure'))
        self.assertGreaterEqual(int(parser['Service']['RestartSec']), 5)


class WebServerDrainTests(unittest.TestCase):
    def test_shutdown_drains_idle_requests_and_blocked_feed_writes(self):
        import threading
        from unittest import mock
        from werkzeug.serving import WSGIRequestHandler
        import app
        import config

        for mode in ('idle_request', 'blocked_feed'):
            with self.subTest(mode=mode):
                entered = threading.Event()

                class Handler(WSGIRequestHandler):
                    def handle(self):
                        if mode == 'idle_request':
                            entered.set()
                        return super().handle()

                def blocked_feed():
                    entered.set()
                    yield b'--frame\r\n' + b'x' * (8 * 1024 * 1024)

                server = app._KioskServer('127.0.0.1', 0, app.app, handler=Handler)
                server.request_timeout = 0.25
                original_get_request = server.get_request

                def get_request():
                    connection, address = original_get_request()
                    connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
                    return connection, address

                server.get_request = get_request
                client = socket.socket()
                client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
                with mock.patch.object(config, 'KIOSK_UI_KEY', 'synthetic-ui-key', create=True), \
                        mock.patch.object(app, '_KioskServer', return_value=server), \
                        mock.patch.object(app, '_mjpeg_stream', side_effect=blocked_feed):
                    web_thread = app.start_server()
                    try:
                        client.connect(server.server_address)
                        if mode == 'idle_request':
                            client.sendall(b'GET /health HTTP/1.1\r\nHost: localhost\r\n')
                        else:
                            client.sendall(
                                b'GET /feed HTTP/1.1\r\nHost: localhost\r\n'
                                b'X-Kiosk-UI-Key: synthetic-ui-key\r\n\r\n'
                            )
                        self.assertTrue(entered.wait(3))
                        server.shutdown()
                        web_thread.join(timeout=2)
                        self.assertFalse(web_thread.is_alive(), 'Client prevented web shutdown')
                    finally:
                        client.close()
                        server.shutdown()
                        web_thread.join(timeout=3)

    def test_shutdown_finishes_manual_write_and_closes_feed(self):
        import threading
        from unittest import mock
        from urllib.request import Request, urlopen
        import numpy as np
        import app
        import config
        import database
        from kiosk_ui_auth import KIOSK_SUPERVISOR_SESSION_COOKIE, supervisor_session_token

        with tempfile.TemporaryDirectory() as root, mock.patch.multiple(
            config, DB_PATH=str(Path(root) / 'queue.db'), KIOSK_PORT=0,
            KIOSK_UI_KEY='synthetic-ui-key', KIOSK_SUPERVISOR_PIN='synthetic-pin',
            create=True,
        ):
            database._local.conn = None
            database.init_db()
            worker_id = database.add_worker('Synthetic worker', np.ones(512))
            entered, finish = threading.Event(), threading.Event()
            original_get_conn = database._get_conn
            responses = []
            failures = []
            server = app._KioskServer('127.0.0.1', 0, app.app)
            server.request_timeout = 0.05
            url = f'http://127.0.0.1:{server.server_port}'

            def get_conn():
                conn = original_get_conn()
                class Connection:
                    def __getattr__(self, name):
                        return getattr(conn, name)
                    def __enter__(self):
                        conn.__enter__()
                        return self
                    def __exit__(self, kind, value, traceback):
                        if kind is None:
                            self.commit()
                        else:
                            conn.rollback()
                        return False
                    def commit(self):
                        entered.set()
                        if not finish.wait(5):
                            raise RuntimeError('Test did not release attendance commit')
                        conn.commit()
                return Connection()

            def manual_clock():
                try:
                    request = Request(url + '/manual-clock', data=(
                        '{"worker_id":%d,"action":"clock_in"}' % worker_id
                    ).encode(), headers={
                        'Content-Type': 'application/json',
                        'X-Kiosk-UI-Key': config.KIOSK_UI_KEY,
                        'Cookie': f'{KIOSK_SUPERVISOR_SESSION_COOKIE}={supervisor_session_token()}',
                    })
                    with urlopen(request, timeout=5) as response:
                        responses.append(response.read())
                except Exception as exc:
                    failures.append(exc)

            with mock.patch.object(app, '_KioskServer', return_value=server):
                web_thread = app.start_server()
            app.set_frame(np.zeros((8, 8, 3), dtype=np.uint8))
            request = Request(url + '/feed', headers={'X-Kiosk-UI-Key': config.KIOSK_UI_KEY})
            feed = urlopen(request, timeout=5)
            caller = threading.Thread(target=manual_clock)
            stopper = threading.Thread(target=server.shutdown)
            try:
                with mock.patch.object(database, '_get_conn', side_effect=get_conn):
                    caller.start()
                    self.assertTrue(entered.wait(3), failures)
                    stopper.start()
                    self.assertTrue(app._server_stopped.wait(3))
                    # The web thread is draining the request, rather than
                    # abandoning its uncommitted SQLite transaction.
                    self.assertTrue(web_thread.is_alive())
                    with self.assertRaisesRegex(RuntimeError, 'Kiosk web server stopped'):
                        app.check_server()
                    # A commit longer than the socket inactivity timeout must
                    # still finish; the timeout only bounds network I/O.
                    self.assertFalse(finish.wait(0.1))
                    finish.set()
                    caller.join(timeout=3)
                    web_thread.join(timeout=3)
                self.assertFalse(web_thread.is_alive())
                self.assertFalse(caller.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(len(responses), 1)
                self.assertIn(b'"success":true', responses[0])
                self.assertEqual(database.count_unsynced_logs(), 1)
                self.assertIn(b'--frame', feed.read())
            finally:
                finish.set()
                feed.close()
                server.shutdown()
                if caller.ident:
                    caller.join(timeout=5)
                if stopper.ident:
                    stopper.join(timeout=5)
                web_thread.join(timeout=5)
                database._local.conn.close()
                database._local.conn = None


if __name__ == '__main__':
    unittest.main()
