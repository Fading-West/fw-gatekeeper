# Roster membership by date

Shift Briefing, Shift Exceptions and Shift Closeout judge a factory date only
against workers who were on the roster when that date's shift started, plus
workers the door or an audited correction recorded on that date. Both builders
share `convex/rosterMembership.ts`, so briefing-missing always equals
exception-missing.

- **Join time is the worker row's `_creationTime`.** `enrolledAt` is rewritten
  on re-enrollment and restore, so it is not a join time. A worker restored by
  employee ID reuses the old row and keeps its original join time.
- **Joined on an earlier date:** judged as before.
- **Joined on a later date:** omitted from the date (no briefing row, counts,
  schedule warnings, coverage evidence, enrollment risks or exceptions) unless
  they have effective attendance belonging to the date.
- **Joined on the date:** compared with the unique supported schedule start,
  ignoring seconds, using the first occurrence of a repeated fall-back time. A
  skipped spring-forward start compares factory wall times. Joining at the start
  minute, or with no unique supported schedule, counts as before.
- **Joined after the start, with attendance on the date:** kept, but never
  missing or late. Briefing status follows the last punch; scan-sequence and
  missing-clock-out checks still apply. Hours worked before enrollment are
  recorded with direct Activity Log corrections.

Effective attendance excludes voided scans and reversed added punches, and only
events belonging to the factory date count; neighbouring-date events in the
pairing window do not.

## Non-goals

- Deactivated workers still vanish from dates before their deactivation, and
  restored workers still show as missing during their inactive gap. Fixing that
  needs active intervals from the audit log.
- Retroactive schedule or department changes.
- `convex/stats.ts`, which intentionally uses the current roster.
- Exports, schema, backfill, UI copy and kiosk behavior.

## Tests

convex-test stamps `_creationTime` from `Date.now()` and keeps it monotonic.
Fixtures for fixed past dates must insert workers under a fake clock set before
the evaluated shift start, and before any real-clock insert in the same test.
