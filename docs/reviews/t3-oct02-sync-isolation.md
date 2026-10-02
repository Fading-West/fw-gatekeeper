# Isolate independent kiosk sync phases

A failed roster reload previously skipped both durable uploads; attendance exceptions also skipped recognition telemetry. The background cycle now catches failures around each independent phase. Roster reload remains fail-closed and a failed reload never acknowledges its receipt. Attendance and telemetry continue independently; a later cycle retries failed phases. Existing queue acknowledgement/quarantine implementations remain untouched.

Scope: master-based sync orchestration. Preserve complete PR97, PR103 and PR107 acknowledgement/quarantine changes during composition, including their additional recognition-rejection health counters. No existing bases or scopes changed.

Regression code: test_t3_sync_isolation.py invokes the production worker loop for one synthetic cycle, covering roster request/reload faults, attendance faults, all-phase failure followed by recovery and receipt/health preservation. No runtime/network/data used during implementation.

Validation status: source-only; git diff --check passed. Tests, exact builds and normal local kiosk acceptance await explicit serialized admission behind FWCRM and UnitFlow. Physical device/backend/release acceptance remains pending.
