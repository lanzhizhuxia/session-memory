/**
 * SourceAdapter interface — PRD §2.4.2
 * Every data source implements this interface.
 * Extractors only call interface methods, never touch raw format.
 */

import type { Project, Session, Message, Todo, NoiseSignals } from './types.js';

export interface SourceAdapter {
  readonly name: string;   // 'opencode' | 'claude-code' | ...

  /** Check if data source exists and is available */
  detect(): Promise<boolean>;

  /** Get all projects */
  getProjects(): Promise<Project[]>;

  /** Get sessions under a project (incremental: since is Unix ms) */
  getSessions(projectId: string, since?: number): Promise<Session[]>;

  /** Get all messages in a session */
  getMessages(sessionId: string): Promise<Message[]>;

  /** Get all todos (pending + in_progress) */
  getTodos(): Promise<Todo[]>;

  /** Get noise detection signals for a project */
  getNoiseSignals(projectId: string): Promise<NoiseSignals>;
}
