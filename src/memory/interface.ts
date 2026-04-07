/**
 * MemoryAdapter interface — PRD-memory-integration §3.3
 * Every memory data source implements this interface.
 * Layer 0 calls interface methods, never touches raw format.
 */

import type { MemoryItem } from './types.js';

export interface MemoryAdapter {
  readonly name: string;

  /** Check if this memory data source exists and is available */
  detect(): Promise<boolean>;

  /**
   * List all memory items from this source.
   * kind field discriminates: 'auto-memory' | 'rule' | 'session-note' | 'skill-metadata'
   * @param projectPath optional — filter to a specific project's canonical path
   */
  listMemoryItems(projectPath?: string): Promise<MemoryItem[]>;
}
