/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../../convex/schema';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { PATCH } from './route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn(), query: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
const date = '2026-09-10';
const exceptionKey = `${date}:missing_arrival:worker`;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
});

async function setup() {
  const t = convexTest(schema, modules);
  const { userId, id } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'exceptions@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const id = await ctx.db.insert('exceptionReviews', {
      exceptionKey, date, type: 'missing_arrival', status: 'open', note: 'Existing note', updatedAt: date,
    });
    return { userId, id };
  });
  const actor = t.withIdentity({ subject: userId });
  // Match Convex HTTP serialization: undefined fields disappear on the wire.
  vi.mocked(convex.mutation).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    return actor.mutation(ref, JSON.parse(JSON.stringify(args)));
  });
  const patch = (fields: Record<string, unknown>) => PATCH(new NextRequest('https://example.test/api/shift-exceptions', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exception_key: exceptionKey, date, type: 'missing_arrival', status: 'reviewed', ...fields }),
  }));
  return { t, id, patch };
}

it.each(['', '   '])('clears the saved note when it is explicitly sent as %j', async note => {
  const { t, id, patch } = await setup();
  const res = await patch({ note });
  expect(res.status).toBe(200);
  expect(await res.json()).not.toHaveProperty('note');
  const saved = await t.run(ctx => ctx.db.get(id));
  expect(saved).not.toHaveProperty('note');
  expect(saved).toMatchObject({ status: 'reviewed' });
});

it('preserves the saved note when the note is omitted', async () => {
  const { t, id, patch } = await setup();
  const res = await patch({ status: 'resolved' });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ note: 'Existing note' });
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'resolved', note: 'Existing note' });
});

it('saves a new trimmed note', async () => {
  const { t, id, patch } = await setup();
  const res = await patch({ note: '  Supervisor confirmed  ' });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ note: 'Supervisor confirmed' });
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ note: 'Supervisor confirmed' });
});

it.each([null, 42, { text: 'note' }])('rejects a non-string note %j without changing the review', async note => {
  const { t, id, patch } = await setup();
  const res = await patch({ note });
  expect(res.status).toBe(400);
  expect(convex.mutation).not.toHaveBeenCalled();
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'open', note: 'Existing note' });
});
