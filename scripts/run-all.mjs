#!/usr/bin/env node
/**
 * npm run all: test:perf -> test:lh -> report, in that order.
 * A failing test is a finding, not a reason to stop: the later stages always run, and the report is built
 * from whatever was measured. Exit code: non-zero if the report's redaction gate fails, or if any test failed.
 */
import { spawnSync } from 'node:child_process';

const run = (script) => {
  console.log(`\n=== npm run ${script} ===`);
  const started = Date.now();
  const r = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(`=== ${script}: exit ${r.status} after ${Math.round((Date.now() - started) / 1000)} s ===`);
  return r.status ?? 1;
};

const perf = run('test:perf');
const lh = run('test:lh');
const report = run('report');

console.log(`\nSummary: test:perf ${perf === 0 ? 'passed' : 'had failures (recorded in the report)'}, test:lh ${lh === 0 ? 'passed' : 'had failures (recorded in the report)'}, report ${report === 0 ? 'built' : 'FAILED'}`);
console.log('Report: reports/perf-report.html');
process.exit(report !== 0 ? report : perf !== 0 || lh !== 0 ? 1 : 0);
