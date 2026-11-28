# Activity Log reads can leave operators stuck indefinitely

Base: origin/master `5f85003ad5e9eb40794337d020977f9a1b7929fa` (default branch master).
Card: https://trello.com/c/1xWxqwFw

A fetch or JSON body that never resolves leaves the Activity Log loading, its
worker picker unavailable, or its hours export stuck on “Preparing hours…”.
There is no timeout or retry transition on those reads. The recently added
`boundedRead` used by other portal pages did not cover this page.

Use the existing 20-second read bound around the complete log response pair,
worker picker, and neighboring-day export reads. Retire selected-day requests
on cleanup. Export failure keeps the existing cancellation message and releases
the pending guard. No payroll file is downloaded from incomplete neighbor data.

Evidence: `evidence/nov06-log-read-timeout/red.txt` records the six initial
regression failures on the base production code. Eight regression cases now
cover fetch/body stalls, recovery and late completions, worker retry, and date
navigation. Focused runs: 70 tests across four portal suites; 52 tests across all
eight Activity Log suites. The existing export lifecycle test's mock now serves
the new selected day independently of the held export neighbors; otherwise it
mistakenly counted the newly cancellable selected-day request as an export read.

Validation: lint passes (six existing warnings); app and Convex typechecks pass;
production build passes with the CI-only Convex URL. Full Vitest and contracts
are recorded in the PR/card once complete. No production API or deployment used.
