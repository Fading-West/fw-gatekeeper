import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const attendance = read('convex/attendance.ts');
const workers = read('convex/workers.ts');
const recognitionAttempts = read('convex/recognitionAttempts.ts');
const kiosks = read('convex/kiosks.ts');
const http = read('convex/http.ts');
const helper = read('src/lib/convex-ingest.ts');
const backlog = read('src/lib/attendance-backlog.ts');
const attendanceRoute = read('src/app/api/attendance/bulk/route.ts');
const attendanceSingleRoute = read('src/app/api/attendance/route.ts');
const recognitionRoute = read('src/app/api/recognition-attempts/bulk/route.ts');
const syncRoute = read('src/app/api/sync/route.ts');

assert.match(
  attendance,
  /export const bulkCreateFromHttp\s*=\s*internalMutation/,
  'Attendance ingest must use an internal Convex mutation.',
);
assert.match(attendance, /export const createFromHttp\s*=\s*internalMutation/, 'Single attendance ingest must use an internal Convex mutation.');
assert.match(workers, /export const listForSyncFromHttp\s*=\s*internalQuery/, 'Worker sync must use an internal Convex query.');
assert.match(
  recognitionAttempts,
  /export const bulkIngestFromHttp\s*=\s*internalMutation/,
  'Recognition ingest must use an internal Convex mutation.',
);
assert.match(
  kiosks,
  /export const updateLastSyncFromHttp\s*=\s*internalMutation/,
  'Kiosk lastSync ingest must use an internal Convex mutation.',
);

assert.match(http, /process\.env\.CONVEX_INGEST_KEY/, 'Convex HTTP ingest must require the server ingest key.');
assert.match(http, /request\.headers\.get\('authorization'\)/, 'Convex HTTP ingest must read bearer authorization.');
assert.match(http, /\{ error: 'Unauthorized' \}, 401/, 'Invalid Convex HTTP credentials must return 401.');
assert.match(http, /path: '\/api\/ingest\/attendance\/bulk'/, 'Attendance HTTP ingest route must be registered.');
assert.match(http, /path: '\/api\/ingest\/attendance'/, 'Single attendance HTTP ingest route must be registered.');
assert.match(http, /path: '\/api\/ingest\/recognition-attempts\/bulk'/, 'Recognition HTTP ingest route must be registered.');
assert.match(http, /path: '\/api\/ingest\/kiosks\/last-sync'/, 'Kiosk sync HTTP ingest route must be registered.');
assert.match(http, /path: '\/api\/ingest\/workers\/sync'/, 'Worker sync HTTP route must be registered.');

assert.match(helper, /process\.env\.CONVEX_INGEST_KEY/, 'Next secured ingest must use the server-only ingest key.');
assert.match(helper, /authorization: `Bearer \$\{getConvexIngestKey\(\)\}`/, 'Next secured ingest must send bearer authorization.');
assert.match(helper, /INGEST_TIMEOUT_MS = 10_000/, 'Next secured ingest must time out before the kiosk request does.');
assert.doesNotMatch(helper, /assertProductionIngestAllowed|FW_DEMO_WRITE_MODE/, 'Demo write mode was removed; secured ingest must not carry demo guards.');
assert.match(attendanceRoute, /ingestAttendanceBacklog\(mapped\)/, 'Attendance route must call the compatible backlog gateway.');
assert.match(backlog, /ingestAttendanceBatch\(/, 'Backlog gateway must call secured HTTP ingest.');
assert.match(backlog, /getAttendanceReceiptStatus\(/, 'Backlog gateway must resume durable chunk receipts.');
assert.match(attendanceSingleRoute, /ingestAttendanceEvent\(/, 'Single attendance route must call secured HTTP ingest.');
assert.match(recognitionRoute, /ingestRecognitionAttemptBatch\(mapped\)/, 'Recognition route must call secured HTTP ingest.');
assert.match(syncRoute, /updateKioskLastSync\(kioskId, lastSync, parseKioskHealth\(/, 'Sync route must update lastSync and kiosk health through secured HTTP ingest.');
assert.match(syncRoute, /fetchWorkersForSync\(since\)/, 'Sync route must fetch workers through secured HTTP ingest.');
assert.doesNotMatch(attendanceRoute, /convex\.mutation/, 'Attendance route must not call a public Convex mutation.');
assert.doesNotMatch(attendanceSingleRoute, /attendance\.create/, 'Single attendance route must not call the public attendance mutation.');
assert.doesNotMatch(recognitionRoute, /convex\.mutation/, 'Recognition route must not call a public Convex mutation.');
assert.doesNotMatch(syncRoute, /kiosks\.updateLastSync/, 'Sync route must not call the public kiosk mutation.');
assert.doesNotMatch(syncRoute, /workers\.listForSync/, 'Sync route must not call the public worker sync query.');
assert.doesNotMatch(attendance, /export const bulkCreate\s*=\s*mutation/, 'Legacy attendance bulk mutation must not be public.');
assert.doesNotMatch(recognitionAttempts, /export const bulkIngest\s*=\s*mutation/, 'Legacy recognition bulk mutation must not be public.');
assert.doesNotMatch(kiosks, /export const updateLastSync\s*=\s*mutation/, 'Legacy kiosk sync mutation must not be public.');

console.log('Secured Convex ingest contract passed');
