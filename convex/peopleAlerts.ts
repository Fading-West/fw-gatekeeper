import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";

const DEFAULT_SITE_URL = "https://fw-gatekeeper.onrender.com";
const CLAIM_MS = 60_000;
const RETRY_DELAY_MS = 60_000;

export function readPeopleAlertConfig(env: Record<string, string | undefined>) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.ALERT_EMAIL_FROM?.trim();
  const to = (env.PEOPLE_ALERT_EMAIL_TO ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  return {
    email: apiKey && from && to.length ? { apiKey, from, to } : null,
    webhookUrl: env.PEOPLE_ALERT_WEBHOOK_URL?.trim() || null,
    siteUrl: (env.SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/$/, ""),
  };
}

const claimedEvent = v.union(v.null(), v.object({
  id: v.id("peopleAlertEvents"),
  kind: v.union(v.literal("worker"), v.literal("portal_account")),
  label: v.string(),
  detail: v.optional(v.string()),
  createdAt: v.string(),
}));

export const claimPending = internalMutation({
  args: { attemptedIds: v.optional(v.array(v.id("peopleAlertEvents"))) },
  returns: claimedEvent,
  handler: async (ctx, args) => {
    const now = Date.now();
    // Unclaimed rows (undefined sorts before numbers) and expired claims are
    // eligible. Apply eligibility in the index so deferred rows cannot hide work.
    // A slow run can outlive an earlier event's retry delay. Exclude that
    // run's attempted IDs even after they become eligible in the index again.
    // A run attempts at most 20 events, so at most 21 candidates are needed.
    const attempted = new Set((args.attemptedIds ?? []).slice(0, 20));
    const candidates = await ctx.db.query("peopleAlertEvents")
      .withIndex("by_delivered_and_claimed_until", (q) => q.eq("delivered", false).lte("claimedUntil", now))
      .take(attempted.size + 1);
    const event = candidates.find((candidate) => !attempted.has(candidate._id));
    if (!event) return null;
    await ctx.db.patch(event._id, { claimedUntil: now + CLAIM_MS });
    return {
      id: event._id,
      kind: event.kind,
      label: event.label,
      detail: event.detail,
      createdAt: event.createdAt,
    };
  },
});

export const finishDelivery = internalMutation({
  args: { id: v.id("peopleAlertEvents"), delivered: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.id);
    if (!event || event.delivered) return null;
    await ctx.db.patch(args.id, args.delivered
      ? { delivered: true, deliveredAt: new Date().toISOString(), claimedUntil: undefined }
      : { claimedUntil: Date.now() + RETRY_DELAY_MS });
    return null;
  },
});

type Event = Exclude<typeof claimedEvent.type, null>;

export function buildPeopleAlert(event: Event, siteUrl: string) {
  const isWorker = event.kind === "worker";
  const kind = isWorker ? "Worker" : "Portal account";
  const link = `${siteUrl}/${isWorker ? "workers" : "accounts"}`;
  const subject = `[FW Gatekeeper] ${kind} added: ${event.label}`;
  const text = [
    `${kind} added to FW Gatekeeper`,
    `Name or email: ${event.label}`,
    ...(event.detail ? [`${isWorker ? "Department" : "Role"}: ${event.detail}`] : []),
    `Added at: ${event.createdAt}`,
    `Review: ${link}`,
  ].join("\n");
  return { subject, text, link };
}

export const deliverPending = internalAction({
  args: {},
  returns: v.object({ delivered: v.number(), configured: v.boolean() }),
  handler: async (ctx) => {
    const config = readPeopleAlertConfig(process.env);
    if (!config.email && !config.webhookUrl) {
      return { delivered: 0, configured: false };
    }

    let delivered = 0;
    const attemptedIds: Event["id"][] = [];
    for (let index = 0; index < 20; index++) {
      const event = await ctx.runMutation(internal.peopleAlerts.claimPending, { attemptedIds });
      if (!event) break;
      attemptedIds.push(event.id);
      const message = buildPeopleAlert(event, config.siteUrl);
      let accepted = false;
      if (config.email) {
        try {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
            headers: {
              authorization: `Bearer ${config.email.apiKey}`,
              "content-type": "application/json",
              "Idempotency-Key": `fw-gatekeeper-person-${event.id}`,
            },
            body: JSON.stringify({ from: config.email.from, to: config.email.to, subject: message.subject, text: message.text }),
          });
          if (!response.ok) throw new Error(`Resend responded ${response.status}`);
          accepted = true;
        } catch (error) {
          console.error("people_alert_email_failed", { eventId: event.id, error: String(error) });
        }
      }
      if (config.webhookUrl) {
        try {
          const response = await fetch(config.webhookUrl, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              source: "fw-gatekeeper", type: "person_added", event_id: event.id,
              person_type: event.kind, label: event.label, detail: event.detail ?? null,
              added_at: event.createdAt, subject: message.subject, text: message.text, link: message.link,
            }),
          });
          if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
          accepted = true;
        } catch (error) {
          console.error("people_alert_webhook_failed", { eventId: event.id, error: String(error) });
        }
      }
      await ctx.runMutation(internal.peopleAlerts.finishDelivery, { id: event.id, delivered: accepted });
      // A rejected event remains pending with a retry delay; later events can
      // still be delivered within this run's existing 20-attempt budget.
      if (accepted) delivered++;
    }
    return { delivered, configured: true };
  },
});
