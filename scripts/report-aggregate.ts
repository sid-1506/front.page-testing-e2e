/**
 * results/raw/*.json  ->  the metrics.json structure (stable schema; fields are only ever added).
 * No number is invented here: every value is a statistic over recorded measurements, and anything
 * that could not be measured is carried as null with a reason in `notCollected`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Budgets, ConsoleRecord, PageLoadResult, PageLoadRun, QualityScan, RequestRecord, StepRecord, WorkflowResult, WorkflowRun } from '../lib/types';

export type Status = 'ok' | 'warn' | 'fail';

export interface Stat {
  n: number;
  median: number;
  /** 95th percentile when n >= 5, otherwise the maximum (see p95Kind) */
  p95: number;
  p95Kind: 'p95' | 'max';
  min: number;
  max: number;
  mean: number;
  /** coefficient of variation (population std / mean); null when n < 2 or mean is 0 */
  cov: number | null;
  unstable: boolean;
  status?: Status | null;
  budget?: [number, number] | null;
}

export const UNSTABLE_COV = 0.3;
/** CoV is meaningless on near-zero values (0 / 0 / 7 ms gives 141%): also require this absolute spread. */
export const UNSTABLE_MIN_SPREAD = 20;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function stat(values: (number | null | undefined)[], digits: 1 | 4 = 1): Stat | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rnd = digits === 4 ? r4 : r1;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const std = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const cov = v.length >= 2 && mean !== 0 ? Math.round((std / Math.abs(mean)) * 1000) / 1000 : null;
  return {
    n: v.length,
    median: rnd(percentile(v, 0.5)),
    p95: rnd(v.length >= 5 ? percentile(v, 0.95) : v[v.length - 1]),
    p95Kind: v.length >= 5 ? 'p95' : 'max',
    min: rnd(v[0]),
    max: rnd(v[v.length - 1]),
    mean: rnd(mean),
    cov,
    // CLS-type values (digits 4) are fractions, where an absolute ms spread does not apply
    unstable: cov != null && v.length >= 3 && cov > UNSTABLE_COV && (digits === 4 || v[v.length - 1] - v[0] >= UNSTABLE_MIN_SPREAD),
  };
}

/** Budget status. For "higher is better" budgets (Lighthouse score) the pair is [okAtOrAbove, failBelow]. */
export function statusOf(value: number | null | undefined, budget: [number, number] | undefined, higherIsBetter = false): Status | null {
  if (value == null || !budget) return null;
  if (higherIsBetter) return value >= budget[0] ? 'ok' : value >= budget[1] ? 'warn' : 'fail';
  return value > budget[1] ? 'fail' : value > budget[0] ? 'warn' : 'ok';
}

function withBudget(s: Stat | null, budget: [number, number] | undefined, scale = 1): Stat | null {
  if (!s) return null;
  s.budget = budget || null;
  s.status = statusOf(s.median * scale, budget);
  return s;
}

const worst = (list: (Status | null | undefined)[]): Status | null => (list.includes('fail') ? 'fail' : list.includes('warn') ? 'warn' : list.includes('ok') ? 'ok' : null);

function mode<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------- loading
export interface RawData {
  workflows: WorkflowResult[];
  pageLoads: PageLoadResult[];
  lighthouse: { generatedAt: string; runsPerPage: number; results: LhResult[]; flow: LhFlow | null; notes: string[] } | null;
  budgets: Budgets;
}
export interface LhResult {
  page: string;
  key: string;
  url: string;
  formFactor: string;
  collected: boolean;
  reason?: string;
  signedIn?: boolean;
  scores?: { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null };
  metrics?: { fcp: number | null; lcp: number | null; tbt: number | null; cls: number | null; si: number | null; inp: number | null; ttfb: number | null };
  opportunities?: { id: string; title: string; savingsMs: number; savingsBytes: number; displayValue: string | null }[];
  diagnostics?: Record<string, { collected: boolean; reason?: string; audits?: { id: string; title: string; score: number | null; displayValue: string | null; savingsMs: number | null; savingsBytes: number | null; items: Record<string, unknown>[] }[] }>;
  throttling?: Record<string, unknown>;
  lighthouseVersion?: string;
  runWarnings?: string[];
  runs?: { run: number; performance: number | null; error: string | null }[];
  medianRun?: number;
  reportPath?: string;
  jsonPath?: string;
}
export interface LhFlow {
  collected: boolean;
  reason?: string;
  name?: string;
  workflow?: string;
  formFactor?: string;
  steps?: { name: string; mode: string; performance: number | null; tbt: number | null; cls: number | null; inp: number | null }[];
  reportPath?: string;
}

export function loadRaw(root: string): RawData {
  const rawDir = path.join(root, 'results', 'raw');
  const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')) : [];
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  const workflows: WorkflowResult[] = [];
  const pageLoads: PageLoadResult[] = [];
  let lighthouse: RawData['lighthouse'] = null;
  for (const f of files.sort()) {
    const j = read(f);
    if (j.kind === 'workflow') workflows.push(j);
    else if (j.kind === 'pageload') pageLoads.push(j);
    else if (j.kind === 'lighthouse') lighthouse = j;
  }
  const budgets: Budgets = JSON.parse(fs.readFileSync(path.join(root, 'perf-budgets.json'), 'utf8'));
  return { workflows, pageLoads, lighthouse, budgets };
}

// ---------------------------------------------------------------------------------------------- page loads
const PROFILE_ORDER = ['desktop', 'mobile-slow4g'];
const MODE_ORDER = ['cold', 'warm', 'reload'];
const PAGE_ORDER = ['Home Feed', 'Create Post', 'Stock page (RELIANCE)', 'Post page'];
const ord = (list: string[], v: string) => (list.indexOf(v) === -1 ? 99 : list.indexOf(v));

export interface PageLoadAgg {
  page: string;
  url: string;
  profile: string;
  mode: 'cold' | 'warm' | 'reload';
  okRuns: number;
  totalRuns: number;
  errors: string[];
  runs: Record<string, unknown>[];
  median: {
    ttfb: number | null;
    fcp: number | null;
    lcp: number | null;
    lcpElement: string | null;
    lcpResource: string | null;
    cls: number | null;
    tbt: number | null;
    dcl: number | null;
    load: number | null;
    requests: number | null;
    bytes: { doc: number; js: number; css: number; img: number; font: number; xhr: number; other: number; thirdParty: number; firstParty: number; total: number };
    dns: number | null;
    tcp: number | null;
    tls: number | null;
    responseEnd: number | null;
    uiReady: number | null;
    cachedRequests: number | null;
    thirdPartyRequests: number | null;
    firstPartyRequests: number | null;
    redirectCount: number | null;
    tbtToSettle: number | null;
    longTasks: number | null;
    loafCount: number | null;
    loafBlockingMs: number | null;
  };
  stats: Record<string, Stat | null>;
  status: Record<string, Status | null>;
  lcpBreakdown: Record<string, unknown> | null;
  topShifts: { element: string; value: number }[];
  redirectChain: string[];
  doc: { protocol: string | null; encoding: string | null; cacheControl: string | null; serverTiming: string | null };
  apiCalls: ApiAgg[];
  slowestRequests: PageLoadRun['slowestRequests'];
  thirdPartyHosts: PageLoadRun['thirdPartyHosts'];
  notCollected: Record<string, string>;
  screenshot: string | null;
  sanity: { ttfbBeforeFcp: boolean | null; fcpBeforeOrAtLcp: boolean | null };
}

function representative<T>(items: T[], value: (t: T) => number | null | undefined): T | null {
  const withV = items.filter((i) => value(i) != null).sort((a, b) => (value(a) as number) - (value(b) as number));
  if (!withV.length) return items[0] || null;
  return withV[Math.floor((withV.length - 1) / 2)];
}

export function aggregatePageLoads(raw: PageLoadResult[], budgets: Budgets): PageLoadAgg[] {
  const out: PageLoadAgg[] = [];
  for (const res of raw) {
    for (const mode of MODE_ORDER as ('cold' | 'warm' | 'reload')[]) {
      const all = res.runs.filter((r) => r.mode === mode);
      if (!all.length) continue;
      const runs = all.filter((r) => r.ok);
      const s = (pick: (r: PageLoadRun) => number | null | undefined, d: 1 | 4 = 1) => stat(runs.map(pick), d);
      const stats: Record<string, Stat | null> = {
        ttfb: withBudget(s((r) => r.ttfb), budgets.ttfbMs),
        fcp: withBudget(s((r) => r.fcp), budgets.fcpMs),
        lcp: withBudget(s((r) => r.lcp), budgets.lcpMs),
        cls: withBudget(s((r) => r.cls, 4), budgets.cls),
        tbt: withBudget(s((r) => r.tbt), budgets.tbtMs),
        dcl: s((r) => r.dcl),
        load: s((r) => r.load),
        dns: s((r) => r.dns),
        tcp: s((r) => r.tcp),
        tls: s((r) => r.tls),
        responseEnd: s((r) => r.responseEnd),
        uiReady: s((r) => r.uiReadyMs),
        requests: s((r) => r.requests),
        cachedRequests: s((r) => r.cachedRequests),
        // weight budgets are about what a first-time visitor downloads, so they only apply to cold loads
        jsTransferKb: withBudget(s((r) => r.bytes.js / 1024), mode === 'cold' ? budgets.jsTransferKb : undefined),
        pageWeightKb: withBudget(s((r) => r.bytes.total / 1024), mode === 'cold' ? budgets.pageWeightKb : undefined),
        tbtToSettle: s((r) => r.tbtToSettle),
      };
      const med = (k: string) => (stats[k] ? stats[k]!.median : null);
      const rep = representative(runs, (r) => r.lcp) || all[0];
      const bytesMed = (k: keyof PageLoadRun['bytes']) => Math.round(stat(runs.map((r) => r.bytes[k]))?.median ?? 0);
      const ttfb = med('ttfb');
      const fcp = med('fcp');
      const lcp = med('lcp');
      const notCollected: Record<string, string> = {};
      for (const k of ['ttfb', 'fcp', 'lcp', 'cls', 'tbt', 'load', 'lcpResource', 'lcpElement', 'inp', 'loaf']) {
        const why = all.map((r) => r.notCollected[k]).find(Boolean);
        if (why && (stats[k] == null || ['lcpResource', 'lcpElement', 'inp', 'loaf'].includes(k))) notCollected[k] = why;
      }
      out.push({
        page: res.page,
        url: res.url,
        profile: res.profile,
        mode,
        okRuns: runs.length,
        totalRuns: all.length,
        errors: all.filter((r) => !r.ok).map((r) => `run ${r.runIndex}: ${r.error}`),
        runs: all.map((r) => ({ runIndex: r.runIndex, ok: r.ok, ttfb: r.ttfb, fcp: r.fcp, lcp: r.lcp, cls: r.cls, tbt: r.tbt, dcl: r.dcl, load: r.load, uiReady: r.uiReadyMs, requests: r.requests, cachedRequests: r.cachedRequests, bytesTotal: r.bytes.total, error: r.error })),
        median: {
          ttfb,
          fcp,
          lcp,
          lcpElement: rep?.lcpElement ?? null,
          lcpResource: rep?.lcpResource ?? null,
          cls: med('cls'),
          tbt: med('tbt'),
          dcl: med('dcl'),
          load: med('load'),
          requests: med('requests'),
          bytes: { doc: bytesMed('doc'), js: bytesMed('js'), css: bytesMed('css'), img: bytesMed('img'), font: bytesMed('font'), xhr: bytesMed('xhr'), other: bytesMed('other'), thirdParty: bytesMed('thirdParty'), firstParty: bytesMed('firstParty'), total: bytesMed('total') },
          dns: med('dns'),
          tcp: med('tcp'),
          tls: med('tls'),
          responseEnd: med('responseEnd'),
          uiReady: med('uiReady'),
          cachedRequests: med('cachedRequests'),
          thirdPartyRequests: stat(runs.map((r) => r.counts.thirdParty))?.median ?? null,
          firstPartyRequests: stat(runs.map((r) => r.counts.firstParty))?.median ?? null,
          redirectCount: stat(runs.map((r) => r.redirectCount))?.median ?? null,
          tbtToSettle: med('tbtToSettle'),
          longTasks: stat(runs.map((r) => r.longTaskCount))?.median ?? null,
          loafCount: stat(runs.map((r) => r.loaf?.count))?.median ?? null,
          loafBlockingMs: stat(runs.map((r) => r.loaf?.blockingMs))?.median ?? null,
        },
        stats,
        status: {
          ttfb: stats.ttfb?.status ?? null,
          fcp: stats.fcp?.status ?? null,
          lcp: stats.lcp?.status ?? null,
          cls: stats.cls?.status ?? null,
          tbt: stats.tbt?.status ?? null,
          jsTransferKb: stats.jsTransferKb?.status ?? null,
          pageWeightKb: stats.pageWeightKb?.status ?? null,
        },
        lcpBreakdown: rep?.lcpBreakdown ?? null,
        topShifts: rep?.topShifts ?? [],
        redirectChain: rep?.redirectChain ?? [],
        doc: { protocol: rep?.navProtocol ?? null, encoding: rep?.docEncoding ?? null, cacheControl: rep?.docCacheControl ?? null, serverTiming: rep?.docServerTiming ?? null },
        apiCalls: aggregateApi(
          runs.map((r) => r.apiCalls),
          budgets,
        ),
        slowestRequests: rep?.slowestRequests ?? [],
        thirdPartyHosts: rep?.thirdPartyHosts ?? [],
        notCollected,
        screenshot: all.map((r) => r.screenshot).find(Boolean) || null,
        sanity: { ttfbBeforeFcp: ttfb != null && fcp != null ? ttfb < fcp : null, fcpBeforeOrAtLcp: fcp != null && lcp != null ? fcp <= lcp : null },
      });
    }
  }
  return out.sort((a, b) => ord(PAGE_ORDER, a.page) - ord(PAGE_ORDER, b.page) || ord(PROFILE_ORDER, a.profile) - ord(PROFILE_ORDER, b.profile) || ord(MODE_ORDER, a.mode) - ord(MODE_ORDER, b.mode));
}

// ---------------------------------------------------------------------------------------------- API calls
export interface ApiAgg {
  method: string;
  url: string;
  host: string;
  path: string;
  resourceType: string;
  firstParty: boolean;
  polling: boolean;
  status: number | null;
  statuses: number[];
  callsPerRun: number;
  runsSeen: number;
  startOffsetMs: number | null;
  durationMs: Stat | null;
  timing: { blocked: number; dns: number; connect: number; ssl: number; wait: number; download: number } | null;
  timingNote: string | null;
  requestBytes: number | null;
  responseBytes: number | null;
  bodyBytes: number | null;
  contentType: string | null;
  encoding: string | null;
  cacheControl: string | null;
  etag: string | null;
  age: string | null;
  xCache: string | null;
  serverTiming: string | null;
  requestHeaders: Record<string, string>;
  payload: string | null;
  payloadTruncated: boolean;
  responsePreview: string | null;
  responsePreviewTruncated: boolean;
  sequentialAfter: string | null;
  failureText: string | null;
  flags: string[];
}

/** Collapse ids so the same endpoint groups across runs even when a different post is opened. */
function normPath(p: string): string {
  return p.replace(/\/\d{5,}(?=[/.]|$)/g, '/{id}');
}

export function aggregateApi(perRun: RequestRecord[][], budgets: Budgets): ApiAgg[] {
  const groups = new Map<string, { recs: RequestRecord[]; runs: Set<number>; firstStart: number }>();
  perRun.forEach((reqs, runIdx) => {
    for (const r of reqs) {
      const key = `${r.method} ${r.host}${normPath(r.path)}`;
      const g = groups.get(key) || { recs: [], runs: new Set<number>(), firstStart: Infinity };
      g.recs.push(r);
      g.runs.add(runIdx);
      if (r.startOffsetMs != null) g.firstStart = Math.min(g.firstStart, r.startOffsetMs);
      groups.set(key, g);
    }
  });
  const out: ApiAgg[] = [];
  for (const g of groups.values()) {
    const sample = g.recs.find((r) => r.responsePreview) || g.recs.find((r) => r.timing) || g.recs[0];
    const timed = g.recs.filter((r) => r.timing);
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(sample.method);
    const budget = sample.bucket === 'xhr' ? budgets[isWrite ? 'apiWriteMs' : 'apiReadMs'] : undefined;
    const tm = (k: 'blocked' | 'dns' | 'connect' | 'ssl' | 'wait' | 'download') => stat(timed.map((r) => r.timing![k]))?.median ?? 0;
    const flags = [...new Set(g.recs.flatMap((r) => r.flags))];
    out.push({
      method: sample.method,
      url: sample.url,
      host: sample.host,
      path: normPath(sample.path),
      resourceType: sample.resourceType,
      firstParty: sample.firstParty,
      polling: sample.polling,
      status: mode(g.recs.map((r) => r.status)),
      statuses: [...new Set(g.recs.map((r) => r.status).filter((x): x is number => x != null))],
      callsPerRun: r1(g.recs.length / Math.max(1, perRun.length)),
      runsSeen: g.runs.size,
      startOffsetMs: stat(g.recs.map((r) => r.startOffsetMs))?.median ?? null,
      durationMs: withBudget(stat(g.recs.map((r) => r.durationMs)), budget),
      timing: timed.length ? { blocked: tm('blocked'), dns: tm('dns'), connect: tm('connect'), ssl: tm('ssl'), wait: tm('wait'), download: tm('download') } : null,
      timingNote: timed.length ? (timed.every((r) => r.timing!.reusedConnection) ? 'connection reused: no DNS / connect / TLS cost' : null) : `not collected: ${sample.failed ? `request failed (${sample.failureText})` : 'request had not finished when the step window closed'}`,
      requestBytes: stat(g.recs.map((r) => r.requestBytes))?.median ?? null,
      responseBytes: stat(g.recs.map((r) => r.responseBytes))?.median ?? null,
      bodyBytes: stat(g.recs.map((r) => r.bodyBytes))?.median ?? null,
      contentType: sample.contentType,
      encoding: sample.encoding,
      cacheControl: sample.cacheControl,
      etag: sample.etag,
      age: sample.age,
      xCache: sample.xCache,
      serverTiming: g.recs.map((r) => r.serverTiming).find(Boolean) || null,
      requestHeaders: sample.requestHeaders,
      payload: sample.payload?.text ?? null,
      payloadTruncated: !!sample.payload?.truncated,
      responsePreview: sample.responsePreview?.text ?? null,
      responsePreviewTruncated: !!sample.responsePreview?.truncated,
      sequentialAfter: g.recs.map((r) => r.sequentialAfter).find(Boolean) || null,
      failureText: g.recs.map((r) => r.failureText).find(Boolean) || null,
      flags,
    });
  }
  return out.sort((a, b) => (a.startOffsetMs ?? 1e12) - (b.startOffsetMs ?? 1e12));
}

// ---------------------------------------------------------------------------------------------- workflows
export interface WaterfallRow {
  label: string;
  url: string;
  bucket: string;
  firstParty: boolean;
  polling: boolean;
  start: number;
  duration: number;
  timing: RequestRecord['timing'];
  status: number | null;
  flags: string[];
  sequentialAfter: string | null;
}

export interface StepAgg {
  index: number;
  name: string;
  action: string;
  stopPoint: boolean;
  /** functional outcome across the measured runs */
  status: 'passed' | 'failed' | 'skipped: irreversible';
  /** worst budget status of this step's measured values */
  budgetStatus: Status | null;
  isNavigation: boolean;
  anchor: string;
  runsMeasured: number;
  runsFailed: number;
  errors: { runIndex: number; error: string }[];
  clickToFeedbackMs: Stat | null;
  clickToAnyMutationMs: Stat | null;
  clickToFirstRequestMs: Stat | null;
  clickToApiDoneMs: Stat | null;
  clickToUiReadyMs: Stat | null;
  clickToNetworkIdleMs: Stat | null;
  eventTiming: { inputDelay: number; processing: number; presentation: number; duration: number; n: number; durationStat: Stat | null } | null;
  longTasksMs: Stat | null;
  cls: Stat | null;
  layoutShiftAll: Stat | null;
  loafBlockingMs: Stat | null;
  navigation: { type: string; softNavEntry: boolean; lcpMs: Stat | null; note: string } | null;
  typing: { keystrokes: number; typingMs: number | null; uiReadyAfterKeystroke: number | null; firstKeyToUiReadyMs: number | null } | null;
  milestones: Record<string, Stat | null>;
  parts: { label: string; at: number | null; feedbackMs: number | null; target: string | null }[];
  feedbackTarget: string | null;
  feedbackKind: string | null;
  uiConditions: { description: string; ms: number | null }[];
  expectApi: { pattern: string; matchedRuns: number; runs: number } | null;
  extra: Record<string, unknown>;
  segments: { feedback: number; network: number; render: number } | null;
  screenshot: string | null;
  api: ApiAgg[];
  staticResources: { bucket: string; requestsPerRun: number; bytesPerRun: number; slowestMs: number | null }[];
  waterfall: WaterfallRow[];
  requestCount: Stat | null;
  console: { type: string; text: string; count: number }[];
  notCollected: Record<string, string>;
  firstVisit: { status: string; clickToFeedbackMs: number | null; clickToUiReadyMs: number | null; clickToApiDoneMs: number | null } | null;
}

export interface WorkflowAgg {
  id: string;
  name: string;
  profile: string;
  startUrl: string;
  passRate: number | null;
  runsPassed: number;
  runsTotal: number;
  measuredFromFirstVisitOnly: boolean;
  totalMs: Stat | null;
  wallMs: Stat | null;
  entry: { readyMs: Stat | null; ttfb: Stat | null; fcp: Stat | null; lcp: Stat | null };
  steps: StepAgg[];
  runs: { runIndex: number; passed: boolean; error: string | null; totalMs: number | null; wallMs: number }[];
  firstVisit: { passed: boolean; error: string | null; totalMs: number | null; entryReadyMs: number | null; entryLcp: number | null } | null;
  findings: string[];
  cleanup: { description: string; ok: boolean; detail: string; runs: number }[];
  writes: { method: string; url: string; status: number | null; step: string | null; count: number; payload: string | null }[];
  slowestStep: { index: number; name: string; ms: number } | null;
  slowestApi: { step: number; method: string; path: string; ms: number } | null;
  representativeRun: number | null;
  env: WorkflowResult['env'];
}

const STEP_METRICS = ['clickToFeedbackMs', 'eventTiming', 'clickToFirstRequestMs', 'clickToApiDoneMs', 'clickToUiReadyMs', 'clickToNetworkIdleMs', 'longTasksMs', 'cls'];

function aggregateStep(index: number, runs: WorkflowRun[], rep: WorkflowRun | null, firstVisit: WorkflowRun | null, budgets: Budgets): StepAgg {
  const recs = runs.map((r) => ({ run: r, rec: r.steps.find((s) => s.index === index) })).filter((x): x is { run: WorkflowRun; rec: StepRecord } => !!x.rec);
  const first = recs[0].rec;
  const good = recs.filter((x) => x.rec.status === 'passed').map((x) => x.rec);
  const failed = recs.filter((x) => x.rec.status === 'failed');
  const s = (pick: (r: StepRecord) => number | null | undefined, d: 1 | 4 = 1) => stat(good.map(pick), d);
  const isNav = recs.some((x) => x.rec.isNavigation);

  const feedback = withBudget(s((r) => r.clickToFeedbackMs), budgets.clickToFeedbackMs);
  const uiReady = withBudget(s((r) => r.clickToUiReadyMs), isNav ? budgets.pageTransitionMs : budgets.clickToUiReadyMs);
  const apiDone = s((r) => r.clickToApiDoneMs);
  const clsStat = withBudget(s((r) => r.cls, 4), budgets.cls);
  const ets = good.map((r) => r.eventTiming).filter((e): e is NonNullable<StepRecord['eventTiming']> => !!e);
  const etDuration = withBudget(stat(ets.map((e) => e.duration)), budgets.inpMs);

  const repRec = (rep && rep.steps.find((x) => x.index === index)) || good[good.length - 1] || first;
  const notCollected: Record<string, string> = {};
  const metricStats: Record<string, unknown> = { clickToFeedbackMs: feedback, eventTiming: ets.length ? 1 : null, clickToFirstRequestMs: s((r) => r.clickToFirstRequestMs), clickToApiDoneMs: apiDone, clickToUiReadyMs: uiReady, clickToNetworkIdleMs: s((r) => r.clickToNetworkIdleMs), longTasksMs: s((r) => r.longTasksMs), cls: clsStat };
  for (const k of STEP_METRICS) {
    if (metricStats[k] == null) notCollected[k] = recs.map((x) => x.rec.notCollected[k]).find(Boolean) || (failed.length ? 'step failed before this could be measured' : 'no value recorded');
  }

  let segments: StepAgg['segments'] = null;
  if (uiReady) {
    const total = uiReady.median;
    const f = Math.min(feedback?.median ?? 0, total);
    const net = Math.max(0, Math.min(apiDone?.median ?? f, total) - f);
    segments = { feedback: r1(f), network: r1(net), render: r1(Math.max(0, total - f - net)) };
  }

  // network: API-like calls in detail, static resources summarised
  const perRunReqs = good.map((r) => r.requests);
  const detailed = (r: RequestRecord) => r.bucket === 'xhr' || r.bucket === 'doc';
  const api = aggregateApi(
    perRunReqs.map((reqs) => reqs.filter(detailed)),
    budgets,
  );
  const buckets = ['js', 'css', 'img', 'font', 'other'];
  const staticResources = buckets
    .map((b) => {
      const per = perRunReqs.map((reqs) => reqs.filter((r) => r.bucket === b));
      const all = per.flat();
      return {
        bucket: b,
        requestsPerRun: stat(per.map((p) => p.length))?.median ?? 0,
        bytesPerRun: Math.round(stat(per.map((p) => p.reduce((a, r) => a + (r.responseBytes || 0), 0)))?.median ?? 0),
        slowestMs: all.length ? r1(Math.max(...all.map((r) => r.durationMs || 0))) : null,
      };
    })
    .filter((x) => x.requestsPerRun > 0);

  const wfReqs = (repRec.requests || []).filter((r) => !r.polling && r.startOffsetMs != null);
  const keep = [...wfReqs.filter(detailed), ...wfReqs.filter((r) => !detailed(r)).sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 14)].sort((a, b) => (a.startOffsetMs as number) - (b.startOffsetMs as number));
  const waterfall: WaterfallRow[] = keep.map((r) => ({
    label: `${r.method} ${r.path.length > 46 ? '…' + r.path.slice(-45) : r.path}`,
    url: r.url,
    bucket: r.bucket,
    firstParty: r.firstParty,
    polling: r.polling,
    start: r.startOffsetMs as number,
    duration: r.durationMs ?? 0,
    timing: r.timing,
    status: r.status,
    flags: r.flags,
    sequentialAfter: r.sequentialAfter,
  }));

  const consoleMap = new Map<string, { type: string; text: string; count: number }>();
  for (const x of recs) for (const c of [...x.rec.console, ...x.rec.pageErrors]) {
    const key = c.type + c.text;
    const e = consoleMap.get(key) || { type: c.type, text: c.text, count: 0 };
    e.count++;
    consoleMap.set(key, e);
  }

  const msKeys = [...new Set(good.flatMap((r) => Object.keys(r.milestones)))];
  const fv = firstVisit?.steps.find((x) => x.index === index) || null;
  const typingRecs = good.map((r) => r.typing).filter((t): t is NonNullable<StepRecord['typing']> => !!t);
  const navRecs = good.map((r) => r.navigation).filter((n): n is NonNullable<StepRecord['navigation']> => !!n);
  const expectRecs = good.map((r) => r.expectApi).filter((e): e is NonNullable<StepRecord['expectApi']> => !!e);
  const status: StepAgg['status'] = failed.length ? 'failed' : first.stopPoint ? 'skipped: irreversible' : 'passed';

  return {
    index,
    name: first.name,
    action: first.action,
    stopPoint: first.stopPoint,
    status,
    budgetStatus: status === 'passed' ? worst([feedback?.status, uiReady?.status, clsStat?.status, etDuration?.status]) : null,
    isNavigation: isNav,
    anchor: repRec.anchor,
    runsMeasured: good.length,
    runsFailed: failed.length,
    errors: failed.map((x) => ({ runIndex: x.run.runIndex, error: x.rec.error || 'failed' })),
    clickToFeedbackMs: feedback,
    clickToAnyMutationMs: s((r) => r.clickToAnyMutationMs),
    clickToFirstRequestMs: metricStats.clickToFirstRequestMs as Stat | null,
    clickToApiDoneMs: apiDone,
    clickToUiReadyMs: uiReady,
    clickToNetworkIdleMs: metricStats.clickToNetworkIdleMs as Stat | null,
    eventTiming: ets.length
      ? {
          inputDelay: stat(ets.map((e) => e.inputDelay))!.median,
          processing: stat(ets.map((e) => e.processing))!.median,
          presentation: stat(ets.map((e) => e.presentation))!.median,
          duration: etDuration!.median,
          n: ets.length,
          durationStat: etDuration,
        }
      : null,
    longTasksMs: metricStats.longTasksMs as Stat | null,
    cls: clsStat,
    layoutShiftAll: s((r) => r.layoutShiftAll, 4),
    loafBlockingMs: s((r) => r.loafBlockingMs),
    navigation: navRecs.length ? { type: navRecs[0].type, softNavEntry: navRecs.some((n) => n.softNavEntry), lcpMs: stat(navRecs.map((n) => n.lcpMs)), note: navRecs[0].note } : null,
    typing: typingRecs.length
      ? {
          keystrokes: typingRecs[0].keystrokes,
          typingMs: stat(typingRecs.map((t) => t.typingMs))?.median ?? null,
          uiReadyAfterKeystroke: mode(typingRecs.map((t) => t.uiReadyAfterKeystroke ?? null)),
          firstKeyToUiReadyMs: stat(typingRecs.map((t) => t.firstKeyToUiReadyMs))?.median ?? null,
        }
      : null,
    milestones: Object.fromEntries(msKeys.map((k) => [k, s((r) => r.milestones[k])])),
    parts: (repRec.parts || []).map((p) => ({ label: p.label, at: p.at, feedbackMs: p.feedbackMs, target: p.target })),
    feedbackTarget: repRec.feedbackTarget,
    feedbackKind: repRec.feedbackKind,
    uiConditions: (repRec.uiConditions || []).map((u) => ({ description: u.description, ms: u.ms })),
    expectApi: expectRecs.length ? { pattern: expectRecs[0].pattern, matchedRuns: expectRecs.filter((e) => e.matched).length, runs: expectRecs.length } : null,
    extra: repRec.extra || {},
    segments,
    screenshot: repRec.screenshot || recs.map((x) => x.rec.screenshot).find(Boolean) || null,
    api,
    staticResources,
    waterfall,
    requestCount: stat(perRunReqs.map((r) => r.filter((x) => !x.polling).length)),
    console: [...consoleMap.values()],
    notCollected,
    firstVisit: fv ? { status: fv.status, clickToFeedbackMs: fv.clickToFeedbackMs, clickToUiReadyMs: fv.clickToUiReadyMs, clickToApiDoneMs: fv.clickToApiDoneMs } : null,
  };
}

export function aggregateWorkflows(raw: WorkflowResult[], budgets: Budgets): WorkflowAgg[] {
  const out: WorkflowAgg[] = [];
  for (const wr of raw) {
    const onlyFirst = wr.runs.length === 0 && !!wr.firstVisit;
    const runs = onlyFirst ? [wr.firstVisit as WorkflowRun] : wr.runs;
    if (!runs.length) continue;
    const passed = runs.filter((r) => r.passed);
    const totalMs = stat(passed.map((r) => r.totalMs));
    const rep = passed.length ? representative(passed, (r) => r.totalMs) : runs[runs.length - 1];
    const indexes = [...new Set(runs.flatMap((r) => r.steps.map((s) => s.index)))].sort((a, b) => a - b);
    const steps = indexes.map((i) => aggregateStep(i, runs, rep, onlyFirst ? null : wr.firstVisit, budgets));

    const timedSteps = steps.filter((s) => s.clickToUiReadyMs && s.action !== 'wait');
    const slow = timedSteps.sort((a, b) => b.clickToUiReadyMs!.median - a.clickToUiReadyMs!.median)[0];
    let slowestApi: WorkflowAgg['slowestApi'] = null;
    for (const s of steps) for (const a of s.api) {
      if (!a.firstParty || a.polling || a.resourceType === 'document' || !a.durationMs) continue;
      if (!slowestApi || a.durationMs.median > slowestApi.ms) slowestApi = { step: s.index, method: a.method, path: a.path, ms: a.durationMs.median };
    }
    const cleanupMap = new Map<string, { description: string; ok: boolean; detail: string; runs: number }>();
    for (const r of runs) for (const c of r.cleanup) {
      const e = cleanupMap.get(c.description) || { description: c.description, ok: true, detail: c.detail, runs: 0 };
      e.runs++;
      if (!c.ok) {
        e.ok = false;
        e.detail = c.detail;
      }
      cleanupMap.set(c.description, e);
    }
    const writeMap = new Map<string, WorkflowAgg['writes'][number]>();
    for (const r of [...runs, ...(wr.firstVisit && !onlyFirst ? [wr.firstVisit] : [])]) for (const w of r.writes) {
      const key = `${w.method} ${w.url.split('?')[0]} ${w.step}`;
      const e = writeMap.get(key) || { ...w, count: 0 };
      e.count++;
      writeMap.set(key, e);
    }
    out.push({
      id: wr.id,
      name: wr.name,
      profile: wr.profile,
      startUrl: wr.startUrl,
      passRate: runs.length ? Math.round((passed.length / runs.length) * 1000) / 1000 : null,
      runsPassed: passed.length,
      runsTotal: runs.length,
      measuredFromFirstVisitOnly: onlyFirst,
      totalMs,
      wallMs: stat(runs.map((r) => r.wallMs)),
      entry: {
        readyMs: stat(runs.map((r) => r.entry?.readyMs)),
        ttfb: stat(runs.map((r) => r.entry?.ttfb)),
        fcp: stat(runs.map((r) => r.entry?.fcp)),
        lcp: stat(runs.map((r) => r.entry?.lcp)),
      },
      steps: steps.sort((a, b) => a.index - b.index),
      runs: runs.map((r) => ({ runIndex: r.runIndex, passed: r.passed, error: r.error, totalMs: r.totalMs, wallMs: r.wallMs })),
      firstVisit: wr.firstVisit && !onlyFirst ? { passed: wr.firstVisit.passed, error: wr.firstVisit.error, totalMs: wr.firstVisit.totalMs, entryReadyMs: wr.firstVisit.entry?.readyMs ?? null, entryLcp: wr.firstVisit.entry?.lcp ?? null } : null,
      findings: wr.findings,
      cleanup: [...cleanupMap.values()],
      writes: [...writeMap.values()],
      slowestStep: slow ? { index: slow.index, name: slow.name, ms: slow.clickToUiReadyMs!.median } : null,
      slowestApi,
      representativeRun: rep ? rep.runIndex : null,
      env: wr.env,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || ord(PROFILE_ORDER, a.profile) - ord(PROFILE_ORDER, b.profile));
}

// ---------------------------------------------------------------------------------------------- quality
export interface Quality {
  consoleErrors: { workflow: string; profile: string; step: string; type: string; text: string; count: number }[];
  pageErrors: { workflow: string; profile: string; step: string; text: string; count: number }[];
  failedRequests: { workflow: string; profile: string; step: string; method: string; url: string; failure: string | null; count: number }[];
  abortedRequests: number;
  httpErrors: { workflow: string; profile: string; step: string; method: string; url: string; status: number; count: number }[];
  axe: { workflow: string; profile: string; page: string; url: string; critical: number; serious: number; moderate: number; minor: number; topRules: { id: string; impact: string; nodes: number; help: string }[]; error: string | null }[];
  brokenImages: { workflow: string; profile: string; page: string; url: string }[];
  mixedContent: { workflow: string; profile: string; page: string; detail: string }[];
  redirectChains: { page: string; profile: string; chain: string[] }[];
}

export function aggregateQuality(wfs: WorkflowResult[], pls: PageLoadResult[]): Quality {
  const q: Quality = { consoleErrors: [], pageErrors: [], failedRequests: [], abortedRequests: 0, httpErrors: [], axe: [], brokenImages: [], mixedContent: [], redirectChains: [] };
  const bump = <T extends { count: number }>(list: T[], key: (t: T) => string, item: T) => {
    const found = list.find((x) => key(x) === key(item));
    if (found) found.count++;
    else list.push(item);
  };
  const addConsole = (workflow: string, profile: string, step: string, list: ConsoleRecord[]) => {
    for (const c of list) {
      if (c.type === 'pageerror') bump(q.pageErrors, (x) => x.workflow + x.profile + x.step + x.text, { workflow, profile, step, text: c.text, count: 1 });
      else bump(q.consoleErrors, (x) => x.workflow + x.profile + x.step + x.type + x.text, { workflow, profile, step, type: c.type, text: c.text, count: 1 });
    }
  };
  const addReqs = (workflow: string, profile: string, step: string, reqs: RequestRecord[]) => {
    for (const r of reqs) {
      if (r.flags.includes('aborted')) q.abortedRequests++;
      if (r.flags.includes('failed')) bump(q.failedRequests, (x) => x.workflow + x.profile + x.step + x.method + x.url, { workflow, profile, step, method: r.method, url: r.url.slice(0, 300), failure: r.failureText, count: 1 });
      if (r.status != null && r.status >= 400) bump(q.httpErrors, (x) => x.workflow + x.profile + x.step + x.method + x.url + x.status, { workflow, profile, step, method: r.method, url: r.url.slice(0, 300), status: r.status, count: 1 });
    }
  };
  for (const wr of wfs) {
    for (const run of [wr.firstVisit, ...wr.runs]) {
      if (!run) continue;
      for (const st of run.steps) {
        const label = `step ${st.index}: ${st.name}`;
        addConsole(wr.id, wr.profile, label, [...st.console, ...st.pageErrors]);
        addReqs(wr.id, wr.profile, label, st.requests);
      }
    }
    for (const s of wr.quality as QualityScan[]) {
      q.axe.push({ workflow: wr.id, profile: wr.profile, page: s.page, url: s.url, critical: s.axe?.critical ?? 0, serious: s.axe?.serious ?? 0, moderate: s.axe?.moderate ?? 0, minor: s.axe?.minor ?? 0, topRules: s.axe?.topRules ?? [], error: s.axeError });
      for (const b of s.brokenImages) q.brokenImages.push({ workflow: wr.id, profile: wr.profile, page: s.page, url: b });
      for (const m of s.mixedContent) q.mixedContent.push({ workflow: wr.id, profile: wr.profile, page: s.page, detail: m });
    }
  }
  for (const pl of pls) {
    for (const run of pl.runs) {
      const label = `${pl.page} (${run.mode})`;
      addConsole('page-load', pl.profile, label, [...run.console, ...run.pageErrors]);
      for (const f of run.failedRequests) {
        if (f.status != null && f.status >= 400) bump(q.httpErrors, (x) => x.workflow + x.profile + x.step + x.url + x.status, { workflow: 'page-load', profile: pl.profile, step: label, method: 'GET', url: f.url, status: f.status, count: 1 });
        else bump(q.failedRequests, (x) => x.workflow + x.profile + x.step + x.url, { workflow: 'page-load', profile: pl.profile, step: label, method: 'GET', url: f.url, failure: f.failure, count: 1 });
      }
      for (const b of run.brokenImages) if (!q.brokenImages.some((x) => x.url === b && x.profile === pl.profile)) q.brokenImages.push({ workflow: 'page-load', profile: pl.profile, page: pl.page, url: b });
      for (const m of run.mixedContent) if (!q.mixedContent.some((x) => x.detail === m && x.profile === pl.profile)) q.mixedContent.push({ workflow: 'page-load', profile: pl.profile, page: pl.page, detail: m });
    }
    const cold = pl.runs.find((r) => r.mode === 'cold');
    if (cold) q.redirectChains.push({ page: pl.page, profile: pl.profile, chain: cold.redirectChain });
  }
  return q;
}

// ---------------------------------------------------------------------------------------------- flags
export interface Flag {
  severity: 'fail' | 'warn';
  workflow: string;
  profile: string;
  step: string;
  metric: string;
  value: number | string;
  budget: [number, number] | null;
  /** how far over the warn threshold the value is (1.0 = at threshold); used for sorting */
  overBy: number;
  message: string;
}

export function buildFlags(wfs: WorkflowAgg[], pls: PageLoadAgg[], lh: LhResult[], budgets: Budgets): Flag[] {
  const flags: Flag[] = [];
  const add = (st: Stat | null | undefined, workflow: string, profile: string, step: string, metric: string, unit: string, what: string) => {
    if (!st || !st.status || st.status === 'ok' || !st.budget) return;
    flags.push({
      severity: st.status,
      workflow,
      profile,
      step,
      metric,
      value: st.median,
      budget: st.budget,
      overBy: st.budget[0] ? st.median / st.budget[0] : 0,
      message: `${what}: median ${st.median}${unit} (budget warn ${st.budget[0]}${unit} / fail ${st.budget[1]}${unit})`,
    });
  };
  for (const w of wfs) {
    for (const r of w.runs.filter((x) => !x.passed)) {
      flags.push({ severity: 'fail', workflow: w.id, profile: w.profile, step: 'run ' + r.runIndex, metric: 'functional', value: 'failed', budget: null, overBy: 1e6, message: `Run ${r.runIndex} failed: ${(r.error || '').split('\n')[0]}` });
    }
    for (const s of w.steps) {
      const step = `step ${s.index}: ${s.name}`;
      add(s.clickToFeedbackMs, w.id, w.profile, step, 'clickToFeedbackMs', ' ms', 'Time to first visual feedback');
      add(s.clickToUiReadyMs, w.id, w.profile, step, s.isNavigation ? 'pageTransitionMs' : 'clickToUiReadyMs', ' ms', s.isNavigation ? 'Page transition (click to new page usable)' : 'Click to UI ready');
      add(s.eventTiming?.durationStat, w.id, w.profile, step, 'inpMs', ' ms', 'Interaction latency (Event Timing duration)');
      add(s.cls, w.id, w.profile, step, 'cls', '', 'Layout shift during the step');
      for (const a of s.api) {
        if (a.polling || !a.firstParty) continue; // the API budgets are about the site's own endpoints
        add(a.durationMs, w.id, w.profile, step, a.method === 'GET' ? 'apiReadMs' : 'apiWriteMs', ' ms', `API ${a.method} ${a.path}`);
      }
    }
  }
  for (const p of pls) {
    const step = `${p.page} (${p.mode})`;
    add(p.stats.ttfb, 'page-load', p.profile, step, 'ttfbMs', ' ms', 'TTFB');
    add(p.stats.fcp, 'page-load', p.profile, step, 'fcpMs', ' ms', 'FCP');
    add(p.stats.lcp, 'page-load', p.profile, step, 'lcpMs', ' ms', 'LCP');
    add(p.stats.cls, 'page-load', p.profile, step, 'cls', '', 'CLS');
    add(p.stats.tbt, 'page-load', p.profile, step, 'tbtMs', ' ms', 'TBT');
    add(p.stats.jsTransferKb, 'page-load', p.profile, step, 'jsTransferKb', ' KB', 'JavaScript transferred');
    add(p.stats.pageWeightKb, 'page-load', p.profile, step, 'pageWeightKb', ' KB', 'Page weight transferred');
    for (const e of p.errors) flags.push({ severity: 'fail', workflow: 'page-load', profile: p.profile, step, metric: 'functional', value: 'failed', budget: null, overBy: 1e6, message: `Page load failed: ${e}` });
  }
  for (const l of lh) {
    if (!l.collected || l.scores?.performance == null) continue;
    const st = statusOf(l.scores.performance, budgets.lighthousePerf, true);
    if (st && st !== 'ok')
      flags.push({
        severity: st,
        workflow: 'lighthouse',
        profile: l.formFactor,
        step: l.page,
        metric: 'lighthousePerf',
        value: l.scores.performance,
        budget: budgets.lighthousePerf,
        overBy: budgets.lighthousePerf[0] / Math.max(1, l.scores.performance),
        message: `Lighthouse performance score ${l.scores.performance} (${l.formFactor}); budget ok >= ${budgets.lighthousePerf[0]}, fail < ${budgets.lighthousePerf[1]}`,
      });
  }
  return flags.sort((a, b) => (a.severity === b.severity ? b.overBy - a.overBy : a.severity === 'fail' ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------- unstable
export interface Unstable {
  scope: string;
  profile: string;
  where: string;
  metric: string;
  median: number;
  min: number;
  max: number;
  cov: number;
  n: number;
}

export function collectUnstable(wfs: WorkflowAgg[], pls: PageLoadAgg[]): Unstable[] {
  const out: Unstable[] = [];
  const push = (st: Stat | null | undefined, scope: string, profile: string, where: string, metric: string) => {
    if (st && st.unstable && st.cov != null) out.push({ scope, profile, where, metric, median: st.median, min: st.min, max: st.max, cov: st.cov, n: st.n });
  };
  for (const w of wfs) {
    push(w.totalMs, w.id, w.profile, 'whole workflow', 'totalMs');
    push(w.entry.readyMs, w.id, w.profile, 'entry page', 'entryReadyMs');
    for (const s of w.steps) {
      const where = `step ${s.index}: ${s.name}`;
      push(s.clickToFeedbackMs, w.id, w.profile, where, 'clickToFeedbackMs');
      push(s.clickToFirstRequestMs, w.id, w.profile, where, 'clickToFirstRequestMs');
      push(s.clickToApiDoneMs, w.id, w.profile, where, 'clickToApiDoneMs');
      push(s.clickToUiReadyMs, w.id, w.profile, where, 'clickToUiReadyMs');
      push(s.clickToNetworkIdleMs, w.id, w.profile, where, 'clickToNetworkIdleMs');
      push(s.longTasksMs, w.id, w.profile, where, 'longTasksMs');
      push(s.eventTiming?.durationStat, w.id, w.profile, where, 'eventTiming.duration');
      for (const a of s.api) if (!a.polling && a.firstParty) push(a.durationMs, w.id, w.profile, where, `API ${a.method} ${a.path}`);
    }
  }
  for (const p of pls) for (const k of ['ttfb', 'fcp', 'lcp', 'tbt', 'dcl', 'load', 'uiReady']) push(p.stats[k], 'page-load', p.profile, `${p.page} (${p.mode})`, k);
  return out.sort((a, b) => b.cov - a.cov);
}
