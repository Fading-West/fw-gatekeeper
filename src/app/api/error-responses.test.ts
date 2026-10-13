import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { BIOMETRIC_CONSENT_ERROR_CODE, BIOMETRIC_CONSENT_ERROR_MESSAGE } from '@/lib/biometric-consent';

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), action: vi.fn(), authorized: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: mocks }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: mocks.authorized }));
import { POST as purge } from './workers/purge-biometrics/route';
import { POST as correct } from './attendance-corrections/route';
import { POST as enroll } from './enroll/route';
import { PATCH as closeout } from './shift-closeout/route';

const routes = [
  { path: 'workers/purge-biometrics', method: 'POST', handler: purge, body: { id: 'worker', reason: 'Retention request' }, generic: 'Failed to purge face data', log: 'Biometric purge failed:', validation: 'Worker not found' },
  { path: 'attendance-corrections', method: 'POST', handler: correct, body: { date: '2026-09-01', worker_id: 'worker', action: 'add_clock_in', corrected_timestamp: '2026-09-01T08:00:00', reason: 'Missed scan' }, generic: 'Failed to create attendance correction', log: 'Attendance corrections POST error:', validation: 'Original attendance event not found.' },
  { path: 'enroll', method: 'POST', handler: enroll, body: { name: 'Test Worker', photos: Array(3).fill('data:image/jpeg;base64,YQ=='), consent: true, consentAgeMs: 0 }, generic: 'Internal server error', log: 'Enrollment error:', validation: 'Employee must be selected from the company roster' },
  { path: 'shift-closeout', method: 'PATCH', handler: closeout, body: { date: '2026-09-01', action: 'complete' }, generic: 'Failed to update shift closeout', log: 'Shift closeout PATCH error:', validation: 'Closeout has blockers. Add an acknowledgement note before completing.' },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('FACE_SERVICE_KEY', 'test');
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [0, 1, 2] })));
  mocks.authorized.mockResolvedValue(true);
  mocks.query.mockResolvedValue(null);
  mocks.action.mockResolvedValue('photo');
  mocks.mutation.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function request(route: typeof routes[number]) {
  return new NextRequest(`https://example.test/api/${route.path}`, { method: route.method, body: JSON.stringify(route.body) });
}
function diagnostic(message: string) {
  return `[Request ID: private-request-id] Server Error\nUncaught Error: ${message}\n    at handler (convex/privateFunction.ts:42:7)\n`;
}

it.each(routes)('$path hides unexpected backend diagnostics and logs only safe metadata', async route => {
  const error = new Error(diagnostic('Database write failed with internal diagnostics'));
  mocks.mutation.mockRejectedValueOnce(error);
  const response = await route.handler(request(route));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: route.generic });
  expect(console.error).toHaveBeenCalledWith(route.log, { type: 'Error' });
});

it.each(routes)('$path keeps allowlisted legacy validation text without the diagnostic envelope', async route => {
  mocks.mutation.mockRejectedValueOnce(new Error(diagnostic(route.validation)));
  const response = await route.handler(request(route));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: route.validation });
});

it.each(routes)('$path hides unknown structured Convex errors', async route => {
  const error = new ConvexError({ code: 'UNEXPECTED_FAILURE', message: 'Private implementation details' });
  mocks.mutation.mockRejectedValueOnce(error);
  const response = await route.handler(request(route));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: route.generic });
  expect(console.error).toHaveBeenCalledWith(route.log, { type: 'ConvexError' });
});

it.each(routes)('$path does not expose unexpected errors that merely mention validation text', async route => {
  mocks.mutation.mockRejectedValueOnce(new Error(`Unexpected failure while handling: ${route.validation}`));
  const response = await route.handler(request(route));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: route.generic });
});

it.each(routes)('$path does not unwrap validation text embedded in an unrelated multiline error', async route => {
  mocks.mutation.mockRejectedValueOnce(new Error(`ArgumentValidationError: private payload\nUncaught Error: ${route.validation}\n    at internal.ts:42`));
  const response = await route.handler(request(route));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: route.generic });
});

it.each(routes)('$path does not fall back to message text for an unknown Convex data shape', async route => {
  const error = new ConvexError({ code: 'UNEXPECTED_FAILURE', photos: ['private-photo'] });
  error.message = route.validation;
  mocks.mutation.mockRejectedValueOnce(error);
  const response = await route.handler(request(route));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: route.generic });
});

it.each(routes)('$path never logs payloads, secrets, stacks or custom error properties', async route => {
  const payload = { photos: ['data:image/jpeg;base64,PRIVATE_PHOTO'], faceEncoding: [0.987654321], authorization: 'Bearer PRIVATE_TOKEN' };
  const error = Object.assign(new Error(`[Request ID: aabbccdd11223344] Server Error\nArgumentValidationError: ${JSON.stringify(payload)}`), { cause: payload, ...payload });
  mocks.mutation.mockRejectedValueOnce(error);
  const response = await route.handler(request(route));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: route.generic });
  expect(console.error).toHaveBeenCalledWith(route.log, { type: 'Error', requestId: 'aabbccdd11223344' });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/PRIVATE_|faceEncoding|0\.987654321|ArgumentValidationError/);
});

it.each(['encoding', 'upload', 'cleanup'])('enrollment %s failure logs no payloads or secrets', async stage => {
  const error = new ConvexError({ photos: ['data:image/jpeg;base64,PRIVATE_PHOTO'], secret: 'PRIVATE_TOKEN' });
  mocks.mutation.mockResolvedValue({ id: 'worker' });
  if (stage === 'encoding') vi.mocked(fetch).mockRejectedValueOnce(error);
  if (stage === 'upload') mocks.action.mockRejectedValueOnce(error);
  if (stage === 'cleanup') mocks.mutation.mockResolvedValueOnce({ id: 'worker' }).mockRejectedValueOnce(error);
  const response = await enroll(request(routes[2]));
  expect(response.status).toBe(stage === 'encoding' ? 503 : 201);
  expect(console.error).toHaveBeenCalledWith(expect.any(String), { type: 'ConvexError' });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/PRIVATE_|photos|secret/);
});

it.each([
  { route: routes[0], error: new ConvexError({ message: 'Worker not found' }), message: 'Worker not found', status: 400 },
  { route: routes[1], error: new ConvexError({ code: 'INVALID_CORRECTION_TIMESTAMP', message: 'correctedTimestamp must be on the correction date.' }), message: 'correctedTimestamp must be on the correction date.', status: 400 },
  { route: routes[1], error: new Error(diagnostic('Correction requestId was already used with different details.')), message: 'Correction requestId was already used with different details.', status: 409 },
  { route: routes[2], error: new ConvexError({ code: BIOMETRIC_CONSENT_ERROR_CODE }), message: BIOMETRIC_CONSENT_ERROR_MESSAGE, status: 400 },
  { route: routes[2], error: new Error('Worker name already exists'), message: 'Worker name already exists', status: 409 },
  { route: routes[2], error: new Error(diagnostic('Employee ID EMP123 already belongs to Test Worker')), message: 'Employee ID EMP123 already belongs to Test Worker', status: 409 },
  { route: routes[3], error: new ConvexError('Reopen the completed closeout before changing notes.'), message: 'Reopen the completed closeout before changing notes.', status: 409 },
])('$route.path preserves known validation/conflict: $message', async ({ route, error, message, status }) => {
  // Structured Convex data survives even when the Error message is redacted.
  if (error instanceof ConvexError) error.message = '[Request ID: private-request-id] Server Error';
  mocks.mutation.mockRejectedValueOnce(error);
  const response = await route.handler(request(route));
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: message });
});
