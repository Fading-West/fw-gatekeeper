/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

// convex-test stamps _creationTime from Date.now(); workers join the roster at
// `timestamp`, before the evaluated shift starts (see docs/roster-membership.md).
async function joinedAt<T>(timestamp: string, seed: () => Promise<T>) {
  const now = vi.isFakeTimers() ? Date.now() : null;
  if (now === null) vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(timestamp));
  try { return await seed(); } finally { if (now === null) vi.useRealTimers(); else vi.setSystemTime(now); }
}

async function fixture(date: string, endTime: string, absentWorker = false) {
  const t = convexTest(schema, modules);
  const userId = await joinedAt(`${date}T00:00:00Z`, () => t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'coverage@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', {
      name: 'Early shift worker', department: 'Assembly', active: true,
      enrolledAt: date, faceEncoding: Array(512).fill(0.1),
    });
    if (absentWorker) await ctx.db.insert('workers', {
      name: 'Absent worker', department: 'Assembly', active: true,
      enrolledAt: date, faceEncoding: Array(512).fill(0.1),
    });
    await ctx.db.insert('schedules', {
      name: 'Early shift', department: 'Assembly', days: '[0]', startTime: '00:30',
      endTime, active: true, createdAt: date,
    });
    // Both punches precede the first scheduled end. Leaving early must stay
    // critical until the deadline, then remain covered after the clock rolls back.
    for (const [time, eventType] of [['00:25', 'clock_in'], ['00:55', 'clock_out']]) {
      await ctx.db.insert('attendance', { workerId, eventType, timestamp: `${date}T${time}:00`, synced: true });
    }
    return userId;
  }));
  const admin = t.withIdentity({ subject: userId });
  return { load: () => admin.query(api.shiftBriefing.summary, { date }) };
}

function at(utc: string) {
  vi.setSystemTime(new Date(utc));
}

function expectCoverage(briefing: any, status: 'covered' | 'critical') {
  expect(briefing.departments[0]).toMatchObject({ status, present: 0, clocked_out: 1 });
  const actions = briefing.action_items.filter((item: any) => item.id.startsWith('coverage:'));
  if (status === 'covered') {
    expect(actions).toEqual([]);
    expect(briefing.summary.critical_actions).toBe(0);
    expect(briefing.shift_trust_brief.primary_action).toBeNull();
  } else {
    expect(actions).toContainEqual(expect.objectContaining({ priority: 'critical', label: 'Assembly coverage critical' }));
  }
}

afterEach(() => vi.useRealTimers());

describe('department coverage uses the scheduled end instant', () => {
  it('does not reopen a finished shift during either occurrence of the fall-back hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-11-01T06:49:59Z'); // First 01:49:59 CDT.
    const { load } = await fixture('2026-11-01', '01:50');
    expectCoverage(await load(), 'critical');

    // Match the existing strict deadline: exactly the first 01:50:00 is still
    // running; one second later it has ended, using the earlier occurrence.
    at('2026-11-01T06:50:00Z');
    expectCoverage(await load(), 'critical');
    for (const utc of [
      '2026-11-01T06:50:01Z', '2026-11-01T06:59:59Z',
      '2026-11-01T07:00:00Z', '2026-11-01T07:10:00Z',
      '2026-11-01T07:50:00Z', '2026-11-01T07:50:01Z',
    ]) {
      at(utc);
      expectCoverage(await load(), 'covered');
    }
  });

  it('keeps early departure critical when the end is after the repeated hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-11-01T07:10:00Z'); // Repeated 01:10 CST, before the unique 02:30 end.
    const { load } = await fixture('2026-11-01', '02:30');
    expectCoverage(await load(), 'critical');
    at('2026-11-01T08:30:01Z');
    expectCoverage(await load(), 'covered');
  });

  it('keeps absent-worker coverage critical after the first end and during the repeated hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-11-01T06:50:01Z');
    const { load } = await fixture('2026-11-01', '01:50', true);
    for (const utc of ['2026-11-01T06:50:01Z', '2026-11-01T07:10:00Z', '2026-11-01T07:50:01Z']) {
      at(utc);
      const briefing = await load();
      expectCoverage(briefing, 'critical');
      expect(briefing.summary.missing).toBe(1);
    }
  });

  it('ends a skipped spring-forward deadline when the factory clock jumps past it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-03-08T07:59:59Z'); // 01:59:59 CST; 02:30 has no instant that day.
    const { load } = await fixture('2026-03-08', '02:30');
    expectCoverage(await load(), 'critical');
    at('2026-03-08T08:00:00Z'); // 03:00 CDT, past the skipped end.
    expectCoverage(await load(), 'covered');
  });
});
