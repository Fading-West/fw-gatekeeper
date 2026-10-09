# Require complete accepted-photo storage before enrollment publication

Enrollment previously swallowed individual storage failures, then saved a partial photo set or no photos. Reenrollment could replace the template and delete prior photos while reporting success. Enrollment staff and administrators need an explicit recoverable failure that keeps the persisted worker intact.

The route now stops at the first failed quality-approved photo upload and returns 503 before any worker save. Successfully uploaded pending files follow the existing caller-owned cleanup/expiry lifecycle. A worker save consumes those receipts atomically, so cleanup after a committed save with a lost response cannot delete attached files. Only quality-approved frames are stored; there is no fallback to rejected frames.

Dependency: complete worker-revision change through 19be39ed351aa6b12bd01f1a6f752feb92514d67, with its later contract repair retained in composition. The new scope is the all-or-none publication boundary. Existing pending-upload ownership, expiry, shared legacy attachment preservation, fresh consent and usable-vector policies remain intact.

Acceptance: first/middle/final upload failure on creation and reenrollment; unchanged old persisted template/photos; safe pending cleanup; lost committed response preserves new attached photos and inactive shared legacy references; unauthorized roles fail before processing. New tests call the actual route and isolated Convex implementation with synthetic data, alongside the existing ownership/expiry/conflict suites. Final exact-head tests/types/lint/build, independent review and matching CI remain pending. Actual deployed backend and production release remain pending.
