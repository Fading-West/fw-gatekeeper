#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const schema = read('convex/schema.ts');
const attempts = read('convex/recognitionAttempts.ts');
const auth = read('src/lib/auth.ts');
const apiRoute = read('src/app/api/recognition-attempts/route.ts');
const bulkRoute = read('src/app/api/recognition-attempts/bulk/route.ts');
const page = read('src/app/calibration/recognition/page.tsx');
const lab = read('src/components/RecognitionCalibrationLab.tsx');
const sidebar = read('src/components/Sidebar.tsx');

assert.match(schema, /recognitionAttempts:\s*defineTable/, 'Schema must define recognitionAttempts.');
assert.match(schema, /timestamp:\s*v\.string\(\)/, 'Recognition attempts must store timestamp.');
assert.match(schema, /kioskId:\s*v\.string\(\)/, 'Recognition attempts must store kioskId.');
assert.match(schema, /faceDetected:\s*v\.boolean\(\)/, 'Recognition attempts must store faceDetected.');
assert.match(schema, /candidateWorkerId:\s*v\.optional\(v\.string\(\)\)/, 'Recognition attempts must store optional candidate worker id.');
assert.match(schema, /bestScore:\s*v\.optional\(v\.float64\(\)\)/, 'Recognition attempts must store optional best score.');
assert.match(schema, /scoreMargin:\s*v\.optional\(v\.float64\(\)\)/, 'Recognition attempts must store optional score margin.');
assert.match(schema, /decision:\s*v\.string\(\)/, 'Recognition attempts must store decision.');
assert.match(schema, /threshold:\s*v\.float64\(\)/, 'Recognition attempts must store threshold.');
assert.match(schema, /livenessConfirmed:\s*v\.optional\(v\.boolean\(\)\)/, 'Recognition attempts must store optional liveness confirmation.');
assert.match(schema, /modelVersion:\s*v\.optional\(v\.string\(\)\)/, 'Recognition attempts must store optional model version.');
assert.match(schema, /reviewed:\s*v\.boolean\(\)/, 'Recognition attempts must store review status.');
assert.match(schema, /reviewedLabel:\s*v\.optional\(v\.string\(\)\)/, 'Recognition attempts must store optional review label.');
assert.match(schema, /\.index\("by_timestamp",\s*\["timestamp"\]\)/, 'Recognition attempts need a timestamp index for date/range queries.');
assert.match(schema, /\.index\("by_kiosk_timestamp",\s*\["kioskId",\s*"timestamp"\]\)/, 'Recognition attempts need a kiosk/timestamp index.');
assert.match(schema, /\.index\("by_reviewed_timestamp",\s*\["reviewed",\s*"timestamp"\]\)/, 'Recognition attempts need a review/timestamp index.');
assert.match(schema, /\.index\("by_kiosk_reviewed_timestamp",\s*\["kioskId",\s*"reviewed",\s*"timestamp"\]\)/, 'Recognition attempts need a kiosk/review/timestamp index.');

assert.doesNotMatch(attempts, /export const bulkIngest\s*=\s*mutation/, 'Recognition bulk ingest must not remain publicly callable.');
assert.match(attempts, /export const listByDate\s*=\s*query/, 'Recognition attempts must expose listByDate query.');
assert.match(attempts, /export const getById\s*=\s*query/, 'Recognition attempts must expose exact attempt lookup for source handoffs.');
assert.match(attempts, /export const updateReview\s*=\s*mutation/, 'Recognition attempts must expose updateReview mutation.');
assert.match(attempts, /const reviewed = attempt\.reviewed \?\? false/, 'Bulk ingest should default attempts to unreviewed.');
assert.match(attempts, /bestScore[\s\S]*secondBestScore[\s\S]*bestScore - attempt\.secondBestScore/, 'Bulk ingest should derive scoreMargin from best and second-best scores.');
assert.match(attempts, /by_source_attempt_id/, 'Bulk ingest should support sourceAttemptId idempotency.');
assert.match(attempts, /timestampBelongsToFactoryLocalDate\(attempt\.timestamp,\s*args\.date\)/, 'Exact recognition attempt lookups should stay scoped to the requested factory day.');

assert.match(auth, /\/api\/recognition-attempts\/bulk/, 'Kiosk auth allow-list must include recognition attempt bulk upload.');
assert.match(bulkRoute, /await authenticateKiosk\(req, claims\)/, 'Bulk recognition upload must authenticate the device and every kiosk claim.');
assert.match(bulkRoute, /if \(!identity\) return unauthorizedApiResponse\(\)/, 'Unverified devices must be rejected before ingestion.');
assert.match(bulkRoute, /ingestRecognitionAttemptBatch/, 'Bulk recognition attempt API must use secured Convex HTTP ingest.');
assert.doesNotMatch(bulkRoute, /convex\.mutation/, 'Bulk recognition attempt API must not call a public Convex mutation.');
assert.match(apiRoute, /recognitionAttempts\.listByDate/, 'Recognition attempt API must call the Convex listByDate query.');
assert.match(apiRoute, /recognitionAttempts\.updateReview/, 'Recognition attempt review API must call the Convex updateReview mutation.');
assert.match(apiRoute, /hasValidPortalSession\(req,\s*\['admin',\s*'enrollment',\s*'viewer'\]\)/, 'Recognition attempt reads must allow viewer portal members.');
assert.match(apiRoute, /hasValidPortalSession\(req,\s*\['admin',\s*'enrollment'\]\)/, 'Recognition attempt review writes must remain admin/enrollment only.');
assert.match(apiRoute, /const attemptId = optionalString\(searchParams\.get\('attempt_id'\)\)/, 'Recognition attempt API should accept exact attempt-row links.');
assert.match(apiRoute, /reviewed:\s*attemptId \? undefined : reviewStatus === 'unreviewed'/, 'Exact attempt links should not be narrowed by reviewed status.');
assert.match(apiRoute, /recognitionAttempts\.getById/, 'Recognition attempt API should fetch exact target rows by id.');
assert.match(apiRoute, /const rawAttempts = Array\.isArray\(result\) \? result : result\?\.attempts \|\| result\?\.rows \|\| \[\]/, 'Recognition attempt API should normalize dated rows before exact target merging.');
assert.match(apiRoute, /targetAttempt \? \{ attempts: \[targetAttempt, \.\.\.rawAttempts\] \} : result/, 'Recognition attempt API should merge exact target rows into normal dated results.');
assert.match(apiRoute, /const deduped = new Map\(response\.attempts\.map/, 'Recognition attempt API should dedupe exact target rows after merging.');
assert.match(apiRoute, /const attemptMatches = !attemptId \|\| attempt\.id === attemptId/, 'Recognition attempt API should filter exact attempt links by id after normalization.');
assert.match(apiRoute, /const decisionMatches =\s*attemptId \|\|/, 'Exact attempt links should not be hidden by decision filters.');
assert.match(apiRoute, /const confidenceMatches =\s*attemptId \|\|/, 'Exact attempt links should not be hidden by confidence filters.');
assert.match(page, /RecognitionCalibrationLab/, 'Recognition calibration page must render the lab component.');
assert.match(lab, /usePortalRole|portalMembers\.current/, 'Recognition Lab should resolve portal role before exposing review write controls.');
assert.match(lab, /function canOperateRecognition/, 'Recognition Lab should centralize write-role checks.');
assert.match(lab, /return role === 'admin' \|\| role === 'enrollment'/, 'Recognition Lab writes should remain limited to admin and enrollment roles.');
assert.match(lab, /if \(!canOperate\)[\s\S]*Only admin or enrollment roles can update recognition reviews/, 'Recognition review mutations should be guarded client-side for read-only roles.');
assert.match(lab, /canOperate \?[\s\S]*Confirm[\s\S]*Ignore[\s\S]*Review-only/, 'Recognition Lab controls should render as review-only for viewers.');
assert.match(lab, /searchParams\.get\('attempt_id'\)/, 'Recognition Lab should read exact attempt-row links.');
assert.match(lab, /new URLSearchParams\(\{ date, limit: queryAttemptId \? '1000' : '150' \}\)/, 'Recognition Lab should widen direct-link fetches only when an attempt id is present.');
assert.match(lab, /params\.set\('attempt_id', queryAttemptId\)/, 'Recognition Lab should pass exact attempt ids to the API.');
assert.match(lab, /function recognitionAttemptRowId/, 'Recognition Lab should create stable row ids for direct links.');
assert.match(lab, /document\.getElementById\(recognitionAttemptRowId\(queryAttemptId\)\)\?\.scrollIntoView/, 'Recognition Lab should scroll exact attempt links to the targeted row.');
assert.match(lab, /queryAttemptId === attempt\.id/, 'Recognition Lab should highlight the targeted attempt row.');
assert.match(sidebar, /\/calibration\/recognition/, 'Sidebar must link to the recognition calibration lab.');

console.log('Recognition attempts contract passed');
