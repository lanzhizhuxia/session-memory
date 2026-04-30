import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';
import { INVALID_TIMESTAMP } from '../merge.js';
import { areNearDuplicateTexts, cleanEvidence, cleanProjectName, cleanTitle, finalizeMarkdownWithinBudget, localizeTrust } from './view-text.js';
import { polishSections, type PolishConfig } from './polish.js';

const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';
const DECISIONS_POLISH_PROMPT = `你是一个技术决策日志编辑。输入是按项目分组的技术决策记录草稿，输出是润色后的中文版本。

要求：
- 确保所有决定、理由、替代方案都是通顺的中文
- 英文内容翻译为中文，技术术语保留原文
- 修正不完整的句子，使每条理由都是完整表述
- 不要编造缺失的事实，只润色已有内容的表达
- 保持 ## 项目 / ### 日期 / - **决定/理由/替代方案/依据强度** 的结构
- 每个 section 的 sectionId 必须保持不变

输出严格 JSON 格式：{ "sections": [{ "sectionId": "...", "markdown": "..." }] }`;

type DecisionSignal = Extract<CanonicalSignal, { kind: 'decision' }>;

const RECENT_SECTION_TITLE = '最近决策';
const RECENT_SECTION_ID = '__recent__';
const RECENT_DAYS = 3;
const RECENT_RESERVE_ITEMS = 12;
const RECENT_RESERVE_CHARS = 3500;
const DAY_MS = 86_400_000;

export const DECISIONS_BUDGET: ViewBudget = {
  viewId: 'decisions',
  buildMode: 'full_rebuild',
  maxChars: 16000,
  maxItemsTotal: 50,
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

function isDecisionSignal(signal: CanonicalSignal): signal is DecisionSignal {
  return signal.kind === 'decision';
}

function effectiveDate(signal: DecisionSignal): string {
  if (signal.payload.trigger != null && signal.payload.trigger.length > 0) {
    const dateMatch = /^\d{4}-\d{2}-\d{2}/.exec(signal.payload.trigger);
    if (dateMatch != null) return dateMatch[0];
  }
  if (signal.lastSeenAt > INVALID_TIMESTAMP) {
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
  const rationale = cleanEvidence(signal.payload.rationale, 250);
  const alternatives = signal.payload.alternatives.map((item) => cleanEvidence(item, 120)).filter((item) => item.length > 0);
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

function renderRecentDecisionEntry(signal: DecisionSignal, projectName: string): string {
  const topic = cleanTitle(signal.payload.topic);
  const decision = cleanTitle(signal.payload.decision);
  const trustLabel = localizeTrust(signal.trustScore, signal.supportCount);
  const projectTag = `**[${projectName}]**`;
  if (areNearDuplicateTexts(topic, decision)) {
    return `- ${projectTag} ${decision} _(${trustLabel})_`;
  }
  return `- ${projectTag} ${topic} — ${decision} _(${trustLabel})_`;
}

function buildRecentSection(
  signals: DecisionSignal[],
  projectNameById: Map<string, string>,
): { markdown: string; signalIds: string[] } {
  if (signals.length === 0) return { markdown: '', signalIds: [] };

  const byDate = new Map<string, DecisionSignal[]>();
  for (const signal of signals) {
    const date = effectiveDate(signal);
    const list = byDate.get(date) ?? [];
    list.push(signal);
    byDate.set(date, list);
  }
  const sortedDates = [...byDate.keys()].sort((left, right) => right.localeCompare(left));

  const lines: string[] = [`## ${RECENT_SECTION_TITLE}`];
  const signalIds: string[] = [];

  for (const date of sortedDates) {
    lines.push(`### ${date}`);
    const entries = byDate.get(date) ?? [];
    for (const signal of entries) {
      const projectName = projectNameById.get(signal.id) ?? cleanProjectName(signal.projectNames[0], '未归类项目');
      lines.push(renderRecentDecisionEntry(signal, projectName));
      signalIds.push(signal.id);
    }
  }

  return { markdown: `${lines.join('\n')}\n`, signalIds };
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string, metadata: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n` : '\n';
  return `${header}${body}${metadata}${userNotes}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

function pickRecentSignals(
  sortedSignals: DecisionSignal[],
  generatedAt: number,
  maxItems: number,
  maxChars: number,
  projectNameById: Map<string, string>,
): DecisionSignal[] {
  const cutoffIso = new Date(generatedAt - RECENT_DAYS * DAY_MS).toISOString().slice(0, 10);
  const todayIso = new Date(generatedAt).toISOString().slice(0, 10);
  const picked: DecisionSignal[] = [];
  let charBudget = maxChars;
  for (const signal of sortedSignals) {
    if (picked.length >= maxItems) break;
    const date = effectiveDate(signal);
    if (date === 'unknown') continue;
    if (date < cutoffIso || date > todayIso) continue;
    const projectName = projectNameById.get(signal.id) ?? cleanProjectName(signal.projectNames[0], '未归类项目');
    const entry = renderRecentDecisionEntry(signal, projectName);
    const cost = entry.length + 5;
    if (cost > charBudget) break;
    picked.push(signal);
    charBudget -= cost;
  }
  return picked;
}

export async function compileDecisionsView(
  signals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
  polishConfig?: PolishConfig,
): Promise<PublishedView> {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('决策日志');
  const metadata = fileMetadata(sourceSummary, now);
  const decisionSignals = signals.filter((signal) => signal.status === 'active').filter(isDecisionSignal);
  const filtered = sortDecisionSignals(
    decisionSignals.filter((signal) => signal.lastSeenAt > INVALID_TIMESTAMP),
  );

  const projectNameById = new Map<string, string>();
  for (const signal of filtered) {
    projectNameById.set(signal.id, cleanProjectName(signal.projectNames[0], '未归类项目'));
  }

  const recentSignals = pickRecentSignals(
    filtered,
    generatedAt,
    RECENT_RESERVE_ITEMS,
    RECENT_RESERVE_CHARS,
    projectNameById,
  );
  const recentIds = new Set(recentSignals.map((signal) => signal.id));
  const recentSection = buildRecentSection(recentSignals, projectNameById);

  const grouped = new Map<string, DecisionSignal[]>();
  for (const signal of filtered) {
    if (recentIds.has(signal.id)) continue;
    const project = projectNameById.get(signal.id) ?? cleanProjectName(signal.projectNames[0], '未归类项目');
    const list = grouped.get(project) ?? [];
    list.push(signal);
    grouped.set(project, list);
  }

  const sortedProjectNames = [...grouped.keys()].sort((left, right) => left.localeCompare(right));

  const draftSections: PublishedViewSection[] = [];
  const sectionIdByIndex: string[] = [];
  const signalIdsKeyBySectionId = new Map<string, string>();

  if (recentSection.markdown.length > 0) {
    draftSections.push({
      title: RECENT_SECTION_TITLE,
      signalIds: recentSection.signalIds,
      markdown: recentSection.markdown,
    });
    sectionIdByIndex.push(RECENT_SECTION_ID);
    signalIdsKeyBySectionId.set(RECENT_SECTION_ID, recentSection.signalIds.join(','));
  }
  const sourceSignalIds: string[] = [...recentSection.signalIds];
  const maxItemsTotal = Math.min(budget.maxItemsTotal ?? Number.POSITIVE_INFINITY, budget.maxSignals ?? Number.POSITIVE_INFINITY);
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = recentSection.signalIds.length;

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
          ...draftSections,
          { title: projectName, signalIds: candidateSignalIds, markdown: `${candidateSectionLines.join('\n')}\n` },
        ];
      const candidateMarkdown = buildMarkdown(header, candidateSections, userNotes, metadata);
      if (!fitsBudget(candidateMarkdown, budget)) break;

      sectionLines.push(block);
      sectionSignalIds.push(signal.id);
      sourceSignalIds.push(signal.id);
      itemsWritten++;
    }

    if (sectionSignalIds.length === 0) continue;

    draftSections.push({ title: projectName, signalIds: sectionSignalIds, markdown: `${sectionLines.join('\n')}\n` });
    sectionIdByIndex.push(projectName);
    signalIdsKeyBySectionId.set(projectName, sectionSignalIds.join(','));
  }

  const polishInputs = draftSections.map((section, idx) => {
    const sectionId = sectionIdByIndex[idx];
    return {
      sectionId,
      title: section.title,
      draftMarkdown: section.markdown,
      signalIdsKey: signalIdsKeyBySectionId.get(sectionId) ?? '',
    };
  });
  const polishedMarkdownById = await polishSections(
    budget.viewId,
    '决策日志',
    polishInputs,
    DECISIONS_POLISH_PROMPT,
    polishConfig ?? {
      enabled: false,
      model: 'gpt-5.4-mini',
      max_chars_per_call: 24000,
      cache_version: 'v1',
      cache_dir: '.state',
    },
  );

  const sections = draftSections.map((section, idx) => {
    const sectionId = sectionIdByIndex[idx];
    return {
      ...section,
      markdown: polishedMarkdownById.get(sectionId) ?? section.markdown,
    };
  });

  let finalSections = [...sections];
  let finalSignalIds = Array.from(new Set(sourceSignalIds));
  let markdown = buildMarkdown(header, finalSections, userNotes, metadata);

  while (finalSections.length > 0 && !fitsBudget(markdown, budget)) {
    const removed = finalSections.pop();
    const removedIds = new Set(removed?.signalIds ?? []);
    finalSignalIds = finalSignalIds.filter((id) => !removedIds.has(id));
    markdown = buildMarkdown(header, finalSections, userNotes, metadata);
  }

  if (!fitsBudget(markdown, budget)) {
    markdown = buildMarkdown(header, [], DEFAULT_USER_NOTES, metadata);
    finalSignalIds = [];
  }

  if (!fitsBudget(markdown, budget)) {
    markdown = finalizeMarkdownWithinBudget(header, '', budget.maxChars);
    finalSections = [];
    finalSignalIds = [];
  }

  const sectionMarkdown = finalSections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n${metadata}${userNotes}\n` : `\n${metadata}${userNotes}\n`;
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
