# Broken kiosk site imports must stop startup

Base: origin/master `5f85003ad5e9eb40794337d020977f9a1b7929fa` (November 8, 2026).

`config.py` suppressed every ImportError from `from config_local import *`.
An existing site file setting `KIOSK_TYPE = "exit"` and
`LIVENESS_REQUIRED = True`, then importing a missing dependency, therefore
loaded successfully with entry / liveness-disabled defaults. Policy validation
saw those defaults rather than the intended site policy.

Only absence of the optional config_local module is now suppressed. Dependency
ModuleNotFoundError and plain ImportError propagate and prevent startup.
Operators must repair broken site imports before restarting; this intentionally
removes the previous silent fallback. A genuinely absent config remains optional.

## Local proof

`python3 pi-kiosk/test_config_local_import.py` on unchanged master code:
4 cases, 2 failures (both broken-site imports unexpectedly succeed).
After the fix: all 4 pass. The loader executes actual site source through Python's
import machinery and executes the tracked config.py; it needs no site secrets.

Related checks: `test_auto_clock_config.py` (2), `test_setup_policy.py` (7),
and `test_t3_kiosk_policy.py` (7 with Python 3.11 test venv) pass.
Default system Python lacks numpy; the policy test requires the existing test
venv. Python compilation and `git diff --check` pass.

Broader validation is recorded separately in the PR body as it completes.
No UI change, browser proof, hardware test, deployment or production acceptance
is claimed. Checked all open PR titles and November 6–7 daily closeouts; this
finding does not duplicate their pending changes.
