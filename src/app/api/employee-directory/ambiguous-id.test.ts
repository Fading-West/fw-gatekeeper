import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { reconcileEmployeeDirectory } from '@/lib/employee-directory';

const mocks = vi.hoisted(() => ({ query: vi.fn(), authorized: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: { query: mocks.query } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: mocks.authorized }));
import { GET } from './route';

const workers = [
  { id: 'duplicate-a', name: 'Legacy A', employeeId: 'F-2', encodingStatus: 'valid' as const },
  { id: 'duplicate-b', name: 'Legacy B', employeeId: 'f-2', encodingStatus: 'valid' as const },
  { id: 'name-only', name: 'Alex Gonzalez', encodingStatus: 'valid' as const },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorized.mockResolvedValue(true);
});

it('does not bypass an ambiguous employee ID with a third name-only worker', () => {
  // Input order must not select any of the three workers as the target.
  for (const input of [workers, [...workers].reverse()]) {
    const result = reconcileEmployeeDirectory(input);
    const employee = result.employees.find(row => row.employeeId === 'F-2');
    expect(employee).toMatchObject({ status: 'not_enrolled' });
    expect(employee).not.toHaveProperty('workerId');
    expect(result.summary.enrolled).toBe(0);
  }
});

it('keeps the ambiguous row in remaining API suggestions without a re-enrollment target', async () => {
  mocks.query.mockResolvedValue(workers.map(worker => ({
    id: worker.id, name: worker.name, employee_id: worker.employeeId, encoding_status: worker.encodingStatus,
  })));
  const response = await GET(new NextRequest('https://example.test/api/employee-directory?q=F-2&status=remaining'));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.suggestions[0]).toEqual({
    name: 'Alex Gonzalez', employeeId: 'F-2', department: 'Area Manager', status: 'not_enrolled',
  });
  expect(result.summary).toEqual({ total: 84, enrolled: 0, remaining: 84, invalid: 0 });
});
