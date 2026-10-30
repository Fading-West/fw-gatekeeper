"""Run the kiosk's actual unlock JavaScript against lockout and dialog races."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest


KIOSK_DIR = Path(__file__).resolve().parent

HARNESS = r"""
const assert = require('node:assert/strict');
let supervisorUnlockPending = false, supervisorLockPending = false, supervisorLockNeeded = false;
let supervisorUnlockGeneration = 0, supervisorStateVersion = 0;
let activeUnlockRequest = null, activeUnlockController = null;
let supervisorBootNonce = 'a'.repeat(32), adminVisible = false;
let statusCalls = 0, logCalls = 0, nextRequest = 0;
const supervisorSubmit = { disabled: false };
const supervisorError = { textContent: '' };
const supervisorPin = { value: '1234', selections: 0, select() { this.selections++; } };
const supervisorDialog = { open: true, close() { this.open = false; } };
const supervisorUnlock = { disabled: false, textContent: 'Supervisor controls (A)' };
globalThis.crypto = { randomUUID: () => `request-${++nextRequest}` };
function setAdminVisible(visible) {
    if (visible !== adminVisible) supervisorStateVersion++;
    adminVisible = visible;
}
function openSupervisorDialog() { supervisorDialog.open = true; }
function fetchStatus() { statusCalls++; }
function fetchLog() { logCalls++; }
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function response(status, body) {
    return { ok: status === 200, status, json: async () => body };
}
function assertDenied(message) {
    assert.equal(supervisorError.textContent, message);
    assert.equal(adminVisible, false);
    assert.equal(supervisorDialog.open, true);
    assert.equal(supervisorUnlockPending, false);
    assert.equal(supervisorSubmit.disabled, false);
    assert.equal(supervisorLockNeeded, false);
    assert.equal(statusCalls, 0);
    assert.equal(logCalls, 0);
}
"""


class SupervisorLockoutFeedbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if cls.node is None:
            raise RuntimeError("Node is required to exercise the kiosk unlock JavaScript")
        template = (KIOSK_DIR / "templates" / "index.html").read_text(encoding="utf-8")
        start = template.index("async function toggleSupervisorControls()")
        end = template.index("// Never let a failing kiosk", start)
        cls.source = template[start:end]

    def run_js(self, scenario):
        script = HARNESS + self.source + r"""
const watchdog = setTimeout(() => {
    console.error('Scenario did not finish (possibly waiting for an unread response body)');
    process.exitCode = 1;
}, 2000);
(async () => {
""" + scenario + r"""
})().then(() => clearTimeout(watchdog), error => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
});
"""
        result = subprocess.run(
            [self.node, "-e", script], capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_lockout_shows_remaining_wait_without_echoing_server_error(self):
        for seconds, unit in [(287, "seconds"), (1, "second")]:
            with self.subTest(seconds=seconds):
                self.run_js(f"""
fetch = async () => response(429, {{
    error: '<private server detail>', retry_after_seconds: {seconds}
}});
await unlockSupervisorControls();
assertDenied('Too many failed attempts. Try again in {seconds} {unit}.');
assert.equal(supervisorPin.selections, 0);
""")

    def test_unusable_retry_interval_still_explains_lockout(self):
        for body in [{}, None, {"retry_after_seconds": "287"},
                     {"retry_after_seconds": -1}, {"retry_after_seconds": 0},
                     {"retry_after_seconds": 1.5},
                     {"retry_after_seconds": 9007199254740992}]:
            with self.subTest(body=body):
                self.run_js("fetch = async () => response(429, " + json.dumps(body) + ");" + """
await unlockSupervisorControls();
assertDenied('Too many failed attempts. Wait before trying again.');
""")

    def test_invalid_json_still_explains_lockout(self):
        self.run_js("""
fetch = async () => ({ ok: false, status: 429, json: async () => { throw new SyntaxError('bad JSON'); } });
await unlockSupervisorControls();
assertDenied('Too many failed attempts. Wait before trying again.');
""")

    def test_other_auth_failures_keep_generic_feedback(self):
        for status in [400, 401, 403]:
            with self.subTest(status=status):
                self.run_js(f"""
fetch = async () => ({{ ok: false, status: {status}, json: () => {{ throw new Error('must not read server detail'); }} }});
await unlockSupervisorControls();
assertDenied('Supervisor authentication failed.');
assert.equal(supervisorPin.selections, 1);
""")

    def test_cancel_before_response_ignores_lockout(self):
        self.run_js("""
const unlockResponse = deferred();
fetch = async url => url === '/supervisor/lock' ? response(200) : unlockResponse.promise;
const unlocking = unlockSupervisorControls();
cancelSupervisorUnlock();
await Promise.resolve();
supervisorError.textContent = 'Canceled';
unlockResponse.resolve({ ok: false, status: 429, json: () => { throw new Error('stale response'); } });
await unlocking;
assert.equal(supervisorDialog.open, false);
assert.equal(supervisorError.textContent, 'Canceled');
assert.equal(adminVisible, false);
""")

    def test_cancel_during_json_read_ignores_late_body(self):
        for lock_confirmed in [False, True]:
            for reject_json in [False, True]:
                with self.subTest(lock_confirmed=lock_confirmed, reject_json=reject_json):
                    self.run_js(f"""
const body = deferred(), reading = deferred(), locking = deferred();
fetch = async url => url === '/supervisor/lock' ? locking.promise : {{
    ok: false, status: 429, json: () => {{ reading.resolve(); return body.promise; }}
}};
const unlocking = unlockSupervisorControls();
await reading.promise;
cancelSupervisorUnlock();
if ({json.dumps(lock_confirmed)}) {{
    locking.resolve(response(200));
    await Promise.resolve();
    await Promise.resolve();
}}
supervisorError.textContent = 'Canceled';
if ({json.dumps(reject_json)}) body.reject(new SyntaxError('late bad JSON'));
else body.resolve({{ retry_after_seconds: 287 }});
await unlocking;
assert.equal(supervisorDialog.open, false);
assert.equal(supervisorError.textContent, 'Canceled');
assert.equal(adminVisible, false);
assert.equal(statusCalls, 0);
assert.equal(logCalls, 0);
locking.resolve(response(200));
""")

    def test_old_body_cannot_overwrite_new_dialog_or_clear_its_pending_request(self):
        self.run_js("""
const body = deferred(), reading = deferred(), nextResponse = deferred();
fetch = async url => url === '/supervisor/lock' ? response(200) : {
    ok: false, status: 429, json: () => { reading.resolve(); return body.promise; }
};
const oldUnlock = unlockSupervisorControls();
await reading.promise;
cancelSupervisorUnlock();
await Promise.resolve();
await Promise.resolve();
await toggleSupervisorControls();
supervisorError.textContent = 'New attempt';
fetch = async () => nextResponse.promise;
const newUnlock = unlockSupervisorControls();
const newController = activeUnlockController;
body.resolve({ retry_after_seconds: 287 });
await oldUnlock;
assert.equal(supervisorError.textContent, 'New attempt');
assert.equal(supervisorDialog.open, true);
assert.equal(supervisorUnlockPending, true);
assert.equal(supervisorSubmit.disabled, true);
assert.equal(activeUnlockController, newController);
nextResponse.resolve(response(401));
await newUnlock;
assertDenied('Supervisor authentication failed.');
""")

    def test_success_still_unlocks_and_refreshes_admin_data(self):
        self.run_js("""
fetch = async () => response(200);
await unlockSupervisorControls();
assert.equal(adminVisible, true);
assert.equal(supervisorDialog.open, false);
assert.equal(statusCalls, 1);
assert.equal(logCalls, 1);
assert.equal(supervisorUnlockPending, false);
assert.equal(supervisorSubmit.disabled, false);
""")


if __name__ == "__main__":
    unittest.main()
