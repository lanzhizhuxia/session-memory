import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compileDecisionsArchiveView,
  DECISIONS_ARCHIVE_BUDGET,
  compileDecisionsView,
  DECISIONS_BUDGET,
} from '../src/canonical/views/decisions.js';
import type { CanonicalSignal, PublishedView } from '../src/canonical/types.js';

const sandboxDir = process.argv[2];
if (sandboxDir == null || sandboxDir.length === 0) {
  console.error('usage: sandbox-extract.ts <sandboxDir>');
  process.exit(2);
}
const stateDir = path.join(sandboxDir, '.state');
const signalsPath = path.join(stateDir, 'signals.json');
const manifestPath = path.join(stateDir, 'publish-manifest.json');

if (!fs.existsSync(signalsPath)) {
  console.error(`signals.json not found at ${signalsPath}`);
  process.exit(2);
}

console.log(`reading ${signalsPath}...`);
const allSignals = JSON.parse(fs.readFileSync(signalsPath, 'utf8')) as CanonicalSignal[];
console.log(`  total signals: ${allSignals.length}`);

const decisions = allSignals.filter((s) => s.kind === 'decision');
const decisionsActive = decisions.filter((s) => s.status === 'active');
console.log(`  decision signals: ${decisions.length} total, ${decisionsActive.length} active`);

const sourceSummary = `sandbox(${decisions.length} decision signals)`;

console.log('\n=== running OLD path (compileDecisionsView, top-50 + maxChars 16KB) ===');
const oldView = await compileDecisionsView(
  allSignals,
  DECISIONS_BUDGET,
  sourceSummary,
  undefined,
  undefined,
);
console.log(`  oldView.sourceSignalIds: ${oldView.sourceSignalIds.length}`);
console.log(`  oldView.markdown: ${oldView.markdown.length} chars`);
fs.writeFileSync(path.join(sandboxDir, '决策日志.OLD.md'), oldView.markdown);

console.log('\n=== running NEW path (compileDecisionsArchiveView, archive_by_month 12) ===');
const newResult = await compileDecisionsArchiveView(
  allSignals,
  DECISIONS_ARCHIVE_BUDGET,
  sourceSummary,
  undefined,
  undefined,
);
console.log(`  newView.sourceSignalIds: ${newResult.view.sourceSignalIds.length}`);
console.log(`  newView.markdown (main): ${newResult.view.markdown.length} chars`);
console.log(`  newResult.archiveMarkdown: ${newResult.archiveMarkdown.length} chars`);
console.log(`  archiveIndex entries: ${newResult.view.archiveIndex?.length ?? 0}`);
fs.writeFileSync(path.join(sandboxDir, '决策日志.md'), newResult.view.markdown);
const archivePath = newResult.view.archiveFile;
if (archivePath != null && newResult.archiveMarkdown.length > 0) {
  const archiveAbs = path.join(sandboxDir, archivePath);
  fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
  fs.writeFileSync(archiveAbs, newResult.archiveMarkdown);
}

console.log('\n=== diff: signals visible in OLD vs NEW ===');
const oldVisibleIds = new Set(oldView.sourceSignalIds);
const newVisibleIds = new Set(newResult.view.sourceSignalIds);
const onlyInNew = [...newVisibleIds].filter((id) => !oldVisibleIds.has(id));
const onlyInOld = [...oldVisibleIds].filter((id) => !newVisibleIds.has(id));
console.log(`  signals visible only in NEW: ${onlyInNew.length}`);
console.log(`  signals visible only in OLD: ${onlyInOld.length}`);
console.log(`  signals visible in BOTH: ${[...oldVisibleIds].filter((id) => newVisibleIds.has(id)).length}`);

console.log('\n=== sample of decisions recovered by NEW path (first 5) ===');
const recoveredById = new Map(decisionsActive.map((s) => [s.id, s]));
for (const id of onlyInNew.slice(0, 5)) {
  const s = recoveredById.get(id);
  if (s == null || s.kind !== 'decision') continue;
  const date = s.lastSeenAt > 0 ? new Date(s.lastSeenAt).toISOString().slice(0, 10) : '?';
  console.log(`  - [${date}] ${s.projectNames[0] ?? '?'} :: ${s.payload.topic.slice(0, 60)}`);
}

console.log('\n=== verification ===');
const allActiveIds = new Set(decisionsActive.map((s) => s.id));
const newCovered = new Set(newResult.view.sourceSignalIds);
const missing: string[] = [];
for (const id of allActiveIds) {
  if (!newCovered.has(id)) missing.push(id);
}
console.log(`  active decisions: ${allActiveIds.size}`);
console.log(`  covered by NEW (main + archive): ${newCovered.size}`);
console.log(`  missing in NEW: ${missing.length}`);
if (missing.length > 0) {
  console.log(`  ! first 5 missing ids: ${missing.slice(0, 5).join(', ')}`);
  for (const id of missing.slice(0, 5)) {
    const s = recoveredById.get(id);
    if (s != null && s.kind === 'decision') {
      console.log(`    ${id}: lastSeenAt=${s.lastSeenAt}, trigger=${s.payload.trigger ?? '(none)'}`);
    }
  }
}

const existingManifest: PublishedView[] = fs.existsSync(manifestPath)
  ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PublishedView[])
  : [];
const manifestNext = existingManifest.filter((v) => v.viewId !== 'decisions');
manifestNext.push(newResult.view);
fs.writeFileSync(manifestPath, JSON.stringify(manifestNext, null, 2));

console.log('\n=== output files ===');
const oldStat = fs.statSync(path.join(sandboxDir, '决策日志.OLD.md'));
const mainStat = fs.statSync(path.join(sandboxDir, '决策日志.md'));
const archiveStat = archivePath != null && fs.existsSync(path.join(sandboxDir, archivePath))
  ? fs.statSync(path.join(sandboxDir, archivePath))
  : null;
console.log(`  决策日志.OLD.md: ${oldStat.size} bytes (rendered via OLD path for comparison)`);
console.log(`  决策日志.md:     ${mainStat.size} bytes (rendered via NEW path)`);
if (archiveStat) {
  console.log(`  ${archivePath}: ${archiveStat.size} bytes`);
}

console.log('\nsandbox extract complete ✓');
