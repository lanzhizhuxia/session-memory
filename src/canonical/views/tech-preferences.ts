import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';
import { cleanEvidence, finalizeMarkdownWithinBudget, localizeStance } from './view-text.js';
import { polishSections, type PolishConfig } from './polish.js';

const CATEGORY_ORDER = ['前端', '后端', 'AI', '工具', '部署'];
const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';
const TECH_PREFERENCES_POLISH_PROMPT = `你是一个技术栈偏好编辑。输入是技术偏好记录草稿，输出是润色后的中文版本。

要求：
- 将英文 rationale 翻译为中文
- 如果 rationale 为空或过于笼统（如"技术栈中使用 X"），改写为更有信息量的描述
- 保留技术术语原文
- 保持 ## 分类 / - **技术名** (偏好/避免/视场景而定): 描述 — *证据* 的结构
- 每个 section 的 sectionId 必须保持不变

输出严格 JSON 格式：{ "sections": [{ "sectionId": "...", "markdown": "..." }] }`;

interface AggregatedTechPreference {
  category: string;
  representative: Extract<CanonicalSignal, { kind: 'tech_preference' }>;
  signals: Array<Extract<CanonicalSignal, { kind: 'tech_preference' }>>;
}

export const TECH_PREFS_BUDGET: ViewBudget = {
  viewId: 'tech_preferences',
  buildMode: 'full_rebuild',
  maxChars: 12000,
  maxItemsTotal: 40,
  maxSections: 5,
  overflowPolicy: 'drop_low_score',
};

function fileHeader(title: string): string {
  return `# ${title}\n`;
}

function fileMetadata(sourceSummary: string, now: Date): string {
  return `<!-- generated: ${now.toISOString()} | sources: ${sourceSummary} -->\n`;
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

function stanceRank(signal: Extract<CanonicalSignal, { kind: 'tech_preference' }>): number {
  switch (signal.payload.stance) {
    case 'prefer':
      return 2;
    case 'avoid':
      return 1;
    case 'conditional':
      return 0;
  }
}

function displayStance(group: AggregatedTechPreference): 'prefer' | 'avoid' | 'conditional' {
  const stances = new Set(group.signals.map((signal) => signal.payload.stance));
  if (stances.has('prefer') && stances.has('avoid')) {
    return 'conditional';
  }
  if (stances.has('prefer')) {
    return 'prefer';
  }
  if (stances.has('avoid')) {
    return 'avoid';
  }
  return 'conditional';
}

function sortSignals<T extends Extract<CanonicalSignal, { kind: 'tech_preference' }>>(signals: T[]): T[] {
  return [...signals].sort((left, right) => (
    right.trustScore - left.trustScore
    || right.supportCount - left.supportCount
    || right.confidence - left.confidence
    || stanceRank(right) - stanceRank(left)
    || right.lastSeenAt - left.lastSeenAt
    || left.id.localeCompare(right.id)
  ));
}

function isTechPreferenceSignal(
  signal: CanonicalSignal,
): signal is Extract<CanonicalSignal, { kind: 'tech_preference' }> {
  return signal.kind === 'tech_preference';
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

function aggregateSignals(signals: Extract<CanonicalSignal, { kind: 'tech_preference' }>[]): AggregatedTechPreference[] {
  const grouped = new Map<string, AggregatedTechPreference>();

  for (const signal of signals) {
    const key = signal.payload.technology.toLowerCase();
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(key, {
        category: signal.payload.category,
        representative: signal,
        signals: [signal],
      });
      continue;
    }

    existing.signals.push(signal);
    existing.representative = sortSignals([existing.representative, signal])[0];
  }

  return [...grouped.values()].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left.category);
    const rightIndex = CATEGORY_ORDER.indexOf(right.category);
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex)
      || left.representative.payload.technology.localeCompare(right.representative.payload.technology);
  });
}

function renderLine(group: AggregatedTechPreference): string {
  const representative = group.representative;
  const projectCount = new Set(group.signals.flatMap((signal) => signal.projectNames)).size;
  const supportCount = group.signals.reduce((sum, signal) => sum + signal.supportCount, 0);
  const rationale = cleanEvidence(sanitizeRationale(representative.payload.rationale), 100);
  const scopeSuffix = projectCount > 1 ? `, ${projectCount} 个项目` : '';
  const stance = displayStance(group);
  return rationale.length > 0
    ? `- **${representative.payload.technology}** (${localizeStance(stance)}): ${rationale} — *${supportCount} 条证据${scopeSuffix}, 信任度 ${representative.trustScore}*`
    : `- **${representative.payload.technology}** (${localizeStance(stance)}) — *${supportCount} 条证据${scopeSuffix}, 信任度 ${representative.trustScore}*`;
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string, metadata: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n` : '\n';
  return `${header}${body}${metadata}${userNotes}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export async function compileTechPreferencesView(
  signals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
  polishConfig?: PolishConfig,
): Promise<PublishedView> {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('技术偏好');
  const metadata = fileMetadata(sourceSummary, now);
  const filteredSignals = sortSignals(
    signals.filter((signal) => signal.status === 'active').filter(isTechPreferenceSignal),
  );
  const aggregatedSignals = aggregateSignals(filteredSignals);

  const grouped = new Map<string, AggregatedTechPreference[]>();
  for (const group of aggregatedSignals) {
    const list = grouped.get(group.category) ?? [];
    list.push(group);
    grouped.set(group.category, list);
  }

  const configuredSections = budget.sections?.length != null && budget.sections.length > 0
    ? budget.sections
    : undefined;
  const categoryNames = (configuredSections ?? [...grouped.keys()]).filter((category) => grouped.has(category));
  const sortedCategoryNames = [...categoryNames].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left);
    const rightIndex = CATEGORY_ORDER.indexOf(right);
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex) || left.localeCompare(right);
  });

  const limitedCategories = budget.maxSections == null ? sortedCategoryNames : sortedCategoryNames.slice(0, budget.maxSections);
  const draftSections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  const maxItemsTotal = Math.min(budget.maxItemsTotal ?? Number.POSITIVE_INFINITY, budget.maxSignals ?? Number.POSITIVE_INFINITY);
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = 0;

  for (const category of limitedCategories) {
    if (itemsWritten >= maxItemsTotal) break;

    const groupsInCategory = grouped.get(category) ?? [];
    const maxItemsPerSection = budget.maxItemsPerSection ?? groupsInCategory.length;
    const sectionLines = [`## ${category}`];
    const sectionSignalIds: string[] = [];

    for (const group of groupsInCategory) {
      if (itemsWritten >= maxItemsTotal || sectionSignalIds.length >= maxItemsPerSection) break;

      const line = renderLine(group);
      if (line.length === 0) continue;

      const candidateSectionLines = [...sectionLines, line];
      const candidateSignalIds = [...sectionSignalIds, ...group.signals.map((signal) => signal.id)];
      const candidateSections = [
          ...draftSections,
          { title: category, signalIds: candidateSignalIds, markdown: `${candidateSectionLines.join('\n')}\n` },
        ];
      const candidateMarkdown = buildMarkdown(header, candidateSections, userNotes, metadata);
      if (!fitsBudget(candidateMarkdown, budget)) break;

      sectionLines.push(line);
      sectionSignalIds.push(...group.signals.map((signal) => signal.id));
      sourceSignalIds.push(...group.signals.map((signal) => signal.id));
      itemsWritten++;
    }

    if (sectionSignalIds.length === 0) continue;

    draftSections.push({ title: category, signalIds: sectionSignalIds, markdown: `${sectionLines.join('\n')}\n` });
  }

  const polishedMarkdownById = await polishSections(
    budget.viewId,
    '技术偏好',
    draftSections.map((section) => ({ sectionId: section.title, title: section.title, draftMarkdown: section.markdown })),
    TECH_PREFERENCES_POLISH_PROMPT,
    polishConfig ?? {
      enabled: false,
      model: 'gpt-5.4-mini',
      max_chars_per_call: 24000,
      cache_version: 'v1',
      cache_dir: '.state',
    },
  );

  const sections = draftSections.map((section) => ({
    ...section,
    markdown: polishedMarkdownById.get(section.title) ?? section.markdown,
  }));

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
    title: '技术偏好',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
