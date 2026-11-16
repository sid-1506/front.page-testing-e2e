/** Dev tool: does CDP network emulation actually delay requests in this Chromium build? */
import { chromium } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    res.end('<html><body>ok</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await page.goto(local);
  const probe = async (label: string) => {
    const t = await page.evaluate(async (urls) => {
      const out: Record<string, number> = {};
      for (const u of urls) {
        const s = performance.now();
        try { await fetch(u, { mode: 'no-cors', cache: 'no-store' }); } catch (e) {}
        out[u.slice(0, 30)] = Math.round(performance.now() - s);
      }
      return out;
    }, [local + '?a=' + Math.random(), 'https://front.page/favicon.ico?x=' + Math.random()]);
    console.log(label, JSON.stringify(t));
  };
  await probe('warmup          ');
  await probe('no throttle     ');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 93750, connectionType: 'cellular4g' });
  await probe('legacy emulate  ');
  await probe('legacy emulate 2');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await probe('cleared         ');
  try {
    const r = await (cdp as any).send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{ urlPattern: '', latency: 150, downloadThroughput: 200000, uploadThroughput: 93750, connectionType: 'cellular4g' }] });
    console.log('byRule result', JSON.stringify(r));
    await probe('byRule emulate  ');
    await probe('byRule emulate 2');
  } catch (e) { console.log('byRule error', (e as Error).message.split('\n')[0]); }
  await browser.close();
  server.close();
})();
