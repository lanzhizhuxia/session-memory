/**
 * Layer 1: Structured Extraction — PRD §5.2
 * Zero AI cost. Generates project-timeline.md and open-threads.md
 */

import type { Session, MergedProject } from '../adapters/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { NoiseFilter } from '../utils/noise-filter.js';
import {
  buildTimelineData,
  renderTimeline,
  renderOpenThreads,
  type TodoWithContext,
} from '../utils/renderer.js';

export interface Layer1Result {
  timelineContent: string;
  openThreadsContent: string;
  sessionsByProject: Map<string, Session[]>;
  latestSessionTime: Record<string, number>;  // per source
}

export async function runLayer1(
  registry: AdapterRegistry,
  noiseFilter: NoiseFilter,
  mergedProjects: MergedProject[],
  since?: Record<string, number>,   // per-source last_session_time
  existingTimeline?: string,
  existingOpenThreads?: string,
): Promise<Layer1Result> {
  const sessionsByProject = new Map<string, Session[]>();
  const projectNames = new Map<string, string>();
  const latestSessionTime: Record<string, number> = {};

  // Step 1: Collect sessions for non-noise projects
  for (const mp of mergedProjects) {
    if (noiseFilter.isNoise(mp)) continue;

    const sessions = await registry.getSessions(mp);
    if (sessions.length === 0) continue;

    // Filter by since (per-source incremental)
    const filtered = sessions.filter(s => {
      const sourceSince = since?.[s.source];
      return sourceSince == null || s.timeCreated > sourceSince;
    });

    // For timeline we only use new sessions (append-type)
    // But for open-threads we need all sessions (aggregate-type)
    sessionsByProject.set(mp.path, filtered);
    projectNames.set(mp.path, mp.name);

    // Track latest session time per source
    for (const s of filtered) {
      if (!latestSessionTime[s.source] || s.timeCreated > latestSessionTime[s.source]) {
        latestSessionTime[s.source] = s.timeCreated;
      }
    }
  }

  // Step 2: Build and render project-timeline.md
  const sourceSummary = await registry.getSourceSummary();
  const timelineData = buildTimelineData(sessionsByProject, projectNames, registry);
  const timelineContent = renderTimeline(timelineData, sourceSummary, existingTimeline);

  // Step 3: Build and render open-threads.md (aggregate — full rebuild)
  const allTodos = await registry.getAllTodos();

  // Build session lookup for todo context
  const todoWithContext: TodoWithContext[] = [];
  for (const todo of allTodos) {
    // Find which project this todo belongs to
    const session = registry.getSessionById(todo.sessionId);
    let projectName = 'unknown';
    if (session) {
      // Find merged project for this session
      for (const mp of mergedProjects) {
        if (noiseFilter.isNoise(mp)) continue;
        for (const ps of mp.sources) {
          if (ps.source === session.source && ps.projectId === session.projectId) {
            projectName = mp.name;
            break;
          }
        }
      }
    }

    // Skip todos from noise projects
    if (projectName === 'unknown') {
      // Try to find from session source
      for (const mp of mergedProjects) {
        if (noiseFilter.isNoise(mp)) continue;
        const mpSessions = await registry.getSessions(mp);
        if (mpSessions.some(s => s.id === todo.sessionId)) {
          projectName = mp.name;
          break;
        }
      }
    }

    if (projectName === 'unknown') continue;

    todoWithContext.push({
      ...todo,
      projectName,
      sessionTitle: session?.title,
      sourceLabel: registry.getSourceLabel(todo.source),
    });
  }

  const openThreadsContent = renderOpenThreads(todoWithContext, sourceSummary, existingOpenThreads);

  return {
    timelineContent,
    openThreadsContent,
    sessionsByProject,
    latestSessionTime,
  };
}
