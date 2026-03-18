/**
 * Markdown Renderer — PRD §6.1.1, §6.1.2
 * Generates project-timeline.md and open-threads.md
 */

import path from 'node:path';
import type { Session, Todo } from '../adapters/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';

/** Format age string per PRD §6.1.2: <1h→Xm, <24h→Xh, <30d→Xd, <365d→Xmo, ≥365d→Xy */
export function formatAge(timestampMs: number | undefined, now: number = Date.now()): string {
  if (timestampMs == null) return 'unknown';
  const diffMs = now - timestampMs;
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (hours < 1) return `${Math.max(1, minutes)}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${months}mo ago`;
  return `${years}y ago`;
}

/** Format date as YYYY-MM-DD in local timezone */
export function formatDate(timestampMs: number): string {
  const d = new Date(timestampMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format ISO8601 timestamp for file headers */
export function formatISO(date: Date = new Date()): string {
  return date.toISOString().replace('Z', '+00:00');
}

/** Generate file header per PRD §6.1.1 */
export function fileHeader(title: string, sourceSummary: string, now: Date = new Date()): string {
  return `<!-- generated: ${formatISO(now)} -->\n<!-- sources: ${sourceSummary} -->\n# ${title}\n`;
}

/** Format code churn string */
function formatChurn(session: Session): string {
  if (!session.codeChurn) return '';
  const { additions, deletions, files } = session.codeChurn;
  if (additions === 0 && deletions === 0 && files === 0) return '';
  const parts: string[] = [];
  if (additions > 0 || deletions > 0) {
    parts.push(`+${additions}/-${deletions}`);
  }
  if (files > 0) {
    parts.push(`${files} files`);
  }
  return ` (${parts.join(', ')})`;
}

// ============================================================
// project-timeline.md — PRD §6.1.2 (append-type)
// ============================================================

interface TimelineData {
  projects: Array<{
    name: string;
    days: Array<{
      date: string;
      sessions: Array<{
        id: string;
        sourceLabel: string;
        title: string;
        churn: string;
      }>;
    }>;
  }>;
}

/**
 * Build timeline data from merged projects + sessions
 * Sessions are grouped by project → date
 */
export function buildTimelineData(
  sessions: Map<string, Session[]>,  // projectPath → sessions
  projectNames: Map<string, string>, // projectPath → name
  registry: AdapterRegistry,
): TimelineData {
  const projects: TimelineData['projects'] = [];

  for (const [projectPath, projectSessions] of sessions) {
    const projectName = projectNames.get(projectPath) ?? path.basename(projectPath);

    // Group by date
    const byDate = new Map<string, Session[]>();
    for (const s of projectSessions) {
      const date = formatDate(s.timeCreated);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(s);
    }

    // Sort dates
    const sortedDates = Array.from(byDate.keys()).sort();

    const days = sortedDates.map(date => ({
      date,
      sessions: byDate.get(date)!.map(s => ({
        id: s.id,
        sourceLabel: registry.getSourceLabel(s.source),
        title: s.title ?? '(untitled)',
        churn: formatChurn(s),
      })),
    }));

    projects.push({ name: projectName, days });
  }

  // Sort projects alphabetically
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { projects };
}

/**
 * Render project-timeline.md
 * Append-type: merges with existing content via session_id dedup
 */
export function renderTimeline(
  data: TimelineData,
  sourceSummary: string,
  existingContent?: string,
): string {
  // Parse existing session IDs for dedup
  const existingSessionIds = new Set<string>();
  if (existingContent) {
    // Extract session info from existing timeline
    // Each session line has a comment with session ID
    const idRegex = /<!-- sid:([^\s]+) -->/g;
    let match;
    while ((match = idRegex.exec(existingContent)) !== null) {
      existingSessionIds.add(match[1]);
    }
  }

  const lines: string[] = [];
  lines.push(fileHeader('项目时间线', sourceSummary));
  lines.push('');

  for (const project of data.projects) {
    lines.push(`## ${project.name}`);
    lines.push('');

    for (const day of project.days) {
      // Check if any session in this day is new
      const newSessions = day.sessions.filter(s => !existingSessionIds.has(s.id));
      const oldSessions = day.sessions.filter(s => existingSessionIds.has(s.id));

      // Render all sessions (both old and new for complete output)
      if (newSessions.length > 0 || oldSessions.length > 0) {
        lines.push(`### ${day.date}`);
        for (const s of [...oldSessions, ...newSessions]) {
          lines.push(`- [${s.sourceLabel}] ${s.title}${s.churn} <!-- sid:${s.id} -->`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ============================================================
// open-threads.md — PRD §6.1.2 (aggregate-type, full rebuild)
// ============================================================

export interface TodoWithContext extends Todo {
  projectName: string;
  sessionTitle?: string;
  sourceLabel: string;
}

/**
 * Render open-threads.md
 * Aggregate-type: full rebuild each time, preserves user notes
 */
export function renderOpenThreads(
  todos: TodoWithContext[],
  sourceSummary: string,
  existingContent?: string,
  now: number = Date.now(),
): string {
  // Extract existing user notes
  const userNotes = extractUserNotes(existingContent);

  // Group todos by project
  const byProject = new Map<string, TodoWithContext[]>();
  for (const todo of todos) {
    if (!byProject.has(todo.projectName)) {
      byProject.set(todo.projectName, []);
    }
    byProject.get(todo.projectName)!.push(todo);
  }

  const lines: string[] = [];
  lines.push(fileHeader('未完成线索', sourceSummary));
  lines.push('');

  // Sort projects alphabetically
  const sortedProjects = Array.from(byProject.keys()).sort();

  for (const projectName of sortedProjects) {
    const projectTodos = byProject.get(projectName)!;
    lines.push(`## ${projectName}（${projectTodos.length} 项）`);
    lines.push('');

    for (const todo of projectTodos) {
      const checkbox = todo.status === 'in_progress' ? '[~]' : '[ ]';
      const age = formatAge(todo.timeCreated, now);
      const from = todo.sessionTitle
        ? `from "${todo.sessionTitle}" [${todo.sourceLabel}]`
        : `[${todo.sourceLabel}]`;
      lines.push(`- ${checkbox} ${todo.content} — *${age}, ${from}*`);
    }
    lines.push('');
  }

  // Append user notes section
  if (userNotes) {
    lines.push(userNotes);
  } else {
    lines.push('<!-- user notes -->');
    lines.push('<!-- 在此处添加个人备注，全量重建时不会被覆盖 -->');
    lines.push('<!-- /user notes -->');
  }
  lines.push('');

  return lines.join('\n');
}

/** Extract user notes section from existing content */
function extractUserNotes(content?: string): string | null {
  if (!content) return null;
  const startTag = '<!-- user notes -->';
  const endTag = '<!-- /user notes -->';
  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) return null;
  return content.slice(startIdx, endIdx + endTag.length);
}
