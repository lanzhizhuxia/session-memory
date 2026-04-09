import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';

type OpenThreadSignal = Extract<CanonicalSignal, { kind: 'open_thread' }>;

const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  open: 1,
  blocked: 2,
};

export const OPEN_THREADS_BUDGET: ViewBudget = {
  viewId: 'open_threads',
  buildMode: 'full_rebuild',
  maxChars: 12000,
  maxItemsTotal: 60,
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

function isOpenThreadSignal(signal: CanonicalSignal): signal is OpenThreadSignal {
  return signal.kind === 'open_thread';
}

function sortOpenThreadSignals(signals: OpenThreadSignal[]): OpenThreadSignal[] {
  return [...signals].sort((left, right) => {
    const statusDiff = (STATUS_ORDER[left.payload.status] ?? 9) - (STATUS_ORDER[right.payload.status] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    return right.firstSeenAt - left.firstSeenAt
      || right.trustScore - left.trustScore
      || right.supportCount - left.supportCount
      || left.id.localeCompare(right.id);
  });
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n` : '\n';
  return `${header}${body}${userNotes}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export function compileOpenThreadsView(
  signals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
): PublishedView {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('未完成线索', sourceSummary, now);
  const filtered = sortOpenThreadSignals(
    signals.filter((signal) => signal.status === 'active').filter(isOpenThreadSignal),
  );

  const grouped = new Map<string, OpenThreadSignal[]>();
  for (const signal of filtered) {
    const project = signal.projectNames.length > 0 && signal.projectNames[0].length > 0 ? signal.projectNames[0] : 'unknown';
    const list = grouped.get(project) ?? [];
    list.push(signal);
    grouped.set(project, list);
  }

  const sortedProjectNames = [...grouped.keys()].sort((left, right) => {
    const leftLatest = Math.max(...(grouped.get(left) ?? []).map((s) => s.firstSeenAt));
    const rightLatest = Math.max(...(grouped.get(right) ?? []).map((s) => s.firstSeenAt));
    return rightLatest - leftLatest || left.localeCompare(right);
  });

  const sections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  const maxItemsTotal = budget.maxItemsTotal ?? 60;
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = 0;

  for (const projectName of sortedProjectNames) {
    if (itemsWritten >= maxItemsTotal) break;

    const projectSignals = grouped.get(projectName) ?? [];
    const sectionLines = [`## ${projectName}`];
    const sectionSignalIds: string[] = [];

    for (const signal of projectSignals) {
      if (itemsWritten >= maxItemsTotal) break;

      const line = `- [${signal.payload.status}] ${signal.payload.title}`;

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
    title: '未完成线索',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
