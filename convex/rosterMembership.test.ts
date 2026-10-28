/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
// Thursday in Central Daylight Time (UTC-5); the day shift runs 07:00-15:30.
const DATE = '2026-09-03';

function at(isoUtc: string) {
  vi.setSystemTime(new Date(isoUtc));
}

// convex-test stamps _creationTime from Date.now(), so the established roster
// is created before the earliest evaluated shift start.
async function fixture(date = DATE, schedule = { startTime: '07:00', endTime: '15:30' }) {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-01-01T12:00:00Z');
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const createdAt = '2026-01-01T12:00:00Z';
    const userId = await ctx.db.insert('users', { email: 'supervisor@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt });
    const avery = await ctx.db.insert('workers', {
      name: 'Avery', department: 'Assembly', active: true, enrolledAt: createdAt, faceEncoding: Array(512).fill(0.1),
    });
    await ctx.db.insert('schedules', {
      name: 'Day', department: 'Assembly', days: '[0,1,2,3,4,5,6]', ...schedule, active: true, createdAt,
    });
    return { userId, avery: String(avery) };
  });
  const admin = t.withIdentity({ subject: ids.userId });
  async function addWorker(name: string, joinedAtUtc: string, department = 'Assembly') {
    at(joinedAtUtc);
    return String(await t.run((ctx) => ctx.db.insert('workers', { name, department, active: true, enrolledAt: joinedAtUtc })));
  }
  async function punch(workerId: string, eventType: 'clock_in' | 'clock_out', timestamp: string) {
    return t.run((ctx) => ctx.db.insert('attendance', { workerId, eventType, timestamp, synced: true }));
  }
  async function load(day = date) {
    const [briefing, exceptions, closeout] = await Promise.all([
      admin.query(api.shiftBriefing.summary, { date: day }),
      admin.query(api.shiftExceptions.summary, { date: day }),
      admin.query(api.shiftCloseouts.get, { date: day }),
    ]);
    // The briefing and the exception queue must always agree on who is missing.
    const briefingMissing = briefing.workers.filter((row: any) => row.status === 'missing').map((row: any) => row.worker_id).sort();
    const exceptionMissing = exceptions.exceptions.filter((row: any) => row.type === 'missing_arrival').map((row: any) => row.worker_id).sort();
    expect(briefingMissing).toEqual(exceptionMissing);
    return { briefing, exceptions: exceptions.exceptions as any[], closeout };
  }
  return { t, admin, userId: ids.userId, avery: ids.avery, addWorker, punch, load };
}

function exceptionTypes(exceptions: any[], workerId: string) {
  return exceptions.filter((row) => row.worker_id === workerId).map((row) => row.type).sort();
}

function rowOf(briefing: any, workerId: string) {
  return briefing.workers.find((row: any) => row.worker_id === workerId);
}

function enrollmentRiskIds(briefing: any) {
  const brief = briefing.shift_trust_brief;
  return [...brief.readiness_blockers, ...brief.closeout_risks].map((risk: any) => risk.id).filter((id: string) => id.includes('face-data'));
}

describe('shift builders judge a date only against workers on its roster', () => {
  afterEach(() => vi.useRealTimers());

  it('ignores workers added after the date and leaves its closeout blocker evidence byte-equal', async () => {
    const { avery, addWorker, load } = await fixture();
    at('2026-09-04T14:00:00Z'); // D+1 09:00 Central
    const before = await load();
    expect(exceptionTypes(before.exceptions, avery)).toEqual(['missing_arrival']);

    const nova = await addWorker('Nova', '2026-09-04T14:00:00Z');
    const quinn = await addWorker('Quinn', '2026-09-04T14:00:00Z', 'No schedule');
    const after = await load();

    for (const id of [nova, quinn]) {
      expect(rowOf(after.briefing, id)).toBeUndefined();
      expect(exceptionTypes(after.exceptions, id)).toEqual([]);
    }
    expect(after.briefing.summary).toEqual(before.briefing.summary);
    expect(after.briefing.daily_attendance).toEqual(before.briefing.daily_attendance);
    expect(after.briefing.departments).toEqual(before.briefing.departments);
    expect(after.briefing.schedule_assignment_warnings).toEqual([]);
    expect(after.briefing.coverage_evidence).toEqual([]);
    expect(enrollmentRiskIds(after.briefing)).toEqual([]);
    expect(after.closeout.blocker_evidence).toBe(before.closeout.blocker_evidence);

    // Quinn has no schedule to compare, so joins D+1's roster; Nova joined
    // after D+1's start and is first expected on D+2.
    const nextDay = await load('2026-09-04');
    expect(rowOf(nextDay.briefing, nova)).toBeUndefined();
    expect(nextDay.briefing.coverage_evidence.map((row: any) => row[0])).toEqual([quinn]);
    expect(enrollmentRiskIds(nextDay.briefing)).toContain('closeout:missing-face-data');
    expect(rowOf((await load('2026-09-05')).briefing, nova)?.status).toBe('not_yet_due');
  });

  it('omits a worker added during the shift until the door records them, then skips arrival checks only', async () => {
    const { avery, addWorker, punch, load } = await fixture();
    const nova = await addWorker('Nova', '2026-09-03T19:00:00Z'); // 14:00 Central
    at('2026-09-03T19:10:00Z');
    const omitted = await load();
    expect(rowOf(omitted.briefing, nova)).toBeUndefined();
    expect(exceptionTypes(omitted.exceptions, nova)).toEqual([]);
    expect(exceptionTypes(omitted.exceptions, avery)).toEqual(['missing_arrival']);
    expect(enrollmentRiskIds(omitted.briefing)).toEqual([]);

    await punch(nova, 'clock_in', `${DATE}T14:30:00`);
    at('2026-09-03T19:45:00Z');
    const present = await load();
    expect(rowOf(present.briefing, nova)?.status).toBe('present');
    expect(present.briefing.summary).toMatchObject({ expected: omitted.briefing.summary.expected + 1, present: 1, late: 0 });
    expect(present.briefing.daily_attendance).toMatchObject({ expected: 2, present: 1, late: 0, missing: 1 });
    expect(exceptionTypes(present.exceptions, nova)).toEqual([]);
    expect(enrollmentRiskIds(present.briefing)).toContain('closeout:missing-face-data');

    at('2026-09-03T20:45:00Z'); // 15:45 Central, after the scheduled end
    const ended = await load();
    expect(exceptionTypes(ended.exceptions, nova)).toEqual(['missing_clock_out']);
  });

  it('shows a clock-out-only worker added during the shift as clocked out, not missing or attended', async () => {
    const { t, addWorker, punch, load } = await fixture();
    const kiosk = await addWorker('Kiosk Kim', '2026-09-03T19:00:00Z');
    const corrected = await addWorker('Corrected Cam', '2026-09-03T19:00:00Z');
    await punch(kiosk, 'clock_out', `${DATE}T15:30:00`);
    await t.run((ctx) => ctx.db.insert('attendanceCorrections', {
      date: DATE, workerId: corrected, action: 'add_clock_out', eventType: 'clock_out',
      correctedTimestamp: `${DATE}T15:30:00`, reason: 'Forgot to scan', createdAt: '2026-09-03T21:00:00Z', updatedAt: '2026-09-03T21:00:00Z',
    }));
    at('2026-09-03T21:00:00Z');
    const { briefing, exceptions } = await load();
    for (const id of [kiosk, corrected]) {
      expect(rowOf(briefing, id)?.status).toBe('clocked_out');
      expect(exceptionTypes(exceptions, id)).toEqual(['scan_sequence']);
    }
    expect(briefing.daily_attendance).toMatchObject({ expected: 3, present: 0, late: 0, missing: 1 });
  });

  it('keeps arrival checks for workers added before the start, including at the start minute', async () => {
    const { addWorker, punch, load } = await fixture();
    const early = await addWorker('Early', '2026-09-03T11:00:00Z'); // 06:00 Central
    const late = await addWorker('Late', '2026-09-03T11:30:00Z');
    const onTheMinute = await addWorker('On the minute', '2026-09-03T12:00:30Z'); // 07:00:30 Central
    await punch(late, 'clock_in', `${DATE}T07:45:00`);
    at('2026-09-03T13:00:00Z');
    const { exceptions } = await load();
    expect(exceptionTypes(exceptions, early)).toEqual(['missing_arrival']);
    expect(exceptionTypes(exceptions, onTheMinute)).toEqual(['missing_arrival']);
    expect(exceptions.find((row) => row.worker_id === late)).toMatchObject({ type: 'late_arrival', severity: 'critical' });
  });

  it('does not count evidence on neighbouring dates, voided scans or reversed added punches', async () => {
    const { t, userId, addWorker, punch, load } = await fixture();
    const neighbour = await addWorker('Neighbour', '2026-09-03T19:00:00Z');
    const voided = await addWorker('Voided', '2026-09-03T19:00:00Z');
    const reversed = await addWorker('Reversed', '2026-09-03T19:00:00Z');
    await punch(neighbour, 'clock_in', '2026-09-02T23:00:00');
    await punch(neighbour, 'clock_in', '2026-09-04T06:55:00');
    const scan = await punch(voided, 'clock_in', `${DATE}T14:30:00`);
    await t.run(async (ctx) => {
      const base = { date: DATE, reason: 'Wrong person', createdAt: '2026-09-03T20:00:00Z', updatedAt: '2026-09-03T20:00:00Z' };
      await ctx.db.insert('attendanceCorrections', { ...base, workerId: voided, action: 'void_event', originalAttendanceId: scan });
      const added = await ctx.db.insert('attendanceCorrections', {
        ...base, workerId: reversed, action: 'add_clock_in', eventType: 'clock_in', correctedTimestamp: `${DATE}T14:30:00`,
      });
      await ctx.db.insert('attendanceCorrectionReversals', {
        correctionId: added, requestId: 'undo', date: DATE, workerId: reversed, reason: 'Wrong worker', actorUserId: userId, createdAt: '2026-09-03T20:05:00Z',
      });
    });
    at('2026-09-04T12:30:00Z');
    const { briefing, exceptions } = await load();
    for (const id of [neighbour, voided, reversed]) {
      expect(rowOf(briefing, id)).toBeUndefined();
      expect(exceptionTypes(exceptions, id)).toEqual([]);
    }
  });

  it('rejects stale reviews and one-tap corrections for removed missing arrivals but keeps direct corrections', async () => {
    const { admin, addWorker, load } = await fixture();
    const nova = await addWorker('Nova', '2026-09-03T19:00:00Z');
    at('2026-09-03T19:10:00Z');
    const key = `${DATE}:missing_arrival:${nova}`;
    await expect(admin.mutation(api.shiftExceptions.review, {
      exceptionKey: key, sourceFingerprint: 'pre-deploy', date: DATE, type: 'missing_arrival', status: 'reviewed',
    })).rejects.toThrow(/no longer matches/);
    const correction = {
      requestId: 'one-tap', date: DATE, workerId: nova as any, action: 'add_clock_in' as const,
      correctedTimestamp: `${DATE}T07:00:00`, reason: 'Started before enrollment',
    };
    await expect(admin.mutation(api.attendanceCorrections.create, {
      ...correction, relatedExceptionKey: key, sourceFingerprint: 'pre-deploy',
    })).rejects.toThrow(/no longer correctable/);

    await admin.mutation(api.attendanceCorrections.create, { ...correction, requestId: 'direct' });
    const { briefing, exceptions } = await load();
    expect(rowOf(briefing, nova)?.status).toBe('present');
    expect(exceptionTypes(exceptions, nova)).toEqual([]);
  });

  it('compares a join in the repeated fall-back hour by instant', async () => {
    const day = '2026-11-01';
    const { addWorker, load } = await fixture(day, { startTime: '01:30', endTime: '05:00' });
    const beforeStart = await addWorker('First 01:20 CDT', '2026-11-01T06:20:00Z');
    const afterFirst = await addWorker('First 01:45 CDT', '2026-11-01T06:45:00Z');
    const afterRepeat = await addWorker('Repeated 01:20 CST', '2026-11-01T07:20:00Z');
    at('2026-11-01T11:30:00Z');
    const { briefing } = await load(day);
    expect(rowOf(briefing, beforeStart)?.status).toBe('missing');
    expect(rowOf(briefing, afterFirst)).toBeUndefined();
    expect(rowOf(briefing, afterRepeat)).toBeUndefined();
  });

  it('compares a join with a skipped spring-forward start by factory wall time', async () => {
    const day = '2026-03-08';
    const { addWorker, load } = await fixture(day, { startTime: '02:30', endTime: '06:00' });
    const beforeStart = await addWorker('01:45 CST', '2026-03-08T07:45:00Z');
    const afterStart = await addWorker('03:10 CDT', '2026-03-08T08:10:00Z');
    at('2026-03-08T12:00:00Z');
    const { briefing } = await load(day);
    expect(rowOf(briefing, beforeStart)?.status).toBe('missing');
    expect(rowOf(briefing, afterStart)).toBeUndefined();
  });
});
