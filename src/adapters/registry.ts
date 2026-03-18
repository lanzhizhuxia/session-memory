/**
 * Adapter Registry — PRD §2.4.3
 * Multi-source registration, auto-detect, project merge by worktree path
 */

import type { SourceAdapter } from './interface.js';
import type { Session, Message, Todo, NoiseSignals, MergedProject } from './types.js';

export class AdapterRegistry {
  private adapters: SourceAdapter[] = [];
  private activeAdapters: SourceAdapter[] = [];
  private mergedProjects: MergedProject[] = [];

  // Source label mapping (config-driven)
  private sourceLabels: Record<string, string>;

  constructor(sourceLabels?: Record<string, string>) {
    this.sourceLabels = sourceLabels ?? {
      opencode: 'OC',
      'claude-code': 'CC',
    };
  }

  register(adapter: SourceAdapter): void {
    this.adapters.push(adapter);
  }

  /** Detect available adapters and build merged project list */
  async initialize(): Promise<void> {
    this.activeAdapters = [];
    for (const adapter of this.adapters) {
      if (await adapter.detect()) {
        this.activeAdapters.push(adapter);
      }
    }

    await this.buildMergedProjects();
  }

  private async buildMergedProjects(): Promise<void> {
    // Merge key: worktree absolute path
    const byPath = new Map<string, MergedProject>();

    for (const adapter of this.activeAdapters) {
      const projects = await adapter.getProjects();
      for (const project of projects) {
        const key = project.path;
        if (!byPath.has(key)) {
          byPath.set(key, {
            name: project.name,
            path: project.path,
            sources: [],
          });
        }
        byPath.get(key)!.sources.push({
          source: adapter.name,
          projectId: project.id,
          project,
        });
      }
    }

    this.mergedProjects = Array.from(byPath.values());
  }

  /** Get all merged projects */
  getAllProjects(): MergedProject[] {
    return this.mergedProjects;
  }

  /** Get all active adapters */
  getActiveAdapters(): SourceAdapter[] {
    return this.activeAdapters;
  }

  /** Get source label for display */
  getSourceLabel(source: string): string {
    return this.sourceLabels[source] ?? source.toUpperCase();
  }

  /**
   * Get sessions for a merged project across all sources.
   * Returns sessions sorted by timeCreated.
   */
  async getSessions(mergedProject: MergedProject, since?: number): Promise<Session[]> {
    const allSessions: Session[] = [];

    for (const ps of mergedProject.sources) {
      const adapter = this.activeAdapters.find(a => a.name === ps.source);
      if (!adapter) continue;
      const sessions = await adapter.getSessions(ps.projectId, since);
      allSessions.push(...sessions);
    }

    return allSessions.sort((a, b) => a.timeCreated - b.timeCreated);
  }

  /** Get messages for a session (auto-routes to correct adapter) */
  async getMessages(session: Session): Promise<Message[]> {
    const adapter = this.activeAdapters.find(a => a.name === session.source);
    if (!adapter) return [];
    return adapter.getMessages(session.id);
  }

  /** Get all todos across all active adapters */
  async getAllTodos(): Promise<Todo[]> {
    const allTodos: Todo[] = [];
    for (const adapter of this.activeAdapters) {
      const todos = await adapter.getTodos();
      allTodos.push(...todos);
    }
    return allTodos;
  }

  /** Get noise signals for a specific project source */
  async getNoiseSignals(source: string, projectId: string): Promise<NoiseSignals> {
    const adapter = this.activeAdapters.find(a => a.name === source);
    if (!adapter) throw new Error(`Adapter ${source} not found`);
    return adapter.getNoiseSignals(projectId);
  }

  /** Get total session count across all active adapters for a specific source */
  async getTotalSessionCount(source: string): Promise<number> {
    const adapter = this.activeAdapters.find(a => a.name === source);
    if (!adapter) return 0;
    const projects = await adapter.getProjects();
    let total = 0;
    for (const p of projects) {
      const sessions = await adapter.getSessions(p.id);
      total += sessions.length;
    }
    return total;
  }

  /** Look up session by ID across all adapters */
  getSessionById(sessionId: string): Session | undefined {
    for (const adapter of this.activeAdapters) {
      const a = adapter as any;
      if (typeof a.getSessionById === 'function') {
        const session = a.getSessionById(sessionId);
        if (session) return session;
      }
    }
    return undefined;
  }

  /** Get session counts per source (for file headers) */
  async getSourceSummary(): Promise<string> {
    const parts: string[] = [];
    for (const adapter of this.activeAdapters) {
      const projects = await adapter.getProjects();
      let totalSessions = 0;
      for (const p of projects) {
        const sessions = await adapter.getSessions(p.id);
        totalSessions += sessions.length;
      }
      parts.push(`${adapter.name}(${totalSessions} sessions)`);
    }
    return parts.join(' + ');
  }
}
