# Keep owned photo cleanup working after data-root relocation

Moving an existing kiosk data directory to an owned external directory and
replacing the original directory with a symlink is supported by setup. Existing
photo references still use the original prefix. The photo ownership helpers
mistook that configured root alias for an untrusted nested symlink: re-enrollment
failed before updating the worker, local removal failed, and strict server
deactivation deleted the worker row but retained its biometric photo and pending
cleanup journal. Interrupted publication recovery also failed repeatedly.

The helper now maps only the configured `PHOTO_DIR` prefix onto its resolved root,
retaining the complete suffix for ownership and symlink checks. Cleanup recovery
uses this same helper. Nested file/directory symlinks, paths outside the root,
and unconfigured aliases remain rejected; shared referenced photos remain intact.

## Observed proof

Base: `origin/master` at `6d7110fd23520956bb489912b55ddce3563ebba0`.
The new tests create real SQLite rows and photo files before relocating data.
Loading that original database module into a fresh Python process and running
the new suite produced four errors (`Worker photo symlink needs manual cleanup`)
and one passing security test. With this change all five tests pass.

Run: `python3 pi-kiosk/test_relocated_photo_root.py`.

Adjacent checks passed: local photo ownership (7), roster receipt/mapping (47),
local removal (17), and the two existing setup tests for symlinked/relocated data
roots. Including the new suite, 78 checks passed. `git diff --check` passed.
Full repository verification and review are coordinated separately by the parent
daily-review task; these focused results do not claim those checks have run.

## Scope and limits

Privacy/path-security sensitive: this changes which configured-root photo paths
are accepted for deletion. It preserves the nested-symlink and outside-root
guards, photo publication lock, reference protection and durable cleanup journal.
No schema, migration, authentication, attendance-write or deployment changes.
No physical Pi, removable drive or live server was used. The existing filesystem
checks are not a new defense against hostile concurrent symlink replacement.

All open PRs and the October 26–31 ledger were searched for duplicates and file
overlap. No open PR changes `pi-kiosk/database.py`; root-relocation cleanup is
distinct from enrollment camera recovery and attendance-JSON isolation.
