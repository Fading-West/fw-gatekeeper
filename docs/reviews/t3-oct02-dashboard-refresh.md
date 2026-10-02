# Publish current coherent dashboard refresh results

Rank17; high operational trust benefit is an engineering estimate. Polling, visibility and manual refreshes could publish out of order, and new-day requests could reuse previous-day attendance after a partial failure. Every refresh now owns a sequence, shared abort signal, factory date and mount lifecycle. Superseded requests cannot publish success, errors or completion flags. A new date clears operational evidence, freshness and cached attendance before loading; rendered actions share the data date, and a rollover render hides old-day actions pending refresh.

Individual same-day signal failure behavior remains: independent requests settle separately, successful signals publish, unavailable signals remain visibly stale. Day changes never carry old attendance into the new roster.

Acceptance: later requests win; late failures cannot overwrite confirmed evidence; unmount aborts outstanding reads; midnight failure cannot show yesterday's presence or current-date actions from old evidence. Component regressions authored using synthetic responses and controllable promises/clock. Existing worker read-scope contract accommodates AbortSignal options. Source-only; exact tests/types/lint/build, normal-role runtime, CI and composition remain pending admission. No deployment or real data.
