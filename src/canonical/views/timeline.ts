import type { CanonicalSignal, PublishedView, PublishedViewSection, ViewBudget } from '../types.js';
import {
  cleanProjectName,
  cleanTitle,
  cleanViewText,
  finalizeMarkdownWithinBudget,
  shouldHideAsNoise,
} from './view-text.js';

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

function timelineTimestamp(signal: TimelineSignal): number {
  const parsed = Date.parse(signal.payload.date);
  return Number.isNaN(parsed) ? signal.lastSeenAt : parsed;
}

function sortTimelineSignals(signals: TimelineSignal[]): TimelineSignal[] {
  return [...signals].sort((left, right) => (
    timelineTimestamp(right) - timelineTimestamp(left)
    || right.trustScore - left.trustScore
    || right.supportCount - left.supportCount
    || right.lastSeenAt - left.lastSeenAt
    || left.id.localeCompare(right.id)
  ));
}

function isLowValueTimelineEntry(title: string): boolean {
  return /^(?:Explore|Inspect|Research|Search|Find|Look|Read|Check|Investigate)\b/i.test(title)
    || /^(?:hello|hi|test|测试|Tell me about yourself)$/i.test(title)
    || /^\[TEAM_STATUS\]/.test(title)
    || /^Oracle\b.*\breview\b/i.test(title);
}

function buildMarkdown(header: string, sections: PublishedViewSection[], userNotes: string): string {
  const sectionMarkdown = sections.map((section) => section.markdown.trimEnd()).join('\n\n');
  const body = sectionMarkdown.length > 0 ? `\n${sectionMarkdown}\n\n${userNotes}\n` : `\n${userNotes}\n`;
  const finalized = finalizeMarkdownWithinBudget(header, body, TIMELINE_BUDGET.maxChars);
  return finalized.endsWith('\n') ? finalized : `${finalized}\n`;
}

function fitsBudget(markdown: string, budget: ViewBudget): boolean {
  return markdown.length <= budget.maxChars;
}

export function compileTimelineView(
  signals: CanonicalSignal[],
  projectDescriptions: Map<string, string>,
  budget: ViewBudget,
  sourceSummary: string,
  existingContent?: string,
): PublishedView {
  const generatedAt = Date.now();
  const now = new Date(generatedAt);
  const header = fileHeader('项目时间线', sourceSummary, now);
  const activeTimelineSignals = sortTimelineSignals(
    signals
      .filter((signal) => signal.status === 'active')
      .filter(isTimelineSignal)
      .filter((signal) => !shouldHideAsNoise(signal.payload.title)),
  );

  const grouped = new Map<string, TimelineSignal[]>();
  for (const signal of activeTimelineSignals) {
    const project = cleanProjectName(signal.projectNames[0]);
    const list = grouped.get(project) ?? [];
    list.push(signal);
    grouped.set(project, list);
  }

  const filteredGrouped = new Map<string, TimelineSignal[]>();
  for (const [projectName, projectSignals] of grouped) {
    const description = cleanViewText(projectDescriptions.get(projectName));
    const lowValueSignals = projectSignals.filter((signal) => isLowValueTimelineEntry(cleanTitle(signal.payload.title)));
    const highValueSignals = projectSignals.filter((signal) => !isLowValueTimelineEntry(cleanTitle(signal.payload.title)));
    if (highValueSignals.length === 0 && (description.length === 0 || description === '(unknown)')) {
      continue;
    }
    filteredGrouped.set(projectName, highValueSignals.length > 0 ? [...highValueSignals, ...lowValueSignals.slice(0, 1)] : projectSignals.slice(0, 1));
  }

  const sortedProjectNames = [...filteredGrouped.keys()].sort((left, right) => {
    const leftSignals = filteredGrouped.get(left) ?? [];
    const rightSignals = filteredGrouped.get(right) ?? [];
    const leftLatest = Math.max(...leftSignals.map(timelineTimestamp));
    const rightLatest = Math.max(...rightSignals.map(timelineTimestamp));
    return rightLatest - leftLatest || rightSignals.length - leftSignals.length || left.localeCompare(right);
  });

  const maxItemsTotal = budget.maxItemsTotal ?? 80;
  const minPerProject = 3;
  const projectCount = sortedProjectNames.length;
  const userNotes = extractUserNotes(existingContent) ?? DEFAULT_USER_NOTES;

  const perProjectBudget = new Map<string, number>();
  if (projectCount * minPerProject <= maxItemsTotal) {
    let remaining = maxItemsTotal;
    for (const name of sortedProjectNames) {
      perProjectBudget.set(name, minPerProject);
      remaining -= minPerProject;
    }
    const totalSignals = [...filteredGrouped.values()].reduce((sum, signalsForProject) => sum + signalsForProject.length, 0);
    for (const name of sortedProjectNames) {
      if (remaining <= 0) break;
      const projectSize = filteredGrouped.get(name)?.length ?? 0;
      const proportionalShare = totalSignals > 0 ? Math.floor((projectSize / totalSignals) * remaining) : 0;
      const extra = Math.min(proportionalShare, projectSize - minPerProject, remaining);
      if (extra > 0) {
        perProjectBudget.set(name, (perProjectBudget.get(name) ?? minPerProject) + extra);
        remaining -= extra;
      }
    }
    if (remaining > 0) {
      for (const name of sortedProjectNames) {
        if (remaining <= 0) break;
        const current = perProjectBudget.get(name) ?? minPerProject;
        const projectSize = filteredGrouped.get(name)?.length ?? 0;
        const canAdd = Math.min(projectSize - current, remaining);
        if (canAdd > 0) {
          perProjectBudget.set(name, current + canAdd);
          remaining -= canAdd;
        }
      }
    }
  } else {
    for (const name of sortedProjectNames) {
      perProjectBudget.set(name, Math.max(1, Math.floor(maxItemsTotal / projectCount)));
    }
  }

  const sections: PublishedViewSection[] = [];
  const sourceSignalIds: string[] = [];
  let totalItemsWritten = 0;

  for (const projectName of sortedProjectNames) {
    if (totalItemsWritten >= maxItemsTotal) break;

    const projectSignals = filteredGrouped.get(projectName) ?? [];
    const projectMax = perProjectBudget.get(projectName) ?? minPerProject;
    const description = cleanViewText(projectDescriptions.get(projectName));
    const sectionLines = [`## ${projectName}`];
    if (description.length > 0 && description !== '(unknown)') {
      sectionLines.push(`> ${description}`);
    }
    const sectionSignalIds: string[] = [];
    let projectItemsWritten = 0;

    const byDate = new Map<string, TimelineSignal[]>();
    for (const signal of projectSignals) {
      const date = signal.payload.date;
      const list = byDate.get(date) ?? [];
      list.push(signal);
      byDate.set(date, list);
    }

    const sortedDates = [...byDate.keys()].sort((left, right) => right.localeCompare(left));
    for (const date of sortedDates) {
      if (projectItemsWritten >= projectMax || totalItemsWritten >= maxItemsTotal) break;

      const dateSignals = byDate.get(date) ?? [];
      const dateLines: string[] = [];
      const dateSignalIds: string[] = [];

      for (const signal of dateSignals) {
        if (projectItemsWritten >= projectMax || totalItemsWritten >= maxItemsTotal) break;

        const line = `- ${cleanTitle(signal.payload.title)}`;
        const candidateSectionLines = [...sectionLines, `### ${date}`, ...dateLines, line];
        const candidateSignalIds = [...sectionSignalIds, ...dateSignalIds, signal.id];
        const candidateSections = [
          ...sections,
          { title: projectName, signalIds: candidateSignalIds, markdown: `${candidateSectionLines.join('\n')}\n` },
        ];
        if (!fitsBudget(buildMarkdown(header, candidateSections, userNotes), budget)) break;

        dateLines.push(line);
        dateSignalIds.push(signal.id);
        sourceSignalIds.push(signal.id);
        projectItemsWritten++;
        totalItemsWritten++;
      }

      if (dateLines.length > 0) {
        sectionLines.push(`### ${date}`);
        sectionLines.push(...dateLines);
        sectionSignalIds.push(...dateSignalIds);
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
    finalSections = [];
    finalSignalIds = [];
    markdown = buildMarkdown(header, [], DEFAULT_USER_NOTES);
  }

  const finalMarkdown = fitsBudget(markdown, budget)
    ? markdown
    : finalizeMarkdownWithinBudget(header, `\n${userNotes}\n`, budget.maxChars);

  return {
    viewId: budget.viewId,
    title: '项目时间线',
    generatedAt,
    sourceSignalIds: finalSignalIds,
    budget,
    sections: finalSections,
    markdown: finalMarkdown.endsWith('\n') ? finalMarkdown : `${finalMarkdown}\n`,
  };
}
