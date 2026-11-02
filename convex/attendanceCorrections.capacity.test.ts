/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-14';

it('loads correction history and worker-filtered history within transaction limits on a busy day', async () => {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const { userId, workerId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'history@example.invalid' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Synthetic', department: 'QA', active: true, enrolledAt: date });
    for (let i = 0; i < 1600; i++) {
      const correctionId = await ctx.db.insert('attendanceCorrections', { date, workerId,
        action: 'add_clock_out', eventType: 'clock_out', correctedTimestamp: `${date}T17:00:00`,
        reason: `Correction ${i}`, actorUserId: userId, createdAt: date, updatedAt: date });
      if (i % 2 === 0) await ctx.db.insert('attendanceCorrectionReversals', { correctionId, date, workerId,
        reason: 'Synthetic reversal', actorUserId: userId, createdAt: date, requestId: `reverse-${i}` });
    }
    return { userId, workerId };
  });
  const actor = t.withIdentity({ subject: userId });
  for (const args of [{ date }, { date, workerId }]) {
    const rows = await actor.query(api.attendanceCorrections.list, args);
    expect(rows).toHaveLength(1600);
    expect(rows.filter(row => row.reversal_id)).toHaveLength(800);
    expect(rows[0]).toMatchObject({ worker_name: 'Synthetic', actor_name: 'history@example.invalid' });
    expect(rows.find(row => row.reversal_id)).toMatchObject({
      reversed_by_name: 'history@example.invalid', reversal_reason: 'Synthetic reversal',
    });
  }
}, 30_000);

it('loads two corrected punches for each of 700 workers within transaction limits', async () => {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const userId = await t.run(async ctx => {
    const id = await ctx.db.insert('users', { email: 'capacity@example.invalid' });
    await ctx.db.insert('portalMembers', { userId: id, role: 'admin', active: true, createdAt: date });
    return id;
  });
  for (let start = 0; start < 700; start += 100) await t.run(async ctx => {
    for (let i = start; i < start + 100; i++) {
      const workerId = await ctx.db.insert('workers', { name: `Worker ${i}`, department: 'QA', active: true, enrolledAt: date });
      for (const [action, eventType, time] of [['add_clock_in', 'clock_in', '08:00'], ['add_clock_out', 'clock_out', '17:00']] as const)
        await ctx.db.insert('attendanceCorrections', {
          date, workerId, action, eventType, correctedTimestamp: `${date}T${time}:00`,
          reason: 'Door scanner outage; supervisor verified shift', actorUserId: userId, createdAt: date, updatedAt: date,
        });
    }
  });
  const admin = t.withIdentity({ subject: userId });
  expect(await admin.query(api.attendanceCorrections.list, { date })).toHaveLength(1400);
});
