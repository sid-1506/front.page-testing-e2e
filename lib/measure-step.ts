/**
 * measureStep(name, action, opts): wraps one workflow step and records how fast the site responds.
 *
 * Clocks: everything is epoch milliseconds. In the page that is performance.timeOrigin + performance.now();
 * on the node side Date.now(); Playwright's request.timing().startTime is epoch too, so they line up.
 *
 * Step window = [just before the action, network idle after the expected UI appeared].
 * Anchor     = the in-page interaction that starts the step (first pointerdown for clicks, first keydown
 *              for typing). Completion metrics of typing steps are anchored on the LAST keystroke,
 *              because the time spent typing is the harness's own pacing, not the site's latency.
 */
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { applyWindowFlags, type NetworkRecorder } from './network-recorder';
import type { Redactor } from './redact';
import type { EventTimingSummary, RequestRecord, StepPart, StepRecord } from './types';

export interface UiCondition {
  description: string;
  /** 'frame': checked in the page once per animation frame; 'coarse': Playwright locator wait (backoff up to 500 ms) */
  precision: 'frame' | 'coarse';
  /** Resolves with the epoch (ms) at which the condition became true, when the page can tell us. */
  wait(timeoutMs: number): Promise<number | void>;
}

type Match = string | RegExp;
interface MatchSpec {
  text?: string;
  exact?: boolean;
  re?: string;
  flags?: string;
}
const m = (v: Match | undefined, exact = false): MatchSpec | undefined => (v == null ? undefined : v instanceof RegExp ? { re: v.source, flags: v.flags.replace(/[gy]/g, '') } : { text: v, exact });

export type UiSpec =
  | { kind: 'path'; re: string; flags?: string }
  | { kind: 'url'; re: string; flags?: string }
  | { kind: 'feedChanged'; baseline: string; n?: number }
  | { kind: 'title'; re: string; flags?: string }
  | { kind: 'role'; role: string; name?: MatchSpec; hasText?: MatchSpec; within?: string; enabled?: boolean; pick?: 'first' | 'last'; minCount?: number }
  | { kind: 'placeholder'; match: MatchSpec; hasText?: MatchSpec; useValue?: boolean; within?: string }
  | { kind: 'css'; selector: string; hasText?: MatchSpec; within?: string; minCount?: number }
  | { kind: 'text'; match: MatchSpec; within?: string }
  | { kind: 'all'; specs: UiSpec[] }
  | { kind: 'not'; spec: UiSpec };

function inPage(page: Page, description: string, spec: UiSpec): UiCondition {
  return {
    description,
    precision: 'frame',
    wait: async (timeout) => {
      const handle = await page.waitForFunction(
        (sp) => {
          const P = (window as unknown as { __perf?: { check?(s: unknown): boolean } }).__perf;
          return P && P.check && P.check(sp) ? performance.timeOrigin + performance.now() : false;
        },
        spec,
        { polling: 'raf', timeout },
      );
      const at = (await handle.jsonValue()) as number;
      await handle.dispose().catch(() => {});
      return at;
    },
  };
}

/**
 * Timed UI conditions. They are evaluated inside the page once per animation frame (requestAnimationFrame
 * polling) and report the in-page timestamp at which they became true, so the precision is one frame.
 * The step's functional assertions still use the spec's Playwright locators, separately and untimed.
 */
export const ui = {
  /** location.pathname matches */
  path: (page: Page, re: RegExp, description?: string) => inPage(page, description || `URL path matches ${re}`, { kind: 'path', re: re.source, flags: re.flags.replace(/[gy]/g, '') }),
  /** location.pathname + location.search matches */
  url: (page: Page, re: RegExp, description?: string) => inPage(page, description || `URL matches ${re}`, { kind: 'url', re: re.source, flags: re.flags.replace(/[gy]/g, '') }),
  /** the post list in <main> shows different cards than `baseline` (see feedSignature) and is not empty */
  feedChanged: (page: Page, baseline: string, description = 'post list re-rendered with different cards') => inPage(page, description, { kind: 'feedChanged', baseline }),
  title: (page: Page, re: RegExp) => inPage(page, `document.title matches ${re}`, { kind: 'title', re: re.source, flags: re.flags.replace(/[gy]/g, '') }),
  /** a visible element with this role (simplified accessible name: aria-label, else text content) */
  role: (page: Page, role: string, o: { name?: Match; exact?: boolean; hasText?: Match; within?: string; enabled?: boolean; pick?: 'first' | 'last'; minCount?: number; description?: string } = {}) =>
    inPage(page, o.description || `${role}${o.name ? ` "${o.name}"` : ''} visible${o.enabled != null ? (o.enabled ? ' and enabled' : ' and disabled') : ''}${o.within ? ` in ${o.within}` : ''}`, {
      kind: 'role',
      role,
      name: m(o.name, o.exact),
      hasText: m(o.hasText),
      within: o.within,
      enabled: o.enabled,
      pick: o.pick,
      minCount: o.minCount,
    }),
  placeholder: (page: Page, match: Match, o: { exact?: boolean; description?: string; valueMatches?: Match } = {}) =>
    inPage(page, o.description || `field with placeholder "${match}" visible`, { kind: 'placeholder', match: m(match, o.exact)!, hasText: m(o.valueMatches), useValue: o.valueMatches != null }),
  text: (page: Page, match: Match, o: { exact?: boolean; within?: string; description?: string } = {}) =>
    inPage(page, o.description || `text "${match}" visible`, { kind: 'text', match: m(match, o.exact)!, within: o.within }),
  css: (page: Page, selector: string, o: { hasText?: Match; minCount?: number; description?: string } = {}) =>
    inPage(page, o.description || `${selector} visible`, { kind: 'css', selector, hasText: m(o.hasText), minCount: o.minCount }),
  all: (page: Page, description: string, conds: UiSpec[]) => inPage(page, description, { kind: 'all', specs: conds }),
  /** Fallback for anything the in-page checks cannot express. Late by up to 500 ms; avoid for timing. */
  locatorCoarse(locator: Locator, description: string): UiCondition {
    return { description: `${description} (coarse)`, precision: 'coarse', wait: async (t) => void (await locator.first().waitFor({ state: 'visible', timeout: t })) };
  },
};

export interface StepOptions {
  index: number;
  action: 'click' | 'fill' | 'select' | 'wait';
  /** What the user must see for the step to count as done. All conditions are timed. */
  expectUi: UiCondition[];
  /** Strict functional assertions, run after timing (not timed). A throw fails the step. */
  assert?: () => Promise<void>;
  /** A first-party API the spec expects this step to call; recorded as matched / not matched. */
  expectApi?: RegExp;
  isNavigation?: boolean;
  /** Extra timed checkpoints started together with expectUi (e.g. "comment section rendered"). */
  milestones?: Record<string, UiCondition[]>;
  uiTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Locators painted over in the screenshot (anything showing the logged-in user's name). */
  mask?: Locator[];
  /** Computed after the window closes; merged into the record's `extra`. */
  extra?: (ctx: { requests: RequestRecord[]; slice: PageSlice | null; anchorEpoch: number | null; lastKeyEpoch: number | null }) => Record<string, unknown>;
}

export interface StepContext {
  page: Page;
  recorder: NetworkRecorder;
  redactor: Redactor;
  screenshotDir: string;
  /** prefix for screenshot files, e.g. "wf1-desktop-run1" */
  shotPrefix: string;
  /** label stored on every request fired during the step */
  stepLabel: (index: number, name: string) => string;
  defaultUiTimeoutMs: number;
  defaultIdleTimeoutMs: number;
  defaultMask: () => Locator[];
  reportsDir: string;
}

interface PageInteraction {
  seq: number;
  type: string;
  t: number;
  tHandler: number;
  target: string | null;
  key?: string;
  firstMutation: number | null;
  mutationTarget: string | null;
  mutationKind: string | null;
  firstAnyMutation: number | null;
  ambientSkipped: number;
}
interface PageEvent {
  name: string;
  start: number;
  inputDelay: number;
  processing: number;
  presentation: number;
  duration: number;
  interactionId: number;
  target: string | null;
}
export interface PageSlice {
  url: string;
  timeOrigin: number;
  interactions: PageInteraction[];
  events: PageEvent[];
  longTasks: { start: number; duration: number }[];
  loafs: { start: number; duration: number; blocking: number }[];
  shifts: { t: number; value: number; hadRecentInput: boolean; sources: string[] }[];
  softNavs: { start: number; url: string; navigationId: number | null }[];
  vitals: Record<string, { name: string; value: number; navigationType: string; navigationId: number; navigationURL: string | null; attribution: Record<string, unknown>; at: number }[]>;
  ambientMutations1s: number;
  errors: string[];
}

export class StepError extends Error {
  constructor(
    message: string,
    public record: StepRecord,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

/** Minimum time the idle page is observed before each step to learn which elements mutate on their own. */
export const AMBIENT_LEARN_MS = 1000;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function overlap(start: number, duration: number, from: number, to: number): number {
  return Math.max(0, Math.min(start + duration, to) - Math.max(start, from));
}

function cleanError(e: unknown, redactor: Redactor): string {
  const msg = e instanceof Error ? e.message : String(e);
  // strip ANSI colour codes Playwright puts into expect() messages
  return redactor
    .text(msg.replace(/\u001b\[[0-9;]*m/g, ''))
    .split('\n')
    .slice(0, 12)
    .join('\n')
    .slice(0, 1500);
}

export function emptyStep(index: number, name: string, action: string): StepRecord {
  return {
    index,
    name,
    action,
    stopPoint: false,
    status: 'passed',
    error: null,
    url: '',
    anchor: 'none',
    anchorEpoch: null,
    isNavigation: false,
    navigation: null,
    clickToFeedbackMs: null,
    clickToAnyMutationMs: null,
    ambientMutationsSkipped: null,
    feedbackTarget: null,
    feedbackKind: null,
    ambientMutations1s: null,
    eventTiming: null,
    clickToFirstRequestMs: null,
    clickToApiDoneMs: null,
    clickToUiReadyMs: null,
    clickToNetworkIdleMs: null,
    networkIdleReached: null,
    longTasksMs: null,
    longTaskCount: null,
    loafCount: null,
    loafBlockingMs: null,
    cls: null,
    layoutShiftAll: null,
    shiftSources: [],
    actionabilityMs: null,
    stepWallMs: 0,
    uiConditions: [],
    milestones: {},
    parts: [],
    typing: null,
    expectApi: null,
    extra: {},
    clock: { skewMs: null, rttMs: null },
    screenshot: null,
    requests: [],
    console: [],
    pageErrors: [],
    notCollected: {},
  };
}

export async function takeScreenshot(ctx: StepContext, name: string, mask: Locator[] = []): Promise<string | null> {
  try {
    const file = path.join(ctx.screenshotDir, `${ctx.shotPrefix}-${name}.jpg`);
    await ctx.page.screenshot({
      path: file,
      type: 'jpeg',
      quality: 60,
      scale: 'css',
      mask: [...ctx.defaultMask(), ...mask],
      maskColor: '#9aa0a6',
      timeout: 15_000,
    });
    return path.relative(ctx.reportsDir, file).split(path.sep).join('/');
  } catch {
    return null;
  }
}

/** Wait for all conditions; returns when each became true (in-page epoch where available, else node clock). */
async function timeConditions(conds: UiCondition[], timeoutMs: number): Promise<{ doneAt: number; each: { description: string; at: number; precision: string }[] }> {
  const each: { description: string; at: number; precision: string }[] = [];
  await Promise.all(
    conds.map(async (c) => {
      const at = await c.wait(timeoutMs);
      each.push({ description: c.description, at: typeof at === 'number' ? at : Date.now(), precision: c.precision });
    }),
  );
  return { doneAt: each.length ? Math.max(...each.map((e) => e.at)) : Date.now(), each };
}

export async function measureStep(ctx: StepContext, name: string, action: () => Promise<unknown>, opts: StepOptions): Promise<StepRecord> {
  const { page, recorder, redactor } = ctx;
  const rec = emptyStep(opts.index, name, opts.action);
  rec.isNavigation = !!opts.isNavigation;
  const label = ctx.stepLabel(opts.index, name);
  const uiTimeout = opts.uiTimeoutMs ?? ctx.defaultUiTimeoutMs;
  const idleTimeout = opts.idleTimeoutMs ?? ctx.defaultIdleTimeoutMs;

  await recorder.flush();
  recorder.setStep(label);
  const reqMark = recorder.mark();
  const conMark = recorder.consoleMark();
  const urlBefore = page.url();

  // clock alignment check (page epoch vs node epoch), also proves the probes are installed
  try {
    const a = Date.now();
    const pg = await page.evaluate(() => (window as unknown as { __perf?: { now(): { epoch: number } } }).__perf?.now().epoch ?? null);
    const b = Date.now();
    if (pg != null) {
      rec.clock.rttMs = b - a;
      rec.clock.skewMs = r1(pg - (a + b) / 2);
    } else rec.notCollected.inPageProbes = 'window.__perf missing on this document';
  } catch (e) {
    rec.notCollected.inPageProbes = `could not reach page: ${cleanError(e, redactor).slice(0, 120)}`;
  }

  // Ambient learning: make sure the idle page has been observed for a while before acting, so elements
  // that change on their own (tickers, clocks) are known and not mistaken for feedback. Harness time only.
  try {
    const st = (await page.evaluate(() => (window as unknown as { __perf?: { learn?(on: boolean): { since: number; now: number } } }).__perf?.learn?.(true) ?? null)) as { since: number; now: number } | null;
    if (st) {
      const observed = st.now - st.since;
      if (observed < AMBIENT_LEARN_MS) await page.waitForTimeout(AMBIENT_LEARN_MS - observed);
    }
  } catch {
    /* probes unavailable: reported above */
  }

  const windowStart = Date.now();
  let failure: unknown = null;
  let uiDoneAt: number | null = null;
  let uiEach: { description: string; at: number; precision: string }[] = [];
  const milestoneAt: Record<string, number | null> = {};

  try {
    // start watching for the expected UI *before* acting so nothing is missed
    const uiP = timeConditions(opts.expectUi, uiTimeout);
    uiP.catch(() => {});
    const msP = Object.entries(opts.milestones || {}).map(async ([k, conds]) => {
      try {
        milestoneAt[k] = (await timeConditions(conds, uiTimeout)).doneAt;
      } catch {
        milestoneAt[k] = null;
      }
    });
    await action();
    const res = await uiP;
    uiDoneAt = res.doneAt;
    uiEach = res.each;
    await Promise.all(msP);
  } catch (e) {
    failure = e;
  }

  // let the network settle, then close the window
  const idle = await recorder.waitForIdle({ quietMs: 500, timeoutMs: failure ? 3000 : idleTimeout, sinceIndex: reqMark });
  await page.waitForTimeout(250).catch(() => {}); // Event Timing entries are delivered after the next paint
  const windowEnd = Date.now();
  rec.stepWallMs = windowEnd - windowStart;
  rec.url = redactor.url(page.url());

  // ---- in-page data for the window ------------------------------------------------------------------
  let slice: PageSlice | null = null;
  try {
    slice = (await page.evaluate(
      ([from, to]) => (window as unknown as { __perf?: { slice(a: number, b: number): unknown } }).__perf?.slice(from, to) ?? null,
      [windowStart - 30, windowEnd + 30],
    )) as PageSlice | null;
  } catch (e) {
    rec.notCollected.inPageProbes = `evaluate failed: ${cleanError(e, redactor).slice(0, 120)}`;
  }

  // the window is closed and the page is idle again: resume ambient learning until the next interaction
  await page.evaluate(() => void (window as unknown as { __perf?: { learn?(on: boolean): unknown } }).__perf?.learn?.(true)).catch(() => {});

  // ---- anchor ---------------------------------------------------------------------------------------
  const interactions = slice?.interactions || [];
  const pointerdowns = interactions.filter((i) => i.type === 'pointerdown');
  const clicks = interactions.filter((i) => i.type === 'click');
  const keydowns = interactions.filter((i) => i.type === 'keydown');
  let first: PageInteraction | null = null;
  let last: PageInteraction | null = null;
  if (opts.action === 'fill' && keydowns.length) {
    // ignore the click that focuses the field: the user-visible work starts with the first keystroke
    first = keydowns[0];
    last = keydowns[keydowns.length - 1];
    rec.anchor = 'first keydown (feedback) / the keystroke that caused each effect (completion)';
  } else if (pointerdowns.length || clicks.length) {
    const list = pointerdowns.length ? pointerdowns : clicks;
    first = list[0];
    last = first;
    rec.anchor = `first ${first.type}`;
  } else if (keydowns.length) {
    first = keydowns[0];
    last = first;
    rec.anchor = 'first keydown';
  }
  let anchorEpoch: number;
  let completionAnchor: number;
  if (first && last) {
    anchorEpoch = first.t;
    completionAnchor = opts.action === 'fill' ? last.t : first.t;
    rec.actionabilityMs = r1(first.t - windowStart);
  } else if (opts.action === 'wait') {
    anchorEpoch = completionAnchor = windowStart;
    rec.anchor = 'step start (no interaction: wait step)';
  } else {
    anchorEpoch = completionAnchor = windowStart;
    rec.anchor = 'node-side action start (in-page interaction not captured)';
    if (!rec.notCollected.inPageProbes) rec.notCollected.anchor = 'no trusted pointerdown/click/keydown seen in the step window';
  }
  rec.anchorEpoch = r1(anchorEpoch);
  // Typing steps: an effect is timed from the keystroke that caused it, i.e. the latest keydown at or
  // before the moment it was observed (Submit may enable after the 1st character, search fires after the last).
  const isTyping = opts.action === 'fill' && keydowns.length > 0;
  const anchorFor = (t: number): number => {
    if (!isTyping) return completionAnchor;
    let k = keydowns[0].t;
    for (const kd of keydowns) if (kd.t <= t) k = kd.t;
    return k;
  };
  const keystrokeIndex = (t: number): number => keydowns.filter((kd) => kd.t <= t).length;

  // ---- feedback (first DOM mutation) ----------------------------------------------------------------
  if (first) {
    rec.clickToAnyMutationMs = first.firstAnyMutation != null ? r1(Math.max(0, first.firstAnyMutation - first.t)) : null;
    rec.ambientMutationsSkipped = first.ambientSkipped || 0;
    if (first.firstMutation != null) {
      rec.clickToFeedbackMs = r1(Math.max(0, first.firstMutation - first.t));
      rec.feedbackTarget = redactor.text(first.mutationTarget);
      rec.feedbackKind = first.mutationKind;
    } else {
      rec.notCollected.clickToFeedbackMs =
        opts.action === 'fill'
          ? 'no DOM mutation followed the keystroke (a textarea value change is a property change, not a DOM mutation); see eventTiming for the typing latency'
          : 'no DOM mutation observed after the interaction';
    }
    rec.ambientMutations1s = slice?.ambientMutations1s ?? null;
  } else if (opts.action !== 'wait') {
    rec.notCollected.clickToFeedbackMs = 'interaction not captured in page';
  } else rec.notCollected.clickToFeedbackMs = 'wait step: no interaction';

  // sub-interactions (select = open + choose; typing = keystrokes)
  if (opts.action === 'select' || pointerdowns.length > 1) {
    const parts: StepPart[] = pointerdowns.map((p, i) => ({
      label: `interaction ${i + 1}`,
      type: p.type,
      target: redactor.text(p.target),
      at: r1(p.t - anchorEpoch),
      feedbackMs: p.firstMutation != null ? r1(Math.max(0, p.firstMutation - p.t)) : null,
      feedbackTarget: redactor.text(p.mutationTarget),
    }));
    rec.parts = parts;
  }
  if (opts.action === 'fill' && keydowns.length) {
    rec.typing = {
      keystrokes: keydowns.length,
      typingMs: r1(keydowns[keydowns.length - 1].t - keydowns[0].t),
      firstKeyToFeedbackMs: rec.clickToFeedbackMs,
    };
  }

  // ---- Event Timing (INP components) ----------------------------------------------------------------
  const events = (slice?.events || []).filter((e) => e.start >= anchorEpoch - 4);
  if (events.length) {
    // keyup is left out for typing: it changes nothing on screen, so its "duration" only measures how long
    // the page happened to go without painting, not how long the keystroke took to show up.
    const wanted = opts.action === 'fill' ? /^(keydown|keypress|input|beforeinput)$/ : /^(pointerdown|pointerup|mousedown|mouseup|click|keydown|keyup)$/;
    const cand = events.filter((e) => wanted.test(e.name));
    // Breakdown per interaction, the way INP attribution does it: all entries of one interaction that were
    // presented in the same frame are combined (first processingStart .. last processingEnd).
    const combine = (group: PageEvent[]): EventTimingSummary => {
      const start = Math.min(...group.map((e) => e.start));
      const pStart = Math.min(...group.map((e) => e.start + e.inputDelay));
      const pEnd = Math.max(...group.map((e) => e.start + e.inputDelay + e.processing));
      const end = Math.max(...group.map((e) => e.start + e.duration));
      const longest = group.slice().sort((x, y) => y.processing - x.processing)[0];
      return { name: longest.name, inputDelay: r1(pStart - start), processing: r1(pEnd - pStart), presentation: r1(Math.max(0, end - pEnd)), duration: r1(end - start), interactions: 0 };
    };
    const frames = (list: PageEvent[]): PageEvent[][] => {
      const out: PageEvent[][] = [];
      for (const e of list.slice().sort((x, y) => x.start + x.duration - (y.start + y.duration))) {
        const g = out[out.length - 1];
        if (g && Math.abs(g[0].start + g[0].duration - (e.start + e.duration)) <= 8) g.push(e);
        else out.push([e]);
      }
      return out;
    };
    let chosen: EventTimingSummary | null = null;
    if (opts.action === 'fill') {
      // worst keystroke of the typing step
      const byId = new Map<number, PageEvent[]>();
      cand.forEach((e, i) => {
        const key = e.interactionId || -1 - i;
        byId.set(key, [...(byId.get(key) || []), e]);
      });
      for (const group of byId.values()) for (const fr of frames(group)) {
        const c = combine(fr);
        if (!chosen || c.duration > chosen.duration) chosen = c;
      }
    } else {
      // the interaction that contains the anchoring pointerdown/click
      const near = cand.filter((e) => e.start - anchorEpoch < 1500);
      const anchorEv = near.find((e) => Math.abs(e.start - anchorEpoch) <= 4) || near[0];
      if (anchorEv) {
        const group = anchorEv.interactionId ? near.filter((e) => e.interactionId === anchorEv.interactionId) : [anchorEv];
        for (const fr of frames(group)) {
          const c = combine(fr);
          if (!chosen || c.duration > chosen.duration) chosen = c;
        }
      }
    }
    if (chosen) {
      chosen.interactions = new Set(events.filter((e) => e.interactionId).map((e) => e.interactionId)).size;
      rec.eventTiming = chosen;
    }
  }
  if (!rec.eventTiming) {
    rec.notCollected.eventTiming = !slice
      ? 'in-page probes unavailable'
      : opts.action === 'wait'
        ? 'wait step: no interaction'
        : 'no Event Timing entry: the interaction took under 16 ms (below durationThreshold)';
  }

  // ---- network --------------------------------------------------------------------------------------
  await recorder.flush();
  const reqs = recorder.records.slice(reqMark).filter((r) => r.startEpoch <= windowEnd + 50);
  applyWindowFlags(reqs);
  for (const r of reqs) r.startOffsetMs = r1(r.startEpoch - anchorEpoch);
  rec.requests = reqs;
  const fp = reqs.filter((r) => r.firstParty && !r.polling);
  const fpAfter = fp.filter((r) => r.startEpoch >= anchorEpoch - 5);
  if (fpAfter.length) {
    const firstStart = Math.min(...fpAfter.map((r) => r.startEpoch));
    rec.clickToFirstRequestMs = r1(Math.max(0, firstStart - (isTyping ? anchorFor(firstStart) : anchorEpoch)));
  }
  else rec.notCollected.clickToFirstRequestMs = 'no first-party request fired in this step';
  const apiDone = fp.filter((r) => r.api && r.endEpoch != null && r.startEpoch >= anchorEpoch - 5);
  if (apiDone.length) {
    const lastApi = apiDone.reduce((x, y) => ((y.endEpoch as number) > (x.endEpoch as number) ? y : x));
    rec.clickToApiDoneMs = r1(Math.max(0, (lastApi.endEpoch as number) - anchorFor(lastApi.startEpoch)));
  }
  else rec.notCollected.clickToApiDoneMs = 'no first-party API call (xhr/fetch) fired in this step';
  rec.networkIdleReached = idle.reached;
  const fpEnded = fp.filter((r) => r.endEpoch != null);
  if (fpEnded.length && idle.reached) {
    const lastReq = fpEnded.reduce((x, y) => ((y.endEpoch as number) > (x.endEpoch as number) ? y : x));
    rec.clickToNetworkIdleMs = r1(Math.max(0, (lastReq.endEpoch as number) - anchorFor(lastReq.startEpoch)));
  }
  else if (!idle.reached) rec.notCollected.clickToNetworkIdleMs = `first-party network not idle within ${idleTimeout} ms (in flight: ${idle.inflight.join(', ') || 'unknown'})`;
  else rec.notCollected.clickToNetworkIdleMs = 'no first-party request fired in this step';

  if (opts.expectApi) {
    const hits = reqs.filter((r) => r.firstParty && opts.expectApi!.test(r.path));
    rec.expectApi = { pattern: String(opts.expectApi), matched: hits.length > 0, calls: hits.length };
  }

  // ---- UI ready -------------------------------------------------------------------------------------
  if (uiDoneAt != null) {
    rec.clickToUiReadyMs = r1(Math.max(0, uiDoneAt - anchorFor(uiDoneAt)));
    rec.uiConditions = uiEach.map((e) => ({ description: e.description, ms: r1(Math.max(0, e.at - anchorFor(e.at))), precision: e.precision }));
    if (isTyping && rec.typing) {
      rec.typing.uiReadyAfterKeystroke = keystrokeIndex(uiDoneAt);
      rec.typing.firstKeyToUiReadyMs = r1(Math.max(0, uiDoneAt - keydowns[0].t));
    }
  } else {
    rec.uiConditions = opts.expectUi.map((c) => ({ description: c.description, ms: null, precision: c.precision }));
    rec.notCollected.clickToUiReadyMs = 'expected UI never appeared (step failed)';
  }
  for (const [k, at] of Object.entries(milestoneAt)) rec.milestones[k] = at == null ? null : r1(Math.max(0, at - anchorFor(at)));

  // ---- main thread + layout stability ---------------------------------------------------------------
  if (slice) {
    const to = windowEnd;
    const lt = slice.longTasks.map((t) => overlap(t.start, t.duration, anchorEpoch, to)).filter((d) => d > 0);
    rec.longTasksMs = r1(lt.reduce((a, b) => a + b, 0));
    rec.longTaskCount = lt.length;
    const lo = slice.loafs.filter((l) => overlap(l.start, l.duration, anchorEpoch, to) > 0);
    rec.loafCount = lo.length;
    rec.loafBlockingMs = r1(lo.reduce((a, b) => a + (b.blocking || 0), 0));
    const shifts = slice.shifts.filter((s) => s.t >= anchorEpoch);
    rec.cls = r4(shifts.filter((s) => !s.hadRecentInput).reduce((a, s) => a + s.value, 0));
    rec.layoutShiftAll = r4(shifts.reduce((a, s) => a + s.value, 0));
    rec.shiftSources = [...new Set(shifts.flatMap((s) => s.sources).filter(Boolean))].slice(0, 5).map((s) => redactor.text(s));
  } else {
    for (const k of ['longTasksMs', 'cls']) rec.notCollected[k] = 'in-page probes unavailable';
  }

  // ---- navigation -----------------------------------------------------------------------------------
  if (opts.isNavigation) {
    const urlChanged = page.url() !== urlBefore;
    const sameDocument = slice != null && first != null; // the document that saw the interaction is still alive
    const soft = slice?.softNavs?.find((s) => s.start >= anchorEpoch - 5) || null;
    let softLcp: number | null = null;
    if (soft && slice?.vitals?.LCP) {
      const v = slice.vitals.LCP.find((x) => x.navigationType === 'soft-navigation' && x.navigationId === soft.navigationId);
      if (v) softLcp = r1(v.value);
    }
    rec.navigation = {
      type: sameDocument ? 'soft' : 'hard',
      softNavEntry: !!soft,
      softNavUrl: soft ? redactor.url(soft.url) : null,
      ttfbMs: null,
      fcpMs: null,
      lcpMs: softLcp,
      note: sameDocument
        ? `soft navigation (client-side route change${urlChanged ? '' : ', URL unchanged'}): there is no document request, so TTFB/FCP do not exist; the page-transition time is clickToUiReadyMs` +
          (softLcp != null ? '. lcpMs is the soft-navigation LCP reported by web-vitals (experimental Chrome heuristic)' : '')
        : 'hard navigation: the previous document was unloaded',
    };
  }

  // ---- console / errors -----------------------------------------------------------------------------
  rec.console = recorder.consoleMessages.slice(conMark.console);
  rec.pageErrors = recorder.pageErrors.slice(conMark.errors);

  if (opts.extra) {
    try {
      rec.extra = opts.extra({ requests: reqs, slice, anchorEpoch: first ? anchorEpoch : null, lastKeyEpoch: opts.action === 'fill' && last ? last.t : null });
    } catch (e) {
      rec.extra = { error: cleanError(e, redactor) };
    }
  }
  if (slice?.errors?.length) rec.extra.probeErrors = slice.errors;

  // ---- functional assertions (untimed) ---------------------------------------------------------------
  if (!failure && opts.assert) {
    try {
      await opts.assert();
    } catch (e) {
      failure = e;
    }
  }

  recorder.setStep(null);
  rec.screenshot = await takeScreenshot(ctx, `step${opts.index}${failure ? '-FAILED' : ''}`, opts.mask);

  if (failure) {
    rec.status = 'failed';
    rec.error = cleanError(failure, redactor);
    throw new StepError(`Step ${opts.index} "${name}" failed: ${rec.error.split('\n')[0]}`, rec);
  }
  return rec;
}

/** A stop point: everything up to the final click is verified, the click itself is never performed. */
export async function recordStopPoint(
  ctx: StepContext,
  name: string,
  opts: { index: number; action: string; verify: () => Promise<void>; reason: string; mask?: Locator[] },
): Promise<StepRecord> {
  const rec = emptyStep(opts.index, name, opts.action);
  rec.stopPoint = true;
  rec.url = ctx.redactor.url(ctx.page.url());
  rec.anchor = 'none (click not performed)';
  const why = `skipped: irreversible (${opts.reason})`;
  for (const k of ['clickToFeedbackMs', 'eventTiming', 'clickToFirstRequestMs', 'clickToApiDoneMs', 'clickToUiReadyMs', 'clickToNetworkIdleMs', 'longTasksMs', 'cls']) rec.notCollected[k] = why;
  const t0 = Date.now();
  let failure: unknown = null;
  try {
    await opts.verify();
  } catch (e) {
    failure = e;
  }
  rec.stepWallMs = Date.now() - t0;
  rec.screenshot = await takeScreenshot(ctx, `step${opts.index}-stop-point${failure ? '-FAILED' : ''}`, opts.mask);
  if (failure) {
    rec.status = 'failed';
    rec.error = cleanError(failure, ctx.redactor);
    throw new StepError(`Stop point ${opts.index} "${name}" could not be verified: ${rec.error.split('\n')[0]}`, rec);
  }
  rec.status = 'skipped: irreversible';
  return rec;
}

export { cleanError };

/** Fingerprint of the post list currently shown in <main> (first 8 cards, digits masked). */
export async function feedSignature(page: Page): Promise<string> {
  return (await page.evaluate(() => (window as unknown as { __perf?: { feedSignature?(n: number): string } }).__perf?.feedSignature?.(8) ?? '')) as string;
}
