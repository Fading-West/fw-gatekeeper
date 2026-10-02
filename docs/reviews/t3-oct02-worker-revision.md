# Reject stale worker identity updates

Rank 14; high integrity impact is an engineering estimate. Two administrators or a long-running enrollment could overwrite an intervening identity change. An identity-only revision fingerprints normalized name, employee ID and department, supports legacy rows without migration, and is compared inside the worker mutation before any biometric/photo/audit write. Metadata-changing direct calls require a revision; the normal API rejects missing or stale revisions with recoverable HTTP409.

Worker editing preserves a conflicted draft and offers explicit loading of the current record. Enrollment carries the prefill revision, captures current server identity before encoding and compares it at commit. Enrollment-role biometric refreshes omit metadata changes. Cleanup retains old attached photos and deletes only still-pending uploads owned by the operator.

Acceptance: stale saves cannot change identity, photos or audit; a refreshed current draft can save; metadata and encoding-time conflicts stay recoverable. Existing identity regressions now supply the revision for intentional metadata updates. Dedicated Convex and route regressions authored. Exact source/tests/types/lint/build, normal admin/enrollment app acceptance and CI remain pending serialized runtime admission. Preserve96 consent and99 usable vectors during composition; no runtime/deployment or physical acceptance claimed.

Source authoring initially missed the reviews directory after switching to the isolated master-based branch; no commit was created by that failed attempt. Directory creation repaired this source-only operation; no tests were run.
