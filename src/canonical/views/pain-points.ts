import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';
import { cleanEvidence, cleanTitle, finalizeMarkdownWithinBudget, localizeRecurrence, localizeTrust } from './view-text.js';
import { polishSections, type PolishConfig } from './polish.js';

const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';
const PAIN_POINTS_POLISH_PROMPT = `你是一个技术问题诊断编辑。输入是反复出现的技术痛点记录草稿，输出是润色后的中文版本。

要求：
- 确保问题描述、诊断、解决方式都是通顺完整的中文
- 将英文通用技术词翻译为中文（如 runner→运行器, dashboard→仪表板, fallback→兜底, speaker→说话人, meeting entity→会议实体, arch-specific→架构相关, workaround→变通方案）
- 保留技术专有名词和标识符原文（文件名/路径、命令名、类/函数名、配置项、SDK/库名、HTTP 状态码、错误码等）
- 修正截断的句子，使每个字段都是完整表述
- 不要编造缺失的诊断或解决方案
- 保持 ## 问题 / - **诊断/解决方式/复发频率/依据强度** 的结构
- 每个 section 的 sectionId 必须保持不变

输出严格 JSON 格式：{ "sections": [{ "sectionId": "...", "markdown": "..." }] }`;

type PainPointSignal = Extract<CanonicalSignal, { kind: 'pain_point' }>;

const RECURRENCE_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };

export const PAIN_POINTS_BUDGET: ViewBudget = {
  viewId: 'pain_points',
  buildMode: 'full_rebuild',
  maxChars: 12000,
  maxItemsTotal: 35,
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
  const diagnosis = signal.payload.diagnosis != null && signal.payload.diagnosis.length > 0
    ? cleanEvidence(signal.payload.diagnosis, 250)
    : '';
  const workaround = signal.payload.workaround != null && signal.payload.workaround.length > 0
    ? cleanEvidence(signal.payload.workaround, 250)
    : '';

  if (diagnosis.length === 0 && workaround.length === 0) return '';

  const lines: string[] = [];
  lines.push(`## ${cleanTitle(signal.payload.problem)}`);

  if (signal.payload.symptoms != null && signal.payload.symptoms.length > 0) {
    lines.push(`- **典型症状**: ${signal.payload.symptoms.join(', ')}`);
  }

  if (diagnosis.length > 0) {
    lines.push(`- **诊断**: ${diagnosis}`);
  }

  if (workaround.length > 0) {
    lines.push(`- **解决方式**: ${workaround}`);
  }

  lines.push(`- **复发频率**: ${localizeRecurrence(signal.payload.recurrence)}`);
  lines.push(`- **依据强度**: ${localizeTrust(signal.trustScore, signal.supportCount)}`);

  return lines.join('\n');
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string, metadata: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n` : '\n';
  return `${header}${body}${metadata}${userNotes}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export async function compilePainPointsView(
  signals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
  polishConfig?: PolishConfig,
): Promise<PublishedView> {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('反复痛点');
  const metadata = fileMetadata(sourceSummary, now);
  const filtered = sortPainPointSignals(
    signals.filter((signal) => signal.status === 'active').filter(isPainPointSignal),
  );

  const draftSections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  const maxItemsTotal = Math.min(budget.maxItemsTotal ?? Number.POSITIVE_INFINITY, budget.maxSignals ?? Number.POSITIVE_INFINITY);
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = 0;

  for (const signal of filtered) {
    if (itemsWritten >= maxItemsTotal) break;

    const block = renderPainPointBlock(signal);
    if (block.length === 0) continue;

    const candidateSections = [
        ...draftSections,
        { title: signal.payload.problem, signalIds: [signal.id], markdown: `${block}\n` },
      ];
    const candidateMarkdown = buildMarkdown(header, candidateSections, userNotes, metadata);
    if (!fitsBudget(candidateMarkdown, budget)) break;

    draftSections.push({ title: signal.payload.problem, signalIds: [signal.id], markdown: `${block}\n` });
    sourceSignalIds.push(signal.id);
    itemsWritten++;
  }

  const polishedMarkdownById = await polishSections(
    budget.viewId,
    '反复痛点',
    draftSections.map((section) => ({ sectionId: section.title, title: section.title, draftMarkdown: section.markdown })),
    PAIN_POINTS_POLISH_PROMPT,
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
    title: '反复痛点',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
