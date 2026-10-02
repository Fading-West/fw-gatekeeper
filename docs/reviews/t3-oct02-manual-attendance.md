# Durable supervisor manual attendance

A double tap or retry after a lost local response previously wrote another event, including an immediate clock-out on an auto kiosk. Normal supervisor submissions now retain one operation ID until acknowledged. SQLite serializes current-worker selection, auto action, attendance and its durable receipt in one transaction. Replays return the original receipt even after restart or worker removal; conflicting reuse fails. Legacy callers without an operation ID remain compatible but must supply one for retry guarantees.

Scope: manual attendance only, master-based. Preserve the separate automatic recognition guard in PR95 during composition. No old improvement counted.

Regression code: test_t3_manual_attendance.py covers real disposable SQLite transactions, concurrent replay, restart, deletion, receipt-write failure and Flask validation/authorization. UI holds selection while outcome is uncertain and retains the operation through network/auth failures.

Validation status: source-only; no tests/runtime/builds run because serialized host admission remains pending behind FWCRM and UnitFlow. Exact-head checks and normal supervisor app acceptance remain required before PR readiness. Physical device, deployed backend and production release acceptance remain pending.

Review correction: the browser saves only the pending operation ID and local worker ID in per-tab session storage before transmission, restores that identity across reloads of the same tab, and clears only the matching operation after a terminal receipt. Another tab's successful attendance cannot replace or erase an uncertain receipt. This browser retry guarantee lasts for the tab's session; closing the tab ends that storage lifetime. Unavailable, corrupt, missing or changed retry storage blocks submissions before HTTP rather than inventing a new identity.

Regression source exercises two same-origin page contexts against one synthetic receipt backend: A commits and loses its response, B commits the next auto action successfully, and reloaded A returns the original receipt without a third event. It also covers double taps, removed roster selection, mismatched late cleanup, and storage failure. All original commits are retained. No runtime checks executed.
