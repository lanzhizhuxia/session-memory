import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';

type TimelineSignal = Extract<CanonicalSignal, { kind: 'timeline_event' }>;

const DEFAULT_USER_NOTES = '<!-- user notes -->\n<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->\n<!-- /user notes -->';

export const TIMELINE_BUDGET: ViewBudget = {
  viewId: 'timeline',
  buildMode: 'full_rebuild',
  maxChars: 18000,
  maxItemsTotal: 80,
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

function isTimelineSignal(signal: CanonicalSignal): signal is TimelineSignal {
  return signal.kind === 'timeline_event';
}

function sortTimelineSignals(signals: TimelineSignal[]): TimelineSignal[] {
  return [...signals].sort((left, right) => (
    right.payload.date.localeCompare(left.payload.date)
    || right.trustScore - left.trustScore
    || right.supportCount - left.supportCount
    || right.lastSeenAt - left.lastSeenAt
    || left.id.localeCompare(right.id)
  ));
}

function clampDescription(text: string, maxChars: number = 40): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trim()}…`;
}

function cleanSessionTitle(title: string): string {
  return title
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/\((?:subagent|agent|retry|followup)[^)]+\)$/i, '')
    .replace(/\b(?:subagent|agent|followup|retry)\b.*$/i, '')
    .replace(/[|｜].*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreProjectThemes(titles: string[]): Map<string, number> {
  const themeScores = new Map<string, number>();
  const themePatterns: Array<{ label: string; pattern: RegExp }> = [
    { label: 'AI 企业知识库助手', pattern: /知识库|knowledge\s*base|知识管理|knowledge\s*manage/i },
    { label: '语音会议记录与转录', pattern: /转录|transcri|语音|whisper|说话人|speaker/i },
    { label: '量化交易回测', pattern: /量化|quant|回测|backtest/i },
    { label: '资金费率套利', pattern: /资金费率|funding\s*rate|套利|arbitrage/i },
    { label: '交易基础设施', pattern: /交易系统|exchange|撮合|gateway|broker/i },
    { label: '风控系统', pattern: /风控|risk\s*control|risk\s*manage/i },
    { label: 'RWA 代币化', pattern: /\bRWA\b|代币化|tokeniz/i },
    { label: 'AI Agent 工具链', pattern: /\bagent\b.*tool|opencode|davidbot/i },
    { label: 'Meme 交易工具', pattern: /\bmeme\b|pump\.fun|four\.meme/i },
    { label: '加密货币分析', pattern: /加密货币|crypto|区块链|blockchain|链上|on-?chain/i },
    { label: 'PRD 产品管理', pattern: /\bPRD\b|产品需求|需求文档/i },
  ];

  for (const title of titles) {
    for (const theme of themePatterns) {
      if (theme.pattern.test(title)) {
        themeScores.set(theme.label, (themeScores.get(theme.label) ?? 0) + 1);
      }
    }
  }

  return themeScores;
}

function deriveTitleKeywords(titles: string[]): string[] {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'project', 'task', 'issue', 'fix', 'update']);
  const counts = new Map<string, number>();

  for (const title of titles) {
    const matches = title.match(/[A-Za-z]{3,}|[\u4e00-\u9fa5]{2,}/g) ?? [];
    for (const match of matches) {
      const token = match.trim();
      const normalized = token.toLowerCase();
      if (stopWords.has(normalized)) continue;
      if (/^(today|tomorrow|session|unknown)$/i.test(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([token]) => token);
}

function deriveProjectDescription(
  projectName: string,
  allSignals: CanonicalSignal[],
): string {
  const titles = [...new Set(
    allSignals
      .filter((signal): signal is TimelineSignal => (
        signal.status === 'active'
        && signal.kind === 'timeline_event'
        && signal.projectNames.includes(projectName)
      ))
      .map((signal) => cleanSessionTitle(signal.payload.title))
      .filter((title) => title.length > 0),
  )];

  if (titles.length === 0) return clampDescription(projectName);

  const themeScores = [...scoreProjectThemes(titles).entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  const themeLabels = themeScores.map(([label]) => label);
  if (themeLabels.length > 0) {
    return clampDescription(themeLabels.slice(0, 2).join('与'));
  }

  const keywords = deriveTitleKeywords(titles);
  if (keywords.length > 0) {
    return clampDescription(keywords.join(' / '));
  }

  return clampDescription(projectName);
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n` : '\n';
  return `${header}${body}${userNotes}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export function compileTimelineView(
  signals: CanonicalSignal[],
  allSignals: CanonicalSignal[],
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
): PublishedView {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('项目时间线', sourceSummary, now);
  const filtered = sortTimelineSignals(
    signals.filter((signal) => signal.status === 'active').filter(isTimelineSignal),
  );

  const grouped = new Map<string, TimelineSignal[]>();
  for (const signal of filtered) {
    const project = signal.projectNames.length > 0 && signal.projectNames[0].length > 0 ? signal.projectNames[0] : 'unknown';
    const list = grouped.get(project) ?? [];
    list.push(signal);
    grouped.set(project, list);
  }

  const sortedProjectNames = [...grouped.keys()].sort((left, right) => left.localeCompare(right));

  const sections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  const maxItemsTotal = budget.maxItemsTotal ?? 80;
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;
  let itemsWritten = 0;

  for (const projectName of sortedProjectNames) {
    if (itemsWritten >= maxItemsTotal) break;

    const projectSignals = grouped.get(projectName) ?? [];
    const desc = deriveProjectDescription(projectName, allSignals);
    const sectionLines = [`## ${projectName}`, `<!-- desc: ${desc} -->`];
    const sectionSignalIds: string[] = [];

    const byDate = new Map<string, TimelineSignal[]>();
    for (const signal of projectSignals) {
      const date = signal.payload.date;
      const list = byDate.get(date) ?? [];
      list.push(signal);
      byDate.set(date, list);
    }

    const sortedDates = [...byDate.keys()].sort((left, right) => right.localeCompare(left));

    for (const date of sortedDates) {
      if (itemsWritten >= maxItemsTotal) break;

      const dateSignals = byDate.get(date) ?? [];
      sectionLines.push(`### ${date}`);

      for (const signal of dateSignals) {
        if (itemsWritten >= maxItemsTotal) break;

        const sourceLabel = signal.sourceLabels.length > 0 ? signal.sourceLabels[0] : 'unknown';
        const line = `- [${sourceLabel}] ${signal.payload.title}`;

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
    title: '项目时间线',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: boundedMarkdown,
  };
}
