/**
 * wf1: Create a post in a club.
 * SAFETY: the Submit button is never clicked (stop point). The typed text is cleared before leaving.
 */
import { test, expect, expectAllRunsPassed, COMPOSER_RE } from '../lib/perf-fixture';
import { ui } from '../lib/measure-step';

const BODY = 'PI Labs test post, please ignore';

test('wf1: create a post in a club (publish skipped)', async ({ perf, session }) => {
  const { page } = session;

  const result = await perf.workflow(
    session,
    { id: 'wf1', name: 'Create a post in a club', startUrl: '/', entryReady: (p) => p.getByPlaceholder(COMPOSER_RE) },
    async (run) => {
      await run.quality('Home Feed (/)');

      // spec locators
      const composer = page.getByPlaceholder(COMPOSER_RE);
      const clubCombo = page.getByRole('combobox').filter({ hasText: 'Post to Profile' });
      const stockBets = page.getByRole('option', { name: /^Stock Bets/ });
      const specBody = page.getByPlaceholder('Share your insights...');
      const submit = page.getByRole('button', { name: 'Submit' });
      const stockBetsVisible = ui.role(page, 'option', { name: /^Stock Bets/ });

      // ---- step 1: click the home composer -> /post/create-post ------------------------------------
      await run.step('Click the home composer textarea', () => composer.click(), {
        index: 1,
        action: 'click',
        isNavigation: true,
        expectUi: [ui.path(page, /^\/post\/create-post\/?$/), ui.role(page, 'heading', { name: 'Create Post', exact: true })],
        milestones: { clubListOpen: [stockBetsVisible] },
        expectApi: /^\/api\/v1\/pub\/discover_clubs_to_post/,
        assert: async () => {
          await expect(page).toHaveURL(/\/post\/create-post\/?$/);
          // The club list auto-opens on this page and Radix then marks the rest of the page aria-hidden,
          // so the heading is on screen but not in the accessibility tree: check what the user sees here,
          // and the spec's exact role locator in step 2 once the list has closed.
          await expect(page.getByRole('heading', { name: 'Create Post', includeHidden: true })).toBeVisible();
        },
      });

      // The textarea as the spec identifies it (before a club is chosen), to prove later it is the same field.
      const originalBody = await specBody.elementHandle({ timeout: 5000 }).catch(() => null);

      // ---- step 2: choose the club "Stock Bets" ------------------------------------------------------
      let listWasOpen = false;
      await run.step(
        'Select club "Stock Bets" in the club selector',
        async () => {
          listWasOpen = await stockBets.isVisible();
          if (!listWasOpen) {
            await clubCombo.click(); // spec path: open the selector first
            await stockBetsVisible.wait(perf.uiTimeoutMs);
          }
          await stockBets.click();
        },
        {
          index: 2,
          action: 'select',
          expectUi: [ui.role(page, 'combobox', { hasText: /^Stock Bets$/, within: 'main' })],
          expectApi: /^\/api\/v1\/pub\/details/,
          assert: async () => {
            await expect(page.getByRole('main').getByRole('combobox')).toHaveText('Stock Bets');
            await expect(page.getByRole('heading', { name: 'Create Post' })).toBeVisible(); // spec's step-1 locator, literal
          },
        },
      );
      await run.quality('Create Post (/post/create-post)');
      if (listWasOpen)
        run.finding(
          'wf1 step 2: the club selector is already open when /post/create-post loads (it auto-opens, also on a direct page load). ' +
            'While it is open the rest of the page is aria-hidden, so the spec locator getByRole("combobox").filter({hasText:"Post to Profile"}) matches nothing. ' +
            'The test therefore skips the "open" click and picks the option with the spec locator getByRole("option", {name:/^Stock Bets/}). ' +
            'Consequence for users: the heading and form are not reachable by assistive tech until a club is chosen or the list is dismissed.',
        );

      // ---- step 3: type the post body ---------------------------------------------------------------
      const body = page.getByRole('main').locator('textarea');
      const specStillMatches = (await specBody.count()) > 0;
      const sameNode = originalBody ? await originalBody.evaluate((el) => el.isConnected && el === document.querySelector('main textarea')).catch(() => false) : null;
      if (!specStillMatches)
        run.finding(
          'wf1 step 3: after choosing "Stock Bets" the body textarea no longer has the placeholder "Share your insights..." (it becomes a club-specific prompt), ' +
            `so the spec locator getByPlaceholder("Share your insights...") matches nothing. The test types into the only <textarea> in <main>` +
            (sameNode === true ? ', verified to be the same DOM node the spec locator pointed at before the club was chosen.' : sameNode === false ? ' (a different DOM node than before the club was chosen).' : '.'),
        );
      await run.step(
        'Type the post body',
        async () => {
          await expect(body).toHaveCount(1);
          await expect(submit, 'Submit must be disabled while the body is empty').toBeDisabled();
          await body.click();
          await body.pressSequentially(BODY, { delay: 40 });
        },
        {
          index: 3,
          action: 'fill',
          expectUi: [ui.role(page, 'button', { name: 'Submit', exact: true, enabled: true })],
          assert: async () => {
            await expect(body).toHaveValue(BODY);
            await expect(submit).toBeEnabled();
          },
          extra: () => ({ specPlaceholderLocatorMatches: specStillMatches, sameTextareaNodeAsSpecLocator: sameNode }),
        },
      );

      // ---- step 4: Submit (STOP POINT: never clicked) -------------------------------------------------
      await run.stopPoint('Click Submit', {
        index: 4,
        action: 'click',
        reason: 'would publish a public post',
        verify: async () => {
          await expect(submit).toBeVisible();
          await expect(submit).toBeEnabled();
        },
      });

      // success signal + cleanup
      await expect(page.getByRole('main').getByRole('combobox')).toHaveText('Stock Bets');
      await run.cleanup('clear the post textarea so no draft is left behind', async () => {
        await body.fill('');
        await expect(body).toHaveValue('');
        await expect(submit).toBeDisabled();
        return 'textarea emptied, Submit disabled again';
      });
    },
  );

  expectAllRunsPassed(result);
});
