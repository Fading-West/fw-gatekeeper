/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-01';

async function fixture(scans: Array<[string, 'clock_in' | 'clock_out']>) {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'supervisor@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: `${date}T00:00:00Z` });
    const workerId = await ctx.db.insert('workers', { name: 'Example', department: 'Assembly', active: true, enrolledAt: `${date}T00:00:00Z`, faceEncoding: Array(512).fill(0.1) });
    await ctx.db.insert('schedules', { name: 'Shift', department: 'Assembly', days: '[0,1,2,3,4,5,6]', startTime: '08:00', endTime: '17:00', active: true, createdAt: `${date}T00:00:00Z` });
    for (const [time, eventType] of scans) {
      await ctx.db.insert('attendance', { workerId, eventType, timestamp: `${date}T${time}:00`, synced: true });
    }
    return userId;
  });
  return t.withIdentity({ subject: userId }).query(api.shiftBriefing.summary, { date });
}

const coverageActions = (briefing: any) => briefing.action_items.filter((item: any) => item.id.startsWith('coverage:'));

describe('department coverage after workers clock out', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Default to after the selected shift; mid-shift cases override this clock.
    vi.setSystemTime(new Date('2026-09-01T22:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not mark a finished, fully clocked-out shift as critical', async () => {
    const briefing = await fixture([['07:55', 'clock_in'], ['17:05', 'clock_out']]);
    expect(briefing.summary).toMatchObject({ expected: 1, present: 0, missing: 0, late: 0, clocked_out: 1, critical_actions: 0 });
    expect(briefing.departments[0]).toMatchObject({ department: 'Assembly', clocked_out: 1, status: 'covered' });
    expect(coverageActions(briefing)).toEqual([]);
  });

  it('keeps a department critical when nobody arrived', async () => {
    const briefing = await fixture([]);
    expect(briefing.summary).toMatchObject({ expected: 1, present: 0, missing: 1 });
    expect(briefing.departments[0].status).toBe('critical');
    expect(coverageActions(briefing)).toContainEqual(expect.objectContaining({ priority: 'critical', label: 'Assembly coverage critical' }));
  });

  it('keeps a department critical when everyone left early while the shift is still running', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2026-09-01T17:00:00Z is 12:00 in America/Chicago, inside the 08:00-17:00 shift.
    vi.setSystemTime(new Date('2026-09-01T17:00:00.000Z'));
    const briefing = await fixture([['07:55', 'clock_in'], ['11:00', 'clock_out']]);
    expect(briefing.summary).toMatchObject({ expected: 1, present: 0, missing: 0, clocked_out: 1 });
    expect(briefing.departments[0].status).toBe('critical');
    expect(coverageActions(briefing)).toContainEqual(expect.objectContaining({
      priority: 'critical',
      href: expect.stringContaining('status=clocked_out'),
    }));
  });

  it('clears the early-leave critical once the scheduled end has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2026-09-01T22:30:00Z is 17:30 in America/Chicago, after the 17:00 end.
    vi.setSystemTime(new Date('2026-09-01T22:30:00.000Z'));
    const briefing = await fixture([['07:55', 'clock_in'], ['11:00', 'clock_out']]);
    expect(briefing.departments[0].status).toBe('covered');
    expect(coverageActions(briefing)).toEqual([]);
  });
});
