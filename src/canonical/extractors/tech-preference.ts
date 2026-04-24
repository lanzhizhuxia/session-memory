import { computeContentHash } from '../../memory/types.js';
import type { MemoryItem } from '../../memory/types.js';
import type { MergedProject, Session } from '../../adapters/types.js';
import { classifyRelevance } from '../relevance.js';
import {
  computeCanonicalKey,
  computeFingerprint,
  type EvidenceRecord,
  type SignalCandidate,
  type TechPreferencePayload,
} from '../types.js';

interface TechKeyword {
  category: string;
  name: string;
  patterns: RegExp[];
}

interface SessionLike extends Session {
  canonicalProjectPath?: string;
  firstUserMessage?: string;
  projectName?: string;
  sourceLabel?: string;
}

interface SessionTechAccumulator {
  keyword: TechKeyword;
  count: number;
  preferCount: number;
  avoidCount: number;
  stackCount: number;
  projectName: string;
  canonicalProjectPath: string | undefined;
  projectId?: string;
  sourceLabel: string;
  sessionIds: string[];
  latestSessionTime: number;
  rationaleSample: string;
}

const TECH_KEYWORDS: TechKeyword[] = [
  { category: '前端', name: 'Next.js', patterns: [/\bnext\.?js\b/i, /\bnextjs\b/i, /\bapp\s*router\b/i] },
  { category: '前端', name: 'React', patterns: [/(?<!@base-ui\/)\breact\b/i] },
  { category: '前端', name: 'Vue', patterns: [/\bvue\b/i, /\bnuxt\b/i] },
  { category: '前端', name: 'Tailwind CSS', patterns: [/\btailwind\b/i] },
  { category: '前端', name: 'shadcn/ui', patterns: [/\bshadcn\b/i] },
  { category: '前端', name: 'Vite', patterns: [/\bvite\b/i, /\bvitepress\b/i] },
  { category: '后端', name: 'Drizzle ORM', patterns: [/\bdrizzle\b/i] },
  { category: '后端', name: 'Prisma', patterns: [/\bprisma\b/i] },
  { category: '后端', name: 'SQLite', patterns: [/\bsqlite\b/i] },
  { category: '后端', name: 'PostgreSQL', patterns: [/\bpostgres(?:ql)?\b/i] },
  { category: '后端', name: 'Express', patterns: [/\bexpress\b/i] },
  { category: '后端', name: 'Hono', patterns: [/\bhono\b/i] },
  { category: '后端', name: 'Node.js', patterns: [/\bnode\.?js\b/i, /\bnodejs\b/i] },
  { category: '后端', name: 'node-cron', patterns: [/\bnode-cron\b/i] },
  { category: 'AI', name: 'Claude', patterns: [/\bclaude\b/i, /\banthropic\b/i] },
  { category: 'AI', name: 'Gemini', patterns: [/\bgemini\b/i] },
  { category: 'AI', name: 'OpenAI', patterns: [/\bopenai\b/i, /\bchatgpt\b/i] },
  { category: 'AI', name: 'LiteLLM', patterns: [/\blitellm\b/i] },
  { category: 'AI', name: 'Vercel AI SDK', patterns: [/\bvercel\s*ai\b/i, /\bai\s*sdk\b/i] },
  { category: 'AI', name: 'LangChain', patterns: [/\blangchain\b/i] },
  { category: '工具', name: 'Playwright', patterns: [/\bplaywright\b/i] },
  { category: '工具', name: 'MCP', patterns: [/\bmcp\b/i] },
  { category: '工具', name: 'GitHub Actions', patterns: [/\bgithub\s*actions?\b/i, /\bci\/cd\b/i] },
  { category: '工具', name: 'TypeScript', patterns: [/\btypescript\b/i] },
  { category: '工具', name: 'ESLint', patterns: [/\beslint\b/i] },
  { category: '工具', name: 'Vitest', patterns: [/\bvitest\b/i] },
  { category: '部署', name: 'Docker', patterns: [/\bdocker\b/i, /\bdockerfile\b/i] },
  { category: '部署', name: 'Vercel', patterns: [/\bvercel\b/i] },
  { category: '部署', name: 'GitHub Pages', patterns: [/\bgithub\s*pages\b/i] },
  { category: '部署', name: 'NAS', patterns: [/\bnas\b/i, /\bsynology\b/i] },
];

const POSITIVE_PATTERNS = [
  /\bprefer\b/i,
  /\bpreferred\b/i,
  /\balways\b/i,
  /\bstandard\b/i,
  /\bdefault to\b/i,
  /\bprioriti[sz]e\b/i,
  /偏好/,
  /优先/,
  /推荐/,
  /必须/,
  /严格/,
  /默认/,
];

const NEGATIVE_PATTERNS = [
  /\bavoid\b/i,
  /\bnever\b/i,
  /\bdon't\b/i,
  /\bdo not\b/i,
  /禁止/,
  /不要/,
  /禁用/,
  /避免/,
];

const CONDITIONAL_PATTERNS = [
  /\bif\b/i,
  /\bwhen\b/i,
  /\bunless\b/i,
  /\bonly\b/i,
  /如果/,
  /当/,
  /仅在/,
  /除非/,
];

const STACK_LABEL_PATTERNS = [
  /前端/,
  /后端/,
  /数据库/,
  /部署/,
  /工具/,
  /技术栈/,
  /stack/i,
  /ai/i,
  /组件/,
  /测试/,
];

const OPERATIONAL_NOISE_PATTERNS = [
  /\bssh\b/i,
  /\bdocker-compose\b/i,
  /\/usr\/local\/bin\//i,
  /https?:\/\//i,
  /\.github\/workflows\//i,
  /\bworkflow\b/i,
  /\bpath\b/i,
  /\bendpoint\b/i,
  /\bport\b/i,
  /\b日志\b/,
  /\b命令\b/,
  /\b重启\b/,
  /\brestart\b/i,
];

const SESSION_PROMPT_NOISE_PATTERNS = [
  /^task:/i,
  /^expected outcome:/i,
  /^required skills:/i,
  /^required tools:/i,
  /^must do:/i,
  /^must not do:/i,
  /^context:/i,
  /^you are\b/i,
  /^research how to\b/i,
  /^create\b/i,
  /^build\b/i,
  /^rewrite\b/i,
  /^review\b/i,
  /^i'?m building\b/i,
  /OMO_INTERNAL_INITIATOR/,
  /EXPECTED OUTCOME/i,
  /MUST DO/i,
  /MUST NOT DO/i,
  /PRD 全文/,
];

function clamp(value: string, maxChars: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return trimmed;
  const punctuation = ['。', '！', '？', '.', '!', '?', '；', ';'];
  let bestCut = -1;
  for (const mark of punctuation) {
    const idx = trimmed.lastIndexOf(mark, maxChars);
    if (idx > bestCut) bestCut = idx + 1;
  }
  const softPunctuation = ['，', ',', '、', '：', ':'];
  let softCut = -1;
  for (const mark of softPunctuation) {
    const idx = trimmed.lastIndexOf(mark, maxChars);
    if (idx > softCut) softCut = idx + 1;
  }
  const spaceCut = trimmed.lastIndexOf(' ', maxChars);
  const threshold = Math.floor(maxChars * 0.5);
  if (bestCut > threshold) return trimmed.slice(0, bestCut).trim();
  if (softCut > threshold) return trimmed.slice(0, softCut).trim();
  if (spaceCut > threshold) return trimmed.slice(0, spaceCut).trim();
  return `${trimmed.slice(0, maxChars - 1).trim()}…`;
}

function sanitizeLine(value: string): string {
  return value
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasExplicitPreferenceLanguage(line: string): boolean {
  return POSITIVE_PATTERNS.some((pattern) => pattern.test(line))
    || NEGATIVE_PATTERNS.some((pattern) => pattern.test(line))
    || CONDITIONAL_PATTERNS.some((pattern) => pattern.test(line));
}

function looksLikeStackDeclaration(line: string, matchedKeywords: TechKeyword[]): boolean {
  if (matchedKeywords.length === 0) {
    return false;
  }

  const sanitized = sanitizeLine(line);
  return STACK_LABEL_PATTERNS.some((pattern) => pattern.test(sanitized))
    && /[:：]/.test(sanitized)
    && (matchedKeywords.length > 1 || /[+,/]/.test(sanitized));
}

function isOperationalNoise(line: string): boolean {
  const sanitized = sanitizeLine(line);
  if (sanitized.length === 0) {
    return true;
  }

  if (/^---$/.test(sanitized) || /^[#>]/.test(sanitized) || /^<!--/.test(sanitized) || /^\|.+\|$/.test(line.trim())) {
    return true;
  }

  return OPERATIONAL_NOISE_PATTERNS.some((pattern) => pattern.test(sanitized));
}

function inferStanceFromLine(line: string): TechPreferencePayload['stance'] {
  if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(line))) {
    return 'avoid';
  }
  if (POSITIVE_PATTERNS.some((pattern) => pattern.test(line))) {
    return 'prefer';
  }
  return 'conditional';
}

function inferConditions(line: string): string[] | undefined {
  if (!CONDITIONAL_PATTERNS.some((pattern) => pattern.test(line))) {
    return undefined;
  }
  const compact = clamp(sanitizeLine(line), 80);
  return compact.length > 0 ? [compact] : ['context-dependent'];
}

function buildEvidenceId(prefix: string, stableKey: string): string {
  return computeContentHash(`${prefix}:${stableKey}`);
}

function isPromptLike(line: string): boolean {
  return SESSION_PROMPT_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

function shouldSkipKeywordForLine(keyword: TechKeyword, line: string): boolean {
  if (keyword.name === 'React' && /@base-ui\/react/i.test(line)) {
    return true;
  }

  if (keyword.name === 'Docker' && /docker\s+路径|docker command/i.test(line)) {
    return true;
  }

  return false;
}

function buildCandidateFromPayload(
  payload: TechPreferencePayload,
  evidence: EvidenceRecord,
  extractor: string,
  confidenceOverride?: number,
): SignalCandidate {
  const candidate: SignalCandidate = {
    id: computeContentHash(`${evidence.id}:${payload.category}:${payload.technology}:${payload.stance}`),
    kind: 'tech_preference',
    evidenceIds: [evidence.id],
    primaryEvidenceId: evidence.id,
    projectId: evidence.projectId,
    projectName: evidence.projectName,
    canonicalProjectPath: evidence.canonicalProjectPath,
    confidence: confidenceOverride ?? (evidence.sourceKind === 'rule_file' ? 0.95 : evidence.sourceKind === 'memory_file' ? 0.85 : 0.7),
    trustScore: evidence.trustScore,
    sourceLabels: [evidence.sourceLabel],
    observedAt: evidence.observedAt,
    extractor,
    rawText: evidence.content,
    payload,
  };

  candidate.fingerprint = computeFingerprint(candidate.kind, candidate.payload);
  candidate.canonicalKeyHint = computeCanonicalKey(candidate);
  return candidate;
}

function pathTitle(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts.at(-1) ?? filePath;
}

export function extractTechPrefsFromMemory(
  memoryItems: MemoryItem[],
  sourceLabel: string,
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  for (const item of memoryItems) {
    const isSupported = item.kind === 'rule' || (item.kind === 'auto-memory' && item.memoryType === 'reference');
    if (!isSupported) {
      continue;
    }

    const sourceKind = item.kind === 'rule' ? 'rule_file' as const : 'memory_file' as const;
    const trustScore: 1 | 2 | 3 | 4 | 5 = item.kind === 'rule' ? 5 : 4;
    const projectName = item.canonicalProjectPath == null
      ? undefined
      : item.canonicalProjectPath.split('/').filter(Boolean).pop();

    const lines = item.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const rawLine = lines[index];
      const line = sanitizeLine(rawLine);
      if (isOperationalNoise(rawLine)) {
        continue;
      }

      const relevance = classifyRelevance(line, pathTitle(item.path));
      if (relevance === 'noise' || relevance === 'generic_execution') {
        continue;
      }

      const matchedKeywords = TECH_KEYWORDS.filter(
        (keyword) => keyword.patterns.some((pattern) => pattern.test(line)) && !shouldSkipKeywordForLine(keyword, line),
      );
      if (matchedKeywords.length === 0) {
        continue;
      }

      const explicitPreference = hasExplicitPreferenceLanguage(line);
      const stackDeclaration = looksLikeStackDeclaration(line, matchedKeywords);
      if (!explicitPreference && !stackDeclaration) {
        continue;
      }

      for (const keyword of matchedKeywords) {
        const evidenceRecord: EvidenceRecord = {
          id: buildEvidenceId(item.stableId, `${item.path}:${index}:${keyword.name}`),
          sourceKind,
          sourceLabel: sourceLabel || item.source,
          projectName,
          canonicalProjectPath: item.canonicalProjectPath,
          filePath: item.path,
          content: line,
          contentHash: computeContentHash(line),
          capturedAt: item.lastModified,
          observedAt: new Date(item.lastModified).toISOString().slice(0, 10),
          trustScore,
          recencyScore: 1,
          extractionHints: ['tech-preference'],
          metadata: {
            lineNumber: index + 1,
            memoryKind: item.kind,
          },
        };

        const stackRationale = stackDeclaration && !explicitPreference
          ? `技术栈中使用 ${keyword.name}`
          : line;
        const stance = explicitPreference ? inferStanceFromLine(line) : 'prefer';
        const payload: TechPreferencePayload = {
          technology: keyword.name,
          category: keyword.category,
          stance,
          rationale: clamp(stackRationale, 120),
          conditions: stance === 'conditional' ? inferConditions(line) : undefined,
        };

        evidence.push(evidenceRecord);
        candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer0-tech-preference'));
      }
    }
  }

  return { candidates, evidence };
}

export function extractTechPrefsFromSessions(
  projects: MergedProject[],
  sessions: SessionLike[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const candidates: SignalCandidate[] = [];
  const evidence: EvidenceRecord[] = [];

  const sessionsByProject = new Map<string, { sessions: SessionLike[]; project: MergedProject }>();
  for (const project of projects) {
    const projectSessions: SessionLike[] = [];
    for (const session of sessions) {
      const matchesProject = project.sources.some(
        (source) => source.projectId === session.projectId && source.source === session.source,
      );
      if (matchesProject) {
        projectSessions.push(session);
      }
    }
    if (projectSessions.length > 0) {
      sessionsByProject.set(project.path, { sessions: projectSessions, project });
    }
  }

  for (const [, { sessions: projectSessions, project }] of sessionsByProject) {
    const accumulators = new Map<string, SessionTechAccumulator>();

    for (const session of projectSessions) {
      const snippets = [session.title, session.title == null || session.title.trim().length === 0 ? session.firstUserMessage : undefined]
        .filter((value): value is string => value != null && value.trim().length > 0)
        .map((value) => sanitizeLine(value));

      for (const snippet of snippets) {
        if (isOperationalNoise(snippet) || isPromptLike(snippet) || snippet.length > 220) {
          continue;
        }

        const relevance = classifyRelevance(snippet, session.title);
        if (relevance !== 'preference_rich') {
          continue;
        }

        const matchedKeywords = TECH_KEYWORDS.filter(
          (keyword) => keyword.patterns.some((pattern) => pattern.test(snippet)) && !shouldSkipKeywordForLine(keyword, snippet),
        );
        if (matchedKeywords.length === 0) {
          continue;
        }

        const explicitPreference = hasExplicitPreferenceLanguage(snippet);
        const stackDeclaration = looksLikeStackDeclaration(snippet, matchedKeywords);
        if (!explicitPreference && !stackDeclaration) {
          continue;
        }

        for (const keyword of matchedKeywords) {
          const key = `${project.path}:${keyword.category}:${keyword.name}`;
          const existing = accumulators.get(key);
          const snippetStance = explicitPreference ? inferStanceFromLine(snippet) : 'prefer';

          if (existing == null) {
            accumulators.set(key, {
              keyword,
              count: 1,
              preferCount: snippetStance === 'prefer' ? 1 : 0,
              avoidCount: snippetStance === 'avoid' ? 1 : 0,
              stackCount: stackDeclaration ? 1 : 0,
              projectName: session.projectName ?? project.name,
              canonicalProjectPath: session.canonicalProjectPath ?? project.path,
              projectId: session.projectId,
              sourceLabel: session.sourceLabel ?? project.sources[0]?.source ?? 'unknown',
              sessionIds: [session.id],
              latestSessionTime: session.timeCreated,
              rationaleSample: snippet,
            });
            continue;
          }

          existing.count++;
          existing.sessionIds.push(session.id);
          existing.latestSessionTime = Math.max(existing.latestSessionTime, session.timeCreated);
          existing.preferCount += snippetStance === 'prefer' ? 1 : 0;
          existing.avoidCount += snippetStance === 'avoid' ? 1 : 0;
          existing.stackCount += stackDeclaration ? 1 : 0;

          if (snippet.length > existing.rationaleSample.length) {
            existing.rationaleSample = snippet;
          }
        }
      }
    }

    for (const [, accumulator] of accumulators) {
      const hasStrongSignal = accumulator.preferCount > 0 || accumulator.avoidCount > 0 || accumulator.stackCount >= 2;
      if (!hasStrongSignal || accumulator.count < 2) {
        continue;
      }

      let confidence: number;
      if (accumulator.count >= 8) {
        confidence = 0.75;
      } else if (accumulator.count >= 4) {
        confidence = 0.6;
      } else {
        confidence = 0.45;
      }

      const stance: TechPreferencePayload['stance'] = accumulator.avoidCount > accumulator.preferCount
        ? 'avoid'
        : 'prefer';

      const evidenceRecord: EvidenceRecord = {
        id: buildEvidenceId(
          project.path,
          `${project.path}:${accumulator.keyword.name}:sessions`,
        ),
        sourceKind: 'session_message',
        sourceLabel: accumulator.sourceLabel,
        projectId: accumulator.projectId,
        projectName: accumulator.projectName,
        canonicalProjectPath: accumulator.canonicalProjectPath,
        content: accumulator.rationaleSample,
        contentHash: computeContentHash(
          `${project.path}:${accumulator.keyword.name}:${accumulator.count}:${accumulator.rationaleSample}`,
        ),
        capturedAt: accumulator.latestSessionTime,
        observedAt: new Date(accumulator.latestSessionTime).toISOString().slice(0, 10),
        authorRole: 'user',
        trustScore: 2,
        recencyScore: 1,
        extractionHints: ['tech-preference'],
        metadata: {
          mentionCount: accumulator.count,
          sessionCount: accumulator.sessionIds.length,
        },
      };

      const payload: TechPreferencePayload = {
        technology: accumulator.keyword.name,
        category: accumulator.keyword.category,
        stance,
        rationale: clamp(
          accumulator.preferCount > 0 || accumulator.avoidCount > 0
            ? accumulator.rationaleSample
            : `在 ${accumulator.projectName} 中反复作为技术栈使用（${accumulator.count} 条证据）`,
          120,
        ),
      };

      evidence.push(evidenceRecord);
      candidates.push(buildCandidateFromPayload(payload, evidenceRecord, 'canonical-layer2-tech-preference', confidence));
    }
  }

  return { candidates, evidence };
}

export function extractTechPreferenceCandidates(
  memoryItems: MemoryItem[],
  sessions: SessionLike[],
  projects: MergedProject[],
): { candidates: SignalCandidate[]; evidence: EvidenceRecord[] } {
  const memoryResult = extractTechPrefsFromMemory(memoryItems, '');
  const sessionResult = extractTechPrefsFromSessions(projects, sessions);

  return {
    candidates: [...memoryResult.candidates, ...sessionResult.candidates],
    evidence: [...memoryResult.evidence, ...sessionResult.evidence],
  };
}
