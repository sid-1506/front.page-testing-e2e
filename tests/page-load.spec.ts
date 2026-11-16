/**
 * Page-load performance: homepage + each workflow's entry page, in three modes per iteration:
 *   cold   - new browser context, HTTP cache disabled through CDP Network.setCacheDisabled
 *   warm   - second navigation in the same context with the cache re-enabled (primed by the cold load)
 *   reload - page.reload() once the page is fully loaded ("how long after a refresh")
 * Every iteration uses a fresh context, so cold is always a genuinely empty cache.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, BASE_URL, RUNS, RAW_DIR, RESULTS_DIR, SCREENSHOT_DIR, REPORTS_DIR, COMPOSER_RE, PAUSE_BETWEEN_RUNS_MS, writeJson, type Perf } from '../lib/perf-fixture';
import { ui, feedSignature } from '../lib/measure-step';
import { setCacheDisabled } from '../lib/throttling';
import type { PageLoadResult, PageLoadRun } from '../lib/types';

const POST_PATH_RE = /^\/[a-z0-9-]+\/\d+$/;
const ITERATIONS = Math.max(1, RUNS);

interface Target {
  key: string;
  name: string;
  path: string | null;
  ready: (page: Page) => Locator;
}

const TARGETS: Target[] = [
  { key: 'home', name: 'Home Feed', path: '/', ready: (p) => p.getByPlaceholder(COMPOSER_RE) },
  { key: 'create-post', name: 'Create Post', path: '/post/create-post', ready: (p) => p.locator('h1', { hasText: 'Create Post' }) },
  { key: 'reliance', name: 'Stock page (RELIANCE)', path: '/reliance', ready: (p) => p.getByRole('heading', { name: 'RELIANCE' }) },
  { key: 'post', name: 'Post page', path: null, ready: (p) => p.getByPlaceholder('Add a comment...') },
];

/**
 * The post page is "the URL reached in wf2 step 2". If wf2 already ran in this session its URL is reused;
 * otherwise the same two read-only clicks (New, then Comment on the first card) are performed here.
 */
async function resolvePostPath(perf: Perf): Promise<{ path: string; source: string }> {
  const file = path.join(RESULTS_DIR, 'post-url.json');
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (POST_PATH_RE.test(saved.path)) return saved;
  }
  const s = await perf.newSession();
  try {
    const { page } = s;
    await page.goto(BASE_URL + '/', { waitUntil: 'load' });
    await page.getByPlaceholder(COMPOSER_RE).waitFor({ state: 'visible', timeout: perf.uiTimeoutMs });
    await s.recorder.waitForIdle({ timeoutMs: perf.idleTimeoutMs });
    const main = page.getByRole('main');
    const before = await feedSignature(page);
    await main.getByRole('button', { name: 'New', exact: true }).click();
    await ui.feedChanged(page, before).wait(perf.uiTimeoutMs);
    await main.getByRole('button', { name: 'Comment', exact: true }).first().click();
    await page.waitForURL((u) => POST_PATH_RE.test(u.pathname), { timeout: perf.uiTimeoutMs });
    const found = { path: new URL(page.url()).pathname, source: `page-load discovery (${perf.profile.name}): same clicks as wf2 steps 1-2`, at: new Date().toISOString() };
    writeJson(file, found);
    return found;
  } finally {
    await s.context.close();
  }
}

for (const target of TARGETS) {
  test(`page load: ${target.name} (cold / warm / reload)`, async ({ perf }) => {
    const findings: string[] = [];
    let urlPath = target.path;
    if (!urlPath) {
      const r = await resolvePostPath(perf);
      urlPath = r.path;
      findings.push(`Post page URL ${r.path} from ${r.source}.`);
    }
    const url = BASE_URL + urlPath;
    const result: PageLoadResult = { kind: 'pageload', page: target.name, url: perf.redactor.url(url), profile: perf.profile.name, generatedAt: new Date().toISOString(), env: perf.env, runs: [], findings };
    const outFile = path.join(RAW_DIR, `pageload-${target.key}-${perf.profile.name}.json`);
    const failures: string[] = [];

    for (let i = 1; i <= ITERATIONS; i++) {
      const s = await perf.newSession();
      const { page, cdp } = s;
      const common = { pageName: target.name, url, runIndex: i, ready: target.ready(page) };
      const record = (r: PageLoadRun) => {
        result.runs.push(r);
        if (!r.ok) failures.push(`${r.mode} run ${i}: ${r.error}`);
        writeJson(outFile, result);
      };
      try {
        // cold: brand-new context + cache disabled
        await setCacheDisabled(cdp, true);
        const cold = await perf.pageLoad(s, { ...common, mode: 'cold', navigate: () => page.goto(url, { waitUntil: 'commit', timeout: perf.loadTimeoutMs }) });
        if (i === 1) {
          const shot = path.join(SCREENSHOT_DIR, `pageload-${target.key}-${perf.profile.name}.jpg`);
          await page.screenshot({ path: shot, type: 'jpeg', quality: 60, scale: 'css', mask: perf.maskFor(page), maskColor: '#9aa0a6' }).catch(() => {});
          if (fs.existsSync(shot)) cold.screenshot = path.relative(REPORTS_DIR, shot).split(path.sep).join('/');
        }
        record(cold);

        // warm: cache back on, leave the page, navigate to it again
        await setCacheDisabled(cdp, false);
        await page.goto('about:blank');
        const warm = await perf.pageLoad(s, { ...common, mode: 'warm', navigate: () => page.goto(url, { waitUntil: 'commit', timeout: perf.loadTimeoutMs }) });
        record(warm);

        // reload: the page is fully loaded and idle at this point
        const reload = await perf.pageLoad(s, { ...common, mode: 'reload', navigate: () => page.reload({ waitUntil: 'commit', timeout: perf.loadTimeoutMs }) });
        record(reload);
      } finally {
        await s.recorder.flush();
        await s.context.close();
      }
      if (i < ITERATIONS) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_RUNS_MS));
    }

    // a load that failed is a finding: it is recorded above, and reported here after every iteration ran
    expect(failures, `${target.name} [${perf.profile.name}] failed page loads`).toEqual([]);
    const ok = result.runs.filter((r) => r.ok);
    expect(ok.length, 'at least one successful load').toBeGreaterThan(0);
  });
}
