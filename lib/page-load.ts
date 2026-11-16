/**
 * Measures one full document load (cold / warm / reload) and reads the vitals before leaving the page.
 */
import type { Locator, Page, Response } from '@playwright/test';
import type { NetworkRecorder } from './network-recorder';
import type { Redactor } from './redact';
import type { PageLoadRun, RequestRecord } from './types';

const r1 = (n: number) => Math.round(n * 10) / 10;

interface PageLoadData {
  url: string;
  title: string;
  timeOrigin: number;
  collectedAtRel: number;
  nav: {
    type: string;
    redirectCount: number;
    dns: number;
    tcp: number;
    tls: number;
    ttfb: number;
    responseEnd: number;
    dcl: number;
    load: number;
    protocol: string;
    serverTiming: string;
  } | null;
  fcp: number | null;
  lcp: { time: number; size: number; element: string | null; url: string | null } | null;
  clsRaw: number;
  topShifts: { element: string; value: number }[];
  longTasks: { rel: number; duration: number }[];
  loafs: { rel: number; duration: number; blocking: number; scripts: unknown[] }[];
  loafSupported: boolean;
  vitals: Record<string, { value: number; attribution: Record<string, unknown> }>;
  errors: string[];
}

export interface MeasureLoadArgs {
  page: Page;
  recorder: NetworkRecorder;
  redactor: Redactor;
  pageName: string;
  url: string;
  profile: string;
  mode: 'cold' | 'warm' | 'reload';
  runIndex: number;
  /** must resolve as soon as the navigation commits (waitUntil: 'commit'); load is awaited separately */
  navigate: () => Promise<Response | null>;
  /** proves the right page rendered (e.g. the composer on the home feed); timed as uiReadyMs */
  ready?: Locator;
  idleTimeoutMs: number;
  settleMs: number;
  uiTimeoutMs: number;
  loadTimeoutMs: number;
}

/** Total blocking time: for each long task overlapping [from, to], the part beyond 50 ms. */
export function blockingTime(tasks: { rel: number; duration: number }[], from: number, to: number): number {
  let total = 0;
  for (const t of tasks) {
    const clipped = Math.min(t.rel + t.duration, to) - Math.max(t.rel, from);
    if (clipped > 50) total += clipped - 50;
  }
  return r1(total);
}

export function emptyLoadRun(a: Pick<MeasureLoadArgs, 'pageName' | 'url' | 'profile' | 'mode' | 'runIndex'>): PageLoadRun {
  return {
    page: a.pageName,
    url: a.url,
    finalUrl: a.url,
    profile: a.profile,
    mode: a.mode,
    runIndex: a.runIndex,
    ok: false,
    error: null,
    at: new Date().toISOString(),
    dns: null,
    tcp: null,
    tls: null,
    ttfb: null,
    responseEnd: null,
    dcl: null,
    load: null,
    fcp: null,
    lcp: null,
    lcpElement: null,
    lcpResource: null,
    lcpSize: null,
    lcpBreakdown: null,
    uiReadyMs: null,
    cls: null,
    topShifts: [],
    tbt: null,
    tbtToSettle: null,
    longTaskCount: null,
    loaf: null,
    inp: null,
    requests: 0,
    cachedRequests: 0,
    bytes: { doc: 0, js: 0, css: 0, img: 0, font: 0, xhr: 0, other: 0, total: 0, firstParty: 0, thirdParty: 0 },
    counts: { firstParty: 0, thirdParty: 0, byType: {} },
    redirectCount: 0,
    redirectChain: [],
    navProtocol: null,
    docServerTiming: null,
    docCacheControl: null,
    docEncoding: null,
    settleMs: null,
    networkIdleReached: false,
    apiCalls: [],
    slowestRequests: [],
    thirdPartyHosts: [],
    console: [],
    pageErrors: [],
    failedRequests: [],
    brokenImages: [],
    mixedContent: [],
    notCollected: {},
    screenshot: null,
  };
}

export async function measurePageLoad(a: MeasureLoadArgs): Promise<PageLoadRun> {
  const { page, recorder, redactor } = a;
  const run = emptyLoadRun(a);
  await recorder.flush();
  recorder.resetInflight();
  recorder.setStep(`page-load:${a.pageName}:${a.mode}`);
  const mark = recorder.mark();
  const cm = recorder.consoleMark();
  const t0 = Date.now();
  let response: Response | null = null;
  try {
    response = await a.navigate();
    // the new document is committed: time the "usable" signal and the load event in parallel
    let readyAt: number | null = null;
    const readyP = a.ready
      ? a.ready
          .first()
          .waitFor({ state: 'visible', timeout: a.uiTimeoutMs })
          .then(() => {
            readyAt = Date.now();
          })
      : Promise.resolve();
    readyP.catch(() => {});
    await page.waitForLoadState('load', { timeout: a.loadTimeoutMs });
    await readyP;
    const idle = await recorder.waitForIdle({ quietMs: 500, timeoutMs: a.idleTimeoutMs, sinceIndex: mark });
    run.networkIdleReached = idle.reached;
    await page.waitForTimeout(a.settleMs); // let LCP / CLS / long-task entries flush
    run.settleMs = Date.now() - t0;

    const d = (await page.evaluate(() => (window as unknown as { __perf?: { pageLoad(): unknown } }).__perf?.pageLoad() ?? null)) as PageLoadData | null;
    const q = (await page.evaluate(() => (window as unknown as { __perf?: { quality(): unknown } }).__perf?.quality() ?? null)) as { brokenImages: string[]; mixedContent: string[] } | null;
    run.finalUrl = redactor.url(page.url());
    if (readyAt != null && d) run.uiReadyMs = r1(Math.max(0, readyAt - d.timeOrigin));
    else run.notCollected.uiReadyMs = a.ready ? 'page probes missing' : 'no ready signal defined for this page';

    if (!d || !d.nav) {
      const why = 'window.__perf / navigation timing entry missing on this document';
      for (const k of ['ttfb', 'fcp', 'lcp', 'cls', 'tbt', 'dcl', 'load']) run.notCollected[k] = why;
    } else {
      const n = d.nav;
      run.dns = n.dns;
      run.tcp = n.tcp;
      run.tls = n.tls;
      run.ttfb = n.ttfb;
      run.responseEnd = n.responseEnd;
      run.dcl = n.dcl;
      run.load = n.load > 0 ? n.load : null;
      if (run.load == null) run.notCollected.load = 'loadEventEnd was 0 when the page was read';
      run.navProtocol = n.protocol || null;
      run.docServerTiming = n.serverTiming ? redactor.text(n.serverTiming) : null;
      run.redirectCount = n.redirectCount;

      const vf = d.vitals.FCP;
      run.fcp = vf ? vf.value : d.fcp;
      if (run.fcp == null) run.notCollected.fcp = 'no first-contentful-paint entry (page may not have painted)';

      const vl = d.vitals.LCP;
      if (vl) {
        run.lcp = vl.value;
        run.lcpElement = redactor.text((vl.attribution.target as string) || d.lcp?.element || '') || null;
        run.lcpResource = vl.attribution.url ? redactor.url(String(vl.attribution.url)) : d.lcp?.url ? redactor.url(d.lcp.url) : null;
        run.lcpBreakdown = {
          timeToFirstByte: vl.attribution.timeToFirstByte ?? null,
          resourceLoadDelay: vl.attribution.resourceLoadDelay ?? null,
          resourceLoadDuration: vl.attribution.resourceLoadDuration ?? null,
          elementRenderDelay: vl.attribution.elementRenderDelay ?? null,
        };
      } else if (d.lcp) {
        run.lcp = d.lcp.time;
        run.lcpElement = redactor.text(d.lcp.element || '') || null;
        run.lcpResource = d.lcp.url ? redactor.url(d.lcp.url) : null;
      } else run.notCollected.lcp = 'no largest-contentful-paint entry was emitted';
      run.lcpSize = d.lcp?.size ?? null;
      if (run.lcp != null && !run.lcpResource) run.notCollected.lcpResource = 'LCP element is text (no resource URL)';
      if (run.lcp != null && !run.lcpElement) run.notCollected.lcpElement = 'the LCP element was removed from the DOM before it could be described';

      const vc = d.vitals.CLS;
      run.cls = vc ? Math.round(vc.value * 10000) / 10000 : d.clsRaw;
      run.topShifts = d.topShifts.map((s) => ({ element: redactor.text(s.element), value: s.value }));

      if (run.fcp != null && run.load != null) run.tbt = blockingTime(d.longTasks, run.fcp, run.load);
      else run.notCollected.tbt = 'needs both FCP and load event';
      if (run.fcp != null) run.tbtToSettle = blockingTime(d.longTasks, run.fcp, d.collectedAtRel);
      run.longTaskCount = d.longTasks.length;
      run.loaf = d.loafSupported
        ? {
            supported: true,
            count: d.loafs.length,
            blockingMs: r1(d.loafs.reduce((s, l) => s + (l.blocking || 0), 0)),
            worst: d.loafs
              .slice()
              .sort((x, y) => y.duration - x.duration)
              .slice(0, 3)
              .map((l) => JSON.parse(redactor.text(JSON.stringify(l)))),
          }
        : null;
      if (!d.loafSupported) run.notCollected.loaf = 'long-animation-frame entries not supported by this browser';
      run.notCollected.inp = 'no user interaction happens during a page-load measurement';
      if (d.errors.length) run.notCollected.probeErrors = d.errors.join(' | ').slice(0, 300);
    }
    if (q) {
      run.brokenImages = q.brokenImages.map((u) => redactor.url(u));
      run.mixedContent = q.mixedContent.map((u) => redactor.text(u));
    }

    // redirect chain of the entry URL
    const chain: string[] = [];
    let req = response?.request() ?? null;
    while (req) {
      const prev = req.redirectedFrom();
      if (!prev) break;
      const pr = await prev.response().catch(() => null);
      chain.unshift(`${pr ? pr.status() : '?'} ${redactor.url(prev.url())}`);
      req = prev;
    }
    run.redirectChain = chain;
    run.redirectCount = Math.max(run.redirectCount, chain.length);
    const h = response?.headers() || {};
    run.docCacheControl = h['cache-control'] || null;
    run.docEncoding = h['content-encoding'] || null;
    if (!run.docServerTiming && h['server-timing']) run.docServerTiming = redactor.text(h['server-timing']);

    const status = response?.status() ?? 0;
    run.ok = status > 0 && status < 400;
    if (!run.ok) run.error = `document responded with HTTP ${status}`;
  } catch (e) {
    run.error = redactor.text(e instanceof Error ? e.message.replace(/\u001b\[[0-9;]*m/g, '') : String(e)).slice(0, 600);
  }

  // ---- network summary --------------------------------------------------------------------------------
  await recorder.flush();
  const reqs: RequestRecord[] = recorder.records.slice(mark);
  run.requests = reqs.length;
  run.cachedRequests = reqs.filter((r) => r.fromCache).length;
  const hostAgg = new Map<string, { requests: number; bytes: number }>();
  for (const r of reqs) {
    const b = r.responseBytes || 0;
    const bucket = r.bucket as keyof PageLoadRun['bytes'];
    run.bytes[bucket] = (run.bytes[bucket] || 0) + b;
    run.bytes.total += b;
    run.counts.byType[r.bucket] = (run.counts.byType[r.bucket] || 0) + 1;
    if (r.firstParty) {
      run.bytes.firstParty += b;
      run.counts.firstParty++;
    } else {
      run.bytes.thirdParty += b;
      run.counts.thirdParty++;
      const agg = hostAgg.get(r.host) || { requests: 0, bytes: 0 };
      agg.requests++;
      agg.bytes += b;
      hostAgg.set(r.host, agg);
    }
  }
  run.thirdPartyHosts = [...hostAgg.entries()].map(([host, v]) => ({ host, ...v })).sort((x, y) => y.bytes - x.bytes || y.requests - x.requests).slice(0, 12);
  run.apiCalls = reqs.filter((r) => r.api);
  run.slowestRequests = reqs
    .filter((r) => r.durationMs != null && !r.polling)
    .sort((x, y) => (y.durationMs as number) - (x.durationMs as number))
    .slice(0, 8)
    .map((r) => ({ url: r.url.slice(0, 200), bucket: r.bucket, durationMs: r.durationMs as number, bytes: r.responseBytes, firstParty: r.firstParty }));
  run.failedRequests = reqs
    .filter((r) => (r.failed && !r.flags.includes('aborted')) || (r.status != null && r.status >= 400))
    .map((r) => ({ url: r.url.slice(0, 300), failure: r.failureText, status: r.status }));
  run.console = recorder.consoleMessages.slice(cm.console);
  run.pageErrors = recorder.pageErrors.slice(cm.errors);
  recorder.setStep(null);
  // the page is loaded and idle: start learning which elements change on their own (see init-observers)
  await page.evaluate(() => void (window as unknown as { __perf?: { learn?(on: boolean): unknown } }).__perf?.learn?.(true)).catch(() => {});
  return run;
}
