// Pilot feature: Activity Log "Add missing punch" (direct attendance correction).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { adminClient, diffSnapshots, readTable, snapshot, userClient } from './convex-admin.mjs';
import { Assertions, appRequire, childEnv, chromiumPath, factoryDate, nowStamp, randomHex } from './common.mjs';

export const PILOT_WORKER = 'Tommy Krueger';
// Each attempt in a run uses its own minute so earlier attempts never trip the
// dialog's two-minute possible-duplicate guard.
export function pilotTime(existingForWorkerAndDate) {
  const minutes = 6 * 60 + 5 * existingForWorkerAndDate;
  if (minutes > 14 * 60) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
const FLOW_LIMIT_MS = 180_000;
export const EXISTING_BROWSER_PROOFS = [
  'src/app/log/direct-corrections.browser.test.ts',
  'src/components/AttendanceCorrectionDialog.browser.test.ts',
];

export async function launchBrowser(state) {
  const { chromium } = appRequire(state)('playwright-core');
  // Explicit env: Playwright otherwise hands Chromium the caller's process.env.
  return chromium.launch({ executablePath: chromiumPath(state), headless: true, env: childEnv(state) });
}

// Browser contexts reach only this run's app and backend. Everything else
// (e.g. the Google Fonts @import in globals.css) is aborted and recorded.
export const blockedRequests = new Set();
export async function isolatedContext(state, browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const allowed = new Set([new URL(state.app.url).origin, new URL(state.backend.url).origin]);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (allowed.has(url.origin)) return route.continue();
    blockedRequests.add(url.origin);
    return route.abort('blockedbyclient');
  });
  return context;
}

export async function signIn(state, page, role) {
  await page.goto(`${state.app.url}/login`);
  await page.locator('input[type=email]').fill(state.users[role].email);
  await page.locator('input[type=password]').fill(state.secrets[`${role}Password`]);
  await page.locator('button[type=submit]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

// Opens a role's saved session. Convex Auth rotates refresh tokens, so the
// cookies are saved again by closeRole; an expired fixture session signs in
// again through the real /login page (recorded as reauthenticated).
export async function openRole(state, browser, role) {
  const file = path.join(state.run, 'sessions', `${role}.json`);
  const context = await isolatedContext(state, browser, { storageState: file });
  const page = await context.newPage();
  // The client refreshes its token through /api/convex-auth right after load
  // and redirects to /login if that fails, so wait for the network to settle.
  const response = await page.goto(`${state.app.url}/`, { waitUntil: 'networkidle' });
  let reauthenticated = false;
  if (new URL(page.url()).pathname.startsWith('/login')) {
    await signIn(state, page, role);
    reauthenticated = true;
  }
  await context.storageState({ path: file });
  fs.chmodSync(file, 0o600);
  const jwt = (await context.cookies()).find((c) => c.name === '__convexAuthJWT')?.value;
  return { role, file, context, page, landing: new URL(page.url()).pathname, status: response?.status(), jwt, reauthenticated };
}

export async function closeRole(session) {
  await session.context.storageState({ path: session.file }).catch(() => {});
  if (fs.existsSync(session.file)) fs.chmodSync(session.file, 0o600);
  await session.context.close();
}

async function convexOutcome(fn) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    const data = error?.data;
    return { ok: false, error: typeof data === 'string' ? data : String(error?.message ?? error).split('\n')[0].slice(0, 240) };
  }
}

function runExistingBrowserProofs(state, evidenceDir) {
  const outputFile = path.join(evidenceDir, 'existing-browser-proofs.json');
  const env = childEnv(state, { CI: '1', PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: chromiumPath(state), NODE_ENV: 'test' });
  let exitCode = 0;
  try {
    execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...EXISTING_BROWSER_PROOFS, '--reporter=json', `--outputFile=${outputFile}`],
      { cwd: path.join(state.run, 'app'), env, stdio: ['ignore', 'ignore', 'ignore'], timeout: 300_000 });
  } catch (error) {
    exitCode = error.status ?? 1;
  }
  const report = fs.existsSync(outputFile) ? JSON.parse(fs.readFileSync(outputFile, 'utf8')) : null;
  return {
    exitCode,
    files: EXISTING_BROWSER_PROOFS,
    passed: report?.numPassedTests ?? 0,
    failed: report?.numFailedTests ?? null,
    skipped: (report?.numPendingTests ?? 0) + (report?.numTodoTests ?? 0),
    report: path.relative(state.run, outputFile),
  };
}

function step(message) {
  console.error(`[verify-gatekeeper] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

export async function runFeature(state, { label = 'feature' } = {}) {
  const stamp = `${label}-${nowStamp()}`;
  const evidenceDir = path.join(state.run, 'evidence', stamp);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const a = new Assertions();
  const admin = adminClient(state);
  const date = factoryDate(-1);
  const nonce = randomHex(6);
  const reason = `verify-gatekeeper ${state.runId} allowed ${nonce}`;
  const deniedNonce = randomHex(6);
  const record = { date, worker: PILOT_WORKER, reason };

  const workers = await readTable(admin, 'workers');
  const worker = workers.find((w) => w.name === PILOT_WORKER && w.active);
  a.check('fixture-worker-present', worker, PILOT_WORKER);
  if (!worker) return finish();
  const priorAttempts = (await readTable(admin, 'attendanceCorrections')).filter((c) => c.workerId === worker._id && c.date === date).length;
  const PILOT_TIME = pilotTime(priorAttempts);
  record.time = PILOT_TIME;
  a.check('attempt-slot-available', PILOT_TIME, { priorAttempts });
  if (!PILOT_TIME) return finish();
  const before = await snapshot(admin);
  step('snapshot taken');

  const browser = await launchBrowser(state);
  const watchdog = setTimeout(() => {
    a.check('feature-flow-within-time-limit', false, `${FLOW_LIMIT_MS / 1000}s`);
    browser.close().catch(() => {});
  }, FLOW_LIMIT_MS);
  try {
    // Allowed path: least-privileged allowed role through the real dialog.
    const enrollment = await openRole(state, browser, 'enrollment');
    step('enrollment session opened');
    a.check('enrollment-session-active', enrollment.landing !== '/login', enrollment.landing);
    const page = enrollment.page;
    await page.goto(`${state.app.url}/log?date=${date}`, { waitUntil: 'domcontentloaded' });
    record.enrollmentReauthenticated = enrollment.reauthenticated;
    const add = page.getByRole('button', { name: 'Add missing punch', exact: true });
    await add.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add missing punch');
      return button && !button.disabled;
    }, null, { timeout: 30_000 });
    await add.click();
    step('Add missing punch opened');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const selects = dialog.locator('select');
    const workerOption = await selects.nth(0).locator('option', { hasText: PILOT_WORKER }).getAttribute('value');
    await selects.nth(0).selectOption(workerOption);
    await selects.nth(1).selectOption('clock_in');
    await dialog.locator('input[type="time"]').fill(PILOT_TIME);
    await dialog.locator('textarea').fill(reason);
    await dialog.getByPlaceholder('Optional').fill('Verify Supervisor');
    const responsePromise = page.waitForResponse((r) => r.url() === `${state.app.url}/api/attendance-corrections` && r.request().method() === 'POST', { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Add punch', exact: true }).click();
    const response = await responsePromise;
    step('UI POST answered');
    // Reading the body through CDP can stall in headless Chromium, so the
    // receipt is checked against the fresh database read below instead.
    const uiRequest = response.request().postDataJSON();
    record.uiRequest = uiRequest;
    record.uiStatus = response.status();
    a.check('ui-post-created', response.status() === 201 && typeof uiRequest?.request_id === 'string', { status: response.status(), requestId: uiRequest?.request_id });
    await dialog.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    const rowText = `Supervisor correction: ${reason}`;
    const shown = await page.getByText(rowText).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    a.check('ui-row-visible-after-save', shown);
    await page.screenshot({ path: path.join(evidenceDir, 'allowed-after-save.png'), fullPage: true });

    // Fresh database read, independent of the app.
    const corrections = (await readTable(admin, 'attendanceCorrections')).filter((c) => c.reason === reason);
    step('fresh read done');
    const saved = corrections[0];
    record.persisted = saved ?? null;
    a.check('fresh-read-exactly-one-row', corrections.length === 1, { count: corrections.length });
    a.check('fresh-read-matches-ui-request', saved && saved.requestId === uiRequest?.request_id && saved.reason === uiRequest?.reason
      && saved.correctedTimestamp === uiRequest?.corrected_timestamp && saved.workerId === uiRequest?.worker_id, { id: saved?._id, requestId: saved?.requestId });
    a.check('fresh-read-fields', saved && saved.workerId === worker._id && saved.action === 'add_clock_in' && saved.eventType === 'clock_in'
      && saved.date === date && String(saved.correctedTimestamp).startsWith(`${date}T${PILOT_TIME}`) && saved.supervisorName === 'Verify Supervisor',
    saved && { workerId: saved.workerId, action: saved.action, eventType: saved.eventType, date: saved.date, correctedTimestamp: saved.correctedTimestamp });
    a.check('fresh-read-actor-is-enrollment-user', saved?.actorUserId === state.users.enrollment.userId, { actorUserId: saved?.actorUserId });

    // Reload and an independent admin session both read it back through the app.
    await page.reload({ waitUntil: 'domcontentloaded' });
    a.check('row-visible-after-reload', await page.getByText(rowText).first().waitFor({ timeout: 20_000 }).then(() => true, () => false));
    await closeRole(enrollment);
    const adminRole = await openRole(state, browser, 'admin');
    await adminRole.page.goto(`${state.app.url}/log?date=${date}`, { waitUntil: 'domcontentloaded' });
    a.check('row-visible-to-fresh-admin-session', await adminRole.page.getByText(rowText).first().waitFor({ timeout: 20_000 }).then(() => true, () => false));
    await closeRole(adminRole);

    // Restricted identity: viewer can read the log but has no control.
    const viewer = await openRole(state, browser, 'viewer');
    step('viewer session opened');
    a.check('viewer-session-active', viewer.landing !== '/login', viewer.landing);
    await viewer.page.goto(`${state.app.url}/log?date=${date}`, { waitUntil: 'domcontentloaded' });
    const viewerSees = await viewer.page.getByText(rowText).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const viewerButtons = await viewer.page.getByRole('button', { name: 'Add missing punch', exact: true }).count();
    a.check('viewer-reads-row-without-control', viewerSees && viewerButtons === 0, { viewerSees, viewerButtons });
    await viewer.page.screenshot({ path: path.join(evidenceDir, 'viewer-log.png'), fullPage: true });

    // Server enforcement: replay the exact UI request with a new request_id
    // and reason (an identical replay would hit the idempotent receipt).
    const deniedBody = { ...uiRequest, request_id: `verify-denied-${deniedNonce}`, reason: `verify-gatekeeper ${state.runId} denied ${deniedNonce}` };
    const viewerPost = await viewer.context.request.post(`${state.app.url}/api/attendance-corrections`, { data: deniedBody, maxRedirects: 0 });
    record.viewerPost = { status: viewerPost.status(), body: (await viewerPost.text()).slice(0, 200) };
    a.check('viewer-api-post-denied', [401, 403].includes(viewerPost.status()), record.viewerPost);
    const anonymous = await isolatedContext(state, browser);
    const anonPost = await anonymous.request.post(`${state.app.url}/api/attendance-corrections`, { data: { ...deniedBody, request_id: `verify-anon-${deniedNonce}` }, maxRedirects: 0 });
    record.anonymousPost = { status: anonPost.status(), body: (await anonPost.text()).slice(0, 200) };
    a.check('anonymous-api-post-denied', anonPost.status() === 401, record.anonymousPost);
    await anonymous.close();

    // Convex boundary, bypassing Next: same mutation the route calls.
    const args = {
      requestId: `verify-convex-${deniedNonce}`, date, workerId: worker._id, action: 'add_clock_in',
      correctedTimestamp: uiRequest?.corrected_timestamp, reason: deniedBody.reason, supervisorName: 'Verify Supervisor',
    };
    const viewerDirect = await convexOutcome(() => userClient(state, viewer.jwt).mutation('attendanceCorrections:create', args));
    record.viewerConvex = viewerDirect;
    a.check('viewer-convex-mutation-denied', !viewerDirect.ok && /Insufficient permissions/.test(viewerDirect.error), viewerDirect);
    const anonDirect = await convexOutcome(() => userClient(state, null).mutation('attendanceCorrections:create', { ...args, requestId: `verify-convex-anon-${deniedNonce}` }));
    record.anonymousConvex = anonDirect;
    a.check('anonymous-convex-mutation-denied', !anonDirect.ok && /Unauthorized/.test(anonDirect.error), anonDirect);
    await closeRole(viewer);
    step('denied paths done');
  } catch (error) {
    a.check('feature-flow-completed', false, String(error?.message ?? error).split('\n')[0]);
    for (const context of browser.contexts()) {
      for (const [i, open] of context.pages().entries()) {
        await open.screenshot({ path: path.join(evidenceDir, `failure-${i}.png`), timeout: 10_000 }).catch(() => {});
      }
    }
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
  }

  // Whole-database comparison: the only domain change is the allowed row.
  const after = await snapshot(admin);
  const diff = diffSnapshots(before, after);
  record.blockedExternalOrigins = [...blockedRequests].sort();
  record.domainChanges = diff.domain.map(({ table, id, kind }) => ({ table, id, kind }));
  record.backgroundChanges = diff.background;
  const onlyAllowed = diff.domain.length === 1 && diff.domain[0].table === 'attendanceCorrections'
    && diff.domain[0].kind === 'added' && diff.domain[0].id === record.persisted?._id;
  a.check('only-allowed-row-persisted', onlyAllowed, record.domainChanges);
  const leaked = Object.values(after).some((docs) => Object.values(docs).some((json) => json.includes(deniedNonce)));
  a.check('no-denied-attempt-persisted', !leaked);

  // Existing repository browser proofs for this feature, unchanged.
  const existing = runExistingBrowserProofs(state, evidenceDir);
  step('existing browser proofs done');
  record.existingBrowserProofs = existing;
  a.check('existing-browser-proofs-pass', existing.exitCode === 0 && existing.failed === 0 && existing.passed > 0 && existing.skipped === 0, existing);

  return finish();

  function finish() {
    const result = {
      check: 'feature:activity-log-add-missing-punch',
      label,
      candidate: state.candidate.sha,
      at: new Date().toISOString(),
      passed: a.passed,
      firstFailure: a.failed[0]?.name ?? null,
      assertions: a.results,
      record,
      evidenceDir: path.relative(state.run, evidenceDir),
    };
    fs.writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
}
