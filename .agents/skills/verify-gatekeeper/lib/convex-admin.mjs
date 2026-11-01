// Admin access to the run-owned local Convex backend only. The URL and admin
// key always come from this run's private state; nothing reads caller config.
import { appRequire, fail } from './common.mjs';

// Tables that can change without any portal action: Convex Auth may rotate
// refresh tokens when the Next proxy refreshes a JWT, and crons (session
// expiry, kiosk alert check, people-alert retry) maintain their own state.
export const BACKGROUND_TABLES = new Set([
  'authRefreshTokens', 'authSessions', 'authRateLimits', 'authVerificationCodes', 'authVerifiers',
  'alertState', 'alertEvents', 'peopleAlertEvents',
]);

function assertLoopback(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1') fail(`Refusing non-loopback Convex URL ${parsed.origin}`);
}

export function adminClient(state) {
  assertLoopback(state.backend.url);
  const require = appRequire(state);
  const { ConvexHttpClient } = require('convex/browser');
  const { makeFunctionReference } = require('convex/server');
  const client = new ConvexHttpClient(state.backend.url, { logger: false });
  client.setAdminAuth(state.secrets.adminKey);
  return {
    query: (name, args = {}) => client.query(makeFunctionReference(name), args),
    mutation: (name, args = {}) => client.mutation(makeFunctionReference(name), args),
  };
}

// A client authenticated as a portal user (their Convex Auth JWT), or anonymous.
export function userClient(state, jwt) {
  assertLoopback(state.backend.url);
  const require = appRequire(state);
  const { ConvexHttpClient } = require('convex/browser');
  const { makeFunctionReference } = require('convex/server');
  const client = new ConvexHttpClient(state.backend.url, { logger: false });
  if (jwt) client.setAuth(jwt);
  return {
    query: (name, args = {}) => client.query(makeFunctionReference(name), args),
    mutation: (name, args = {}) => client.mutation(makeFunctionReference(name), args),
  };
}

async function paginate(admin, name, args) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 1000; i += 1) {
    const page = await admin.query(name, { ...args, paginationOpts: { numItems: 500, cursor } });
    out.push(...page.page);
    if (page.isDone) return out;
    cursor = page.continueCursor;
  }
  fail(`${name} did not finish paginating`);
}

export async function listTables(admin) {
  const tables = await paginate(admin, '_system/cli/tables', {});
  return tables.map((t) => t.name).filter((name) => !name.startsWith('_')).sort();
}

export async function readTable(admin, table) {
  return paginate(admin, '_system/cli/tableData', { table, order: 'asc' });
}

// Full snapshot of every user table: id -> canonical JSON of the document.
export async function snapshot(admin) {
  const tables = {};
  for (const table of await listTables(admin)) {
    const docs = await readTable(admin, table);
    tables[table] = Object.fromEntries(docs.map((doc) => [doc._id, JSON.stringify(doc, Object.keys(doc).sort())]));
  }
  return tables;
}

export function diffSnapshots(before, after) {
  const changes = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[table] ?? {};
    const b = after[table] ?? {};
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(id in a)) changes.push({ table, id, kind: 'added', doc: JSON.parse(b[id]) });
      else if (!(id in b)) changes.push({ table, id, kind: 'removed' });
      else if (a[id] !== b[id]) changes.push({ table, id, kind: 'changed' });
    }
  }
  return {
    domain: changes.filter((c) => !BACKGROUND_TABLES.has(c.table)),
    background: changes.filter((c) => BACKGROUND_TABLES.has(c.table)).map(({ table, kind }) => ({ table, kind })),
    rowCounts: Object.fromEntries(Object.entries(after).map(([table, docs]) => [table, Object.keys(docs).length])),
  };
}

export async function setBackendEnv(state, changes) {
  assertLoopback(state.backend.url);
  const response = await fetch(`${state.backend.url}/api/update_environment_variables`, {
    method: 'POST',
    headers: { authorization: `Convex ${state.secrets.adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ changes: Object.entries(changes).map(([name, value]) => ({ name, value })) }),
  });
  if (!response.ok) fail(`Setting backend environment failed with ${response.status}`);
}

// Module path -> bundle hash of the functions currently deployed.
export async function deployedModuleHashes(state) {
  assertLoopback(state.backend.url);
  const response = await fetch(`${state.backend.url}/api/get_config_hashes`, {
    method: 'POST',
    headers: { authorization: `Convex ${state.secrets.adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: '1.0.0', adminKey: state.secrets.adminKey }),
  });
  if (!response.ok) fail(`Reading deployed module hashes failed with ${response.status}`);
  const data = await response.json();
  return Object.fromEntries((data.moduleHashes ?? []).map((m) => [m.path, m.hash]).sort(([a], [b]) => a.localeCompare(b)));
}
