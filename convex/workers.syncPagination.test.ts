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
        enrolledAt: '2026-09-01T00:00:00Z',
        updatedAt: index === 1004 ? '2026-09-26T00:00:00Z' : '2026-09-01T00:00:00Z',
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
  expect(incremental.workers).toHaveLength(1);
  expect(incremental.workers[0]).toMatchObject({ name: 'Worker 1004', active: 0 });
  expect(incremental.pages).toBeGreaterThan(5);
});
