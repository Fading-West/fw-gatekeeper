/// <reference types="vite/client" />
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser } from 'playwright-core';

const origin = 'https://guide-fixture.test';
const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

describe.skipIf(!process.env.CI && process.env.GATEKEEPER_GUIDE_BROWSER_QA !== '1')('Guide Drawer scroll isolation', () => {
  let browser: Browser;
  let script: string;
  let css: string;
  beforeAll(async () => {
    const mocks: Record<string, string> = {
      'next/link': 'import { createElement } from "react"; export default props => createElement("a", props);',
      'next/navigation': 'export const usePathname = () => location.pathname;',
      '@/hooks/usePortalRole': 'export const usePortalRole = () => "viewer";',
    };
    const bundle = await build({
      configFile: false, logLevel: 'silent', mode: 'production',
      oxc: { jsx: { runtime: 'automatic', development: false } },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: [{ find: /^@\/(?!hooks\/usePortalRole$)/, replacement: fileURLToPath(new URL('../', import.meta.url)) }] },
      plugins: [{
        name: 'guide-fixture-mocks',
        enforce: 'pre',
        resolveId(id) { if (Object.hasOwn(mocks, id)) return '\0guide-mock:' + id; },
        load(id) { if (id.startsWith('\0guide-mock:')) return mocks[id.slice('\0guide-mock:'.length)]; },
      }],
      build: {
        write: false,
        lib: { entry: fileURLToPath(new URL('./__browser__/guide-drawer-fixture.tsx', import.meta.url)), formats: ['iife'], name: 'GuideFixture' },
      },
    });
    const output = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(part => 'output' in part ? part.output : []);
    script = output.map(file => 'code' in file ? file.code : '').join('\n');
    css = output.filter(file => file.fileName.endsWith('.css')).map(file => 'source' in file ? String(file.source) : '').join('\n');
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  }, 60_000);

  afterAll(async () => { await browser?.close(); });

  it.each(viewports)('keeps the background in place on $name until Help closes', async ({ name, width, height }) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: css });
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
        });
      });
      await page.goto(origin + '/briefing');
      const help = page.getByRole('button', { name: /^(Help|How to use this page)$/ });
      await help.waitFor();
      await page.evaluate(() => window.scrollTo(0, 80));
      await help.click();
      const dialog = page.getByRole('dialog', { name: 'How to use Shift Briefing' });
      await dialog.getByRole('button', { name: 'Close guide' }).waitFor();
      const readScroll = () => page.evaluate(() => window.scrollY);
      const before = await readScroll();
      expect(before).toBe(80);

      // Wheel over the pinned drawer heading on phone, or its backdrop on desktop.
      await page.mouse.move(width * 0.11, 45);
      await page.mouse.wheel(0, 540);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const after = await readScroll();

      const proofDir = process.env.GATEKEEPER_GUIDE_PROOF_DIR;
      if (proofDir) {
        await mkdir(proofDir, { recursive: true });
        const stage = process.env.GATEKEEPER_GUIDE_PROOF_STAGE === 'before' ? 'before' : 'after';
        await page.screenshot({ path: join(proofDir, `${name}-${stage}.png`), animations: 'disabled' });
      }
      expect(after).toBe(before);

      const tips = dialog.getByRole('heading', { name: 'Good to know' });
      await tips.scrollIntoViewIfNeeded();
      expect(await readScroll()).toBe(before);

      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      expect(await help.evaluate(element => element === document.activeElement)).toBe(true);
      await page.mouse.wheel(0, 540);
      await expect.poll(readScroll).toBeGreaterThan(before);
    } finally {
      await page.close();
    }
  });
});
