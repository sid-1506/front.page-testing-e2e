/**
 * Self-test: proves measureStep records sane numbers on one step whose true timings are known.
 *
 * A local page does, on click:   80 ms of main-thread work
 *                               -> "working" indicator 120 ms later            (feedback   >= ~200 ms)
 *                               -> GET /api/v1/slow (server delays 300 ms)
 *                               -> then GET /api/v1/second (150 ms): a waterfall (API done  >= ~530 ms)
 *                               -> 100 ms later inserts a banner + "Done"      (UI ready   >= ~630 ms)
 * It also polls /api/v1/inbox/unreads every 200 ms, which must be tagged `polling` and ignored for idle,
 * and has live "price tickers" that mutate the DOM on their own, which must not be mistaken for feedback.
 *
 *   npx playwright test --project=selftest --project=selftest-mobile
 */
import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Perf } from '../lib/perf-fixture';
import { measureStep, ui } from '../lib/measure-step';
import { applyProfile, clearThrottling } from '../lib/throttling';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>selftest</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font:16px sans-serif;margin:16px">
<div class="row"><span class="price">0</span></div><div class="row"><span class="price">0</span></div>
<button id="go" style="padding:12px 20px">Go</button>
<div id="slot"></div>
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Paragraph that will be pushed down.</p>
<p>Second paragraph, also pushed down by the banner.</p>
<script>
  setInterval(function(){ fetch('/api/v1/inbox/unreads').catch(function(){}); }, 200);
  // live tickers: the first one ticks every 70 ms; the second one only starts ticking 30 ms after the click
  var prices = document.querySelectorAll('.price'), n = 0;
  setInterval(function(){ prices[0].textContent = String(++n); }, 70);
  document.getElementById('go').addEventListener('click', function () {
    var end = performance.now() + 80; while (performance.now() < end) {}        // 80 ms long task
    setTimeout(function(){ prices[1].textContent = 'tick'; }, 30);               // same structure as the known ticker
    setTimeout(function () {
      var w = document.createElement('div'); w.id = 'working'; w.textContent = 'working…';
      document.getElementById('slot').appendChild(w);
    }, 120);
    fetch('/api/v1/slow?token=QUERY-SECRET-VALUE').then(function (r) { return r.json(); })
      .then(function () { return fetch('/api/v1/second', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ note: 'hi', password: 'hunter2hunter2' }) }); })
      .then(function (r) { return r.json(); })
      .then(function () {
        setTimeout(function () {
          var b = document.createElement('div'); b.id = 'banner'; b.style.cssText = 'height:200px;background:#cde';
          document.body.insertBefore(b, document.body.firstChild);
          var d = document.createElement('div'); d.id = 'done'; d.textContent = 'Done';
          document.getElementById('slot').appendChild(d);
        }, 100);
      });
  });
</script></body></html>`;

let server: http.Server;
let origin = '';

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url || '/';
    const json = (ms: number, body: unknown) =>
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json', 'server-timing': 'db;dur=12.5, app;dur=3' });
        res.end(JSON.stringify(body));
      }, ms);
    if (url.startsWith('/api/v1/slow'))
      return json(300, { ok: true, token: 'SECRET-TOKEN-123456', nested: { api_key: 'KEY-ABCDEF-999', visible: 'keep-me' }, user: ['id', 4242424242, 'display_name', 'Selftest Person'], 'active:4242424242': 1, filler: 'x'.repeat(1500) });
    if (url.startsWith('/api/v1/second')) return json(150, { ok: true });
    if (url.startsWith('/api/v1/inbox/unreads')) return json(5, { unread: 0 });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

test('measureStep records sane numbers for a step with known timings', async ({ browser, context, page }, testInfo) => {
  const perf = new Perf(browser, testInfo, new URL(origin).host);
  perf.redactor.addUserTerms(['Selftest Person', '4242424242']); // stand-ins for the account's name and numeric id
  const s = await perf.instrument(context, page);
  const throttled = perf.profile.name === 'mobile-slow4g';
  // CDP network emulation: `latency` is a floor on time-to-headers, not an additive delay.
  const floor = throttled ? 150 : 0;

  await page.goto(origin + '/');
  await page.waitForTimeout(600);

  // CPU throttle check: the same fixed amount of work, unthrottled vs under the profile
  const work = () => {
    const t = performance.now();
    let x = 0;
    for (let i = 0; i < 4e7; i++) x += i % 7;
    return performance.now() - t + (x > 0 ? 0 : 0);
  };
  await clearThrottling(s.cdp);
  const base = await page.evaluate(work);
  await applyProfile(s.cdp, perf.profile);
  const withProfile = await page.evaluate(work);
  const cpuFactor = withProfile / base;
  console.log(`[selftest ${perf.profile.name}] fixed CPU work: ${base.toFixed(1)} ms unthrottled, ${withProfile.toFixed(1)} ms under profile => x${cpuFactor.toFixed(2)}`);
  if (throttled) expect(cpuFactor, 'CPU throttling (4x) is applied').toBeGreaterThan(2.5);
  else expect(cpuFactor, 'no CPU throttling on desktop').toBeLessThan(1.8);

  const ctx = perf.stepContext(s, `selftest-${perf.profile.name}`, 'selftest');
  const rec = await measureStep(ctx, 'click Go', () => page.locator('#go').click(), {
    index: 1,
    action: 'click',
    expectUi: [ui.css(page, '#done', { hasText: 'Done' })],
    milestones: { working: [ui.css(page, '#working')] },
    expectApi: /^\/api\/v1\/slow/,
  });

  const slow = rec.requests.find((r) => r.path === '/api/v1/slow')!;
  const second = rec.requests.find((r) => r.path === '/api/v1/second')!;
  const polls = rec.requests.filter((r) => r.path === '/api/v1/inbox/unreads');
  console.log(
    `[selftest ${perf.profile.name}] ` +
      JSON.stringify({
        anchor: rec.anchor,
        clickToFeedbackMs: rec.clickToFeedbackMs,
        clickToAnyMutationMs: rec.clickToAnyMutationMs,
        ambientMutationsSkipped: rec.ambientMutationsSkipped,
        feedbackTarget: rec.feedbackTarget,
        eventTiming: rec.eventTiming,
        clickToFirstRequestMs: rec.clickToFirstRequestMs,
        clickToApiDoneMs: rec.clickToApiDoneMs,
        clickToUiReadyMs: rec.clickToUiReadyMs,
        clickToNetworkIdleMs: rec.clickToNetworkIdleMs,
        milestoneWorking: rec.milestones.working,
        longTasksMs: rec.longTasksMs,
        cls: rec.cls,
        layoutShiftAll: rec.layoutShiftAll,
        clock: rec.clock,
        actionabilityMs: rec.actionabilityMs,
        slow: { timing: slow?.timing, offset: slow?.startOffsetMs, flags: slow?.flags },
        second: { timing: second?.timing, offset: second?.startOffsetMs, flags: second?.flags, sequentialAfter: second?.sequentialAfter },
        polls: polls.length,
        notCollected: rec.notCollected,
      }),
  );

  // the anchor is the real in-page pointerdown, and the two clocks agree
  expect(rec.anchor).toBe('first pointerdown');
  expect(Math.abs(rec.clock.skewMs as number), 'page clock vs node clock').toBeLessThan(throttled ? 120 : 50);

  // feedback: 80 ms busy loop + 120 ms timer
  expect(rec.clickToFeedbackMs).toBeGreaterThanOrEqual(190);
  expect(rec.clickToFeedbackMs).toBeLessThan(throttled ? 900 : 450);
  expect(rec.feedbackTarget).toContain('slot');
  // the tickers mutated first and were recognised as ambient (including the one that had never ticked before)
  expect(rec.clickToAnyMutationMs, 'a ticker mutation came before the real feedback').toBeLessThan(rec.clickToFeedbackMs as number);
  expect(rec.ambientMutationsSkipped).toBeGreaterThanOrEqual(1);
  // frame-accurate UI detection: within ~2 frames of the DOM mutation that made it true
  expect(rec.milestones.working).toBeGreaterThanOrEqual(rec.clickToFeedbackMs as number);
  expect((rec.milestones.working as number) - (rec.clickToFeedbackMs as number), 'UI detection lag after the DOM change').toBeLessThan(throttled ? 120 : 50);

  // Event Timing: the click handler burned >= 80 ms
  expect(rec.eventTiming, 'event timing entry').not.toBeNull();
  expect(rec.eventTiming!.processing).toBeGreaterThanOrEqual(70);
  expect(rec.eventTiming!.duration).toBeGreaterThanOrEqual(80);
  expect(rec.longTasksMs).toBeGreaterThanOrEqual(70);

  // network: first request after the busy loop; slow (300) then second (150) in sequence
  expect(rec.clickToFirstRequestMs).toBeGreaterThanOrEqual(70);
  expect(rec.clickToFirstRequestMs).toBeLessThan(throttled ? 900 : 300);
  expect(slow.timing!.wait).toBeGreaterThanOrEqual(290);
  expect(slow.timing!.total).toBeLessThan(300 + (throttled ? 900 : 300));
  expect(second.timing!.wait).toBeGreaterThanOrEqual(Math.max(140, floor - 10));
  expect(second.flags).toContain('sequential');
  expect(second.flags).toContain('write');
  expect(slow.flags).toContain('slow'); // > apiReadMs warn budget (300 ms)
  expect(slow.serverTiming).toBe('db;dur=12.5, app;dur=3');
  expect(rec.expectApi).toEqual({ pattern: String(/^\/api\/v1\/slow/), matched: true, calls: 1 });

  const minApi = 80 + 300 + 150;
  expect(rec.clickToApiDoneMs).toBeGreaterThanOrEqual(minApi);
  expect(rec.clickToApiDoneMs).toBeLessThan(minApi + (throttled ? 800 : 200));
  // "Done" appears 100 ms after the last response: UI ready must be ~100 ms after API done
  expect((rec.clickToUiReadyMs as number) - (rec.clickToApiDoneMs as number)).toBeGreaterThanOrEqual(90);
  expect((rec.clickToUiReadyMs as number) - (rec.clickToApiDoneMs as number)).toBeLessThan(throttled ? 300 : 160);
  expect(rec.clickToNetworkIdleMs).toBe(rec.clickToApiDoneMs);
  expect(rec.networkIdleReached, 'idle reached although the page polls every 200 ms').toBe(true);

  // polling is tagged and excluded
  expect(polls.length).toBeGreaterThan(0);
  expect(polls.every((p) => p.flags.includes('polling'))).toBe(true);

  // network throttling: a ~5 ms request is held to the profile's latency floor
  const pollWaits = polls.filter((p) => p.timing).map((p) => p.timing!.wait).sort((x, y) => x - y);
  const medianPoll = pollWaits[Math.floor(pollWaits.length / 2)];
  console.log(`[selftest ${perf.profile.name}] median wait of the 5 ms polling endpoint: ${medianPoll} ms (profile latency floor ${floor} ms)`);
  if (throttled) expect(medianPoll, 'network latency emulation is applied').toBeGreaterThanOrEqual(140);
  else expect(medianPoll, 'no network throttling on desktop').toBeLessThan(60);

  // the banner inserted ~630 ms after the click is an unexpected layout shift
  expect(rec.cls).toBeGreaterThan(0);

  // redaction: secrets never reach the record
  const dump = JSON.stringify(rec);
  for (const secret of ['SECRET-TOKEN-123456', 'KEY-ABCDEF-999', 'hunter2hunter2', 'QUERY-SECRET-VALUE', 'Selftest Person', '4242424242']) expect(dump, `secret ${secret.slice(0, 6)}… must be redacted`).not.toContain(secret);
  expect(slow.responsePreview!.text).toContain('keep-me');
  expect(slow.responsePreview!.text).toContain('[REDACTED]');
  expect(slow.responsePreview!.text).toContain('[test-user]'); // name as a string, id as a bare number and inside a key
  expect(second.payload!.text).toContain('"note":"hi"');
  expect(slow.url).toContain('token=[REDACTED]');
  expect(rec.screenshot).toMatch(/screenshots\/selftest-.*step1\.jpg$/);
});
