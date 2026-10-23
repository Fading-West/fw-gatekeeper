import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), action: vi.fn(), authorized: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: mocks }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: mocks.authorized }));
import { POST as registerKiosk } from './kiosks/route';
import { POST as correct } from './attendance-corrections/route';
import { POST as enroll } from './enroll/route';
import { PATCH as reviewException } from './shift-exceptions/route';
import { PATCH as reviewRecognition } from './recognition-attempts/route';

const routes = [
  { path: 'kiosks', method: 'POST', handler: registerKiosk },
  { path: 'attendance-corrections', method: 'POST', handler: correct },
  { path: 'enroll', method: 'POST', handler: enroll },
  { path: 'shift-exceptions', method: 'PATCH', handler: reviewException },
  { path: 'recognition-attempts', method: 'PATCH', handler: reviewRecognition },
];
const bodies = ['null', '"text"', '42', 'not json'];

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.authorized.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

function request(path: string, method: string, body: string) {
  return new NextRequest(`https://example.test/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body });
}

it.each(routes.flatMap(route => bodies.map(body => ({ ...route, body }))))('$method /api/$path rejects body $body with 400', async ({ path, method, handler, body }) => {
  const response = await handler(request(path, method, body));
  expect(response.status).toBe(400);
  expect(mocks.mutation).not.toHaveBeenCalled();
});

it.each([
  { name: 123, type: 'entry' },
  { name: 'Gate', type: 'entry', kiosk_id: 7 },
  { name: 'Gate', type: 'entry', location: { building: 'A' } },
])('POST /api/kiosks rejects non-text fields %j with 400 before calling Convex', async body => {
  const response = await registerKiosk(request('kiosks', 'POST', JSON.stringify(body)));
  expect(response.status).toBe(400);
  expect(mocks.mutation).not.toHaveBeenCalled();
});

it('POST /api/kiosks still registers a valid kiosk', async () => {
  mocks.mutation.mockResolvedValue({ id: 'kiosk' });
  const response = await registerKiosk(request('kiosks', 'POST', JSON.stringify({ name: 'Gate', type: 'entry', kiosk_id: 'gate', location: null })));
  expect(response.status).toBe(201);
  expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), { name: 'Gate', kioskId: 'gate', type: 'entry', location: undefined });
});
