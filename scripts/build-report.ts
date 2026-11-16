/**
 * results/raw/*.json  ->  results/metrics.json  +  reports/perf-report.html
 *
 *   npm run report
 *
 * Exit code 1 when a known secret (TEST_PASSWORD, a session cookie value, the account name) is found in
 * any generated report or result file. Other self-checks are printed and shown in the report.
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { Redactor } from '../lib/redact';
import { aggregatePageLoads, aggregateQuality, aggregateWorkflows, buildFlags, collectUnstable, loadRaw, type LhResult } from './report-aggregate';
import { renderHtml, type ReportModel } from './report-html';

const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true } as dotenv.DotenvConfigOptions);

const RESULTS = path.join(ROOT, 'results');
const REPORTS = path.join(ROOT, 'reports');
const HTML_OUT = path.join(REPORTS, 'perf-report.html');
const METRICS_OUT = path.join(RESULTS, 'metrics.json');

function listFiles(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

function main(): number {
  const raw = loadRaw(ROOT);
  const redactor = Redactor.fromEnv();
  if (!raw.workflows.length && !raw.pageLoads.length && !raw.lighthouse) {
    console.error('[report] nothing in results/raw. Run `npm run test:perf` (and `npm run test:lh`) first.');
    return 1;
  }

  const pageLoads = aggregatePageLoads(raw.pageLoads, raw.budgets);
  const workflows = aggregateWorkflows(raw.workflows, raw.budgets);
  const quality = aggregateQuality(raw.workflows, raw.pageLoads);
  const lighthouse: LhResult[] = raw.lighthouse?.results || [];
  const flags = buildFlags(workflows, pageLoads, lighthouse, raw.budgets);
  const unstable = collectUnstable(workflows, pageLoads);

  const envs = [...raw.workflows.map((w) => w.env), ...raw.pageLoads.map((p) => p.env)];
  const profiles = [...new Map(envs.map((e) => [e.profile, { name: e.profile, label: e.profileLabel, userAgent: e.userAgent, viewport: e.viewport }])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const env0 = envs[0];
  const generatedAt = new Date().toISOString();
  const meta = {
    site: env0?.site || 'FrontPage',
    baseUrl: env0?.baseUrl || process.env.BASE_URL || 'https://front.page',
    generatedAt,
    testLocation: env0?.testLocation || process.env.TEST_LOCATION || 'not set (TEST_LOCATION env var missing)',
    browserVersion: env0?.browserVersion || 'not collected: no perf run found',
    playwrightVersion: env0?.playwrightVersion || 'not collected',
    runsPerProfile: env0?.runs ?? 0,
    profiles,
    os: env0?.os || '',
    headless: env0?.headless ?? true,
    ci: env0?.ci ?? false,
    measuredAt: { first: [...raw.workflows.map((w) => w.generatedAt), ...raw.pageLoads.map((p) => p.generatedAt)].sort()[0] || null, lighthouse: raw.lighthouse?.generatedAt || null },
    lighthouseRunsPerPage: raw.lighthouse?.runsPerPage ?? null,
  };
  const findings = [...new Set(raw.workflows.flatMap((w) => w.findings))];

  // ---------------------------------------------------------------------------------- self-checks
  const sanity: ReportModel['sanity'] = [];
  const check = (name: string, ok: boolean, detail: string) => sanity.push({ name, ok, detail });
  check('Workflow results present', workflows.length > 0, `${workflows.length} workflow × profile result(s)`);
  check('Page-load results present', pageLoads.length > 0, `${pageLoads.length} page × profile × mode row(s)`);
  check('Lighthouse results present', lighthouse.some((l) => l.collected), `${lighthouse.filter((l) => l.collected).length} of ${lighthouse.length} audit(s) collected`);
  const order = pageLoads.filter((p) => p.sanity.ttfbBeforeFcp === false || p.sanity.fcpBeforeOrAtLcp === false);
  const orderChecked = pageLoads.filter((p) => p.sanity.ttfbBeforeFcp != null && p.sanity.fcpBeforeOrAtLcp != null).length;
  check('TTFB < FCP ≤ LCP on every page load', order.length === 0 && orderChecked > 0, order.length ? order.map((p) => `${p.page}/${p.profile}/${p.mode}: ttfb ${p.median.ttfb}, fcp ${p.median.fcp}, lcp ${p.median.lcp}`).join('; ') : `${orderChecked} of ${pageLoads.length} rows checked`);
  const untimed = workflows.flatMap((w) => w.steps.filter((s) => s.status === 'passed' && !s.clickToUiReadyMs).map((s) => `${w.id}/${w.profile} step ${s.index}`));
  const timedCount = workflows.reduce((a, w) => a + w.steps.filter((s) => s.clickToUiReadyMs).length, 0);
  check('Every performed step has timing', untimed.length === 0 && timedCount > 0, untimed.length ? `missing: ${untimed.join(', ')}` : `${timedCount} step(s) timed; stop points are skipped by design`);
  const apiRows = workflows.flatMap((w) => w.steps.flatMap((s) => s.api.map((a) => ({ w, s, a }))));
  const noTiming = apiRows.filter((x) => !x.a.timing);
  check('Every API row has a timing breakdown', noTiming.length === 0 && apiRows.length > 0, noTiming.length ? `${noTiming.length} of ${apiRows.length} without timing: ${noTiming.slice(0, 5).map((x) => `${x.w.id}/${x.w.profile} step ${x.s.index} ${x.a.method} ${x.a.path} (${x.a.timingNote})`).join('; ')}` : `${apiRows.length} API row(s)`);
  const failedRuns = workflows.flatMap((w) => w.runs.filter((r) => !r.passed).map((r) => `${w.id}/${w.profile} run ${r.runIndex}`));
  check('All measured workflow runs passed', failedRuns.length === 0, failedRuns.length ? failedRuns.join(', ') : `${workflows.reduce((a, w) => a + w.runsPassed, 0)} run(s)`);
  const writes = workflows.flatMap((w) => w.writes.map((x) => `${w.id}/${w.profile}: ${x.method} ${x.url.split('?')[0]} ×${x.count}`));
  check('No first-party write request was sent (nothing published)', writes.length === 0, writes.length ? `REVIEW: ${writes.join('; ')}` : 'no POST/PUT/PATCH/DELETE to a first-party host in any run');
  const badCleanup = workflows.flatMap((w) => w.cleanup.filter((c) => !c.ok).map((c) => `${w.id}/${w.profile}: ${c.description}`));
  check('Typed text was cleared after each run', badCleanup.length === 0, badCleanup.length ? badCleanup.join('; ') : 'post and comment boxes emptied');

  // ---------------------------------------------------------------------------------- metrics.json
  const metrics = {
    meta,
    budgets: raw.budgets,
    pageLoads: pageLoads.map((p) => ({ page: p.page, url: p.url, profile: p.profile, mode: p.mode, runs: p.runs, median: p.median, status: p.status, stats: p.stats, okRuns: p.okRuns, totalRuns: p.totalRuns, errors: p.errors, lcpBreakdown: p.lcpBreakdown, topShifts: p.topShifts, redirectChain: p.redirectChain, doc: p.doc, api: p.apiCalls, slowestRequests: p.slowestRequests, thirdPartyHosts: p.thirdPartyHosts, notCollected: p.notCollected, screenshot: p.screenshot })),
    workflows: workflows.map((w) => ({
      id: w.id,
      name: w.name,
      profile: w.profile,
      passRate: w.passRate,
      totalMs: w.totalMs,
      steps: w.steps.map((s) => ({
        index: s.index,
        name: s.name,
        action: s.action,
        stopPoint: s.stopPoint,
        status: s.status,
        budgetStatus: s.budgetStatus,
        clickToFeedbackMs: s.clickToFeedbackMs,
        clickToFirstRequestMs: s.clickToFirstRequestMs,
        clickToApiDoneMs: s.clickToApiDoneMs,
        clickToUiReadyMs: s.clickToUiReadyMs,
        clickToNetworkIdleMs: s.clickToNetworkIdleMs,
        eventTiming: s.eventTiming ? { inputDelay: s.eventTiming.inputDelay, processing: s.eventTiming.processing, presentation: s.eventTiming.presentation, duration: s.eventTiming.duration, status: s.eventTiming.durationStat?.status ?? null } : null,
        longTasksMs: s.longTasksMs,
        cls: s.cls,
        screenshot: s.screenshot,
        api: s.api,
        // additions to the base schema
        isNavigation: s.isNavigation,
        navigation: s.navigation,
        anchor: s.anchor,
        clickToAnyMutationMs: s.clickToAnyMutationMs,
        layoutShiftAll: s.layoutShiftAll,
        typing: s.typing,
        milestones: s.milestones,
        extra: s.extra,
        expectApi: s.expectApi,
        staticResources: s.staticResources,
        errors: s.errors,
        console: s.console,
        notCollected: s.notCollected,
        firstVisit: s.firstVisit,
        runsMeasured: s.runsMeasured,
        runsFailed: s.runsFailed,
      })),
      runs: w.runs,
      firstVisit: w.firstVisit,
      entry: w.entry,
      slowestStep: w.slowestStep,
      slowestApi: w.slowestApi,
      cleanup: w.cleanup,
      writes: w.writes,
      findings: w.findings,
    })),
    lighthouse: lighthouse.map((l) => ({
      url: l.url,
      page: l.page,
      formFactor: l.formFactor,
      collected: l.collected,
      notCollected: l.collected ? null : l.reason,
      scores: l.scores || { performance: null, accessibility: null, bestPractices: null, seo: null },
      metrics: l.metrics ? { fcp: l.metrics.fcp, lcp: l.metrics.lcp, tbt: l.metrics.tbt, cls: l.metrics.cls, si: l.metrics.si } : { fcp: null, lcp: null, tbt: null, cls: null, si: null },
      opportunities: (l.opportunities || []).map((o) => ({ id: o.id, title: o.title, savingsMs: o.savingsMs, savingsBytes: o.savingsBytes })),
      diagnostics: l.diagnostics || {},
      reportPath: l.reportPath ? `reports/${l.reportPath}` : null,
      runs: l.runs || [],
      signedIn: l.signedIn ?? null,
    })),
    lighthouseFlow: raw.lighthouse?.flow || null,
    quality: {
      consoleErrors: quality.consoleErrors,
      pageErrors: quality.pageErrors,
      failedRequests: quality.failedRequests,
      httpErrors: quality.httpErrors,
      axe: quality.axe.map((a) => ({ url: a.url, page: a.page, workflow: a.workflow, profile: a.profile, critical: a.critical, serious: a.serious, topRules: a.topRules.map((r) => r.id), topRulesDetail: a.topRules, error: a.error })),
      brokenImages: quality.brokenImages,
      mixedContent: quality.mixedContent,
      redirectChains: quality.redirectChains,
      abortedRequests: quality.abortedRequests,
    },
    flags: flags.map((f) => ({ severity: f.severity, workflow: f.workflow, step: f.step, metric: f.metric, value: f.value, budget: f.budget, message: f.message, profile: f.profile })),
    unstable,
    findings,
    sanity,
  };

  // ---------------------------------------------------------------------------------- write + redaction gate
  const model: ReportModel = {
    meta,
    budgets: raw.budgets,
    pageLoads,
    workflows,
    lighthouse,
    lighthouseFlow: raw.lighthouse?.flow || null,
    lighthouseNotes: raw.lighthouse?.notes || [],
    quality,
    flags,
    unstable,
    findings,
    sanity,
    playwrightReports: [
      { label: "Playwright's built-in HTML report: perf run (traces of failed tests)", href: '../playwright-report/perf/index.html', exists: fs.existsSync(path.join(ROOT, 'playwright-report', 'perf', 'index.html')) },
      { label: "Playwright's built-in HTML report: Lighthouse run", href: '../playwright-report/lighthouse/index.html', exists: fs.existsSync(path.join(ROOT, 'playwright-report', 'lighthouse', 'index.html')) },
    ],
    reportsDir: REPORTS,
    embedScreenshots: process.env.REPORT_EMBED_SCREENSHOTS !== '0',
  };

  const scan = (): { problems: string[]; scanned: number } => {
    const files = [HTML_OUT, METRICS_OUT, ...listFiles(path.join(RESULTS, 'raw'), ['.json']), ...listFiles(RESULTS, ['.json']).filter((f) => path.dirname(f) === RESULTS), ...listFiles(path.join(REPORTS, 'lighthouse'), ['.json', '.html'])];
    const unique = [...new Set(files)].filter((f) => fs.existsSync(f));
    const problems: string[] = [];
    const password = process.env.TEST_PASSWORD || '';
    const userRe = redactor.knownUserTerms.length ? new RegExp(`(?<![A-Za-z0-9])(?:${redactor.knownUserTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9])`, 'i') : null;
    for (const f of unique) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      if (password.length >= 4 && text.includes(password)) problems.push(`${rel}: contains the literal TEST_PASSWORD value`);
      let hits = 0;
      for (const s of redactor.knownSecrets) if (s.length >= 8 && text.includes(s)) hits++;
      if (hits) problems.push(`${rel}: contains ${hits} known secret value(s) (session cookie / token / TEST_EMAIL)`);
      if (userRe && userRe.test(text)) problems.push(`${rel}: contains an identifier of the test account`);
    }
    return { problems, scanned: unique.length };
  };

  fs.mkdirSync(REPORTS, { recursive: true });
  // the JSON reporter's output can quote locators and error text: scrub known literals before it is scanned
  for (const f of listFiles(RESULTS, ['.json']).filter((x) => path.dirname(x) === RESULTS && /playwright-/.test(path.basename(x)))) fs.writeFileSync(f, redactor.literal(fs.readFileSync(f, 'utf8')));

  const write = () => {
    fs.writeFileSync(METRICS_OUT, JSON.stringify({ ...metrics, sanity }, null, 1));
    fs.writeFileSync(HTML_OUT, renderHtml(model));
  };
  write();
  const first = scan();
  const pwSet = !!process.env.TEST_PASSWORD;
  check(
    'Redaction: no known secret in any report or result file',
    first.problems.length === 0,
    first.problems.length
      ? first.problems.join('; ')
      : `${first.scanned} file(s) scanned for ${redactor.knownSecrets.length} secret value(s) and ${redactor.knownUserTerms.length} account identifier(s); TEST_PASSWORD ${pwSet ? 'checked' : 'is not set (login is phone + OTP), so there is no password literal to look for'}`,
  );
  write();
  const final = scan();

  // ---------------------------------------------------------------------------------- console summary
  const size = (f: string) => `${(fs.statSync(f).size / 1024 / 1024).toFixed(2)} MB`;
  console.log(`[report] ${path.relative(ROOT, HTML_OUT)} (${size(HTML_OUT)}) and ${path.relative(ROOT, METRICS_OUT)} (${size(METRICS_OUT)}) written`);
  console.log(`[report] ${workflows.length} workflow rows, ${pageLoads.length} page-load rows, ${lighthouse.length} lighthouse audits, ${flags.filter((f) => f.severity === 'fail').length} fail / ${flags.filter((f) => f.severity === 'warn').length} warn flags, ${unstable.length} unstable metrics`);
  for (const s of sanity) console.log(`[report] ${s.ok ? 'PASS' : 'FAIL'}  ${s.name}  (${s.detail})`);
  if (final.problems.length) {
    console.error('[report] REDACTION CHECK FAILED: a known secret is present in generated output. Build failed.');
    for (const p of final.problems) console.error('  - ' + p);
    return 1;
  }
  console.log('[report] redaction check passed');
  return 0;
}

process.exit(main());
