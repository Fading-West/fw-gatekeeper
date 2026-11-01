import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright-core';

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

async function openPage(options: BrowserContextOptions = { viewport: { width: 1280, height: 900 } }) {
  const page = await browser!.newPage(options);
  await page.route('https://fixture.test/**', (route) => route.fulfill({
    // Next's default viewport meta, so phone emulation lays out like the real page.
    contentType: 'text/html',
    body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
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

// Whether the element is fully inside what the phone screen shows.
function onScreen(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const screen = window.visualViewport!;
    return box.top >= screen.offsetTop && box.bottom <= screen.offsetTop + screen.height
      && box.left >= screen.offsetLeft && box.right <= screen.offsetLeft + screen.width;
  });
}

// A finger drag. Input.synthesizeScrollGesture does nothing in headless shell.
async function swipe(page: Page, fromY: number, toY: number) {
  const cdp = await page.context().newCDPSession(page);
  const step = fromY > toY ? -10 : 10;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 187, y: fromY }] });
  for (let y = fromY + step; step < 0 ? y >= toY : y <= toY; y += step) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 187, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

it.for(['add', 'void'] as const)('keeps the %s dialog on screen and reachable by touch and keyboard on a 375x667 phone', { timeout: 60_000 }, async (mode, context) => {
  if (!browser) context.skip();
  const page = await openPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  try {
    // A page wider than the phone widens the layout viewport, so the fixed
    // dialog overlay grows taller than the screen and opens partly below it.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    await page.getByRole('button', { name: mode === 'void' ? 'Correct' : 'Add missing punch', exact: true }).tap();
    const dialog = page.getByRole('dialog');
    const panel = dialog.locator('section');
    const heading = dialog.getByRole('heading', { name: mode === 'void' ? 'Correct attendance row' : 'Add missing punch' });
    expect(await onScreen(panel)).toBe(true);
    expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const worker = dialog.locator('select').first();
    if (mode === 'add') {
      await worker.selectOption('worker-1');
      await dialog.locator('input[type="time"]').fill('17:00');
    }
    await dialog.locator('textarea').fill('Synthetic correction reason');
    const save = dialog.getByRole('button', { name: mode === 'void' ? 'Void row' : 'Add punch', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });

    // Keyboard: every control the focus trap visits is scrolled onto the screen.
    await heading.focus();
    const visited: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      expect(await focused.evaluate((element) => Boolean(element.closest('[role="dialog"]')))).toBe(true);
      expect(await onScreen(focused)).toBe(true);
      visited.push(await focused.evaluate((element) => element.textContent?.trim() || element.tagName));
    }
    expect(visited).toEqual(expect.arrayContaining(['Cancel', mode === 'void' ? 'Void row' : 'Add punch']));

    // Touch: drag back to the top, then down to the actions, and tap Save.
    for (let i = 0; i < 3; i += 1) await swipe(page, 150, 550);
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await onScreen(heading)).toBe(true);
    if (mode === 'add') expect(await onScreen(worker)).toBe(true);
    expect(await onScreen(save)).toBe(false);
    for (let i = 0; i < 3; i += 1) await swipe(page, 550, 150);
    expect(await onScreen(save)).toBe(true);
    expect(await onScreen(cancel)).toBe(true);
    const box = (await save.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => (window as unknown as { __fixture: { posts: number } }).__fixture.posts === 1, null, { timeout: 3_000 });
  } finally {
    await page.close();
  }
});
