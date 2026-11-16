/**
 * metrics -> one self-contained HTML file: inline CSS + JS, charts as inline SVG, no network requests.
 * Chart rules: fixed categorical order, 2px surface gaps between segments, legends for multi-series charts,
 * text in ink colours (never the series colour), status = icon + label + colour (never colour alone).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ApiAgg, Flag, LhFlow, LhResult, PageLoadAgg, Quality, Stat, Status, StepAgg, Unstable, WaterfallRow, WorkflowAgg } from './report-aggregate';
import { statusOf } from './report-aggregate';
import type { Budgets } from '../lib/types';

export interface ReportModel {
  meta: Record<string, unknown> & {
    site: string;
    baseUrl: string;
    generatedAt: string;
    testLocation: string;
    browserVersion: string;
    playwrightVersion: string;
    runsPerProfile: number;
    profiles: { name: string; label: string; userAgent: string; viewport: { width: number; height: number } }[];
  };
  budgets: Budgets;
  pageLoads: PageLoadAgg[];
  workflows: WorkflowAgg[];
  lighthouse: LhResult[];
  lighthouseFlow: LhFlow | null;
  lighthouseNotes: string[];
  quality: Quality;
  flags: Flag[];
  unstable: Unstable[];
  findings: string[];
  sanity: { name: string; ok: boolean; detail: string }[];
  playwrightReports: { label: string; href: string; exists: boolean }[];
  reportsDir: string;
  embedScreenshots: boolean;
}

// ------------------------------------------------------------------------------------------------ helpers
const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const nf = new Intl.NumberFormat('en-US');
function num(v: number, digits = 0): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
}
function ms(v: number | null | undefined): string {
  if (v == null) return '';
  return v >= 100 ? `${nf.format(Math.round(v))} ms` : `${num(v, 1)} ms`;
}
function kb(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  return bytes >= 1024 * 1024 ? `${num(bytes / 1024 / 1024, 2)} MB` : `${num(bytes / 1024, bytes < 10240 ? 1 : 0)} KB`;
}
const nc = (reason?: string | null) => `<span class="nc" title="${esc(reason || 'not collected')}">not collected</span>${reason ? `<span class="nc-why"> (${esc(reason)})</span>` : ''}`;
const ncShort = (reason?: string | null) => `<span class="nc" title="${esc(reason || 'not collected')}">n/c</span>`;

const ICON: Record<Status, string> = { ok: '✓', warn: '▲', fail: '✕' };
const WORD: Record<Status, string> = { ok: 'ok', warn: 'warn', fail: 'fail' };
const chip = (s: Status | null | undefined, text?: string) => (s ? `<span class="chip chip-${s}">${ICON[s]} ${esc(text ?? WORD[s])}</span>` : '');

function statTitle(s: Stat, unit: string): string {
  return `median ${s.median}${unit} · ${s.p95Kind} ${s.p95}${unit} · min ${s.min}${unit} · max ${s.max}${unit} · n=${s.n}${s.cov != null ? ` · CoV ${(s.cov * 100).toFixed(0)}%` : ''}${s.budget ? ` · budget warn ${s.budget[0]} / fail ${s.budget[1]}` : ''}`;
}
/** A table cell for a statistic: median, coloured + icon when a budget applies. */
function td(s: Stat | null | undefined, opts: { unit?: 'ms' | 'cls' | 'kb' | 'count'; reason?: string | null; cls?: string } = {}): string {
  if (!s) return `<td class="num ${opts.cls || ''}">${ncShort(opts.reason)}</td>`;
  const unit = opts.unit || 'ms';
  const text = unit === 'ms' ? ms(s.median) : unit === 'cls' ? num(s.median, 4) : unit === 'kb' ? `${num(s.median, 0)} KB` : num(s.median, 1);
  const st = s.status;
  return `<td class="num ${st ? 'st-' + st : ''} ${opts.cls || ''}" title="${esc(statTitle(s, unit === 'ms' ? ' ms' : unit === 'kb' ? ' KB' : ''))}">${st ? `<span class="ic">${ICON[st]}</span> ` : ''}${text}${s.unstable ? ' <span class="unst" title="unstable: coefficient of variation above 30%">~</span>' : ''}</td>`;
}
function tdVal(v: number | null | undefined, st: Status | null | undefined, text: string, reason?: string | null, title?: string): string {
  if (v == null) return `<td class="num">${ncShort(reason)}</td>`;
  return `<td class="num ${st ? 'st-' + st : ''}"${title ? ` title="${esc(title)}"` : ''}>${st ? `<span class="ic">${ICON[st]}</span> ` : ''}${text}</td>`;
}

const PROFILE_LABEL: Record<string, string> = { desktop: 'Desktop', 'mobile-slow4g': 'Mobile slow 4G' };
const pl = (p: string) => PROFILE_LABEL[p] || p;

// ------------------------------------------------------------------------------------------------ charts
function niceTicks(max: number, count = 5): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}
/** rect with rounded right end (the data end); square at the baseline side */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  return `M${x},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 ${-rr},${rr}h${-(w - rr)}z`;
}
function legend(items: { cls: string; label: string }[]): string {
  return `<div class="legend">${items.map((i) => `<span class="lg"><i class="sw ${i.cls}"></i>${esc(i.label)}</span>`).join('')}</div>`;
}

interface BarRow {
  label: string;
  sub?: string;
  segs: { key: string; value: number }[];
  endLabel: string;
}
function stackedBars(rows: BarRow[], series: { key: string; label: string; cls: string }[], fmt: (v: number) => string, ariaLabel: string): string {
  const LABEL_W = 250;
  const W = 900;
  const END_W = 110;
  const PLOT = W - LABEL_W - END_W;
  const ROW = 34;
  const BAR = 16;
  const max = Math.max(1, ...rows.map((r) => r.segs.reduce((a, s) => a + s.value, 0)));
  const ticks = niceTicks(max);
  const scaleMax = Math.max(max, ticks[ticks.length - 1]);
  const x = (v: number) => (v / scaleMax) * PLOT;
  const H = rows.length * ROW + 30;
  let g = '';
  for (const t of ticks) {
    const tx = LABEL_W + x(t);
    g += `<line class="grid" x1="${tx}" y1="4" x2="${tx}" y2="${H - 24}"/><text class="tick" x="${tx}" y="${H - 8}" text-anchor="middle">${esc(fmt(t))}</text>`;
  }
  rows.forEach((r, i) => {
    const y = i * ROW + 10;
    g += `<text class="rowlabel" x="${LABEL_W - 10}" y="${y + (r.sub ? 7 : 12)}" text-anchor="end">${esc(r.label)}</text>`;
    if (r.sub) g += `<text class="rowsub" x="${LABEL_W - 10}" y="${y + 20}" text-anchor="end">${esc(r.sub)}</text>`;
    let cx = LABEL_W;
    const live = r.segs.filter((s) => s.value > 0);
    live.forEach((s, j) => {
      const w = x(s.value);
      const meta = series.find((q) => q.key === s.key)!;
      const gap = j < live.length - 1 ? 2 : 0; // 2px surface gap between touching segments
      const dw = Math.max(1, w - gap);
      const title = `<title>${esc(r.label)}${r.sub ? ' · ' + esc(r.sub) : ''} — ${esc(meta.label)}: ${esc(fmt(s.value))}</title>`;
      g += j === live.length - 1 ? `<path class="${meta.cls}" d="${barPath(cx, y, dw, BAR, 4)}">${title}</path>` : `<rect class="${meta.cls}" x="${cx}" y="${y}" width="${dw}" height="${BAR}">${title}</rect>`;
      cx += w;
    });
    g += `<text class="endlabel" x="${cx + 8}" y="${y + 12}">${esc(r.endLabel)}</text>`;
  });
  g += `<line class="axis" x1="${LABEL_W}" y1="4" x2="${LABEL_W}" y2="${H - 24}"/>`;
  return `${legend(series)}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">${g}</svg>`;
}

const PHASES: { key: 'blocked' | 'dns' | 'connect' | 'ssl' | 'wait' | 'download'; label: string; cls: string }[] = [
  { key: 'blocked', label: 'queued / stalled', cls: 'ph-blocked' },
  { key: 'dns', label: 'DNS', cls: 's1' },
  { key: 'connect', label: 'connect', cls: 's2' },
  { key: 'ssl', label: 'TLS', cls: 's3' },
  { key: 'wait', label: 'waiting (TTFB)', cls: 's4' },
  { key: 'download', label: 'download', cls: 's5' },
];

function waterfall(rows: WaterfallRow[], marks: { label: string; at: number | null; cls: string }[], ariaLabel: string): string {
  if (!rows.length) return `<p class="muted">No network requests were fired in this step (excluding background polling).</p>`;
  const LABEL_W = 330;
  const W = 900;
  const RIGHT = 120;
  const PLOT = W - LABEL_W - RIGHT;
  const ROW = 20;
  const TOP = 30;
  const end = Math.max(...rows.map((r) => r.start + r.duration), ...marks.map((m) => m.at ?? 0), 1);
  const origin = Math.min(0, ...rows.map((r) => r.start));
  const ticks = niceTicks(end - origin);
  const span = Math.max(end - origin, ticks[ticks.length - 1]);
  const x = (v: number) => LABEL_W + ((v - origin) / span) * PLOT;
  const H = TOP + rows.length * ROW + 26;
  let g = '';
  for (const t of ticks) {
    const tx = x(origin + t);
    g += `<line class="grid" x1="${tx}" y1="${TOP - 4}" x2="${tx}" y2="${H - 22}"/><text class="tick" x="${tx}" y="${H - 7}" text-anchor="middle">${esc(ms(origin + t))}</text>`;
  }
  rows.forEach((r, i) => {
    const y = TOP + i * ROW;
    const seq = r.flags.includes('sequential');
    const tip = `${r.url}\nstatus ${r.status ?? 'n/a'} · starts ${ms(r.start)} after the interaction · total ${ms(r.duration)}${r.timing ? ` · blocked ${r.timing.blocked} / dns ${r.timing.dns} / connect ${r.timing.connect} / tls ${r.timing.ssl} / wait ${r.timing.wait} / download ${r.timing.download} ms` : ' · no timing breakdown (aborted or still in flight)'}${r.flags.length ? '\nflags: ' + r.flags.join(', ') : ''}${r.sequentialAfter ? '\nsequential: started after ' + r.sequentialAfter : ''}`;
    // party marker: filled dot = first-party, hollow ring = third-party (also tagged "3P" in the label)
    g += r.firstParty ? `<circle class="p1" cx="8" cy="${y + 8}" r="4"/>` : `<circle class="p3" cx="8" cy="${y + 8}" r="3.2"/>`;
    g += `<text class="wlabel${seq ? ' seq' : ''}" x="18" y="${y + 12}">${seq ? '↳ ' : ''}${esc(r.label)}${r.firstParty ? '' : '  · 3P'}<title>${esc(tip)}</title></text>`;
    let cx = x(r.start);
    if (seq) g += `<rect class="seqmark" x="${cx - 4}" y="${y - 1}" width="2" height="18"/>`;
    if (r.timing) {
      const parts = PHASES.map((p) => ({ p, v: r.timing![p.key] })).filter((q) => q.v > 0);
      const total = parts.reduce((a, q) => a + q.v, 0) || r.duration || 1;
      const fullW = Math.max(3, ((r.duration || total) / span) * PLOT);
      parts.forEach((q, j) => {
        const w = (q.v / total) * fullW;
        const gap = j < parts.length - 1 && w > 4 ? 2 : 0;
        const dw = Math.max(1, w - gap);
        g += j === parts.length - 1 ? `<path class="${q.p.cls}" d="${barPath(cx, y + 2, dw, 12, 3)}"><title>${esc(q.p.label)}: ${q.v} ms\n${esc(tip)}</title></path>` : `<rect class="${q.p.cls}" x="${cx}" y="${y + 2}" width="${dw}" height="12"><title>${esc(q.p.label)}: ${q.v} ms\n${esc(tip)}</title></rect>`;
        cx += w;
      });
    } else {
      const w = Math.max(3, (r.duration / span) * PLOT);
      g += `<rect class="notiming" x="${cx}" y="${y + 2}" width="${w}" height="12"><title>${esc(tip)}</title></rect>`;
      cx += w;
    }
    const tags = [ms(r.duration), ...(r.status != null && r.status >= 400 ? [`HTTP ${r.status}`] : []), ...r.flags.filter((f) => ['slow', 'sequential', 'duplicate', 'failed', 'aborted', 'large', 'uncompressed'].includes(f))];
    g += `<text class="wend" x="${Math.min(cx + 6, W - 4)}" y="${y + 12}"${cx + 6 > W - RIGHT + 30 ? ' text-anchor="end" dx="-12"' : ''}>${esc(tags.join(' · '))}</text>`;
  });
  marks
    .filter((m) => m.at != null)
    .forEach((m, i) => {
      const mx = x(m.at as number);
      g += `<line class="${m.cls}" x1="${mx}" y1="${TOP - 6}" x2="${mx}" y2="${H - 22}"/><text class="marklabel" x="${mx + 4}" y="${10 + i * 11}"${mx > W - 170 ? ' text-anchor="end" dx="-8"' : ''}>${esc(m.label)} ${esc(ms(m.at))}</text>`;
    });
  const lg = `${legend(PHASES.map((p) => ({ cls: p.cls, label: p.label })))}<div class="legend"><span class="lg"><i class="dot p1b"></i>first-party</span><span class="lg"><i class="dot p3b"></i>third-party (3P)</span><span class="lg"><b class="seqglyph">↳</b> sequential: started only after another first-party call ended</span><span class="lg"><i class="sw notiming-sw"></i>no timing breakdown</span></div>`;
  return `${lg}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">${g}</svg>`;
}

function gauge(score: number | null, label: string, budget?: [number, number]): string {
  const st = score == null ? null : budget ? statusOf(score, budget, true) : score >= 90 ? 'ok' : score >= 50 ? 'warn' : 'fail';
  const R = 26;
  const C = 2 * Math.PI * R;
  const frac = score == null ? 0 : Math.max(0, Math.min(1, score / 100));
  return `<div class="gauge"><svg viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${esc(label)} ${score ?? 'not collected'}"><circle class="g-bg" cx="32" cy="32" r="${R}"/>${
    score == null ? '' : `<circle class="g-arc g-${st}" cx="32" cy="32" r="${R}" stroke-dasharray="${(frac * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 32 32)"/>`
  }<text class="g-num" x="32" y="37" text-anchor="middle">${score ?? 'n/c'}</text></svg><div class="g-label">${st ? `<span class="ic ic-${st}">${ICON[st]}</span> ` : ''}${esc(label)}</div></div>`;
}

// ------------------------------------------------------------------------------------------------ sections
function sectionHeader(m: ReportModel): string {
  const meta = m.meta;
  const date = new Date(meta.generatedAt);
  const ist = date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const rows: [string, string][] = [
    ['Site', `${esc(meta.site)} · <code>${esc(meta.baseUrl)}</code>`],
    ['Generated', `${esc(ist)} IST <span class="muted">(${esc(meta.generatedAt)})</span>`],
    ['Test location', esc(meta.testLocation)],
    ['Browser', `${esc(meta.browserVersion)} · headless · Playwright ${esc(meta.playwrightVersion)}`],
    ['Runs', `${meta.runsPerProfile} measured run(s) per workflow per profile, after one separate warm-up run (firstVisit)`],
    ['Machine', esc(String(meta.os || ''))],
  ];
  return `<header class="hero"><div class="eyebrow">Pi Labs · QA performance audit</div><h1>${esc(meta.site)}: workflow speed, API behaviour and page-load performance</h1>
  <dl class="meta">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
  <div class="profiles">${meta.profiles.map((p) => `<div class="profile"><b>${esc(p.name)}</b><span>${esc(p.label)}</span><span class="muted ua">${esc(p.userAgent)}</span></div>`).join('')}</div>
  <p class="method"><b>Method.</b> A signed-in Chromium, driven by Playwright with one worker, walks three real user workflows on the production site and stops before anything would be published.
  Every step is wrapped in a timer that anchors on the actual in-page <code>pointerdown</code>/<code>keydown</code> and records: time to the first DOM change, the Event Timing breakdown, the first and last first-party request,
  the moment the expected UI is on screen (checked once per animation frame inside the page), network idle, long tasks and layout shift. Every request in the step window is captured with its timing phases, headers, redacted payload and response preview.
  Entry pages are also loaded cold, warm and reloaded to collect Navigation Timing and Web Vitals, and audited with Lighthouse. Everything runs twice: unthrottled desktop, and a mobile profile with slow-4G network and 4× CPU slowdown.
  Values are medians over the measured runs and are coloured against <code>perf-budgets.json</code>. Nothing in this report is estimated: where a value could not be measured it says “not collected” and why.</p></header>`;
}

function sectionScorecard(m: ReportModel): string {
  const homeLcp = (profile: string) => m.pageLoads.find((p) => p.page === 'Home Feed' && p.profile === profile && p.mode === 'cold');
  const lhFor = (profile: string) => m.lighthouse.find((l) => l.key === 'home' && l.formFactor === (profile === 'desktop' ? 'desktop' : 'mobile'));
  const rows = m.workflows
    .map((w) => {
      const passSt: Status = w.passRate === 1 ? 'ok' : w.passRate && w.passRate > 0 ? 'warn' : 'fail';
      const slowStep = w.slowestStep ? w.steps.find((s) => s.index === w.slowestStep!.index) : null;
      const slowApi = w.slowestApi ? w.steps.find((s) => s.index === w.slowestApi!.step)?.api.find((a) => a.path === w.slowestApi!.path && a.method === w.slowestApi!.method) : null;
      const lcp = homeLcp(w.profile);
      const lh = lhFor(w.profile);
      const lhSt = lh?.scores?.performance != null ? statusOf(lh.scores.performance, m.budgets.lighthousePerf, true) : null;
      return `<tr><th scope="row"><a href="#${w.id}-${w.profile}">${esc(w.id)} · ${esc(w.name)}</a></th><td>${esc(pl(w.profile))}</td>
      <td class="num st-${passSt}"><span class="ic">${ICON[passSt]}</span> ${w.runsPassed}/${w.runsTotal}</td>
      ${w.totalMs ? `<td class="num" title="${esc(statTitle(w.totalMs, ' ms'))}">${ms(w.totalMs.median)}${w.totalMs.unstable ? ' <span class="unst">~</span>' : ''}</td>` : `<td class="num">${ncShort('no passing run')}</td>`}
      ${slowStep?.clickToUiReadyMs ? `<td class="st-${slowStep.clickToUiReadyMs.status || ''}">${slowStep.clickToUiReadyMs.status ? `<span class="ic">${ICON[slowStep.clickToUiReadyMs.status]}</span> ` : ''}<b>${ms(slowStep.clickToUiReadyMs.median)}</b> <span class="muted">step ${slowStep.index}: ${esc(slowStep.name)}</span></td>` : `<td>${ncShort('no timed step')}</td>`}
      ${slowApi?.durationMs ? `<td class="st-${slowApi.durationMs.status || ''}">${slowApi.durationMs.status ? `<span class="ic">${ICON[slowApi.durationMs.status]}</span> ` : ''}<b>${ms(slowApi.durationMs.median)}</b> <span class="muted"><code>${esc(slowApi.method)} ${esc(slowApi.path)}</code></span></td>` : `<td>${ncShort('no first-party API call')}</td>`}
      ${lcp ? td(lcp.stats.lcp, { reason: lcp.notCollected.lcp }) : `<td class="num">${ncShort('page-load test did not run')}</td>`}
      ${lh?.scores?.performance != null ? tdVal(lh.scores.performance, lhSt, String(lh.scores.performance)) : `<td class="num">${ncShort(lh?.reason || 'Lighthouse did not run')}</td>`}</tr>`;
    })
    .join('');
  return `<section id="scorecard"><h2>2. Scorecard</h2>
  <p class="lead">One row per workflow and profile. End-to-end time is the entry page becoming usable plus each step's click-to-UI-ready time (harness waits and typing time are excluded).</p>
  <div class="tablewrap"><table><thead><tr><th>Workflow</th><th>Profile</th><th class="num">Pass rate</th><th class="num">End-to-end (median)</th><th>Slowest step</th><th>Slowest API</th><th class="num">Entry-page LCP (cold)</th><th class="num">Lighthouse perf</th></tr></thead><tbody>${rows || `<tr><td colspan="8">${nc('no workflow results in results/raw')}</td></tr>`}</tbody></table></div>
  <p class="keyline">${chip('ok', 'within budget')} ${chip('warn', 'over warn budget')} ${chip('fail', 'over fail budget')} <span class="muted"><span class="unst">~</span> unstable (CoV &gt; 30%) · hover any number for median / max / min / CoV / n</span></p></section>`;
}

function sectionIssues(m: ReportModel): string {
  const fails = m.flags.filter((f) => f.severity === 'fail').length;
  const warns = m.flags.length - fails;
  const rows = m.flags
    .map(
      (f) => `<tr><td>${chip(f.severity)}</td><td>${esc(f.workflow)}</td><td>${esc(pl(f.profile))}</td><td>${esc(f.step)}</td><td><code>${esc(f.metric)}</code></td>
      <td class="num">${typeof f.value === 'number' ? num(f.value, f.metric === 'cls' ? 4 : 1) : esc(f.value)}</td><td class="num muted">${f.budget ? `${f.budget[0]} / ${f.budget[1]}` : ''}</td><td>${esc(f.message)}</td></tr>`,
    )
    .join('');
  const findings = m.findings.length
    ? `<h3>Where the site differs from the workflow spec</h3><ul class="findings">${m.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : `<h3>Where the site differs from the workflow spec</h3><p class="muted">No differences were recorded.</p>`;
  return `<section id="issues"><h2>3. Top issues</h2>
  <p class="lead">${fails} over the fail budget, ${warns} over the warn budget. Fails first, then by how far over budget the median is.</p>
  ${m.flags.length ? `<div class="tablewrap"><table class="compact"><thead><tr><th>Severity</th><th>Scope</th><th>Profile</th><th>Step / page</th><th>Metric</th><th class="num">Median</th><th class="num">Budget warn / fail</th><th>What</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p>Nothing is over budget.</p>`}
  ${findings}</section>`;
}

const BYTE_SERIES = [
  { key: 'doc', label: 'document', cls: 's1' },
  { key: 'js', label: 'JavaScript', cls: 's2' },
  { key: 'css', label: 'CSS', cls: 's3' },
  { key: 'img', label: 'images', cls: 's4' },
  { key: 'font', label: 'fonts', cls: 's5' },
  { key: 'xhr', label: 'XHR / fetch', cls: 's6' },
  { key: 'other', label: 'other', cls: 's7' },
];

function apiDetails(a: ApiAgg): string {
  const t = a.timing;
  const flags = a.flags.map((f) => `<span class="flag flag-${esc(f)}">${esc(f)}</span>`).join(' ');
  const row = (k: string, v: string) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  return `<details class="api"><summary><span class="mth">${esc(a.method)}</span> <code>${esc(a.path)}</code> <span class="muted">${a.firstParty ? '' : esc(a.host) + ' · third-party · '}${a.status ?? 'no status'}</span>
  <span class="dur ${a.durationMs?.status ? 'st-' + a.durationMs.status : ''}">${a.durationMs ? `${a.durationMs.status ? ICON[a.durationMs.status] + ' ' : ''}${ms(a.durationMs.median)}` : 'no timing'}</span> ${flags}</summary>
  <table class="kv">
  ${row('URL', `<code class="wrap">${esc(a.url)}</code>`)}
  ${row('Status', `${a.statuses.length ? a.statuses.join(', ') : 'none (request did not complete)'} · ${esc(a.resourceType)} · ${a.firstParty ? 'first-party' : 'third-party'}${a.polling ? ' · background polling' : ''} · ${a.callsPerRun} call(s) per run, seen in ${a.runsSeen} run(s)`)}
  ${row('Start offset', a.startOffsetMs != null ? `${ms(a.startOffsetMs)} after the step's interaction` : nc('request not tied to an interaction'))}
  ${row('Duration', a.durationMs ? `median ${ms(a.durationMs.median)} · ${a.durationMs.p95Kind} ${ms(a.durationMs.p95)} · min ${ms(a.durationMs.min)} · n=${a.durationMs.n}${a.durationMs.cov != null ? ` · CoV ${(a.durationMs.cov * 100).toFixed(0)}%` : ''}` : nc(a.timingNote))}
  ${row('Timing breakdown', t ? `queued ${t.blocked} ms · DNS ${t.dns} ms · connect ${t.connect} ms · TLS ${t.ssl} ms · <b>wait (TTFB) ${t.wait} ms</b> · download ${t.download} ms${a.timingNote ? ` <span class="muted">(${esc(a.timingNote)})</span>` : ''}` : nc(a.timingNote))}
  ${row('Server-Timing', a.serverTiming ? `<code class="wrap">${esc(a.serverTiming)}</code>` : nc('the server sends no Server-Timing header on this response'))}
  ${row('Size', `request ${a.requestBytes != null ? kb(a.requestBytes) : 'n/c'} · response on the wire ${a.responseBytes != null ? kb(a.responseBytes) : 'n/c'}${a.bodyBytes != null ? ` · decoded body ${kb(a.bodyBytes)}` : ''}`)}
  ${row('Response headers', `content-type <code>${esc(a.contentType || 'none')}</code> · content-encoding <code>${esc(a.encoding || 'none')}</code> · cache-control <code>${esc(a.cacheControl || 'none')}</code> · etag <code>${esc(a.etag || 'none')}</code> · age <code>${esc(a.age || 'none')}</code> · x-cache <code>${esc(a.xCache || 'none')}</code>`)}
  ${row('Request headers', Object.keys(a.requestHeaders).length ? Object.entries(a.requestHeaders).map(([k, v]) => `${esc(k)} <code>${esc(v)}</code>`).join(' · ') : '<span class="muted">none of content-type / accept / x-requested-with sent</span>')}
  ${row('Payload (redacted)', a.payload ? `<pre>${esc(a.payload)}${a.payloadTruncated ? '\n… truncated at 4 KB' : ''}</pre>` : '<span class="muted">no request body</span>')}
  ${row('Response preview (redacted)', a.responsePreview ? `<pre>${esc(a.responsePreview)}${a.responsePreviewTruncated ? '\n… truncated at 2 KB' : ''}</pre>` : `<span class="muted">${a.firstParty ? 'no JSON/text body captured' : 'not captured for third-party requests'}</span>`)}
  ${a.sequentialAfter ? row('Waterfall', `started only after <code>${esc(a.sequentialAfter)}</code>`) : ''}
  ${a.failureText ? row('Failure', esc(a.failureText)) : ''}
  </table></details>`;
}

function sectionPageLoad(m: ReportModel): string {
  if (!m.pageLoads.length) return `<section id="pageload"><h2>4. Page load</h2><p>${nc('no page-load results in results/raw (run npm run test:perf)')}</p></section>`;
  const pages = [...new Set(m.pageLoads.map((p) => p.page))];
  const blocks = pages
    .map((page) => {
      const rows = m.pageLoads.filter((p) => p.page === page);
      const tr = rows
        .map(
          (p) => `<tr><th scope="row">${esc(pl(p.profile))}</th><td>${esc(p.mode)}</td>${td(p.stats.ttfb, { reason: p.notCollected.ttfb })}${td(p.stats.fcp, { reason: p.notCollected.fcp })}${td(p.stats.lcp, { reason: p.notCollected.lcp })}${td(p.stats.cls, { unit: 'cls', reason: p.notCollected.cls })}${td(p.stats.tbt, { reason: p.notCollected.tbt })}${td(p.stats.dcl)}${td(p.stats.load, { reason: p.notCollected.load })}${td(p.stats.uiReady)}
          <td class="num">${p.median.requests ?? ''} <span class="muted">(${p.median.cachedRequests ?? 0} cached)</span></td>${td(p.stats.pageWeightKb, { unit: 'kb' })}${td(p.stats.jsTransferKb, { unit: 'kb' })}<td class="num">${p.okRuns}/${p.totalRuns}</td></tr>`,
        )
        .join('');
      const detail = rows
        .filter((p) => p.mode === 'cold')
        .map((p) => {
          const b = p.lcpBreakdown as Record<string, number | null> | null;
          return `<div class="lcpbox"><b>${esc(pl(p.profile))} · cold</b>
          <div>LCP element: ${p.median.lcpElement ? `<code class="wrap">${esc(p.median.lcpElement)}</code>` : nc(p.notCollected.lcpElement || p.notCollected.lcp)}</div>
          <div>LCP resource: ${p.median.lcpResource ? `<code class="wrap">${esc(p.median.lcpResource)}</code>` : nc(p.notCollected.lcpResource || 'no resource')}</div>
          ${b ? `<div class="muted">LCP breakdown: TTFB ${ms(b.timeToFirstByte)} → resource load delay ${ms(b.resourceLoadDelay)} → resource load ${ms(b.resourceLoadDuration)} → element render delay ${ms(b.elementRenderDelay)}</div>` : ''}
          <div class="muted">Connection: DNS ${ms(p.median.dns)} · TCP ${ms(p.median.tcp)} · TLS ${ms(p.median.tls)} · response end ${ms(p.median.responseEnd)} · protocol ${esc(p.doc.protocol || 'n/c')} · redirects ${p.median.redirectCount ?? 0}${p.redirectChain.length ? ` (${esc(p.redirectChain.join(' → '))})` : ''}</div>
          <div class="muted">Document: content-encoding <code>${esc(p.doc.encoding || 'none')}</code> · cache-control <code>${esc(p.doc.cacheControl || 'none')}</code> · Server-Timing ${p.doc.serverTiming ? `<code>${esc(p.doc.serverTiming)}</code>` : 'not sent'}</div>
          <div class="muted">Main thread: ${p.median.longTasks ?? 0} long task(s); TBT to settle ${ms(p.median.tbtToSettle) || '0 ms'}; long animation frames ${p.median.loafCount ?? ncShort(p.notCollected.loaf)} (blocking ${ms(p.median.loafBlockingMs) || '0 ms'}) · INP: ${ncShort(p.notCollected.inp)}</div>
          <div class="muted">Top layout shifts: ${p.topShifts.length ? p.topShifts.slice(0, 3).map((s) => `<code>${esc(s.element.slice(0, 90))}</code> ${s.value}`).join(' · ') : 'none recorded'}</div>
          <div class="muted">Requests: ${p.median.firstPartyRequests ?? 0} first-party (${kb(p.median.bytes.firstParty)}), ${p.median.thirdPartyRequests ?? 0} third-party (${kb(p.median.bytes.thirdParty)})${p.thirdPartyHosts.length ? ': ' + p.thirdPartyHosts.slice(0, 6).map((h) => `${esc(h.host)} ${kb(h.bytes)}`).join(', ') : ''}</div>
          ${p.apiCalls.length ? `<details><summary>API calls during the cold load (${p.apiCalls.length})</summary>${p.apiCalls.map(apiDetails).join('')}</details>` : ''}
          ${p.screenshot ? shot(m, p.screenshot, `${page} · ${pl(p.profile)} · cold load`) : ''}</div>`;
        })
        .join('');
      return `<h3>${esc(page)} <code class="muted">${esc(rows[0].url)}</code></h3>
      <div class="tablewrap"><table class="compact"><thead><tr><th>Profile</th><th>Mode</th><th class="num">TTFB</th><th class="num">FCP</th><th class="num">LCP</th><th class="num">CLS</th><th class="num">TBT</th><th class="num">DCL</th><th class="num">Load</th><th class="num">Usable</th><th class="num">Requests</th><th class="num">Transferred</th><th class="num">JS</th><th class="num">OK runs</th></tr></thead><tbody>${tr}</tbody></table></div>
      <div class="lcpgrid">${detail}</div>`;
    })
    .join('');
  const cold = m.pageLoads.filter((p) => p.mode === 'cold');
  const chart = stackedBars(
    // plotted in KB so the axis lands on round numbers
    cold.map((p) => ({ label: p.page, sub: pl(p.profile), segs: BYTE_SERIES.map((s) => ({ key: s.key, value: p.median.bytes[s.key as 'doc'] / 1024 })), endLabel: kb(p.median.bytes.total) })),
    BYTE_SERIES,
    (v) => `${num(v, v < 10 ? 1 : 0)} KB`,
    'Bytes transferred by resource type on a cold load, per page and profile',
  );
  const bytesTable = `<details><summary>Bytes by type as a table</summary><div class="tablewrap"><table class="compact"><thead><tr><th>Page</th><th>Profile</th>${BYTE_SERIES.map((s) => `<th class="num">${s.label}</th>`).join('')}<th class="num">Third-party</th><th class="num">Total</th></tr></thead><tbody>${cold
    .map((p) => `<tr><th scope="row">${esc(p.page)}</th><td>${esc(pl(p.profile))}</td>${BYTE_SERIES.map((s) => `<td class="num">${kb(p.median.bytes[s.key as 'doc'])}</td>`).join('')}<td class="num">${kb(p.median.bytes.thirdParty)}</td><td class="num">${kb(p.median.bytes.total)}</td></tr>`)
    .join('')}</tbody></table></div></details>`;
  return `<section id="pageload"><h2>4. Page load</h2>
  <p class="lead">Each page in three modes: <b>cold</b> (new context, cache disabled), <b>warm</b> (second navigation, cache primed) and <b>reload</b> (refresh of the loaded page). “Usable” is when the page's key element is visible. Weight budgets apply to cold loads only.</p>
  ${blocks}
  <h3>Bytes transferred by type (cold load, median)</h3><div class="figure">${chart}${bytesTable}</div></section>`;
}

function shot(m: ReportModel, rel: string, caption: string): string {
  const file = path.join(m.reportsDir, rel);
  if (!fs.existsSync(file)) return `<span class="muted">screenshot missing: ${esc(rel)}</span>`;
  const src = m.embedScreenshots ? `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}` : esc(rel);
  return `<figure class="shot"><img src="${src}" alt="${esc(caption)}" loading="lazy" data-zoom><figcaption>${esc(caption)}</figcaption></figure>`;
}

function stepDetails(m: ReportModel, w: WorkflowAgg, s: StepAgg): string {
  const facts: string[] = [];
  const fact = (k: string, v: string) => facts.push(`<tr><th scope="row">${k}</th><td>${v}</td></tr>`);
  const st = (x: Stat | null, reason?: string) => (x ? `<b>${ms(x.median)}</b> <span class="muted">(${x.p95Kind} ${ms(x.p95)}, min ${ms(x.min)}, n=${x.n}${x.cov != null ? `, CoV ${(x.cov * 100).toFixed(0)}%` : ''})</span>` : nc(reason));
  fact('Outcome', `${s.status === 'passed' ? chip('ok', 'passed') : s.status === 'failed' ? chip('fail', 'failed') : '<span class="chip chip-skip">⊘ skipped: irreversible</span>'} in ${s.runsMeasured + s.runsFailed} run(s)${s.runsFailed ? `, ${s.runsFailed} failed` : ''}`);
  for (const e of s.errors) fact(`Error (run ${e.runIndex})`, `<pre>${esc(e.error)}</pre>`);
  fact('Timing anchor', esc(s.anchor));
  if (s.status !== 'skipped: irreversible') {
    fact('First visual feedback', `${st(s.clickToFeedbackMs, s.notCollected.clickToFeedbackMs)}${s.feedbackTarget ? ` on <code class="wrap">${esc(s.feedbackTarget)}</code> <span class="muted">(${esc(s.feedbackKind || '')})</span>` : ''}${s.clickToAnyMutationMs && s.clickToFeedbackMs && s.clickToAnyMutationMs.median < s.clickToFeedbackMs.median - 1 ? ` <span class="muted">· first DOM mutation of any kind: ${ms(s.clickToAnyMutationMs.median)} (a self-updating element such as a ticker, ignored)</span>` : ''}`);
    fact('Event Timing', s.eventTiming ? `input delay ${ms(s.eventTiming.inputDelay)} · processing ${ms(s.eventTiming.processing)} · presentation ${ms(s.eventTiming.presentation)} · <b>duration ${ms(s.eventTiming.duration)}</b> ${chip(s.eventTiming.durationStat?.status)}` : nc(s.notCollected.eventTiming));
    fact('First first-party request', st(s.clickToFirstRequestMs, s.notCollected.clickToFirstRequestMs));
    fact('Last API response', st(s.clickToApiDoneMs, s.notCollected.clickToApiDoneMs));
    fact('Expected UI ready', `${st(s.clickToUiReadyMs, s.notCollected.clickToUiReadyMs)} ${chip(s.clickToUiReadyMs?.status)}${s.uiConditions.length ? `<ul class="tight">${s.uiConditions.map((u) => `<li>${esc(u.description)}: ${u.ms != null ? ms(u.ms) : 'not reached'}</li>`).join('')}</ul>` : ''}`);
    fact('Network idle', st(s.clickToNetworkIdleMs, s.notCollected.clickToNetworkIdleMs));
    fact('Main thread', `long tasks ${st(s.longTasksMs, s.notCollected.longTasksMs)} · long-animation-frame blocking ${s.loafBlockingMs ? ms(s.loafBlockingMs.median) : 'n/c'}`);
    fact('Layout shift', s.cls ? `CLS <b>${num(s.cls.median, 4)}</b> ${chip(s.cls.status)} <span class="muted">· including shifts within 500 ms of the input: ${s.layoutShiftAll ? num(s.layoutShiftAll.median, 4) : 'n/c'}</span>` : nc(s.notCollected.cls));
  }
  if (s.navigation) fact('Navigation', `${esc(s.navigation.type)} navigation${s.navigation.softNavEntry ? ' (Chrome emitted a soft-navigation entry)' : ''}${s.navigation.lcpMs ? ` · soft-navigation LCP ${ms(s.navigation.lcpMs.median)}` : ''}<div class="muted">${esc(s.navigation.note)}</div>`);
  if (s.typing) fact('Typing', `${s.typing.keystrokes} keystrokes over ${ms(s.typing.typingMs)} (harness pacing)${s.typing.uiReadyAfterKeystroke != null ? ` · expected UI appeared after keystroke ${s.typing.uiReadyAfterKeystroke}` : ''}${s.typing.firstKeyToUiReadyMs != null ? ` · first key → UI ready ${ms(s.typing.firstKeyToUiReadyMs)}` : ''}`);
  const ex = s.extra as Record<string, unknown>;
  if (ex && typeof ex.searchCalls === 'number') {
    const calls = (ex.calls as { q: string | null; afterKeystroke: number; msAfterThatKeystroke: number | null; durationMs: number | null }[]) || [];
    fact(
      'Search debounce',
      `<b>${ex.searchCalls}</b> call(s) to <code>/api/v1/search</code> for ${ex.keystrokes} keystrokes typed ${ex.keyDelayMs} ms apart (${ex.callsPerKeystroke} per keystroke) → ${ex.debounced ? 'debounced' : 'NOT debounced: one call per keystroke'}.
      Last keystroke → request sent: <b>${ms(ex.lastKeystrokeToSearchRequestMs as number)}</b> · → response: <b>${ms(ex.lastKeystrokeToSearchResponseMs as number)}</b> · → suggestions visible: <b>${s.clickToUiReadyMs ? ms(s.clickToUiReadyMs.median) : 'n/c'}</b>
      <ul class="tight">${calls.map((c) => `<li>q=<code>${esc(c.q)}</code> sent ${c.msAfterThatKeystroke} ms after keystroke ${c.afterKeystroke}, took ${ms(c.durationMs)}</li>`).join('')}</ul>`,
    );
  }
  if (ex && ex.mobileOnly) fact('Note', esc(String(ex.note)));
  if (ex && ex.specPlaceholderLocatorMatches === false) fact('Locator note', `spec placeholder locator no longer matches after the club is chosen; same DOM node as before: ${esc(String(ex.sameTextareaNodeAsSpecLocator))}`);
  for (const [k, v] of Object.entries(s.milestones)) fact(`Milestone: ${esc(k)}`, st(v, 'not reached'));
  if (s.parts.length > 1) fact('Sub-interactions', s.parts.map((p, i) => `#${i + 1} at ${ms(p.at ?? 0)} → feedback ${p.feedbackMs != null ? ms(p.feedbackMs) : 'n/c'}`).join(' · '));
  if (s.expectApi) fact('Expected API', `<code>${esc(s.expectApi.pattern)}</code> fired in ${s.expectApi.matchedRuns}/${s.expectApi.runs} run(s)`);
  if (s.firstVisit) fact('First visit (warm-up run)', `UI ready ${s.firstVisit.clickToUiReadyMs != null ? ms(s.firstVisit.clickToUiReadyMs) : 'n/c'} · feedback ${s.firstVisit.clickToFeedbackMs != null ? ms(s.firstVisit.clickToFeedbackMs) : 'n/c'} · API done ${s.firstVisit.clickToApiDoneMs != null ? ms(s.firstVisit.clickToApiDoneMs) : 'n/c'}`);
  if (s.console.length) fact('Console', `<ul class="tight">${s.console.map((c) => `<li><span class="flag">${esc(c.type)}</span> ${esc(c.text.slice(0, 300))} ×${c.count}</li>`).join('')}</ul>`);
  if (s.staticResources.length) fact('Static resources', s.staticResources.map((r) => `${r.bucket}: ${r.requestsPerRun} req, ${kb(r.bytesPerRun)}, slowest ${ms(r.slowestMs)}`).join(' · '));

  const marks = [
    { label: 'feedback', at: s.clickToFeedbackMs?.median ?? null, cls: 'mark-fb' },
    { label: 'UI ready', at: s.clickToUiReadyMs?.median ?? null, cls: 'mark-ui' },
  ];
  const net =
    s.status === 'skipped: irreversible'
      ? `<p class="muted">Not measured: the click was deliberately not performed (${esc(s.notCollected.clickToUiReadyMs || 'irreversible')}). Everything up to it was verified.</p>`
      : s.action === 'wait'
        ? `<p class="muted">This step has no interaction of its own; its requests are listed under the step that triggered them.</p>`
        : `<h5>Network waterfall <span class="muted">(run ${w.representativeRun}, the median run; offsets from the interaction)</span></h5>${waterfall(s.waterfall, marks, `Network waterfall for step ${s.index}`)}
           <h5>API calls (${s.api.length})</h5>${s.api.length ? s.api.map(apiDetails).join('') : '<p class="muted">No XHR/fetch/document request in this step.</p>'}`;
  return `<details class="step" id="${w.id}-${w.profile}-step${s.index}"><summary><span class="stepno">${s.index}</span> ${esc(s.name)} <span class="muted">${s.clickToUiReadyMs ? '· UI ready ' + ms(s.clickToUiReadyMs.median) : s.status === 'skipped: irreversible' ? '· skipped: irreversible' : ''}</span> ${s.status === 'failed' ? chip('fail', 'failed') : s.budgetStatus ? chip(s.budgetStatus, s.budgetStatus === 'ok' ? 'within budget' : `over ${WORD[s.budgetStatus]} budget`) : ''}</summary>
  <div class="stepbody"><div class="stepgrid"><table class="kv">${facts.join('')}</table>${s.screenshot ? shot(m, s.screenshot, `${w.id} step ${s.index} · ${pl(w.profile)}`) : '<span class="muted">no screenshot</span>'}</div>${net}</div></details>`;
}

const SEG_SERIES = [
  { key: 'feedback', label: 'until first visual feedback', cls: 's1' },
  { key: 'network', label: 'waiting on network (feedback → last API response)', cls: 's2' },
  { key: 'render', label: 'rendering after data (→ expected UI visible)', cls: 's3' },
];

function sectionWorkflows(m: ReportModel): string {
  if (!m.workflows.length) return `<section id="workflows"><h2>5. Per-workflow deep dive</h2><p>${nc('no workflow results in results/raw (run npm run test:perf)')}</p></section>`;
  const ids = [...new Set(m.workflows.map((w) => w.id))];
  const body = ids
    .map((id) => {
      const variants = m.workflows.filter((w) => w.id === id);
      return `<article class="wf" id="${id}"><h3>${esc(id)} · ${esc(variants[0].name)}</h3>${variants
        .map((w) => {
          const rows = w.steps
            .map((s) => {
              const skipped = s.status === 'skipped: irreversible';
              const why = (k: string) => s.notCollected[k];
              return `<tr><td class="num">${s.index}</td><th scope="row"><a href="#${w.id}-${w.profile}-step${s.index}">${esc(s.name)}</a> <span class="muted">${esc(s.action)}${s.isNavigation ? ' · soft nav' : ''}</span></th>
              ${skipped ? `<td class="num skip" colspan="6">skipped: irreversible (not clicked)</td>` : `${td(s.clickToFeedbackMs, { reason: why('clickToFeedbackMs') })}${td(s.clickToFirstRequestMs, { reason: why('clickToFirstRequestMs') })}${td(s.clickToApiDoneMs, { reason: why('clickToApiDoneMs') })}${td(s.clickToUiReadyMs, { reason: why('clickToUiReadyMs') })}${td(s.longTasksMs, { reason: why('longTasksMs') })}${td(s.cls, { unit: 'cls', reason: why('cls') })}`}
              <td>${s.status === 'passed' ? `${chip('ok', 'passed')}${s.budgetStatus && s.budgetStatus !== 'ok' ? ' ' + chip(s.budgetStatus, `over ${WORD[s.budgetStatus]} budget`) : ''}` : s.status === 'failed' ? chip('fail', `failed ${s.runsFailed}×`) : '<span class="chip chip-skip">⊘ skipped</span>'}</td></tr>`;
            })
            .join('');
          const timed = w.steps.filter((s) => s.segments && s.action !== 'wait');
          const chart = timed.length
            ? stackedBars(
                timed.map((s) => ({ label: `${s.index}. ${s.name.length > 34 ? s.name.slice(0, 33) + '…' : s.name}`, segs: SEG_SERIES.map((q) => ({ key: q.key, value: s.segments![q.key as 'feedback'] })), endLabel: ms(s.clickToUiReadyMs!.median) })),
                SEG_SERIES,
                (v) => ms(v),
                `Step durations for ${w.id} on ${w.profile}`,
              )
            : `<p class="muted">${nc('no step reached its expected UI')}</p>`;
          const thumbs = w.steps.filter((s) => s.screenshot).map((s) => shot(m, s.screenshot as string, `step ${s.index}`)).join('');
          const writes = w.writes.length
            ? `<div class="tablewrap"><table class="compact"><thead><tr><th>Method</th><th>URL</th><th class="num">Status</th><th>During</th><th class="num">Times</th><th>Payload (redacted)</th></tr></thead><tbody>${w.writes.map((x) => `<tr><td>${esc(x.method)}</td><td><code class="wrap">${esc(x.url)}</code></td><td class="num">${x.status ?? ''}</td><td>${esc(x.step || 'between steps / page load')}</td><td class="num">${x.count}</td><td><code class="wrap">${esc((x.payload || '').slice(0, 200))}</code></td></tr>`).join('')}</tbody></table></div>`
            : `<p>${chip('ok', 'no first-party write request')} No POST/PUT/PATCH/DELETE was sent to a first-party host in any run of this workflow.</p>`;
          return `<section class="variant" id="${w.id}-${w.profile}"><h4>${esc(pl(w.profile))} <span class="muted">${esc(w.env.profileLabel)}</span></h4>
          <p class="summaryline">Pass rate <b>${w.runsPassed}/${w.runsTotal}</b>${w.measuredFromFirstVisitOnly ? ' <span class="muted">(only the warm-up run exists: RUNS=0)</span>' : ''} · end-to-end ${w.totalMs ? `<b>${ms(w.totalMs.median)}</b> median, ${ms(w.totalMs.p95)} ${w.totalMs.p95Kind}` : nc('no passing run')}
          · entry page usable ${w.entry.readyMs ? ms(w.entry.readyMs.median) : 'n/c'} (TTFB ${w.entry.ttfb ? ms(w.entry.ttfb.median) : 'n/c'}, LCP ${w.entry.lcp ? ms(w.entry.lcp.median) : 'n/c'}; warm cache)
          ${w.firstVisit ? `· first visit (cold cache, separate): ${w.firstVisit.passed ? `${ms(w.firstVisit.totalMs)} end-to-end, entry usable ${ms(w.firstVisit.entryReadyMs)}` : `failed: ${esc((w.firstVisit.error || '').split('\n')[0])}`}` : ''}</p>
          ${w.runs.some((r) => !r.passed) ? `<ul class="findings">${w.runs.filter((r) => !r.passed).map((r) => `<li>${chip('fail', 'run ' + r.runIndex)} ${esc((r.error || '').split('\n')[0])}</li>`).join('')}</ul>` : ''}
          <div class="tablewrap"><table><thead><tr><th class="num">#</th><th>Step</th><th class="num">Feedback</th><th class="num">First request</th><th class="num">API done</th><th class="num">UI ready</th><th class="num">Long tasks</th><th class="num">CLS</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
          <div class="figure"><h5>Where the time goes, per step (median)</h5>${chart}</div>
          <div class="thumbs">${thumbs}</div>
          <h5>Step details</h5>${w.steps.map((s) => stepDetails(m, w, s)).join('')}
          <h5>Safety: cleanup and write audit</h5>
          <ul class="tight">${w.cleanup.length ? w.cleanup.map((c) => `<li>${chip(c.ok ? 'ok' : 'fail', c.ok ? 'done' : 'failed')} ${esc(c.description)}: ${esc(c.detail)} <span class="muted">(${c.runs} run(s))</span></li>`).join('') : '<li class="muted">no cleanup needed (read-only workflow)</li>'}</ul>
          ${writes}</section>`;
        })
        .join('')}</article>`;
    })
    .join('');
  return `<section id="workflows"><h2>5. Per-workflow deep dive</h2>
  <p class="lead">Times are medians, measured from the real in-page interaction. Open a step for its waterfall, every API call, and its screenshot.
  <button type="button" class="btn" data-toggle-all>Expand all steps</button></p>${body}</section>`;
}

function sectionThrottle(m: ReportModel): string {
  const factor = (d: number | null | undefined, mob: number | null | undefined) => (d != null && mob != null && d > 0 ? `×${num(mob / d, 1)}` : '');
  const plRows: string[] = [];
  for (const page of [...new Set(m.pageLoads.map((p) => p.page))]) {
    const d = m.pageLoads.find((p) => p.page === page && p.profile === 'desktop' && p.mode === 'cold');
    const mo = m.pageLoads.find((p) => p.page === page && p.profile === 'mobile-slow4g' && p.mode === 'cold');
    if (!d || !mo) continue;
    for (const [k, label] of [['ttfb', 'TTFB'], ['fcp', 'FCP'], ['lcp', 'LCP'], ['load', 'Load event'], ['uiReady', 'Usable'], ['tbt', 'TBT']] as const) {
      const dv = d.stats[k]?.median;
      const mv = mo.stats[k]?.median;
      plRows.push(`<tr><th scope="row">${esc(page)}</th><td>${label}</td><td class="num">${dv != null ? ms(dv) : 'n/c'}</td><td class="num">${mv != null ? ms(mv) : 'n/c'}</td><td class="num"><b>${factor(dv, mv)}</b></td></tr>`);
    }
  }
  const wfRows: string[] = [];
  for (const id of [...new Set(m.workflows.map((w) => w.id))]) {
    const d = m.workflows.find((w) => w.id === id && w.profile === 'desktop');
    const mo = m.workflows.find((w) => w.id === id && w.profile === 'mobile-slow4g');
    if (!d || !mo) continue;
    wfRows.push(`<tr class="grp"><th scope="row">${esc(id)} end-to-end</th><td>total</td><td class="num">${d.totalMs ? ms(d.totalMs.median) : 'n/c'}</td><td class="num">${mo.totalMs ? ms(mo.totalMs.median) : 'n/c'}</td><td class="num"><b>${factor(d.totalMs?.median, mo.totalMs?.median)}</b></td></tr>`);
    for (const s of d.steps) {
      const ms2 = mo.steps.find((x) => x.index === s.index);
      if (!s.clickToUiReadyMs && !ms2?.clickToUiReadyMs) continue;
      wfRows.push(`<tr><th scope="row">${esc(id)} step ${s.index}: ${esc(s.name)}</th><td>click → UI ready</td><td class="num">${s.clickToUiReadyMs ? ms(s.clickToUiReadyMs.median) : 'n/c'}</td><td class="num">${ms2?.clickToUiReadyMs ? ms(ms2.clickToUiReadyMs.median) : 'n/c'}</td><td class="num"><b>${factor(s.clickToUiReadyMs?.median, ms2?.clickToUiReadyMs?.median)}</b></td></tr>`);
    }
    for (const s of mo.steps.filter((x) => !d.steps.some((y) => y.index === x.index) && x.clickToUiReadyMs)) {
      wfRows.push(`<tr><th scope="row">${esc(id)} step ${s.index}: ${esc(s.name)}</th><td>click → UI ready</td><td class="num muted">step not needed</td><td class="num">${ms(s.clickToUiReadyMs!.median)}</td><td class="num"></td></tr>`);
    }
  }
  const head = `<thead><tr><th>What</th><th>Metric</th><th class="num">Desktop (unthrottled)</th><th class="num">Mobile slow 4G + 4× CPU</th><th class="num">Slowdown</th></tr></thead>`;
  return `<section id="throttle"><h2>6. Throttled vs unthrottled</h2>
  <p class="lead">Same tests, two profiles, medians side by side. The factor is mobile ÷ desktop.</p>
  <h3>Cold page loads</h3>${plRows.length ? `<div class="tablewrap"><table class="compact">${head}<tbody>${plRows.join('')}</tbody></table></div>` : `<p>${nc('needs page-load results for both profiles')}</p>`}
  <h3>Workflow steps</h3>${wfRows.length ? `<div class="tablewrap"><table class="compact">${head}<tbody>${wfRows.join('')}</tbody></table></div>` : `<p>${nc('needs workflow results for both profiles')}</p>`}</section>`;
}

function sectionLighthouse(m: ReportModel): string {
  if (!m.lighthouse.length) return `<section id="lighthouse"><h2>7. Lighthouse</h2><p>${nc('no Lighthouse results in results/raw (run npm run test:lh)')}</p></section>`;
  const b = m.budgets;
  const cards = m.lighthouse
    .map((l) => {
      if (!l.collected) return `<div class="lhcard"><h4>${esc(l.page)} · ${esc(l.formFactor)}</h4><p>${nc(l.reason)}</p></div>`;
      const s = l.scores!;
      const x = l.metrics!;
      const metric = (label: string, v: number | null, budget: [number, number] | undefined, text: string) => `<div class="lhm ${v != null && budget ? 'st-' + statusOf(v, budget) : ''}"><span>${label}</span><b>${v == null ? 'n/c' : `${budget && statusOf(v, budget) ? ICON[statusOf(v, budget) as Status] + ' ' : ''}${text}`}</b></div>`;
      const opp = l.opportunities!.length
        ? `<table class="compact"><thead><tr><th>Opportunity</th><th class="num">Est. time saved</th><th class="num">Est. bytes saved</th></tr></thead><tbody>${l.opportunities!.map((o) => `<tr><td>${esc(o.title)} <code class="muted">${esc(o.id)}</code></td><td class="num">${o.savingsMs ? ms(o.savingsMs) : '—'}</td><td class="num">${o.savingsBytes ? kb(o.savingsBytes) : '—'}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">Lighthouse reported no opportunities with estimated savings.</p>';
      const diag = Object.entries(l.diagnostics || {})
        .map(([k, v]) => {
          if (!v.collected) return `<li><b>${esc(k)}</b>: ${nc(v.reason)}</li>`;
          return `<li><b>${esc(k)}</b>: ${v.audits!.map((a) => `${esc(a.title)}${a.displayValue ? ` — ${esc(a.displayValue)}` : ''}${a.items.length ? `<ul class="tight">${a.items.map((it) => `<li><code class="wrap">${esc(String(it.label ?? '').slice(0, 110))}</code> ${Object.entries(it).filter(([kk]) => kk !== 'label').map(([kk, vv]) => `${esc(kk)} ${/Bytes|Size/.test(kk) ? kb(vv as number) : num(vv as number) + (/(Ms|Time|duration|total|scripting|Compile)/.test(kk) ? ' ms' : '')}`).join(' · ')}</li>`).join('')}</ul>` : ''}`).join('; ')}</li>`;
        })
        .join('');
      return `<div class="lhcard"><h4>${esc(l.page)} · ${esc(l.formFactor)} <span class="muted">${l.signedIn ? 'signed in' : 'sign-in not confirmed'} · median of ${l.runs!.length} run(s): ${l.runs!.map((r) => r.performance ?? 'failed').join(', ')}</span></h4>
      <div class="gauges">${gauge(s.performance, 'Performance', b.lighthousePerf)}${gauge(s.accessibility, 'Accessibility')}${gauge(s.bestPractices, 'Best practices')}${gauge(s.seo, 'SEO')}</div>
      <div class="lhmetrics">${metric('FCP', x.fcp, b.fcpMs, ms(x.fcp))}${metric('LCP', x.lcp, b.lcpMs, ms(x.lcp))}${metric('TBT', x.tbt, b.tbtMs, ms(x.tbt))}${metric('CLS', x.cls, b.cls, num(x.cls ?? 0, 4))}${metric('Speed Index', x.si, undefined, ms(x.si))}</div>
      ${opp}
      <details><summary>Diagnostics: unused JS/CSS, render-blocking, images, third parties, main-thread work</summary><ul class="diag">${diag}</ul><p class="muted">Throttling: ${esc(JSON.stringify(l.throttling))}</p></details>
      <p><a href="${esc(l.reportPath)}">Full Lighthouse report (HTML)</a> · <a href="${esc(l.jsonPath)}">JSON</a></p></div>`;
    })
    .join('');
  const f = m.lighthouseFlow;
  const flow = !f
    ? ''
    : f.collected
      ? `<h3>User flow (timespan): ${esc(f.name)}</h3><div class="tablewrap"><table class="compact"><thead><tr><th>Step</th><th>Mode</th><th class="num">Performance</th><th class="num">TBT</th><th class="num">CLS</th><th class="num">INP</th></tr></thead><tbody>${f.steps!.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.mode)}</td><td class="num">${s.performance ?? 'n/c'}</td><td class="num">${s.tbt != null ? ms(s.tbt) : 'n/c'}</td><td class="num">${s.cls ?? 'n/c'}</td>${tdVal(s.inp, statusOf(s.inp, b.inpMs), ms(s.inp), 'no interaction measured')}</tr>`).join('')}</tbody></table></div><p><a href="${esc(f.reportPath)}">Full flow report (HTML)</a></p>`
      : `<h3>User flow (timespan)</h3><p>${nc(f.reason)}</p>`;
  return `<section id="lighthouse"><h2>7. Lighthouse</h2>
  <p class="lead">Lab audits run inside the signed-in browser context, cache cleared before each run, median-performance run kept. Lighthouse uses its own simulated throttling, so its numbers are not directly comparable with the measured loads in section 4. Screenshots are disabled in these reports because they would show the test account.</p>
  <div class="lhgrid">${cards}</div>${flow}${m.lighthouseNotes.length ? `<ul class="findings">${m.lighthouseNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</section>`;
}

function sectionQuality(m: ReportModel): string {
  const q = m.quality;
  const tbl = (head: string[], rows: string[], empty: string) => (rows.length ? `<div class="tablewrap"><table class="compact"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p>${chip('ok', 'none')} ${empty}</p>`);
  const axeRows = q.axe.map(
    (a) => `<tr><td>${esc(a.workflow)}</td><td>${esc(pl(a.profile))}</td><td>${esc(a.page)}</td>${a.error ? `<td colspan="3">${nc(a.error)}</td>` : `<td class="num ${a.critical ? 'st-fail' : ''}">${a.critical ? ICON.fail + ' ' : ''}${a.critical}</td><td class="num ${a.serious ? 'st-warn' : ''}">${a.serious ? ICON.warn + ' ' : ''}${a.serious}</td><td>${a.topRules.map((r) => `<code>${esc(r.id)}</code> <span class="muted">(${esc(r.impact)}, ${r.nodes} node${r.nodes === 1 ? '' : 's'}: ${esc(r.help)})</span>`).join('<br>')}</td>`}</tr>`,
  );
  return `<section id="quality"><h2>8. Errors and quality</h2>
  <h3>Console errors and warnings</h3>${tbl(['Scope', 'Profile', 'Step / page', 'Type', 'Message', '×'], q.consoleErrors.map((c) => `<tr><td>${esc(c.workflow)}</td><td>${esc(pl(c.profile))}</td><td>${esc(c.step)}</td><td>${esc(c.type)}</td><td><code class="wrap">${esc(c.text)}</code></td><td class="num">${c.count}</td></tr>`), 'No console errors or warnings were logged in any step or page load.')}
  <h3>Uncaught page errors</h3>${tbl(['Scope', 'Profile', 'Step / page', 'Error', '×'], q.pageErrors.map((c) => `<tr><td>${esc(c.workflow)}</td><td>${esc(pl(c.profile))}</td><td>${esc(c.step)}</td><td><code class="wrap">${esc(c.text)}</code></td><td class="num">${c.count}</td></tr>`), 'No uncaught exceptions.')}
  <h3>Failed requests</h3>${tbl(['Scope', 'Profile', 'Step / page', 'Request', 'Failure', '×'], q.failedRequests.map((c) => `<tr><td>${esc(c.workflow)}</td><td>${esc(pl(c.profile))}</td><td>${esc(c.step)}</td><td><code class="wrap">${esc(c.method)} ${esc(c.url)}</code></td><td>${esc(c.failure || '')}</td><td class="num">${c.count}</td></tr>`), 'No request failed at the network level.')}
  <p class="muted">${q.abortedRequests} request(s) were aborted by the page itself (net::ERR_ABORTED, typically a navigation cancelling an in-flight fetch); these are not counted as failures.</p>
  <h3>HTTP 4xx / 5xx responses</h3>${tbl(['Scope', 'Profile', 'Step / page', 'Request', 'Status', '×'], q.httpErrors.map((c) => `<tr><td>${esc(c.workflow)}</td><td>${esc(pl(c.profile))}</td><td>${esc(c.step)}</td><td><code class="wrap">${esc(c.method)} ${esc(c.url)}</code></td><td class="num">${c.status}</td><td class="num">${c.count}</td></tr>`), 'No 4xx or 5xx response.')}
  <h3>Accessibility (axe-core)</h3>${axeRows.length ? `<div class="tablewrap"><table class="compact"><thead><tr><th>Workflow</th><th>Profile</th><th>Page</th><th class="num">Critical</th><th class="num">Serious</th><th>Top rules</th></tr></thead><tbody>${axeRows.join('')}</tbody></table></div>` : `<p>${nc('no axe scan was recorded')}</p>`}
  <h3>Broken images, mixed content, redirects</h3>
  <ul class="tight"><li>Broken images (naturalWidth 0): ${q.brokenImages.length ? q.brokenImages.map((b) => `<code class="wrap">${esc(b.url)}</code> on ${esc(b.page)} (${esc(pl(b.profile))})`).join('; ') : 'none found'}</li>
  <li>Mixed content (http:// resource on an https page): ${q.mixedContent.length ? q.mixedContent.map((b) => `${esc(b.detail)} on ${esc(b.page)}`).join('; ') : 'none found'}</li>
  <li>Redirect chain on entry URLs: ${q.redirectChains.some((r) => r.chain.length) ? q.redirectChains.filter((r) => r.chain.length).map((r) => `${esc(r.page)} (${esc(pl(r.profile))}): ${esc(r.chain.join(' → '))}`).join('; ') : 'no redirects on any entry URL'}</li></ul></section>`;
}

function sectionUnstable(m: ReportModel): string {
  const rows = m.unstable.map((u) => `<tr><td>${esc(u.scope)}</td><td>${esc(pl(u.profile))}</td><td>${esc(u.where)}</td><td><code>${esc(u.metric)}</code></td><td class="num">${num(u.median, 1)}</td><td class="num">${num(u.min, 1)}</td><td class="num">${num(u.max, 1)}</td><td class="num"><b>${(u.cov * 100).toFixed(0)}%</b></td><td class="num">${u.n}</td></tr>`);
  return `<section id="unstable"><h2>9. Unstable metrics</h2>
  <p class="lead">Every metric whose coefficient of variation across runs is above 30% (with at least 3 values, and at least 20 ms between the lowest and highest run, so near-zero values such as 0 / 0 / 7 ms are not listed). Treat their medians as indicative and re-run with a higher <code>RUNS</code> before acting on them.</p>
  ${rows.length ? `<div class="tablewrap"><table class="compact"><thead><tr><th>Scope</th><th>Profile</th><th>Where</th><th>Metric</th><th class="num">Median</th><th class="num">Min</th><th class="num">Max</th><th class="num">CoV</th><th class="num">n</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p>${chip('ok', 'stable')} No metric exceeded 30% CoV across the measured runs.</p>`}</section>`;
}

function sectionMethod(m: ReportModel): string {
  const b = m.budgets;
  const defs: [string, string][] = [
    ['Clocks', 'Epoch milliseconds everywhere. In the page: <code>performance.timeOrigin + performance.now()</code>; node side: <code>Date.now()</code>; Playwright request timing is epoch-based too. The offset between page and node clocks is checked before every step.'],
    ['Step anchor', 'The first trusted <code>pointerdown</code> of the step, read from a capture-phase listener in the page (not the moment Playwright was asked to click). Typing steps: feedback from the first <code>keydown</code>; each later effect from the keystroke that caused it (the latest keydown at or before it).'],
    ['clickToFeedbackMs', 'Anchor → first DOM mutation (MutationObserver on <code>document</code>) that is not on a self-updating element. Elements seen mutating while the page was idle (live tickers), invisible elements and number-only text changes away from the clicked element are ignored; the unfiltered value is kept as <code>clickToAnyMutationMs</code>.'],
    ['eventTiming', 'Event Timing entries (<code>durationThreshold: 16</code>) of the anchoring interaction, combined per frame: input delay, processing, presentation delay, duration. Interactions faster than 16 ms produce no entry.'],
    ['clickToFirstRequestMs / clickToApiDoneMs', 'Anchor → start of the first first-party request / end of the last first-party XHR or fetch (REST calls, <code>*.data</code> route loaders, <code>/__manifest</code>) started in the step window. Background polling is excluded.'],
    ['clickToUiReadyMs', 'Anchor → the step\'s expected UI is on screen. Checked inside the page once per animation frame, so precision is one frame. The spec\'s Playwright locators are asserted separately and are not part of the timing.'],
    ['clickToNetworkIdleMs', 'Anchor → end of the last first-party request, confirmed by 500 ms with nothing in flight.'],
    ['longTasksMs / cls', 'Sum of long-task time overlapping the step window; sum of layout-shift values without recent input (the CLS definition). Shifts within 500 ms of the input are reported separately.'],
    ['Soft navigations', 'All workflow steps are client-side route changes: there is no document request, so TTFB and FCP do not exist for them. The page-transition time is click → expected UI. Where Chrome emitted a soft-navigation entry, its LCP is shown as extra information.'],
    ['Page load', 'Navigation Timing L2 for DNS/TCP/TLS/TTFB/response end/DCL/load; web-vitals (attribution build) for FCP, LCP + element, CLS; TBT = long-task time beyond 50 ms between FCP and the load event. Bytes are on-the-wire sizes per request from the browser.'],
    ['API flags', '<code>slow</code> over the API budget · <code>http_error</code> 4xx/5xx · <code>failed</code> · <code>duplicate</code> same method+URL+body twice in a step · <code>sequential</code> started only after another first-party call ended · <code>uncompressed</code> text over 1 KB without content-encoding · <code>large</code> over 100 KB · <code>no_cache_headers</code> static GET without cache-control · <code>polling</code> the unread-count endpoints · <code>write</code> non-GET to a first-party host.'],
    ['Statistics', `Median, 95th percentile (the maximum when there are fewer than 5 runs), minimum and coefficient of variation over ${m.meta.runsPerProfile} measured run(s). The warm-up run is reported separately as “first visit”. Measured runs reuse the browser cache of the warm-up, like a returning visitor.`],
  ];
  const caveats = [
    `<b>Test location: ${esc(m.meta.testLocation)}.</b> The site's users are in India; numbers from a distant runner (for example a US-hosted CI machine) inflate TTFB and every API round-trip. Compare runs only from the same location.`,
    'The mobile profile uses Chrome DevTools emulation: latency is a floor on time-to-headers per request (150 ms), not an added round-trip on connection setup, and CPU slowdown is a 4× throttle of this machine, not a real phone. It shows sensitivity to slow conditions rather than predicting a specific device.',
    'Stop points: “Submit” (wf1) and the comment submit button (wf2) are verified visible and enabled but never clicked, so the publish and comment API calls are not measured. Typed text is cleared afterwards. Vote, Follow and bookmark are never touched.',
    'Redaction: values of keys matching <code>pass(word)|token|secret|auth|session|cookie|api-key|card|cvv|cvc|ssn|otp</code>, the Authorization / Cookie / Set-Cookie headers, JWTs, every cookie value of the saved session and the test account\'s name and id are replaced before anything is written. Because the key rule is broad, harmless fields such as <code>author</code> also show as [REDACTED]. The build fails if a known secret is found in any report or result file.',
    'Screenshots mask the composer and any element showing the account name (grey boxes).',
    'The step timer adds no pauses inside a measured window; between steps the page is observed idle for about a second to learn which elements update on their own.',
    'Playwright traces (kept only for failing tests, under <code>test-results/</code> and the built-in report) are raw browser recordings and are not redacted: do not share them.',
  ];
  return `<section id="method"><h2>10. Methodology and caveats</h2>
  <h3>How each metric is measured</h3><dl class="defs">${defs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
  <h3>Budgets (warn / fail)</h3><div class="tablewrap"><table class="compact"><thead><tr><th>Budget</th><th class="num">Warn above</th><th class="num">Fail above</th></tr></thead><tbody>${Object.entries(b).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${k === 'lighthousePerf' ? `below ${v[0]}` : v[0]}</td><td class="num">${k === 'lighthousePerf' ? `below ${v[1]}` : v[1]}</td></tr>`).join('')}</tbody></table></div>
  <h3>Caveats</h3><ul class="caveats">${caveats.map((c) => `<li>${c}</li>`).join('')}</ul>
  <h3>Report self-checks</h3><ul class="tight">${m.sanity.map((s) => `<li>${chip(s.ok ? 'ok' : 'fail', s.ok ? 'pass' : 'FAIL')} ${esc(s.name)} <span class="muted">${esc(s.detail)}</span></li>`).join('')}</ul>
  <h3>Other reports</h3><ul class="tight">${m.playwrightReports.map((r) => `<li>${r.exists ? `<a href="${esc(r.href)}">${esc(r.label)}</a>` : `${esc(r.label)}: ${nc('not generated yet')}`}</li>`).join('')}<li><a href="../results/metrics.json">results/metrics.json</a> (machine-readable, same numbers)</li></ul></section>`;
}

// ------------------------------------------------------------------------------------------------ page
const CSS = String.raw`
:root{color-scheme:light;--bg:#f6f6f4;--surface:#fcfcfb;--surface-2:#f0efec;--line:#e2e1dc;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#807f79;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;
--good:#0ca30c;--warning:#fab219;--critical:#d03b3b;--good-ink:#006300;--warn-ink:#7a5200;--crit-ink:#a32222;--link:#1c5cab}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#121211;--surface:#1a1a19;--surface-2:#262624;--line:#383835;--ink:#f0efec;--ink-2:#c3c2b7;--ink-3:#8f8e86;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c;--s7:#9085e9;--good-ink:#5fd35f;--warn-ink:#fab219;--crit-ink:#f08080;--link:#86b6ef}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#121211;--surface:#1a1a19;--surface-2:#262624;--line:#383835;--ink:#f0efec;--ink-2:#c3c2b7;--ink-3:#8f8e86;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c;--s7:#9085e9;--good-ink:#5fd35f;--warn-ink:#fab219;--crit-ink:#f08080;--link:#86b6ef}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:56px}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--link)}code,pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--surface-2);padding:1px 4px;border-radius:4px}code.wrap{word-break:break-all;white-space:normal}
pre{background:var(--surface-2);padding:8px 10px;border-radius:6px;overflow:auto;max-height:260px;white-space:pre-wrap;word-break:break-all;margin:4px 0}
nav.top{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--line);display:flex;gap:4px;overflow-x:auto;padding:8px 16px;white-space:nowrap}
nav.top a{text-decoration:none;color:var(--ink-2);padding:4px 10px;border-radius:6px;font-size:13px}nav.top a:hover{background:var(--surface-2);color:var(--ink)}
main{max-width:1240px;margin:0 auto;padding:0 16px 80px}
.hero{padding:28px 0 8px}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
h1{font-size:26px;line-height:1.2;margin:6px 0 18px;max-width:900px;text-wrap:balance}
h2{font-size:20px;margin:0 0 6px;padding-top:8px}h3{font-size:16px;margin:26px 0 8px}h4{font-size:15px;margin:20px 0 6px}h5{font-size:13px;margin:18px 0 6px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em}
section{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px 22px;margin:18px 0}
section section.variant{border:0;border-top:1px solid var(--line);border-radius:0;padding:14px 0 0;margin:18px 0 0;background:none}
.lead{color:var(--ink-2);margin:0 0 14px;max-width:920px}.muted{color:var(--ink-3);font-weight:400}.method{color:var(--ink-2);max-width:980px}
dl.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px 24px;margin:0 0 14px}dl.meta div{display:flex;gap:10px}dl.meta dt{color:var(--ink-3);min-width:96px}dl.meta dd{margin:0}
.profiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;margin:0 0 14px}.profile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}.ua{font-size:11px;word-break:break-all}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}thead th{font-size:12px;color:var(--ink-2);font-weight:600;background:var(--surface-2);white-space:nowrap}
tbody tr:last-child>*{border-bottom:0}tbody th{font-weight:600}table.compact th,table.compact td{padding:5px 9px;font-size:13px}
.num{text-align:right;white-space:nowrap}tr.grp>*{background:var(--surface-2)}td.skip{text-align:center;color:var(--ink-3);font-style:italic}
.st-ok{background:color-mix(in srgb,var(--good) 13%,transparent)}.st-warn{background:color-mix(in srgb,var(--warning) 24%,transparent)}.st-fail{background:color-mix(in srgb,var(--critical) 17%,transparent)}
.st-ok .ic,.ic-ok{color:var(--good-ink)}.st-warn .ic,.ic-warn{color:var(--warn-ink)}.st-fail .ic,.ic-fail{color:var(--crit-ink)}.ic{font-weight:700}
.chip{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:1px 9px;white-space:nowrap}
.chip-ok{background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good-ink)}.chip-warn{background:color-mix(in srgb,var(--warning) 28%,transparent);color:var(--warn-ink)}.chip-fail{background:color-mix(in srgb,var(--critical) 18%,transparent);color:var(--crit-ink)}.chip-skip{background:var(--surface-2);color:var(--ink-2)}
.unst{color:var(--warn-ink);font-weight:700;cursor:help}.nc{color:var(--ink-3);font-style:italic;border-bottom:1px dotted var(--ink-3);cursor:help}.nc-why{color:var(--ink-3);font-size:12px}
.keyline{margin:10px 0 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.findings{padding-left:18px;max-width:1000px}.findings li{margin:6px 0}.tight{margin:4px 0;padding-left:18px}.tight li{margin:2px 0}.caveats li{margin:6px 0;max-width:1000px}
.figure{margin:8px 0}.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:4px 0 6px;font-size:12px;color:var(--ink-2)}.lg{display:inline-flex;align-items:center;gap:6px}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%}
i.s1{background:var(--s1)}i.s2{background:var(--s2)}i.s3{background:var(--s3)}i.s4{background:var(--s4)}i.s5{background:var(--s5)}i.s6{background:var(--s6)}i.s7{background:var(--s7)}i.ph-blocked{background:var(--line)}
i.notiming-sw{background:none;border:1.5px dashed var(--ink-3)}i.p1b{background:var(--ink-2)}i.p3b{border:2px solid var(--s7)}.seqglyph{color:var(--ink)}
svg.chart{width:100%;height:auto;display:block;max-width:980px}svg .s1{fill:var(--s1)}svg .s2{fill:var(--s2)}svg .s3{fill:var(--s3)}svg .s4{fill:var(--s4)}svg .s5{fill:var(--s5)}svg .s6{fill:var(--s6)}svg .s7{fill:var(--s7)}svg .ph-blocked{fill:var(--line)}
svg .grid{stroke:var(--line);stroke-width:1}svg .axis{stroke:var(--ink-3);stroke-width:1}svg text{fill:var(--ink-2);font-size:11px;font-family:inherit}svg .tick{fill:var(--ink-3)}
svg .rowlabel{fill:var(--ink);font-size:12px}svg .rowsub{fill:var(--ink-3);font-size:10.5px}svg .endlabel{fill:var(--ink);font-size:12px;font-weight:600}
svg .wlabel{fill:var(--ink);font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace}svg .wlabel.seq{font-weight:700}svg .wend{fill:var(--ink-2);font-size:10.5px}
svg .p1{fill:var(--ink-2)}svg .p3{fill:none;stroke:var(--s7);stroke-width:2}svg .seqmark{fill:var(--ink)}svg .notiming{fill:none;stroke:var(--ink-3);stroke-dasharray:3 2}
svg .mark-fb{stroke:var(--ink-3);stroke-width:1.5}svg .mark-ui{stroke:var(--ink);stroke-width:1.5}svg .marklabel{fill:var(--ink);font-size:10.5px;font-weight:600}
details{border:1px solid var(--line);border-radius:8px;margin:6px 0;background:var(--surface)}summary{cursor:pointer;padding:8px 12px;list-style-position:inside}details[open]>summary{border-bottom:1px solid var(--line)}
details>*:not(summary){margin-left:12px;margin-right:12px}details.step>summary{font-weight:600}details.api>summary{font-weight:400;font-size:13px}.stepbody{padding:6px 0 12px}
.stepno{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:50%;background:var(--surface-2);font-size:12px;margin-right:4px}
.stepgrid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start}@media(max-width:900px){.stepgrid{grid-template-columns:1fr}}
table.kv{width:100%}table.kv th{width:180px;color:var(--ink-2);font-weight:600;font-size:13px}table.kv td{font-size:13px}
.mth{font-weight:700;font-size:12px}.dur{float:right;font-variant-numeric:tabular-nums;border-radius:6px;padding:0 8px;font-weight:600}
.flag{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--ink-2);background:var(--surface-2)}.flag-slow,.flag-http_error,.flag-failed{border-color:var(--critical);color:var(--crit-ink)}.flag-sequential,.flag-duplicate,.flag-uncompressed,.flag-large,.flag-no_cache_headers{border-color:var(--warning);color:var(--warn-ink)}
.thumbs{display:flex;gap:10px;overflow-x:auto;padding:6px 0}.shot{margin:0;flex:0 0 auto}.shot img{display:block;max-width:100%;max-height:190px;border:1px solid var(--line);border-radius:6px;cursor:zoom-in}
.thumbs .shot img{height:130px;width:auto}.shot figcaption{font-size:11px;color:var(--ink-3);margin-top:3px}
.lcpgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px;margin:10px 0}.lcpbox{border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:13px;display:flex;flex-direction:column;gap:4px;min-width:0}
.lhgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:14px}.lhcard{border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}.lhcard h4{margin:0 0 8px}
.gauges{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 10px}.gauge{text-align:center;font-size:12px;color:var(--ink-2)}.g-bg{fill:none;stroke:var(--surface-2);stroke-width:6}.g-arc{fill:none;stroke-width:6;stroke-linecap:round}
.g-ok{stroke:var(--good)}.g-warn{stroke:var(--warning)}.g-fail{stroke:var(--critical)}svg .g-num{fill:var(--ink);font-size:17px;font-weight:700}
.lhmetrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin:0 0 10px}.lhm{border:1px solid var(--line);border-radius:6px;padding:5px 8px;display:flex;flex-direction:column;font-size:12px}.lhm b{font-size:13px}
.diag li{margin:6px 0}dl.defs{margin:0}dl.defs div{display:grid;grid-template-columns:230px 1fr;gap:12px;padding:7px 0;border-bottom:1px solid var(--line)}dl.defs dt{font-weight:600}dl.defs dd{margin:0;color:var(--ink-2)}
@media(max-width:700px){dl.defs div{grid-template-columns:1fr;gap:2px}.lhmetrics{grid-template-columns:repeat(2,1fr)}}
.btn{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);border-radius:6px;padding:3px 10px;cursor:pointer;margin-left:8px}
.summaryline{max-width:1000px}
#lightbox{position:fixed;inset:0;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;z-index:20;cursor:zoom-out;padding:20px}#lightbox.on{display:flex}#lightbox img{max-width:100%;max-height:100%;border-radius:6px;background:#fff}
@media print{nav.top,.btn{display:none}section{break-inside:avoid-page}details{break-inside:avoid}}
`;

const JS = String.raw`
(function(){
  var lb=document.getElementById('lightbox'),img=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var t=e.target;
    if(t&&t.matches&&t.matches('img[data-zoom]')){img.src=t.src;img.alt=t.alt;lb.classList.add('on');return;}
    if(lb.classList.contains('on')){lb.classList.remove('on');img.removeAttribute('src');}
    if(t&&t.matches&&t.matches('[data-toggle-all]')){
      var open=t.getAttribute('data-open')!=='1';
      document.querySelectorAll('details.step').forEach(function(d){d.open=open;});
      t.setAttribute('data-open',open?'1':'0');t.textContent=open?'Collapse all steps':'Expand all steps';
    }
  });
  document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.classList.remove('on');});
  // open the step a link points at
  function openTarget(){var el=location.hash&&document.getElementById(location.hash.slice(1));if(el&&el.tagName==='DETAILS')el.open=true;}
  window.addEventListener('hashchange',openTarget);openTarget();
})();
`;

export function renderHtml(m: ReportModel): string {
  const nav = [
    ['#scorecard', 'Scorecard'],
    ['#issues', 'Top issues'],
    ['#pageload', 'Page load'],
    ['#workflows', 'Workflows'],
    ['#throttle', 'Throttled vs unthrottled'],
    ['#lighthouse', 'Lighthouse'],
    ['#quality', 'Errors & quality'],
    ['#unstable', 'Unstable'],
    ['#method', 'Methodology'],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(m.meta.site)} performance audit</title><style>${CSS}</style></head><body>
<nav class="top" aria-label="Sections">${nav.map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}</nav>
<main>${sectionHeader(m)}${sectionScorecard(m)}${sectionIssues(m)}${sectionPageLoad(m)}${sectionWorkflows(m)}${sectionThrottle(m)}${sectionLighthouse(m)}${sectionQuality(m)}${sectionUnstable(m)}${sectionMethod(m)}</main>
<div id="lightbox" role="dialog" aria-label="Screenshot"><img alt=""></div><script>${JS}</script></body></html>`;
}
