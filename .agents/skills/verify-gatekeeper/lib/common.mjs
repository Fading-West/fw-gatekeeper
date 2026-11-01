// Shared helpers for verify-gatekeeper. No third-party imports: runtime
// packages (convex, playwright-core) are loaded from the run's archived app.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const FACTORY_TIME_ZONE = 'America/Chicago';
export const DEFAULT_RUNS_DIR = path.join(os.homedir(), '.cache', 'fw-gatekeeper-verify', 'runs');
export const ROLES = ['admin', 'enrollment', 'viewer'];
export const EMAIL_DOMAIN = 'verify-gatekeeper.invalid';

export class CheckFailure extends Error {}

export function fail(message) {
  throw new CheckFailure(message);
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function gitBlobHash(content) {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

export function randomPassword() {
  // Synthetic per-run password; long enough for the portal password policy.
  return `Gk-${randomBytes(18).toString('base64url')}`;
}

export function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: options.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function writeEvidence(run, name, value) {
  const file = path.join(run, 'evidence', name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export function readState(run) {
  const file = path.join(run, 'state.json');
  if (!fs.existsSync(file)) fail(`No state.json in ${run}; not a verify-gatekeeper run directory.`);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.package !== 'verify-gatekeeper' || path.resolve(state.run) !== path.resolve(run)) {
    fail(`State in ${run} does not belong to this run directory.`);
  }
  return state;
}

export function saveState(state) {
  writePrivateJson(path.join(state.run, 'state.json'), state);
}

export function appRequire(state) {
  return createRequire(path.join(state.run, 'app', 'package.json'));
}

// Every child gets an explicit environment: caller variables (deployment
// keys, CONVEX_DEPLOYMENT, .env exports) never reach the candidate.
export function childEnv(state, extra = {}, { realHome = false } = {}) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: realHome ? os.homedir() : path.join(state.run, 'home'),
    LANG: 'C.UTF-8',
    NEXT_TELEMETRY_DISABLED: '1',
    CONVEX_TELEMETRY_DISABLED: '1',
    DISABLE_BEACON: '1',
  };
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

export function runLogged(state, logName, command, args, { cwd, env, timeoutMs = 600_000 } = {}) {
  const logFile = path.join(state.run, 'logs', logName);
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    execFileSync(command, args, { cwd, env, stdio: ['ignore', fd, fd], timeout: timeoutMs });
  } catch (error) {
    fail(`${path.basename(command)} ${args.slice(0, 2).join(' ')} failed (${error.status ?? error.signal ?? error.code}); see logs/${logName}`);
  } finally {
    fs.closeSync(fd);
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Process identity is pid + kernel start time + the run path on the command
// line or as cwd. A recycled pid never matches.
export function procStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return null;
  }
}

export function procCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

export function procCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

export function ownedProcessAlive(state, proc) {
  if (!proc?.pid) return false;
  if (procStartTicks(proc.pid) !== proc.startTicks) return false;
  const cmd = procCmdline(proc.pid) ?? [];
  const cwd = procCwd(proc.pid) ?? '';
  return cmd.some((part) => part.includes(state.run)) || cwd.startsWith(state.run);
}

export function spawnOwned(state, name, command, args, { cwd, env }) {
  const logFile = path.join(state.run, 'logs', `${name}.log`);
  const fd = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child.unref();
  const startTicks = procStartTicks(child.pid);
  return { pid: child.pid, pgid: child.pid, startTicks, command: [command, ...args.filter((a) => !a.startsWith('--instance-secret'))].slice(0, 6) };
}

// Pids of owned processes plus their descendants (Next may fork workers).
export function ownedTree(rootPid) {
  const children = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(entry));
    } catch { /* process exited */ }
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

// Listening TCP sockets for the given pids, from `ss -ltnpH`.
export function listenersFor(pids) {
  const out = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' });
  const wanted = new Set(pids.map(String));
  const result = [];
  for (const line of out.split('\n')) {
    const pidMatches = [...line.matchAll(/pid=(\d+)/g)].map((m) => m[1]);
    if (!pidMatches.some((pid) => wanted.has(pid))) continue;
    const cols = line.trim().split(/\s+/);
    result.push(cols[3]);
  }
  return result;
}

export async function waitFor(label, fn, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export function factoryDate(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: FACTORY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

export function chromiumPath(state) {
  const { chromium } = appRequire(state)('playwright-core');
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const executable = chromium.executablePath();
  if (!fs.existsSync(executable)) {
    fail(`Chromium for the candidate's playwright-core is not installed at ${executable}${env ? '' : ' (set PLAYWRIGHT_BROWSERS_PATH if browsers live elsewhere)'}.`);
  }
  return executable;
}

// Stable assertion recorder: every check is named, and a failure names the
// first assertion that failed.
export class Assertions {
  constructor() {
    this.results = [];
  }

  check(name, ok, detail = undefined) {
    this.results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    return Boolean(ok);
  }

  get failed() {
    return this.results.filter((r) => !r.ok);
  }

  get passed() {
    return this.failed.length === 0 && this.results.length > 0;
  }
}
