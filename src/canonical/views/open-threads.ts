import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';
import {
  cleanProjectName,
  cleanTitle,
  finalizeMarkdownWithinBudget,
  formatDateLabel,
  formatRelativeStaleness,
  localizeStatus,
} from './view-text.js';

type OpenThreadSignal = Extract<CanonicalSignal, { kind: 'open_thread' }>;

const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  blocked: 1,
  open: 2,
};

export const OPEN_THREADS_BUDGET: ViewBudget = {
  viewId: 'open_threads',
  buildMode: 'full_rebuild',
  maxChars: 12000,
  maxItemsTotal: 60,
  overflowPolicy: 'drop_low_score',
};

function fileHeader(title: string): string {
  return `# ${title}\n`;
}

function fileMetadata(sourceSummary: string, now: Date): string {
  return `<!-- generated: ${now.toISOString()} | sources: ${sourceSummary} -->\n`;
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
    return right.lastSeenAt - left.lastSeenAt
      || right.trustScore - left.trustScore
      || right.supportCount - left.supportCount
      || left.id.localeCompare(right.id);
  });
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string, maxChars: number, metadata: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n${metadata}${userNotes}\n` : `\n${metadata}${userNotes}\n`;
  const finalized = finalizeMarkdownWithinBudget(header, body, maxChars);
  return finalized.endsWith('\n') ? finalized : `${finalized}\n`;
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
  const header = fileHeader('未完成线索');
  const metadata = fileMetadata(sourceSummary, now);
  const filtered = sortOpenThreadSignals(
    signals.filter((signal) => signal.status === 'active').filter(isOpenThreadSignal),
  );

  const grouped = new Map<string, OpenThreadSignal[]>();
  for (const signal of filtered) {
    const project = cleanProjectName(signal.projectNames[0]);
    const list = grouped.get(project) ?? [];
    list.push(signal);
    grouped.set(project, list);
  }

  const sortedProjectNames = [...grouped.keys()].sort((left, right) => {
    const leftLatest = Math.max(...(grouped.get(left) ?? []).map((signal) => signal.lastSeenAt));
    const rightLatest = Math.max(...(grouped.get(right) ?? []).map((signal) => signal.lastSeenAt));
    return rightLatest - leftLatest || left.localeCompare(right);
  });

  const statusOrder: Array<OpenThreadSignal['payload']['status']> = ['in_progress', 'blocked', 'open'];
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
    let projectItemsWritten = 0;

    for (const status of statusOrder) {
      if (projectItemsWritten >= 10 || itemsWritten >= maxItemsTotal) break;
      const statusSignals = projectSignals.filter((signal) => signal.payload.status === status);
      if (statusSignals.length === 0) continue;

      const remainingForProject = 10 - projectItemsWritten;
      const visibleSignals = statusSignals.slice(0, remainingForProject);
      const statusLines: string[] = [];
      const statusSignalIds: string[] = [];

      for (const signal of visibleSignals) {
        if (itemsWritten >= maxItemsTotal) break;
        const staleness = formatRelativeStaleness(signal.lastSeenAt, generatedAt);
        const line = `- ${formatDateLabel(signal.lastSeenAt)} · ${cleanTitle(signal.payload.title)}${staleness ? `（${staleness}）` : ''}`;
        const candidateSectionLines = [
          ...sectionLines,
          `### ${localizeStatus(status)}`,
          ...statusLines,
          line,
        ];
        const candidateSignalIds = [...sectionSignalIds, ...statusSignalIds, signal.id];
        const candidateSections = [
          ...sections,
          { title: projectName, signalIds: candidateSignalIds, markdown: `${candidateSectionLines.join('\n')}\n` },
        ];
        if (!fitsBudget(buildMarkdown(header, candidateSections, userNotes, budget.maxChars, metadata), budget)) break;

        statusLines.push(line);
        statusSignalIds.push(signal.id);
        sourceSignalIds.push(signal.id);
        itemsWritten++;
        projectItemsWritten++;
      }

      if (statusLines.length === 0) continue;
      sectionLines.push(`### ${localizeStatus(status)}`);
      sectionLines.push(...statusLines);
      sectionSignalIds.push(...statusSignalIds);

      const overflow = statusSignals.length - statusLines.length;
      if (overflow > 0 && projectItemsWritten < 10) {
        sectionLines.push(`- 另有 ${overflow} 项未展开`);
      }
    }

    if (sectionSignalIds.length === 0) continue;
    sections.push({ title: projectName, signalIds: sectionSignalIds, markdown: `${sectionLines.join('\n')}\n` });
  }

  let finalSections = [...sections];
  let finalSignalIds = Array.from(new Set(sourceSignalIds));
  let markdown = buildMarkdown(header, finalSections, userNotes, budget.maxChars, metadata);

  while (finalSections.length > 0 && !fitsBudget(markdown, budget)) {
    const removed = finalSections.pop();
    const removedIds = new Set(removed?.signalIds ?? []);
    finalSignalIds = finalSignalIds.filter((id) => !removedIds.has(id));
    markdown = buildMarkdown(header, finalSections, userNotes, budget.maxChars, metadata);
  }

  if (!fitsBudget(markdown, budget)) {
    finalSections = [];
    finalSignalIds = [];
    markdown = buildMarkdown(header, [], DEFAULT_USER_NOTES, budget.maxChars, metadata);
  }

  return {
    viewId: budget.viewId,
    title: '未完成线索',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown,
  };
}
