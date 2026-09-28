import { getFactoryLocalDateKey } from "./localDate";
import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { isValidFactoryLocalDateKey } from "./localDate";
import { buildShiftExceptions } from "./shiftExceptions";
import { buildShiftBriefing } from "./shiftBriefing";
import { assertPortalRole } from "./access";

type CloseoutStatus = "open" | "completed" | "reopened";

function normalizeText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function buildHref(path: string, params: Record<string, string | null | undefined>) {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

function firstExceptionKey(exceptions: any[]) {
  return exceptions.find((exception) => exception?.key)?.key || null;
}

function firstExceptionLink(exceptions: any[], link: "activity_log" | "recognition_lab" | "kiosk") {
  return exceptions.find((exception) => exception?.links?.[link])?.links?.[link] || null;
}

function proof(count: number, label: string, href: string, exact: boolean) {
  return {
    label,
    count,
    href,
    exact,
  };
}

function plural(count: number, singular: string, pluralValue?: string) {
  return `${count} ${count === 1 ? singular : pluralValue || `${singular}s`}`;
}

function buildDraftSection(
  id: string,
  title: string,
  paragraph: string,
  sourceLinks: Array<{ label: string; href: string; count: number; exact: boolean }> = [],
) {
  return {
    id,
    title,
    paragraph,
    source_links: sourceLinks,
  };
}

function buildChecklist(input: {
  date: string;
  openExceptions: any[];
  criticalExceptions: any[];
  missingClockOuts: any[];
  recognitionReviews: any[];
  kioskWarnings: number;
  acknowledgedBlockers: boolean;
}) {
  const criticalClear = input.criticalExceptions.length === 0 || input.acknowledgedBlockers;
  const missingClockOutsClear = input.missingClockOuts.length === 0 || input.acknowledgedBlockers;
  const kioskWarningsClear = input.kioskWarnings === 0 || input.acknowledgedBlockers;
  const recognitionReviewsClear = input.recognitionReviews.length === 0 || input.acknowledgedBlockers;
  const firstCriticalKey = firstExceptionKey(input.criticalExceptions);
  const firstMissingClockOutKey = firstExceptionKey(input.missingClockOuts);
  const firstRecognitionKey = firstExceptionKey(input.recognitionReviews);
  const firstRecognitionLabHref = firstExceptionLink(input.recognitionReviews, "recognition_lab");
  const criticalHref = buildHref("/exceptions", { date: input.date, status: "open", severity: "critical", exception_key: firstCriticalKey });
  const missingClockOutHref = buildHref("/exceptions", {
    date: input.date,
    status: "open",
    type: "missing_clock_out",
    exception_key: firstMissingClockOutKey,
    intent: firstMissingClockOutKey ? "correct" : null,
  });
  const kioskHref = "/kiosks";
  const recognitionHref = firstRecognitionLabHref || buildHref("/calibration/recognition", { date: input.date, review_status: "unreviewed" });

  return [
    {
      id: "critical_exceptions",
      label: "Critical exceptions reviewed",
      status: criticalClear ? "clear" : "blocked",
      count: input.criticalExceptions.length,
      href: criticalHref,
      source_exception_key: firstCriticalKey,
      proof: proof(input.criticalExceptions.length, "open critical exceptions", criticalHref, Boolean(firstCriticalKey)),
      description: input.criticalExceptions.length
        ? `${input.criticalExceptions.length} critical exception${input.criticalExceptions.length === 1 ? "" : "s"} still need supervisor review.`
        : "No open critical exceptions.",
    },
    {
      id: "missing_clock_outs",
      label: "Missing clock-outs reviewed",
      status: missingClockOutsClear ? "clear" : "blocked",
      count: input.missingClockOuts.length,
      href: missingClockOutHref,
      source_exception_key: firstMissingClockOutKey,
      proof: proof(input.missingClockOuts.length, "missing clock-outs", missingClockOutHref, Boolean(firstMissingClockOutKey)),
      description: input.missingClockOuts.length
        ? `${input.missingClockOuts.length} missing clock-out exception${input.missingClockOuts.length === 1 ? "" : "s"} still need acknowledgement.`
        : "No missing clock-out exceptions are open.",
    },
    {
      id: "kiosk_warnings",
      label: "Kiosk trust acknowledged",
      status: kioskWarningsClear ? "clear" : "blocked",
      count: input.kioskWarnings,
      href: kioskHref,
      proof: proof(input.kioskWarnings, "kiosk trust warnings", kioskHref, false),
      description: input.kioskWarnings
        ? `${input.kioskWarnings} kiosk trust warning${input.kioskWarnings === 1 ? "" : "s"} may affect shift confidence.`
        : "All kiosk trust signals are clear.",
    },
    {
      id: "recognition_reviews",
      label: "Recognition review issues acknowledged",
      status: recognitionReviewsClear ? "clear" : "blocked",
      count: input.recognitionReviews.length,
      href: recognitionHref,
      source_exception_key: firstRecognitionKey,
      proof: proof(input.recognitionReviews.length, "recognition reviews", recognitionHref, Boolean(firstRecognitionLabHref)),
      description: input.recognitionReviews.length
        ? `${input.recognitionReviews.length} recognition review item${input.recognitionReviews.length === 1 ? "" : "s"} remain open.`
        : "No recognition review exceptions are open.",
    },
  ];
}

function buildSuggestedNote(input: {
  date: string;
  summary: {
    expected: number;
    present: number;
    late: number;
    missing: number;
    open_exceptions: number;
    critical_exceptions: number;
    missing_clock_outs: number;
    recognition_reviews: number;
    kiosk_warnings: number;
    attendance_corrections: number;
  };
  blockers: Array<{ label: string; count: number }>;
}) {
  const summaryCounts = [
    `${input.summary.expected} expected`,
    `${input.summary.present} present`,
    `${input.summary.late} late`,
    `${input.summary.missing} missing`,
    `${input.summary.open_exceptions} open exceptions`,
    `${input.summary.critical_exceptions} critical exceptions`,
    `${input.summary.missing_clock_outs} missing clock-outs`,
    `${input.summary.recognition_reviews} recognition reviews`,
    `${input.summary.kiosk_warnings} kiosk warnings`,
    `${input.summary.attendance_corrections} attendance corrections`,
  ].join(", ");

  if (input.blockers.length) {
    const blockerCounts = input.blockers
      .map((blocker) => `${blocker.label}: ${blocker.count}`)
      .join("; ");
    return `${input.date} closeout: blockers remain (${blockerCounts}). Summary: ${summaryCounts}.`;
  }

  return `${input.date} closeout: checklist clear. Summary: ${summaryCounts}.`;
}

function buildCloseoutDraft(input: {
  date: string;
  generatedAt: string;
  summary: {
    expected: number;
    present: number;
    late: number;
    missing: number;
    open_exceptions: number;
    critical_exceptions: number;
    missing_clock_outs: number;
    recognition_reviews: number;
    kiosk_warnings: number;
    attendance_corrections: number;
  };
  totalExceptions: number;
  reviewedExceptions: number;
  sourceBlockers: ReturnType<typeof buildChecklist>;
  actionLinks: Array<{ label: string; href: string }>;
}) {
  const sourceCounts = {
    ...input.summary,
    total_exceptions: input.totalExceptions,
    reviewed_exceptions: input.reviewedExceptions,
    source_blockers: input.sourceBlockers.reduce((total, blocker) => total + blocker.count, 0),
  };
  const blockerLinks = input.sourceBlockers.map((blocker) => ({
    label: blocker.proof.label,
    href: blocker.proof.href,
    count: blocker.proof.count,
    exact: blocker.proof.exact,
  }));
  const sourceLinks = [
    ...input.actionLinks.map((link) => ({
      ...link,
      count: 0,
      exact: false,
    })),
    ...blockerLinks,
  ];

  const sections = [
    buildDraftSection(
      "attendance_summary",
      "Attendance summary",
      `${input.date} attendance shows ${input.summary.present}/${input.summary.expected} expected workers present, ${input.summary.late} late, and ${input.summary.missing} missing from effective attendance evidence.`,
      [
        {
          label: "briefing attendance summary",
          href: buildHref("/briefing", { date: input.date }),
          count: input.summary.expected,
          exact: false,
        },
      ],
    ),
    buildDraftSection(
      "exceptions_reviewed",
      "Exceptions reviewed and unresolved",
      input.summary.open_exceptions
        ? `The shift exception queue contains ${plural(input.totalExceptions, "total exception")} with ${plural(input.reviewedExceptions, "reviewed or resolved exception")} and ${plural(input.summary.open_exceptions, "open exception")} still unresolved, including ${plural(input.summary.critical_exceptions, "critical exception")} and ${plural(input.summary.missing_clock_outs, "missing clock-out blocker")}.`
        : `The shift exception queue contains ${plural(input.totalExceptions, "total exception")} and no open exceptions remain for this closeout.`,
      [
        {
          label: "open exceptions",
          href: buildHref("/exceptions", { date: input.date, status: "open" }),
          count: input.summary.open_exceptions,
          exact: false,
        },
      ],
    ),
    buildDraftSection(
      "kiosk_trust_caveats",
      "Kiosk trust caveats",
      input.summary.kiosk_warnings
        ? `${plural(input.summary.kiosk_warnings, "kiosk trust warning")} may affect confidence in the physical-door attendance record and should be reviewed against kiosk sync evidence.`
        : "No kiosk trust warnings are blocking the closeout based on current kiosk sync evidence.",
      [
        {
          label: "kiosk trust warnings",
          href: "/kiosks",
          count: input.summary.kiosk_warnings,
          exact: false,
        },
      ],
    ),
    buildDraftSection(
      "corrections_applied",
      "Corrections applied",
      input.summary.attendance_corrections
        ? `${plural(input.summary.attendance_corrections, "audited attendance correction")} are recorded for this date; reversals are reflected in effective attendance, and raw kiosk evidence remains preserved as source history.`
        : "No audited attendance corrections are recorded for this date; the closeout is based on kiosk and schedule evidence only.",
      [
        {
          label: "attendance corrections",
          href: buildHref("/log", { date: input.date }),
          count: input.summary.attendance_corrections,
          exact: false,
        },
      ],
    ),
    buildDraftSection(
      "blocker_acknowledgement",
      "Blocker acknowledgement",
      input.sourceBlockers.length
        ? `Source blockers remain: ${input.sourceBlockers.map((blocker) => `${blocker.label} (${blocker.count})`).join("; ")}. A supervisor must explicitly acknowledge these blockers and keep the reason in closeout notes before completing the shift record.`
        : "No source blockers remain. Supervisor signoff can complete the closeout when the notes are acceptable.",
      blockerLinks,
    ),
  ];

  return {
    generated_at: input.generatedAt,
    source_counts: sourceCounts,
    source_links: sourceLinks,
    sections,
    narrative: sections.map((section) => `${section.title}: ${section.paragraph}`).join("\n\n"),
  };
}

async function buildCloseoutPayload(ctx: any, date: string) {
  const generatedAt = new Date().toISOString();
  const [briefing, exceptions, closeout] = await Promise.all([
    buildShiftBriefing(ctx, date),
    buildShiftExceptions(ctx, date),
    ctx.db
      .query("shiftCloseouts")
      .withIndex("by_date", (q: any) => q.eq("date", date))
      .first(),
  ]);
  const attendanceCorrections = await ctx.db
    .query("attendanceCorrections")
    .withIndex("by_date", (q: any) => q.eq("date", date))
    .collect();

  const openExceptions = exceptions.filter((exception: any) => exception.status === "open");
  const criticalExceptions = openExceptions.filter((exception: any) => exception.severity === "critical");
  const missingClockOuts = openExceptions.filter((exception: any) => exception.type === "missing_clock_out");
  const recognitionReviews = openExceptions.filter((exception: any) => exception.type === "recognition_review");
  const kioskWarnings = briefing.summary.kiosk_warnings || 0;
  const acknowledgedBlockers = closeout?.acknowledgedBlockers ?? false;
  const checklist = buildChecklist({
    date,
    openExceptions,
    criticalExceptions,
    missingClockOuts,
    recognitionReviews,
    kioskWarnings,
    acknowledgedBlockers,
  });
  const sourceBlockers = buildChecklist({
    date,
    openExceptions,
    criticalExceptions,
    missingClockOuts,
    recognitionReviews,
    kioskWarnings,
    acknowledgedBlockers: false,
  }).filter((item) => item.status === "blocked");
  const blockers = checklist.filter((item) => item.status === "blocked");
  const canComplete = blockers.length === 0;
  const summary = {
    expected: briefing.summary.expected,
    present: briefing.summary.present,
    late: briefing.summary.late,
    missing: briefing.summary.missing,
    open_exceptions: openExceptions.length,
    critical_exceptions: criticalExceptions.length,
    missing_clock_outs: missingClockOuts.length,
    recognition_reviews: recognitionReviews.length,
    kiosk_warnings: kioskWarnings,
    attendance_corrections: attendanceCorrections.length,
  };
  const suggestedNote = buildSuggestedNote({
    date,
    summary,
    blockers: sourceBlockers,
  });
  const actionLinks = [
    { label: "Briefing", href: `/briefing?date=${date}` },
    { label: "Exceptions", href: buildHref("/exceptions", { date, status: "open" }) },
    { label: "Activity Log", href: `/log?date=${date}` },
    { label: "Kiosks", href: "/kiosks" },
    { label: "Recognition Lab", href: buildHref("/calibration/recognition", { date, review_status: "unreviewed" }) },
  ];
  const closeoutDraft = buildCloseoutDraft({
    date,
    generatedAt,
    summary,
    totalExceptions: exceptions.length,
    reviewedExceptions: exceptions.filter((exception: any) => exception.status !== "open").length,
    sourceBlockers,
    actionLinks,
  });

  return {
    date,
    generated_at: generatedAt,
    closeout: closeout
      ? {
          id: String(closeout._id),
          date: closeout.date,
          status: closeout.status as CloseoutStatus,
          supervisor_name: closeout.supervisorName || null,
          notes: closeout.notes || "",
          acknowledged_blockers: closeout.acknowledgedBlockers,
          completed_at: closeout.completedAt || null,
          reopened_at: closeout.reopenedAt || null,
          updated_at: closeout.updatedAt,
          snapshot: {
            expected: closeout.expected,
            present: closeout.present,
            late: closeout.late,
            missing: closeout.missing,
            open_exceptions: closeout.openExceptions,
            critical_exceptions: closeout.criticalExceptions,
            kiosk_warnings: closeout.kioskWarnings,
          },
        }
      : null,
    summary,
    checklist,
    blockers,
    can_complete: canComplete,
    suggested_note: suggestedNote,
    closeout_draft: closeoutDraft,
    action_links: actionLinks,
  };
}

export const get = query({
  args: { date: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);
    const date = args.date || getFactoryLocalDateKey(new Date().toISOString())!;
    return buildCloseoutPayload(ctx, date);
  },
});

export const save = mutation({
  args: {
    date: v.string(),
    action: v.union(v.literal("save"), v.literal("complete"), v.literal("reopen")),
    supervisorName: v.optional(v.string()),
    notes: v.optional(v.string()),
    acknowledgedBlockers: v.optional(v.boolean()),
  },
  returns: v.object({ id: v.id("shiftCloseouts"), status: v.union(v.literal("open"), v.literal("completed"), v.literal("reopened")) }),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ["admin", "enrollment"]);
    if (!isValidFactoryLocalDateKey(args.date)) throw new ConvexError("date must use YYYY-MM-DD format");
    const existing = await ctx.db
      .query("shiftCloseouts")
      .withIndex("by_date", (q: any) => q.eq("date", args.date))
      .first();
    if (existing?.status === "completed" && args.action === "complete") {
      // Network retries cannot rewrite the signed snapshot or its timestamp.
      return { id: existing._id, status: existing.status };
    }
    if (existing?.status === "completed" && args.action === "save") {
      throw new ConvexError("Reopen the completed closeout before changing notes.");
    }
    if (args.action === "reopen" && existing?.status !== "completed") {
      throw new ConvexError("Only a completed closeout can be reopened.");
    }
    const current = await buildCloseoutPayload(ctx, args.date);
    const now = new Date().toISOString();
    const supervisorName = args.supervisorName === undefined ? existing?.supervisorName : normalizeText(args.supervisorName);
    const hasNotesArg = Object.prototype.hasOwnProperty.call(args, "notes");
    const notes = normalizeText(args.notes);
    const acknowledgedBlockers = args.action === "reopen" ? false : args.acknowledgedBlockers ?? existing?.acknowledgedBlockers ?? false;
    const nextNotes = notes || (hasNotesArg ? undefined : normalizeText(existing?.notes));
    const hasSourceBlockers = Boolean(
      current.summary.critical_exceptions ||
      current.summary.missing_clock_outs ||
      current.summary.recognition_reviews ||
      current.summary.kiosk_warnings
    );

    if (hasSourceBlockers && acknowledgedBlockers && !nextNotes) {
      throw new Error("Closeout has blockers. Add an acknowledgement note before acknowledging blockers.");
    }

    if (args.action === "complete" && hasSourceBlockers && (!acknowledgedBlockers || !nextNotes)) {
      throw new Error("Closeout has blockers. Add an acknowledgement note before completing.");
    }

    const status: CloseoutStatus =
      args.action === "complete" ? "completed" : args.action === "reopen" ? "reopened" : existing?.status || "open";

    const patch = {
      date: args.date,
      status,
      supervisorName,
      notes: nextNotes,
      acknowledgedBlockers,
      expected: current.summary.expected,
      present: current.summary.present,
      late: current.summary.late,
      missing: current.summary.missing,
      openExceptions: current.summary.open_exceptions,
      criticalExceptions: current.summary.critical_exceptions,
      kioskWarnings: current.summary.kiosk_warnings,
      completedAt: args.action === "complete" ? now : existing?.completedAt,
      reopenedAt: args.action === "reopen" ? now : existing?.reopenedAt,
      updatedAt: now,
    };

    const before = existing ? (({ _id, _creationTime, ...record }) => record)(existing) : undefined;
    const after = args.action === "reopen" && before
      ? { ...before, status, acknowledgedBlockers: false, reopenedAt: now, updatedAt: now }
      : { ...patch, createdAt: existing?.createdAt || now };
    const id = existing?._id || await ctx.db.insert("shiftCloseouts", after);
    if (existing) await ctx.db.patch(id, after);
    if (args.action === "complete" || args.action === "reopen") {
      await ctx.db.insert("shiftCloseoutHistory", {
        closeoutId: id, actorUserId: actor.userId, action: args.action,
        occurredAt: now, before, after,
      });
    }
    return { id, status };
  },
});
