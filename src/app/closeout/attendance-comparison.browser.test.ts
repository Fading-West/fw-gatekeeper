/// <reference types="vite/client" />
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { convexTest } from 'convex-test';
import type { FunctionArgs } from 'convex/server';
import { NextRequest } from 'next/server';
import schema from '../../../convex/schema';
import { api, internal } from '../../../convex/_generated/api';
import { GET, PATCH } from '../api/shift-closeout/route';

const bridge = vi.hoisted(() => ({
  role: 'enrollment',
  query: null as null | ((ref: unknown, args: unknown) => Promise<unknown>),
  mutation: null as null | ((ref: unknown, args: unknown) => Promise<unknown>),
  mode: 'normal',
}));
vi.mock('@/lib/convex', () => ({ default: {
  query: (ref: unknown, args: unknown) => bridge.query!(ref, args),
  mutation: (ref: unknown, args: unknown) => bridge.mutation!(ref, args),
} }));
// The browser uses synthetic roles; this is not an external login test.
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: async (_req: unknown, roles: string[]) => roles.includes(bridge.role) }));

const modules = import.meta.glob('../../../convex/**/*.ts');
const date = '2026-09-02';
const output = fileURLToPath(new URL('../../../output/playwright/signed-attendance/', import.meta.url));
let browser: Browser;
let bundle = '';
let css = '';
let revision = '';

// Explicit opt-in prevents a normal unit-suite run from retrying a denied local
// browser launch. CI supplies an installed Chromium and runs this suite normally.
// A launch failure in an opted-in run is an error, never passing interaction QA.
describe.skipIf(!process.env.CI && process.env.GATEKEEPER_BROWSER_QA !== '1')('synthetic closeout browser acceptance', () => {
beforeAll(async () => {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const runtime = fileURLToPath(new URL('./__browser__/runtime.tsx', import.meta.url));
  const result = await build({
    configFile: false, logLevel: 'silent', mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    resolve: { alias: [
      { find: 'next/navigation', replacement: runtime }, { find: 'next/link', replacement: runtime },
      { find: '@/hooks/usePortalRole', replacement: runtime }, { find: '@/hooks/useCloseoutActor', replacement: runtime }, { find: '@/components/Toast', replacement: runtime },
      { find: '@', replacement: fileURLToPath(new URL('../..', import.meta.url)) },
    ] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL('./__browser__/page-fixture.tsx', import.meta.url)), formats: ['iife'], name: 'CloseoutFixture' } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(part => 'output' in part ? part.output : []);
  bundle = outputs.map(chunk => 'code' in chunk ? chunk.code : '').join('\n');
  css = outputs.filter(chunk => chunk.fileName.endsWith('.css')).map(chunk => 'source' in chunk ? String(chunk.source) : '').join('\n');
}, 60_000);

afterAll(async () => { await browser?.close(); });

async function setup(role = 'enrollment', viewport = { width: 1360, height: 1000 }) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'browser-synthetic@example.invalid' });
    await ctx.db.insert('portalMembers', { userId, role: role as 'enrollment' | 'viewer', active: true, createdAt: `${date}T00:00:00Z` });
    const workerId = await ctx.db.insert('workers', { name: 'Synthetic Late Punch', department: 'QA', active: false, enrolledAt: `${date}T00:00:00Z` });
    return { userId, workerId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  bridge.role = role;
  bridge.mode = 'normal';
  bridge.query = async (_ref, args) => {
    if (bridge.mode === 'failure') throw new Error('Synthetic backend unavailable');
    const result = await actor.query(api.shiftCloseouts.get, args as FunctionArgs<typeof api.shiftCloseouts.get>) as Record<string, unknown>;
    if (bridge.mode === 'legacy') delete result.attendance_comparison;
    return result;
  };
  bridge.mutation = (_ref, args) => actor.mutation(api.shiftCloseouts.save, args as FunctionArgs<typeof api.shiftCloseouts.save>);
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://fixture.test/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/shift-closeout')) {
      const req = new NextRequest(request.url(), { method: request.method(), ...(request.method() === 'PATCH' ? { headers: { 'content-type': 'application/json' }, body: request.postData()! } : {}) });
      const response = request.method() === 'PATCH' ? await PATCH(req) : await GET(req);
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    } else if (url.pathname === '/api/attendance') {
      await route.fulfill({ json: await actor.query(api.attendance.list, { date: url.searchParams.get('date') || date }) });
    } else if (url.pathname === '/api/attendance-corrections') {
      await route.fulfill({ json: { date, corrections: await actor.query(api.attendanceCorrections.list, { date }) } });
    } else if (url.pathname === '/api/workers') {
      await route.fulfill({ json: [] });
    } else if (url.pathname === '/fixture.js') {
      await route.fulfill({ contentType: 'text/javascript', body: bundle });
    } else if (url.pathname === '/fixture.css') {
      await route.fulfill({ contentType: 'text/css', body: css });
    } else {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body class="bg-navy-950 text-slate-100"><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    }
  });
  await page.goto(`https://fixture.test/closeout?date=${date}&role=${role}&actor=${encodeURIComponent(ids.userId)}`);
  await page.getByRole('heading', { name: role === 'viewer' ? 'Ready to close shift' : 'Ready to close shift', exact: true }).waitFor();
  return { t, actor, page, errors, ...ids };
}

async function snap(page: Page, name: string) { await page.screenshot({ path: `${output}/${name}.png`, fullPage: true }); }
async function complete(page: Page) {
  await page.getByRole('textbox', { name: /^Closeout notes/ }).fill('Synthetic attendance evidence reviewed.');
  const acknowledgement = page.locator('input[type="checkbox"]');
  if (await acknowledgement.count()) await acknowledgement.check();
  await page.getByRole('button', { name: 'Complete closeout', exact: true }).click();
  await page.getByText('No attendance evidence changes detected', { exact: true }).waitFor();
}

it('runs closeout, late evidence, Activity Log review, export, and explicit re-sign with immutable history', async () => {
  const { page, t, actor, workerId, errors } = await setup();
  try {
    await complete(page);
    await snap(page, '01-signed-empty');
    const before = await actor.query(api.shiftCloseouts.get, { date });
    const original = await t.run(ctx => ctx.db.query('shiftCloseouts').withIndex('by_date', q => q.eq('date', date)).first());
    await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ workerId, eventType: 'clock_in', timestamp: `${date}T05:30:00.123456Z`, kioskId: 'synthetic-browser', idempotencyKey: 'delayed-punch' }] });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'Attendance changed since signoff', exact: true }).first().waitFor();
    await snap(page, '02-late-evidence-changed');
    expect(await page.locator('[aria-label="Signed summary"]').count()).toBe(1);
    const after = await t.run(ctx => ctx.db.get(original!._id));
    expect(after).toEqual(original);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = `${output}/closeout-export.txt`;
    await download.saveAs(downloadPath);
    const exported = await readFile(downloadPath, 'utf8');
    expect(exported).toContain('Attendance changed since signoff');
    expect(exported).toContain('Signed summary');
    expect(exported).toContain('Current summary');
    expect(exported).toContain('0 raw punches');
    expect(exported).toContain('1 raw punches');
    await page.getByRole('link', { name: 'Review attendance in Activity Log →' }).click();
    await page.getByRole('heading', { name: 'Activity Log', exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.get('date')).toBe(date);
    await page.getByText('Synthetic Late Punch', { exact: true }).first().waitFor();
    await snap(page, '03-activity-log-review');
    await page.goBack();
    await page.getByRole('button', { name: 'Reopen', exact: true }).click();
    await page.getByRole('button', { name: 'Complete closeout', exact: true }).waitFor();
    await complete(page);
    await snap(page, '04-recompleted');
    const history = await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect());
    expect(history).toHaveLength(3);
    expect(history[1].before?.signedAttendanceEvidence).toEqual(original?.signedAttendanceEvidence);
    expect(history[2].after.signedAttendanceEvidence?.raw_punches).toBe(1);
    expect(before.attendance_comparison.status).toBe('unchanged');
    expect(errors).toEqual([]);
    await writeFile(`${output}/journey.json`, JSON.stringify({ revision, timestamp: new Date().toISOString(), kind: 'synthetic authenticated browser with real routes and in-memory Convex; session validation mocked', status: 'passed', history: history.map(row => ({ action: row.action, signed: row.after.signedAttendanceEvidence })) }, null, 2));
  } finally { await page.close(); }
}, 90_000);

it('shows viewer review controls, denies writes, and keeps legacy/failed loads from claiming unchanged', async () => {
  const { page, t, actor, errors } = await setup('viewer', { width: 390, height: 844 });
  try {
    const id = await t.run(ctx => ctx.db.insert('shiftCloseouts', { date, status: 'completed', notes: 'Original legacy note', acknowledgedBlockers: false, expected: 9, present: 8, late: 1, missing: 1, openExceptions: 0, criticalExceptions: 0, kioskWarnings: 0, completedAt: `${date}T22:00:00Z`, createdAt: `${date}T20:00:00Z`, updatedAt: `${date}T22:00:00Z` }));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'Attendance comparison unavailable', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Reopen', exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Review-only', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('textbox', { name: /^Closeout notes/ }).getAttribute('readonly')).not.toBeNull();
    const result = await page.evaluate(async ({ date }) => {
      const response = await fetch('/api/shift-closeout', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date, action: 'reopen' }) });
      return response.status;
    }, { date });
    expect(result).toBe(401);
    await expect(actor.mutation(api.shiftCloseouts.save, { date, action: 'reopen', requestId: 'viewer-reopen', expectedRevision: 0 })).rejects.toThrow();
    await snap(page, '05-viewer-legacy-mobile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    bridge.mode = 'failure';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'Closeout unavailable', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Export', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByText('No attendance evidence changes detected', { exact: true }).count()).toBe(0);
    expect((await t.run(ctx => ctx.db.get(id)))?.notes).toBe('Original legacy note');
    expect(errors).toEqual([]);
    await snap(page, '06-failed-load-mobile');
  } finally { await page.close(); }
}, 90_000);

it('retains changed evidence after correction reversal and preserves signed data with an older backend response', async () => {
  const { page, t, actor, workerId, errors } = await setup();
  try {
    await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ workerId, eventType: 'clock_in', timestamp: `${date}T13:00:00Z`, kioskId: 'synthetic-browser', idempotencyKey: 'correction-control' }] });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Complete closeout', exact: true }).waitFor();
    await complete(page);
    const original = await t.run(ctx => ctx.db.query('shiftCloseouts').withIndex('by_date', q => q.eq('date', date)).first());
    const effective = await actor.query(api.attendance.list, { date });
    const attendance = await t.run(ctx => ctx.db.query('attendance').first());
    const correction = await actor.mutation(api.attendanceCorrections.create, { date, workerId, action: 'void_event', originalAttendanceId: attendance!._id, reason: 'Synthetic correction review' });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'Attendance changed since signoff', exact: true }).first().waitFor();
    await actor.mutation(api.attendanceCorrections.reverse, { correctionId: correction.id, reason: 'Synthetic reversal control', requestId: 'browser-correction-reversal' });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Current evidence: 1 raw punches, 1 corrections, 1 reversals', { exact: true }).waitFor();
    expect(await actor.query(api.attendance.list, { date })).toEqual(effective);
    expect(await t.run(ctx => ctx.db.get(original!._id))).toEqual(original);
    await snap(page, '07-correction-reversed-still-changed');
    bridge.mode = 'legacy';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'Attendance comparison unavailable', exact: true }).waitFor();
    expect(await page.locator('[aria-label="Signed summary"]').count()).toBe(1);
    expect(await page.getByRole('textbox', { name: /^Closeout notes/ }).inputValue()).toBe('Synthetic attendance evidence reviewed.');
    expect(await page.getByText('No attendance evidence changes detected', { exact: true }).count()).toBe(0);
    expect(await t.run(ctx => ctx.db.get(original!._id))).toEqual(original);
    await snap(page, '08-older-backend-retains-signature');
    bridge.mode = 'normal';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'Attendance changed since signoff', exact: true }).first().waitFor();
    expect(errors).toEqual([]);
    await writeFile(`${output}/correction-journey.json`, JSON.stringify({ revision, timestamp: new Date().toISOString(), kind: 'synthetic browser with real closeout routes and in-memory Convex; correction mutations invoked by test actor', status: 'passed', effectiveAttendanceRestored: true, signaturePreserved: true, olderBackendUnknown: true }, null, 2));
  } finally { await page.close(); }
}, 90_000);

});
