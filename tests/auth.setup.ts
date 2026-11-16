/**
 * Auth setup project.
 *
 * front.page login = phone number + OTP behind an invisible reCAPTCHA. That cannot be automated, so this
 * setup does not log in: it verifies the session saved by `npm run auth:login` (headed helper) still works,
 * refreshes playwright/.auth/user.json, and records which strings identify the test account so they can be
 * scrubbed from everything that is stored or shown. Nothing identifying is printed.
 */
import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import { STORAGE_STATE_PATH, USER_META_PATH, type UserMeta } from '../lib/redact';

const COMPOSER = /what's your view on markets today\?/;

setup('saved session is signed in', async ({ browser, baseURL }) => {
  setup.setTimeout(120_000);
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    throw new Error(
      'No saved session at playwright/.auth/user.json.\n' +
        'front.page login is phone + OTP + reCAPTCHA and cannot be automated.\n' +
        'Run `npm run auth:login`, log in once in the browser window that opens, then re-run the tests.\n' +
        '(In CI, provide the file through the STORAGE_STATE_B64 secret.)',
    );
  }
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH, viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

  // collect first-party JSON so sibling identifiers of the display name (handle, id) can be found
  const bodies: unknown[] = [];
  page.on('response', async (res) => {
    try {
      const u = new URL(res.url());
      if (!/(^|\.)front\.page$/.test(u.hostname)) return;
      if (!/json/i.test(res.headers()['content-type'] || '')) return;
      bodies.push(await res.json());
    } catch {
      /* not json / body gone */
    }
  });

  await page.goto(`${baseURL}/`, { waitUntil: 'load' });
  const composer = page.getByPlaceholder(COMPOSER);
  await expect(
    composer,
    'The home composer is only visible when signed in. The saved session has expired or is invalid: run `npm run auth:login` again.',
  ).toBeVisible({ timeout: 45_000 });

  // ---- identify the account (for redaction only) ----
  const terms = new Set<string>();
  const placeholder = (await composer.getAttribute('placeholder')) || '';
  const displayName = placeholder
    .replace(COMPOSER, '')
    .replace(/[\s,]+$/, '')
    .trim();
  if (displayName.length >= 3) {
    terms.add(displayName);
    for (const part of displayName.split(/\s+/)) if (part.length >= 4) terms.add(part);
  }
  // numeric user id embedded in localStorage key names (e.g. "active_today:<id>", "<id>_notification_nudge")
  const keys: string[] = await page.evaluate(() => Object.keys(localStorage));
  for (const k of keys) {
    const mm = k.match(/(?:^|[:_])(\d{5,})(?:$|[:_])/);
    if (mm) terms.add(mm[1]);
  }
  // handles / ids that sit next to the display name in API responses
  const ID_KEYS = /^(username|user_name|handle|slug|screen_name|nick(name)?|user_id|userid|uid|id|profile_url)$/i;
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 8) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const obj = v as Record<string, unknown>;
    const hasName = displayName.length >= 3 && Object.values(obj).some((x) => typeof x === 'string' && x.trim().toLowerCase() === displayName.toLowerCase());
    if (hasName) {
      for (const [k, x] of Object.entries(obj)) {
        if (!ID_KEYS.test(k)) continue;
        if (typeof x === 'string' && x.length >= 3 && x.length <= 60) terms.add(x.replace(/^\//, ''));
        if (typeof x === 'number' && x >= 10_000) terms.add(String(x));
      }
    }
    for (const x of Object.values(obj)) walk(x, depth + 1);
  };
  await page.waitForTimeout(1500);
  bodies.forEach((b) => walk(b, 0));

  const meta: UserMeta = { userTerms: [...terms], detectedAt: new Date().toISOString() };
  fs.writeFileSync(USER_META_PATH, JSON.stringify(meta, null, 1), { mode: 0o600 });

  // refresh the saved state (rotated cookies) only now that we know it is a signed-in one
  await context.storageState({ path: STORAGE_STATE_PATH, indexedDB: true });
  fs.chmodSync(STORAGE_STATE_PATH, 0o600);
  console.log(`[auth.setup] signed-in session verified; ${terms.size} account identifier(s) registered for redaction (values not shown).`);
  await context.close();
});
