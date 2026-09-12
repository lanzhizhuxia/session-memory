import { strict as assert } from 'node:assert';
import {
  compileDecisionsArchiveView,
  DECISIONS_ARCHIVE_BUDGET,
} from '../src/canonical/views/decisions.js';
import type { CanonicalSignal } from '../src/canonical/types.js';

function ts(yyyyMmDd: string): number {
  return Date.parse(`${yyyyMmDd}T12:00:00Z`);
}

function mkDecision(id: string, opts: {
  date: string;
  topic?: string;
  decision?: string;
  rationale?: string;
  alternatives?: string[];
  trigger?: string;
  project?: string;
  trustScore?: 1 | 2 | 3 | 4 | 5;
  supportCount?: number;
}): CanonicalSignal {
  const lastSeen = ts(opts.date);
  const project = opts.project ?? 'aibuddy';
  return {
    id,
    kind: 'decision',
    canonicalKey: `decision:${id}`,
    fingerprintSet: [`fp-${id}`],
    status: 'active',
    projectIds: [project],
    projectNames: [project],
    evidenceIds: [`ev-${id}`],
    sourceLabels: ['OC'],
    trustScore: opts.trustScore ?? 3,
    confidence: 0.8,
    supportCount: opts.supportCount ?? 1,
    firstSeenAt: lastSeen,
    lastSeenAt: lastSeen,
    summary: opts.decision ?? 'a decision',
    payload: {
      topic: opts.topic ?? `topic-${id}`,
      decision: opts.decision ?? `decision-${id}`,
      rationale: opts.rationale ?? `rationale-${id}`,
      alternatives: opts.alternatives ?? [],
      trigger: opts.trigger,
      scope: 'project',
    },
  } as CanonicalSignal;
}

async function testCoverageNoLossAcross20Months() {
  const sigs: CanonicalSignal[] = [];
  for (let m = 0; m < 20; m++) {
    const year = 2025 + Math.floor(m / 12);
    const monthZeroIdx = m % 12;
    const monthStr = String(monthZeroIdx + 1).padStart(2, '0');
    sigs.push(mkDecision(`s-${m}-a`, { date: `${year}-${monthStr}-15`, project: 'aibuddy' }));
    sigs.push(mkDecision(`s-${m}-b`, { date: `${year}-${monthStr}-20`, project: 'HLQUANT' }));
  }

  const result = await compileDecisionsArchiveView(
    sigs,
    DECISIONS_ARCHIVE_BUDGET,
    'opencode(40)',
  );

  const inputIds = new Set(sigs.map((s) => s.id));
  const sourceIds = new Set(result.view.sourceSignalIds);
  for (const id of inputIds) {
    assert.ok(sourceIds.has(id), `signal ${id} missing from sourceSignalIds`);
  }
  assert.equal(sourceIds.size, inputIds.size);

  const mainTexts = result.view.markdown;
  const archiveTexts = result.archiveMarkdown;
  for (const id of inputIds) {
    const probe = `decision-${id}`;
    const inMain = mainTexts.includes(probe);
    const inArchive = archiveTexts.includes(probe);
    assert.ok(
      inMain || inArchive,
      `decision body for signal ${id} not in main or archive`,
    );
    assert.ok(
      !(inMain && inArchive),
      `decision body for signal ${id} duplicated in both main and archive`,
    );
  }
  console.log('  ✓ no signal lost (source covers all inputs across 20 months × 2 projects = 40 sigs)');
}

async function testHistoryIndexNonEmpty() {
  const sigs = [
    mkDecision('recent-1', { date: '2026-05-15', project: 'aibuddy' }),
    mkDecision('recent-2', { date: '2026-04-15', project: 'HLQUANT' }),
    mkDecision('old-1', { date: '2024-12-15', project: 'aibuddy' }),
  ];
  const result = await compileDecisionsArchiveView(sigs, DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.ok(result.view.archiveIndex != null);
  assert.ok(result.view.archiveIndex!.length >= 2);
  assert.ok(result.view.markdown.includes('## 历史索引'));
  assert.ok(result.view.markdown.includes('| 月份 | 条目数 | 位置 |'));
  const archiveEntries = result.view.archiveIndex!.filter((e) => e.location === 'archive');
  assert.ok(archiveEntries.length >= 1);
  console.log('  ✓ archiveIndex populated, 历史索引 section rendered');
}

async function testNoTop50Truncation() {
  const sigs: CanonicalSignal[] = [];
  for (let i = 0; i < 80; i++) {
    sigs.push(mkDecision(`d-${i}`, { date: '2026-05-15', project: 'aibuddy' }));
  }
  const result = await compileDecisionsArchiveView(sigs, DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.equal(result.view.sourceSignalIds.length, 80);
  console.log('  ✓ no top-50 truncation (all 80 same-month decisions retained)');
}

async function testNoMaxCharsTruncation() {
  const longRationale = '理由'.repeat(1000);
  const sigs: CanonicalSignal[] = [];
  for (let i = 0; i < 10; i++) {
    sigs.push(mkDecision(`big-${i}`, {
      date: '2026-05-15',
      project: 'aibuddy',
      rationale: longRationale,
    }));
  }
  const result = await compileDecisionsArchiveView(sigs, DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.equal(result.view.sourceSignalIds.length, 10);
  console.log('  ✓ no maxChars truncation (10 mega-rationales retained)');
}

async function testActiveOnly() {
  const sigs: CanonicalSignal[] = [
    mkDecision('active-1', { date: '2026-05-15' }),
    {
      ...mkDecision('superseded-1', { date: '2026-05-15' }),
      status: 'superseded',
    } as CanonicalSignal,
    {
      ...mkDecision('archived-1', { date: '2026-05-15' }),
      status: 'archived',
    } as CanonicalSignal,
  ];
  const result = await compileDecisionsArchiveView(sigs, DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.equal(result.view.sourceSignalIds.length, 1);
  assert.equal(result.view.sourceSignalIds[0], 'active-1');
  console.log('  ✓ only active signals included (superseded/archived excluded — for §6.3 migration)');
}

async function testTriggerDateFallback() {
  const sigs = [
    mkDecision('t-only', {
      date: '2020-01-01',
      project: 'aibuddy',
      trigger: '2026-05-10 因为 X',
    }),
  ];
  const result = await compileDecisionsArchiveView(sigs, DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.equal(result.view.sourceSignalIds.length, 1);
  assert.ok(result.view.markdown.includes('2026-05'));
  console.log('  ✓ effectiveTimestamp prefers trigger date over lastSeenAt');
}

async function testArchiveFileMetadata() {
  const sigs = [
    mkDecision('current', { date: '2026-05-15' }),
    mkDecision('old', { date: '2024-08-15' }),
  ];
  const result = await compileDecisionsArchiveView(sigs, DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.equal(result.view.archiveFile, 'archive/决策日志-archive.md');
  assert.ok(result.archiveMarkdown.length > 0);
  assert.ok(result.archiveMarkdown.includes('old'));
  assert.ok(!result.view.markdown.includes('## 2024-08'));
  assert.ok(result.view.markdown.includes('## 2026-05'));
  console.log('  ✓ archive file populated with old months only; current in main');
}

async function testEmptyInput() {
  const result = await compileDecisionsArchiveView([], DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.equal(result.view.sourceSignalIds.length, 0);
  assert.equal(result.archiveMarkdown, '');
  assert.ok(result.view.markdown.includes('# 决策日志'));
  console.log('  ✓ empty input produces empty archive but valid main');
}

async function testRetentionPrecedenceContract() {
  const badBudget = { ...DECISIONS_ARCHIVE_BUDGET, retention: undefined };
  await assert.rejects(
    compileDecisionsArchiveView([], badBudget, 'oc'),
    /archive_by_month/,
  );
  console.log('  ✓ rejects budget without retention.mode=archive_by_month');
}

async function testModalityHeader() {
  const sigs = [mkDecision('h', { date: '2026-05-15' })];
  const result = await compileDecisionsArchiveView(sigs, DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.ok(result.view.markdown.includes('<!-- modality: event -->'));
  assert.ok(result.view.markdown.includes('<!-- retention: archive_by_month'));
  console.log('  ✓ modality + retention HTML header present');
}

async function testUndatedSection() {
  const dated = mkDecision('dated-1', { date: '2026-05-15', topic: 'topic-dated', decision: 'decision-dated' });
  const undatedRaw = mkDecision('undated-1', {
    date: '2026-05-15',
    topic: 'topic-undated-no-anchor',
    decision: 'decision-undated-no-anchor',
    rationale: 'rationale for undated',
    trigger: '中文叙述触发器，无可解析日期',
  });
  const undated = {
    ...undatedRaw,
    lastSeenAt: 0,
    firstSeenAt: 0,
  } as CanonicalSignal;

  const sigs: CanonicalSignal[] = [dated, undated];
  const result = await compileDecisionsArchiveView(sigs, DECISIONS_ARCHIVE_BUDGET, 'oc');

  assert.equal(result.view.sourceSignalIds.length, 2, 'both dated and undated must be in sourceSignalIds');
  assert.ok(result.view.sourceSignalIds.includes('dated-1'));
  assert.ok(result.view.sourceSignalIds.includes('undated-1'));

  assert.ok(result.view.markdown.includes('## 未定日期'), 'main should include 未定日期 section');
  assert.ok(result.view.markdown.includes('decision-undated-no-anchor'), 'undated decision body must render');
  assert.ok(result.view.markdown.includes('中文叙述触发器'), 'undated trigger should be surfaced as forensic hint');

  const undatedIdx = result.view.markdown.indexOf('## 未定日期');
  const indexIdx = result.view.markdown.indexOf('## 历史索引');
  assert.ok(undatedIdx > 0, '未定日期 section must exist');
  assert.ok(indexIdx > undatedIdx, '未定日期 must appear before 历史索引');

  const dateBucketIdx = result.view.markdown.indexOf('## 2026-05');
  assert.ok(dateBucketIdx > 0 && dateBucketIdx < undatedIdx, 'dated buckets must appear before 未定日期');

  const archiveIndex = result.view.archiveIndex ?? [];
  for (const e of archiveIndex) {
    assert.notEqual(e.yearMonth, '未定日期', 'archiveIndex must not pollute with 未定日期 pseudo-month');
  }

  const undatedSection = result.view.sections.find((s) => s.title === '未定日期');
  assert.ok(undatedSection != null, 'sections array must include 未定日期');
  assert.deepEqual(undatedSection!.signalIds, ['undated-1']);

  console.log('  ✓ undated decisions rendered in 未定日期 section, fully covered, not polluting archive index');
}

async function testUndatedOnlyInputProducesEmptyArchive() {
  const undated = {
    ...mkDecision('u-only', { date: '2026-05-15', topic: 'u-topic', decision: 'u-decision' }),
    lastSeenAt: 0,
    firstSeenAt: 0,
  } as CanonicalSignal;
  const result = await compileDecisionsArchiveView([undated], DECISIONS_ARCHIVE_BUDGET, 'oc');
  assert.equal(result.view.sourceSignalIds.length, 1);
  assert.equal(result.archiveMarkdown, '');
  assert.ok(result.view.markdown.includes('## 未定日期'));
  assert.ok(result.view.markdown.includes('u-decision'));
  console.log('  ✓ undated-only input renders without archive file');
}

async function main() {
  console.log('\nrunning decisions-archive smoke tests...');
  await testCoverageNoLossAcross20Months();
  await testHistoryIndexNonEmpty();
  await testNoTop50Truncation();
  await testNoMaxCharsTruncation();
  await testActiveOnly();
  await testTriggerDateFallback();
  await testArchiveFileMetadata();
  await testEmptyInput();
  await testRetentionPrecedenceContract();
  await testModalityHeader();
  await testUndatedSection();
  await testUndatedOnlyInputProducesEmptyArchive();
  console.log('\nall decisions-archive smoke tests passed ✓');
}

main().catch((err) => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
