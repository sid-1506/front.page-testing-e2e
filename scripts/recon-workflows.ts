/**
 * Read-only walk through the three workflows to learn the DOM and the API calls behind each step
 * (dev tool, not part of the suite). Never clicks Submit / Comment-submit / Vote / Follow / bookmark.
 *   npx tsx scripts/recon-workflows.ts [desktop|mobile] [wf1,wf2,wf3]
 */
import { chromium, type Page } from '@playwright/test';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'https://front.page';
const STATE = path.join(__dirname, '..', 'playwright', '.auth', 'user.json');
const mobile = process.argv[2] === 'mobile';
const which = (process.argv[3] || 'wf1,wf2,wf3').split(',');
const SHOTS = path.join(__dirname, '..', 'reports', 'screenshots', 'probe');

let log: string[] = [];
function watch(page: Page) {
  page.on('request', (r) => {
    try {
      const u = new URL(r.url());
      if (!/front\.page$/.test(u.hostname)) return;
      if (!['xhr', 'fetch', 'document'].includes(r.resourceType())) return;
      if (/get_all_unread_counts|inbox\/unreads/.test(u.pathname)) return;
      log.push(`${r.method()} ${u.pathname}${u.search ? '?' + [...u.searchParams.entries()].map(([k, v]) => `${k}=${/token|auth|key/i.test(k) ? '…' : v.slice(0, 40)}`).join('&') : ''} [${r.resourceType()}]`);
    } catch {
      /* ignore */
    }
  });
}
function flush(label: string) {
  console.log(`  requests during "${label}":${log.length ? '' : ' (none)'}`);
  for (const l of log) console.log('    ' + l);
  log = [];
}
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `wfrecon-${mobile ? 'm' : 'd'}-${name}.png`) }).catch(() => {});

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext(
    mobile
      ? { storageState: STATE, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' }
      : { storageState: STATE, viewport: { width: 1366, height: 768 } },
  );
  await ctx.addInitScript({ content: 'globalThis.__name = (f) => f;' });
  const page = await ctx.newPage();
  watch(page);
  const home = async () => {
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.getByPlaceholder(/what's your view on markets today\?/).waitFor({ timeout: 30000 });
    await page.waitForTimeout(2500);
    log = [];
  };
  const describe = (sel: string, max = 12) =>
    page.evaluate(
      ([s, m]) =>
        [...document.querySelectorAll(s as string)].slice(0, m as number).map((el) => {
          const r = el.getBoundingClientRect();
          const a: Record<string, string> = {};
          for (const at of ['role', 'aria-label', 'aria-pressed', 'aria-selected', 'aria-expanded', 'aria-haspopup', 'aria-controls', 'data-state', 'disabled', 'placeholder', 'href', 'type']) {
            const v = el.getAttribute(at);
            if (v != null) a[at] = v.slice(0, 60);
          }
          return `${el.tagName.toLowerCase()} ${JSON.stringify(a)} vis=${r.width > 0 && r.height > 0} text="${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70)}" class="${String(el.className).slice(0, 80)}"`;
        }),
      [sel, max],
    );
  const p = async (label: string, sel: string, max = 12) => {
    const d = await describe(sel, max);
    console.log(`  ${label} (${d.length}):`);
    d.forEach((x) => console.log('    ' + x));
  };

  if (which.includes('wf1')) {
    console.log('\n===== WF1 =====');
    await home();
    await page.getByPlaceholder(/what's your view on markets today\?/).click();
    await page.waitForURL(/create-post/, { timeout: 20000 }).catch(() => console.log('  !! URL did not become /post/create-post: ' + page.url()));
    await page.waitForTimeout(3000);
    console.log('  url:', page.url());
    flush('click composer');
    await p('headings', 'h1,h2,h3,[role=heading]');
    await p('comboboxes', '[role=combobox]');
    await p('textareas/inputs', 'main textarea, main input, textarea');
    await p('buttons in main', 'main button', 30);
    console.log('  "Loading clubs..." present:', await page.getByText('Loading clubs').count());
    await shot(page, 'wf1-create-post');
    const combo = page.getByRole('combobox').filter({ hasText: 'Post to Profile' });
    const opt = page.getByRole('option', { name: /^Stock Bets/ });
    console.log('  combobox "Post to Profile" count:', await combo.count(), ' options already visible:', await page.getByRole('option').count());
    console.log('  heading by role:', await page.getByRole('heading', { name: 'Create Post' }).count(), ' includeHidden:', await page.getByRole('heading', { name: 'Create Post', includeHidden: true }).count());
    if (!(await opt.count()) && (await combo.count())) {
      await combo.first().click();
      await page.waitForTimeout(2000);
      flush('open club selector');
    }
    console.log('  option names:', await page.getByRole('option').evaluateAll((els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40))));
    await p('listbox', '[role=listbox]');
    await shot(page, 'wf1-options');
    console.log('  option /^Stock Bets/ count:', await opt.count());
    if (await opt.count()) {
      await opt.first().click();
      await page.waitForTimeout(1500);
      flush('choose Stock Bets');
      await p('comboboxes after select', '[role=combobox]');
      console.log('  heading by role after select:', await page.getByRole('heading', { name: 'Create Post' }).count());
    } else await page.keyboard.press('Escape');
    await p('textareas/inputs after club select', 'main textarea, main input:not([type=file]), main [contenteditable=true]');
    await p('labels / hints', 'main label, main h2, main h3, main p', 12);
    await shot(page, 'wf1-after-select');
    const body = page.getByRole('main').locator('textarea');
    console.log('  placeholder locator count:', await page.getByPlaceholder('Share your insights...').count(), ' main textarea count:', await body.count());
    const submit = page.getByRole('button', { name: 'Submit' });
    console.log('  Submit count:', await submit.count(), 'disabled(empty):', await submit.first().isDisabled().catch(() => 'n/a'));
    if (await body.count()) {
      await body.first().click();
      await body.first().pressSequentially('PI Labs test post, please ignore', { delay: 30 });
      await page.waitForTimeout(2500);
      flush('type body');
      console.log('  Submit disabled(after typing):', await submit.first().isDisabled().catch(() => 'n/a'));
      await shot(page, 'wf1-filled');
      await body.first().fill('');
      await page.waitForTimeout(1500);
      flush('clear body');
      console.log('  body value after clear:', JSON.stringify(await body.first().inputValue()), ' Submit disabled:', await submit.first().isDisabled().catch(() => 'n/a'));
      console.log('  localStorage keys:', await page.evaluate(() => Object.keys(localStorage).map((k) => k.replace(/\d{5,}/g, '<id>'))));
    }
  }

  if (which.includes('wf2')) {
    console.log('\n===== WF2 =====');
    await home();
    await p('Hot/New buttons', 'main button:not(:has(svg))', 6);
    const postLinks = () => page.evaluate(() => [...document.querySelectorAll('main a[href]')].map((a) => a.getAttribute('href') || '').filter((h) => /^\/[a-z0-9-]+\/\d+$/.test(h)).slice(0, 6));
    console.log('  post links before:', await postLinks());
    const firstCard = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('main button')].find((b) => (b.textContent || '').trim() === 'Comment');
      let el: Element | null = btn || null;
      const chain: string[] = [];
      for (let i = 0; el && i < 8; i++, el = el.parentElement) chain.push(`${el.tagName.toLowerCase()}${el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : ''}.${String(el.className).split(/\s+/).slice(0, 3).join('.')}${el.getAttribute('data-post-id') ? '[data-post-id]' : ''} children=${el.children.length}`);
      return chain;
    });
    console.log('  ancestor chain of first Comment button:');
    firstCard.forEach((c) => console.log('    ' + c));
    const newBtn = page.getByRole('main').getByRole('button', { name: 'New', exact: true });
    console.log('  New button count:', await newBtn.count());
    await newBtn.click();
    await page.waitForTimeout(4000);
    flush('click New');
    console.log('  url:', page.url());
    console.log('  post links after:', await postLinks());
    await p('Hot/New buttons after', 'main button:not(:has(svg))', 6);
    const commentBtn = page.getByRole('main').getByRole('button', { name: 'Comment', exact: true });
    console.log('  Comment buttons in main:', await commentBtn.count());
    await commentBtn.first().click();
    await page.waitForTimeout(5000);
    flush('click Comment on first card');
    console.log('  url:', page.url(), ' title:', await page.title());
    await p('textareas', 'textarea, [contenteditable=true]');
    console.log('  Add a comment... count:', await page.getByPlaceholder('Add a comment...').count());
    console.log('  Sort by button count:', await page.getByRole('button', { name: /Sort by:/ }).count());
    console.log('  Vote-like buttons:', await page.getByRole('button', { name: /\d+ Votes?|^Vote$/ }).count());
    console.log('  buttons named Comment (exact):', await page.getByRole('button', { name: 'Comment', exact: true }).count());
    await p('buttons named Comment', 'button', 60).catch(() => {});
    const cb = page.getByRole('button', { name: 'Comment', exact: true }).last();
    console.log('  last Comment button disabled (empty):', await cb.isDisabled().catch(() => 'n/a'));
    const ta = page.getByPlaceholder('Add a comment...');
    if (await ta.count()) {
      await ta.first().click();
      await ta.first().pressSequentially('Test comment', { delay: 30 });
      await page.waitForTimeout(2000);
      flush('type comment');
      console.log('  buttons named Comment (exact) after typing:', await page.getByRole('button', { name: 'Comment', exact: true }).count());
      console.log('  last Comment button disabled (typed):', await cb.isDisabled().catch(() => 'n/a'));
      await shot(page, 'wf2-typed');
      await ta.first().fill('');
      await page.waitForTimeout(1000);
      flush('clear comment');
      console.log('  value after clear:', JSON.stringify(await ta.first().inputValue()), ' last Comment disabled:', await cb.isDisabled().catch(() => 'n/a'));
    }
    await shot(page, 'wf2-post');
  }

  if (which.includes('wf3')) {
    console.log('\n===== WF3 =====');
    await home();
    const search = page.getByRole('combobox', { name: 'Search stocks, communities, users...' });
    console.log('  search combobox count:', await search.count(), 'visible:', await search.first().isVisible().catch(() => false));
    if (!(await search.first().isVisible().catch(() => false))) {
      await p('header controls', 'header button, header a, header input', 20);
      console.log('  -> search box not visible at this viewport; trying header icon buttons (read-only)');
      const icons = page.locator('header button').filter({ hasNotText: /\S/ });
      console.log('  textless header buttons:', await icons.count());
      for (let i = 0; i < (await icons.count()); i++) {
        await icons.nth(i).click();
        await page.waitForTimeout(1200);
        const vis = await search.first().isVisible().catch(() => false);
        const anySearch = await page.locator('input[type=search]:visible, input[placeholder*="Search"]:visible').count();
        console.log(`    clicked textless header button #${i}: combobox visible=${vis}, visible search inputs=${anySearch}, url=${page.url()}`);
        if (vis || anySearch) break;
        await page.keyboard.press('Escape');
      }
      await p('search inputs now', 'input[type=search], input[placeholder*="Search"]');
      await shot(page, 'wf3-mobile-search');
    }
    const box = (await search.first().isVisible().catch(() => false)) ? search.first() : page.locator('input[type=search]:visible, input[placeholder*="Search"]:visible').first();
    await box.click();
    log = [];
    await box.pressSequentially('reliance', { delay: 120 });
    await page.waitForTimeout(3000);
    flush('type reliance');
    await p('listbox/options', '[role=listbox], [role=option]', 20);
    console.log('  text "Reliance Industries Ltd." count:', await page.getByText('Reliance Industries Ltd.').count());
    console.log('  text Search "reliance" count:', await page.getByText('Search "reliance"').count());
    await shot(page, 'wf3-suggestions');
    await page.getByText('Reliance Industries Ltd.').first().click();
    await page.waitForTimeout(6000);
    flush('click suggestion');
    console.log('  url:', page.url(), ' title:', (await page.title()).replace(/[\d.,]+/g, '#'));
    console.log('  heading RELIANCE count:', await page.getByRole('heading', { name: 'RELIANCE' }).count());
    console.log('  Updated..IST count:', await page.getByText(/Updated .* IST/).count());
    await p('headings', 'main h1, main h2, main h3');
    await p('main buttons', 'main button', 30);
    const postLinks = () => page.evaluate(() => [...document.querySelectorAll('main a[href]')].map((a) => a.getAttribute('href') || '').filter((h) => /\/\d+$/.test(h)).slice(0, 5));
    console.log('  post links:', await postLinks());
    await page.getByRole('main').getByRole('button', { name: 'Updates', exact: true }).click();
    await page.waitForTimeout(4000);
    flush('click Updates');
    console.log('  url:', page.url());
    console.log('  post links:', await postLinks());
    console.log('  corpannouncement/newsbot mentions:', await page.getByText(/corpannouncement|newsbot/i).count());
    await p('tab buttons after Updates', 'main button', 8);
    await shot(page, 'wf3-updates');
    await page.getByRole('main').getByRole('button', { name: 'Posts', exact: true }).click();
    await page.waitForTimeout(4000);
    flush('click Posts');
    console.log('  url:', page.url());
    console.log('  post links:', await postLinks());
    const filter = page.getByRole('button', { name: 'All Posts' });
    console.log('  All Posts button count:', await filter.count());
    await p('All Posts button', 'main button[aria-haspopup], button[aria-haspopup]');
    await filter.first().click();
    await page.waitForTimeout(1500);
    flush('open All Posts');
    await p('menu items', '[role=menu], [role=menuitem], [role=menuitemradio], [role=option], [role=listbox]', 20);
    console.log('  text Charts (exact) count:', await page.getByText('Charts', { exact: true }).count());
    await shot(page, 'wf3-filter-menu');
    await page.getByText('Charts', { exact: true }).first().click();
    await page.waitForTimeout(4000);
    flush('choose Charts');
    console.log('  url:', page.url());
    console.log('  post links:', await postLinks());
    await p('filter button after', 'main button[aria-haspopup], button[aria-haspopup]');
    await shot(page, 'wf3-charts');
  }
  await browser.close();
})().catch((e) => {
  console.error('recon error:', e.message.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
