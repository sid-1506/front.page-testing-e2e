// Dev helper: node scripts/print-run.js wf2 desktop [first|N]
const fs = require('fs');
const [id, profile, which = 'first'] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(`results/raw/${id}-${profile}.json`, 'utf8'));
const run = which === 'first' ? r.firstVisit : r.runs[Number(which) - 1];
if (!run) { console.log('no such run'); process.exit(0); }
console.log('passed', run.passed, '| error', run.error, '| totalMs', run.totalMs, '| wallMs', run.wallMs, '| entry', JSON.stringify(run.entry));
for (const s of run.steps) {
  console.log(`\nSTEP ${s.index} ${s.name} | ${s.status} | anchor: ${s.anchor}`);
  if (s.error) console.log('  ERROR', s.error.split('\n').slice(0, 6).join('\n        '));
  console.log(`  feedback ${s.clickToFeedbackMs} (${s.feedbackKind} @ ${(s.feedbackTarget || '').slice(0, 70)}) firstReq ${s.clickToFirstRequestMs} apiDone ${s.clickToApiDoneMs} uiReady ${s.clickToUiReadyMs} idle ${s.clickToNetworkIdleMs} LT ${s.longTasksMs} cls ${s.cls} shiftAll ${s.layoutShiftAll} ambient ${s.ambientMutations1s}`);
  console.log('  eventTiming', JSON.stringify(s.eventTiming), 'nav', JSON.stringify(s.navigation && { type: s.navigation.type, soft: s.navigation.softNavEntry, lcp: s.navigation.lcpMs }), 'milestones', JSON.stringify(s.milestones), 'typing', JSON.stringify(s.typing));
  console.log('  ui', JSON.stringify(s.uiConditions.map((u) => [u.description.slice(0, 50), u.ms])), 'expectApi', JSON.stringify(s.expectApi), 'actionability', s.actionabilityMs, 'wall', s.stepWallMs, 'parts', JSON.stringify(s.parts.map((p) => [p.at, p.feedbackMs])));
  for (const q of s.requests.filter((x) => x.firstParty && !x.polling && x.bucket !== 'img' && x.bucket !== 'js')) console.log('   ', q.method, q.path.slice(0, 60), q.status, '@' + q.startOffsetMs, 'dur', q.durationMs, q.resourceType, JSON.stringify(q.flags), q.serverTiming || '', q.encoding || '', q.responseBytes);
  const img = s.requests.filter((x) => x.bucket === 'img').length, js = s.requests.filter((x) => x.bucket === 'js').length;
  console.log(`  img ${img} js ${js} 3p ${s.requests.filter((x) => !x.firstParty).length} polling ${s.requests.filter((x) => x.polling).length} console ${s.console.length} pageErrors ${s.pageErrors.length}`, 'notCollected', JSON.stringify(Object.keys(s.notCollected)), 'extra', JSON.stringify(s.extra).slice(0, 700));
}
console.log('\ncleanup', JSON.stringify(run.cleanup));
console.log('writes', JSON.stringify(run.writes));
console.log('findings', r.findings.length, '| quality', JSON.stringify(r.quality.map((q) => ({ p: q.page, axe: q.axe && [q.axe.critical, q.axe.serious, q.axe.topRules.map((t) => t.id)], err: q.axeError, broken: q.brokenImages.length, mixed: q.mixedContent.length }))));
