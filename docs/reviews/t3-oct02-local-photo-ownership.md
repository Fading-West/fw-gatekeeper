# Publish locally captured photos with durable worker ownership

Local enrollment previously wrote name-derived captures before completion and left files after cancellation or a failed SQLite update. Reenrollment/removal could also affect a namesake's captures. Local operators and roster administrators need worker references and owned photos to recover together.

Capture stays in memory until accepted. Publication journals uniquely named files before creation, flushes file bytes and directory entries before the worker commit, and retires only journaled, unreferenced files. Local and roster publications/removals share a short process lock; roster downloads remain outside it. Recovery preserves unknown files, shared references, ambiguous names, external files and symlinks requiring manual review. A failed publication retains the old worker and its photo references.

Dependency: complete local-sample-consistency range through e65ae351e695a62a0121d2f3ad6084330cdab24e. The dependent change starts after that head; the original draft was retained as commit 2403a20 before repairs. Prior roster revocation and queue identity behavior must remain intact in composition.

Acceptance uses isolated SQLite, temporary directories and synthetic bytes/vectors: namesakes and shared files survive, write/commit failures recover, cleanup cannot race roster publication, symlinks cannot delete other photos, and interrupted roster receipts remain retryable. Initial focused ownership and roster tests passed before the final external-path preservation repair; final exact-head complete checks and independent review remain pending. Physical camera/model accuracy, deployed backend and production release remain pending.
