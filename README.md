# perf-e2e: FrontPage performance + functional E2E suite

Playwright (Chromium) walks three signed-in workflows on https://front.page, measures how fast each step
responds, records every API call, loads the entry pages cold/warm/reload, runs Lighthouse, and builds one
self-contained report: `reports/perf-report.html` (+ `results/metrics.json`).

It runs against production with real members, so it **never publishes anything**: Submit and the comment
submit button are verified but not clicked, typed text is cleared, Vote/Follow/bookmark are never touched.

## Run it

```bash
npm ci
npx playwright install chromium
cp .env.example .env          # set TEST_LOCATION (and RUNS if you want more than 3)
npm run auth:login            # once: log in by phone + OTP in the window that opens
npm run all                   # test:perf -> test:lh -> report  (about 35-45 min with RUNS=3)
open reports/perf-report.html
```

Login is phone number + OTP behind an invisible reCAPTCHA, so it cannot be automated. `auth:login` opens a
real browser, waits for you to sign in, and saves the session to `playwright/.auth/user.json` (gitignored).
`TEST_EMAIL` / `TEST_PASSWORD` are not used to log in; if `TEST_PASSWORD` is set, the build fails when its
value shows up in any output.

| Script | What it does |
|---|---|
| `npm run test:perf` | page-load + wf1/wf2/wf3 on both profiles (`desktop`, `mobile-slow4g`) |
| `npm run test:lh` | Lighthouse desktop + mobile on the four pages, plus a user-flow timespan for wf3 |
| `npm run report` | `results/raw/*.json` → `results/metrics.json` + `reports/perf-report.html`, then the redaction gate |
| `npm run all` | the three above, in order; later stages run even if a test fails |
| `npm run selftest` | proves `measureStep` against a local page with known delays (no site traffic) |
| `RUNS=0 npx playwright test wf1 --project=desktop --headed --trace on` | dry run of one workflow (warm-up pass only) |

## Layout

```
lib/init-observers.ts    in-page probes: web-vitals, interaction + mutation probes, PerformanceObservers, UI checks
lib/network-recorder.ts  every request: timing phases, classification, redacted payload/preview, flags, idle tracking
lib/measure-step.ts      measureStep(): anchors on the real pointerdown/keydown and times feedback, API, UI ready, idle
lib/page-load.ts         Navigation Timing + vitals + bytes for one cold / warm / reload navigation
lib/perf-fixture.ts      `perf` + `session` fixtures, workflow runner (warm-up + RUNS), axe scans
lib/throttling.ts        CDP network + CPU profiles
lib/redact.ts            key-based, pattern-based and literal redaction; secret scan
tests/                   auth.setup, page-load, wf1, wf2, wf3, lighthouse, self-test
scripts/build-report.ts  aggregation (report-aggregate.ts) + HTML (report-html.ts) + redaction gate
scripts/lh-runner.mjs    Lighthouse child process attached to the Playwright browser on port 9222
scripts/login-helper.ts  headed login helper
scripts/recon-workflows.ts, probe-login.ts, throttle-check.ts, print-run.js, shot-report.ts   maintenance tools
```

## Things that differ from the original workflow spec (found during the dry run)

- `/post/create-post` opens the club selector by itself; while it is open the rest of the page is
  `aria-hidden`. wf1 step 2 therefore picks the option without first clicking the combobox.
- After a club is chosen the body textarea's placeholder changes, so `getByPlaceholder('Share your insights...')`
  no longer matches; the test uses the only `<textarea>` in `<main>` (verified to be the same node).
- At 390 px the header search is collapsed behind an unlabeled icon button (extra step 0 in wf3), and the
  filter button is labelled "All" instead of "All Posts".

## Notes

- Budgets live in `perf-budgets.json` (warn / fail).
- Results depend on where the test runs from. Set `TEST_LOCATION`; compare runs only from the same location.
- Traces of failed tests (`test-results/`, `playwright-report/`) are raw browser recordings including cookies.
  They are kept out of `reports/` and are not uploaded by the CI workflow. Do not share them.
- CI: `.github/workflows/perf.yml` (manual trigger). It needs the saved session as the `STORAGE_STATE_B64` secret.
