import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';

const DIMENSION_ORDER = ['交互风格', '语言偏好', '技术审美', '工作节奏'];
const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';

type WorkStyleSignal = Extract<CanonicalSignal, { kind: 'work_style' }>;

export const WORK_PROFILE_BUDGET: ViewBudget = {
  viewId: 'work_profile',
  buildMode: 'full_rebuild',
  maxChars: 10000,
  maxItemsTotal: 30,
  maxSections: 4,
  overflowPolicy: 'drop_low_score',
};

function fileHeader(title: string, sourceSummary: string, now: Date): string {
  return `<!-- generated: ${now.toISOString().replace('Z', '+00:00')} -->\n<!-- sources: ${sourceSummary} -->\n# ${title}\n`;
}

function sanitizeRationale(value: string): string {
  return value
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWorkStyleSignal(signal: CanonicalSignal): signal is WorkStyleSignal {
  return signal.kind === 'work_style';
}

function sortSignals(signals: WorkStyleSignal[]): WorkStyleSignal[] {
  return [...signals].sort((left, right) => (
    right.trustScore - left.trustScore
    || right.supportCount - left.supportCount
    || right.confidence - left.confidence
    || right.lastSeenAt - left.lastSeenAt
    || left.id.localeCompare(right.id)
  ));
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

function isDuplicateClaim(existing: string[], candidate: string): boolean {
  const normalized = candidate.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return true;
  return existing.some((item) => {
    const normalizedItem = item.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalizedItem === normalized) return true;
    const shorter = normalizedItem.length <= normalized.length ? normalizedItem : normalized;
    const longer = normalizedItem.length > normalized.length ? normalizedItem : normalized;
    return longer.includes(shorter) && shorter.length >= longer.length * 0.6;
  });
}

function isRationaleRedundant(claim: string, rationale: string | undefined): boolean {
  if (rationale == null || rationale.length === 0) return true;
  const cleanRationale = sanitizeRationale(rationale);
  if (cleanRationale.length === 0) return true;
  const normalizedClaim = claim.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedRationale = cleanRationale.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalizedClaim === normalizedRationale;
}

function renderLine(signal: WorkStyleSignal): string {
  const { claim, rationale } = signal.payload;
  const showRationale = !isRationaleRedundant(claim, rationale);
  const rationalePart = showRationale ? ` — *${sanitizeRationale(rationale!)}*` : '';
  return `- ${claim}${rationalePart} (${signal.supportCount} 条证据, 信任度 ${signal.trustScore})`;
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n` : '\n';
  return `${header}${body}${userNotes}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export function compileWorkProfileView(
  signals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
): PublishedView {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('工作画像', sourceSummary, now);

  const filteredSignals = sortSignals(
    signals.filter((signal) => signal.status === 'active').filter(isWorkStyleSignal),
  );

  const grouped = new Map<string, WorkStyleSignal[]>();
  for (const signal of filteredSignals) {
    const dimension = signal.payload.dimension;
    const list = grouped.get(dimension) ?? [];
    list.push(signal);
    grouped.set(dimension, list);
  }

  const dimensionNames = [...grouped.keys()].sort((left, right) => {
    const leftIndex = DIMENSION_ORDER.indexOf(left);
    const rightIndex = DIMENSION_ORDER.indexOf(right);
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex)
      || left.localeCompare(right);
  });

  const limitedDimensions = budget.maxSections == null
    ? dimensionNames
    : dimensionNames.slice(0, budget.maxSections);

  const sections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  const droppedSignalIds: string[] = [];
  const droppedReasons: string[] = [];
  const maxItemsTotal = Math.min(
    budget.maxItemsTotal ?? Number.POSITIVE_INFINITY,
    budget.maxSignals ?? Number.POSITIVE_INFINITY,
  );
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = 0;

  for (const dimension of limitedDimensions) {
    if (itemsWritten >= maxItemsTotal) break;

    const dimensionSignals = grouped.get(dimension) ?? [];
    const maxItemsPerSection = budget.maxItemsPerSection ?? dimensionSignals.length;
    const sectionLines = [`## ${dimension}`];
    const sectionSignalIds: string[] = [];
    const claimsInSection: string[] = [];

    for (const signal of dimensionSignals) {
      if (itemsWritten >= maxItemsTotal || sectionSignalIds.length >= maxItemsPerSection) {
        droppedSignalIds.push(signal.id);
        droppedReasons.push('over_budget');
        continue;
      }

      if (isDuplicateClaim(claimsInSection, signal.payload.claim)) {
        droppedSignalIds.push(signal.id);
        droppedReasons.push('duplicate_claim');
        continue;
      }

      const line = renderLine(signal);
      if (line.length === 0) continue;

      const candidateSectionLines = [...sectionLines, line];
      const candidateSignalIds = [...sectionSignalIds, signal.id];
      const candidateSections = [
        ...sections,
        { title: dimension, signalIds: candidateSignalIds, markdown: `${candidateSectionLines.join('\n')}\n` },
      ];
      const candidateMarkdown = buildMarkdown(header, candidateSections, userNotes);
      if (!fitsBudget(candidateMarkdown, budget)) {
        droppedSignalIds.push(signal.id);
        droppedReasons.push('over_char_budget');
        continue;
      }

      sectionLines.push(line);
      sectionSignalIds.push(signal.id);
      sourceSignalIds.push(signal.id);
      claimsInSection.push(signal.payload.claim);
      itemsWritten++;
    }

    if (sectionSignalIds.length === 0) continue;

    sections.push({ title: dimension, signalIds: sectionSignalIds, markdown: `${sectionLines.join('\n')}\n` });
  }

  if (budget.maxSections != null && dimensionNames.length > budget.maxSections) {
    for (const dimension of dimensionNames.slice(budget.maxSections)) {
      for (const signal of grouped.get(dimension) ?? []) {
        droppedSignalIds.push(signal.id);
        droppedReasons.push('section_over_budget');
      }
    }
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
    title: '工作画像',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
