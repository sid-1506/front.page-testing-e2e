/** Shared record shapes written to results/raw/*.json and read by scripts/build-report.ts. */

export type Budgets = Record<string, [number, number]>;

export interface RedactedBody {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface RequestTiming {
  /** queueing / stalled before the request was sent (after any connection setup) */
  blocked: number;
  dns: number;
  /** TCP connect, excluding TLS */
  connect: number;
  ssl: number;
  /** TTFB: responseStart - requestStart */
  wait: number;
  /** responseEnd - responseStart */
  download: number;
  total: number;
  /** true when dns/connect/ssl are all 0 because an existing connection was reused */
  reusedConnection: boolean;
}

export type RequestFlag =
  | 'slow'
  | 'failed'
  | 'aborted'
  | 'http_error'
  | 'duplicate'
  | 'sequential'
  | 'uncompressed'
  | 'large'
  | 'no_cache_headers'
  | 'polling'
  | 'write';

export interface RequestRecord {
  id: number;
  method: string;
  url: string;
  host: string;
  path: string;
  resourceType: string;
  /** doc | js | css | img | font | xhr | other */
  bucket: string;
  firstParty: boolean;
  polling: boolean;
  /** first-party xhr/fetch (REST API, *.data route loaders, /__manifest) */
  api: boolean;
  step: string | null;
  startEpoch: number;
  endEpoch: number | null;
  /** ms from the step's anchoring interaction to request start (set by measureStep) */
  startOffsetMs: number | null;
  status: number | null;
  failed: boolean;
  failureText: string | null;
  timing: RequestTiming | null;
  durationMs: number | null;
  requestHeaders: Record<string, string>;
  payload: RedactedBody | null;
  requestBytes: number | null;
  /** bytes on the wire: encoded body + response headers */
  responseBytes: number | null;
  /** decoded body length, only when the body was read (first-party JSON/text xhr/fetch) */
  bodyBytes: number | null;
  contentLength: number | null;
  contentType: string | null;
  encoding: string | null;
  cacheControl: string | null;
  etag: string | null;
  age: string | null;
  xCache: string | null;
  serverTiming: string | null;
  fromCache: boolean;
  responsePreview: RedactedBody | null;
  redirectedFrom: string | null;
  sequentialAfter: string | null;
  flags: RequestFlag[];
}

export interface ConsoleRecord {
  type: string;
  text: string;
  location: string;
  step: string | null;
  at: number;
}

export interface EventTimingSummary {
  name: string;
  inputDelay: number;
  processing: number;
  presentation: number;
  duration: number;
  /** number of Event Timing interactions seen in the step window */
  interactions: number;
}

export interface StepPart {
  label: string;
  type: string;
  target: string | null;
  at: number;
  feedbackMs: number | null;
  feedbackTarget: string | null;
}

export type StepStatus = 'passed' | 'failed' | 'skipped: irreversible';

export interface StepRecord {
  index: number;
  name: string;
  action: string;
  stopPoint: boolean;
  status: StepStatus;
  error: string | null;
  url: string;
  /** which timestamp anchors the metrics */
  anchor: string;
  anchorEpoch: number | null;
  isNavigation: boolean;
  navigation: {
    type: 'soft' | 'hard';
    softNavEntry: boolean;
    softNavUrl: string | null;
    ttfbMs: number | null;
    fcpMs: number | null;
    lcpMs: number | null;
    note: string;
  } | null;
  /** interaction -> first DOM mutation on an element that does not also change on its own while the page is idle */
  clickToFeedbackMs: number | null;
  /** interaction -> first DOM mutation of any kind (can be a live ticker; kept for transparency) */
  clickToAnyMutationMs: number | null;
  ambientMutationsSkipped: number | null;
  feedbackTarget: string | null;
  feedbackKind: string | null;
  ambientMutations1s: number | null;
  eventTiming: EventTimingSummary | null;
  clickToFirstRequestMs: number | null;
  clickToApiDoneMs: number | null;
  clickToUiReadyMs: number | null;
  clickToNetworkIdleMs: number | null;
  networkIdleReached: boolean | null;
  longTasksMs: number | null;
  longTaskCount: number | null;
  loafCount: number | null;
  loafBlockingMs: number | null;
  cls: number | null;
  layoutShiftAll: number | null;
  shiftSources: string[];
  /** time the harness spent before the interaction reached the page (scrolling, actionability checks) */
  actionabilityMs: number | null;
  stepWallMs: number;
  uiConditions: { description: string; ms: number | null; precision?: string }[];
  milestones: Record<string, number | null>;
  parts: StepPart[];
  typing: { keystrokes: number; typingMs: number; firstKeyToFeedbackMs: number | null; uiReadyAfterKeystroke?: number; firstKeyToUiReadyMs?: number } | null;
  expectApi: { pattern: string; matched: boolean; calls: number } | null;
  extra: Record<string, unknown>;
  clock: { skewMs: number | null; rttMs: number | null };
  screenshot: string | null;
  requests: RequestRecord[];
  console: ConsoleRecord[];
  pageErrors: ConsoleRecord[];
  /** metric name -> why it could not be collected */
  notCollected: Record<string, string>;
}

export interface PageLoadRun {
  page: string;
  url: string;
  finalUrl: string;
  profile: string;
  mode: 'cold' | 'warm' | 'reload';
  runIndex: number;
  ok: boolean;
  error: string | null;
  at: string;
  dns: number | null;
  tcp: number | null;
  tls: number | null;
  ttfb: number | null;
  responseEnd: number | null;
  dcl: number | null;
  load: number | null;
  fcp: number | null;
  lcp: number | null;
  lcpElement: string | null;
  lcpResource: string | null;
  lcpSize: number | null;
  lcpBreakdown: Record<string, unknown> | null;
  /** navigation start -> the page's "usable" element is visible */
  uiReadyMs: number | null;
  cls: number | null;
  topShifts: { element: string; value: number }[];
  tbt: number | null;
  tbtToSettle: number | null;
  longTaskCount: number | null;
  loaf: { supported: boolean; count: number; blockingMs: number; worst: unknown[] } | null;
  inp: number | null;
  requests: number;
  cachedRequests: number;
  bytes: { doc: number; js: number; css: number; img: number; font: number; xhr: number; other: number; total: number; firstParty: number; thirdParty: number };
  counts: { firstParty: number; thirdParty: number; byType: Record<string, number> };
  redirectCount: number;
  redirectChain: string[];
  navProtocol: string | null;
  docServerTiming: string | null;
  docCacheControl: string | null;
  docEncoding: string | null;
  settleMs: number | null;
  networkIdleReached: boolean;
  apiCalls: RequestRecord[];
  slowestRequests: { url: string; bucket: string; durationMs: number; bytes: number | null; firstParty: boolean }[];
  thirdPartyHosts: { host: string; requests: number; bytes: number }[];
  console: ConsoleRecord[];
  pageErrors: ConsoleRecord[];
  failedRequests: { url: string; failure: string | null; status: number | null }[];
  brokenImages: string[];
  mixedContent: string[];
  notCollected: Record<string, string>;
  screenshot: string | null;
}

export interface QualityScan {
  workflow: string;
  profile: string;
  page: string;
  url: string;
  axe: { critical: number; serious: number; moderate: number; minor: number; topRules: { id: string; impact: string; nodes: number; help: string }[] } | null;
  axeError: string | null;
  brokenImages: string[];
  mixedContent: string[];
  imageCount: number | null;
}

export interface WorkflowRun {
  runIndex: number;
  kind: 'firstVisit' | 'measured';
  passed: boolean;
  error: string | null;
  /** entry navigation to entry-ready + sum of the steps' interaction-to-UI-ready times */
  totalMs: number | null;
  wallMs: number;
  startedAt: string;
  entry: { url: string; readyMs: number | null; ttfb: number | null; fcp: number | null; lcp: number | null; requests: number; idleReached: boolean } | null;
  steps: StepRecord[];
  cleanup: { description: string; ok: boolean; detail: string }[];
  /** first-party non-GET requests seen anywhere in the run (write-safety audit) */
  writes: { method: string; url: string; status: number | null; step: string | null; payload: string | null }[];
  idleRequests: RequestRecord[];
}

export interface WorkflowResult {
  kind: 'workflow';
  id: string;
  name: string;
  profile: string;
  startUrl: string;
  generatedAt: string;
  env: EnvInfo;
  findings: string[];
  firstVisit: WorkflowRun | null;
  runs: WorkflowRun[];
  quality: QualityScan[];
}

export interface EnvInfo {
  site: string;
  baseUrl: string;
  testLocation: string;
  browserVersion: string;
  playwrightVersion: string;
  userAgent: string;
  viewport: { width: number; height: number };
  profile: string;
  profileLabel: string;
  runs: number;
  headless: boolean;
  os: string;
  ci: boolean;
}

export interface PageLoadResult {
  kind: 'pageload';
  page: string;
  url: string;
  profile: string;
  generatedAt: string;
  env: EnvInfo;
  runs: PageLoadRun[];
  findings: string[];
}
