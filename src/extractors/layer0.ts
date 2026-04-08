import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { MemoryAdapter } from '../memory/interface.js';
import {
  computeContentHash,
  emptyMemorySignals,
  emptyMemoryTrackingState,
  type MemoryDecision,
  type MemoryItem,
  type MemoryPainPoint,
  type MemorySignals,
  type MemoryTechPreference,
  type MemoryTrackingState,
} from '../memory/types.js';

export interface Layer0Config {
  enabled: boolean;
  sourceLabels: Record<string, string>;
}

export interface Layer0Result {
  signals: MemorySignals;
  tracking: MemoryTrackingState;
  stats: { filesProcessed: number; filesSkipped: number; filesWarned: number };
}

interface ProcessMemoryResult {
  warned: number;
  contentHashes: string[];
}

interface TechKeyword {
  category: string;
  name: string;
  patterns: RegExp[];
}

interface ParsedMemoryContent {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  frontmatterError: boolean;
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const TECH_KEYWORDS: TechKeyword[] = [
  { category: '前端', name: 'Next.js', patterns: [/\bnext\.?js\b/i, /\bnextjs\b/i, /\bapp\s*router\b/i] },
  { category: '前端', name: 'React', patterns: [/\breact\b/i] },
  { category: '前端', name: 'Vue', patterns: [/\bvue\b/i, /\bnuxt\b/i] },
  { category: '前端', name: 'Tailwind CSS', patterns: [/\btailwind\b/i] },
  { category: '前端', name: 'shadcn/ui', patterns: [/\bshadcn\b/i] },
  { category: '前端', name: 'Vite', patterns: [/\bvite\b/i, /\bvitepress\b/i] },
  { category: '后端', name: 'Drizzle ORM', patterns: [/\bdrizzle\b/i] },
  { category: '后端', name: 'Prisma', patterns: [/\bprisma\b/i] },
  { category: '后端', name: 'SQLite', patterns: [/\bsqlite\b/i] },
  { category: '后端', name: 'PostgreSQL', patterns: [/\bpostgres\b/i, /\bpostgresql\b/i] },
  { category: '后端', name: 'Express', patterns: [/\bexpress\b/i] },
  { category: '后端', name: 'Hono', patterns: [/\bhono\b/i] },
  { category: '后端', name: 'Node.js', patterns: [/\bnode\.?js\b/i, /\bnodejs\b/i] },
  { category: '后端', name: 'Docker', patterns: [/\bdocker\b/i, /\bdockerfile\b/i] },
  { category: '后端', name: 'node-cron', patterns: [/\bnode-cron\b/i, /\bcron\b/i] },
  { category: 'AI', name: 'Claude', patterns: [/\bclaude\b/i, /\banthropic\b/i] },
  { category: 'AI', name: 'Gemini', patterns: [/\bgemini\b/i] },
  { category: 'AI', name: 'OpenAI', patterns: [/\bopenai\b/i, /\bgpt\b/i, /\bchatgpt\b/i] },
  { category: 'AI', name: 'LiteLLM', patterns: [/\blitellm\b/i] },
  { category: 'AI', name: 'Vercel AI SDK', patterns: [/\bvercel\s*ai\b/i, /\bai\s*sdk\b/i] },
  { category: 'AI', name: 'LangChain', patterns: [/\blangchain\b/i] },
  { category: '工具', name: 'Playwright', patterns: [/\bplaywright\b/i] },
  { category: '工具', name: 'MCP', patterns: [/\bmcp\b/i] },
  { category: '工具', name: 'GitHub Actions', patterns: [/\bgithub\s*actions?\b/i, /\bci\/cd\b/i] },
  { category: '工具', name: 'TypeScript', patterns: [/\btypescript\b/i, /\b\.ts\b/] },
  { category: '工具', name: 'ESLint', patterns: [/\beslint\b/i] },
  { category: '工具', name: 'Vitest', patterns: [/\bvitest\b/i] },
  { category: '部署', name: 'Vercel', patterns: [/\bvercel\b/i] },
  { category: '部署', name: 'GitHub Pages', patterns: [/\bgithub\s*pages\b/i] },
  { category: '部署', name: 'NAS', patterns: [/\bnas\b/i, /\bsynology\b/i] },
];

const PREFERENCE_PATTERNS = [
  /\bprefer\b/i,
  /\bavoid\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /偏好/,
  /禁止/,
  /总是/,
  /不要/,
];

const OPERATIONAL_RULE_PATTERNS = [
  /\b(run|execute|npm|yarn|pnpm)\s+(test|build|lint|check)\b/i,
  /提交前/,
  /\bbefore\s+(commit|push|merge)\b/i,
  /\bci\b.*\bpipeline\b/i,
  /\bpre-commit\b/i,
];

const AI_INSTRUCTION_PATTERNS = [
  /\bin chat replies\b/i,
  /\bwhen the user says\b/i,
  /\bgithub\s+(issues?|comments?|pr)\b/i,
  /\bcommit\s+message\b/i,
  /\bgit\s+(stash|rebase|pull|push)\b/i,
  /\bprlctl\b/i,
  /\bdocker(file)?\b/i,
  /\bnpm\s+publish\b/i,
  /\btmux\b/i,
  /\bMulti-agent safety\b/i,
  /\brelease\s+(flow|guardrail)\b/i,
  /\bplugin/i,
  /\bMintlify\b/i,
  /\bCarbon\s+dependency\b/i,
  /\bSwiftUI\b/i,
  /\bOxlint\b/i,
  /\bnode_modules\b/i,
  /\bshim\b.*\bPowerShell\b/i,
  /\bParallels\b/i,
  /\bschema\s+guardrail\b/i,
  /\bstreaming.*partial\b/i,
];

export async function runLayer0(
  adapters: MemoryAdapter[],
  config: Layer0Config,
  previousTracking?: MemoryTrackingState,
): Promise<Layer0Result> {
  if (!config.enabled) {
    return {
      signals: emptyMemorySignals(),
      tracking: previousTracking ?? emptyMemoryTrackingState(),
      stats: { filesProcessed: 0, filesSkipped: 0, filesWarned: 0 },
    };
  }

  const signals = emptyMemorySignals();
  const priorTracking = previousTracking ?? emptyMemoryTrackingState();
  const tracking: MemoryTrackingState = {
    files: {},
    memoryHashes: [],
    sessionNotes: { ...priorTracking.sessionNotes },
    signalCache: {},
  };
  const stats = { filesProcessed: 0, filesSkipped: 0, filesWarned: 0 };
  const now = Date.now();

  for (const adapter of adapters) {
    const isAvailable = await adapter.detect();
    if (!isAvailable) {
      continue;
    }

    const items = await adapter.listMemoryItems();

    for (const item of items) {
      tracking.files[item.stableId] = {
        path: item.path,
        contentHash: item.contentHash,
        lastSeen: now,
      };

      const previousFile = priorTracking.files[item.stableId];
      if (previousFile != null && previousFile.contentHash === item.contentHash) {
        const cached = priorTracking.signalCache?.[item.stableId];
        if (cached) {
          signals.decisions.push(...cached.decisions);
          signals.painPoints.push(...cached.painPoints);
          signals.workProfile.push(...cached.workProfile);
          signals.techPreferences.push(...cached.techPreferences);
          tracking.memoryHashes.push(...cached.contentHashes);
          tracking.signalCache[item.stableId] = cached;
        }
        stats.filesSkipped++;
        continue;
      }

      stats.filesProcessed++;

      const beforeCounts = {
        decisions: signals.decisions.length,
        painPoints: signals.painPoints.length,
        workProfile: signals.workProfile.length,
        techPreferences: signals.techPreferences.length,
      };
      const itemHashes: string[] = [];

      switch (item.kind) {
        case 'auto-memory': {
          const result = processAutoMemoryItem(item, resolveSourceLabel(item, config), signals);
          stats.filesWarned += result.warned;
          itemHashes.push(...result.contentHashes);
          break;
        }
        case 'rule': {
          const result = processRuleItem(item, resolveSourceLabel(item, config), signals);
          itemHashes.push(...result.contentHashes);
          break;
        }
        case 'session-note':
        case 'skill-metadata':
          break;
      }

      tracking.signalCache[item.stableId] = {
        decisions: signals.decisions.slice(beforeCounts.decisions),
        painPoints: signals.painPoints.slice(beforeCounts.painPoints),
        workProfile: signals.workProfile.slice(beforeCounts.workProfile),
        techPreferences: signals.techPreferences.slice(beforeCounts.techPreferences),
        contentHashes: itemHashes,
      };
      tracking.memoryHashes.push(...itemHashes);
    }
  }

  tracking.memoryHashes = Array.from(new Set(tracking.memoryHashes));

  return {
    signals,
    tracking,
    stats,
  };
}

function resolveSourceLabel(item: MemoryItem, config: Layer0Config): string {
  const kindKey = item.kind === 'rule' ? `${item.source}-rule` : `${item.source}-memory`;
  return config.sourceLabels[kindKey] ?? config.sourceLabels[item.source] ?? item.source;
}

function processAutoMemoryItem(item: MemoryItem, sourceLabel: string, signals: MemorySignals): ProcessMemoryResult {
  const parsed = parseMemoryContent(item.content);
  const projectName = projectNameFromItem(item);

  if (!parsed.hasFrontmatter) {
    console.warn(`[layer0] Skipping auto-memory without YAML frontmatter: ${item.path}`);
    return { warned: 1, contentHashes: [] };
  }

  if (parsed.frontmatterError) {
    console.warn(`[layer0] Skipping auto-memory with malformed YAML frontmatter: ${item.path}`);
    return { warned: 1, contentHashes: [] };
  }

  const memoryType = typeof parsed.frontmatter.type === 'string' ? parsed.frontmatter.type : item.memoryType;
  if (memoryType == null) {
    console.warn(`[layer0] Skipping auto-memory without type: ${item.path}`);
    return { warned: 1, contentHashes: [] };
  }

  switch (memoryType) {
    case 'project': {
      const decision: MemoryDecision = {
        stableId: item.stableId,
        sourceLabel,
        sourcePath: item.path,
        projectName,
        date: extractDate(parsed.frontmatter),
        what: extractSummary(parsed.body),
        why: findRelevantParagraph(parsed.body, [/\bbecause\b/i, /理由/, /原因/]),
      };
      signals.decisions.push(decision);
      return { warned: 0, contentHashes: [computeDecisionContentHash(decision)] };
    }
    case 'feedback': {
      const painPoint: MemoryPainPoint = {
        stableId: item.stableId,
        sourceLabel,
        sourcePath: item.path,
        projectName,
        problem: extractSummary(parsed.body),
        diagnosis: findRelevantParagraph(parsed.body, [/诊断/, /原因/, /root cause/i, /because/i]),
        solution: findRelevantParagraph(parsed.body, [/解决/, /fix/i, /solution/i]),
        likelyRecurring: /again|recurring|repeat|反复|经常|总是/i.test(parsed.body),
      };
      signals.painPoints.push(painPoint);
      return { warned: 0, contentHashes: [computePainPointContentHash(painPoint)] };
    }
    case 'user': {
      const blocks = extractBlocks(parsed.body);
      const contentHashes: string[] = [];
      blocks.forEach((block, index) => {
        const observation = cleanBlock(block);
        if (observation.length === 0) {
          return;
        }
        const entry = {
          stableId: derivedStableId(item.stableId, `profile:${index}`),
          sourceLabel,
          sourcePath: item.path,
          category: classifyProfileCategory(observation),
          observation,
        };
        signals.workProfile.push(entry);
        contentHashes.push(computeProfileContentHash(entry));
      });
      return { warned: 0, contentHashes };
    }
    case 'reference': {
      const preferences = buildTechPreferencesFromContent(item, sourceLabel, parsed.body);
      signals.techPreferences.push(...preferences);
      return { warned: 0, contentHashes: [] };
    }
    default:
      console.warn(`[layer0] Unknown auto-memory type for ${item.path}: ${memoryType}`);
      return { warned: 1, contentHashes: [] };
  }
}

function processRuleItem(item: MemoryItem, sourceLabel: string, signals: MemorySignals): ProcessMemoryResult {
  const parsed = parseMemoryContent(item.content);
  const preferences = buildTechPreferencesFromContent(item, sourceLabel, parsed.body);
  signals.techPreferences.push(...preferences);

  if (item.scope !== 'user') {
    return { warned: 0, contentHashes: [] };
  }

  const contentHashes: string[] = [];
  const blocks = extractBlocks(parsed.body)
    .filter((block) => PREFERENCE_PATTERNS.some((pattern) => pattern.test(block)))
    .filter((block) => !OPERATIONAL_RULE_PATTERNS.some((pattern) => pattern.test(block)))
    .filter((block) => !AI_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(block)));

  blocks.forEach((block, index) => {
    const observation = cleanBlock(block);
    if (observation.length === 0) {
      return;
    }
    const ruleEntry = {
      stableId: derivedStableId(item.stableId, `rule-profile:${index}`),
      sourceLabel,
      sourcePath: item.path,
      category: classifyProfileCategory(observation),
      observation,
    };
    signals.workProfile.push(ruleEntry);
    contentHashes.push(computeProfileContentHash(ruleEntry));
  });

  return { warned: 0, contentHashes };
}

function computeDecisionContentHash(decision: MemoryDecision): string {
  return computeContentHash(JSON.stringify({
    what: decision.what.trim(),
    why: decision.why?.trim() ?? '',
    alternatives: decision.alternatives?.map((item) => item.trim()) ?? [],
    trigger: decision.trigger?.trim() ?? '',
  }));
}

function computePainPointContentHash(painPoint: MemoryPainPoint): string {
  return computeContentHash(JSON.stringify({
    problem: painPoint.problem.trim(),
    diagnosis: painPoint.diagnosis?.trim() ?? '',
    solution: painPoint.solution?.trim() ?? '',
  }));
}

function computeProfileContentHash(entry: { category: string; observation: string; evidence?: string }): string {
  return computeContentHash(JSON.stringify({
    category: entry.category.trim(),
    observation: entry.observation.trim(),
    evidence: entry.evidence?.trim() ?? '',
  }));
}

function buildTechPreferencesFromContent(
  item: MemoryItem,
  sourceLabel: string,
  content: string,
): MemoryTechPreference[] {
  const projectName = item.canonicalProjectPath != null ? path.basename(item.canonicalProjectPath) || item.canonicalProjectPath : undefined;
  const preferences: MemoryTechPreference[] = [];

  TECH_KEYWORDS.forEach((keyword, index) => {
    if (!keyword.patterns.some((pattern) => pattern.test(content))) {
      return;
    }

    const baseDescription = findRelevantParagraph(content, keyword.patterns) ?? extractSummary(content);
    const pathAnnotation = item.pathFilters != null && item.pathFilters.length > 0
      ? ` (paths: ${item.pathFilters.join(', ')})`
      : '';

    preferences.push({
      stableId: derivedStableId(item.stableId, `tech:${index}`),
      sourceLabel,
      sourcePath: item.path,
      category: keyword.category,
      techName: keyword.name,
      description: `${baseDescription}${pathAnnotation}`,
      projectNames: projectName != null ? [projectName] : undefined,
    });
  });

  return preferences;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMemoryContent(content: string): ParsedMemoryContent {
  const normalizedContent = content.replace(/^\uFEFF/, '');
  const match = normalizedContent.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: normalizedContent.trim(), hasFrontmatter: false, frontmatterError: false };
  }

  let frontmatter: Record<string, unknown> = {};
  let frontmatterError = false;
  try {
    const parsed = parseYaml(match[1]) as unknown;
    if (isRecord(parsed)) {
      frontmatter = parsed;
    }
  } catch {
    frontmatterError = true;
  }

  return {
    frontmatter,
    body: normalizedContent.slice(match[0].length).trim(),
    hasFrontmatter: true,
    frontmatterError,
  };
}

function projectNameFromItem(item: MemoryItem): string {
  if (item.canonicalProjectPath == null) {
    return '(global)';
  }
  return path.basename(item.canonicalProjectPath) || item.canonicalProjectPath;
}

function extractDate(frontmatter: Record<string, unknown>): string | undefined {
  const candidate = typeof frontmatter.created === 'string'
    ? frontmatter.created
    : typeof frontmatter.updated === 'string'
      ? frontmatter.updated
      : undefined;

  if (candidate == null) {
    return undefined;
  }

  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString().slice(0, 10);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function extractHeading(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      return normalizeWhitespace(match[1]);
    }
  }
  return undefined;
}

function extractFirstSentence(content: string): string | undefined {
  const normalized = normalizeWhitespace(content.replace(/^#{1,6}\s+/gm, ''));
  if (normalized.length === 0) {
    return undefined;
  }

  const match = normalized.match(/^(.+?[。！？.!?])(?:\s|$)/);
  return match?.[1]?.trim() ?? normalized.split('\n')[0]?.trim();
}

function extractSummary(content: string): string {
  return extractHeading(content) ?? extractFirstSentence(content) ?? '(untitled memory)';
}

function splitParagraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function findRelevantParagraph(content: string, patterns: RegExp[]): string | undefined {
  const paragraphs = splitParagraphs(content);
  const match = paragraphs.find((paragraph) => patterns.some((pattern) => pattern.test(paragraph)));
  return match != null ? normalizeWhitespace(match) : undefined;
}

function extractBlocks(content: string): string[] {
  const bulletLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*+]\s+/.test(line))
    .map((line) => line.replace(/^[-*+]\s+/, '').trim())
    .filter((line) => line.length > 0);

  if (bulletLines.length > 0) {
    return bulletLines;
  }

  return splitParagraphs(content);
}

function cleanBlock(value: string): string {
  return normalizeWhitespace(value.replace(/^[-*+]\s+/, ''));
}

function classifyProfileCategory(observation: string): string {
  if (/中文|英文|language|语言|bilingual|双语/i.test(observation)) {
    return '语言偏好';
  }
  if (/prefer|avoid|always|never|沟通|反馈|简洁|详细|直接|风格|偏好|禁止/i.test(observation)) {
    return '交互风格';
  }
  if (/design|ui|ux|代码风格|架构|typescript|react|next|tailwind|审美|技术/i.test(observation)) {
    return '技术审美';
  }
  return '其他';
}

function derivedStableId(baseStableId: string, suffix: string): string {
  return computeContentHash(`${baseStableId}:${suffix}`);
}
