import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { api } from '../../../convex/_generated/api';

const mocks = vi.hoisted(() => ({ query: vi.fn(), authorized: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: { query: mocks.query } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: mocks.authorized }));
import { GET as getWorkers } from './workers/route';
import { GET as getDirectory } from './employee-directory/route';

const reads = [
  { path: 'workers?id=worker', handler: getWorkers, roles: ['admin', 'enrollment'], error: 'Failed to load workers', log: 'Workers GET error:' },
  { path: 'workers?scope=dashboard', handler: getWorkers, roles: ['admin', 'enrollment', 'viewer'], error: 'Failed to load workers', log: 'Workers GET error:' },
  { path: 'workers', handler: getWorkers, roles: ['admin'], error: 'Failed to load workers', log: 'Workers GET error:' },
  { path: 'employee-directory', handler: getDirectory, roles: ['admin', 'enrollment'], error: 'Failed to load employee directory', log: 'Employee directory GET error:' },
];
const request = (path: string) => new NextRequest(`https://example.test/api/${path}`);
const worker = {
  id: 'worker', name: 'Synthetic Worker', employee_id: 'S-1', identity_revision: 'revision',
  department: 'Sales', photo_url: '/photo', has_face_encoding: true,
  encoding_status: 'valid', enrolled_at: '2026-10-30T08:00:00Z', active: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.authorized.mockResolvedValue(true);
  mocks.query.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe.each(reads)('$path', read => {
  it.each(['transport', 'structured'])('returns a safe JSON 500 for a %s read failure', async kind => {
    const privatePayload = { faceEncoding: [0.987654321], authorization: 'Bearer PRIVATE_TOKEN', photos: ['PRIVATE_PHOTO'] };
    const error = kind === 'structured'
      ? new ConvexError(privatePayload)
      : new Error(`[Request ID: aabbccdd11223344] Server Error\nArgumentValidationError: ${JSON.stringify(privatePayload)}`);
    mocks.query.mockRejectedValueOnce(error);

    const response = await read.handler(request(read.path));
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: read.error });
    expect(console.error).toHaveBeenCalledWith(read.log, expect.objectContaining({ type: kind === 'structured' ? 'ConvexError' : 'Error' }));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/PRIVATE_|faceEncoding|0\.987654321|ArgumentValidationError/);
  });

  it.each(['admin', 'enrollment', 'viewer', 'anonymous'])('preserves access for %s', async role => {
    mocks.authorized.mockImplementation(async (_req: NextRequest, roles: string[]) => roles.includes(role));
    mocks.query.mockResolvedValue(read.path.includes('?id=') ? worker : []);
    const req = request(read.path);
    const response = await read.handler(req);
    expect(mocks.authorized).toHaveBeenCalledExactlyOnceWith(req, read.roles);
    if (read.roles.includes(role)) {
      expect(response.status).toBe(200);
      expect(mocks.query).toHaveBeenCalledTimes(1);
    } else {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
      expect(mocks.query).not.toHaveBeenCalled();
    }
    expect(console.error).not.toHaveBeenCalled();
  });
});

it.each([
  { path: 'workers?id=worker', args: { id: 'worker' }, single: true, revision: true },
  { path: 'workers?scope=dashboard', args: { includeEncodings: false }, single: false, revision: false },
  { path: 'workers', args: { includeEncodings: false, active: true }, single: false, revision: true },
  { path: 'workers?active=false', args: { includeEncodings: false, active: false }, single: false, revision: true },
])('preserves successful query and response for $path', async ({ path, args, single, revision }) => {
  const upstream = { ...worker, face_encoding: [0.987654321], private_field: 'PRIVATE' };
  mocks.query.mockResolvedValueOnce(single ? upstream : [upstream]);
  const response = await getWorkers(request(path));
  expect(response.status).toBe(200);
  expect(mocks.query).toHaveBeenCalledExactlyOnceWith(single ? api.workers.get : api.workers.list, args);
  const expected: Record<string, unknown> = { ...worker };
  if (!revision) delete expected.identity_revision;
  expect(await response.json()).toEqual(single ? expected : [expected]);
});

it('preserves the worker-not-found JSON 404', async () => {
  mocks.query.mockResolvedValueOnce(null);
  const response = await getWorkers(request('workers?id=missing'));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Worker not found' });
  expect(console.error).not.toHaveBeenCalled();
});

it('keeps ID read permissions when dashboard scope is also supplied', async () => {
  mocks.authorized.mockResolvedValueOnce(false);
  const req = request('workers?id=worker&scope=dashboard');
  expect((await getWorkers(req)).status).toBe(401);
  expect(mocks.authorized).toHaveBeenCalledExactlyOnceWith(req, ['admin', 'enrollment']);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('preserves directory filtering and summary on a successful roster read', async () => {
  mocks.query.mockResolvedValueOnce([worker]);
  const response = await getDirectory(request('employee-directory?q=S-1&status=enrolled'));
  expect(response.status).toBe(200);
  expect(mocks.query).toHaveBeenCalledExactlyOnceWith(api.workers.list, { includeEncodings: false });
  expect(await response.json()).toEqual({
    suggestions: [{ name: 'Amanda Bonapace', employeeId: 'S-1', department: 'Sales', status: 'enrolled', workerId: 'worker' }],
    summary: { total: expect.any(Number), enrolled: 1, remaining: expect.any(Number), invalid: 0 },
  });
});
