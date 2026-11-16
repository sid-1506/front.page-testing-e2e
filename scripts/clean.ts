/**
 * Removes generated output before a run so stale numbers can never end up in a report.
 *   tsx scripts/clean.ts perf | lh | all
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const what = process.argv[2] || 'all';
const rm = (p: string) => fs.rmSync(path.join(ROOT, p), { recursive: true, force: true });
const rmMatching = (dir: string, re: RegExp) => {
  const d = path.join(ROOT, dir);
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) if (re.test(f)) fs.rmSync(path.join(d, f), { recursive: true, force: true });
};

if (what === 'perf' || what === 'all') {
  rmMatching('results/raw', /^(wf\d|pageload-)/);
  rm('results/post-url.json');
  rm('results/playwright-perf.json');
  rmMatching('reports/screenshots', /^(wf\d|pageload-|selftest)/);
  rm('reports/screenshots/probe');
  rm('playwright-report/perf');
}
if (what === 'lh' || what === 'all') {
  rmMatching('results/raw', /^lighthouse/);
  rm('results/playwright-lighthouse.json');
  rm('reports/lighthouse');
  rm('playwright-report/lighthouse');
}
if (what === 'all') {
  rm('results/metrics.json');
  rm('reports/perf-report.html');
  rm('test-results');
}
for (const d of ['results/raw', 'reports/screenshots', 'reports/lighthouse']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
console.log(`[clean] ${what} output removed`);
