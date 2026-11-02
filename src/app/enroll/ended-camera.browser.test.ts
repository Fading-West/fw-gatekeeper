import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser } from 'playwright-core';

let browser: Browser | null = null;
let bundle = '';
let css = '';
beforeAll(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }); }
  catch (error) { if (process.env.CI) throw error; return; }
  const runtime = fileURLToPath(new URL('./__browser__/runtime.tsx', import.meta.url));
  const result = await build({
    configFile: false, logLevel: 'silent', mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    resolve: { alias: [
      { find: 'next/navigation', replacement: runtime },
      { find: 'next/link', replacement: runtime },
      { find: '@/hooks/usePortalRole', replacement: runtime },
      { find: '@', replacement: fileURLToPath(new URL('../..', import.meta.url)) },
    ] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { write: false, minify: false, lib: {
      entry: fileURLToPath(new URL('./__browser__/camera-fixture.tsx', import.meta.url)),
      formats: ['iife'], name: 'CameraFixture',
    } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => 'output' in output ? output.output : []);
  bundle = outputs.map(chunk => 'code' in chunk ? chunk.code : '').join('\n');
  css = outputs.filter(chunk => chunk.fileName.endsWith('.css')).map(chunk => 'source' in chunk ? String(chunk.source) : '').join('\n');
}, 60_000);
afterAll(async () => { await browser?.close(); });

it('discards an interrupted capture despite the video retaining its final frame', async context => {
  if (!browser) context.skip();
  const page = await browser!.newPage({ viewport: { width: 900, height: 900 } });
  try {
    await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><html><body><div id="root"></div></body></html>' }));
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto('https://fixture.test/');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });
    await page.getByRole('button', { name: 'Add manually' }).click();
    await page.locator('#employee-name').fill('Synthetic Camera Test');
    await page.getByRole('button', { name: 'Continue to Camera' }).click();
    await page.locator('#biometric-consent').check();
    const start = page.getByRole('button', { name: 'Start Capture' });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent?.includes('Start Capture') && !button.disabled));
    await start.click();
    await page.getByAltText('Capture 1').waitFor();
    const evidence = process.env.GATEKEEPER_CAMERA_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/capture-before-disconnect.png` });
    }
    expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => (window as unknown as { __cameraFixture: { end: () => void } }).__cameraFixture.end());
    await page.getByText('The camera stopped providing images. Reconnect it and try again.').waitFor();
    await page.waitForTimeout(3500); // Let every formerly queued capture deadline elapse.
    expect(await page.evaluate(() => (window as unknown as { __cameraFixture: { posts: () => number } }).__cameraFixture.posts())).toBe(0);
    expect(await page.getByAltText('Capture 1').count()).toBe(0);
    if (evidence) await page.screenshot({ path: `${evidence}/camera-disconnected.png` });
    await page.getByRole('button', { name: 'Try Again' }).click();
    await page.getByRole('button', { name: 'Continue to Camera' }).waitFor();
  } finally { await page.close(); }
}, 60_000);
