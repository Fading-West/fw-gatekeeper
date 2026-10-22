# Unsynced attendance in Briefing and Closeout

Kiosks keep attendance locally and upload it on each sync cycle. Each sync request
reports `queued_logs`: the number of attendance records still on the device,
including quarantined records (`pi-kiosk/database.py::count_unsynced_logs`). A
fresh heartbeat and a working scanner do not prove that attendance reached the
server. Briefing and Closeout therefore treat a positive count as **incomplete
attendance evidence**. It is not proof of data loss or a scanner failure.

## Observation rules

- Ingestion (`src/app/api/sync/route.ts`, `convex/http.ts`) accepts only safe,
  nonnegative integer counts. Query strings must be canonical (`0`, `12`).
  Blank, `null`, boolean, fractional, signed, padded or exponent values are
  treated as unknown. They never become zero.
- Queue state (`kiosks.attendanceQueue`) changes only when a report passes the
  existing arrival-order check. A delayed older report cannot change it.
- A valid count stores `lastValidCount` and `observedAt`. `observedAt` is the
  server arrival time of that report.
- A report without a valid count, or contact with no health at all, marks the
  latest state `unknown`. It keeps the previous count and its `observedAt`. A
  positive count therefore stays a caveat until a newer valid zero arrives.
- A newer valid zero clears only the queue caveat. Connectivity and device-fault
  warnings are unaffected.
- A kiosk with no valid count on record stays visibly unknown. It does not add a
  warning, so legacy kiosks without queue telemetry are not newly blocked.
- Rows written before this field existed are read from their last `health`
  report. The next accepted update initializes the stored state. Read paths
  never write.
- Recognition-attempt counts (`queued_attempts`) are never treated as attendance.

## Briefing and Closeout

- Each active kiosk counts once in `kiosk_warnings`, whatever its reasons. Rows
  expose `warning_reasons` (`never_synced`, `offline`, `stale`, `device_fault`,
  `attendance_queue`) and `attendance_queue` (`status`, `last_valid_count`,
  `observed_at`, `caveat`).
- Queue dates are unknown. Every selected date shows the same current,
  fleet-wide caveat. The queue is not assigned to that shift.
- Closeout requires the existing admin/enrollment acknowledgement and a nonblank
  reason. Viewers stay read-only.
- Reviewed blocker evidence includes the kiosk ID, count and known/unknown
  state. Observation and heartbeat times are excluded, so a routine heartbeat
  does not invalidate an acknowledgement.
- Completing a closeout stores `attendanceQueueEvidence`. This is a copy of the
  queue observations at signing, and it is also written to
  `shiftCloseoutHistory`. Retries return the original signature without
  rewriting it. Records signed earlier show signed queue evidence as "Not
  recorded".
- Closeout pages and exports show signed evidence separately from current
  observations. Deployment fallbacks and older backends show queue evidence as
  unavailable, never as clear.

## Limitations

- Kiosks sample the queue before uploading in the same cycle. A successful
  upload is confirmed by the next cycle's zero, roughly one sync interval later.
- Telemetry carries counts, not record identities. If records upload and new
  ones queue between reports so the count is unchanged, the evidence looks the
  same. Acknowledgement is not renewed in that case.
- The `queue_backlog` alert (`docs/alerting.md`) still uses the latest raw count
  and its 50-record threshold. It is independent of this caveat.

## Deployment

Deploy the Convex schema and functions before the portal. The new fields are
optional, so no data migration is needed. Physical offline and reconnect
behavior must be confirmed on a Pi pilot.
