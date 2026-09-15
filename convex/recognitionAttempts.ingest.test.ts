/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
const modules = import.meta.glob('./**/*.ts');
const attempt = { sourceAttemptId: 'uuid-before-reset', kioskId: 'entry-1', timestamp: '2026-09-14T08:00:00', faceDetected: true, decision: 'matched', threshold: 0.3, bestScore: 0.8 };
const setup = () => convexTest(schema, modules);
const ingest = (t: ReturnType<typeof setup>, attempts: (typeof attempt & { legacySourceAttemptId?: string })[]) => t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts });
afterEach(() => vi.unstubAllEnvs());
it('acknowledges retries and preserves distinct UUIDs after a database reset', async () => {
  const t = setup();
  expect(await ingest(t, [attempt, attempt])).toMatchObject({ ingested: 1, skipped: 1 });
  expect(await ingest(t, [attempt])).toMatchObject({ ingested: 0, skipped: 1 });
  expect(await ingest(t, [{ ...attempt, sourceAttemptId: 'uuid-after-reset' }])).toMatchObject({ ingested: 1 });
  expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(2);
});
it.each(['timestamp', 'kioskId', 'decision', 'bestScore', 'threshold'] as const)('rejects conflicting %s without committing a partial batch', async field => {
  const t = setup();
  await ingest(t, [attempt]);
  const conflict = { ...attempt, [field]: typeof attempt[field] === 'number' ? 0.5 : 'changed' };
  await expect(ingest(t, [{ ...attempt, sourceAttemptId: 'new' }, conflict])).rejects.toThrow('different evidence');
  expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(1);
});
it('rejects conflicting evidence within the first batch', async () => {
  const t = setup();
  await expect(ingest(t, [attempt, { ...attempt, decision: 'unknown' }])).rejects.toThrow('different evidence');
  expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(0);
});
it('adopts a lost-ack legacy upload while preserving review and old-client retries', async () => {
  const t = setup();
  const old = { ...attempt, sourceAttemptId: 'entry-1:1' };
  const first = await ingest(t, [old]);
  await t.run(ctx => ctx.db.patch(first.ids[0], { reviewed: true, reviewedNote: 'Checked', reviewedAt: '2026-09-15T00:00:00Z' }));
  expect(await ingest(t, [{ ...attempt, legacySourceAttemptId: old.sourceAttemptId }])).toMatchObject({ ingested: 0, skipped: 1 });
  expect(await ingest(t, [attempt, old])).toMatchObject({ ingested: 0, skipped: 2 });
  const rows = await t.run(ctx => ctx.db.query('recognitionAttempts').collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sourceAttemptId: attempt.sourceAttemptId, reviewed: true, reviewedNote: 'Checked' });
});
it('does not discard a migrated row whose legacy ID collided after reset', async () => {
  const t = setup();
  await ingest(t, [{ ...attempt, sourceAttemptId: 'entry-1:1' }]);
  expect(await ingest(t, [{ ...attempt, timestamp: '2026-09-15T08:00:00', legacySourceAttemptId: 'entry-1:1' }])).toMatchObject({ ingested: 1 });
  expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(2);
});
it('returns HTTP 409 for conflicting evidence through authenticated ingest', async () => {
  const t = setup();
  vi.stubEnv('CONVEX_INGEST_KEY', 'recognition-test-secret');
  await ingest(t, [attempt]);
  const response = await t.fetch('/api/ingest/recognition-attempts/bulk', { method: 'POST', headers: { authorization: 'Bearer recognition-test-secret', 'content-type': 'application/json' }, body: JSON.stringify({ attempts: [{ ...attempt, decision: 'unknown' }] }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'RECOGNITION_ATTEMPT_CONFLICT' });
});
