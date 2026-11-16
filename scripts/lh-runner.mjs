#!/usr/bin/env node
/**
 * Runs one Lighthouse audit (or one user-flow timespan) inside a page that already exists in a
 * Chromium launched by Playwright with --remote-debugging-port. That page lives in a browser context
 * loaded with the saved storageState, so authenticated pages are audited signed in.
 *
 * Lighthouse is ESM-only, the Playwright project is CommonJS: hence this separate process.
 *
 *   node scripts/lh-runner.mjs --mode=audit --port=9222 --marker=lh-target --url=https://… \
 *        --formFactor=desktop|mobile --json=out.json --html=out.html
 *   node scripts/lh-runner.mjs --mode=flow  --port=9222 --marker=lh-target --base=https://front.page --json=… --html=…
 *
 * stdout: one JSON line with a summary. Screenshots are disabled: the signed-in pages show the account name.
 */
import fs from 'node:fs';
import lighthouse, { desktopConfig, startFlow } from 'lighthouse';
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=');
    return [a.slice(2, i), a.slice(i + 1)];
  }),
);
const port = Number(args.port || 9222);
const marker = args.marker || 'lh-target';

const FLAGS = {
  logLevel: 'error',
  output: ['json', 'html'],
  // keep cookies / storage: clearing them would sign the test account out. The HTTP cache is cleared
  // by the caller (CDP Network.clearBrowserCache) before every run instead.
  disableStorageReset: true,
  disableFullPageScreenshot: true,
  skipAudits: ['screenshot-thumbnails', 'final-screenshot'],
};

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 240_000 });
let exitCode = 0;
try {
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes(marker));
  if (!page) throw new Error(`no page with marker "${marker}" among ${pages.length} pages on port ${port}`);

  if (args.mode === 'flow') {
    const base = args.base.replace(/\/$/, '');
    await page.goto(base + '/', { waitUntil: 'load', timeout: 120_000 });
    await page.waitForSelector('textarea[placeholder*="your view on markets today"]', { visible: true, timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2500));
    const flow = await startFlow(page, { config: desktopConfig, flags: FLAGS, name: 'wf3: search a stock and open its page (timespan)' });
    await flow.startTimespan({ name: 'Type "reliance", pick RELIANCE, stock page renders' });
    const search = 'input[type="search"]';
    await page.click(search);
    await page.type(search, 'reliance', { delay: 100 });
    const option = await page.waitForSelector('::-p-xpath(//*[@role="option"][contains(., "Reliance Industries Ltd.")])', { visible: true, timeout: 30_000 });
    await option.click();
    await page.waitForFunction(() => location.pathname === '/reliance' && (document.querySelector('h1')?.textContent || '').trim() === 'RELIANCE', { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2500));
    await flow.endTimespan();
    const flowResult = await flow.createFlowResult();
    fs.writeFileSync(args.json, JSON.stringify(flowResult));
    fs.writeFileSync(args.html, await flow.generateReport());
    const step = flowResult.steps[0];
    out({ ok: true, mode: 'flow', steps: flowResult.steps.length, performance: step?.lhr?.categories?.performance?.score ?? null, lighthouseVersion: step?.lhr?.lighthouseVersion });
  } else {
    const config = args.formFactor === 'desktop' ? desktopConfig : undefined;
    const result = await lighthouse(args.url, FLAGS, config, page);
    if (!result) throw new Error('lighthouse returned no result');
    const [json, html] = result.report;
    fs.writeFileSync(args.json, json);
    fs.writeFileSync(args.html, html);
    const lhr = result.lhr;
    out({
      ok: !lhr.runtimeError,
      mode: 'audit',
      performance: lhr.categories.performance?.score ?? null,
      finalUrl: lhr.finalDisplayedUrl,
      runtimeError: lhr.runtimeError ? `${lhr.runtimeError.code}: ${lhr.runtimeError.message}` : null,
      warnings: lhr.runWarnings,
      lighthouseVersion: lhr.lighthouseVersion,
    });
  }
  // park the page on the marker again so the next run can find it
  await page.goto(`about:blank#${marker}`).catch(() => {});
} catch (e) {
  out({ ok: false, error: String(e && e.message ? e.message : e).split('\n')[0].slice(0, 400) });
  exitCode = 1;
} finally {
  await browser.disconnect();
}
process.exit(exitCode);
