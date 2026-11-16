/** Dev tool: screenshot sections of the generated report for a visual check. npx tsx scripts/shot-report.ts [dark] */
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
(async () => {
  const out = process.env.SHOT_DIR || path.join(__dirname, '..', 'test-results', 'report-shots');
  fs.mkdirSync(out, { recursive: true });
  const dark = process.argv[2] === 'dark';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) errors.push('external request: ' + r.url()); });
  await page.goto('file://' + path.join(__dirname, '..', 'reports', 'perf-report.html'));
  for (const id of ['scorecard', 'issues', 'pageload', 'throttle', 'lighthouse', 'quality', 'unstable', 'method']) {
    const el = page.locator('#' + id);
    if (await el.count()) await el.screenshot({ path: path.join(out, `${dark ? 'dark-' : ''}${id}.png`) }).catch((e) => console.log(id, 'shot failed', e.message.split('\n')[0]));
  }
  await page.locator('header.hero').screenshot({ path: path.join(out, `${dark ? 'dark-' : ''}header.png`) });
  const v = page.locator('#wf2-desktop');
  if (await v.count()) {
    await v.locator('details.step').nth(0).evaluate((d: HTMLDetailsElement) => (d.open = true));
    await v.locator('details.step').nth(1).evaluate((d: HTMLDetailsElement) => (d.open = true));
    await v.screenshot({ path: path.join(out, `${dark ? 'dark-' : ''}wf2-desktop.png`) });
  }
  const w3 = page.locator('#wf3-mobile-slow4g');
  if (await w3.count()) {
    await w3.locator('details.step').nth(1).evaluate((d: HTMLDetailsElement) => (d.open = true));
    await w3.screenshot({ path: path.join(out, `${dark ? 'dark-' : ''}wf3-mobile.png`) });
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log('horizontal overflow:', overflow, '| console/page errors + external requests:', errors.length, errors.slice(0, 5));
  await browser.close();
})();
