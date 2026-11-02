/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-10-01';

async function setup() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const userId = await t.run(async ctx => {
    const id = await ctx.db.insert('users', { email: 'worker-joins@example.invalid' });
    await ctx.db.insert('portalMembers', { userId: id, role: 'viewer', active: true, createdAt: date });
    return id;
  });
  return { t, actor: t.withIdentity({ subject: userId }) };
}

it.each([false, true])('retains payroll identifiers for 700 workers with breaks (templates: %s)', async templates => {
  const { t, actor } = await setup();
  // Entry, a short break, lunch, and the final exit: six ordinary punches.
  // Templates make repeated full-worker reads consume the byte budget too.
  const times = ['08:00', '10:00', '10:15', '12:00', '12:30', '17:00'];
  for (let batch = 0; batch < 700; batch += 100) await t.run(async ctx => {
    for (let i = batch; i < batch + 100; i++) {
      const workerId = await ctx.db.insert('workers', {
        name: `Worker ${i}`, employeeId: `E-${i}`, department: 'QA', active: true, enrolledAt: date,
        ...(templates ? { faceEncoding: Array(512).fill(0.125) } : {}),
      });
      for (const [index, time] of times.entries()) await ctx.db.insert('attendance', {
        workerId, workerName: `Worker ${i}`, eventType: index % 2 ? 'clock_out' : 'clock_in',
        synced: true, timestamp: `${date}T${time}:00`,
      });
    }
  });
  const rows = await actor.query(api.attendance.list, { date });
  expect(rows).toHaveLength(4200);
  expect(rows.filter(row => !row.worker_employee_id || row.worker_department !== 'QA')).toHaveLength(0);
}, 60_000);

it('keeps legacy missing/malformed worker fallbacks from exhausting unrelated joins', async () => {
  const { t, actor } = await setup();
  const { present, missing } = await t.run(async ctx => {
    const fields = { name: 'Present', employeeId: 'E-PRESENT', department: 'QA', active: true, enrolledAt: date };
    const present = await ctx.db.insert('workers', fields);
    const missing = await ctx.db.insert('workers', { ...fields, name: 'Deleted' });
    await ctx.db.delete(missing);
    await ctx.db.insert('attendance', { workerId: present, eventType: 'clock_in', timestamp: `${date}T07:00:00`, synced: true });
    await ctx.db.insert('attendance', { workerId: 'malformed-legacy-id', workerName: 'Legacy', eventType: 'clock_in', timestamp: `${date}T07:30:00`, synced: true });
    return { present, missing };
  });
  // Missing references are possible in imported history. Their null result
  // must be shared too, rather than consuming every range before other joins.
  for (let batch = 0; batch < 4200; batch += 100) await t.run(async ctx => {
    for (let i = batch; i < batch + 100; i++) await ctx.db.insert('attendance', {
      workerId: missing, workerName: 'Historical', eventType: 'clock_in',
      timestamp: `${date}T08:00:00.${String(i).padStart(4, '0')}`, synced: true,
    });
  });
  const rows = await actor.query(api.attendance.list, { date });
  expect(rows).toHaveLength(4202);
  expect(rows.find(row => row.worker_id === present)).toMatchObject({ worker_name: 'Present', worker_department: 'QA', worker_employee_id: 'E-PRESENT' });
  expect(rows.find(row => row.worker_id === 'malformed-legacy-id')).toMatchObject({ worker_name: 'Legacy', worker_department: '', worker_employee_id: null });
  expect(rows.filter(row => row.worker_id === missing)).toHaveLength(4200);
  expect(rows.filter(row => row.worker_id === missing).every(row => row.worker_name === 'Historical' && row.worker_employee_id === null)).toBe(true);
}, 60_000);
