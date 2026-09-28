/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

it('pages past 1,000 workers and includes a later deactivation in incremental sync', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let index = 0; index < 1005; index++) {
      await ctx.db.insert('workers', {
        name: `Worker ${index}`, department: 'Operations',
        enrolledAt: index === 1003 ? '2026-09-25T00:00:00Z' : '2026-09-01T00:00:00Z',
        ...(index === 1003 ? {} : { updatedAt: index === 1004 ? '2026-09-26T00:00:00Z' : '2026-09-01T00:00:00Z' }),
        active: index !== 1004,
      });
    }
  });

  async function collect(since?: string) {
    const workers = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await t.query(internal.workers.listForSyncFromHttp, { since, inclusive: true, cursor });
      workers.push(...page.workers);
      pages += 1;
      if (page.isDone) return { workers, pages };
      cursor = page.continueCursor;
    } while (pages < 20);
    throw new Error('Worker sync pagination did not finish');
  }

  const full = await collect();
  expect(full.workers).toHaveLength(1005);
  expect(full.pages).toBeGreaterThan(5);
  const incremental = await collect('2026-09-20T00:00:00Z');
  expect(incremental.workers).toHaveLength(2);
  expect(incremental.workers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Worker 1003', updated_at: '2026-09-25T00:00:00Z' }),
    expect.objectContaining({ name: 'Worker 1004', active: 0 }),
  ]));
  expect(incremental.pages).toBeLessThanOrEqual(3);
});

it('continues across multiple indexed change pages before legacy rows', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (let index = 0; index < 405; index++) {
      await ctx.db.insert('workers', { name: `Changed ${index}`, department: '', active: true,
        enrolledAt: '2026-09-01T00:00:00Z', updatedAt: index < 205 ? '2026-09-26T00:00:00Z' : '2026-09-01T00:00:00Z' });
    }
    await ctx.db.insert('workers', { name: 'Legacy recent', department: '', active: true,
      enrolledAt: '2026-09-26T00:00:00Z' });
  });
  const names: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await t.query(internal.workers.listForSyncFromHttp, {
      since: '2026-09-20T00:00:00Z', inclusive: true, cursor,
    });
    names.push(...page.workers.map(worker => worker.name));
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect(names).toHaveLength(206);
  expect(new Set(names).size).toBe(206);
  expect(names).toContain('Legacy recent');
});
