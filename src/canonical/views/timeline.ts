import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';

type TimelineSignal = Extract<CanonicalSignal, { kind: 'timeline_event' }>;

const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';

export const TIMELINE_BUDGET: ViewBudget = {
  viewId: 'timeline',
  buildMode: 'full_rebuild',
  maxChars: 18000,
  maxItemsTotal: 80,
  overflowPolicy: 'drop_low_score',
};

function fileHeader(title: string, sourceSummary: string, now: Date): string {
  return `<!-- generated: ${now.toISOString().replace('Z', '+00:00')} -->\n<!-- sources: ${sourceSummary} -->\n# ${title}\n`;
}

function extractUserNotes(content: string | undefined): string | null {
  if (content == null) return null;
  const startTag = '<!-- user notes -->';
  const endTag = '<!-- /user notes -->';
  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) return null;
  return content.slice(startIdx, endIdx + endTag.length);
}

function isTimelineSignal(signal: CanonicalSignal): signal is TimelineSignal {
  return signal.kind === 'timeline_event';
}

function sortTimelineSignals(signals: TimelineSignal[]): TimelineSignal[] {
  return [...signals].sort((left, right) => (
    right.payload.date.localeCompare(left.payload.date)
    || right.trustScore - left.trustScore
    || right.supportCount - left.supportCount
    || right.lastSeenAt - left.lastSeenAt
    || left.id.localeCompare(right.id)
  ));
}

function deriveProjectDescription(
  projectName: string,
  allSignals: CanonicalSignal[],
): string {
  const projectSignals = allSignals
    .filter((signal) => signal.status === 'active' && signal.projectNames.includes(projectName))
    .sort((left, right) => right.trustScore - left.trustScore || right.supportCount - left.supportCount);

  const snippets: string[] = [];

  for (const signal of projectSignals) {
    if (snippets.length >= 3) break;
    if (signal.kind === 'decision') {
      snippets.push(signal.payload.topic);
    } else if (signal.kind === 'timeline_event' && signal.payload.eventType !== 'milestone') {
      snippets.push(signal.payload.title);
    }
  }

  if (snippets.length === 0) return '(unknown)';

  const desc = snippets.slice(0, 2).join(', ');
  return desc.length <= 40 ? desc : `${desc.slice(0, 39).trim()}…`;
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n` : '\n';
  return `${header}${body}${userNotes}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export function compileTimelineView(
  signals: CanonicalSignal[],
  allSignals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
): PublishedView {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('项目时间线', sourceSummary, now);
  const filtered = sortTimelineSignals(
    signals.filter((signal) => signal.status === 'active').filter(isTimelineSignal),
  );

  const grouped = new Map<string, TimelineSignal[]>();
  for (const signal of filtered) {
    const project = signal.projectNames.length > 0 && signal.projectNames[0].length > 0 ? signal.projectNames[0] : 'unknown';
    const list = grouped.get(project) ?? [];
    list.push(signal);
    grouped.set(project, list);
  }

  const sortedProjectNames = [...grouped.keys()].sort((left, right) => left.localeCompare(right));

  const sections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  const maxItemsTotal = budget.maxItemsTotal ?? 80;
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = 0;

  for (const projectName of sortedProjectNames) {
    if (itemsWritten >= maxItemsTotal) break;

    const projectSignals = grouped.get(projectName) ?? [];
    const desc = deriveProjectDescription(projectName, allSignals);
    const sectionLines = [`## ${projectName}`, `<!-- desc: ${desc} -->`];
    const sectionSignalIds: string[] = [];

    const byDate = new Map<string, TimelineSignal[]>();
    for (const signal of projectSignals) {
      const date = signal.payload.date;
      const list = byDate.get(date) ?? [];
      list.push(signal);
      byDate.set(date, list);
    }

    const sortedDates = [...byDate.keys()].sort((left, right) => right.localeCompare(left));

    for (const date of sortedDates) {
      if (itemsWritten >= maxItemsTotal) break;

      const dateSignals = byDate.get(date) ?? [];
      sectionLines.push(`### ${date}`);

      for (const signal of dateSignals) {
        if (itemsWritten >= maxItemsTotal) break;

        const sourceLabel = signal.sourceLabels.length > 0 ? signal.sourceLabels[0] : 'unknown';
        const line = `- [${sourceLabel}] ${signal.payload.title}`;

        const candidateSectionLines = [...sectionLines, line];
        const candidateSignalIds = [...sectionSignalIds, signal.id];
        const candidateSections = [
          ...sections,
          { title: projectName, signalIds: candidateSignalIds, markdown: `${candidateSectionLines.join('\n')}\n` },
        ];
        const candidateMarkdown = buildMarkdown(header, candidateSections, userNotes);
        if (!fitsBudget(candidateMarkdown, budget)) break;

        sectionLines.push(line);
        sectionSignalIds.push(signal.id);
        sourceSignalIds.push(signal.id);
        itemsWritten++;
      }
    }

    if (sectionSignalIds.length === 0) continue;

    sections.push({ title: projectName, signalIds: sectionSignalIds, markdown: `${sectionLines.join('\n')}\n` });
  }

  let finalSections = [...sections];
  let finalSignalIds = Array.from(new Set(sourceSignalIds));
  let markdown = buildMarkdown(header, finalSections, userNotes);

  while (finalSections.length > 0 && !fitsBudget(markdown, budget)) {
    const removed = finalSections.pop();
    const removedIds = new Set(removed?.signalIds ?? []);
    finalSignalIds = finalSignalIds.filter((id) => !removedIds.has(id));
    markdown = buildMarkdown(header, finalSections, userNotes);
  }

  if (!fitsBudget(markdown, budget)) {
    markdown = buildMarkdown(header, [], DEFAULT_USER_NOTES);
    finalSignalIds = [];
  }

  if (!fitsBudget(markdown, budget)) {
    markdown = `${header}`.slice(0, budget.maxChars).trimEnd() + '\n';
    finalSections = [];
    finalSignalIds = [];
  }

  const finalizedMarkdown = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  const boundedMarkdown = finalizedMarkdown.length <= budget.maxChars
    ? finalizedMarkdown
    : finalizedMarkdown.slice(0, budget.maxChars);

  return {
    viewId: budget.viewId,
    title: '项目时间线',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
