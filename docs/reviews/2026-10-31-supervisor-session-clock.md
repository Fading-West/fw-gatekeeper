# Supervisor session expiry and clock corrections — October 31, 2026

Daily card: https://trello.com/c/1Rja8Qip
Base: origin/master at 382a6145131b675b059ef9009919ed823617a4f8.
Checked open/recent PRs and daily work through October 30. This expiry helper is
separate from #265's PIN lockout feedback; no edited files overlap open PRs.

Supervisor unlock expiry used the wall clock even though unlock records are
process-local. An expired token remained in the session map: advancing wall
time from 1000 to 1301 rejected it, then correcting time backward to 1001 made
that same token valid again. A large correction in either direction could also
invalidate a freshly issued five-minute unlock before five minutes elapsed.

Observed proof: all three tests in `pi-kiosk/test_supervisor_session_clock.py`
failed against the original helper and passed after the fix. They cover expired
token revival, fresh unlocks across forward/backward corrections, idempotent
unlock retries, pruning and replacement after the actual elapsed TTL.

Store monotonic expiry deadlines in the existing process-local session map.
Retain signed token format and key/PIN verification. Check deadlines before and
after signature validation, and delete an observed expired entry. Existing
revoke/cancel/restart semantics stay intact. Explicit historical `issued_at`
values still receive only their remaining lifetime.

Focused checks observed: new clock tests (3), existing lock/restart tests (8)
and UI credential tests (10) pass. Full local and exact-head GitHub CI/audit
results are recorded in the PR. Browser cookie expiry further limits ordinary
exposure, but the server must reject an expired retained/copied token itself.

Scope: local authentication/security. No new schema, migration, payroll/time-punch
behavior or deployment configuration change. No merge or deployment.
