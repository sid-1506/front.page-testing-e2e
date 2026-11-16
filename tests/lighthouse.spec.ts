/**
 * Lighthouse on the homepage and each workflow's entry page, desktop + mobile presets, LH_RUNS (3) runs each,
 * keeping the median-performance run. Chromium is launched with --remote-debugging-port and the audits run
 * in a context loaded with the saved storageState (see scripts/lh-runner.mjs).
 *
 * Optional extra: a Lighthouse user-flow timespan over wf3 (search -> stock page) to score the interaction.
 */
import { test, expect, chromium, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Redactor, STORAGE_STATE_PATH } from '../lib/redact';

const ROOT = path.join(__dirname, '..');
const BASE_URL = (process.env.BASE_URL || 'https://front.page').replace(/\/$/, '');
const PORT = Number(process.env.LH_PORT || 9222);
const LH_RUNS = Math.max(1, Number(process.env.LH_RUNS || 3));
const OUT_DIR = path.join(ROOT, 'reports', 'lighthouse');
const RAW_DIR = path.join(ROOT, 'results', 'raw');
const MARKER = 'lh-target';
const COMPOSER_RE = /what's your view on markets today\?/;

interface Target {
  key: string;
  name: string;
  path: string;
  /** proves the audited page was the signed-in version */
  signedIn: (p: Page) => Promise<boolean>;
}

type Lhr = {
  lighthouseVersion: string;
  finalDisplayedUrl: string;
  fetchTime: string;
  runWarnings: string[];
  runtimeError?: { code: string; message: string };
  configSettings: { formFactor: string; throttlingMethod: string; throttling: Record<string, number> };
  categories: Record<string, { score: number | null; title: string }>;
  audits: Record<string, Audit>;
};
type Audit = {
  id: string;
  title: string;
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  displayValue?: string;
  metricSavings?: Record<string, number>;
  details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number; items?: Record<string, unknown>[] };
};

function postPath(): string | null {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'post-url.json'), 'utf8')).path;
    return typeof p === 'string' ? p : null;
  } catch {
    return null;
  }
}

function runChild(args: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; summary: Record<string, unknown> | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lh-runner.mjs'), ...Object.entries(args).map(([k, v]) => `--${k}=${v}`)], { cwd: ROOT, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      let summary: Record<string, unknown> | null = null;
      for (const line of stdout.trim().split('\n').reverse()) {
        try {
          summary = JSON.parse(line);
          break;
        } catch {
          /* not the summary line */
        }
      }
      resolve({ code, summary, stderr: stderr.slice(-600) });
    });
  });
}

const round = (n: number | undefined | null, d = 0) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

function simplifyItems(a: Audit, redactor: Redactor): Record<string, unknown>[] {
  const items = a.details?.items || [];
  return items.slice(0, 5).map((it) => {
    const o: Record<string, unknown> = {};
    const label = (it.url as string) || (it.entity as string) || (it.groupLabel as string) || (it.group as string) || ((it.node as { snippet?: string })?.snippet as string) || (it.source as { url?: string })?.url;
    if (label) o.label = redactor.url(String(label)).slice(0, 160);
    for (const k of ['wastedBytes', 'totalBytes', 'wastedMs', 'blockingTime', 'mainThreadTime', 'transferSize', 'duration', 'tbtImpact', 'total', 'scripting', 'scriptParseCompile']) {
      if (typeof it[k] === 'number') o[k] = Math.round(it[k] as number);
    }
    return o;
  });
}

function extract(lhr: Lhr, redactor: Redactor) {
  const score = (k: string) => (lhr.categories[k]?.score == null ? null : Math.round((lhr.categories[k].score as number) * 100));
  const num = (id: string, d = 0) => round(lhr.audits[id]?.numericValue, d);
  const opportunities = Object.values(lhr.audits)
    .map((a) => {
      const ms = a.details?.overallSavingsMs ?? Math.max(a.metricSavings?.LCP ?? 0, a.metricSavings?.FCP ?? 0);
      const bytes = a.details?.overallSavingsBytes ?? 0;
      return { id: a.id, title: a.title, savingsMs: Math.round(ms || 0), savingsBytes: Math.round(bytes || 0), displayValue: a.displayValue || null, score: a.score };
    })
    .filter((o) => (o.savingsMs > 0 || o.savingsBytes > 0) && (o.score == null || o.score < 1))
    .sort((x, y) => y.savingsMs - x.savingsMs || y.savingsBytes - x.savingsBytes)
    .slice(0, 5);

  const pick = (label: string, ids: string[]) => {
    const found = ids.map((id) => lhr.audits[id]).filter(Boolean);
    if (!found.length) return { collected: false, reason: `not collected: none of [${ids.join(', ')}] exist in Lighthouse ${lhr.lighthouseVersion}` };
    return {
      collected: true,
      audits: found.map((a) => ({
        id: a.id,
        title: a.title,
        score: a.score,
        displayValue: a.displayValue || null,
        savingsMs: a.details?.overallSavingsMs != null ? Math.round(a.details.overallSavingsMs) : a.metricSavings?.LCP != null ? Math.round(Math.max(a.metricSavings.LCP, a.metricSavings.FCP ?? 0)) : null,
        savingsBytes: a.details?.overallSavingsBytes != null ? Math.round(a.details.overallSavingsBytes) : null,
        items: simplifyItems(a, redactor),
      })),
    };
  };

  return {
    scores: { performance: score('performance'), accessibility: score('accessibility'), bestPractices: score('best-practices'), seo: score('seo') },
    metrics: {
      fcp: num('first-contentful-paint'),
      lcp: num('largest-contentful-paint'),
      tbt: num('total-blocking-time'),
      cls: num('cumulative-layout-shift', 4),
      si: num('speed-index'),
      inp: num('interaction-to-next-paint'),
      ttfb: num('server-response-time'),
    },
    opportunities,
    diagnostics: {
      unusedJavascript: pick('unused JS', ['unused-javascript']),
      unusedCss: pick('unused CSS', ['unused-css-rules']),
      renderBlocking: pick('render-blocking', ['render-blocking-resources', 'render-blocking-insight']),
      imageOptimisation: pick('images', ['image-delivery-insight', 'uses-optimized-images', 'modern-image-formats', 'uses-responsive-images', 'offscreen-images']),
      thirdParty: pick('third-party', ['third-party-summary', 'third-parties-insight']),
      mainThreadWork: pick('main thread', ['mainthread-work-breakdown']),
      jsBootup: pick('bootup', ['bootup-time']),
    },
    throttling: { method: lhr.configSettings.throttlingMethod, ...lhr.configSettings.throttling },
    lighthouseVersion: lhr.lighthouseVersion,
    runWarnings: (lhr.runWarnings || []).map((w) => redactor.text(w)),
  };
}

/** Literal-only scrub (account name, cookie values) that cannot corrupt the report's embedded JSON. */
function scrubFile(file: string, redactor: Redactor) {
  if (!fs.existsSync(file)) return;
  fs.writeFileSync(file, redactor.literal(fs.readFileSync(file, 'utf8')));
}

test('lighthouse: homepage + workflow entry pages, desktop and mobile', async () => {
  test.setTimeout(120 * 60_000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const redactor = Redactor.fromEnv();

  const post = postPath();
  const targets: Target[] = [
    { key: 'home', name: 'Home Feed', path: '/', signedIn: (p) => p.getByPlaceholder(COMPOSER_RE).isVisible() },
    { key: 'create-post', name: 'Create Post', path: '/post/create-post', signedIn: (p) => p.locator('h1', { hasText: 'Create Post' }).isVisible() },
    { key: 'reliance', name: 'Stock page (RELIANCE)', path: '/reliance', signedIn: (p) => p.locator('header button', { hasText: /^Messages$/ }).first().isVisible() },
  ];
  const notes: string[] = [];
  if (post) targets.push({ key: 'post', name: 'Post page', path: post, signedIn: (p) => p.getByPlaceholder('Add a comment...').isVisible() });
  else notes.push('Post page: not audited because results/post-url.json is missing (run test:perf first; wf2 / page-load record the post URL).');
  const only = (process.env.LH_ONLY || '').split(',').filter(Boolean);

  const browser = await chromium.launch({ headless: !process.env.HEADED, args: [`--remote-debugging-port=${PORT}`] });
  const results: unknown[] = [];
  const failures: string[] = [];
  let flow: unknown = null;
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH, viewport: null });
    const page = await context.newPage();
    await page.goto(`about:blank#${MARKER}`);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');

    for (const t of targets) {
      if (only.length && !only.includes(t.key)) continue;
      for (const formFactor of ['desktop', 'mobile'] as const) {
        const runs: { run: number; performance: number | null; json: string; html: string; ok: boolean; error: string | null; signedIn: boolean | null }[] = [];
        for (let i = 1; i <= LH_RUNS; i++) {
          await cdp.send('Network.clearBrowserCache').catch(() => {});
          const json = path.join(OUT_DIR, `${t.key}-${formFactor}.run${i}.json`);
          const html = path.join(OUT_DIR, `${t.key}-${formFactor}.run${i}.html`);
          // the runner leaves the page on the audited URL until it parks it; check sign-in from the LHR instead
          const res = await runChild({ mode: 'audit', port: String(PORT), marker: MARKER, url: BASE_URL + t.path, formFactor, json, html }, 240_000);
          const s = res.summary || {};
          const ok = res.code === 0 && s.ok === true && fs.existsSync(json);
          runs.push({ run: i, performance: typeof s.performance === 'number' ? Math.round((s.performance as number) * 100) : null, json, html, ok, error: ok ? null : redactor.text(String(s.error || s.runtimeError || res.stderr || `exit ${res.code}`)).slice(0, 300), signedIn: null });
          await page.waitForTimeout(1500);
        }
        const good = runs.filter((r) => r.ok && r.performance != null).sort((a, b) => (a.performance as number) - (b.performance as number));
        if (!good.length) {
          failures.push(`${t.name} ${formFactor}: ${runs.map((r) => r.error).join(' | ')}`);
          results.push({ page: t.name, key: t.key, url: BASE_URL + t.path, formFactor, collected: false, reason: `not collected: all ${LH_RUNS} Lighthouse runs failed (${runs[0]?.error})`, runs: runs.map((r) => ({ run: r.run, performance: r.performance, error: r.error })) });
          continue;
        }
        const median = good[Math.floor((good.length - 1) / 2)];
        const finalJson = path.join(OUT_DIR, `${t.key}-${formFactor}.report.json`);
        const finalHtml = path.join(OUT_DIR, `${t.key}-${formFactor}.report.html`);
        fs.copyFileSync(median.json, finalJson);
        fs.copyFileSync(median.html, finalHtml);
        for (const r of runs) for (const f of [r.json, r.html]) fs.rmSync(f, { force: true });
        scrubFile(finalJson, redactor);
        scrubFile(finalHtml, redactor);
        const lhr = JSON.parse(fs.readFileSync(finalJson, 'utf8')) as Lhr;

        // confirm the audited page really is the signed-in one (same context, same cookies)
        await page.goto(BASE_URL + t.path, { waitUntil: 'load' }).catch(() => {});
        const signedIn = await t
          .signedIn(page)
          .then(async (v) => v || (await page.waitForTimeout(4000), t.signedIn(page)))
          .catch(() => false);
        await page.goto(`about:blank#${MARKER}`);
        if (!signedIn) notes.push(`${t.name} ${formFactor}: the signed-in marker was not visible after the audit; the page may have been audited signed out.`);

        results.push({
          page: t.name,
          key: t.key,
          url: redactor.url(lhr.finalDisplayedUrl || BASE_URL + t.path),
          formFactor,
          collected: true,
          signedIn,
          ...extract(lhr, redactor),
          runs: runs.map((r) => ({ run: r.run, performance: r.performance, error: r.error })),
          medianRun: median.run,
          reportPath: `lighthouse/${t.key}-${formFactor}.report.html`,
          jsonPath: `lighthouse/${t.key}-${formFactor}.report.json`,
        });
        fs.writeFileSync(path.join(RAW_DIR, 'lighthouse.json'), JSON.stringify({ kind: 'lighthouse', generatedAt: new Date().toISOString(), runsPerPage: LH_RUNS, browserVersion: browser.version(), results, flow, notes }, null, 1));
      }
    }

    // ---- optional: user-flow timespan over wf3 (read-only workflow) ----
    if (!only.length || only.includes('flow')) {
      await cdp.send('Network.clearBrowserCache').catch(() => {});
      const json = path.join(OUT_DIR, 'wf3-flow.report.json');
      const html = path.join(OUT_DIR, 'wf3-flow.report.html');
      const res = await runChild({ mode: 'flow', port: String(PORT), marker: MARKER, base: BASE_URL, json, html }, 300_000);
      if (res.code === 0 && res.summary?.ok && fs.existsSync(json)) {
        scrubFile(json, redactor);
        scrubFile(html, redactor);
        const fr = JSON.parse(fs.readFileSync(json, 'utf8')) as { name: string; steps: { name: string; lhr: Lhr & { gatherMode: string } }[] };
        flow = {
          collected: true,
          name: fr.name,
          workflow: 'wf3',
          formFactor: 'desktop',
          steps: fr.steps.map((st) => ({
            name: st.name,
            mode: st.lhr.gatherMode,
            performance: st.lhr.categories.performance?.score == null ? null : Math.round((st.lhr.categories.performance.score as number) * 100),
            tbt: round(st.lhr.audits['total-blocking-time']?.numericValue),
            cls: round(st.lhr.audits['cumulative-layout-shift']?.numericValue, 4),
            inp: round(st.lhr.audits['interaction-to-next-paint']?.numericValue),
          })),
          reportPath: 'lighthouse/wf3-flow.report.html',
        };
      } else {
        flow = { collected: false, reason: `not collected: user-flow run failed (${redactor.text(String(res.summary?.error || res.stderr || res.code)).slice(0, 200)})` };
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(RAW_DIR, 'lighthouse.json'), JSON.stringify({ kind: 'lighthouse', generatedAt: new Date().toISOString(), runsPerPage: LH_RUNS, results, flow, notes }, null, 1));
  expect(failures, 'Lighthouse runs that could not be collected').toEqual([]);
});
