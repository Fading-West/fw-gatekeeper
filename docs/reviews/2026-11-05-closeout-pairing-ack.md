# Renew missing-exit closeout acknowledgement after overnight evidence changes

Tier B: closeout signoff data integrity. Base: `3790da196bcd180d68b7bd073f6bd120e8e1041d`.

A supervisor can acknowledge a missing clock-out, then complete the closeout using that old acknowledgement after newly uploaded overnight scans materially change the evidence. The blocker retains the same key, same-day scans and counts, so the existing closeout comparison accepts it. For example, a September 3 14:00 entry is missing its exit. Later September 4 01:00 entry and 02:00 exit scans introduce a plausible competing exit within 16 hours. The exception correctly switches from a suggested clock-out correction to review-only, but the closeout still accepts the earlier acknowledgement.

`shiftCloseouts` now includes the existing missing-exit review fingerprint in that blocker's acknowledgement evidence. It covers effective pairing evidence, including relevant neighboring dates, and excludes next-day punches beyond the last entry's 16-hour horizon. No new reads, schema changes, migrations, API/UI changes or attendance writes. Existing acknowledgements containing open missing-exit blockers require renewal; evidence shapes without those blockers remain unchanged. The existing 200,000-character comparison limit still applies.

## Reproduce

Run from the checkout, with locked dependencies installed:

```sh
flock /home/noah/.cache/t3-recovery-heavy.lock node node_modules/vitest/vitest.mjs run convex/shiftCloseouts.pairingEvidence.test.ts --maxWorkers=1
```

The regression fixes the clock, creates the worker before the evaluated date and calls the actual authenticated Convex queries/mutations. On original product code: **2 failed, 1 passed**; both stale completion calls resolve with `status: completed` instead of rejecting. The unchanged control uses next-day 07:00/15:00 scans outside the pairing horizon. After the fix: **3 passed** (`after.log`). Rejected requests must preserve the draft and leave history/receipts untouched; renewed acknowledgement must permit completion.

Proof files remain outside the worktree at `/home/noah/t3-ui-proof/pQIuEFpq/evidence/closeout-pairing-ack/`: `before.log`, `after.log`, `checks.sh`, `check-results.txt` and individual check logs. The draft PR embeds the observed before/after summaries and reports final check outcomes. The opt-in local-stack package is run after committing the candidate; its separate run directory retains evidence after cleanup.

## Duplicate and scope check

Read the card's open/merged inventories before investigation, searched `docs/reviews` and current git history, then checked all 28 current open PRs. None of the candidate files overlaps open PR files. PR #264 concerns explicit exception-review persistence; #280 concerns pending-shift workers. This fix concerns closeout blocker acknowledgement after overnight attendance changes. It uses #264's existing review fingerprint without editing its implementation. The forbidden deactivated-worker-restoration feature is untouched.

Automated regression coverage is specific to missing-exit closeout acknowledgement, including stale saved/submitted evidence, transactional rejection, renewed completion and unrelated next-day attendance. The verification package's supported journey is Activity Log add-missing-punch, not this closeout scenario. Physical kiosks/ingest, face service, alert delivery, the real Command Center consumer, production Convex and Render remain uncovered. No deployment or production data access was performed.
