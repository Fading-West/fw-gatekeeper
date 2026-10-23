import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(root, '.next'), { recursive: true });
const fixture = mkdtempSync(join(root, '.next/api-cache-contract-'));
const next = join(root, 'node_modules/next/dist/bin/next');
const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
let server;
let output = '';

const write = (path, contents) => {
  mkdirSync(join(fixture, path, '..'), { recursive: true });
  writeFileSync(join(fixture, path), contents);
};

try {
  // Exercise the real config on production HTTP responses, independent of
  // Convex availability or authentication. Route fixtures deliberately omit
  // Cache-Control, just like the affected portal handlers.
  copyFileSync(join(root, 'next.config.js'), join(fixture, 'next.config.js'));
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  write('package.json', '{"private":true}');
  write('app/api/[...path]/route.js', `
export const dynamic = 'force-dynamic';
export function GET(request) {
  const params = new URL(request.url).searchParams;
  if (params.has('throw')) throw new Error('Synthetic backend failure');
  if (params.has('stream')) {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('private stream'));
        controller.close();
      },
    }));
  }
  return Response.json({ workers: [{ face_encoding: Array(512).fill(0.1) }] },
    { status: Number(params.get('status') || 200) });
}
export const POST = GET;
export const DELETE = GET;
`);
  write('proxy.js', `
import { NextResponse } from 'next/server';
export function proxy(request) {
  const status = request.nextUrl.searchParams.get('proxyStatus');
  return status ? NextResponse.json({ error: 'Denied' }, { status: Number(status) }) : NextResponse.next();
}
export const config = { matcher: ['/api/:path*'] };
`);
  write('app/public/route.js', `
export const dynamic = 'force-dynamic';
export function GET() {
  return new Response('public', { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
`);

  const build = spawnSync(process.execPath, [next, 'build', '--webpack'], {
    cwd: fixture, env, encoding: 'utf8', timeout: 120_000,
  });
  if (build.error) throw build.error;
  assert.equal(build.status, 0, `Contract fixture build failed:\n${build.stdout}\n${build.stderr}`);

  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const { port } = portProbe.address();
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  server = spawn(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Next server startup timed out:\n${output}`)), 30_000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Next server exited (${code}):\n${output}`)); });
    server.stdout.on('data', () => {
      if (output.includes('Ready in')) { clearTimeout(timeout); resolve(); }
    });
  });

  const check = async (path, method = 'GET', status = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, status, `${method} ${path} status`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', `${method} ${path} must prevent caching`);
    return response.text();
  };
  for (const path of ['/api/sync?kiosk_id=entry', '/api/workers', '/api/attendance', '/api/health', '/api/activity', '/api/convex-auth']) {
    await check(path);
  }
  await check('/api/kiosks/credentials', 'POST'); // issuance and rotation
  await check('/api/kiosks/credentials', 'DELETE');
  await check('/api/enroll', 'POST');
  for (const status of [401, 403, 500]) {
    await check(`/api/sync?status=${status}`, 'GET', status);
  }
  for (const status of [401, 403]) {
    await check(`/api/sync?proxyStatus=${status}`, 'GET', status);
  }
  await check('/api/sync?throw=1', 'GET', 500);
  assert.equal(await check('/api/sync?stream=1'), 'private stream');
  const publicResponse = await fetch(`http://127.0.0.1:${port}/public`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(publicResponse.headers.get('cache-control'), 'public, max-age=3600', 'Non-API caching should be preserved');
  await publicResponse.text();
  console.log('Production API cache-control contract passed');
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGKILL');
    await exited;
  }
  rmSync(fixture, { recursive: true, force: true });
}
