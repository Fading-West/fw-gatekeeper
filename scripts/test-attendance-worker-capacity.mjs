// Real backend regression: convex-test does not count documents discarded by
// query filters. Run under the shared heavy-work flock; see the review note.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as h from '../.agents/skills/verify-gatekeeper/lib/common.mjs';
import { setBackendEnv, deployedModuleHashes } from '../.agents/skills/verify-gatekeeper/lib/convex-admin.mjs';

const repo = process.cwd();
const baseline = process.argv.includes('--baseline');
const noteBytes = process.argv.includes('--notes') ? 1024 : 0;
const binFlag = process.argv.indexOf('--backend-bin');
assert(binFlag >= 0 && process.argv[binFlag + 1], 'Pass --backend-bin PATH');
const bin = path.resolve(process.argv[binFlag + 1]);
for (const directory of [repo, os.tmpdir()]) {
  const disk = fs.statfsSync(directory);
  assert(disk.bavail * disk.bsize >= 5 * 1024 ** 3, `Less than 5 GiB available: ${directory}`);
}
const available = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1]);
assert(available >= 6 * 1024 ** 2, 'Less than 6 GiB MemAvailable');

const run = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-worker-capacity-'));
const app = path.join(run, 'app');
for (const dir of ['app', 'backend', 'home', 'logs', 'evidence']) {
  fs.mkdirSync(path.join(run, dir), { recursive: true, mode: 0o700 });
}
// Only source/config and this checkout's dependencies; no caller .env or credentials.
for (const dir of ['convex', 'src']) fs.cpSync(path.join(repo, dir), path.join(app, dir), { recursive: true });
fs.copyFileSync(path.join(repo, 'package.json'), path.join(app, 'package.json'));
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(app, 'node_modules'));
if (baseline) fs.writeFileSync(path.join(app, 'convex/attendanceReads.ts'),
  h.git(repo, ['show', '8c6c8ba4446cf7cfef2d4cac2a520da299d43e7b:convex/attendanceReads.ts']));
const require = createRequire(path.join(app, 'package.json'));
const { ConvexHttpClient } = require('convex/browser');
const { makeFunctionReference } = require('convex/server');
const state = { run, secrets: { instanceSecret: h.randomHex(32) } };
const port = await h.freePort(), sitePort = await h.freePort();
const instance = `worker-capacity-${h.randomHex(5)}`;
state.backend = { url: `http://127.0.0.1:${port}` };
state.secrets.adminKey = execFileSync(bin, [
  'keygen', 'admin-key', '--instance-name', instance, '--instance-secret', state.secrets.instanceSecret,
], { env: h.childEnv(state), encoding: 'utf8' }).trim();
const evidence = {
  sourceSha: h.git(repo, ['rev-parse', 'HEAD']).trim(), baseline, noteBytes,
  binarySha256: h.sha256(fs.readFileSync(bin)),
  attendanceReadsSha256: h.sha256(fs.readFileSync(path.join(app, 'convex/attendanceReads.ts'))),
  workerRows: 4, unrelatedRows: 33000, results: [],
};
// This fixture module exists only in the disposable copy. It never ships in convex/.
fs.writeFileSync(path.join(app, 'convex/capacityFixture.ts'), `
import { internalMutation } from './_generated/server';
import { v } from 'convex/values';
const timestamps = ['2026-09-01T07:00:00', '2026-09-01T12:01:00Z',
  '2026-09-02T09:00:00+14:00', '2026-09-01T16:00:00-05:00'];
export const setup = internalMutation({
  args: {}, returns: v.object({workerId: v.id('workers'), userId: v.id('users')}),
  handler: async ctx => {
    const userId = await ctx.db.insert('users', {email: 'capacity@verify-gatekeeper.invalid'});
    await ctx.db.insert('portalMembers', {userId, role: 'admin', active: true, createdAt: '2026-09-01'});
    const workerId = await ctx.db.insert('workers', {name: 'Tiny history', department: 'Operations',
      active: true, enrolledAt: '2026-09-01'});
    for (const timestamp of timestamps) await ctx.db.insert('attendance', {
      workerId, timestamp, eventType: 'clock_in', synced: true,
    });
    return {workerId, userId};
  },
});
export const clutter = internalMutation({
  args: {count: v.number(), noteBytes: v.number()}, returns: v.null(),
  handler: async (ctx, {count, noteBytes}) => {
    for (let i = 0; i < count; i++) await ctx.db.insert('attendance', {
      workerId: 'unrelated-worker', timestamp: '2026-09-01T08:00:00',
      eventType: 'clock_in', synced: true, ...(noteBytes ? {note: 'x'.repeat(noteBytes)} : {}),
    });
    return null;
  },
});
// Invalidate prior worker queries as well, so the capacity pass cannot be cached.
export const touch = internalMutation({
  args: {workerId: v.string()}, returns: v.null(), handler: async (ctx, {workerId}) => {
    const row = await ctx.db.query('attendance').withIndex('by_worker', q => q.eq('workerId', workerId)).first();
    await ctx.db.patch(row!._id, {note: 'fresh capacity read'});
    return null;
  },
});
`);
let proc;
try {
  proc = h.spawnOwned(state, 'backend', bin, [
    path.join(run, 'backend/db.sqlite3'), '--interface', '127.0.0.1', '--port', String(port),
    '--site-proxy-port', String(sitePort), '--instance-name', instance,
    '--instance-secret', state.secrets.instanceSecret,
    '--local-storage', path.join(run, 'backend/storage'), '--disable-beacon',
  ], { cwd: path.join(run, 'backend'), env: h.childEnv(state) });
  await h.waitFor('owned backend', async () =>
    (await (await fetch(`${state.backend.url}/instance_name`)).text()) === instance);
  assert(h.listenersFor([proc.pid]).every(address => address.startsWith('127.0.0.1:')));
  await setBackendEnv(state, { SITE_URL: `http://127.0.0.1:${sitePort}` });
  h.runLogged(state, 'deploy.log', path.join(app, 'node_modules/.bin/convex'),
    ['deploy', '--yes', '--codegen', 'disable', '--typecheck', 'disable'], {
      cwd: app, env: h.childEnv(state, {
        CONVEX_SELF_HOSTED_URL: state.backend.url, CONVEX_SELF_HOSTED_ADMIN_KEY: state.secrets.adminKey,
      }),
    });
  evidence.moduleHashes = await deployedModuleHashes(state);
  const admin = new ConvexHttpClient(state.backend.url, { logger: false });
  admin.setAdminAuth(state.secrets.adminKey);
  const fixture = await admin.mutation(makeFunctionReference('capacityFixture:setup'), {});
  const portal = new ConvexHttpClient(state.backend.url, { logger: false });
  // Owned admin impersonation exercises the real portal access checks; no JWT secrets needed.
  portal.setAdminAuth(state.secrets.adminKey, { subject: fixture.userId, issuer: 'https://capacity.invalid' });
  async function query(stage, includeCorrections) {
    try {
      const rows = await portal.query(makeFunctionReference('attendance:list'), {
        date: '2026-09-01', workerId: fixture.workerId, includeCorrections,
      });
      assert.equal(rows.length, 4);
      assert(rows.every(row => row.worker_id === fixture.workerId));
      assert.deepEqual(rows.map(row => row.timestamp_utc), [
        '2026-09-01T21:00:00Z', '2026-09-01T19:00:00Z',
        '2026-09-01T12:01:00Z', '2026-09-01T12:00:00Z',
      ]);
      evidence.results.push({ stage, includeCorrections, ok: true, rows: rows.length });
    } catch (error) {
      evidence.results.push({ stage, includeCorrections, ok: false, error: String(error) });
    }
  }
  await query('tiny-history', false);
  await query('tiny-history', true);
  assert(evidence.results.every(result => result.ok), 'Small fixture must work before adding clutter');
  for (let i = 0; i < 33; i++) {
    // Respect this local binary's 4 MiB/s write-rate limit (including indexes).
    await new Promise(resolve => setTimeout(resolve, 1000));
    await admin.mutation(makeFunctionReference('capacityFixture:clutter'), { count: 1000, noteBytes });
  }
  await admin.mutation(makeFunctionReference('capacityFixture:touch'), { workerId: fixture.workerId });
  await query('with-unrelated-history', false);
  await query('with-unrelated-history', true);
  assert(evidence.results.every(result => result.ok), 'Worker read failed with unrelated attendance');
} catch (error) {
  evidence.failure = String(error);
  process.exitCode = 1;
} finally {
  if (proc && h.procStartTicks(proc.pid) !== null) {
    assert(h.ownedProcessAlive(state, proc), 'Backend ownership mismatch; refusing cleanup');
    process.kill(-proc.pgid, 'SIGTERM');
    await h.waitFor('owned backend stop', () => !h.ownedProcessAlive(state, proc));
  }
  fs.writeFileSync(path.join(run, 'evidence/result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  for (const dir of ['app', 'backend', 'home']) fs.rmSync(path.join(run, dir), { recursive: true, force: true });
  console.log(JSON.stringify(evidence.results, null, 2));
  console.log(`Evidence and private logs: ${run}`);
  if (evidence.failure) console.error(evidence.failure);
}
