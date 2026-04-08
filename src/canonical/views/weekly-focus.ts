import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';

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

function fileHeader(title: string, sourceSummary: string, now: Date): string {
  return `<!-- generated: ${now.toISOString().replace('Z', '+00:00')} -->\n<!-- sources: ${sourceSummary} -->\n# ${title}\n`;
}

function effectiveTimestamp(signal: CanonicalSignal): number {
  if (signal.kind === 'timeline_event') {
    const parsed = Date.parse(signal.payload.date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return signal.lastSeenAt;
}

function isWithinDays(signal: CanonicalSignal, days: number, now: number): boolean {
  const ts = effectiveTimestamp(signal);
  return (now - ts) <= days * MS_PER_DAY;
}

function hasCompletionSemantics(signal: TimelineSignal): boolean {
  if (signal.payload.eventType === 'delivery' || signal.payload.eventType === 'milestone') return true;
  return COMPLETION_PATTERN.test(signal.payload.title);
}

function formatItem(signal: CanonicalSignal): string {
  const projectName = signal.projectNames.length > 0 && signal.projectNames[0].length > 0 ? signal.projectNames[0] : 'unknown';

  if (signal.kind === 'timeline_event') {
    return `- [${projectName}] ${signal.payload.title}`;
  }
  if (signal.kind === 'open_thread') {
    return `- [${projectName}] ${signal.payload.title}`;
  }
  if (signal.kind === 'decision') {
    return `- [${projectName}] ${signal.payload.topic}`;
  }

  return `- [${projectName}] ${signal.summary}`;
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
  const header = fileHeader('本周重点', sourceSummary, now);
  const maxPerSection = budget.maxItemsPerSection ?? 12;
  const maxTotal = budget.maxItemsTotal ?? 30;

  const activeSignals = allSignals.filter((signal) => signal.status === 'active');

  const inProgress = sortByRelevance(
    activeSignals
      .filter((signal): signal is OpenThreadSignal => signal.kind === 'open_thread')
      .filter((signal) => isWithinDays(signal, 3, nowMs)),
  ).slice(0, maxPerSection);

  const completed = sortByRelevance(
    activeSignals
      .filter((signal): signal is TimelineSignal => signal.kind === 'timeline_event')
      .filter((signal) => isWithinDays(signal, 7, nowMs) && hasCompletionSemantics(signal)),
  ).slice(0, maxPerSection);

  const decisions = sortByRelevance(
    activeSignals
      .filter((signal): signal is DecisionSignal => signal.kind === 'decision')
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
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n` : '\n';
  let markdown = `${header}${body}`;

  let finalSections = [...sections];
  let finalSignalIds = Array.from(new Set(sourceSignalIds));

  while (finalSections.length > 0 && !fitsBudget(markdown, budget)) {
    const removed = finalSections.pop();
    const removedIds = new Set(removed?.signalIds ?? []);
    finalSignalIds = finalSignalIds.filter((id) => !removedIds.has(id));
    const rebuiltSectionMd = finalSections.map((section) => section.markdown.trimEnd()).join('\n\n');
    const rebuiltBody = rebuiltSectionMd.length > 0 ? `\n${rebuiltSectionMd}\n` : '\n';
    markdown = `${header}${rebuiltBody}`;
  }

  if (!fitsBudget(markdown, budget)) {
    markdown = `${header}`;
    finalSections = [];
    finalSignalIds = [];
  }

  const finalizedMarkdown = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  const boundedMarkdown = finalizedMarkdown.length <= budget.maxChars
    ? finalizedMarkdown
    : finalizedMarkdown.slice(0, budget.maxChars);

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
