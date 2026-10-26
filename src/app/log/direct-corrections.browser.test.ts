import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';

let browser: Browser | null = null;
let bundle = '';
let css = '';

beforeAll(async () => {
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  } catch (error) {
    if (process.env.CI) throw error;
    return;
  }
  const runtime = fileURLToPath(new URL('./__browser__/runtime.tsx', import.meta.url));
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    resolve: { alias: [
      { find: 'next/navigation', replacement: runtime },
      { find: 'next/link', replacement: runtime },
      { find: '@/hooks/usePortalRole', replacement: runtime },
      { find: '@/components/Toast', replacement: runtime },
      { find: '@', replacement: fileURLToPath(new URL('../..', import.meta.url)) },
    ] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false, minify: false,
      lib: { entry: fileURLToPath(new URL('./__browser__/page-fixture.tsx', import.meta.url)), formats: ['iife'], name: 'LogFixture' },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => 'output' in output ? output.output : []);
  bundle = outputs.map((chunk) => 'code' in chunk ? chunk.code : '').join('\n');
  css = outputs.filter((chunk) => chunk.fileName.endsWith('.css'))
    .map((chunk) => 'source' in chunk ? String(chunk.source) : '').join('\n');
}, 60_000);

afterAll(async () => { await browser?.close(); });

async function openPage(viewport = { width: 1280, height: 900 }) {
  const page = await browser!.newPage({ viewport });
  await page.route('https://fixture.test/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>',
  }));
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto('https://fixture.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Correct', exact: true }).waitFor();
  return page;
}

async function waitForFocus(page: Page, name: string) {
  await page.waitForFunction((text) => document.activeElement?.textContent?.trim() === text, name, { timeout: 3_000 });
}

it.for(['void', 'add'] as const)('restores focus after a successful %s and its delayed refresh', { timeout: 60_000 }, async (mode, context) => {
  if (!browser) context.skip();
  const page = await openPage();
  try {
    await page.getByRole('button', { name: mode === 'void' ? 'Correct' : 'Add missing punch', exact: true }).click();
    if (mode === 'add') await page.locator('input[type="time"]').fill('17:00');
    await page.locator('textarea').fill('Synthetic correction reason');
    await page.getByRole('button', { name: mode === 'void' ? 'Void row' : 'Add punch', exact: true }).click();
    await page.evaluate(() => (window as unknown as { __fixture: { resolvePost: () => void } }).__fixture.resolvePost());
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await waitForFocus(page, 'Activity Log');
    await page.evaluate((remove) => (window as unknown as { __fixture: { resolveRefresh: (remove: boolean) => void } }).__fixture.resolveRefresh(remove), mode === 'void');
    // The voided row no longer exists; Add missing punch is its fallback.
    await waitForFocus(page, 'Add missing punch');
  } finally {
    await page.close();
  }
});

it('keeps the add dialog reachable and scrollable on a small viewport', async (context) => {
  if (!browser) context.skip();
  const page = await openPage({ width: 375, height: 667 });
  try {
    await page.getByRole('button', { name: 'Add missing punch', exact: true }).click();
    const heading = page.getByRole('heading', { name: 'Add missing punch' });
    const bounds = await heading.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    const panel = page.getByRole('dialog').locator('section');
    expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const worker = page.getByRole('dialog').locator('select').first();
    await worker.scrollIntoViewIfNeeded();
    await worker.selectOption('worker-1');
    await page.locator('input[type="time"]').fill('17:00');
    await page.locator('textarea').fill('Synthetic correction reason');
    await page.getByRole('button', { name: 'Add punch', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { __fixture: { posts: number } }).__fixture.posts)).toBe(1);
  } finally {
    await page.close();
  }
}, 60_000);
