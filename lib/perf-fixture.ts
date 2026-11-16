/**
 * `perf` fixture: recorder + step timer + collectors, bound to the project's network/CPU profile.
 *
 *   test('wf1', async ({ perf }) => {
 *     await perf.workflow({ id, name, startUrl, entryReady }, async (run) => {
 *       await run.step('click composer', () => composer.click(), { index: 1, action: 'click', expectUi: [...] });
 *     });
 *   });
 */
import { test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions, type CDPSession, type Locator, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installObservers } from './init-observers';
import { NetworkRecorder } from './network-recorder';
import { measureStep, recordStopPoint, takeScreenshot, emptyStep, cleanError, StepError, type StepContext, type StepOptions } from './measure-step';
import { measurePageLoad, type MeasureLoadArgs } from './page-load';
import { Redactor, STORAGE_STATE_PATH } from './redact';
import { applyProfile, clearThrottling, profileByName, type Profile } from './throttling';
import type { Budgets, EnvInfo, PageLoadRun, QualityScan, RequestRecord, StepRecord, WorkflowResult, WorkflowRun } from './types';

export const ROOT = path.join(__dirname, '..');
export const RESULTS_DIR = path.join(ROOT, 'results');
export const RAW_DIR = path.join(RESULTS_DIR, 'raw');
export const REPORTS_DIR = path.join(ROOT, 'reports');
export const SCREENSHOT_DIR = path.join(REPORTS_DIR, 'screenshots');
export const BASE_URL = (process.env.BASE_URL || 'https://front.page').replace(/\/$/, '');
/** Measured passes per workflow per profile. RUNS=0 runs only the warm-up (firstVisit) pass: used for dry runs. */
export const RUNS = process.env.RUNS !== undefined && process.env.RUNS !== '' ? Math.max(0, Math.floor(Number(process.env.RUNS))) : 3;
export const COMPOSER_RE = /what's your view on markets today\?/;
export const PAUSE_BETWEEN_RUNS_MS = Number(process.env.PAUSE_MS || 2500);

export function loadBudgets(): Budgets {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'perf-budgets.json'), 'utf8'));
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

export interface Session {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  recorder: NetworkRecorder;
}

export interface WorkflowDef {
  id: string;
  name: string;
  startUrl: string;
  /** what proves the entry page is usable (and that we are signed in) */
  entryReady: (page: Page) => Locator;
}

export interface RunApi {
  page: Page;
  kind: 'firstVisit' | 'measured';
  runIndex: number;
  profile: Profile;
  step(name: string, action: () => Promise<unknown>, opts: StepOptions): Promise<StepRecord>;
  /** A step with no interaction of its own, timed from a milestone of an earlier step. */
  waitStep(name: string, opts: { index: number; from: StepRecord; milestone: string; assert: () => Promise<void>; description: string }): Promise<StepRecord>;
  stopPoint(name: string, opts: { index: number; action: string; verify: () => Promise<void>; reason: string }): Promise<StepRecord>;
  cleanup(description: string, fn: () => Promise<string | void>): Promise<void>;
  /** axe + broken images + mixed content; runs only during the firstVisit pass so measured runs stay clean */
  quality(pageLabel: string): Promise<void>;
  /** something that differs from the workflow spec; shown in the report */
  finding(text: string): void;
  extraStep(rec: StepRecord): void;
}

export class Perf {
  readonly budgets: Budgets;
  readonly redactor: Redactor;
  readonly profile: Profile;
  readonly env: EnvInfo;
  readonly uiTimeoutMs: number;
  readonly idleTimeoutMs: number;

  constructor(
    readonly browser: Browser,
    readonly testInfo: TestInfo,
    readonly baseHost: string = new URL(BASE_URL).host,
  ) {
    this.budgets = loadBudgets();
    this.redactor = Redactor.fromEnv();
    const profileName = (testInfo.project.metadata?.profile as string) || testInfo.project.name;
    this.profile = profileByName(profileName);
    this.uiTimeoutMs = this.profile.mobile ? 60_000 : 20_000;
    this.idleTimeoutMs = this.profile.mobile ? 30_000 : 15_000;
    const use = testInfo.project.use;
    this.env = {
      site: 'FrontPage',
      baseUrl: BASE_URL,
      testLocation: process.env.TEST_LOCATION || 'not set (TEST_LOCATION env var missing)',
      browserVersion: `${browser.browserType().name()} ${browser.version()}`,
      playwrightVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version,
      userAgent: (use.userAgent as string) || 'browser default',
      viewport: (use.viewport as { width: number; height: number }) || this.profile.viewport,
      profile: this.profile.name,
      profileLabel: this.profile.label,
      runs: RUNS,
      headless: use.headless !== false,
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
      ci: !!process.env.CI,
    };
  }

  /** Context options of the current project (viewport, UA, storage state, ...) for manually created contexts. */
  contextOptions(): BrowserContextOptions {
    const u = this.testInfo.project.use;
    return {
      storageState: u.storageState,
      viewport: u.viewport,
      userAgent: u.userAgent,
      isMobile: u.isMobile,
      hasTouch: u.hasTouch,
      deviceScaleFactor: u.deviceScaleFactor,
      locale: u.locale,
      timezoneId: u.timezoneId,
      ignoreHTTPSErrors: u.ignoreHTTPSErrors,
    };
  }

  /** Install probes, attach CDP, apply the throttling profile, start recording. */
  async instrument(context: BrowserContext, page: Page): Promise<Session> {
    await installObservers(context);
    const cdp = await context.newCDPSession(page);
    await applyProfile(cdp, this.profile);
    const recorder = new NetworkRecorder(page, { baseHost: this.baseHost, redactor: this.redactor, budgets: this.budgets, cdp });
    recorder.attach();
    return { context, page, cdp, recorder };
  }

  async newSession(): Promise<Session> {
    const context = await this.browser.newContext(this.contextOptions());
    const page = await context.newPage();
    return this.instrument(context, page);
  }

  /** Locators painted over in screenshots: anything that shows the test account's name. */
  maskFor(page: Page): Locator[] {
    const masks: Locator[] = [page.getByPlaceholder(COMPOSER_RE)];
    for (const term of this.redactor.knownUserTerms) if (term.length >= 5) masks.push(page.getByText(term, { exact: false }));
    return masks;
  }

  stepContext(s: Session, shotPrefix: string, workflowId: string): StepContext {
    return {
      page: s.page,
      recorder: s.recorder,
      redactor: this.redactor,
      screenshotDir: SCREENSHOT_DIR,
      shotPrefix,
      stepLabel: (index, name) => `${workflowId} step ${index}: ${name}`,
      defaultUiTimeoutMs: this.uiTimeoutMs,
      defaultIdleTimeoutMs: this.idleTimeoutMs,
      defaultMask: () => this.maskFor(s.page),
      reportsDir: REPORTS_DIR,
    };
  }

  get loadTimeoutMs(): number {
    return this.profile.mobile ? 180_000 : 60_000;
  }

  async pageLoad(s: Session, a: Omit<MeasureLoadArgs, 'page' | 'recorder' | 'redactor' | 'profile' | 'idleTimeoutMs' | 'settleMs' | 'uiTimeoutMs' | 'loadTimeoutMs'>): Promise<PageLoadRun> {
    return measurePageLoad({
      ...a,
      page: s.page,
      recorder: s.recorder,
      redactor: this.redactor,
      profile: this.profile.name,
      idleTimeoutMs: this.idleTimeoutMs,
      settleMs: this.profile.mobile ? 2000 : 1200,
      uiTimeoutMs: this.uiTimeoutMs,
      loadTimeoutMs: this.loadTimeoutMs,
    });
  }

  async qualityScan(s: Session, workflow: string, pageLabel: string): Promise<QualityScan> {
    const scan: QualityScan = { workflow, profile: this.profile.name, page: pageLabel, url: this.redactor.url(s.page.url()), axe: null, axeError: null, brokenImages: [], mixedContent: [], imageCount: null };
    try {
      const q = (await s.page.evaluate(() => (window as unknown as { __perf?: { quality(): unknown } }).__perf?.quality() ?? null)) as { imageCount: number; brokenImages: string[]; mixedContent: string[] } | null;
      if (q) {
        scan.imageCount = q.imageCount;
        scan.brokenImages = q.brokenImages.map((u) => this.redactor.url(u));
        scan.mixedContent = q.mixedContent.map((u) => this.redactor.text(u));
      }
    } catch {
      /* page navigating */
    }
    // axe is harness work: run it unthrottled, then restore the profile
    await clearThrottling(s.cdp).catch(() => {});
    try {
      const res = await new AxeBuilder({ page: s.page }).analyze();
      const count = (impact: string) => res.violations.filter((v) => v.impact === impact).length;
      scan.axe = {
        critical: count('critical'),
        serious: count('serious'),
        moderate: count('moderate'),
        minor: count('minor'),
        topRules: res.violations
          .slice()
          .sort((a, b) => {
            const rank = (i?: string | null) => ['minor', 'moderate', 'serious', 'critical'].indexOf(i || 'minor');
            return rank(b.impact) - rank(a.impact) || b.nodes.length - a.nodes.length;
          })
          .slice(0, 5)
          .map((v) => ({ id: v.id, impact: v.impact || 'unknown', nodes: v.nodes.length, help: v.help })),
      };
    } catch (e) {
      scan.axeError = cleanError(e, this.redactor).slice(0, 300);
    }
    await applyProfile(s.cdp, this.profile).catch(() => {});
    return scan;
  }

  /**
   * Run a workflow: one firstVisit pass (cold cache, recorded separately) then RUNS measured passes
   * in the same context. A failing run is recorded and the next one still executes.
   */
  async workflow(s: Session, def: WorkflowDef, body: (run: RunApi) => Promise<void>): Promise<WorkflowResult> {
    const { page, recorder } = s;
    const result: WorkflowResult = {
      kind: 'workflow',
      id: def.id,
      name: def.name,
      profile: this.profile.name,
      startUrl: def.startUrl,
      generatedAt: new Date().toISOString(),
      env: this.env,
      findings: [],
      firstVisit: null,
      runs: [],
      quality: [],
    };
    const outFile = path.join(RAW_DIR, `${def.id}-${this.profile.name}.json`);
    const scanned = new Set<string>();

    for (let k = 0; k <= RUNS; k++) {
      const kind: 'firstVisit' | 'measured' = k === 0 ? 'firstVisit' : 'measured';
      const ctx = this.stepContext(s, `${def.id}-${this.profile.name}-${kind === 'firstVisit' ? 'first' : 'run' + k}`, def.id);
      const run: WorkflowRun = { runIndex: k, kind, passed: false, error: null, totalMs: null, wallMs: 0, startedAt: new Date().toISOString(), entry: null, steps: [], cleanup: [], writes: [], idleRequests: [] };
      const runMark = recorder.mark();
      const t0 = Date.now();

      const api: RunApi = {
        page,
        kind,
        runIndex: k,
        profile: this.profile,
        step: async (name, action, opts) => {
          try {
            const rec = await measureStep(ctx, name, action, opts);
            run.steps.push(rec);
            return rec;
          } catch (e) {
            if (e instanceof StepError) run.steps.push(e.record);
            throw e;
          }
        },
        waitStep: async (name, o) => {
          const rec = emptyStep(o.index, name, 'wait');
          rec.url = this.redactor.url(page.url());
          rec.anchor = `interaction of step ${o.from.index} (this step has no interaction of its own)`;
          rec.anchorEpoch = o.from.anchorEpoch;
          const ms = o.from.milestones[o.milestone];
          if (ms != null) {
            rec.clickToUiReadyMs = ms;
            rec.uiConditions = [{ description: o.description, ms }];
          } else rec.notCollected.clickToUiReadyMs = `milestone "${o.milestone}" was not reached while step ${o.from.index} was being timed`;
          const why = `wait step: no interaction; network, long tasks and layout shift for this window are reported under step ${o.from.index}`;
          for (const key of ['clickToFeedbackMs', 'eventTiming', 'clickToFirstRequestMs', 'clickToApiDoneMs', 'clickToNetworkIdleMs', 'longTasksMs', 'cls']) rec.notCollected[key] = why;
          const started = Date.now();
          let failure: unknown = null;
          try {
            await o.assert();
          } catch (e) {
            failure = e;
          }
          rec.stepWallMs = Date.now() - started;
          rec.screenshot = await takeScreenshot(ctx, `step${o.index}${failure ? '-FAILED' : ''}`);
          run.steps.push(rec);
          if (failure) {
            rec.status = 'failed';
            rec.error = cleanError(failure, this.redactor);
            throw new StepError(`Step ${o.index} "${name}" failed: ${rec.error.split('\n')[0]}`, rec);
          }
          return rec;
        },
        stopPoint: async (name, o) => {
          try {
            const rec = await recordStopPoint(ctx, name, o);
            run.steps.push(rec);
            return rec;
          } catch (e) {
            if (e instanceof StepError) run.steps.push(e.record);
            throw e;
          }
        },
        cleanup: async (description, fn) => {
          try {
            const detail = (await fn()) || 'done';
            run.cleanup.push({ description, ok: true, detail });
          } catch (e) {
            run.cleanup.push({ description, ok: false, detail: cleanError(e, this.redactor).slice(0, 300) });
          }
        },
        quality: async (pageLabel) => {
          if (kind !== 'firstVisit' || scanned.has(pageLabel)) return;
          scanned.add(pageLabel);
          result.quality.push(await this.qualityScan(s, def.id, pageLabel));
        },
        finding: (text) => {
          const t = this.redactor.text(text);
          if (!result.findings.includes(t)) result.findings.push(t);
        },
        extraStep: (rec) => run.steps.push(rec),
      };

      try {
        // ---- entry navigation (hard load of the workflow's start URL) ----
        const load = await this.pageLoad(s, {
          pageName: `${def.id} entry`,
          url: BASE_URL + def.startUrl,
          mode: k === 0 ? 'cold' : 'warm',
          runIndex: k,
          navigate: () => page.goto(BASE_URL + def.startUrl, { waitUntil: 'commit', timeout: this.loadTimeoutMs }),
          ready: def.entryReady(page),
        });
        run.entry = { url: load.finalUrl, readyMs: load.uiReadyMs, ttfb: load.ttfb, fcp: load.fcp, lcp: load.lcp, requests: load.requests, idleReached: load.networkIdleReached };
        if (!load.ok) throw new Error(`entry page failed to load: ${load.error}`);

        await body(api);
        run.passed = true;
      } catch (e) {
        run.error = e instanceof StepError ? e.message : cleanError(e, this.redactor);
        if (!(e instanceof StepError)) await takeScreenshot(ctx, 'error');
      }

      await recorder.flush();
      run.wallMs = Date.now() - t0;
      const measuredSteps = run.steps.filter((st) => st.status === 'passed' && st.clickToUiReadyMs != null && st.action !== 'wait');
      if (run.passed && run.entry?.readyMs != null) run.totalMs = Math.round(run.entry.readyMs + measuredSteps.reduce((a, st) => a + (st.clickToUiReadyMs as number), 0));
      const all: RequestRecord[] = recorder.records.slice(runMark);
      run.writes = all
        .filter((r) => r.firstParty && r.flags.includes('write'))
        .map((r) => ({ method: r.method, url: r.url.slice(0, 300), status: r.status, step: r.step, payload: r.payload ? r.payload.text.slice(0, 500) : null }));
      run.idleRequests = all.filter((r) => r.step == null && r.api).slice(0, 40);

      if (kind === 'firstVisit') result.firstVisit = run;
      else result.runs.push(run);
      writeJson(outFile, result); // persist after every run so a crash never loses data

      if (k < RUNS) await page.waitForTimeout(PAUSE_BETWEEN_RUNS_MS);
    }
    return result;
  }
}

export const test = base.extend<{ perf: Perf; session: Session }>({
  perf: async ({ browser }, use, testInfo) => {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await use(new Perf(browser, testInfo));
  },
  /** The test's own page/context, instrumented and throttled for the project's profile. */
  session: async ({ perf, context, page }, use) => {
    const s = await perf.instrument(context, page);
    await use(s);
    await s.recorder.flush();
  },
});

/** Fail the Playwright test when any run failed, after every run has been executed and recorded. */
export function expectAllRunsPassed(result: WorkflowResult): void {
  const failed = [result.firstVisit, ...result.runs].filter((r): r is WorkflowRun => !!r && !r.passed).map((r) => `${r.kind} run ${r.runIndex}: ${r.error}`);
  expect(failed, `${result.id} [${result.profile}] failed runs`).toEqual([]);
}

export { expect, STORAGE_STATE_PATH };
