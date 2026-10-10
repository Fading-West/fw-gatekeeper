import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST as attendance } from '@/app/api/attendance/bulk/route';
import { POST as recognition } from '@/app/api/recognition-attempts/bulk/route';
import { ingestAttendanceBacklog } from './attendance-backlog';
import { ingestRecognitionAttemptBatch, lookupKioskCredential } from './convex-ingest';

vi.mock('./convex-ingest', async importOriginal => ({
  ...await importOriginal<typeof import('./convex-ingest')>(),
  lookupKioskCredential: vi.fn(), ingestRecognitionAttemptBatch: vi.fn(),
}));
vi.mock('./attendance-backlog', async importOriginal => ({
  ...await importOriginal<typeof import('./attendance-backlog')>(), ingestAttendanceBacklog: vi.fn(),
}));
const deviceKey = `gkdev_${'a'.repeat(43)}`;
const identity = { documentId: 'real-entry', kioskId: 'entry', aliases: ['entry', 'Front', 'real-entry'] };
const routes = [
  { name: 'attendance', post: attendance, field: 'logs', event: { worker_id: 'worker', action: 'clock_in', timestamp: '2026-10-01T08:00:00' } },
  { name: 'recognition', post: recognition, field: 'attempts', event: { sourceAttemptId: 'attempt', timestamp: '2026-10-01T08:00:00' } },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KIOSK_API_KEY', 'legacy-key');
  vi.mocked(lookupKioskCredential).mockResolvedValue(identity);
  vi.mocked(ingestAttendanceBacklog).mockResolvedValue({ synced: 1, acknowledged: 1 });
  vi.mocked(ingestRecognitionAttemptBatch).mockResolvedValue({ ingested: 1, skipped: 0, ids: ['attempt'] });
});
afterEach(() => vi.unstubAllEnvs());
const request = (body: unknown, key = deviceKey) => new NextRequest('http://localhost/api/bulk', {
  method: 'POST', body: JSON.stringify(body), headers: { 'x-kiosk-key': key },
});
function expectNoIngest() {
  expect(ingestAttendanceBacklog).not.toHaveBeenCalled();
  expect(ingestRecognitionAttemptBatch).not.toHaveBeenCalled();
}
for (const route of routes) {
  it(`${route.name}: rejects every mismatched row with a distinguishable denial before any ingest`, async () => {
    const response = await route.post(request({ kiosk_id: 'entry', [route.field]: [route.event, { ...route.event, kioskId: 'different-real-kiosk' }] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'KIOSK_CLAIM_MISMATCH' });
    expectNoIngest();
  });
  it(`${route.name}: invalid/revoked credentials remain 401 even with mismatched evidence`, async () => {
    vi.mocked(lookupKioskCredential).mockResolvedValue(null);
    const response = await route.post(request({ kiosk_id: 'entry', [route.field]: [{ ...route.event, kiosk_id: 'other' }] }));
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('code', 'KIOSK_CLAIM_MISMATCH');
    expectNoIngest();
  });
  it(`${route.name}: invalid shared keys remain 401`, async () => {
    expect((await route.post(request({ kiosk_id: 'entry', [route.field]: [{ ...route.event, kiosk_id: 'other' }] }, 'wrong-key'))).status).toBe(401);
    expect(lookupKioskCredential).not.toHaveBeenCalled();
    expectNoIngest();
  });
  it(`${route.name}: a wrong current configuration remains 401 rather than quarantining all current evidence`, async () => {
    const response = await route.post(request({ kiosk_id: 'other', [route.field]: [{ ...route.event, kiosk_id: 'other' }] }));
    expect(response.status).toBe(401);
    expectNoIngest();
  });
  it(`${route.name}: accepts authorized aliases and preserves the captured claim`, async () => {
    const response = await route.post(request({ kiosk_id: 'entry', [route.field]: [{ ...route.event, kiosk_id: 'Front' }] }));
    expect(response.status).toBe(route.name === 'attendance' ? 200 : 201);
    const ingest = route.name === 'attendance' ? ingestAttendanceBacklog : ingestRecognitionAttemptBatch;
    expect(vi.mocked(ingest).mock.calls[0][0][0]).toMatchObject({ kioskId: 'Front' });
  });
  it(`${route.name}: rejects a conflicting camel claim even when the snake claim is authorized`, async () => {
    const response = await route.post(request({ kiosk_id: 'entry', [route.field]: [{ ...route.event, kiosk_id: 'entry', kioskId: 'other' }] }));
    expect(response.status).toBe(403);
    expectNoIngest();
  });
  it(`${route.name}: valid legacy credentials can distinguish mismatched historical records`, async () => {
    const response = await route.post(request({ kiosk_id: 'entry', [route.field]: [{ ...route.event, kiosk_id: 'old' }] }, 'legacy-key'));
    expect(response.status).toBe(403);
    expect(lookupKioskCredential).toHaveBeenCalledWith({ mode: 'legacy', identifier: 'entry' });
    expectNoIngest();
  });
}
