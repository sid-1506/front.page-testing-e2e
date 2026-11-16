/**
 * Headed login helper.
 *
 * front.page login is phone number + OTP behind an invisible reCAPTCHA, which cannot be automated.
 * This script opens a real browser window, waits for a human to log in, then saves the session to
 * playwright/.auth/user.json (gitignored). Nothing typed into the window is read, logged or stored
 * by this script; only the resulting browser storage state is written to disk.
 *
 *   npm run auth:login
 *
 * Env: BASE_URL (default https://front.page), LOGIN_TIMEOUT_MIN (default 20),
 *      LOGIN_BROWSER=chrome|chromium (default: chrome if installed, else bundled chromium)
 */
import { chromium, type Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true } as dotenv.DotenvConfigOptions);

const BASE = (process.env.BASE_URL || 'https://front.page').replace(/\/$/, '');
const AUTH_DIR = path.join(__dirname, '..', 'playwright', '.auth');
const STATE = path.join(AUTH_DIR, 'user.json');
const TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MIN || 20) * 60_000;
const COMPOSER = /what's your view on markets today\?/i;

async function launch(): Promise<{ browser: Browser; name: string }> {
  const want = process.env.LOGIN_BROWSER;
  if (want !== 'chromium') {
    try {
      return { browser: await chromium.launch({ headless: false, channel: 'chrome' }), name: 'Google Chrome' };
    } catch {
      if (want === 'chrome') throw new Error('LOGIN_BROWSER=chrome but Google Chrome could not be launched');
    }
  }
  return { browser: await chromium.launch({ headless: false }), name: 'bundled Chromium' };
}

(async () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { browser, name } = await launch();
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });

  console.log(`[login-helper] ${name} window opened at ${BASE}/login`);
  console.log('[login-helper] Log in with your TEST account (phone number + OTP). Waiting up to ' + TIMEOUT_MS / 60_000 + ' min...');

  const deadline = Date.now() + TIMEOUT_MS;
  let leftLoginAt = 0;
  let triedHome = false;
  let ok = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    try {
      const pathname = new URL(page.url()).pathname;
      if (pathname !== '/login') {
        if (!leftLoginAt) leftLoginAt = Date.now();
        if (await page.getByPlaceholder(COMPOSER).first().isVisible().catch(() => false)) {
          ok = true;
          break;
        }
        // Logged in but landed somewhere without the composer (e.g. onboarding): check the home feed once.
        if (!triedHome && Date.now() - leftLoginAt > 10_000) {
          triedHome = true;
          await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      } else {
        leftLoginAt = 0;
      }
    } catch {
      /* page navigating */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!ok) {
    console.error('[login-helper] FAILED: the signed-in home composer never became visible (timeout or window closed). No session saved.');
    await browser.close().catch(() => {});
    process.exit(1);
  }

  await page.waitForTimeout(2000); // let post-login requests settle so all cookies/tokens are written
  const state = await context.storageState({ path: STATE, indexedDB: true });
  fs.chmodSync(STATE, 0o600);
  const idbCount = state.origins.reduce((n, o) => n + ((o as { indexedDB?: unknown[] }).indexedDB?.length || 0), 0);
  console.log(
    `[login-helper] OK: session saved to playwright/.auth/user.json (${state.cookies.length} cookies, ${state.origins.length} origins with localStorage, ${idbCount} IndexedDB databases).`,
  );
  await browser.close();
})().catch((e) => {
  console.error('[login-helper] error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
