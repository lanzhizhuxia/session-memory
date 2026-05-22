import type {
  CanonicalSignal,
  PublishedView,
  PublishedViewArchiveIndexEntry,
  PublishedViewSection,
  ViewBudget,
} from '../types.js';
import { INVALID_TIMESTAMP } from '../merge.js';
import { areNearDuplicateTexts, cleanEvidence, cleanProjectName, cleanTitle, finalizeMarkdownWithinBudget, localizeTrust } from './view-text.js';
import { polishSections, type PolishConfig } from './polish.js';
import { MODEL_DEFAULTS } from '../../utils/model-defaults.js';
import { buildArchive, renderHistoryIndexSection, type MonthlyBucket } from './archive.js';

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
      model: MODEL_DEFAULTS.polish,
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

export const DECISIONS_ARCHIVE_BUDGET: ViewBudget = {
  viewId: 'decisions',
  buildMode: 'full_rebuild',
  maxChars: Number.MAX_SAFE_INTEGER,
  overflowPolicy: 'truncate',
  modality: 'event',
  retention: {
    mode: 'archive_by_month',
    currentMonths: 12,
    archivePath: 'archive/决策日志-archive.md',
  },
};

function effectiveTimestamp(signal: DecisionSignal): number {
  if (signal.payload.trigger != null && signal.payload.trigger.length > 0) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(signal.payload.trigger);
    if (m != null) {
      const parsed = Date.parse(`${m[1]}T12:00:00Z`);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (signal.lastSeenAt > INVALID_TIMESTAMP) return signal.lastSeenAt;
  if (signal.firstSeenAt > INVALID_TIMESTAMP) return signal.firstSeenAt;
  return 0;
}

function renderDecisionEntry(signal: DecisionSignal): string {
  const date = effectiveDate(signal);
  const projectName = cleanProjectName(signal.projectNames[0], '未归类项目');
  const topic = cleanTitle(signal.payload.topic);
  const decision = cleanTitle(signal.payload.decision);
  const rationale = cleanEvidence(signal.payload.rationale, 250);
  const alternatives = signal.payload.alternatives
    .map((item) => cleanEvidence(item, 120))
    .filter((item) => item.length > 0);
  const lines: string[] = [];
  lines.push(`### ${date} · [${projectName}]`);
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
  lines.push('');
  return lines.join('\n');
}

function renderBucketGroupForDecisions(buckets: MonthlyBucket[]): { markdown: string; sections: PublishedViewSection[] } {
  if (buckets.length === 0) return { markdown: '', sections: [] };
  const sections: PublishedViewSection[] = [];
  const parts: string[] = [];
  for (const b of buckets) {
    const decisionSignals = b.signals.filter(isDecisionSignal);
    const sortedInBucket = sortDecisionSignals(decisionSignals);
    const sectionLines: string[] = [`## ${b.yearMonth}`, ''];
    const sectionIds: string[] = [];
    for (const s of sortedInBucket) {
      sectionLines.push(renderDecisionEntry(s));
      sectionIds.push(s.id);
    }
    const sectionMd = sectionLines.join('\n');
    parts.push(sectionMd);
    sections.push({ title: b.yearMonth, signalIds: sectionIds, markdown: sectionMd });
  }
  return { markdown: parts.join('\n'), sections };
}

function archiveFileHeader(metadata: string, archivePath: string | undefined): string {
  const archiveDirective = archivePath != null ? `\n<!-- archive: ${archivePath} -->\n` : '';
  return `<!-- modality: event -->\n<!-- retention: archive_by_month(currentMonths=12) -->${archiveDirective}# 决策日志\n\n${metadata}`;
}

function archiveSubFileHeader(metadata: string): string {
  return `<!-- modality: event -->\n<!-- retention: archive (overflow from 决策日志.md) -->\n# 决策日志 · 历史归档\n\n${metadata}`;
}

export interface CompileDecisionsArchiveResult {
  view: PublishedView;
  archiveMarkdown: string;
}

function renderUndatedSection(undatedSignals: DecisionSignal[]): { markdown: string; section: PublishedViewSection | null } {
  if (undatedSignals.length === 0) return { markdown: '', section: null };
  const sorted = sortDecisionSignals(undatedSignals);
  const lines: string[] = ['## 未定日期', ''];
  const ids: string[] = [];
  for (const s of sorted) {
    const projectName = cleanProjectName(s.projectNames[0], '未归类项目');
    const topic = cleanTitle(s.payload.topic);
    const decision = cleanTitle(s.payload.decision);
    const rationale = cleanEvidence(s.payload.rationale, 250);
    const alternatives = s.payload.alternatives
      .map((item) => cleanEvidence(item, 120))
      .filter((item) => item.length > 0);
    lines.push(`### 未定日期 · [${projectName}]`);
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
    lines.push(`- **依据强度**: ${localizeTrust(s.trustScore, s.supportCount)}`);
    if (s.payload.trigger != null && s.payload.trigger.length > 0) {
      lines.push(`- **trigger（无可解析日期）**: ${cleanEvidence(s.payload.trigger, 200)}`);
    }
    lines.push('');
    ids.push(s.id);
  }
  const markdown = lines.join('\n');
  return { markdown, section: { title: '未定日期', signalIds: ids, markdown } };
}

export async function compileDecisionsArchiveView(
  signals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
  _polishConfig?: PolishConfig,
): Promise<CompileDecisionsArchiveResult> {
  if (budget.retention?.mode !== 'archive_by_month') {
    throw new Error('compileDecisionsArchiveView requires retention.mode=archive_by_month');
  }
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const metadata = `<!-- generated: ${now.toISOString()} | sources: ${sourceSummary} -->\n\n`;

  const allActiveDecisions = signals
    .filter((s) => s.status === 'active')
    .filter(isDecisionSignal);
  const datedSignals = allActiveDecisions.filter((s) => effectiveTimestamp(s) > 0);
  const undatedSignals = allActiveDecisions.filter((s) => effectiveTimestamp(s) <= 0);

  const archive = buildArchive({
    signals: datedSignals as CanonicalSignal[],
    effectiveTimestamp: (s) => effectiveTimestamp(s as DecisionSignal),
    currentMonths: budget.retention.currentMonths,
    nowMs: generatedAt,
  });

  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  const archivePath = budget.retention.archivePath;

  const currentRender = renderBucketGroupForDecisions(archive.currentBuckets);
  const undatedRender = renderUndatedSection(undatedSignals);
  const indexSection = renderHistoryIndexSection(archive.index, archivePath);

  const mainHeader = archiveFileHeader(metadata, archivePath);
  const mainBodyParts: string[] = [];
  if (currentRender.markdown.length > 0) mainBodyParts.push(currentRender.markdown);
  if (undatedRender.markdown.length > 0) mainBodyParts.push(undatedRender.markdown);
  const mainBody = mainBodyParts.length > 0 ? `${mainBodyParts.join('\n\n')}\n\n` : '';
  const mainTail = `${indexSection}\n${userNotes}\n`;
  const mainMarkdown = `${mainHeader}${mainBody}${mainTail}`;

  const archiveRender = renderBucketGroupForDecisions(archive.archiveBuckets);
  const archiveMarkdown = archive.archiveBuckets.length > 0
    ? `${archiveSubFileHeader(metadata)}${archiveRender.markdown}\n`
    : '';

  const sourceSignalIds: string[] = [];
  for (const b of archive.currentBuckets) for (const s of b.signals) sourceSignalIds.push(s.id);
  for (const b of archive.archiveBuckets) for (const s of b.signals) sourceSignalIds.push(s.id);
  for (const s of undatedSignals) sourceSignalIds.push(s.id);

  const archiveIndex: PublishedViewArchiveIndexEntry[] = archive.index;

  const sections = [...currentRender.sections];
  if (undatedRender.section != null) sections.push(undatedRender.section);

  const view: PublishedView = {
    viewId: budget.viewId,
    title: '决策日志',
    generatedAt,
    sourceSignalIds,
    budget,
    sections,
    markdown: mainMarkdown,
    archiveFile: archivePath,
    archiveIndex,
  };

  return { view, archiveMarkdown };
}
