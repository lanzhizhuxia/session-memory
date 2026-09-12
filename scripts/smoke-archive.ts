import { strict as assert } from 'node:assert';
import {
  bucketByMonth,
  buildArchive,
  foldArchiveIndexByYear,
  formatYearMonth,
  renderBucketGroup,
  renderHistoryIndexSection,
  splitCurrentVsArchive,
} from '../src/canonical/views/archive.js';
import type { CanonicalSignal } from '../src/canonical/types.js';

function mkSignal(id: string, lastSeenAt: number): CanonicalSignal {
  return {
    id,
    kind: 'decision',
    canonicalKey: `key-${id}`,
    fingerprintSet: [`fp-${id}`],
    status: 'active',
    projectIds: [],
    projectNames: [],
    evidenceIds: [],
    sourceLabels: [],
    trustScore: 3,
    confidence: 0.8,
    supportCount: 1,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    summary: `summary-${id}`,
    payload: {
      topic: `topic-${id}`,
      decision: `decision-${id}`,
      rationale: `rationale-${id}`,
      alternatives: [],
      scope: 'project',
    },
  } as CanonicalSignal;
}

function ts(yyyyMmDd: string): number {
  return Date.parse(`${yyyyMmDd}T12:00:00Z`);
}

const NOW = ts('2026-05-22');

function assertNoDataLoss(input: CanonicalSignal[], result: ReturnType<typeof buildArchive>) {
  const inputIds = new Set(input.map((s) => s.id));
  const seen = new Set<string>();
  for (const b of result.currentBuckets) for (const s of b.signals) seen.add(s.id);
  for (const b of result.archiveBuckets) for (const s of b.signals) seen.add(s.id);
  for (const id of inputIds) {
    assert.ok(seen.has(id), `signal ${id} lost during bucketing`);
  }
  assert.equal(seen.size, inputIds.size, 'no duplicates expected');
}

function testFormatYearMonth() {
  assert.equal(formatYearMonth(ts('2026-05-22')), '2026-05');
  assert.equal(formatYearMonth(ts('2026-01-01')), '2026-01');
  assert.equal(formatYearMonth(ts('2025-12-31')), '2025-12');
  console.log('  ✓ formatYearMonth');
}

function testBucketByMonth() {
  const sigs = [
    mkSignal('a', ts('2026-05-15')),
    mkSignal('b', ts('2026-05-01')),
    mkSignal('c', ts('2026-04-20')),
    mkSignal('d', ts('2025-12-10')),
  ];
  const buckets = bucketByMonth(sigs, (s) => s.lastSeenAt);
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].yearMonth, '2026-05');
  assert.equal(buckets[0].count, 2);
  assert.equal(buckets[1].yearMonth, '2026-04');
  assert.equal(buckets[2].yearMonth, '2025-12');
  console.log('  ✓ bucketByMonth (sorted desc, grouped)');
}

function testBucketByMonthSkipsInvalid() {
  const sigs = [
    mkSignal('valid', ts('2026-05-15')),
    mkSignal('zero', 0),
    mkSignal('negative', -1),
    mkSignal('nan', Number.NaN),
  ];
  const buckets = bucketByMonth(sigs, (s) => s.lastSeenAt);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].signals[0].id, 'valid');
  console.log('  ✓ bucketByMonth skips invalid timestamps');
}

function testSplitCurrent12Months() {
  const sigs = [
    mkSignal('current-may', ts('2026-05-15')),
    mkSignal('current-jun-prior', ts('2025-06-15')),
    mkSignal('archive-may-prior', ts('2025-05-15')),
    mkSignal('archive-old', ts('2024-12-01')),
  ];
  const buckets = bucketByMonth(sigs, (s) => s.lastSeenAt);
  const { current, archive } = splitCurrentVsArchive(buckets, 12, NOW);
  const currentIds = current.flatMap((b) => b.signals.map((s) => s.id));
  const archiveIds = archive.flatMap((b) => b.signals.map((s) => s.id));
  assert.deepEqual(currentIds.sort(), ['current-jun-prior', 'current-may'].sort());
  assert.deepEqual(archiveIds.sort(), ['archive-may-prior', 'archive-old'].sort());
  console.log('  ✓ splitCurrentVsArchive (12-month window)');
}

function testBuildArchiveCoverage() {
  const sigs = [
    mkSignal('m1', ts('2026-05-15')),
    mkSignal('m2', ts('2026-05-10')),
    mkSignal('m3', ts('2026-03-15')),
    mkSignal('m4', ts('2025-12-15')),
    mkSignal('m5', ts('2025-08-15')),
    mkSignal('m6', ts('2025-04-15')),
    mkSignal('m7', ts('2024-11-01')),
  ];
  const result = buildArchive({
    signals: sigs,
    effectiveTimestamp: (s) => s.lastSeenAt,
    currentMonths: 12,
    nowMs: NOW,
  });
  assertNoDataLoss(sigs, result);
  const indexCounts = new Map(result.index.map((e) => [e.yearMonth, e.count]));
  assert.equal(indexCounts.get('2026-05'), 2);
  assert.equal(indexCounts.get('2026-03'), 1);
  assert.equal(indexCounts.get('2024-11'), 1);
  console.log('  ✓ buildArchive (no data loss across 7 signals)');
}

function testFoldByYear() {
  const buckets = Array.from({ length: 40 }, (_, i) => {
    const year = 2020 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, '0');
    return { yearMonth: `${year}-${month}`, signals: [], count: 1 };
  });
  const folded = foldArchiveIndexByYear(buckets);
  assert.ok(folded.length <= 5, `folded should collapse to year-level, got ${folded.length}`);
  for (const e of folded) {
    assert.equal(e.yearMonth.length, 4);
    assert.equal(e.location, 'archive');
  }
  console.log('  ✓ foldArchiveIndexByYear (collapses 40 months → year-level)');
}

function testBuildArchiveFoldsLargeIndex() {
  const sigs: CanonicalSignal[] = [];
  for (let i = 0; i < 60; i++) {
    const month = i + 1;
    const year = 2020 + Math.floor((month - 1) / 12);
    const m = String(((month - 1) % 12) + 1).padStart(2, '0');
    sigs.push(mkSignal(`s${i}`, ts(`${year}-${m}-15`)));
  }
  sigs.push(mkSignal('recent', ts('2026-05-01')));
  const result = buildArchive({
    signals: sigs,
    effectiveTimestamp: (s) => s.lastSeenAt,
    currentMonths: 12,
    nowMs: NOW,
  });
  assertNoDataLoss(sigs, result);
  const archiveEntries = result.index.filter((e) => e.location === 'archive');
  for (const e of archiveEntries) {
    assert.ok(e.yearMonth.length === 4 || e.yearMonth.length === 7, `unexpected ${e.yearMonth}`);
  }
  console.log('  ✓ buildArchive folds large archive indices');
}

function testRenderBucketGroup() {
  const sigs = [mkSignal('a', ts('2026-05-15')), mkSignal('b', ts('2026-04-10'))];
  const buckets = bucketByMonth(sigs, (s) => s.lastSeenAt);
  const md = renderBucketGroup(buckets, (s) => `- ${s.id}`);
  assert.ok(md.includes('## 2026-05'));
  assert.ok(md.includes('## 2026-04'));
  assert.ok(md.includes('- a'));
  assert.ok(md.includes('- b'));
  console.log('  ✓ renderBucketGroup');
}

function testRenderHistoryIndex() {
  const md = renderHistoryIndexSection(
    [
      { yearMonth: '2026-05', location: 'current', count: 5 },
      { yearMonth: '2024', location: 'archive', count: 30 },
    ],
    'archive/决策日志-archive.md',
  );
  assert.ok(md.includes('## 历史索引'));
  assert.ok(md.includes('| 月份 | 条目数 | 位置 |'));
  assert.ok(md.includes('2026-05'));
  assert.ok(md.includes('archive/决策日志-archive.md'));
  console.log('  ✓ renderHistoryIndexSection');
}

function testEmptyInputs() {
  const result = buildArchive({
    signals: [],
    effectiveTimestamp: (s) => s.lastSeenAt,
    currentMonths: 12,
    nowMs: NOW,
  });
  assert.equal(result.currentBuckets.length, 0);
  assert.equal(result.archiveBuckets.length, 0);
  assert.equal(result.index.length, 0);
  assert.equal(renderBucketGroup([], () => ''), '');
  assert.equal(renderHistoryIndexSection([], undefined), '');
  console.log('  ✓ empty inputs');
}

console.log('\nrunning archive.ts smoke tests...');
testFormatYearMonth();
testBucketByMonth();
testBucketByMonthSkipsInvalid();
testSplitCurrent12Months();
testBuildArchiveCoverage();
testFoldByYear();
testBuildArchiveFoldsLargeIndex();
testRenderBucketGroup();
testRenderHistoryIndex();
testEmptyInputs();
console.log('\nall archive smoke tests passed ✓');
