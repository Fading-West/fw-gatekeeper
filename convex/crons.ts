import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Watches kiosk sync freshness and self-reported device health even when no
// dashboard tab is open. Conditions, thresholds, and the env vars needed for
// delivery are documented in docs/alerting.md.
crons.interval("kiosk alert check", { minutes: 15 }, internal.alerts.checkKiosks, {});

export default crons;
