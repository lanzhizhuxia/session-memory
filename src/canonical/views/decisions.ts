import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';

const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';

type DecisionSignal = Extract<CanonicalSignal, { kind: 'decision' }>;

export const DECISIONS_BUDGET: ViewBudget = {
  viewId: 'decisions',
  buildMode: 'full_rebuild',
  maxChars: 16000,
  maxItemsTotal: 50,
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

function isDecisionSignal(signal: CanonicalSignal): signal is DecisionSignal {
  return signal.kind === 'decision';
}

function effectiveDate(signal: DecisionSignal): string {
  if (signal.payload.trigger != null && signal.payload.trigger.length > 0) {
    const dateMatch = /^\d{4}-\d{2}-\d{2}/.exec(signal.payload.trigger);
    if (dateMatch != null) return dateMatch[0];
  }
  if (signal.lastSeenAt > 0) {
    return new Date(signal.lastSeenAt).toISOString().slice(0, 10);
  }
  return 'unknown';
}

function sortDecisionSignals(signals: DecisionSignal[]): DecisionSignal[] {
  return [...signals].sort((left, right) => (
    effectiveDate(right).localeCompare(effectiveDate(left))
    || right.trustScore - left.trustScore
    || right.supportCount - left.supportCount
    || right.confidence - left.confidence
    || right.lastSeenAt - left.lastSeenAt
    || left.id.localeCompare(right.id)
  ));
}

function renderDecisionBlock(signal: DecisionSignal): string {
  const date = effectiveDate(signal);
  const lines: string[] = [];
  lines.push(`### ${date}: ${signal.payload.topic}`);
  lines.push(`- **决定**: ${signal.payload.decision}`);

  if (signal.payload.rationale.length > 0) {
    lines.push(`- **理由**: ${signal.payload.rationale}`);
  }

  if (signal.payload.alternatives.length > 0) {
    lines.push(`- **替代方案**: ${signal.payload.alternatives.join(', ')}`);
  }

  const trustLabel = signal.trustScore >= 4 ? '高信任' : 'session 提取';
  lines.push(`- **来源**: ${trustLabel}, ${signal.supportCount} 条证据`);

  return lines.join('\n');
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n` : '\n';
  return `${header}${body}${userNotes}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export function compileDecisionsView(
  signals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
): PublishedView {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('决策日志', sourceSummary, now);
  const filtered = sortDecisionSignals(
    signals.filter((signal) => signal.status === 'active').filter(isDecisionSignal),
  );

  const grouped = new Map<string, DecisionSignal[]>();
  for (const signal of filtered) {
    const project = signal.projectNames.length > 0 ? signal.projectNames[0] : 'cross_project';
    const list = grouped.get(project) ?? [];
    list.push(signal);
    grouped.set(project, list);
  }

  const sortedProjectNames = [...grouped.keys()].sort((left, right) => left.localeCompare(right));

  const sections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  const maxItemsTotal = Math.min(budget.maxItemsTotal ?? Number.POSITIVE_INFINITY, budget.maxSignals ?? Number.POSITIVE_INFINITY);
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = 0;

  for (const projectName of sortedProjectNames) {
    if (itemsWritten >= maxItemsTotal) break;

    const projectSignals = grouped.get(projectName) ?? [];
    const sectionLines = [`## ${projectName}`];
    const sectionSignalIds: string[] = [];

    for (const signal of projectSignals) {
      if (itemsWritten >= maxItemsTotal) break;

      const block = renderDecisionBlock(signal);
      if (block.length === 0) continue;

      const candidateSectionLines = [...sectionLines, block];
      const candidateSignalIds = [...sectionSignalIds, signal.id];
      const candidateSections = [
        ...sections,
        { title: projectName, signalIds: candidateSignalIds, markdown: `${candidateSectionLines.join('\n')}\n` },
      ];
      const candidateMarkdown = buildMarkdown(header, candidateSections, userNotes);
      if (!fitsBudget(candidateMarkdown, budget)) break;

      sectionLines.push(block);
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
    title: '决策日志',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
