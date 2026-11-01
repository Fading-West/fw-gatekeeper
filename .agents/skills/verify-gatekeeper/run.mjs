#!/usr/bin/env node
// verify-gatekeeper: prepare | doctor | feature | negative-control | cleanup
// See SKILL.md. Every resource lives under one run directory and is owned by
// this run; nothing here reads caller env files or touches deployed services.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Assertions, CheckFailure, DEFAULT_RUNS_DIR, EMAIL_DOMAIN, ROLES, childEnv, factoryDate, fail, freePort, git, gitBlobHash,
  hostEnv, listenersFor, nowStamp, ownedProcessAlive, ownedTree, procCwd, procStartTicks, randomHex, randomPassword, readState,
  runLogged, saveState, sha256, spawnOwned, waitFor, writeEvidence, writePrivateJson,
} from './lib/common.mjs';
import {
  adminClient, deployedModuleHashes, diffSnapshots, readTable, setBackendEnv, snapshot, userClient,
} from './lib/convex-admin.mjs';
import { closeRole, isolatedContext, launchBrowser, openRole, runFeature, signIn } from './lib/feature.mjs';

const SEEDED_WORKERS = ['Marcus Johnson', 'Sarah Chen', 'Diego Rivera', 'Aisha Patel', 'Tommy Krueger'];
const DEFECT_FILE = 'convex/attendanceCorrections.ts';
const DEFECT_FROM = 'const actor = await assertPortalRole(ctx, ["admin", "enrollment"]);';
const DEFECT_TO = 'const actor = await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--')) fail(`Unexpected argument ${key}`);
    opts[key.slice(2)] = rest[i + 1];
    i += 1;
  }
  return { command, opts };
}

function newestBackendBinary() {
  const root = path.join(os.homedir(), '.cache', 'convex', 'binaries');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'convex-local-backend'))).sort() : [];
  if (!dirs.length) fail(`No convex-local-backend under ${root}; pass --backend-bin.`);
  return path.join(root, dirs.at(-1), 'convex-local-backend');
}

function withLock(run, fn) {
  const lock = path.join(run, 'operation.lock');
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    const holder = fs.readFileSync(lock, 'utf8').trim();
    fail(`${lock} is held by pid ${holder}. If that process is gone, inspect the run, remove the lock and retry.`);
  }
  return Promise.resolve().then(fn).finally(() => fs.rmSync(lock, { force: true }));
}

// Git blob identity of every tracked file in the archived app copy.
function sourceIdentity(state, { scopes = ['convex/', 'src/'] } = {}) {
  const listing = git(state.candidate.repo, ['ls-tree', '-r', '-z', state.candidate.sha]).split('\0').filter(Boolean);
  const mismatches = [];
  const tracked = new Set();
  for (const entry of listing) {
    const [meta, file] = entry.split('\t');
    const [mode, , blob] = meta.split(' ');
    tracked.add(file);
    const target = path.join(state.run, 'app', file);
    let actual = null;
    try {
      actual = mode === '120000' ? gitBlobHash(Buffer.from(fs.readlinkSync(target))) : gitBlobHash(fs.readFileSync(target));
    } catch { /* missing */ }
    if (actual !== blob) mismatches.push(file);
  }
  const extras = [];
  for (const scope of scopes) {
    const walk = (dir) => {
      for (const name of fs.readdirSync(path.join(state.run, 'app', dir))) {
        const rel = `${dir}${name}`;
        const stat = fs.lstatSync(path.join(state.run, 'app', rel));
        if (stat.isDirectory()) walk(`${rel}/`);
        else if (!tracked.has(rel)) extras.push(rel);
      }
    };
    walk(scope);
  }
  return { files: listing.length, mismatches, extras };
}

async function deployFunctions(state, logName) {
  const app = path.join(state.run, 'app');
  runLogged(state, logName, path.join(app, 'node_modules', '.bin', 'convex'), ['deploy', '--yes', '--codegen', 'disable'], {
    cwd: app,
    env: childEnv(state, { CONVEX_SELF_HOSTED_URL: state.backend.url, CONVEX_SELF_HOSTED_ADMIN_KEY: state.secrets.adminKey }),
  });
  return deployedModuleHashes(state);
}

async function prepare(opts) {
  const repo = git(opts.repo ?? process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty) fail('The caller checkout has uncommitted tracked changes. Commit the candidate first.');
  const backendBin = path.resolve(opts['backend-bin'] ?? newestBackendBinary());
  const runsDir = path.resolve(opts['runs-dir'] ?? DEFAULT_RUNS_DIR);
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const runId = `gkv-${nowStamp().toLowerCase()}-${randomHex(3)}`;
  const run = path.join(runsDir, runId);
  for (const dir of ['', 'app', 'backend', 'home', 'logs', 'evidence', 'sessions']) fs.mkdirSync(path.join(run, dir), { recursive: true, mode: 0o700 });

  const state = {
    package: 'verify-gatekeeper', run, runId,
    candidate: { repo, sha, tree: git(repo, ['rev-parse', 'HEAD^{tree}']).trim() },
    secrets: {}, users: {},
  };
  saveState(state);
  console.log(`RUN=${run}`);

  return withLock(run, async () => {
    // Archived committed candidate; never the caller's working tree.
    execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repo, sha, path.join(run, 'app')], { env: hostEnv() });
    const app = path.join(run, 'app');
    runLogged(state, 'npm-ci.log', 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: app, env: childEnv(state, {}, { realHome: true }) });
    state.candidate.packageLockSha256 = sha256(fs.readFileSync(path.join(app, 'package-lock.json')));
    state.candidate.installedLockSha256 = sha256(fs.readFileSync(path.join(app, 'node_modules', '.package-lock.json')));

    // Owned backend on loopback with its own SQLite file and storage dir.
    const [backendPort, sitePort, appPort] = [await freePort(), await freePort(), await freePort()];
    const instanceName = runId.replace(/[^a-z0-9-]/g, '-');
    state.secrets.instanceSecret = randomHex(32);
    state.secrets.adminKey = execFileSync(backendBin, ['keygen', 'admin-key', '--instance-name', instanceName, '--instance-secret', state.secrets.instanceSecret], { encoding: 'utf8', env: childEnv(state) }).trim();
    state.backend = {
      bin: backendBin, binSha256: sha256(fs.readFileSync(backendBin)), instanceName,
      url: `http://127.0.0.1:${backendPort}`, siteUrl: `http://127.0.0.1:${sitePort}`, ports: [backendPort, sitePort],
      db: path.join(run, 'backend', 'db.sqlite3'),
    };
    state.app = { url: `http://127.0.0.1:${appPort}`, port: appPort };
    saveState(state);
    state.backend.proc = spawnOwned(state, 'backend', backendBin, [
      state.backend.db, '--interface', '127.0.0.1', '--port', String(backendPort), '--site-proxy-port', String(sitePort),
      '--instance-name', instanceName, '--instance-secret', state.secrets.instanceSecret,
      '--local-storage', path.join(run, 'backend', 'storage'), '--disable-beacon',
    ], { cwd: path.join(run, 'backend'), env: childEnv(state) });
    saveState(state);
    await waitFor('owned Convex backend', async () => (await (await fetch(`${state.backend.url}/instance_name`)).text()) === instanceName);

    // Disposable Convex Auth signing keys (never production's).
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    state.secrets.ingestKey = randomHex(24);
    state.secrets.kioskKey = randomHex(24);
    state.secrets.activityToken = randomHex(24);
    await setBackendEnv(state, {
      JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).trimEnd().replace(/\n/g, ' '),
      JWKS: JSON.stringify({ keys: [{ use: 'sig', alg: 'RS256', ...publicKey.export({ format: 'jwk' }) }] }),
      SITE_URL: state.app.url,
      CONVEX_INGEST_KEY: state.secrets.ingestKey,
    });
    state.backend.moduleHashes = await deployFunctions(state, 'convex-deploy.log');
    saveState(state);

    // Synthetic fixtures: the repository's own seed plus one portal account
    // per role, created through Convex Auth's credential store.
    const admin = adminClient(state);
    const seeded = await admin.mutation('seed:run');
    if (!seeded.seeded) fail('seed:run did not seed a fresh backend');
    const now = new Date().toISOString();
    for (const role of ROLES) {
      const email = `${role}@${EMAIL_DOMAIN}`;
      const password = randomPassword();
      const created = await admin.mutation('auth:store', { args: { type: 'createAccountFromCredentials', provider: 'password', account: { id: email, secret: password }, profile: { email } } });
      await admin.mutation('_system/frontend/addDocument', { table: 'portalMembers', documents: [{ userId: created.user._id, role, active: true, mustChangePassword: false, createdAt: now, updatedAt: now }] });
      state.users[role] = { email, userId: created.user._id };
      state.secrets[`${role}Password`] = password;
    }
    await setBackendEnv(state, { ACTIVITY_FW_GATEWAY_TOKEN: state.secrets.activityToken, ACTIVITY_FW_GATEWAY_ACCOUNT_ID: state.users.admin.userId });
    saveState(state);

    // Production build of the archived candidate, pointed at the owned backend.
    const appEnv = {
      NODE_ENV: 'production', NEXT_PUBLIC_CONVEX_URL: state.backend.url, CONVEX_INGEST_URL: state.backend.siteUrl,
      CONVEX_INGEST_KEY: state.secrets.ingestKey, KIOSK_API_KEY: state.secrets.kioskKey,
    };
    runLogged(state, 'next-build.log', process.execPath, ['node_modules/next/dist/bin/next', 'build'], { cwd: app, env: childEnv(state, appEnv) });
    state.app.buildId = fs.readFileSync(path.join(app, '.next', 'BUILD_ID'), 'utf8').trim();
    state.app.proc = spawnOwned(state, 'next', process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(appPort)], { cwd: app, env: childEnv(state, appEnv) });
    saveState(state);
    await waitFor('owned Next app health', async () => {
      const body = await (await fetch(`${state.app.url}/api/health`)).json();
      return body.status === 'ok' && body.convex === 'ok';
    });

    // Real sign-in through /login for each role; cookies saved privately.
    const browser = await launchBrowser(state);
    try {
      for (const role of ROLES) {
        const context = await isolatedContext(state, browser);
        const page = await context.newPage();
        await signIn(state, page, role);
        const file = path.join(run, 'sessions', `${role}.json`);
        await context.storageState({ path: file });
        fs.chmodSync(file, 0o600);
        await context.close();
      }
    } finally {
      await browser.close();
    }

    state.preparedAt = new Date().toISOString();
    saveState(state);
    writeEvidence(run, 'prepare.json', {
      runId, candidate: state.candidate, backend: { ...state.backend, proc: { pid: state.backend.proc.pid } },
      app: { url: state.app.url, buildId: state.app.buildId, pid: state.app.proc.pid }, users: state.users,
      fixtures: { workers: SEEDED_WORKERS, source: 'convex/seed.ts seed:run' }, preparedAt: state.preparedAt,
    });
    console.log(`Prepared ${runId} for ${sha} (app ${state.app.url}, backend ${state.backend.url}).`);
  });
}

async function doctor(run, opts) {
  const state = readState(run);
  if (!state.preparedAt) fail('This run never finished prepare; run cleanup and prepare a new run.');
  if (state.cleanedAt) fail('This run was cleaned up; prepare a new run.');
  const a = new Assertions();
  const callerRepo = git(opts.repo ?? process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const callerSha = git(callerRepo, ['rev-parse', 'HEAD']).trim();
  a.check('caller-checkout-is-candidate', callerSha === state.candidate.sha, { callerSha, candidate: state.candidate.sha });
  const identity = sourceIdentity(state);
  a.check('archived-source-matches-candidate', identity.mismatches.length === 0 && identity.extras.length === 0, identity);
  const app = path.join(run, 'app');
  a.check('dependency-identity', sha256(fs.readFileSync(path.join(app, 'package-lock.json'))) === state.candidate.packageLockSha256
    && sha256(fs.readFileSync(path.join(app, 'node_modules', '.package-lock.json'))) === state.candidate.installedLockSha256);

  // Processes: identity-checked, listening only on loopback.
  for (const [name, proc, ports] of [['backend', state.backend.proc, state.backend.ports], ['app', state.app.proc, [state.app.port]]]) {
    const alive = ownedProcessAlive(state, proc);
    a.check(`${name}-process-owned`, alive, { pid: proc.pid, cwd: procCwd(proc.pid) });
    const listeners = alive ? listenersFor(ownedTree(proc.pid)) : [];
    a.check(`${name}-loopback-only`, listeners.length > 0 && listeners.every((l) => l.startsWith('127.0.0.1:'))
      && ports.every((p) => listeners.includes(`127.0.0.1:${p}`)), listeners);
  }
  a.check('backend-binary-identity', sha256(fs.readFileSync(state.backend.bin)) === state.backend.binSha256);
  const instance = await fetch(`${state.backend.url}/instance_name`).then((r) => r.text(), () => null);
  a.check('backend-instance-owned', instance === state.backend.instanceName && state.backend.db.startsWith(run), { instance });
  const hashes = await deployedModuleHashes(state);
  a.check('deployed-functions-match-prepare', JSON.stringify(hashes) === JSON.stringify(state.backend.moduleHashes), { modules: Object.keys(hashes).length });

  const admin = adminClient(state);
  const before = await snapshot(admin);

  // Served build identity and backend target.
  const health = await fetch(`${state.app.url}/api/health`).then((r) => r.json(), () => null);
  a.check('app-health', health?.status === 'ok' && health?.convex === 'ok', health);
  const buildId = fs.readFileSync(path.join(app, '.next', 'BUILD_ID'), 'utf8').trim();
  const manifestPath = `/_next/static/${buildId}/_buildManifest.js`;
  const served = await fetch(`${state.app.url}${manifestPath}`).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : null), () => null);
  a.check('served-build-is-archived-build', buildId === state.app.buildId && served && served.equals(fs.readFileSync(path.join(app, '.next', 'static', buildId, '_buildManifest.js'))), { buildId });
  const loginHtml = await fetch(`${state.app.url}/login`).then((r) => r.text(), () => '');
  const chunks = [...new Set([...loginHtml.matchAll(/\/_next\/static\/[^"'\s]+\.js/g)].map((m) => m[0]))];
  let targetsOwned = false;
  let targetsCloud = false;
  for (const chunk of chunks) {
    const js = await fetch(`${state.app.url}${chunk}`).then((r) => r.text(), () => '');
    if (js.includes(state.backend.url)) targetsOwned = true;
    // Convex's client embeds 'happy-otter-123.convex.cloud' in an error message.
    const hosted = [...js.matchAll(/https:\/\/([a-z0-9-]+)\.convex\.(?:cloud|site)/g)].map((m) => m[1]).filter((name) => name !== 'happy-otter-123');
    if (hosted.length || js.includes('modest-bat-146')) targetsCloud = true;
  }
  a.check('served-client-targets-owned-backend', targetsOwned && !targetsCloud, { chunks: chunks.length, targetsOwned, targetsCloud });

  // Fixtures and roles.
  const members = await readTable(admin, 'portalMembers');
  const workers = await readTable(admin, 'workers');
  a.check('fixture-roles', ROLES.every((role) => members.some((m) => m.userId === state.users[role].userId && m.role === role && m.active && !m.mustChangePassword)) && members.length === ROLES.length,
    members.map((m) => m.role));
  a.check('fixture-workers', SEEDED_WORKERS.every((name) => workers.some((w) => w.name === name && w.active)), workers.map((w) => w.name));
  const browser = await launchBrowser(state);
  try {
    // Browser processes must not carry any caller-only environment variable.
    const allowedKeys = new Set(Object.keys(childEnv(state)));
    const callerOnly = Object.keys(process.env).filter((key) => !allowedKeys.has(key));
    const browserPids = ownedTree(process.pid).filter((pid) => pid !== process.pid);
    const leaked = new Set();
    for (const pid of browserPids) {
      let environ = '';
      try { environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { continue; }
      const keys = new Set(environ.split('\0').map((entry) => entry.split('=', 1)[0]));
      for (const key of callerOnly) if (keys.has(key)) leaked.add(key);
    }
    a.check('browser-env-isolated', browserPids.length > 0 && leaked.size === 0, { browserProcesses: browserPids.length, callerOnlyVariables: callerOnly.length, leaked: [...leaked] });
    for (const role of ROLES) {
      const session = await openRole(state, browser, role);
      const current = session.jwt ? await userClient(state, session.jwt).query('portalMembers:current').catch(() => null) : null;
      const stats = await session.context.request.get(`${state.app.url}/api/stats`);
      const kiosks = await session.context.request.get(`${state.app.url}/kiosks`, { maxRedirects: 0 });
      const kioskAllowed = kiosks.status() === 200;
      a.check(`session-${role}`, session.landing === '/' && current?.role === role && stats.status() === 200 && kioskAllowed === (role === 'admin'),
        { landing: session.landing, role: current?.role, stats: stats.status(), kiosks: kiosks.status(), reauthenticated: session.reauthenticated });
      await closeRole(session);
    }
  } finally {
    await browser.close();
  }

  // Integration: Command Center activity feed with a run-owned bearer token.
  const withToken = await fetch(`${state.app.url}/api/activity`, { headers: { authorization: `Bearer ${state.secrets.activityToken}` } });
  const feed = await withToken.json().catch(() => null);
  const withoutToken = await fetch(`${state.app.url}/api/activity`);
  a.check('activity-feed-integration', withToken.status === 200 && feed?.version === 1 && Array.isArray(feed?.items) && withoutToken.status === 401,
    { withToken: withToken.status, version: feed?.version, withoutToken: withoutToken.status });

  const diff = diffSnapshots(before, await snapshot(admin));
  a.check('doctor-read-only', diff.domain.length === 0, { domain: diff.domain.map(({ table, kind }) => ({ table, kind })), background: diff.background });
  a.check('run-ownership', path.basename(run) === state.runId && state.backend.db.startsWith(`${run}/`) && procCwd(state.app.proc.pid) === app);

  const result = { check: 'doctor', candidate: state.candidate.sha, runId: state.runId, at: new Date().toISOString(), passed: a.passed, firstFailure: a.failed[0]?.name ?? null, assertions: a.results, factoryDate: factoryDate(0) };
  const file = writeEvidence(run, `doctor-${nowStamp()}.json`, result);
  report(result, file);
  return result.passed;
}

function report(result, file) {
  for (const r of result.assertions) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` ${JSON.stringify(r.detail ?? '')}`}`);
  console.log(`${result.passed ? 'PASSED' : `FAILED at ${result.firstFailure}`} — evidence ${file}`);
}

async function feature(run) {
  const state = readState(run);
  if (!state.preparedAt || state.cleanedAt) fail('Run is not prepared or already cleaned up.');
  const result = await runFeature(state);
  report(result, path.join(run, result.evidenceDir, 'result.json'));
  return result.passed;
}

async function negativeControl(run) {
  const state = readState(run);
  if (!state.preparedAt || state.cleanedAt) fail('Run is not prepared or already cleaned up.');
  const file = path.join(run, 'app', DEFECT_FILE);
  const original = git(state.candidate.repo, ['show', `${state.candidate.sha}:${DEFECT_FILE}`], { encoding: 'buffer' });
  if (!fs.readFileSync(file).equals(original)) fail(`${DEFECT_FILE} in the run does not match the candidate; refusing.`);
  const source = original.toString('utf8');
  const createAt = source.indexOf('export const create = mutation(');
  const at = source.indexOf(DEFECT_FROM, createAt);
  if (createAt < 0 || at < 0 || at > source.indexOf('export const', createAt + 1)) fail('Could not locate the create role check for the disposable defect.');
  const defective = `${source.slice(0, at)}${DEFECT_TO}${source.slice(at + DEFECT_FROM.length)}`;

  const outcome = { check: 'negative-control', candidate: state.candidate.sha, defect: { file: DEFECT_FILE, from: DEFECT_FROM, to: DEFECT_TO, scope: 'attendanceCorrections.create only, run-owned backend only' } };
  let defectResult;
  let correctedResult;
  try {
    fs.writeFileSync(file, defective);
    const defectHashes = await deployFunctions(state, 'convex-deploy-defect.log');
    outcome.defectDeployedChangedModules = Object.keys(defectHashes).filter((k) => defectHashes[k] !== state.backend.moduleHashes[k]);
    defectResult = await runFeature(state, { label: 'negative-defect' });
  } finally {
    fs.writeFileSync(file, original);
    const restored = await deployFunctions(state, 'convex-deploy-restore.log');
    outcome.restoredMatchesPrepare = JSON.stringify(restored) === JSON.stringify(state.backend.moduleHashes);
  }
  if (outcome.restoredMatchesPrepare) correctedResult = await runFeature(state, { label: 'negative-corrected' });
  outcome.defect = { ...outcome.defect, passed: defectResult.passed, failed: defectResult.assertions.filter((r) => !r.ok).map((r) => r.name), evidence: defectResult.evidenceDir };
  outcome.corrected = correctedResult ? { passed: correctedResult.passed, firstFailure: correctedResult.firstFailure, evidence: correctedResult.evidenceDir } : null;
  outcome.passed = !defectResult.passed && defectResult.assertions.some((r) => r.name === 'viewer-convex-mutation-denied' && !r.ok)
    && outcome.restoredMatchesPrepare && Boolean(correctedResult?.passed);
  const out = writeEvidence(run, `negative-control-${nowStamp()}.json`, outcome);
  console.log(`Defect candidate: ${defectResult.passed ? 'PASSED (control did not catch it)' : `FAILED as expected at ${defectResult.assertions.filter((r) => !r.ok).map((r) => r.name).join(', ')}`}`);
  console.log(`Corrected candidate: ${correctedResult?.passed ? 'PASSED' : `FAILED ${correctedResult?.firstFailure ?? '(not run: restore mismatch)'}`}`);
  console.log(`${outcome.passed ? 'NEGATIVE CONTROL PASSED' : 'NEGATIVE CONTROL FAILED'} — evidence ${out}`);
  return outcome.passed;
}

async function stopOwned(state, proc, name) {
  if (!proc?.pid) return `${name}: never started`;
  if (!ownedProcessAlive(state, proc)) return `${name}: not running (or pid reused; left alone)`;
  const pids = ownedTree(proc.pid);
  const ticks = new Map(pids.map((pid) => [pid, procStartTicks(pid)]));
  for (const pid of pids) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  const gone = () => pids.every((pid) => procStartTicks(pid) !== ticks.get(pid));
  for (let i = 0; i < 40 && !gone(); i += 1) await new Promise((r) => setTimeout(r, 250));
  if (!gone()) for (const pid of pids) if (procStartTicks(pid) === ticks.get(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  return `${name}: stopped ${pids.length} process(es)`;
}

async function cleanup(run) {
  const state = readState(run);
  const notes = [];
  notes.push(await stopOwned(state, state.app?.proc, 'app'));
  notes.push(await stopOwned(state, state.backend?.proc, 'backend'));
  for (const dir of ['app', 'backend', 'home', 'sessions']) {
    const target = path.join(run, dir);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      notes.push(`removed ${dir}/`);
    }
  }
  state.secrets = {};
  state.cleanedAt = state.cleanedAt ?? new Date().toISOString();
  writePrivateJson(path.join(run, 'state.json'), state);
  writeEvidence(run, 'cleanup.json', { runId: state.runId, cleanedAt: state.cleanedAt, notes, retained: ['evidence/', 'logs/ (private)', 'state.json (no secrets)'] });
  for (const note of notes) console.log(note);
  console.log(`Cleaned ${state.runId}; evidence retained in ${path.join(run, 'evidence')}`);
  return true;
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const run = opts.run && path.resolve(opts.run);
  if (command !== 'prepare' && !run) fail('--run RUN is required');
  const ops = {
    prepare: () => prepare(opts),
    doctor: () => withLock(run, () => doctor(run, opts)),
    feature: () => withLock(run, () => feature(run)),
    'negative-control': () => withLock(run, () => negativeControl(run)),
    cleanup: () => withLock(run, () => cleanup(run)),
  };
  if (!ops[command]) fail('Usage: run.mjs prepare|doctor|feature|negative-control|cleanup [--run RUN]');
  const ok = await ops[command]();
  process.exitCode = ok === false ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof CheckFailure ? `verify-gatekeeper: ${error.message}` : error);
  process.exitCode = 2;
});
