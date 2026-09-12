# Kiosk alerting and external health monitoring

Nothing used to watch FW Gatekeeper when no dashboard tab was open. This document
covers the two pieces that fix that:

1. `/api/health` now proves the Convex database is reachable, so an external uptime
   monitor can tell the difference between "the web process is up" and "the system works".
2. A Convex cron (`convex/crons.ts` -> `convex/alerts.ts`) checks every active kiosk every
   15 minutes and emails (and optionally webhooks) when one is offline, stale, faulty, or
   holding a backlog of unsynced scans.

Both are read-only with respect to the signals they measure (vision.md principle 6). The
cron only writes its own `alertState` table; it never touches `lastSync` or kiosk health.

## What triggers an alert

Thresholds mirror the Kiosks page (`src/app/api/system-health/route.ts`) and the
scan-blocking fault list in `convex/shiftBriefing.ts`, so the email says the same thing
the dashboard does.

| Condition | Fires when | Notes |
|-----------|------------|-------|
| `stale` | `lastSync` is older than 15 minutes | Cleared automatically (no recovery notice) if the kiosk escalates to `offline`. |
| `offline` | `lastSync` is older than 60 minutes | `stale` is never reported alongside `offline` for the same kiosk. |
| `never_synced` | The kiosk has no `lastSync` at all | Usually a freshly registered kiosk whose `KIOSK_ID` does not match. |
| `device_fault` | `health.cameraOk === false`, `health.modelOk === false`, or `health.degradedReason` is one of `camera_error`, `model_error`, `encoding_mismatch`, `no_workers_synced`, `liveness_required_unavailable` | These are the faults that block every scan. `liveness_unavailable` is shown on the dashboard but does not page anyone. |
| `queue_backlog` | `health.queuedLogs >= 50` | The kiosk is scanning but cannot upload attendance. |

Inactive kiosks (`active: false`) are ignored.

## Cadence

- The cron runs every 15 minutes (`crons.interval("kiosk alert check", { minutes: 15 }, ...)`).
- A condition is emailed the first time it is seen.
- While it persists, a reminder goes out at most every 6 hours.
- When a condition that was emailed clears, exactly one recovery notice is sent.
- Multiple conditions on the same kiosk are combined into one message per run; the
  subject names the most severe one, e.g. `[FW Gatekeeper] Main Entry offline for 1h 12m (+1 more)`.
- Alert episodes are tracked in the `alertState` table (`kioskId`, `condition`,
  `firstSeenAt`, `lastNotifiedAt`, `resolvedAt`). Rows are kept after resolution as a
  small audit trail; a new episode creates a new row.

If a delivery attempt fails, the condition is not marked as notified, so it is retried
on the next run.

## Environment variables (Convex deployment)

These are read by the Convex action, so they must be set on the Convex deployment, not on
Render. Set them with the Convex CLI from the repo root:

```bash
npx convex env set RESEND_API_KEY re_xxxxxxxxx
npx convex env set ALERT_EMAIL_FROM "FW Gatekeeper <alerts@yourdomain.com>"
npx convex env set ALERT_EMAIL_TO "supervisor@yourdomain.com,ops@yourdomain.com"
npx convex env set ALERT_WEBHOOK_URL https://hooks.example.com/fw-gatekeeper   # optional
npx convex env set SITE_URL https://fw-gatekeeper.onrender.com                # optional
```

Use `npx convex env set --prod ...` (or pick the deployment with `--deployment-name`) for
production; without a flag the CLI targets your dev deployment. Verify with `npx convex env list`.

| Variable | Required | Purpose |
|----------|----------|---------|
| `RESEND_API_KEY` | yes (for email) | API key from https://resend.com. The action calls `POST https://api.resend.com/emails`. |
| `ALERT_EMAIL_FROM` | yes (for email) | Sender address. The domain must be verified in Resend. |
| `ALERT_EMAIL_TO` | yes (for email) | Comma-separated recipient list. |
| `ALERT_WEBHOOK_URL` | no | If set, every alert and recovery is also `POST`ed as JSON (`type`, `kiosk`, `conditions`, `subject`, `text`, `link`, `checked_at`). Works with Slack/Discord-style incoming webhooks via a small adapter or any custom receiver. |
| `SITE_URL` | no | Base URL for the `/kiosks` link in messages. Defaults to `https://fw-gatekeeper.onrender.com`. |

If any of the three email variables is missing, the cron still evaluates and records
state, logs `kiosk_alerts_unconfigured` with the conditions that would have fired, and
does not throw. If only the webhook is configured, alerts go to the webhook alone.

Every run logs `kiosk_alerts_checked` with counts; look at the Convex dashboard logs for
`alerts:checkKiosks` to confirm it is running.

## Testing with a fake stale kiosk

1. Register a kiosk on the dashboard (`/kiosks` -> add kiosk) or reuse an existing one.
2. In the Convex dashboard (Data -> `kiosks`), edit that row and set `lastSync` to an ISO
   timestamp two hours ago, e.g. `2026-09-05T01:00:00.000Z`. Do not use the kiosk sync
   endpoint for this; that would mutate the signal you are trying to observe.
3. Trigger the check without waiting 15 minutes:

   ```bash
   npx convex run alerts:checkKiosks
   ```

   The command prints `{ kiosks, alerts, recoveries, delivered, configured }`. With email
   configured you should receive `[FW Gatekeeper] <name> offline for 2h 0m`.
4. Run it again: `alerts` should be `0` and no second email is sent (the 6-hour reminder
   window has not passed). Check Data -> `alertState` for one open row.
5. Restore `lastSync` to now (or let the real kiosk sync) and run the command once more:
   you should get one recovery notice and the row gains `resolvedAt`.

The automated equivalent lives in `convex/alerts.test.ts` (`npm run test:alerts`).

## External uptime monitoring

`/api/health` is public (see `PUBLIC_PATHS` in `src/proxy.ts`) and is what Render's health
check and each kiosk's `check_server()` poll. It now performs one tiny unauthenticated
Convex query (`health:ping`) with a 5-second timeout:

- `200 {"status":"ok","convex":"ok","timestamp":...}` when Convex answered.
- `503 {"status":"degraded","convex":"unreachable"}` when it did not.

Point an external monitor (UptimeRobot, Better Stack, Healthchecks.io, a cron on another
box, etc.) at these two URLs and alert on anything other than HTTP 200:

| Target | URL | Healthy response |
|--------|-----|------------------|
| Dashboard + Convex | `https://fw-gatekeeper.onrender.com/api/health` | `200`, body contains `"convex":"ok"` |
| Face service | `https://fw-face-service.onrender.com/health` | `200`, body contains `"rec_exists":true` |

Recommended settings: check every 1-5 minutes, require two consecutive failures before
paging (Render free-tier cold starts can exceed 5 seconds), and use a keyword/body match
rather than status code alone so a cached or proxied `200` does not hide a real outage.

Note that the monitor tells you the cloud side is up; the kiosk cron tells you the
factory side is syncing. You need both.

## Delivery and recovery failures

Each email/webhook request has a 10-second timeout. Failed alert delivery is retried
on the next cron run; a cleared alert is also retained until its recovery notice is
delivered. A successful channel counts as delivery when both channels are configured.
Malformed or future sync timestamps produce a stale alert instead of reporting healthy.
Required-liveness failures (`liveness_required_unavailable`) count as device faults.
The public health endpoint returns a generic 503 during backend failures; diagnostics
stay in server logs. No health probe updates kiosk sync timestamps.

Deactivated or removed kiosks stop producing alerts; their old alerts close silently.
Retirement is never announced as a recovered device.
