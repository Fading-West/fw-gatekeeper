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

const publicHealthRoute = read('src/app/api/health/kiosks/route.ts');
assert.match(publicHealthRoute, /api\.kiosks\.publicHealthSummary/, 'Public kiosk health should use the aggregate-only Convex query');
assert.match(publicHealthRoute, /Cache-Control['"]:\s*['"]no-store/, 'Public kiosk health should not be cached by intermediaries');
assert.doesNotMatch(publicHealthRoute, /api\.kiosks\.list/, 'Public kiosk health must not expose the role-protected kiosk inventory');

const kioskQueries = read('convex/kiosks.ts');
const publicSummary = kioskQueries.slice(
  kioskQueries.indexOf('export const publicHealthSummary'),
  kioskQueries.indexOf('export const create'),
);
assert.match(publicSummary, /status:[\s\S]*timestamp:[\s\S]*kiosks:/, 'Public kiosk health should return a timestamped aggregate status');
assert.doesNotMatch(publicSummary, /serializeKiosk|workerName|attendance|location:/, 'Public kiosk health must not return kiosk identity, worker, attendance, or location details');

console.log('Kiosk readiness page contract passed');
