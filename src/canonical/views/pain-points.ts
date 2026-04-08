import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';

const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';

type PainPointSignal = Extract<CanonicalSignal, { kind: 'pain_point' }>;

const RECURRENCE_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };

export const PAIN_POINTS_BUDGET: ViewBudget = {
  viewId: 'pain_points',
  buildMode: 'full_rebuild',
  maxChars: 12000,
  maxItemsTotal: 35,
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

function isPainPointSignal(signal: CanonicalSignal): signal is PainPointSignal {
  return signal.kind === 'pain_point';
}

function sortPainPointSignals(signals: PainPointSignal[]): PainPointSignal[] {
  return [...signals].sort((left, right) => (
    (RECURRENCE_RANK[right.payload.recurrence] ?? 0) - (RECURRENCE_RANK[left.payload.recurrence] ?? 0)
    || right.trustScore - left.trustScore
    || right.supportCount - left.supportCount
    || right.confidence - left.confidence
    || right.lastSeenAt - left.lastSeenAt
    || left.id.localeCompare(right.id)
  ));
}

function renderPainPointBlock(signal: PainPointSignal): string {
  const lines: string[] = [];
  lines.push(`## ${signal.payload.problem}`);

  if (signal.payload.symptoms != null && signal.payload.symptoms.length > 0) {
    lines.push(`- **典型症状**: ${signal.payload.symptoms.join(', ')}`);
  }

  if (signal.payload.diagnosis != null && signal.payload.diagnosis.length > 0) {
    lines.push(`- **诊断**: ${signal.payload.diagnosis}`);
  }

  if (signal.payload.workaround != null && signal.payload.workaround.length > 0) {
    lines.push(`- **解决方式**: ${signal.payload.workaround}`);
  }

  lines.push(`- **复发频率**: ${signal.payload.recurrence}`);
  lines.push(`- **来源**: ${signal.supportCount} 条证据, 信任度 ${signal.trustScore}`);

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

export function compilePainPointsView(
  signals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
): PublishedView {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('反复痛点', sourceSummary, now);
  const filtered = sortPainPointSignals(
    signals.filter((signal) => signal.status === 'active').filter(isPainPointSignal),
  );

  const sections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  const maxItemsTotal = Math.min(budget.maxItemsTotal ?? Number.POSITIVE_INFINITY, budget.maxSignals ?? Number.POSITIVE_INFINITY);
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = 0;

  for (const signal of filtered) {
    if (itemsWritten >= maxItemsTotal) break;

    const block = renderPainPointBlock(signal);
    if (block.length === 0) continue;

    const candidateSections = [
      ...sections,
      { title: signal.payload.problem, signalIds: [signal.id], markdown: `${block}\n` },
    ];
    const candidateMarkdown = buildMarkdown(header, candidateSections, userNotes);
    if (!fitsBudget(candidateMarkdown, budget)) break;

    sections.push({ title: signal.payload.problem, signalIds: [signal.id], markdown: `${block}\n` });
    sourceSignalIds.push(signal.id);
    itemsWritten++;
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
    title: '反复痛点',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
