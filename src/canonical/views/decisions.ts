import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';
import { areNearDuplicateTexts, cleanEvidence, cleanProjectName, cleanTitle, finalizeMarkdownWithinBudget, localizeTrust } from './view-text.js';

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

function normalizeForDedup(input: string): string {
  return cleanTitle(input)
    .toLowerCase()
    .replace(/[\p{P}\p{S}。.!！?？…]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderDecisionBlock(signal: DecisionSignal): string {
  const date = effectiveDate(signal);
  const topic = cleanTitle(signal.payload.topic);
  const decision = cleanTitle(signal.payload.decision);
  const rationale = cleanEvidence(signal.payload.rationale, 120);
  const alternatives = signal.payload.alternatives.map((item) => cleanEvidence(item, 80)).filter((item) => item.length > 0);
  const lines: string[] = [];
  lines.push(`### ${date}`);
  if (!areNearDuplicateTexts(topic, decision)) {
    lines.push(`- **主题**: ${topic}`);
  }
  lines.push(`- **决定**: ${decision}`);

  if (rationale.length > 0 && rationale !== decision) {
    lines.push(`- **理由**: ${rationale}`);
  }

  if (alternatives.length > 0) {
    lines.push(`- **替代方案**: ${alternatives.join('，')}`);
  }

  lines.push(`- **依据强度**: ${localizeTrust(signal.trustScore, signal.supportCount)}`);

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
    const project = cleanProjectName(signal.projectNames[0], '未归类项目');
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
    const seen = new Map<string, DecisionSignal>();
    for (const signal of projectSignals) {
      const key = `${effectiveDate(signal)}|${normalizeForDedup(signal.payload.decision)}`;
      const existing = seen.get(key);
      if (
        existing == null
        || signal.trustScore > existing.trustScore
        || (signal.trustScore === existing.trustScore && signal.supportCount > existing.supportCount)
      ) {
        seen.set(key, signal);
      }
    }
    const dedupedSignals = sortDecisionSignals([...seen.values()]);
    const sectionLines = [`## ${projectName}`];
    const sectionSignalIds: string[] = [];

    for (const signal of dedupedSignals) {
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
    markdown = finalizeMarkdownWithinBudget(header, '', budget.maxChars);
    finalSections = [];
    finalSignalIds = [];
  }

  const sectionMarkdown = finalSections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n${userNotes}\n` : `\n${userNotes}\n`;
  const finalized = finalizeMarkdownWithinBudget(header, body, budget.maxChars);
  const boundedMarkdown = finalized.endsWith('\n') ? finalized : `${finalized}\n`;

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
