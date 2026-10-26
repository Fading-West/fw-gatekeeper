import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';

// Real-browser regression: Chromium drops focus to <body> when the focused
// button becomes disabled, which react-test-renderer cannot reproduce.
// CI installs the browser; locally the test skips if none is installed.
const fixtureEntry = fileURLToPath(new URL('./__browser__/correction-dialog-fixture.tsx', import.meta.url));
let browser: Browser | null = null;
let bundle = '';

beforeAll(async () => {
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  } catch (error) {
    if (process.env.CI) throw error;
    return;
  }
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    // Vitest sets NODE_ENV=test; build the fixture as production React.
    mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    resolve: { alias: { '@': fileURLToPath(new URL('..', import.meta.url)) } },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { write: false, minify: false, lib: { entry: fixtureEntry, formats: ['iife'], name: 'CorrectionDialogFixture' } },
  });
  const outputs = Array.isArray(result) ? result : [result];
  bundle = outputs.flatMap((output) => ('output' in output ? output.output : []))
    .map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n');
}, 60_000);

afterAll(async () => { await browser?.close(); });

async function openFixture(): Promise<Page> {
  const page = await browser!.newPage();
  // Serve from an https origin: request IDs use crypto.randomUUID, which
  // needs a secure context.
  await page.route('https://fixture.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><div id="root"></div></body></html>',
  }));
  await page.goto('https://fixture.test/');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('dialog').waitFor();
  return page;
}

const focusInsideDialog = (page: Page) => page.evaluate(() => {
  const active = document.activeElement;
  return Boolean(active && active !== document.body && document.querySelector('[role="dialog"]')?.contains(active));
});

async function expectTabStaysInside(page: Page) {
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(await focusInsideDialog(page), `focus after ${key}`).toBe(true);
  }
}

it('keeps keyboard focus in the dialog while a save is pending and after it becomes uncertain', async (context) => {
  if (!browser) context.skip();
  const page = await openFixture();
  try {
    await page.locator('textarea').fill('Duplicate badge');
    const save = page.getByRole('button', { name: 'Void row' });
    await save.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Close', exact: true }).last().waitFor();

    // The focused Void row button is now disabled.
    expect(await focusInsideDialog(page)).toBe(true);
    await expectTabStaysInside(page);

    await page.evaluate(() => (window as unknown as { __fixture: { resolvePost: (status: number) => void } }).__fixture.resolvePost(401));
    await page.getByText('Sign in again to finish this save').waitFor();
    expect(await focusInsideDialog(page)).toBe(true);
    await expectTabStaysInside(page);
  } finally {
    await page.close();
  }
}, 60_000);

it('traps Tab and handles Escape even if focus has already left the dialog', async (context) => {
  if (!browser) context.skip();
  const page = await openFixture();
  try {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await focusInsideDialog(page)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Close');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Shift+Tab');
    // Void row is disabled until a reason is entered, so Cancel is last.
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Cancel');

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as unknown as { __fixture: { closed: number } }).__fixture.closed)).toBe(1);
    expect(await page.getByRole('dialog').count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);
