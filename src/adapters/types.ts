/**
 * Unified intermediate types for all source adapters.
 * PRD §2.4.1
 */

export interface Project {
  id: string;              // Internal unique identifier
  name: string;            // Project name (directory name)
  path: string;            // Git worktree absolute path (used for cross-source merge)
  source: string;          // 'opencode' | 'claude-code' | ...
  timeCreated: number;     // Unix ms
}

export interface Session {
  id: string;
  projectId: string;
  source: string;
  title?: string;
  parentId?: string;
  messageCount: number;
  codeChurn?: {
    additions: number;
    deletions: number;
    files: number;
  };
  timeCreated: number;     // Unix ms
  timeEnd?: number;        // Unix ms
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;         // Plain text; tool_use/tool_result folded or filtered
  timeCreated: number;     // Unix ms
}

export interface Todo {
  sessionId: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: string;
  source: string;
  timeCreated?: number;    // Unix ms
}

export interface NoiseSignals {
  projectId: string;
  hourDistribution: number[];      // 24 slots of session count
  uniqueFirstMessageRatio: number;
  medianSessionDurationMs: number;
  sessionSharePercent: number;     // This project's session count / total session count for this source
  userMessageRatio: number;
}

/** Merged logical project across sources */
export interface MergedProject {
  name: string;
  path: string;            // Worktree absolute path (merge key)
  sources: ProjectSource[];
}

export interface ProjectSource {
  source: string;
  projectId: string;
  project: Project;
}
