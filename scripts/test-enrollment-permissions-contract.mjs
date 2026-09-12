import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');

const middleware = read('src/proxy.ts');
assert.match(
  middleware,
  /getApiAllowedRoles\s*\(/,
  'middleware should derive API allowed roles per route instead of treating every /api route as admin-only',
);
assert.match(
  middleware,
  /pathname\s*===\s*['"]\/api\/enroll['"][\s\S]*\['admin',\s*'enrollment'\]/,
  'middleware should allow enrollment-role users through /api/enroll while keeping route-level validation in place',
);
assert.match(
  middleware,
  /pathname\s*===\s*['"]\/api\/workers['"][\s\S]*method\s*===\s*['"]GET['"][\s\S]*searchParams\.has\(['"]id['"]\)[\s\S]*\['admin',\s*'enrollment'\]/,
  'middleware should allow enrollment-role users to fetch a specific worker for re-enrollment lookup',
);
assert.match(
  middleware,
  /pathname\s*===\s*['"]\/api\/workers['"][\s\S]*method\s*===\s*['"]GET['"][\s\S]*searchParams\.get\(['"]scope['"]\)\s*===\s*['"]dashboard['"][\s\S]*\['admin',\s*'enrollment',\s*'viewer'\]/,
  'middleware should allow dashboard-scoped worker roster reads for active dashboard roles',
);
assert.match(
  middleware,
  /hasPortalMemberAccess\(token,\s*apiAllowedRoles\)/,
  'middleware should pass route-specific allowed roles into portal-member authorization',
);
assert.match(
  middleware,
  /hasPortalMemberAccess\(token,\s*\['admin'\]\)/,
  'middleware should still compute explicit admin status for admin-only UI/API routes',
);

const workersRoute = read('src/app/api/workers/route.ts');
assert.match(
  workersRoute,
  /requireWorkerRead\s*\(/,
  'Workers API should separate specific-worker read access from admin-only mutations/listing',
);
assert.match(
  workersRoute,
  /hasValidPortalSession\(req,\s*\['admin',\s*'enrollment'\]\)/,
  'Specific worker lookup should allow admin and enrollment roles for re-enrollment',
);
assert.doesNotMatch(
  workersRoute,
  /face_encoding:\s*worker\.face_encoding/,
  'Portal worker responses must never serialize biometric vectors',
);
assert.match(
  workersRoute,
  /requireDashboardWorkerRead\s*\(/,
  'Workers API should expose a separate dashboard read scope without broadening worker management',
);
assert.match(
  workersRoute,
  /hasValidPortalSession\(req,\s*\['admin',\s*'enrollment',\s*'viewer'\]\)/,
  'Dashboard worker roster reads should allow viewer portal members',
);
assert.doesNotMatch(
  workersRoute,
  /export async function POST/,
  'Worker creation must go through /api/enroll only; the raw workers POST was removed',
);
assert.match(
  workersRoute,
  /PATCH[\s\S]*requireAdmin\(req\)/,
  'Generic worker edits must stay admin-only; enrollment users should use /api/enroll for face re-enrollment',
);

const enrollRoute = read('src/app/api/enroll/route.ts');
const convexWorkers = read('convex/workers.ts');
assert.match(
  enrollRoute,
  /const isAdminSession = await hasValidPortalSession\(req,\s*\['admin'\]\)/,
  'Enrollment API should detect admin role separately before allowing metadata changes during re-enrollment',
);
assert.match(
  enrollRoute,
  /!isAdminSession[\s\S]*findEmployeeDirectoryById\(employeeIdForSave\)[\s\S]*Select an employee from the company roster/,
  'Enrollment-role creation must reject identities that are not in the company roster.',
);
assert.match(
  enrollRoute,
  /api\.workers\.createFromRoster/,
  'Enrollment-role creation must use the roster-validated Convex mutation.',
);
assert.match(
  convexWorkers,
  /export const create = mutation\([\s\S]*assertPortalRole\(ctx, \["admin"\]\)/,
  'Generic Convex worker creation must remain admin-only.',
);
assert.match(
  convexWorkers,
  /export const createFromRoster = mutation\([\s\S]*findEmployeeDirectoryById\(args\.employeeId\)/,
  'Convex must independently validate enrollment-role creation against the roster.',
);
assert.match(
  enrollRoute,
  /hasValidPortalSession\(req,\s*\['enrollment'\]\)/,
  'Enrollment API should allow enrollment-role sessions after checking admin status',
);
assert.match(
  enrollRoute,
  /if \(workerId && !isAdminSession\)[\s\S]*convex\.query\(api\.workers\.get[\s\S]*normalizedName = existingForEnrollment\.name/,
  'Enrollment-role re-enrollment should preserve existing worker name instead of allowing metadata edits through /api/enroll',
);
assert.match(
  enrollRoute,
  /employeeIdForSave = existingForEnrollment\.employee_id/,
  'Enrollment-role re-enrollment should preserve existing employee ID instead of allowing metadata edits through /api/enroll',
);
assert.match(
  enrollRoute,
  /departmentForSave = existingForEnrollment\.department/,
  'Enrollment-role re-enrollment should preserve existing department instead of allowing metadata edits through /api/enroll',
);

console.log('Enrollment permissions contract passed');


const enrollmentConsentPage = read('src/app/enroll/page.tsx');
assert.match(enrollmentConsentPage, /const startCamera = async \(\) => \{\s*setConsentConfirmed\(false\)/, 'Each camera session must collect fresh biometric consent.');
assert.match(enrollmentConsentPage, /if \(!consentConfirmed\) throw new Error/, 'Submitting face data must enforce the current consent choice.');
assert.match(enrollmentConsentPage, /consent: consentConfirmed/, 'Enrollment must send the actual consent choice, never a hard-coded acknowledgement.');
