/**
 * Captures every request/response on a page with timing, classification, redacted payloads and flags.
 * Also tracks in-flight first-party requests so callers can wait for (and timestamp) network idle.
 */
import type { CDPSession, Page, Request, Response } from '@playwright/test';
import type { Budgets, ConsoleRecord, RequestFlag, RequestRecord, RequestTiming } from './types';
import type { Redactor } from './redact';

export const POLLING_PATHS: RegExp[] = [/^\/api\/v1\/user\/get_all_unread_counts\/?$/, /^\/api\/v1\/inbox\/unreads\/?$/, /^\/socket\.io\//];
const PAYLOAD_MAX = 4 * 1024;
const PREVIEW_MAX = 2 * 1024;
const TEXT_CT = /json|text\/|javascript|xml|svg|x-www-form-urlencoded|x-script/i;
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);
const HEADER_SUBSET = ['content-type', 'accept', 'x-requested-with'];

export interface RecorderOptions {
  /** e.g. "front.page": this host and its subdomains are first-party */
  baseHost: string;
  redactor: Redactor;
  budgets: Budgets;
  cdp?: CDPSession;
  pollingPaths?: RegExp[];
}

function bucketOf(type: string): string {
  switch (type) {
    case 'document':
      return 'doc';
    case 'script':
      return 'js';
    case 'stylesheet':
      return 'css';
    case 'image':
      return 'img';
    case 'font':
      return 'font';
    case 'xhr':
    case 'fetch':
      return 'xhr';
    default:
      return 'other';
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeTiming(t: ReturnType<Request['timing']>): RequestTiming | null {
  if (!t || t.responseEnd < 0) return null;
  const has = (x: number) => typeof x === 'number' && x >= 0;
  const dns = has(t.domainLookupStart) && has(t.domainLookupEnd) ? t.domainLookupEnd - t.domainLookupStart : 0;
  const ssl = has(t.secureConnectionStart) && has(t.connectEnd) ? Math.max(0, t.connectEnd - t.secureConnectionStart) : 0;
  const connectAll = has(t.connectStart) && has(t.connectEnd) ? Math.max(0, t.connectEnd - t.connectStart) : 0;
  const connect = Math.max(0, connectAll - ssl);
  const reqStart = has(t.requestStart) ? t.requestStart : 0;
  const respStart = has(t.responseStart) ? t.responseStart : reqStart;
  const wait = Math.max(0, respStart - reqStart);
  const download = Math.max(0, t.responseEnd - respStart);
  const blocked = Math.max(0, reqStart - dns - connectAll);
  return {
    blocked: round1(blocked),
    dns: round1(dns),
    connect: round1(connect),
    ssl: round1(ssl),
    wait: round1(wait),
    download: round1(download),
    total: round1(t.responseEnd),
    reusedConnection: dns === 0 && connectAll === 0,
  };
}

export class NetworkRecorder {
  readonly records: RequestRecord[] = [];
  readonly consoleMessages: ConsoleRecord[] = [];
  readonly pageErrors: ConsoleRecord[] = [];
  websockets = 0;

  private seq = 0;
  private byReq = new Map<Request, RequestRecord>();
  private inflight = new Set<RequestRecord>();
  private pending = new Set<Promise<void>>();
  private step: string | null = null;
  private lastActivity = Date.now();
  private cdpRequestUrl = new Map<string, string>();
  private cachedUrls = new Map<string, number>();
  private polling: RegExp[];
  private attached = false;

  constructor(
    private page: Page,
    private opts: RecorderOptions,
  ) {
    this.polling = opts.pollingPaths || POLLING_PATHS;
  }

  // ---- classification -------------------------------------------------------------------------------
  isFirstParty(host: string): boolean {
    const h = host.toLowerCase().replace(/:\d+$/, '');
    const base = this.opts.baseHost.toLowerCase().replace(/:\d+$/, '');
    return h === base || h.endsWith('.' + base);
  }
  isPolling(pathname: string): boolean {
    return this.polling.some((re) => re.test(pathname));
  }

  // ---- lifecycle ------------------------------------------------------------------------------------
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const p = this.page;
    p.on('request', this.onRequest);
    p.on('response', this.onResponse);
    p.on('requestfinished', this.onFinished);
    p.on('requestfailed', this.onFailed);
    p.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      const loc = msg.location();
      this.consoleMessages.push({
        type,
        text: this.opts.redactor.text(msg.text()).slice(0, 600),
        location: loc?.url ? this.opts.redactor.url(loc.url).slice(0, 200) + (loc.lineNumber ? `:${loc.lineNumber}` : '') : '',
        step: this.step,
        at: Date.now(),
      });
    });
    p.on('pageerror', (err) => {
      this.pageErrors.push({
        type: 'pageerror',
        text: this.opts.redactor.text(`${err.name}: ${err.message}`).slice(0, 600),
        location: this.opts.redactor.text((err.stack || '').split('\n')[1] || '').trim().slice(0, 200),
        step: this.step,
        at: Date.now(),
      });
    });
    p.on('websocket', () => {
      this.websockets++;
    });
    const cdp = this.opts.cdp;
    if (cdp) {
      cdp.on('Network.requestWillBeSent', (e: { requestId: string; request: { url: string } }) => {
        this.cdpRequestUrl.set(e.requestId, e.request.url);
        if (this.cdpRequestUrl.size > 5000) {
          const first = this.cdpRequestUrl.keys().next().value;
          if (first) this.cdpRequestUrl.delete(first);
        }
      });
      // memory-cache hits announce themselves with requestServedFromCache; disk-cache hits only set a flag
      // on the response. A request can trigger both, so count each requestId once.
      const counted = new Set<string>();
      const markCached = (requestId: string, url?: string) => {
        if (counted.has(requestId)) return;
        const u = url || this.cdpRequestUrl.get(requestId);
        if (!u) return;
        counted.add(requestId);
        if (counted.size > 5000) counted.clear();
        this.cachedUrls.set(u, (this.cachedUrls.get(u) || 0) + 1);
      };
      cdp.on('Network.requestServedFromCache', (e: { requestId: string }) => markCached(e.requestId));
      cdp.on('Network.responseReceived', (e: { requestId: string; response: { url: string; fromDiskCache?: boolean; fromPrefetchCache?: boolean } }) => {
        if (e.response.fromDiskCache || e.response.fromPrefetchCache) markCached(e.requestId, e.response.url);
      });
    }
  }

  setStep(label: string | null): void {
    this.step = label;
  }

  /** Index marker: records.slice(mark) are the requests that started after this call. */
  mark(): number {
    return this.records.length;
  }
  consoleMark(): { console: number; errors: number } {
    return { console: this.consoleMessages.length, errors: this.pageErrors.length };
  }

  // ---- event handlers -------------------------------------------------------------------------------
  private onRequest = (req: Request) => {
    let host = '';
    let pathname = '';
    const rawUrl = req.url();
    try {
      const u = new URL(rawUrl);
      host = u.host;
      pathname = u.pathname;
    } catch {
      /* data:, blob: */
    }
    if (/^(data|blob|chrome-extension|about):/i.test(rawUrl)) return;
    const type = req.resourceType();
    const firstParty = this.isFirstParty(host);
    const polling = firstParty && this.isPolling(pathname);
    const method = req.method();
    const headers = req.headers();
    const subset: Record<string, string> = {};
    for (const h of HEADER_SUBSET) if (headers[h]) subset[h] = headers[h];

    let payload = null;
    try {
      const raw = req.postData();
      if (raw) payload = this.opts.redactor.body(raw, PAYLOAD_MAX);
    } catch {
      /* binary body */
    }

    const prev = req.redirectedFrom();
    const rec: RequestRecord = {
      id: ++this.seq,
      method,
      url: this.opts.redactor.url(rawUrl).slice(0, 1500),
      host,
      path: this.opts.redactor.text(pathname).slice(0, 300),
      resourceType: type,
      bucket: bucketOf(type),
      firstParty,
      polling,
      api: firstParty && (type === 'xhr' || type === 'fetch'),
      step: this.step,
      startEpoch: Date.now(),
      endEpoch: null,
      startOffsetMs: null,
      status: null,
      failed: false,
      failureText: null,
      timing: null,
      durationMs: null,
      requestHeaders: this.opts.redactor.headers(subset),
      payload,
      requestBytes: null,
      responseBytes: null,
      bodyBytes: null,
      contentLength: null,
      contentType: null,
      encoding: null,
      cacheControl: null,
      etag: null,
      age: null,
      xCache: null,
      serverTiming: null,
      fromCache: false,
      responsePreview: null,
      redirectedFrom: prev ? this.opts.redactor.url(prev.url()).slice(0, 500) : null,
      sequentialAfter: null,
      flags: polling ? ['polling'] : [],
    };
    this.records.push(rec);
    this.byReq.set(req, rec);
    if (firstParty && !polling && type !== 'websocket' && type !== 'eventsource') {
      this.inflight.add(rec);
      this.lastActivity = Date.now();
    }
  };

  private onResponse = (res: Response) => {
    const rec = this.byReq.get(res.request());
    if (!rec) return;
    rec.status = res.status();
    const h = res.headers();
    rec.contentType = h['content-type'] || null;
    rec.encoding = h['content-encoding'] || null;
    rec.cacheControl = h['cache-control'] || null;
    rec.etag = h['etag'] ? this.opts.redactor.text(h['etag']).slice(0, 120) : null;
    rec.age = h['age'] || null;
    rec.xCache = h['x-cache'] || h['cf-cache-status'] || h['x-cache-status'] || null;
    rec.serverTiming = h['server-timing'] ? this.opts.redactor.text(h['server-timing']).slice(0, 1000) : null;
    rec.contentLength = h['content-length'] != null && h['content-length'] !== '' ? Number(h['content-length']) : null;
  };

  private onFinished = (req: Request) => {
    const rec = this.byReq.get(req);
    if (!rec) return;
    const job = this.finish(req, rec).catch(() => {});
    this.pending.add(job);
    job.finally(() => this.pending.delete(job));
  };

  private async finish(req: Request, rec: RequestRecord): Promise<void> {
    const nodeEnd = Date.now();
    try {
      const t = req.timing();
      rec.timing = computeTiming(t);
      if (t.startTime > 0) {
        rec.startEpoch = t.startTime;
        rec.endEpoch = t.responseEnd >= 0 ? t.startTime + t.responseEnd : nodeEnd;
      } else rec.endEpoch = nodeEnd;
      rec.durationMs = rec.timing ? rec.timing.total : round1(Math.max(0, rec.endEpoch - rec.startEpoch));
    } catch {
      rec.endEpoch = nodeEnd;
    }
    // network-idle bookkeeping first, so it is not delayed by body reads (polling never moves the idle clock)
    if (this.inflight.delete(rec)) this.lastActivity = Date.now();

    const cached = this.cachedUrls.get(req.url());
    if (cached) {
      rec.fromCache = true;
      if (cached <= 1) this.cachedUrls.delete(req.url());
      else this.cachedUrls.set(req.url(), cached - 1);
    }
    try {
      const sizes = await req.sizes();
      rec.requestBytes = sizes.requestBodySize + sizes.requestHeadersSize;
      rec.responseBytes = Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize);
      if (rec.fromCache) rec.responseBytes = 0;
    } catch {
      /* sizes unavailable (page closed, redirect) */
    }
    if (rec.status === 304) rec.fromCache = true;

    if (rec.api && rec.contentType && TEXT_CT.test(rec.contentType) && rec.status !== 204 && rec.status !== 304) {
      try {
        const res = await req.response();
        if (res) {
          const buf = await res.body();
          rec.bodyBytes = buf.length;
          rec.responsePreview = this.opts.redactor.body(buf.subarray(0, 64 * 1024).toString('utf8'), PREVIEW_MAX);
          if (rec.responsePreview) {
            rec.responsePreview.bytes = buf.length;
            if (buf.length > 64 * 1024) rec.responsePreview.truncated = true;
          }
        }
      } catch {
        /* body evicted after navigation */
      }
    }
    this.flag(rec);
  }

  private onFailed = (req: Request) => {
    const rec = this.byReq.get(req);
    if (!rec) return;
    rec.failed = true;
    rec.failureText = this.opts.redactor.text(req.failure()?.errorText || 'failed');
    rec.endEpoch = Date.now();
    try {
      const t = req.timing();
      if (t.startTime > 0) rec.startEpoch = t.startTime;
    } catch {
      /* no timing */
    }
    rec.durationMs = round1(Math.max(0, rec.endEpoch - rec.startEpoch));
    if (this.inflight.delete(rec)) this.lastActivity = Date.now();
    this.flag(rec);
  };

  private flag(rec: RequestRecord): void {
    const f = new Set<RequestFlag>(rec.flags);
    if (rec.polling) f.add('polling');
    if (rec.failed) f.add(/ERR_ABORTED/i.test(rec.failureText || '') ? 'aborted' : 'failed');
    if (rec.status != null && rec.status >= 400) f.add('http_error');
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(rec.method);
    if (isWrite && rec.firstParty) f.add('write');
    if (rec.bucket === 'xhr' && rec.durationMs != null) {
      const budget = this.opts.budgets[isWrite ? 'apiWriteMs' : 'apiReadMs'];
      if (budget && rec.durationMs > budget[0]) f.add('slow');
    }
    const size = rec.bodyBytes ?? rec.responseBytes ?? 0;
    const wire = rec.responseBytes ?? rec.contentLength ?? 0;
    if (!rec.fromCache && !rec.failed && rec.status != null && rec.status < 300) {
      if (!rec.encoding && rec.contentType && TEXT_CT.test(rec.contentType) && size > 1024) f.add('uncompressed');
      if (wire > 100 * 1024) f.add('large');
      if (rec.method === 'GET' && STATIC_TYPES.has(rec.resourceType) && !rec.cacheControl) f.add('no_cache_headers');
    }
    rec.flags = [...f];
  }

  // ---- idle + flush ---------------------------------------------------------------------------------
  /**
   * Resolve when no first-party (non-polling) request has been in flight for quietMs.
   * `lastEndEpoch` is the browser-clock end of the last such request that started at/after sinceIndex.
   */
  async waitForIdle(opts: { quietMs?: number; timeoutMs?: number; sinceIndex?: number } = {}): Promise<{ reached: boolean; lastEndEpoch: number | null; inflight: string[] }> {
    const quiet = opts.quietMs ?? 500;
    const timeout = opts.timeoutMs ?? 20_000;
    const start = Date.now();
    let reached = false;
    while (Date.now() - start < timeout) {
      if (this.inflight.size === 0 && Date.now() - this.lastActivity >= quiet) {
        reached = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    await this.flush();
    const since = this.records.slice(opts.sinceIndex ?? 0).filter((r) => r.firstParty && !r.polling && r.endEpoch != null);
    const lastEndEpoch = since.length ? Math.max(...since.map((r) => r.endEpoch as number)) : null;
    return { reached, lastEndEpoch, inflight: [...this.inflight].map((r) => `${r.method} ${r.path}`).slice(0, 10) };
  }

  /** Wait for async body/size reads of already-finished requests. */
  async flush(timeoutMs = 5000): Promise<void> {
    if (!this.pending.size) return;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  /** Requests that are still pending are abandoned for idle purposes (called before a hard navigation). */
  resetInflight(): void {
    this.inflight.clear();
    this.lastActivity = Date.now();
  }
}

/** Step-scoped flags that need the whole window: duplicates and sequential (waterfall) API calls. */
export function applyWindowFlags(requests: RequestRecord[]): void {
  const seen = new Map<string, RequestRecord>();
  for (const r of requests) {
    if (r.polling) continue;
    const key = `${r.method} ${r.url} ${r.payload?.text || ''}`;
    if (seen.has(key)) {
      if (!r.flags.includes('duplicate')) r.flags.push('duplicate');
      const first = seen.get(key)!;
      if (!first.flags.includes('duplicate')) first.flags.push('duplicate');
    } else seen.set(key, r);
  }
  const api = requests.filter((r) => r.api && !r.polling && r.endEpoch != null).sort((a, b) => a.startEpoch - b.startEpoch);
  for (const r of api) {
    // the latest-finishing first-party API call that ended before this one started
    let prev: RequestRecord | null = null;
    for (const o of api) {
      if (o === r || o.endEpoch == null) continue;
      if (o.endEpoch <= r.startEpoch && (!prev || o.endEpoch > (prev.endEpoch as number))) prev = o;
    }
    if (prev) {
      if (!r.flags.includes('sequential')) r.flags.push('sequential');
      r.sequentialAfter = `${prev.method} ${prev.path} (+${Math.round(r.startEpoch - (prev.endEpoch as number))} ms after it ended)`;
    }
  }
}
