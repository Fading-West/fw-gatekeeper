import { v } from "convex/values";
import { query } from "./_generated/server";

/**
 * Liveness probe for the Convex deployment.
 *
 * This query is intentionally unauthenticated: it backs the Next.js
 * `/api/health` route, which is itself public so that Render's health check,
 * external uptime monitors, and every kiosk's `check_server()`
 * (pi-kiosk/sync.py) can reach it without a session. It takes no arguments,
 * reads no tables, and returns nothing but a constant and the deployment
 * clock, so exposing it leaks no data and cannot be used to mutate or
 * enumerate anything.
 *
 * Per vision.md principle 6 it is strictly read-only: it measures
 * reachability and must never touch sync state to make things look fresh.
 */
export const ping = query({
  args: {},
  returns: v.object({ ok: v.literal(true), now: v.number() }),
  handler: async () => ({ ok: true as const, now: Date.now() }),
});
