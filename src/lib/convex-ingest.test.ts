import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ingestAttendanceBatch, SecuredIngestError } from './convex-ingest';

beforeEach(() => {
  vi.stubEnv('CONVEX_INGEST_URL', 'https://example.convex.site');
  vi.stubEnv('CONVEX_INGEST_KEY', 'test-key');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('keeps the Convex attendance validation code and reason across the secured ingest hop', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    code: 'INVALID_ATTENDANCE',
    error: 'workerId must identify an existing worker',
  }, { status: 400 })));
  await expect(ingestAttendanceBatch([])).rejects.toMatchObject({
    status: 400,
    code: 'INVALID_ATTENDANCE',
    detail: 'workerId must identify an existing worker',
  } satisfies Partial<SecuredIngestError>);
});

it('does not invent a validation code for an unrelated upstream error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Bad Request' }, { status: 400 })));
  await expect(ingestAttendanceBatch([])).rejects.toMatchObject({ status: 400, code: undefined });
});
