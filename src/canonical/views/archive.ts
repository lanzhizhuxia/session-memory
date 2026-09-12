import type {
  CanonicalSignal,
  PublishedViewArchiveIndexEntry,
} from '../types.js';

const MAX_INDEX_MONTHS = 36;

export interface MonthlyBucket {
  yearMonth: string;
  signals: CanonicalSignal[];
  count: number;
}

export interface ArchiveBuildInput {
  signals: CanonicalSignal[];
  effectiveTimestamp: (signal: CanonicalSignal) => number;
  currentMonths: number;
  nowMs: number;
}

export interface ArchiveBuildResult {
  currentBuckets: MonthlyBucket[];
  archiveBuckets: MonthlyBucket[];
  index: PublishedViewArchiveIndexEntry[];
}

export function formatYearMonth(epochMs: number): string {
  const d = new Date(epochMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function bucketByMonth(
  signals: CanonicalSignal[],
  effectiveTimestamp: (signal: CanonicalSignal) => number,
): MonthlyBucket[] {
  const bucketMap = new Map<string, CanonicalSignal[]>();
  for (const signal of signals) {
    const ts = effectiveTimestamp(signal);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const ym = formatYearMonth(ts);
    let arr = bucketMap.get(ym);
    if (!arr) {
      arr = [];
      bucketMap.set(ym, arr);
    }
    arr.push(signal);
  }
  const buckets: MonthlyBucket[] = [...bucketMap.entries()].map(([yearMonth, list]) => ({
    yearMonth,
    signals: list,
    count: list.length,
  }));
  buckets.sort((a, b) => (a.yearMonth < b.yearMonth ? 1 : a.yearMonth > b.yearMonth ? -1 : 0));
  return buckets;
}

export function splitCurrentVsArchive(
  buckets: MonthlyBucket[],
  currentMonths: number,
  nowMs: number,
): { current: MonthlyBucket[]; archive: MonthlyBucket[] } {
  if (currentMonths <= 0 || buckets.length === 0) {
    return { current: [], archive: buckets };
  }
  const cutoff = new Date(nowMs);
  cutoff.setUTCDate(1);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - (currentMonths - 1));
  const cutoffYm = formatYearMonth(cutoff.getTime());
  const current: MonthlyBucket[] = [];
  const archive: MonthlyBucket[] = [];
  for (const b of buckets) {
    if (b.yearMonth >= cutoffYm) current.push(b);
    else archive.push(b);
  }
  return { current, archive };
}

export function foldArchiveIndexByYear(
  archiveBuckets: MonthlyBucket[],
): PublishedViewArchiveIndexEntry[] {
  const yearMap = new Map<string, number>();
  for (const b of archiveBuckets) {
    const year = b.yearMonth.slice(0, 4);
    yearMap.set(year, (yearMap.get(year) ?? 0) + b.count);
  }
  const folded: PublishedViewArchiveIndexEntry[] = [...yearMap.entries()]
    .map(([year, count]) => ({ yearMonth: year, location: 'archive' as const, count }))
    .sort((a, b) => (a.yearMonth < b.yearMonth ? 1 : a.yearMonth > b.yearMonth ? -1 : 0));
  return folded;
}

export function buildArchive(input: ArchiveBuildInput): ArchiveBuildResult {
  const all = bucketByMonth(input.signals, input.effectiveTimestamp);
  const { current, archive } = splitCurrentVsArchive(all, input.currentMonths, input.nowMs);

  const currentEntries: PublishedViewArchiveIndexEntry[] = current.map((b) => ({
    yearMonth: b.yearMonth,
    location: 'current' as const,
    count: b.count,
  }));

  let archiveEntries: PublishedViewArchiveIndexEntry[];
  if (archive.length > MAX_INDEX_MONTHS) {
    archiveEntries = foldArchiveIndexByYear(archive);
  } else {
    archiveEntries = archive.map((b) => ({
      yearMonth: b.yearMonth,
      location: 'archive' as const,
      count: b.count,
    }));
  }

  const index = [...currentEntries, ...archiveEntries];
  return { currentBuckets: current, archiveBuckets: archive, index };
}

export function renderHistoryIndexSection(
  index: PublishedViewArchiveIndexEntry[],
  archiveFile: string | undefined,
): string {
  if (index.length === 0) return '';
  const lines: string[] = ['## 历史索引', ''];
  lines.push('| 月份 | 条目数 | 位置 |');
  lines.push('|---|---:|---|');
  for (const entry of index) {
    const location = entry.location === 'current'
      ? `本文件 §${entry.yearMonth}`
      : (archiveFile ? archiveFile : '(archive)');
    lines.push(`| ${entry.yearMonth} | ${entry.count} | ${location} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderBucketGroup(
  buckets: MonthlyBucket[],
  renderEntry: (signal: CanonicalSignal) => string,
): string {
  if (buckets.length === 0) return '';
  const parts: string[] = [];
  for (const b of buckets) {
    parts.push(`## ${b.yearMonth}`);
    parts.push('');
    for (const s of b.signals) {
      parts.push(renderEntry(s));
    }
    parts.push('');
  }
  return parts.join('\n');
}
