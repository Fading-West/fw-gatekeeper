import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock('@/lib/convex-ingest', async (original) => ({ ...await original<typeof import('@/lib/convex-ingest')>(), ingestRecognitionAttemptBatch: mocks.ingest }));
vi.mock('@/lib/kiosk-device-auth', () => ({ authenticateKiosk: async () => ({ kioskId: 'synthetic' }), kioskClaims: () => [], kioskEvidenceId: () => 'synthetic' }));
import { SecuredIngestError } from '@/lib/convex-ingest';
import { POST } from './route';
it('preserves the explicit permanent validation code through the Next API', async () => {
  mocks.ingest.mockRejectedValue(new SecuredIngestError(400, 'INVALID_RECOGNITION_METRIC', 'Synthetic rejected evidence'));
  const response = await POST(new NextRequest('https://synthetic.test/api/recognition-attempts/bulk', { method: 'POST', body: JSON.stringify({ attempts: [{ timestamp: '2026-10-01T08:00:00', threshold: .45, decision: 'near_miss' }] }) }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'INVALID_RECOGNITION_METRIC' });
});
