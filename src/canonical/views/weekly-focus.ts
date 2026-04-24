import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';
import { cleanProjectName, cleanTitle, cleanViewText, finalizeMarkdownWithinBudget, formatDateLabel } from './view-text.js';

type TimelineSignal = Extract<CanonicalSignal, { kind: 'timeline_event' }>;
type OpenThreadSignal = Extract<CanonicalSignal, { kind: 'open_thread' }>;
type DecisionSignal = Extract<CanonicalSignal, { kind: 'decision' }>;

const MS_PER_DAY = 86_400_000;
const COMPLETION_PATTERN = /完成|deploy|review.*通过|上线|发布|delivered|shipped|merged/i;

export const WEEKLY_FOCUS_BUDGET: ViewBudget = {
  viewId: 'weekly_focus',
  buildMode: 'rolling_window',
  maxChars: 6000,
  maxItemsTotal: 30,
  maxItemsPerSection: 12,
  sections: ['进行中', '已完成', '关键决策'],
  overflowPolicy: 'drop_low_score',
};

function fileHeader(title: string): string {
  return `# ${title}\n`;
}

function fileMetadata(sourceSummary: string, now: Date): string {
  return `<!-- generated: ${now.toISOString()} | sources: ${sourceSummary} -->\n`;
}

function effectiveTimestamp(signal: CanonicalSignal): number {
  if (signal.kind === 'timeline_event') {
    const parsed = Date.parse(signal.payload.date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return signal.lastSeenAt;
}

function creationTimestamp(signal: CanonicalSignal): number {
  return signal.firstSeenAt;
}

function isWithinDays(signal: CanonicalSignal, days: number, now: number): boolean {
  const ts = effectiveTimestamp(signal);
  return (now - ts) <= days * MS_PER_DAY;
}

function wasCreatedWithinDays(signal: CanonicalSignal, days: number, now: number): boolean {
  return (now - creationTimestamp(signal)) <= days * MS_PER_DAY;
}

function hasNamedProject(signal: CanonicalSignal): boolean {
  return signal.projectNames.length > 0 && signal.projectNames[0].length > 0;
}

function hasRecentProjectTimelineActivity(
  projectName: string,
  signals: CanonicalSignal[],
  now: number,
): boolean {
  return signals.some((signal): signal is TimelineSignal => (
    signal.kind === 'timeline_event'
    && signal.projectNames.includes(projectName)
    && isWithinDays(signal, 7, now)
  ));
}

function hasCompletionSemantics(signal: TimelineSignal): boolean {
  if (signal.payload.eventType === 'delivery') return true;
  return COMPLETION_PATTERN.test(signal.payload.title);
}

function cleanReason(input: string | null | undefined): string {
  return cleanViewText(input);
}

function formatItem(signal: CanonicalSignal): string {
  const projectName = cleanProjectName(signal.projectNames[0]);
  const dateLabel = signal.kind === 'decision'
    ? formatDateLabel(signal.payload.trigger ?? signal.lastSeenAt)
    : signal.kind === 'timeline_event'
      ? formatDateLabel(signal.payload.date)
      : formatDateLabel(effectiveTimestamp(signal));

  if (signal.kind === 'timeline_event') {
    return `- [${projectName}] ${dateLabel} · ${cleanTitle(signal.payload.title)}`;
  }
  if (signal.kind === 'open_thread') {
    return `- [${projectName}] ${dateLabel} · ${cleanTitle(signal.payload.title)}`;
  }
  if (signal.kind === 'decision') {
    const reason = cleanReason(signal.payload.rationale);
    const decision = `- [${projectName}] ${dateLabel} · 决定：${cleanTitle(signal.payload.topic)}`;
    if (reason.length === 0 || reason === cleanTitle(signal.payload.topic)) return decision;
    return `${decision}；原因：${reason}`;
  }

  return `- [${projectName}] ${dateLabel} · ${cleanTitle(signal.summary)}`;
}

function sortByRelevance(signals: CanonicalSignal[]): CanonicalSignal[] {
  return [...signals].sort((left, right) => (
    right.trustScore - left.trustScore
    || right.supportCount - left.supportCount
    || right.lastSeenAt - left.lastSeenAt
    || left.id.localeCompare(right.id)
  ));
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export function compileWeeklyFocusView(
  allSignals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
): PublishedView {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const nowMs = generatedAt;
  const header = fileHeader('本周重点');
  const metadata = fileMetadata(sourceSummary, now);
  const maxPerSection = budget.maxItemsPerSection ?? 12;
  const maxTotal = budget.maxItemsTotal ?? 30;

  const activeSignals = allSignals.filter((signal) => signal.status === 'active');

  const inProgress = sortByRelevance(
    activeSignals
      .filter((signal): signal is OpenThreadSignal => signal.kind === 'open_thread')
      .filter(hasNamedProject)
      .filter((signal) => wasCreatedWithinDays(signal, 7, nowMs))
      .filter((signal) => hasRecentProjectTimelineActivity(signal.projectNames[0], activeSignals, nowMs)),
  ).slice(0, maxPerSection);

  const completed = sortByRelevance(
    activeSignals
      .filter((signal): signal is TimelineSignal => signal.kind === 'timeline_event')
      .filter(hasNamedProject)
      .filter((signal) => isWithinDays(signal, 7, nowMs) && hasCompletionSemantics(signal)),
  ).slice(0, maxPerSection);

  const decisions = sortByRelevance(
    activeSignals
      .filter((signal): signal is DecisionSignal => signal.kind === 'decision')
      .filter(hasNamedProject)
      .filter((signal) => isWithinDays(signal, 7, nowMs)),
  ).slice(0, maxPerSection);

  const sectionData: Array<{ title: string; signals: CanonicalSignal[] }> = [
    { title: '进行中', signals: inProgress },
    { title: '已完成', signals: completed },
    { title: '关键决策', signals: decisions },
  ];

  const sections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  let itemsWritten = 0;

  for (const { title, signals } of sectionData) {
    if (signals.length === 0) continue;
    if (itemsWritten >= maxTotal) break;

    const sectionLines = [`## ${title}`];
    const sectionSignalIds: string[] = [];

    for (const signal of signals) {
      if (itemsWritten >= maxTotal) break;

      const line = formatItem(signal);
      sectionLines.push(line);
      sectionSignalIds.push(signal.id);
      sourceSignalIds.push(signal.id);
      itemsWritten++;
    }

    if (sectionSignalIds.length === 0) continue;

    sections.push({ title, signalIds: sectionSignalIds, markdown: `${sectionLines.join('\n')}\n` });
  }

  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n${metadata}` : `\n${metadata}`;
  let markdown = `${header}${body}`;

  let finalSections = [...sections];
  let finalSignalIds = Array.from(new Set(sourceSignalIds));

  while (finalSections.length > 0 && !fitsBudget(markdown, budget)) {
    const removed = finalSections.pop();
    const removedIds = new Set(removed?.signalIds ?? []);
    finalSignalIds = finalSignalIds.filter((id) => !removedIds.has(id));
    const rebuiltSectionMd = finalSections.map((section) => section.markdown.trimEnd()).join('\n\n');
    const rebuiltBody = rebuiltSectionMd.length > 0 ? `\n${rebuiltSectionMd}\n${metadata}` : `\n${metadata}`;
    markdown = `${header}${rebuiltBody}`;
  }

  if (!fitsBudget(markdown, budget)) {
    markdown = `${header}`;
    finalSections = [];
    finalSignalIds = [];
  }

  const rebuiltSectionMd = finalSections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const rebuiltBody = rebuiltSectionMd.length > 0 ? `\n${rebuiltSectionMd}\n${metadata}` : `\n${metadata}`;
  const finalized = finalizeMarkdownWithinBudget(header, rebuiltBody, budget.maxChars);
  const boundedMarkdown = finalized.endsWith('\n') ? finalized : `${finalized}\n`;

  return {
    viewId: budget.viewId,
    title: '本周重点',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
