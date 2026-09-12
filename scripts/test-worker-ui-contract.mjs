#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const workersPage = read('src/app/workers/page.tsx');
const enrollPage = read('src/app/enroll/page.tsx');
const enrollRoute = read('src/app/api/enroll/route.ts');
const workersRoute = read('src/app/api/workers/route.ts');
const dashboardPage = read('src/app/page.tsx');
const convexWorkers = read('convex/workers.ts');
const types = read('src/lib/types.ts');
const proactiveActions = read('src/lib/proactive-actions.ts');
const employeeDirectory = read('src/lib/employee-directory.ts');

assert.doesNotMatch(workersPage, /include_encodings=true/, 'Portal worker management must never download raw biometric vectors.');
assert.match(workersPage, /Face enrolled/, 'Workers page must show a Face enrolled badge.');
assert.match(workersPage, /Missing face/, 'Workers page must show a Missing face badge.');
assert.match(workersPage, /Invalid face data/, 'Workers page must distinguish invalid/corrupt face data from missing data.');
assert.match(workersPage, /Ready for kiosk recognition/, 'Workers page must explain that valid enrolled workers are kiosk-ready.');
assert.match(workersPage, /Needs enrollment/, 'Workers page must flag workers who still need enrollment.');
assert.match(workersPage, /Needs re-enrollment/, 'Workers page must flag workers with invalid face data for re-enrollment.');
assert.match(workersPage, /Re-enroll/, 'Workers page must offer a re-enroll path for missing/updated face data.');
assert.match(workersPage, /`\/enroll\?worker_id=\$\{encodeURIComponent\(w\.id\)\}`/, 'Workers page Enroll/Re-enroll CTA must pass the existing worker id.');
assert.doesNotMatch(workersPage, /href="\/enroll" className=\{`flex-1 text-center text-xs/, 'Workers page must not use a plain /enroll link for existing worker enrollment.');
assert.match(workersPage, /grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3/, 'Workers list should be responsive cards, not a cramped row list.');

assert.match(enrollPage, /useSearchParams/, 'Enroll page must read worker_id from the URL.');
assert.match(enrollPage, /\/api\/workers\?id=\$\{encodeURIComponent\(workerId\)\}/, 'Enroll page must fetch an existing worker by id for prefill.');
assert.match(enrollPage, /workerId: workerIdRef\.current/, 'Enroll submit payload must include the existing worker id when present.');
assert.match(enrollPage, /Employee ID Number[\s\S]*Department/, 'Enroll page must show Employee ID Number between Full Name and Department.');
assert.match(enrollPage, /employeeId: employeeIdRef\.current\.trim\(\)/, 'Enroll submit payload must include the employee ID number.');
assert.match(enrollPage, /setEmployeeId\(worker\.employee_id \|\| ''\)/, 'Re-enrollment prefill must load the existing employee ID number.');
assert.match(enrollPage, /\/api\/employee-directory\?q=/, 'New enrollment should fetch directory suggestions server-side so the roster PII stays out of the client bundle.');
assert.doesNotMatch(enrollPage, /searchEmployeeDirectory/, 'Enroll page must not bundle the employee directory data client-side.');
assert.match(enrollPage, /selectEmployee[\s\S]*setEmployeeId\(employee\.employeeId\)[\s\S]*setDepartment\(employee\.department\)/, 'Selecting a directory match must fill its employee ID and area.');
assert.match(enrollPage, /role="combobox"[\s\S]*role="listbox"[\s\S]*role="option"/, 'Employee suggestions must expose accessible combobox semantics.');
assert.match(enrollPage, /No roster match\. Check the spelling or employee ID before creating someone new\./, 'Enrollment must warn operators before creating an off-roster person.');
assert.match(enrollPage, /currentRole === 'admin'[\s\S]*Employee not listed\? Add manually/, 'Only admins should receive the explicit off-roster manual entry path.');
assert.match(enrollPage, /Roster progress[\s\S]*of \{directorySummary\.total\} enrolled[\s\S]*remaining/, 'Enrollment must show live roster progress and remaining count.');
assert.match(enrollPage, /Already enrolled[\s\S]*Needs re-enrollment[\s\S]*Ready to enroll/, 'Roster results must clearly distinguish enrollment status.');
assert.match(enrollPage, /disabled=\{!canEnroll \|\| cameraOpening \|\| !name\.trim\(\) \|\| \(!workerId && !selectedEmployee && !manualEntry\)\}/, 'Enrollment must require a roster selection unless an admin explicitly uses manual entry.');
assert.match(
  enrollPage,
  /setResultMsg\([\s\S]*setStep\('done'\);[\s\S]*fetch\('\/api\/employee-directory\?status=not_enrolled'\)/,
  'Enrollment must show success before the non-critical roster progress refresh completes.',
);
assert.match(employeeDirectory, /Camilo \(Kevin Rojas\) Pacheco/, 'Employee directory should retain roster aliases used for search.');
assert.match(enrollPage, /<button type="button" onClick=\{enrollNext\} className="btn-primary w-full py-3\.5 text-base block text-center">/, 'Done state must clear worker_id by navigating to a fresh /enroll URL before enrolling another person.');
assert.match(enrollRoute, /employeeId\?: string/, 'Enroll API must accept an optional employee ID number.');
assert.match(enrollRoute, /api\.workers\.findByEmployeeId/, 'Enroll API must reject duplicate employee IDs before processing photos.');
assert.match(enrollRoute, /workerId\?: string/, 'Enroll API must accept an optional existing worker id.');
assert.match(enrollRoute, /api\.workers\.update/, 'Enroll API must update an existing worker when workerId is provided.');
assert.doesNotMatch(enrollRoute, /if \(existingWorker\?\.active\) \{\n\s*return NextResponse\.json\(\{ error: 'Worker name already exists' \}/, 'Enroll API must not reject the same active worker before checking workerId.');

assert.match(dashboardPage, /Action Center/, 'Dashboard must include an Action Center section.');
assert.match(dashboardPage, /missingFaceWorkers/, 'Dashboard must compute missing face enrollment action items.');
assert.match(dashboardPage, /invalidFaceWorkers/, 'Dashboard must compute invalid face data action items.');
assert.match(dashboardPage, /All clear/, 'Dashboard Action Center must have a positive empty state.');
assert.match(dashboardPage, /buildProactiveActions/, 'Dashboard Action Center must use the proactive action engine.');
assert.match(proactiveActions, /Review now/, 'Dashboard Action Center must provide a clear review CTA.');
assert.match(dashboardPage, /Shift Command <span className="text-gold">Inbox<\/span>/, 'Dashboard must lead with the shift command inbox instead of a passive live dashboard.');
assert.match(dashboardPage, /Live Shift Sentinel/, 'Dashboard command inbox must include the deterministic live Sentinel surface.');
assert.match(dashboardPage, /Mark Sentinel seen/, 'Dashboard Sentinel acknowledgements must stay lightweight and in-app.');
assert.match(dashboardPage, /Live Shift Sentinel/, 'Dashboard command inbox must lead with the single ranked action queue (the Sentinel).');
assert.doesNotMatch(dashboardPage, /Needs action[\s\S]*Closeout blockers[\s\S]*Watch signals/, 'Dashboard must not re-render ranked actions as parallel command groups; the Sentinel is the single queue.');
assert.match(dashboardPage, /Open exception work[\s\S]*Suggested resolutions/, 'Dashboard command inbox must surface exception work with server-backed suggested resolutions.');
assert.doesNotMatch(dashboardPage, /group\.items\.slice\(0,\s*4\)/, 'Dashboard command inbox must not hide overflow command actions.');
assert.match(dashboardPage, /exceptionSignalUnavailable \? \([\s\S]*role="status"[\s\S]*exceptionUnavailableCopy/, 'Dashboard exception work must show unavailable state instead of all-clear copy when exception data is stale or missing.');
assert.match(dashboardPage, /0 of \$\{systemHealth\.kiosks\.total\} kiosks online|\$\{systemHealth\.kiosks\.counts\.online\} of \$\{systemHealth\.kiosks\.total\} kiosks online/, 'Dashboard should use plain-language kiosk online copy instead of ambiguous 0/2 sync shorthand.');
assert.match(dashboardPage, /need disposition/, 'Dashboard command inbox should summarize exception work as disposition, not raw dashboard activity.');
assert.match(dashboardPage, /blockers \/ risks/, 'Dashboard command inbox should summarize closeout blockers before supporting roster evidence.');
assert.doesNotMatch(dashboardPage, /3\.0-mobilefacenet|face_service\.version \|\|/, 'Dashboard should not foreground raw face model version in the main health card.');
assert.match(dashboardPage, /Attendance roster|Today.s workers/, 'Dashboard worker search/cards must have a nearby section heading.');
assert.match(dashboardPage, /source: 'system-warning' as const/, 'Recent Events system warnings should be typed as timeline/system signals distinct from action items.');
assert.match(dashboardPage, /data-event-source=\{event\.source\}/, 'Recent Events cards should expose event source markers for QA and styling.');
assert.match(dashboardPage, /fetch\('\/api\/workers\?scope=dashboard'\)/, 'Dashboard must fetch worker readiness metadata through the dashboard read scope without requesting full biometric vectors.');
assert.doesNotMatch(dashboardPage, /fetch\('\/api\/workers\?include_encodings=true'\)/, 'Dashboard must not download full biometric vectors every poll.');

const appShell = read('src/components/AppShell.tsx');
assert.match(appShell, /pb-\[calc\(7rem\+env\(safe-area-inset-bottom\)\)\]|pb-32/, 'App shell must leave enough mobile bottom padding so fixed tabs do not cover dashboard cards.');

assert.match(convexWorkers, /encoding_status/, 'Convex worker list must expose encoding_status readiness metadata.');
assert.match(convexWorkers, /has_face_encoding/, 'Convex worker list must expose has_face_encoding readiness metadata.');
assert.doesNotMatch(workersRoute, /face_encoding:\s*worker\.face_encoding/, 'Workers API must never serialize raw face encodings to portal clients.');
assert.match(workersRoute, /api\.workers\.list, \{ includeEncodings: false \}/, 'Workers API must request only readiness metadata from Convex.');
assert.match(workersRoute, /employee_id: worker\.employee_id/, 'Workers API list must expose employee ID number metadata.');
assert.doesNotMatch(workersRoute, /\.\.\.safeWorker|\.\.\.worker/, 'Workers API id prefill should use an explicit biometric-free response allowlist.');
assert.match(convexWorkers, /employee_id: w\.employeeId \|\| ""/, 'Convex worker queries must expose employee ID number metadata.');
assert.match(types, /employee_id\?:\s*string/, 'Worker type should model employee ID number metadata.');
assert.match(types, /encoding_status\?:\s*'valid'\s*\|\s*'missing'\s*\|\s*'invalid'/, 'Worker type should model encoding_status readiness metadata.');
assert.match(types, /has_face_encoding\?:\s*boolean/, 'Worker type should model has_face_encoding readiness metadata.');

console.log('Worker UI contract passed');
