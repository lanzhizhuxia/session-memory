import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { MemoryAdapter } from './interface.js';
import { computeContentHash, computeStableId, type MemoryItem } from './types.js';

interface ClaudeCodeMemoryAdapterOptions {
  includeAutoMemory?: boolean;
  includeRules?: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MARKDOWN_EXTENSION_RE = /\.md$/i;
const MAX_MEMORY_FILE_SIZE_BYTES = 1024 * 1024;

function expandHome(inputPath: string): string {
  if (inputPath.startsWith('~')) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return inputPath;
}

function canonicalizePath(inputPath: string): string {
  const resolvedPath = path.resolve(inputPath);

  let canonicalPath = resolvedPath;
  try {
    canonicalPath = fs.realpathSync.native(resolvedPath);
  } catch {
    canonicalPath = resolvedPath;
  }

  return path.normalize(canonicalPath).replace(/[\/]+$/, '') || path.parse(canonicalPath).root;
}

function decodeProjectDirName(dirName: string): string {
  const decodedPath = dirName.startsWith('-')
    ? `/${dirName.slice(1).replace(/-/g, '/')}`
    : dirName.replace(/-/g, '/');

  return canonicalizePath(decodedPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripBom(content: string): string {
  return content.replace(/^\uFEFF/, '');
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalizedContent = stripBom(content);
  const match = normalizedContent.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: normalizedContent };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]) as unknown;
    if (isRecord(parsed)) {
      frontmatter = parsed;
    }
  } catch {
    frontmatter = {};
  }

  return {
    frontmatter,
    body: normalizedContent.slice(match[0].length),
  };
}

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const items = value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return items.length > 0 ? items : undefined;
  }

  return undefined;
}

function createMemoryItem(
  filePath: string,
  rawContent: string,
  kind: MemoryItem['kind'],
  scope: MemoryItem['scope'],
  canonicalProjectPath?: string,
): MemoryItem {
  const stat = fs.statSync(filePath);
  const normalizedContent = stripBom(rawContent);
  const { frontmatter } = parseFrontmatter(normalizedContent);
  const memoryType = typeof frontmatter.type === 'string' ? frontmatter.type : undefined;
  const pathFilters = toStringArray(frontmatter.paths);

  return {
    kind,
    stableId: computeStableId(filePath),
    path: canonicalizePath(filePath),
    content: normalizedContent,
    contentHash: computeContentHash(normalizedContent),
    source: 'claude-code',
    scope,
    canonicalProjectPath,
    memoryType,
    pathFilters,
    lastModified: stat.mtimeMs,
  };
}

export class ClaudeCodeMemoryAdapter implements MemoryAdapter {
  readonly name = 'claude-code-memory';

  private readonly baseDir: string;
  private readonly projectsDir: string;
  private readonly includeAutoMemory: boolean;
  private readonly includeRules: boolean;

  constructor(baseDir?: string, options?: ClaudeCodeMemoryAdapterOptions) {
    this.baseDir = canonicalizePath(expandHome(baseDir ?? '~/.claude'));
    this.projectsDir = path.join(this.baseDir, 'projects');
    this.includeAutoMemory = options?.includeAutoMemory !== false;
    this.includeRules = options?.includeRules !== false;
  }

  async detect(): Promise<boolean> {
    if (this.includeAutoMemory) {
      return fs.existsSync(this.projectsDir);
    }

    if (this.includeRules) {
      return fs.existsSync(this.baseDir);
    }

    return false;
  }

  async listMemoryItems(projectPath?: string): Promise<MemoryItem[]> {
    const items: MemoryItem[] = [];
    const knownProjectPaths = new Set<string>();
    const normalizedProjectPath = projectPath != null ? canonicalizePath(projectPath) : undefined;

    const projectDirs = fs.existsSync(this.projectsDir)
      ? fs.readdirSync(this.projectsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .sort((left, right) => left.name.localeCompare(right.name))
      : [];

    const maybePushItem = (
      candidatePath: string,
      kind: MemoryItem['kind'],
      scope: MemoryItem['scope'],
      canonicalProjectPath?: string,
    ): void => {
      try {
        if (!fs.existsSync(candidatePath)) {
          return;
        }

        const stat = fs.statSync(candidatePath);
        if (!stat.isFile()) {
          return;
        }

        if (stat.size > MAX_MEMORY_FILE_SIZE_BYTES) {
          console.warn(`[claude-code-memory] Skipped oversized file ${candidatePath} (${stat.size} bytes)`);
          return;
        }

        const statBeforeRead = stat;
        const rawContent = fs.readFileSync(candidatePath, 'utf-8');
        const statAfterRead = fs.statSync(candidatePath);
        if (statAfterRead.mtimeMs !== statBeforeRead.mtimeMs || statAfterRead.size !== statBeforeRead.size) {
          console.warn(`[claude-code-memory] Skipped concurrently modified file ${candidatePath}`);
          return;
        }
        if (rawContent.trim().length === 0) {
          return;
        }

        items.push(createMemoryItem(candidatePath, rawContent, kind, scope, canonicalProjectPath));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[claude-code-memory] Skipped unreadable file ${candidatePath}: ${message}`);
      }
    };

    const listMarkdownFiles = (dirPath: string): string[] => {
      try {
        if (!fs.existsSync(dirPath)) {
          return [];
        }

        return fs.readdirSync(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && MARKDOWN_EXTENSION_RE.test(entry.name))
          .map((entry) => path.join(dirPath, entry.name))
          .sort((left, right) => left.localeCompare(right));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[claude-code-memory] Skipped unreadable directory ${dirPath}: ${message}`);
        return [];
      }
    };

    for (const projectDir of projectDirs) {
      const canonicalProjectPath = decodeProjectDirName(projectDir.name);
      knownProjectPaths.add(canonicalProjectPath);

      if (!this.includeAutoMemory) {
        continue;
      }

      const memoryDir = path.join(this.projectsDir, projectDir.name, 'memory');
      for (const memoryFilePath of listMarkdownFiles(memoryDir)) {
        if (path.basename(memoryFilePath).toUpperCase() === 'MEMORY.MD') {
          continue;
        }

        maybePushItem(memoryFilePath, 'auto-memory', 'project', canonicalProjectPath);
      }
    }

    if (this.includeRules) {
      maybePushItem(path.join(this.baseDir, 'CLAUDE.md'), 'rule', 'user');

      for (const ruleFilePath of listMarkdownFiles(path.join(this.baseDir, 'rules'))) {
        maybePushItem(ruleFilePath, 'rule', 'user');
      }

      for (const knownProjectPath of knownProjectPaths) {
        const projectRuleCandidates = [
          path.join(knownProjectPath, 'CLAUDE.md'),
          path.join(knownProjectPath, '.claude', 'CLAUDE.md'),
        ];

        for (const candidate of projectRuleCandidates) {
          maybePushItem(candidate, 'rule', 'project', knownProjectPath);
        }

        for (const projectRulePath of listMarkdownFiles(path.join(knownProjectPath, '.claude', 'rules'))) {
          maybePushItem(projectRulePath, 'rule', 'project', knownProjectPath);
        }
      }
    }

    const filtered = normalizedProjectPath == null
      ? items
      : items.filter((item) => item.scope === 'user' || item.canonicalProjectPath === normalizedProjectPath);

    return filtered.sort((left, right) => left.path.localeCompare(right.path));
  }
}
