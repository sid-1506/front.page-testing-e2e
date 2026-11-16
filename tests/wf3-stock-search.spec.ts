/**
 * wf3: Search a stock and read its page. Read-only workflow (no stop point).
 */
import { test, expect, expectAllRunsPassed, COMPOSER_RE } from '../lib/perf-fixture';
import { ui, feedSignature } from '../lib/measure-step';

const QUERY = 'reliance';
const KEY_DELAY_MS = 100;

test('wf3: search a stock and read its page', async ({ perf, session }) => {
  const { page } = session;

  const result = await perf.workflow(
    session,
    { id: 'wf3', name: 'Search a stock and read its page', startUrl: '/', entryReady: (p) => p.getByPlaceholder(COMPOSER_RE) },
    async (run) => {
      const main = page.getByRole('main');
      const search = page.getByRole('combobox', { name: 'Search stocks, communities, users...' });
      const searchVisible = ui.role(page, 'combobox', { name: 'Search stocks, communities, users...', exact: true });

      // ---- mobile only: the header search is collapsed behind an icon -------------------------------------
      if (!(await search.isVisible())) {
        const icon = page.locator('header button').filter({ hasNotText: /\S/ });
        const icons = await icon.count();
        run.finding(
          `wf3 step 1 (${perf.profile.name}, ${perf.profile.viewport.width}px): the spec locator getByRole("combobox", {name:"Search stocks, communities, users..."}) is in the DOM but hidden; ` +
            `the search box is collapsed behind an icon button in the header that has no accessible name or text (${icons} such button found). ` +
            'The test adds a step 0 that clicks that icon, then continues with the spec locator. Desktop does not need this step.',
        );
        // exactly one candidate, so this is not a guess about which icon opens the search
        expect(icons, 'unlabeled icon buttons in the header before opening search').toBe(1);
        await run.step('Open the collapsed header search (mobile layout only)', () => icon.first().click(), {
          index: 0,
          action: 'click',
          expectUi: [searchVisible],
          assert: async () => {
            await expect(search).toBeVisible();
          },
          extra: () => ({ mobileOnly: true, note: 'not part of the workflow spec; needed because the search box is collapsed at this viewport' }),
        });
      }

      // ---- step 1: type the query ----------------------------------------------------------------------------
      await run.step(
        `Type "${QUERY}" in the header search box`,
        async () => {
          await search.click();
          await search.pressSequentially(QUERY, { delay: KEY_DELAY_MS });
        },
        {
          index: 1,
          action: 'fill',
          expectUi: [ui.role(page, 'option', { hasText: `Search "${QUERY}"` }), ui.role(page, 'option', { hasText: 'Reliance Industries Ltd.' })],
          expectApi: /^\/api\/v1\/search$/,
          assert: async () => {
            await expect(page.getByText(`Search "${QUERY}"`)).toBeVisible();
            await expect(page.getByText('RELIANCE', { exact: true }).first()).toBeVisible();
            await expect(page.getByText('Reliance Industries Ltd.')).toBeVisible();
          },
          // keystroke-to-suggestions + debounce check
          extra: ({ requests, slice, lastKeyEpoch }) => {
            const keys = (slice?.interactions || []).filter((i) => i.type === 'keydown' && i.key === 'char').map((i) => i.t);
            const calls = requests.filter((r) => r.path === '/api/v1/search');
            const perCall = calls.map((r) => {
              let q: string | null = null;
              try {
                q = new URL(r.url).searchParams.get('q');
              } catch {
                /* keep null */
              }
              const typedBefore = keys.filter((t) => t <= r.startEpoch).length;
              const lastKeyBefore = keys.filter((t) => t <= r.startEpoch).pop();
              return {
                q,
                afterKeystroke: typedBefore,
                msAfterThatKeystroke: lastKeyBefore != null ? Math.round(r.startEpoch - lastKeyBefore) : null,
                durationMs: r.durationMs,
                status: r.status,
              };
            });
            const final = calls.filter((r) => r.endEpoch != null).pop();
            return {
              keystrokes: keys.length,
              keyDelayMs: KEY_DELAY_MS,
              searchCalls: calls.length,
              callsPerKeystroke: keys.length ? Math.round((calls.length / keys.length) * 100) / 100 : null,
              debounced: keys.length > 0 && calls.length < keys.length,
              calls: perCall,
              lastKeystrokeToSearchRequestMs: final && lastKeyEpoch != null ? Math.round(final.startEpoch - lastKeyEpoch) : null,
              lastKeystrokeToSearchResponseMs: final && lastKeyEpoch != null && final.endEpoch != null ? Math.round(final.endEpoch - lastKeyEpoch) : null,
              note: 'lastKeystrokeToSuggestionsMs is this step\'s clickToUiReadyMs (typing steps are anchored on the last keystroke)',
            };
          },
        },
      );

      // ---- step 2: open the RELIANCE stock page -------------------------------------------------------------
      const homeFeed = await feedSignature(page);
      await run.step("Click the suggestion 'RELIANCE' (Reliance Industries Ltd.)", () => page.getByText('Reliance Industries Ltd.').click(), {
        index: 2,
        action: 'click',
        isNavigation: true,
        expectUi: [ui.path(page, /^\/reliance\/?$/), ui.role(page, 'heading', { name: 'RELIANCE', exact: true }), ui.text(page, /Updated .* IST/, { within: 'main' }), ui.title(page, /^RELIANCE ₹/)],
        milestones: { stockPostList: [ui.feedChanged(page, homeFeed, 'post list of the stock page rendered')] },
        expectApi: /^\/api\/v2\/post\/feed\/all$/,
        assert: async () => {
          await expect(page).toHaveURL(/\/reliance\/?$/);
          await expect(page.getByRole('heading', { name: 'RELIANCE' })).toBeVisible();
          await expect(page.getByText(/Updated .* IST/)).toBeVisible();
          expect(await page.title()).toMatch(/^RELIANCE ₹/);
        },
      });
      await run.quality('Stock page (/reliance)');

      // ---- step 3: Updates tab --------------------------------------------------------------------------------
      const postsFeed = await feedSignature(page);
      await run.step("Click the 'Updates' button", () => main.getByRole('button', { name: 'Updates', exact: true }).click(), {
        index: 3,
        action: 'click',
        expectUi: [ui.feedChanged(page, postsFeed), ui.text(page, /corpannouncement|newsbot/i, { within: 'main' })],
        expectApi: /^\/api\/v2\/post\/feed\/updates$/,
        assert: async () => {
          await expect(main.getByText(/corpannouncement|newsbot/i).first()).toBeVisible();
        },
      });

      // ---- step 4: back to Posts ------------------------------------------------------------------------------
      const updatesFeed = await feedSignature(page);
      await run.step("Click the 'Posts' button", () => main.getByRole('button', { name: 'Posts', exact: true }).click(), {
        index: 4,
        action: 'click',
        expectUi: [ui.feedChanged(page, updatesFeed, 'post list switched from Updates back to community posts')],
        assert: async () => {
          await expect(main.getByRole('button', { name: /\d+ Votes?|^Vote$/ }).first()).toBeVisible();
          expect(await feedSignature(page), 'list differs from the Updates list').not.toBe(updatesFeed);
        },
      });

      // ---- step 5: filter All Posts -> Charts -------------------------------------------------------------------
      const specFilter = page.getByRole('button', { name: 'All Posts' });
      let filter = specFilter;
      if ((await specFilter.count()) === 0) {
        // Narrow layout: the button's long label is hidden and its accessible name is just "All".
        const narrow = main.getByRole('button', { name: 'All', exact: true });
        const n = await narrow.count();
        run.finding(
          `wf3 step 5 (${perf.profile.name}, ${perf.profile.viewport.width}px): the spec locator getByRole("button", {name:"All Posts"}) matches nothing; ` +
            `at this width the filter button is labelled "All" (the "All Posts" label is hidden). ${n} button named exactly "All" found in <main>; the test uses it. ` +
            'The menu items ("All Posts", "Charts") are unchanged.',
        );
        expect(n, 'filter button named "All" in <main> at the narrow layout').toBe(1);
        filter = narrow;
      }
      const allPostsFeed = await feedSignature(page);
      const chartsItemVisible = ui.role(page, 'menuitem', { name: 'Charts', exact: true });
      await run.step(
        "Open the 'All Posts' filter and choose 'Charts'",
        async () => {
          await filter.click();
          await chartsItemVisible.wait(perf.uiTimeoutMs);
          await page.getByText('Charts', { exact: true }).click();
        },
        {
          index: 5,
          action: 'select',
          expectUi: [ui.role(page, 'button', { name: /^Charts/, within: 'main' }), ui.feedChanged(page, allPostsFeed, 'post list re-rendered for the Charts filter')],
          expectApi: /^\/api\/v2\/post\/feed\/all$/,
          assert: async () => {
            await expect(main.getByRole('button', { name: /^Charts/ })).toBeVisible();
            await expect(filter).toHaveCount(0);
          },
        },
      );

      // success signal: /reliance with price header and post list rendered
      await expect(page).toHaveURL(/\/reliance\/?$/);
      await expect(page.getByRole('heading', { name: 'RELIANCE' })).toBeVisible();
      await expect(page.getByText(/Updated .* IST/)).toBeVisible();
      await expect(main.getByRole('button', { name: /\d+ Votes?|^Vote$/ }).first()).toBeVisible();

      // put the filter back so the next run starts from "All Posts" (read-only UI state)
      await run.cleanup("reset the filter to 'All Posts'", async () => {
        await main.getByRole('button', { name: /^Charts/ }).click();
        await page.getByRole('menuitem', { name: 'All Posts' }).click();
        await expect(filter).toBeVisible();
        return 'filter back on All Posts';
      });
    },
  );

  expectAllRunsPassed(result);
});
