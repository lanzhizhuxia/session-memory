/**
 * Memory layer types — PRD-memory-integration §3.3, §4.0
 * Unified types for memory/rules/knowledge data from all sources.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// MemoryItem — MemoryAdapter output
// ============================================================

export type MemoryItemKind = 'auto-memory' | 'rule' | 'session-note' | 'skill-metadata';

export interface MemoryItem {
  kind: MemoryItemKind;
  stableId: string;
  path: string;
  content: string;
  contentHash: string;
  source: string;             // 'claude-code' | 'opencode'
  scope: 'user' | 'project' | 'org';
  canonicalProjectPath?: string;
  memoryType?: string;        // YAML frontmatter type (auto-memory only)
  pathFilters?: string[];     // rules paths: frontmatter
  sections?: Record<string, string>; // session-note structured sections
  lastModified: number;       // Unix ms
}

// ============================================================
// MemorySignals — Layer 0 output, consumed by Layer 2/3 renderers
// ============================================================

export interface MemorySignals {
  decisions: MemoryDecision[];
  painPoints: MemoryPainPoint[];
  workProfile: MemoryProfileEntry[];
  techPreferences: MemoryTechPreference[];
  sessionNotes: Map<string, SessionNoteData>;
}

export interface MemoryDecision {
  stableId: string;
  sourceLabel: string;
  sourcePath: string;
  projectName: string;
  date?: string;
  what: string;
  why?: string;
  alternatives?: string[];
  trigger?: string;
}

export interface MemoryPainPoint {
  stableId: string;
  sourceLabel: string;
  sourcePath: string;
  projectName: string;
  problem: string;
  diagnosis?: string;
  solution?: string;
  likelyRecurring?: boolean;
}

export interface MemoryProfileEntry {
  stableId: string;
  sourceLabel: string;
  sourcePath: string;
  category: string;
  observation: string;
  evidence?: string;
}

export interface MemoryTechPreference {
  stableId: string;
  sourceLabel: string;
  sourcePath: string;
  category: string;
  techName: string;
  description: string;
  projectNames?: string[];
}

export interface SessionNoteData {
  currentState?: string;
  worklog?: string;
  filesAndFunctions?: string;
  lastModified: number;
}

// ============================================================
// Incremental tracking — .last-extraction.json memory key
// ============================================================

export interface MemoryTrackingState {
  files: Record<string, MemoryFileRecord>;
  memoryHashes: string[];
  sessionNotes: Record<string, SessionNoteData>;
  signalCache: Record<string, CachedSignals>;
}

export interface CachedSignals {
  decisions: MemoryDecision[];
  painPoints: MemoryPainPoint[];
  workProfile: MemoryProfileEntry[];
  techPreferences: MemoryTechPreference[];
  contentHashes: string[];
}

export interface MemoryFileRecord {
  path: string;
  contentHash: string;
  lastSeen: number;
}

// ============================================================
// Helpers
// ============================================================

/** Compute stableId from file path (SHA-256 first 16 chars of normalized path) */
function normalizePathForStableId(filePath: string): string {
  const expandedPath = path.resolve(filePath);

  let normalizedPath = expandedPath;
  try {
    normalizedPath = fs.realpathSync.native(expandedPath);
  } catch {
    normalizedPath = expandedPath;
  }

  const cleanedPath = path.normalize(normalizedPath).replace(/[\/]+$/, '');
  return cleanedPath.length > 0 ? cleanedPath : path.parse(normalizedPath).root;
}

export function computeStableId(filePath: string): string {
  return createHash('sha256').update(normalizePathForStableId(filePath)).digest('hex').slice(0, 16);
}

/** Compute contentHash from file content (SHA-256 first 16 chars) */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Create an empty MemorySignals */
export function emptyMemorySignals(): MemorySignals {
  return {
    decisions: [],
    painPoints: [],
    workProfile: [],
    techPreferences: [],
    sessionNotes: new Map(),
  };
}

/** Create an empty MemoryTrackingState */
export function emptyMemoryTrackingState(): MemoryTrackingState {
  return {
    files: {},
    memoryHashes: [],
    sessionNotes: {},
    signalCache: {},
  };
}
