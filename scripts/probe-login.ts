/**
 * Opens the site logged out and reports what the login screen offers.
 * Read-only: clicks only "Login"/"Sign in" style entry points, never submits anything.
 *   npx tsx scripts/probe-login.ts
 */
import { chromium, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'https://front.page';
const OUT = path.join(__dirname, '..', 'reports', 'screenshots', 'probe');

async function dump(page: Page, label: string) {
  const info = await page.evaluate(() => {
    const vis = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const txt = (el: Element) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return {
      url: location.href,
      title: document.title,
      buttons: [...document.querySelectorAll('button,[role=button]')].filter(vis).map((b) => txt(b) || b.getAttribute('aria-label') || '(no text)').slice(0, 60),
      links: [...document.querySelectorAll('a[href]')].filter(vis).map((a) => `${txt(a)} -> ${a.getAttribute('href')}`).slice(0, 60),
      inputs: [...document.querySelectorAll('input,textarea,select')].filter(vis).map((i) => ({
        tag: i.tagName.toLowerCase(),
        type: i.getAttribute('type'),
        name: i.getAttribute('name'),
        placeholder: i.getAttribute('placeholder'),
        autocomplete: i.getAttribute('autocomplete'),
        ariaLabel: i.getAttribute('aria-label'),
      })),
      iframes: [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src') || f.getAttribute('title') || '(inline)').slice(0, 20),
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(txt).slice(0, 20),
      dialogs: [...document.querySelectorAll('[role=dialog]')].filter(vis).map((d) => txt(d).slice(0, 300)),
    };
  });
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: false });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  // tsx (esbuild keepNames) wraps named functions in __name(); shim it for page.evaluate bodies.
  await ctx.addInitScript({ content: 'globalThis.__name = (f) => f;' });
  const page = await ctx.newPage();
  const redirects: string[] = [];
  page.on('response', (r) => {
    if (r.request().isNavigationRequest() && r.status() >= 300 && r.status() < 400) redirects.push(`${r.status()} ${r.url()} -> ${r.headers()['location']}`);
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await dump(page, '01-home-logged-out');
  console.log('redirects:', redirects);

  // Look for a login entry point.
  const candidates = [
    page.getByRole('button', { name: /^(log ?in|sign ?in)$/i }),
    page.getByRole('link', { name: /^(log ?in|sign ?in)$/i }),
    page.getByRole('button', { name: /log ?in|sign ?in|sign ?up|get started|join/i }),
    page.getByRole('link', { name: /log ?in|sign ?in|sign ?up|get started|join/i }),
  ];
  let clicked = false;
  for (const c of candidates) {
    const n = await c.count();
    if (n > 0) {
      console.log(`login entry candidate matched (${n}): ${await c.first().textContent()}`);
      await c.first().click();
      clicked = true;
      break;
    }
  }
  if (!clicked) console.log('no login entry point found by role/name');
  await page.waitForTimeout(3500);
  await dump(page, '02-after-login-click');

  // Also try common direct routes.
  for (const route of ['/login', '/signin', '/auth/login']) {
    const resp = await page.goto(BASE + route, { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForTimeout(2500);
    console.log(`\nroute ${route}: status ${resp?.status()} final ${page.url()}`);
    await dump(page, `03-route${route.replace(/\//g, '_')}`);
  }
  await browser.close();
})();
