import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');
const exists = (path) => fs.existsSync(new URL(path, root));

assert.ok(exists('src/app/kiosks/page.tsx'), 'Kiosks page should exist so the sidebar link does not lead to a 404');

const kiosksPage = read('src/app/kiosks/page.tsx');
assert.match(kiosksPage, /fetch\(['"]\/api\/system-health/, 'Kiosks page should use the sanitized system-health API payload');
assert.match(kiosksPage, /Kiosk readiness/i, 'Kiosks page should have a clear readiness heading');
assert.match(kiosksPage, /Last sync/i, 'Kiosks page should show last sync evidence for each kiosk');
assert.match(kiosksPage, /Expected worker/i, 'Kiosks page should show expected worker payload counts');
assert.match(kiosksPage, /Last attendance upload/i, 'Kiosks page should show last attendance upload evidence');
assert.match(kiosksPage, /online[\s\S]*stale[\s\S]*offline[\s\S]*never synced/i, 'Kiosks page should explain online/stale/offline/never-synced status thresholds');
assert.match(kiosksPage, /KIOSK_API_KEY/, 'Kiosks page should remind admins that kiosks need the matching KIOSK_API_KEY without printing the key');
assert.doesNotMatch(kiosksPage, /process\.env\.KIOSK_API_KEY/, 'Kiosks page must not expose the kiosk secret value to the browser');

const sidebar = read('src/components/Sidebar.tsx');
assert.match(sidebar, /href:\s*['"]\/kiosks['"][\s\S]*label:\s*['"]Kiosks['"][\s\S]*adminOnly:\s*true/, 'Kiosks navigation should be admin-only because it exposes device readiness/ops details');

const middleware = read('src/proxy.ts');
assert.match(middleware, /isAdminOnlyPage\s*\(/, 'middleware should enforce admin-only pages server-side, not only hide nav links');
assert.match(middleware, /pathname\s*===\s*['"]\/kiosks['"]/, 'middleware should treat /kiosks as an admin-only page');
assert.match(middleware, /isAdminOnlyPage\(pathname\)[\s\S]*!hasConvexPortalAdmin[\s\S]*NextResponse\.redirect\(new URL\('\/', req\.url\)\)/, 'non-admin portal members who browse directly to /kiosks should be redirected away');

const kiosksRoute = read('src/app/api/kiosks/route.ts');
assert.match(kiosksRoute, /hasValidPortalSession\(req,\s*\['admin'\]\)/, 'Kiosks API should enforce admin role at the route layer, not rely on middleware alone');
assert.match(kiosksRoute, /unauthorizedApiResponse/, 'Kiosks API should return the standard unauthorized response for non-admin users');

const kioskQueries = read('convex/kiosks.ts');
const publicSummary = kioskQueries.slice(
  kioskQueries.indexOf('export const internalHealthSnapshot'),
  kioskQueries.indexOf('export const create'),
);
assert.match(publicSummary, /internalQuery/, 'The health snapshot must remain internal to the Convex HTTP action');
assert.doesNotMatch(publicSummary, /serializeKiosk|workerName|attendance|location:/, 'Public kiosk health must not return kiosk identity, worker, attendance, or location details');
assert.doesNotMatch(publicSummary, /Date\.now\(\)|\.collect\(\)/, 'The internal snapshot should stay deterministic and bound its indexed fleet query');

const convexHttp = read('convex/http.ts');
assert.match(convexHttp, /path: '\/api\/public\/kiosk-health'[\s\S]*method: 'GET'/, 'Convex should expose a credential-free GET health action');
assert.match(convexHttp, /internal\.kiosks\.internalHealthSnapshot/, 'Public health should read only the internal aggregate input');
assert.match(convexHttp, /inventory_truncated:[\s\S]*inventoryTruncated/, 'A fleet beyond the bounded read should degrade with an explicit truncation fact instead of failing health');
assert.match(convexHttp, /missingDeviceHealth \+ staleDeviceHealth > 0/, 'Missing or stale device telemetry must degrade aggregate kiosk health');
assert.match(convexHttp, /health\.reported_at/, 'Device telemetry freshness must use its own report time instead of kiosk sync alone');
assert.match(convexHttp, /typeof kiosk\.health\.camera_ok !== 'boolean'[\s\S]*typeof kiosk\.health\.model_ok !== 'boolean'[\s\S]*missingDeviceHealth/, 'Fresh but incomplete device telemetry must remain degraded');
assert.doesNotMatch(convexHttp.slice(convexHttp.indexOf('const publicKioskHealth')), /checkedAtMs:\s*v\./, 'Public callers must not supply the health evaluation clock');

console.log('Kiosk readiness page contract passed');
