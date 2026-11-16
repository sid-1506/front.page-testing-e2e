/**
 * wf2: Open a post from the feed and join the discussion.
 * SAFETY: the comment is typed but never submitted (stop point) and cleared afterwards.
 * Never clicked here: Vote / "N Votes", Follow, bookmark.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, expectAllRunsPassed, COMPOSER_RE, RESULTS_DIR, writeJson } from '../lib/perf-fixture';
import { ui, feedSignature } from '../lib/measure-step';

const COMMENT = 'Test comment';
const POST_PATH_RE = /^\/[a-z0-9-]+\/\d+$/;
const VOTE_RE = /^(\d+ Votes?|Vote)$/;

test('wf2: open a post from the feed and join the discussion (comment skipped)', async ({ perf, session }) => {
  const { page } = session;

  const result = await perf.workflow(
    session,
    { id: 'wf2', name: 'Open a post from the feed and join the discussion', startUrl: '/', entryReady: (p) => p.getByPlaceholder(COMPOSER_RE) },
    async (run) => {
      const main = page.getByRole('main');
      const newTab = main.getByRole('button', { name: 'New', exact: true });
      const firstComment = main.getByRole('button', { name: 'Comment', exact: true }).first();
      const commentBox = page.getByPlaceholder('Add a comment...');
      const sortBy = page.getByRole('button', { name: /Sort by:/ });
      const voteButton = page.getByRole('button', { name: /\d+ Votes?|^Vote$/ });
      const commentSubmit = page.getByRole('button', { name: 'Comment', exact: true }).last();

      // ---- step 1: sort the feed by New ----------------------------------------------------------------
      const hotFeed = await feedSignature(page);
      await run.step('Click the feed sort button "New"', () => newTab.click(), {
        index: 1,
        action: 'click',
        expectUi: [ui.feedChanged(page, hotFeed, 'feed re-rendered with different post cards'), ui.role(page, 'button', { name: 'Comment', exact: true, within: 'main' })],
        milestones: { urlTabNew: [ui.url(page, /[?&]tab=new/)] },
        expectApi: /^\/_root\.data$/,
        assert: async () => {
          await expect(firstComment).toBeVisible();
          expect(await feedSignature(page), 'post list changed after choosing New').not.toBe(hotFeed);
        },
      });

      // ---- step 2: open the first post through its Comment button ----------------------------------------
      const commentSection = [
        ui.placeholder(page, 'Add a comment...', { exact: true }),
        ui.role(page, 'button', { name: /Sort by:/ }),
        ui.role(page, 'button', { name: VOTE_RE, within: 'main' }),
      ];
      const step2 = await run.step("Click 'Comment' on the first post card", () => firstComment.click(), {
        index: 2,
        action: 'click',
        isNavigation: true,
        expectUi: [ui.path(page, POST_PATH_RE, 'URL is a post page (/club/123)'), ui.placeholder(page, 'Add a comment...', { exact: true })],
        milestones: { commentSection },
        expectApi: /^\/api\/v2\/post\/comments/,
        assert: async () => {
          expect(new URL(page.url()).pathname).toMatch(POST_PATH_RE);
          await expect(commentBox).toBeVisible();
        },
      });
      // the post page URL doubles as the page-load target "post page"
      const postUrlFile = path.join(RESULTS_DIR, 'post-url.json');
      if (!fs.existsSync(postUrlFile)) writeJson(postUrlFile, { path: new URL(page.url()).pathname, source: `wf2 step 2 (${perf.profile.name})`, at: new Date().toISOString() });
      await run.quality('Post page (/club/post-id)');

      // ---- step 3: comment section is rendered (no interaction; timed from the step-2 click) ---------------
      await run.waitStep('Wait for the comment section', {
        index: 3,
        from: step2,
        milestone: 'commentSection',
        description: 'comment box, "Sort by:" and the vote button visible',
        assert: async () => {
          await expect(commentBox).toBeVisible();
          await expect(sortBy).toBeVisible();
          await expect(voteButton.first()).toBeVisible();
          // post body: the card around the vote button carries the post text
          const card = await feedSignature(page);
          expect(card.length, 'post body text is rendered next to the vote button').toBeGreaterThan(20);
        },
      });

      // ---- step 4: type a comment ------------------------------------------------------------------------
      await run.step(
        'Type a comment',
        async () => {
          await expect(commentSubmit, 'comment submit must be disabled while the box is empty').toBeDisabled();
          await commentBox.click();
          await commentBox.pressSequentially(COMMENT, { delay: 40 });
        },
        {
          index: 4,
          action: 'fill',
          expectUi: [ui.role(page, 'button', { name: 'Comment', exact: true, pick: 'last', enabled: true, minCount: 2 })],
          assert: async () => {
            await expect(commentBox).toHaveValue(COMMENT);
            await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(2);
            await expect(commentSubmit).toBeEnabled();
          },
        },
      );

      // ---- step 5: submit the comment (STOP POINT: never clicked) -------------------------------------------
      await run.stopPoint('Click the comment submit button', {
        index: 5,
        action: 'click',
        reason: 'would publish a public comment',
        verify: async () => {
          await expect(commentSubmit).toBeVisible();
          await expect(commentSubmit).toBeEnabled();
        },
      });

      // success signal + cleanup
      await expect(voteButton.first()).toBeVisible();
      await expect(commentBox).toBeVisible();
      await run.cleanup('clear the comment textarea', async () => {
        await commentBox.fill('');
        await expect(commentBox).toHaveValue('');
        await expect(commentSubmit).toBeDisabled();
        return 'comment box emptied, submit disabled again';
      });
    },
  );

  expectAllRunsPassed(result);
});
