import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(__dirname, '.env'), quiet: true } as dotenv.DotenvConfigOptions);

const STATE = path.join(__dirname, 'playwright', '.auth', 'user.json');
const BASE_URL = (process.env.BASE_URL || 'https://front.page').replace(/\/$/, '');
const PERF_SPECS = /(page-load|wf\d-[\w-]+)\.spec\.ts$/;
/** test:perf and test:lh are separate invocations; give each its own built-in HTML report folder. */
const REPORT_NAME = process.env.PW_REPORT_NAME || 'perf';

const common = {
  storageState: STATE,
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
};

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  // Low traffic only: one worker, nothing in parallel, no retries (a failure is a finding, not noise to retry away).
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // One test = one workflow x profile with a warm-up + RUNS measured passes, so tests are long.
  timeout: 45 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    // Kept out of reports/ on purpose: traces of failed tests are raw recordings (cookies included) and
    // reports/ is what gets shared and uploaded as a CI artifact.
    ['html', { outputFolder: `playwright-report/${REPORT_NAME}`, open: 'never' }],
    ['json', { outputFile: `results/playwright-${REPORT_NAME}.json` }],
  ],
  use: {
    baseURL: BASE_URL,
    // HEADED=1 shows the browser. Playwright launches Chromium with background/occlusion throttling disabled,
    // so a hidden or covered window does not slow timers or rendering, but keep it visible to be safe.
    headless: !process.env.HEADED,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 45_000,
    navigationTimeout: 180_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'desktop',
      testMatch: PERF_SPECS,
      dependencies: ['setup'],
      metadata: { profile: 'desktop' },
      use: { ...common, browserName: 'chromium', viewport: { width: 1366, height: 768 }, userAgent: devices['Desktop Chrome'].userAgent },
    },
    {
      name: 'mobile-slow4g',
      testMatch: PERF_SPECS,
      dependencies: ['setup'],
      metadata: { profile: 'mobile-slow4g' },
      use: {
        ...common,
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        userAgent: devices['Pixel 7'].userAgent,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'lighthouse',
      testMatch: /lighthouse\.spec\.ts$/,
      dependencies: ['setup'],
      use: { browserName: 'chromium' },
    },
    // Harness self-test against a local page with known delays. No auth, no traffic to the real site.
    { name: 'selftest', testMatch: /self-test\.spec\.ts$/, metadata: { profile: 'desktop' }, use: { browserName: 'chromium', viewport: { width: 1366, height: 768 } } },
    {
      name: 'selftest-mobile',
      testMatch: /self-test\.spec\.ts$/,
      metadata: { profile: 'mobile-slow4g' },
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
});
